/**
 * Contributor environment check (doctor CLI).
 *
 * Provides a one-command verification that the local checkout and environment
 * are usable without contacting external networks (Stellar RPC or Telegram)
 * and without leaking secrets in the console output.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseDotenv } from "dotenv";

import { EXIT_ERROR, EXIT_OK } from "./exitCodes.js";
import { redactText, registerSecret } from "./redact.js";
import { MOCK_BOT_TOKEN } from "./stellar/mock-constants.js";
import { validateContractId } from "./stellar/client.js";

export type CheckStatus = "OK" | "WARN" | "FAIL";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: CheckResult[];
}

export interface DoctorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  envPath?: string;
  nodeVersion?: string;
  packageJsonPath?: string;
}

export function parseSemver(v: string): [number, number, number] | null {
  const clean = v.replace(/^v/i, "").trim();
  const match = clean.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match || match[1] === undefined) return null;
  return [
    parseInt(match[1], 10),
    match[2] !== undefined ? parseInt(match[2], 10) : 0,
    match[3] !== undefined ? parseInt(match[3], 10) : 0,
  ];
}

export function satisfiesNodeEngine(currentVersion: string, requirement: string): boolean {
  const current = parseSemver(currentVersion);
  if (!current) return false;

  const req = requirement.trim();
  if (req === "*" || req === "x" || req === "") return true;

  const gteMatch = req.match(/^>=?\s*([0-9v.]+)/i);
  if (gteMatch && gteMatch[1] !== undefined) {
    const isStrict = req.startsWith(">") && !req.startsWith(">=");
    const target = parseSemver(gteMatch[1]);
    if (!target) return false;
    if (isStrict) {
      if (current[0] > target[0]) return true;
      if (current[0] === target[0] && current[1] > target[1]) return true;
      if (current[0] === target[0] && current[1] === target[1] && current[2] > target[2]) return true;
      return false;
    }
    if (current[0] > target[0]) return true;
    if (current[0] === target[0] && current[1] > target[1]) return true;
    if (current[0] === target[0] && current[1] === target[1] && current[2] >= target[2]) return true;
    return false;
  }

  const caretMatch = req.match(/^\^\s*([0-9v.]+)/i);
  if (caretMatch && caretMatch[1] !== undefined) {
    const target = parseSemver(caretMatch[1]);
    if (!target) return false;
    if (current[0] !== target[0]) return false;
    if (current[1] > target[1]) return true;
    if (current[1] === target[1] && current[2] >= target[2]) return true;
    return false;
  }

  const simpleMatch = req.match(/^([0-9]+)(?:\.([0-9]+|x))?(?:\.([0-9]+|x))?/i);
  if (simpleMatch && simpleMatch[1] !== undefined) {
    const maj = parseInt(simpleMatch[1], 10);
    if (simpleMatch[2] === undefined || simpleMatch[2].toLowerCase() === "x") {
      return current[0] === maj;
    }
    const min = parseInt(simpleMatch[2], 10);
    if (simpleMatch[3] === undefined || simpleMatch[3].toLowerCase() === "x") {
      return current[0] === maj && current[1] === min;
    }
    const patch = parseInt(simpleMatch[3], 10);
    return current[0] === maj && current[1] === min && current[2] === patch;
  }

  return false;
}

function findPackageEngines(cwd: string, explicitPath?: string): { enginesNode?: string; error?: string } {
  const candidatePaths = explicitPath
    ? [explicitPath]
    : [
        path.join(cwd, "package.json"),
        path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"),
      ];

  for (const p of candidatePaths) {
    try {
      if (existsSync(p)) {
        const content = readFileSync(p, "utf8");
        const parsed = JSON.parse(content) as { engines?: { node?: unknown } };
        if (parsed.engines && typeof parsed.engines.node === "string") {
          return { enginesNode: parsed.engines.node };
        }
      }
    } catch (err) {
      return { error: `Failed to read package.json at ${p}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return {};
}

const TELEGRAM_TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{15,}$/;

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const checks: CheckResult[] = [];

  // 1. Node version check
  const currentVersion = options.nodeVersion ?? process.version;
  const { enginesNode } = findPackageEngines(cwd, options.packageJsonPath);

  if (enginesNode) {
    if (satisfiesNodeEngine(currentVersion, enginesNode)) {
      checks.push({
        name: "node-version",
        status: "OK",
        message: `Node.js version ${currentVersion} satisfies engines requirement (${enginesNode})`,
      });
    } else {
      checks.push({
        name: "node-version",
        status: "FAIL",
        message: `Node.js version ${currentVersion} does not satisfy engines requirement (${enginesNode})`,
      });
    }
  } else {
    checks.push({
      name: "node-version",
      status: "WARN",
      message: `Node.js version ${currentVersion} (engines.node not found in package.json)`,
    });
  }

  // 2. Presence of .env
  const explicitEnvPath = options.envPath ?? options.env?.DOTENV_CONFIG_PATH ?? process.env.DOTENV_CONFIG_PATH;
  const envFilePath = explicitEnvPath ? path.resolve(cwd, explicitEnvPath) : path.join(cwd, ".env");
  const relEnvPath = path.relative(cwd, envFilePath) || ".env";

  let parsedDotenv: Record<string, string> = {};
  if (existsSync(envFilePath)) {
    try {
      const content = readFileSync(envFilePath, "utf8");
      parsedDotenv = parseDotenv(content);
      checks.push({
        name: "env-file",
        status: "OK",
        message: `.env file found (${relEnvPath})`,
      });
    } catch (err) {
      checks.push({
        name: "env-file",
        status: "FAIL",
        message: `Failed to read .env file (${relEnvPath}): ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    checks.push({
      name: "env-file",
      status: "FAIL",
      message: `.env file missing (${relEnvPath} not found; copy from .env.example)`,
    });
  }

  // Merge loaded dotenv with provided/process env (process env overrides file)
  const envSource = options.env ?? process.env;
  const effectiveEnv: Record<string, string | undefined> = { ...parsedDotenv };
  for (const [k, v] of Object.entries(envSource)) {
    if (v !== undefined) {
      effectiveEnv[k] = v;
    }
  }

  // Register secrets so any accidental print would still be masked
  if (effectiveEnv.BOT_TOKEN) {
    registerSecret(effectiveEnv.BOT_TOKEN);
  }

  // 3. Writability of cursor directory
  const cursorSetting = effectiveEnv.CURSOR_FILE || "./data/cursor.json";
  const resolvedCursorPath = path.resolve(cwd, cursorSetting);
  const cursorDir = path.dirname(resolvedCursorPath);
  const relCursorDir = path.relative(cwd, cursorDir) || cursorDir;

  try {
    if (!existsSync(cursorDir)) {
      await mkdir(cursorDir, { recursive: true });
    }
    const probeFile = path.join(
      cursorDir,
      `.doctor-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(probeFile, "probe", "utf8");
    await unlink(probeFile);
    checks.push({
      name: "cursor-directory",
      status: "OK",
      message: `Cursor directory is writable (${relCursorDir})`,
    });
  } catch (err) {
    checks.push({
      name: "cursor-directory",
      status: "FAIL",
      message: `Cursor directory is not writable (${relCursorDir}): ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 4. Contract IDs validation via validateContractId
  for (const contractField of ["MARKET_CONTRACT_ID", "SQUAD_CONTRACT_ID"] as const) {
    const rawVal = effectiveEnv[contractField];
    if (rawVal === undefined || rawVal.trim() === "") {
      checks.push({
        name: contractField,
        status: "FAIL",
        message: `${contractField} is missing or empty`,
      });
      continue;
    }
    try {
      validateContractId(rawVal.trim(), contractField);
      const trimmed = rawVal.trim();
      const truncated = `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
      checks.push({
        name: contractField,
        status: "OK",
        message: `${contractField} format is valid (${truncated})`,
      });
    } catch (err) {
      checks.push({
        name: contractField,
        status: "FAIL",
        message: `${contractField}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 5. Bot token shape check (checked only for shape; value never output)
  const botToken = effectiveEnv.BOT_TOKEN;
  if (botToken === undefined || botToken.trim() === "") {
    checks.push({
      name: "BOT_TOKEN",
      status: "WARN",
      message: "BOT_TOKEN is unset or empty (required for Telegram bot; optional for offline scanner)",
    });
  } else {
    const trimmedToken = botToken.trim();
    if (TELEGRAM_TOKEN_SHAPE.test(trimmedToken)) {
      checks.push({
        name: "BOT_TOKEN",
        status: "OK",
        message: "BOT_TOKEN shape is valid (<digits>:<token>)",
      });
    } else if (trimmedToken === MOCK_BOT_TOKEN || effectiveEnv.MIMIR_PROFILE === "mock") {
      checks.push({
        name: "BOT_TOKEN",
        status: "OK",
        message: "BOT_TOKEN using mock profile placeholder",
      });
    } else {
      checks.push({
        name: "BOT_TOKEN",
        status: "FAIL",
        message: "BOT_TOKEN does not match expected Telegram bot token shape (<digits>:<token>)",
      });
    }
  }

  // 6. Telegram chat ID (warn if unset, fail if malformed)
  const chatId = effectiveEnv.TELEGRAM_CHAT_ID;
  if (chatId === undefined || chatId.trim() === "") {
    checks.push({
      name: "TELEGRAM_CHAT_ID",
      status: "WARN",
      message: "TELEGRAM_CHAT_ID is unset (required for Telegram bot)",
    });
  } else {
    const ids = chatId
      .trim()
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const invalid = ids.filter((id) => !/^-?\d+$/.test(id) && !/^@[A-Za-z0-9_]{4,}$/.test(id));
    if (invalid.length > 0) {
      checks.push({
        name: "TELEGRAM_CHAT_ID",
        status: "FAIL",
        message: "TELEGRAM_CHAT_ID contains an invalid chat ID (expected numeric ID or @channelusername)",
      });
    } else {
      checks.push({
        name: "TELEGRAM_CHAT_ID",
        status: "OK",
        message: `TELEGRAM_CHAT_ID format is valid (${ids.length} destination${ids.length === 1 ? "" : "s"})`,
      });
    }
  }

  const ok = !checks.some((c) => c.status === "FAIL");
  return { ok, checks };
}

export function formatCheckLine(check: CheckResult): string {
  const tag = `[${check.status}]`.padEnd(8, " ");
  return redactText(`${tag} ${check.message}`);
}

async function main(): Promise<void> {
  const report = await runDoctor();
  for (const check of report.checks) {
    console.log(formatCheckLine(check));
  }
  process.exit(report.ok ? EXIT_OK : EXIT_ERROR);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  main().catch((err: unknown) => {
    console.error(`[doctor] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_ERROR);
  });
}
