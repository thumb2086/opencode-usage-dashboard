// Verify /api/stats overview + models + tools against independent hybrid.
// Overview is ALL TIME and shares the trend/report attribution basis
// (message layer authoritative + session residual), so expected values come
// from computeHybrid's totals, not raw session-table SUM.
// Time-travel where possible via data.generatedAt; live chat can only make the
// DB larger, so growth-only drift is accepted when the shape matches.
const { openDb, fetchJson, computeHybrid, detectTables } = require('./check-lib');
const pricing = require('./pricing');

(async () => {
  const j = await fetchJson(`http://127.0.0.1:4868/api/stats?days=7&_=${Date.now()}`);
  const d = j.data;
  const endMs = j.generatedAt;
  const db = openDb();
  const T = detectTables(db);
  let fails = 0;
  const chk = (name, a, e, tol = 0) => {
    const ok = tol ? Math.abs(a - e) <= tol : a === e;
    if (!ok) fails++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: api=${a} expected=${e}`);
  };
  // Live chat appends tokens between the 15s refresh and this check.
  const chkGrow = (name, a, e, tol = 0) => {
    const ok = Math.abs(a - e) <= tol || (a <= e && Math.abs(a - e) <= Math.max(tol, Math.abs(e) * 0.02));
    if (!ok) fails++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: api=${a} expected=${e}${ok && Math.abs(a - e) > tol ? ' (live-growth, accepted)' : ''}`);
  };

  const exp = computeHybrid(db, 0, endMs);
  const tt = exp.totals;
  chk('overview.sessions', d.overview.sessions, tt.sessions);
  chkGrow('overview.messages', d.overview.messages, tt.messages);
  const activeDays = Object.keys(exp.perDay).filter((k) => exp.perDay[k].date.getFullYear() >= 2020).length || 1;
  chk('overview.days(>=2020 buckets)', d.overview.days, activeDays);
  chkGrow('cost.input', d.cost.input, Math.round(tt.input), 1);
  chkGrow('cost.output', d.cost.output, Math.round(tt.output), 1);
  chkGrow('cost.reasoning', d.cost.reasoning, Math.round(tt.reasoning), 1);
  chkGrow('cost.cacheRead', d.cost.cacheRead, Math.round(tt.cacheRead), 1);
  chk('cost.cacheWrite', d.cost.cacheWrite, Math.round(tt.cacheWrite), 1);
  chkGrow('cost.total', d.cost.total, tt.cost, 1e-9);
  chk('cost.avgDay', d.cost.avgDay, tt.cost / activeDays, 1e-9);
  const sessVals = Object.values(exp.perSession)
    .filter((s) => s.input > 0 || s.output > 0 || s.reasoning > 0)
    .map((s) => s.input + s.output + s.reasoning)
    .filter(Number.isFinite);
  const avg = sessVals.length ? sessVals.reduce((s, v) => s + v, 0) / sessVals.length : 0;
  const sorted = sessVals.slice().sort((a, b) => a - b);
  const med = sorted.length ? (sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[Math.floor(sorted.length / 2) - 1] + sorted[Math.floor(sorted.length / 2)]) / 2) : 0;
  chkGrow('avgTokensSession', d.cost.avgTokensSession, Math.round(avg), 1);
  chk('medianTokensSession', d.cost.medianTokensSession, Math.round(med), 1);

  // savings: priced per MESSAGE model (same perModel buckets as server), so
  // overview and the report providers table share one basis.
  {
    let expMarket = 0, hasNull = false;
    for (const [name, m] of Object.entries(exp.perModel)) {
      const i = name.indexOf('/');
      const provider = i < 0 ? 'unknown' : name.slice(0, i);
      const model = i < 0 ? name : name.slice(i + 1);
      const pr = pricing.priceFor(provider, model);
      if (!pr) { hasNull = true; break; }
      expMarket += pricing.marketOf({ input: m.input, output: m.output, reasoning: m.reasoning, cacheRead: m.cacheRead }, pr) || 0;
    }
    if (!hasNull) {
      expMarket = Math.round(expMarket * 10000) / 10000;
      chkGrow('cost.marketTotal', d.cost.marketTotal, expMarket, Math.max(0.05, expMarket * 0.02));
      chkGrow('cost.savedTotal', d.cost.savedTotal, Math.round((expMarket - tt.cost) * 10000) / 10000, Math.max(0.05, expMarket * 0.02));
    } else {
      console.log('SKIP cost.marketTotal: no pricing catalog');
    }
  }

  // tools. V1: frozen part table (exact via time-travel). V2: tool parts are
  // embedded in session_message content plus parts of never-migrated messages
  // in `part` (mirrors server's union — everything else would double count).
  // Embedded content keeps mutating while streaming, so accept api <= expected
  // (stale snapshot) but never api > expected (which would double count).
  let tools = [];
  if (T.embeddedTools) {
    const emb = db.prepare(`SELECT COALESCE(json_extract(je.value,'$.tool'), json_extract(je.value,'$.name')) t, COUNT(*) c FROM session_message sm, json_each(json_extract(sm.data,'$.content')) je WHERE json_extract(je.value,'$.type')='tool' AND sm.time_created < ? GROUP BY t`).all(endMs);
    const v1p = db.prepare(`SELECT json_extract(data,'$.tool') t, COUNT(*) c FROM part WHERE json_extract(data,'$.type')='tool' AND time_created < ? AND message_id NOT IN (SELECT id FROM session_message) GROUP BY t`).all(endMs);
    const merged = {};
    for (const r of [...emb, ...v1p]) if (r.t) merged[r.t] = (merged[r.t] || 0) + r.c;
    tools = Object.entries(merged).map(([t, c]) => ({ t, c })).sort((a, b) => b.c - a.c);
  } else {
    tools = db.prepare(`SELECT json_extract(data,'$.tool') t, COUNT(*) c FROM part WHERE json_extract(data,'$.type')='tool' AND time_created < ? GROUP BY t ORDER BY c DESC`).all(endMs);
  }
  const toolsExp = tools.filter((r) => r.t);
  const chkLe = (name, a, e) => {
    const ok = a <= e;
    if (!ok) fails++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: api=${a} expected<=${e}`);
  };
  chkLe('tools.length', d.tools.length, toolsExp.length);
  for (let i = 0; i < Math.min(3, toolsExp.length); i++) {
    const e = toolsExp[i];
    chkLe(`tools[${e.t}].count`, (d.tools.find((x) => x.name === e.t) || {}).count || 0, e.c);
  }

  // models: true message counts + hybrid token sums (all-time buckets)
  const expModels = Object.entries(exp.perModel).map(([name, m]) => ({ name, n: m.messages }))
    .sort((a, b) => b.n - a.n).slice(0, 5);
  const apiByName = {};
  for (const m of d.models) apiByName[m.name] = m;
  for (const e of expModels) {
    chkGrow(`models[${e.name}].messages`, (apiByName[e.name] || {}).messages, e.n);
  }
  const eTop = Object.entries(exp.perModel).sort((a, b) => b[1].cost - a[1].cost)[0];
  if (eTop) {
    const aTop = apiByName[eTop[0]] || {};
    chkGrow(`models[${eTop[0]}].input`, aTop.input, Math.round(eTop[1].input), 1);
    chk(`models[${eTop[0]}].cost`, aTop.cost, eTop[1].cost, 1e-6);
  }
  // speed: message-level output tok/s for the top-cost model, independent SQL
  if (eTop) {
    const rows = db.prepare(`SELECT COALESCE(json_extract(data,'$.providerID'),json_extract(data,'$.model.providerID'),'unknown')||'/'||COALESCE(json_extract(data,'$.modelID'),json_extract(data,'$.model.modelID'),json_extract(data,'$.model.id'),'unknown') AS name, COALESCE(SUM(CAST(json_extract(data,'$.tokens.output') AS INTEGER)),0) AS o, COALESCE(SUM(CAST(json_extract(data,'$.time.completed') AS INTEGER)-CAST(json_extract(data,'$.time.created') AS INTEGER)),0) AS ms FROM ${T.message} WHERE CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) GROUP BY name`).all();
    const row = rows.find((x) => x.name === eTop[0]);
    if (row && row.ms > 0) {
      const expSpeed = Math.round((row.o / (row.ms / 1000)) * 10) / 10;
      chk(`models[${eTop[0]}].speed`, (apiByName[eTop[0]] || {}).speed, expSpeed, Math.max(0.1, Math.abs(expSpeed) * 0.05));
    } else {
      console.log(`SKIP models[${eTop[0]}].speed: no usable durations`);
    }
  }
  db.close();
  console.log(fails === 0 ? 'VERIFY PASS' : `VERIFY FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR:', e.message); process.exit(2); });