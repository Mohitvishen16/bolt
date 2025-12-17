const { execSync } = require('child_process');

function stopNodeWindows() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq node.exe" /NH', { stdio: ['pipe', 'pipe', 'ignore'] }).toString();
    if (/node.exe/i.test(out)) {
      console.log('Found node.exe processes, attempting to stop...');
      execSync('taskkill /IM node.exe /F', { stdio: 'inherit' });
      console.log('node.exe processes terminated.');
    } else {
      console.log('No node.exe processes found.');
    }
  } catch (err) {
    console.log('No node.exe processes found or failed to query tasks.');
  }
}

function stopNodeUnix() {
  try {
    execSync('pgrep node', { stdio: ['pipe', 'pipe', 'ignore'] });
    console.log('Found node processes, attempting to stop...');
    execSync('pkill node', { stdio: 'inherit' });
    console.log('Node processes terminated.');
  } catch (err) {
    console.log('No node processes found.');
  }
}

if (process.platform === 'win32') {
  stopNodeWindows();
} else {
  stopNodeUnix();
}
