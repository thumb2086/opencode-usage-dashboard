// Shared independent verification for oc-stats.
// Message part is grouped by SQLite date(..., 'localtime') (independent of
// server.js JS-Date grouping). Residual math follows the same spec:
// residual = max(0, session - itsMessages), spread across spanned local days
// proportional to message-token volume (uniform when no messages).
// Time-travel: pass endMs = API generatedAt so live chat can't cause drift.
const Database = require('better-sqlite3');
const path = require('path');

function openDb() {
  const override = process.env.OC_STATS_SNAP_DB;
  const dbPath = override || path.join(process.env.USERPROFILE || process.env.HOME, '.local', 'share', 'opencode', 'opencode.db');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

async function fetchJson(url, retries = 20) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json();
    if (j.report !== undefined && !j.ready) {
      await new Promise((s) => setTimeout(s, 1500));
      continue;
    }
    return j;
  }
  throw new Error('not ready: ' + url);
}

function dayKeyOfLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Mirror of server.js schema detection: OpenCode V2 uses session_v2 and
// session_message (tool parts embedded in content); V1 used session/message/part
// and froze at the upgrade. The migration is lossy (455 sessions lost lifetime
// totals recomputed from surviving messages, 30 messages never migrated), so
// both sides merge: per-field MAX over shared session rows + V1-only rows,
// and V1 messages not present in session_message.
function detectTables(db) {
  const has = (t) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table', t);
  const sV2 = has('session_v2'), sV1 = has('session');
  const mV2 = has('session_message'), mV1 = has('message');
  return {
    session: (sV2 && sV1)
      ? `(SELECT v.id AS id, v.agent AS agent, v.model AS model,
           v.time_created AS time_created,
           MAX(v.time_updated, COALESCE(s.time_updated, 0)) AS time_updated,
           MAX(v.tokens_input, COALESCE(s.tokens_input, 0)) AS tokens_input,
           MAX(v.tokens_output, COALESCE(s.tokens_output, 0)) AS tokens_output,
           MAX(v.tokens_reasoning, COALESCE(s.tokens_reasoning, 0)) AS tokens_reasoning,
           MAX(v.tokens_cache_read, COALESCE(s.tokens_cache_read, 0)) AS tokens_cache_read,
           MAX(v.tokens_cache_write, COALESCE(s.tokens_cache_write, 0)) AS tokens_cache_write,
           MAX(v.cost, COALESCE(s.cost, 0)) AS cost
         FROM session_v2 v LEFT JOIN session s ON s.id = v.id
         UNION ALL
         SELECT id, agent, model, time_created, time_updated, tokens_input, tokens_output,
           tokens_reasoning, tokens_cache_read, tokens_cache_write, cost
         FROM session WHERE id NOT IN (SELECT id FROM session_v2))`
      : sV2 ? 'session_v2' : 'session',
    message: (mV2 && mV1)
      ? `(SELECT id, session_id, time_created, time_updated, data
           FROM session_message WHERE type IN ('user','assistant')
         UNION ALL
         SELECT id, session_id, time_created, time_updated, data
           FROM message WHERE id NOT IN (SELECT id FROM session_message))`
      : mV2 ? 'session_message' : 'message',
    embeddedTools: mV2,
  };
}

// Independent hybrid attribution. Returns {perDay, perModel, perAgent, perSession, totals}.
// perDay key: 'YYYY-MM-DD'; sessions are Sets.
function computeHybrid(db, startMs, endMs) {
  const T = detectTables(db);
  const perDay = {}, perModel = {}, perAgent = {}, perSession = {};
  const ens = (o, k, init) => o[k] || (o[k] = init());
  const newBucket = () => ({ sessions: new Set(), messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

  const mrows = db.prepare(`SELECT date(time_created/1000,'unixepoch','localtime') AS day,
    session_id AS sid,
    COALESCE(json_extract(data,'$.agent'),'unknown') AS agent,
    COALESCE(json_extract(data,'$.providerID'),json_extract(data,'$.model.providerID'),'unknown') AS provider,
    COALESCE(json_extract(data,'$.modelID'),json_extract(data,'$.model.modelID'),json_extract(data,'$.model.id'),'unknown') AS model,
    COALESCE(SUM(CAST(json_extract(data,'$.tokens.input') AS INTEGER)),0) AS input,
    COALESCE(SUM(CAST(json_extract(data,'$.tokens.output') AS INTEGER)),0) AS output,
    COALESCE(SUM(CAST(json_extract(data,'$.tokens.reasoning') AS INTEGER)),0) AS reasoning,
    COALESCE(SUM(CAST(json_extract(data,'$.tokens.cache.read') AS INTEGER)),0) AS cacheRead,
    COALESCE(SUM(CAST(json_extract(data,'$.tokens.cache.write') AS INTEGER)),0) AS cacheWrite,
    COALESCE(SUM(CAST(json_extract(data,'$.cost') AS REAL)),0) AS cost,
    COUNT(*) AS n
    FROM ${T.message} WHERE time_created >= ? AND time_created < ? GROUP BY day, sid, agent, provider, model`).all(startMs, endMs);

  const sessMsg = {}; // sid -> {tot per field, perDay {day: vol}}
  for (const r of mrows) {
    const D = ens(perDay, r.day, newBucket);
    D.messages += r.n;
    if (r.sid) D.sessions.add(r.sid);
    D.input += r.input; D.output += r.output; D.reasoning += r.reasoning;
    D.cacheRead += r.cacheRead; D.cacheWrite += r.cacheWrite; D.cost += r.cost;
    const mn = `${r.provider || 'unknown'}/${r.model || 'unknown'}`;
    const M = ens(perModel, mn, newBucket);
    M.messages += r.n;
    if (r.sid) M.sessions.add(r.sid);
    M.input += r.input; M.output += r.output; M.reasoning += r.reasoning;
    M.cacheRead += r.cacheRead; M.cacheWrite += r.cacheWrite; M.cost += r.cost;
    const A = ens(perAgent, r.agent || 'unknown', newBucket);
    A.messages += r.n;
    if (r.sid) A.sessions.add(r.sid);
    A.input += r.input; A.output += r.output; A.reasoning += r.reasoning;
    A.cacheRead += r.cacheRead; A.cacheWrite += r.cacheWrite; A.cost += r.cost;
    if (r.sid) {
      const e = ens(sessMsg, r.sid, () => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, perDay: {} }));
      e.input += r.input; e.output += r.output; e.reasoning += r.reasoning;
      e.cacheRead += r.cacheRead; e.cacheWrite += r.cacheWrite; e.cost += r.cost;
      const vol = r.input + r.output + r.reasoning + r.cacheRead + r.cacheWrite;
      e.perDay[r.day] = (e.perDay[r.day] || 0) + vol;
    }
  }

  const srows = db.prepare(`SELECT id, agent, COALESCE(json_extract(model,'$.providerID'),'unknown') AS provider,
    COALESCE(json_extract(model,'$.id'),'unknown') AS model, time_created AS tc, time_updated AS tu,
    tokens_input AS si, tokens_output AS so, tokens_reasoning AS sr, tokens_cache_read AS scr,
    tokens_cache_write AS scw, cost AS sc FROM ${T.session} WHERE time_updated >= ? AND time_created < ?`).all(startMs, endMs);
  const keyToDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  for (const s of srows) {
    // Full-span residual per the hybrid spec: only the END is clipped for
    // time-travel; callers filter perDay to their period instead of clipping
    // the start, so pre-period share lands outside their window.
    const lo = s.tc, hi = Math.min(s.tu, endMs - 1);
    if (hi < lo) continue;
    const d0 = new Date(new Date(lo).setHours(0, 0, 0, 0));
    const d1 = new Date(new Date(hi).setHours(0, 0, 0, 0));
    const span = [];
    for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) span.push(dayKeyOfLocal(d));
    if (!span.length) continue;
    const mt = sessMsg[s.id] || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, perDay: {} };
    const res = {
      input: Math.max(0, (s.si || 0) - mt.input),
      output: Math.max(0, (s.so || 0) - mt.output),
      reasoning: Math.max(0, (s.sr || 0) - mt.reasoning),
      cacheRead: Math.max(0, (s.scr || 0) - mt.cacheRead),
      cacheWrite: Math.max(0, (s.scw || 0) - mt.cacheWrite),
      cost: Math.max(0, (s.sc || 0) - mt.cost),
    };
    let wTotal = 0;
    for (const k of span) wTotal += mt.perDay[k] || 0;
    const ps = ens(perSession, s.id, () => ({ input: mt.input, output: mt.output, reasoning: mt.reasoning, cacheRead: mt.cacheRead, cacheWrite: mt.cacheWrite, cost: mt.cost }));
    if (wTotal > 0) {
      for (const k of span) if ((mt.perDay[k] || 0) > 0) ens(perDay, k, newBucket).sessions.add(s.id);
    } else {
      const ud = new Date(Math.min(s.tu, endMs - 1));
      ens(perDay, dayKeyOfLocal(ud), newBucket).sessions.add(s.id);
    }
    const mn = `${s.provider || 'unknown'}/${s.model || 'unknown'}`;
    const an = s.agent || 'unknown';
    for (const k of span) {
      const share = wTotal > 0 ? ((mt.perDay[k] || 0) / wTotal) : 1 / span.length;
      if (!share) continue;
      const D = ens(perDay, k, newBucket);
      D.input += res.input * share; D.output += res.output * share; D.reasoning += res.reasoning * share;
      D.cacheRead += res.cacheRead * share; D.cacheWrite += res.cacheWrite * share; D.cost += res.cost * share;
      const M = ens(perModel, mn, newBucket);
      M.input += res.input * share; M.output += res.output * share; M.reasoning += res.reasoning * share;
      M.cacheRead += res.cacheRead * share; M.cacheWrite += res.cacheWrite * share; M.cost += res.cost * share;
      const A = ens(perAgent, an, newBucket);
      A.input += res.input * share; A.output += res.output * share; A.reasoning += res.reasoning * share;
      A.cacheRead += res.cacheRead * share; A.cacheWrite += res.cacheWrite * share; A.cost += res.cost * share;
      ps.input += res.input * share; ps.output += res.output * share; ps.reasoning += res.reasoning * share;
      ps.cacheRead += res.cacheRead * share; ps.cacheWrite += res.cacheWrite * share; ps.cost += res.cost * share;
    }
  }

  const totals = { sessions: Object.keys(perSession).length, messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const k of Object.keys(perDay)) {
    const D = perDay[k];
    totals.messages += D.messages;
    totals.input += D.input; totals.output += D.output; totals.reasoning += D.reasoning;
    totals.cacheRead += D.cacheRead; totals.cacheWrite += D.cacheWrite; totals.cost += D.cost;
  }
  return { perDay, perModel, perAgent, perSession, totals };
}

module.exports = { openDb, fetchJson, dayKeyOfLocal, computeHybrid, detectTables };
