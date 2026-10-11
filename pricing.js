// Shared market-price engine for the "how much did I save" feature.
// Pricing comes from the user's local opencode models catalog
// (~/.cache/opencode/models.json): { provider: { models: { name: { cost: { input,
// output, cache_read } } } } } in USD per 1M tokens.
//
// A free variant is mapped to a paid basis, in order:
//   1. exact provider/model with a nonzero cost            -> kind 'exact'
//   2. same provider, free suffix stripped (:free / -free /
//      -contributor-free) or duplicated provider prefix   -> kind 'sibling'
//   3. same base name under provider 'opencode'            -> kind 'proxy'
//   4. same base name anywhere else (cheapest nonzero)     -> kind 'proxy'
//   5. nothing in the catalog                              -> null (NOT priced;
//      inventing a number here is how a $0 model turned into $212 of fake
//      savings). Callers must show '—' and can disclose the unpriced rows.
//
// Reasoning has no catalog rate and bills at the output rate (verified:
// tokens.output does not include reasoning — 8,764 messages have
// reasoning > output). cache_write is always 0 in the DB.
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

function entry(data, provider, model) {
  const c = data[provider] && data[provider].models && data[provider].models[model] && data[provider].models[model].cost;
  return nonzero(c) ? { input: c.input || 0, output: c.output || 0, cacheRead: c.cache_read || 0 } : null;
}

const stripFree = (m) => String(m).replace(/-contributor-free$/, '').replace(/-free$/, '').replace(/:free$/, '');

// Map a usage model (provider/model as recorded in the DB) to paid rates.
// Returns { input, output, cacheRead, source, kind } or null when the catalog
// has no comparable paid listing at all.
function priceFor(provider, model) {
  const cat = loadCatalog();
  if (!cat.data) return null;
  const data = cat.data;
  provider = provider || 'unknown';
  model = model || 'unknown';
  if (model === 'unknown') return null; // unattributed usage: never invent a rate

  const mk = (p, m, kind) => {
    const r = entry(data, p, m);
    return r ? { ...r, source: `${p}/${m}`, kind } : null;
  };

  let r = mk(provider, model, 'exact');
  if (r) return r;

  // Free suffixes and a provider prefix duplicated inside the model id
  // (opencode records nvidia/nvidia/nemotron-... on some sessions). The plain
  // base is always kept: a model that is free at ITS provider (cost 0) may
  // still have a paid listing elsewhere (e.g. nvidia/z-ai/glm-5.3-flash).
  const bases = [];
  const deDup = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : null;
  for (const b of [stripFree(model), deDup && stripFree(deDup), deDup, model]) {
    if (b && !bases.includes(b)) bases.push(b);
  }
  for (const b of bases) {
    if (b === model) continue;
    r = mk(provider, b, 'sibling');
    if (r) return r;
  }
  for (const b of bases) {
    r = mk('opencode', b, 'proxy');
    if (r) return r;
  }
  // Any provider, cheapest nonzero listing for the same base name. Cheapest
  // keeps the estimate conservative (it understates savings, never inflates).
  for (const b of bases) {
    let best = null;
    for (const pid of Object.keys(data).sort()) {
      const e = entry(data, pid, b);
      if (!e) continue;
      const score = e.input + e.output + e.cacheRead;
      if (!best || score < best.score) best = { ...e, score, pid };
    }
    if (best) {
      const { score, pid, ...rates } = best;
      void score;
      return { ...rates, source: `${pid}/${b}`, kind: 'proxy' };
    }
  }
  return null;
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

module.exports = { priceFor, marketOf, catalogInfo, loadCatalog };