const fs = require('fs');
const c = fs.readFileSync('server.js', 'utf8');

// Find the tryListen function start
const tryListenStart = c.indexOf('function tryListen(port, maxPort) {');
if (tryListenStart === -1) {
  console.log('Could not find tryListen function');
  process.exit(1);
}

// Find the end of tryListen function
let braceCount = 0;
let tryListenEnd = -1;
for (let i = tryListenStart; i < c.length; i++) {
  if (c[i] === '{') braceCount++;
  else if (c[i] === '}') {
    braceCount--;
    if (braceCount === 0) {
      tryListenEnd = i + 1; // Include the closing brace
      break;
    }
  }

  if (tryListenEnd === -1) {
    console.log('Could not find end of tryListen function');
    process.exit(1);
  }

  // Find the IIFE start
  const iifeStart = c.indexOf('(async () => {');
  if (iifeStart === -1) {
    console.log('Could not find IIFE start');
    process.exit(1);
  }

  // Find the end of the IIFE (the closing })();)
  let braceCount = 0;
  let iifeEnd = -1;
  for (let i = c.indexOf('(async () => {'); i < c.length; i++) {
    if (c[i] === '{') braceCount++;
    else if (c[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        // Check if next chars are })();
        const nextChars = c.substring(i, i + 10);
        if (nextChars.startsWith('})();')) {
          tryListenEnd = i + 5; // Include })();
          break;
        }
      }
    }

    if (tryListenEnd === -1) {
      console.log('Could not find end of IIFE');
      process.exit(1);
    }

  // Find the IIFE start (the async () => { part)
  const iifeStart = c.indexOf('(async () => {');
  if (iifeStart === -1) {
    console.log('Could not find IIFE start');
    process.exit(1);
  }

  // Build new content
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
}

` + c.substring(iifeStart);

  fs.writeFileSync('server.js', newContent);
  console.log('Fixed server.js - replaced tryListen with fixed port listener');