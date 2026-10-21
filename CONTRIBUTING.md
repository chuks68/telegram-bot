# Contributing to mimir-stellar/telegram-bot

Thanks for helping improve the Mimir Telegram notifier. This guide gives first-time
contributors the setup, test, and pull-request expectations. The bot is read-only: it
polls Mimir's Soroban contracts and posts events to Telegram — it holds no keys and
signs nothing.

## Prerequisites

- **Node.js >= 20** (the `engines.node` field in `package.json`); production runs on
  Node 22, pinned in `.nvmrc`.
- A local checkout of this repository.
- **No credentials required to develop or test.** The automated suite never calls the
  live Testnet RPC or the Telegram API; fixture and mock profiles are credential-free.
  A real `BOT_TOKEN` and `TELEGRAM_CHAT_ID` are only needed to run the bot itself, never
  to contribute.

## Setup

```bash
nvm use   # optional: selects Node 22 from .nvmrc
npm ci
```

`npm ci` installs exactly what `package-lock.json` pins (deployments rebuild the same
way). Keep the lockfile in sync when you change dependencies: edit `package.json`,
run `npm install` to regenerate the lockfile, and commit both together — drift fails
`npm ci`, `npm run lockfile:check`, `npm run lockfile:reproduce`, and CI.

## Development checks

Run these locally before opening a PR; CI runs the secret scan, the lockfile
checks, typecheck, build, and the full test suite on every push and pull request.

```bash
npm run scan:secrets  # fail-fast scan for secret-shaped strings (CI runs it first)
npm run typecheck     # no-emit TypeScript check (tsc -p tsconfig.json --noEmit)
npm run build         # compile src/ -> dist/
npm test              # build, then run every tests/*.test.mjs with node's built-in runner
```

### Pre-commit hook (optional)

Catch tokens locally before committing:

```bash
git config core.hooksPath .githooks
```

This opt-in hook runs `scripts/pre-commit.mjs` on staged files prior to each commit.

- `npm test` builds `src/` into `dist/` and then runs all suites
  (`tests/*.test.mjs`). It needs no network credentials.
- To run only the local-mock suites (`tests/mock-*.test.mjs`):

```bash
npm run test:mock
```

### Fast unit-test loop (`test:fast`)

`test:fast` runs the full test suite directly against `src/` using
[tsx](https://tsx.is/) as a TypeScript transpiler — no `tsc` build step, no
`dist/` output. A tiny loader shim (`scripts/tsx-dist-loader.mjs`) intercepts
`../dist/*.js` import specifiers in the test files and rewrites them to their
`src/*.ts` counterparts; `tsx` then transpiles each module in-memory.

```bash
# Run the whole suite
npm run test:fast

# Run only the formatter and decoder tests (common inner-loop targets)
node --import tsx/esm --import ./scripts/tsx-dist-loader.mjs \
  --test --test-timeout=120000 \
  tests/format.test.mjs tests/decode.test.mjs
```

**When to use each script:**

| Script | Builds `dist/`? | Type-checks? | When to run |
|---|---|---|---|
| `npm run test:fast` | No | No (transpile only) | Inner-loop iterations on formatter/decoder logic |
| `npm test` | Yes | Yes (via tsc) | Before opening a PR; mirrors CI exactly |

> **Note:** `test:fast` skips type-checking. Always run `npm test` (or
> `npm run typecheck`) as a final check before submitting a PR.

### Local mock profile (no Testnet or Telegram)

For a five-minute quickstart walking through the mock RPC, scanner, and rendered
notifications without tokens, see [docs/quickstart-mock.md](docs/quickstart-mock.md).

Rehearse failure drills against a loopback Soroban mock instead of live services:

```bash
npm run mock:rpc    # serve the fixture scenario on 127.0.0.1:8420
npm run mock:poll   # dry run: mock RPC + real poller, sends are logged only
```

`MIMIR_PROFILE=mock` fills unset config with local, loopback-only fixtures and an
isolated cursor file (`data/cursor.mock.json`), so a drill cannot touch the live bot's
position. See `docs/contributor-fixtures.md` for the fixture catalog and failure-mode
table.

### Interactive developer REPL

To explore Soroban event decoding and Telegram notification formatting interactively without network access or `.env` credentials, launch the preloaded REPL:

```bash
node dist/dev/repl.js
# or with tsx directly from source:
npx tsx src/dev/repl.ts
```

The REPL context is preloaded with:
- **Decoders**: `decode`, `decodeEvent`, `formatUsdc`, `shortAddress`.
- **Formatters**: `format`, `formatEvent`, `formatPlainTextEvent`, `escapeMd`, `eventExplorerUrl`.
- **Fixtures & constants**: `mockConstants` (mock contract IDs, RPC port, passphrase), `sampleConfig` / `config` (offline mock configuration), `fixtures` / `events` (synthetic event builders from `tests/fixtures/events.mjs`), and `scenario` (`defaultMockScenario()`).
- **Interactive helpers**:
  - `render(name, overrides?)` — Renders Telegram notification text for an event from the in-process mock scenario (e.g. `render("claim_created")`, `render("market_created")`) or fixtures, applying optional field overrides (e.g. `render("claim_created", { claimId: 42, category: "sports" })`).
  - `scan(n?)` — Scans, decodes, and logs the first `n` events from the in-process mock scenario (defaults to all events).
  - `help()` — Prints available variables and helper signatures.


## Adding tests

- Put a new suite in its own `tests/*.test.mjs` file.
- Import compiled modules from `dist/` (for example `../dist/bot.js`), so run
  `npm run build` before `npm test` — `npm test` already does this for you.
- Use deterministic, credential-free fixtures: no live RPC calls, no Telegram API
  calls, no bot tokens, and no signing keys. Reuse the ephemeral data-dir helper for
  persistence tests instead of hand-rolled `/tmp` paths.
- Credential-free fixture rules (stable fake `C…`/`G…` ids, `example.invalid` URLs,
  redacted placeholder tokens) live in
  [docs/contributor-fixtures.md](docs/contributor-fixtures.md).

## Branching and commits

- Create a branch off `main` for one logical change: `fix/short-description`,
  `feat/short-description`, `docs/short-description`, or `test/short-description`.
- Use conventional-commit titles: `type(scope): subject`
  (e.g. `fix(poller): advance cursor after a failed send`).
- Keep each PR focused on a single logical unit; batch unrelated fixes in separate
  PRs so they can be reviewed and merged independently.

## Pull request expectations

- Open the PR against `main` and fill in the repository's pull-request template.
- Describe the *why*, not only the diff: what changed, how it was verified
  (`npm run scan:secrets`, `npm run typecheck`, `npm test`, and the mock drills
  when relevant), and any deployment or configuration impact.
- Never commit a real `BOT_TOKEN`, chat id, private key, payment proof, or a live
  `data/cursor.json`. Examples use placeholders such as `0000000000:SECRET-TOKEN-DO-NOT-LEAK`.
- Keep tests and docs consistent with the behavior they describe; a behavior change
  updates its test and, where the operator surface changes, the README.

## Where things live

- `src/` — the TypeScript source (config, RPC client, decoder, poller, bot, audit).
- `src/dev/repl.ts` — interactive developer REPL with preloaded decoders, formatters, and mock helpers.
- `tests/` — Node built-in test runner suites compiled against `dist/`.
- `scripts/tsx-dist-loader.mjs` — ESM loader that maps `dist/*.js` → `src/*.ts` for `test:fast`.
- `docs/quickstart-mock.md` — five-minute quickstart using the local mock RPC.
- `docs/contributor-fixtures.md` — credential-free fixture guide and failure modes.
- `.env.example` — the documented runtime settings (not required for testing).
