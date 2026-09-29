// Verify /api/stats overview + models + tools against direct SQL.
// Time-travel where possible via data.generatedAt.
const { openDb, fetchJson, computeHybrid, detectTables } = require('./check-lib');

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

  const sess = db.prepare(`SELECT COUNT(*) c FROM ${T.session}`).get().c;
  chk('overview.sessions', d.overview.sessions, sess);
  const sessEqual = d.overview.sessions === sess;
  // Monotonic totals: our own chat appends tokens between state refresh
  // (15s) and this check, so accept exact or growth-only drift (api<=fresh)
  // when the session set is unchanged.
  const chkGrow = (name, a, e, tol = 0) => {
    const ok = Math.abs(a - e) <= tol || (sessEqual && a <= e);
    if (!ok) fails++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: api=${a} expected=${e}${ok && Math.abs(a - e) > tol ? ' (live-growth, accepted)' : ''}`);
  };
  const msg = db.prepare(`SELECT COUNT(*) c FROM ${T.message} m WHERE m.time_created < ?`).get(endMs).c;
  chk('overview.messages', d.overview.messages, msg);
  const days = db.prepare(`SELECT COUNT(DISTINCT date(time_updated/1000,'unixepoch','localtime')) c FROM ${T.session}`).get().c;
  chk('overview.days(local)', d.overview.days, days);
  const cs = db.prepare(`SELECT COALESCE(SUM(tokens_input),0) i, COALESCE(SUM(tokens_output),0) o, COALESCE(SUM(tokens_reasoning),0) r, COALESCE(SUM(tokens_cache_read),0) cr, COALESCE(SUM(tokens_cache_write),0) cw, COALESCE(SUM(cost),0) c FROM ${T.session}`).get();
  chkGrow('cost.input', d.cost.input, cs.i);
  chkGrow('cost.output', d.cost.output, cs.o);
  chkGrow('cost.reasoning', d.cost.reasoning, cs.r);
  chkGrow('cost.cacheRead', d.cost.cacheRead, cs.cr);
  chk('cost.cacheWrite', d.cost.cacheWrite, cs.cw);
  chkGrow('cost.total', d.cost.total, cs.c, 1e-9);
  chk('cost.avgDay', d.cost.avgDay, cs.c / (days || 1), 1e-9);
  const toks = db.prepare(`SELECT tokens_input+tokens_output+tokens_reasoning t FROM ${T.session}`).all().map((r) => r.t);
  const avg = toks.reduce((s, v) => s + v, 0) / toks.length;
  const sorted = toks.slice().sort((a, b) => a - b);
  const med = sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  chkGrow('avgTokensSession', d.cost.avgTokensSession, Math.round(avg));
  chk('medianTokensSession', d.cost.medianTokensSession, Math.round(med));

  // tools. V1: frozen part table (exact via time-travel). V2: tool parts are
  // embedded in session_message content plus parts of never-migrated messages
  // in `part` (mirrors server's union — everything else would double count).
  // Embedded content keeps mutating inside existing messages while streaming,
  // so accept api <= expected (stale snapshot) but never api > expected
  // (which would expose double counting).
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

  // models: true message counts + hybrid token sums
  const exp = computeHybrid(db, 0, endMs);
  const expModels = Object.entries(exp.perModel).map(([name, m]) => ({ name, n: m.messages }))
    .sort((a, b) => b.n - a.n).slice(0, 5);
  const apiByName = {};
  for (const m of d.models) apiByName[m.name] = m;
  for (const e of expModels) {
    chk(`models[${e.name}].messages`, (apiByName[e.name] || {}).messages, e.n);
  }
  const eTop = Object.entries(exp.perModel).sort((a, b) => b[1].cost - a[1].cost)[0];
  if (eTop) {
    const aTop = apiByName[eTop[0]] || {};
    chkGrow(`models[${eTop[0]}].input`, aTop.input, Math.round(eTop[1].input), 1);
    chk(`models[${eTop[0]}].cost`, aTop.cost, eTop[1].cost, 1e-6);
  }
  // speed: message-level output tok/s for the top-cost model, independent SQL
  // (same merged message view, same completed/output>0 filter as server).
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
