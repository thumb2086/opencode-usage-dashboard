#!/usr/bin/env node
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Worker } = require('worker_threads');
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
// froze at the upgrade. The V2 migration is LOSSY, so merge ??never switch:
// - 455/734 migrated sessions LOST their lifetime totals (196M input tokens):
//   V2 recomputed them from surviving messages, dropping pruned compaction
//   history (sessions whose messages were fully pruned went to 0). V1's frozen
//   totals are the authoritative record, so take per-field MAX of the shared
//   rows (same lifetime counter ??never SUM, that would double count).
// - 30 messages were never migrated (4.3M input tokens) ??union them in.
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
  // the same object the usage report uses) ??never a separate windowed
  // attributeUsage call. Windowed attribution inflates in-window days:
  // messages before the window are excluded from msgTok, so the session
  // residual grows and lands entirely on windowed days (measured
  // +0.25??.7M input/day on 2026-09-29). One shared attribution makes
  // trend buckets and report periods structurally identical; any remaining
  // panel difference is only cache age (trend ??0s, report ??0min, both
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
// market minus actual cost. kind is 'exact' | 'sibling' | 'proxy' ??how the
// rate was found; null (kind 'unpriced') when the catalog has NO comparable
// paid listing, in which case we report no money at all rather than inventing
// a rate (that fake rate once turned a $0 model into $212 of phantom savings).
// Market-price engine rules live in pricing.js (shared with check scripts).
function marketOf(tok, provider, model) {
  const pr = pricing.priceFor(provider, model);
  if (!pr) return { market: null, saved: null, pricedAs: null, priced: false, kind: 'unpriced' };
  const market = pricing.marketOf(tok, pr);
  const r4m = (v) => Math.round(v * 10000) / 10000;
  return { market: r4m(market), saved: r4m(market - (tok.cost || 0)), pricedAs: pr.source, priced: true, kind: pr.kind };
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
// by the session's model/agent ??so per-model report rows sum exactly to the
// period totals (self-consistent by construction).
// Hybrid attribution over [startMs, endMs), message layer + session residual.
//
// PERFORMANCE (measured 2026-10-11 on 62k messages / 993MB of JSON):
// message rows are fetched as raw `data` and parsed ONCE in Node. Doing the
// same work with a dozen json_extract() calls per row costs 43.6s in SQLite
// (it re-parses the whole content blob for every call) versus 1.6s + 0.9s
// this way. Period slices are folded in the same pass, so the trend, the
// overview and every report period share ONE scan per ATTR_TTL instead of
// paying for their own.
//
// Message tokens go to their exact local day; each session's residual
// (session totals minus its message sums, clamped >= 0) is spread across the
// session's full local-day span, weighted by its per-day message volume
// (uniform across spanned days when the session has no messages).
//
// periodStartsMs: optional ARRAY of local-midnight boundaries. Boundaries are
// NESTED (today ⊂ 7d ⊂ MTD ⊂ all), so a day feeds every boundary at or
// before it. Per-period buckets group message tokens by the MESSAGE's own
// model/agent and spread residual by the session's, so report rows sum
// exactly to the period totals. Each slice also carries msgAgg (per session:
// message count, output, reasoning, active ms, wall span on the MESSAGE clock)
// and msgAgentAgg, so reports need no extra queries.
const ATTR_TTL = 300000;
// Tool counts change slowly but the embedded-content scan costs ~2.8s on a
// 2.7GB live DB, so it is computed by the stats WORKER (see spawnAttrWorker)
// and only ever READ here. `fromWorker` marks worker-supplied data, which is
// always as fresh as the last worker round and therefore exempt from TOOLS_TTL.
let toolsCache = null;
let attrWorkerActive = false;
const ATTR_WORKER = path.join(__dirname, 'attr-worker.js');
const yieldToLoop = () => new Promise((r) => setImmediate(r));

function newTokBucket() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}
function addTok(b, iv, ov, rv, crv, cwv, cv) {
  b.input += iv; b.output += ov; b.reasoning += rv; b.cacheRead += crv; b.cacheWrite += cwv; b.cost += cv;
}

async function attributeUsage(startMs, endMs, periodStartsMs) {
  // CRITICAL: open the DB (which runs detectSchema) BEFORE any schema.* value
  // is interpolated into a query. Template literals evaluate left to right, so
  // a query built before the first getDb() would silently use the V1-only
  // defaults and drop every V2 row.
  getDb();
  const starts = (Array.isArray(periodStartsMs) ? periodStartsMs : [periodStartsMs])
    .filter((x) => x != null).sort((a, b) => a - b);

  const perDay = {};
  const perModel = {};
  const perAgent = {};
  const perSession = {};
  const msgTok = {};
  const msgW = {};
  const ensureDay = (key) => perDay[key] || (perDay[key] = { date: dateOfKey(key), sessions: new Set(), messages: 0, ...newTokBucket() });
  const ensureModel = (n) => perModel[n] || (perModel[n] = { messages: 0, sessions: new Set(), ...newTokBucket(), speedOut: 0, speedMs: 0 });
  const ensureAgent = (a) => perAgent[a || 'unknown'] || (perAgent[a || 'unknown'] = { messages: 0, sessions: new Set(), ...newTokBucket() });

  const slices = starts.map((s) => {
    const perModelP = {}, perAgentP = {}, perAgentModelP = {}, perSessionP = {}, perSessionModelP = {};
    const msgAgg = {}, msgAgentAgg = {};
    return {
      start: s,
      perModel: perModelP, perAgent: perAgentP, perAgentModel: perAgentModelP,
      perSession: perSessionP, perSessionModel: perSessionModelP,
      msgAgg, msgAgentAgg,
      model: (n) => perModelP[n] || (perModelP[n] = { messages: 0, sessions: new Set(), ...newTokBucket(), speedOut: 0, speedMs: 0 }),
      agent: (a) => perAgentP[a || 'unknown'] || (perAgentP[a || 'unknown'] = { sessions: new Set(), ...newTokBucket(), speedOut: 0, speedMs: 0 }),
      agentModel: (a, m) => {
        const k = a || 'unknown';
        const bag = perAgentModelP[k] || (perAgentModelP[k] = {});
        return bag[m] || (bag[m] = newTokBucket());
      },
      sess: (sid) => perSessionP[sid] || (perSessionP[sid] = newTokBucket()),
      sessModel: (sid, m) => {
        const bag = perSessionModelP[sid] || (perSessionModelP[sid] = {});
        return bag[m] || (bag[m] = newTokBucket());
      },
    };
  });

  const rows = dbQuery(`SELECT time_created AS t, session_id AS sid, data FROM ${schema.message} WHERE time_created >= ${startMs} AND time_created < ${endMs};`) || [];
  let processed = 0;
  for (const row of rows) {
    let d = null;
    try { d = JSON.parse(row.data); } catch (_) { d = null; }
    processed++;
    if (!d) continue;
    const key = localDayKey(new Date(row.t));
    const dayMs = dateOfKey(key).getTime();
    const tk = d.tokens || {};
    const cache = tk.cache || {};
    const iv = +tk.input || 0, ov = +tk.output || 0, rv = +tk.reasoning || 0;
    const crv = +cache.read || 0, cwv = +cache.write || 0, cv = +d.cost || 0;
    const md = d.model || {};
    const provider = d.providerID || md.providerID || 'unknown';
    const model = d.modelID || md.modelID || md.id || 'unknown';
    const agent = d.agent || 'unknown';
    const mName = `${provider || 'unknown'}/${model || 'unknown'}`;
    const dm = d.time || {};
    const t0 = +dm.created || 0, t1 = +dm.completed || 0;
    const hasDur = ov > 0 && t1 > t0;

    const D = ensureDay(key);
    D.messages++;
    if (row.sid) D.sessions.add(row.sid);
    addTok(D, iv, ov, rv, crv, cwv, cv);
    const M = ensureModel(mName);
    M.messages++;
    if (row.sid) M.sessions.add(row.sid);
    addTok(M, iv, ov, rv, crv, cwv, cv);
    if (hasDur) { M.speedOut += ov; M.speedMs += (t1 - t0); }
    const A = ensureAgent(agent);
    A.messages++;
    if (row.sid) A.sessions.add(row.sid);
    addTok(A, iv, ov, rv, crv, cwv, cv);

    if (row.sid) {
      const mt = msgTok[row.sid] || (msgTok[row.sid] = newTokBucket());
      addTok(mt, iv, ov, rv, crv, cwv, cv);
      const w = msgW[row.sid] || (msgW[row.sid] = { total: 0, perDay: {} });
      const vol = iv + ov + rv + crv + cwv;
      w.total += vol;
      w.perDay[key] = (w.perDay[key] || 0) + vol;
    }

    for (const sl of slices) {
      if (dayMs < sl.start) continue;
      const MP = sl.model(mName);
      MP.messages++;
      if (row.sid) MP.sessions.add(row.sid);
      addTok(MP, iv, ov, rv, crv, cwv, cv);
      if (hasDur) { MP.speedOut += ov; MP.speedMs += (t1 - t0); }
      const AP = sl.agent(agent);
      if (row.sid) AP.sessions.add(row.sid);
      addTok(AP, iv, ov, rv, crv, cwv, cv);
      if (hasDur) { AP.speedOut += ov; AP.speedMs += (t1 - t0); }
      addTok(sl.agentModel(agent, mName), iv, ov, rv, crv, cwv, cv);
      if (row.sid) {
        addTok(sl.sess(row.sid), iv, ov, rv, crv, cwv, cv);
        addTok(sl.sessModel(row.sid, mName), iv, ov, rv, crv, cwv, cv);
        const ma = sl.msgAgg[row.sid] || (sl.msgAgg[row.sid] = { n: 0, o: 0, rq: 0, ms: 0, w0: Infinity, w1: 0 });
        ma.n++;
        if (hasDur) { ma.o += ov; ma.rq += rv; ma.ms += (t1 - t0); }
        if (row.t < ma.w0) ma.w0 = row.t;
        if (t1 > ma.w1) ma.w1 = t1;
      }
      const ag = sl.msgAgentAgg[agent] || (sl.msgAgentAgg[agent] = { o: 0, ms: 0 });
      if (hasDur) { ag.o += ov; ag.ms += (t1 - t0); }
    }
    if ((processed & 0x3fff) === 0) await yieldToLoop();
  }

  const srows = dbQuery(`SELECT id, agent, COALESCE(json_extract(model, '$.providerID'), 'unknown') AS provider, COALESCE(json_extract(model, '$.id'), 'unknown') AS model, time_created AS tc, time_updated AS tu, tokens_input AS si, tokens_output AS so, tokens_reasoning AS sr, tokens_cache_read AS scr, tokens_cache_write AS scw, cost AS sc FROM ${schema.session} WHERE time_updated >= ${startMs} AND time_created < ${endMs};`) || [];
  let sessProcessed = 0;
  for (const s of srows) {
    const d0 = new Date(new Date(s.tc).setHours(0, 0, 0, 0));
    const d1 = new Date(new Date(s.tu).setHours(0, 0, 0, 0));
    const spanKeys = [];
    for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) spanKeys.push(localDayKey(d));
    if (!spanKeys.length) { sessProcessed++; continue; }
    const mt = msgTok[s.id] || newTokBucket();
    const res = {
      input: Math.max(0, (+s.si || 0) - mt.input),
      output: Math.max(0, (+s.so || 0) - mt.output),
      reasoning: Math.max(0, (+s.sr || 0) - mt.reasoning),
      cacheRead: Math.max(0, (+s.scr || 0) - mt.cacheRead),
      cacheWrite: Math.max(0, (+s.scw || 0) - mt.cacheWrite),
      cost: Math.max(0, (+s.sc || 0) - mt.cost),
    };
    const ps = perSession[s.id] || (perSession[s.id] = { ...mt });
    const w = msgW[s.id];
    let wTotal = 0;
    if (w) { for (const k of spanKeys) wTotal += w.perDay[k] || 0; }
    if (wTotal > 0) {
      for (const k of spanKeys) if ((w.perDay[k] || 0) > 0) ensureDay(k).sessions.add(s.id);
    } else {
      ensureDay(localDayKey(new Date(s.tu))).sessions.add(s.id);
    }
    const mName = `${s.provider || 'unknown'}/${s.model || 'unknown'}`;
    const aName = s.agent || 'unknown';
    for (const k of spanKeys) {
      const share = wTotal > 0 ? ((w.perDay[k] || 0) / wTotal) : 1 / spanKeys.length;
      if (share === 0) continue;
      const D = ensureDay(k);
      const di = res.input * share, dout = res.output * share, dr = res.reasoning * share;
      const dcr = res.cacheRead * share, dcw = res.cacheWrite * share, dc = res.cost * share;
      addTok(D, di, dout, dr, dcr, dcw, dc);
      const M = ensureModel(mName);
      addTok(M, di, dout, dr, dcr, dcw, dc);
      const A = ensureAgent(aName);
      addTok(A, di, dout, dr, dcr, dcw, dc);
      addTok(ps, di, dout, dr, dcr, dcw, dc);
      const dayMs = D.date.getTime();
      for (const sl of slices) {
        if (dayMs < sl.start) continue;
        addTok(sl.model(mName), di, dout, dr, dcr, dcw, dc);
        addTok(sl.agent(aName), di, dout, dr, dcr, dcw, dc);
        addTok(sl.agentModel(aName, mName), di, dout, dr, dcr, dcw, dc);
        addTok(sl.sess(s.id), di, dout, dr, dcr, dcw, dc);
        addTok(sl.sessModel(s.id, mName), di, dout, dr, dcr, dcw, dc);
      }
    }
    if ((++sessProcessed & 0x3f) === 0) await yieldToLoop();
  }

  const totals = { sessions: Object.keys(perSession).length, messages: 0, ...newTokBucket() };
  for (const k of Object.keys(perDay)) {
    const D = perDay[k];
    totals.messages += D.messages;
    addTok(totals, D.input, D.output, D.reasoning, D.cacheRead, D.cacheWrite, D.cost);
  }

  const out = { perDay, perModel, perAgent, perSession, totals, periods: new Map() };
  for (const sl of slices) {
    // Every slice also carries the all-time day buckets: the report sums its
    // periodDays off perDay, and period 0 (all-time) IS the all-time view.
    out.periods.set(sl.start, {
      start: sl.start,
      perDay,
      perModelPeriod: sl.perModel,
      perAgentPeriod: sl.perAgent,
      perAgentModelPeriod: sl.perAgentModel,
      perSessionPeriod: sl.perSession,
      perSessionModelPeriod: sl.perSessionModel,
      msgAgg: sl.msgAgg,
      msgAgentAgg: sl.msgAgentAgg,
    });
    if (sl.start === 0) {
      // period 0 == all-time: expose the bucket names the report reads.
      out.perModelPeriod = sl.perModel;
      out.perAgentPeriod = sl.perAgent;
      out.perAgentModelPeriod = sl.perAgentModel;
      out.perSessionPeriod = sl.perSession;
      out.perSessionModelPeriod = sl.perSessionModel;
      out.msgAgg = sl.msgAgg;
      out.msgAgentAgg = sl.msgAgentAgg;
    }
  }
  return out;
}

// ---- shared attribution bundle cache ----------------------------------
// One scan serves overview, trend and every report period. Memoized ATTR_TTL;
// rebuilds run detached (and yield internally), so request handlers never pay
// for the scan inline and the UI stays responsive while it happens.
let attrAllCache = null;
let attrBundlePending = false;
let attrLastSave = 0;
const EMPTY_ATTR = {
  perDay: {}, perModel: {}, perAgent: {}, perSession: {},
  totals: { sessions: 0, messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  periods: new Map(), msgAgg: {}, msgAgentAgg: {},
};
function periodStartsFor(now) {
  return {
    1: periodStartMs(1, now),
    7: periodStartMs(7, now),
    30: periodStartMs(30, now),
    '-1': 0,
  };
}
async function buildAttrBundle(now) {
  const a = await attributeUsage(0, now, Object.values(periodStartsFor(now)));
  a.byPeriodStart = periodStartsFor(now);
  return a;
}

// ---- on-disk bundle cache ---------------------------------------------
// Scanning the live DB costs 5–26s (WAL + concurrent opencode writes), so the
// computed bundle is persisted and loaded on startup; a stale bundle still
// serves every request while a fresh one is rebuilt in the background.
const BUNDLE_FILE = path.join(__dirname, '.attr-bundle.json');
const BUNDLE_SAVE_MS = 60000; // don't hammer the disk while chatting
// Cache is bound to the exact database it was computed from, so pointing
// OPENCODE_DATA at another DB (tests, a restored copy) never reuses it.
function dbFingerprint() {
  try {
    const st = fs.statSync(BACKUP_SRC);
    return `${BACKUP_SRC}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch (_) { return BACKUP_SRC; }
}
function serializeBundle(a, tools) {
  // MUST NOT mutate: the caller serializes the LIVE bundle, and swapping a
  // bucket's `sessions` Set for an array in place would break every later
  // `.sessions.size` read (arrays have no .size).
  const setToArr = (obj) => {
    const out = {};
    for (const k of Object.keys(obj || {})) {
      const v = obj[k];
      out[k] = (v && v.sessions) ? { ...v, sessions: [...v.sessions] } : v;
    }
    return out;
  };
  const days = {};
  for (const [k, v] of Object.entries(a.perDay)) days[k] = { ...v, dateMs: +v.date, date: undefined, sessions: [...v.sessions] };
  const periods = {};
  for (const [s, sl] of a.periods) periods[s] = {
    ...sl,
    perModelPeriod: setToArr(sl.perModelPeriod),
    perAgentPeriod: setToArr(sl.perAgentPeriod),
  };
  return JSON.stringify({
    v: 2, builtAt: a.builtAt, db: dbFingerprint(), byPeriodStart: a.byPeriodStart,
    tools: tools ? { embedded: tools.embedded, startMs: tools.startMs, counts: tools.counts } : null,
    perDay: days,
    perModel: setToArr(a.perModel), perAgent: setToArr(a.perAgent),
    perSession: a.perSession, totals: a.totals, periods,
    perModelPeriod: setToArr(a.perModelPeriod), perAgentPeriod: setToArr(a.perAgentPeriod),
    perAgentModelPeriod: a.perAgentModelPeriod, perSessionPeriod: a.perSessionPeriod,
    perSessionModelPeriod: a.perSessionModelPeriod,
    msgAgg: a.msgAgg, msgAgentAgg: a.msgAgentAgg,
  });
}
function reviveBundle(o) {
  const fixDays = (d) => {
    const out = {};
    for (const [k, v] of Object.entries(d)) out[k] = { ...v, date: new Date(v.dateMs), dateMs: undefined, sessions: new Set(v.sessions) };
    return out;
  };
  const fixSets = (obj) => {
    const out = {};
    for (const k of Object.keys(obj || {})) {
      const v = obj[k];
      out[k] = (v && Array.isArray(v.sessions)) ? { ...v, sessions: new Set(v.sessions) } : v;
    }
    return out;
  };
  const periods = new Map();
  for (const [s, sl] of Object.entries(o.periods || {})) {
    periods.set(+s, { ...sl, perDay: fixDays(o.perDay), perModelPeriod: fixSets(sl.perModelPeriod), perAgentPeriod: fixSets(sl.perAgentPeriod) });
  }
  const a = {
    ...o,
    perDay: fixDays(o.perDay),
    perModel: fixSets(o.perModel), perAgent: fixSets(o.perAgent),
    perModelPeriod: fixSets(o.perModelPeriod), perAgentPeriod: fixSets(o.perAgentPeriod),
    periods,
  };
  return a;
}
function saveBundleCache(a, tools) {
  try { fs.writeFileSync(BUNDLE_FILE, serializeBundle(a, tools)); } catch (_) {}
}
function loadBundleCache() {
  try {
    const raw = fs.readFileSync(BUNDLE_FILE, 'utf8');
    const o = JSON.parse(raw);
    if (o && o.v === 2 && o.db === dbFingerprint() && o.periods && Object.keys(o.periods).length) {
      console.log(`attr bundle loaded from cache (built ${Math.round((Date.now() - o.builtAt) / 60000)} min ago)`);
      // Tool counts ride along so a cold start paints complete numbers before
      // the first worker round lands.
      if (o.tools && o.tools.counts) {
        toolsCache = { at: o.builtAt, embedded: o.tools.embedded, startMs: 0, counts: o.tools.counts, fromWorker: true };
      }
      return { at: o.builtAt, a: reviveBundle(o) };
    }
  } catch (_) {}
  return null;
}
function getAttrAll() {
  if (!attrAllCache) refreshAttrBundle();
  return attrAllCache ? attrAllCache.a : EMPTY_ATTR;
}
function getAttrPeriod(startMs) {
  if (!attrAllCache) refreshAttrBundle();
  if (!attrAllCache) return EMPTY_ATTR;
  return attrAllCache.a.periods.get(startMs) || attrAllCache.a;
}
// Kick a fresh scan. The scan runs in a WORKER THREAD because it is
// synchronous better-sqlite3 + JSON work: inline it froze the event loop for
// 3-29s on a contended 2.7GB WAL DB, which is exactly what made cold starts
// and scope clicks feel slow. The worker posts back the same JSON the disk
// cache stores, so the swap-in path is identical either way.
function refreshAttrBundle() {
  if (attrBundlePending) return attrAllCache ? attrAllCache.a : null;
  const now = Date.now();
  if (attrAllCache && now - attrAllCache.at < ATTR_TTL) return attrAllCache.a;
  attrBundlePending = true;
  attrWorkerActive = true;
  spawnAttrWorker(now);
  return attrAllCache ? attrAllCache.a : null;
}

const attrBundleWaiters = [];
function waitForBundle(timeoutMs) {
  if (attrAllCache) return Promise.resolve(attrAllCache);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(attrAllCache); } };
    const t = setTimeout(finish, timeoutMs || 120000);
    attrBundleWaiters.push(finish);
  });
}

function spawnAttrWorker(now) {
  // Failure path: unblock waiters and, on a truly cold start, build inline so
  // the dashboard still shows numbers.
  function failBundle(msg) {
    if (!attrBundlePending) return;
    attrBundlePending = false;
    attrWorkerActive = false;
    console.error('attr worker failed:', msg);
    const waiters = attrBundleWaiters.splice(0);
    for (const f of waiters) f();
    if (!attrAllCache) {
      buildAttrBundle(now).then((a) => {
        a.builtAt = now;
        attrAllCache = { at: now, a };
        settleBundle(now, `built inline in ${Date.now() - now}ms (worker unavailable)`);
      }).catch((e) => console.error('inline bundle failed:', e && e.message));
    }
  }
  let w;
  try {
    w = new Worker(ATTR_WORKER, { workerData: { now, toolsStartMs: 0 } });
  } catch (e) {
    // Worker unavailable (very old Node / restricted env): build inline.
    console.error('attr worker spawn failed, building inline:', e.message);
    failBundle(e.message);
    return;
  }
  let settled = false;
  w.on('message', (m) => {
    if (settled) return;
    settled = true;
    try { w.terminate(); } catch (_) {}
    if (!m || !m.ok) return failBundle((m && m.error) || 'unknown worker error');
    try {
      const a = reviveBundle(JSON.parse(m.json));
      a.builtAt = m.builtAt;
      attrAllCache = { at: m.builtAt, a };
      if (m.tools) {
        toolsCache = { at: m.builtAt, embedded: m.tools.embedded, startMs: 0, counts: m.tools.counts, fromWorker: true };
      }
      settleBundle(m.builtAt, `rebuilt in ${Date.now() - m.builtAt}ms (worker)`);
    } catch (e) {
      failBundle('bad worker payload: ' + (e && e.message));
    }
  });
  w.on('error', (e) => { if (!settled) { settled = true; failBundle(e && e.message); } });
  // A worker that posted its result exits 0 right after; only an unsettled
  // exit is a failure.
  w.on('exit', (code) => { if (!settled) { settled = true; failBundle('worker exited with code ' + code); } });
}

function settleBundle(now, msg) {
  attrBundlePending = false;
  attrWorkerActive = false;
  console.log(`attr bundle ${msg}`);
  if (now - (attrLastSave || 0) > BUNDLE_SAVE_MS) {
    attrLastSave = now;
    saveBundleCache(attrAllCache.a, toolsCache);
  }
  const waiters = attrBundleWaiters.splice(0);
  for (const f of waiters) f();
  // A brand-new bundle changes the numbers behind every panel; repaint now
  // instead of waiting for the next 15s tick.
  if (typeof refresh === 'function') Promise.resolve(refresh()).catch(() => {});
  // The default scope is the first thing on screen: build it the moment the
  // bundle lands so the opening view never shows a "generating" spinner.
  setImmediate(() => {
    try {
      const r = buildReportFromDb(1);
      if (r && r.stats && r.stats.ok) reportCache['1'] = r;
    } catch (_) {}
  });
}

// Pure tool-count scan (no cache side effects) so the worker can run it.
function scanToolCounts(startMs) {
  getDb(); // detectSchema must run before schema.embeddedTools is read
  const timeFilterPart = startMs ? `AND p.time_updated >= ${startMs}` : '';
  const toolRows = schema.embeddedTools
    ? dbQuery(`SELECT COALESCE(json_extract(je.value, '$.tool'), json_extract(je.value, '$.name')) AS tool FROM session_message sm, json_each(json_extract(sm.data, '$.content')) je WHERE json_extract(je.value, '$.type') = 'tool' ${startMs ? `AND sm.time_updated >= ${startMs}` : ''}
        UNION ALL
        SELECT json_extract(p.data, '$.tool') AS tool FROM part p WHERE json_extract(p.data, '$.type') = 'tool' AND p.message_id NOT IN (SELECT id FROM session_message) ${startMs ? `AND p.time_updated >= ${startMs}` : ''};`) || []
    : dbQuery(`SELECT json_extract(p.data, '$.tool') AS tool FROM part p WHERE json_extract(p.data, '$.type') = 'tool' ${timeFilterPart};`) || [];
  const counts = {};
  for (const row of toolRows) {
    if (row.tool) counts[row.tool] = (counts[row.tool] || 0) + 1;
  }
  return counts;
}

// Read side: prefer worker-supplied counts; NEVER scan inline while a worker
// round is in flight (a few seconds of empty tools beats a frozen UI).
function toolCountsFor(now, startMs) {
  const hit = toolsCache;
  if (hit && hit.startMs === startMs && hit.embedded === schema.embeddedTools
      && (hit.fromWorker || now - hit.at <= TOOLS_TTL)) {
    return hit.counts;
  }
  if (attrWorkerActive || (hit && hit.startMs === startMs)) return (hit && hit.counts) || {};
  toolsCache = { at: now, embedded: schema.embeddedTools, startMs, counts: scanToolCounts(startMs) };
  return toolsCache.counts;
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
  // querying all of part would double count ??only parts of messages that
  // were never migrated are added from `part`). Cached (see toolsCache):
  // verification accepts api<=expected, so staleness never fails checks.
  const toolCounts = toolCountsFor(now, startMs);
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
  // priced per MESSAGE model (residual falls back to the session's model) ??  // the same basis as the report providers table. Rows the catalog cannot
  // price are EXCLUDED and disclosed (unpricedTokens/unpricedRows) instead of
  // being valued at a made-up rate; proxyShare is how much of the priced
  // total comes from cross-provider estimates.
  let marketTotal = null, savedTotal = null, priceAsOf = null;
  let unpricedRows = 0, unpricedTokens = 0, proxyMarket = 0;
  {
    const info = pricing.catalogInfo();
    if (info.ok) {
      priceAsOf = new Date(info.mtimeMs).toISOString();
      marketTotal = 0;
      for (const [name, m] of Object.entries(attr.perModel)) {
        const { provider, model } = splitModelName(name);
        const tok = { input: m.input, output: m.output, reasoning: m.reasoning, cacheRead: m.cacheRead, cost: m.cost };
        const mk = marketOf(tok, provider, model);
        if (!mk.priced) {
          unpricedRows++;
          unpricedTokens += tok.input + tok.output + tok.reasoning + tok.cacheRead;
          continue;
        }
        marketTotal += mk.market;
        if (mk.kind === 'proxy') proxyMarket += mk.market;
      }
      marketTotal = Math.round(marketTotal * 10000) / 10000;
      savedTotal = Math.round((marketTotal - T.cost) * 10000) / 10000;
      proxyMarket = Math.round(proxyMarket * 10000) / 10000;
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
      unpricedRows, unpricedTokens, proxyMarket,
      proxyShare: marketTotal > 0 ? Math.round((proxyMarket / marketTotal) * 1000) / 10 : null,
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
  const a = getAttrPeriod(startMs);
  const aNow = attrAllCache ? attrAllCache.at : now; // snapshot time of the shared bundle
  // Message-level stats per session within the period (period speed + active
  // time). One GROUP BY over the merged message view, mapped onto the same
  // session-meta buckets as tokens so row sets stay identical.
  // Wall time must come from the MESSAGE clock, not session.time_updated:
  // subagent/fork sessions are written with time_updated == time_created
  // (same millisecond), which would report ~0 wall for hours of real work.
  // Query the merged message view for the period span per session.
// Speed / active / wall come from the shared attribution bundle (the same
  // message pass that produced these period buckets), so switching scope costs
  // no SQL at all. Wall uses the MESSAGE clock: subagent/fork sessions are
  // written with time_updated == time_created, which would read as ~0 wall.
  const msgAgg = a.msgAgg || {};
  const msgAgentAgg = a.msgAgentAgg || {};
  const wallMs = {};
  for (const sid of Object.keys(msgAgg)) {
    const m = msgAgg[sid];
    const w0 = m.w0 === Infinity ? 0 : m.w0;
    wallMs[sid] = Math.max(0, (+m.w1 || 0) - w0);
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
  // Avg/median over the PERIOD's token-bearing sessions ??period buckets, so
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
          market: mk.market, saved: mk.saved, pricedAs: mk.pricedAs, priced: mk.priced, kind: mk.kind,
        };
      })
      .sort((x, y) => y.cost - x.cost);

    var pAgentRows = Object.entries(a.perAgentPeriod)
      .map(([agent, m]) => {
        let market = 0, saved = 0, pricedAny = false, unpriced = 0, proxy = 0;
        const bag = (a.perAgentModelPeriod && a.perAgentModelPeriod[agent]) || {};
        for (const [name, b] of Object.entries(bag)) {
          const { provider, model } = splitModelName(name);
          const mk = marketOf({ input: b.input, output: b.output, reasoning: b.reasoning, cacheRead: b.cacheRead, cost: b.cost }, provider, model);
          if (!mk.priced) { unpriced++; continue; }
          market += mk.market; saved += mk.saved; pricedAny = true;
          if (mk.kind === 'proxy') proxy += mk.market;
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
          market: pricedAny ? Math.round(market * 10000) / 10000 : null,
          saved: pricedAny ? Math.round(saved * 10000) / 10000 : null,
          pricedAs: pricedAny ? (proxy > 0 && proxy >= market - 0.01 ? 'mixed' : 'exact') : null,
          priced: pricedAny, kind: !pricedAny ? 'unpriced' : (unpriced > 0 ? 'partial' : (proxy > 0 ? 'proxy' : 'exact')),
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
          market, saved, pricedAs, priced: mkS.priced, kind: mkS.kind,
        };
      })
      .sort((x, y) => y.activeMs - x.activeMs)
      .slice(0, 20);
  } else {
    var pAgentRows = [];
    var pProviderRows = [];
    var pSessionRows = [];
  }

  // Period market = 峉 priced provider rows (already period-scoped); saved = 峉
  // provider saved so it can never mix a period cost with a lifetime market.
  // Unpriced rows are disclosed, not valued.
  const sumMkt = (rows) => rows.reduce((s, r) => s + (r.market || 0), 0);
  const sumSaved = (rows) => rows.reduce((s, r) => s + (r.saved || 0), 0);
  statsR.cost.marketTotal = Math.round(sumMkt(pProviderRows) * 10000) / 10000;
  statsR.cost.savedTotal = Math.round(sumSaved(pProviderRows) * 10000) / 10000;
  statsR.cost.savedPct = statsR.cost.marketTotal > 0 ? Math.round((statsR.cost.savedTotal / statsR.cost.marketTotal) * 1000) / 10 : null;
  statsR.cost.priceAsOf = pricing.catalogInfo().ok ? new Date(pricing.catalogInfo().mtimeMs).toISOString() : null;
  statsR.cost.unpricedRows = pProviderRows.filter((r) => !r.priced).length;
  statsR.cost.unpricedTokens = pProviderRows.filter((r) => !r.priced).reduce((s, r) => s + r.tok_in + r.tok_out + r.tok_reasoning + r.cache_read, 0);
  const proxyMkt = pProviderRows.filter((r) => r.kind === 'proxy').reduce((s, r) => s + (r.market || 0), 0);
  statsR.cost.proxyShare = statsR.cost.marketTotal > 0 ? Math.round((proxyMkt / statsR.cost.marketTotal) * 1000) / 10 : null;

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
  // Never build a report from a missing bundle: an all-zero report would sit in
  // the 10-minute cache and blank the whole dashboard until it expires.
  if (!attrAllCache) {
    refreshAttrBundle();
    return { report: null, ready: false };
  }
  if (!reportBusy[key]) {
    reportBusy[key] = true;
    setImmediate(() => {
      try {
        const r = buildReportFromDb(days);
        if (r && r.stats && r.stats.ok) {
          reportCache[key] = r;
        } else {
          console.error(`report build failed for days=${days}`);
        }
      } catch (e) {
        // Never swallow silently: a broken report must not look like "still
        // generating" forever while the frontend retries.
        console.error(`report build threw for days=${days}:`, e && e.stack ? e.stack.split('\n')[0] : e);
      } finally {
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

// Loaded as a MODULE by the stats worker (attr-worker.js): publish the scan
// helpers and bail out before any server-side side effect (listening, timers,
// signal handlers). `bin` points straight at this file, so a normal
// `opencode-dashboard` run always has require.main === module.
if (require.main !== module) {
  module.exports = {
    buildAttrBundle,
    serializeBundle,
    reviveBundle,
    scanToolCounts,
    getEmbeddedToolsFlag: () => schema.embeddedTools,
  };
  return;
}

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
    // Serve the persisted bundle + tool counts IMMEDIATELY. Nothing on this
    // path touches the live DB, so the first request answers in milliseconds
    // instead of waiting out a 3-29s scan.
    const cached = loadBundleCache();
    attrAllCache = cached || null;
    getDb(); // detect schema now, so the worker result lands on a warm handle
    // Spawn the fresh scan BEFORE the first refresh: while it is in flight the
    // request thread never runs the inline tool scan (toolCountsFor skips it).
    refreshAttrBundle();
    await refresh();
    await refreshModels();
    if (!cached) {
      // No cache file yet (first run on this machine): there is nothing to
      // serve until the worker's first result arrives.
      await waitForBundle(180000);
      await refresh();
      await refreshModels();
    }
    setInterval(refresh, REFRESH_MS);
    setInterval(refreshModels, 60000);
    setInterval(refreshAttrBundle, 60000);
    // Today's report eagerly (the common first view). Other periods build on
    // demand in the background via refreshReport stale-while-revalidate.
    for (const d of [1]) {
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
    // (Windows may kill process for excessive I/O on large DB files).
    setTimeout(() => {
      autoBackupIfDue().catch((_) => {});
    }, 30000);
  } catch (e) {
    console.error('startup error:', e.message || e);
  }
})();
