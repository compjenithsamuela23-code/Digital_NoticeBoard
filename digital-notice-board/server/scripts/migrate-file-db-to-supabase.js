const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const { randomUUID, createHash } = require('crypto');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  dotenv.config();
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment variables.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const DB_FILE = path.resolve(__dirname, '../database.json');

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

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function uuidFromSeed(seed) {
  const hash = createHash('sha1').update(seed).digest('hex');
  const base = hash.slice(0, 32);
  return `${base.slice(0, 8)}-${base.slice(8, 12)}-5${base.slice(13, 16)}-a${base.slice(17, 20)}-${base.slice(20, 32)}`;
}

function mapLegacyId(raw, namespace) {
  if (raw && isUuid(raw)) return String(raw).toLowerCase();
  if (!raw) return randomUUID();
  return uuidFromSeed(`${namespace}:${raw}`);
}

function toIso(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true';
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeLiveStreamLinks(value, maxLinks = 24) {
  let values = [];
  if (Array.isArray(value)) {
    values = value;
  } else {
    const normalized = String(value || '').trim();
    if (normalized.startsWith('[') && normalized.endsWith(']')) {
      try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) {
          values = parsed;
        }
      } catch {
        values = [];
      }
    } else if (normalized) {
      values = normalized.split(/[\n,]+/).map((item) => item.trim());
    }
  }

  const unique = [];
  values.forEach((item) => {
    const normalized = String(item || '').trim();
    if (!normalized) return;
    if (!isValidHttpUrl(normalized)) return;
    if (unique.includes(normalized)) return;
    unique.push(normalized);
  });
  return unique.slice(0, maxLinks);
}

function sanitizeOriginalFileName(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, 255);
}

function normalizeMimeType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw.includes('/')) return null;
  return raw.split(';')[0].trim().slice(0, 120) || null;
}

function resolveMappedId(map, raw, namespace, fallbackSeed) {
  const key = raw || fallbackSeed;
  if (!key) return null;
  if (!map.has(key)) {
    map.set(key, mapLegacyId(key, namespace));
  }
  return map.get(key);
}

function normalizeAnnouncement(row, index, announcementIdMap, categoryIdMap) {
  const now = new Date().toISOString();
  const createdAt = toIso(row.createdAt, now);
  const startAt = toIso(row.startAt, createdAt);
  const endAt = toIso(row.endAt || row.expiresAt, startAt);
  const priority = Number.parseInt(row.priority, 10);
  const duration = Number.parseInt(row.duration, 10);
  const fileSize = Number.parseInt(row.fileSizeBytes, 10);

  return {
    id: resolveMappedId(announcementIdMap, row.id, 'announcement', `announcement-${index}`),
    title: row.title || '',
    content: row.content || '',
    priority: Number.isNaN(priority) ? 1 : priority,
    duration: Number.isNaN(duration) ? 7 : duration,
    is_active: toBoolean(row.isActive, true),
    category: resolveMappedId(categoryIdMap, row.category, 'category', null),
    image: row.image || null,
    type: row.type || (row.image ? (row.content ? 'mixed' : 'image') : 'text'),
    file_name: sanitizeOriginalFileName(row.fileName) || null,
    file_mime_type: normalizeMimeType(row.fileMimeType) || null,
    file_size_bytes:
      row.fileSizeBytes === undefined || row.fileSizeBytes === null
        ? null
        : Number.isNaN(fileSize)
          ? null
          : Math.max(0, fileSize),
    live_stream_links: normalizeLiveStreamLinks(
      row.liveStreamLinks !== undefined ? row.liveStreamLinks : row.live_stream_links
    ),
    created_at: createdAt,
    start_at: startAt,
    end_at: endAt,
    expires_at: toIso(row.expiresAt, endAt)
  };
}

function normalizeHistory(row, index, announcementIdMap, categoryIdMap) {
  const now = new Date().toISOString();
  const createdAt = toIso(row.createdAt, now);
  const startAt = toIso(row.startAt, createdAt);
  const endAt = toIso(row.endAt || row.expiresAt, startAt);
  const priority = Number.parseInt(row.priority, 10);
  const duration = Number.parseInt(row.duration, 10);
  const fileSize = Number.parseInt(row.fileSizeBytes, 10);

  return {
    id: resolveMappedId(announcementIdMap, row.id, 'announcement', `history-announcement-${index}`),
    title: row.title || '',
    content: row.content || '',
    priority: Number.isNaN(priority) ? 1 : priority,
    duration: Number.isNaN(duration) ? 7 : duration,
    is_active: toBoolean(row.isActive, true),
    category: resolveMappedId(categoryIdMap, row.category, 'category', null),
    image: row.image || null,
    type: row.type || (row.image ? (row.content ? 'mixed' : 'image') : 'text'),
    file_name: sanitizeOriginalFileName(row.fileName) || null,
    file_mime_type: normalizeMimeType(row.fileMimeType) || null,
    file_size_bytes:
      row.fileSizeBytes === undefined || row.fileSizeBytes === null
        ? null
        : Number.isNaN(fileSize)
          ? null
          : Math.max(0, fileSize),
    live_stream_links: normalizeLiveStreamLinks(
      row.liveStreamLinks !== undefined ? row.liveStreamLinks : row.live_stream_links
    ),
    created_at: createdAt,
    start_at: startAt,
    end_at: endAt,
    expires_at: toIso(row.expiresAt, endAt),
    action: row.action || 'updated',
    action_at: toIso(row.actionAt || row.deletedAt, now),
    user_email: row.user || null
  };
}

function normalizeCategory(row, index, categoryIdMap) {
  return {
    id: resolveMappedId(categoryIdMap, row.id, 'category', `category-${index}`),
    name: row.name || '',
    created_at: toIso(row.createdAt, new Date().toISOString())
  };
}

function normalizeUser(row, index, userIdMap) {
  const rawPassword = row.password || '';
  const normalizedPassword =
    /^\$2[aby]\$\d{2}\$/.test(String(rawPassword)) ? rawPassword : bcrypt.hashSync(String(rawPassword), 10);

  return {
    id: resolveMappedId(userIdMap, row.id, 'user', `user-${row.email || index}`),
    email: row.email,
    password: normalizedPassword,
    role: row.role || 'admin',
    created_at: toIso(row.createdAt, new Date().toISOString())
  };
}

function normalizeLive(row) {
  const now = new Date().toISOString();
  return {
    id: 1,
    status: row && row.status ? row.status : 'OFF',
    link: row && row.link ? row.link : null,
    started_at: toIso(row && row.startedAt, null),
    stopped_at: toIso(row && row.stoppedAt, null),
    updated_at: now
  };
}

async function upsertRows(table, rows, onConflict, options = {}) {
  if (!rows || rows.length === 0) return;

  const writableRows = rows.map((row) => ({ ...row }));
  const removedColumns = new Set();

  while (true) {
    const { error } = await supabase.from(table).upsert(writableRows, { onConflict });
    if (!error) return;

    if (options.optionalMissingTable && isMissingTableError(error, table)) {
      console.log(`⚠️ Skipping ${table}: table is missing in Supabase.`);
      return;
    }

    const missingColumn = getMissingColumnForTable(error, table);
    if (missingColumn && !removedColumns.has(missingColumn)) {
      removedColumns.add(missingColumn);
      writableRows.forEach((row) => {
        if (Object.prototype.hasOwnProperty.call(row, missingColumn)) {
          delete row[missingColumn];
        }
      });
      console.log(`⚠️ Skipping unsupported column "${missingColumn}" while migrating ${table}.`);
      continue;
    }

    throw new Error(`Error migrating ${table}: ${error.message}`);
  }
}

async function main() {
  try {
    await fs.access(DB_FILE);
  } catch {
    console.log('ℹ️ No legacy database.json found. Nothing to migrate.');
    return;
  }

  const raw = await fs.readFile(DB_FILE, 'utf8');
  const parsed = JSON.parse(raw);

  const userIdMap = new Map();
  const categoryIdMap = new Map();
  const announcementIdMap = new Map();

  const users = (parsed.users || []).filter((u) => u && u.email).map((row, index) => normalizeUser(row, index, userIdMap));
  const categories = (parsed.categories || [])
    .filter((c) => c && c.name)
    .map((row, index) => normalizeCategory(row, index, categoryIdMap));
  const announcements = (parsed.announcements || []).map((row, index) =>
    normalizeAnnouncement(row, index, announcementIdMap, categoryIdMap)
  );
  const history = (parsed.history || []).map((row, index) =>
    normalizeHistory(row, index, announcementIdMap, categoryIdMap)
  );
  const live = normalizeLive(parsed.live);

  await upsertRows('users', users, 'email');
  await upsertRows('categories', categories, 'id');
  await upsertRows('announcements', announcements, 'id');
  await upsertRows('history', history, 'id,action,action_at');
  await upsertRows('live_state', [live], 'id', { optionalMissingTable: true });

  console.log('✅ Migration complete.');
  console.log(`- Users: ${users.length}`);
  console.log(`- Categories: ${categories.length}`);
  console.log(`- Announcements: ${announcements.length}`);
  console.log(`- History entries: ${history.length}`);
  console.log('- Live status: 1 row (or skipped if live_state table is missing)');
}

main().catch((error) => {
  console.error('❌ Migration failed:', error.message);
  process.exit(1);
});
