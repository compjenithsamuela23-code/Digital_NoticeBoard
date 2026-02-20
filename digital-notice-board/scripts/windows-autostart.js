const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const action = String(process.argv[2] || '').trim().toLowerCase();
const mode = String(process.argv[3] || 'serve').trim().toLowerCase();

if (process.platform !== 'win32') {
  console.error('Windows autostart is only available on Windows.');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..', '..');
const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
const AUTOSTART_FILE = path.join(STARTUP_DIR, 'DigitalNoticeBoardAutoStart.vbs');
const CONTROL_SCRIPT = path.join(ROOT, 'digital-notice-board', 'scripts', 'local-control.js');

function ensureStartupDir() {
  fs.mkdirSync(STARTUP_DIR, { recursive: true });
}

function toVbsString(value) {
  return String(value).replace(/"/g, '""');
}

function buildCommand(targetMode) {
  const validMode = targetMode === 'dev' ? 'dev-up' : 'serve-start';
  return `"${process.execPath}" "${CONTROL_SCRIPT}" ${validMode}`;
}

function install(targetMode) {
  ensureStartupDir();
  const command = buildCommand(targetMode);
  const content = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.CurrentDirectory = "${toVbsString(ROOT)}"`,
    `WshShell.Run "${toVbsString(command)}", 0, False`
  ].join('\r\n');

  fs.writeFileSync(AUTOSTART_FILE, content, 'utf8');
  console.log(`Installed autostart: ${AUTOSTART_FILE}`);
  console.log(
    `Mode: ${
      targetMode === 'dev'
        ? 'dev (http://localhost:5173/admin)'
        : 'serve (http://localhost:5001/admin)'
    }`
  );
}

function remove() {
  if (fs.existsSync(AUTOSTART_FILE)) {
    fs.unlinkSync(AUTOSTART_FILE);
    console.log('Autostart removed.');
    return;
  }
  console.log('Autostart file does not exist.');
}

function status() {
  if (!fs.existsSync(AUTOSTART_FILE)) {
    console.log('Autostart: not installed');
    return;
  }
  console.log('Autostart: installed');
  console.log(`File: ${AUTOSTART_FILE}`);
  const content = fs.readFileSync(AUTOSTART_FILE, 'utf8');
  const detectedMode = content.includes('serve-start') ? 'serve' : 'dev';
  console.log(`Mode: ${detectedMode}`);
}

function runNow() {
  const result = spawnSync(process.execPath, [CONTROL_SCRIPT, mode === 'dev' ? 'dev-up' : 'serve-start'], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

if (action === 'install') {
  install(mode);
  process.exit(0);
}
if (action === 'remove') {
  remove();
  process.exit(0);
}
if (action === 'status') {
  status();
  process.exit(0);
}
if (action === 'run-now') {
  runNow();
  process.exit(0);
}

console.log('Usage: node digital-notice-board/scripts/windows-autostart.js <install|remove|status|run-now> [dev|serve]');
process.exit(1);
