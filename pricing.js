// Shared market-price engine for the "how much did I save" feature.
// Pricing comes from the user's local opencode models catalog
// (~/.cache/opencode/models.json):
//   { provider: { models: { name: { cost: { input, output, cache_read } } } } }
// in USD per 1M tokens. Free variants (cost 0) are mapped to a paid basis:
//   1. exact provider/model with nonzero cost
//   2. strip -free / -contributor-free suffix, same provider, nonzero cost
//   3. same base name under provider 'opencode', nonzero cost
//   4. same base name under any provider (sorted, first nonzero)
//   5. proxy fallback: opencode/deepseek-v4-flash rates (marked "proxy:")
// Reasoning tokens have no catalog rate and are billed at the output rate.
// cache_write is always 0 in the DB and contributes nothing.
const fs = require('fs');
const path = require('path');

function catalogCandidates() {
  const homes = [process.env.USERPROFILE, process.env.HOME].filter(Boolean);
  const out = [];
  for (const h of homes) out.push(path.join(h, '.cache', 'opencode', 'models.json'));
  return [...new Set(out)];
}

let cache = { mtimeMs: 0, data: null, path: null };

function loadCatalog() {
  for (const p of catalogCandidates()) {
    try {
      const st = fs.statSync(p);
      if (cache.data && cache.path === p && cache.mtimeMs === st.mtimeMs) return cache;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      cache = { mtimeMs: st.mtimeMs, data, path: p };
      return cache;
    } catch (_) { /* try next candidate */ }
  }
  cache = { mtimeMs: 0, data: null, path: null };
  return cache;
}

function nonzero(cost) {
  if (!cost) return false;
  return (cost.input || 0) > 0 || (cost.output || 0) > 0 || (cost.cache_read || 0) > 0;
}

function ratesOf(data, provider, model) {
  const cost = data[provider] && data[provider].models && data[provider].models[model] && data[provider].models[model].cost;
  if (!nonzero(cost)) return null;
  return { input: cost.input || 0, output: cost.output || 0, cacheRead: cost.cache_read || 0, source: `${provider}/${model}` };
}

// Map a usage model (provider/model as seen in the DB) to paid rates.
// Returns { input, output, cacheRead, source, exact } or null when no catalog.
function priceFor(provider, model) {
  const cat = loadCatalog();
  if (!cat.data) return null;
  const data = cat.data;
  provider = provider || 'unknown';
  model = model || 'unknown';
  let r = ratesOf(data, provider, model);
  if (r) return { ...r, exact: true };
  if (model === 'unknown') {
    const fb = ratesOf(data, 'opencode', 'deepseek-v4-flash');
    return fb ? { ...fb, source: 'proxy:opencode/deepseek-v4-flash', exact: false } : null;
  }
  const base = String(model).replace(/-contributor-free$/, '').replace(/-free$/, '');
  const cands = [];
  if (base !== model) cands.push([provider, base]);
  cands.push(['opencode', base]);
  for (const pid of Object.keys(data).sort()) {
    if (pid !== provider && pid !== 'opencode') cands.push([pid, base]);
  }
  for (const [p, m] of cands) {
    r = ratesOf(data, p, m);
    if (r) return { ...r, exact: false };
  }
  const fb = ratesOf(data, 'opencode', 'deepseek-v4-flash');
  return fb ? { ...fb, source: 'proxy:opencode/deepseek-v4-flash', exact: false } : null;
}

// Market value (USD) of token usage at the given rates.
function marketOf(tok, rates) {
  if (!rates) return null;
  const m = (tok.input || 0) / 1e6 * rates.input
    + (tok.output || 0) / 1e6 * rates.output
    + (tok.reasoning || 0) / 1e6 * rates.output
    + (tok.cacheRead || 0) / 1e6 * rates.cacheRead;
  return Math.round(m * 10000) / 10000;
}

function catalogInfo() {
  const cat = loadCatalog();
  return cat.data ? { ok: true, path: cat.path, mtimeMs: cat.mtimeMs } : { ok: false };
}

module.exports = { priceFor, marketOf, catalogInfo };
