/**
 * Tests for src/notifications/message-index.ts.
 *
 * Covers:
 * - record, lookup, and forget operations
 * - (chatId, ref) -> messageId mapping
 * - LRU eviction bounds on capacity
 * - Atomic persistence to disk and reload on restart
 * - Corrupt file recovery (moving aside to *.corrupt.<timestamp>, not fatal)
 * - Input validation & sanitization (chatId, ref, messageId bounds)
 */

import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  MessageIndex,
  createMessageIndex,
  indexQuarantinePath,
} from "../dist/notifications/message-index.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

test("MessageIndex: record, lookup and forget in-memory", async () => {
  const index = new MessageIndex({ capacity: 5 });

  // Lookup non-existent
  assert.equal(index.lookup(12345, "market:1"), undefined);

  // Record market & squad
  await index.record(12345, "market:1", 101);
  await index.record(12345, "squad:42", 102);
  await index.record("-100987654321", "market:1", 201);

  assert.equal(index.size, 3);
  assert.equal(index.lookup(12345, "market:1"), 101);
  assert.equal(index.lookup(12345, "squad:42"), 102);
  assert.equal(index.lookup("-100987654321", "market:1"), 201);

  // Update existing key
  await index.record(12345, "market:1", 999);
  assert.equal(index.lookup(12345, "market:1"), 999);
  assert.equal(index.size, 3);

  // Forget
  const forgotten = await index.forget(12345, "market:1");
  assert.equal(forgotten, true);
  assert.equal(index.lookup(12345, "market:1"), undefined);
  assert.equal(index.size, 2);

  // Forget non-existent
  const forgottenAgain = await index.forget(12345, "market:1");
  assert.equal(forgottenAgain, false);
});

test("MessageIndex: validates and rejects invalid chatId, ref or messageId", async () => {
  const index = new MessageIndex();

  // Invalid ref: must start with market: or squad:
  await index.record(123, "invalid:1", 100);
  assert.equal(index.lookup(123, "invalid:1"), undefined);
  assert.equal(index.size, 0);

  // Invalid messageId: must be safe positive integer
  await index.record(123, "market:1", 0);
  await index.record(123, "market:1", -5);
  await index.record(123, "market:1", 1.5);
  assert.equal(index.lookup(123, "market:1"), undefined);
  assert.equal(index.size, 0);

  // Invalid chatId: empty string or non-integer number
  await index.record("", "market:1", 100);
  await index.record(1.23, "market:1", 100);
  assert.equal(index.size, 0);

  // Oversized ref or chatId
  await index.record("c".repeat(200), "market:1", 100);
  await index.record(123, `market:${"x".repeat(300)}`, 100);
  assert.equal(index.size, 0);
});

test("MessageIndex: LRU eviction bounds memory and file size", async () => {
  const index = new MessageIndex({ capacity: 3 });

  await index.record(1, "market:1", 101);
  await index.record(1, "market:2", 102);
  await index.record(1, "market:3", 103);
  assert.equal(index.size, 3);

  // Access market:1 so it becomes most recently used
  assert.equal(index.lookup(1, "market:1"), 101);

  // Add 4th item -> should evict market:2 (oldest LRU)
  await index.record(1, "market:4", 104);
  assert.equal(index.size, 3);
  assert.equal(index.lookup(1, "market:2"), undefined, "market:2 should have been evicted");

  // Order is now: market:3, market:1, market:4
  // If we add market:5 without looking up market:3, market:3 will be evicted
  await index.record(1, "market:5", 105);
  assert.equal(index.size, 3);
  assert.equal(index.lookup(1, "market:3"), undefined, "market:3 should be evicted");
  assert.equal(index.lookup(1, "market:1"), 101);
  assert.equal(index.lookup(1, "market:4"), 104);
  assert.equal(index.lookup(1, "market:5"), 105);
});

test("MessageIndex: persists to JSON atomically and reloads on restart", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("message-index.json");

    // First process instance
    const first = await createMessageIndex({ filePath, capacity: 5 });
    await first.record("chat-1", "market:claim-100", 1001);
    await first.record("chat-1", "squad:pool-200", 1002);

    // Verify file content is valid JSON
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.entries.length, 2);
    assert.deepEqual(parsed.entries[0], {
      chatId: "chat-1",
      ref: "market:claim-100",
      messageId: 1001,
    });

    // Forget one entry and verify file updates
    await first.forget("chat-1", "market:claim-100");
    const updatedContent = await readFile(filePath, "utf8");
    const updatedParsed = JSON.parse(updatedContent);
    assert.equal(updatedParsed.entries.length, 1);
    assert.equal(updatedParsed.entries[0].ref, "squad:pool-200");

    // Restart with second process instance
    const second = await createMessageIndex({ filePath, capacity: 5 });
    assert.equal(second.size, 1);
    assert.equal(second.lookup("chat-1", "market:claim-100"), undefined);
    assert.equal(second.lookup("chat-1", "squad:pool-200"), 1002);
  });
});

test("MessageIndex: corrupt JSON file is quarantined and not fatal", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("message-index.json");

    // Write malformed JSON
    await writeFile(filePath, "{ corrupt json ...", "utf8");

    // Load should not throw; should start empty and quarantine
    const index = await createMessageIndex({ filePath });
    assert.equal(index.size, 0);

    // The live file was moved aside
    const files = await readdir(dir.root);
    const quarantined = files.filter((f) => f.includes("message-index.json.corrupt."));
    assert.equal(quarantined.length, 1);

    // Verify the quarantined file contains the original corrupt content
    const corruptData = await readFile(dir.file(quarantined[0]), "utf8");
    assert.equal(corruptData, "{ corrupt json ...");

    // Index continues to work normally and can persist new records
    await index.record(12345, "market:1", 555);
    assert.equal(index.lookup(12345, "market:1"), 555);

    const newContent = await readFile(filePath, "utf8");
    const parsed = JSON.parse(newContent);
    assert.equal(parsed.entries.length, 1);
  });
});

test("MessageIndex: invalid schema version is quarantined as corrupt", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("message-index.json");

    // Wrong version or wrong structure
    await writeFile(
      filePath,
      JSON.stringify({ version: 99, entries: [{ chatId: 1, ref: "market:1", messageId: 10 }] }),
      "utf8",
    );

    const index = await createMessageIndex({ filePath });
    assert.equal(index.size, 0);

    const files = await readdir(dir.root);
    const quarantined = files.filter((f) => f.includes("message-index.json.corrupt."));
    assert.equal(quarantined.length, 1);
  });
});

test("MessageIndex: hand-edited file with oversized entries is bounded on load", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("message-index.json");

    const entries = [
      { chatId: 1, ref: "market:1", messageId: 101 },
      { chatId: 1, ref: "market:2", messageId: 102 },
      { chatId: 1, ref: "market:3", messageId: 103 },
      { chatId: 1, ref: "market:4", messageId: 104 },
    ];
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }),
      "utf8",
    );

    // Capacity is 2
    const index = await createMessageIndex({ filePath, capacity: 2 });
    assert.equal(index.size, 2);
    // Oldest items (market:1 and market:2) evicted
    assert.equal(index.lookup(1, "market:1"), undefined);
    assert.equal(index.lookup(1, "market:2"), undefined);
    assert.equal(index.lookup(1, "market:3"), 103);
    assert.equal(index.lookup(1, "market:4"), 104);
  });
});
