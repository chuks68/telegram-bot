# Channel member FAQ

This channel is fed by a bot that watches Mimir's contracts on Stellar and posts
every new on-chain event. The messages use a few specific words — this page
explains them in plain language. For full definitions see the
[glossary](glossary.md).

## What each notification means

### 🆕 New claim

Someone posted a statement (a claim) on the Mimir market. The message shows the
claim number, its category text and the creator's address. No money has moved
yet — it is just an announcement. Later messages tell you whether the claim is
challenged, resolved or cancelled.

### ⚔️ Claim #N challenged

Someone disagrees with the claim and staked USDC against it. The message shows
the stake amount and the challenger's address. The stake is the challenger's own
money at risk; it is returned or paid out when the claim is resolved or
cancelled.

### ⚖️ Claim #N resolved

An oracle decided the claim's outcome. The message names the winning side and
shows `Confidence: ████░░ 60%` — how sure the oracle reported itself to be, as a
bar plus percentage, plus an optional one-line summary. Resolution decides who
wins; the money moves in the following settlement message.

### 🚫 Claim #N cancelled

The claim was called off before an outcome, and every stake was returned to the
people who posted it. No one wins or loses.

### 💰 Claim #N settled

The payout-and-fee accounting for a resolved claim: `Paid out` is what winners
receive, `fees` is what the protocol kept, and `Owed to challengers` is what the
winning challengers get. The related `dust` field is the tiny USDC remainder
left over from dividing the payout — fractions of a cent that cannot be split
further.

### 🏆 Challenger paid

A challenger collected their winnings on a resolved claim. The message shows the
address, what they staked, what they take home (`net`), the `gross` amount before
the `fee`, and the fee itself.

### 🧾 Fees claimed

Protocol fees were collected and sent to a recipient address. No claim outcome
is implied.

### 📤 Withdrawal and ⏳ Withdrawal parked

`Withdrawal` — funds left the contract for an address. `Withdrawal parked` — the
funds could not be delivered automatically, so the amount is now claimable by
that address instead. The money is not lost either way.

### Squad notifications

`🆕 New squad market` opens a two-sided market with a question, captain, fee and
deadline. `➕` shows a deposit on Side A or B, `➖` a participant pulling funds
back. `🏁 Squad #N resolved` names the winning side and both pools. `💸 Squad
payout` and `🧾 Squad fees claimed` show a participant's winnings and the
protocol fee.

### ⚠️ Event Notification Fallback

The bot saw an event it could not read properly, so it posted the raw details
instead of a normal message. It means something on-chain changed in an
unexpected format — not that your funds are at risk.

### 🧪 Preview mode and Mimir Digest

`[PREVIEW MODE]` marks test renderings, not real events. A `Mimir Digest`
message summarises several events from one polling cycle as one line each.

### The `ledger N · tx` line and the Explorer button

Every event message ends with the ledger (Stellar's numbered batch of
transactions) containing it, and a link to that transaction.

## Why do amounts have 7 decimals?

USDC on Stellar is stored as whole numbers with 7 decimal places, so
`2.0000000 USDC` is simply 2 USDC. Printing all seven digits keeps the amount
exact and unambiguous — nothing is rounded or converted through decimals. The
trailing zeros are normal and never mean extra money.

## What does the explorer link show?

The `tx` link and the `View on Explorer` button open the public Stellar explorer
page for the exact transaction behind the message: what was called, which events
it emitted, the fee paid and whether it succeeded. It is independent proof you
can check yourself. Messages whose transaction hash is missing get no link.

## Why can notifications arrive late?

The bot checks Stellar roughly every 30 seconds, so a message can trail the real
event by that long. Delays also come from the bot waiting out an unreachable
network node, a burst of more than 20 notifications being spread across cycles,
the small pause between sends, and Telegram rate limits during busy periods.
Events are never dropped — only queued for the next pass.
