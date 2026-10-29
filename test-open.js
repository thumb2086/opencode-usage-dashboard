const { spawn } = require('child_process');
const url = 'http://127.0.0.1:4868';
spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
console.log('Opened');