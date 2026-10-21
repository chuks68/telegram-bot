# Mimir and Stellar glossary

Terms used in the bot's [notification templates](../src/i18n.ts#L78) and
[decoded payloads](../src/stellar/decode.ts#L102), listed alphabetically.

## Captain

The address recorded as the captain of a squad market when it is created
(`captain` in [`SquadMarketCreatedPayload`](../src/stellar/decode.ts#L136-L145)).

## Category

A claim's text label (`category` in [`MarketPayload`](../src/stellar/decode.ts#L102-L104));
v2 squad markets may also carry an optional `category` in
[`SquadMarketCreatedPayload`](../src/stellar/decode.ts#L136-L145).

## Challenger

The address challenging a claim, reported together with its `stake` in the
`claim_challenged` event ([`MarketPayload`](../src/stellar/decode.ts#L102-L104)).

## Claim

A statement tracked by `mimir-market`, identified by `claimId` with a `creator`
and `category` in its `claim_created` event
([`MarketPayload`](../src/stellar/decode.ts#L102-L104)).

## Confidence

The numeric `confidence` reported with a claim's resolution and displayed as a
percentage in its notification ([`MarketPayload`](../src/stellar/decode.ts#L105-L113)).

## Cursor

An opaque RPC pagination token used to resume scanning events, returned as
[`RawScan.cursor`](../src/stellar/events.ts#L110-L113) and persisted per watched
contract in [`CursorFile`](../src/poller.ts#L276-L287).

## Dust

The residual USDC amount reported in the `dust` field of a claim's
`market_settled` event ([`MarketPayload`](../src/stellar/decode.ts#L115-L122)).

## Fee bps

A fee rate in basis points, where 100 bps equals 1%, so `feeBps: 200` represents
2% in [`SquadMarketCreatedPayload`](../src/stellar/decode.ts#L136-L145).

## Ledger

A numbered batch of Stellar transactions; the `ledger` field in
[`EventMeta`](../src/stellar/decode.ts#L69-L78) identifies the ledger containing
an event.

## Resolution

The reported outcome of a claim (`winnerSide` in
[`MarketPayload`](../src/stellar/decode.ts#L105-L113)) or a squad market
(`result` in [`SquadResolvedPayload`](../src/stellar/decode.ts#L164-L170)).

## Settlement

The payout-and-fee accounting reported by `market_settled`: `totalPaid`,
`totalFees`, `owedToChallengers` and `dust`
([`MarketPayload`](../src/stellar/decode.ts#L115-L122)).

## Shares

The units reported for a participant's squad-market deposit as `shares`,
separately from the deposited USDC `amount`
([`SquadDepositedPayload`](../src/stellar/decode.ts#L147-L154)).

## Side

One of a squad market's two positions, Side A (`1`) or Side B (`2`) in
[`SQUAD_SIDE`](../src/stellar/decode.ts#L61-L67), recorded as `side` in
[`SquadDepositedPayload`](../src/stellar/decode.ts#L147-L154) and
[`SquadWithdrawnPayload`](../src/stellar/decode.ts#L156-L162).

## Squad market

A two-sided market tracked by `mimir-squad`, identified by `marketId` and
described by a `question`, `captain`, `deadline` and `feeBps`
([`SquadMarketCreatedPayload`](../src/stellar/decode.ts#L136-L145)).

## Stake

The USDC amount committed by a challenger to a claim, recorded as `stake` in
`claim_challenged` and `challenger_paid`
([`MarketPayload`](../src/stellar/decode.ts#L104-L131)).
