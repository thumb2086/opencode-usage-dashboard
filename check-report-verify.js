// Verify /api/report for Daily/Weekly/Monthly/All against independent hybrid.
// Time-travel: expected range ends at report.generatedAt.
// Mirrors buildReportFromDb's structure without reusing its code:
//   - attribution is full-span and full-range (hybrid spec), then only perDay
//     entries inside the period are summed;
//   - avg/median + providers/agents are derived from the period's session set
//     via session-table meta (perSession doesn't carry agent/model).
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
    // Full-range attribution like the server's getAttrAll(): windowing the
    // message rows would drop pre-period messages and inflate the session
    // residual; the period is applied when filtering perDay buckets below.
    const exp = computeHybrid(db, 0, endMs);
    const tag = `report[${days}]`;
    const chk = (name, a, e, tol = 0) => {
      const ok = tol ? Math.abs(a - e) <= tol : a === e;
      if (!ok) fails++;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${tag} ${name}: api=${a} expected=${e}`);
    };

    // Period-filtered per-day buckets + totals.
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

    // Avg/median over the period's token-bearing sessions.
    const sessVals = periodSessionIds
      .map((sid) => exp.perSession[sid])
      .filter((x) => x && (x.input > 0 || x.output > 0 || x.reasoning > 0))
      .map((x) => x.input + x.output + x.reasoning);
    const avg = sessVals.length ? sessVals.reduce((a2, v) => a2 + v, 0) / sessVals.length : 0;
    chk('avgTokensSession', s.cost.avgTokensSession, Math.round(avg), 1);
    const sv = sessVals.slice().sort((a2, b) => a2 - b);
    const med = sv.length ? (sv.length % 2 ? sv[Math.floor(sv.length / 2)] : (sv[sv.length / 2 - 1] + sv[sv.length / 2]) / 2) : 0;
    chk('medianTokensSession', s.cost.medianTokensSession, Math.round(med), 1);

    // Providers + agents from session-table meta over the period's sessions.
    // Message-level stats per session (period speed + active time), same
    // filter as server (upper bound = time-travel endMs here).
    const agentAgg = {};
    const modelAgg = {};
    const sessExp = [];
    const msgMap = {};
    for (const m of db.prepare(`SELECT session_id AS sid, COUNT(*) AS n, COALESCE(SUM(CASE WHEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) THEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) ELSE 0 END),0) AS o, COALESCE(SUM(CASE WHEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) THEN CAST(json_extract(data,'$.tokens.reasoning') AS INTEGER) ELSE 0 END),0) AS rq, COALESCE(SUM(CASE WHEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) THEN CAST(json_extract(data,'$.time.completed') AS INTEGER) - CAST(json_extract(data,'$.time.created') AS INTEGER) ELSE 0 END),0) AS ms FROM ${T.message} WHERE time_created >= ${startMs} AND time_created < ? GROUP BY sid`).all(endMs)) {
      msgMap[m.sid] = m;
    }
    if (periodSessionIds.length) {
      const ph = periodSessionIds.map(() => '?').join(',');
      const meta = db.prepare(`SELECT id, agent, COALESCE(json_extract(model,'$.providerID'),'unknown') AS provider, COALESCE(json_extract(model,'$.id'),'unknown') AS model, title, time_created AS tc, time_updated AS tu FROM ${T.session} WHERE id IN (${ph})`).all(...periodSessionIds);
      const metaMap = {};
      for (const m of meta) metaMap[m.id] = m;
      for (const sid of periodSessionIds) {
        const ps = exp.perSession[sid];
        if (!ps) continue;
        const m = metaMap[sid] || { agent: 'unknown', provider: 'unknown', model: 'unknown' };
        const agent = m.agent || 'unknown';
        const name = `${m.provider}/${m.model}`;
        if (!agentAgg[agent]) agentAgg[agent] = { sessions: new Set(), cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, speedOut: 0, speedMs: 0, wallMs: 0, activeMs: 0, market: 0, saved: 0 };
        agentAgg[agent].sessions.add(sid);
        agentAgg[agent].input += ps.input; agentAgg[agent].output += ps.output;
        agentAgg[agent].reasoning += ps.reasoning; agentAgg[agent].cacheRead += ps.cacheRead;
        agentAgg[agent].cost += ps.cost;
        const mg = msgMap[sid] || { n: 0, o: 0, ms: 0, rq: 0 };
        agentAgg[agent].speedOut += mg.o; agentAgg[agent].speedMs += mg.ms; agentAgg[agent].activeMs += mg.ms;
        agentAgg[agent].wallMs += Math.max(0, (m.tu || 0) - (m.tc || 0));
        sessExp.push({ sid, m, ps, mg });
        const mkA = pricing.priceFor(m.provider || 'unknown', m.model || 'unknown');
        const mkAv = mkA ? pricing.marketOf({ input: ps.input, output: ps.output, reasoning: ps.reasoning, cacheRead: ps.cacheRead }, mkA) : null;
        if (mkAv !== null) { agentAgg[agent].market += mkAv; agentAgg[agent].saved += mkAv - ps.cost; }
        if (!modelAgg[name]) modelAgg[name] = { sessions: new Set(), cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, speedOut: 0, speedMs: 0, market: 0, saved: 0 };
        modelAgg[name].sessions.add(sid);
        modelAgg[name].input += ps.input; modelAgg[name].output += ps.output;
        modelAgg[name].reasoning += ps.reasoning; modelAgg[name].cacheRead += ps.cacheRead;
        modelAgg[name].cost += ps.cost;
        modelAgg[name].speedOut += mg.o; modelAgg[name].speedMs += mg.ms;
      }
    }

    const expProviders = Object.entries(modelAgg).map(([name, m]) => {
      const i = name.indexOf('/');
      const provider = i < 0 ? 'unknown' : name.slice(0, i);
      const model = i < 0 ? name : name.slice(i + 1);
      const pr = pricing.priceFor(provider, model);
      const mk = pr ? pricing.marketOf({ input: m.input, output: m.output, reasoning: m.reasoning, cacheRead: m.cacheRead }, pr) : null;
      const r4m = (v) => Math.round(v * 10000) / 10000;
      return {
        key: name,
        provider,
        model,
        sessions: m.sessions.size,
        cost: Math.round(m.cost * 1e4) / 1e4,
        tok_in: Math.round(m.input),
        speed: m.speedMs > 0 ? Math.round((m.speedOut / (m.speedMs / 1000)) * 10) / 10 : null,
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
      chk(`prov[${e.key}].speed`, p.speed, e.speed, Math.max(0.1, Math.abs(e.speed || 0) * 0.05));
    }
    if (r.providers.length !== expProviders.length) {
      console.log(`FAIL ${tag} providers.length: api=${r.providers.length} expected=${expProviders.length}`); fails++;
    } else console.log(`OK   ${tag} providers.length: ${r.providers.length}`);

    const expAgents = Object.entries(agentAgg).map(([agent, m]) => ({
      agent, sessions: m.sessions.size, tok_in: Math.round(m.input),
      speed: m.speedMs > 0 ? Math.round((m.speedOut / (m.speedMs / 1000)) * 10) / 10 : null,
      wallMs: Math.round(m.wallMs), activeMs: Math.round(m.activeMs),
      market: Math.round(m.market * 10000) / 10000, saved: Math.round(m.saved * 10000) / 10000,
    }));
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

    // Sessions detail: top 20 by wall time, spot-check first 3 rows.
    const expSessions = sessExp
      .map(({ sid, m, ps, mg }) => {
        const pr = pricing.priceFor(m.provider || 'unknown', m.model || 'unknown');
        const mk = pr ? pricing.marketOf({ input: ps.input, output: ps.output, reasoning: mg.rq || 0, cacheRead: ps.cacheRead }, pr) : null;
        const r4m = (v) => Math.round(v * 10000) / 10000;
        return {
          id: sid,
          wallMs: Math.max(0, (m.tu || 0) - (m.tc || 0)),
          activeMs: mg.ms || 0, messages: mg.n || 0,
          speed: (mg.ms || 0) > 0 ? Math.round(((mg.o || 0) / (mg.ms / 1000)) * 10) / 10 : null,
          market: mk === null ? null : r4m(mk),
          saved: mk === null ? null : r4m(mk - ps.cost),
        };
      })
      .sort((x, y) => y.wallMs - x.wallMs)
      .slice(0, 20);
    const apiSessions = r.sessions || [];
    if (apiSessions.length !== expSessions.length) {
      console.log(`FAIL ${tag} sessions.length: api=${apiSessions.length} expected=${expSessions.length}`); fails++;
    } else console.log(`OK   ${tag} sessions.length: ${apiSessions.length}`);
    for (let i = 1; i < apiSessions.length; i++) {
      if (apiSessions[i - 1].wallMs < apiSessions[i].wallMs) {
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

    // Summary market/saved = sum over provider rows (same construction).
    const expMarketSum = expProviders.reduce((s, p) => s + (p.market || 0), 0);
    chk('marketTotal', s.cost.marketTotal, Math.round(expMarketSum * 10000) / 10000, Math.max(0.05, expMarketSum * 0.03));
    chk('savedTotal', s.cost.savedTotal, Math.round((expMarketSum - t.cost) * 10000) / 10000, Math.max(0.05, expMarketSum * 0.03));
  }
  db.close();
  console.log(fails === 0 ? 'VERIFY PASS' : `VERIFY FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR:', e.message); process.exit(2); });
