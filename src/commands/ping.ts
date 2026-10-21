/**
 * /ping command: verifies bot responsiveness and measures Telegram API round-trip latency.
 */

import { performance } from "node:perf_hooks";
import type { Context } from "grammy";
import { escapeMd, safeErrorMessage } from "../notifications/format.js";
import { updateOrReplyMessage, TELEGRAM_OPTIONS } from "../bot.js";
import type { BotConfig } from "../config.js";

/** Clock abstraction for measuring time, injectable for tests. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => performance.now(),
};

/**
 * Returns true when the chat is permitted to use restricted commands.
 * Matches the same chat allowlist policy as /status.
 */
export function isChatAllowed(
  allowedChatIds: readonly string[] | undefined,
  chatId: number | string | undefined,
): boolean {
  if (!allowedChatIds || allowedChatIds.length === 0) return true;
  if (chatId === undefined || chatId === null) return false;
  const asString = String(chatId);
  return allowedChatIds.some((allowed) => allowed === asString);
}

/** Configuration and clock dependencies for /ping. */
export interface PingDeps {
  config?: Pick<BotConfig, "allowedChatIds" | "botToken"> | undefined;
  clock?: Clock | undefined;
}

/**
 * Format the pong response string with measured round-trip time.
 */
export function pongMessage(latencyMs?: number): string {
  if (latencyMs === undefined) return "Pong";
  const formatted = Number.isInteger(latencyMs)
    ? `${latencyMs}ms`
    : `${latencyMs.toFixed(1)}ms`;
  return `Pong (${formatted})`;
}

export const formatPong = pongMessage;

/**
 * Execute the /ping command:
 * 1. Verifies the chat is in ALLOWED_CHAT_IDS (same allowlist as /status).
 * 2. Replies "Pong".
 * 3. Measures the round-trip latency using performance.now() (or an injected clock).
 * 4. Edits the message with the measured round trip using updateOrReplyMessage.
 * 5. If editing fails, keeps the original reply and logs the error with redaction.
 */
export async function handlePingCommand(
  ctx: Context | any,
  depsOrConfig?: PingDeps | Pick<BotConfig, "allowedChatIds" | "botToken"> | Clock,
  clockOverride?: Clock,
): Promise<void> {
  // Normalize arguments for flexibility
  let config: Pick<BotConfig, "allowedChatIds" | "botToken"> | undefined;
  let clock: Clock = clockOverride ?? systemClock;

  if (depsOrConfig) {
    if ("now" in depsOrConfig && typeof depsOrConfig.now === "function") {
      clock = depsOrConfig as Clock;
    } else if ("config" in depsOrConfig || "clock" in depsOrConfig) {
      const deps = depsOrConfig as PingDeps;
      config = deps.config;
      if (deps.clock) clock = deps.clock;
    } else {
      config = depsOrConfig as Pick<BotConfig, "allowedChatIds" | "botToken">;
    }
  }
  if (clockOverride) {
    clock = clockOverride;
  }

  // 1. Apply the same chat allowlist as /status
  const chatId = ctx.chat?.id;
  if (!isChatAllowed(config?.allowedChatIds, chatId)) {
    console.warn(
      `[bot] /ping denied for chat ${chatId ?? "unknown"} (not in ALLOWED_CHAT_IDS)`,
    );
    return;
  }

  // 2. Measure round trip starting before initial reply
  const startedAt = clock.now();
  let sent: any;
  try {
    sent = await ctx.reply("Pong", TELEGRAM_OPTIONS);
  } catch (err) {
    // If initial reply fails, let it propagate (standard bot error handling)
    throw err;
  }

  const latencyMs = Math.max(0, clock.now() - startedAt);
  const updatedText = escapeMd(pongMessage(latencyMs));

  // 3. Edit the message using updateOrReplyMessage from src/bot.ts.
  // Acceptance criteria:
  // "If editing fails, the original reply stays and the error is logged with redaction."
  // We wrap the context to target the sent reply and suppress fall-through replies on edit failure.
  let editError: unknown = null;

  const editCtx = {
    ...ctx,
    callbackQuery: {
      message: sent ?? { message_id: 0, chat: ctx.chat },
    },
    editMessageText: async (text: string, options?: any) => {
      try {
        if (typeof ctx.editMessageText === "function") {
          return await ctx.editMessageText(text, options);
        }
        if (ctx.api?.editMessageText) {
          const targetChatId = sent?.chat?.id ?? ctx.chat?.id;
          const messageId = sent?.message_id;
          return await ctx.api.editMessageText(targetChatId, messageId, text, options);
        }
        throw new Error("No editMessageText available on context or api");
      } catch (err) {
        editError = err;
        throw err;
      }
    },
    // chat is set to undefined so updateOrReplyMessage does NOT fall through
    // to send a second reply when editMessageText fails.
    chat: undefined,
  };

  try {
    await updateOrReplyMessage(editCtx as any, updatedText);
  } catch (err) {
    editError = err;
  }

  if (editError) {
    const secrets = config?.botToken ? [config.botToken] : [];
    console.error(
      `[bot] /ping edit failed: ${safeErrorMessage(editError, secrets)}`,
    );
  }
}

export const pingCommand = handlePingCommand;
