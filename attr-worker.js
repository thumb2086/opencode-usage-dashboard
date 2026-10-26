const { parentPort, workerData } = require('worker_threads');
const srv = require('./server.js');

// I/O throttling parameters (from env, with defaults)
const ITHROTTLE_BATCH = parseInt(process.env.OPENCODE_ITHROTTLE_BATCH || '1000', 10);
const ITHROTTLE_DELAY_MS = parseInt(process.env.OPENCODE_ITHROTTLE_DELAY_MS || '5', 10);

function throttle(iteration) {
  if (iteration % ITHROTTLE_BATCH === 0) {
    return new Promise((r) => setTimeout(r, ITHROTTLE_DELAY_MS));
  }
  return Promise.resolve();
}

(async () => {
  const bundle = await srv.buildAttrBundle(workerData.now || Date.now());
  bundle.builtAt = workerData.now || Date.now();
  const counts = srv.scanToolCounts(workerData.toolsStartMs || 0);
  parentPort.postMessage({
    ok: true,
    builtAt: bundle.builtAt,
    dbRevision: srv.dbRevision(),
    json: srv.serializeBundle(bundle, { embedded: srv.getEmbeddedToolsFlag(), startMs: workerData.toolsStartMs || 0, counts }),
    tools: { embedded: srv.getEmbeddedToolsFlag(), startMs: workerData.toolsStartMs || 0, counts },
  });
})().catch((e) => {
  parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
});