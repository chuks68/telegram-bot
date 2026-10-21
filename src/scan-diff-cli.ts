import { readFileSync } from "node:fs";

export interface ScanEvent {
  id: string;
  ledger: number;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ScanReport {
  events?: ScanEvent[];
  [code: string]: unknown;
}

export type FieldDiff = {
  field: string;
  before: unknown;
  after: unknown;
};

export type EventDiff = {
  id: string;
  ledger: number;
  status: "added" | "removed" | "changed";
  fields?: FieldDiff[];
};

const BIGINT_REGEX = /^-?\d+$/;

function isBigIntString(value: unknown): value is string {
  return typeof value === "string" && BIGINT_REGEX.test(value);
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (isBigIntString(a) && isBigIntString(b)) {
    try {
      return BigInt(a) === BigInt(b);
    } catch {
      return false;
    }
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => valuesEqual(item, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) {
        return false;
      }
    }
    return aKeys.every((key) =>
      valuesEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}

function comparePayloads(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): FieldDiff[] {
  const a = normalizeValue(before ?? {}) as Record<string, unknown>;
  const b = normalizeValue(after ?? {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  const diffs: FieldDiff[] = [];
  for (const key of keys) {
    const hasA = Object.prototype.hasOwnProperty.call(a, key);
    const hasB = Object.prototype.hasOwnProperty.call(b, key);
    if (!hasA) {
      diffs.push({ field: key, before: undefined, after: b[key] });
    } else if (!hasB) {
      diffs.push({ field: key, before: a[key], after: undefined });
    } else if (!valuesEqual(a[key], b[key])) {
      diffs.push({ field: key, before: a[key], after: b[key] });
    }
  }
  return diffs;
}

export function diffScans(
  beforeReport: ScanReport,
  afterReport: ScanReport,
): EventDiff[] {
  const beforeEvents = Array.isArray(beforeReport.events) ? beforeReport.events : [];
  const afterEvents = Array.isArray(afterReport.events) ? afterReport.events : [];
  const beforeMap = new Map<string, ScanEvent>();
  const afterMap = new Map<string, ScanEvent>();
  for (const ev of beforeEvents) {
    if (ev && typeof ev.id === "string") {
      beforeMap.set(ev.id, ev);
    }
  }
  for (const ev of afterEvents) {
    if (ev && typeof ev.id === "string") {
      afterMap.set(ev.id, ev);
    }
  }

  const diffs: EventDiff[] = [];
  const allIds = Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()]));
  for (const id of allIds) {
    const before = beforeMap.get(id);
    const after = afterMap.get(id);
    if (!before && after) {
      diffs.push({ id, ledger: Number(after.ledger ?? 0), status: "added" });
    } else if (before && !after) {
      diffs.push({ id, ledger: Number(before.ledger ?? 0), status: "removed" });
    } else if (before && after) {
      const fields = comparePayloads(before.payload, after.payload);
      if (fields.length > 0) {
        diffs.push({
          id,
          ledger: Number(after.ledger ?? before.ledger ?? 0),
          status: "changed",
          fields,
        });
      }
    }
  }

  diffs.sort((a, b) => {
    if (a.ledger !== b.ledger) {
      return a.ledger - b.ledger;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return diffs;
}

export function formatDiffs(diffs: EventDiff[]): string {
  if (diffs.length === 0) {
    return "No differences.\n";
  }
  const lines: string[] = [];
  for (const d of diffs) {
    lines.push(`[${d.status.toUpperCase()}] ledger=${d.ledger} id=${d.id}`);
    if (d.fields && d.fields.length > 0) {
      for (const f of d.fields) {
        lines.push(
          `  ${f.field}: ${formatValue(f.before)} -> ${formatValue(f.after)}`,
        );
      }
    }
  }
  return lines.join("\n") + "\n";
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return "<undefined>";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(normalizeValue(value));
  } catch {
    return String(value);
  }
}

function parseReport(raw: string, label: string): ScanReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${label}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid report in ${label}: expected an object`);
  }
  const report = parsed as ScanReport;
  if (report.events !== undefined && !Array.isArray(report.events)) {
    throw new Error(`Invalid report in ${label}: "events" must be an array`);
  }
  return report;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.length !== 2) {
    process.stderr.write("Usage: scan-diff <before.json> <after.json>\n");
    return 2;
  }
  const [beforePath, afterPath] = argv;
  let beforeReport: ScanReport;
  let afterReport: ScanReport;
  try {
    beforeReport = parseReport(readFileSync(beforePath!, "utf8"), beforePath!);
    afterReport = parseReport(readFileSync(afterPath!, "utf8"), afterPath!);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  const diffs = diffScans(beforeReport, afterReport);
  process.stdout.write(formatDiffs(diffs));
  return diffs.length === 0 ? 0 : 1;
}

if (typeof require !== "undefined" && require.main === module) {
  process.exitCode = main();
}
