const { parentPort, workerData } = require('worker_threads');
const srv = require('./server.js');

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