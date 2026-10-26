const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const oldFunc = `async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    // No bundle yet (first run on this machine, or right after \`npm i -g\`
    // wiped the package dir): the worker is still scanning \uFEFFX which can take
    // 30-60s on a 3GB DB. Publish "loading" instead of an all-zero payload
    // the UI cannot tell apart from real numbers.
    if (!attrAllCache) {
      refreshAttrBundle();
      state.loading = true;
      return;
    }
    const p = getStatsFromDb(0);
    if (p && p.ok) {
      state.data = p;
      state.error = null;
      state.updatedAt = Date.now();
      state.loading = false;
    } else {
      state.error = state.error || 'failed to read database';
    }
  } catch (e) {
    state.error = e.message;
  } finally {
    state.busy = false;
  }
}`;
const newFunc = `async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    // No bundle yet (first run on this machine, or right after \`npm i -g\`
    // wiped the package dir): the worker is still scanning \uFEFFX which can take
    // 30-60s on a 3GB DB. Publish "loading" instead of an all-zero payload
    // the UI cannot tell apart from real numbers.
    if (!attrAllCache) {
      refreshAttrBundle();
      state.loading = true;
      return;
    }
    const p = getStatsFromDb(0);
    if (p && p.ok) {
      state.data = p;
      state.error = null;
      state.updatedAt = Date.now();
      state.loading = false;
    } else {
      state.error = state.error || 'failed to read database';
      state.loading = false;
    }
  } catch (e) {
    console.error("refresh error:", e);
    state.error = e.message;
    state.loading = false;
  } finally {
    state.busy = false;
  }
}`;
const content = fs.readFileSync('server.js', 'utf8');
const newContent = content.replace(oldFunc, newFunc);
fs.writeFileSync('server.js', newContent, 'utf8');
console.log('Done');