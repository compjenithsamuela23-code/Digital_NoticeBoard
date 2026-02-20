const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs').promises;
const fsSync = require('fs');
const multer = require('multer');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
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

const DEFAULT_ADMIN = {
  email: 'admin@noticeboard.com',
  password: 'admin123',
  role: 'admin'
};
const JWT_SECRET = process.env.JWT_SECRET || process.env.SUPABASE_SERVICE_KEY;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
if (!process.env.JWT_SECRET) {
  console.log('⚠️ JWT_SECRET is not set. Falling back to SUPABASE_SERVICE_KEY.');
}
const LIVE_STATUS_ID = 1;
const ANNOUNCEMENT_MAINTENANCE_INTERVAL_MS = 60 * 1000;
const REQUIRED_SUPABASE_TABLES = ['users', 'categories', 'announcements', 'history'];
const OPTIONAL_SUPABASE_TABLES = ['live_state'];
let maintenanceInFlight = null;
let historyTableMode = 'unknown';
let runtimeInitPromise = null;
let maintenanceIntervalHandle = null;
let storageBucketReadyPromise = null;
const LOGIN_HISTORY_ACTIONS = [
  'admin_login',
  'admin_logout',
  'staff_login',
  'staff_logout',
  'display_login',
  'display_logout'
];
const ANNOUNCEMENT_HISTORY_ACTIONS = ['created', 'updated', 'deleted', 'expired'];
const ID_HISTORY_ACTIONS = [
  'admin_registered',
  'category_created',
  'category_deleted',
  'access_user_created',
  'access_user_deleted',
  'staff_user_created',
  'staff_user_deleted'
];
const liveStateFallback = {
  status: 'OFF',
  link: null,
  startedAt: null,
  stoppedAt: null
};

const configuredOrigins = (process.env.CLIENT_ORIGIN || process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const API_NO_STORE = String(process.env.API_NO_STORE || 'true').toLowerCase() !== 'false';
const TRUST_PROXY = process.env.TRUST_PROXY || '1';
const IS_VERCEL = Boolean(process.env.VERCEL);
const IS_SERVERLESS_RUNTIME = IS_VERCEL || String(process.env.SERVERLESS || '').toLowerCase() === 'true';
const SUPABASE_STORAGE_BUCKET =
  String(process.env.SUPABASE_STORAGE_BUCKET || 'notice-board-uploads').trim() || 'notice-board-uploads';
const SUPABASE_STORAGE_PUBLIC_URL_MARKER = `/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/`;
const LOCAL_MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024;
const SERVERLESS_MAX_UPLOAD_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_SIZE_BYTES = IS_SERVERLESS_RUNTIME
  ? SERVERLESS_MAX_UPLOAD_SIZE_BYTES
  : LOCAL_MAX_UPLOAD_SIZE_BYTES;
const MAX_UPLOAD_SIZE_MB = Math.floor(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024));

const corsOrigin = configuredOrigins.length > 0 ? configuredOrigins : '*';
const UPLOAD_DOWNLOAD_ONLY_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.js',
  '.mjs',
  '.cjs',
  '.svg',
  '.exe',
  '.msi',
  '.dll',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh'
]);

const app = express();
const server = IS_SERVERLESS_RUNTIME ? null : http.createServer(app);
const io = IS_SERVERLESS_RUNTIME
  ? { emit: () => {}, on: () => {} }
  : socketIo(server, {
      cors: {
        origin: corsOrigin,
        methods: ['GET', 'POST', 'PUT', 'DELETE']
      }
    });

app.use(
  cors({
    origin: corsOrigin
  })
);
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use('/api', (req, res, next) => {
  if (API_NO_STORE) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.json());
app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'), {
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const extension = path.extname(filePath).toLowerCase();
      if (UPLOAD_DOWNLOAD_ONLY_EXTENSIONS.has(extension)) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    }
  })
);

const clientDistPath = path.resolve(__dirname, '../client/dist');
const hasClientBuild = fsSync.existsSync(clientDistPath);
if (hasClientBuild) {
  app.use(express.static(clientDistPath));
}

const storage = IS_SERVERLESS_RUNTIME
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: async function destination(req, file, cb) {
        const uploadDir = path.join(__dirname, 'uploads');
        try {
          await fs.access(uploadDir);
        } catch {
          await fs.mkdir(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
      },
      filename: function filename(req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
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
  '.svg',
  '.ai',
  '.eps',
  '.psd',
  '.raw',
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.orf',
  '.rw2'
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
  '.mpe',
  '.vob',
  '.mxf',
  '.rm',
  '.rmvb',
  '.qt',
  '.hevc',
  '.h265',
  '.h264',
  '.r3d',
  '.braw',
  '.cdng',
  '.prores',
  '.dnxhd',
  '.dnxhr',
  '.dv',
  '.mjpeg'
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

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
  fileFilter: function fileFilter(req, file, cb) {
    const extension = path.extname(file.originalname).toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const genericMime =
      mime === '' || mime === 'application/octet-stream' || mime === 'binary/octet-stream';

    if (file.fieldname === 'document') {
      const isImageLike = IMAGE_EXTENSIONS.has(extension) || mime.startsWith('image/');
      const isVideoLike = VIDEO_EXTENSIONS.has(extension) || mime.startsWith('video/');
      if (isImageLike || isVideoLike) {
        return cb(createBadRequestError('Image/video files must be uploaded in the Media Upload field.'));
      }
      return cb(null, true);
    }

    const isImage =
      IMAGE_EXTENSIONS.has(extension) &&
      (mime.startsWith('image/') || mime.startsWith('application/') || genericMime);
    const isVideo =
      VIDEO_EXTENSIONS.has(extension) &&
      (mime.startsWith('video/') || mime.startsWith('application/') || genericMime);

    if (file.fieldname === 'image' && (isImage || isVideo)) {
      return cb(null, true);
    }

    console.log('Rejected file:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });

    cb(createBadRequestError('Unsupported file type for this upload field.'));
  }
});

function generateId() {
  return randomUUID();
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value === true || value === 'true';
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

function normalizeUploadedMimeType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw.includes('/')) return null;
  return raw.split(';')[0].trim().slice(0, 120) || null;
}

function getAttachmentMetadata(uploadedFile) {
  if (!uploadedFile) {
    return {
      file_name: null,
      file_mime_type: null,
      file_size_bytes: null
    };
  }

  const size = Number.parseInt(uploadedFile.size, 10);
  return {
    file_name: sanitizeOriginalFileName(uploadedFile.originalname),
    file_mime_type: normalizeUploadedMimeType(uploadedFile.mimetype),
    file_size_bytes: Number.isNaN(size) ? null : Math.max(0, size)
  };
}

function getStorageObjectPathFromReference(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const normalizedRaw = raw.replace(/\\/g, '/');
  if (normalizedRaw.startsWith('/uploads/')) {
    return null;
  }

  const markerIndex = normalizedRaw.indexOf(SUPABASE_STORAGE_PUBLIC_URL_MARKER);
  if (markerIndex !== -1) {
    return decodeURIComponent(
      normalizedRaw.slice(markerIndex + SUPABASE_STORAGE_PUBLIC_URL_MARKER.length).split('?')[0]
    );
  }

  if (!normalizedRaw.includes('://')) {
    return decodeURIComponent(normalizedRaw.replace(/^\/+/, '').split('?')[0]);
  }

  return null;
}

async function ensureStorageBucketReady() {
  if (storageBucketReadyPromise) {
    return storageBucketReadyPromise;
  }

  storageBucketReadyPromise = (async () => {
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      throw new Error(`Error listing Supabase storage buckets: ${listError.message}`);
    }

    const hasBucket = (buckets || []).some((bucket) => bucket && bucket.name === SUPABASE_STORAGE_BUCKET);
    if (hasBucket) {
      return;
    }

    const { error: createError } = await supabase.storage.createBucket(SUPABASE_STORAGE_BUCKET, {
      public: true,
      fileSizeLimit: 50 * 1024 * 1024
    });

    if (createError) {
      const message = String(createError.message || '').toLowerCase();
      if (!message.includes('already exists')) {
        throw new Error(
          `Error creating Supabase storage bucket "${SUPABASE_STORAGE_BUCKET}": ${createError.message}`
        );
      }
    }

    console.log(`✅ Supabase storage bucket ready: ${SUPABASE_STORAGE_BUCKET}`);
  })().catch((error) => {
    storageBucketReadyPromise = null;
    throw error;
  });

  return storageBucketReadyPromise;
}

function buildStorageObjectPath(uploadedFile) {
  const extension = path.extname(String(uploadedFile.originalname || '')).toLowerCase();
  const safeExtension = extension && extension.length <= 16 ? extension : '';
  const dateSegment = new Date().toISOString().slice(0, 10);
  return `${dateSegment}/${randomUUID()}${safeExtension}`;
}

async function cleanupLocalUploadedFile(uploadedFile) {
  const uploadedPath = uploadedFile && uploadedFile.path ? String(uploadedFile.path) : '';
  if (!uploadedPath) return;

  try {
    await fs.unlink(uploadedPath);
  } catch {
    // Ignore cleanup failures for local temp uploads.
  }
}

async function uploadAttachmentToStorage(uploadedFile) {
  if (!uploadedFile) {
    return null;
  }

  await ensureStorageBucketReady();
  const objectPath = buildStorageObjectPath(uploadedFile);
  const contentType = normalizeUploadedMimeType(uploadedFile.mimetype) || 'application/octet-stream';

  let payload = uploadedFile.buffer;
  if (!payload) {
    payload = await fs.readFile(uploadedFile.path);
  }

  try {
    const { error: uploadError } = await supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .upload(objectPath, payload, {
        contentType,
        upsert: false
      });
    if (uploadError) {
      throw new Error(`Error uploading attachment to Supabase Storage: ${uploadError.message}`);
    }
  } finally {
    await cleanupLocalUploadedFile(uploadedFile);
  }

  const { data: publicData } = supabase.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(objectPath);
  if (!publicData || !publicData.publicUrl) {
    throw new Error('Error generating Supabase storage public URL for uploaded attachment.');
  }

  return {
    url: publicData.publicUrl,
    objectPath
  };
}

async function deleteAttachmentFromStorage(attachmentReference) {
  const objectPath = getStorageObjectPathFromReference(attachmentReference);
  if (!objectPath) {
    return false;
  }

  const { error } = await supabase.storage.from(SUPABASE_STORAGE_BUCKET).remove([objectPath]);
  if (error) {
    const message = String(error.message || '').toLowerCase();
    if (!message.includes('not found')) {
      throw new Error(`Error deleting attachment from Supabase Storage: ${error.message}`);
    }
  }

  return true;
}

async function removeAttachmentReference(attachmentReference) {
  if (!attachmentReference) return;

  try {
    const removedFromStorage = await deleteAttachmentFromStorage(attachmentReference);
    if (removedFromStorage) {
      return;
    }
  } catch (error) {
    console.log('Note: Could not delete storage attachment:', error.message);
  }

  const normalizedReference = String(attachmentReference).replace(/\\/g, '/');
  if (!normalizedReference.startsWith('/uploads/')) {
    return;
  }

  const localFilePath = path.join(__dirname, normalizedReference.replace(/^\/+/, ''));
  try {
    await fs.unlink(localFilePath);
  } catch (error) {
    console.log('Note: Could not delete local attachment:', error.message);
  }
}

function createBadRequestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeUsername(value) {
  return normalizeEmail(value);
}

const DISPLAY_ROLE_PREFIX = 'display:';

function getDisplayAccessFromRole(value) {
  const roleRaw = String(value || '').trim();
  const roleLower = roleRaw.toLowerCase();

  if (roleLower === 'display') {
    return { isDisplay: true, categoryId: 'all' };
  }

  if (roleLower.startsWith(DISPLAY_ROLE_PREFIX)) {
    const categoryId = roleRaw.slice(DISPLAY_ROLE_PREFIX.length).trim();
    return { isDisplay: true, categoryId: categoryId || 'all' };
  }

  return { isDisplay: false, categoryId: null };
}

function getDisplayCategoryIdFromRole(value) {
  return getDisplayAccessFromRole(value).categoryId || 'all';
}

function buildDisplayRole(categoryId) {
  const normalizedCategoryId = String(categoryId || '').trim();
  if (!normalizedCategoryId || normalizedCategoryId.toLowerCase() === 'all') {
    return 'display';
  }
  return `${DISPLAY_ROLE_PREFIX}${normalizedCategoryId}`;
}

async function resolveDisplayCategoryMetaFromRole(roleValue) {
  const displayCategoryId = getDisplayCategoryIdFromRole(roleValue);
  let displayCategoryName = 'All Categories';

  if (displayCategoryId !== 'all') {
    const { data: categoryRows, error: categoryError } = await supabase
      .from('categories')
      .select('id,name')
      .eq('id', displayCategoryId)
      .limit(1);
    throwSupabaseError('Error resolving display category', categoryError);

    const assignedCategory = categoryRows && categoryRows.length > 0 ? categoryRows[0] : null;
    if (assignedCategory && assignedCategory.name) {
      displayCategoryName = assignedCategory.name;
    }
  }

  return { displayCategoryId, displayCategoryName };
}

function isAdminRole(value) {
  const role = String(value || '')
    .trim()
    .toLowerCase();
  return role === 'admin' || role === 'superadmin';
}

function isStaffRole(value) {
  const role = String(value || '')
    .trim()
    .toLowerCase();
  return role === 'staff';
}

function isWorkspaceRole(value) {
  return isAdminRole(value) || isStaffRole(value);
}

function isDisplayRole(value) {
  return getDisplayAccessFromRole(value).isDisplay;
}

function isBcryptHash(value) {
  return /^\$2[aby]\$\d{2}\$/.test(String(value || ''));
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function upgradeUserPasswordIfNeeded(userId, plainPassword) {
  const hashed = await hashPassword(plainPassword);
  const { error } = await supabase.from('users').update({ password: hashed }).eq('id', userId);
  throwSupabaseError('Error upgrading user password hash', error);
}

function createAuthToken(user, extraClaims = {}) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role || 'admin',
      ...extraClaims
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

async function verifyUserPassword(user, providedPassword) {
  if (!user || !providedPassword) return false;

  if (isBcryptHash(user.password)) {
    return bcrypt.compare(providedPassword, user.password);
  }

  const isMatch = user.password === providedPassword;
  if (isMatch && user.id) {
    await upgradeUserPasswordIfNeeded(user.id, providedPassword);
  }

  return isMatch;
}

function isVideoMediaPath(mediaPath) {
  if (!mediaPath) return false;
  return VIDEO_EXTENSIONS.has(getMediaPathExtension(mediaPath));
}

function isImageMediaPath(mediaPath) {
  if (!mediaPath) return false;
  return IMAGE_EXTENSIONS.has(getMediaPathExtension(mediaPath));
}

function isDocumentMediaPath(mediaPath) {
  if (!mediaPath) return false;
  return DOCUMENT_EXTENSIONS.has(getMediaPathExtension(mediaPath));
}

function getMediaPathExtension(mediaPath) {
  const raw = String(mediaPath || '').trim();
  if (!raw) return '';

  const withoutQuery = raw.split('?')[0].split('#')[0];
  if (/^https?:\/\//i.test(withoutQuery)) {
    try {
      const parsed = new URL(withoutQuery);
      return path.extname(parsed.pathname).toLowerCase();
    } catch {
      return path.extname(withoutQuery).toLowerCase();
    }
  }

  return path.extname(withoutQuery).toLowerCase();
}

function getUploadedAttachment(req) {
  const files = req.files || {};
  const mediaFile = Array.isArray(files.image) ? files.image[0] : null;
  const documentFile = Array.isArray(files.document) ? files.document[0] : null;
  return { mediaFile, documentFile };
}

function toDateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return isValidDate(value) ? value : null;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const withoutSpace = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw;
  const hasTimezone = /(?:[zZ]|[+\-]\d{2}:?\d{2})$/.test(withoutSpace);
  const normalized = hasTimezone ? withoutSpace : `${withoutSpace}Z`;
  const primary = new Date(normalized);
  if (isValidDate(primary)) return primary;

  const fallback = new Date(withoutSpace);
  return isValidDate(fallback) ? fallback : null;
}

function toIsoStringOrNull(value) {
  const parsed = toDateOrNull(value);
  return parsed ? parsed.toISOString() : null;
}

function isAnnouncementExpired(row, nowMs = Date.now()) {
  if (!row) return false;
  const endDate = toDateOrNull(row.end_at || row.expires_at);
  return Boolean(endDate && endDate.getTime() <= nowMs);
}

function isAnnouncementVisiblePublicly(row, nowMs = Date.now()) {
  if (!row || row.is_active === false) return false;

  const startDate = toDateOrNull(row.start_at);
  if (startDate && startDate.getTime() > nowMs) {
    return false;
  }

  return !isAnnouncementExpired(row, nowMs);
}

function normalizeCategoryFilter(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return 'all';
  return normalized.toLowerCase() === 'all' ? 'all' : normalized.toLowerCase();
}

function getAnnouncementCategoryValue(row) {
  if (!row) return null;
  const normalized = String(row.category || '').trim();
  return normalized ? normalized.toLowerCase() : null;
}

function isAnnouncementVisibleForDisplayCategory(row, requestedCategory) {
  const normalizedRequest = normalizeCategoryFilter(requestedCategory);
  if (normalizedRequest === 'all') return true;
  if (!row) return false;
  if (Number(row.priority) === 0) return true;

  // Announcements without category are global and visible to every display category.
  const rowCategory = getAnnouncementCategoryValue(row);
  if (!rowCategory) return true;

  return rowCategory === normalizedRequest;
}

function toAnnouncementDto(row) {
  if (!row) return null;
  const parsedFileSize = Number.parseInt(row.file_size_bytes, 10);
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    priority: row.priority,
    duration: row.duration,
    isActive: row.is_active,
    category: row.category,
    image: row.image,
    type: row.type,
    fileName: row.file_name || null,
    fileMimeType: row.file_mime_type || null,
    fileSizeBytes: Number.isNaN(parsedFileSize) ? null : parsedFileSize,
    createdAt: toIsoStringOrNull(row.created_at),
    startAt: toIsoStringOrNull(row.start_at),
    endAt: toIsoStringOrNull(row.end_at),
    expiresAt: toIsoStringOrNull(row.expires_at),
    updatedAt: toIsoStringOrNull(row.updated_at) || undefined
  };
}

function toHistoryDto(row) {
  if (!row) return null;

  const snapshot = row.data && typeof row.data === 'object' ? row.data : {};
  const announcementId = row.announcement_id || row.id || snapshot.id;
  const parsedFileSize = Number.parseInt(row.file_size_bytes ?? snapshot.file_size_bytes, 10);

  return {
    id: announcementId,
    title: row.title || snapshot.title || null,
    content: row.content || snapshot.content || null,
    priority: row.priority ?? snapshot.priority ?? null,
    duration: row.duration ?? snapshot.duration ?? null,
    isActive: row.is_active ?? snapshot.is_active ?? null,
    category: row.category || snapshot.category || null,
    image: row.image || snapshot.image || null,
    type: row.type || snapshot.type || null,
    fileName: row.file_name || snapshot.file_name || null,
    fileMimeType: row.file_mime_type || snapshot.file_mime_type || null,
    fileSizeBytes: Number.isNaN(parsedFileSize) ? null : parsedFileSize,
    createdAt: toIsoStringOrNull(row.created_at || snapshot.created_at),
    startAt: toIsoStringOrNull(row.start_at || snapshot.start_at),
    endAt: toIsoStringOrNull(row.end_at || snapshot.end_at),
    expiresAt: toIsoStringOrNull(row.expires_at || snapshot.expires_at),
    updatedAt: toIsoStringOrNull(row.updated_at || snapshot.updated_at) || undefined,
    action: row.action,
    actionAt: row.action_at,
    user: row.user_email || null
  };
}

function toCategoryDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    createdAt: toIsoStringOrNull(row.created_at)
  };
}

function toDisplayUserDto(row) {
  if (!row) return null;
  const categoryId = getDisplayCategoryIdFromRole(row.role);
  return {
    id: row.id,
    username: row.email,
    role: 'display',
    categoryId,
    createdAt: toIsoStringOrNull(row.created_at)
  };
}

function toStaffUserDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.email,
    role: 'staff',
    createdAt: toIsoStringOrNull(row.created_at)
  };
}

async function findCategoryByInput(categoryInput, errorContext = 'Error validating category') {
  const normalizedInput = String(categoryInput || '').trim();
  if (!normalizedInput) return null;

  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    normalizedInput
  );
  if (looksLikeUuid) {
    const { data: byIdRows, error: byIdError } = await supabase
      .from('categories')
      .select('id,name')
      .eq('id', normalizedInput)
      .limit(1);
    throwSupabaseError(errorContext, byIdError);

    if (byIdRows && byIdRows.length > 0) {
      return byIdRows[0];
    }
  }

  const { data: byNameRows, error: byNameError } = await supabase
    .from('categories')
    .select('id,name')
    .ilike('name', normalizedInput)
    .limit(1);
  throwSupabaseError(errorContext, byNameError);

  return byNameRows && byNameRows.length > 0 ? byNameRows[0] : null;
}

function toLiveDto(row) {
  if (!row) {
    return { status: 'OFF', link: null };
  }
  return {
    status: row.status || 'OFF',
    link: row.link || null,
    startedAt: toIsoStringOrNull(row.started_at) || undefined,
    stoppedAt: toIsoStringOrNull(row.stopped_at) || undefined
  };
}

function getAnnouncementType(mediaPath, contentValue, mimeType) {
  if (!mediaPath) {
    return 'text';
  }

  const hasContent = Boolean(String(contentValue || '').trim());
  const normalizedMime = String(mimeType || '').toLowerCase();
  const isVideo = normalizedMime.startsWith('video/') || isVideoMediaPath(mediaPath);
  const isImage = normalizedMime.startsWith('image/') || isImageMediaPath(mediaPath);
  const isLikelyDocumentPath =
    Boolean(mediaPath) && !isVideoMediaPath(mediaPath) && !isImageMediaPath(mediaPath);
  const isDocument =
    normalizedMime.startsWith('application/') ||
    normalizedMime.startsWith('text/') ||
    isDocumentMediaPath(mediaPath) ||
    isLikelyDocumentPath;

  if (isVideo) {
    return hasContent ? 'mixed_video' : 'video';
  }

  if (isDocument && !isImage) {
    return hasContent ? 'mixed_document' : 'document';
  }

  return hasContent ? 'mixed' : 'image';
}

function throwSupabaseError(context, error) {
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
}

function isMissingTableError(error, tableName) {
  return Boolean(
    error &&
      typeof error.message === 'string' &&
      error.message.includes(`Could not find the table 'public.${tableName}'`)
  );
}

async function ensureSupabaseSchemaReady() {
  for (const tableName of REQUIRED_SUPABASE_TABLES) {
    const { error } = await supabase.from(tableName).select('*').limit(1);
    if (!error) continue;

    if (isMissingTableError(error, tableName)) {
      throw new Error(
        `Required Supabase table "${tableName}" is missing. Run server/supabase/schema.sql in Supabase SQL Editor.`
      );
    }

    throw new Error(`Unable to access Supabase table "${tableName}": ${error.message}`);
  }

  for (const tableName of OPTIONAL_SUPABASE_TABLES) {
    const { error } = await supabase.from(tableName).select('*').limit(1);
    if (!error) continue;

    if (isMissingTableError(error, tableName)) {
      console.log(
        `⚠️ Optional Supabase table "${tableName}" is missing. Run server/supabase/schema.sql to enable it.`
      );
      continue;
    }

    throw new Error(`Unable to access optional Supabase table "${tableName}": ${error.message}`);
  }
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

function getMissingHistoryColumn(error) {
  return getMissingColumnForTable(error, 'history');
}

async function detectHistoryTableMode() {
  if (historyTableMode !== 'unknown') {
    return historyTableMode;
  }

  const { error } = await supabase.from('history').select('announcement_id').limit(1);
  if (!error) {
    historyTableMode = 'legacy';
    return historyTableMode;
  }

  if (getMissingHistoryColumn(error) === 'announcement_id') {
    historyTableMode = 'modern';
    return historyTableMode;
  }

  historyTableMode = 'modern';
  return historyTableMode;
}

async function getHistoryAnnouncementRefColumn() {
  const mode = await detectHistoryTableMode();
  return mode === 'legacy' ? 'announcement_id' : 'id';
}

async function insertHistoryRow(payload) {
  const writablePayload = { ...payload };
  const removedColumns = new Set();

  while (true) {
    const { error } = await supabase.from('history').insert(writablePayload);
    if (!error) {
      return;
    }

    const missingColumn = getMissingHistoryColumn(error);
    if (
      missingColumn &&
      Object.prototype.hasOwnProperty.call(writablePayload, missingColumn) &&
      !removedColumns.has(missingColumn)
    ) {
      removedColumns.add(missingColumn);
      delete writablePayload[missingColumn];
      continue;
    }

    throwSupabaseError('Error writing history', error);
  }
}

async function runAnnouncementUpdate(updatePayload, applyFilters, context) {
  const writablePayload = { ...updatePayload };
  const removedColumns = new Set();

  while (true) {
    const query = applyFilters(supabase.from('announcements').update(writablePayload));
    const { data, error } = await query;
    if (!error) {
      return data;
    }

    const missingColumn = getMissingColumnForTable(error, 'announcements');
    if (
      missingColumn &&
      Object.prototype.hasOwnProperty.call(writablePayload, missingColumn) &&
      !removedColumns.has(missingColumn)
    ) {
      removedColumns.add(missingColumn);
      delete writablePayload[missingColumn];
      continue;
    }

    throwSupabaseError(context, error);
  }
}

async function runAnnouncementInsert(insertPayload, context) {
  const writablePayload = { ...insertPayload };
  const removedColumns = new Set();

  while (true) {
    const { data, error } = await supabase
      .from('announcements')
      .insert(writablePayload)
      .select('*')
      .single();

    if (!error) {
      return data;
    }

    const missingColumn = getMissingColumnForTable(error, 'announcements');
    if (
      missingColumn &&
      Object.prototype.hasOwnProperty.call(writablePayload, missingColumn) &&
      !removedColumns.has(missingColumn)
    ) {
      removedColumns.add(missingColumn);
      delete writablePayload[missingColumn];
      continue;
    }

    throwSupabaseError(context, error);
  }
}

function getFallbackLiveDto() {
  return {
    status: liveStateFallback.status || 'OFF',
    link: liveStateFallback.link || null,
    startedAt: liveStateFallback.startedAt || undefined,
    stoppedAt: liveStateFallback.stoppedAt || undefined
  };
}

async function getAnnouncementById(id) {
  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .eq('id', id)
    .limit(1);

  throwSupabaseError('Error reading announcement', error);
  return data && data.length > 0 ? data[0] : null;
}

async function getUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', normalizedEmail)
    .limit(1);

  throwSupabaseError('Error reading user', error);
  return data && data.length > 0 ? data[0] : null;
}

async function appendHistory(announcementRow, action, userEmail, options = {}) {
  const mode = await detectHistoryTableMode();
  const actionDate = toDateOrNull(options.actionAt);
  const actionAtIso = actionDate ? actionDate.toISOString() : new Date().toISOString();

  if (mode === 'legacy') {
    await insertHistoryRow({
      id: generateId(),
      announcement_id: announcementRow.id,
      action,
      action_at: actionAtIso,
      user_email: userEmail || 'System',
      data: {
        id: announcementRow.id,
        title: announcementRow.title,
        content: announcementRow.content,
        priority: announcementRow.priority,
        duration: announcementRow.duration,
        is_active: announcementRow.is_active,
        category: announcementRow.category || null,
        image: announcementRow.image || null,
        type: announcementRow.type,
        file_name: announcementRow.file_name || null,
        file_mime_type: announcementRow.file_mime_type || null,
        file_size_bytes: announcementRow.file_size_bytes ?? null,
        created_at: announcementRow.created_at,
        start_at: announcementRow.start_at,
        end_at: announcementRow.end_at,
        expires_at: announcementRow.expires_at,
        updated_at: announcementRow.updated_at || null
      }
    });
    return;
  }

  await insertHistoryRow({
    id: announcementRow.id,
    title: announcementRow.title,
    content: announcementRow.content,
    priority: announcementRow.priority,
    duration: announcementRow.duration,
    is_active: announcementRow.is_active,
    category: announcementRow.category || null,
    image: announcementRow.image || null,
    type: announcementRow.type,
    file_name: announcementRow.file_name || null,
    file_mime_type: announcementRow.file_mime_type || null,
    file_size_bytes: announcementRow.file_size_bytes ?? null,
    created_at: announcementRow.created_at,
    start_at: announcementRow.start_at,
    end_at: announcementRow.end_at,
    expires_at: announcementRow.expires_at,
    action,
    action_at: actionAtIso,
    user_email: userEmail || null
  });
}

function buildSystemHistoryRow(details = {}) {
  const eventDate = toDateOrNull(details.actionAt);
  const eventIso = eventDate ? eventDate.toISOString() : new Date().toISOString();

  const priorityValue = Number.parseInt(details.priority, 10);
  const durationValue = Number.parseInt(details.duration, 10);
  const fileSizeValue = Number.parseInt(details.fileSizeBytes, 10);

  return {
    id: details.id || generateId(),
    title: String(details.title || 'System Event'),
    content: String(details.content || ''),
    priority: Number.isNaN(priorityValue) ? 1 : priorityValue,
    duration: Number.isNaN(durationValue) ? 0 : durationValue,
    is_active: details.isActive === undefined ? true : Boolean(details.isActive),
    category: details.category || null,
    image: details.image || null,
    type: String(details.type || 'system'),
    file_name: sanitizeOriginalFileName(details.fileName) || null,
    file_mime_type: normalizeUploadedMimeType(details.fileMimeType) || null,
    file_size_bytes: Number.isNaN(fileSizeValue) ? null : Math.max(0, fileSizeValue),
    created_at: eventIso,
    start_at: eventIso,
    end_at: eventIso,
    expires_at: eventIso,
    updated_at: eventIso
  };
}

async function appendSystemHistory(action, userEmail, details = {}) {
  const historyRow = buildSystemHistoryRow(details);
  await appendHistory(historyRow, action, userEmail || 'System', {
    actionAt: details.actionAt || historyRow.updated_at
  });
}

async function backfillMissingCreatedHistory() {
  const { data: announcements, error: announcementsError } = await supabase
    .from('announcements')
    .select('*');
  throwSupabaseError('Error loading announcements for history backfill', announcementsError);

  if (!announcements || announcements.length === 0) {
    return 0;
  }

  const announcementIds = announcements.map((row) => row.id).filter(Boolean);
  const historyRefColumn = await getHistoryAnnouncementRefColumn();
  const { data: createdHistoryRows, error: createdHistoryError } = await supabase
    .from('history')
    .select(historyRefColumn)
    .eq('action', 'created')
    .in(historyRefColumn, announcementIds);
  throwSupabaseError('Error loading created history entries', createdHistoryError);

  const alreadyBackfilled = new Set((createdHistoryRows || []).map((row) => row[historyRefColumn]).filter(Boolean));
  const missingRows = announcements.filter((row) => !alreadyBackfilled.has(row.id));

  for (const row of missingRows) {
    await appendHistory(row, 'created', 'System', { actionAt: row.created_at });
  }

  return missingRows.length;
}

async function archiveExpiredAnnouncements() {
  const nowIso = new Date().toISOString();
  const { data: expiredRows, error: expiredRowsError } = await supabase
    .from('announcements')
    .select('*')
    .lt('end_at', nowIso);
  throwSupabaseError('Error loading expired announcements', expiredRowsError);

  if (!expiredRows || expiredRows.length === 0) {
    return { archived: 0, deactivated: 0 };
  }

  const historyRefColumn = await getHistoryAnnouncementRefColumn();
  const ids = expiredRows.map((row) => row.id);
  const { data: expiredHistoryRows, error: expiredHistoryError } = await supabase
    .from('history')
    .select(historyRefColumn)
    .eq('action', 'expired')
    .in(historyRefColumn, ids);
  throwSupabaseError('Error loading expired history entries', expiredHistoryError);

  const alreadyArchived = new Set((expiredHistoryRows || []).map((row) => row[historyRefColumn]).filter(Boolean));
  let archivedCount = 0;
  for (const row of expiredRows) {
    if (alreadyArchived.has(row.id)) continue;
    await appendHistory(row, 'expired', 'System', { actionAt: nowIso });
    archivedCount += 1;
  }

  const idsToDeactivate = expiredRows.filter((row) => row.is_active !== false).map((row) => row.id);
  if (idsToDeactivate.length > 0) {
    await runAnnouncementUpdate(
      { is_active: false, updated_at: nowIso },
      (query) => query.in('id', idsToDeactivate),
      'Error deactivating expired announcements'
    );
  }

  if (archivedCount > 0 || idsToDeactivate.length > 0) {
    io.emit('announcementUpdate', {
      action: 'expire',
      ids: idsToDeactivate,
      timestamp: nowIso
    });
  }

  return { archived: archivedCount, deactivated: idsToDeactivate.length };
}

async function runAnnouncementMaintenance() {
  if (maintenanceInFlight) {
    return maintenanceInFlight;
  }

  maintenanceInFlight = (async () => {
    try {
      const backfilled = await backfillMissingCreatedHistory();
      const expired = await archiveExpiredAnnouncements();

      if (backfilled > 0 || expired.archived > 0 || expired.deactivated > 0) {
        console.log(
          `🧾 Announcement maintenance: backfilled=${backfilled}, archivedExpired=${expired.archived}, deactivatedExpired=${expired.deactivated}`
        );
      }
    } catch (error) {
      console.error('⚠️ Announcement maintenance failed:', error.message);
    } finally {
      maintenanceInFlight = null;
    }
  })();

  return maintenanceInFlight;
}

async function getLiveState() {
  const { data, error } = await supabase
    .from('live_state')
    .select('*')
    .eq('id', LIVE_STATUS_ID)
    .limit(1);

  if (isMissingTableError(error, 'live_state')) {
    return null;
  }

  throwSupabaseError('Error reading live status', error);
  return data && data.length > 0 ? data[0] : null;
}

async function initializeSupabase() {
  await ensureSupabaseSchemaReady();
  await ensureStorageBucketReady();

  const admin = await getUserByEmail(DEFAULT_ADMIN.email);
  if (!admin) {
    const hashedPassword = await hashPassword(DEFAULT_ADMIN.password);
    const { error } = await supabase.from('users').insert({
      id: generateId(),
      email: normalizeEmail(DEFAULT_ADMIN.email),
      password: hashedPassword,
      role: DEFAULT_ADMIN.role,
      created_at: new Date().toISOString()
    });
    throwSupabaseError('Error creating default admin', error);
    console.log('✅ Default admin created in Supabase: admin@noticeboard.com / admin123');
  } else if (!isBcryptHash(admin.password)) {
    await upgradeUserPasswordIfNeeded(admin.id, String(admin.password || DEFAULT_ADMIN.password));
    console.log('✅ Upgraded existing admin password storage to bcrypt hash');
  }

  const { error: liveError } = await supabase.from('live_state').upsert(
    {
      id: LIVE_STATUS_ID,
      status: 'OFF',
      link: null,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'id' }
  );
  if (isMissingTableError(liveError, 'live_state')) {
    console.log('⚠️ live_state table not found. Run server/supabase/schema.sql to enable persisted live status.');
  } else {
    throwSupabaseError('Error initializing live status', liveError);
  }

  await runAnnouncementMaintenance();
  console.log('✅ Supabase initialized');
}

const simpleAuth = (req, res, next) => {
  const authHeader = String(req.headers.authorization || '');
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const token = bearerToken || String(req.headers['x-auth-token'] || '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role || 'admin'
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const requireAdminRole = (req, res, next) => {
  if (!req.user || !isAdminRole(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const requireStaffRole = (req, res, next) => {
  if (!req.user || !isStaffRole(req.user.role)) {
    return res.status(403).json({ error: 'Staff access required' });
  }
  next();
};

const requireWorkspaceRole = (req, res, next) => {
  if (!req.user || !isWorkspaceRole(req.user.role)) {
    return res.status(403).json({ error: 'Workspace access required' });
  }
  next();
};

io.on('connection', (socket) => {
  console.log('📡 New client connected');
  socket.on('disconnect', () => {
    console.log('📡 Client disconnected');
  });
});

const uploadsDir = path.join(__dirname, 'uploads');
if (!IS_SERVERLESS_RUNTIME) {
  fs.access(uploadsDir).catch(async () => {
    await fs.mkdir(uploadsDir, { recursive: true });
    console.log('✅ Created uploads directory');
  });
}

app.post('/api/auth/register', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existingUser = await getUserByEmail(normalizedEmail);
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await hashPassword(String(password));
    const userRow = {
      id: generateId(),
      email: normalizedEmail,
      password: hashedPassword,
      role: 'admin',
      created_at: new Date().toISOString()
    };

    const { error } = await supabase.from('users').insert(userRow);
    throwSupabaseError('Error creating user', error);

    await appendSystemHistory('admin_registered', (req.user && req.user.email) || null, {
      id: userRow.id,
      title: 'Admin Account Created',
      content: `Admin account "${normalizedEmail}" (User ID: ${userRow.id}) was created.`,
      type: 'system_auth',
      actionAt: userRow.created_at
    });

    const token = createAuthToken(userRow);
    res.status(201).json({
      message: 'Admin user created',
      user: { email: userRow.email, role: userRow.role },
      token
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const normalizedEmail = normalizeEmail(email || username);
    const plainPassword = String(password || '');

    if (!normalizedEmail || !plainPassword) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', normalizedEmail)
      .limit(1);

    throwSupabaseError('Error logging in', error);
    const user = data && data.length > 0 ? data[0] : null;

    const isValid = await verifyUserPassword(user, plainPassword);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    if (!isAdminRole(user.role)) {
      if (isStaffRole(user.role)) {
        return res.status(403).json({
          error: 'This account is for Staff Dashboard. Use staff login.',
          accountType: 'staff'
        });
      }
      if (isDisplayRole(user.role)) {
        const { displayCategoryId, displayCategoryName } = await resolveDisplayCategoryMetaFromRole(
          user.role
        );
        return res.status(403).json({
          error: 'This account is for Display Access. Use display login.',
          accountType: 'display',
          displayCategoryId,
          displayCategoryName
        });
      }
      return res.status(403).json({ error: 'This account cannot access workspace controls.' });
    }

    const token = createAuthToken(user);

    await appendSystemHistory('admin_login', user.email, {
      title: 'Admin Signed In',
      content: `${user.email} signed in to admin workspace.`,
      type: 'system_auth'
    });

    res.json({
      message: 'Login successful',
      user: { email: user.email, role: user.role },
      token
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/staff-auth/login', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const normalizedEmail = normalizeEmail(email || username);
    const plainPassword = String(password || '');

    if (!normalizedEmail || !plainPassword) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', normalizedEmail)
      .limit(1);

    throwSupabaseError('Error logging in staff user', error);
    const user = data && data.length > 0 ? data[0] : null;

    const isValid = await verifyUserPassword(user, plainPassword);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    if (!isStaffRole(user.role)) {
      if (isAdminRole(user.role)) {
        return res.status(403).json({
          error: 'This account is for Admin Workspace. Use admin login.',
          accountType: 'admin'
        });
      }

      if (isDisplayRole(user.role)) {
        const { displayCategoryId, displayCategoryName } = await resolveDisplayCategoryMetaFromRole(
          user.role
        );
        return res.status(403).json({
          error: 'This account is for Display Access. Use display login.',
          accountType: 'display',
          displayCategoryId,
          displayCategoryName
        });
      }

      return res.status(403).json({ error: 'This account cannot access staff workspace.' });
    }

    const token = createAuthToken(user);
    await appendSystemHistory('staff_login', user.email, {
      title: 'Staff User Signed In',
      content: `${user.email} signed in to staff dashboard.`,
      type: 'system_auth'
    });

    res.json({
      message: 'Login successful',
      user: { username: user.email, role: 'staff' },
      token
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/display-auth/login', async (req, res) => {
  try {
    const { username, password, category } = req.body;
    const normalizedUsername = normalizeUsername(username);
    const plainPassword = String(password || '');
    const enteredCategory = String(category || '').trim();

    if (!normalizedUsername || !plainPassword || !enteredCategory) {
      return res
        .status(400)
        .json({ error: 'Username, password, and category are required.' });
    }

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', normalizedUsername)
      .limit(1);

    throwSupabaseError('Error logging in display user', error);
    const user = data && data.length > 0 ? data[0] : null;

    const isValid = await verifyUserPassword(user, plainPassword);
    if (!isValid || !user || (!isDisplayRole(user.role) && !isAdminRole(user.role))) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const selectedCategory = await findCategoryByInput(enteredCategory, 'Error validating category');
    if (!selectedCategory) {
      return res.status(400).json({ error: 'Selected category does not exist.' });
    }

    const assignedCategoryId = getDisplayCategoryIdFromRole(user.role);
    const selectedCategoryId = selectedCategory.id;
    const selectedCategoryName = selectedCategory.name;
    if (
      isDisplayRole(user.role) &&
      assignedCategoryId !== 'all' &&
      assignedCategoryId !== selectedCategoryId
    ) {
      return res
        .status(403)
        .json({ error: 'This category is not assigned to this username.' });
    }

    const token = createAuthToken(user, { scope: 'display' });
    await appendSystemHistory('display_login', user.email, {
      title: 'Display User Signed In',
      content: `${user.email} signed in for category "${selectedCategoryName}".`,
      type: 'system_display'
    });

    res.json({
      message: 'Login successful',
      token,
      user: { username: user.email, role: isDisplayRole(user.role) ? 'display' : user.role || 'display' },
      category: { id: selectedCategoryId, name: selectedCategoryName }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/logout', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    await appendSystemHistory('admin_logout', (req.user && req.user.email) || null, {
      title: 'Admin Signed Out',
      content: `${(req.user && req.user.email) || 'Admin'} signed out from admin workspace.`,
      type: 'system_auth'
    });

    res.json({ message: 'Logout successful' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/staff-auth/logout', simpleAuth, requireStaffRole, async (req, res) => {
  try {
    await appendSystemHistory('staff_logout', (req.user && req.user.email) || null, {
      title: 'Staff User Signed Out',
      content: `${(req.user && req.user.email) || 'Staff user'} signed out from staff dashboard.`,
      type: 'system_auth'
    });

    res.json({ message: 'Staff logout successful' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/display-auth/logout', simpleAuth, async (req, res) => {
  try {
    await appendSystemHistory('display_logout', (req.user && req.user.email) || null, {
      title: 'Display User Signed Out',
      content: `${(req.user && req.user.email) || 'Display user'} signed out from display access.`,
      type: 'system_display'
    });

    res.json({ message: 'Display logout successful' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/announcements/public', async (req, res) => {
  try {
    await runAnnouncementMaintenance();
    const requestedCategory = normalizeCategoryFilter(req.query.category);
    const { data, error } = await supabase
      .from('announcements')
      .select('*')
      .neq('is_active', false)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });

    throwSupabaseError('Error fetching public announcements', error);
    const nowMs = Date.now();
    const visibleRows = (data || []).filter((row) => isAnnouncementVisiblePublicly(row, nowMs));
    const scopedRows = visibleRows.filter((row) =>
      isAnnouncementVisibleForDisplayCategory(row, requestedCategory)
    );
    res.json(scopedRows.map(toAnnouncementDto));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/announcements', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    await runAnnouncementMaintenance();
    const { data, error } = await supabase
      .from('announcements')
      .select('*')
      .order('created_at', { ascending: false });

    throwSupabaseError('Error fetching announcements', error);
    const nowMs = Date.now();
    const activeRows = (data || []).filter((row) => !isAnnouncementExpired(row, nowMs));
    res.json(activeRows.map(toAnnouncementDto));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post(
  '/api/announcements',
  simpleAuth,
  requireWorkspaceRole,
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'document', maxCount: 1 }
  ]),
  async (req, res) => {
  try {
    const {
      title,
      content,
      priority = 1,
      duration = 7,
      isActive,
      active,
      category = '',
      startAt,
      endAt
    } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    const priorityValue = Number.parseInt(priority, 10);
    const durationValue = Number.parseInt(duration, 10);
    const safePriority = Number.isNaN(priorityValue) ? 1 : priorityValue;
    const safeDuration = Number.isNaN(durationValue) ? 7 : durationValue;

    const startDate = toDateOrNull(startAt) || new Date();
    const endDate = endAt
      ? toDateOrNull(endAt)
      : new Date(startDate.getTime() + safeDuration * 24 * 60 * 60 * 1000);

    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      return res.status(400).json({ error: 'Invalid startAt or endAt date' });
    }

    const { mediaFile, documentFile } = getUploadedAttachment(req);
    if (mediaFile && documentFile) {
      return res.status(400).json({ error: 'Upload either media or document, not both at once.' });
    }

    const uploadedFile = mediaFile || documentFile;
    const uploadResult = uploadedFile ? await uploadAttachmentToStorage(uploadedFile) : null;
    const attachmentPath = uploadResult ? uploadResult.url : null;
    const attachmentMetadata = getAttachmentMetadata(uploadedFile);
    const announcementRow = {
      id: generateId(),
      title,
      content,
      priority: safePriority,
      duration: safeDuration,
      is_active: toBoolean(isActive !== undefined ? isActive : active, true),
      category: category || null,
      image: attachmentPath,
      type: getAnnouncementType(attachmentPath, content, uploadedFile && uploadedFile.mimetype),
      ...attachmentMetadata,
      created_at: new Date().toISOString(),
      start_at: startDate.toISOString(),
      end_at: endDate.toISOString(),
      expires_at: endDate.toISOString()
    };

    const data = await runAnnouncementInsert(announcementRow, 'Error creating announcement');
    await appendHistory(data, 'created', (req.user && req.user.email) || null);

    io.emit('announcementUpdate', {
      action: 'create',
      announcement: toAnnouncementDto(data),
      timestamp: new Date().toISOString()
    });

    console.log(`✅ Created announcement: ${title}`);
    res.status(201).json(toAnnouncementDto(data));
  } catch (error) {
    console.error('❌ Error creating announcement:', error);
    res.status(400).json({ error: error.message });
  }
});

app.put(
  '/api/announcements/:id',
  simpleAuth,
  requireWorkspaceRole,
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'document', maxCount: 1 }
  ]),
  async (req, res) => {
  try {
    const existing = await getAnnouncementById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Announcement not found' });
    }
    if (isAnnouncementExpired(existing)) {
      return res.status(410).json({
        error: 'Expired announcements are archived to history and can no longer be modified.'
      });
    }

    const { title, content, priority, duration, isActive, active, category, startAt, endAt } =
      req.body;

    const { mediaFile, documentFile } = getUploadedAttachment(req);
    if (mediaFile && documentFile) {
      return res.status(400).json({ error: 'Upload either media or document, not both at once.' });
    }

    const uploadedFile = mediaFile || documentFile;
    const uploadResult = uploadedFile ? await uploadAttachmentToStorage(uploadedFile) : null;
    const attachmentPath = uploadResult ? uploadResult.url : existing.image;
    const existingFileSize = Number.parseInt(existing.file_size_bytes, 10);
    const attachmentMetadata = uploadedFile
      ? getAttachmentMetadata(uploadedFile)
      : {
          file_name: existing.file_name || null,
          file_mime_type: existing.file_mime_type || null,
          file_size_bytes: Number.isNaN(existingFileSize) ? null : existingFileSize
        };
    if (uploadResult && existing.image && existing.image !== attachmentPath) {
      await removeAttachmentReference(existing.image);
    }

    const prevStart = toDateOrNull(existing.start_at) || new Date();
    const prevEnd = toDateOrNull(existing.end_at) || new Date();
    const parsedStart = startAt ? toDateOrNull(startAt) : null;
    const newStart = parsedStart || prevStart;
    const parsedDuration = duration ? Number.parseInt(duration, 10) : null;
    const safeDuration = Number.isNaN(parsedDuration) ? null : parsedDuration;
    const newEnd = endAt
      ? toDateOrNull(endAt)
      : safeDuration
        ? new Date(newStart.getTime() + safeDuration * 24 * 60 * 60 * 1000)
        : prevEnd;

    if (!isValidDate(newStart) || !isValidDate(newEnd)) {
      return res.status(400).json({ error: 'Invalid startAt or endAt date' });
    }

    const effectiveContent = content || existing.content;
    const updateRow = {
      image: attachmentPath,
      type: getAnnouncementType(attachmentPath, effectiveContent, uploadedFile && uploadedFile.mimetype),
      ...attachmentMetadata,
      start_at: newStart.toISOString(),
      end_at: newEnd.toISOString(),
      expires_at: newEnd.toISOString(),
      updated_at: new Date().toISOString()
    };

    if (title) updateRow.title = title;
    if (content) updateRow.content = content;
    if (priority) {
      const parsedPriority = Number.parseInt(priority, 10);
      if (!Number.isNaN(parsedPriority)) {
        updateRow.priority = parsedPriority;
      }
    }
    if (duration && safeDuration !== null) {
      updateRow.duration = safeDuration;
    }
    if (isActive !== undefined || active !== undefined) {
      updateRow.is_active = toBoolean(isActive !== undefined ? isActive : active, existing.is_active);
    }
    if (category !== undefined) {
      updateRow.category = category || null;
    }

    const updatedRows = await runAnnouncementUpdate(
      updateRow,
      (query) => query.eq('id', req.params.id).select('*'),
      'Error updating announcement'
    );
    const data = updatedRows && updatedRows.length > 0 ? updatedRows[0] : null;
    if (!data) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    await appendHistory(data, 'updated', (req.user && req.user.email) || null);

    io.emit('announcementUpdate', {
      action: 'update',
      announcement: toAnnouncementDto(data),
      timestamp: new Date().toISOString()
    });

    console.log(`✅ Updated announcement: ${data.title}`);
    res.json(toAnnouncementDto(data));
  } catch (error) {
    console.error('❌ Error updating announcement:', error);
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/announcements/:id', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const existing = await getAnnouncementById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Announcement not found' });
    }
    if (isAnnouncementExpired(existing)) {
      return res.status(410).json({
        error: 'Expired announcements are archived to history and can no longer be deleted.'
      });
    }

    await removeAttachmentReference(existing.image);

    await appendHistory(existing, 'deleted', (req.user && req.user.email) || null);

    const { error } = await supabase.from('announcements').delete().eq('id', req.params.id);
    throwSupabaseError('Error deleting announcement', error);

    io.emit('announcementUpdate', {
      action: 'delete',
      id: req.params.id,
      timestamp: new Date().toISOString()
    });

    console.log(`✅ Deleted announcement: ${existing.title}`);
    res.json({
      message: 'Announcement deleted successfully',
      id: req.params.id
    });
  } catch (error) {
    console.error('❌ Error deleting announcement:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/history', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    await runAnnouncementMaintenance();
    const { data, error } = await supabase
      .from('history')
      .select('*')
      .in('action', ANNOUNCEMENT_HISTORY_ACTIONS)
      .order('action_at', { ascending: false });

    throwSupabaseError('Error fetching history', error);
    res.json((data || []).map(toHistoryDto));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/history/login', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    await runAnnouncementMaintenance();
    const { data, error } = await supabase
      .from('history')
      .select('*')
      .in('action', LOGIN_HISTORY_ACTIONS)
      .order('action_at', { ascending: false });

    throwSupabaseError('Error fetching login history', error);
    res.json((data || []).map(toHistoryDto));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/history/id', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    await runAnnouncementMaintenance();
    const { data, error } = await supabase
      .from('history')
      .select('*')
      .in('action', ID_HISTORY_ACTIONS)
      .order('action_at', { ascending: false });

    throwSupabaseError('Error fetching ID history', error);
    res.json((data || []).map(toHistoryDto));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/announcements/:id', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const announcement = await getAnnouncementById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    res.json(toAnnouncementDto(announcement));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const live = await getLiveState();
    if (!live) {
      return res.json(getFallbackLiveDto());
    }
    res.json(toLiveDto(live));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .order('created_at', { ascending: true });

    throwSupabaseError('Error fetching categories', error);
    res.json((data || []).map(toCategoryDto));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/categories', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    const { name } = req.body;
    const normalizedName = name ? name.trim() : '';
    if (!normalizedName) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const { data: existing, error: existingError } = await supabase
      .from('categories')
      .select('id')
      .ilike('name', normalizedName)
      .limit(1);

    throwSupabaseError('Error checking category', existingError);
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'Category already exists' });
    }

    const categoryRow = {
      id: generateId(),
      name: normalizedName,
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('categories')
      .insert(categoryRow)
      .select('*')
      .single();

    throwSupabaseError('Error creating category', error);

    await appendSystemHistory('category_created', (req.user && req.user.email) || null, {
      id: data.id,
      title: 'Category Created',
      content: `Category "${data.name}" (Category ID: ${data.id}) was created.`,
      category: data.id,
      type: 'system_category',
      actionAt: data.created_at
    });

    res.status(201).json(toCategoryDto(data));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/categories/:id', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    const { data: categoryRows, error: readError } = await supabase
      .from('categories')
      .select('*')
      .eq('id', req.params.id)
      .limit(1);

    throwSupabaseError('Error loading category', readError);
    const category = categoryRows && categoryRows.length > 0 ? categoryRows[0] : null;
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const boundDisplayRole = buildDisplayRole(category.id);
    const { data: assignedUsers, error: userCheckError } = await supabase
      .from('users')
      .select('id')
      .eq('role', boundDisplayRole)
      .limit(1);
    throwSupabaseError('Error checking assigned display users', userCheckError);
    if (assignedUsers && assignedUsers.length > 0) {
      return res.status(400).json({
        error: 'This category is assigned to display credentials. Reassign or delete those credentials first.'
      });
    }

    const { error } = await supabase
      .from('categories')
      .delete()
      .eq('id', req.params.id);

    throwSupabaseError('Error deleting category', error);

    const deletedAt = new Date().toISOString();
    await appendSystemHistory('category_deleted', (req.user && req.user.email) || null, {
      id: category.id,
      title: 'Category Deleted',
      content: `Category "${category.name}" (Category ID: ${category.id}) was deleted.`,
      category: category.id,
      type: 'system_category',
      actionAt: deletedAt
    });

    res.json({ message: 'Category deleted', id: category.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/display-users', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id,email,role,created_at')
      .like('role', 'display%')
      .order('created_at', { ascending: false });

    throwSupabaseError('Error fetching display users', error);
    const users = (data || []).map(toDisplayUserDto);
    const categoryIds = [...new Set(users.map((item) => item.categoryId).filter((id) => id && id !== 'all'))];
    let categoryById = new Map();

    if (categoryIds.length > 0) {
      const { data: categoryRows, error: categoryError } = await supabase
        .from('categories')
        .select('id,name')
        .in('id', categoryIds);
      throwSupabaseError('Error loading display user categories', categoryError);

      categoryById = new Map((categoryRows || []).map((item) => [item.id, item.name]));
    }

    res.json(
      users.map((user) => ({
        ...user,
        categoryName:
          user.categoryId === 'all' ? 'All Categories' : categoryById.get(user.categoryId) || null
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/display-users', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    const { username, password, category } = req.body;
    const normalizedUsername = normalizeUsername(username);
    const plainPassword = String(password || '').trim();
    const selectedCategoryInput = String(category || '').trim();

    if (!normalizedUsername || !plainPassword || !selectedCategoryInput) {
      return res.status(400).json({ error: 'Username, password, and category are required.' });
    }

    if (plainPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existingUser = await getUserByEmail(normalizedUsername);
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists.' });
    }

    const selectedCategory = await findCategoryByInput(
      selectedCategoryInput,
      'Error validating display user category'
    );
    if (!selectedCategory) {
      return res.status(400).json({ error: 'Selected category does not exist.' });
    }

    const userRow = {
      id: generateId(),
      email: normalizedUsername,
      password: await hashPassword(plainPassword),
      role: buildDisplayRole(selectedCategory.id),
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('users')
      .insert(userRow)
      .select('id,email,role,created_at')
      .single();
    throwSupabaseError('Error creating display user', error);

    await appendSystemHistory('access_user_created', (req.user && req.user.email) || null, {
      id: data.id,
      title: 'Display Access User Created',
      content: `Display credential "${normalizedUsername}" (User ID: ${data.id}) was created for category "${selectedCategory.name}" (Category ID: ${selectedCategory.id}).`,
      category: selectedCategory.id,
      type: 'system_auth',
      actionAt: userRow.created_at
    });

    res.status(201).json({
      ...toDisplayUserDto(data),
      categoryName: selectedCategory.name
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/display-users/:id', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    const { data: users, error: readError } = await supabase
      .from('users')
      .select('id,email,role,created_at')
      .eq('id', req.params.id)
      .limit(1);
    throwSupabaseError('Error reading display user', readError);

    const target = users && users.length > 0 ? users[0] : null;
    if (!target || !isDisplayRole(target.role)) {
      return res.status(404).json({ error: 'Display user not found.' });
    }

    const { error } = await supabase.from('users').delete().eq('id', req.params.id);
    throwSupabaseError('Error deleting display user', error);

    const assignedCategoryId = getDisplayCategoryIdFromRole(target.role);
    const deletedAt = new Date().toISOString();
    await appendSystemHistory('access_user_deleted', (req.user && req.user.email) || null, {
      id: target.id,
      title: 'Display Access User Deleted',
      content: `Display credential "${target.email}" (User ID: ${target.id}) was deleted.`,
      category: assignedCategoryId === 'all' ? null : assignedCategoryId,
      type: 'system_auth',
      actionAt: deletedAt
    });

    res.json({ id: target.id, message: 'Display user deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/staff-users', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id,email,role,created_at')
      .eq('role', 'staff')
      .order('created_at', { ascending: false });

    throwSupabaseError('Error fetching staff users', error);
    res.json((data || []).map(toStaffUserDto));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/staff-users', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    const { username, password } = req.body;
    const normalizedUsername = normalizeUsername(username);
    const plainPassword = String(password || '').trim();

    if (!normalizedUsername || !plainPassword) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    if (plainPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existingUser = await getUserByEmail(normalizedUsername);
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists.' });
    }

    const userRow = {
      id: generateId(),
      email: normalizedUsername,
      password: await hashPassword(plainPassword),
      role: 'staff',
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('users')
      .insert(userRow)
      .select('id,email,role,created_at')
      .single();
    throwSupabaseError('Error creating staff user', error);

    await appendSystemHistory('staff_user_created', (req.user && req.user.email) || null, {
      id: data.id,
      title: 'Staff Access User Created',
      content: `Staff credential "${normalizedUsername}" (User ID: ${data.id}) was created.`,
      type: 'system_auth',
      actionAt: userRow.created_at
    });

    res.status(201).json(toStaffUserDto(data));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/staff-users/:id', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    const { data: users, error: readError } = await supabase
      .from('users')
      .select('id,email,role,created_at')
      .eq('id', req.params.id)
      .limit(1);
    throwSupabaseError('Error reading staff user', readError);

    const target = users && users.length > 0 ? users[0] : null;
    if (!target || !isStaffRole(target.role)) {
      return res.status(404).json({ error: 'Staff user not found.' });
    }

    const { error } = await supabase.from('users').delete().eq('id', req.params.id);
    throwSupabaseError('Error deleting staff user', error);

    const deletedAt = new Date().toISOString();
    await appendSystemHistory('staff_user_deleted', (req.user && req.user.email) || null, {
      id: target.id,
      title: 'Staff Access User Deleted',
      content: `Staff credential "${target.email}" (User ID: ${target.id}) was deleted.`,
      type: 'system_auth',
      actionAt: deletedAt
    });

    res.json({ id: target.id, message: 'Staff user deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/start', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const { link } = req.body;
    if (!link) return res.status(400).json({ error: 'Link is required' });

    const now = new Date().toISOString();
    const liveRow = {
      id: LIVE_STATUS_ID,
      status: 'ON',
      link,
      started_at: now,
      stopped_at: null,
      updated_at: now
    };

    const { data, error } = await supabase
      .from('live_state')
      .upsert(liveRow, { onConflict: 'id' })
      .select('*')
      .single();

    if (isMissingTableError(error, 'live_state')) {
      liveStateFallback.status = 'ON';
      liveStateFallback.link = link;
      liveStateFallback.startedAt = now;
      liveStateFallback.stoppedAt = null;

      await appendSystemHistory('live_started', (req.user && req.user.email) || null, {
        title: 'Live Broadcast Started',
        content: `Live stream started with link: ${link}`,
        type: 'system_live',
        actionAt: now
      });

      io.emit('liveUpdate', getFallbackLiveDto());
      return res.json(getFallbackLiveDto());
    }

    throwSupabaseError('Error starting live', error);

    await appendSystemHistory('live_started', (req.user && req.user.email) || null, {
      title: 'Live Broadcast Started',
      content: `Live stream started with link: ${link}`,
      type: 'system_live',
      actionAt: now
    });

    const payload = toLiveDto(data);
    io.emit('liveUpdate', payload);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stop', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const liveRow = {
      id: LIVE_STATUS_ID,
      status: 'OFF',
      link: null,
      stopped_at: now,
      updated_at: now
    };

    const { data, error } = await supabase
      .from('live_state')
      .upsert(liveRow, { onConflict: 'id' })
      .select('*')
      .single();

    if (isMissingTableError(error, 'live_state')) {
      liveStateFallback.status = 'OFF';
      liveStateFallback.link = null;
      liveStateFallback.stoppedAt = now;

      await appendSystemHistory('live_stopped', (req.user && req.user.email) || null, {
        title: 'Live Broadcast Stopped',
        content: 'Live stream was stopped.',
        type: 'system_live',
        actionAt: now
      });

      io.emit('liveUpdate', getFallbackLiveDto());
      return res.json(getFallbackLiveDto());
    }

    throwSupabaseError('Error stopping live', error);

    await appendSystemHistory('live_stopped', (req.user && req.user.email) || null, {
      title: 'Live Broadcast Stopped',
      content: 'Live stream was stopped.',
      type: 'system_live',
      actionAt: now
    });

    const payload = toLiveDto(data);
    io.emit('liveUpdate', payload);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/test', (req, res) => {
  res.json({
    status: 'Server is running perfectly!',
    database: 'Using Supabase PostgreSQL',
    port: 5001,
    features: ['Image/video/document upload', 'Real-time updates', 'Supabase storage']
  });
});

app.get('/api/health', async (req, res) => {
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error && !isMissingTableError(error, 'users')) {
      throwSupabaseError('Health check database error', error);
    }

    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      startedAt,
      database: error ? 'degraded' : 'ok'
    });
  } catch (error) {
    res.status(503).json({
      status: 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      startedAt,
      error: error.message
    });
  }
});

app.use((error, req, res, next) => {
  if (!error) {
    return next();
  }

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `Uploaded file exceeds ${MAX_UPLOAD_SIZE_MB}MB size limit.` });
    }
    return res.status(400).json({ error: error.message || 'File upload failed.' });
  }

  if (Number.isInteger(error.statusCode)) {
    return res.status(error.statusCode).json({ error: error.message || 'Invalid request.' });
  }

  console.error('❌ Unhandled server error:', error);
  return res.status(500).json({ error: 'Unexpected server error.' });
});

app.use('/api', (req, res) => {
  res.status(404).json({
    error: `API route not found: ${req.method} ${req.originalUrl}`
  });
});

app.get('/', (req, res) => {
  if (hasClientBuild) {
    return res.sendFile(path.join(clientDistPath, 'index.html'));
  }

  res.json({
    message: 'Digital Notice Board API',
    version: '3.0',
    features: [
      'Image/video/document upload support',
      'Real-time Socket.io updates',
      'Priority-based sorting',
      'Supabase database'
    ],
    endpoints: {
      test: 'GET /api/test',
      health: 'GET /api/health',
      login: 'POST /api/auth/login',
      staffLogin: 'POST /api/staff-auth/login',
      displayLogin: 'POST /api/display-auth/login',
      history: {
        all: 'GET /api/history',
        login: 'GET /api/history/login',
        id: 'GET /api/history/id'
      },
      announcements: {
        public: 'GET /api/announcements/public',
        all: 'GET /api/announcements',
        create: 'POST /api/announcements (with image/document)',
        update: 'PUT /api/announcements/:id',
        delete: 'DELETE /api/announcements/:id'
      },
      displayUsers: {
        list: 'GET /api/display-users',
        create: 'POST /api/display-users',
        delete: 'DELETE /api/display-users/:id'
      },
      staffUsers: {
        list: 'GET /api/staff-users',
        create: 'POST /api/staff-users',
        delete: 'DELETE /api/staff-users/:id'
      }
    }
  });
});

app.get(/^(?!\/api|\/uploads).*/, (req, res) => {
  if (hasClientBuild) {
    return res.sendFile(path.join(clientDistPath, 'index.html'));
  }

  res.status(404).json({ error: 'Not found' });
});

const PORT = Number(process.env.PORT) || 5001;

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
});

function ensureMaintenanceScheduler() {
  if (IS_SERVERLESS_RUNTIME || maintenanceIntervalHandle) {
    return;
  }

  maintenanceIntervalHandle = setInterval(() => {
    runAnnouncementMaintenance();
  }, ANNOUNCEMENT_MAINTENANCE_INTERVAL_MS);
}

async function ensureRuntimeInitialized() {
  if (!runtimeInitPromise) {
    runtimeInitPromise = initializeSupabase().catch((error) => {
      runtimeInitPromise = null;
      throw error;
    });
  }

  await runtimeInitPromise;
  ensureMaintenanceScheduler();
}

async function startServer() {
  if (!server) {
    throw new Error('HTTP server is unavailable in serverless runtime.');
  }

  await ensureRuntimeInitialized();

  server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📁 Uploads directory: ${uploadsDir}`);
    console.log(
      IS_SERVERLESS_RUNTIME
        ? '📡 Real-time socket transport disabled in serverless runtime'
        : '📡 Socket.io ready for real-time updates'
    );
    console.log('🗄️ Database: Supabase PostgreSQL');
    console.log(`👤 Default admin account ensured for ${DEFAULT_ADMIN.email}`);
    console.log(`🔗 Test: http://localhost:${PORT}/api/test`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('❌ Supabase startup error:', error.message);
    process.exit(1);
  });
}

module.exports = {
  app,
  io,
  ensureRuntimeInitialized
};
