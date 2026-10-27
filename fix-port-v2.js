const fs = require('fs');
const c = fs.readFileSync('server.js', 'utf8');

// Find the tryListen function and the IIFE start
const tryListenStart = c.indexOf('function tryListen(port, maxPort) {');
const iifeStart = c.indexOf('(async () => {');

if (tryListenStart >= 0 && iifeStart >= 0) {
  // Find the end of tryListen function (the closing brace of the function)
  let braceCount = 0;
  let tryListenEnd = -1;
  for (let i = tryListenStart; i < c.length; i++) {
    if (c[i] === '{') {
      braceCount++;
    } else if (c[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        tryListenEnd = i + 1; // Include the closing brace
        break;
      }
    }
  }
  
  if (tryListenEnd === -1) {
    console.log('Could not find end of tryListen function');
    process.exit(1);
  }

  // Find the start of the IIFE (the opening parenthesis)
  const iifeParenStart = c.indexOf('(', iifeStart) + 1;
  
  // Build the new content
  const beforeTryListen = c.substring(0, tryListenStart);
  const afterIifeStart = c.substring(iifeStart); // Keep the IIFE
  
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
} else {
  console.log('Could not find tryListen or IIFE start');
  console.log('tryListenStart:', tryListenStart);
  console.log('iifeStart:', iifeStart);
}