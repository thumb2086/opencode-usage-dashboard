const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const srv = require('./server.js');
const dbg = (s) => fs.appendFileSync('C:\\Users\\CPXru\\Desktop\\thumb\\大拇哥實驗室\\Projects\\oc-stats\\worker-debug.txt', s + '\n');
dbg('WORKER STARTED; BACKUP_SRC=' + (srv.BACKUP_SRC || 'NOT EXPORTED') + ' env.OPENCODE_DATA=' + (process.env.OPENCODE_DATA || '(unset)'));

(async () => {
  dbg('calling buildAttrBundle...');
  const bundle = await srv.buildAttrBundle(workerData.now || Date.now());
  dbg('bundle done: messages=' + bundle.totals.messages + ' input=' + bundle.totals.input);
  bundle.builtAt = workerData.now || Date.now();
  const counts = srv.scanToolCounts(workerData.toolsStartMs || 0);
  dbg('tools done: ' + Object.keys(counts).length);
  parentPort.postMessage({
    ok: true,
    builtAt: bundle.builtAt,
    dbRevision: srv.dbRevision(),
    json: srv.serializeBundle(bundle, { embedded: srv.getEmbeddedToolsFlag(), startMs: workerData.toolsStartMs || 0, counts }),
    tools: { embedded: srv.getEmbeddedToolsFlag(), startMs: workerData.toolsStartMs || 0, counts },
  });
  dbg('posted');
})().catch((e) => {
  dbg('CATCH: ' + (e && e.stack ? e.stack : e));
  parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
});