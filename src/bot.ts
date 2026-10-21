/**
 * The grammy bot: commands, and the one send path the poller uses.
 *
 * The bot half is deliberately thin. It answers public status and contract
 * commands plus operator pause/resume controls. Operator controls only change
 * when the next polling cycle starts; they never edit cursors or touch chain
 * state. All chain logic lives in `src/poller.ts` and `src/stellar/`.
 */

import { Bot, InlineKeyboard, type Context, type CommandContext } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { performance } from "node:perf_hooks";

import {
  escapeMd,
  formatLastEvent,
  splitTelegramMessage,
  previewMessage,
  safeErrorMessage,
  type ExplorerKeyboard,
} from "./notifications/format.js";
import { formatFeatureFlags } from "./notifications/featureFlags.js";
import { DEFAULT_SILENT_EVENTS, isSilent } from "./notifications/priority.js";
export { previewMessage } from "./notifications/format.js";
import { formatProvenanceSummary, networkLabel, type BotConfig } from "./config.js";
import { contractExplorerUrl } from "./stellar/client.js";
import type { ContractSource } from "./stellar/decode.js";
import { buildHealthReport, chainClockLabel } from "./health.js";
import { renderLogExport, type LogCapture } from "./logger.js";
import type { PollerPauseResult, PollerResumeResult, PollerStatus } from "./poller.js";
import {
  AUDIT_REPORT_MAX_ENTRIES,
  readAuditFile,
  renderAuditReport,
  type AuditFileSummary,
  type AuditLog,
} from "./audit.js";
import {
  AUDIT_CLI_HINT,
  COMMAND_DESCRIPTIONS,
  HELP_INTRO,
  HELP_TITLE,
  PAUSE_MESSAGES,
  RESUME_MESSAGES,
} from "./i18n.js";
import { helpDetailMessage } from "./commands/help-detail.js";
import { aboutMessage } from "./commands/about.js";
export { helpDetailMessage, COMMAND_DETAILS, type CommandDetail } from "./commands/help-detail.js";
import { handlePingCommand } from "./commands/ping.js";
export {
  handlePingCommand,
  pingCommand,
  pongMessage,
  formatPong,
  type PingDeps,
  type Clock,
} from "./commands/ping.js";
import {
  handleBroadcastCallback,
  registerBroadcastHandlers,
  type BroadcastStore,
} from "./commands/broadcast.js";

/** Shared metadata for handlers, help, and Telegram's command menu. */
export const COMMANDS = [
  { command: "start", description: COMMAND_DESCRIPTIONS.start, operatorOnly: false },
  { command: "help", description: COMMAND_DESCRIPTIONS.help, operatorOnly: false },
  { command: "about", description: COMMAND_DESCRIPTIONS.about, operatorOnly: false },
  { command: "status", description: COMMAND_DESCRIPTIONS.status, operatorOnly: false },
  { command: "audit", description: COMMAND_DESCRIPTIONS.audit, operatorOnly: true },
  { command: "contracts", description: COMMAND_DESCRIPTIONS.contracts, operatorOnly: false },
  { command: "health", description: COMMAND_DESCRIPTIONS.health, operatorOnly: false },
  { command: "preview", description: COMMAND_DESCRIPTIONS.preview, operatorOnly: false },
  { command: "ping", description: COMMAND_DESCRIPTIONS.ping, operatorOnly: false },
  { command: "pause", description: COMMAND_DESCRIPTIONS.pause, operatorOnly: true },
  { command: "resume", description: COMMAND_DESCRIPTIONS.resume, operatorOnly: true },
] as const;

function visibleCommands(config?: BotConfig) {
  return COMMANDS.filter((command) =>
    !command.operatorOnly || config === undefined || config.operatorTelegramUserId !== null,
  );
}
export {
  handleBroadcastCallback,
  registerBroadcastHandlers,
  handleBroadcastCommand,
  getConfiguredBroadcastChats,
  BroadcastStore,
  sendBroadcast,
} from "./commands/broadcast.js";

/**
 * How long a pause-confirmation message stays valid.
 * Callbacks arriving after this window are rejected as stale.
 */
export const PAUSE_CONFIRM_TTL_MS = 60_000;

/**
 * The two callback_data strings used by the pause confirmation flow.
 * Both are well under Telegram's 64-byte limit.
 */
export const CALLBACK_PAUSE_CONFIRM = "pause-confirm" as const;
export const CALLBACK_PAUSE_CANCEL = "pause-cancel" as const;

/** Inline keyboard attached to the pause confirmation message. */
export function pauseConfirmationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm pause", CALLBACK_PAUSE_CONFIRM)
    .text("❌ Cancel", CALLBACK_PAUSE_CANCEL);
}

type PauseCallbackAction = typeof CALLBACK_PAUSE_CONFIRM | typeof CALLBACK_PAUSE_CANCEL;

export function validatePauseCallbackData(data: unknown): PauseCallbackAction | null {
  return data === CALLBACK_PAUSE_CONFIRM || data === CALLBACK_PAUSE_CANCEL ? data : null;
}

const HELP_BASE = [
  "*Mimir notifier*",
  "",
  "I watch Mimir's two Soroban contracts on Stellar and post every new on-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts\\.",
  "",
  "/status — what I am watching and how far I have read",
  "/contracts — the contract ids I watch and where to look them up",
  "/health — health assessment and operational readiness",
  "/preview — preview channel notification formatting",
  "/help — this message",
];

export function helpMessage(config?: BotConfig): string {
  if (!config || config.operatorTelegramUserId === null) return HELP_BASE.join("\n");
  return [
    HELP_TITLE,
    "",
    escapeMd(HELP_INTRO),
    "",
    ...visibleCommands(config).map(({ command, description }) =>
      escapeMd(`/${command} — ${description}`),
    ),
  ].join("\n");
}

export const TELEGRAM_OPTIONS = {
  parse_mode: "MarkdownV2" as const,
  link_preview_options: { is_disabled: true },
};

// ── Inline keyboard callbacks ────────────────────────────────────────────────
// Callback data is untrusted user input: it is validated before any action
// runs, and operator actions are authorized exactly like /pause and /resume.

export type CallbackActionType = "status" | "contracts" | "help" | "pause" | "resume" | "broadcast";

export interface ValidCallbackAction {
  type: CallbackActionType;
  raw: string;
}

export type CallbackValidationResult =
  | { ok: true; action: ValidCallbackAction }
  | { ok: false; reason: string; fallbackText: string };

/** Telegram's Bot API limits callback_data to 1-64 bytes. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export const CALLBACK_FALLBACK_PAYLOAD =
  "*Invalid request*\nThe requested action is unrecognized or malformed\\.";

export const CALLBACK_UNAUTHORIZED_PAYLOAD =
  "*Unauthorized*\nThis action requires operator privileges\\.";

export const CALLBACK_FALLBACK_FEEDBACK = "Invalid or unrecognized action";
export const CALLBACK_UNAUTHORIZED_FEEDBACK = "Unauthorized: operator only";


function isKnownAction(val: string): val is CallbackActionType {
  return ["status", "contracts", "help", "pause", "resume", "broadcast"].includes(val);
}

/**
 * Validate untrusted callback-query data before any action is executed.
 * Treats all callback data as untrusted external user input.
 */
export function validateCallbackData(raw: unknown): CallbackValidationResult {
  if (typeof raw !== "string") {
    return {
      ok: false,
      reason: "missing-or-non-string",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: "empty",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  const byteLength = Buffer.byteLength(raw, "utf8");
  if (byteLength > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    return {
      ok: false,
      reason: "exceeds-max-length",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  // Reject ASCII control characters (including null bytes)
  if (/[\x00-\x1F\x7F]/.test(raw)) {
    return {
      ok: false,
      reason: "control-characters",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  // 1. JSON payload: e.g. {"action":"status"}
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { action?: unknown };
      if (typeof parsed?.action === "string" && isKnownAction(parsed.action)) {
        return {
          ok: true,
          action: { type: parsed.action, raw },
        };
      }
      return {
        ok: false,
        reason: "unknown-json-action",
        fallbackText: CALLBACK_FALLBACK_FEEDBACK,
      };
    } catch {
      return {
        ok: false,
        reason: "malformed-json",
        fallbackText: CALLBACK_FALLBACK_FEEDBACK,
      };
    }
  }

  // 2. Colon-delimited: e.g. "status:refresh", "mimir:contracts", etc.
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    if (parts[0] === "mimir" && parts[1] && isKnownAction(parts[1])) {
      return {
        ok: true,
        action: { type: parts[1], raw },
      };
    }
    if (parts[0] && isKnownAction(parts[0])) {
      return {
        ok: true,
        action: { type: parts[0], raw },
      };
    }
    return {
      ok: false,
      reason: "unknown-action",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  // 3. Direct action token: "status", "contracts", "help", "pause", "resume"
  if (isKnownAction(trimmed)) {
    return {
      ok: true,
      action: { type: trimmed, raw },
    };
  }

  return {
    ok: false,
    reason: "unknown-action",
    fallbackText: CALLBACK_FALLBACK_FEEDBACK,
  };
}

export function statusKeyboard(config?: BotConfig): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("🔄 Refresh", "status")
    .text("📋 Contracts", "contracts");
  if (config?.operatorTelegramUserId) {
    keyboard.row().text("⏸ Pause", "pause").text("▶ Resume", "resume");
  }
  return keyboard;
}

export function contractsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Status", "status")
    .text("❓ Help", "help");
}

export function operatorKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⏸ Pause", "pause")
    .text("▶ Resume", "resume")
    .row()
    .text("📊 Status", "status");
}

function ago(timestamp: number | null, nowMs: number = Date.now()): string {
  if (timestamp === null) return "never";
  const seconds = Math.max(0, Math.round((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/**
 * Render the audit report for Telegram. The report is plain text — audit lines
 * are arbitrary redacted strings and MarkdownV2 would mangle them — so nothing
 * here goes through MarkdownV2 escaping; this message is sent without a parse
 * mode. Bounded twice over: the file read is capped and only the tail renders.
 */
function renderAuditForTelegram(summary: AuditFileSummary, tail: number): string {
  const header = `*Audit* — ${summary.file}`;
  const report = renderAuditReport(summary, { tail });
  return `${header}\n\n${report}\n\n${AUDIT_CLI_HINT}`;
}

function cursorPreview(cursor: string | null): string {
  if (cursor === null) return "none (cold start)";
  const compact = cursor.replace(/\s+/g, " ").replace(/[`\\]/g, "?").trim() || "empty";
  return compact.length <= 24 ? compact : `${compact.slice(0, 23)}…`;
}

export function statusMessage(config: BotConfig, status: PollerStatus, nowMs: number = Date.now()): string {
  const lifecycle = status.stopping
    ? "stopping"
    : status.paused
      ? "paused"
      : status.running
        ? "running"
        : "stopped";

  const lines: string[] = [
    `*Status* — ${lifecycle} on Stellar ${networkLabel(config)}`,
    `Channel preview: ${config.channelPreviewMode ? "enabled" : "disabled"}`,
    "",
    `Chain tip: ${status.latestLedger ?? "unknown"}`,
    `RPC retains from ledger: ${status.oldestLedger ?? "unknown"}`,
    `Chain clock skew: ${escapeMd(chainClockLabel(status.chainClockAt, nowMs))}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt, nowMs)}`,
    `Cycles: ${status.cycles} · sent ${status.notificationsSent} · failed sends ${status.notificationsFailed} · skipped ${status.eventsSkipped} · deduped ${status.eventsDeduplicated ?? 0}` +
      (status.notificationsDropped
        ? ` · dropped during shutdown ${status.notificationsDropped}`
        : ""),
    `RPC pages: ${status.pagesScanned} total · ${status.emptyPages} empty` +
      (status.lastCyclePages > 0
        ? ` · last cycle ${status.lastCycleEmptyPages}/${status.lastCyclePages} empty`
        : ""),
    `Feature flags: ${escapeMd(formatFeatureFlags(config.featureFlags))}`,
    "",
    "*Watching*",
  ];

  // Only shown when the queue is holding or has replayed something, so an
  // ordinary /status is unchanged.
  if (status.deadLetter && (status.deadLetter.depth > 0 || status.deadLetter.replayed > 0)) {
    lines.push(
      `Parked sends: ${status.deadLetter.depth} waiting \u00b7 ` +
        `${status.deadLetter.replayed} replayed \u00b7 ${status.deadLetter.dropped} dropped`,
      "",
    );
  }

  // Only shown after an automatic recovery, so an ordinary /status is unchanged.
  if (status.cursorRewinds > 0) {
    lines.push(
      `Cursors rewound to the retained floor: ${status.cursorRewinds}`,
      "",
    );
  }

  for (const target of status.targets) {
    lines.push(
      `· mimir\\-${target.source} \\(${escapeMd(target.version ?? "v1")}\\) \`${target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${cursorPreview(target.cursor)}\``,
    );
    if (target.cursorStalled) {
      lines.push(
        `  cursor stalled: unchanged for ${target.cyclesWithoutAdvance} successful cycles while behind tip`,
      );
    }
    if (target.gapLedgers > 0) {
      lines.push(
        `  restart gap: ${target.gapLedgers} ledger${target.gapLedgers === 1 ? "" : "s"} unrecoverable, ` +
          `cursor reset ${ago(target.cursorResetAt, nowMs)}`,
      );
    }
    if (target.cursorUnreadable) {
      lines.push("  cursor ledger unreadable: position left untouched");
    }
    if (target.lastError) lines.push(`  last error: ${escapeMd(target.lastError)}`);
  }

  if (status.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError.at, nowMs)}\\): ${escapeMd(status.lastError.message)}`,
    );
  }
  if (status.consecutiveFailures > 0) {
    lines.push(`Consecutive failed cycles: ${status.consecutiveFailures}`);
  }
  if (status.restartGaps > 0) {
    lines.push(`Restart gaps detected since start: ${status.restartGaps}`);
  }

  if (status.stopping) {
    lines.push(
      "",
      "Graceful shutdown in progress: no new cycles, unsent notifications dropped" +
        (status.pendingFlush ? ", cursor flush still pending" : ", cursor flushed") +
        "\\.",
    );
  }

  return lines.join("\n");
}

export function lastEventMessage(config: BotConfig, status: PollerStatus): string {
  const lines = [`*Last observed events* — Stellar ${networkLabel(config)}`, ""];

  for (const target of status.targets) {
    lines.push(`*mimir\\-${target.source}*`);
    if (!target.lastEvent) {
      lines.push("No event has been observed since this process started\\.", "");
      continue;
    }
    lines.push(formatLastEvent(config, target.lastEvent), "");
  }

  if (status.targets.length === 0) {
    lines.push("No contract scan has completed yet\\.");
  }
  return lines.join("\n").trimEnd();
}

/**
 * The `/contracts` message: which two contracts this bot watches, and where to
 * look each one up independently — deliberately static (config only, no
 * poller state), so it answers the same whether the poller is mid-cycle,
 * between restarts, or wedged on a run of RPC failures. `/status` is for
 * "is it working"; this is for "what is it even watching".
 */
export function healthMessage(
  config: BotConfig,
  status: PollerStatus,
  nowMs: number = Date.now(),
): string {
  const report = buildHealthReport(config, status, nowMs);
  const statusLabel = report.status.toUpperCase();

  const lines: string[] = [
    `*Health* — ${escapeMd(statusLabel)} on Stellar ${networkLabel(config)}`,
    "",
    `Status: \`${report.status}\` \\(${report.ok ? "ok" : "action required"}\\)`,
    `Poller: ${report.poller.running ? "running" : "stopped"}`,
    `Uptime: ${report.uptimeMs > 0 ? ago(nowMs - report.uptimeMs, nowMs) : "0s"}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt, nowMs)}`,
    `Last successful poll: ${ago(status.lastSuccessAt, nowMs)}`,
    `Chain tip: ${report.poller.latestLedger ?? "unknown"}`,
    `Chain clock skew: ${escapeMd(chainClockLabel(status.chainClockAt, nowMs))}`,
    `Cycles: ${report.poller.cycles} · consecutive failures: ${report.poller.consecutiveFailures}`,
    `Notifications: sent ${report.poller.notificationsSent} · failed ${report.poller.notificationsFailed} · skipped ${report.poller.eventsSkipped}`,
    "",
    "*Watched Contracts*",
  ];

  for (const target of report.poller.targets) {
    lines.push(
      `· mimir\\-${target.source} \`${target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${target.cursorPreview ?? "none (cold start)"}\``,
    );
    if (target.cursorStale) {
      lines.push(
        target.rewindFromLedger === null
          ? "  ALERT: RPC rejected this cursor as stale; its position is unchanged"
          : `  ALERT: stale cursor recovery from ledger ${target.rewindFromLedger}`,
      );
    }
    if (target.gapLedgers > 0) {
      lines.push(
        `  restart gap: ${target.gapLedgers} ledger(s) unrecoverable at the last recovery`,
      );
    }
    if (target.cursorUnreadable) {
      lines.push("  cursor ledger unreadable: position forwarded unchanged");
    }
    if (target.hasError) {
      const targetState = status.targets.find((t) => t.source === target.source);
      if (targetState?.lastError) {
        lines.push(`  last error: ${escapeMd(targetState.lastError)}`);
      }
    }
  }

  if (report.poller.restartGaps > 0) {
    const gap = report.poller.lastRestartGap;
    lines.push(
      escapeMd(
        `Restart gaps since start: ${report.poller.restartGaps}` +
          (gap ? ` (last: ${gap.missedLedgers} ledger(s) unrecoverable on ${gap.source})` : ""),
      ),
    );
  }

  if (report.poller.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError?.at ?? null, nowMs)}\\): ${escapeMd(report.poller.lastError.message)}`,
    );
  }

  // Origins, never values: an operator can confirm this process is reading the
  // intended .env / profile without a secret being typed into a chat. The
  // summary is interpolated into a code span unescaped on purpose — it is built
  // only from key names, source names, and counts (see config.ts), so it has no
  // MarkdownV2 reserved character to escape and stays copy-pasteable.
  lines.push("", `Config: \`${formatProvenanceSummary(report.config)}\``);
  if (report.config.warnings.length > 0) {
    lines.push(`Config notes: ${escapeMd(report.config.warnings.join("; "))}`);
  }

  return lines.join("\n");
}

export function contractsMessage(config: BotConfig): string {
  const targets: Array<{ label: string; version: string; contractId: string }> = [
    {
      label: "mimir\\-market",
      version: config.marketContractVersion ?? "v1",
      contractId: config.marketContractId,
    },
    {
      label: "mimir\\-squad",
      version: config.squadContractVersion ?? "v1",
      contractId: config.squadContractId,
    },
  ];

  const lines: string[] = [
    `*Contracts* — Mimir on Stellar ${escapeMd(networkLabel(config))}`,
    "",
    "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.",
  ];

  for (const target of targets) {
    lines.push(
      "",
      `*${target.label}* \\(${escapeMd(target.version ?? "v1")}\\)`,
      `\`${escapeMd(target.contractId)}\``,
      `[View on stellar\\.expert](${contractExplorerUrl(config, target.contractId)})`,
    );
  }

  return lines.join("\n");
}

/** Exact operator replies, exported for deterministic Telegram payload tests. */
export function pauseMessage(result: PollerPauseResult): string {
  switch (result) {
    case "paused":
      return PAUSE_MESSAGES.paused;
    case "already-paused":
      return PAUSE_MESSAGES.alreadyPaused;
    case "stopped":
      return PAUSE_MESSAGES.stopped;
  }
}

export function resumeMessage(result: PollerResumeResult): string {
  switch (result) {
    case "resumed":
      return RESUME_MESSAGES.resumed;
    case "already-running":
      return RESUME_MESSAGES.alreadyRunning;
    case "stopped":
      return RESUME_MESSAGES.stopped;
  }
}

/**
 * Shared handler for pause inline-keyboard callbacks.
 *
 * Exported for unit testing without needing a live grammy `Bot` instance.
 * Callers must pass a grammy-compatible `ctx` that exposes:
 *   - `ctx.from`
 *   - `ctx.callbackQuery.data`
 *   - `ctx.callbackQuery.message.date` (Unix seconds, set by Telegram)
 *   - `ctx.answerCallbackQuery(text?, opts?)`
 *   - `ctx.editMessageText(text, opts)`
 */
async function handlePauseCallback(
  ctx: Context,
  deps: Pick<BotDeps, "config" | "pause">,
  nowMs: number = Date.now(),
): Promise<void> {
  const { config, pause } = deps;

  const action = validatePauseCallbackData(ctx.callbackQuery?.data);
  if (action === null) return; // unknown payload — silently ignore

  // Only the operator may act on these buttons.
  if (!isOperator(ctx, config)) {
    await ctx.answerCallbackQuery({ text: "Only the operator can do that.", show_alert: true });
    return;
  }

  // Reject stale confirmations so an old message cannot pause the bot later.
  const messageDate = ctx.callbackQuery?.message?.date ?? 0;
  const ageMs = nowMs - messageDate * 1000;
  if (ageMs > PAUSE_CONFIRM_TTL_MS) {
    await ctx.answerCallbackQuery({ text: "Confirmation expired.", show_alert: true });
    await ctx.editMessageText("⏱ *Pause confirmation expired\\.* Run /pause again\\.", TELEGRAM_OPTIONS);
    return;
  }

  if (action === CALLBACK_PAUSE_CONFIRM) {
    const result = pause();
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(pauseMessage(result), TELEGRAM_OPTIONS);
    return;
  }

  if (action === CALLBACK_PAUSE_CANCEL) {
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.editMessageText("*Pause cancelled\\.* Polling continues\\.", TELEGRAM_OPTIONS);
    return;
  }
}

export interface BotDeps {
  config: BotConfig;
  status: () => PollerStatus;
  pause: () => PollerPauseResult;
  resume: () => PollerResumeResult;
  /** Bot version string, typically read from package.json. */
  version?: string | undefined;
  /** Live in-memory audit window; renders immediately even before a flush. */
  audit?: AuditLog | undefined;
  /** Where the audit JSONL file lives, for the file-backed report. */
  auditFile?: string | undefined;
  /**
   * Pre-populated bot info. When provided (e.g. in tests) grammy skips the
   * getMe() call so `bot.handleUpdate()` works without a real Telegram token.
   */
  botInfo?: UserFromGetMe;
  /** Bounded redacted log ring backing /export. Absent = command disabled. */
  logs?: LogCapture | undefined;
  /** In-memory broadcast confirmation store. */
  broadcastStore?: BroadcastStore | undefined;
}

/**
 * Returns true when the chat is permitted to use restricted commands.
 *
 * Rules:
 * - If `allowedChatIds` is empty the list is open (any chat may use the
 *   gated commands: /status, /health, /contracts, /preview).
 * - Otherwise the incoming chat id must appear in the list. Both the numeric
 *   id (stored as a number in grammy's ctx.chat.id) and its string form are
 *   compared so that negative group ids such as -1001234567890 match correctly.
 */
export function isChatAllowed(allowedChatIds: readonly string[] | undefined, chatId: number): boolean {
  // Hand-built configs (tests, embedders) may omit the list: treat it as open.
  if (!allowedChatIds || allowedChatIds.length === 0) return true;
  const asString = String(chatId);
  return allowedChatIds.some((allowed) => allowed === asString);
}

export function isOperator(ctx: Pick<Context, "from">, config: BotConfig): boolean {
  const operatorId = config.operatorTelegramUserId;
  return operatorId !== null && ctx.from?.id.toString() === operatorId;
}

/** How many recent audit lines `/audit` renders. A chat message is not a file. */
const AUDIT_TAIL = 10;

/**
 * Reply with MarkdownV2, splitting when the payload exceeds Telegram's
 * 4096-character `sendMessage` limit. `/help` grows with the command list
 * and `/status` with the watched targets, so either can cross it; the chunks
 * are sent in order.
 */
async function replyMarkdown(
  ctx: CommandContext<Context>,
  text: string,
  options: typeof TELEGRAM_OPTIONS = TELEGRAM_OPTIONS,
): Promise<void> {
  for (const part of splitTelegramMessage(text)) {
    await ctx.reply(part, options);
  }
}

/** Register command handlers on a grammy-compatible bot (also useful in tests). */
export function registerCommandHandlers(
  bot: Bot | { command: (name: string, handler: (ctx: CommandContext<Context>) => Promise<void>) => void; callbackQuery?: (filter: string | string[], handler: (ctx: Context) => Promise<void>) => void },
  deps: BotDeps,
): void {
  const { config, status } = deps;
  const version = deps.version ?? "unknown";
  const pause = deps.pause ?? (() => "stopped");
  const resume = deps.resume ?? (() => "stopped");

  /**
   * Gate for commands that expose deployment details. Requests from
   * unapproved chats are silently ignored: an error reply would leak the
   * existence of the restriction, and silence matches privacy-mode bots that
   * never see most messages. The log lets operators spot misconfigured ids.
   */
  const chatAllowed = (ctx: CommandContext<Context>, command: string): boolean => {
    if (isChatAllowed(config.allowedChatIds, ctx.chat.id)) return true;
    console.warn(`[bot] /${command} denied for chat ${ctx.chat.id} (not in ALLOWED_CHAT_IDS)`);
    return false;
  };

  const handlers: Record<typeof COMMANDS[number]["command"], (ctx: CommandContext<Context>) => Promise<void>> = {
    start: async (ctx) => {
      await replyMarkdown(ctx, helpMessage(config));
    },

    help: async (ctx) => {
      const text = ctx.message?.text ?? "";
      const spaceIndex = text.indexOf(" ");
      const arg = (
        typeof ctx.match === "string" && ctx.match.trim().length > 0
          ? ctx.match.trim()
          : (spaceIndex !== -1 ? text.slice(spaceIndex + 1).trim() : "")
      );
      if (arg) {
        await replyMarkdown(ctx, helpDetailMessage(arg, config));
      } else {
        await replyMarkdown(ctx, helpMessage(config));
      }
    },

    about: async (ctx) => {
      await replyMarkdown(ctx, aboutMessage(config, version));
    },

    status: async (ctx) => {
      if (!chatAllowed(ctx, "status")) return;
      const startedAt = performance.now();
      let sent = false;
      try {
        await ctx.reply(statusMessage(config, status()), TELEGRAM_OPTIONS);
        sent = true;
      } finally {
        const latencyMs = Math.max(0, performance.now() - startedAt);
        console.info(
          `[bot] /status ${sent ? "sent" : "failed"} in ${latencyMs.toFixed(1)}ms`,
        );
      }
    },

    audit: async (ctx) => {
      if (!isOperator(ctx, config)) {
        // Same authorization model as /pause and /resume: the report is only
        // meant for the operator, so other users get silence, not an error that
        // would confirm the command exists. The standalone `npm run audit` CLI
        // is the credential-free path for anyone with machine access.
        console.warn(`[bot] ignored unauthorized /audit on update ${ctx.update.update_id}`);
        return;
      }
      try {
        const file = deps.auditFile ?? config.auditFile;
        const summary = await readAuditFile(file);

        // The in-memory window also holds entries recorded since the last flush;
        // append any of those the file does not already contain (same entries
        // serialise identically) so the report is current without duplicates.
        const seen = new Set(summary.entries.map((e) => JSON.stringify(e)));
        const live = (deps.audit ? deps.audit.tail(AUDIT_TAIL) : []).filter(
          (e) => !seen.has(JSON.stringify(e)),
        );

        const merged: AuditFileSummary = {
          ...summary,
          entries: [...summary.entries, ...live].slice(-AUDIT_REPORT_MAX_ENTRIES),
        };
        await ctx.reply(renderAuditForTelegram(merged, AUDIT_TAIL), {
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        await ctx.reply(`Audit report failed: ${safeErrorMessage(err, [config.botToken])}`);
      }
    },

    // Config-only, so this never fails on account of poller or RPC state —
    // unlike /status, it has nothing to report failure on.
    health: async (ctx) => {
      if (!chatAllowed(ctx, "health")) return;
      await ctx.reply(healthMessage(config, status()), TELEGRAM_OPTIONS);
    },

    contracts: async (ctx) => {
      if (!chatAllowed(ctx, "contracts")) return;
      await ctx.reply(contractsMessage(config), TELEGRAM_OPTIONS);
    },

    preview: async (ctx) => {
      if (!chatAllowed(ctx, "preview")) return;
      const text = ctx.message?.text ?? "";
      const spaceIndex = text.indexOf(" ");
      const arg = spaceIndex !== -1 ? text.slice(spaceIndex + 1).trim() : "";
      await ctx.reply(previewMessage(config, arg || "market"), TELEGRAM_OPTIONS);
    },

    ping: async (ctx) => {
      await handlePingCommand(ctx, { config });
    },

    pause: async (ctx) => {
      if (!isOperator(ctx, config)) {
        console.warn(`[bot] ignored unauthorized /pause on update ${ctx.update.update_id}`);
        return;
      }
      await ctx.reply("⏸ *Pause polling?*\\nThis will stop new scans from starting\\. The current scan may finish\\.", {
        ...TELEGRAM_OPTIONS,
        reply_markup: pauseConfirmationKeyboard(),
      });
    },

    resume: async (ctx) => {
      if (!isOperator(ctx, config)) {
        console.warn(`[bot] ignored unauthorized /resume on update ${ctx.update.update_id}`);
        return;
      }
      await ctx.reply(resumeMessage(resume()), TELEGRAM_OPTIONS);
    },
  };

  for (const { command } of COMMANDS) {
    bot.command(command, handlers[command]);
  }
  if (!("on" in bot) && typeof bot.callbackQuery === "function") {
    bot.callbackQuery(
      [CALLBACK_PAUSE_CONFIRM, CALLBACK_PAUSE_CANCEL],
      async (ctx) => handlePauseCallback(ctx, { config, pause }),
    );
  }
}

function isMessageNotModified(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /message is not modified/i.test(msg);
}

export async function safeAnswerCallback(
  ctx: Context,
  config: BotConfig,
  params: { text?: string; show_alert?: boolean } = {},
): Promise<void> {
  if (ctx.callbackQuery?.id) {
    try {
      await ctx.answerCallbackQuery(params);
    } catch (err) {
      console.warn(
        `[bot] answerCallbackQuery failed: ${safeErrorMessage(err, [config.botToken])}`,
      );
    }
  }
}

export async function updateOrReplyMessage(
  ctx: Context,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  const options = {
    ...TELEGRAM_OPTIONS,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (err) {
      if (isMessageNotModified(err)) {
        return;
      }
      // If edit failed (e.g. message too old or deleted), fall through to reply
    }
  }

  if (ctx.chat) {
    await ctx.reply(text, options);
    return;
  }

  // no-op: callers that need to target the configured chat should call
  // `ctx.api.sendMessage(config.chatId, ...)` directly when `ctx.chat` is
  // unavailable. handleCallbackQuery does this.
}

export async function handleCallbackQuery(
  ctx: Context,
  deps: BotDeps,
  nowMs?: number,
): Promise<void> {
  if (nowMs !== undefined || ctx.callbackQuery?.data === CALLBACK_PAUSE_CONFIRM || ctx.callbackQuery?.data === CALLBACK_PAUSE_CANCEL) {
    await handlePauseCallback(ctx, { config: deps.config, pause: deps.pause }, nowMs);
    return;
  }

  const { config, status } = deps;
  const pause = deps.pause ?? (() => "stopped");
  const resume = deps.resume ?? (() => "stopped");
  const rawData = ctx.callbackQuery?.data;

  // Validate callback query data before acting
  const validation = validateCallbackData(rawData);

  if (!validation.ok) {
    console.warn(
      `[bot] rejected invalid callback query (${validation.reason}) on update ${ctx.update.update_id}`,
    );
    await safeAnswerCallback(ctx, config, {
      text: validation.fallbackText,
      show_alert: false,
    });
    return;
  }

  const { action } = validation;

  // Enforce operator role authorization
  if (action.type === "pause" || action.type === "resume" || action.type === "broadcast") {
    if (!isOperator(ctx, config)) {
      console.warn(
        `[bot] ignored unauthorized callback /${action.type} on update ${ctx.update.update_id}`,
      );
      await safeAnswerCallback(ctx, config, {
        text: CALLBACK_UNAUTHORIZED_FEEDBACK,
        show_alert: true,
      });
      return;
    }
  }

  // Execute validated action
  try {
    switch (action.type) {
      case "broadcast": {
        await handleBroadcastCallback(ctx, deps, action.raw);
        break;
      }

      case "status": {
        const text = statusMessage(config, status());
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, statusKeyboard(config));
        } else {
          await ctx.api.sendMessage(config.chatId, text, {
            ...TELEGRAM_OPTIONS,
            reply_markup: statusKeyboard(config),
          });
        }
        await safeAnswerCallback(ctx, config, { text: "Status refreshed" });
        break;
      }

      case "contracts": {
        const text = contractsMessage(config);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, contractsKeyboard());
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, { text: "Contracts" });
        break;
      }

      case "help": {
        const text = helpMessage(config);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text);
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, { text: "Help" });
        break;
      }

      case "pause": {
        const result = pause();
        const text = pauseMessage(result);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, operatorKeyboard());
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, {
          text: result === "paused" ? "Polling paused" : result === "already-paused" ? "Already paused" : "Cannot pause",
        });
        break;
      }

      case "resume": {
        const result = resume();
        const text = resumeMessage(result);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, operatorKeyboard());
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, {
          text: result === "resumed" ? "Polling resumed" : result === "already-running" ? "Already running" : "Cannot resume",
        });
        break;
      }
    }
  } catch (err) {
    console.error(
      `[bot] callback error on action ${action.type}: ${safeErrorMessage(err, [config.botToken])}`,
    );
    await safeAnswerCallback(ctx, config, { text: "Action failed" });
  }
}

/** Register callback handlers on a grammy-compatible bot or mock. */
export function registerCallbackHandlers(
  bot: Bot | { on: (event: string, handler: (ctx: Context) => Promise<void>) => void },
  deps: BotDeps,
): void {
  bot.on("callback_query", async (ctx: Context) => {
    await handleCallbackQuery(ctx, deps);
  });
}

export function createBot(deps: BotDeps): Bot {
  const clientOptions =
    deps.config.telegramApiRoot !== undefined && deps.config.telegramApiRoot !== null
      ? { client: { apiRoot: deps.config.telegramApiRoot } }
      : undefined;
  const bot = new Bot(
    deps.config.botToken,
    deps.botInfo !== undefined
      ? { botInfo: deps.botInfo, ...clientOptions }
      : clientOptions,
  );
  registerCommandHandlers(bot, deps);
  registerCallbackHandlers(bot, deps);
  registerBroadcastHandlers(bot, deps);
  const { config, status, logs } = deps;

  bot.command("export", async (ctx) => {
    // Same authorization model as /audit: recent logs are for the operator.
    if (!isOperator(ctx, config)) {
      console.warn(`[bot] ignored unauthorized /export on update ${ctx.update.update_id}`);
      return;
    }
    if (!logs || logs.capacity() === 0) {
      await ctx.reply("Log export is disabled (LOG_BUFFER_LINES=0).");
      return;
    }
    // Plain text, no parse mode: the content is redacted but untrusted, and
    // MarkdownV2 would make any escaping slip a parsing error instead of a
    // cosmetic wart.
    await ctx.reply(renderLogExport(config, status(), logs), {
      link_preview_options: { is_disabled: true },
    });
  });

  // grammy rethrows handler errors by default, which would take the process
  // with it. Keep Telegram/RPC error text bounded and redact known secrets.
  bot.catch((err) => {
    console.error(
      `[bot] handler error on update ${err.ctx.update.update_id}: ` +
        safeErrorMessage(err.error, [deps.config.botToken]),
    );
  });

  return bot;
}

/** Extra Telegram send options the poller may attach to a notification. */
export interface SendExtra {
  reply_markup?: ExplorerKeyboard | undefined;
  /**
   * Plain-text rendering of the same notification, sent without a `parse_mode`
   * when Telegram rejects the MarkdownV2 version for entity/parse reasons.
   * Optional: without it the notifier behaves exactly as before (parse errors
   * propagate, no second send). Empty or whitespace-only values count as absent.
   */
  plainText?: string | undefined;
  /**
   * Bounded identifiers for fallback logging only. Optional; never sent.
   */
  eventRef?: { eventId?: string | undefined; ledger?: number | undefined; source?: string | undefined } | undefined;
  /**
   * Post the notification as a reply to this message, for chats that thread
   * their notifications. Optional: omitted from the payload entirely when
   * absent, so the send is byte-identical to the unthreaded one.
   */
  replyToMessageId?: number | undefined;
  /** Decoded contract event name used to apply silent-notification policy. */
  eventName?: string | undefined;
}

/**
 * True when a Telegram send failed because the message text could not be
 * parsed as MarkdownV2 entities.
 *
 * grammy (1.x) surfaces Bot API failures as `GrammyError` with `error_code`
 * and `description` straight from Telegram, e.g. error 400 with
 * `"Bad Request: can't parse entities: …"` or `"… can't find end of the
 * entity …"`. The classifier matches that shape — error 400 plus the
 * entity-parse phrasing — so rate limits (429), auth failures (401), chat
 * errors, and network `HttpError`s never qualify. Duck-typed errors carrying
 * the same Telegram description (mocks, wrapped rejections) match on the
 * phrasing alone when no numeric `error_code` is present.
 */
export function isMarkdownParseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { error_code?: unknown; description?: unknown; message?: unknown };
  const text = [record.description, record.message]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
  if (!/can't parse entities|can't find end of the entity/i.test(text)) return false;
  if (typeof record.error_code === "number") return record.error_code === 400;
  return true;
}

/** Bounded log fragment identifying which event a fallback send belongs to. */
function eventRefLabel(eventRef: SendExtra["eventRef"]): string {
  if (!eventRef) return "";
  const parts: string[] = [];
  if (typeof eventRef.source === "string" && eventRef.source) parts.push(eventRef.source);
  if (typeof eventRef.ledger === "number" && Number.isFinite(eventRef.ledger)) {
    parts.push(`ledger ${eventRef.ledger}`);
  }
  if (typeof eventRef.eventId === "string" && eventRef.eventId) parts.push(eventRef.eventId);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

/**
 * Sends suppressed by the empty-message guard, counted so callers (and the
 * empty-text tests) can prove a blank render never reached the Telegram API.
 */
export const notifierSkips = { emptyText: 0 };

/**
 * The poller's send path: route each contract's messages to its named chat,
 * with the event's explorer button when `extra.reply_markup` is set.
 *
 * MarkdownV2 first; exactly one plain-text retry when Telegram rejects the
 * entities *and* the caller supplied a non-blank `extra.plainText`. The retry
 * carries no `parse_mode`, so it cannot fail the same way. Every other failure —
 * network, rate limit, auth, unknown chats, or a failed plain-text retry —
 * propagates unchanged, preserving the poller's existing error/cursor
 * accounting. An oversized payload is split into chunks and an
 * unspecified one into a single call, so the MarkdownV2-to-plain-text
 * retry happens at most once per chunk, never in a loop.
 *
 * A rendering that is empty, whitespace-only, or not a string at all is
 * skipped before any API call: Telegram rejects blank message text with a
 * 400, and a formatters' `null` must never turn into a doomed send. The skip
 * is counted in {@link notifierSkips} and logged with bounded metadata.
 */
export function createNotifier(
  bot: Pick<Bot, "api">,
  config: Pick<BotConfig, "chatId" | "marketChatId" | "squadChatId" | "botToken"> &
    Partial<Pick<BotConfig, "chatIds" | "linkPreviewMarket" | "linkPreviewSquad" | "silentEvents">>,
) {
  return async (
    text: string | null,
    source?: ContractSource,
    extra?: SendExtra,
  ): Promise<void> => {
    if (typeof text !== "string" || text.trim() === "") {
      notifierSkips.emptyText += 1;
      // Only bounded metadata: which chat path and how short the render was —
      // never the payload itself.
      console.warn(
        `[notifier] skipped empty message${eventRefLabel(extra?.eventRef)} ` +
          `(source=${typeof source === "string" && source ? source.slice(0, 32) : "default"}, ` +
          `chars=${typeof text === "string" ? text.length : -1})`,
      );
      return;
    }

    const defaultChat = config.chatId ?? config.chatIds?.[0] ?? "";
    const chatId = source === "market"
      ? config.marketChatId || defaultChat
      : source === "squad"
        ? config.squadChatId || defaultChat
        : defaultChat;

    // Select link preview settings based on the contract source.
    // Commands (where source is undefined) always use TELEGRAM_OPTIONS (disabled).
    const linkPreviewDisabled = source === "market"
      ? !config.linkPreviewMarket
      : source === "squad"
        ? !config.linkPreviewSquad
        : true;

    const silentOption = extra?.eventName && isSilent(extra.eventName, config.silentEvents ?? DEFAULT_SILENT_EVENTS)
      ? { disable_notification: true }
      : {};
    const notificationOptions = {
      parse_mode: "MarkdownV2" as const,
      link_preview_options: { is_disabled: linkPreviewDisabled },
      ...silentOption,
    };

    // Oversized payloads go out as ordered chunks under Telegram's limit. The
    // thread reply rides on the first chunk and the explorer button on the
    // last, so the message reads exactly like the unsplit one.
    const parts = splitTelegramMessage(text);
    if (parts.length > 1) {
      for (const [index, part] of parts.entries()) {
        await bot.api.sendMessage(chatId, part, {
          ...notificationOptions,
          ...(index === parts.length - 1 && extra?.reply_markup
            ? { reply_markup: extra.reply_markup }
            : {}),
          ...(index === 0 && extra?.replyToMessageId !== undefined
            ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
            : {}),
        });
      }
      return;
    }

    try {
      await bot.api.sendMessage(chatId, text, {
        ...notificationOptions,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
        ...(extra?.replyToMessageId !== undefined
          ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
          : {}),
      });
      return;
    } catch (err) {
      // A blank fallback is no fallback: sending whitespace-only text would
      // just draw the same 400, so the original parse error propagates.
      const fallback = extra?.plainText;
      if (typeof fallback !== "string" || fallback.trim() === "" || !isMarkdownParseError(err)) {
        throw err;
      }
      // Only bounded metadata is logged: the fallback outcome, the safe error
      // category, and the caller-supplied event reference — never message
      // text, tokens, or remote payloads.
      console.warn(
        `[notifier] MarkdownV2 rejected${eventRefLabel(extra?.eventRef)}, ` +
          `retrying as plain text: ${safeErrorMessage(
            err,
            typeof config.botToken === "string" ? [config.botToken] : [],
          )}`,
      );
      // Plain text (no parse mode), same per-source link preview setting.
      await bot.api.sendMessage(chatId, fallback, {
        link_preview_options: notificationOptions.link_preview_options,
        ...silentOption,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
        ...(extra?.replyToMessageId !== undefined
          ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
          : {}),
      });
    }
  };
}

/** Registers the command list so Telegram's UI offers autocompletion. */
export async function registerCommands(bot: Bot, config?: BotConfig): Promise<void> {
  try {
    await bot.api.setMyCommands(visibleCommands(config).map(({ command, description }) => ({ command, description })));
  } catch (err) {
    // Cosmetic. Never worth failing a boot over, and never log an unbounded API error.
    console.warn(`[bot] setMyCommands failed: ${safeErrorMessage(err)}`);
  }
}
