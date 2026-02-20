const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const legacyDbPath = path.resolve(rootDir, 'database.json');

function runScript(scriptName, required = true) {
  console.log(`\n▶ Running ${scriptName}...`);
  const shellCommand = process.platform === 'win32' ? 'cmd.exe' : 'sh';
  const shellArgs =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `npm run ${scriptName}`]
      : ['-lc', `npm run ${scriptName}`];

  const result = spawnSync(shellCommand, shellArgs, {
    cwd: rootDir,
    stdio: 'inherit'
  });

  if (result.error) {
    console.error(`Failed to run ${scriptName}: ${result.error.message}`);
    if (required) {
      process.exit(1);
    }
    return 1;
  }

  if (result.status !== 0 && required) {
    process.exit(result.status || 1);
  }

  return result.status || 0;
}

function main() {
  runScript('check:supabase', true);
  if (fs.existsSync(legacyDbPath)) {
    runScript('migrate:supabase', true);
  } else {
    console.log('\nℹ️ No legacy database.json found. Skipping legacy migration.');
  }
  console.log('\n✅ Supabase setup completed.');
}

main();
