#!/usr/bin/env node
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 4868;
const REFRESH_MS = 15000;
const TREND_MS = 10 * 60 * 1000;
const REPORT_TTL = 10 * 60 * 1000;
const CACHE_CLEANUP_MS = 5 * 60 * 1000;

const EXE = (() => {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'opencode';
})();

const state = { data: null, busy: false, error: null, updatedAt: 0, models: null, modelsBusy: false };

let indexHtmlCache = null;

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

async function generateTrend(days, retries = 2) {
  const step = days > 30 ? 3 : 1;
  const points = Math.ceil(days / step);
  const now = Date.now();
  
  async function getStatsForDay(dayOffset) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    startOfDay.setDate(startOfDay.getDate() - dayOffset);
    const startMs = startOfDay.getTime();
    
    const r = await run(['db', `SELECT COUNT(*) AS sessions, COALESCE(SUM(tokens_input),0) AS input, COALESCE(SUM(tokens_output),0) AS output, COALESCE(SUM(tokens_cache_read),0) AS cacheRead, COALESCE(SUM(cost),0) AS total FROM session WHERE time_updated >= ${startMs};`, '--format', 'tsv']);
    if (!r.ok) return null;
    const rows = parseTSV(r.out);
    if (!rows.length) return null;
    const row = rows[0];
    return {
      overview: { sessions: parseInt(row.sessions) || 0, messages: 0 },
      cost: {
        total: parseFloat(row.total) || 0,
        input: parseFloat(row.input) || 0,
        output: parseFloat(row.output) || 0,
        cacheRead: parseFloat(row.cacheRead) || 0,
        cacheWrite: 0,
      },
    };
  }
  
  const results = new Array(points);
  let next = 0;
  const worker = async () => {
    while (next < points) {
      const i = next++;
      const dayOffset = (i + 1) * step - 1;
      results[i] = await getStatsForDay(dayOffset);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (results.some((r) => !r)) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 1000));
      return generateTrend(days, retries - 1);
    }
    return null;
  }
  
  const buckets = results.map((r) => ({
    sessions: r.overview.sessions,
    messages: r.overview.messages,
    total: r.cost.total,
    input: r.cost.input,
    output: r.cost.output,
    cacheRead: r.cost.cacheRead,
  }));
  
  return {
    generatedAt: now,
    step,
    labels: buckets.map((_, i) => {
      const d = new Date(now - (i * step) * 86400000);
      return (d.getMonth() + 1) + '/' + d.getDate();
    }),
    sessions: buckets.map((b) => b.sessions),
    messages: buckets.map((b) => b.messages),
    input: buckets.map((b) => b.input),
    output: buckets.map((b) => b.output),
    cacheRead: buckets.map((b) => b.cacheRead),
    cost: buckets.map((b) => b.total),
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

const clean = (s) => String(s).replace(/[^\x20-\x7E\n]/g, '');

function toNum(s) {
  const t = String(s).replace(/,/g, '').trim();
  const m = /^([\d.]+)([KMB])?$/i.exec(t);
  if (!m) return NaN;
  let v = parseFloat(m[1]);
  if (m[2]) v *= { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()];
  return v;
}

const money = (s) => {
  const m = /([\d.]+)/.exec(String(s));
  return m ? parseFloat(m[1]) : NaN;
};

function parseStats(text) {
  const c = clean(text);
  const grab = (re) => { const m = re.exec(c); return m ? m[1] : null; };
  const out = {
    overview: {
      sessions: toNum(grab(/Sessions\s+([\d,]+)/)),
      messages: toNum(grab(/Messages\s+([\d,]+)/)),
      days: toNum(grab(/Days\s+([\d,]+)/)),
    },
    cost: {
      total: money(grab(/Total Cost\s*\$([\d.]+)/)),
      avgDay: money(grab(/Avg Cost\/Day\s*\$([\d.]+)/)),
      avgTokensSession: toNum(grab(/Avg Tokens\/Session\s+([\d.]+[KMB]?)/)),
      medianTokensSession: toNum(grab(/Median Tokens\/Session\s+([\d.]+[KMB]?)/)),
      input: toNum(grab(/^Input\s+([\d.]+[KMB]?)/m)),
      output: toNum(grab(/^Output\s+([\d.]+[KMB]?)/m)),
      cacheRead: toNum(grab(/^Cache Read\s+([\d.]+[KMB]?)/m)),
      cacheWrite: toNum(grab(/^Cache Write\s+([\d.]+[KMB]?)/m)),
    },
    tools: [],
    models: [],
  };

  for (const line of c.split('\n')) {
    const m = /^\s*([\w.\-]+)\s+([\d,]+)\s*\(\s*([\d.]+)%\)/.exec(line);
    if (m) out.tools.push({ name: m[1], count: parseInt(m[2].replace(/,/g, ''), 10), pct: parseFloat(m[3]) });
  }

  let cur = null;
  const setv = (cur, line, re, key, isMoney) => {
    const m = re.exec(line);
    if (m) cur[key] = isMoney ? money(m[1]) : toNum(m[1]);
  };
  for (const line of c.split('\n')) {
    const name = /^\s*([a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_.\-]+)\s*$/.exec(line);
    if (name) {
      cur = { name: name[1], messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      out.models.push(cur);
      continue;
    }
    if (!cur) continue;
    setv(cur, line, /Messages\s+([\d,]+)/, 'messages', false);
    setv(cur, line, /Input Tokens\s+([\d.]+[KMB]?)/, 'input', false);
    setv(cur, line, /Output Tokens\s+([\d.]+[KMB]?)/, 'output', false);
    setv(cur, line, /Cache Read\s+([\d.]+[KMB]?)/, 'cacheRead', false);
    setv(cur, line, /Cache Write\s+([\d.]+[KMB]?)/, 'cacheWrite', false);
    setv(cur, line, /Cost\s+(\$[\d.]+)/, 'cost', true);
  }
  return out;
}

function validRow(p) {
  return Number.isFinite(p.overview.sessions) && Number.isFinite(p.overview.messages);
}

async function runStats(args) {
  const r = await run(args);
  if (!r.ok) return null;
  const p = parseStats(r.out);
  if (!validRow(p)) return null;
  return Object.assign({ ok: true }, p);
}

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  const p = await runStats(['stats']);
  if (p) {
    state.data = p;
    state.error = null;
    state.updatedAt = Date.now();
  } else {
    state.error = state.error || 'opencode stats failed';
  }
  state.busy = false;
}

async function refreshModels() {
  if (state.modelsBusy) return;
  state.modelsBusy = true;
  const p = await runStats(['stats', '--models', '10']);
  if (p) state.models = p.models;
  state.modelsBusy = false;
}

function clamp(n) {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeNum(v) {
  return Number.isFinite(v) ? v : 0;
}

function sub(a, b) {
  return {
    sessions: clamp(safeNum(a.overview.sessions) - safeNum(b.overview.sessions)),
    messages: clamp(safeNum(a.overview.messages) - safeNum(b.overview.messages)),
    total: clamp(safeNum(a.cost.total) - safeNum(b.cost.total)),
    input: clamp(safeNum(a.cost.input) - safeNum(b.cost.input)),
    output: clamp(safeNum(a.cost.output) - safeNum(b.cost.output)),
    cacheRead: clamp(safeNum(a.cost.cacheRead) - safeNum(b.cost.cacheRead)),
  };
}

const reportCache = {};
const reportBusy = {};

function parseTSV(text) {
  if (!text) return [];
  const cleaned = text.replace(/[^\x20-\x7E\n\t]/g, '');
  const lines = cleaned.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cols = line.split('\t');
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (cols[i] || '').trim(); });
    return obj;
  });
}

async function buildReport(days) {
  const label = days === 0 ? 'Today' : days <= 1 ? 'Daily' : days <= 7 ? 'Weekly' : 'Monthly';
  const timeFilter = days === 0
    ? `(strftime('%s','now','start of day') * 1000)`
    : days <= 1
    ? `(strftime('%s','now','start of day') * 1000)`
    : days <= 7
    ? `(strftime('%s','now','start of day', '-${days - 1} day') * 1000)`
    : `(strftime('%s','now','start of month') * 1000)`;
  let statsR = await runStats(['stats', '--days', String(Math.max(days, 1)), '--models', '20']);
  if (!statsR) {
    await new Promise((r) => setTimeout(r, 2000));
    statsR = await runStats(['stats', '--days', String(Math.max(days, 1)), '--models', '20']);
  }
  const [agentR, modelR] = await Promise.all([
    run(['db', `SELECT agent, COUNT(*) AS sessions, ROUND(SUM(cost),4) AS cost, SUM(tokens_input) AS tok_in, SUM(tokens_output) AS tok_out, SUM(tokens_cache_read) AS cache_read FROM session WHERE agent IS NOT NULL AND time_updated >= ${timeFilter} GROUP BY agent ORDER BY cost DESC;`, '--format', 'tsv']),
    run(['db', `SELECT json_extract(model,'$.providerID') AS provider, json_extract(model,'$.id') AS model, COUNT(*) AS sessions, ROUND(SUM(cost),4) AS cost, SUM(tokens_input) AS tok_in, SUM(tokens_output) AS tok_out, SUM(tokens_cache_read) AS cache_read FROM session WHERE model IS NOT NULL AND time_updated >= ${timeFilter} GROUP BY provider, model ORDER BY cost DESC;`, '--format', 'tsv']),
  ]);
  return {
    label: label,
    days: days,
    stats: statsR,
    agents: parseTSV(agentR.out),
    providers: parseTSV(modelR.out),
  };
}

function refreshReport(days) {
  const key = String(days);
  const hit = reportCache[key];
  const fresh = hit && Date.now() - hit.generatedAt < REPORT_TTL;
  if (fresh) return { report: hit, ready: true };
  if (!reportBusy[key]) {
    reportBusy[key] = true;
    buildReport(days).then((r) => {
      if (r && r.stats && r.stats.ok) {
        reportCache[key] = Object.assign({}, r, { generatedAt: Date.now() });
      }
    }).catch(() => {}).finally(() => {
      delete reportBusy[key];
    });
  }
  return hit ? { report: Object.assign({}, hit, { stale: true }), ready: true } : { report: null, ready: false };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const u = url.pathname;
  if (u === '/api/stats') {
    const days = parseInt(url.searchParams.get('days') || '7', 10) || 7;
    const r = refreshTrend(days);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({
      ok: !!state.data,
      error: state.error,
      generatedAt: state.updatedAt,
      data: state.data,
      models: state.models,
      trend: r.trend,
      trendReady: !!r.trend,
    }));
  } else if (u === '/api/report') {
    const daysParam = url.searchParams.get('days');
    const days = daysParam !== null ? (parseInt(daysParam, 10) || 0) : 0;
    const r = refreshReport(days);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({
      ok: true,
      ready: r.ready,
      report: r.report,
    }));
  } else if (u === '/') {
    loadIndexHtml((err, data) => {
      if (err) {
        res.statusCode = 500;
        res.end('Internal Server Error');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(data);
    });
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

function gracefulShutdown() {
  console.log('\nShutting down...');
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

setInterval(() => {
  cleanExpiredCache(trendCache, TREND_MS * 2);
  cleanExpiredCache(reportCache, REPORT_TTL * 2);
}, CACHE_CLEANUP_MS);

(async () => {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`opencode stats dashboard: http://127.0.0.1:${PORT}`);
  });
  setInterval(refresh, REFRESH_MS);
  setInterval(refreshModels, 60000);
  await refresh();
  await refreshModels();
  for (const d of [1, 7, 30]) {
    const r = await buildReport(d);
    if (r && r.stats && r.stats.ok) reportCache[String(d)] = Object.assign({}, r, { generatedAt: Date.now() });
  }
  for (const d of [7, 30, 90]) {
    const t = await generateTrend(d);
    if (t) trendCache[String(d)] = t;
  }
})();
