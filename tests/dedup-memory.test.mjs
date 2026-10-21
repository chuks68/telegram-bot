/**
 * Memory budget and O(1) operation cost verification for `EventDedupWindow`
 * under 100,000-event bursts.
 *
 * Spawns a dedicated `node --expose-gc` child process so forced garbage
 * collection (`globalThis.gc()`) is deterministic and isolated from any other
 * test suite sharing the runner.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { DEFAULT_DEDUP_WINDOW } from "../dist/dedup.js";

const execFileAsync = promisify(execFile);
const DIST_DEDUP = new URL("../dist/dedup.js", import.meta.url).href;

/** Total unique keys pushed through the deduplication window during the burst. */
const BURST_KEYS = 100_000;

/**
 * Documented heap growth budget across a 100k-key burst after forced GC: 4 MiB.
 *
 * A 256-entry window retains only a few tens of kilobytes (~85 KiB measured),
 * whereas an unbounded structure retaining all 100k keys consumes >10 MiB.
 * 4 MiB (matching `tests/soak.test.mjs`) gives ~45x headroom for V8 heap
 * page/fragmentation noise on CI while reliably catching any O(N) leak.
 */
const MAX_HEAP_GROWTH_BYTES = 4 * 1024 * 1024;

/**
 * Generous CI-safe upper bounds on average per-operation cost (microseconds).
 *
 * Measured V8 `Set`-backed costs are ~2.5 us/op for key construction + `add()`
 * (with oldest-key eviction) and ~0.12 us/op for `has()`. A 50 us/op ceiling
 * for `add` and 25 us/op ceiling for `has` tolerate heavily contended CI
 * runners while catching accidental O(N) scans.
 */
const MAX_ADD_US_PER_OP = 50;
const MAX_HAS_US_PER_OP = 25;

const CHILD_PROBE_SCRIPT = `
import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey } from ${JSON.stringify(DIST_DEDUP)};

if (typeof globalThis.gc !== "function") {
  throw new Error("Expected --expose-gc to provide globalThis.gc()");
}

const totalKeys = Number(process.argv[1]) || 100_000;
const capacity = Number(process.argv[2]) || DEFAULT_DEDUP_WINDOW;
const txHash = "a".repeat(64);

function makeKey(i) {
  return eventKey({ id: \`v2:\${4_226_500 + (i >> 4)}:\${txHash}:\${i & 15}:0:\${i.toString(16).padStart(16, "0")}\` });
}

function forceGc() {
  globalThis.gc();
  globalThis.gc();
}

// Warm up V8 JIT and string/Set code paths before sampling baseline heap.
{
  const warmup = new EventDedupWindow(capacity);
  for (let i = 0; i < 2_000; i += 1) {
    const k = makeKey(i);
    warmup.add(k);
    warmup.has(k);
  }
}

const window = new EventDedupWindow(capacity);
forceGc();
const baselineHeap = process.memoryUsage().heapUsed;

const checkpoints = 4;
const batchSize = totalKeys / checkpoints;
const heapSamples = [];
const batchAddUsPerOp = [];
let totalAddNs = 0n;
let accepted = 0;

for (let c = 0; c < checkpoints; c += 1) {
  const startIdx = c * batchSize;
  const endIdx = startIdx + batchSize;
  const t0 = process.hrtime.bigint();
  for (let i = startIdx; i < endIdx; i += 1) {
    if (window.add(makeKey(i))) accepted += 1;
  }
  const elapsedNs = process.hrtime.bigint() - t0;
  totalAddNs += elapsedNs;
  batchAddUsPerOp.push(Number(elapsedNs) / 1_000 / batchSize);

  forceGc();
  heapSamples.push(process.memoryUsage().heapUsed);
}

const finalHeap = heapSamples[heapSamples.length - 1];
const retainedKeys = window.toJSON();
const evictedProbeKeys = Array.from({ length: capacity }, (_, i) => makeKey(i));

// Measure O(1) lookup cost across 100k mixed hits (retained) and misses (evicted).
let hits = 0;
const lookupCount = totalKeys;
const lookupT0 = process.hrtime.bigint();
for (let i = 0; i < lookupCount; i += 1) {
  const probe = (i & 1) === 0
    ? retainedKeys[i % retainedKeys.length]
    : evictedProbeKeys[i % evictedProbeKeys.length];
  if (window.has(probe)) hits += 1;
}
const totalHasNs = process.hrtime.bigint() - lookupT0;

const report = {
  capacity,
  totalKeys,
  accepted,
  finalSize: window.size,
  hits,
  baselineHeap,
  finalHeap,
  heapGrowthBytes: finalHeap - baselineHeap,
  maxHeapGrowthBytes: Math.max(...heapSamples) - baselineHeap,
  heapSamples,
  addUsPerOp: Number(totalAddNs) / 1_000 / totalKeys,
  hasUsPerOp: Number(totalHasNs) / 1_000 / lookupCount,
  batchAddUsPerOp,
  oldestRetained: retainedKeys[0],
  newestRetained: retainedKeys[retainedKeys.length - 1],
  expectedOldest: makeKey(totalKeys - capacity),
  expectedNewest: makeKey(totalKeys - 1),
};

process.stdout.write(JSON.stringify(report));
`;

async function runMemoryProbe(totalKeys = BURST_KEYS, capacity = DEFAULT_DEDUP_WINDOW) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--expose-gc", "--input-type=module", "-e", CHILD_PROBE_SCRIPT, String(totalKeys), String(capacity)],
    {
      env: { PATH: process.env.PATH },
      timeout: 60_000,
    },
  );
  return JSON.parse(stdout);
}

test(
  "EventDedupWindow stays within a fixed memory budget and O(1) time per op across 100k unique keys",
  { timeout: 60_000 },
  async (t) => {
    const report = await runMemoryProbe(BURST_KEYS, DEFAULT_DEDUP_WINDOW);

    t.diagnostic(
      `dedup 100k burst: heapGrowth=${(report.heapGrowthBytes / 1024).toFixed(1)} KiB ` +
        `(max=${(report.maxHeapGrowthBytes / 1024).toFixed(1)} KiB), ` +
        `add=${report.addUsPerOp.toFixed(3)} us/op, has=${report.hasUsPerOp.toFixed(3)} us/op`,
    );

    // Window bounds & eviction correctness after 100k unique insertions.
    assert.equal(report.accepted, BURST_KEYS, "every unique key in the 100k burst is accepted once");
    assert.equal(report.finalSize, DEFAULT_DEDUP_WINDOW, "window size stays capped at EVENT_DEDUP_WINDOW");
    assert.equal(report.oldestRetained, report.expectedOldest, "oldest retained key is N - capacity");
    assert.equal(report.newestRetained, report.expectedNewest, "newest retained key is N - 1");
    assert.equal(report.hits, BURST_KEYS / 2, "retained keys hit and evicted keys miss");

    // Memory stays within the fixed budget across all GC checkpoints.
    assert.ok(
      report.heapGrowthBytes < MAX_HEAP_GROWTH_BYTES,
      `expected final heap growth < ${MAX_HEAP_GROWTH_BYTES} bytes, got ${report.heapGrowthBytes} bytes`,
    );
    assert.ok(
      report.maxHeapGrowthBytes < MAX_HEAP_GROWTH_BYTES,
      `expected peak checkpoint heap growth < ${MAX_HEAP_GROWTH_BYTES} bytes, got ${report.maxHeapGrowthBytes} bytes`,
    );

    // Average insertion+eviction and lookup costs stay within O(1) bounds.
    assert.ok(
      report.addUsPerOp < MAX_ADD_US_PER_OP,
      `expected average add+evict time < ${MAX_ADD_US_PER_OP} us/op, got ${report.addUsPerOp.toFixed(3)} us/op`,
    );
    assert.ok(
      report.hasUsPerOp < MAX_HAS_US_PER_OP,
      `expected average has() lookup time < ${MAX_HAS_US_PER_OP} us/op, got ${report.hasUsPerOp.toFixed(3)} us/op`,
    );
    for (const [idx, batchUs] of report.batchAddUsPerOp.entries()) {
      assert.ok(
        batchUs < MAX_ADD_US_PER_OP,
        `expected checkpoint ${idx + 1} add+evict time < ${MAX_ADD_US_PER_OP} us/op, got ${batchUs.toFixed(3)} us/op`,
      );
    }
  },
);
