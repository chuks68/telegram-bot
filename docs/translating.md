# Translator Guide (`src/i18n.ts`)

This guide explains how user-facing strings are organized, formatted, and escaped in [`src/i18n.ts`](../src/i18n.ts) so translators and contributors can edit or add strings safely without causing Telegram API rejections or broken formatting.

---

## 1. String Organization: MarkdownV2 vs. Plain Text

All user-facing localization templates live in [`src/i18n.ts`](../src/i18n.ts). Strings are strictly separated based on whether the caller dispatches them with `parse_mode: "MarkdownV2"` or as raw plain text (no `parse_mode`):

| Export in `src/i18n.ts` | Mode | Purpose & Caller Behavior |
| --- | --- | --- |
| `HELP_TITLE` | **MarkdownV2** | Bot `/help` and `/start` headline (`"*Mimir notifier*"`). Pre-formatted as bold. |
| `HELP_INTRO` | **Plain text** | Intro paragraph under `HELP_TITLE`. Stored unescaped; `helpMessage()` in [`src/bot.ts`](../src/bot.ts) runs `escapeMd(HELP_INTRO)` before combining it into the MarkdownV2 `/help` reply. |
| `PAUSE_MESSAGES` | **MarkdownV2** | Operator `/pause` replies (`paused`, `alreadyPaused`, `stopped`). Sent directly with `parse_mode: "MarkdownV2"`. |
| `RESUME_MESSAGES` | **MarkdownV2** | Operator `/resume` replies (`resumed`, `alreadyRunning`, `stopped`). Sent directly with `parse_mode: "MarkdownV2"`. |
| `AUDIT_CLI_HINT` | **Plain text** | Footer hint appended to `/audit` replies. Sent **without** a `parse_mode` because audit logs contain arbitrary redacted text. Backticks in this string render literally. |
| `COMMAND_DESCRIPTIONS` | **Plain text** | Descriptions registered with Telegram's `setMyCommands` autocomplete menu and interpolated into `/help` (via `escapeMd`). |
| `NOTIFICATION_MD` | **MarkdownV2** | Primary event notification templates (`claimCreated`, `claimChallenged`, etc.), fallback template (`fallbackEvent`), and preview headers (`previewModePrefix`, `channelPreviewMarket`, `channelPreviewSquad`). |
| `NOTIFICATION_PLAIN` | **Plain text** | 1-to-1 plain-text mirror of `NOTIFICATION_MD` (plus `minimal`), sent without `parse_mode` if Telegram rejects the MarkdownV2 payload or when plain text is requested. |
| `EXPLORER_BUTTON_TEXT` | **Plain text** | Label on the inline keyboard button linking to Stellar Expert (`"View on Explorer"`). Inline button labels do not parse Markdown. |

### Why Both `NOTIFICATION_MD` and `NOTIFICATION_PLAIN` Exist

In [`src/bot.ts`](../src/bot.ts), `createNotifier()` always attempts to send event notifications using `NOTIFICATION_MD` with `parse_mode: "MarkdownV2"`. If Telegram rejects the message with HTTP 400 (`can't parse entities`), the notifier automatically retries once using the `NOTIFICATION_PLAIN` rendering without a `parse_mode`.

* **`NOTIFICATION_MD` strings** use MarkdownV2 entities (`*bold*`, `_italic_`, `` `code` ``, `[text](url)`) and **must pre-escape** every literal reserved character.
* **`NOTIFICATION_PLAIN` strings** must contain **zero** Markdown syntax (`*`, `_`, `` ` ``, `[`, `]`, `\`). Any formatting characters placed in `NOTIFICATION_PLAIN` will show up as raw punctuation in the user's chat and will fail [`tests/i18n.test.mjs`](../tests/i18n.test.mjs).

#### Real Example from `src/i18n.ts`: `claimCreated` and `claimed`

```ts
// MarkdownV2 (NOTIFICATION_MD) — uses *bold* and pre-escapes literal '#' and '(', ')'
claimCreated: (claimId: string, category: string, creator: string): string =>
  `🆕 *New claim* \\#${claimId}\nCategory: ${category}\nCreator: ${creator}`,

claimed: (
  marketId: string,
  participant: string,
  net: string,
  gross: string,
  fee: string,
): string =>
  `💸 *Squad payout* on \\#${marketId}\n${participant} → net *${net}* \\(gross ${gross}, fee ${fee}\\)`,
```

```ts
// Plain text (NOTIFICATION_PLAIN) — no emojis required, no *bold*, no backslash escapes
claimCreated: (claimId: string | number, category: string, creator: string): string =>
  `New claim #${claimId}\nCategory: ${category}\nCreator: ${creator}`,

claimed: (
  marketId: string | number,
  participant: string,
  net: string,
  gross: string,
  fee: string,
): string =>
  `Squad payout on #${marketId}\n${participant} → net ${net} (gross ${gross}, fee ${fee})`,
```

---

## 2. Pre-Escaped Reserved Characters in MarkdownV2

Telegram's `MarkdownV2` parser requires **18 reserved characters** to be escaped with a preceding backslash (`\`) whenever they appear as literal text outside a formatting entity:

```text
_ * [ ] ( ) ~ ` > # + - = | { } . !
```

And inside a JavaScript/TypeScript string or template literal in `src/i18n.ts`, each backslash must itself be escaped as `\\`.

### Rules for Static Text in MarkdownV2 Strings

1. **Escape literal punctuation**: Common prose characters like periods (`.`), hyphens (`-`), hashes (`#`), parentheses (`(` and `)`), and exclamation marks (`!`) are reserved in MarkdownV2.
   * Note: Em-dashes (`—`), middle dots (`·`), arrows (`→`), colons (`:`), commas (`,`), and percent signs (`%`) are **not** reserved in MarkdownV2 and must not be escaped.
2. **Double the backslash in TypeScript source**: Write `\\.` for a literal period, `\\#` for a literal hash, `\\-` for a literal hyphen, and `\\(` / `\\)` for literal parentheses.
3. **Keep entity delimiters unescaped and balanced**:
   * Bold: `*bold text*`
   * Italic: `_italic text_`
   * Inline code: `` `code` ``
   * Inline link: `[label](https://...)`

### Real Examples of Pre-Escaped Strings in `src/i18n.ts`

* **Escaping literal periods (`\\.`) in `PAUSE_MESSAGES` and `RESUME_MESSAGES`:**
  ```ts
  export const PAUSE_MESSAGES = {
    paused:
      "*Polling paused*\nThe current scan may finish, but no new cycle will start\\. Cursors were not changed\\.",
    alreadyPaused: "*Polling is already paused*",
    stopped: "*Polling cannot pause* — the process is stopping\\.",
  } as const;
  ```
* **Escaping literal hyphens (`\\-`) in `NOTIFICATION_MD`:**
  ```ts
  channelPreviewMarket: "🧪 *Channel Preview — mimir\\-market*",
  channelPreviewSquad: "🧪 *Channel Preview — mimir\\-squad*",
  ```
* **Bold entity wrapping in `previewModePrefix`:**
  ```ts
  previewModePrefix: "🧪 *[PREVIEW MODE]*",
  ```
  Here `*[PREVIEW MODE]*` is a bold entity span (`*...*`). Note that [`tests/markdown-lint.test.mjs`](../tests/markdown-lint.test.mjs) tokenizes `*...*` as a bold entity and validates reserved characters outside entity spans; however, in new strings, prefer escaping literal `[` and `]` as `\\[` and `\\]` unless forming a `[text](url)` link so Telegram's parser never interprets them as link syntax.
* **Escaping hashes (`\\#`) and parentheses (`\\(`, `\\)`) alongside formatting entities (`fallbackEvent`):**
  ```ts
  fallbackEvent: (
    source: string,
    contract: string,
    ledger: string,
    reason: string,
    txPart: string,
  ): string =>
    `⚠️ *Event Notification Fallback* \\(${source}\\)\nContract: \`${contract}\` · Ledger: ${ledger}${txPart}\nReason: _${reason}_`,
  ```

---

## 3. Placeholders Interpolated by Callers

Template entries in `NOTIFICATION_MD` and `NOTIFICATION_PLAIN` are TypeScript arrow functions. **The localization layer provides the template; callers in [`src/notifications/format.ts`](../src/notifications/format.ts) supply the already-formatted and already-escaped arguments.**

### Caller Escaping Contract

Translators must **never** wrap `NOTIFICATION_MD` template parameters in `escapeMd()` inside `src/i18n.ts`, and must pay attention to which parameters already carry MarkdownV2 entities from the caller:

| Parameter Type | How [`src/notifications/format.ts`](../src/notifications/format.ts) Prepares It for `NOTIFICATION_MD` | How It Arrives in `NOTIFICATION_PLAIN` |Template Usage in `NOTIFICATION_MD` |
| --- | --- | --- | --- |
| **IDs** (`claimId`, `marketId`, `ledger`) | `String(p.claimId)` (digits, or `escapeMd` for `ledger`) | `p.claimId` (`string \| number`) | Preceded by `\\#` in `NOTIFICATION_MD` (e.g. `\\#${claimId}`) and `#` in `NOTIFICATION_PLAIN` (`#${claimId}`). |
| **Addresses** (`creator`, `challenger`, `recipient`, `to`, `captain`, `participant`) | `who(address)` → `` ` `` + `escapeMd(shortAddress(addr))` + `` ` `` (**already wrapped in backticks!**) | `plainWho(address)` → `shortAddress(addr)` (plain `GABC…WXYZ`) | Interpolate `${creator}` directly. **Do not** add extra backticks around address parameters in `NOTIFICATION_MD` (except `contract` in `fallbackEvent`, which is passed without backticks and wrapped as `` \`${contract}\` `` in the template). |
| **USDC Amounts** (`stake`, `totalPaid`, `totalFees`, `owedToChallengers`, `net`, `gross`, `fee`, `amount`, `poolA`, `poolB`) | `usdc(units)` → `escapeMd("2.0000000 USDC")` (produces `"2\\.0000000 USDC"`) | `plainUsdc(units)` → `"2.0000000 USDC"` | Safe to place outside or inside `*...*` bold markers (e.g. `*${stake}*`, `*${totalPaid}*`, `*${net}*`). |
| **Free-Text Contract Strings** (`category`, `question`, `summary`, `reason`) | `escapeMd(clip(text))` (truncated to 200 Unicode characters, then MarkdownV2-escaped) | `clip(text)` (truncated to 200 Unicode characters, unescaped) | Interpolate directly. In `claimResolved` and `fallbackEvent`, `summary` and `reason` are wrapped in italic underscores `_${summary}_` / `_${reason}_` by the template. |
| **Labels & Timestamps** (`winnerSide`, `side`, `result`, `feeBps`, `deadline`) | `escapeMd(...)` | Plain string | Interpolate directly; `winnerSide`, `side` (in `deposited`), and `result` (in `resolved`) are wrapped in `*...*` bold by the template. |
| **Optional Link Suffix** (`txPart` in `fallbackEvent`) | Either `""` or `` ` · [tx](${txExplorerUrl(...)})` `` (already valid MarkdownV2 link) | N/A | Appended directly to `Ledger: ${ledger}${txPart}` with no space before `${txPart}`. |

### Real Reference Table of All Template Signatures in `src/i18n.ts`

| Key (`NOTIFICATION_MD` & `NOTIFICATION_PLAIN`) | Parameters | Notes for Translators |
| --- | --- | --- |
| `claimCreated` | `(claimId, category, creator)` | Keep `\\#${claimId}` in MD, `#${claimId}` in plain. |
| `claimChallenged` | `(claimId, stake, challenger)` | `*${stake}*` is bolded in MD. |
| `claimResolved` | `(claimId, winnerSide, confidence, summary)` | `summary` is `string \| null`. When `null`, the italic summary line is omitted and `.trimEnd()` removes the trailing newline. Keep `%` after `${confidence}%`. |
| `claimCancelled` | `(claimId)` | Single-line status headline. |
| `marketSettled` | `(claimId, totalPaid, totalFees, owedToChallengers)` | `*${totalPaid}*` is bolded in MD. |
| `challengerPaid` | `(claimId, challenger, stake, net, gross, fee)` | `*${net}*` is bolded in MD. |
| `feeClaimed` | `(amount, recipient)` | Single-line market fee payout. |
| `withdrawal` | `(amount, to)` | Single-line withdrawal headline. |
| `withdrawalPending` | `(amount, to)` | Single-line pending withdrawal headline. |
| `marketCreated` | `(marketId, question, captain, feeBps, deadline)` | 3-line squad market creation summary. |
| `deposited` | `(marketId, amount, side, participant)` | `*${side}*` is bolded in MD. |
| `withdrawn` | `(marketId, participant, amount, side)` | Note parameter order: `(marketId, participant, amount, side)` differs from `deposited`. |
| `resolved` | `(marketId, result, poolA, poolB)` | `*${result}*` is bolded in MD. |
| `claimed` | `(marketId, participant, net, gross, fee)` | Uses escaped parentheses `\\(gross ${gross}, fee ${fee}\\)` in MD. |
| `feesClaimedSquad` | `(amount, recipient)` | Squad equivalent of `feeClaimed`. |
| `fallbackEvent` *(MD only)* | `(source, contract, ledger, reason, txPart)` | `contract` is wrapped in backticks inside the template: `` \`${contract}\` ``. |
| `minimal` *(Plain only)* | `(source, ledger, eventId)` | Last-resort fallback; **must never return an empty string** even if all arguments are `""`. |

---

## 4. Command Autocomplete Strings (`COMMAND_DESCRIPTIONS`)

The `COMMAND_DESCRIPTIONS` object in [`src/i18n.ts`](../src/i18n.ts) defines the descriptions for all nine bot commands:

```ts
export const COMMAND_DESCRIPTIONS = {
  start: "What this bot does",
  help: "Show help",
  status: "Last-seen ledger and watched contracts",
  audit: "Operator only: audit report (redacted, bounded)",
  contracts: "Contract ids and explorer links",
  health: "Health assessment and operational readiness",
  preview: "Preview channel notification formatting",
  pause: "Operator only: pause new scans",
  resume: "Operator only: resume polling now",
} as const;
```

### Where `COMMAND_DESCRIPTIONS` Appear

Each entry in `COMMAND_DESCRIPTIONS` is used in two places in [`src/bot.ts`](../src/bot.ts):

1. **Telegram UI Autocomplete Menu (`registerCommands`)**: Sent to Telegram via `bot.api.setMyCommands(...)` at startup so users see a command pop-up menu when they type `/` in the chat.
   * When `OPERATOR_TELEGRAM_USER_ID` is unset (`null`), operator-only commands (`audit`, `pause`, `resume`) are filtered out by `visibleCommands()` and omitted from both the autocomplete menu and `/help`.
2. **`/help` and `/start` Replies (`helpMessage`)**: Rendered as `/command — description` and passed through `escapeMd(...)` before being sent in `MarkdownV2` mode.

### Rules & Constraints for `COMMAND_DESCRIPTIONS`

* **Plain text only — no MarkdownV2 formatting characters**: Telegram's command autocomplete menu does not parse Markdown. Furthermore, [`tests/i18n.test.mjs`](../tests/i18n.test.mjs) enforces that no description matches `/[*_`[\]~>#+|{}.!\\]/`.
  * **Allowed**: Letters, numbers, spaces, colons (`:`), commas (`,`), hyphens (`-`), and parentheses (`(` and `)`), as seen in `"Operator only: audit report (redacted, bounded)"`.
  * **Forbidden**: `*`, `_`, `` ` ``, `[`, `]`, `~`, `>`, `#`, `+`, `|`, `{`, `}`, `.` (periods!), `!`, and `\`.
* **Telegram `BotCommand` description length limit**: Telegram's Bot API requires each `setMyCommands` description to be between **1 and 256 characters** (recommended under ~60 characters so it does not truncate on mobile screens).
* **Prefix convention**: Keep the `"Operator only: ..."` prefix on operator-gated commands (`audit`, `pause`, `resume`).

---

## 5. Telegram Length Limits & Clipping Boundaries

Translators should keep strings concise ("One event, one message, one line of substance — a notification is read on a phone lock screen"). Keep these hard and soft limits in mind when translating:

| Surface | Limit | Constant / Enforcement in Codebase | Translator Impact |
| --- | --- | --- | --- |
| **Telegram Message (`sendMessage` / `editMessageText`)** | **4,096 characters** | `TELEGRAM_MAX_MESSAGE_LENGTH = 4096` in [`src/notifications/format.ts`](../src/notifications/format.ts). Oversized messages are split on newlines by `splitTelegramMessage()` without breaking trailing backslash escapes. | Individual event notifications should remain well under 500 characters so they never split into multi-part messages. |
| **Plain-Text Fallback Notification** | **4,000 characters** | `MAX_PLAIN_TEXT_LENGTH = 4000` (`clipPlainText()` in [`src/notifications/format.ts`](../src/notifications/format.ts)). | `formatPlainTextEvent()` clips the final assembled plain-text message to 4,000 Unicode code points. |
| **Contract Free-Text Fields** (`category`, `question`, `summary`) | **200 characters** per field | `MAX_EVENT_FIELD_LENGTH = 200` (`clip()` in [`src/notifications/format.ts`](../src/notifications/format.ts)). | Dynamic contract text can be up to 200 characters before `escapeMd()` (which can double the length if every character is reserved). Leave ample room in `NOTIFICATION_MD` templates. |
| **Error / Fallback Reason** (`reason` in `fallbackEvent`) | **240 characters** | `safeErrorMessage()` in [`src/notifications/format.ts`](../src/notifications/format.ts) clamps redacted error strings to 240 characters. | Static text in `NOTIFICATION_MD.fallbackEvent` must stay compact around `${reason}`. |
| **Command Autocomplete Description** (`COMMAND_DESCRIPTIONS`) | **1–256 characters** | Telegram Bot API `setMyCommands` limit (and tested for non-empty length in [`tests/i18n.test.mjs`](../tests/i18n.test.mjs)). | Keep descriptions concise (ideally 20–60 characters) and never empty. |
| **Inline Keyboard Button Text** (`EXPLORER_BUTTON_TEXT`) | Non-empty (keep **≤ 30 characters**) | Tested in [`tests/i18n.test.mjs`](../tests/i18n.test.mjs). | Long button labels truncate with `…` on narrow mobile screens; keep `"View on Explorer"` translations short. |

---

## 6. Translator Review Checklist

Before opening a pull request that edits or adds strings in [`src/i18n.ts`](../src/i18n.ts), verify every item below:

- [ ] **Both `NOTIFICATION_MD` and `NOTIFICATION_PLAIN` are updated in lockstep**: Every event template change in `NOTIFICATION_MD` has a corresponding update in `NOTIFICATION_PLAIN` with the exact same parameter order and meaning.
- [ ] **All literal MarkdownV2 reserved characters are pre-escaped in MarkdownV2 strings**: Check `HELP_TITLE`, `PAUSE_MESSAGES`, `RESUME_MESSAGES`, and `NOTIFICATION_MD` for any unescaped `_ * [ ] ( ) ~ ` > # + - = | { } . !` outside formatting entities (remembering to write `\\.` / `\\#` / `\\-` / `\\(` / `\\)` in `.ts` files).
- [ ] **No MarkdownV2 syntax or backslash escapes leak into plain-text strings**: Verify that `HELP_INTRO`, `AUDIT_CLI_HINT`, `COMMAND_DESCRIPTIONS`, `NOTIFICATION_PLAIN`, and `EXPLORER_BUTTON_TEXT` contain no `\\` escape sequences and that `NOTIFICATION_PLAIN` contains none of `* _ ` [ ] \`.
- [ ] **`COMMAND_DESCRIPTIONS` contain no forbidden punctuation**: Confirm no command description in `COMMAND_DESCRIPTIONS` uses periods (`.`), exclamation marks (`!`), hashes (`#`), or Markdown formatting characters (`/[*_`[\]~>#+|{}.!\\]/`), and each is non-empty and under 256 characters.
- [ ] **Template placeholders and caller formatting are preserved**:
  - Function parameter counts and order match callers in [`src/notifications/format.ts`](../src/notifications/format.ts).
  - Address placeholders (`${creator}`, `${challenger}`, `${participant}`, etc.) are **not** wrapped in extra backticks in `NOTIFICATION_MD` (since `who()` already wraps them in `` `...` ``).
  - `claimResolved` still handles `summary === null` without leaving trailing whitespace, a dangling newline, or empty `__` italic markers.
  - `NOTIFICATION_PLAIN.minimal` never returns an empty string, even when called with `("", "", "")`.
- [ ] **Automated lint and localization tests pass**:
  ```bash
  npm run typecheck
  npm test
  ```
  Specifically confirm that both [`tests/i18n.test.mjs`](../tests/i18n.test.mjs) (snapshot and plain-text boundary checks) and [`tests/markdown-lint.test.mjs`](../tests/markdown-lint.test.mjs) (MarkdownV2 tokenizer and reserved-character linter) pass with zero errors.
