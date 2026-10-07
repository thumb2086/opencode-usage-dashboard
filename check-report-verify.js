// Verify /api/report for Daily/Weekly/Monthly/All against independent hybrid.
// Time-travel: expected range ends at report.generatedAt.
// Mirrors buildReportFromDb's structure without reusing its code:
//   - attribution is full-span; perDay buckets are summed for the summary;
//   - providers/agents/sessions come from PERIOD buckets, so their columns must
//     sum exactly to the summary card (checked explicitly below);
//   - providers group message tokens by the MESSAGE's model and session
//     residual by the SESSION's model; agents use the same split.
const { openDb, fetchJson, computeHybrid, detectTables } = require('./check-lib');
const pricing = require('./pricing');

const PERIODS = [-1, 1, 7, 30];

function periodStart(days, refMs) {
  if (days === -1) return 0;
  const d = new Date(refMs);
  d.setHours(0, 0, 0, 0);
  if (days <= 1) return d.getTime();
  if (days <= 7) { d.setDate(d.getDate() - 6); return d.getTime(); }
  d.setDate(1);
  return d.getTime();
}

const keyToMs = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const r4m = (v) => Math.round((v || 0) * 10000) / 10000;
const splitName = (name) => {
  const i = String(name).indexOf('/');
  return i < 0 ? { provider: 'unknown', model: String(name) } : { provider: String(name).slice(0, i), model: String(name).slice(i + 1) };
};

(async () => {
  const db = openDb();
  const T = detectTables(db);
  let fails = 0;
  for (const days of PERIODS) {
    const j = await fetchJson(`http://127.0.0.1:4868/api/report?days=${days}&_=${Date.now()}`);
    if (!j.ready || !j.report) { console.log(`FAIL report days=${days}: not ready`); fails++; continue; }
    const r = j.report;
    const endMs = r.generatedAt;
    const startMs = periodStart(days, endMs);
    // One full-range scan sliced to the period (periodStartMs = 0 for All, so
    // the period buckets equal the all-time buckets there).
    const exp = computeHybrid(db, 0, endMs, startMs);
    const tag = `report[${days}]`;
    const chk = (name, a, e, tol = 0) => {
      const ok = tol ? Math.abs(a - e) <= tol : a === e;
      if (!ok) fails++;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${tag} ${name}: api=${a} expected=${e}`);
    };

    // Summary: perDay buckets inside the period.
    const pdVals = Object.entries(exp.perDay)
      .filter(([key]) => days === -1 || keyToMs(key) >= startMs)
      .map(([, v]) => v);
    const t = { sessions: new Set(), messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const pd of pdVals) {
      for (const sid of pd.sessions) t.sessions.add(sid);
      t.messages += pd.messages;
      t.input += pd.input; t.output += pd.output; t.reasoning += pd.reasoning;
      t.cacheRead += pd.cacheRead; t.cacheWrite += pd.cacheWrite; t.cost += pd.cost;
    }
    const activeDays = pdVals.length || 1;
    const periodSessionIds = [...t.sessions];

    const s = r.stats;
    chk('sessions', s.overview.sessions, t.sessions.size);
    chk('messages', s.overview.messages, t.messages);
    chk('days', s.overview.days, activeDays);
    chk('input', s.cost.input, Math.round(t.input), 1);
    chk('output', s.cost.output, Math.round(t.output), 1);
    chk('reasoning', s.cost.reasoning, Math.round(t.reasoning), 1);
    chk('cacheRead', s.cost.cacheRead, Math.round(t.cacheRead), 1);
    chk('cacheWrite', s.cost.cacheWrite, Math.round(t.cacheWrite), 1);
    chk('total', s.cost.total, t.cost, 1e-4);

    // Avg/median over the period's token-bearing sessions (period buckets).
    const sessVals = periodSessionIds
      .map((sid) => exp.perSessionPeriod[sid])
      .filter((x) => x && (x.input > 0 || x.output > 0 || x.reasoning > 0))
      .map((x) => x.input + x.output + x.reasoning);
    const avg = sessVals.length ? sessVals.reduce((a2, v) => a2 + v, 0) / sessVals.length : 0;
    chk('avgTokensSession', s.cost.avgTokensSession, Math.round(avg), 1);
    const sv = sessVals.slice().sort((a2, b) => a2 - b);
    const med = sv.length ? (sv.length % 2 ? sv[Math.floor(sv.length / 2)] : (sv[sv.length / 2 - 1] + sv[sv.length / 2]) / 2) : 0;
    chk('medianTokensSession', s.cost.medianTokensSession, Math.round(med), 1);

    // Message-level speed/active per session AND per (session, agent) inside the
    // period (server query basis; the message layer knows agents the session
    // table lacks, e.g. compaction/plan).
    const agentMs = {};
    for (const b of db.prepare(`SELECT session_id AS sid, COALESCE(json_extract(data,'$.agent'),'unknown') AS agent,
      COALESCE(SUM(CASE WHEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) THEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) ELSE 0 END),0) AS o,
      COALESCE(SUM(CASE WHEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) THEN CAST(json_extract(data,'$.time.completed') AS INTEGER) - CAST(json_extract(data,'$.time.created') AS INTEGER) ELSE 0 END),0) AS ms
      FROM ${T.message} WHERE time_created >= ${startMs} AND time_created < ? GROUP BY session_id, COALESCE(json_extract(data,'$.agent'),'unknown')`).all(endMs)) {
      agentMs[`${b.sid}|${b.agent}`] = b;
    }
    // Per-session wall span on the message clock, same basis as server.
    const wallBySid = {};
    for (const b of db.prepare(`SELECT session_id AS sid, MIN(time_created) AS t0,
      MAX(COALESCE(CAST(json_extract(data,'$.time.completed') AS INTEGER), time_updated)) AS t1
      FROM ${T.message} WHERE time_created >= ${startMs} AND time_created < ? GROUP BY session_id`).all(endMs)) {
      wallBySid[b.sid] = Math.max(0, (+b.t1 || 0) - (+b.t0 || 0));
    }
    const msgMap = {};
    for (const m of db.prepare(`SELECT session_id AS sid, COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) THEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) ELSE 0 END),0) AS o,
      COALESCE(SUM(CASE WHEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) THEN CAST(json_extract(data,'$.tokens.reasoning') AS INTEGER) ELSE 0 END),0) AS rq,
      COALESCE(SUM(CASE WHEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) THEN CAST(json_extract(data,'$.time.completed') AS INTEGER) - CAST(json_extract(data,'$.time.created') AS INTEGER) ELSE 0 END),0) AS ms
      FROM ${T.message} WHERE time_created >= ${startMs} AND time_created < ? GROUP BY sid`).all(endMs)) {
      msgMap[m.sid] = m;
    }

    // Providers: period buckets, priced per model.
    const expProviders = Object.entries(exp.perModelPeriod).map(([name, m]) => {
      const { provider, model } = splitName(name);
      const pr = pricing.priceFor(provider, model);
      const mk = pr ? pricing.marketOf({ input: m.input, output: m.output, reasoning: m.reasoning, cacheRead: m.cacheRead }, pr) : null;
      return {
        key: name, provider, model,
        sessions: m.sessions.size,
        cost: r4m(m.cost),
        tok_in: Math.round(m.input),
        market: mk === null ? null : r4m(mk),
        saved: mk === null ? null : r4m(mk - m.cost),
        pricedAs: pr ? pr.source : null,
      };
    });
    const byProv = {};
    for (const p of r.providers) byProv[`${p.provider}/${p.model}`] = p;
    for (const e of expProviders) {
      const p = byProv[e.key];
      if (!p) { console.log(`FAIL ${tag} providers missing ${e.key}`); fails++; continue; }
      chk(`prov[${e.key}].sessions`, p.sessions, e.sessions);
      chk(`prov[${e.key}].in`, p.tok_in, e.tok_in, 1);
      chk(`prov[${e.key}].cost`, p.cost, e.cost, 6e-5);
      chk(`prov[${e.key}].market`, p.market, e.market, Math.max(0.05, Math.abs(e.market || 0) * 0.03));
      chk(`prov[${e.key}].saved`, p.saved, e.saved, Math.max(0.05, Math.abs(e.saved || 0) * 0.03));
      chk(`prov[${e.key}].pricedAs`, p.pricedAs, e.pricedAs);
    }
    if (r.providers.length !== expProviders.length) {
      console.log(`FAIL ${tag} providers.length: api=${r.providers.length} expected=${expProviders.length}`); fails++;
    } else console.log(`OK   ${tag} providers.length: ${r.providers.length}`);

    // Cross-panel: provider rows must sum to the summary card (the invariant
    // that was violated when report tables used session-lifetime totals).
    {
      const sumIn = r.providers.reduce((a, x) => a + (x.tok_in || 0), 0);
      const sumCost = r.providers.reduce((a, x) => a + (x.cost || 0), 0);
      chk('Σproviders.in == card.input', sumIn, s.cost.input, Math.max(1, s.cost.input * 0.0002));
      chk('Σproviders.cost == card.cost', sumCost, s.cost.total, Math.max(1e-4, s.cost.total * 0.0002));
    }

    // Agents: period buckets; market priced from the per-(agent,model) bag.
    const metaMap = {};
    if (periodSessionIds.length) {
      const ph = periodSessionIds.map(() => '?').join(',');
      for (const m of db.prepare(`SELECT id, agent, COALESCE(json_extract(model,'$.providerID'),'unknown') AS provider, COALESCE(json_extract(model,'$.id'),'unknown') AS model, title, time_created AS tc, time_updated AS tu FROM ${T.session} WHERE id IN (${ph})`).all(...periodSessionIds)) metaMap[m.id] = m;
    }
    const expAgents = Object.entries(exp.perAgentPeriod).map(([agent, m]) => {
      let market = 0, saved = 0;
      const bag = exp.perAgentModelPeriod[agent] || {};
      for (const [name, b] of Object.entries(bag)) {
        const { provider, model } = splitName(name);
        const pr = pricing.priceFor(provider, model);
        const mk = pr ? pricing.marketOf({ input: b.input, output: b.output, reasoning: b.reasoning, cacheRead: b.cacheRead }, pr) : null;
        if (mk === null) { market = null; break; }
        market += mk;
        saved += mk - b.cost;
      }
      // Wall from the message clock (subagent sessions write time_updated ==
    // time_created, so session-table spans would read as ~0).
    let wallMs = 0;
    for (const sid of m.sessions) wallMs += wallBySid[sid] || 0;
      // Speed/activeMs: per-(session,agent) message aggregates (same query basis as
      // server, including agents only the message layer knows: compaction/plan).
      let agO = 0, agMs = 0;
      for (const [key, b] of Object.entries(agentMs)) {
        if (b.agent !== agent) continue;
        agO += b.o; agMs += b.ms;
      }
      return {
        agent, sessions: m.sessions.size, tok_in: Math.round(m.input),
        speed: agMs > 0 ? Math.round((agO / (agMs / 1000)) * 10) / 10 : null,
        wallMs: Math.round(wallMs), activeMs: Math.round(agMs),
        market: market === null ? null : r4m(market), saved: market === null ? null : r4m(saved),
      };
    });
    const byAgent = {};
    for (const x of r.agents) byAgent[x.agent] = x;
    for (const e of expAgents) {
      const x = byAgent[e.agent];
      if (!x) { console.log(`FAIL ${tag} agents missing ${e.agent}`); fails++; continue; }
      chk(`agent[${e.agent}].sessions`, x.sessions, e.sessions);
      chk(`agent[${e.agent}].in`, x.tok_in, e.tok_in, 1);
      chk(`agent[${e.agent}].speed`, x.speed, e.speed, Math.max(0.1, Math.abs(e.speed || 0) * 0.05));
      chk(`agent[${e.agent}].wallMs`, x.wallMs, e.wallMs, Math.max(120000, e.wallMs * 0.05));
      chk(`agent[${e.agent}].activeMs`, x.activeMs, e.activeMs, Math.max(120000, e.activeMs * 0.05));
      chk(`agent[${e.agent}].market`, x.market, e.market, Math.max(0.05, Math.abs(e.market || 0) * 0.03));
      chk(`agent[${e.agent}].saved`, x.saved, e.saved, Math.max(0.05, Math.abs(e.saved || 0) * 0.03));
    }
    if (r.agents.length !== expAgents.length) {
      console.log(`FAIL ${tag} agents.length: api=${r.agents.length} expected=${expAgents.length}`); fails++;
    } else console.log(`OK   ${tag} agents.length: ${r.agents.length}`);

    // Sessions: top 20 by period activeMs; priced by the session's dominant
    // period model when available (message model mix).
    const expSessions = periodSessionIds.map((sid) => {
      const m = metaMap[sid] || { provider: 'unknown', model: 'unknown' };
      const ps = exp.perSessionPeriod[sid] || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0 };
      const mg = msgMap[sid] || { n: 0, o: 0, ms: 0, rq: 0 };
      const bag = exp.perSessionModelPeriod[sid] || null;
      let prov = m.provider || 'unknown', mod = m.model || 'unknown';
      if (bag && Object.keys(bag).length) {
        const top = Object.keys(bag).sort((a, b) => {
          const va = bag[a].input + bag[a].output + bag[a].cacheRead;
          const vb = bag[b].input + bag[b].output + bag[b].cacheRead;
          return vb - va;
        })[0];
        const sp = splitName(top);
        prov = sp.provider; mod = sp.model;
      }
      const pr = pricing.priceFor(prov, mod);
      const mk = pr ? pricing.marketOf({ input: ps.input, output: ps.output, reasoning: mg.rq || 0, cacheRead: ps.cacheRead }, pr) : null;
      return {
        id: sid,
        wallMs: wallBySid[sid] || 0,
        activeMs: mg.ms || 0, messages: mg.n || 0,
        speed: (mg.ms || 0) > 0 ? Math.round(((mg.o || 0) / (mg.ms / 1000)) * 10) / 10 : null,
        market: mk === null ? null : r4m(mk),
        saved: mk === null ? null : r4m(mk - ps.cost),
      };
    })
      .sort((x, y) => y.activeMs - x.activeMs)
      .slice(0, 20);
    const apiSessions = r.sessions || [];
    if (apiSessions.length !== expSessions.length) {
      console.log(`FAIL ${tag} sessions.length: api=${apiSessions.length} expected=${expSessions.length}`); fails++;
    } else console.log(`OK   ${tag} sessions.length: ${apiSessions.length}`);
    for (let i = 1; i < apiSessions.length; i++) {
      if (apiSessions[i - 1].activeMs < apiSessions[i].activeMs) {
        console.log(`FAIL ${tag} sessions not sorted desc at ${i}`); fails++; break;
      }
    }
    for (let i = 0; i < Math.min(3, expSessions.length); i++) {
      const e = expSessions[i], a2 = apiSessions[i] || {};
      if (a2.id !== e.id) { console.log(`FAIL ${tag} sessions[${i}].id: api=${a2.id} expected=${e.id}`); fails++; continue; }
      chk(`sessions[${i}].wallMs`, a2.wallMs, e.wallMs, Math.max(120000, e.wallMs * 0.05));
      chk(`sessions[${i}].activeMs`, a2.activeMs, e.activeMs, Math.max(120000, e.activeMs * 0.05));
      chk(`sessions[${i}].messages`, a2.messages, e.messages, Math.max(5, e.messages * 0.01));
      chk(`sessions[${i}].speed`, a2.speed, e.speed, Math.max(0.1, Math.abs(e.speed || 0) * 0.05));
      chk(`sessions[${i}].market`, a2.market, e.market, Math.max(0.05, Math.abs(e.market || 0) * 0.03));
      chk(`sessions[${i}].saved`, a2.saved, e.saved, Math.max(0.05, Math.abs(e.saved || 0) * 0.03));
    }

    // Summary market/saved = Σ provider rows (both period-scoped now).
    const expMarketSum = expProviders.reduce((su, p) => su + (p.market || 0), 0);
    const expSavedSum = expProviders.reduce((su, p) => su + (p.saved || 0), 0);
    chk('marketTotal', s.cost.marketTotal, r4m(expMarketSum), Math.max(0.05, expMarketSum * 0.03));
    chk('savedTotal', s.cost.savedTotal, r4m(expSavedSum), Math.max(0.05, expSavedSum * 0.03));
  }
  db.close();
  console.log(fails === 0 ? 'VERIFY PASS' : `VERIFY FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR:', e.message); process.exit(2); });