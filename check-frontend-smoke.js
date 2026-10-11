// Frontend smoke test: executes public/index.html's real <script> against live
// /api/stats + /api/report data with a stub DOM, then asserts the new
// single-scope information architecture renders. Needs the dashboard running
// on 127.0.0.1:4868.
const fs = require('fs');
const path = require('path');

function makeEl(tag) {
  return {
    tagName: tag || 'DIV', innerHTML: '', textContent: '', title: '', value: '',
    style: {}, dataset: {}, open: true,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    addEventListener() {}, removeAttribute() {}, scrollIntoView() {},
  };
}

(async () => {
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('FAIL no script block'); process.exit(1); }

// Live API data via curl child process (keeps this process free of
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

let fails = 0;
const chk = (name, cond) => {
  if (!cond) fails++;
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}`);
};

// ---- helpers over the rendered stub DOM --------------------------------
const els = {};
const htmlOf = (id) => ((els[id] || {}).innerHTML || '');
const textOf = (id) => ((els[id] || {}).textContent || '');
const rowsIn = (id) => htmlOf(id).match(/<tr>[\s\S]*?<\/tr>/g) || [];
const cellsIn = (id) => rowsIn(id).map((tr) =>
  (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map((td) => td.replace(/<[^>]*>/g, '').trim()));
const stripTags = (s) => s.replace(/<[^>]*>/g, '');

const EM = '\u2014';
const tokTotal = (row) => (+row.tok_in || 0) + (+row.tok_out || 0) + (+row.tok_reasoning || 0) + (+row.cache_read || 0);
const provName = (p) => p.provider + '/' + p.model;

// =====================================================================
// 1. STATIC STRUCTURE — new IA, old sections gone
// =====================================================================
console.log('--- structure ---');
const SECTIONS = ['sec-headline', 'sec-trend', 'sec-breakdown', 'sec-tools', 'sec-pricing', 'sec-raw'];
chk('6 collapsible sections declared', (html.match(/<details class="tool-section[^>]*id="sec-/g) || []).length === 6);
chk('new section ids present', SECTIONS.every((id) => html.includes('id="' + id + '"')));
chk('removed sections gone (speed/agent/sessions/savings)',
  ['sec-speed', 'sec-agent', 'sec-sessions', 'sec-savings'].every((id) => !html.includes('id="' + id + '"')));
chk('removed legacy sections gone (overview/tokens/models/report)',
  ['sec-overview', 'sec-tokens', 'sec-models', 'sec-report'].every((id) => !html.includes('id="' + id + '"')));
chk('removed legacy element ids gone',
  ['speed-bars', 'agent-bars', 'session-bars', 'savings-bars', 'model-rows', 'reportContent', 'token-bars', 'cost-bars']
    .every((id) => !html.includes('id="' + id + '"')));
chk('single global scope bar with 4 buttons',
  (html.match(/data-days="(-1|1|7|30)"/g) || []).length === 4 && html.includes('id="scopeBtns"'));
chk('scope tag on every section header',
  SECTIONS.every((id) => html.includes('id="tag-' + id.replace('sec-', '') + '"')));
chk('caveat line present (V1+V2 / per-message / residual)',
  /V1\+V2 merged/.test(html) && /per-message token authority/.test(html) && /residual spread across the session/.test(html));
chk('market card carries prices-as-of + unpriced disclosure',
  html.includes('id="hl-priceAsOf"') && html.includes('id="hl-unpriced"') && html.includes('openPricing()'));
chk('scrollable table wrapper kept', html.includes('class="scrollx"'));
chk('section collapse persisted via localStorage', html.includes('restoreSections') && html.includes("'oc-sec-'"));
chk('only two tables (breakdown sub-tabs share one, pricing one)',
  (html.match(/<tbody id="bd-(models|agents|sessions)"/g) || []).length === 3 &&
  (html.match(/<table>/g) || []).length === 2);
chk('headline cards carry scope-dependent numbers',
  ['hl-tokens', 'hl-in', 'hl-out', 'hl-reasoning', 'hl-cache', 'hl-cost', 'hl-market', 'hl-saved']
    .every((id) => html.includes('id="' + id + '"')));

// =====================================================================
// 2. i18n COVERAGE — no hardcoded UI strings, en / zh-TW key parity
// =====================================================================
console.log('--- i18n ---');
let STRINGS = null;
try {
  const probe = new Function('fetch', 'document', 'localStorage', 'navigator', 'window',
    'setInterval', 'setTimeout', m[1] + '\n;return STRINGS;');
  STRINGS = probe(() => new Promise(() => {}), { getElementById: () => makeEl(), querySelectorAll: () => [], documentElement: { lang: '' } },
    { getItem: () => null, setItem: () => {} }, { language: 'en-US' }, {}, () => 0, () => 0);
} catch (e) { console.log('   i18n probe error: ' + e.message); }
chk('STRINGS table parsed', !!STRINGS);
if (STRINGS) {
  const en = Object.keys(STRINGS.en).sort();
  const zh = Object.keys(STRINGS['zh-TW']).sort();
  chk('en / zh-TW key parity', JSON.stringify(en) === JSON.stringify(zh));
  chk('scopeSuffix covers -1/1/7/30 in both languages',
    ['-1', '1', '7', '30'].every((d) => STRINGS.en.scopeSuffix[d] && STRINGS['zh-TW'].scopeSuffix[d]));
  const used = [...new Set((html.match(/data-i18n="([^"]+)"/g) || []).map((s) => s.slice(11, -1)))];
  chk('every data-i18n key exists in en (' + used.length + ' keys)', used.every((k) => STRINGS.en[k]));
  chk('every data-i18n key exists in zh-TW', used.every((k) => STRINGS['zh-TW'][k]));
  chk('pricing kinds exact/sibling/proxy/partial/unpriced translated',
    ['exact', 'sibling', 'proxy', 'partial', 'unpriced'].every((k) =>
      STRINGS.en['kind' + k[0].toUpperCase() + k.slice(1)] && STRINGS['zh-TW']['kind' + k[0].toUpperCase() + k.slice(1)]));
  chk('legacy activeLabel present (no undefined tooltip)', !!STRINGS.en.activeLabel);
  chk('unpriced disclosure mentions the unvalued token count',
    /\{t\}/.test(STRINGS.en.unpricedModels) && /\{t\}/.test(STRINGS['zh-TW'].unpricedModels));
  chk('formatReport kept for RAW TEXT', /function formatReport\(/.test(m[1]) && /OPENCODE USAGE STATEMENT/.test(m[1]));
  chk('test hooks exposed', /window\.__setScope\s*=/.test(m[1]) && /window\.__renderAll\s*=/.test(m[1]) && /window\.__lastReport\s*=/.test(m[1]));
}

// =====================================================================
// 3. RUNTIME — render against live data
// =====================================================================
console.log('--- runtime ---');
const documentStub = {
  getElementById: (id) => (els[id] || (els[id] = makeEl())),
  querySelectorAll: () => [],
  documentElement: { lang: '' },
};
const ls = { getItem: () => null, setItem: () => {} };
const fetches = [];
const stubFetch = async (url) => {
  fetches.push(String(url));
  return { json: async () => (String(url).includes('/api/report') ? rep : stats) };
};
const win = {};
const noop = () => 0;
const tick = async (n) => { for (let i = 0; i < (n || 10); i++) await new Promise((r2) => setImmediate(r2)); };

try {
  const run = new Function('fetch', 'document', 'localStorage', 'navigator', 'window',
    'setInterval', 'setTimeout', m[1]);
  run(stubFetch, documentStub, ls, { language: 'en-US' }, win, noop, noop);
  await tick(12);
} catch (e) {
  console.log('FAIL script threw: ' + e.message);
  process.exit(1);
}

chk('window.__setScope / __renderAll / __lastReport exposed',
  typeof win.__setScope === 'function' && typeof win.__renderAll === 'function' && !!win.__lastReport);
chk('default scope tag on headline', textOf('tag-headline') === STRINGS.en.scopeSuffix['7']);
chk('headline tokens split into in/out/reasoning/cache',
  ['hl-tokens', 'hl-in', 'hl-out', 'hl-reasoning', 'hl-cache'].every((id) => textOf(id) && textOf(id) !== EM));
chk('headline cost / market / saved rendered as $',
  [textOf('hl-cost'), textOf('hl-market'), textOf('hl-saved')].every((v) => v.includes('$')));
chk('market card shows prices as of YYYY-MM-DD',
  /prices as of \d{4}-\d{2}-\d{2}/.test(textOf('hl-priceAsOf')));
const unpricedModels = r.providers.filter((p) => p.market == null);
chk('unpriced disclosure rendered with token count',
  (unpricedModels.length === 0 && textOf('hl-unpriced') === '') ||
  (textOf('hl-unpriced').includes('models unpriced') && /tokens not valued/.test(textOf('hl-unpriced'))));

// --- breakdown: three sub-tabs, all populated, sorted by tokens ---
const bdM = cellsIn('bd-models'), bdA = cellsIn('bd-agents'), bdS = cellsIn('bd-sessions');
chk('bd-models row count === providers', bdM.length === r.providers.length);
chk('bd-agents row count === agents', bdA.length === r.agents.length);
chk('bd-sessions capped at top 20', bdS.length === Math.min(20, r.sessions.length) && bdS.length > 0);
const byTokens = (x, y) => tokTotal(y) - tokTotal(x);
const expModels = r.providers.slice().sort(byTokens).map(provName);
chk('models sorted by tokens desc (not by cost)',
  JSON.stringify(bdM.map((c) => c[0])) === JSON.stringify(expModels));
chk('free models (cost 0) still present in ordering',
  r.providers.some((p) => !p.cost) && bdM.some((c) => expModels.includes(c[0])));
chk('all three sub-tabs carry rows + share bar + 11 columns',
  [bdM, bdA, bdS].every((rows) => rows.length > 0 && rows.every((c) => c.length === 11)) &&
  htmlOf('bd-models').includes('track share'));
chk('sub-tab column headers (sessions count column)', textOf('th-count') === STRINGS.en.thSessions);
chk('sort note explains token ordering', textOf('bdSortNote').includes('sorted by tokens'));
chk('speed column renders tok/s or —', bdM.every((c) => c[7] === EM || c[7].includes('tok/s')));
chk('wall column renders duration or —', bdM.every((c) => c[8] === EM || /\d/.test(c[8])));

// --- unpriced rows must show —, never $0.00 ---
const unpricedNames = r.providers.filter((p) => p.market == null).map(provName);
const bdUnpriced = bdM.filter((c) => unpricedNames.includes(c[0]));
chk('unpriced rows show — for market/saved',
  bdUnpriced.length > 0 && bdUnpriced.every((c) => c[9] === EM && c[10] === EM));
chk('unpriced rows never render $0.00 (unknown is not zero)',
  bdUnpriced.every((c) => !c[9].includes('$') && !c[10].includes('$')));
chk('priced rows show $ for market/saved',
  bdM.filter((c) => !unpricedNames.includes(c[0])).every((c) => c[9].includes('$') && c[10].includes('$')));

// --- pricing basis ---
const pricingRows = rowsIn('pricing-rows');
chk('pricing basis lists every usage model', pricingRows.length === r.providers.length);
chk('pricing basis marks kind per row', /badge (exact|sibling|proxy|partial|unpriced)/.test(htmlOf('pricing-rows')));
chk('pricing basis shows pricedAs source', r.providers.some((p) => p.pricedAs) && /opencode\/|llmgateway\//.test(htmlOf('pricing-rows')));
const unpricedPricing = pricingRows.filter((tr) => {
  const n = stripTags((tr.match(/<td[^>]*>[\s\S]*?<\/td>/) || [''])[0]).trim();
  return unpricedNames.includes(n);
});
chk('pricing basis shows — for unpriced rows',
  unpricedPricing.length > 0 && unpricedPricing.every((tr) => (tr.match(/—/g) || []).length >= 3));

// --- trend / tools / raw ---
const nLabels = (stats.trend && stats.trend.labels) || [];
chk('trend renders one column per bucket', (htmlOf('trend-tokens').match(/class="col"/g) || []).length === nLabels.length);
chk('trend x-axis puts today (newest bucket) leftmost',
  nLabels.length > 0 &&
  stripTags((htmlOf('trend-token-x').match(/<span[^>]*>([^<]*)<\/span>/) || ['', ''])[1]) === nLabels[0] &&
  stripTags((htmlOf('trend-token-x').match(/<span[^>]*>([^<]*)<\/span>/g) || []).pop().replace(/<[^>]*>/g, '')) === nLabels[nLabels.length - 1]);
chk('trend tooltip carries per-day detail', htmlOf('trend-tokens').includes('title='));
chk('trend cost chart or all-free note', htmlOf('trend-cost').length > 0 || textOf('costZeroNote') === STRINGS.en.allFree);
chk('tools render one row per tool', (htmlOf('tool-bars').match(/class="bar-row"/g) || []).length === (stats.data.tools || []).length);
chk('tools disclose they cannot be sliced by scope', /tool counts are all-time/.test(textOf('tag-tools')));
chk('raw text statement preserved', textOf('rawText').includes('OPENCODE USAGE STATEMENT') && textOf('rawText').includes('Period:'));

// --- no NaN / undefined leaking ---
const rendered = ['bd-models', 'bd-agents', 'bd-sessions', 'pricing-rows', 'tool-bars', 'trend-tokens', 'rawText']
  .map(htmlOf).join('\n') + ['hl-tokens', 'hl-in', 'hl-out', 'hl-reasoning', 'hl-cache', 'hl-cost', 'hl-market', 'hl-saved']
    .map(textOf).join(' ');
chk('no NaN in rendered output', !/NaN/.test(rendered));
chk('no undefined in rendered output', !/undefined/.test(rendered));

// =====================================================================
// 4. GLOBAL SCOPE SWITCH — one switch, every section repaints + relabels
// =====================================================================
console.log('--- scope switch ---');
const SECT = (id) => textOf('tag-' + id);

const beforeFetches = fetches.length;
await win.__setScope(1);
await tick(12);
chk('scope=Today relabels headline/breakdown/pricing/raw',
  ['headline', 'breakdown', 'pricing', 'raw'].every((k) => SECT(k) === STRINGS.en.scopeSuffix['1']));
chk('scope=Today relabels trend with bucket count', SECT('trend') === STRINGS.en.trendScope.replace('{n}', '1'));
chk('scope=Today keeps tools tag carrying the scope', SECT('tools').indexOf(STRINGS.en.scopeSuffix['1']) === 0);
chk('scopeNow shows the active scope', textOf('scopeNow') === STRINGS.en.scopeSuffix['1']);
chk('headline repainted for new scope', textOf('hl-tokens') && textOf('hl-tokens') !== EM && textOf('hl-market').includes('$'));
chk('breakdown repainted for new scope', rowsIn('bd-models').length === r.providers.length);
chk('pricing repainted for new scope', rowsIn('pricing-rows').length === r.providers.length);
chk('raw text repainted for new scope', textOf('rawText').includes('OPENCODE USAGE STATEMENT'));
chk('trend repainted for new scope', htmlOf('trend-tokens').includes('title='));
chk('first visit to a scope does fetch', fetches.length > beforeFetches);

await win.__setScope(-1);
await tick(12);
chk('scope=All time relabels every section',
  ['headline', 'breakdown', 'pricing', 'raw'].every((k) => SECT(k) === STRINGS.en.scopeSuffix['-1']));
chk('scope=All time uses 90-day trend buckets', SECT('trend') === STRINGS.en.allTimeTrend);

const beforeCached = fetches.length;
await win.__setScope(7);   // already visited during boot
await tick(6);
chk('cached scope switch re-renders without hitting the API', fetches.length === beforeCached);
chk('cached scope switch still relabels',
  SECT('headline') === STRINGS.en.scopeSuffix['7'] && SECT('breakdown') === STRINGS.en.scopeSuffix['7']);

// --- __renderAll redraws from cache without network ---
const b2 = fetches.length;
win.__setTab('agents');
win.__renderAll();
chk('__renderAll repaints without the API', fetches.length === b2);
chk('__renderAll honours current sub-tab', textOf('th-name') === STRINGS.en.tabAgents);
chk('__renderAll keeps the active scope tag',
  SECT('headline') === STRINGS.en.scopeSuffix['7'] && SECT('breakdown') === STRINGS.en.scopeSuffix['7']);

console.log(fails === 0 ? 'VERIFY PASS' : `VERIFY FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR:', e.message, e.stack); process.exit(2); });