#!/usr/bin/env node
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { promisify } = require('util');
const pipelineAsync = promisify(pipeline);

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }
const pricing = require('./pricing');

const PORT = parseInt(process.env.OC_PORT || '4868', 10);
const REFRESH_MS = 15000;
const TREND_MS = 60 * 1000;
const REPORT_TTL = 10 * 60 * 1000;
const TOOLS_TTL = 5 * 60 * 1000;
const STATS_TTL = 10 * 60 * 1000;
const CACHE_CLEANUP_MS = 5 * 60 * 1000;
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_RETENTION = parseInt(process.env.OPENCODE_BACKUP_RETENTION || '3', 10) || 3;
const BACKUP_SRC = process.env.OPENCODE_DATA
  ? path.join(process.env.OPENCODE_DATA, 'opencode.db')
  : path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'share', 'opencode', 'opencode.db');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const VERSION = pkg.version;

function compressFile(srcPath) {
  return new Promise((resolve, reject) => {
    const dstPath = srcPath + '.gz';
    const src = fs.createReadStream(srcPath);
    const dst = fs.createWriteStream(dstPath);
    const gzip = zlib.createGzip({ level: 1 });
    src.on('error', reject);
    dst.on('error', reject);
    gzip.on('error', reject);
    dst.on('finish', () => {
      try {
        const origSize = fs.statSync(srcPath).size;
        const compSize = fs.statSync(dstPath).size;
        fs.unlinkSync(srcPath);
        resolve({ origSize, compSize });
      } catch (e) { reject(e); }
    });
    src.pipe(gzip).pipe(dst);
  });
}

function cleanupOldBackups() {
  if (BACKUP_RETENTION <= 0) return Promise.resolve();
  return (async () => {
    try {
      const dirs = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('opencode-') && fs.statSync(path.join(BACKUP_DIR, f)).isDirectory())
        .sort();
      if (dirs.length > BACKUP_RETENTION) {
        const toDelete = dirs.slice(0, dirs.length - BACKUP_RETENTION);
        for (const f of toDelete) {
          const dirPath = path.join(BACKUP_DIR, f);
          // Async: recursive rm of multi-hundred-MB gzip dirs is slow on
          // Windows; doing it synchronously starves the event loop long
          // enough that the process gets terminated during backup cleanup.
          await fs.promises.rm(dirPath, { recursive: true, force: true });
          console.log(`backup cleaned: ${f}`);
        }
      }
    } catch (_) {}
  })();
}

const EXE = (() => {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'opencode';
})();

// OpenCode V2 writes sessions to session_v2 and messages to session_message
// (tool parts embedded in message content); V1 used session/message/part and
// froze at the upgrade. The V2 migration is LOSSY, so merge — never switch:
// - 455/734 migrated sessions LOST their lifetime totals (196M input tokens):
//   V2 recomputed them from surviving messages, dropping pruned compaction
//   history (sessions whose messages were fully pruned went to 0). V1's frozen
//   totals are the authoritative record, so take per-field MAX of the shared
//   rows (same lifetime counter — never SUM, that would double count).
// - 30 messages were never migrated (4.3M input tokens) → union them in.
// - Tool parts: embedded content already covers migrated V1 parts, so only
//   parts of never-migrated messages are added from `part` (everything else
//   would double count).
const schema = { session: 'session', message: 'message', embeddedTools: false };
function detectSchema(d) {
  const has = (t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const sV2 = has('session_v2'), sV1 = has('session');
  const mV2 = has('session_message'), mV1 = has('message');
  schema.embeddedTools = mV2;
  schema.session = (sV2 && sV1)
    ? `(SELECT v.id AS id, v.agent AS agent, v.model AS model,
         COALESCE(v.title, s.title, '') AS title,
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
       SELECT id, agent, model, title, time_created, time_updated, tokens_input, tokens_output,
         tokens_reasoning, tokens_cache_read, tokens_cache_write, cost
       FROM session WHERE id NOT IN (SELECT id FROM session_v2))`
    : sV2 ? 'session_v2' : 'session';
  // V2 adds non-chat message types (idle/synthetic/compaction/...): keep V1
  // user+assistant semantics by filtering inside the union.
  schema.message = (mV2 && mV1)
    ? `(SELECT id, session_id, time_created, time_updated, data
         FROM session_message WHERE type IN ('user','assistant')
       UNION ALL
       SELECT id, session_id, time_created, time_updated, data
         FROM message WHERE id NOT IN (SELECT id FROM session_message))`
    : mV2 ? 'session_message' : 'message';
}

let db = null;
function getDb() {
  if (!Database) return null;
  // Re-open if previous connection was lost (e.g. WAL checkpoint reset).
  if (db) {
    try { db.prepare('SELECT 1').get(); return db; } catch (_) { try { db.close(); } catch (_) {} db = null; }
  }
  if (!fs.existsSync(BACKUP_SRC)) return null;
  try {
    db = new Database(BACKUP_SRC, { readonly: true, fileMustExist: true });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    detectSchema(db);
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_message_time_created ON message(time_created)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_message_session_time ON message(session_id, time_created)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_session_time ON session(time_created, time_updated)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_part_time_tool ON part(time_updated)");
    } catch (_) {}
    return db;
  } catch (_) { return null; }
}

const state = { data: null, busy: false, error: null, updatedAt: 0, models: null, modelsBusy: false, loading: true };

let indexHtmlCache = null;

let backupBusy = false;
let vacuumBusy = false;
let lastAutoBackupDay = '';

function loadIndexHtml(callback) {
  if (indexHtmlCache) return callback(null, indexHtmlCache);
  fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8', (err, data) => {
    if (err) return callback(err);
    indexHtmlCache = data;
    callback(null, data);
  });
}

function run(args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(EXE, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout }, (err, stdout) => {
      if (err) return resolve({ ok: false, err: err.message, out: stdout || '' });
      resolve({ ok: true, out: stdout });
    });
  });
}

function dbQuery(sql, params) {
  const d = getDb();
  if (!d) return null;
  try { return params ? d.prepare(sql).all(...params) : d.prepare(sql).all(); } catch (_) { return null; }
}

function dbGet(sql, params) {
  const d = getDb();
  if (!d) return null;
  try { return params ? d.prepare(sql).get(...params) : d.prepare(sql).get(); } catch (_) { return null; }
}

function dbExec(sql) {
  const d = getDb();
  if (!d) return null;
  try { d.exec(sql); return true; } catch (_) { return false; }
}

function ensureIndexes() {
  // Indexes are created inside getDb() on open; kept for explicit warmup call.
  getDb();
}

const trendCache = {};
const trendBusy = {};
const trendPending = {};

function cleanExpiredCache(cache, ttl) {
  const now = Date.now();
  for (const key of Object.keys(cache)) {
    if (cache[key] && cache[key].generatedAt && now - cache[key].generatedAt > ttl) {
      delete cache[key];
    }
  }
}

async function generateTrend(days) {
  // Buckets: local midnights, today -> (days-1) days ago.
  // Values are sliced from the SHARED all-time attribution (getAttrAll(),
  // the same object the usage report uses) — never a separate windowed
  // attributeUsage call. Windowed attribution inflates in-window days:
  // messages before the window are excluded from msgTok, so the session
  // residual grows and lands entirely on windowed days (measured
  // +0.25–1.7M input/day on 2026-09-29). One shared attribution makes
  // trend buckets and report periods structurally identical; any remaining
  // panel difference is only cache age (trend ≤60s, report ≤10min, both
  // timestamps shown in the UI).
  const buckets = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    buckets.push(d);
  }
  const a = getAttrAll();
  const at = (b, f) => {
    const D = a.perDay[localDayKey(b)];
    return D ? D[f] : 0;
  };
  const sess = (b) => {
    const D = a.perDay[localDayKey(b)];
    return D ? D.sessions.size : 0;
  };

  return {
    generatedAt: attrAllCache.at, // attribution build time, not response time
    step: 1,
    labels: buckets.map((b) => (b.getMonth() + 1) + '/' + b.getDate()),
    sessions: buckets.map(sess),
    input: buckets.map((b) => at(b, 'input')),
    output: buckets.map((b) => at(b, 'output')),
    reasoning: buckets.map((b) => at(b, 'reasoning')),
    cacheRead: buckets.map((b) => at(b, 'cacheRead')),
    cost: buckets.map((b) => at(b, 'cost')),
  };
}

function refreshTrend(days) {
  const key = String(days);
  const hit = trendCache[key];
  const fresh = hit && Date.now() - hit.generatedAt < TREND_MS;
  if (fresh) return { trend: hit, pending: null };
  let pending = trendPending[key];
  if (!pending) {
    pending = generateTrend(days).then((t) => {
      if (t) trendCache[key] = t;
    }).catch(() => {}).finally(() => {
      delete trendBusy[key];
      delete trendPending[key];
    });
    trendPending[key] = pending;
    trendBusy[key] = true;
  }
  return { trend: hit ? Object.assign({}, hit, { stale: true }) : null, pending };
}

function localDayKey(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dateOfKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m, d); }
function modelNameOf(provider, model) { return `${provider || 'unknown'}/${model || 'unknown'}`; }
function splitModelName(name) {
  const i = String(name).indexOf('/');
  return i < 0 ? { provider: 'unknown', model: String(name) } : { provider: String(name).slice(0, i), model: String(name).slice(i + 1) };
}

// Market estimate for token usage at catalog paid rates (USD). saved is
// market minus actual cost. pricedAs records the catalog entry used
// ("proxy:" prefix = fallback estimate). Null when no pricing catalog.
// Market-price engine rules live in pricing.js (shared with check scripts).
function marketOf(tok, provider, model) {
  const pr = pricing.priceFor(provider, model);
  if (!pr) return { market: null, saved: null, pricedAs: null };
  const market = pricing.marketOf(tok, pr);
  const r4m = (v) => Math.round(v * 10000) / 10000;
  return { market: r4m(market), saved: r4m(market - (tok.cost || 0)), pricedAs: pr.source };
}

// Hybrid usage attribution over [startMs, endMs).
// Why hybrid: session-level totals are COMPLETE (message table only covers
// ~2026-08 onward; 287/469 sessions in 90d have zero messages) but a
// multi-day session dumps all its tokens onto time_updated day (e.g. a 45.9M
// session created 9/9 updated 9/13). Message rows carry exact per-message
// tokens+cost+time but are incomplete. So: message tokens go to their exact
// local day; each session's residual (session totals minus its message sums,
// clamped >= 0) is spread across the local days the session spans,
// proportional to that session's per-day message-token volume
// (uniform across spanned days when the session has no messages).
// Returns perDay/perModel/perAgent/perSession maps plus totals.
// periodStartMs (optional): when set, ALSO slice every total into
// *-Period buckets covering only local days >= periodStartMs. The all-time
// buckets (perDay/perModel/perSession) are unaffected, so one scan serves both
// the trend (lifetime) and the report (period) views. Period buckets group
// message tokens by the MESSAGE's own model/agent, and spread session residual
// by the session's model/agent — so per-model report rows sum exactly to the
// period totals (self-consistent by construction).
function attributeUsage(startMs, endMs, periodStartMs) {
  const periodOn = periodStartMs != null;
  const inPeriod = periodOn ? (key) => dateOfKey(key).getTime() >= periodStartMs : () => false;
  const perDay = {};
  const perModel = {};
  const perAgent = {};
  const perSession = {};
  const perModelPeriod = {};
  const perAgentPeriod = {};
  const perAgentModelPeriod = {};
  const perSessionPeriod = {};
  const perSessionModelPeriod = {};
  const ensureDay = (key) => perDay[key] || (perDay[key] = { date: dateOfKey(key), sessions: new Set(), messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const ensureModel = (n) => perModel[n] || (perModel[n] = { messages: 0, sessions: new Set(), input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, speedOut: 0, speedMs: 0 });
  const ensureAgent = (a) => perAgent[a || 'unknown'] || (perAgent[a || 'unknown'] = { messages: 0, sessions: new Set(), input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const tok = () => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const ensureModelP = (n) => perModelPeriod[n] || (perModelPeriod[n] = { messages: 0, sessions: new Set(), input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, speedOut: 0, speedMs: 0 });
  const ensureAgentP = (a) => perAgentPeriod[a || 'unknown'] || (perAgentPeriod[a || 'unknown'] = { sessions: new Set(), input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, speedOut: 0, speedMs: 0 });
  const ensureAgentModelP = (a, m) => {
    const k = a || 'unknown';
    const bag = perAgentModelPeriod[k] || (perAgentModelPeriod[k] = {});
    return bag[m] || (bag[m] = tok());
  };
  const ensureSessP = (sid) => perSessionPeriod[sid] || (perSessionPeriod[sid] = tok());
  const ensureSessModelP = (sid, m) => {
    const bag = perSessionModelPeriod[sid] || (perSessionModelPeriod[sid] = {});
    return bag[m] || (bag[m] = tok());
  };

  // 1. messages in period (exact timing)
  const msgTok = {};
  const msgW = {};
  const mrows = dbQuery(`SELECT time_created AS t, session_id AS sid, COALESCE(json_extract(data, '$.agent'), 'unknown') AS agent, COALESCE(json_extract(data, '$.providerID'), json_extract(data, '$.model.providerID'), 'unknown') AS provider, COALESCE(json_extract(data, '$.modelID'), json_extract(data, '$.model.modelID'), json_extract(data, '$.model.id'), 'unknown') AS model, COALESCE(CAST(json_extract(data, '$.tokens.input') AS INTEGER), 0) AS input, COALESCE(CAST(json_extract(data, '$.tokens.output') AS INTEGER), 0) AS output, COALESCE(CAST(json_extract(data, '$.tokens.reasoning') AS INTEGER), 0) AS reasoning, COALESCE(CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER), 0) AS cacheRead, COALESCE(CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER), 0) AS cacheWrite, COALESCE(CAST(json_extract(data, '$.cost') AS REAL), 0) AS cost, CAST(json_extract(data, '$.time.created') AS INTEGER) AS t0, CAST(json_extract(data, '$.time.completed') AS INTEGER) AS t1 FROM ${schema.message} WHERE time_created >= ${startMs} AND time_created < ${endMs};`) || [];
  for (const r of mrows) {
    const key = localDayKey(new Date(r.t));
    const D = ensureDay(key);
    D.messages++;
    if (r.sid) D.sessions.add(r.sid);
    const iv = +r.input || 0, ov = +r.output || 0, rv = +r.reasoning || 0;
    const crv = +r.cacheRead || 0, cwv = +r.cacheWrite || 0, cv = +r.cost || 0;
    D.input += iv; D.output += ov; D.reasoning += rv; D.cacheRead += crv; D.cacheWrite += cwv; D.cost += cv;
    const M = ensureModel(modelNameOf(r.provider, r.model));
    M.messages++;
    if (r.sid) M.sessions.add(r.sid);
    M.input += iv; M.output += ov; M.reasoning += rv; M.cacheRead += crv; M.cacheWrite += cwv; M.cost += cv;
    // Message-level generation speed only (session residuals have no
    // duration): output tokens per active second over completed messages.
    const t0 = +r.t0 || 0, t1 = +r.t1 || 0;
    if (ov > 0 && t1 > t0) { M.speedOut += ov; M.speedMs += (t1 - t0); }
    const A = ensureAgent(r.agent);
    A.messages++;
    if (r.sid) A.sessions.add(r.sid);
    A.input += iv; A.output += ov; A.reasoning += rv; A.cacheRead += crv; A.cacheWrite += cwv; A.cost += cv;
    if (r.sid) {
      const mt = msgTok[r.sid] || (msgTok[r.sid] = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
      mt.input += iv; mt.output += ov; mt.reasoning += rv; mt.cacheRead += crv; mt.cacheWrite += cwv; mt.cost += cv;
      const w = msgW[r.sid] || (msgW[r.sid] = { total: 0, perDay: {} });
      const vol = iv + ov + rv + crv + cwv;
      w.total += vol;
      w.perDay[key] = (w.perDay[key] || 0) + vol;
    }
    // Period slice: message tokens under the MESSAGE's own model/agent.
    if (periodOn && inPeriod(key)) {
      const mName = modelNameOf(r.provider, r.model);
      const aName = r.agent || 'unknown';
      const MP = ensureModelP(mName);
      MP.messages++;
      if (r.sid) MP.sessions.add(r.sid);
      MP.input += iv; MP.output += ov; MP.reasoning += rv; MP.cacheRead += crv; MP.cacheWrite += cwv; MP.cost += cv;
      if (ov > 0 && t1 > t0) { MP.speedOut += ov; MP.speedMs += (t1 - t0); }
      const AP = ensureAgentP(aName);
      if (r.sid) AP.sessions.add(r.sid);
      AP.input += iv; AP.output += ov; AP.reasoning += rv; AP.cacheRead += crv; AP.cacheWrite += cwv; AP.cost += cv;
      if (ov > 0 && t1 > t0) { AP.speedOut += ov; AP.speedMs += (t1 - t0); }
      const AM = ensureAgentModelP(aName, mName);
      AM.input += iv; AM.output += ov; AM.reasoning += rv; AM.cacheRead += crv; AM.cacheWrite += cwv; AM.cost += cv;
      if (r.sid) {
        const SP = ensureSessP(r.sid);
        SP.input += iv; SP.output += ov; SP.reasoning += rv; SP.cacheRead += crv; SP.cacheWrite += cwv; SP.cost += cv;
        const SM = ensureSessModelP(r.sid, mName);
        SM.input += iv; SM.output += ov; SM.reasoning += rv; SM.cacheRead += crv; SM.cacheWrite += cwv; SM.cost += cv;
      }
    }
  }

  // 2. sessions intersecting the period: spread residual
  const srows = dbQuery(`SELECT id, agent, COALESCE(json_extract(model, '$.providerID'), 'unknown') AS provider, COALESCE(json_extract(model, '$.id'), 'unknown') AS model, time_created AS tc, time_updated AS tu, tokens_input AS si, tokens_output AS so, tokens_reasoning AS sr, tokens_cache_read AS scr, tokens_cache_write AS scw, cost AS sc FROM ${schema.session} WHERE time_updated >= ${startMs} AND time_created < ${endMs};`) || [];
  for (const s of srows) {
    // Use the session's FULL span for residual distribution. All consumers
    // share one all-time attribution (getAttrAll), so per-day values are
    // identical whichever period slices them.
    const d0 = new Date(new Date(s.tc).setHours(0, 0, 0, 0));
    const d1 = new Date(new Date(s.tu).setHours(0, 0, 0, 0));
    const spanKeys = [];
    for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) spanKeys.push(localDayKey(d));
    if (!spanKeys.length) continue;
    const mt = msgTok[s.id] || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const res = {
      input: Math.max(0, (+s.si || 0) - mt.input),
      output: Math.max(0, (+s.so || 0) - mt.output),
      reasoning: Math.max(0, (+s.sr || 0) - mt.reasoning),
      cacheRead: Math.max(0, (+s.scr || 0) - mt.cacheRead),
      cacheWrite: Math.max(0, (+s.scw || 0) - mt.cacheWrite),
      cost: Math.max(0, (+s.sc || 0) - mt.cost),
    };
    const ps = perSession[s.id] || (perSession[s.id] = { input: mt.input, output: mt.output, reasoning: mt.reasoning, cacheRead: mt.cacheRead, cacheWrite: mt.cacheWrite, cost: mt.cost });
    const w = msgW[s.id];
    let wTotal = 0;
    if (w) { for (const k of spanKeys) wTotal += w.perDay[k] || 0; }
    if (wTotal > 0) {
      for (const k of spanKeys) if ((w.perDay[k] || 0) > 0) ensureDay(k).sessions.add(s.id);
    } else {
      ensureDay(localDayKey(new Date(s.tu))).sessions.add(s.id);
    }
    const mName = modelNameOf(s.provider, s.model);
    const aName = s.agent || 'unknown';
    for (const k of spanKeys) {
      const share = wTotal > 0 ? ((w.perDay[k] || 0) / wTotal) : 1 / spanKeys.length;
      if (share === 0) continue;
      const D = ensureDay(k);
      const di = res.input * share, dout = res.output * share, dr = res.reasoning * share;
      const dcr = res.cacheRead * share, dcw = res.cacheWrite * share, dc = res.cost * share;
      D.input += di; D.output += dout; D.reasoning += dr; D.cacheRead += dcr; D.cacheWrite += dcw; D.cost += dc;
      const M = ensureModel(mName);
      M.input += di; M.output += dout; M.reasoning += dr; M.cacheRead += dcr; M.cacheWrite += dcw; M.cost += dc;
      const A = ensureAgent(aName);
      A.input += di; A.output += dout; A.reasoning += dr; A.cacheRead += dcr; A.cacheWrite += dcw; A.cost += dc;
      ps.input += di; ps.output += dout; ps.reasoning += dr; ps.cacheRead += dcr; ps.cacheWrite += dcw; ps.cost += dc;
      // Period slice: residual shares land under the SESSION's model/agent
      // (no per-message model exists for residual), but only on days inside
      // the period, so period rows sum exactly to the period totals.
      if (periodOn && inPeriod(k)) {
        const MP = ensureModelP(mName);
        MP.input += di; MP.output += dout; MP.reasoning += dr; MP.cacheRead += dcr; MP.cacheWrite += dcw; MP.cost += dc;
        const AP = ensureAgentP(aName);
        AP.input += di; AP.output += dout; AP.reasoning += dr; AP.cacheRead += dcr; AP.cacheWrite += dcw; AP.cost += dc;
        const AM = ensureAgentModelP(aName, mName);
        AM.input += di; AM.output += dout; AM.reasoning += dr; AM.cacheRead += dcr; AM.cacheWrite += dcw; AM.cost += dc;
        const SP = ensureSessP(s.id);
        SP.input += di; SP.output += dout; SP.reasoning += dr; SP.cacheRead += dcr; SP.cacheWrite += dcw; SP.cost += dc;
        const SM = ensureSessModelP(s.id, mName);
        SM.input += di; SM.output += dout; SM.reasoning += dr; SM.cacheRead += dcr; SM.cacheWrite += dcw; SM.cost += dc;
      }
    }
  }

  const totals = { sessions: Object.keys(perSession).length, messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const k of Object.keys(perDay)) {
    const D = perDay[k];
    totals.messages += D.messages;
    totals.input += D.input; totals.output += D.output; totals.reasoning += D.reasoning;
    totals.cacheRead += D.cacheRead; totals.cacheWrite += D.cacheWrite; totals.cost += D.cost;
  }
  return {
    perDay, perModel, perAgent, perSession, totals,
    perModelPeriod, perAgentPeriod, perAgentModelPeriod, perSessionPeriod, perSessionModelPeriod,
    periodStartMs,
  };
}

// All-time attribution, memoized 300s (expensive full DB scan; avoids
// re-running attributeUsage on every /api/stats hit).
let attrAllCache = null;
// Tool counts change slowly but the embedded-content scan costs ~1.5s on a
// large DB; cache it so the 15s refresh stays cheap. Keyed on schema+window.
let toolsCache = null;
function getAttrAll() {
  const now = Date.now();
  if (attrAllCache && now - attrAllCache.at < 300000) return attrAllCache.a;
  // periodStartMs = 0: the *Period buckets equal the all-time ones, so the
  // All report can read them (single scan serves both views).
  const a = attributeUsage(0, now, 0);
  attrAllCache = { at: now, a };
  return a;
}

// Period-scoped attribution (same 300s TTL, one cache slot per period start).
// Report panels slice this instead of the all-time buckets so every row and
// the summary total describe the SAME period.
const attrPeriodCache = new Map();
function getAttrPeriod(startMs) {
  const now = Date.now();
  const hit = attrPeriodCache.get(startMs);
  if (hit && now - hit.at < 300000) return hit.a;
  const a = attributeUsage(0, now, startMs);
  attrPeriodCache.set(startMs, { at: now, a });
  if (attrPeriodCache.size > 6) {
    for (const [k, v] of attrPeriodCache) if (now - v.at >= 300000) attrPeriodCache.delete(k);
  }
  return a;
}

function computeMedian(arr) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function getStatsFromDb(days) {
  const now = Date.now();
  const startMs = days > 0 ? now - days * 86400000 : 0;
  const timeFilter = startMs ? `AND s.time_updated >= ${startMs}` : '';
  const timeFilterPart = startMs ? `AND p.time_updated >= ${startMs}` : '';
  const timeFilterWhere = startMs ? `WHERE s.time_updated >= ${startMs}` : '';

  // NOTE: days is only ever 0 here (overview totals); per-period stats are
  // built by buildReportFromDb via attributeUsage. Local-day count so the
  // number matches the trend chart buckets.
  

  // V2: tool parts are embedded in session_message content (part table froze
  // at the upgrade and its migrated rows were rebuilt into content, so
  // querying all of part would double count — only parts of messages that
  // were never migrated are added from `part`). Cached (see toolsCache):
  // verification accepts api<=expected, so staleness never fails checks.
  if (!toolsCache || now - toolsCache.at > TOOLS_TTL || toolsCache.embedded !== schema.embeddedTools || toolsCache.startMs !== startMs) {
    const toolRows = schema.embeddedTools
      ? dbQuery(`SELECT COALESCE(json_extract(je.value, '$.tool'), json_extract(je.value, '$.name')) AS tool FROM session_message sm, json_each(json_extract(sm.data, '$.content')) je WHERE json_extract(je.value, '$.type') = 'tool' ${startMs ? `AND sm.time_updated >= ${startMs}` : ''}
        UNION ALL
        SELECT json_extract(p.data, '$.tool') AS tool FROM part p WHERE json_extract(p.data, '$.type') = 'tool' AND p.message_id NOT IN (SELECT id FROM session_message) ${startMs ? `AND p.time_updated >= ${startMs}` : ''};`) || []
      : dbQuery(`SELECT json_extract(p.data, '$.tool') AS tool FROM part p WHERE json_extract(p.data, '$.type') = 'tool' ${timeFilterPart};`) || [];
    const counts = {};
    for (const row of toolRows) {
      if (row.tool) counts[row.tool] = (counts[row.tool] || 0) + 1;
    }
    toolsCache = { at: now, embedded: schema.embeddedTools, startMs, counts };
  }
  const toolCounts = toolsCache.counts;
  const totalToolUse = Object.values(toolCounts).reduce((s, v) => s + v, 0) || 1;
  const tools = Object.entries(toolCounts)
    .map(([name, count]) => ({ name, count, pct: Math.round((count / totalToolUse) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);

  const attr = getAttrAll();
  const T = attr.totals;
  // Overview = ALL TIME and uses the SAME attribution as the trend chart and
  // Report(All), so the three panels cannot disagree. Per-message tokens are
  // authoritative: a session whose message sums exceed its session-table
  // counters (V2 migration artifact) keeps the measured message values
  // instead of being clamped down to the session counters.
  const sessions = T.sessions;
  const messages = T.messages;
  // Active days = day buckets that actually carry usage. Excludes pre-2000
  // epoch artifacts (imported rows with time_created = 0).
  const dayKeys = Object.keys(attr.perDay).filter((k) => attr.perDay[k].date.getFullYear() >= 2020);
  const activeDays = dayKeys.length || 1;
  const sessVals = Object.values(attr.perSession)
    .filter((s) => s.input > 0 || s.output > 0 || s.reasoning > 0)
    .map((s) => s.input + s.output + s.reasoning)
    .filter(Number.isFinite);
  const avgTokens = sessVals.length ? sessVals.reduce((s, v) => s + v, 0) / sessVals.length : 0;
  const medianTokens = computeMedian(sessVals);
  const avgDayCost = T.cost ? T.cost / activeDays : 0;

  // Per-model usage from hybrid attribution (message counts are TRUE message
  // counts here, not session counts; token/cost sums include residuals so
  // pruned history isn't lost).
  const models = Object.entries(attr.perModel)
    .map(([name, m]) => ({
      name,
      messages: m.messages,
      input: Math.round(m.input),
      output: Math.round(m.output),
      reasoning: Math.round(m.reasoning),
      cacheRead: Math.round(m.cacheRead),
      cacheWrite: Math.round(m.cacheWrite),
      cost: m.cost,
      speed: m.speedMs > 0 ? Math.round((m.speedOut / (m.speedMs / 1000)) * 10) / 10 : null,
    }))
    .sort((a, b) => b.cost - a.cost);

  // Savings estimate: market value of all-time usage at catalog paid rates,
  // priced per MESSAGE model (residual falls back to the session's model) —
  // the same basis as the report providers table.
  let marketTotal = null, savedTotal = null, priceAsOf = null;
  {
    const info = pricing.catalogInfo();
    if (info.ok) {
      priceAsOf = new Date(info.mtimeMs).toISOString();
      marketTotal = 0;
      for (const [name, m] of Object.entries(attr.perModel)) {
        const { provider, model } = splitModelName(name);
        const mk = marketOf({ input: m.input, output: m.output, reasoning: m.reasoning, cacheRead: m.cacheRead, cost: m.cost }, provider, model);
        if (mk.market === null) { marketTotal = null; break; }
        marketTotal += mk.market;
      }
      if (marketTotal !== null) {
        marketTotal = Math.round(marketTotal * 10000) / 10000;
        savedTotal = Math.round((marketTotal - T.cost) * 10000) / 10000;
      } else { savedTotal = null; }
    }
  }

  return {
    ok: true,
    overview: { sessions, messages, days: activeDays },
    cost: {
      total: T.cost,
      avgDay: avgDayCost,
      avgTokensSession: Math.round(avgTokens),
      medianTokensSession: Math.round(medianTokens),
      input: Math.round(T.input),
      output: Math.round(T.output),
      reasoning: Math.round(T.reasoning),
      cacheRead: Math.round(T.cacheRead),
      cacheWrite: Math.round(T.cacheWrite),
      marketTotal, savedTotal, priceAsOf,
    },
    tools,
    models,
  };
}

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    const p = getStatsFromDb(0);
    if (p && p.ok) {
      state.data = p;
      state.error = null;
      state.updatedAt = Date.now();
    } else {
      state.error = state.error || 'failed to read database';
    }
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
  state.busy = false;
}

function getModelsFromDb() {
  const attr = getAttrAll();
  return Object.entries(attr.perModel)
    .map(([name, m]) => ({
      name,
      messages: m.messages,
      input: Math.round(m.input),
      output: Math.round(m.output),
      cacheRead: Math.round(m.cacheRead),
      cacheWrite: Math.round(m.cacheWrite),
      cost: m.cost,
      speed: m.speedMs > 0 ? Math.round((m.speedOut / (m.speedMs / 1000)) * 10) / 10 : null,
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10);
}

async function refreshModels() {
  if (state.modelsBusy) return;
  state.modelsBusy = true;
  try {
    state.models = getModelsFromDb();
  } catch (_) {}
  state.modelsBusy = false;
}

function backupDirName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `opencode-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function performBackup(auto) {
  if (backupBusy || vacuumBusy) return { ok: false, busy: true };
  backupBusy = true;
  try {
    if (!fs.existsSync(BACKUP_SRC)) return { ok: false, error: 'source db not found: ' + BACKUP_SRC };
    const srcDir = path.dirname(BACKUP_SRC);
    const files = ['opencode.db', 'opencode.db-wal', 'opencode.db-shm'].filter((n) => fs.existsSync(path.join(srcDir, n)));
    const dir = backupDirName();
    const destDir = path.join(BACKUP_DIR, dir);
    fs.mkdirSync(destDir, { recursive: true });
    let totalOrigSize = 0;
    let totalCompSize = 0;
    const compressedFiles = [];
    for (const n of files) {
      const srcPath = path.join(srcDir, n);
      const dstPath = path.join(destDir, n);
      await fs.promises.copyFile(srcPath, dstPath);
      try {
        const { origSize, compSize } = await compressFile(dstPath);
        totalOrigSize += origSize;
        totalCompSize += compSize;
        compressedFiles.push(n + '.gz');
      } catch (_) {
        totalOrigSize += fs.statSync(dstPath).size;
        totalCompSize += fs.statSync(dstPath).size;
        compressedFiles.push(n);
      }
    }
    if (auto) {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      lastAutoBackupDay = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    }
    await cleanupOldBackups();
    const ratio = totalOrigSize > 0 ? ((1 - totalCompSize / totalOrigSize) * 100).toFixed(1) : 0;
    console.log(`backup ok: ${dir} (${(totalCompSize / 1024 / 1024).toFixed(1)} MB, compressed ${ratio}%)`);
    return { ok: true, file: dir, size: totalCompSize, origSize: totalOrigSize, files: compressedFiles };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    backupBusy = false;
  }
}

async function autoBackupIfDue() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  if (lastAutoBackupDay === day) return;
  try {
    const existing = fs.readdirSync(BACKUP_DIR).some((f) => f.startsWith(`opencode-${day}`) && fs.statSync(path.join(BACKUP_DIR, f)).isDirectory());
    if (existing) {
      lastAutoBackupDay = day;
      return;
    }
  } catch (e) { /* dir not created yet */ }
  await performBackup(true);
}

const reportCache = {};
const reportBusy = {};

function periodStartMs(days, now) {
  if (days === -1) return 0;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (days <= 1) return d.getTime(); // Daily = today (local)
  if (days <= 7) { d.setDate(d.getDate() - 6); return d.getTime(); } // Weekly = 7 local days
  d.setDate(1);
  return d.getTime(); // Monthly = month-to-date (local)
}

function buildReportFromDb(days) {
  const now = Date.now();
  const startMs = periodStartMs(days, now);
  const label = days === -1 ? 'All' : days <= 1 ? 'Daily' : days <= 7 ? 'Weekly' : 'Monthly';

  // Period-scoped attribution: every number below (summary, providers, agents,
  // sessions, market/saved) is sliced to THIS period, so the tables sum to the
  // card. The all-time buckets (perDay) are still used for the summary totals
  // and stay identical to the trend chart for the same period.
  const a = days === -1 ? getAttrAll() : getAttrPeriod(startMs);
  const aNow = days === -1 ? attrAllCache.at : attrPeriodCache.get(startMs).at; // snapshot time of `a`
  // Message-level stats per session within the period (period speed + active
  // time). One GROUP BY over the merged message view, mapped onto the same
  // session-meta buckets as tokens so row sets stay identical.
  // Wall time must come from the MESSAGE clock, not session.time_updated:
  // subagent/fork sessions are written with time_updated == time_created
  // (same millisecond), which would report ~0 wall for hours of real work.
  // Query the merged message view for the period span per session.
  const wallMs = {};
  for (const m of (dbQuery(`SELECT session_id AS sid, MIN(time_created) AS t0, MAX(COALESCE(CAST(json_extract(data,'$.time.completed') AS INTEGER), time_updated)) AS t1 FROM ${schema.message} WHERE time_created >= ${startMs} AND time_created < ${aNow} GROUP BY session_id`) || [])) {
    wallMs[m.sid] = Math.max(0, (+m.t1 || 0) - (+m.t0 || 0));
  }
  const msgAgg = {};
  for (const m of (dbQuery(`SELECT session_id AS sid, COUNT(*) AS n, COALESCE(SUM(CASE WHEN CAST(json_extract(data, '$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data, '$.time.completed') AS INTEGER) > CAST(json_extract(data, '$.time.created') AS INTEGER) THEN CAST(json_extract(data, '$.tokens.output') AS INTEGER) ELSE 0 END), 0) AS o, COALESCE(SUM(CASE WHEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) THEN CAST(json_extract(data,'$.tokens.reasoning') AS INTEGER) ELSE 0 END), 0) AS rq, COALESCE(SUM(CASE WHEN CAST(json_extract(data, '$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data, '$.time.completed') AS INTEGER) > CAST(json_extract(data, '$.time.created') AS INTEGER) THEN CAST(json_extract(data, '$.time.completed') AS INTEGER) - CAST(json_extract(data, '$.time.created') AS INTEGER) ELSE 0 END), 0) AS ms FROM ${schema.message} WHERE time_created >= ${startMs} AND time_created < ${aNow} GROUP BY sid`) || [])) {
    msgAgg[m.sid] = m;
  }
  // Same aggregates per agent — the message layer can name agents that session
  // meta lacks (compaction/plan), so agent speed/active come from messages.
  const msgAgentAgg = {};
  for (const m of (dbQuery(`SELECT COALESCE(json_extract(data,'$.agent'),'unknown') AS agent, COALESCE(SUM(CASE WHEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) THEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) ELSE 0 END),0) AS o, COALESCE(SUM(CASE WHEN CAST(json_extract(data,'$.tokens.output') AS INTEGER) > 0 AND CAST(json_extract(data,'$.time.completed') AS INTEGER) > CAST(json_extract(data,'$.time.created') AS INTEGER) THEN CAST(json_extract(data,'$.time.completed') AS INTEGER) - CAST(json_extract(data,'$.time.created') AS INTEGER) ELSE 0 END),0) AS ms FROM ${schema.message} WHERE time_created >= ${startMs} AND time_created < ${aNow} GROUP BY COALESCE(json_extract(data,'$.agent'),'unknown')`) || [])) {
    msgAgentAgg[m.agent] = { o: m.o, ms: m.ms };
  }
  const periodDays = {};
  for (const [key, val] of Object.entries(a.perDay)) {
    const dayMs = val.date.getTime();
    if (days === -1 || dayMs >= startMs) periodDays[key] = val;
  }
  // Sum totals from periodDays (not all-time a.totals)
  const pdVals = Object.values(periodDays);
  const periodTotals = { sessions: new Set(), messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const pd of pdVals) {
    for (const sid of pd.sessions) periodTotals.sessions.add(sid);
    periodTotals.messages += pd.messages;
    periodTotals.input += pd.input; periodTotals.output += pd.output; periodTotals.reasoning += pd.reasoning;
    periodTotals.cacheRead += pd.cacheRead; periodTotals.cacheWrite += pd.cacheWrite; periodTotals.cost += pd.cost;
  }
  const t = periodTotals;
  const activeDays = pdVals.length || 1;
  // Avg/median over the PERIOD's token-bearing sessions — period buckets, so
  // Daily/Weekly differ and the value matches the card and the tables.
  const periodSessionIds = [...periodTotals.sessions];
  const sessVals = periodSessionIds
    .map((sid) => (a.perSessionPeriod || a.perSession)[sid])
    .filter((s) => s && (s.input > 0 || s.output > 0 || s.reasoning > 0))
    .map((s) => s.input + s.output + s.reasoning)
    .filter(Number.isFinite);
  const avgTokens = sessVals.length ? sessVals.reduce((x, v) => x + v, 0) / sessVals.length : 0;
  const statsR = {
    ok: true,
    overview: { sessions: t.sessions.size, messages: t.messages, days: activeDays },
    cost: {
      total: t.cost, avgDay: t.cost / activeDays,
      avgTokensSession: Math.round(avgTokens),
      medianTokensSession: Math.round(computeMedian(sessVals)),
      input: Math.round(t.input), output: Math.round(t.output),
      reasoning: Math.round(t.reasoning),
      cacheRead: Math.round(t.cacheRead), cacheWrite: Math.round(t.cacheWrite),
    },
    tools: [], models: [],
  };
  const r4 = (v) => Math.round((v || 0) * 10000) / 10000;

  // Rebuild per-agent and per-model for the period from session-table meta
  // (perSession doesn't store agent/model). periodSessionIds was computed
  // above for avg/median.
  if (periodSessionIds.length) {
    const placeholders = periodSessionIds.map(() => '?').join(',');
    const sessMeta = dbQuery(`SELECT id, agent, COALESCE(json_extract(model,'$.providerID'),'unknown') AS provider, COALESCE(json_extract(model,'$.id'),'unknown') AS model, title, time_created AS tc, time_updated AS tu FROM ${schema.session} WHERE id IN (${placeholders})`, periodSessionIds) || [];
    const metaMap = {};
    for (const s of sessMeta) metaMap[s.id] = s;

    const sessRows = [];
    for (const sid of periodSessionIds) {
      const meta = metaMap[sid] || { agent: 'unknown', provider: 'unknown', model: 'unknown', tc: 0, tu: 0 };
      const mg = msgAgg[sid] || { n: 0, o: 0, ms: 0, rq: 0 };
      const sm = (a.perSessionModelPeriod && a.perSessionModelPeriod[sid]) || null;
      sessRows.push({ sid, meta, ps: a.perSessionPeriod ? a.perSessionPeriod[sid] : a.perSession[sid], mg, sm });
    }

    // Providers/agents come straight from the period buckets (message tokens
    // under the message's own model; residual under the session's), so their
    // columns sum EXACTLY to the summary card by construction.
    var pProviderRows = Object.entries(a.perModelPeriod)
      .map(([name, m]) => {
        const { provider, model } = splitModelName(name);
        const mk = marketOf({ input: m.input, output: m.output, reasoning: m.reasoning, cacheRead: m.cacheRead, cost: m.cost }, provider, model);
        return {
          provider, model, sessions: m.sessions.size, messages: m.messages, cost: r4(m.cost),
          tok_in: Math.round(m.input), tok_out: Math.round(m.output),
          tok_reasoning: Math.round(m.reasoning), cache_read: Math.round(m.cacheRead),
          speed: m.speedMs > 0 ? Math.round((m.speedOut / (m.speedMs / 1000)) * 10) / 10 : null,
          market: mk.market, saved: mk.saved, pricedAs: mk.pricedAs,
        };
      })
      .sort((x, y) => y.cost - x.cost);

    var pAgentRows = Object.entries(a.perAgentPeriod)
      .map(([agent, m]) => {
        let market = 0, saved = 0, priced = false;
        const bag = (a.perAgentModelPeriod && a.perAgentModelPeriod[agent]) || {};
        for (const [name, b] of Object.entries(bag)) {
          const { provider, model } = splitModelName(name);
          const mk = marketOf({ input: b.input, output: b.output, reasoning: b.reasoning, cacheRead: b.cacheRead, cost: b.cost }, provider, model);
          if (mk.market === null) { market = null; break; }
          market += mk.market; saved += mk.saved; priced = true;
        }
        // Wall = period span measured on the message clock (see wallMs above).
        let agentWall = 0;
        for (const sid of m.sessions) agentWall += wallMs[sid] || 0;
        return {
          agent, sessions: m.sessions.size, cost: r4(m.cost),
          tok_in: Math.round(m.input), tok_out: Math.round(m.output),
          tok_reasoning: Math.round(m.reasoning), cache_read: Math.round(m.cacheRead),
          speed: msgAgentAgg[agent] && msgAgentAgg[agent].ms > 0 ? Math.round((msgAgentAgg[agent].o / (msgAgentAgg[agent].ms / 1000)) * 10) / 10 : null,
          wallMs: Math.round(agentWall),
          activeMs: msgAgentAgg[agent] ? Math.round(msgAgentAgg[agent].ms) : 0,
          market: market === null ? null : Math.round(market * 10000) / 10000,
          saved: market === null ? null : Math.round(saved * 10000) / 10000,
          pricedAs: priced,
        };
      })
      .sort((x, y) => y.cost - x.cost);
    var pSessionRows = sessRows
      .map(({ sid, meta, ps, mg, sm }) => {
        // Price by the session's own period model mix when available
        // (message tokens under the message's model), else the session's meta
        // model (residual-only sessions).
        let market = null, saved = null, pricedAs = null, prov = meta.provider || 'unknown', mod = meta.model || 'unknown';
        const bag = sm || null;
        if (bag && Object.keys(bag).length) {
          const name = Object.keys(bag).sort((a, b) => {
            const va = bag[a].input + bag[a].output + bag[a].cacheRead;
            const vb = bag[b].input + bag[b].output + bag[b].cacheRead;
            return vb - va;
          })[0];
          const sp = splitModelName(name);
          prov = sp.provider; mod = sp.model;
        }
        const mkS = marketOf({ input: ps.input, output: ps.output, reasoning: mg.rq || 0, cacheRead: ps.cacheRead, cost: ps.cost }, prov, mod);
        market = mkS.market; saved = mkS.saved; pricedAs = mkS.pricedAs;
        // Wall from the message clock (see wallMs above).
        return {
          id: sid, title: (meta.title || '').slice(0, 40), agent: meta.agent || 'unknown',
          provider: prov, model: mod,
          wallMs: wallMs[sid] || 0,
          activeMs: mg.ms || 0, messages: mg.n || 0,
          tok_in: Math.round(ps.input), tok_out: Math.round(ps.output),
          tok_reasoning: Math.round(mg.rq || 0),
          cost: r4(ps.cost),
          speed: (mg.ms || 0) > 0 ? Math.round(((mg.o || 0) / (mg.ms / 1000)) * 10) / 10 : null,
          market, saved, pricedAs,
        };
      })
      .sort((x, y) => y.activeMs - x.activeMs)
      .slice(0, 20);
  } else {
    var pAgentRows = [];
    var pProviderRows = [];
    var pSessionRows = [];
  }

  // Period market = Σ provider rows (already period-scoped); saved = Σ provider
  // saved so it can never mix a period cost with a lifetime market.
  const sumMkt = (rows) => rows.reduce((s, r) => s + (r.market || 0), 0);
  const sumSaved = (rows) => rows.reduce((s, r) => s + (r.saved || 0), 0);
  statsR.cost.marketTotal = Math.round(sumMkt(pProviderRows) * 10000) / 10000;
  statsR.cost.savedTotal = Math.round(sumSaved(pProviderRows) * 10000) / 10000;
  statsR.cost.savedPct = statsR.cost.marketTotal > 0 ? Math.round((statsR.cost.savedTotal / statsR.cost.marketTotal) * 1000) / 10 : null;
  statsR.cost.priceAsOf = pricing.catalogInfo().ok ? new Date(pricing.catalogInfo().mtimeMs).toISOString() : null;

  return {
    label,
    days,
    stats: statsR,
    agents: pAgentRows,
    providers: pProviderRows,
    sessions: pSessionRows,
    priceAsOf: statsR.cost.priceAsOf,
    generatedAt: now,
  };
}

function refreshReport(days) {
  const key = String(days);
  const hit = reportCache[key];
  const fresh = hit && Date.now() - hit.generatedAt < REPORT_TTL;
  if (fresh) return { report: hit, ready: true };
  if (!reportBusy[key]) {
    reportBusy[key] = true;
    setImmediate(() => {
      try {
        const r = buildReportFromDb(days);
        if (r && r.stats && r.stats.ok) {
          reportCache[key] = r;
        }
      } catch (_) {} finally {
        delete reportBusy[key];
      }
    });
  }
  return hit ? { report: Object.assign({}, hit, { stale: true }), ready: true } : { report: null, ready: false };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const u = url.pathname;

  // Gzip compress JSON responses
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const useGzip = acceptEncoding.includes('gzip') && u.startsWith('/api/');
  const respond = (data, headers = {}) => {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (useGzip && payload.length > 512) {
      res.setHeader('Content-Encoding', 'gzip');
      const compressed = zlib.gzipSync(Buffer.from(payload), { level: 1 });
      res.end(compressed);
    } else {
      res.end(payload);
    }
  };

  if (u === '/api/stats') {
    const days = parseInt(url.searchParams.get('days') || '7', 10) || 7;
    const r = refreshTrend(days);
    respond({
      ok: !!state.data,
      loading: state.loading,
      error: state.error,
      generatedAt: state.updatedAt,
      data: state.data,
      models: state.models,
      trend: r.trend,
      trendReady: !!r.trend,
    });
  } else if (u === '/api/report') {
    const daysParam = url.searchParams.get('days');
    const days = daysParam !== null ? (parseInt(daysParam, 10) || 0) : 0;
    const r = refreshReport(days);
    respond({
      ok: true,
      ready: r.ready,
      report: r.report,
    });
  } else if (u === '/api/backup') {
    performBackup(false).then((r) => { respond(r); });
  } else if (u === '/api/backups') {
    try {
      const dirs = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('opencode-') && fs.statSync(path.join(BACKUP_DIR, f)).isDirectory())
        .sort().reverse()
        .map((f) => {
          const dirPath = path.join(BACKUP_DIR, f);
          const files = fs.readdirSync(dirPath);
          let totalSize = 0;
          for (const file of files) totalSize += fs.statSync(path.join(dirPath, file)).size;
          return { name: f, size: totalSize, files };
        });
      respond({ ok: true, backups: dirs, retention: BACKUP_RETENTION });
    } catch (e) { respond({ ok: false, error: e.message }); }
  } else if (u === '/api/vacuum') {
    if (!Database) { respond({ ok: false, error: 'better-sqlite3 not available' }); return; }
    if (backupBusy || vacuumBusy) { respond({ ok: false, busy: true, error: 'backup or vacuum already running' }); return; }
    vacuumBusy = true;
    try {
      const sizeBefore = fs.statSync(BACKUP_SRC).size;
      const probe = new Database(BACKUP_SRC, { readonly: true, fileMustExist: true, timeout: 5000 });
      let freelist = 0, pageSize = 4096, pageCount = 0;
      try {
        freelist = probe.prepare('PRAGMA freelist_count').get().freelist_count || 0;
        pageSize = probe.prepare('PRAGMA page_size').get().page_size || 4096;
        pageCount = probe.prepare('PRAGMA page_count').get().page_count || 0;
      } finally { probe.close(); }
      const reclaimable = freelist * pageSize;
      if (reclaimable < 64 * 1024 * 1024) {
        vacuumBusy = false;
        console.log(`vacuum skipped: freelist ${(reclaimable / 1024 / 1024).toFixed(1)} MB < 64 MB (nothing to reclaim)`);
        respond({ ok: false, skipped: true, reason: 'freelist too small, nothing to reclaim', freelistBytes: reclaimable, pageCount, pageSize });
        return;
      }
      const d = new Database(BACKUP_SRC, { timeout: 15000 });
      try { d.pragma('busy_timeout = 15000'); d.pragma('VACUUM'); } finally { d.close(); }
      const sizeAfter = fs.statSync(BACKUP_SRC).size;
      const saved = sizeBefore - sizeAfter;
      console.log(`vacuum ok: ${(sizeBefore / 1024 / 1024).toFixed(1)} MB -> ${(sizeAfter / 1024 / 1024).toFixed(1)} MB (saved ${(saved / 1024 / 1024).toFixed(1)} MB)`);
      respond({ ok: true, before: sizeBefore, after: sizeAfter, saved });
    } catch (e) { respond({ ok: false, error: e.message }); } finally { vacuumBusy = false; }
  } else if (u === '/api/db-info') {
    try {
      const dbPath = BACKUP_SRC;
      const dbDir = path.dirname(dbPath);
      const files = ['opencode.db', 'opencode.db-wal', 'opencode.db-shm']
        .filter((n) => fs.existsSync(path.join(dbDir, n)))
        .map((n) => { const stat = fs.statSync(path.join(dbDir, n)); return { name: n, size: stat.size, modified: stat.mtime }; });
      const totalSize = files.reduce((s, f) => s + f.size, 0);
      let pragma = null;
      if (Database && fs.existsSync(dbPath)) {
        try {
          const probe = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
          try {
            const freelist = probe.prepare('PRAGMA freelist_count').get().freelist_count || 0;
            const pageSize = probe.prepare('PRAGMA page_size').get().page_size || 4096;
            const pageCount = probe.prepare('PRAGMA page_count').get().page_count || 0;
            pragma = { freelistBytes: freelist * pageSize, pageCount, pageSize };
          } finally { probe.close(); }
        } catch (_) {}
      }
      respond({ ok: true, path: dbPath, files, totalSize, pragma });
    } catch (e) { respond({ ok: false, error: e.message }); }
  } else if (u === '/') {
    loadIndexHtml((err, data) => {
      if (err) {
        res.statusCode = 500;
        res.end('Internal Server Error');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(data.replace('__VERSION__', VERSION));
    });
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

function gracefulShutdown() {
  console.log('\nShutting down...');
  if (db) try { db.close(); } catch (_) {}
  server.close(() => { process.exit(0); });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (e) => { console.error('uncaught:', e.message || e); });
process.on('unhandledRejection', (e) => { console.error('unhandled:', e && e.message ? e.message : e); });

// Keep process alive even if all timers are cleared
process.title = 'opencode-dashboard';
process.stdin.resume();

setInterval(() => {
  try { cleanExpiredCache(trendCache, TREND_MS * 2); } catch (_) {}
  try { cleanExpiredCache(reportCache, REPORT_TTL * 2); } catch (_) {}
  try { autoBackupIfDue(); } catch (_) {}
}, CACHE_CLEANUP_MS);

function tryListen(port, maxPort) {
  return new Promise((resolve) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.log(`port ${port} in use, trying ${port + 1}...`);
        server.removeAllListeners('error');
        if (port < (maxPort || port + 5)) {
          resolve(tryListen(port + 1, maxPort));
        } else {
          console.error(`all ports ${PORT}-${maxPort || PORT + 5} in use`);
          process.exit(1);
        }
      } else {
        console.error(e);
        process.exit(1);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`opencode stats dashboard: http://127.0.0.1:${port}`);
      resolve(port);
    });
  });
}

(async () => {
  try {
    const actualPort = await tryListen(PORT, PORT + 5);
    setInterval(refresh, REFRESH_MS);
    setInterval(refreshModels, 60000);
    await refresh();
    await refreshModels();
    for (const d of [1, 7, 30]) {
      try {
        const r = buildReportFromDb(d);
        if (r && r.stats && r.stats.ok) reportCache[String(d)] = r;
      } catch (_) {}
    }
    for (const d of [7, 30, 90]) {
      try {
        const t = await generateTrend(d);
        if (t) trendCache[String(d)] = t;
      } catch (_) {}
    }
    // Defer backup to avoid heavy disk I/O during startup
    // (Windows may kill process for excessive I/O on large DB files).
    setTimeout(() => {
      autoBackupIfDue().catch((_) => {});
    }, 30000);
  } catch (e) {
    console.error('startup error:', e.message || e);
  }
})();
