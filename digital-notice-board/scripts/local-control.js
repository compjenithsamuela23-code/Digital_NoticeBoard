const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const LOG_DIR = path.join(RUNTIME_DIR, 'logs');
const PID_FILE = path.join(RUNTIME_DIR, 'pids.json');
const npmSpawner =
  process.platform === 'win32'
    ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'npm'] }
    : { cmd: 'npm', args: [] };

function withNpmArgs(args) {
  return [...npmSpawner.args, ...args];
}

const SERVICES = {
  devBackend: {
    label: 'Dev Backend',
    cmd: npmSpawner.cmd,
    args: withNpmArgs(['--prefix', 'server', 'run', 'dev']),
    port: 5001,
    url: 'http://localhost:5001/api/test'
  },
  devFrontend: {
    label: 'Dev Frontend',
    cmd: npmSpawner.cmd,
    args: withNpmArgs(['--prefix', 'client', 'run', 'dev', '--', '--host', '0.0.0.0', '--port', '5173']),
    port: 5173,
    url: 'http://localhost:5173'
  },
  serveBackend: {
    label: 'Serve Backend',
    cmd: process.execPath,
    args: ['index.js'],
    cwd: path.join(ROOT, 'server'),
    port: 5001,
    url: 'http://localhost:5001/admin'
  },
  serveRedirect: {
    label: 'Serve Redirect',
    cmd: process.execPath,
    args: [path.join(ROOT, 'scripts', 'redirect-5173.js')],
    cwd: ROOT,
    port: 5173,
    url: 'http://localhost:5173/admin'
  }
};

function ensureRuntime() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readPids() {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writePids(pids) {
  ensureRuntime();
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

function isPidRunning(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  if (!isPidRunning(pid)) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    process.kill(pid, 'SIGTERM');
  }
}

function startService(serviceName) {
  const service = SERVICES[serviceName];
  if (!service) {
    throw new Error(`Unknown service: ${serviceName}`);
  }

  const pids = readPids();
  if (isPidRunning(pids[serviceName])) {
    return { pid: pids[serviceName], alreadyRunning: true };
  }

  ensureRuntime();
  const logPath = path.join(LOG_DIR, `${serviceName}.log`);
  const serviceCwd = service.cwd || ROOT;
  const outFd = fs.openSync(logPath, 'a');
  const child = spawn(service.cmd, service.args, {
    cwd: serviceCwd,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    windowsHide: true
  });

  child.unref();
  pids[serviceName] = child.pid;
  writePids(pids);

  return { pid: child.pid, alreadyRunning: false };
}

function stopService(serviceName) {
  const pids = readPids();
  const pid = pids[serviceName];
  if (!pid) return false;

  killPid(pid);
  delete pids[serviceName];
  writePids(pids);
  return true;
}

function isPortOpen(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function waitForPort(port, attempts = 30, delayMs = 500) {
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortOpen(port)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function runOrThrow(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

async function cmdDevUp() {
  stopService('serveBackend');
  stopService('serveRedirect');
  const backend = startService('devBackend');
  const frontend = startService('devFrontend');

  const backendReady = await waitForPort(SERVICES.devBackend.port);
  const frontendReady = await waitForPort(SERVICES.devFrontend.port);

  console.log(
    `Dev backend: ${backend.alreadyRunning ? 'already running' : 'started'} (pid ${backend.pid})`
  );
  console.log(
    `Dev frontend: ${frontend.alreadyRunning ? 'already running' : 'started'} (pid ${frontend.pid})`
  );
  console.log(`Backend ready: ${backendReady ? 'yes' : 'no'} -> ${SERVICES.devBackend.url}`);
  console.log(`Frontend ready: ${frontendReady ? 'yes' : 'no'} -> ${SERVICES.devFrontend.url}`);
  console.log(`Logs: ${LOG_DIR}`);
}

async function cmdDevDown() {
  const backendStopped = stopService('devBackend');
  const frontendStopped = stopService('devFrontend');
  console.log(`Dev backend stopped: ${backendStopped ? 'yes' : 'no process'}`);
  console.log(`Dev frontend stopped: ${frontendStopped ? 'yes' : 'no process'}`);
}

async function cmdServeUp() {
  stopService('devFrontend');
  stopService('devBackend');
  stopService('serveBackend');
  stopService('serveRedirect');

  runOrThrow(npmSpawner.cmd, withNpmArgs(['--prefix', 'client', 'run', 'build']));

  const server = startService('serveBackend');
  const redirect = startService('serveRedirect');
  const ready = await waitForPort(SERVICES.serveBackend.port);
  const redirectReady = await waitForPort(SERVICES.serveRedirect.port);
  console.log(`Serve backend: ${server.alreadyRunning ? 'already running' : 'started'} (pid ${server.pid})`);
  console.log(
    `Serve redirect: ${redirect.alreadyRunning ? 'already running' : 'started'} (pid ${redirect.pid})`
  );
  console.log(`Ready: ${ready ? 'yes' : 'no'} -> ${SERVICES.serveBackend.url}`);
  console.log(`Redirect ready: ${redirectReady ? 'yes' : 'no'} -> ${SERVICES.serveRedirect.url}`);
  console.log(`Logs: ${LOG_DIR}`);
}

async function cmdServeStart() {
  stopService('devFrontend');
  stopService('devBackend');
  stopService('serveBackend');
  stopService('serveRedirect');

  const server = startService('serveBackend');
  const redirect = startService('serveRedirect');
  const ready = await waitForPort(SERVICES.serveBackend.port);
  const redirectReady = await waitForPort(SERVICES.serveRedirect.port);
  console.log(`Serve backend: ${server.alreadyRunning ? 'already running' : 'started'} (pid ${server.pid})`);
  console.log(
    `Serve redirect: ${redirect.alreadyRunning ? 'already running' : 'started'} (pid ${redirect.pid})`
  );
  console.log(`Ready: ${ready ? 'yes' : 'no'} -> ${SERVICES.serveBackend.url}`);
  console.log(`Redirect ready: ${redirectReady ? 'yes' : 'no'} -> ${SERVICES.serveRedirect.url}`);
  console.log(`Logs: ${LOG_DIR}`);
}

async function cmdServeDown() {
  const stopped = stopService('serveBackend');
  const redirectStopped = stopService('serveRedirect');
  console.log(`Serve backend stopped: ${stopped ? 'yes' : 'no process'}`);
  console.log(`Serve redirect stopped: ${redirectStopped ? 'yes' : 'no process'}`);
}

async function cmdStatus() {
  const pids = readPids();

  const devBackendRunning = isPidRunning(pids.devBackend);
  const devFrontendRunning = isPidRunning(pids.devFrontend);
  const serveBackendRunning = isPidRunning(pids.serveBackend);
  const serveRedirectRunning = isPidRunning(pids.serveRedirect);

  const port5001 = await isPortOpen(5001);
  const port5173 = await isPortOpen(5173);

  console.log(`PID file: ${PID_FILE}`);
  console.log(`devBackend pid: ${pids.devBackend || '-'} running: ${devBackendRunning ? 'yes' : 'no'}`);
  console.log(`devFrontend pid: ${pids.devFrontend || '-'} running: ${devFrontendRunning ? 'yes' : 'no'}`);
  console.log(`serveBackend pid: ${pids.serveBackend || '-'} running: ${serveBackendRunning ? 'yes' : 'no'}`);
  console.log(
    `serveRedirect pid: ${pids.serveRedirect || '-'} running: ${serveRedirectRunning ? 'yes' : 'no'}`
  );
  console.log(`port 5001 open: ${port5001 ? 'yes' : 'no'}`);
  console.log(`port 5173 open: ${port5173 ? 'yes' : 'no'}`);
}

async function main() {
  const action = String(process.argv[2] || '').trim();
  if (!action) {
    console.error(
      'Usage: node scripts/local-control.js <dev-up|dev-down|serve-up|serve-start|serve-down|status>'
    );
    process.exit(1);
  }

  try {
    if (action === 'dev-up') return cmdDevUp();
    if (action === 'dev-down') return cmdDevDown();
    if (action === 'serve-up') return cmdServeUp();
    if (action === 'serve-start') return cmdServeStart();
    if (action === 'serve-down') return cmdServeDown();
    if (action === 'status') return cmdStatus();

    console.error(`Unknown action: ${action}`);
    process.exit(1);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

main();
