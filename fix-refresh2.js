const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const newContent = content.replace(
  '} catch (e) {\n    state.error = e.message;\n  } finally {\n    state.busy = false;\n  }',
  '} catch (e) {\n    console.error("refresh error:", e);\n    state.error = e.message;\n    state.loading = false;\n  } finally {\n    state.busy = false;\n  }'
);
fs.writeFileSync('server.js', newContent, 'utf8');
console.log('Done');