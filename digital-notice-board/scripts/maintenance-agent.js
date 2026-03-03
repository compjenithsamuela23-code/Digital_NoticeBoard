const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'maintenance-agent-status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'pids.json');
const LOCAL_CONTROL_SCRIPT = path.join(ROOT, 'scripts', 'local-control.js');

const AGENT_NAME = 'Digital Notice Board Maintenance Agent';
const AGENT_VERSION = '1.0.0';
const HEALTH_URL = String(process.env.MAINTENANCE_AGENT_HEALTH_URL || 'http://127.0.0.1:5001/api/health').trim();
const NETWORK_URL = String(process.env.MAINTENANCE_AGENT_NETWORK_URL || 'https://www.gstatic.com/generate_204').trim();
const DNS_HOST = String(process.env.MAINTENANCE_AGENT_DNS_HOST || 'google.com').trim();
const LOOP_INTERVAL_MS = toBoundedInteger(process.env.MAINTENANCE_AGENT_INTERVAL_MS, 45000, 10000, 10 * 60 * 1000);
const API_TIMEOUT_MS = toBoundedInteger(process.env.MAINTENANCE_AGENT_API_TIMEOUT_MS, 7000, 2000, 60000);
const NETWORK_TIMEOUT_MS = toBoundedInteger(
  process.env.MAINTENANCE_AGENT_NETWORK_TIMEOUT_MS,
  5000,
  1000,
  60000
);
const FAILURE_THRESHOLD = toBoundedInteger(process.env.MAINTENANCE_AGENT_FAILURE_THRESHOLD, 3, 1, 10);
const RECOVERY_COOLDOWN_MS = toBoundedInteger(
  process.env.MAINTENANCE_AGENT_RECOVERY_COOLDOWN_MS,
  5 * 60 * 1000,
  30 * 1000,
  60 * 60 * 1000
);
const RECOVERY_TIMEOUT_MS = toBoundedInteger(
  process.env.MAINTENANCE_AGENT_RECOVERY_TIMEOUT_MS,
  120000,
  10000,
  10 * 60 * 1000
);
const RUN_ONCE = process.argv.includes('--once');

const state = {
  startedAt: new Date().toISOString(),
  consecutiveFailures: 0,
  checksCompleted: 0,
  lastRecoveryAtMs: 0,
  recoveryAttempts: 0,
  recoveryFailures: 0,
  lastRecovery: null
};

let shuttingDown = false;
let loopTimer = null;

function toBoundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function nowIso() {
  return new Date().toISOString();
}

function ensureRuntime() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function readJsonFile(filePath, fallbackValue) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

function writeJsonFile(filePath, payload) {
  ensureRuntime();
  const tempFilePath = `${filePath}.tmp`;
  fs.writeFileSync(tempFilePath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tempFilePath, filePath);
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

function summarizeProcesses() {
  const pids = readJsonFile(PID_FILE, {});
  const processes = {
    devBackend: { pid: pids.devBackend || null, running: isPidRunning(pids.devBackend) },
    devFrontend: { pid: pids.devFrontend || null, running: isPidRunning(pids.devFrontend) },
    serveBackend: { pid: pids.serveBackend || null, running: isPidRunning(pids.serveBackend) },
    serveRedirect: { pid: pids.serveRedirect || null, running: isPidRunning(pids.serveRedirect) }
  };

  let mode = 'standalone';
  if (processes.serveBackend.pid || processes.serveRedirect.pid) {
    mode = 'serve';
  } else if (processes.devBackend.pid || processes.devFrontend.pid) {
    mode = 'dev';
  }

  return { pids, mode, processes };
}

async function fetchWithTimeout(url, timeoutMs) {
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });
    const bodyText = await response.text().catch(() => '');
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAtMs,
      bodyText,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAtMs,
      bodyText: '',
      error: error.message || 'Request failed'
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function probeApiHealth() {
  const rawResult = await fetchWithTimeout(HEALTH_URL, API_TIMEOUT_MS);
  let payload = null;
  if (rawResult.bodyText) {
    try {
      payload = JSON.parse(rawResult.bodyText);
    } catch {
      payload = null;
    }
  }

  const healthStatus = String(payload?.status || '').toLowerCase();
  const dbStatus = String(payload?.database || '').toLowerCase();
  const ok = Boolean(rawResult.ok) && healthStatus === 'ok' && dbStatus !== 'degraded';

  return {
    ok,
    statusCode: rawResult.status,
    latencyMs: rawResult.latencyMs,
    status: healthStatus || null,
    database: dbStatus || null,
    error: rawResult.error
  };
}

async function probeNetwork() {
  const rawResult = await fetchWithTimeout(NETWORK_URL, NETWORK_TIMEOUT_MS);
  return {
    ok: Boolean(rawResult.ok),
    statusCode: rawResult.status,
    latencyMs: rawResult.latencyMs,
    error: rawResult.error
  };
}

async function probeDns() {
  const startedAtMs = Date.now();
  try {
    const result = await Promise.race([
      dns.lookup(DNS_HOST),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DNS probe timed out')), NETWORK_TIMEOUT_MS)
      )
    ]);
    return {
      ok: true,
      latencyMs: Date.now() - startedAtMs,
      address: result.address,
      family: result.family,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAtMs,
      address: null,
      family: null,
      error: error.message || 'DNS probe failed'
    };
  }
}

function shouldRecover(mode, processSummary, apiCheck) {
  if (mode === 'serve') {
    return !processSummary.serveBackend.running || !apiCheck.ok;
  }
  if (mode === 'dev') {
    return !processSummary.devBackend.running || !processSummary.devFrontend.running;
  }
  return false;
}

function runRecoveryAction(mode) {
  if (mode !== 'serve' && mode !== 'dev') {
    return {
      attempted: false,
      success: false,
      action: null,
      reason: 'No managed mode detected for automatic recovery.',
      output: ''
    };
  }

  const action = mode === 'serve' ? 'serve-start' : 'dev-up';
  const child = spawnSync(process.execPath, [LOCAL_CONTROL_SCRIPT, action], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: RECOVERY_TIMEOUT_MS,
    windowsHide: true
  });

  const output = [String(child.stdout || '').trim(), String(child.stderr || '').trim()]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
  const success = !child.error && Number(child.status || 0) === 0;

  return {
    attempted: true,
    success,
    action,
    reason: success ? 'Recovery command completed.' : child.error?.message || `Exit code ${child.status}`,
    output
  };
}

function buildSummaryState({ apiCheck, networkCheck, dnsCheck, processSummary, recoveryResult }) {
  const hasCriticalIssue = shouldRecover(processSummary.mode, processSummary.processes, apiCheck);
  if (recoveryResult?.attempted && recoveryResult.success) {
    return {
      state: 'recovering',
      message: 'Recovery action executed. Waiting for next cycle confirmation.',
      hasCriticalIssue
    };
  }
  if (hasCriticalIssue || !networkCheck.ok || !dnsCheck.ok) {
    return {
      state: 'degraded',
      message: hasCriticalIssue
        ? 'Critical service health issue detected.'
        : 'Network/DNS issue detected while core API is reachable.',
      hasCriticalIssue
    };
  }
  return {
    state: 'healthy',
    message: 'All monitored checks are passing.',
    hasCriticalIssue: false
  };
}

function buildStatusPayload({ processSummary, apiCheck, networkCheck, dnsCheck, recoveryResult, summaryState }) {
  return {
    agent: {
      name: AGENT_NAME,
      version: AGENT_VERSION,
      pid: process.pid,
      startedAt: state.startedAt,
      intervalMs: LOOP_INTERVAL_MS,
      healthUrl: HEALTH_URL
    },
    updatedAt: nowIso(),
    mode: processSummary.mode,
    summary: {
      state: summaryState.state,
      message: summaryState.message,
      consecutiveFailures: state.consecutiveFailures,
      checksCompleted: state.checksCompleted
    },
    checks: {
      api: apiCheck,
      network: networkCheck,
      dns: dnsCheck
    },
    processes: processSummary.processes,
    recovery: {
      threshold: FAILURE_THRESHOLD,
      cooldownMs: RECOVERY_COOLDOWN_MS,
      attempts: state.recoveryAttempts,
      failures: state.recoveryFailures,
      last: state.lastRecovery,
      current: recoveryResult
    }
  };
}

async function runCycle() {
  const processSummary = summarizeProcesses();
  const [apiCheck, networkCheck, dnsCheck] = await Promise.all([
    probeApiHealth(),
    probeNetwork(),
    probeDns()
  ]);

  const criticalFailure = shouldRecover(processSummary.mode, processSummary.processes, apiCheck);
  state.checksCompleted += 1;
  state.consecutiveFailures = criticalFailure ? state.consecutiveFailures + 1 : 0;

  let recoveryResult = {
    attempted: false,
    success: false,
    action: null,
    reason: 'No recovery needed.',
    output: ''
  };

  const cooldownReady = Date.now() - state.lastRecoveryAtMs >= RECOVERY_COOLDOWN_MS;
  if (criticalFailure && state.consecutiveFailures >= FAILURE_THRESHOLD && cooldownReady) {
    recoveryResult = runRecoveryAction(processSummary.mode);
    state.recoveryAttempts += recoveryResult.attempted ? 1 : 0;
    state.recoveryFailures += recoveryResult.attempted && !recoveryResult.success ? 1 : 0;
    state.lastRecoveryAtMs = Date.now();
    state.lastRecovery = {
      attemptedAt: nowIso(),
      action: recoveryResult.action,
      success: recoveryResult.success,
      reason: recoveryResult.reason,
      output: recoveryResult.output
    };
  }

  const summaryState = buildSummaryState({
    processSummary,
    apiCheck,
    networkCheck,
    dnsCheck,
    recoveryResult
  });

  const payload = buildStatusPayload({
    processSummary,
    apiCheck,
    networkCheck,
    dnsCheck,
    recoveryResult,
    summaryState
  });
  writeJsonFile(STATUS_FILE, payload);

  const apiLatency = apiCheck.latencyMs !== null && apiCheck.latencyMs !== undefined ? `${apiCheck.latencyMs}ms` : '-';
  const networkLatency =
    networkCheck.latencyMs !== null && networkCheck.latencyMs !== undefined ? `${networkCheck.latencyMs}ms` : '-';
  console.log(
    `[maintenance-agent] state=${summaryState.state} mode=${processSummary.mode} api=${apiCheck.ok ? 'ok' : 'fail'}(${apiLatency}) network=${networkCheck.ok ? 'ok' : 'fail'}(${networkLatency}) failures=${state.consecutiveFailures}`
  );
}

function scheduleNextCycle() {
  if (shuttingDown) return;
  loopTimer = setTimeout(async () => {
    try {
      await runCycle();
    } catch (error) {
      console.error('[maintenance-agent] cycle failed:', error.message || String(error));
    } finally {
      scheduleNextCycle();
    }
  }, LOOP_INTERVAL_MS);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }

  const existing = readJsonFile(STATUS_FILE, null);
  if (existing && typeof existing === 'object') {
    existing.updatedAt = nowIso();
    existing.summary = {
      ...(existing.summary || {}),
      state: 'stopped',
      message: 'Maintenance agent stopped.'
    };
    writeJsonFile(STATUS_FILE, existing);
  }
}

async function main() {
  ensureRuntime();
  console.log(
    `[maintenance-agent] starting (interval=${LOOP_INTERVAL_MS}ms threshold=${FAILURE_THRESHOLD} cooldown=${RECOVERY_COOLDOWN_MS}ms)`
  );
  await runCycle();
  if (RUN_ONCE) {
    return;
  }
  scheduleNextCycle();
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

main().catch((error) => {
  console.error('[maintenance-agent] fatal error:', error.message || String(error));
  shutdown();
  process.exit(1);
});
