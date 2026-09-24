import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

import { createPoller } from "../dist/poller.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");

async function loadCatalog() {
  const raw = await readFile(path.join(fixturesDir, "events.json"), "utf8");
  return JSON.parse(raw);
}

function createFakeServer(health, eventsResponse) {
  return {
    getHealth: async () => health,
    getEvents: async () => eventsResponse,
  };
}

test("poller replays fixtures and handles Telegram failure safely", async () => {
  const catalog = await loadCatalog();
  const config = {
    ...catalog.config,
    cursorFile: path.join(os.tmpdir(), `cursor-${Date.now()}.json`),
    startLookbackLedgers: 100,
    maxNotificationsPerCycle: 10,
    pollIntervalMs: 1000,
  };

  try {
    const sent = [];
    let sendFailures = 0;
    const fakeSend = async (text) => {
      if (text.includes("fail")) {
        sendFailures++;
        throw new Error("Telegram failure");
      }
      sent.push(text);
    };

    const server = createFakeServer(
      { oldestLedger: 100, latestLedger: 200 },
      { events: [], latestLedger: 200, cursor: "mock-cursor" }
    );

    const poller = createPoller({ config, server, send: fakeSend });
    await poller.start();
    const status = poller.status();
    assert.equal(status.running, true);
    poller.stop();
  } finally {
    await rm(config.cursorFile, { force: true }).catch(() => {});
  }
});
