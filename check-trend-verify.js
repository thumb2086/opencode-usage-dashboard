// Verify /api/stats trend against independent hybrid attribution.
// The server slices trend buckets from the shared all-time attribution
// (getAttrAll), so recompute full-range here too — a windowed recompute
// would inflate in-window days and mismatch by design. Time-travel: expected
// range ends at trend.generatedAt. On a live DB, mutating session totals can
// still move residuals by small amounts; verify on a snapshot for exactness.
const { openDb, fetchJson, dayKeyOfLocal, computeHybrid } = require('./check-lib');

const DAYS = parseInt(process.argv[2] || '7', 10);

(async () => {
  const j = await fetchJson(`http://127.0.0.1:4868/api/stats?days=${DAYS}&_=${Date.now()}`);
  const t = j.trend;
  if (!t) { console.log('NO TREND in api response'); process.exit(2); }
  const endMs = t.generatedAt;
  const buckets = [];
  const today = new Date(endMs);
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    buckets.push(d);
  }
  const db = openDb();
  const exp = computeHybrid(db, 0, endMs);
  db.close();

  let fails = 0;
  console.log(`trend.generatedAt age: ${((Date.now() - endMs) / 1000).toFixed(1)}s (time-travel endMs)`);
  console.log('label | exp(sess/in/out/reas/cache/cost) vs api(...)');
  for (let i = 0; i < DAYS; i++) {
    const key = dayKeyOfLocal(buckets[i]);
    const e = exp.perDay[key] || { sessions: new Set(), input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0 };
    const eSess = typeof e.sessions === 'object' ? e.sessions.size : e.sessions;
    const expLabel = `${buckets[i].getMonth() + 1}/${buckets[i].getDate()}`;
    const a = { label: t.labels[i], sessions: t.sessions[i], input: t.input[i], output: t.output[i], reasoning: t.reasoning ? t.reasoning[i] : 0, cacheRead: t.cacheRead[i], cost: t.cost[i] };
    const numEq = (x, y) => Math.abs(x - y) < 0.5;
    const ok = expLabel === a.label && eSess === a.sessions &&
      numEq(e.input, a.input) && numEq(e.output, a.output) && numEq(e.reasoning, a.reasoning) &&
      numEq(e.cacheRead, a.cacheRead) && Math.abs(e.cost - a.cost) < 1e-6;
    if (!ok) fails++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${expLabel} | (${eSess}/${Math.round(e.input)}/${Math.round(e.output)}/${Math.round(e.reasoning)}/${Math.round(e.cacheRead)}/${e.cost}) vs (${a.label}/${a.sessions}/${a.input}/${a.output}/${a.reasoning}/${a.cacheRead}/${a.cost})`);
  }
  const maxCost = Math.max(...t.cost);
  console.log(`maxCost=${maxCost} -> ${maxCost < 0.0001 ? 'ALL-FREE (no pink bar expected)' : 'HAS-COST'}`);
  console.log(fails === 0 ? 'VERIFY PASS' : `VERIFY FAIL (${fails} mismatches)`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR:', e.message); process.exit(2); });
