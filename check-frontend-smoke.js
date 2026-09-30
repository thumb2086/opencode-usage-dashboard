// Frontend smoke test: executes public/index.html's real <script> against live
// /api/stats + /api/report data with a stub DOM, then asserts the report
// charts render. Needs the dashboard running on 127.0.0.1:4868.
const fs = require('fs');
const path = require('path');

function makeEl() {
  return {
    innerHTML: '', textContent: '', title: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector() { return makeEl(); },
  };
}

(async () => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) { console.log('FAIL no script block'); process.exit(1); }

  // Fetch live API data via curl child process (keeps this process free of
  // keep-alive sockets; avoids a Node/Win32 libuv teardown race on exit).
  const { execFileSync } = require('child_process');
  const get = (u) => JSON.parse(execFileSync('curl.exe', ['-s', u], { encoding: 'utf8', timeout: 120000 }));
  let stats, rep;
  try {
    stats = get('http://127.0.0.1:4868/api/stats?days=7');
    rep = get('http://127.0.0.1:4868/api/report?days=1');
  } catch (e) {
    console.log('FAIL api fetch: ' + e.message);
    process.exit(1);
  }
  if (!stats.ok || !rep.ready || !rep.report) { console.log('FAIL api not ready'); process.exit(1); }
  const r = rep.report;

  const els = {};
  const documentStub = {
    getElementById: (id) => (els[id] || (els[id] = makeEl())),
    querySelectorAll: () => [],
    documentElement: { lang: '' },
  };
  const ls = { getItem: () => null, setItem: () => {} };
  const stubFetch = async (url) => ({
    json: async () => (String(url).includes('/api/report') ? rep : stats),
  });
  const noop = () => 0;

  try {
    const run = new Function('fetch', 'document', 'localStorage', 'navigator', 'setInterval', 'setTimeout', m[1]);
    run(stubFetch, documentStub, ls, { language: 'en-US' }, noop, noop);
    for (let i = 0; i < 6; i++) await new Promise((r2) => setImmediate(r2));
  } catch (e) {
    console.log('FAIL script threw: ' + e.message);
    process.exit(1);
  }

  let fails = 0;
  const chk = (name, cond) => {
    if (!cond) fails++;
    console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}`);
  };
  const rows = (id) => ((els[id] || {}).innerHTML || '').match(/bar-row/g) || [];
  const speed = (els['speed-bars'] || {}).innerHTML || '';
  const agent = (els['agent-bars'] || {}).innerHTML || '';
  const sess = (els['session-bars'] || {}).innerHTML || '';
  chk('speed-bars row count', rows('speed-bars').length === r.providers.length);
  chk('speed-bars has tok/s', speed.includes('tok/s'));
  chk('speed-bars sorted desc', (() => {
    const vals = [...speed.matchAll(/>([\d.]+) tok\/s</g)].map((x) => parseFloat(x[1]));
    return vals.length > 0 && vals.every((v, i) => i === 0 || vals[i - 1] >= v);
  })());
  chk('agent-bars row count', rows('agent-bars').length === r.agents.length);
  chk('agent-bars has agent + durations', r.agents.every((a) => agent.includes(a.agent)));
  chk('session-bars row count', rows('session-bars').length === r.sessions.length);
  chk('session-bars has session ids', r.sessions.every((s) => sess.includes(String(s.id).slice(0, 12))));
  chk('model-rows has speed col', ((els['model-rows'] || {}).innerHTML || '').includes('tok/s'));
  chk('text report keeps SESSIONS', ((els['reportContent'] || {}).textContent || '').includes('SESSIONS'));
  console.log(fails === 0 ? 'VERIFY PASS' : `VERIFY FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR:', e.message); process.exit(2); });
