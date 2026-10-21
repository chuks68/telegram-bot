import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createEventArchive, readArchive } from "../dist/stellar/archive.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeDummyEvent(id, amountBigInt = 10000000n) {
  return {
    source: "market",
    ledger: 100 + id,
    txHash: `0xdeadbeef${id}`,
    eventId: `event-${id}`,
    txIndex: 1,
    operationIndex: 1,
    topicName: "claim_created",
    contractId: "C1234567890",
    blockTime: 1700000000 + id,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: "GABCD",
      stake: amountBigInt,
      question: `Question ${id}`,
      deadline: 1700001000,
      feeBps: 100,
    },
  };
}

test("archive creates files with 0o600 permissions and appends events", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const archive = createEventArchive({ dir: archiveDir });

    const event1 = makeDummyEvent(1, 5000000000000000000n);
    await archive.append([event1]);
    await archive.close();

    // Verify file exists and has 0o600 permissions (on platforms that support it)
    const readBack = [];
    for await (const ev of readArchive(archiveDir)) {
      readBack.push(ev);
    }

    assert.equal(readBack.length, 1);
    assert.equal(readBack[0].eventId, "event-1");
    // Verify bigint round-trip as string
    assert.equal(readBack[0].payload.stake, "5000000000000000000");

    // Check mode if on posix
    if (process.platform !== "win32") {
      const files = await import("node:fs/promises").then((fs) => fs.readdir(archiveDir));
      assert.ok(files.length > 0);
      const st = await stat(path.join(archiveDir, files[0]));
      assert.equal(st.mode & 0o777, 0o600);
    }
  });
});

test("archive rotates by size and preserves ordering across files", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    // Set maxBytes small enough so each event triggers a new file or rotation
    const archive = createEventArchive({
      dir: archiveDir,
      maxBytes: 250,
      maxFiles: 10,
    });

    const events = [];
    for (let i = 1; i <= 5; i++) {
      events.push(makeDummyEvent(i, BigInt(i * 1000)));
    }

    // Append one by one or in batches
    await archive.append(events);
    await archive.close();

    const readBack = [];
    for await (const ev of readArchive(archiveDir)) {
      readBack.push(ev);
    }

    assert.equal(readBack.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(readBack[i].eventId, `event-${i + 1}`);
      assert.equal(readBack[i].payload.stake, String((i + 1) * 1000));
    }
  });
});

test("archive enforces maxFiles retention on rotation", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const archive = createEventArchive({
      dir: archiveDir,
      maxBytes: 250,
      maxFiles: 3,
    });

    // Write 6 events, each in a separate rotation
    for (let i = 1; i <= 6; i++) {
      await archive.append([makeDummyEvent(i, BigInt(i))]);
    }
    await archive.close();

    const fs = await import("node:fs/promises");
    const files = await fs.readdir(archiveDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    assert.ok(jsonlFiles.length <= 3, `Expected <= 3 files, found ${jsonlFiles.length}`);

    // Read back remaining events
    const readBack = [];
    for await (const ev of readArchive(archiveDir)) {
      readBack.push(ev);
    }

    // Older files were purged, but remaining ones must be in order
    assert.ok(readBack.length <= 6);
    assert.ok(readBack.length >= 3);
    const lastEvent = readBack[readBack.length - 1];
    assert.equal(lastEvent.eventId, "event-6");

    // Check monotonic order of remaining events
    for (let i = 1; i < readBack.length; i++) {
      assert.ok(readBack[i].ledger > readBack[i - 1].ledger);
    }
  });
});

test("archive rotation never loses or duplicates a line", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    // Large maxFiles so nothing is purged
    const archive = createEventArchive({
      dir: archiveDir,
      maxBytes: 300,
      maxFiles: 100,
    });

    const total = 20;
    const allEvents = [];
    for (let i = 1; i <= total; i++) {
      allEvents.push(makeDummyEvent(i, BigInt(i * 12345)));
    }

    // Append in mixed batches
    await archive.append(allEvents.slice(0, 5));
    await archive.append(allEvents.slice(5, 12));
    await archive.append(allEvents.slice(12));
    await archive.close();

    const readBack = [];
    for await (const ev of readArchive(archiveDir)) {
      readBack.push(ev);
    }

    assert.equal(readBack.length, total);
    for (let i = 0; i < total; i++) {
      assert.equal(readBack[i].eventId, `event-${i + 1}`);
      assert.equal(readBack[i].payload.stake, String((i + 1) * 12345));
    }
  });
});
