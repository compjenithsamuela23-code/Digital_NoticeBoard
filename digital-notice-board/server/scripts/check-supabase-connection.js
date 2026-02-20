const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  dotenv.config();
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const REQUIRED_TABLES = ['users', 'categories', 'announcements', 'history'];
const OPTIONAL_TABLES = ['live_state'];
const RECOMMENDED_ANNOUNCEMENT_COLUMNS = [
  'id',
  'title',
  'content',
  'type',
  'file_name',
  'file_mime_type',
  'file_size_bytes'
];
const MODERN_HISTORY_COLUMNS = [
  'id',
  'title',
  'content',
  'action',
  'type',
  'file_name',
  'file_mime_type',
  'file_size_bytes'
];
const LEGACY_HISTORY_COLUMNS = ['announcement_id', 'data', 'action', 'action_at'];

function isMissingTableError(error, tableName) {
  return Boolean(
    error &&
      typeof error.message === 'string' &&
      error.message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

function getMissingColumnForTable(error, tableName) {
  if (!error || typeof error.message !== 'string') {
    return null;
  }

  const message = error.message;
  const postgrestRegex = new RegExp(`Could not find the '([^']+)' column of '${tableName}'`, 'i');
  const postgrestMatch = message.match(postgrestRegex);
  if (postgrestMatch) {
    return postgrestMatch[1];
  }

  const postgresRegex = new RegExp(
    `column ["']([^"']+)["'] of relation ["']${tableName}["'] does not exist`,
    'i'
  );
  const postgresMatch = message.match(postgresRegex);
  if (postgresMatch) {
    return postgresMatch[1];
  }

  return null;
}

async function checkTable(tableName) {
  const { data, error } = await supabase.from(tableName).select('*').limit(1);
  if (error) {
    return {
      table: tableName,
      ok: false,
      error
    };
  }

  return {
    table: tableName,
    ok: true,
    sampleRows: Array.isArray(data) ? data.length : 0
  };
}

async function checkRequiredColumns(tableName, columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    return { table: tableName, ok: true, missingColumns: [] };
  }

  const { error } = await supabase.from(tableName).select(columns.join(',')).limit(1);
  if (!error) {
    return { table: tableName, ok: true, missingColumns: [] };
  }

  const missingColumn = getMissingColumnForTable(error, tableName);
  if (missingColumn) {
    return { table: tableName, ok: false, missingColumns: [missingColumn], error };
  }

  return { table: tableName, ok: false, missingColumns: [], error };
}

async function main() {
  console.log('Checking Supabase connection...');
  const requiredResults = await Promise.all(REQUIRED_TABLES.map(checkTable));
  const optionalResults = await Promise.all(OPTIONAL_TABLES.map(checkTable));
  const results = [...requiredResults, ...optionalResults];

  const failed = [];
  for (const result of results) {
    if (result.ok) {
      console.log(`- ${result.table}: OK (${result.sampleRows} sample row(s))`);
      continue;
    }

    console.log(`- ${result.table}: ERROR (${result.error.message})`);
    failed.push(result);
  }

  const requiredFailed = failed.filter((result) => REQUIRED_TABLES.includes(result.table));
  const optionalFailed = failed.filter((result) => OPTIONAL_TABLES.includes(result.table));

  if (requiredFailed.length === 0) {
    const announcementColumnCheck = await checkRequiredColumns(
      'announcements',
      RECOMMENDED_ANNOUNCEMENT_COLUMNS
    );
    const historyModernCheck = await checkRequiredColumns('history', MODERN_HISTORY_COLUMNS);
    const historyLegacyCheck = historyModernCheck.ok
      ? { table: 'history', ok: false, missingColumns: [], error: null }
      : await checkRequiredColumns('history', LEGACY_HISTORY_COLUMNS);

    const historyCompatible = historyModernCheck.ok || historyLegacyCheck.ok;
    const columnChecks = [announcementColumnCheck];
    if (!historyCompatible) {
      columnChecks.push(historyModernCheck);
    }

    const columnFailures = columnChecks.filter((item) => !item.ok);
    const missingColumns = columnFailures.flatMap((item) =>
      item.missingColumns.map((column) => `${item.table}.${column}`)
    );

    if (columnFailures.length > 0) {
      console.log('');
      if (missingColumns.length > 0) {
        console.log('Recommended column(s) missing: ' + missingColumns.join(', '));
      } else {
        console.log('Recommended column check failed for one or more tables.');
        columnFailures.forEach((item) => {
          console.log(`- ${item.table}: ${item.error.message}`);
        });
      }
      console.log('Run server/supabase/schema.sql to upgrade schema (recommended).');
    }

    if (historyLegacyCheck.ok && !historyModernCheck.ok) {
      console.log('');
      console.log(
        'ℹ️ Legacy history schema detected. Runtime supports it, but modern columns are recommended.'
      );
      console.log('Run server/supabase/schema.sql to upgrade history schema.');
    }
  }

  if (requiredFailed.length === 0 && optionalFailed.length === 0) {
    console.log('Supabase is connected and all required tables are reachable.');
    return;
  }

  const missingRequiredTables = requiredFailed
    .filter((result) => isMissingTableError(result.error, result.table))
    .map((result) => result.table);
  const missingOptionalTables = optionalFailed
    .filter((result) => isMissingTableError(result.error, result.table))
    .map((result) => result.table);

  if (missingRequiredTables.length > 0) {
    console.log('');
    console.log('Missing required table(s): ' + missingRequiredTables.join(', '));
    console.log('Run this file in Supabase SQL Editor: server/supabase/schema.sql');
  }

  if (missingOptionalTables.length > 0) {
    console.log('');
    console.log(
      'Optional table(s) missing: ' +
        missingOptionalTables.join(', ') +
        ' (app will run with in-memory fallback)'
    );
    console.log('Run server/supabase/schema.sql if you want persisted live status.');
  }

  if (requiredFailed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Failed to verify Supabase connection:', error.message);
  process.exit(1);
});
