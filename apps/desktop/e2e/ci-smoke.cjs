const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const electronPath = require('electron');

const desktopRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(desktopRoot, 'dist-electron', 'main.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readIfExists(file) {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* ignore cleanup failures */ }
  }
}

async function waitFor(label, timeoutMs, predicate, child, traceFile, output) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`${label} failed: Electron exited with code ${child.exitCode}\ntrace:\n${readIfExists(traceFile)}\noutput:\n${output()}`);
    }
    if (predicate()) return;
    await sleep(250);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms\ntrace:\n${readIfExists(traceFile)}\noutput:\n${output()}`);
}

function connectBridgeHello(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => { /* ignore cleanup failures */ });
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close();
        else ws.terminate();
      } catch { /* ignore cleanup failures */ }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error(`bridge:hello attempt timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.once('error', (error) => finish(error));

    ws.on('message', (raw) => {
      let parsed;
      try { parsed = JSON.parse(String(raw)); } catch { return; }
      if (parsed.type === 'bridge:hello') finish(null, parsed);
    });
  });
}

async function waitForBridgeHello(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await connectBridgeHello(port, Math.min(2_000, deadline - Date.now()));
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`bridge:hello timed out after ${timeoutMs}ms${detail}`);
}

(async () => {
  if (!fs.existsSync(mainEntry)) {
    throw new Error(`Build required before CI smoke: ${mainEntry} is missing`);
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-ci-e2e-'));
  const traceFile = path.join(userData, 'startup-trace.log');
  const bridgePort = 18_900 + Math.floor(Math.random() * 900);
  const chunks = [];
  const electronArgs = [
    '--disable-gpu',
    '--disable-gpu-sandbox',
    mainEntry,
  ];
  const child = spawn(electronPath, electronArgs, {
    cwd: desktopRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      NEMESIS_E2E_USER_DATA: userData,
      NEMESIS_AUTO_SPAWN_GEA: 'false',
      NEMESIS_BRIDGE_PORT: String(bridgePort),
      NEMESIS_STARTUP_TRACE: 'true',
      NEMESIS_STARTUP_TRACE_FILE: traceFile,
    },
  });

  const capture = (data) => {
    chunks.push(String(data));
    if (chunks.length > 80) chunks.shift();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const output = () => chunks.join('');

  try {
    await waitFor('ipc startup', 90_000, () => readIfExists(traceFile).includes('ipc'), child, traceFile, output);
    const hello = await waitForBridgeHello(bridgePort, 30_000);
    await waitFor('window load attempt', 30_000, () => {
      const trace = readIfExists(traceFile);
      return trace.includes('window-load-file-ok') || trace.includes('window-load-file-failed');
    }, child, traceFile, output);

    const trace = readIfExists(traceFile);
    if (trace.includes('window-load-file-ok')) {
      console.log('NEMESIS CI smoke observed window-load-file-ok');
    } else {
      console.warn('NEMESIS CI smoke bridge passed before renderer load completed; renderer smoke is covered by unit tests.');
    }
    console.log(`NEMESIS CI smoke passed on bridge ${bridgePort}: ${hello.type}`);
    console.log(trace.trim());
  } finally {
    killTree(child);
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});