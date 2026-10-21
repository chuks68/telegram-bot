import { escapeMd } from "../notifications/format.js";
import type { BotConfig } from "../config.js";
import { helpMessage } from "../bot.js";

export interface CommandDetail {
  usage: string;
  arguments: string;
  whoCanRun: string;
  operatorOnly: boolean;
  description: string;
  examples: readonly string[];
}

export const COMMAND_DETAILS: Record<string, CommandDetail> = {
  start: {
    usage: "/start",
    arguments: "None",
    whoCanRun: "Anyone",
    operatorOnly: false,
    description: "Start interacting with the bot and view an overview of what it does and available commands.",
    examples: ["/start"],
  },
  help: {
    usage: "/help [command]",
    arguments: "[command] (optional) — command name to show detailed help for",
    whoCanRun: "Anyone",
    operatorOnly: false,
    description: "Show general help listing all commands, or detailed help with usage, arguments, and examples for a specific command.",
    examples: ["/help", "/help preview", "/help audit", "/help status"],
  },
  status: {
    usage: "/status",
    arguments: "None",
    whoCanRun: "Anyone in allowed chats",
    operatorOnly: false,
    description: "Display the last-seen ledger number, watched contracts, poller health, and sync status.",
    examples: ["/status"],
  },
  audit: {
    usage: "/audit",
    arguments: "None",
    whoCanRun: "Operator only",
    operatorOnly: true,
    description: "Operator only: display a bounded, redacted audit report of recent administrative operations and poller state changes.",
    examples: ["/audit"],
  },
  contracts: {
    usage: "/contracts",
    arguments: "None",
    whoCanRun: "Anyone in allowed chats",
    operatorOnly: false,
    description: "Display watched Soroban contract addresses (market and squad) with links to Stellar block explorers.",
    examples: ["/contracts"],
  },
  health: {
    usage: "/health",
    arguments: "None",
    whoCanRun: "Anyone in allowed chats",
    operatorOnly: false,
    description: "Run operational readiness checks and display health status for RPC connectivity and chain clocks.",
    examples: ["/health"],
  },
  preview: {
    usage: "/preview [market|squad]",
    arguments: "[market|squad] (optional, default: market) — contract event notification format to preview",
    whoCanRun: "Anyone in allowed chats",
    operatorOnly: false,
    description: "Preview Telegram channel notification formatting and verify link preview settings for market or squad contracts.",
    examples: ["/preview", "/preview market", "/preview squad"],
  },
  pause: {
    usage: "/pause",
    arguments: "None",
    whoCanRun: "Operator only",
    operatorOnly: true,
    description: "Operator only: pause polling for new contract events without modifying stored cursors.",
    examples: ["/pause"],
  },
  resume: {
    usage: "/resume",
    arguments: "None",
    whoCanRun: "Operator only",
    operatorOnly: true,
    description: "Operator only: resume polling for contract events immediately if paused.",
    examples: ["/resume"],
  },
};

/**
 * Renders detailed help for a given command.
 * If the command is not recognized, falls back to the normal help message.
 * All dynamic and static content is safely escaped for MarkdownV2 using escapeMd.
 */
export function helpDetailMessage(command: string, config?: BotConfig): string {
  const normalized = (command ?? "").trim().replace(/^\//, "").toLowerCase();
  const detail = COMMAND_DETAILS[normalized];
  if (!detail) {
    return helpMessage(config);
  }

  const lines: string[] = [
    `*Command:* /${escapeMd(normalized)}`,
    "",
    escapeMd(detail.description),
    "",
    `*Usage:* ${escapeMd(detail.usage)}`,
    `*Arguments:* ${escapeMd(detail.arguments)}`,
    `*Who can run it:* ${escapeMd(detail.whoCanRun)}`,
  ];

  if (detail.examples && detail.examples.length > 0) {
    lines.push("", "*Examples:*");
    for (const example of detail.examples) {
      lines.push(escapeMd(`• ${example}`));
    }
  }

  return lines.join("\n");
}
