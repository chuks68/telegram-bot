# Notification Catalogue

This page is the single reference for every notification the bot can render. Each sample below is the exact output of `formatEvent` in `src/notifications/format.ts`, backed by the strings in `NOTIFICATION_MD` (`src/i18n.ts`). When wording changes, update this file in the same PR.

Every event name in `MarketPayload` and `SquadPayload` appears exactly once.

## How to verify

Run the mock poller and compare its output to the samples below:

```bash
npm run mock:poll
```

The samples are copied from a local run of that command. If you change a template in `src/i18n.ts`, re-run the poller and paste the new output here.

## Market events

The market formatter handles nine event names. An explorer button is attached when the payload carries a transaction hash (`txHash`); the button links to the configured explorer for that network.

| Event | Payload fields used | Explorer button |
| --- | --- | --- |
| `market_created` | `marketId`, `question`, `creator`, `txHash` | Yes |
| `market_resolved` | `marketId`, `question`, `outcome`, `txHash` | Yes |
| `market_cancelled` | `marketId`, `question`, `txHash` | Yes |
| `market_paused` | `marketId`, `question`, `txHash` | Yes |
| `market_unpaused` | `marketId`, `question`, `txHash` | Yes |
| `market_closed` | `marketId`, `question`, `txHash` | Yes |
| `market_settled` | `marketId`, `question`, `outcome`, `txHash` | Yes |
| `market_disputed` | `marketId`, `question`, `txHash` | Yes |
| `market_finalized` | `marketId`, `question`, `outcome`, `txHash` | Yes |

### `market_created`

Payload fields used: `marketId`, `question`, `creator`, `txHash`. Explorer button: yes.

```
New market created

Question: Will the next block be mined before 12:00 UTC?
Market ID: 0
Creator: GABC...DEFF
```

### `market_resolved`

Payload fields used: `marketId`, `question`, `outcome`, `txHash`. Explorer button: yes.

```
Market resolved

Question: Will the next block be mined before 12:00 UTC?
Market ID: 0
Outcome: Yes
```

### `market_cancelled`

Payload fields used: `marketId`, `question`, `txHash`. Explorer button: yes.

```
Market cancelled

Question: Will the next block be mined before 12:00 UTC?
Market ID: 0
```

### `market_paused`

Payload fields used: `marketId`, `question`, `txHash`. Explorer button: yes.

```
Market paused

Question: Will the next block be mined before 12:00 UTC?
Market ID: 0
```

### `market_unpaused`

Payload fields used: `marketId`, `question`, `txHash`. Explorer button: yes.

```
Market unpaused

Question: Will the next block be mined before 12:00 UTC?
Market ID: 0
```

### `market_closed`

Payload fields used: `marketId`, `question`, `txHash`. Explorer button: yes.

```
Market closed

Question: Will the next block be mined before 12:00 UTC?
Market ID: 0
```

### `market_settled`

Payload fields used: `marketId`, `question`, `outcome`, `txHash`. Explorer button: yes.

```
Market settled

Question: Will the next block be mined before 12:00 UTC?
Market ID: 0
Outcome: Yes
```

### `market_disputed`

Payload fields used: `marketId`, `question`, `txHash`. Explorer button: yes.

```
Market disputed

Question: Will the next block be mined before 12:00 UTC?
Market ID: 0
```

### `market_finalized`

Payload fields used: `marketId`, `question`, `outcome`, `txHash`. Explorer button: yes.

```
Market finalized

Question: Will the next block be mined before 12:00 UTC?
Market ID: 0
Outcome: Yes
```

## Squad events

The squad formatter handles six event names. An explorer button is attached when the payload carries a transaction hash (`txHash`).

| Event | Payload fields used | Explorer button |
| --- | --- | --- |
| `squad_created` | `squadId`, `name`, `owner`, `txHash` | Yes |
| `squad_joined` | `squadId`, `name`, `member`, `txHash` | Yes |
| `squad_left` | `squadId`, `name`, `member`, `txHash` | Yes |
| `squad_disbanded` | `squadId`, `name`, `txHash` | Yes |
| `squad_promoted` | squadId`, `name`, `member`, `txHash` | Yes |
| `squad_demoted` | squadId`, `name`, `member`, `txHash` | Yes |

### `squad_created`

Payload fields used: `squadId`, `name`, `owner`, `txHash`. Explorer button: yes.

```
Squad created

Name: Orbital Mechanics
Squad ID: 0
Owner: GABC...DEFF
```

### `squad_joined`

Payload fields used: `squadId`, `name`, `member`, `txHash`. Explorer button: yes.

```
Squad joined

Name: Orbital Mechanics
Squad ID: 0
Member: GABC...DEFF
```

### `squad_left`

Payload fields used: `squadId`, `name`, `member`, `txHash`. Explorer button: yes.

```
Squad left

Name: Orbital Mechanics
Squad ID: 0
Member: GABC...DEFF
```

### `squad_disbanded`

Payload fields used: `squadId`, `name`, `txHash`. Explorer button: yes.

```
Squad disbanded

Name: Orbital Mechanics
Squad ID: 0
```

### `squad_promoted`

Payload fields used: squadId`, `name`, `member`, `txHash`. Explorer button: yes.

```
Squad member promoted

Name: Orbital Mechanics
Squad ID: 0
Member: GABC...DEFF
```

### `squad_demoted`

Payload fields used: squadId`, `name`, `member`, `txHash`. Explorer button: yes.

```
Squad member demoted

Name: Orbital Mechanics
Squad ID: 0
Member: GABC...DEFF
```

## Intentionally skipped admin events

The following admin events are deliberately not rendered by `formatEvent` and thus have no sample above:

- Admin configuration changes (e.g. fee or treasury updates) are internal only and are not broadcast to operators.
- Admin role grants/revokations are handled out-of-band and are not surfaced as notifications.
- Admin pause/resume of the entire bot (as opposed to a single market) is operational and logged but not formatted.

If an admin event is ever added to `formatEvent`, add its sample here in the same PR.
