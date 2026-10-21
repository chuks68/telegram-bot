import test from 'node:test';
import assert from 'node:assert';
import { statsMessage } from '../src/commands/stats.ts';

test('statsMessage renders counters and uptime', () => {
  const now = 100000;
  const startedAt = 40000;
  const snapshot = {
    notificationsSent: 12,
    notificationsFailed: 2,
    notificationsSkipped: 3,
    rpcCalls: 45,
    rpcErrors: 1,
    startedAtMs: startedAt,
  };

  const out = statsMessage(snapshot, now);

  assert.typeof(out, 'string');
  assert.match(out, /Notifications sent: 12\b/);
  assert.match(out, /Notifications failed: 2\b/);
  assert.match(out, /Notifications skipped: 3\b/);
  assert.match(out, /RPC calls: 45\b/);
  assert.match(out, /RPC errors: 1\b/);
  assert.match(out, /Uptime: 1m 0s\b/);
});

test('statsMessage renders missing counters as 0', () => {
  const out = statsMessage({}, 5000);

  assert.match(out, /Notifications sent: 0\b/);
  assert.match(out, /Notifications failed: 0\b/);
  assert.match(out, /Notifications skipped: 0\b/);
  assert.match(out, /RPC calls: 0\b/);
  assert.match(out, /RPC errors: 0\b/);
  assert.doesNotMatch(out, /undefined/);
});

test('statsMessage stays within one Telegram message', () => {
  const out = statsMessage(
    {
      notificationsSent: 99999999,
      notificationsFailed: 99999999,
      notificationsSkipped: 99999999,
      rpcCalls: 99999999,
      rpcErrors: 99999999,
      startedAtMs: 0,
    },
    99999999999,
  );

  assert.ok(out.length < 4096);
});
