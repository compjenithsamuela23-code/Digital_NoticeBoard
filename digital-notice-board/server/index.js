const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const dotenv = require('dotenv');
const http = require('http');
const socketIo = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const dns = require('dns').promises;
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
const MAX_DISPLAY_BATCH_SLOT = 24;
const MAX_GLOBAL_LIVE_LINKS = 24;
const MAX_ANNOUNCEMENT_LIVE_LINKS = 24;
const LIVE_LINK_SPLIT_PATTERN = /[\s\n,;]+/;
const LIVE_LINK_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const LIVE_LINK_DOMAIN_PATTERN = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#].*)?$/i;
const LIVE_LINK_QUERY_KEYS = ['url', 'u', 'link', 'target', 'redirect', 'redirect_url', 'text', 'body', 'message'];
const LIVE_LINK_WRAPPER_HOSTS = [
  'facebook.com',
  'whatsapp.com',
  'wa.me',
  'telegram.me',
  't.me',
  'x.com',
  'twitter.com',
  'linkedin.com',
  'reddit.com',
  'instagram.com'
];
const ANNOUNCEMENT_MAINTENANCE_INTERVAL_MS = 60 * 1000;
const ANNOUNCEMENT_MAINTENANCE_MIN_INTERVAL_MS = Math.max(
  10 * 1000,
  Number.parseInt(process.env.ANNOUNCEMENT_MAINTENANCE_MIN_INTERVAL_MS, 10) || 30 * 1000
);
const MAINTENANCE_AGENT_STATUS_PATH = path.resolve(__dirname, '../.runtime/maintenance-agent-status.json');
const OPS_AGENT_SETTINGS_PATH = path.resolve(__dirname, '../.runtime/ops-agent-settings.json');
const MAINTENANCE_AGENT_STALE_MS = Math.max(
  30 * 1000,
  Number.parseInt(process.env.MAINTENANCE_AGENT_STALE_MS, 10) || 5 * 60 * 1000
);
const MAINTENANCE_AGENT_NETWORK_URL = String(
  process.env.MAINTENANCE_AGENT_NETWORK_URL || 'https://www.gstatic.com/generate_204'
).trim();
const MAINTENANCE_AGENT_DNS_HOST = String(process.env.MAINTENANCE_AGENT_DNS_HOST || 'google.com').trim();
const MAINTENANCE_AGENT_PROBE_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.MAINTENANCE_AGENT_PROBE_TIMEOUT_MS, 10) || 5000
);
const MAINTENANCE_AGENT_RUNTIME_CACHE_MS = Math.max(
  5000,
  Number.parseInt(process.env.MAINTENANCE_AGENT_RUNTIME_CACHE_MS, 10) || 20000
);
const MAINTENANCE_AGENT_RUNTIME_NAME = 'Digital Notice Board Runtime Agent';
const MAINTENANCE_AGENT_RUNTIME_VERSION = '2.0.0';
const REQUIRED_SUPABASE_TABLES = ['users', 'categories', 'announcements', 'history'];
const OPTIONAL_SUPABASE_TABLES = ['live_state'];
let maintenanceInFlight = null;
let lastMaintenanceRunAtMs = 0;
let historyTableMode = 'unknown';
let runtimeInitPromise = null;
let maintenanceIntervalHandle = null;
let opsAgentIntervalHandle = null;
let storageBucketReadyPromise = null;
let runtimeDirectUploadMaxSizeBytes = 150 * 1024 * 1024;
let runtimeMaintenanceChecksCompleted = 0;
const opsAgentRuntimeState = {
  startedAt: new Date().toISOString(),
  checksCompleted: 0,
  repairsAttempted: 0,
  repairsSucceeded: 0,
  repairsFailed: 0,
  lastRepairAtMs: 0,
  lastRepair: null,
  currentAction: null
};
const runtimeApiResponseCache = new Map();
const runtimeApiCacheStats = {
  hits: 0,
  misses: 0,
  sets: 0,
  invalidations: 0,
  lastInvalidateAt: null
};
const platformStatusCacheState = {
  payload: null,
  updatedAtMs: 0,
  inFlight: null
};
const runtimeMaintenanceStatusCache = {
  full: {
    payload: null,
    updatedAtMs: 0,
    inFlight: null
  },
  light: {
    payload: null,
    updatedAtMs: 0,
    inFlight: null
  }
};
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
  links: [],
  category: null,
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
const SUPABASE_RESUMABLE_UPLOAD_URL = (() => {
  try {
    const parsed = new URL(SUPABASE_URL);
    if (/\.storage\.supabase\.co$/i.test(parsed.hostname)) {
      return `${parsed.origin}/storage/v1/upload/resumable`;
    }
    const directStorageHost = parsed.hostname.replace(/\.supabase\.co$/i, '.storage.supabase.co');
    return `${parsed.protocol}//${directStorageHost}/storage/v1/upload/resumable`;
  } catch {
    return `${String(SUPABASE_URL || '').replace(/\/+$/, '')}/storage/v1/upload/resumable`;
  }
})();
const DESIRED_DIRECT_UPLOAD_MAX_SIZE_BYTES = 150 * 1024 * 1024;
const DESIRED_DIRECT_UPLOAD_MAX_SIZE_MB = Math.floor(DESIRED_DIRECT_UPLOAD_MAX_SIZE_BYTES / (1024 * 1024));
const SUPABASE_FREE_PLAN_FALLBACK_MAX_SIZE_BYTES = 50 * 1024 * 1024;
const LOCAL_MAX_UPLOAD_SIZE_BYTES = DESIRED_DIRECT_UPLOAD_MAX_SIZE_BYTES;
const SERVERLESS_MAX_UPLOAD_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_SIZE_BYTES = IS_SERVERLESS_RUNTIME
  ? SERVERLESS_MAX_UPLOAD_SIZE_BYTES
  : LOCAL_MAX_UPLOAD_SIZE_BYTES;
const MAX_UPLOAD_SIZE_MB = Math.floor(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024));
const CACHE_CONTROL_SHORT_PUBLIC = 'public, max-age=8, stale-while-revalidate=40';
const CACHE_CONTROL_CATEGORIES_PUBLIC = 'public, max-age=30, stale-while-revalidate=120';
const CACHE_CONTROL_UPLOAD_ASSETS = 'public, max-age=3600, stale-while-revalidate=86400';
const CACHE_CONTROL_STATIC_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_CONTROL_STATIC_FALLBACK = 'public, max-age=600';
const MAX_PUBLIC_ANNOUNCEMENTS = Math.max(
  48,
  Number.parseInt(process.env.MAX_PUBLIC_ANNOUNCEMENTS, 10) || 320
);
const MAX_WORKSPACE_ANNOUNCEMENTS = Math.max(
  80,
  Number.parseInt(process.env.MAX_WORKSPACE_ANNOUNCEMENTS, 10) || 500
);
const CACHEABLE_PUBLIC_API_PATHS = new Set(['/announcements/public', '/status', '/categories']);
const HASHED_ASSET_FILE_PATTERN = /\.[a-f0-9]{8,}\./i;
const API_RUNTIME_CACHE_ENABLED = String(process.env.API_RUNTIME_CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const API_RUNTIME_CACHE_STATUS_TTL_MS = Math.max(
  1000,
  Number.parseInt(process.env.API_RUNTIME_CACHE_STATUS_TTL_MS, 10) || 5000
);
const API_RUNTIME_CACHE_CATEGORIES_TTL_MS = Math.max(
  3000,
  Number.parseInt(process.env.API_RUNTIME_CACHE_CATEGORIES_TTL_MS, 10) || 45000
);
const API_RUNTIME_CACHE_PUBLIC_ANNOUNCEMENTS_TTL_MS = Math.max(
  1000,
  Number.parseInt(process.env.API_RUNTIME_CACHE_PUBLIC_ANNOUNCEMENTS_TTL_MS, 10) || 8000
);
const API_RUNTIME_CACHE_WORKSPACE_ANNOUNCEMENTS_TTL_MS = Math.max(
  1000,
  Number.parseInt(process.env.API_RUNTIME_CACHE_WORKSPACE_ANNOUNCEMENTS_TTL_MS, 10) || 6000
);
const PLATFORM_STATUS_CACHE_MS = Math.max(
  5000,
  Number.parseInt(process.env.PLATFORM_STATUS_CACHE_MS, 10) || 45000
);
const GITHUB_REPO = String(process.env.GITHUB_REPO || '').trim();
const GITHUB_API_BASE_URL = String(process.env.GITHUB_API_BASE_URL || 'https://api.github.com').trim();
const GITHUB_TOKEN = String(process.env.GITHUB_TOKEN || '').trim();
const VERCEL_API_BASE_URL = String(process.env.VERCEL_API_BASE_URL || 'https://api.vercel.com').trim();
const VERCEL_API_TOKEN = String(process.env.VERCEL_TOKEN || process.env.VERCEL_API_TOKEN || '').trim();
const VERCEL_PROJECT_ID = String(process.env.VERCEL_PROJECT_ID || '').trim();
const VERCEL_TEAM_ID = String(process.env.VERCEL_TEAM_ID || '').trim();
const VERCEL_DEPLOY_HOOK_URL = String(process.env.VERCEL_DEPLOY_HOOK_URL || '').trim();
const GITHUB_ACTIONS_WORKFLOW_ID = String(process.env.GITHUB_ACTIONS_WORKFLOW_ID || '').trim();
const GITHUB_ACTIONS_REF = String(process.env.GITHUB_ACTIONS_REF || '').trim();
const OPS_AGENT_RUNTIME_NAME = 'Digital Notice Board Ops Agent';
const OPS_AGENT_RUNTIME_VERSION = '1.0.0';
const OPS_AGENT_DEFAULT_AUTOFIX_ENABLED =
  String(process.env.OPS_AGENT_AUTOFIX_ENABLED || 'true').toLowerCase() !== 'false';
const OPS_AGENT_INTERVAL_MS = Math.max(
  15000,
  Number.parseInt(process.env.OPS_AGENT_INTERVAL_MS, 10) || 60000
);
const OPS_AGENT_COOLDOWN_MS = Math.max(
  30000,
  Number.parseInt(process.env.OPS_AGENT_COOLDOWN_MS, 10) || 5 * 60 * 1000
);
const OPS_AGENT_ACTION_TIMEOUT_MS = Math.max(
  10000,
  Number.parseInt(process.env.OPS_AGENT_ACTION_TIMEOUT_MS, 10) || 3 * 60 * 1000
);
const OPS_AGENT_HISTORY_ACTIONS = [
  'ops_action_manual',
  'ops_action_auto',
  'ops_settings_updated',
  'ops_diagnostic_snapshot'
];
const OPS_AGENT_HISTORY_TYPES = ['system_ops', 'system_ops_success', 'system_ops_error'];

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
app.use(
  compression({
    threshold: 1024
  })
);
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use('/api', (req, res, next) => {
  const canUseCacheHeaders =
    req.method === 'GET' && CACHEABLE_PUBLIC_API_PATHS.has(String(req.path || '').toLowerCase());
  if (API_NO_STORE && !canUseCacheHeaders) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'), {
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', CACHE_CONTROL_UPLOAD_ASSETS);
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
  app.use(
    express.static(clientDistPath, {
      index: false,
      setHeaders: (res, filePath) => {
        const normalized = String(filePath || '').toLowerCase();
        if (normalized.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
          return;
        }

        const baseName = path.basename(filePath);
        if (HASHED_ASSET_FILE_PATTERN.test(baseName)) {
          res.setHeader('Cache-Control', CACHE_CONTROL_STATIC_IMMUTABLE);
          return;
        }

        res.setHeader('Cache-Control', CACHE_CONTROL_STATIC_FALLBACK);
      }
    })
  );
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

function normalizePriorityValue(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return Math.max(0, Number.parseInt(fallback, 10) || 0);
  }
  return Math.max(0, parsed);
}

function isEmergencyPriorityValue(value) {
  return normalizePriorityValue(value, 1) === 0;
}

function hasAnnouncementLiveStreamLinks(row) {
  if (!row) return false;
  return parseStoredLiveLinks(row.live_stream_links, {
    maxLinks: MAX_ANNOUNCEMENT_LIVE_LINKS
  }).length > 0;
}

function getAnnouncementSortTimestamp(row) {
  const updatedAt = toDateOrNull(row && row.updated_at);
  if (updatedAt) {
    return updatedAt.getTime();
  }

  const createdAt = toDateOrNull(row && row.created_at);
  return createdAt ? createdAt.getTime() : 0;
}

function comparePublicAnnouncements(left, right) {
  const leftEmergency = isEmergencyPriorityValue(left && left.priority);
  const rightEmergency = isEmergencyPriorityValue(right && right.priority);

  if (leftEmergency !== rightEmergency) {
    return leftEmergency ? -1 : 1;
  }

  const leftHasLiveStream = hasAnnouncementLiveStreamLinks(left);
  const rightHasLiveStream = hasAnnouncementLiveStreamLinks(right);
  if (leftHasLiveStream !== rightHasLiveStream) {
    return leftHasLiveStream ? -1 : 1;
  }

  const leftPriority = normalizePriorityValue(left && left.priority, 1);
  const rightPriority = normalizePriorityValue(right && right.priority, 1);
  if (leftPriority !== rightPriority && !leftEmergency && !rightEmergency) {
    return rightPriority - leftPriority;
  }

  const leftSortTimestamp = getAnnouncementSortTimestamp(left);
  const rightSortTimestamp = getAnnouncementSortTimestamp(right);
  if (leftSortTimestamp !== rightSortTimestamp) {
    return rightSortTimestamp - leftSortTimestamp;
  }

  return String((right && right.id) || '').localeCompare(String((left && left.id) || ''));
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

function isGenericMimeType(value) {
  const normalized = normalizeUploadedMimeType(value);
  if (!normalized) return true;
  return GENERIC_MIME_TYPES.has(normalized);
}

function inferMimeTypeFromReference(reference) {
  const extension = getMediaPathExtension(reference);
  if (!extension) return null;
  return MIME_TYPE_BY_EXTENSION[extension] || null;
}

function resolveAttachmentMimeType(candidateMimeType, references = []) {
  const normalizedCandidate = normalizeUploadedMimeType(candidateMimeType);
  if (normalizedCandidate && !isGenericMimeType(normalizedCandidate)) {
    return normalizedCandidate;
  }

  for (const reference of references) {
    const inferred = inferMimeTypeFromReference(reference);
    if (inferred) {
      return inferred;
    }
  }

  return normalizedCandidate || null;
}

function parseNonNegativeInteger(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function normalizeDisplayBatchId(value, { strict = false } = {}) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (normalized.length > 80) {
    if (strict) {
      throw createBadRequestError('displayBatchId is too long.');
    }
    return null;
  }
  if (!/^[a-z0-9_-]+$/i.test(normalized)) {
    if (strict) {
      throw createBadRequestError('displayBatchId can contain only letters, numbers, "_" and "-".');
    }
    return null;
  }
  return normalized;
}

function parseDisplayBatchSlot(value, { strict = false } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  if (parsed < 1 || parsed > MAX_DISPLAY_BATCH_SLOT) {
    if (strict) {
      throw createBadRequestError(`displayBatchSlot must be between 1 and ${MAX_DISPLAY_BATCH_SLOT}.`);
    }
    return null;
  }
  return parsed;
}

function normalizeAnnouncementMutationScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'batch' ? 'batch' : 'single';
}

function createServerDisplayBatchId() {
  return generateId().replace(/-/g, '_');
}

function inferFileNameFromReference(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      pathname = new URL(raw).pathname || raw;
    } catch {
      pathname = raw;
    }
  }

  const segment = pathname
    .split('/')
    .filter(Boolean)
    .pop();

  if (!segment) return null;
  try {
    return sanitizeOriginalFileName(decodeURIComponent(segment));
  } catch {
    return sanitizeOriginalFileName(segment);
  }
}

function normalizeAttachmentReference(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.length > 2048) {
    throw createBadRequestError('Attachment reference is too long.');
  }
  return raw.replace(/\\/g, '/');
}

function isManagedAttachmentReference(value) {
  const normalizedReference = normalizeAttachmentReference(value);
  if (!normalizedReference) return false;
  if (normalizedReference.startsWith('/uploads/')) return true;
  return Boolean(getStorageObjectPathFromReference(normalizedReference));
}

function parseAttachmentInput(body = {}) {
  const attachmentPath = normalizeAttachmentReference(body.attachmentUrl || body.attachmentPath || '');
  if (!attachmentPath) {
    return {
      hasAttachmentInput: false,
      attachmentPath: null,
      attachmentMetadata: {
        file_name: null,
        file_mime_type: null,
        file_size_bytes: null
      }
    };
  }

  if (!isManagedAttachmentReference(attachmentPath)) {
    throw createBadRequestError('Attachment URL must point to Notice Board managed storage.');
  }

  const providedFileName = sanitizeOriginalFileName(body.attachmentFileName || body.fileName || '');
  const inferredFileName = inferFileNameFromReference(attachmentPath);
  const providedMimeType = normalizeUploadedMimeType(body.attachmentMimeType || body.fileMimeType || '');
  const resolvedMimeType = resolveAttachmentMimeType(providedMimeType, [
    providedFileName,
    inferredFileName,
    attachmentPath
  ]);
  const providedFileSize = parseNonNegativeInteger(
    body.attachmentFileSizeBytes !== undefined ? body.attachmentFileSizeBytes : body.fileSizeBytes
  );

  return {
    hasAttachmentInput: true,
    attachmentPath,
    attachmentMetadata: {
      file_name: providedFileName || inferredFileName,
      file_mime_type: resolvedMimeType,
      file_size_bytes: providedFileSize
    }
  };
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
  const sanitizedFileName = sanitizeOriginalFileName(uploadedFile.originalname);
  const resolvedMimeType = resolveAttachmentMimeType(uploadedFile.mimetype, [
    sanitizedFileName,
    uploadedFile.originalname
  ]);
  return {
    file_name: sanitizedFileName,
    file_mime_type: resolvedMimeType,
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForStorageAttachmentAvailability(
  attachmentReference,
  { attempts = 4, delayMs = 250 } = {}
) {
  const objectPath = getStorageObjectPathFromReference(attachmentReference);
  if (!objectPath) {
    return true;
  }

  const normalizedObjectPath = objectPath.replace(/^\/+/, '');
  const parentDirectory = path.posix.dirname(normalizedObjectPath);
  const fileName = path.posix.basename(normalizedObjectPath);
  if (!fileName || fileName === '.' || fileName === '/') {
    return false;
  }

  const listPath = parentDirectory === '.' ? '' : parentDirectory;
  const safeAttempts = Math.max(1, Number.parseInt(attempts, 10) || 1);
  const safeDelay = Math.max(50, Number.parseInt(delayMs, 10) || 250);

  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    const { data, error } = await supabase.storage.from(SUPABASE_STORAGE_BUCKET).list(listPath, {
      limit: 200,
      search: fileName
    });

    if (!error) {
      const found = (data || []).some((entry) => entry && String(entry.name || '') === fileName);
      if (found) {
        return true;
      }
    }

    if (attempt < safeAttempts - 1) {
      await sleep(safeDelay);
    }
  }

  return false;
}

function getDirectUploadMaxSizeBytes() {
  return runtimeDirectUploadMaxSizeBytes;
}

function getDirectUploadMaxSizeMb() {
  return Math.floor(getDirectUploadMaxSizeBytes() / (1024 * 1024));
}

function setDirectUploadMaxSizeBytes(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return;
  }
  runtimeDirectUploadMaxSizeBytes = parsed;
}

function getStorageBucketFileLimitBytes(bucket) {
  const parsed = Number.parseInt(bucket?.fileSizeLimit ?? bucket?.file_size_limit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isStorageLimitConstraintError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('maximum allowed size') || message.includes('file size limit');
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

    const existingBucket = (buckets || []).find((bucket) => bucket && bucket.name === SUPABASE_STORAGE_BUCKET);
    const existingFileLimitBytes = getStorageBucketFileLimitBytes(existingBucket);
    const fallbackLimitBytes = existingFileLimitBytes || SUPABASE_FREE_PLAN_FALLBACK_MAX_SIZE_BYTES;
    const shouldUpdateBucket =
      Boolean(existingBucket) &&
      (existingBucket.public !== true ||
        !Number.isFinite(existingFileLimitBytes) ||
        existingFileLimitBytes < DESIRED_DIRECT_UPLOAD_MAX_SIZE_BYTES);

    if (shouldUpdateBucket) {
      const { error: updateError } = await supabase.storage.updateBucket(SUPABASE_STORAGE_BUCKET, {
        public: true,
        fileSizeLimit: DESIRED_DIRECT_UPLOAD_MAX_SIZE_BYTES
      });
      if (updateError) {
        if (!isStorageLimitConstraintError(updateError)) {
          throw new Error(
            `Error updating Supabase storage bucket "${SUPABASE_STORAGE_BUCKET}": ${updateError.message}`
          );
        }

        setDirectUploadMaxSizeBytes(fallbackLimitBytes);
        console.warn(
          `Supabase bucket "${SUPABASE_STORAGE_BUCKET}" could not be raised to ${DESIRED_DIRECT_UPLOAD_MAX_SIZE_MB}MB. ` +
            `Keeping the live limit at ${getDirectUploadMaxSizeMb()}MB for this project.`
        );
      } else {
        setDirectUploadMaxSizeBytes(DESIRED_DIRECT_UPLOAD_MAX_SIZE_BYTES);
      }
    } else {
      setDirectUploadMaxSizeBytes(DESIRED_DIRECT_UPLOAD_MAX_SIZE_BYTES);
    }

    const hasBucket = Boolean(existingBucket);
    if (hasBucket) {
      return;
    }

    const { error: createError } = await supabase.storage.createBucket(SUPABASE_STORAGE_BUCKET, {
      public: true,
      fileSizeLimit: DESIRED_DIRECT_UPLOAD_MAX_SIZE_BYTES
    });

    if (createError) {
      const message = String(createError.message || '').toLowerCase();
      if (!message.includes('already exists') && !isStorageLimitConstraintError(createError)) {
        throw new Error(
          `Error creating Supabase storage bucket "${SUPABASE_STORAGE_BUCKET}": ${createError.message}`
        );
      }

      if (isStorageLimitConstraintError(createError)) {
        const { error: fallbackCreateError } = await supabase.storage.createBucket(SUPABASE_STORAGE_BUCKET, {
          public: true
        });
        const fallbackMessage = String(fallbackCreateError?.message || '').toLowerCase();
        if (fallbackCreateError && !fallbackMessage.includes('already exists')) {
          throw new Error(
            `Error creating Supabase storage bucket "${SUPABASE_STORAGE_BUCKET}": ${fallbackCreateError.message}`
          );
        }
        setDirectUploadMaxSizeBytes(SUPABASE_FREE_PLAN_FALLBACK_MAX_SIZE_BYTES);
        console.warn(
          `Supabase bucket "${SUPABASE_STORAGE_BUCKET}" was created with the project storage limit. ` +
            `Direct uploads are capped at ${getDirectUploadMaxSizeMb()}MB until the global storage limit is increased.`
        );
      } else {
        setDirectUploadMaxSizeBytes(DESIRED_DIRECT_UPLOAD_MAX_SIZE_BYTES);
      }
    } else {
      setDirectUploadMaxSizeBytes(DESIRED_DIRECT_UPLOAD_MAX_SIZE_BYTES);
    }

    console.log(
      `✅ Supabase storage bucket ready: ${SUPABASE_STORAGE_BUCKET} (direct upload limit ${getDirectUploadMaxSizeMb()}MB)`
    );
  })().catch((error) => {
    storageBucketReadyPromise = null;
    throw error;
  });

  return storageBucketReadyPromise;
}

function buildStorageObjectPath(uploadedFile) {
  return buildStorageObjectPathFromOriginalName(uploadedFile && uploadedFile.originalname);
}

function buildStorageObjectPathFromOriginalName(originalName) {
  const extension = path.extname(String(originalName || '')).toLowerCase();
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
  const contentType =
    resolveAttachmentMimeType(uploadedFile.mimetype, [uploadedFile.originalname, objectPath]) ||
    'application/octet-stream';

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
  if (isEmergencyPriorityValue(row.priority)) return true;

  // Announcements without category are global and visible to every display category.
  const rowCategory = getAnnouncementCategoryValue(row);
  if (!rowCategory) return true;

  return rowCategory === normalizedRequest;
}

function resolveMediaAspectDimensions({ mediaPath, mimeType, type, widthValue, heightValue }) {
  const parsedWidth = Number.parseInt(widthValue, 10);
  const parsedHeight = Number.parseInt(heightValue, 10);
  const hasStoredDimensions =
    Number.isFinite(parsedWidth) && parsedWidth > 0 && Number.isFinite(parsedHeight) && parsedHeight > 0;

  if (hasStoredDimensions) {
    return {
      mediaWidth: parsedWidth,
      mediaHeight: parsedHeight
    };
  }

  if (!mediaPath) {
    return {
      mediaWidth: Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : null,
      mediaHeight: Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : null
    };
  }

  return {
    mediaWidth: Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : null,
    mediaHeight: Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : null
  };
}

function toAnnouncementDto(row) {
  if (!row) return null;
  const parsedFileSize = Number.parseInt(row.file_size_bytes, 10);
  const liveStreamLinks = parseStoredLiveLinks(row.live_stream_links, {
    maxLinks: MAX_ANNOUNCEMENT_LIVE_LINKS
  });
  const resolvedMimeType = resolveAttachmentMimeType(row.file_mime_type, [row.file_name, row.image]);
  const resolvedType = getAnnouncementType(row.image, row.content, resolvedMimeType);
  const resolvedDimensions = resolveMediaAspectDimensions({
    mediaPath: row.image,
    mimeType: resolvedMimeType,
    type: resolvedType,
    widthValue: row.media_width,
    heightValue: row.media_height
  });
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    priority: normalizePriorityValue(row.priority, 1),
    isEmergency: isEmergencyPriorityValue(row.priority),
    duration: row.duration,
    isActive: row.is_active,
    category: row.category,
    image: row.image,
    type: resolvedType,
    fileName: row.file_name || null,
    fileMimeType: resolvedMimeType || null,
    fileSizeBytes: Number.isNaN(parsedFileSize) ? null : parsedFileSize,
    mediaWidth: resolvedDimensions.mediaWidth,
    mediaHeight: resolvedDimensions.mediaHeight,
    liveStreamLinks,
    displayBatchId: normalizeDisplayBatchId(row.display_batch_id) || null,
    displayBatchSlot: parseDisplayBatchSlot(row.display_batch_slot),
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
  const liveStreamLinks = parseStoredLiveLinks(
    row.live_stream_links !== undefined ? row.live_stream_links : snapshot.live_stream_links,
    { maxLinks: MAX_ANNOUNCEMENT_LIVE_LINKS }
  );
  const displayBatchId =
    normalizeDisplayBatchId(row.display_batch_id || snapshot.display_batch_id) || null;
  const displayBatchSlot = parseDisplayBatchSlot(row.display_batch_slot ?? snapshot.display_batch_slot);
  const imageReference = row.image || snapshot.image || null;
  const resolvedMimeType = resolveAttachmentMimeType(row.file_mime_type || snapshot.file_mime_type, [
    row.file_name || snapshot.file_name,
    imageReference
  ]);
  const resolvedType = getAnnouncementType(
    imageReference,
    row.content || snapshot.content || '',
    resolvedMimeType
  );
  const resolvedDimensions = resolveMediaAspectDimensions({
    mediaPath: imageReference,
    mimeType: resolvedMimeType,
    type: resolvedType,
    widthValue: row.media_width ?? snapshot.media_width,
    heightValue: row.media_height ?? snapshot.media_height
  });

  return {
    id: announcementId,
    title: row.title || snapshot.title || null,
    content: row.content || snapshot.content || null,
    priority: row.priority ?? snapshot.priority ?? null,
    duration: row.duration ?? snapshot.duration ?? null,
    isActive: row.is_active ?? snapshot.is_active ?? null,
    category: row.category || snapshot.category || null,
    image: imageReference,
    type: resolvedType || null,
    fileName: row.file_name || snapshot.file_name || null,
    fileMimeType: resolvedMimeType || null,
    fileSizeBytes: Number.isNaN(parsedFileSize) ? null : parsedFileSize,
    mediaWidth: resolvedDimensions.mediaWidth,
    mediaHeight: resolvedDimensions.mediaHeight,
    liveStreamLinks,
    displayBatchId,
    displayBatchSlot,
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

const LIVE_LINK_META_PREFIX = 'dnb_live:';

function tryParseJsonArrayInput(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return { matched: false, values: [] };
  }

  if (Array.isArray(rawValue)) {
    return { matched: true, values: rawValue };
  }

  const normalized = String(rawValue || '').trim();
  if (!normalized || !normalized.startsWith('[') || !normalized.endsWith(']')) {
    return { matched: false, values: [] };
  }

  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      return { matched: true, values: parsed };
    }
    return { matched: true, values: [] };
  } catch {
    return { matched: true, values: [] };
  }
}

function cleanupLiveLinkCandidate(value) {
  return String(value || '')
    .trim()
    .replace(/[\s)\],.;]+$/g, '');
}

function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || '').trim());
}

function parseUrl(value) {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
}

function normalizeLiveHost(host) {
  return String(host || '')
    .replace(/^www\./i, '')
    .toLowerCase();
}

function isSupportedLiveHost(host) {
  const normalizedHost = normalizeLiveHost(host);
  return (
    normalizedHost === 'youtu.be' ||
    normalizedHost.endsWith('youtube.com') ||
    normalizedHost.endsWith('vimeo.com') ||
    normalizedHost.endsWith('twitch.tv')
  );
}

function isLikelyWrapperHost(host) {
  const normalizedHost = normalizeLiveHost(host);
  return LIVE_LINK_WRAPPER_HOSTS.some(
    (candidate) => normalizedHost === candidate || normalizedHost.endsWith(`.${candidate}`)
  );
}

function decodeLinkValueVariants(value) {
  const variants = new Set();
  const initial = String(value || '').trim();
  if (!initial) return [];
  variants.add(initial);

  let current = initial;
  for (let step = 0; step < 2; step += 1) {
    if (!current.includes('%')) break;
    try {
      current = decodeURIComponent(current);
      if (current.trim()) variants.add(current.trim());
    } catch {
      break;
    }
  }

  return [...variants];
}

function extractRawLiveLinkCandidates(rawValue) {
  const normalizedRaw = String(rawValue || '').trim();
  if (!normalizedRaw) {
    return [];
  }

  const tokenSet = new Set();
  const urlMatches = normalizedRaw.match(LIVE_LINK_URL_PATTERN);
  if (Array.isArray(urlMatches) && urlMatches.length > 0) {
    urlMatches.forEach((item) => tokenSet.add(cleanupLiveLinkCandidate(item)));
  }

  normalizedRaw
    .split(LIVE_LINK_SPLIT_PATTERN)
    .map(cleanupLiveLinkCandidate)
    .filter(Boolean)
    .forEach((item) => tokenSet.add(item));

  return [...tokenSet];
}

function extractNestedLiveLinkCandidates(parsedUrl) {
  const candidateValues = [];
  const host = normalizeLiveHost(parsedUrl && parsedUrl.hostname);
  const includeAllParams = isLikelyWrapperHost(host);

  LIVE_LINK_QUERY_KEYS.forEach((key) => {
    parsedUrl.searchParams.getAll(key).forEach((value) => candidateValues.push(value));
  });

  if (includeAllParams) {
    parsedUrl.searchParams.forEach((value) => candidateValues.push(value));
  }

  const nested = new Set();
  candidateValues.forEach((value) => {
    decodeLinkValueVariants(value).forEach((decoded) => {
      extractRawLiveLinkCandidates(decoded).forEach((candidate) => nested.add(candidate));
    });
  });

  return [...nested];
}

function normalizeShareableLiveLink(value, { requireSupportedProvider = false } = {}) {
  return resolveShareableLiveLink(value, { requireSupportedProvider });
}

function resolveShareableLiveLink(
  value,
  { requireSupportedProvider = false, depth = 0 } = {}
) {
  if (depth > 2) {
    return null;
  }

  const cleaned = cleanupLiveLinkCandidate(value);
  if (!cleaned) {
    return null;
  }

  const withProtocol =
    hasUrlScheme(cleaned) || !LIVE_LINK_DOMAIN_PATTERN.test(cleaned)
      ? cleaned
      : `https://${cleaned}`;

  const parsed = parseUrl(withProtocol);
  if (!parsed) {
    return null;
  }

  const protocol = String(parsed.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return null;
  }

  if (protocol === 'http:') {
    parsed.protocol = 'https:';
  }

  if (isSupportedLiveHost(parsed.hostname)) {
    return parsed.toString();
  }

  const nestedCandidates = extractNestedLiveLinkCandidates(parsed);
  for (const candidate of nestedCandidates) {
    const resolved = resolveShareableLiveLink(candidate, {
      requireSupportedProvider,
      depth: depth + 1
    });
    if (resolved) {
      return resolved;
    }
  }

  if (requireSupportedProvider) {
    return null;
  }

  return parsed.toString();
}

function extractLiveLinkCandidates(rawValue) {
  return extractRawLiveLinkCandidates(rawValue);
}

function normalizeLiveLinks(
  rawLinks,
  { maxLinks = MAX_GLOBAL_LIVE_LINKS, requireSupportedProvider = false } = {}
) {
  const values = Array.isArray(rawLinks) ? rawLinks : [];
  const normalized = [];

  values.forEach((item) => {
    const rawValue =
      item && typeof item === 'object'
        ? item.url || item.link || ''
        : item;
    const normalizedLink = normalizeShareableLiveLink(rawValue, { requireSupportedProvider });
    if (!normalizedLink) return;
    if (normalized.includes(normalizedLink)) return;
    normalized.push(normalizedLink);
  });

  return normalized.slice(0, Math.max(1, Number.parseInt(maxLinks, 10) || 1));
}

function normalizeAnnouncementLiveStreamLinks(rawLinks) {
  return normalizeLiveLinks(rawLinks, {
    maxLinks: MAX_ANNOUNCEMENT_LIVE_LINKS,
    requireSupportedProvider: true
  });
}

function parseAnnouncementLiveStreamsInput(value) {
  if (Array.isArray(value)) {
    return normalizeAnnouncementLiveStreamLinks(value);
  }

  const parsedJson = tryParseJsonArrayInput(value);
  if (parsedJson.matched) {
    return normalizeAnnouncementLiveStreamLinks(parsedJson.values);
  }

  const normalized = String(value || '').trim();
  if (!normalized) {
    return [];
  }

  return normalizeAnnouncementLiveStreamLinks(extractLiveLinkCandidates(normalized));
}

function parseStoredLiveLinks(value, { maxLinks = MAX_GLOBAL_LIVE_LINKS } = {}) {
  if (Array.isArray(value)) {
    return normalizeLiveLinks(value, { maxLinks });
  }

  const parsedJson = tryParseJsonArrayInput(value);
  if (parsedJson.matched) {
    return normalizeLiveLinks(parsedJson.values, { maxLinks });
  }

  const normalized = String(value || '').trim();
  if (!normalized) {
    return [];
  }

  return normalizeLiveLinks(extractLiveLinkCandidates(normalized), { maxLinks });
}

function parseLiveLinksInput(linkValue, linksValue) {
  let candidates = [];

  if (Array.isArray(linksValue)) {
    candidates = linksValue.flatMap((item) => {
      if (item && typeof item === 'object') {
        return [item];
      }
      return extractLiveLinkCandidates(item);
    });
  } else if (typeof linksValue === 'string') {
    const parsedJsonLinks = tryParseJsonArrayInput(linksValue);
    if (parsedJsonLinks.matched) {
      candidates = parsedJsonLinks.values.flatMap((item) => {
        if (item && typeof item === 'object') {
          return [item];
        }
        return extractLiveLinkCandidates(item);
      });
    } else {
      candidates = extractLiveLinkCandidates(linksValue);
    }
  } else {
    const normalizedLinkValue = String(linkValue || '').trim();
    candidates = extractLiveLinkCandidates(normalizedLinkValue);
  }

  return normalizeLiveLinks(candidates, { requireSupportedProvider: true });
}

function encodeLiveLinkMetadata(linkValue, categoryValue, linksValue) {
  const normalizedLinks = parseLiveLinksInput(linkValue, linksValue);
  if (normalizedLinks.length === 0) {
    return null;
  }

  const normalizedLink = normalizedLinks[0];
  const normalizedCategory = String(categoryValue || '').trim() || null;
  const payload = JSON.stringify({
    link: normalizedLink,
    links: normalizedLinks,
    category: normalizedCategory
  });
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url');
  return `${LIVE_LINK_META_PREFIX}${encodedPayload}`;
}

function decodeLiveLinkMetadata(storedLinkValue) {
  const normalized = String(storedLinkValue || '').trim();
  if (!normalized) {
    return { link: null, links: [], category: null };
  }

  if (!normalized.startsWith(LIVE_LINK_META_PREFIX)) {
    return { link: normalized, links: [normalized], category: null };
  }

  const encodedPayload = normalized.slice(LIVE_LINK_META_PREFIX.length);
  if (!encodedPayload) {
    return { link: null, links: [], category: null };
  }

  try {
    const decodedPayload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const parsedPayload = JSON.parse(decodedPayload);
    const normalizedLinks = parseStoredLiveLinks(
      Array.isArray(parsedPayload.links) && parsedPayload.links.length > 0
        ? parsedPayload.links
        : parsedPayload.link
          ? [parsedPayload.link]
          : []
    );
    return {
      link: normalizedLinks[0] || null,
      links: normalizedLinks,
      category: String(parsedPayload.category || '').trim() || null
    };
  } catch {
    const fallbackLinks = parseStoredLiveLinks(normalized);
    return {
      link: fallbackLinks[0] || null,
      links: fallbackLinks,
      category: null
    };
  }
}

function toLiveDto(row) {
  const decodedLinkMeta = row ? decodeLiveLinkMetadata(row.link) : { link: null, links: [], category: null };
  const storedLinks = row
    ? parseStoredLiveLinks(row.links, { maxLinks: MAX_GLOBAL_LIVE_LINKS })
    : [];
  const resolvedLinks =
    storedLinks.length > 0
      ? storedLinks
      : decodedLinkMeta.links || [];
  const resolvedLink = resolvedLinks[0] || decodedLinkMeta.link || null;
  const hasCategoryField = row && Object.prototype.hasOwnProperty.call(row, 'category');
  const rawCategory = hasCategoryField
    ? row.category || decodedLinkMeta.category
    : decodedLinkMeta.category || liveStateFallback.category;
  const normalizedCategory = String(rawCategory || '').trim();

  if (!row) {
    return { status: 'OFF', link: null, links: [], category: 'all' };
  }
  return {
    status: row.status || 'OFF',
    link: resolvedLink,
    links: resolvedLinks,
    category: normalizedCategory || 'all',
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

  const qualifiedRegex = new RegExp(`column\\s+${tableName}\\.([a-z0-9_]+)\\s+does not exist`, 'i');
  const qualifiedMatch = message.match(qualifiedRegex);
  if (qualifiedMatch) {
    return qualifiedMatch[1];
  }

  return null;
}

function getMissingHistoryColumn(error) {
  return getMissingColumnForTable(error, 'history');
}

function isDisplayBatchSlotConstraintError(error, tableName) {
  if (!error) return false;

  const message = String(error.message || '').toLowerCase();
  const details = String(error.details || '').toLowerCase();
  const hint = String(error.hint || '').toLowerCase();
  const constraintName = `${String(tableName || '').toLowerCase()}_display_batch_slot_chk`;
  const mentionsConstraint =
    message.includes(constraintName) || details.includes(constraintName) || hint.includes(constraintName);
  const mentionsColumn =
    message.includes('display_batch_slot') ||
    details.includes('display_batch_slot') ||
    hint.includes('display_batch_slot');

  return mentionsConstraint || (String(error.code || '') === '23514' && mentionsColumn);
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
      if (missingColumn === 'live_stream_links') {
        console.log(
          '⚠️ announcements.live_stream_links column is missing. Run server/supabase/migration_announcement_live_stream_links.sql.'
        );
      }
      removedColumns.add(missingColumn);
      delete writablePayload[missingColumn];
      continue;
    }

    if (
      isDisplayBatchSlotConstraintError(error, 'history') &&
      Object.prototype.hasOwnProperty.call(writablePayload, 'display_batch_slot') &&
      writablePayload.display_batch_slot !== null &&
      !removedColumns.has('display_batch_slot_constraint')
    ) {
      removedColumns.add('display_batch_slot_constraint');
      writablePayload.display_batch_slot = null;
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
      if (missingColumn === 'live_stream_links') {
        console.log(
          '⚠️ announcements.live_stream_links column is missing. Run server/supabase/migration_announcement_live_stream_links.sql.'
        );
      }
      removedColumns.add(missingColumn);
      delete writablePayload[missingColumn];
      continue;
    }

    if (
      isDisplayBatchSlotConstraintError(error, 'announcements') &&
      Object.prototype.hasOwnProperty.call(writablePayload, 'display_batch_slot') &&
      writablePayload.display_batch_slot !== null &&
      !removedColumns.has('display_batch_slot_constraint')
    ) {
      removedColumns.add('display_batch_slot_constraint');
      writablePayload.display_batch_slot = null;
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
      if (missingColumn === 'live_stream_links') {
        console.log(
          '⚠️ history.live_stream_links column is missing. Run server/supabase/migration_announcement_live_stream_links.sql.'
        );
      }
      removedColumns.add(missingColumn);
      delete writablePayload[missingColumn];
      continue;
    }

    if (
      isDisplayBatchSlotConstraintError(error, 'announcements') &&
      Object.prototype.hasOwnProperty.call(writablePayload, 'display_batch_slot') &&
      writablePayload.display_batch_slot !== null &&
      !removedColumns.has('display_batch_slot_constraint')
    ) {
      removedColumns.add('display_batch_slot_constraint');
      writablePayload.display_batch_slot = null;
      continue;
    }

    throwSupabaseError(context, error);
  }
}

async function runLiveStateUpsert(upsertPayload, context) {
  const writablePayload = { ...upsertPayload };
  const removedColumns = new Set();

  while (true) {
    const { data, error } = await supabase
      .from('live_state')
      .upsert(writablePayload, { onConflict: 'id' })
      .select('*')
      .single();

    if (!error) {
      return data;
    }

    if (isMissingTableError(error, 'live_state')) {
      return null;
    }

    const missingColumn = getMissingColumnForTable(error, 'live_state');
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
  const normalizedCategory = String(liveStateFallback.category || '').trim();
  const fallbackLinks = normalizeLiveLinks(liveStateFallback.links);
  return {
    status: liveStateFallback.status || 'OFF',
    link: liveStateFallback.link || null,
    links: fallbackLinks,
    category: normalizedCategory || 'all',
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

async function getAnnouncementsByDisplayBatchId(displayBatchId) {
  const normalizedDisplayBatchId = normalizeDisplayBatchId(displayBatchId);
  if (!normalizedDisplayBatchId) {
    return [];
  }

  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .eq('display_batch_id', normalizedDisplayBatchId)
    .order('created_at', { ascending: true });

  throwSupabaseError('Error reading announcement batch', error);
  return data || [];
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
  const liveStreamLinks = parseStoredLiveLinks(announcementRow.live_stream_links, {
    maxLinks: MAX_ANNOUNCEMENT_LIVE_LINKS
  });

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
        media_width: announcementRow.media_width ?? null,
        media_height: announcementRow.media_height ?? null,
        live_stream_links: liveStreamLinks,
        display_batch_id: normalizeDisplayBatchId(announcementRow.display_batch_id) || null,
        display_batch_slot: parseDisplayBatchSlot(announcementRow.display_batch_slot),
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
    media_width: announcementRow.media_width ?? null,
    media_height: announcementRow.media_height ?? null,
    live_stream_links: liveStreamLinks,
    display_batch_id: normalizeDisplayBatchId(announcementRow.display_batch_id) || null,
    display_batch_slot: parseDisplayBatchSlot(announcementRow.display_batch_slot),
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

  const durationValue = Number.parseInt(details.duration, 10);
  const fileSizeValue = Number.parseInt(details.fileSizeBytes, 10);

  return {
    id: details.id || generateId(),
    title: String(details.title || 'System Event'),
    content: String(details.content || ''),
    priority: normalizePriorityValue(details.priority, 1),
    duration: Number.isNaN(durationValue) ? 0 : durationValue,
    is_active: details.isActive === undefined ? true : Boolean(details.isActive),
    category: details.category || null,
    image: details.image || null,
    type: String(details.type || 'system'),
    file_name: sanitizeOriginalFileName(details.fileName) || null,
    file_mime_type: normalizeUploadedMimeType(details.fileMimeType) || null,
    file_size_bytes: Number.isNaN(fileSizeValue) ? null : Math.max(0, fileSizeValue),
    media_width: parsePositiveInteger(details.mediaWidth),
    media_height: parsePositiveInteger(details.mediaHeight),
    live_stream_links: parseAnnouncementLiveStreamsInput(details.liveStreamLinks),
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

async function runAnnouncementMaintenance(options = {}) {
  const forceRun = Boolean(options && options.force);
  const nowMs = Date.now();

  if (!forceRun && nowMs - lastMaintenanceRunAtMs < ANNOUNCEMENT_MAINTENANCE_MIN_INTERVAL_MS) {
    return {
      skipped: true,
      backfilled: 0,
      archivedExpired: 0,
      deactivatedExpired: 0
    };
  }

  if (maintenanceInFlight) {
    return maintenanceInFlight;
  }

  maintenanceInFlight = (async () => {
    try {
      const backfilled = await backfillMissingCreatedHistory();
      const expired = await archiveExpiredAnnouncements();
      const changed = backfilled > 0 || expired.archived > 0 || expired.deactivated > 0;

      if (changed) {
        invalidateAnnouncementRuntimeCaches();
      }

      if (changed) {
        console.log(
          `🧾 Announcement maintenance: backfilled=${backfilled}, archivedExpired=${expired.archived}, deactivatedExpired=${expired.deactivated}`
        );
      }
      lastMaintenanceRunAtMs = Date.now();
      return {
        skipped: false,
        backfilled,
        archivedExpired: expired.archived,
        deactivatedExpired: expired.deactivated
      };
    } catch (error) {
      console.error('⚠️ Announcement maintenance failed:', error.message);
      return {
        skipped: false,
        backfilled: 0,
        archivedExpired: 0,
        deactivatedExpired: 0,
        error: error.message
      };
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

  const liveState = await runLiveStateUpsert(
    {
      id: LIVE_STATUS_ID,
      status: 'OFF',
      link: null,
      links: [],
      category: null,
      updated_at: new Date().toISOString()
    },
    'Error initializing live status'
  );
  if (!liveState) {
    console.log('⚠️ live_state table not found. Run server/supabase/schema.sql to enable persisted live status.');
  }

  await runAnnouncementMaintenance({ force: true });
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

app.get('/api/uploads/capabilities', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    await ensureStorageBucketReady();
    const directUploadMaxSizeBytes = getDirectUploadMaxSizeBytes();
    const directUploadMaxSizeMb = getDirectUploadMaxSizeMb();

    res.json({
      bucketName: SUPABASE_STORAGE_BUCKET,
      maxFileSizeBytes: directUploadMaxSizeBytes,
      maxFileSizeMb: directUploadMaxSizeMb,
      resumableUploadUrl: SUPABASE_RESUMABLE_UPLOAD_URL
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/uploads/presign', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const fileName = sanitizeOriginalFileName(req.body && req.body.fileName);
    const requestedMimeType = normalizeUploadedMimeType(req.body && req.body.mimeType);
    const mimeType = resolveAttachmentMimeType(requestedMimeType, [fileName]) || 'application/octet-stream';
    const fileSizeBytes = parsePositiveInteger(req.body && req.body.fileSizeBytes);

    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required.' });
    }

    if (!fileSizeBytes) {
      return res.status(400).json({ error: 'fileSizeBytes is required.' });
    }

    const directUploadMaxSizeBytes = getDirectUploadMaxSizeBytes();
    const directUploadMaxSizeMb = getDirectUploadMaxSizeMb();
    if (fileSizeBytes > directUploadMaxSizeBytes) {
      return res.status(413).json({
        error: `File exceeds ${directUploadMaxSizeMb}MB upload limit for direct storage upload.`
      });
    }

    await ensureStorageBucketReady();
    const objectPath = buildStorageObjectPathFromOriginalName(fileName);
    const storageClient = supabase.storage.from(SUPABASE_STORAGE_BUCKET);
    const { data: signedUploadData, error: signedUploadError } =
      await storageClient.createSignedUploadUrl(objectPath, { upsert: false });
    throwSupabaseError('Error creating signed upload URL', signedUploadError);

    const { data: publicUrlData } = storageClient.getPublicUrl(objectPath);
    if (!publicUrlData || !publicUrlData.publicUrl) {
      throw new Error('Error resolving public URL for signed upload.');
    }

    res.status(201).json({
      signedUrl: signedUploadData && signedUploadData.signedUrl ? signedUploadData.signedUrl : null,
      token: signedUploadData && signedUploadData.token ? signedUploadData.token : null,
      objectPath,
      bucketName: SUPABASE_STORAGE_BUCKET,
      resumableUploadUrl: SUPABASE_RESUMABLE_UPLOAD_URL,
      publicUrl: publicUrlData.publicUrl,
      fileName,
      mimeType,
      fileSizeBytes,
      maxFileSizeBytes: directUploadMaxSizeBytes,
      maxFileSizeMb: directUploadMaxSizeMb,
      targetMaxFileSizeBytes: DESIRED_DIRECT_UPLOAD_MAX_SIZE_BYTES,
      targetMaxFileSizeMb: DESIRED_DIRECT_UPLOAD_MAX_SIZE_MB
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/announcements/public', async (req, res) => {
  try {
    const requestedCategory = normalizeCategoryFilter(req.query.category);
    const cacheKey = `public-announcements:${requestedCategory}`;
    const cachedPayload = getRuntimeCachedPayload(cacheKey);
    if (cachedPayload) {
      res.setHeader('Cache-Control', CACHE_CONTROL_SHORT_PUBLIC);
      res.setHeader('X-Runtime-Cache', 'HIT');
      return res.json(cachedPayload);
    }

    await runAnnouncementMaintenance();
    const nowIso = new Date().toISOString();
    let query = supabase
      .from('announcements')
      .select('*')
      .eq('is_active', true)
      .lte('start_at', nowIso)
      .gt('end_at', nowIso);

    if (requestedCategory !== 'all') {
      query = query.or(`category.is.null,category.eq.${requestedCategory},priority.eq.0`);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(MAX_PUBLIC_ANNOUNCEMENTS);

    throwSupabaseError('Error fetching public announcements', error);
    const scopedRows =
      requestedCategory === 'all'
        ? data || []
        : (data || []).filter((row) => isAnnouncementVisibleForDisplayCategory(row, requestedCategory));
    const sortedRows = [...scopedRows].sort(comparePublicAnnouncements);
    const dtoPayload = sortedRows.map(toAnnouncementDto);
    setRuntimeCachedPayload(cacheKey, dtoPayload, API_RUNTIME_CACHE_PUBLIC_ANNOUNCEMENTS_TTL_MS);
    res.setHeader('Cache-Control', CACHE_CONTROL_SHORT_PUBLIC);
    res.setHeader('X-Runtime-Cache', 'MISS');
    res.json(dtoPayload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/announcements', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const cacheKey = 'workspace-announcements';
    const cachedPayload = getRuntimeCachedPayload(cacheKey);
    if (cachedPayload) {
      res.setHeader('X-Runtime-Cache', 'HIT');
      return res.json(cachedPayload);
    }

    await runAnnouncementMaintenance();
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('announcements')
      .select('*')
      .gt('end_at', nowIso)
      .order('created_at', { ascending: false })
      .limit(MAX_WORKSPACE_ANNOUNCEMENTS);

    throwSupabaseError('Error fetching announcements', error);
    const dtoPayload = (data || []).map(toAnnouncementDto);
    setRuntimeCachedPayload(cacheKey, dtoPayload, API_RUNTIME_CACHE_WORKSPACE_ANNOUNCEMENTS_TTL_MS);
    res.setHeader('X-Runtime-Cache', 'MISS');
    res.json(dtoPayload);
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
      endAt,
      mediaWidth,
      mediaHeight,
      displayBatchId,
      displayBatchSlot,
      liveStreamLinks
    } = req.body;
    const normalizedTitle = String(title || '').trim();
    const normalizedContent = String(content || '').trim();
    const normalizedMediaWidth = parsePositiveInteger(mediaWidth);
    const normalizedMediaHeight = parsePositiveInteger(mediaHeight);
    const normalizedDisplayBatchId = normalizeDisplayBatchId(displayBatchId, { strict: true });
    const normalizedDisplayBatchSlot = parseDisplayBatchSlot(displayBatchSlot, { strict: true });
    const normalizedLiveStreamLinks = parseAnnouncementLiveStreamsInput(liveStreamLinks);

    const durationValue = Number.parseInt(duration, 10);
    const safePriority = normalizePriorityValue(priority, 1);
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

    const attachmentInput = parseAttachmentInput(req.body);
    const uploadedFile = mediaFile || documentFile;
    if (uploadedFile && attachmentInput.hasAttachmentInput) {
      return res.status(400).json({
        error: 'Provide either file upload or attachmentUrl metadata, not both.'
      });
    }
    if (attachmentInput.hasAttachmentInput && attachmentInput.attachmentPath) {
      const isReady = await waitForStorageAttachmentAvailability(attachmentInput.attachmentPath);
      if (!isReady) {
        return res.status(409).json({
          error: 'Uploaded attachment is not ready yet. Please retry in a moment.'
        });
      }
    }

    const hasAttachment = Boolean(uploadedFile || attachmentInput.attachmentPath);
    if (!normalizedTitle && !normalizedContent && !hasAttachment && normalizedLiveStreamLinks.length === 0) {
      return res.status(400).json({
        error: 'Add at least one: title, content, stream link, image/video, or document attachment.'
      });
    }

    const uploadResult = uploadedFile ? await uploadAttachmentToStorage(uploadedFile) : null;
    const attachmentPath = uploadResult ? uploadResult.url : attachmentInput.attachmentPath;
    const attachmentMetadata = uploadedFile
      ? getAttachmentMetadata(uploadedFile)
      : attachmentInput.attachmentMetadata;
    const attachmentMimeType = resolveAttachmentMimeType(
      uploadedFile ? uploadedFile.mimetype : attachmentMetadata.file_mime_type,
      [attachmentMetadata.file_name, attachmentPath]
    );
    if (attachmentMimeType) {
      attachmentMetadata.file_mime_type = attachmentMimeType;
    }
    const announcementRow = {
      id: generateId(),
      title: normalizedTitle,
      content: normalizedContent,
      priority: safePriority,
      duration: safeDuration,
      is_active: toBoolean(isActive !== undefined ? isActive : active, true),
      category: category || null,
      image: attachmentPath,
      type: getAnnouncementType(attachmentPath, normalizedContent, attachmentMimeType),
      ...attachmentMetadata,
      media_width: normalizedMediaWidth,
      media_height: normalizedMediaHeight,
      live_stream_links: normalizedLiveStreamLinks,
      display_batch_id: normalizedDisplayBatchId,
      display_batch_slot: normalizedDisplayBatchSlot,
      created_at: new Date().toISOString(),
      start_at: startDate.toISOString(),
      end_at: endDate.toISOString(),
      expires_at: endDate.toISOString()
    };

    const data = await runAnnouncementInsert(announcementRow, 'Error creating announcement');
    await appendHistory(data, 'created', (req.user && req.user.email) || null);
    invalidateAnnouncementRuntimeCaches();

    io.emit('announcementUpdate', {
      action: 'create',
      announcement: toAnnouncementDto(data),
      timestamp: new Date().toISOString()
    });

    console.log(`✅ Created announcement: ${normalizedTitle || uploadedFile?.originalname || data.id}`);
    res.status(201).json(toAnnouncementDto(data));
  } catch (error) {
    console.error('❌ Error creating announcement:', error);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/announcements/batch', simpleAuth, requireWorkspaceRole, async (req, res) => {
  const insertedRows = [];

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
      endAt,
      displayBatchId,
      attachments,
      liveStreamLinks
    } = req.body || {};

    const normalizedTitle = String(title || '').trim();
    const normalizedContent = String(content || '').trim();
    const safePriority = normalizePriorityValue(priority, 1);
    const durationValue = Number.parseInt(duration, 10);
    const safeDuration = Number.isNaN(durationValue) ? 7 : durationValue;
    const normalizedLiveStreamLinks = parseAnnouncementLiveStreamsInput(liveStreamLinks);
    const attachmentList = Array.isArray(attachments) ? attachments : [];

    if (attachmentList.length < 2) {
      return res.status(400).json({
        error: 'Batch announcements require at least 2 attachments.'
      });
    }

    if (attachmentList.length > MAX_DISPLAY_BATCH_SLOT) {
      return res.status(400).json({
        error: `Batch announcement cannot exceed ${MAX_DISPLAY_BATCH_SLOT} attachments.`
      });
    }

    const startDate = toDateOrNull(startAt) || new Date();
    const endDate = endAt
      ? toDateOrNull(endAt)
      : new Date(startDate.getTime() + safeDuration * 24 * 60 * 60 * 1000);
    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      return res.status(400).json({ error: 'Invalid startAt or endAt date' });
    }

    const normalizedDisplayBatchId =
      normalizeDisplayBatchId(displayBatchId, { strict: true }) || createServerDisplayBatchId();
    const createdAtIso = new Date().toISOString();

    for (let index = 0; index < attachmentList.length; index += 1) {
      const attachmentPayload = attachmentList[index] || {};
      const attachmentInput = parseAttachmentInput(attachmentPayload);
      if (!attachmentInput.hasAttachmentInput || !attachmentInput.attachmentPath) {
        return res.status(400).json({
          error: `Attachment ${index + 1} is missing a managed attachmentUrl.`
        });
      }

      const isReady = await waitForStorageAttachmentAvailability(attachmentInput.attachmentPath);
      if (!isReady) {
        return res.status(409).json({
          error: `Attachment ${index + 1} is not ready yet. Please retry in a moment.`
        });
      }

      const normalizedMediaWidth = parsePositiveInteger(attachmentPayload.mediaWidth);
      const normalizedMediaHeight = parsePositiveInteger(attachmentPayload.mediaHeight);
      const attachmentMetadata = {
        ...attachmentInput.attachmentMetadata
      };
      const attachmentMimeType = resolveAttachmentMimeType(attachmentMetadata.file_mime_type, [
        attachmentMetadata.file_name,
        attachmentInput.attachmentPath
      ]);
      if (attachmentMimeType) {
        attachmentMetadata.file_mime_type = attachmentMimeType;
      }

      const announcementRow = {
        id: generateId(),
        title: normalizedTitle,
        content: normalizedContent,
        priority: safePriority,
        duration: safeDuration,
        is_active: toBoolean(isActive !== undefined ? isActive : active, true),
        category: category || null,
        image: attachmentInput.attachmentPath,
        type: getAnnouncementType(attachmentInput.attachmentPath, normalizedContent, attachmentMimeType),
        ...attachmentMetadata,
        media_width: normalizedMediaWidth,
        media_height: normalizedMediaHeight,
        live_stream_links: normalizedLiveStreamLinks,
        display_batch_id: normalizedDisplayBatchId,
        display_batch_slot: index + 1,
        created_at: createdAtIso,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString(),
        expires_at: endDate.toISOString()
      };

      const inserted = await runAnnouncementInsert(
        announcementRow,
        `Error creating announcement batch item ${index + 1}`
      );
      insertedRows.push(inserted);
    }

    for (const row of insertedRows) {
      await appendHistory(row, 'created', (req.user && req.user.email) || null);
    }
    invalidateAnnouncementRuntimeCaches();

    io.emit('announcementUpdate', {
      action: 'batch_create',
      batchId: normalizedDisplayBatchId,
      count: insertedRows.length,
      timestamp: new Date().toISOString()
    });

    res.status(201).json({
      batchId: normalizedDisplayBatchId,
      count: insertedRows.length,
      announcements: insertedRows.map(toAnnouncementDto)
    });
  } catch (error) {
    if (insertedRows.length > 0) {
      await Promise.all(
        insertedRows.map(async (row) => {
          try {
            await removeAttachmentReference(row.image);
          } catch (cleanupError) {
            console.log('Note: Could not delete attachment during batch rollback:', cleanupError.message);
          }
          try {
            const { error: deleteError } = await supabase.from('announcements').delete().eq('id', row.id);
            if (deleteError) {
              throw deleteError;
            }
          } catch (cleanupError) {
            console.log('Note: Could not rollback announcement row during batch failure:', cleanupError.message);
          }
        })
      );
    }

    console.error('❌ Error creating announcement batch:', error);
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

    const mutationScope = normalizeAnnouncementMutationScope(req.query && req.query.scope);

    const {
      title,
      content,
      priority,
      duration,
      isActive,
      active,
      category,
      startAt,
      endAt,
      mediaWidth,
      mediaHeight,
      displayBatchId,
      displayBatchSlot,
      removeAttachment,
      liveStreamLinks
    } = req.body;
    const hasTitleField = Object.prototype.hasOwnProperty.call(req.body || {}, 'title');
    const hasContentField = Object.prototype.hasOwnProperty.call(req.body || {}, 'content');
    const hasMediaWidthField = Object.prototype.hasOwnProperty.call(req.body || {}, 'mediaWidth');
    const hasMediaHeightField = Object.prototype.hasOwnProperty.call(req.body || {}, 'mediaHeight');
    const hasDisplayBatchIdField = Object.prototype.hasOwnProperty.call(req.body || {}, 'displayBatchId');
    const hasDisplayBatchSlotField = Object.prototype.hasOwnProperty.call(req.body || {}, 'displayBatchSlot');
    const hasRemoveAttachmentField = Object.prototype.hasOwnProperty.call(req.body || {}, 'removeAttachment');
    const hasLiveStreamLinksField = Object.prototype.hasOwnProperty.call(req.body || {}, 'liveStreamLinks');
    const normalizedTitle = hasTitleField ? String(title || '').trim() : null;
    const normalizedContent = hasContentField ? String(content || '').trim() : null;
    const normalizedMediaWidth = hasMediaWidthField ? parsePositiveInteger(mediaWidth) : null;
    const normalizedMediaHeight = hasMediaHeightField ? parsePositiveInteger(mediaHeight) : null;
    const normalizedDisplayBatchId = hasDisplayBatchIdField
      ? normalizeDisplayBatchId(displayBatchId, { strict: true })
      : null;
    const normalizedDisplayBatchSlot = hasDisplayBatchSlotField
      ? parseDisplayBatchSlot(displayBatchSlot, { strict: true })
      : null;
    const removeAttachmentRequested = hasRemoveAttachmentField ? toBoolean(removeAttachment, false) : false;
    const normalizedLiveStreamLinks = hasLiveStreamLinksField
      ? parseAnnouncementLiveStreamsInput(liveStreamLinks)
      : null;

    const { mediaFile, documentFile } = getUploadedAttachment(req);
    if (mediaFile && documentFile) {
      return res.status(400).json({ error: 'Upload either media or document, not both at once.' });
    }

    const attachmentInput = parseAttachmentInput(req.body);
    const uploadedFile = mediaFile || documentFile;
    if (uploadedFile && attachmentInput.hasAttachmentInput) {
      return res.status(400).json({
        error: 'Provide either file upload or attachmentUrl metadata, not both.'
      });
    }
    if (removeAttachmentRequested && (uploadedFile || attachmentInput.hasAttachmentInput)) {
      return res.status(400).json({
        error: 'Choose either attachment replacement or attachment removal, not both.'
      });
    }
    if (mutationScope === 'batch') {
      const existingBatchId = normalizeDisplayBatchId(existing.display_batch_id);
      if (!existingBatchId) {
        return res.status(400).json({
          error: 'This announcement is not part of a batch.'
        });
      }
      if (uploadedFile || attachmentInput.hasAttachmentInput) {
        return res.status(400).json({
          error:
            'Batch update does not support replacing attachments. Edit a single file to replace media/document.'
        });
      }
      if (removeAttachmentRequested) {
        return res.status(400).json({
          error: 'Batch update does not support removing attachments. Edit a single file instead.'
        });
      }
      if (hasDisplayBatchIdField || hasDisplayBatchSlotField) {
        return res.status(400).json({
          error: 'Batch identity/slot cannot be changed during batch update.'
        });
      }

      const batchRows = await getAnnouncementsByDisplayBatchId(existingBatchId);
      if (!batchRows || batchRows.length === 0) {
        return res.status(404).json({ error: 'Announcement batch not found.' });
      }
      if (batchRows.some((row) => isAnnouncementExpired(row))) {
        return res.status(410).json({
          error: 'This batch contains expired announcements and can no longer be modified together.'
        });
      }

      const anchorRow = batchRows.find((row) => row.id === existing.id) || batchRows[0];
      const prevStart = toDateOrNull(anchorRow.start_at) || new Date();
      const prevEnd = toDateOrNull(anchorRow.end_at) || new Date();
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

      const nextTitle = hasTitleField ? normalizedTitle : String(anchorRow.title || '').trim();
      const nextContent = hasContentField ? normalizedContent : String(anchorRow.content || '').trim();
      const hasAnyAttachmentInBatch = batchRows.some((row) => Boolean(row.image));
      const nextLiveStreamLinks = hasLiveStreamLinksField
        ? normalizedLiveStreamLinks
        : parseStoredLiveLinks(anchorRow.live_stream_links, {
            maxLinks: MAX_ANNOUNCEMENT_LIVE_LINKS
          });
      if (!nextTitle && !nextContent && !hasAnyAttachmentInBatch && nextLiveStreamLinks.length === 0) {
        return res.status(400).json({
          error: 'Add at least one: title, content, stream link, image/video, or document attachment.'
        });
      }

      const batchUpdateRow = {
        start_at: newStart.toISOString(),
        end_at: newEnd.toISOString(),
        expires_at: newEnd.toISOString(),
        updated_at: new Date().toISOString()
      };

      if (hasTitleField) batchUpdateRow.title = normalizedTitle;
      if (hasContentField) batchUpdateRow.content = normalizedContent;
      if (priority !== undefined && priority !== null && String(priority).trim() !== '') {
        batchUpdateRow.priority = normalizePriorityValue(priority, anchorRow.priority);
      }
      if (duration && safeDuration !== null) {
        batchUpdateRow.duration = safeDuration;
      }
      if (isActive !== undefined || active !== undefined) {
        batchUpdateRow.is_active = toBoolean(
          isActive !== undefined ? isActive : active,
          anchorRow.is_active
        );
      }
      if (category !== undefined) {
        batchUpdateRow.category = category || null;
      }
      if (hasLiveStreamLinksField) {
        batchUpdateRow.live_stream_links = normalizedLiveStreamLinks;
      }

      const updatedRows = await runAnnouncementUpdate(
        batchUpdateRow,
        (query) => query.eq('display_batch_id', existingBatchId).select('*'),
        'Error updating announcement batch'
      );

      for (const row of updatedRows || []) {
        await appendHistory(row, 'updated', (req.user && req.user.email) || null);
      }
      invalidateAnnouncementRuntimeCaches();

      io.emit('announcementUpdate', {
        action: 'batch_update',
        batchId: existingBatchId,
        count: (updatedRows || []).length,
        timestamp: new Date().toISOString()
      });

      return res.json({
        scope: 'batch',
        batchId: existingBatchId,
        count: (updatedRows || []).length,
        announcements: (updatedRows || []).map(toAnnouncementDto)
      });
    }

    if (attachmentInput.hasAttachmentInput && attachmentInput.attachmentPath) {
      const isReady = await waitForStorageAttachmentAvailability(attachmentInput.attachmentPath);
      if (!isReady) {
        return res.status(409).json({
          error: 'Uploaded attachment is not ready yet. Please retry in a moment.'
        });
      }
    }

    const uploadResult = uploadedFile ? await uploadAttachmentToStorage(uploadedFile) : null;
    const attachmentPath = uploadResult
      ? uploadResult.url
      : attachmentInput.hasAttachmentInput
        ? attachmentInput.attachmentPath
        : removeAttachmentRequested
          ? null
        : existing.image;
    const hasIncomingAttachment = Boolean(uploadResult || attachmentInput.hasAttachmentInput);
    const hasAttachmentRemoval = removeAttachmentRequested && Boolean(existing.image);
    const existingFileSize = Number.parseInt(existing.file_size_bytes, 10);
    const existingMediaWidth = parsePositiveInteger(existing.media_width);
    const existingMediaHeight = parsePositiveInteger(existing.media_height);
    const attachmentMetadata = uploadedFile
      ? getAttachmentMetadata(uploadedFile)
      : attachmentInput.hasAttachmentInput
        ? attachmentInput.attachmentMetadata
        : hasAttachmentRemoval
          ? {
              file_name: null,
              file_mime_type: null,
              file_size_bytes: null
            }
      : {
          file_name: existing.file_name || null,
          file_mime_type: existing.file_mime_type || null,
          file_size_bytes: Number.isNaN(existingFileSize) ? null : existingFileSize
        };
    if ((hasIncomingAttachment || hasAttachmentRemoval) && existing.image && existing.image !== attachmentPath) {
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

    const nextTitle = hasTitleField ? normalizedTitle : String(existing.title || '').trim();
    const nextContent = hasContentField ? normalizedContent : String(existing.content || '').trim();
    const nextLiveStreamLinks = hasLiveStreamLinksField
      ? normalizedLiveStreamLinks
      : parseStoredLiveLinks(existing.live_stream_links, {
          maxLinks: MAX_ANNOUNCEMENT_LIVE_LINKS
        });
    if (!nextTitle && !nextContent && !attachmentPath && nextLiveStreamLinks.length === 0) {
      return res.status(400).json({
        error: 'Add at least one: title, content, stream link, image/video, or document attachment.'
      });
    }

    const effectiveContent = nextContent;
    const attachmentMimeType = resolveAttachmentMimeType(
      uploadedFile ? uploadedFile.mimetype : attachmentMetadata.file_mime_type,
      [attachmentMetadata.file_name, attachmentPath]
    );
    if (attachmentMimeType) {
      attachmentMetadata.file_mime_type = attachmentMimeType;
    }
    const updateRow = {
      image: attachmentPath,
      type: getAnnouncementType(attachmentPath, effectiveContent, attachmentMimeType),
      ...attachmentMetadata,
      media_width: hasIncomingAttachment ? normalizedMediaWidth : hasAttachmentRemoval ? null : existingMediaWidth,
      media_height: hasIncomingAttachment ? normalizedMediaHeight : hasAttachmentRemoval ? null : existingMediaHeight,
      live_stream_links: nextLiveStreamLinks,
      display_batch_id: normalizeDisplayBatchId(existing.display_batch_id) || null,
      display_batch_slot: parseDisplayBatchSlot(existing.display_batch_slot),
      start_at: newStart.toISOString(),
      end_at: newEnd.toISOString(),
      expires_at: newEnd.toISOString(),
      updated_at: new Date().toISOString()
    };

    if (hasTitleField) updateRow.title = normalizedTitle;
    if (hasContentField) updateRow.content = normalizedContent;
    if (hasMediaWidthField) updateRow.media_width = normalizedMediaWidth;
    if (hasMediaHeightField) updateRow.media_height = normalizedMediaHeight;
    if (hasDisplayBatchIdField) updateRow.display_batch_id = normalizedDisplayBatchId;
    if (hasDisplayBatchSlotField) updateRow.display_batch_slot = normalizedDisplayBatchSlot;
    if (priority !== undefined && priority !== null && String(priority).trim() !== '') {
      updateRow.priority = normalizePriorityValue(priority, existing.priority);
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
    invalidateAnnouncementRuntimeCaches();

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
    const mutationScope = normalizeAnnouncementMutationScope(req.query && req.query.scope);
    if (mutationScope === 'batch') {
      const existingBatchId = normalizeDisplayBatchId(existing.display_batch_id);
      if (!existingBatchId) {
        return res.status(400).json({
          error: 'This announcement is not part of a batch.'
        });
      }

      const batchRows = await getAnnouncementsByDisplayBatchId(existingBatchId);
      if (!batchRows || batchRows.length === 0) {
        return res.status(404).json({ error: 'Announcement batch not found.' });
      }
      if (batchRows.some((row) => isAnnouncementExpired(row))) {
        return res.status(410).json({
          error: 'This batch contains expired announcements and can no longer be deleted together.'
        });
      }

      for (const row of batchRows) {
        await removeAttachmentReference(row.image);
        await appendHistory(row, 'deleted', (req.user && req.user.email) || null);
      }

      const { error: batchDeleteError } = await supabase
        .from('announcements')
        .delete()
        .eq('display_batch_id', existingBatchId);
      throwSupabaseError('Error deleting announcement batch', batchDeleteError);
      invalidateAnnouncementRuntimeCaches();

      io.emit('announcementUpdate', {
        action: 'batch_delete',
        batchId: existingBatchId,
        count: batchRows.length,
        timestamp: new Date().toISOString()
      });

      console.log(`✅ Deleted announcement batch: ${existingBatchId} (${batchRows.length} items)`);
      return res.json({
        message: 'Announcement batch deleted successfully',
        batchId: existingBatchId,
        count: batchRows.length
      });
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
    invalidateAnnouncementRuntimeCaches();

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
    const cacheKey = 'live-status';
    const cachedPayload = getRuntimeCachedPayload(cacheKey);
    if (cachedPayload) {
      res.setHeader('Cache-Control', CACHE_CONTROL_SHORT_PUBLIC);
      res.setHeader('X-Runtime-Cache', 'HIT');
      return res.json(cachedPayload);
    }

    const live = await getLiveState();
    res.setHeader('Cache-Control', CACHE_CONTROL_SHORT_PUBLIC);
    if (!live) {
      const fallbackPayload = getFallbackLiveDto();
      setRuntimeCachedPayload(cacheKey, fallbackPayload, API_RUNTIME_CACHE_STATUS_TTL_MS);
      res.setHeader('X-Runtime-Cache', 'MISS');
      return res.json(fallbackPayload);
    }
    const dtoPayload = toLiveDto(live);
    setRuntimeCachedPayload(cacheKey, dtoPayload, API_RUNTIME_CACHE_STATUS_TTL_MS);
    res.setHeader('X-Runtime-Cache', 'MISS');
    res.json(dtoPayload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const cacheKey = 'categories';
    const cachedPayload = getRuntimeCachedPayload(cacheKey);
    if (cachedPayload) {
      res.setHeader('Cache-Control', CACHE_CONTROL_CATEGORIES_PUBLIC);
      res.setHeader('X-Runtime-Cache', 'HIT');
      return res.json(cachedPayload);
    }

    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .order('created_at', { ascending: true });

    throwSupabaseError('Error fetching categories', error);
    const dtoPayload = (data || []).map(toCategoryDto);
    setRuntimeCachedPayload(cacheKey, dtoPayload, API_RUNTIME_CACHE_CATEGORIES_TTL_MS);
    res.setHeader('Cache-Control', CACHE_CONTROL_CATEGORIES_PUBLIC);
    res.setHeader('X-Runtime-Cache', 'MISS');
    res.json(dtoPayload);
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

    invalidateCategoriesRuntimeCache();
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

    invalidateCategoriesRuntimeCache();
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
    const liveLinks = parseLiveLinksInput(req.body && req.body.link, req.body && req.body.links);
    const link = liveLinks[0] || null;
    const categoryInput = String((req.body && req.body.category) || '').trim();
    if (!link) {
      return res
        .status(400)
        .json({ error: 'At least one supported live link is required (YouTube, Vimeo, or Twitch).' });
    }

    const isGlobalLive = !categoryInput || categoryInput.toLowerCase() === 'all';
    let liveCategoryId = null;
    let liveCategoryLabel = 'All categories (global)';
    if (!isGlobalLive) {
      const matchedCategory = await findCategoryByInput(categoryInput, 'Error validating live category');
      if (!matchedCategory) {
        return res.status(400).json({ error: 'Selected live category does not exist.' });
      }
      liveCategoryId = matchedCategory.id;
      liveCategoryLabel = matchedCategory.name || matchedCategory.id;
    }

    const persistedLink = encodeLiveLinkMetadata(link, liveCategoryId, liveLinks);
    const now = new Date().toISOString();
    const liveRow = {
      id: LIVE_STATUS_ID,
      status: 'ON',
      link: persistedLink,
      links: liveLinks,
      category: liveCategoryId,
      started_at: now,
      stopped_at: null,
      updated_at: now
    };

    const data = await runLiveStateUpsert(liveRow, 'Error starting live');
    liveStateFallback.status = 'ON';
    liveStateFallback.link = link;
    liveStateFallback.links = liveLinks;
    liveStateFallback.category = liveCategoryId;
    liveStateFallback.startedAt = now;
    liveStateFallback.stoppedAt = null;

    const streamLabel =
      liveLinks.length > 1
        ? `links: ${liveLinks.join(', ')}`
        : `link: ${link}`;
    let warning = '';
    try {
      await appendSystemHistory('live_started', (req.user && req.user.email) || null, {
        title: 'Live Broadcast Started',
        content: `Live stream started for ${liveCategoryLabel} with ${streamLabel}`,
        type: 'system_live',
        actionAt: now
      });
    } catch (historyError) {
      warning = 'Live stream started, but activity log could not be saved.';
      console.error('⚠️ Live start history logging failed:', historyError.message);
    }

    const payload = data ? toLiveDto(data) : getFallbackLiveDto();
    if (warning) {
      payload.warning = warning;
    }
    invalidateLiveRuntimeCache();
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
      links: [],
      category: null,
      stopped_at: now,
      updated_at: now
    };

    const data = await runLiveStateUpsert(liveRow, 'Error stopping live');
    liveStateFallback.status = 'OFF';
    liveStateFallback.link = null;
    liveStateFallback.links = [];
    liveStateFallback.category = null;
    liveStateFallback.stoppedAt = now;

    let warning = '';
    try {
      await appendSystemHistory('live_stopped', (req.user && req.user.email) || null, {
        title: 'Live Broadcast Stopped',
        content: 'Live stream was stopped.',
        type: 'system_live',
        actionAt: now
      });
    } catch (historyError) {
      warning = 'Live stream stopped, but activity log could not be saved.';
      console.error('⚠️ Live stop history logging failed:', historyError.message);
    }

    const payload = data ? toLiveDto(data) : getFallbackLiveDto();
    if (warning) {
      payload.warning = warning;
    }
    invalidateLiveRuntimeCache();
    io.emit('liveUpdate', payload);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function readMaintenanceAgentStatus() {
  try {
    const raw = await fs.readFile(MAINTENANCE_AGENT_STATUS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function readRuntimeJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeRuntimeJsonFile(filePath, payload) {
  const normalizedPayload = payload && typeof payload === 'object' ? payload : {};
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempFilePath = `${filePath}.tmp`;
  await fs.writeFile(tempFilePath, `${JSON.stringify(normalizedPayload, null, 2)}\n`, 'utf8');
  await fs.rename(tempFilePath, filePath);
}

function cloneJsonValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

async function getOpsAgentControlSettings() {
  const storedSettings = (await readRuntimeJsonFile(OPS_AGENT_SETTINGS_PATH)) || {};
  const requestedAutoFixEnabled =
    storedSettings.autoFixEnabled === undefined
      ? OPS_AGENT_DEFAULT_AUTOFIX_ENABLED
      : Boolean(storedSettings.autoFixEnabled);

  return {
    requestedAutoFixEnabled,
    autoFixEnabled: requestedAutoFixEnabled && !IS_SERVERLESS_RUNTIME,
    environmentDefaultAutoFixEnabled: OPS_AGENT_DEFAULT_AUTOFIX_ENABLED,
    intervalMs: IS_SERVERLESS_RUNTIME ? null : OPS_AGENT_INTERVAL_MS,
    cooldownMs: OPS_AGENT_COOLDOWN_MS,
    actionTimeoutMs: OPS_AGENT_ACTION_TIMEOUT_MS,
    serverless: IS_SERVERLESS_RUNTIME,
    controlledFrom: 'admin-workspace'
  };
}

async function updateOpsAgentControlSettings(patch = {}) {
  const currentSettings = await getOpsAgentControlSettings();
  const nextRequestedAutoFixEnabled =
    patch.autoFixEnabled === undefined
      ? currentSettings.requestedAutoFixEnabled
      : Boolean(patch.autoFixEnabled);

  await writeRuntimeJsonFile(OPS_AGENT_SETTINGS_PATH, {
    autoFixEnabled: nextRequestedAutoFixEnabled,
    updatedAt: new Date().toISOString()
  });

  invalidatePlatformStatusCache();
  return getOpsAgentControlSettings();
}

async function appendOpsAgentEvent(action, details = {}) {
  const actionAt = details.actionAt || new Date().toISOString();
  const safeDetails =
    details.details === null || details.details === undefined
      ? ''
      : typeof details.details === 'string'
        ? details.details
        : JSON.stringify(details.details, null, 2);
  const contentParts = [String(details.content || '').trim(), safeDetails.trim()].filter(Boolean);

  try {
    await appendSystemHistory(action, details.userEmail || null, {
      title: details.title || 'AI Ops Agent Event',
      content: contentParts.join('\n\n'),
      type: details.type || 'system_ops',
      actionAt
    });
  } catch (error) {
    console.error('⚠️ Ops agent event logging failed:', error.message || String(error));
  }
}

function toOpsAgentHistoryDto(row) {
  const rawType = String(row?.type || '').trim();
  const inferredType = rawType
    ? rawType
    : /failed/i.test(String(row?.title || ''))
      ? 'system_ops_error'
      : /completed|succeeded/i.test(String(row?.title || ''))
        ? 'system_ops_success'
        : 'system_ops';
  return {
    id: row?.row_id || row?.id || randomUUID(),
    action: String(row?.action || '').trim(),
    title: String(row?.title || 'AI Ops Agent Event').trim(),
    content: String(row?.content || '').trim(),
    type: inferredType,
    userEmail: String(row?.user_email || 'System').trim(),
    createdAt: row?.action_at || row?.updated_at || row?.created_at || null
  };
}

async function getOpsAgentHistory(limit = 12) {
  const safeLimit = Math.min(40, Math.max(1, Number.parseInt(limit, 10) || 12));
  const buildBaseQuery = () =>
    supabase
      .from('history')
      .select('*')
      .in('action', OPS_AGENT_HISTORY_ACTIONS)
      .order('action_at', { ascending: false })
      .limit(safeLimit);

  let { data, error } = await buildBaseQuery().in('type', OPS_AGENT_HISTORY_TYPES);
  if (error && getMissingColumnForTable(error, 'history') === 'type') {
    ({ data, error } = await buildBaseQuery());
  }

  throwSupabaseError('Error loading ops agent history', error);
  return (data || []).map(toOpsAgentHistoryDto);
}

function getRuntimeCachedPayload(cacheKey) {
  if (!API_RUNTIME_CACHE_ENABLED) {
    return null;
  }
  const entry = runtimeApiResponseCache.get(cacheKey);
  if (!entry) {
    runtimeApiCacheStats.misses += 1;
    return null;
  }
  if (Date.now() > entry.expiresAtMs) {
    runtimeApiResponseCache.delete(cacheKey);
    runtimeApiCacheStats.misses += 1;
    return null;
  }
  runtimeApiCacheStats.hits += 1;
  return cloneJsonValue(entry.payload);
}

function setRuntimeCachedPayload(cacheKey, payload, ttlMs) {
  if (!API_RUNTIME_CACHE_ENABLED) {
    return;
  }
  const safeTtlMs = Math.max(500, Number.parseInt(ttlMs, 10) || 1000);
  runtimeApiResponseCache.set(cacheKey, {
    payload: cloneJsonValue(payload),
    expiresAtMs: Date.now() + safeTtlMs
  });
  runtimeApiCacheStats.sets += 1;
}

function invalidatePlatformStatusCache() {
  platformStatusCacheState.payload = null;
  platformStatusCacheState.updatedAtMs = 0;
}

function invalidateRuntimeCachedPayload(prefix = '') {
  const normalizedPrefix = String(prefix || '').trim();
  let invalidatedCount = 0;
  for (const cacheKey of runtimeApiResponseCache.keys()) {
    if (!normalizedPrefix || cacheKey.startsWith(normalizedPrefix)) {
      runtimeApiResponseCache.delete(cacheKey);
      invalidatedCount += 1;
    }
  }
  if (invalidatedCount > 0) {
    runtimeApiCacheStats.invalidations += invalidatedCount;
    runtimeApiCacheStats.lastInvalidateAt = new Date().toISOString();
    invalidatePlatformStatusCache();
  }
  return invalidatedCount;
}

function invalidateAnnouncementRuntimeCaches() {
  invalidateRuntimeCachedPayload('public-announcements:');
  invalidateRuntimeCachedPayload('workspace-announcements');
  invalidatePlatformStatusCache();
}

function invalidateCategoriesRuntimeCache() {
  invalidateRuntimeCachedPayload('categories');
  invalidatePlatformStatusCache();
}

function invalidateLiveRuntimeCache() {
  invalidateRuntimeCachedPayload('live-status');
  invalidatePlatformStatusCache();
}

function getRuntimeCacheStatsSnapshot() {
  return {
    enabled: API_RUNTIME_CACHE_ENABLED,
    keys: runtimeApiResponseCache.size,
    ...runtimeApiCacheStats
  };
}

function getMaintenanceAgentUpdatedAt(agentStatus) {
  const updatedAt = String(agentStatus?.updatedAt || '').trim();
  return updatedAt || null;
}

function isMaintenanceAgentStatusStale(agentStatus) {
  const updatedAt = getMaintenanceAgentUpdatedAt(agentStatus);
  if (!updatedAt) return true;
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return true;
  return Date.now() - updatedAtMs > MAINTENANCE_AGENT_STALE_MS;
}

async function probeUrlWithTimeout(url, timeoutMs) {
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });
    return {
      ok: response.ok,
      statusCode: response.status,
      latencyMs: Date.now() - startedAtMs,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      latencyMs: Date.now() - startedAtMs,
      error: error.message || 'Request failed'
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function requestJsonWithTimeout(
  url,
  { method = 'GET', timeoutMs = MAINTENANCE_AGENT_PROBE_TIMEOUT_MS, headers = {}, body = null } = {}
) {
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...headers
      },
      body
    });
    const rawText = await response.text().catch(() => '');
    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = null;
      }
    }
    return {
      ok: response.ok,
      statusCode: response.status,
      latencyMs: Date.now() - startedAtMs,
      payload,
      error: response.ok ? null : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      latencyMs: Date.now() - startedAtMs,
      payload: null,
      error: error.message || 'Request failed'
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchJsonWithTimeout(url, options = {}) {
  return requestJsonWithTimeout(url, { ...options, method: 'GET' });
}

function buildBearerAuthHeaders(token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    return {};
  }
  return {
    Authorization: `Bearer ${normalizedToken}`
  };
}

function normalizeGithubRepoValue(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

async function probeGithubPlatform() {
  const repo = normalizeGithubRepoValue(GITHUB_REPO);
  if (!repo || !repo.includes('/')) {
    return {
      enabled: false,
      configured: false,
      status: 'not_configured',
      message: 'Set GITHUB_REPO=owner/repo to enable GitHub diagnostics.'
    };
  }

  const apiUrl = `${GITHUB_API_BASE_URL.replace(/\/+$/, '')}/repos/${repo}`;
  const response = await fetchJsonWithTimeout(apiUrl, {
    timeoutMs: MAINTENANCE_AGENT_PROBE_TIMEOUT_MS,
    headers: buildBearerAuthHeaders(GITHUB_TOKEN)
  });

  if (!response.ok) {
    return {
      enabled: true,
      configured: true,
      status: 'degraded',
      message: response.error || 'GitHub diagnostics failed.',
      latencyMs: response.latencyMs,
      statusCode: response.statusCode
    };
  }

  const payload = response.payload || {};
  return {
    enabled: true,
    configured: true,
    status: 'ok',
    message: `Connected to ${repo}.`,
    latencyMs: response.latencyMs,
    statusCode: response.statusCode,
    repo,
    defaultBranch: payload.default_branch || null,
    pushedAt: payload.pushed_at || null,
    visibility: payload.visibility || (payload.private ? 'private' : 'public')
  };
}

async function probeVercelPlatform() {
  if (!VERCEL_API_TOKEN || !VERCEL_PROJECT_ID) {
    return {
      enabled: false,
      configured: false,
      status: 'not_configured',
      message: 'Set VERCEL_TOKEN and VERCEL_PROJECT_ID to enable Vercel diagnostics.'
    };
  }

  const baseUrl = VERCEL_API_BASE_URL.replace(/\/+$/, '');
  const teamQuery = VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}` : '';
  const projectUrl = `${baseUrl}/v9/projects/${encodeURIComponent(VERCEL_PROJECT_ID)}${teamQuery}`;
  const deploymentsUrl = `${baseUrl}/v6/deployments?projectId=${encodeURIComponent(VERCEL_PROJECT_ID)}&limit=1${
    VERCEL_TEAM_ID ? `&teamId=${encodeURIComponent(VERCEL_TEAM_ID)}` : ''
  }`;

  const [projectResponse, deploymentResponse] = await Promise.all([
    fetchJsonWithTimeout(projectUrl, {
      timeoutMs: MAINTENANCE_AGENT_PROBE_TIMEOUT_MS,
      headers: buildBearerAuthHeaders(VERCEL_API_TOKEN)
    }),
    fetchJsonWithTimeout(deploymentsUrl, {
      timeoutMs: MAINTENANCE_AGENT_PROBE_TIMEOUT_MS,
      headers: buildBearerAuthHeaders(VERCEL_API_TOKEN)
    })
  ]);

  if (!projectResponse.ok) {
    return {
      enabled: true,
      configured: true,
      status: 'degraded',
      message: projectResponse.error || 'Vercel project diagnostics failed.',
      latencyMs: projectResponse.latencyMs,
      statusCode: projectResponse.statusCode
    };
  }

  const projectPayload = projectResponse.payload || {};
  const deploymentPayload = deploymentResponse.payload || {};
  const latestDeployment =
    Array.isArray(deploymentPayload.deployments) && deploymentPayload.deployments.length > 0
      ? deploymentPayload.deployments[0]
      : null;
  const deploymentState = String(latestDeployment?.state || '').trim().toLowerCase();
  const status =
    deploymentResponse.ok && (deploymentState === 'ready' || deploymentState === '')
      ? 'ok'
      : deploymentResponse.ok
        ? 'degraded'
        : 'degraded';

  return {
    enabled: true,
    configured: true,
    status,
    message:
      status === 'ok'
        ? 'Vercel project and latest deployment are healthy.'
        : deploymentResponse.error || 'Vercel deployment diagnostics detected an issue.',
    latencyMs: Math.max(projectResponse.latencyMs || 0, deploymentResponse.latencyMs || 0),
    statusCode: projectResponse.statusCode,
    projectName: projectPayload.name || null,
    latestDeploymentState: deploymentState || null,
    latestDeploymentCreatedAt: latestDeployment?.createdAt
      ? (() => {
          const numericCreatedAt = Number(latestDeployment.createdAt);
          if (Number.isFinite(numericCreatedAt) && numericCreatedAt > 0) {
            return new Date(numericCreatedAt).toISOString();
          }
          return toIsoStringOrNull(latestDeployment.createdAt);
        })()
      : null,
    latestDeploymentUrl: latestDeployment?.url ? `https://${latestDeployment.url}` : null
  };
}

async function probeSupabasePlatform() {
  const startedAtMs = Date.now();
  try {
    const [dbProbe, bucketProbe] = await Promise.all([
      supabase.from('users').select('id').limit(1),
      supabase.storage.listBuckets()
    ]);
    const dbError = dbProbe.error;
    if (dbError && !isMissingTableError(dbError, 'users')) {
      throwSupabaseError('Supabase diagnostics database probe failed', dbError);
    }
    const bucketError = bucketProbe.error;
    if (bucketError) {
      throw new Error(`Storage check failed: ${bucketError.message}`);
    }
    const buckets = Array.isArray(bucketProbe.data) ? bucketProbe.data : [];
    const storageBucketFound = buckets.some((bucket) => bucket && bucket.name === SUPABASE_STORAGE_BUCKET);
    return {
      enabled: true,
      configured: true,
      status: dbError ? 'degraded' : storageBucketFound ? 'ok' : 'degraded',
      message: dbError
        ? 'Supabase is reachable, but required database table metadata is degraded.'
        : storageBucketFound
          ? 'Supabase database and storage are healthy.'
          : `Supabase storage bucket "${SUPABASE_STORAGE_BUCKET}" is missing.`,
      latencyMs: Date.now() - startedAtMs,
      database: dbError ? 'degraded' : 'ok',
      storageBucket: SUPABASE_STORAGE_BUCKET,
      storageBucketFound
    };
  } catch (error) {
    return {
      enabled: true,
      configured: true,
      status: 'degraded',
      message: error.message || 'Supabase diagnostics failed.',
      latencyMs: Date.now() - startedAtMs,
      database: 'degraded',
      storageBucket: SUPABASE_STORAGE_BUCKET,
      storageBucketFound: false
    };
  }
}

function derivePlatformSummaryState(integrationStates = []) {
  const states = integrationStates
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  if (states.length === 0) return 'unknown';
  if (states.includes('degraded') || states.includes('not_configured')) return 'degraded';
  if (states.includes('ok')) return 'ok';
  return 'unknown';
}

async function buildPlatformStatusPayload() {
  const [maintenanceAgentResolution, github, vercel, supabaseStatus] = await Promise.all([
    resolveMaintenanceAgentStatus({ includeNetworkProbe: false }),
    probeGithubPlatform(),
    probeVercelPlatform(),
    probeSupabasePlatform()
  ]);
  const maintenanceSummary = buildMaintenanceAgentSummary(maintenanceAgentResolution.agentStatus);
  const integrations = {
    github,
    vercel,
    supabase: supabaseStatus
  };
  const summaryState = derivePlatformSummaryState([
    maintenanceSummary.state,
    github.status,
    vercel.status,
    supabaseStatus.status
  ]);

  return {
    updatedAt: new Date().toISOString(),
    summary: {
      state: summaryState,
      message:
        summaryState === 'ok'
          ? 'Platform diagnostics are healthy.'
          : 'One or more platform diagnostics are degraded or not configured.'
    },
    maintenanceAgent: maintenanceSummary,
    cache: getRuntimeCacheStatsSnapshot(),
    integrations
  };
}

async function getPlatformStatusPayload() {
  const nowMs = Date.now();
  if (
    platformStatusCacheState.payload &&
    nowMs - platformStatusCacheState.updatedAtMs <= PLATFORM_STATUS_CACHE_MS
  ) {
    return cloneJsonValue(platformStatusCacheState.payload);
  }

  if (platformStatusCacheState.inFlight) {
    return platformStatusCacheState.inFlight;
  }

  platformStatusCacheState.inFlight = (async () => {
    try {
      const payload = await buildPlatformStatusPayload();
      platformStatusCacheState.payload = payload;
      platformStatusCacheState.updatedAtMs = Date.now();
      return cloneJsonValue(payload);
    } finally {
      platformStatusCacheState.inFlight = null;
    }
  })();

  return platformStatusCacheState.inFlight;
}

function getServerNpmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function runServerScript(scriptName) {
  if (IS_SERVERLESS_RUNTIME) {
    return {
      ok: false,
      code: null,
      output: '',
      message: 'Local server scripts are unavailable in serverless runtime.'
    };
  }

  return new Promise((resolve) => {
    const child = spawn(getServerNpmExecutable(), ['run', scriptName], {
      cwd: __dirname,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const outputChunks = [];
    const pushChunk = (value) => {
      const normalized = String(value || '').trim();
      if (normalized) {
        outputChunks.push(normalized);
      }
    };

    child.stdout.on('data', (chunk) => pushChunk(chunk));
    child.stderr.on('data', (chunk) => pushChunk(chunk));

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
    }, OPS_AGENT_ACTION_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timeoutHandle);
      resolve({
        ok: false,
        code: null,
        output: '',
        message: error.message || `Failed to run npm script "${scriptName}".`
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      resolve({
        ok: Number(code || 0) === 0,
        code: Number.isInteger(code) ? code : null,
        output: outputChunks.join('\n').slice(0, 4000),
        message:
          Number(code || 0) === 0
            ? `npm run ${scriptName} completed successfully.`
            : `npm run ${scriptName} exited with code ${String(code)}.`
      });
    });
  });
}

function buildOpsActionCatalog(platformPayload, maintenanceSummary) {
  const integrations = platformPayload?.integrations || {};
  const supabaseStatus = integrations.supabase || {};
  const vercelStatus = integrations.vercel || {};
  const githubStatus = integrations.github || {};

  return [
    {
      id: 'refresh_runtime',
      label: 'Refresh Runtime',
      description: 'Invalidate caches and rerun runtime maintenance.',
      available: true,
      autoEligible: maintenanceSummary?.status !== 'ok',
      reason: 'Available in all environments.'
    },
    {
      id: 'repair_storage_bucket',
      label: 'Repair Supabase Storage',
      description: 'Ensure the configured Supabase storage bucket exists.',
      available: true,
      autoEligible: supabaseStatus.enabled === true && supabaseStatus.storageBucketFound === false,
      reason: 'Uses the existing Supabase service role already configured for this app.'
    },
    {
      id: 'backfill_media_metadata',
      label: 'Backfill Media Metadata',
      description: 'Rebuild stored media width and height metadata for existing posts.',
      available: !IS_SERVERLESS_RUNTIME,
      autoEligible: false,
      reason: !IS_SERVERLESS_RUNTIME
        ? 'Available in app runtime.'
        : 'Unavailable in serverless runtime.'
    },
    {
      id: 'run_smoke_checks',
      label: 'Run Smoke Checks',
      description: 'Run the backend smoke test suite against the live API to catch regressions.',
      available: !IS_SERVERLESS_RUNTIME,
      autoEligible: false,
      reason: !IS_SERVERLESS_RUNTIME
        ? 'Available in app runtime.'
        : 'Unavailable in serverless runtime.'
    },
    {
      id: 'redeploy_vercel',
      label: 'Redeploy Vercel',
      description: 'Trigger a production redeploy through a Vercel deploy hook.',
      available: Boolean(VERCEL_DEPLOY_HOOK_URL),
      autoEligible: Boolean(VERCEL_DEPLOY_HOOK_URL) && vercelStatus.status === 'degraded',
      reason: VERCEL_DEPLOY_HOOK_URL
        ? 'Vercel deploy hook is configured.'
        : 'Set VERCEL_DEPLOY_HOOK_URL to enable automated redeploys.'
    },
    {
      id: 'dispatch_github_workflow',
      label: 'Run GitHub Workflow',
      description: 'Dispatch a GitHub Actions workflow for CI/CD or repository repair.',
      available: Boolean(GITHUB_REPO && GITHUB_TOKEN && GITHUB_ACTIONS_WORKFLOW_ID),
      autoEligible: Boolean(GITHUB_REPO && GITHUB_TOKEN && GITHUB_ACTIONS_WORKFLOW_ID) && githubStatus.status === 'degraded',
      reason:
        GITHUB_REPO && GITHUB_TOKEN && GITHUB_ACTIONS_WORKFLOW_ID
          ? 'GitHub workflow dispatch is configured.'
          : 'Set GITHUB_REPO, GITHUB_TOKEN, and GITHUB_ACTIONS_WORKFLOW_ID to enable workflow dispatch.'
    }
  ];
}

function buildOpsRecommendations({ maintenanceSummary, platformPayload, actionCatalog }) {
  const integrations = platformPayload?.integrations || {};
  const recommendedActionIds = [];

  if (maintenanceSummary?.status && maintenanceSummary.status !== 'ok') {
    recommendedActionIds.push('refresh_runtime');
  }
  if (integrations.supabase?.enabled === true && integrations.supabase?.storageBucketFound === false) {
    recommendedActionIds.push('repair_storage_bucket');
  }
  if (integrations.vercel?.status === 'degraded' && VERCEL_DEPLOY_HOOK_URL) {
    recommendedActionIds.push('redeploy_vercel');
  }
  if (integrations.github?.status === 'degraded' && GITHUB_REPO && GITHUB_TOKEN && GITHUB_ACTIONS_WORKFLOW_ID) {
    recommendedActionIds.push('dispatch_github_workflow');
  }
  if (
    maintenanceSummary?.status &&
    maintenanceSummary.status !== 'ok' &&
    actionCatalog.some((action) => action.id === 'run_smoke_checks' && action.available)
  ) {
    recommendedActionIds.push('run_smoke_checks');
  }

  return [...new Set(recommendedActionIds)]
    .map((actionId) => actionCatalog.find((action) => action.id === actionId))
    .filter(Boolean);
}

function buildOpsInsights({ maintenanceSummary, platformPayload, recommendations, settings, lastRepair }) {
  const integrations = platformPayload?.integrations || {};
  const insights = [];

  if (settings?.autoFixEnabled) {
    insights.push({
      id: 'autofix-enabled',
      severity: 'info',
      title: 'Autonomous repair mode is active',
      message: 'The ops agent can automatically run eligible repair actions when diagnostics degrade.'
    });
  } else {
    insights.push({
      id: 'autofix-manual',
      severity: 'info',
      title: 'Human approval mode is active',
      message: 'Diagnostics keep running, but repair actions only run when an admin approves them.'
    });
  }

  if (maintenanceSummary?.status && maintenanceSummary.status !== 'ok') {
    insights.push({
      id: 'runtime-degraded',
      severity: 'warning',
      title: 'Runtime diagnostics need attention',
      message: maintenanceSummary.message || 'The AI agent detected a runtime issue and recommends a repair cycle.',
      actionId: 'refresh_runtime'
    });
  }

  if (integrations.supabase?.enabled === true && integrations.supabase?.storageBucketFound === false) {
    insights.push({
      id: 'supabase-storage',
      severity: 'warning',
      title: 'Supabase storage needs repair',
      message:
        integrations.supabase.message ||
        'The configured Supabase storage bucket is missing, so uploads and media playback can degrade.',
      actionId: 'repair_storage_bucket'
    });
  }

  if (integrations.github?.status === 'not_configured') {
    insights.push({
      id: 'github-control',
      severity: 'info',
      title: 'Code repair automation is not configured',
      message:
        'Add GitHub workflow dispatch credentials to let the AI agent trigger repository and CI repair workflows.'
    });
  }

  if (integrations.vercel?.status === 'not_configured') {
    insights.push({
      id: 'vercel-control',
      severity: 'info',
      title: 'Deployment recovery is not configured',
      message:
        'Add a Vercel deploy hook so the AI agent can trigger controlled redeploys after diagnostics or repair actions.'
    });
  }

  if (lastRepair?.success) {
    insights.push({
      id: 'last-repair-success',
      severity: 'success',
      title: 'Recent repair succeeded',
      message: `${lastRepair.label} completed successfully ${lastRepair.completedAt || 'recently'}.`
    });
  } else if (lastRepair && lastRepair.success === false) {
    insights.push({
      id: 'last-repair-failed',
      severity: 'warning',
      title: 'Recent repair failed',
      message: `${lastRepair.label} failed and may need another action or manual review.`
    });
  }

  if (recommendations.length === 0) {
    insights.push({
      id: 'steady-state',
      severity: 'success',
      title: 'No repair actions are currently recommended',
      message: 'Runtime, platform, and agent diagnostics are currently stable.'
    });
  }

  return insights.slice(0, 8);
}

function buildOpsAgentSummary({ maintenanceSummary, platformPayload, recommendations }) {
  const platformState = String(platformPayload?.summary?.state || 'unknown')
    .trim()
    .toLowerCase();

  if (opsAgentRuntimeState.currentAction) {
    return {
      state: 'recovering',
      message: `Running ${opsAgentRuntimeState.currentAction.label}...`
    };
  }

  if ((maintenanceSummary?.status && maintenanceSummary.status !== 'ok') || platformState === 'degraded') {
    return {
      state: 'degraded',
      message:
        recommendations.length > 0
          ? `Recommended action: ${recommendations[0].label}.`
          : 'Diagnostics detected an issue that may require manual review.'
    };
  }

  return {
    state: 'healthy',
    message: 'Ops agent diagnostics are healthy.'
  };
}

async function buildOpsAgentStatusPayload({ forceRefresh = false } = {}) {
  if (forceRefresh) {
    invalidatePlatformStatusCache();
  }

  const [maintenanceAgentResolution, platformPayload, settings] = await Promise.all([
    resolveMaintenanceAgentStatus({ includeNetworkProbe: false }),
    getPlatformStatusPayload(),
    getOpsAgentControlSettings()
  ]);
  const maintenanceSummary = buildMaintenanceAgentSummary(maintenanceAgentResolution.agentStatus);
  const actionCatalog = buildOpsActionCatalog(platformPayload, maintenanceSummary);
  const recommendations = buildOpsRecommendations({
    maintenanceSummary,
    platformPayload,
    actionCatalog
  });
  const insights = buildOpsInsights({
    maintenanceSummary,
    platformPayload,
    recommendations,
    settings,
    lastRepair: opsAgentRuntimeState.lastRepair
  });
  const summary = buildOpsAgentSummary({
    maintenanceSummary,
    platformPayload,
    recommendations
  });

  return {
    updatedAt: new Date().toISOString(),
    agent: {
      name: OPS_AGENT_RUNTIME_NAME,
      version: OPS_AGENT_RUNTIME_VERSION,
      pid: process.pid,
      startedAt: opsAgentRuntimeState.startedAt,
      intervalMs: IS_SERVERLESS_RUNTIME ? null : OPS_AGENT_INTERVAL_MS,
      autoFixEnabled: settings.autoFixEnabled,
      serverless: IS_SERVERLESS_RUNTIME
    },
    settings,
    capabilities: {
      diagnostics: true,
      runtimeRepair: true,
      smokeChecks: !IS_SERVERLESS_RUNTIME,
      githubWorkflowDispatch: Boolean(GITHUB_REPO && GITHUB_TOKEN && GITHUB_ACTIONS_WORKFLOW_ID),
      vercelRedeploy: Boolean(VERCEL_DEPLOY_HOOK_URL),
      databaseAuditLog: true,
      codeChangeControl: Boolean(GITHUB_REPO && GITHUB_TOKEN && GITHUB_ACTIONS_WORKFLOW_ID)
    },
    guardrails: [
      'Only admin users can change AI agent settings or run repair actions.',
      'The AI agent can run only predefined maintenance actions, not arbitrary code execution.',
      'Every AI agent repair is logged into the database-backed history feed for review.',
      'Code and deployment changes stay controlled through GitHub workflows or approved server scripts.'
    ],
    summary: {
      ...summary,
      checksCompleted: opsAgentRuntimeState.checksCompleted,
      repairsAttempted: opsAgentRuntimeState.repairsAttempted,
      repairsSucceeded: opsAgentRuntimeState.repairsSucceeded,
      repairsFailed: opsAgentRuntimeState.repairsFailed
    },
    maintenanceAgent: maintenanceSummary,
    platform: platformPayload,
    actions: actionCatalog,
    recommendations,
    insights,
    lastRepair: opsAgentRuntimeState.lastRepair
  };
}

async function executeOpsAgentAction(actionId, platformPayload) {
  switch (actionId) {
    case 'refresh_runtime': {
      invalidateAnnouncementRuntimeCaches();
      invalidateCategoriesRuntimeCache();
      invalidateLiveRuntimeCache();
      await ensureStorageBucketReady();
      await runAnnouncementMaintenance({ force: true });
      return {
        success: true,
        message: 'Runtime caches were refreshed and maintenance was rerun.',
        details: null
      };
    }
    case 'repair_storage_bucket': {
      await ensureStorageBucketReady();
      invalidatePlatformStatusCache();
      return {
        success: true,
        message: `Supabase storage bucket "${SUPABASE_STORAGE_BUCKET}" is ready.`,
        details: null
      };
    }
    case 'backfill_media_metadata': {
      const scriptResult = await runServerScript('backfill:media');
      return {
        success: scriptResult.ok,
        message: scriptResult.message,
        details: scriptResult.output || null
      };
    }
    case 'run_smoke_checks': {
      const scriptResult = await runServerScript('check:smoke');
      return {
        success: scriptResult.ok,
        message: scriptResult.message,
        details: scriptResult.output || null
      };
    }
    case 'redeploy_vercel': {
      if (!VERCEL_DEPLOY_HOOK_URL) {
        return {
          success: false,
          message: 'VERCEL_DEPLOY_HOOK_URL is not configured.',
          details: null
        };
      }
      const response = await requestJsonWithTimeout(VERCEL_DEPLOY_HOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ trigger: 'ops-agent' })
      });
      return {
        success: response.ok,
        message: response.ok ? 'Vercel redeploy hook triggered.' : response.error || 'Vercel redeploy failed.',
        details: response.payload || null
      };
    }
    case 'dispatch_github_workflow': {
      const repo = normalizeGithubRepoValue(GITHUB_REPO);
      if (!repo || !GITHUB_TOKEN || !GITHUB_ACTIONS_WORKFLOW_ID) {
        return {
          success: false,
          message: 'GitHub workflow dispatch is not fully configured.',
          details: null
        };
      }
      const ref =
        GITHUB_ACTIONS_REF ||
        String(platformPayload?.integrations?.github?.defaultBranch || '').trim() ||
        'main';
      const apiUrl = `${GITHUB_API_BASE_URL.replace(/\/+$/, '')}/repos/${repo}/actions/workflows/${encodeURIComponent(
        GITHUB_ACTIONS_WORKFLOW_ID
      )}/dispatches`;
      const response = await requestJsonWithTimeout(apiUrl, {
        method: 'POST',
        headers: {
          ...buildBearerAuthHeaders(GITHUB_TOKEN),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ref })
      });
      return {
        success: response.ok || response.statusCode === 204,
        message:
          response.ok || response.statusCode === 204
            ? `GitHub workflow dispatch queued for ref "${ref}".`
            : response.error || 'GitHub workflow dispatch failed.',
        details: response.payload || null
      };
    }
    default:
      return {
        success: false,
        message: `Unsupported ops action: ${String(actionId || '')}`,
        details: null
      };
  }
}

async function runOpsAgentAction(actionId, { trigger = 'manual', userEmail = null } = {}) {
  const platformPayload = await getPlatformStatusPayload();
  const actionCatalog = buildOpsActionCatalog(
    platformPayload,
    buildMaintenanceAgentSummary((await resolveMaintenanceAgentStatus({ includeNetworkProbe: false })).agentStatus)
  );
  const selectedAction = actionCatalog.find((action) => action.id === actionId);

  if (!selectedAction) {
    return {
      result: {
        actionId,
        label: actionId,
        trigger,
        success: false,
        message: 'Requested action is not supported.',
        details: null,
        completedAt: new Date().toISOString()
      },
      status: await buildOpsAgentStatusPayload({ forceRefresh: true })
    };
  }

  opsAgentRuntimeState.currentAction = {
    id: selectedAction.id,
    label: selectedAction.label,
    trigger,
    startedAt: new Date().toISOString()
  };

  let result;
  try {
    const execution = await executeOpsAgentAction(selectedAction.id, platformPayload);
    opsAgentRuntimeState.repairsAttempted += 1;
    if (execution.success) {
      opsAgentRuntimeState.repairsSucceeded += 1;
    } else {
      opsAgentRuntimeState.repairsFailed += 1;
    }
    opsAgentRuntimeState.lastRepairAtMs = Date.now();
    opsAgentRuntimeState.lastRepair = {
      actionId: selectedAction.id,
      label: selectedAction.label,
      trigger,
      success: execution.success,
      message: execution.message,
      details: execution.details,
      completedAt: new Date().toISOString()
    };
    result = opsAgentRuntimeState.lastRepair;
  } catch (error) {
    opsAgentRuntimeState.repairsAttempted += 1;
    opsAgentRuntimeState.repairsFailed += 1;
    opsAgentRuntimeState.lastRepairAtMs = Date.now();
    opsAgentRuntimeState.lastRepair = {
      actionId: selectedAction.id,
      label: selectedAction.label,
      trigger,
      success: false,
      message: error.message || 'Ops action failed.',
      details: null,
      completedAt: new Date().toISOString()
    };
    result = opsAgentRuntimeState.lastRepair;
  } finally {
    opsAgentRuntimeState.currentAction = null;
    invalidatePlatformStatusCache();
  }

  await appendOpsAgentEvent(
    trigger === 'auto' ? 'ops_action_auto' : 'ops_action_manual',
    {
      userEmail,
      title: `${selectedAction.label} ${result.success ? 'completed' : 'failed'}`,
      content: result.message,
      details: result.details,
      type: result.success ? 'system_ops_success' : 'system_ops_error',
      actionAt: result.completedAt
    }
  );

  return {
    result,
    status: await buildOpsAgentStatusPayload({ forceRefresh: true })
  };
}

async function runOpsAgentCycle() {
  opsAgentRuntimeState.checksCompleted += 1;
  const statusPayload = await buildOpsAgentStatusPayload({ forceRefresh: true });

  if (IS_SERVERLESS_RUNTIME || statusPayload.settings?.autoFixEnabled !== true || opsAgentRuntimeState.currentAction) {
    return statusPayload;
  }

  const cooldownActive = Date.now() - opsAgentRuntimeState.lastRepairAtMs < OPS_AGENT_COOLDOWN_MS;
  if (cooldownActive) {
    return statusPayload;
  }

  const nextAutoAction = (statusPayload.recommendations || []).find(
    (action) => action && action.autoEligible && action.available
  );

  if (!nextAutoAction) {
    return statusPayload;
  }

  await runOpsAgentAction(nextAutoAction.id, { trigger: 'auto' });
  return buildOpsAgentStatusPayload({ forceRefresh: true });
}

async function probeRuntimeNetwork({ enabled = true } = {}) {
  if (!enabled) {
    return {
      ok: true,
      skipped: true,
      statusCode: 0,
      latencyMs: 0,
      error: null
    };
  }
  return probeUrlWithTimeout(MAINTENANCE_AGENT_NETWORK_URL, MAINTENANCE_AGENT_PROBE_TIMEOUT_MS);
}

async function probeRuntimeDns({ enabled = true } = {}) {
  if (!enabled) {
    return {
      ok: true,
      skipped: true,
      latencyMs: 0,
      address: null,
      family: null,
      error: null
    };
  }

  const startedAtMs = Date.now();
  try {
    const result = await Promise.race([
      dns.lookup(MAINTENANCE_AGENT_DNS_HOST),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DNS probe timed out')), MAINTENANCE_AGENT_PROBE_TIMEOUT_MS)
      )
    ]);
    return {
      ok: true,
      skipped: false,
      latencyMs: Date.now() - startedAtMs,
      address: result.address,
      family: result.family,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      latencyMs: Date.now() - startedAtMs,
      address: null,
      family: null,
      error: error.message || 'DNS probe failed'
    };
  }
}

async function probeRuntimeDatabase() {
  const startedAtMs = Date.now();
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error && !isMissingTableError(error, 'users')) {
      throwSupabaseError('Runtime maintenance database probe failed', error);
    }
    return {
      ok: !error,
      status: error ? 'degraded' : 'ok',
      latencyMs: Date.now() - startedAtMs,
      error: error ? error.message : null
    };
  } catch (error) {
    return {
      ok: false,
      status: 'degraded',
      latencyMs: Date.now() - startedAtMs,
      error: error.message || 'Database probe failed'
    };
  }
}

function buildRuntimeMaintenanceCapabilities() {
  return {
    posts: true,
    text: true,
    images: true,
    videos: true,
    documents: true,
    liveStream: true,
    autoRecovery: !IS_SERVERLESS_RUNTIME
  };
}

async function buildRuntimeMaintenanceStatus({ includeNetworkProbe = true } = {}) {
  const startedAtMs = Date.now();
  const [databaseCheck, networkCheck, dnsCheck] = await Promise.all([
    probeRuntimeDatabase(),
    probeRuntimeNetwork({ enabled: includeNetworkProbe }),
    probeRuntimeDns({ enabled: includeNetworkProbe })
  ]);

  const apiLatencyMs = Math.max(1, Date.now() - startedAtMs);
  const hasCriticalIssue = !databaseCheck.ok;
  const hasNetworkIssue = includeNetworkProbe && (!networkCheck.ok || !dnsCheck.ok);

  let state = 'healthy';
  let message = 'Runtime diagnostics are healthy. Agent controls are online.';
  if (hasCriticalIssue && hasNetworkIssue) {
    state = 'degraded';
    message = 'Database and network diagnostics detected issues.';
  } else if (hasCriticalIssue) {
    state = 'degraded';
    message = 'Database diagnostic detected an issue.';
  } else if (hasNetworkIssue) {
    state = 'degraded';
    message = 'Network or DNS diagnostic detected an issue.';
  }

  runtimeMaintenanceChecksCompleted += 1;

  return {
    source: 'runtime-diagnostics',
    agent: {
      name: MAINTENANCE_AGENT_RUNTIME_NAME,
      version: MAINTENANCE_AGENT_RUNTIME_VERSION,
      pid: process.pid,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      intervalMs: null,
      healthUrl: '/api/health'
    },
    updatedAt: new Date().toISOString(),
    mode: IS_SERVERLESS_RUNTIME ? 'serverless-runtime' : 'app-runtime',
    summary: {
      state,
      message,
      consecutiveFailures: hasCriticalIssue ? 1 : 0,
      checksCompleted: runtimeMaintenanceChecksCompleted
    },
    checks: {
      api: {
        ok: !hasCriticalIssue,
        statusCode: hasCriticalIssue ? 503 : 200,
        latencyMs: apiLatencyMs,
        status: state,
        database: databaseCheck.status,
        error: null
      },
      database: databaseCheck,
      network: networkCheck,
      dns: dnsCheck
    },
    processes: {
      apiServer: {
        pid: process.pid,
        running: true
      },
      announcementMaintenance: {
        pid: null,
        running: !IS_SERVERLESS_RUNTIME
      }
    },
    recovery: {
      threshold: null,
      cooldownMs: null,
      attempts: 0,
      failures: 0,
      last: null,
      current: {
        attempted: false,
        success: true,
        action: null,
        reason: 'Runtime diagnostics mode',
        output: ''
      }
    },
    capabilities: buildRuntimeMaintenanceCapabilities()
  };
}

async function getRuntimeMaintenanceStatus({ includeNetworkProbe = true } = {}) {
  const cacheKey = includeNetworkProbe ? 'full' : 'light';
  const cacheEntry = runtimeMaintenanceStatusCache[cacheKey];
  const nowMs = Date.now();

  if (cacheEntry.payload && nowMs - cacheEntry.updatedAtMs <= MAINTENANCE_AGENT_RUNTIME_CACHE_MS) {
    return cloneJsonValue(cacheEntry.payload);
  }

  if (cacheEntry.inFlight) {
    return cacheEntry.inFlight;
  }

  cacheEntry.inFlight = (async () => {
    try {
      const payload = await buildRuntimeMaintenanceStatus({ includeNetworkProbe });
      cacheEntry.payload = payload;
      cacheEntry.updatedAtMs = Date.now();
      return cloneJsonValue(payload);
    } finally {
      cacheEntry.inFlight = null;
    }
  })();

  return cacheEntry.inFlight;
}

async function resolveMaintenanceAgentStatus({ includeNetworkProbe = true } = {}) {
  const heartbeatStatus = await readMaintenanceAgentStatus();
  if (heartbeatStatus && !isMaintenanceAgentStatusStale(heartbeatStatus)) {
    return {
      agentStatus: heartbeatStatus,
      source: 'heartbeat'
    };
  }

  const runtimeStatus = await getRuntimeMaintenanceStatus({ includeNetworkProbe });
  const resolvedStatus = cloneJsonValue(runtimeStatus) || runtimeStatus;

  if (heartbeatStatus) {
    const heartbeatUpdatedAt = getMaintenanceAgentUpdatedAt(heartbeatStatus);
    resolvedStatus.source = 'runtime-fallback';
    resolvedStatus.summary = {
      ...(resolvedStatus.summary || {}),
      message: `Heartbeat is stale${heartbeatUpdatedAt ? ` (${heartbeatUpdatedAt})` : ''}; runtime diagnostics are active.`
    };
    resolvedStatus.recovery = {
      ...(resolvedStatus.recovery || {}),
      heartbeat: {
        stale: true,
        updatedAt: heartbeatUpdatedAt
      }
    };
  } else {
    resolvedStatus.source = 'runtime';
  }

  return {
    agentStatus: resolvedStatus,
    source: resolvedStatus.source
  };
}

function buildMaintenanceAgentSummary(agentStatus) {
  if (!agentStatus || typeof agentStatus !== 'object') {
    return {
      status: 'unavailable',
      state: 'unavailable',
      stale: true,
      updatedAt: null,
      message: 'Maintenance agent is not running or has not reported status yet.'
    };
  }

  const updatedAt = getMaintenanceAgentUpdatedAt(agentStatus);
  const stale = isMaintenanceAgentStatusStale(agentStatus);
  const state = String(agentStatus.summary?.state || 'unknown')
    .trim()
    .toLowerCase();
  const message =
    String(agentStatus.summary?.message || '').trim() ||
    (stale ? 'Maintenance agent heartbeat is stale.' : 'Maintenance agent heartbeat is active.');
  const normalizedState = stale ? 'stale' : state || 'unknown';
  const status =
    normalizedState === 'stale'
      ? 'stale'
      : normalizedState === 'degraded' || normalizedState === 'unavailable' || normalizedState === 'stopped'
        ? 'degraded'
        : normalizedState === 'recovering'
          ? 'recovering'
          : 'ok';

  return {
    status,
    state: normalizedState,
    stale,
    updatedAt,
    message
  };
}

app.get('/api/system/maintenance-agent', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const { agentStatus, source } = await resolveMaintenanceAgentStatus({ includeNetworkProbe: true });
    const summary = buildMaintenanceAgentSummary(agentStatus);
    res.json({
      status: summary.status,
      summary,
      source,
      agent: agentStatus
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/system/platform-status', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const payload = await getPlatformStatusPayload();
    const state = String(payload?.summary?.state || '').toLowerCase();
    const httpStatus = state === 'degraded' ? 207 : 200;
    res.status(httpStatus).json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/system/ops-agent', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const payload = await buildOpsAgentStatusPayload({ forceRefresh: true });
    const state = String(payload?.summary?.state || '').toLowerCase();
    const httpStatus = state === 'degraded' ? 207 : 200;
    res.status(httpStatus).json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/system/ops-agent/settings', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const settings = await getOpsAgentControlSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/system/ops-agent/settings', simpleAuth, requireAdminRole, async (req, res) => {
  try {
    if (typeof req.body?.autoFixEnabled !== 'boolean') {
      return res.status(400).json({ error: 'autoFixEnabled boolean is required.' });
    }

    const settings = await updateOpsAgentControlSettings({
      autoFixEnabled: req.body.autoFixEnabled
    });
    await appendOpsAgentEvent('ops_settings_updated', {
      userEmail: (req.user && req.user.email) || null,
      title: 'AI ops agent settings updated',
      content: `Auto-fix was ${settings.requestedAutoFixEnabled ? 'enabled' : 'disabled'} by admin control.`,
      type: 'system_ops',
      actionAt: new Date().toISOString()
    });

    return res.json({
      settings,
      status: await buildOpsAgentStatusPayload({ forceRefresh: true })
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/system/ops-agent/history', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const rows = await getOpsAgentHistory(req.query?.limit);
    res.json({
      items: rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/system/ops-agent/actions/:actionId', simpleAuth, requireWorkspaceRole, async (req, res) => {
  try {
    const actionId = String(req.params.actionId || '').trim();
    if (!actionId) {
      return res.status(400).json({ error: 'Action id is required.' });
    }

    const payload = await runOpsAgentAction(actionId, {
      trigger: 'manual',
      userEmail: (req.user && req.user.email) || null
    });
    const httpStatus = payload.result?.success ? 200 : 207;
    return res.status(httpStatus).json(payload);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/test', (req, res) => {
  res.json({
    status: 'Server is running perfectly!',
    database: 'Using Supabase PostgreSQL',
    port: 5001,
    features: [
      'Image/video/document upload',
      'Direct signed uploads for large files',
      'Real-time updates',
      'Supabase storage'
    ]
  });
});

app.get('/api/health', async (req, res) => {
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const maintenanceAgentResolution = await resolveMaintenanceAgentStatus({ includeNetworkProbe: false });
  const maintenanceAgentSummary = buildMaintenanceAgentSummary(maintenanceAgentResolution.agentStatus);
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error && !isMissingTableError(error, 'users')) {
      throwSupabaseError('Health check database error', error);
    }

    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      startedAt,
      database: error ? 'degraded' : 'ok',
      maintenanceAgent: maintenanceAgentSummary
    });
  } catch (error) {
    res.status(503).json({
      status: 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      startedAt,
      maintenanceAgent: maintenanceAgentSummary,
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
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(path.join(clientDistPath, 'index.html'));
  }

  res.json({
    message: 'Digital Notice Board API',
    version: '3.0',
    features: [
      'Image/video/document upload support',
      'Direct signed upload support',
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
        createBatch: 'POST /api/announcements/batch (multiple attachments)',
        update: 'PUT /api/announcements/:id',
        delete: 'DELETE /api/announcements/:id'
      },
      uploads: {
        presign: 'POST /api/uploads/presign'
      },
      system: {
        maintenanceAgent: 'GET /api/system/maintenance-agent',
        platformStatus: 'GET /api/system/platform-status',
        opsAgent: 'GET /api/system/ops-agent',
        opsSettings: 'GET/PUT /api/system/ops-agent/settings',
        opsHistory: 'GET /api/system/ops-agent/history',
        opsAction: 'POST /api/system/ops-agent/actions/:actionId'
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
    res.setHeader('Cache-Control', 'no-cache');
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
    runAnnouncementMaintenance({ force: true });
  }, ANNOUNCEMENT_MAINTENANCE_INTERVAL_MS);
}

function ensureOpsAgentScheduler() {
  if (IS_SERVERLESS_RUNTIME || opsAgentIntervalHandle) {
    return;
  }

  opsAgentIntervalHandle = setInterval(() => {
    runOpsAgentCycle().catch((error) => {
      console.error('⚠️ Ops agent cycle failed:', error.message || String(error));
    });
  }, OPS_AGENT_INTERVAL_MS);
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
  ensureOpsAgentScheduler();
  if (opsAgentRuntimeState.checksCompleted === 0) {
    runOpsAgentCycle().catch((error) => {
      console.error('⚠️ Ops agent startup cycle failed:', error.message || String(error));
    });
  }
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
