# Launch Radar — pre-token protocols priced off the tokens that trade

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Ikball53/token-radar-01-v4/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Ikball53/token-radar-01-v4/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar built for make.fun's `token-radar-01` bounty. It reads the
sealed DefiLlama snapshot (758 protocols, 2026-11-14), cleans the list from the
snapshot's own fields, fits a size curve on the traded tokens, tests the curve
out of sample, and nets every farm plan to a verdict.

## What it does

1. **Cleans the list first.** Bridges, wrapped and staked products, liquid
   staking and restaking wrappers, centralised exchanges, and stablecoin
   issuers are dropped by category and name rules written from the snapshot's
   fields — never by naming individual protocols. Pre-token records that are
   the same product as a token that already trades are dropped too. The whole
   40-protocol watchlist is kept regardless.
2. **Fits a size curve.** `log10(market cap) = a + b × log10(TVL)` with a
   category effect, fitted on 49 liquid traded tokens (market cap ≥ $5M,
   market-cap/TVL between 0.02 and 5). Each protocol gets a value band, not
   a point, and the board ranks on the band's low end.
3. **Tests the curve out of sample.** Five-fold holdout, a time split (fit on
   tokens listed before 2025, predict the newer ones), and a 200-resample
   bootstrap for stability. The results are shown on the dashboard, with the
   error factors, not buried in a file.
4. **Nets every farm plan.** Expected value for one farmer is the band's low
   end times a stated share assumption; gas, capital opportunity cost, and
   time are charged on one basis for every row. Net ≥ $400 is **farm**,
   net ≥ $0 is **thin**, below that is **skip**. Steps are mechanism-aware:
   lending, liquidity, vault, and usage protocols get different plans.
5. **Presents it like a research note.** The board header states the method
   in two lines, the detail view shows the band, the three supporting traded
   records, and the full netting arithmetic.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to snapshot.json>
```

`main.ts` (Node 22, standard library only) writes `board.json` (198 rows, the
full watchlist plus the highest-valued cleaned protocols below the floor),
`dashboard/data.js`, copies `dashboard/` and `screenshots/` into the output
directory, and writes `dossier.json` with `buildDossier` from
`vendor/makefun-board.ts`.

## Files

- `main.ts` — the whole program: cleaning, fit, validation, scoring, farm plans
- `dashboard/` — static page (`index.html`, `app.js`, `app.css`); renders with no network
- `screenshots/` — the three required views: board, detail, filtered
- `vendor/makefun-board.ts` — the kit's dossier library, copied unchanged
- `.makefun/owner.json` — the entry's claim file

## License

MIT — see `LICENSE`.
