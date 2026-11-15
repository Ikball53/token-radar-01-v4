// Launch Radar dashboard: renders the board from data.js, no network.
// Row layout in data.js: [slug,name,cat,chains,tvl,low,verdict,watchlist,
// mech,s0,s1,s2,change7d,listedAt,gas,opp,time]. The page re-applies the
// same cost basis the program used: high = low x bandF^2, expected =
// low x share, net = expected - gas - opp - time, capital by size tier,
// hours = 6 + 2 x chain count.
(function () {
  var errs = [];
  window.addEventListener('error', function (e) {
    errs.push(String(e.message || e.error));
    var box = document.getElementById('js-errors');
    if (box) { box.hidden = false; box.textContent = 'JS-ERROR: ' + errs.join(' | '); }
  });

  var D = window.RADAR;
  var META = D.meta;
  var ROWS = D.rows;
  var COMPS = D.comps;
  var VERDICTS = ['farm', 'thin', 'skip'];
  var BAND2 = META.bandF * META.bandF;

  function money(x) {
    var neg = x < 0;
    var a = Math.abs(x);
    var s;
    if (a >= 1e9) s = '$' + (a / 1e9).toFixed(2) + 'B';
    else if (a >= 1e6) s = '$' + (a / 1e6).toFixed(1) + 'M';
    else if (a >= 1e3) s = '$' + (a / 1e3).toFixed(1) + 'K';
    else s = '$' + Math.round(a);
    return (neg ? '-' : '') + s;
  }
  function moneyFull(x) {
    var neg = x < 0;
    return (neg ? '-$' : '$') + Math.abs(Math.round(x)).toLocaleString('en-US');
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function chainShort(s) {
    var parts = s.split(',');
    return parts.length > 2 ? parts.slice(0, 2).join(', ') + ' +' + (parts.length - 2) : parts.join(', ');
  }
  function high(r) { return r[5] * BAND2; }
  function expected(r) { return r[5] * META.share; }
  function net(r) { return expected(r) - r[14] - r[15] - r[16]; }
  function capital(r) { return r[4] > 1e9 ? 3000 : r[4] > 2e8 ? 1500 : 600; }
  function hours(r) { return 6 + 2 * Math.min(3, r[3].split(',').length); }
  function chainCount(r) { return Math.min(3, r[3].split(',').length); }

  // ---- method text, straight from the numbers main.ts measured --------
  document.getElementById('method-line').textContent =
    'Fitted log-space size curve on ' + META.fitN + ' liquid traded tokens; ' +
    'holdout error ' + META.holdFactor.toFixed(1) + 'x, time-split error ' +
    META.timeFactor.toFixed(1) + 'x; board ranked on the low end of the value band; ' +
    META.universeN + ' protocols after cleaning, ' + META.watchCovered + ' of ' +
    META.watchN + ' watchlist covered.';

  var statHtml = [
    ['Board rows', META.boardN],
    ['Watchlist covered', META.watchCovered + ' / ' + META.watchN],
    ['Protocols after cleaning', META.universeN],
    ['Fit set (liquid traded)', META.fitN],
    ['Holdout error factor', META.holdFactor.toFixed(2) + 'x'],
    ['Time-split error factor', META.timeFactor.toFixed(2) + 'x'],
    ['Bootstrap slope (90%)', META.bootSlopeLo.toFixed(2) + ' – ' + META.bootSlopeHi.toFixed(2)],
    ['Verdicts farm / thin / skip', META.verdicts.farm + ' / ' + META.verdicts.thin + ' / ' + META.verdicts.skip]
  ].map(function (p) {
    return '<div class="stat"><b>' + p[1] + '</b><span>' + p[0] + '</span></div>';
  }).join('');
  document.getElementById('stats').innerHTML = statHtml;

  document.getElementById('clean-text').textContent =
    'From ' + META.protocolsN + ' protocols, ' + (META.protocolsN - META.universeN) +
    ' records were dropped before any valuation: ' +
    META.excl.map(function (e) { return e[1] + ' ' + e[0]; }).join(', ') +
    ', plus ' + META.subProduct + ' pre-token records that are the same product as a token that already trades. ' +
    'The whole ' + META.watchN + '-protocol watchlist is kept regardless.';

  document.getElementById('fit-text').textContent =
    'log10(market cap) = ' + META.intercept.toFixed(2) + ' + ' + META.slope.toFixed(2) +
    ' x log10(TVL), with a category effect for ' + META.catFx.map(function (c) {
      return c[0] + ' ' + (c[1] >= 0 ? '+' : '') + c[1].toFixed(2);
    }).join(', ') + '. Category effects are shrunk toward the pooled line (ridge penalty ' + META.dummyLam +
    ') so one token cannot swing a category. ' +
    'Fit on ' + META.fitN + ' traded tokens with market cap at least $5M and market-cap/TVL between 0.02 and 5; ' +
    META.microCap + ' micro-caps and ' + META.extremeRatio + ' extreme ratios were set aside as carrying no pricing signal. ' +
    'Each protocol gets a value band, not a point: the band is the fitted value divided and multiplied by the holdout error factor.';

  document.getElementById('test-text').textContent =
    'Five-fold holdout: fit on four fifths of the traded tokens, predict the held-out fifth; ' +
    'median error ' + META.holdFactor.toFixed(2) + 'x (' + Math.round(META.holdWithin2 * 100) +
    '% of predictions within 2x). Time split: fit on ' + META.timeTrainN +
    ' tokens listed before 2025, predict ' + META.timeTestN + ' newer ones; median error ' +
    META.timeFactor.toFixed(2) + 'x. Bootstrap: 200 resampled refits move the slope between ' +
    META.bootSlopeLo.toFixed(2) + ' and ' + META.bootSlopeHi.toFixed(2) +
    '; dropping any single traded token moves no board row by more than ' + META.looMaxMove + ' ranks.';

  document.getElementById('net-text').textContent =
    'Expected value for one farmer is the band\'s low end times ' + META.share +
    ' (one farmer in ' + Math.round(1 / META.share).toLocaleString('en-US') +
    ' — an assumption, stated plainly). Costs use one basis for every row: gas by chain count, ' +
    'capital by size tier at 4% a year for six months, and time at $12 an hour. ' +
    'Net = expected - costs at the low end. Farm when net is at least $' + META.farmMin +
    ', thin when it is at least $' + META.thinMin + ', skip when it is below that.';

  document.getElementById('growth-note').textContent =
    'Seven-day TVL growth and listing age were tested as extra model features and did not improve the holdout error, ' +
    'so they are not in the model; they are shown on each detail view as facts about the protocol, not as adjustments.';

  document.getElementById('foot').textContent =
    'Snapshot ' + META.asOf + ' (DefiLlama protocols at or above $5M TVL). Board ' + META.boardN +
    ' rows: the full watchlist plus the highest-valued cleaned protocols below the floor.';

  // ---- farm steps (same templates the program used for board.json) ----
  function stepsFor(mech, c) {
    var n = c.name, ch = c.chain, cap = money(c.capital), gas = money(c.gas),
      cost = money(c.cost), exp = money(c.expected);
    if (mech === 0) return [
      'Open ' + n + ' on ' + ch + ' and connect the wallet you will farm with; find the points or rewards page first and confirm it tracks deposits before moving any funds.',
      'Supply ' + cap + ' of a blue-chip asset (ETH, USDC or wBTC on ' + ch + ') as collateral; keep the position above a 200% collateral ratio so a price dip cannot liquidate it.',
      'Borrow 30 to 40% of the collateral value in a stablecoin and re-supply it once, looping the position to about 1.3x exposure; each loop costs roughly ' + gas + ' in gas.',
      'Hold the looped position for at least 30 days without withdrawing; points, where they exist, accrue on supplied and borrowed balances, so an exit resets progress.',
      'Repay a small slice of the loan every two weeks and re-borrow it to keep the account active; budget about ' + gas + ' in gas per month for these touches.',
      'Watch the ' + n + ' announcements channel weekly for a snapshot or a points-season end; a season can close with only a few days of notice.',
      'At launch, claim only from the official ' + n + ' app, check the claim contract matches the announced address, then unwind the loop; the whole plan costs about ' + cost + ' for an expected ' + exp + '.'
    ];
    if (mech === 1) return [
      'Add ' + cap + ' as liquidity to a ' + n + ' pool on ' + ch + ' in the pair with the deepest volume; a thin pair earns fees on paper and impermanent loss in practice.',
      'Use a concentrated range around the current price (about plus or minus 20%) rather than full range, and check the position is still in range at least once a week.',
      'Claim and re-stake any LP rewards weekly instead of letting them sit idle; compounding keeps the position earning at the advertised rate.',
      'Rebalance the range only when the price leaves it, not on every move; each rebalance costs about ' + gas + ' in gas and resets nothing else.',
      'Keep the position open for at least 45 days; short LP stints usually earn less in fees than they pay in gas and price drift.',
      'Track the pool\'s volume share weekly; if ' + n + ' volume falls for three straight weeks, move half the position to a busier pool.',
      'At launch, remove liquidity and claim from the official ' + n + ' app only, verifying the contract in the announcement; the whole plan costs about ' + cost + ' for an expected ' + exp + '.'
    ];
    if (mech === 2) return [
      'Deposit ' + cap + ' into the ' + n + ' vault on ' + ch + '; prefer the vault with the longest track record and the clearest fee page over the highest advertised yield.',
      'Hold the deposit for at least 60 days; vault points, where they exist, reward time-weighted balances, so an early exit gives up most of the accrual.',
      'Top up by $100 to $200 once a month to keep the position growing and to log fresh deposits; each top-up costs about ' + gas + ' in gas.',
      'Do not chase the highest-yield vault each week; moving between vaults resets time-weighted balances and pays exit fees each time.',
      'Check the vault\'s underlying positions monthly (they should match what ' + n + ' advertises) and exit if the strategy changes without notice.',
      'Keep an export of every deposit receipt; claims at launch usually check deposit history, not just the final balance.',
      'At launch, claim from the official ' + n + ' app only and verify the contract address in the announcement; the whole plan costs about ' + cost + ' for an expected ' + exp + '.'
    ];
    return [
      'Connect to ' + n + ' on ' + ch + ' and fund the farming wallet with ' + cap + '; keep a separate wallet so a bad approval cannot touch your main funds.',
      'Place a first trade of at least $100 to open an activity history, then spread 8 to 12 trades of $50 to $200 across the next 4 weeks instead of one large trade.',
      'Use a different feature each week, spot, perps or limit orders where offered, since volume across features usually scores better than one repeated action.',
      'Keep at least $50 of open interest or an open order live through each weekly snapshot window; closing everything between snapshots earns nothing.',
      'Pay the taker fees as you go (about ' + gas + ' over the plan in gas and fees) and avoid wash-trading against yourself; the plan assumes real, varied usage, not volume loops.',
      'Join the ' + n + ' points or leaderboard page if one exists and confirm your wallet shows activity; if nothing tracks after two weeks, stop spending.',
      'At launch, claim from the official app only and verify the token contract in the announcement; the whole plan costs about ' + cost + ' for an expected ' + exp + '.'
    ];
  }

  // ---- filters ---------------------------------------------------------
  var cats = {}, chains = {};
  ROWS.forEach(function (r) {
    cats[r[2]] = 1;
    r[3].split(',').forEach(function (c) { chains[c] = 1; });
  });
  var catSel = document.getElementById('cat');
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o);
  });
  var chainSel = document.getElementById('chain');
  Object.keys(chains).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; chainSel.appendChild(o);
  });

  var sortKey = 'rank', sortDir = 1;
  var qEl = document.getElementById('q');
  var verdictSel = document.getElementById('verdict');
  var wlEl = document.getElementById('wlonly');

  function sortVal(r) {
    if (sortKey === 'rank' || sortKey === 'low') return r[5];
    if (sortKey === 'name') return r[1];
    if (sortKey === 'cat') return r[2];
    if (sortKey === 'tvl') return r[4];
    if (sortKey === 'net') return net(r);
    if (sortKey === 'verdict') return r[6];
    return r[5];
  }

  function filtered() {
    var q = qEl.value.trim().toLowerCase();
    var cat = catSel.value, ch = chainSel.value, v = verdictSel.value, wl = wlEl.checked;
    var out = ROWS.filter(function (r) {
      if (q && (r[0] + ' ' + r[1]).toLowerCase().indexOf(q) < 0) return false;
      if (cat && r[2] !== cat) return false;
      if (ch && r[3].split(',').indexOf(ch) < 0) return false;
      if (v !== '' && String(r[6]) !== v) return false;
      if (wl && !r[7]) return false;
      return true;
    });
    out.sort(function (a, b) {
      var x = sortVal(a), y = sortVal(b);
      if (typeof x === 'string') return sortDir * (x < y ? -1 : x > y ? 1 : 0);
      return sortDir * (y - x);
    });
    return out;
  }

  function render() {
    var list = filtered();
    document.getElementById('count').textContent = list.length + ' of ' + ROWS.length + ' rows';
    var html = list.map(function (r) {
      var v = VERDICTS[r[6]];
      var rank = ROWS.indexOf(r) + 1;
      var nv = net(r);
      return '<tr data-slug="' + esc(r[0]) + '">' +
        '<td>' + rank + '</td>' +
        '<td><b>' + esc(r[1]) + '</b>' + (r[7] ? ' <span class="badge">watchlist</span>' : '') + '<br><span class="slug">' + esc(r[0]) + '</span></td>' +
        '<td>' + esc(r[2]) + '</td>' +
        '<td>' + esc(chainShort(r[3])) + '</td>' +
        '<td class="num">' + money(r[4]) + '</td>' +
        '<td class="num"><b>' + money(r[5]) + '</b> &ndash; ' + money(high(r)) + '</td>' +
        '<td class="num ' + (nv >= 0 ? 'pos' : 'neg') + '">' + moneyFull(nv) + '</td>' +
        '<td><span class="pill ' + v + '">' + v + '</span></td></tr>';
    }).join('');
    document.getElementById('rows').innerHTML = html || '<tr><td colspan="8">No rows match these filters.</td></tr>';
  }

  document.querySelectorAll('#board th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
      render();
    });
  });
  [qEl, catSel, chainSel, verdictSel, wlEl].forEach(function (el) {
    el.addEventListener('input', render);
    el.addEventListener('change', render);
  });
  document.getElementById('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) showDetail(tr.getAttribute('data-slug'));
  });
  document.getElementById('close-detail').addEventListener('click', function () {
    document.getElementById('detail').hidden = true;
    if (location.hash.indexOf('#detail/') === 0) history.replaceState(null, '', '#');
  });

  // ---- detail view -----------------------------------------------------
  function showDetail(slug) {
    var r = ROWS.filter(function (x) { return x[0] === slug; })[0];
    if (!r) return;
    var v = VERDICTS[r[6]];
    var nv = net(r), exp = expected(r), hi = high(r), cap = capital(r), hrs = hours(r);
    document.getElementById('d-name').textContent = r[1] + '  —  ' + v.toUpperCase();
    document.getElementById('d-sub').textContent =
      r[2] + ' · ' + chainShort(r[3]) + ' · TVL ' + money(r[4]) + (r[7] ? ' · on the watchlist' : ' · below the watchlist floor') +
      ' · records no token in the snapshot';
    document.getElementById('d-band').textContent = money(r[5]) + ' – ' + money(hi);
    var mid = Math.sqrt(r[5] * hi);
    document.getElementById('d-facts').innerHTML =
      'Fitted mid value ' + money(mid) + '; band is the mid divided and multiplied by the holdout error factor ' +
      META.holdFactor.toFixed(2) + 'x. 7-day TVL change: ' +
      (r[12] === null ? 'not reported' : (r[12] >= 0 ? '+' : '') + r[12].toFixed(1) + '%') +
      '. First tracked: ' + (r[13] || 'not reported') + '.';
    var compHtml = '<tr><th>Traded token</th><th>Category</th><th>TVL</th><th>Market cap</th><th>Value / TVL</th></tr>';
    [r[9], r[10], r[11]].forEach(function (ci) {
      var c = COMPS[ci];
      compHtml += '<tr><td>' + esc(c[0]) + '</td><td>' + esc(c[1]) + '</td><td class="num">' +
        money(c[2]) + '</td><td class="num">' + money(c[3]) + '</td><td class="num">' +
        (c[3] / c[2]).toFixed(2) + '</td></tr>';
    });
    document.getElementById('d-comps').innerHTML = compHtml;
    var cost = r[14] + r[15] + r[16];
    var mathHtml =
      '<tr><th>Expected farmer value</th><td class="num">' + moneyFull(exp) + '</td><td>low end ' + money(r[5]) + ' x ' + META.share + '</td></tr>' +
      '<tr><th>Gas (' + chainCount(r) + ' chains)</th><td class="num">-' + moneyFull(r[14]) + '</td><td>' + money(r[14]) + ' in gas</td></tr>' +
      '<tr><th>Capital opportunity</th><td class="num">-' + moneyFull(r[15]) + '</td><td>' + money(cap) + ' deployed at 4% for 6 months</td></tr>' +
      '<tr><th>Time (' + hrs + 'h at $12/h)</th><td class="num">-' + moneyFull(r[16]) + '</td><td>' + hrs + ' hours of work</td></tr>' +
      '<tr><th>Net farm value</th><td class="num ' + (nv >= 0 ? 'pos' : 'neg') + '"><b>' + moneyFull(nv) + '</b></td><td>verdict: <b>' + v + '</b> (farm at $' + META.farmMin + '+, thin at $' + META.thinMin + '+)</td></tr>';
    document.getElementById('d-math').innerHTML = mathHtml;
    var ctx = {
      name: r[1], chain: r[3].split(',')[0], gas: r[14], capital: cap,
      hours: hrs, expected: exp, cost: cost
    };
    document.getElementById('d-steps').innerHTML =
      stepsFor(r[8], ctx).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    document.getElementById('detail').hidden = false;
    var el = document.getElementById('detail');
    setTimeout(function () {
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY);
    }, 60);
  }

  // ---- hash routing: #detail/<slug> or #filter/verdict=farm ----------
  function applyHash() {
    var h = location.hash || '';
    if (h.indexOf('#detail/') === 0) { showDetail(decodeURIComponent(h.slice(8))); return; }
    if (h.indexOf('#filter/') === 0) {
      h.slice(8).split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (p[0] === 'verdict') verdictSel.value = p[1] === 'farm' ? '0' : p[1] === 'thin' ? '1' : '2';
        if (p[0] === 'watchlist') wlEl.checked = p[1] === '1';
        if (p[0] === 'category') catSel.value = decodeURIComponent(p[1] || '');
      });
      render();
    }
  }
  window.addEventListener('hashchange', applyHash);
  render();
  applyHash();
})();
