const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');

// Find the catch block in the refresh function
const lines = content.split('\n');
let inRefresh = false;
let inCatch = false;
let catchStart = -1;
let finallyStart = -1;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  if (line.includes('async function refresh()')) {
    inRefresh = true;
  }
  
  if (inRefresh && line.trim() === '} catch (e) {') {
    catchStart = i;
  }
  
  if (inRefresh && line.trim() === '} finally {') {
    finallyStart = i;
    break;
  }
}

if (catchStart >= 0 && finallyStart >= 0) {
  // Replace the catch block (from catchStart to finallyStart - 1)
  const newCatchBlock = [
    '  } catch (e) {',
    '    console.error("refresh error:", e);',
    '    state.error = e.message;',
    '    state.loading = false;',
    '  } finally {'
  ];
  
  const newLines = [
    ...lines.slice(0, catchStart),
    ...newCatchBlock,
    ...lines.slice(finallyStart + 1)
  ];
  
  const newContent = newLines.join('\n');
  fs.writeFileSync('server.js', newContent, 'utf8');
  console.log('Done');
} else {
  console.log('Could not find catch/finally blocks');
}