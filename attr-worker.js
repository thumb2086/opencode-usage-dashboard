// Stats worker: runs the heavy, SYNCHRONOUS database work off the request
// thread. Scanning the message table (JSON.parse of ~1GB of content) plus the
// embedded tool-part scan takes 3-29s against a live 2.7GB WAL DB while
// opencode is writing; doing that inline froze the HTTP server for exactly as
// long, which showed up as a slow cold start and stalled scope switches.
//
// It reuses server.js's own scan functions (no duplicated logic): requiring
// server.js as a module skips every server-side side effect (see the
// require.main guard near the bottom of that file).
const { parentPort, workerData } = require('worker_threads');
const srv = require('./server.js');

(async () => {
  const now = workerData.now || Date.now();
  const bundle = await srv.buildAttrBundle(now);
  bundle.builtAt = now;
  const counts = srv.scanToolCounts(workerData.toolsStartMs || 0);
  parentPort.postMessage({
    ok: true,
    builtAt: now,
    dbRevision: srv.dbRevision(),
    json: srv.serializeBundle(bundle, { embedded: srv.getEmbeddedToolsFlag(), startMs: workerData.toolsStartMs || 0, counts }),
    tools: { embedded: srv.getEmbeddedToolsFlag(), startMs: workerData.toolsStartMs || 0, counts },
  });
})().catch((e) => {
  parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
});