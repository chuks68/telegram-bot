import { escapeMd } from "../notifications/format.js";

export interface StatsSnapshot {
  notificationsSent?: number;
  notificationsFailed?: number;
  notificationsSkipped?: number;
  rpcCalls?: number;
  rpcErrors?: number;
  startedAtMs?: number;
  [key: string]: number | undefined;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d$ ${hours}h ${minutes}m ${seconds}s`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function statsMessage(snapshot: StatsSnapshot, nowMs: number): string {
  const sent = count(snapshot.notificationsSent);
  const failed = count(snapshot.notificationsFailed);
  const skipped = count(snapshot.notificationsSkipped);
  const rpcCalls = count(snapshot.rpcCalls);
  const rpcErrors = count(snapshot.rpcErrors);
  const startedAtMs = count(snapshot.startedAtMs);
  const uptime = formatUptime(nowMs - startedAtMs);

  const lines = [
    "*Stats*",
    `${escapeMd("Notifications")}: sent ${sent}, failed ${failed}, skipped ${skipped}`,
    `${escapeMd("RPC")}: calls ${rpcCalls}, errors ${rpcErrors}`,
    `${escapeMd("Uptime")}: ${escapeMd(uptime)}`,
  ];

  return lines.join("\n");
}
