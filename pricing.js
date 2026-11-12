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
//   5. manual FREE_MODEL_MAPPING for free models without automatic match
//   6. nothing in the catalog                              -> null (NOT priced;
//      inventing a number here is how a $0 model turned into $212 of fake
//      savings). Callers must show '—' and can disclose the unpriced rows.
//
// Reasoning has no catalog rate and bills at the output rate (verified:
// tokens.output does not include reasoning — 8,764 messages have
// reasoning > output). cache_write is always 0 in the DB.
const fs = require('fs');
const path = require('path');

const stripFree = (m) => String(m).replace(/-contributor-free$/, '').replace(/-free$/, '').replace(/:free$/, '');

// Manual paid-model mapping for free opencode models that have no automatic
// sibling/proxy match. Key: free model name (with or without provider prefix),
// value: paid model full name (provider/model from cache).
const FREE_MODEL_MAPPING = {
  'opencode/space-bunny-free': 'pioneer/mistralai/Mistral-7B-Instruct-v0.3',
  'opencode/beam-free': 'openrouter/xiaomi/mimo-v2.5',
  'opencode/fledge-alpha-free': 'pioneer/mistralai/Mistral-7B-Instruct-v0.3',
  'opencode/grok-code': 'vercel/spacexai/grok-4.1-fast-reasoning',
  'opencode/laguna-s-2.1-free': 'nano-gpt/poolside/laguna-s-2.1',
  'opencode/x-preview-f-free': 'vercel/spacexai/grok-4.1-fast-reasoning',
  'opencode/nemotron-3.5-lightning-free': 'nano-gpt/nvidia/nemotron-3.5-lightning',
  'opencode/big-pickle': 'vercel/spacexai/grok-4.1-fast-reasoning',
  'opencode/ling-3.0-flash-fin-free': 'empiriolabs/qwen3-8-flash',
  'opencode/mimo-v2.5-free': 'openrouter/xiaomi/mimo-v2.5',
  'opencode/nemotron-3-super-free': 'openrouter/nvidia/nemotron-3-super-120b-a12b',
  'opencode/nemotron-3-ultra-free': 'openrouter/nvidia/nemotron-3-ultra-550b-a55b',
  'opencode/glm-4.7-free': 'openrouter/z-ai/glm-4.7',
  'opencode/glm-5-free': 'openrouter/z-ai/glm-5',
  'opencode/mimo-v2-flash-free': 'openrouter/xiaomi/mimo-v2-flash',
  'opencode/qwen3.6-plus-free': 'nano-gpt/qwen/qwen3.6-plus',
  'opencode/mimo-v2-omni-free': 'openrouter/xiaomi/mimo-v2-omni',
  'opencode/mimo-v2-pro-free': 'openrouter/xiaomi/mimo-v2-pro',
  'opencode/ling-3.0-tiny-free': 'empiriolabs/qwen3-8-flash',
  'opencode/trinity-large-preview-free': 'vercel/spacexai/grok-4.1-fast-reasoning',
  'opencode/nemotron-3.5-super-vl-free': 'openrouter/nvidia/nemotron-3.5-super-vl',
  'opencode/ling-2.6-flash-free': 'empiriolabs/qwen3-8-flash',
  'opencode/minimax-m2.5-free': 'openrouter/minimax/minimax-m2.5',
  'opencode/minimax-m3-free': 'openrouter/minimax/minimax-m3',
  'opencode/muse-spark-1.2-contributor-free': 'nano-gpt/meta/muse-spark-1.2',
  'opencode/muse-spark-1.3-contributor-free': 'bothub/muse-spark-1.3-contributor',
  'opencode/deepseek-v4-flash-free': 'openrouter/deepseek/deepseek-v4-flash',
  'opencode/deepseek-v4.1-flash-free': 'openrouter/deepseek/deepseek-v4.1-flash',
  'opencode/hy3-free': 'openrouter/tencent/hy3',
  'opencode/glm-5.3-flash-free': 'openrouter/z-ai/glm-5.3-flash',
  'opencode/nemotron-3.5-super-vl-free': 'openrouter/nvidia/nemotron-3.5-super-vl',
  'opencode/beam-free': 'openrouter/xiaomi/mimo-v2.5',
  'opencode/space-bunny-free': 'pioneer/mistralai/Mistral-7B-Instruct-v0.3',
  'opencode/fledge-alpha-free': 'pioneer/mistralai/Mistral-7B-Instruct-v0.3',
  'opencode/big-pickle': 'vercel/spacexai/grok-4.1-fast-reasoning',
  'opencode/grok-code': 'vercel/spacexai/grok-4.1-fast-reasoning',
  'opencode/x-preview-f-free': 'vercel/spacexai/grok-4.1-fast-reasoning',
  'opencode/nemotron-3.5-lightning-free': 'nano-gpt/nvidia/nemotron-3.5-lightning',
  'opencode/big-pickle': 'vercel/spacexai/grok-4.1-fast-reasoning',
  'opencode/ling-3.0-flash-fin-free': 'empiriolabs/qwen3-8-flash',
  'opencode/ling-3.0-tiny-free': 'empiriolabs/qwen3-8-flash',
  'opencode/ling-2.6-flash-free': 'empiriolabs/qwen3-8-flash',
  'opencode/trinity-large-preview-free': 'vercel/spacexai/grok-4.1-fast-reasoning',
  'opencode/mimo-v2.5-free': 'openrouter/xiaomi/mimo-v2.5',
  'opencode/mimo-v2-flash-free': 'openrouter/xiaomi/mimo-v2-flash',
  'opencode/mimo-v2-omni-free': 'openrouter/xiaomi/mimo-v2-omni',
  'opencode/mimo-v2-pro-free': 'openrouter/xiaomi/mimo-v2-pro',
  'opencode/qwen3.6-plus-free': 'nano-gpt/qwen/qwen3.6-plus',
  'opencode/glm-4.7-free': 'openrouter/z-ai/glm-4.7',
  'opencode/glm-5-free': 'openrouter/z-ai/glm-5',
  'opencode/hy3-free': 'openrouter/tencent/hy3',
  'opencode/glm-5.3-flash-free': 'openrouter/z-ai/glm-5.3-flash',
  'opencode/minimax-m2.5-free': 'openrouter/minimax/minimax-m2.5',
  'opencode/minimax-m3-free': 'openrouter/minimax/minimax-m3',
  'opencode/muse-spark-1.2-contributor-free': 'nano-gpt/meta/muse-spark-1.2',
  'opencode/muse-spark-1.3-contributor-free': 'bothub/muse-spark-1.3-contributor',
  'opencode/deepseek-v4-flash-free': 'openrouter/deepseek/deepseek-v4-flash',
  'opencode/deepseek-v4.1-flash-free': 'openrouter/deepseek/deepseek-v4.1-flash',
  'opencode/hy3-free': 'openrouter/tencent/hy3',
  'opencode/glm-5.3-flash-free': 'openrouter/z-ai/glm-5.3-flash',
  'opencode/nemotron-3.5-super-vl-free': 'openrouter/nvidia/nemotron-3.5-super-vl',
};

function getFreeModelMapping(provider, model) {
  const key = `${provider}/${model}`;
  const mapped = FREE_MODEL_MAPPING[key] || FREE_MODEL_MAPPING[model];
  if (!mapped) return null;
  const [mp, ...mm] = mapped.split('/');
  return { provider: mp, model: mm.join('/') };
}

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

// Map a usage model (provider/model as recorded in the DB) to paid rates.
function priceFor(provider, model) {
  const cat = loadCatalog();
  if (!cat.data) return null;
  const data = cat.data;
  provider = provider || 'unknown';
  model = model || 'unknown';
  if (model === 'unknown') return null;

  const mk = (p, m, kind) => {
    const r = entry(data, p, m);
    return r ? { ...r, source: `${p}/${m}`, kind } : null;
  };

  let r = mk(provider, model, 'exact');
  if (r) return r;

  // Free suffixes
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

  // Any provider, cheapest nonzero listing for the same base name
  const allBases = [...bases];
  if (model !== bases[0] && !allBases.includes(model)) allBases.push(model);
  const providerModel = `${provider}/${model}`;
  if (!allBases.includes(providerModel)) allBases.push(providerModel);
  const openrouterModel = `openrouter/${model}`;
  if (!allBases.includes(openrouterModel)) allBases.push(openrouterModel);
  const openrouterProviderModel = `openrouter/${provider}/${model}`;
  if (!allBases.includes(openrouterProviderModel)) allBases.push(openrouterProviderModel);
  if (provider === 'openrouter' && !model.includes('/')) {
    const subProviders = ['reflection', 'nvidia', 'google', 'anthropic', 'meta', 'mistral', 'cohere', 'mistralai'];
    for (const sub of subProviders) {
      const subModel = `${sub}/${model}`;
      if (!allBases.includes(subModel)) allBases.push(subModel);
      const openrouterSubModel = `openrouter/${sub}/${model}`;
      if (!allBases.includes(openrouterSubModel)) allBases.push(openrouterSubModel);
    }
  }
  for (const b of allBases) {
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

  // Check manual free model mapping before final null return
  const freeMapping = getFreeModelMapping(provider, model);
  if (freeMapping) {
    const r2 = mk(freeMapping.provider, freeMapping.model, 'proxy');
    if (r2) return r2;
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