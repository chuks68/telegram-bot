# Running the bot locally against a fake Telegram Bot API

This guide lets you run the full bot process locally without a real Telegram bot token. Instead of talking to `api.telegram.org`, the bot talks to a local fake Bot API server that prints the messages it receives.

## How it works

- `src/dev/fake-telegram.ts`` is a tiny HTTP server that implements a subset of the Telegram Bot API: `getMe", `sendMessage`, `setMyCommands`, `getUpdates` and `answerCallbackQuery`. It accepts any token and never forwards requests to api.telegram.org.
- `src/config.ts` reads an optional `TELEGRAM_API_ROOT` setting. When set, it is passed to grammy as `client.apiRoot`. For safety, only loopback values (`http://127.0.0.1` or `http://localhost`) are accepted; any other value is rejected at config load.

## Prerequisites

- Node.js and the project dependencies installed (`npm install`).
- A local JSON-RPC endpoint for the bot to call. The `mock:rpc` script starts a mock JSON-RPC server for this purpose.

## Walkthrough

1. Start the mock JSON-RPC server:

   ```sh
   npm run mock:rpc
   ```

2. In another terminal, start the fake Telegram Bot API server:

   ```sh
   npx tsx-node src/dev/fake-telegram.ts
   ```

   By default it listens on `http://127.0.0.1:3001`. Set `FAKE_TELEGRAM_PORT` to change the port.

3. Run the bot pointed at the fake server:

   ```sh
   TELEGRAM_BOT_TOKEN=-dev-fake-token \
   TELEGRAM_API_ROOT=http://127.0.0.1:3001 \
   npm run dev
   ```

   The token can be any non-empty string; the fake server accepts it as-is.

4. Trigger a notification (for example via the mock JSON-RPC server or any code path that calls `sendMessage`). The fake server prints the received payload to stdout, e.g.:

   ```
   [fake-telegram] sendMessage chat=123 text="Hello from the bot"
   ```

## Notes

- "TELEGRAM_API_ROOT` is dev-only and must point at a loopback host. Non-loopback values fail at config load.
- The fake server implements only the methods listed above. Other Bot API methods are out of scope.
- The fake server never contacts api.telegram.org, so no real token is required.
