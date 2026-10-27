const fs = require('fs');
const c = fs.readFileSync('server.js', 'utf8');

// Find the tryListen function start
const tryListenStart = c.indexOf('function tryListen(port, maxPort) {');
const iifeStart = c.indexOf('(async () => {');

if (tryListenStart >= 0 && iifeStart >= 0) {
  const beforeTryListen = c.substring(0, tryListenStart);
  const afterIifeStart = c.substring(iifeStart);
  
  const newContent = beforeTryListen + `
async function startServer() {
  return new Promise((resolve, reject) => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log('opencode stats dashboard: http://127.0.0.1:' + PORT);
      resolve(PORT);
    });
    server.once('error', (e) => {
      console.error('Server error:', e.message);
      process.exit(1);
    });
  });
};

` + afterIifeStart;
  
  fs.writeFileSync('server.js', newContent);
  console.log('Fixed server.js - replaced tryListen with fixed port listener');
} else {
  console.log('Could not find tryListen or IIFE start');
}