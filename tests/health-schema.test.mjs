import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configProvenance } from "../dist/config.js";
import { buildHealthReport } from "../dist/health.js";
import { createPoller } from "../dist/poller.js";
import { validate } from "./helpers/json-schema-lite.mjs";

// docs/schemas/health-report.schema.json is the published shape of GET /health.
// Every object in it is closed, so a field added, renamed or removed in
// buildHealthReport fails here until the schema is updated with it.
const schema = JSON.parse(
  readFileSync(new URL("../docs/schemas/health-report.schema.json", import.meta.url), "utf8"),
);

const MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const SQUAD_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

function config(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatIds: ["-1001234567890"],
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    // Never opened: no poller in this file is started.
    cursorFile: path.join(os.tmpdir(), "mimir-health-schema-unused", "cursor.json"),
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

/** A target with every field TargetState declares, as createPoller initialises it. */
function target(source, overrides = {}) {
  return {
    source,
    contractId: source === "market" ? MARKET_ID : SQUAD_ID,
    version: "v1",
    lastCycleMs: 0,
    maxCycleMs: 0,
    cursor: null,
    lastEventLedger: null,
    rewindFromLedger: null,
    cursorStale: false,
    gapLedgers: 0,
    cursorResetAt: null,
    cursorUnreadable: false,
    lastError: null,
    cyclesWithoutAdvance: 0,
    cursorStalled: false,
    consecutiveFailures: 0,
    nextEligibleAt: null,
    ...overrides,
  };
}

/** Cold start: the poller is running and no cycle has finished yet. */
function coldStartStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    stopping: false,
    chainClockAt: null,
    startedAt: NOW - 2_000,
    cycles: 0,
    lastCorrelationId: null,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    emptyPages: 0,
    pagesScanned: 0,
    lastCycleEmptyPages: 0,
    lastCyclePages: 0,
    notificationsDropped: 0,
    eventsDeduplicated: 0,
    cursorRewinds: 0,
    restartGaps: 0,
    lastRestartGap: null,
    consecutiveFailures: 0,
    lastError: null,
    ledgerCache: { hits: 0, misses: 0 },
    lockFile: null,
    lockPid: null,
    pendingFlush: false,
    lastFlushAt: null,
    suppressedLogs: 0,
    deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
    persistentVolumeAvailable: true,
    persistentVolumeError: null,
    targets: [target("market"), target("squad")],
    sbomDigest: null,
    circuitBreaker: { open: false, openedAt: null, failureCount: 0, lastFailureAt: null },
    ...overrides,
  };
}

/** Healthy after an hour: every optional sub-object is populated. */
function healthyStatus() {
  return coldStartStatus({
    startedAt: NOW - 3_600_000,
    cycles: 120,
    lastCorrelationId: "cycle-120",
    lastPollAt: NOW - 10_000,
    lastSuccessAt: NOW - 10_000,
    latestLedger: 5_000,
    oldestLedger: 4_000,
    chainClockAt: NOW - 12_500,
    notificationsSent: 37,
    eventsSkipped: 2,
    eventsDeduplicated: 3,
    cursorRewinds: 1,
    restartGaps: 1,
    lastRestartGap: {
      at: NOW - 3_590_000,
      source: "squad",
      cursorLedger: 3_900,
      oldestLedger: 4_000,
      missedLedgers: 100,
    },
    // An old error that later cycles recovered from.
    lastError: { at: NOW - 1_800_000, message: "getEvents failed: socket hang up" },
    lastFlushAt: NOW - 10_000,
    deadLetter: { depth: 1, enqueued: 2, replayed: 1, dropped: 0 },
    targets: [
      target("market", {
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 4_990,
        lastCycleMs: 420,
        maxCycleMs: 1_850,
      }),
      target("squad", {
        version: "v2",
        lastCycleMs: 380,
        maxCycleMs: 2_400,
        cursor: "21474836480-1",
        lastEventLedger: 4_950,
        gapLedgers: 100,
        cursorResetAt: NOW - 3_590_000,
      }),
    ],
  });
}

/** Degraded: repeated failures, a stale success, a stale and a stalled cursor. */
function degradedStatus() {
  return coldStartStatus({
    startedAt: NOW - 600_000,
    cycles: 40,
    lastCorrelationId: "cycle-40",
    lastPollAt: NOW - 5_000,
    lastSuccessAt: NOW - 300_000,
    latestLedger: 5_100,
    oldestLedger: 4_100,
    // The chain is ahead of the local clock: the skew is negative.
    chainClockAt: NOW + 4_000,
    notificationsSent: 5,
    notificationsFailed: 4,
    notificationsDropped: 1,
    consecutiveFailures: 10,
    lastError: { at: NOW - 5_000, message: "getEvents failed: 503 Service Unavailable" },
    suppressedLogs: 6,
    pendingFlush: true,
    lastFlushAt: NOW - 300_000,
    persistentVolumeAvailable: false,
    persistentVolumeError: "EACCES: data directory is not writable",
    targets: [
      target("market", {
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 4_990,
        cursorStale: true,
        rewindFromLedger: 4_100,
        lastError: "stale cursor",
        consecutiveFailures: 3,
      }),
      target("squad", {
        cursor: "0017179869184000001-0",
        cursorUnreadable: true,
        cyclesWithoutAdvance: 7,
        cursorStalled: true,
      }),
    ],
  });
}

/** Runs `fn` with `vars` applied to process.env (undefined deletes), then restores it. */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

// Real provenance reports, with env that makes every optional part appear.
const provenanceDerivedAndEmpty = withEnv(
  { MIMIR_PROFILE: undefined, TELEGRAM_CHAT_ID: "-1001234567890", POLL_INTERVAL_MS: "" },
  () => configProvenance(),
);
const provenanceUnknownProfile = withEnv({ MIMIR_PROFILE: "no-such-profile" }, () => configProvenance());
const provenanceMockProfile = withEnv({ MIMIR_PROFILE: "mock" }, () => configProvenance());

/** The report as an HTTP client receives it: through JSON.stringify, like sendJson. */
function served(status, provenance, cfg = config()) {
  return JSON.parse(JSON.stringify(buildHealthReport(cfg, status, NOW, provenance)));
}

test("the provenance fixtures exercise every optional config field", () => {
  const entries = provenanceDerivedAndEmpty.entries;
  assert.ok(entries.some((e) => e.source === "derived" && e.derivedFrom === "TELEGRAM_CHAT_ID"));
  assert.ok(entries.some((e) => e.key === "POLL_INTERVAL_MS" && e.emptyDeclaration === true));
  assert.equal(provenanceUnknownProfile.profile, "no-such-profile");
  assert.ok(provenanceUnknownProfile.warnings.length > 0);
  assert.equal(provenanceMockProfile.profile, "mock");
  assert.ok(provenanceMockProfile.entries.some((e) => e.source === "profile-default"));
});

test("a healthy report matches the schema", () => {
  const report = served(healthyStatus(), provenanceDerivedAndEmpty);
  assert.equal(report.status, "ok");
  assert.equal(report.poller.targets[0].cursorPreview.endsWith("…"), true);
  assert.deepEqual(validate(schema, report), []);
});

test("a degraded report matches the schema", () => {
  const report = served(degradedStatus(), provenanceUnknownProfile);
  assert.equal(report.status, "degraded");
  assert.equal(report.poller.chainClockSkewMs, -4_000);
  assert.deepEqual(validate(schema, report), []);
});

test("a cold-start report matches the schema", () => {
  const report = served(coldStartStatus(), provenanceMockProfile);
  assert.equal(report.status, "ok");
  assert.equal(report.poller.lastSuccessAt, null);
  assert.equal(report.poller.chainClockSkewMs, null);
  assert.equal(report.poller.targets[0].cursorPreview, null);
  assert.deepEqual(validate(schema, report), []);
});

test("stopped, paused, draining and channel-preview reports match the schema", () => {
  const reports = [
    served({ ...healthyStatus(), running: false }, provenanceDerivedAndEmpty),
    served({ ...healthyStatus(), paused: true }, provenanceDerivedAndEmpty),
    served({ ...healthyStatus(), stopping: true }, provenanceDerivedAndEmpty),
    served(healthyStatus(), provenanceDerivedAndEmpty, config({ channelPreviewMode: true })),
  ];
  assert.deepEqual(reports.map((r) => r.status), ["stopped", "ok", "ok", "ok"]);
  assert.equal(reports[3].poller.channelPreviewMode, true);
  for (const report of reports) assert.deepEqual(validate(schema, report), []);
});

test("a report built from a real poller's own status matches the schema", () => {
  const poller = createPoller({
    config: config(),
    server: {
      getHealth: async () => ({ status: "healthy", oldestLedger: 4_000, latestLedger: 5_000 }),
      getEvents: async () => ({ events: [], latestLedger: 5_000 }),
    },
    send: async () => undefined,
  });
  // Never started, so nothing is read, written or scheduled.
  const report = served(poller.status(), provenanceDerivedAndEmpty);
  assert.equal(report.status, "stopped");
  assert.deepEqual(validate(schema, report), []);
});

test("adding a field anywhere in the report fails validation", () => {
  const base = served(healthyStatus(), provenanceDerivedAndEmpty);
  const places = [
    ["$", (r) => r],
    ["$.poller", (r) => r.poller],
    ["$.poller.deadLetter", (r) => r.poller.deadLetter],
    ["$.poller.lastError", (r) => r.poller.lastError],
    ["$.poller.lastRestartGap", (r) => r.poller.lastRestartGap],
    ["$.poller.targets[1]", (r) => r.poller.targets[1]],
    ["$.config", (r) => r.config],
    ["$.config.envFile", (r) => r.config.envFile],
    ["$.config.entries[0]", (r) => r.config.entries[0]],
    ["$.config.counts", (r) => r.config.counts],
  ];
  for (const [where, pick] of places) {
    const report = structuredClone(base);
    pick(report).newField = 1;
    assert.deepEqual(validate(schema, report), [`${where}.newField: not in the schema`], where);
  }
});

test("removing, renaming or retyping a field fails validation", () => {
  const base = served(healthyStatus(), provenanceDerivedAndEmpty);

  const removed = structuredClone(base);
  delete removed.poller.cycles;
  assert.deepEqual(validate(schema, removed), ['$.poller: missing required property "cycles"']);

  const renamed = structuredClone(base);
  renamed.state = renamed.status;
  delete renamed.status;
  assert.deepEqual(validate(schema, renamed), [
    '$: missing required property "status"',
    "$.state: not in the schema",
  ]);

  const retyped = structuredClone(base);
  retyped.poller.targets[1].lastEventLedger = "4950";
  assert.deepEqual(validate(schema, retyped), [
    "$.poller.targets[1].lastEventLedger: expected integer or null, got string",
  ]);

  const unknownStatus = structuredClone(base);
  unknownStatus.status = "warning";
  assert.deepEqual(validate(schema, unknownStatus), [
    '$.status: "warning" is not one of "ok", "degraded", "stopped"',
  ]);
});

test("every object in the schema is closed and lists each emitted field as required", () => {
  // Only these two are left out of a provenance entry when they do not apply.
  const optional = new Set(["$.config.entries[].derivedFrom", "$.config.entries[].emptyDeclaration"]);
  const visit = (node, where) => {
    if (node.properties !== undefined) {
      assert.equal(node.additionalProperties, false, `${where} must set additionalProperties: false`);
      for (const [key, child] of Object.entries(node.properties)) {
        const childPath = `${where}.${key}`;
        assert.equal(node.required.includes(key), !optional.has(childPath), `${childPath} required`);
        visit(child, childPath);
      }
    }
    if (node.items !== undefined) visit(node.items, `${where}[]`);
  };
  visit(schema, "$");
});

test("json-schema-lite reports each kind of mismatch and rejects unsupported schemas", () => {
  const sample = {
    type: "object",
    additionalProperties: false,
    required: ["a", "list"],
    properties: {
      a: { type: "integer", minimum: 1 },
      list: { type: "array", items: { type: ["string", "null"], enum: ["x", null] } },
      at: { type: "string", format: "date-time" },
    },
  };
  assert.deepEqual(validate(sample, { a: 1, list: ["x", null], at: "2026-10-17T12:00:00.000Z" }), []);
  assert.deepEqual(validate(sample, { a: 1.5, list: ["y", 2], at: "yesterday", b: true }), [
    "$.a: expected integer, got number",
    '$.list[0]: "y" is not one of "x", null',
    "$.list[1]: expected string or null, got number",
    '$.at: "yesterday" is not an ISO 8601 UTC timestamp',
    "$.b: not in the schema",
  ]);
  assert.deepEqual(validate(sample, { a: 0 }), [
    '$: missing required property "list"',
    "$.a: 0 is below the minimum 1",
  ]);
  assert.throws(() => validate({ type: "string", pattern: "^x" }, "x"), /unsupported keyword "pattern"/);
  assert.throws(() => validate({ type: "object", required: ["a"] }, {}), /required "a" at \$ is not in properties/);
  assert.throws(() => validate({ type: "string", format: "email" }, "x"), /unsupported format "email"/);
});
