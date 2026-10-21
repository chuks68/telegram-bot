/**
 * Process exit-code taxonomy.
 *
 * Every call to `process.exit()` in this codebase uses one of these constants
 * so that a supervisor (systemd, Docker restart policy, fly.io, etc.) can act
 * on the *reason* rather than just "non-zero".
 *
 * ┌──────┬─────────────────────┬────────────────────────────────────────────┐
 * │ Code │ Constant            │ Meaning                                    │
 * ├──────┼─────────────────────┼────────────────────────────────────────────┤
 * │  0   │ EXIT_OK             │ Clean shutdown (SIGTERM / SIGINT / SIGHUP  │
 * │      │                     │ reload-before-exec). Supervisor should     │
 * │      │                     │ restart only if configured for "always".   │
 * ├──────┼─────────────────────┼────────────────────────────────────────────┤
 * │  1   │ EXIT_ERROR          │ Fatal startup error: bad config            │
 * │      │                     │ (ConfigError), RPC unreachable at boot, or │
 * │      │                     │ an uncaught exception that escapes the     │
 * │      │                     │ poll loop. Restarting without fixing the   │
 * │      │                     │ cause will loop forever — alert.           │
 * ├──────┼─────────────────────┼────────────────────────────────────────────┤
 * │  2   │ EXIT_BAD_TOKEN      │ Telegram authentication failure: the       │
 * │      │                     │ BOT_TOKEN was rejected by the Telegram     │
 * │      │                     │ API. Restarting will not help; the token   │
 * │      │                     │ must be replaced before restart.           │
 * ├──────┼─────────────────────┼────────────────────────────────────────────┤
 * │  4   │ EXIT_USAGE          │ CLI usage error: bad arguments, malformed  │
 * │      │                     │ base64, or invalid XDR passed to the       │
 * │      │                     │ offline decode CLI. Restarting will not    │
 * │      │                     │ help; fix the invocation or input.         │
 * ├──────┼─────────────────────┼────────────────────────────────────────────┤
 * │  3   │ EXIT_RPC_PERSISTENT │ Persistent Stellar RPC failure: the        │
 * │      │                     │ consecutive-failure counter reached        │
 * │      │                     │ CONSECUTIVE_FAILURE_EXIT_THRESHOLD. The    │
 * │      │                     │ process exits deliberately so the          │
 * │      │                     │ supervisor can restart it with a clean     │
 * │      │                     │ slate (fresh RPC connection, reset         │
 * │      │                     │ backoff). The cursor is safe.              │
 * └──────┴─────────────────────┴────────────────────────────────────────────┘
 *
 * Exit code 3 is the only one that is *expected* to be retried automatically.
 * Codes 1 and 2 should trigger an alert before any automatic retry.
 *
 * Node reserves codes 5–12 for its own fatal errors (V8 OOM, etc.). Codes
 * 128+N are POSIX signal-death conventions. Staying below 64 keeps us
 * well clear of both.
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_BAD_TOKEN = 2;
export const EXIT_RPC_PERSISTENT = 3;
export const EXIT_USAGE = 4;
