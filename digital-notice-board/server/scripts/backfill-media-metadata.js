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
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment variables.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.webp',
  '.avif',
  '.heif',
  '.heic',
  '.apng',
  '.svg'
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.m4v',
  '.m4p',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.ogg',
  '.ogv',
  '.flv',
  '.f4v',
  '.wmv',
  '.asf',
  '.ts',
  '.m2ts',
  '.mts',
  '.3gp',
  '.3g2',
  '.mpg',
  '.mpeg',
  '.mpe'
]);
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.pps',
  '.ppsx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
  '.rtf',
  '.odt',
  '.ods',
  '.odp',
  '.md',
  '.json',
  '.xml',
  '.zip',
  '.rar',
  '.7z'
]);
const GENERIC_MIME_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);
const MIME_TYPE_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heif': 'image/heif',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed'
};

function normalizeMimeType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw.includes('/')) return null;
  return raw.split(';')[0].trim().slice(0, 120) || null;
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

  const flatColumnRegex = new RegExp(`column\\s+${tableName}\\.([a-zA-Z0-9_]+)\\s+does not exist`, 'i');
  const flatColumnMatch = message.match(flatColumnRegex);
  if (flatColumnMatch) {
    return flatColumnMatch[1];
  }

  return null;
}

function getMediaPathExtension(mediaPath) {
  const raw = String(mediaPath || '').trim();
  if (!raw) return '';

  const withoutQuery = raw.split('?')[0].split('#')[0];
  if (/^https?:\/\//i.test(withoutQuery)) {
    try {
      return path.extname(new URL(withoutQuery).pathname).toLowerCase();
    } catch {
      return path.extname(withoutQuery).toLowerCase();
    }
  }

  return path.extname(withoutQuery).toLowerCase();
}

function inferMimeTypeFromReference(reference) {
  const extension = getMediaPathExtension(reference);
  if (!extension) return null;
  return MIME_TYPE_BY_EXTENSION[extension] || null;
}

function resolveMimeType(candidateMimeType, references = []) {
  const normalized = normalizeMimeType(candidateMimeType);
  if (normalized && !GENERIC_MIME_TYPES.has(normalized)) {
    return normalized;
  }

  for (const reference of references) {
    const inferred = inferMimeTypeFromReference(reference);
    if (inferred) return inferred;
  }

  return normalized || null;
}

function isImagePath(mediaPath) {
  return IMAGE_EXTENSIONS.has(getMediaPathExtension(mediaPath));
}

function isVideoPath(mediaPath) {
  return VIDEO_EXTENSIONS.has(getMediaPathExtension(mediaPath));
}

function isDocumentPath(mediaPath) {
  return DOCUMENT_EXTENSIONS.has(getMediaPathExtension(mediaPath));
}

function getAnnouncementType(mediaPath, contentValue, mimeType) {
  if (!mediaPath) {
    return 'text';
  }

  const hasContent = Boolean(String(contentValue || '').trim());
  const normalizedMime = String(mimeType || '').toLowerCase();
  const isVideo = normalizedMime.startsWith('video/') || isVideoPath(mediaPath);
  const isImage = normalizedMime.startsWith('image/') || isImagePath(mediaPath);
  const isLikelyDocumentPath = Boolean(mediaPath) && !isVideoPath(mediaPath) && !isImagePath(mediaPath);
  const isDocument =
    normalizedMime.startsWith('application/') ||
    normalizedMime.startsWith('text/') ||
    isDocumentPath(mediaPath) ||
    isLikelyDocumentPath;

  if (isVideo) {
    return hasContent ? 'mixed_video' : 'video';
  }

  if (isDocument && !isImage) {
    return hasContent ? 'mixed_document' : 'document';
  }

  return hasContent ? 'mixed' : 'image';
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveDimensions(mediaPath, type, mimeType, widthValue, heightValue) {
  const width = parsePositiveInteger(widthValue);
  const height = parsePositiveInteger(heightValue);
  if (width && height) {
    return { width, height };
  }

  if (!mediaPath) {
    return { width, height };
  }

  const normalizedType = String(type || '').toLowerCase();
  const normalizedMime = String(mimeType || '').toLowerCase();
  const isVisual =
    normalizedType.includes('image') ||
    normalizedType.includes('video') ||
    normalizedMime.startsWith('image/') ||
    normalizedMime.startsWith('video/') ||
    isImagePath(mediaPath) ||
    isVideoPath(mediaPath);

  if (isVisual) {
    return { width: 16, height: 9 };
  }

  return { width, height };
}

async function fetchAllRows(table, columns, orderBy = 'id') {
  const pageSize = 1000;
  let from = 0;
  const rows = [];

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Error reading ${table}: ${error.message}`);
    }

    const chunk = Array.isArray(data) ? data : [];
    rows.push(...chunk);
    if (chunk.length < pageSize) {
      break;
    }
    from += pageSize;
  }

  return rows;
}

async function detectOptionalColumns(table, candidateColumns = []) {
  const supportedColumns = new Set();
  for (const column of candidateColumns) {
    const { error } = await supabase.from(table).select(column).limit(1);
    if (!error) {
      supportedColumns.add(column);
      continue;
    }

    const missingColumn = getMissingColumnForTable(error, table);
    if (!missingColumn) {
      throw new Error(`Error checking ${table}.${column}: ${error.message}`);
    }
  }
  return supportedColumns;
}

async function backfillAnnouncements() {
  const supportedOptionalColumns = await detectOptionalColumns('announcements', [
    'media_width',
    'media_height',
    'updated_at'
  ]);
  const selectColumns = [
    'id',
    'image',
    'content',
    'type',
    'file_name',
    'file_mime_type',
    ...(supportedOptionalColumns.has('media_width') ? ['media_width'] : []),
    ...(supportedOptionalColumns.has('media_height') ? ['media_height'] : []),
    ...(supportedOptionalColumns.has('updated_at') ? ['updated_at'] : [])
  ].join(',');
  const rows = await fetchAllRows('announcements', selectColumns);

  let updatedCount = 0;
  for (const row of rows) {
    const imageReference = row.image || null;
    const resolvedMimeType = resolveMimeType(row.file_mime_type, [row.file_name, imageReference]);
    const resolvedType = getAnnouncementType(imageReference, row.content, resolvedMimeType);
    const resolvedDimensions = resolveDimensions(
      imageReference,
      resolvedType,
      resolvedMimeType,
      row.media_width,
      row.media_height
    );

    const patch = {};
    if ((row.file_mime_type || null) !== (resolvedMimeType || null)) {
      patch.file_mime_type = resolvedMimeType;
    }
    if (String(row.type || '') !== String(resolvedType || '')) {
      patch.type = resolvedType;
    }
    if (
      supportedOptionalColumns.has('media_width') &&
      (parsePositiveInteger(row.media_width) || null) !== (resolvedDimensions.width || null)
    ) {
      patch.media_width = resolvedDimensions.width;
    }
    if (
      supportedOptionalColumns.has('media_height') &&
      (parsePositiveInteger(row.media_height) || null) !== (resolvedDimensions.height || null)
    ) {
      patch.media_height = resolvedDimensions.height;
    }

    if (Object.keys(patch).length === 0) {
      continue;
    }

    if (supportedOptionalColumns.has('updated_at')) {
      patch.updated_at = new Date().toISOString();
    }
    const { error: updateError } = await supabase.from('announcements').update(patch).eq('id', row.id);
    if (updateError) {
      throw new Error(`Error updating announcement ${row.id}: ${updateError.message}`);
    }
    updatedCount += 1;
  }

  return { total: rows.length, updated: updatedCount };
}

async function backfillHistoryIfSupported() {
  const testSelect = await supabase.from('history').select('row_id,image,content,type,file_name,file_mime_type').limit(1);

  if (testSelect.error) {
    console.log('ℹ️ Skipping history backfill (legacy history schema detected).');
    return { total: 0, updated: 0, skipped: true };
  }

  const supportedOptionalColumns = await detectOptionalColumns('history', ['media_width', 'media_height']);
  const selectColumns = [
    'row_id',
    'image',
    'content',
    'type',
    'file_name',
    'file_mime_type',
    ...(supportedOptionalColumns.has('media_width') ? ['media_width'] : []),
    ...(supportedOptionalColumns.has('media_height') ? ['media_height'] : [])
  ].join(',');
  const rows = await fetchAllRows(
    'history',
    selectColumns,
    'row_id'
  );

  let updatedCount = 0;
  for (const row of rows) {
    const imageReference = row.image || null;
    const resolvedMimeType = resolveMimeType(row.file_mime_type, [row.file_name, imageReference]);
    const resolvedType = getAnnouncementType(imageReference, row.content, resolvedMimeType);
    const resolvedDimensions = resolveDimensions(
      imageReference,
      resolvedType,
      resolvedMimeType,
      row.media_width,
      row.media_height
    );

    const patch = {};
    if ((row.file_mime_type || null) !== (resolvedMimeType || null)) {
      patch.file_mime_type = resolvedMimeType;
    }
    if (String(row.type || '') !== String(resolvedType || '')) {
      patch.type = resolvedType;
    }
    if (
      supportedOptionalColumns.has('media_width') &&
      (parsePositiveInteger(row.media_width) || null) !== (resolvedDimensions.width || null)
    ) {
      patch.media_width = resolvedDimensions.width;
    }
    if (
      supportedOptionalColumns.has('media_height') &&
      (parsePositiveInteger(row.media_height) || null) !== (resolvedDimensions.height || null)
    ) {
      patch.media_height = resolvedDimensions.height;
    }

    if (Object.keys(patch).length === 0) {
      continue;
    }

    const { error: updateError } = await supabase.from('history').update(patch).eq('row_id', row.row_id);
    if (updateError) {
      throw new Error(`Error updating history row ${row.row_id}: ${updateError.message}`);
    }
    updatedCount += 1;
  }

  return { total: rows.length, updated: updatedCount, skipped: false };
}

async function main() {
  console.log('Backfilling announcement media metadata...');
  const announcementResult = await backfillAnnouncements();
  console.log(
    `- announcements: ${announcementResult.updated}/${announcementResult.total} row(s) updated`
  );

  const historyResult = await backfillHistoryIfSupported();
  if (!historyResult.skipped) {
    console.log(`- history: ${historyResult.updated}/${historyResult.total} row(s) updated`);
  }

  console.log('✅ Media metadata backfill complete.');
}

main().catch((error) => {
  console.error('❌ Media metadata backfill failed:', error.message);
  process.exit(1);
});
