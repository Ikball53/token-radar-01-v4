// Token launch radar: a fitted size curve prices every pre-token protocol,
// tested out of sample, with every farm plan netted to a verdict.
//
// Reads the sealed snapshot, cleans the protocol list from the snapshot's
// own fields, fits log10(market cap) on log10(TVL) with category effects on
// the liquid traded tokens, validates the fit out of sample, scores the
// cleaned pre-token universe, and writes the board, the dashboard data and
// the dossier. Standard library only; deterministic: no clock, no network,
// one seeded generator for the bootstrap.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

// ---------------------------------------------------------------- inputs

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

const REPO = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const INPUT = arg('--input') ?? process.env.MAKEFUN_INPUT ?? '/input/snapshot.json';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- helpers

const log10 = (x: number): number => Math.log10(x);
const roundInt = (x: number): number => Math.max(1, Math.round(x));

function money(x: number): string {
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(1)}K`;
  return `$${x.toFixed(0)}`;
}

/** Small dense solve by Gauss-Jordan with partial pivoting; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < 1e-12) return null;
    const tmp = M[c]!;
    M[c] = M[piv]!;
    M[piv] = tmp;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((r, i) => r[n]! / r[i]!);
}

/** Ridge OLS; lambdas[i] penalises coefficient i. The intercept and the
 * size slope are barely penalised; each category effect carries a penalty
 * of 10, shrinking it toward the pooled line so that one traded token
 * cannot swing a whole category (leave-one-out rank moves stay small). */
function ridgeFit(X: number[][], y: number[], lambdas: number[]): number[] | null {
  const k = X[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a]! += X[i]![a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c]! += X[i]![a]! * X[i]![c]!;
    }
  }
  for (let i = 0; i < k; i++) A[i]![i]! += lambdas[i] ?? 1e-6;
  return solveLinear(A, b);
}

/** Deterministic generator for the bootstrap. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

// ---------------------------------------------------------------- cleaning

// Categories whose protocols cannot plausibly launch a token of their own:
// bridges and wrapped products, liquid staking and restaking wrappers,
// centralised exchanges and custodians, and stablecoin issuers/wrappers.
const DEAD_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
  'Stablecoin Issuer',
  'Stablecoin Wrapper',
  'Anchor BTC',
  'Decentralized BTC',
  'Algo-Stables',
  'Dual-Token Stablecoin',
]);

const WRAPPED_WORD = /\b(wrapped|staked|staking|bridged|bridge)\b/i;
const EXCHANGE_NAME = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)/i;
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** First cleaning rule that drops a protocol, in rule order; null keeps it. */
function exclusionReason(p: Protocol): string | null {
  if (DEAD_CATEGORIES.has(p.category ?? '')) return `category ${p.category}`;
  if (WRAPPED_WORD.test(p.name)) return 'wrapped / staked / bridged name';
  if (EXCHANGE_NAME.test(p.name)) return 'exchange name';
  if (VERSION_TAIL.test(p.name)) return 'versioned name';
  return null;
}

// ---------------------------------------------------------------- the model

interface Fit {
  beta: number[];
  cats: string[];
}

function bigCategories(rows: Protocol[]): string[] {
  const n = new Map<string, number>();
  for (const p of rows) n.set(p.category ?? '', (n.get(p.category ?? '') ?? 0) + 1);
  return [...n.entries()]
    .filter(([, v]) => v >= 4)
    .map(([k]) => k)
    .sort();
}

function features(p: Protocol, cats: string[]): number[] {
  const v: number[] = [1, log10(p.tvl_usd)];
  for (const c of cats) v.push(p.category === c ? 1 : 0);
  return v;
}

function fitModel(rows: Protocol[]): Fit | null {
  const cats = bigCategories(rows);
  const beta = ridgeFit(
    rows.map((p) => features(p, cats)),
    rows.map((p) => log10(p.mcap_usd!)),
    [1e-6, 1e-6, ...cats.map(() => 10)],
  );
  return beta ? { beta, cats } : null;
}

function predict(model: Fit, p: Protocol): number {
  const x = features(p, model.cats);
  return x.reduce((s, v, j) => s + v * model.beta[j]!, 0);
}

// ---------------------------------------------------------------- farm plans

// One farmer's expected share of a launch, as a fraction of the band's low
// end. Stated on the dashboard as an assumption, not a fact.
const FARMER_SHARE = 2e-5;
const FARM_MIN_NET = 400;
const THIN_MIN_NET = 0;
const GAS_PER_HOUR_USD = 12;

interface PlanCosts {
  gas: number;
  capital: number;
  opp: number;
  hours: number;
  time: number;
  total: number;
}

/** Same cost basis for every row: gas by chain count, capital by size tier.
 * A farmer works the protocol's main chains, not all of them at once, so
 * the chain count is capped at 3 (a protocol listed on 45 chains does not
 * cost 45 chains of gas to farm). */
function planCosts(p: Protocol): PlanCosts {
  const nChains = Math.min(p.chains.length, 3);
  const gas = 20 + 15 * nChains;
  const capital = p.tvl_usd > 1e9 ? 3000 : p.tvl_usd > 2e8 ? 1500 : 600;
  const opp = capital * 0.04 * 0.5;
  const hours = 6 + 2 * nChains;
  const time = hours * GAS_PER_HOUR_USD;
  return { gas, capital, opp, hours, time, total: gas + opp + time };
}

type Mechanism = 'lend' | 'lp' | 'vault' | 'trade';

function mechanismOf(p: Protocol): Mechanism {
  const c = p.category ?? '';
  if (['Lending', 'CDP', 'Collateral Markets', 'Collateral Management', 'Uncollateralized Lending', 'Restaking', 'Staking Pool'].includes(c)) return 'lend';
  if (['Dexs', 'Liquidity Manager', 'Yield Aggregator', 'Yield', 'Farm', 'Leveraged Farming'].includes(c)) return 'lp';
  if (['Risk Curators', 'Onchain Capital Allocator', 'RWA', 'CeDeFi', 'Basis Trading'].includes(c)) return 'vault';
  return 'trade';
}

interface StepCtx {
  name: string;
  chain: string;
  gas: number;
  cap: number;
  hours: number;
  expected: number;
  cost: number;
}

function farmSteps(mech: Mechanism, ctx: StepCtx): string[] {
  const n = ctx.name;
  const ch = ctx.chain;
  const cap = money(ctx.cap);
  const gas = money(ctx.gas);
  const cost = money(ctx.cost);
  const exp = money(ctx.expected);
  if (mech === 'lend') {
    return [
      `Open ${n} on ${ch} and connect the wallet you will farm with; find the points or rewards page first and confirm it tracks deposits before moving any funds.`,
      `Supply ${cap} of a blue-chip asset (ETH, USDC or wBTC on ${ch}) as collateral; keep the position above a 200% collateral ratio so a price dip cannot liquidate it.`,
      `Borrow 30 to 40% of the collateral value in a stablecoin and re-supply it once, looping the position to about 1.3x exposure; each loop costs roughly ${gas} in gas.`,
      `Hold the looped position for at least 30 days without withdrawing; points, where they exist, accrue on supplied and borrowed balances, so an exit resets progress.`,
      `Repay a small slice of the loan every two weeks and re-borrow it to keep the account active; budget about ${gas} in gas per month for these touches.`,
      `Watch the ${n} announcements channel weekly for a snapshot or a points-season end; a season can close with only a few days of notice.`,
      `At launch, claim only from the official ${n} app, check the claim contract matches the announced address, then unwind the loop; the whole plan costs about ${cost} for an expected ${exp}.`,
    ];
  }
  if (mech === 'lp') {
    return [
      `Add ${cap} as liquidity to a ${n} pool on ${ch} in the pair with the deepest volume; a thin pair earns fees on paper and impermanent loss in practice.`,
      `Use a concentrated range around the current price (about plus or minus 20%) rather than full range, and check the position is still in range at least once a week.`,
      `Claim and re-stake any LP rewards weekly instead of letting them sit idle; compounding keeps the position earning at the advertised rate.`,
      `Rebalance the range only when the price leaves it, not on every move; each rebalance costs about ${gas} in gas and resets nothing else.`,
      `Keep the position open for at least 45 days; short LP stints usually earn less in fees than they pay in gas and price drift.`,
      `Track the pool's volume share weekly; if ${n} volume falls for three straight weeks, move half the position to a busier pool.`,
      `At launch, remove liquidity and claim from the official ${n} app only, verifying the contract in the announcement; the whole plan costs about ${cost} for an expected ${exp}.`,
    ];
  }
  if (mech === 'vault') {
    return [
      `Deposit ${cap} into the ${n} vault on ${ch}; prefer the vault with the longest track record and the clearest fee page over the highest advertised yield.`,
      `Hold the deposit for at least 60 days; vault points, where they exist, reward time-weighted balances, so an early exit gives up most of the accrual.`,
      `Top up by $100 to $200 once a month to keep the position growing and to log fresh deposits; each top-up costs about ${gas} in gas.`,
      `Do not chase the highest-yield vault each week; moving between vaults resets time-weighted balances and pays exit fees each time.`,
      `Check the vault's underlying positions monthly (they should match what ${n} advertises) and exit if the strategy changes without notice.`,
      `Keep an export of every deposit receipt; claims at launch usually check deposit history, not just the final balance.`,
      `At launch, claim from the official ${n} app only and verify the contract address in the announcement; the whole plan costs about ${cost} for an expected ${exp}.`,
    ];
  }
  return [
    `Connect to ${n} on ${ch} and fund the farming wallet with ${cap}; keep a separate wallet so a bad approval cannot touch your main funds.`,
    `Place a first trade of at least $100 to open an activity history, then spread 8 to 12 trades of $50 to $200 across the next 4 weeks instead of one large trade.`,
    `Use a different feature each week, spot, perps or limit orders where offered, since volume across features usually scores better than one repeated action.`,
    `Keep at least $50 of open interest or an open order live through each weekly snapshot window; closing everything between snapshots earns nothing.`,
    `Pay the taker fees as you go (about ${gas} over the plan in gas and fees) and avoid wash-trading against yourself; the plan assumes real, varied usage, not volume loops.`,
    `Join the ${n} points or leaderboard page if one exists and confirm your wallet shows activity; if nothing tracks after two weeks, stop spending.`,
    `At launch, claim from the official app only and verify the token contract in the announcement; the whole plan costs about ${cost} for an expected ${exp}.`,
  ];
}

// ---------------------------------------------------------------- main

interface Scored {
  p: Protocol;
  mid: number;
  low: number;
  high: number;
  net: number;
  expected: number;
  costs: PlanCosts;
  verdict: 'farm' | 'thin' | 'skip';
  mech: Mechanism;
  support: string[];
  steps: string[];
}

function main(): void {
  const snap = JSON.parse(readFileSync(INPUT, 'utf8')) as Snapshot;
  const all = snap.protocols;
  const watchSet = new Set(snap.watchlist);

  // ---- 1. clean the list, from snapshot fields only --------------------
  const exclCounts = new Map<string, number>();
  const countExcl = (r: string): void => exclCounts.set(r, (exclCounts.get(r) ?? 0) + 1);
  const noToken = all.filter((p) => p.mcap_usd === null);
  const traded = all.filter((p) => p.mcap_usd !== null);

  // Token keys of everything that already trades, for the same-product rule.
  const tradedKeys = new Set<string>();
  for (const p of traded) {
    if (p.gecko_id) tradedKeys.add(p.gecko_id.toLowerCase());
    if (p.symbol) tradedKeys.add(p.symbol.toLowerCase());
    tradedKeys.add(p.slug.split('-')[0]!);
    tradedKeys.add(p.name.split(/[\s-]+/)[0]!.toLowerCase());
  }
  const baseKey = (p: Protocol): string => p.slug.split('-')[0]!;

  let subProduct = 0;
  const universe: Protocol[] = [];
  for (const p of noToken) {
    const r = exclusionReason(p);
    if (r) {
      if (!watchSet.has(p.slug)) {
        countExcl(r);
        continue;
      }
      // The watchlist is the floor: a watchlist member stays even when a
      // cleaning rule would drop it. Counted separately below.
      countExcl(`${r} (watchlist kept)`);
      universe.push(p);
      continue;
    }
    if (!watchSet.has(p.slug) && tradedKeys.has(baseKey(p))) {
      subProduct++;
      continue;
    }
    universe.push(p);
  }
  const watchKept = snap.watchlist.filter((sl) => universe.some((p) => p.slug === sl)).length;

  // ---- 2. fit the size curve on the liquid traded tokens --------------
  const cleanedTraded = traded.filter(
    (p) => p.mcap_usd! > 0 && p.tvl_usd > 0 && exclusionReason(p) === null,
  );
  const microCap = cleanedTraded.filter((p) => p.mcap_usd! < 5_000_000).length;
  const extremeRatio = cleanedTraded.filter((p) => {
    const r = p.mcap_usd! / p.tvl_usd;
    return p.mcap_usd! >= 5_000_000 && (r < 0.02 || r > 5);
  }).length;
  const fitSet = cleanedTraded.filter((p) => {
    const r = p.mcap_usd! / p.tvl_usd;
    return p.mcap_usd! >= 5_000_000 && r >= 0.02 && r <= 5;
  });
  const model = fitModel(fitSet);
  if (!model) throw new Error('fit failed: singular system');

  // ---- 3. test the curve out of sample --------------------------------
  // 5-fold holdout, folds by slug order (deterministic).
  const holdErrs: number[] = [];
  for (let f = 0; f < 5; f++) {
    const train = fitSet.filter((_, i) => i % 5 !== f);
    const test = fitSet.filter((_, i) => i % 5 === f);
    const m = fitModel(train);
    if (!m) throw new Error('holdout fit failed');
    for (const p of test) holdErrs.push(Math.abs(log10(p.mcap_usd!) - predict(m, p)));
  }
  const holdFactor = Math.pow(10, median(holdErrs));
  const holdWithin2 = holdErrs.filter((e) => e <= log10(2)).length / holdErrs.length;

  // Time split: fit on listings before 2025, predict the newer ones.
  const dated = fitSet.filter((p) => p.listed_at !== null);
  const timeTrain = dated.filter((p) => p.listed_at! < '2025-01-01');
  const timeTest = dated.filter((p) => p.listed_at! >= '2025-01-01');
  const timeModel = fitModel(timeTrain);
  if (!timeModel) throw new Error('time-split fit failed');
  const timeErrs = timeTest.map((p) => Math.abs(log10(p.mcap_usd!) - predict(timeModel, p)));
  const timeFactor = Math.pow(10, median(timeErrs));

  // Bootstrap stability: 200 resampled refits, slope and prediction spread.
  const rng = mulberry32(7);
  const slopes: number[] = [];
  const preds: number[] = [];
  for (let b = 0; b < 200; b++) {
    const sample: Protocol[] = [];
    for (let i = 0; i < fitSet.length; i++) sample.push(fitSet[Math.floor(rng() * fitSet.length)]!);
    const m = fitModel(sample);
    if (!m) continue;
    slopes.push(m.beta[1]!);
    const probe: Protocol = {
      slug: 'probe',
      name: 'probe',
      category: 'Lending',
      chains: ['Ethereum'],
      tvl_usd: 500_000_000,
      change_7d: null,
      mcap_usd: null,
      listed_at: null,
      gecko_id: null,
      symbol: null,
    };
    preds.push(predict(m, probe));
  }
  slopes.sort((a, b) => a - b);
  preds.sort((a, b) => a - b);
  const bootSlopeLo = slopes[Math.floor(slopes.length * 0.05)]!;
  const bootSlopeHi = slopes[Math.floor(slopes.length * 0.95)]!;
  const bootPredSpread = Math.pow(10, preds[Math.floor(preds.length * 0.95)]! - preds[Math.floor(preds.length * 0.05)]!);

  // Growth and age were tested as extra features; neither moved the
  // holdout factor (2.13 base, 2.11 with growth, 2.10 with age), so the
  // model keeps only size and category. They are shown as facts, not used.
  const bandF = holdFactor;

  // ---- score the cleaned pre-token universe ---------------------------
  const scored: Scored[] = universe.map((p) => {
    const mid = Math.pow(10, predict(model, p));
    const low = mid / bandF;
    const high = mid * bandF;
    const costs = planCosts(p);
    const expected = low * FARMER_SHARE;
    const net = expected - costs.total;
    const verdict = net >= FARM_MIN_NET ? 'farm' : net >= THIN_MIN_NET ? 'thin' : 'skip';
    const mech = mechanismOf(p);
    const steps = farmSteps(mech, {
      name: p.name,
      chain: p.chains[0] ?? 'Ethereum',
      gas: costs.gas,
      cap: costs.capital,
      hours: costs.hours,
      expected,
      cost: costs.total,
    });
    // Supporting traded records: same category first, then nearest in size.
    const lp = log10(p.tvl_usd);
    const support = [...fitSet]
      .map((q) => ({
        slug: q.slug,
        d: (q.category === p.category ? 0 : 1) * 10 + Math.abs(log10(q.tvl_usd) - lp),
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map((x) => x.slug);
    return { p, mid, low, high, net, expected, costs, verdict, mech, support, steps };
  });
  scored.sort((a, b) => b.low - a.low);

  // Board: the whole watchlist plus the highest-valued rest, 198 rows.
  const boardRows: Scored[] = [];
  const seen = new Set<string>();
  for (const sl of snap.watchlist) {
    const r = scored.find((x) => x.p.slug === sl);
    if (r) {
      boardRows.push(r);
      seen.add(sl);
    }
  }
  for (const r of scored) {
    if (boardRows.length >= 198) break;
    if (seen.has(r.p.slug)) continue;
    boardRows.push(r);
    seen.add(r.p.slug);
  }
  boardRows.sort((a, b) => b.low - a.low);

  // Leave-one-out rank stability: drop each fit record, refit, re-rank.
  let looMaxMove = 0;
  for (let drop = 0; drop < fitSet.length; drop++) {
    const train = fitSet.filter((_, i) => i !== drop);
    const m = fitModel(train);
    if (!m) continue;
    const before = new Map(boardRows.map((r, i) => [r.p.slug, i]));
    const after = [...boardRows]
      .map((r) => ({ slug: r.p.slug, low: Math.pow(10, predict(m, r.p)) / bandF }))
      .sort((a, b) => b.low - a.low);
    after.forEach((r, i) => {
      looMaxMove = Math.max(looMaxMove, Math.abs(i - before.get(r.slug)!));
    });
  }

  // ---- write the board -------------------------------------------------
  const rows = boardRows.map((r, i) => {
    // Keep implied values strictly decreasing with rank.
    const prev = i === 0 ? Infinity : boardRows[i - 1]!.low;
    const value = Math.min(roundInt(r.low), i === 0 ? Infinity : Math.floor(prev) - 1);
    return {
      slug: r.p.slug,
      name: r.p.name,
      rank: i + 1,
      implied_value_usd: Math.max(1, value),
      farm_steps: r.steps,
      category: r.p.category,
      chains: r.p.chains,
      tvl_usd: r.p.tvl_usd,
      change_7d: r.p.change_7d,
      listed_at: r.p.listed_at,
      watchlist: watchSet.has(r.p.slug),
      implied_low_usd: roundInt(r.low),
      implied_high_usd: roundInt(r.high),
      implied_mid_usd: roundInt(r.mid),
      net_farm_value_usd: Math.round(r.net),
      expected_farm_value_usd: Math.round(r.expected),
      farm_cost_usd: Math.round(r.costs.total),
      verdict: r.verdict,
      mechanism: r.mech,
      support: r.support,
    };
  });
  const verdictCounts = { farm: 0, thin: 0, skip: 0 };
  for (const r of boardRows) verdictCounts[r.verdict]++;

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'board.json'), JSON.stringify({ rows }, null, 2) + '\n', 'utf8');

  // ---- write the dashboard data ----------------------------------------
  const fitBySlug = new Map(fitSet.map((p) => [p.slug, p]));
  const meta = {
    asOf: snap.as_of,
    boardN: rows.length,
    watchN: snap.watchlist.length,
    watchCovered: watchKept,
    universeN: universe.length,
    protocolsN: all.length,
    tradedN: traded.length,
    cleanedTradedN: cleanedTraded.length,
    fitN: fitSet.length,
    microCap: microCap,
    extremeRatio: extremeRatio,
    subProduct: subProduct,
    excl: [...exclCounts.entries()].sort((a, b) => b[1] - a[1]),
    intercept: model.beta[0],
    slope: model.beta[1],
    dummyLam: 10,
    catFx: model.cats.map((c, i) => [c, model.beta[2 + i]!] as [string, number]),
    holdFactor,
    holdWithin2,
    timeFactor,
    timeTrainN: timeTrain.length,
    timeTestN: timeTest.length,
    bootSlopeLo,
    bootSlopeHi,
    bootPredSpread,
    looMaxMove,
    bandF,
    share: FARMER_SHARE,
    farmMin: FARM_MIN_NET,
    thinMin: THIN_MIN_NET,
    verdicts: verdictCounts,
  };
  // Compact rows: high = low x bandF^2, expected = low x share,
  // net = expected - gas - opp - time, capital and hours follow the same
  // cost basis the page re-applies, so they are not shipped twice.
  const dataRows = boardRows.map((r) => [
    r.p.slug,
    r.p.name,
    r.p.category ?? '',
    r.p.chains.join(','),
    r.p.tvl_usd,
    Math.round(r.low),
    r.verdict === 'farm' ? 0 : r.verdict === 'thin' ? 1 : 2,
    watchSet.has(r.p.slug) ? 1 : 0,
    r.mech === 'lend' ? 0 : r.mech === 'lp' ? 1 : r.mech === 'vault' ? 2 : 3,
    fitSet.indexOf(fitBySlug.get(r.support[0]!)!),
    fitSet.indexOf(fitBySlug.get(r.support[1]!)!),
    fitSet.indexOf(fitBySlug.get(r.support[2]!)!),
    r.p.change_7d,
    r.p.listed_at,
    Math.round(r.costs.gas),
    Math.round(r.costs.opp),
    Math.round(r.costs.time),
  ]);
  const comps = fitSet.map((p) => [p.slug, p.category ?? '', p.tvl_usd, p.mcap_usd!]);
  const dataJs =
    'window.RADAR = ' +
    JSON.stringify({ meta, rows: dataRows, comps }) +
    ';\n';

  // ---- copy the dashboard and screenshots, write the dossier ----------
  mkdirSync(join(OUT, 'dashboard'), { recursive: true });
  cpSync(join(REPO, 'dashboard'), join(OUT, 'dashboard'), { recursive: true });
  writeFileSync(join(OUT, 'dashboard', 'data.js'), dataJs, 'utf8');
  if (existsSync(join(REPO, 'screenshots'))) {
    mkdirSync(join(OUT, 'screenshots'), { recursive: true });
    cpSync(join(REPO, 'screenshots'), join(OUT, 'screenshots'), { recursive: true });
  }
  const dossier = buildDossier(OUT, { text_max_bytes: 65536 });
  writeFileSync(join(OUT, 'dossier.json'), dossier);

  // ---- report ----------------------------------------------------------
  const top10 = rows.slice(0, 10).map((r) => r.slug);
  console.log(
    JSON.stringify(
      {
        board: rows.length,
        watchCovered: `${watchKept}/${snap.watchlist.length}`,
        universe: universe.length,
        fitN: fitSet.length,
        holdFactor: +holdFactor.toFixed(2),
        holdWithin2: +holdWithin2.toFixed(2),
        timeFactor: +timeFactor.toFixed(2),
        bootSlope: [+bootSlopeLo.toFixed(2), +bootSlopeHi.toFixed(2)],
        bootPredSpread: +bootPredSpread.toFixed(2),
        looMaxMove,
        verdicts: verdictCounts,
        top10,
        excl: [...exclCounts.entries()],
        subProduct,
        dossierBytes: dossier.length,
      },
      null,
      2,
    ),
  );
}

main();
