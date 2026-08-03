#!/usr/bin/env node
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 4868;
const REFRESH_MS = 10000;
const TREND_MS = 10 * 60 * 1000;
const REPORT_TTL = 10 * 60 * 1000;

const EXE = (() => {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'opencode';
})();

const state = { data: null, busy: false, error: null, updatedAt: 0, models: null, modelsBusy: false };

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

async function generateTrend(days) {
  const steps = days === 7 ? 8 : days === 30 ? 10 : days === 90 ? 13 : 1;
  const stepSize = days === 7 ? 1 : days === 30 ? 3 : days === 90 ? 7 : days;
  const rows = [];
  for (let i = 1; i <= steps; i++) {
    const d = Math.min(i * stepSize, days);
    const p = await runStats(['stats', '--days', String(d)]);
    if (!p) return null;
    rows.push(p);
  }
  const first = rows[0];
  const buckets = [{
    sessions: first.overview.sessions,
    messages: first.overview.messages,
    total: first.cost.total,
    input: first.cost.input,
    output: first.cost.output,
    cacheRead: first.cost.cacheRead,
  }];
  for (let i = 1; i < rows.length; i++) buckets.push(sub(rows[i], rows[i - 1]));
  const now = Date.now();
  return {
    generatedAt: now,
    labels: buckets.map((_, i) => {
      const d = new Date(now - i * stepSize * 86400000);
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
  return p;
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

function sub(a, b) {
  return {
    sessions: clamp(a.overview.sessions - b.overview.sessions),
    messages: clamp(a.overview.messages - b.overview.messages),
    total: clamp(a.cost.total - b.cost.total),
    input: clamp(a.cost.input - b.cost.input),
    output: clamp(a.cost.output - b.cost.output),
    cacheRead: clamp(a.cost.cacheRead - b.cost.cacheRead),
  };
}

async function generateTrend(days) {
  const steps = days === 7 ? 8 : days === 30 ? 10 : days === 90 ? 13 : 1;
  const stepSize = days === 7 ? 1 : days === 30 ? 3 : days === 90 ? 7 : days;
  const rows = [];
  for (let i = 1; i <= steps; i++) {
    const d = Math.min(i * stepSize, days);
    const p = await runStats(['stats', '--days', String(d)]);
    if (!p) return null;
    rows.push(p);
  }
  const first = rows[0];
  const buckets = [{
    sessions: first.overview.sessions,
    messages: first.overview.messages,
    total: first.cost.total,
    input: first.cost.input,
    output: first.cost.output,
    cacheRead: first.cost.cacheRead,
  }];
  for (let i = 1; i < rows.length; i++) buckets.push(sub(rows[i], rows[i - 1]));
  const now = Date.now();
  return {
    generatedAt: now,
    labels: buckets.map((_, i) => {
      const d = new Date(now - i * stepSize * 86400000);
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

const reportCache = {};
const reportBusy = {};

async function buildReport(days) {
  const label = days <= 1 ? 'Daily' : days <= 7 ? 'Weekly' : 'Monthly';
  const [statsR, agentR, modelR] = await Promise.all([
    runStats(['stats', '--days', String(days), '--models', '20']),
    run(['db', `SELECT agent, COUNT(*) AS sessions, ROUND(SUM(cost),4) AS cost, SUM(tokens_input) AS tok_in, SUM(tokens_output) AS tok_out, SUM(tokens_cache_read) AS cache_read FROM session WHERE agent IS NOT NULL AND time_created >= (strftime('%s','now','-${days} day') * 1000) GROUP BY agent ORDER BY cost DESC;`, '--format', 'tsv']),
    run(['db', `SELECT json_extract(model,'$.providerID') AS provider, json_extract(model,'$.id') AS model, COUNT(*) AS sessions, ROUND(SUM(cost),4) AS cost, SUM(tokens_input) AS tok_in, SUM(tokens_output) AS tok_out, SUM(tokens_cache_read) AS cache_read FROM session WHERE model IS NOT NULL AND time_created >= (strftime('%s','now','-${days} day') * 1000) GROUP BY provider, model ORDER BY cost DESC;`, '--format', 'tsv']),
  ]);
  const parseTSV = (text) => {
    if (!text) return [];
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split('\t');
    return lines.slice(1).map((line) => {
      const cols = line.split('\t');
      const obj = {};
      headers.forEach((h, i) => { obj[h.trim()] = (cols[i] || '').trim(); });
      return obj;
    });
  };
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
      reportCache[key] = Object.assign({}, r, { generatedAt: Date.now() });
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
    const days = parseInt(url.searchParams.get('days') || '1', 10) || 1;
    const r = refreshReport(days);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({
      ok: true,
      ready: r.ready,
      report: r.report,
    }));
  } else if (u === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`opencode stats dashboard: http://127.0.0.1:${PORT}`);
});

refresh();
refreshModels();
refreshReport(1);
refreshReport(7);
refreshReport(30);
(async () => {
  await refreshTrend(7).pending;
  await refreshTrend(30).pending;
  await refreshTrend(90).pending;
})();
setInterval(refresh, REFRESH_MS);
setInterval(refreshModels, 60000);
setInterval(() => { for (const k of Object.keys(trendCache)) refreshTrend(parseInt(k, 10)); }, TREND_MS);
setInterval(() => { for (const k of Object.keys(reportCache)) refreshReport(parseInt(k, 10)); }, REPORT_TTL);
