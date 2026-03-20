import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as tus from 'tus-js-client';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { apiUrl } from '../config/api';
import { clearAdminSession, hasAdminSession, withAuthConfig } from '../config/auth';
import { clearStaffSession, hasStaffSession, withStaffAuthConfig } from '../config/staffAuth';
import { apiClient, extractApiError } from '../config/http';
import { useTheme } from '../hooks/useTheme';
import { useAdaptivePolling } from '../hooks/useAdaptivePolling';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { usePageVisibility } from '../hooks/usePageVisibility';
import { usePerformanceMode } from '../hooks/usePerformanceMode';
import AttachmentPreview from './AttachmentPreview';
import TopbarStatus from './TopbarStatus';

const toInputDateTime = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};

const getDefaultStart = () => toInputDateTime(new Date());

const getDefaultEnd = () => {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return toInputDateTime(date);
};

const toApiDateTime = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString();
};

const normalizeLiveCategory = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.toLowerCase() === 'all') {
    return 'all';
  }
  return normalized;
};

const getFileIdentity = (file) =>
  file ? `${file.name || ''}:${file.size || 0}:${file.lastModified || 0}:${file.type || ''}` : '';

const detectMediaDimensions = (file) =>
  new Promise((resolve) => {
    if (!file) {
      resolve({ width: null, height: null });
      return;
    }

    const mime = String(file.type || '').toLowerCase();
    if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
      resolve({ width: null, height: null });
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(objectUrl);
    const finish = (width, height) => {
      cleanup();
      resolve({
        width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
        height: Number.isFinite(height) && height > 0 ? Math.round(height) : null
      });
    };

    if (mime.startsWith('image/')) {
      const image = new Image();
      image.onload = () => finish(image.naturalWidth || image.width, image.naturalHeight || image.height);
      image.onerror = () => finish(null, null);
      image.src = objectUrl;
      return;
    }

    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => finish(video.videoWidth, video.videoHeight);
    video.onerror = () => finish(null, null);
    video.src = objectUrl;
  });

const DOCUMENT_ACCEPT = 'application/*,text/*,*/*';
const IMAGE_ACCEPT =
  'image/*,.jpg,.jpeg,.png,.gif,.bmp,.tif,.tiff,.webp,.avif,.heif,.heic,.apng,.svg,.ai,.eps,.psd,.raw,.dng,.cr2,.cr3,.nef,.arw,.orf,.rw2';
const VIDEO_ACCEPT =
  'video/*,.mp4,.m4v,.m4p,.mov,.avi,.mkv,.webm,.ogg,.ogv,.flv,.f4v,.wmv,.asf,.ts,.m2ts,.mts,.3gp,.3g2,.mpg,.mpeg,.mpe,.vob,.mxf,.rm,.rmvb,.qt,.hevc,.h265,.h264,.r3d,.braw,.cdng,.prores,.dnxhd,.dnxhr,.dv,.mjpeg';
const MEDIA_ACCEPT = `${IMAGE_ACCEPT},${VIDEO_ACCEPT}`;
const MAX_ATTACHMENT_UPLOAD_BYTES = 150 * 1024 * 1024;
const MAX_ATTACHMENT_UPLOAD_MB = Math.floor(MAX_ATTACHMENT_UPLOAD_BYTES / (1024 * 1024));
const MULTIPART_FALLBACK_MAX_BYTES = Math.floor(3.5 * 1024 * 1024);
const MAX_BATCH_ATTACHMENTS = 24;
const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 6 * 1024 * 1024;
const RESUMABLE_UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;
const RESUMABLE_UPLOAD_RETRY_DELAYS_MS = [0, 1000, 3000, 5000, 10000, 20000];
const DROP_ZONE_KEYS = ['image', 'video', 'document'];
const FILE_DRAG_TRANSFER_TYPES = new Set(['files', 'application/x-moz-file']);
const SLOW_NETWORK_TYPES = new Set(['slow-2g', '2g', '3g']);
const MAX_LIVE_LINKS = 24;
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

const parseUrl = (value) => {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
};

const cleanupLiveLinkCandidate = (value) =>
  String(value || '')
    .trim()
    .replace(/[\s)\],.;]+$/g, '');

const hasUrlScheme = (value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || '').trim());

const normalizeLiveHost = (host) => String(host || '').replace(/^www\./i, '').toLowerCase();

const isSupportedLiveHost = (host) => {
  const normalizedHost = normalizeLiveHost(host);
  return (
    normalizedHost === 'youtu.be' ||
    normalizedHost.endsWith('youtube.com') ||
    normalizedHost.endsWith('vimeo.com') ||
    normalizedHost.endsWith('twitch.tv')
  );
};

const isLikelyWrapperHost = (host) => {
  const normalizedHost = normalizeLiveHost(host);
  return LIVE_LINK_WRAPPER_HOSTS.some(
    (candidate) => normalizedHost === candidate || normalizedHost.endsWith(`.${candidate}`)
  );
};

const decodeLinkValueVariants = (value) => {
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
};

const extractRawLinkCandidates = (rawValue) => {
  const normalizedRaw = String(rawValue || '').trim();
  if (!normalizedRaw) return [];

  const tokenSet = new Set();
  const urlMatches = normalizedRaw.match(LIVE_LINK_URL_PATTERN);
  if (urlMatches && urlMatches.length > 0) {
    urlMatches.forEach((item) => tokenSet.add(cleanupLiveLinkCandidate(item)));
  }

  normalizedRaw
    .split(LIVE_LINK_SPLIT_PATTERN)
    .map(cleanupLiveLinkCandidate)
    .filter(Boolean)
    .forEach((item) => tokenSet.add(item));

  return [...tokenSet];
};

const extractNestedLiveLinkCandidates = (parsedUrl) => {
  const candidateValues = [];
  const host = normalizeLiveHost(parsedUrl?.hostname);
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
      extractRawLinkCandidates(decoded).forEach((candidate) => nested.add(candidate));
    });
  });

  return [...nested];
};

const resolveShareableLiveLink = (value, depth = 0) => {
  if (depth > 2) return null;
  const cleaned = cleanupLiveLinkCandidate(value);
  if (!cleaned) return null;

  const withProtocol =
    hasUrlScheme(cleaned) || !LIVE_LINK_DOMAIN_PATTERN.test(cleaned)
      ? cleaned
      : `https://${cleaned}`;

  const parsed = parseUrl(withProtocol);
  if (!parsed) return null;
  const protocol = String(parsed.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;

  if (protocol === 'http:') {
    parsed.protocol = 'https:';
  }

  if (isSupportedLiveHost(parsed.hostname)) {
    return parsed.toString();
  }

  const nestedCandidates = extractNestedLiveLinkCandidates(parsed);
  for (const candidate of nestedCandidates) {
    const resolved = resolveShareableLiveLink(candidate, depth + 1);
    if (resolved) {
      return resolved;
    }
  }

  return null;
};

const extractLiveLinkCandidates = (rawValue) => {
  return extractRawLinkCandidates(rawValue);
};

const parseLiveLinkList = (rawValue) =>
  [
    ...new Set(
      extractLiveLinkCandidates(rawValue)
        .map((item) => resolveShareableLiveLink(item))
        .filter(Boolean)
    )
  ].slice(
    0,
    MAX_LIVE_LINKS
  );

const normalizeLiveLinkArray = (rawValues = []) =>
  [
    ...new Set(
      (Array.isArray(rawValues) ? rawValues : [])
        .map((item) => resolveShareableLiveLink(item))
        .filter(Boolean)
    )
  ].slice(
    0,
    MAX_LIVE_LINKS
  );

const getDimensionLookupKey = (file) => getFileIdentity(file);

const isLikelyMediaFile = (file) => {
  const mime = String(file?.type || '').toLowerCase();
  if (!mime) return true;
  return mime.startsWith('image/') || mime.startsWith('video/');
};

const isVideoFile = (file) => {
  const mime = String(file?.type || '').toLowerCase();
  if (mime.startsWith('video/')) return true;
  const name = String(file?.name || '').toLowerCase();
  return /\.(mp4|m4v|m4p|mov|avi|mkv|webm|ogg|ogv|flv|f4v|wmv|asf|ts|m2ts|mts|3gp|3g2|mpg|mpeg|mpe|vob|mxf|rm|rmvb|qt|hevc|h265|h264|r3d|braw|cdng|prores|dnxhd|dnxhr|dv|mjpeg)$/.test(
    name
  );
};

const isImageFile = (file) => {
  const mime = String(file?.type || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  const name = String(file?.name || '').toLowerCase();
  return /\.(jpg|jpeg|png|gif|bmp|tif|tiff|webp|avif|heif|heic|apng|svg|ai|eps|psd|raw|dng|cr2|cr3|nef|arw|orf|rw2)$/.test(
    name
  );
};

const getMediaKindLabel = (file) => {
  if (isVideoFile(file)) return 'Video';
  if (isImageFile(file)) return 'Image';
  return 'Media';
};

const hasFileDragPayload = (dataTransfer) =>
  Array.from(dataTransfer?.types || []).some((type) =>
    FILE_DRAG_TRANSFER_TYPES.has(String(type || '').trim().toLowerCase())
  );

const extractDroppedFiles = (dataTransfer) => {
  if (!dataTransfer) return [];

  const fileMap = new Map();
  const registerFile = (file) => {
    if (!(file instanceof File)) return;
    const identity = getFileIdentity(file);
    if (!identity || fileMap.has(identity)) return;
    fileMap.set(identity, file);
  };

  Array.from(dataTransfer.items || []).forEach((item) => {
    if (String(item?.kind || '').toLowerCase() !== 'file') return;
    const file = item.getAsFile?.();
    if (file) {
      registerFile(file);
    }
  });

  Array.from(dataTransfer.files || []).forEach(registerFile);
  return [...fileMap.values()];
};

const isSlowUploadNetwork = (effectiveType) =>
  SLOW_NETWORK_TYPES.has(String(effectiveType || '').trim().toLowerCase());

const shouldUseResumableUpload = ({ fileSizeBytes, effectiveType, token, objectPath, bucketName, resumableUploadUrl }) =>
  Boolean(
    token &&
      objectPath &&
      bucketName &&
      resumableUploadUrl &&
      (fileSizeBytes > RESUMABLE_UPLOAD_THRESHOLD_BYTES ||
        (isSlowUploadNetwork(effectiveType) && fileSizeBytes >= 1024 * 1024))
  );

const createDisplayBatchId = () => {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID().replace(/-/g, '_');
  }
  return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const revokeObjectUrls = (urls = []) => {
  urls.forEach((url) => {
    if (url) {
      URL.revokeObjectURL(url);
    }
  });
};

const formatAgentRelativeTime = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return 'never';

  const parsedMs = Date.parse(raw);
  if (!Number.isFinite(parsedMs)) return 'unknown';

  const deltaMs = Date.now() - parsedMs;
  if (deltaMs < 5000) return 'just now';
  if (deltaMs < 60000) return `${Math.round(deltaMs / 1000)}s ago`;
  if (deltaMs < 3600000) return `${Math.round(deltaMs / 60000)}m ago`;
  if (deltaMs < 86400000) return `${Math.round(deltaMs / 3600000)}h ago`;
  return `${Math.round(deltaMs / 86400000)}d ago`;
};

const formatLatencyLabel = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'n/a';
  return `${parsed}ms`;
};

const getStatusPillClass = (state) => {
  const normalized = String(state || '')
    .trim()
    .toLowerCase();
  if (normalized === 'ok' || normalized === 'healthy') return 'pill pill--success';
  if (normalized === 'recovering' || normalized === 'unknown') return 'pill pill--info';
  if (normalized === 'not_configured') return 'pill';
  return 'pill pill--danger';
};

const getInsightPillClass = (severity) => {
  const normalized = String(severity || '')
    .trim()
    .toLowerCase();
  if (normalized === 'success') return 'pill pill--success';
  if (normalized === 'warning' || normalized === 'danger') return 'pill pill--danger';
  return 'pill pill--info';
};

const formatAgentTimestamp = (value) => {
  const parsedMs = Date.parse(String(value || '').trim());
  if (!Number.isFinite(parsedMs)) return 'Unknown time';
  return new Date(parsedMs).toLocaleString();
};

const runSingleFlight = async (pendingRef, task) => {
  if (pendingRef.current) {
    return pendingRef.current;
  }

  const nextPromise = (async () => {
    try {
      return await task();
    } finally {
      pendingRef.current = null;
    }
  })();
  pendingRef.current = nextPromise;
  return nextPromise;
};

const AdminPanel = ({ workspaceRole = 'admin' }) => {
  const isStaffWorkspace = workspaceRole === 'staff';
  const isAdminWorkspace = !isStaffWorkspace;
  const [announcements, setAnnouncements] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [mediaFiles, setMediaFiles] = useState([]);
  const [mediaPreviewUrls, setMediaPreviewUrls] = useState([]);
  const [mediaDimensionsByKey, setMediaDimensionsByKey] = useState({});
  const [documentFiles, setDocumentFiles] = useState([]);
  const [documentPreviewUrls, setDocumentPreviewUrls] = useState([]);
  const [uploadCapabilities, setUploadCapabilities] = useState({
    maxFileSizeBytes: MAX_ATTACHMENT_UPLOAD_BYTES,
    maxFileSizeMb: MAX_ATTACHMENT_UPLOAD_MB
  });
  const [formData, setFormData] = useState({
    title: '',
    content: '',
    priority: 1,
    duration: 7,
    isActive: true,
    category: '',
    startAt: getDefaultStart(),
    endAt: getDefaultEnd()
  });
  const [loading, setLoading] = useState(false);
  const [liveLinkInput, setLiveLinkInput] = useState('');
  const [liveLinkInputError, setLiveLinkInputError] = useState('');
  const [liveStatus, setLiveStatus] = useState('OFF');
  const [liveLinks, setLiveLinks] = useState([]);
  const [liveDraftLinks, setLiveDraftLinks] = useState([]);
  const [liveCategory, setLiveCategory] = useState('all');
  const [liveActionPending, setLiveActionPending] = useState('');
  const [announcementLiveLinkInput, setAnnouncementLiveLinkInput] = useState('');
  const [announcementLiveLinks, setAnnouncementLiveLinks] = useState([]);
  const [categories, setCategories] = useState([]);
  const [newCategory, setNewCategory] = useState('');
  const [categorySaving, setCategorySaving] = useState(false);
  const [deleteCategoryId, setDeleteCategoryId] = useState('');
  const [categoryDeleting, setCategoryDeleting] = useState(false);
  const [displayUsers, setDisplayUsers] = useState([]);
  const [staffUsers, setStaffUsers] = useState([]);
  const [showAccessManager, setShowAccessManager] = useState(false);
  const [credentialsSection, setCredentialsSection] = useState('display');
  const [accessForm, setAccessForm] = useState({
    username: '',
    password: '',
    category: ''
  });
  const [accessSaving, setAccessSaving] = useState(false);
  const [staffAccessForm, setStaffAccessForm] = useState({
    username: '',
    password: ''
  });
  const [staffAccessSaving, setStaffAccessSaving] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [announcementLiveInputError, setAnnouncementLiveInputError] = useState('');
  const [editAttachmentRemoved, setEditAttachmentRemoved] = useState(false);
  const [maintenanceAgentPayload, setMaintenanceAgentPayload] = useState(null);
  const [maintenanceAgentError, setMaintenanceAgentError] = useState('');
  const [platformStatusPayload, setPlatformStatusPayload] = useState(null);
  const [platformStatusError, setPlatformStatusError] = useState('');
  const [opsAgentPayload, setOpsAgentPayload] = useState(null);
  const [opsAgentSettings, setOpsAgentSettings] = useState(null);
  const [opsAgentSettingsError, setOpsAgentSettingsError] = useState('');
  const [opsAgentSettingsPending, setOpsAgentSettingsPending] = useState(false);
  const [opsAgentHistory, setOpsAgentHistory] = useState([]);
  const [opsAgentHistoryError, setOpsAgentHistoryError] = useState('');
  const [opsAgentError, setOpsAgentError] = useState('');
  const [opsAgentActionPending, setOpsAgentActionPending] = useState('');
  const [opsAgentActionResult, setOpsAgentActionResult] = useState(null);
  const [showAgentCenterDetails, setShowAgentCenterDetails] = useState(false);
  const [activeDropZone, setActiveDropZone] = useState('');
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const mediaInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const mediaReplaceInputRef = useRef(null);
  const documentInputRef = useRef(null);
  const documentReplaceInputRef = useRef(null);
  const announcementsRequestRef = useRef(null);
  const liveStatusRequestRef = useRef(null);
  const categoriesRequestRef = useRef(null);
  const uploadCapabilitiesRequestRef = useRef(null);
  const displayUsersRequestRef = useRef(null);
  const staffUsersRequestRef = useRef(null);
  const maintenanceAgentRequestRef = useRef(null);
  const platformStatusRequestRef = useRef(null);
  const opsAgentRequestRef = useRef(null);
  const opsAgentSettingsRequestRef = useRef(null);
  const opsAgentHistoryRequestRef = useRef(null);
  const opsAgentActionRequestRef = useRef(null);
  const windowFileDragDepthRef = useRef(0);
  const dropZoneDragDepthRef = useRef({
    image: 0,
    video: 0,
    document: 0
  });
  const [mediaReplaceIndex, setMediaReplaceIndex] = useState(-1);
  const [documentReplaceIndex, setDocumentReplaceIndex] = useState(-1);

  const navigate = useNavigate();
  const { socket } = useSocket();
  const { isDark, toggleTheme } = useTheme();
  const { isOnline, effectiveType } = useNetworkStatus();
  const { shouldUseSummaryPreviews } = usePerformanceMode();
  const isPageVisible = usePageVisibility();
  const [socketConnected, setSocketConnected] = useState(Boolean(socket?.connected));
  const preferSocket = Boolean(socket) && socketConnected;

  const applyWorkspaceAuth = useCallback(
    (config = {}) => (isStaffWorkspace ? withStaffAuthConfig(config) : withAuthConfig(config)),
    [isStaffWorkspace]
  );

  const clearWorkspaceSession = useCallback(() => {
    if (isStaffWorkspace) {
      clearStaffSession();
      return;
    }
    clearAdminSession();
  }, [isStaffWorkspace]);

  const workspaceLoginRoute = isStaffWorkspace ? '/staff/login' : '/admin/login';
  const workspaceHistoryRoute = isStaffWorkspace ? '/staff/history' : '/admin/history';
  const getBatchAttachmentCount = useCallback(
    (announcement) => {
      const batchId = String(announcement?.displayBatchId || '').trim();
      if (!batchId) return 1;
      const scoped = announcements.filter(
        (item) => String(item?.displayBatchId || '').trim() === batchId
      );
      return scoped.length > 0 ? scoped.length : 1;
    },
    [announcements]
  );

  const handleAuthFailure = useCallback(() => {
    clearWorkspaceSession();
    navigate(workspaceLoginRoute);
  }, [clearWorkspaceSession, navigate, workspaceLoginRoute]);

  const handleRequestError = useCallback(
    (error, fallbackMessage) => {
      if (error.response?.status === 401) {
        handleAuthFailure();
        return true;
      }

      setRequestError(extractApiError(error, fallbackMessage));
      return false;
    },
    [handleAuthFailure]
  );

  const activeUploadMaxSizeBytes = useMemo(() => {
    const configuredLimit = Number.parseInt(uploadCapabilities?.maxFileSizeBytes, 10);
    if (Number.isFinite(configuredLimit) && configuredLimit > 0) {
      return Math.min(configuredLimit, MAX_ATTACHMENT_UPLOAD_BYTES);
    }
    return MAX_ATTACHMENT_UPLOAD_BYTES;
  }, [uploadCapabilities]);

  const activeUploadMaxSizeMb = useMemo(() => {
    const configuredMb = Number.parseInt(uploadCapabilities?.maxFileSizeMb, 10);
    if (Number.isFinite(configuredMb) && configuredMb > 0) {
      return Math.min(configuredMb, MAX_ATTACHMENT_UPLOAD_MB);
    }
    return Math.max(1, Math.floor(activeUploadMaxSizeBytes / (1024 * 1024)));
  }, [activeUploadMaxSizeBytes, uploadCapabilities]);

  const uploadAttachmentWithTus = useCallback(
    async ({
      file,
      mimeType,
      objectPath,
      bucketName,
      token,
      resumableUploadUrl
    }) =>
      new Promise((resolve, reject) => {
        const upload = new tus.Upload(file, {
          endpoint: resumableUploadUrl,
          retryDelays: RESUMABLE_UPLOAD_RETRY_DELAYS_MS,
          headers: {
            'x-signature': token,
            'x-upsert': 'false'
          },
          metadata: {
            bucketName,
            objectName: objectPath,
            contentType: mimeType,
            cacheControl: '3600'
          },
          uploadDataDuringCreation: true,
          removeFingerprintOnSuccess: true,
          chunkSize: RESUMABLE_UPLOAD_CHUNK_BYTES,
          fingerprint: () =>
            Promise.resolve(
              ['notice-board', objectPath, file.name || '', file.size || 0, file.lastModified || 0].join(':')
            ),
          onError: (error) => {
            reject(error);
          },
          onSuccess: () => {
            resolve();
          }
        });

        upload
          .findPreviousUploads()
          .then((previousUploads) => {
            if (Array.isArray(previousUploads) && previousUploads.length > 0) {
              upload.resumeFromPreviousUpload(previousUploads[0]);
            }
            upload.start();
          })
          .catch((error) => {
            reject(error);
          });
      }),
    []
  );

  const uploadAttachmentToStorage = useCallback(
    async (file) => {
      if (!file) return null;

      const fileName = String(file.name || '').trim() || 'attachment';
      const mimeType = String(file.type || '').trim() || 'application/octet-stream';
      const fileSizeBytes = Number.parseInt(file.size, 10);
      if (Number.isNaN(fileSizeBytes) || fileSizeBytes <= 0) {
        throw new Error('Selected file is invalid.');
      }
      if (fileSizeBytes > activeUploadMaxSizeBytes) {
        throw new Error(`"${fileName}" exceeds the ${activeUploadMaxSizeMb}MB upload limit.`);
      }

      const presignResponse = await apiClient.post(
        apiUrl('/api/uploads/presign'),
        {
          fileName,
          mimeType,
          fileSizeBytes
        },
        applyWorkspaceAuth()
      );

      const presignPayload = presignResponse?.data || {};
      const signedUrl = String(presignPayload.signedUrl || '').trim();
      const publicUrl = String(presignPayload.publicUrl || '').trim();
      const bucketName = String(presignPayload.bucketName || '').trim();
      const objectPath = String(presignPayload.objectPath || '').trim();
      const token = String(presignPayload.token || '').trim();
      const resumableUploadUrl = String(presignPayload.resumableUploadUrl || '').trim();
      if (!signedUrl || !publicUrl) {
        throw new Error('Upload URL could not be generated for this file.');
      }

      if (
        shouldUseResumableUpload({
          fileSizeBytes,
          effectiveType,
          token,
          objectPath,
          bucketName,
          resumableUploadUrl
        })
      ) {
        await uploadAttachmentWithTus({
          file,
          mimeType,
          objectPath,
          bucketName,
          token,
          resumableUploadUrl
        });
      } else {
        const uploadResponse = await fetch(signedUrl, {
          method: 'PUT',
          headers: {
            'content-type': mimeType,
            'x-upsert': 'false'
          },
          body: file
        });

        if (!uploadResponse.ok) {
          const failureBody = await uploadResponse.text().catch(() => '');
          const failureDetail = String(failureBody || '').trim().slice(0, 180);
          throw new Error(
            `Direct upload failed (${uploadResponse.status}).${
              failureDetail ? ` ${failureDetail}` : ''
            }`
          );
        }
      }

      return {
        attachmentUrl: publicUrl,
        attachmentFileName: fileName,
        attachmentMimeType: mimeType,
        attachmentFileSizeBytes: fileSizeBytes
      };
    },
    [activeUploadMaxSizeBytes, activeUploadMaxSizeMb, applyWorkspaceAuth, effectiveType, uploadAttachmentWithTus]
  );

  const validateUploadSize = useCallback((files = []) => {
    const oversizedFile = (Array.isArray(files) ? files : []).find((file) => {
      const size = Number.parseInt(file?.size, 10);
      return Number.isFinite(size) && size > activeUploadMaxSizeBytes;
    });

    if (!oversizedFile) {
      return true;
    }

    setRequestError(
      `${oversizedFile.name || 'Selected file'} exceeds the ${activeUploadMaxSizeMb}MB upload limit.`
    );
    return false;
  }, [activeUploadMaxSizeBytes, activeUploadMaxSizeMb]);

  const summary = useMemo(() => {
    const total = announcements.length;
    const active = announcements.filter((announcement) => announcement.isActive !== false).length;
    const emergency = announcements.filter((announcement) => announcement.priority === 0).length;
    return { total, active, emergency };
  }, [announcements]);

  const liveCategoryLabel = useMemo(() => {
    if (liveCategory === 'all') {
      return 'All categories (global)';
    }
    const matchedCategory = categories.find((category) => category.id === liveCategory);
    return matchedCategory ? matchedCategory.name : 'Selected category';
  }, [categories, liveCategory]);
  const maintenanceAgentDetails = useMemo(
    () => maintenanceAgentPayload?.agent || maintenanceAgentPayload || null,
    [maintenanceAgentPayload]
  );
  const maintenanceAgentSummary = useMemo(
    () => maintenanceAgentPayload?.summary || maintenanceAgentDetails?.summary || null,
    [maintenanceAgentDetails, maintenanceAgentPayload]
  );
  const maintenanceAgentChecks = useMemo(
    () => maintenanceAgentDetails?.checks || maintenanceAgentPayload?.checks || {},
    [maintenanceAgentDetails, maintenanceAgentPayload]
  );
  const maintenanceAgentMode = String(maintenanceAgentDetails?.mode || maintenanceAgentPayload?.mode || 'n/a');
  const maintenanceAgentFailures =
    Number.parseInt(
      maintenanceAgentDetails?.summary?.consecutiveFailures ?? maintenanceAgentSummary?.consecutiveFailures,
      10
    ) || 0;
  const maintenanceAgentSource = String(maintenanceAgentDetails?.source || maintenanceAgentPayload?.source || '').trim();
  const maintenanceAgentDatabaseStatus = useMemo(() => {
    if (maintenanceAgentChecks?.database?.ok === true) {
      return 'ok';
    }
    if (maintenanceAgentChecks?.database?.ok === false) {
      return 'degraded';
    }
    const apiDatabase = String(maintenanceAgentChecks?.api?.database || '')
      .trim()
      .toLowerCase();
    return apiDatabase || 'n/a';
  }, [maintenanceAgentChecks]);
  const maintenanceAgentState = String(maintenanceAgentSummary?.state || 'unavailable')
    .trim()
    .toLowerCase();
  const maintenanceAgentPillClass =
    maintenanceAgentState === 'healthy'
      ? 'pill pill--success'
      : maintenanceAgentState === 'recovering'
        ? 'pill pill--info'
        : 'pill pill--danger';
  const platformSummary = useMemo(() => platformStatusPayload?.summary || null, [platformStatusPayload]);
  const platformIntegrations = useMemo(
    () => platformStatusPayload?.integrations || {},
    [platformStatusPayload]
  );
  const platformState = String(platformSummary?.state || 'unknown')
    .trim()
    .toLowerCase();
  const platformPillClass = getStatusPillClass(platformState);
  const githubPlatformState = String(platformIntegrations?.github?.status || 'unknown')
    .trim()
    .toLowerCase();
  const vercelPlatformState = String(platformIntegrations?.vercel?.status || 'unknown')
    .trim()
    .toLowerCase();
  const supabasePlatformState = String(platformIntegrations?.supabase?.status || 'unknown')
    .trim()
    .toLowerCase();
  const opsAgentSummary = useMemo(() => opsAgentPayload?.summary || null, [opsAgentPayload]);
  const opsAgentRuntimeSettings = useMemo(
    () => opsAgentPayload?.settings || opsAgentSettings || null,
    [opsAgentPayload, opsAgentSettings]
  );
  const opsAgentActions = useMemo(
    () => (Array.isArray(opsAgentPayload?.actions) ? opsAgentPayload.actions : []),
    [opsAgentPayload]
  );
  const opsAgentRecommendations = useMemo(
    () => (Array.isArray(opsAgentPayload?.recommendations) ? opsAgentPayload.recommendations : []),
    [opsAgentPayload]
  );
  const opsAgentLastRepair = useMemo(() => opsAgentPayload?.lastRepair || null, [opsAgentPayload]);
  const opsAgentInsights = useMemo(
    () => (Array.isArray(opsAgentPayload?.insights) ? opsAgentPayload.insights : []),
    [opsAgentPayload]
  );
  const opsAgentGuardrails = useMemo(
    () => (Array.isArray(opsAgentPayload?.guardrails) ? opsAgentPayload.guardrails : []),
    [opsAgentPayload]
  );
  const opsAgentCapabilities = useMemo(
    () => opsAgentPayload?.capabilities || {},
    [opsAgentPayload]
  );
  const opsAgentState = String(opsAgentSummary?.state || 'unknown')
    .trim()
    .toLowerCase();
  const opsAgentPillClass = getStatusPillClass(opsAgentState);
  const opsAgentAutoFixLabel = opsAgentRuntimeSettings?.serverless
    ? 'MANUAL ONLY'
    : opsAgentRuntimeSettings?.autoFixEnabled
      ? 'ENABLED'
      : 'DISABLED';
  const recommendedActionIds = useMemo(
    () => new Set(opsAgentRecommendations.map((action) => action.id).filter(Boolean)),
    [opsAgentRecommendations]
  );
  const opsActionCards = useMemo(
    () =>
      opsAgentActions.map((action) => ({
        ...action,
        recommended: recommendedActionIds.has(action.id)
      })),
    [opsAgentActions, recommendedActionIds]
  );
  const platformIntegrationCards = useMemo(
    () => [
      {
        id: 'github',
        label: 'GitHub',
        status: githubPlatformState,
        message: platformIntegrations?.github?.message || 'GitHub automation status unavailable.',
        latencyMs: platformIntegrations?.github?.latencyMs || null
      },
      {
        id: 'vercel',
        label: 'Vercel',
        status: vercelPlatformState,
        message: platformIntegrations?.vercel?.message || 'Vercel deployment status unavailable.',
        latencyMs: platformIntegrations?.vercel?.latencyMs || null
      },
      {
        id: 'supabase',
        label: 'Supabase',
        status: supabasePlatformState,
        message: platformIntegrations?.supabase?.message || 'Supabase diagnostics unavailable.',
        latencyMs: platformIntegrations?.supabase?.latencyMs || null
      }
    ],
    [githubPlatformState, platformIntegrations, supabasePlatformState, vercelPlatformState]
  );

  const editingAnnouncementPreview = useMemo(() => {
    if (!editingId) return null;
    return announcements.find((announcement) => announcement.id === editingId) || null;
  }, [announcements, editingId]);
  const editingBatchCount = useMemo(
    () => (editingAnnouncementPreview ? getBatchAttachmentCount(editingAnnouncementPreview) : 1),
    [editingAnnouncementPreview, getBatchAttachmentCount]
  );
  const isEditingBatchGroup =
    Boolean(editingAnnouncementPreview && editingAnnouncementPreview.displayBatchId) &&
    editingBatchCount > 1;
  const hasSelectedEditAttachmentReplacement = mediaFiles.length > 0 || documentFiles.length > 0;
  const editingAttachmentTypeHint = String(
    editingAnnouncementPreview?.fileMimeType || editingAnnouncementPreview?.type || ''
  ).toLowerCase();
  const editingExistingAttachmentKind = editingAttachmentTypeHint.startsWith('video/')
    ? 'video'
    : editingAttachmentTypeHint.startsWith('image/')
      ? 'image'
      : editingAnnouncementPreview?.image
        ? 'document'
        : '';
  const showExistingAttachmentEditor =
    Boolean(editingAnnouncementPreview?.image) &&
    !editAttachmentRemoved &&
    !hasSelectedEditAttachmentReplacement;
  const canRemoveEditingAttachment = !isEditingBatchGroup;

  const fetchAnnouncements = useCallback(async () => {
    if (!isOnline) {
      setRequestError('Network appears offline. Waiting to reconnect...');
      return;
    }

    await runSingleFlight(announcementsRequestRef, async () => {
      try {
        const response = await apiClient.get(apiUrl('/api/announcements'), applyWorkspaceAuth());
        setAnnouncements(response.data || []);
        setRequestError('');
      } catch (error) {
        if (handleRequestError(error, 'Unable to load announcements.')) return;
        console.error('Error fetching announcements:', error);
      }
    });
  }, [applyWorkspaceAuth, handleRequestError, isOnline]);

  const fetchLiveStatus = useCallback(async () => {
    if (!isOnline) {
      return;
    }

    await runSingleFlight(liveStatusRequestRef, async () => {
      try {
        const response = await apiClient.get(apiUrl('/api/status'));
        const statusPayload = response.data || {};
        const nextLinks =
          Array.isArray(statusPayload.links) && statusPayload.links.length > 0
            ? statusPayload.links
            : statusPayload.link
              ? [statusPayload.link]
              : [];
        setLiveStatus(statusPayload.status || 'OFF');
        setLiveLinks(nextLinks);
        setLiveDraftLinks((previous) =>
          previous.length > 0 ? previous : normalizeLiveLinkArray(nextLinks)
        );
        setLiveCategory(normalizeLiveCategory(statusPayload.category));
      } catch (error) {
        console.error('Error fetching live status:', error);
      }
    });
  }, [isOnline]);

  const fetchCategories = useCallback(async () => {
    if (!isOnline) {
      return;
    }

    await runSingleFlight(categoriesRequestRef, async () => {
      try {
        const response = await apiClient.get(apiUrl('/api/categories'), applyWorkspaceAuth());
        setCategories(response.data || []);
        setRequestError('');
      } catch (error) {
        if (handleRequestError(error, 'Unable to load categories.')) return;
        console.error('Error fetching categories:', error);
      }
    });
  }, [applyWorkspaceAuth, handleRequestError, isOnline]);

  const fetchUploadCapabilities = useCallback(async () => {
    if (!isOnline) {
      return;
    }

    await runSingleFlight(uploadCapabilitiesRequestRef, async () => {
      try {
        const response = await apiClient.get(apiUrl('/api/uploads/capabilities'), applyWorkspaceAuth());
        const payload = response.data || {};
        const nextMaxFileSizeBytes = Number.parseInt(payload.maxFileSizeBytes, 10);
        const nextMaxFileSizeMb = Number.parseInt(payload.maxFileSizeMb, 10);

        setUploadCapabilities({
          maxFileSizeBytes:
            Number.isFinite(nextMaxFileSizeBytes) && nextMaxFileSizeBytes > 0
              ? Math.min(nextMaxFileSizeBytes, MAX_ATTACHMENT_UPLOAD_BYTES)
              : MAX_ATTACHMENT_UPLOAD_BYTES,
          maxFileSizeMb:
            Number.isFinite(nextMaxFileSizeMb) && nextMaxFileSizeMb > 0
              ? Math.min(nextMaxFileSizeMb, MAX_ATTACHMENT_UPLOAD_MB)
              : MAX_ATTACHMENT_UPLOAD_MB
        });
      } catch (error) {
        if (error.response?.status === 401) {
          handleAuthFailure();
          return;
        }
        console.error('Error fetching upload capabilities:', error);
      }
    });
  }, [applyWorkspaceAuth, handleAuthFailure, isOnline]);

  const fetchDisplayUsers = useCallback(async () => {
    if (!isAdminWorkspace) {
      setDisplayUsers([]);
      return;
    }
    if (!isOnline) {
      return;
    }
    await runSingleFlight(displayUsersRequestRef, async () => {
      try {
        const response = await apiClient.get(apiUrl('/api/display-users'), applyWorkspaceAuth());
        setDisplayUsers(response.data || []);
        setRequestError('');
      } catch (error) {
        if (handleRequestError(error, 'Unable to load display users.')) return;
        console.error('Error fetching display users:', error);
      }
    });
  }, [applyWorkspaceAuth, handleRequestError, isAdminWorkspace, isOnline]);

  const fetchStaffUsers = useCallback(async () => {
    if (!isAdminWorkspace) {
      setStaffUsers([]);
      return;
    }
    if (!isOnline) {
      return;
    }
    await runSingleFlight(staffUsersRequestRef, async () => {
      try {
        const response = await apiClient.get(apiUrl('/api/staff-users'), applyWorkspaceAuth());
        setStaffUsers(response.data || []);
        setRequestError('');
      } catch (error) {
        if (handleRequestError(error, 'Unable to load staff users.')) return;
        console.error('Error fetching staff users:', error);
      }
    });
  }, [applyWorkspaceAuth, handleRequestError, isAdminWorkspace, isOnline]);

  const fetchMaintenanceAgentStatus = useCallback(async () => {
    if (!isOnline) {
      return;
    }

    await runSingleFlight(maintenanceAgentRequestRef, async () => {
      try {
        const response = await apiClient.get(
          apiUrl('/api/system/maintenance-agent'),
          applyWorkspaceAuth()
        );
        setMaintenanceAgentPayload(response.data || null);
        setMaintenanceAgentError('');
      } catch (error) {
        if (error.response?.status === 401) {
          handleAuthFailure();
          return;
        }
        setMaintenanceAgentError(extractApiError(error, 'Maintenance agent status is unavailable.'));
      }
    });
  }, [applyWorkspaceAuth, handleAuthFailure, isOnline]);

  const fetchPlatformStatus = useCallback(async () => {
    if (!isOnline) {
      return;
    }

    await runSingleFlight(platformStatusRequestRef, async () => {
      try {
        const response = await apiClient.get(apiUrl('/api/system/platform-status'), applyWorkspaceAuth());
        setPlatformStatusPayload(response.data || null);
        setPlatformStatusError('');
      } catch (error) {
        if (error.response?.status === 401) {
          handleAuthFailure();
          return;
        }
        setPlatformStatusError(extractApiError(error, 'Platform diagnostics are unavailable.'));
      }
    });
  }, [applyWorkspaceAuth, handleAuthFailure, isOnline]);

  const fetchOpsAgentStatus = useCallback(async () => {
    if (!isOnline) {
      return;
    }

    await runSingleFlight(opsAgentRequestRef, async () => {
      try {
        const response = await apiClient.get(apiUrl('/api/system/ops-agent'), applyWorkspaceAuth());
        setOpsAgentPayload(response.data || null);
        setOpsAgentError('');
      } catch (error) {
        if (error.response?.status === 401) {
          handleAuthFailure();
          return;
        }
        setOpsAgentError(extractApiError(error, 'Ops agent status is unavailable.'));
      }
    });
  }, [applyWorkspaceAuth, handleAuthFailure, isOnline]);

  const fetchOpsAgentSettings = useCallback(async () => {
    if (!isOnline) {
      return;
    }

    await runSingleFlight(opsAgentSettingsRequestRef, async () => {
      try {
        const response = await apiClient.get(apiUrl('/api/system/ops-agent/settings'), applyWorkspaceAuth());
        setOpsAgentSettings(response.data || null);
        setOpsAgentSettingsError('');
      } catch (error) {
        if (error.response?.status === 401) {
          handleAuthFailure();
          return;
        }
        setOpsAgentSettingsError(extractApiError(error, 'Ops agent settings are unavailable.'));
      }
    });
  }, [applyWorkspaceAuth, handleAuthFailure, isOnline]);

  const fetchOpsAgentHistory = useCallback(async () => {
    if (!isOnline) {
      return;
    }

    await runSingleFlight(opsAgentHistoryRequestRef, async () => {
      try {
        const response = await apiClient.get(
          apiUrl('/api/system/ops-agent/history'),
          applyWorkspaceAuth({ params: { limit: 10 } })
        );
        setOpsAgentHistory(Array.isArray(response.data?.items) ? response.data.items : []);
        setOpsAgentHistoryError('');
      } catch (error) {
        if (error.response?.status === 401) {
          handleAuthFailure();
          return;
        }
        setOpsAgentHistoryError(extractApiError(error, 'Ops agent history is unavailable.'));
      }
    });
  }, [applyWorkspaceAuth, handleAuthFailure, isOnline]);

  const updateOpsAgentSettings = useCallback(
    async (autoFixEnabled) => {
      if (!isAdminWorkspace) {
        setOpsAgentSettingsError('Only the admin workspace can change AI agent settings.');
        return;
      }
      if (!isOnline) {
        setOpsAgentSettingsError('Network appears offline. Waiting to reconnect...');
        return;
      }

      setOpsAgentSettingsPending(true);
      setOpsAgentSettingsError('');

      try {
        const response = await apiClient.put(
          apiUrl('/api/system/ops-agent/settings'),
          { autoFixEnabled: Boolean(autoFixEnabled) },
          applyWorkspaceAuth()
        );
        const payload = response.data || {};
        if (payload.settings) {
          setOpsAgentSettings(payload.settings);
        }
        if (payload.status) {
          setOpsAgentPayload(payload.status);
          if (payload.status.platform) {
            setPlatformStatusPayload(payload.status.platform);
          }
        }
        await fetchOpsAgentHistory();
      } catch (error) {
        if (error.response?.status === 401) {
          handleAuthFailure();
          return;
        }
        setOpsAgentSettingsError(extractApiError(error, 'Unable to update AI agent settings.'));
      } finally {
        setOpsAgentSettingsPending(false);
      }
    },
    [applyWorkspaceAuth, fetchOpsAgentHistory, handleAuthFailure, isAdminWorkspace, isOnline]
  );

  const runOpsAgentAction = useCallback(
    async (action) => {
      const actionId = String(action?.id || '').trim();
      if (!actionId) {
        return;
      }
      if (!isAdminWorkspace) {
        setOpsAgentError('Only the admin workspace can run ops actions.');
        return;
      }
      if (!isOnline) {
        setOpsAgentError('Network appears offline. Waiting to reconnect...');
        return;
      }

      setOpsAgentActionPending(actionId);
      setOpsAgentActionResult(null);
      setOpsAgentError('');

      try {
        await runSingleFlight(opsAgentActionRequestRef, async () => {
          const response = await apiClient.post(
            apiUrl(`/api/system/ops-agent/actions/${encodeURIComponent(actionId)}`),
            {},
            applyWorkspaceAuth()
          );
          const payload = response.data || {};
          const nextStatus = payload.status || null;
          if (nextStatus) {
            setOpsAgentPayload(nextStatus);
            if (nextStatus.platform) {
              setPlatformStatusPayload(nextStatus.platform);
            }
          }
          setOpsAgentActionResult(payload.result || null);
        });

        await fetchMaintenanceAgentStatus();
        await fetchOpsAgentSettings();
        await fetchPlatformStatus();
        await fetchOpsAgentStatus();
        await fetchOpsAgentHistory();
      } catch (error) {
        if (error.response?.status === 401) {
          handleAuthFailure();
          return;
        }
        setOpsAgentError(extractApiError(error, `Unable to run "${action?.label || actionId}".`));
      } finally {
        setOpsAgentActionPending('');
      }
    },
    [
      applyWorkspaceAuth,
      fetchMaintenanceAgentStatus,
      fetchOpsAgentHistory,
      fetchOpsAgentSettings,
      fetchOpsAgentStatus,
      fetchPlatformStatus,
      handleAuthFailure,
      isAdminWorkspace,
      isOnline
    ]
  );

  useEffect(() => {
    const hasWorkspaceSession = isStaffWorkspace ? hasStaffSession() : hasAdminSession();
    if (!hasWorkspaceSession) {
      navigate(workspaceLoginRoute);
      return;
    }

    fetchAnnouncements();
    fetchLiveStatus();
    fetchCategories();
    fetchUploadCapabilities();
    fetchMaintenanceAgentStatus();
    fetchOpsAgentSettings();
    fetchPlatformStatus();
    fetchOpsAgentStatus();
    fetchOpsAgentHistory();
    if (isAdminWorkspace) {
      fetchDisplayUsers();
      fetchStaffUsers();
    }
  }, [
    fetchAnnouncements,
    fetchCategories,
    fetchDisplayUsers,
    fetchLiveStatus,
    fetchMaintenanceAgentStatus,
    fetchOpsAgentHistory,
    fetchOpsAgentSettings,
    fetchOpsAgentStatus,
    fetchPlatformStatus,
    fetchStaffUsers,
    fetchUploadCapabilities,
    isAdminWorkspace,
    isStaffWorkspace,
    navigate,
    workspaceLoginRoute
  ]);

  useAdaptivePolling(fetchLiveStatus, {
    enabled: true,
    online: isOnline,
    visible: isPageVisible,
    immediate: false,
    baseIntervalMs: preferSocket ? 25000 : 6000,
    hiddenIntervalMs: 45000,
    offlineIntervalMs: 90000
  });

  useAdaptivePolling(fetchAnnouncements, {
    enabled: true,
    online: isOnline,
    visible: isPageVisible,
    immediate: false,
    baseIntervalMs: preferSocket ? 30000 : 8000,
    hiddenIntervalMs: 50000,
    offlineIntervalMs: 90000
  });

  useAdaptivePolling(fetchMaintenanceAgentStatus, {
    enabled: true,
    online: isOnline,
    visible: isPageVisible,
    immediate: false,
    baseIntervalMs: 45000,
    hiddenIntervalMs: 90000,
    offlineIntervalMs: 120000
  });

  useAdaptivePolling(fetchPlatformStatus, {
    enabled: true,
    online: isOnline,
    visible: isPageVisible,
    immediate: false,
    baseIntervalMs: 60000,
    hiddenIntervalMs: 120000,
    offlineIntervalMs: 150000
  });

  useAdaptivePolling(fetchOpsAgentStatus, {
    enabled: true,
    online: isOnline,
    visible: isPageVisible,
    immediate: false,
    baseIntervalMs: 45000,
    hiddenIntervalMs: 90000,
    offlineIntervalMs: 120000
  });

  useAdaptivePolling(fetchOpsAgentSettings, {
    enabled: true,
    online: isOnline,
    visible: isPageVisible,
    immediate: false,
    baseIntervalMs: 60000,
    hiddenIntervalMs: 120000,
    offlineIntervalMs: 150000
  });

  useAdaptivePolling(fetchOpsAgentHistory, {
    enabled: true,
    online: isOnline,
    visible: isPageVisible,
    immediate: false,
    baseIntervalMs: 60000,
    hiddenIntervalMs: 120000,
    offlineIntervalMs: 150000
  });

  useEffect(() => {
    const syncVisibleWorkspace = () => {
      if (!isOnline) return;
      fetchAnnouncements();
      fetchLiveStatus();
      fetchMaintenanceAgentStatus();
      fetchOpsAgentSettings();
      fetchPlatformStatus();
      fetchOpsAgentStatus();
      fetchOpsAgentHistory();
    };
    const handleOnline = () => {
      setRequestError('');
      fetchAnnouncements();
      fetchLiveStatus();
      fetchCategories();
      fetchMaintenanceAgentStatus();
      fetchOpsAgentSettings();
      fetchPlatformStatus();
      fetchOpsAgentStatus();
      fetchOpsAgentHistory();
      if (isAdminWorkspace) {
        fetchDisplayUsers();
        fetchStaffUsers();
      }
    };

    window.addEventListener('focus', syncVisibleWorkspace);
    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('focus', syncVisibleWorkspace);
      window.removeEventListener('online', handleOnline);
    };
  }, [
    fetchAnnouncements,
    fetchCategories,
    fetchDisplayUsers,
    fetchLiveStatus,
    fetchMaintenanceAgentStatus,
    fetchOpsAgentHistory,
    fetchOpsAgentSettings,
    fetchOpsAgentStatus,
    fetchPlatformStatus,
    fetchStaffUsers,
    isAdminWorkspace,
    isOnline
  ]);

  useEffect(() => {
    if (!socket) {
      setSocketConnected(false);
      return;
    }

    setSocketConnected(Boolean(socket.connected));

    const handleConnect = () => {
      setSocketConnected(true);
      fetchAnnouncements();
      fetchLiveStatus();
      fetchMaintenanceAgentStatus();
      fetchOpsAgentSettings();
      fetchPlatformStatus();
      fetchOpsAgentStatus();
      fetchOpsAgentHistory();
    };
    const handleDisconnect = () => {
      setSocketConnected(false);
    };
    const handleLiveUpdate = (payload) => {
      const nextLinks =
        Array.isArray(payload?.links) && payload.links.length > 0
          ? payload.links
          : payload?.link
            ? [payload.link]
            : [];
      setLiveStatus(payload?.status || 'OFF');
      setLiveLinks(nextLinks);
      setLiveDraftLinks((previous) =>
        previous.length > 0 ? previous : normalizeLiveLinkArray(nextLinks)
      );
      setLiveCategory(normalizeLiveCategory(payload?.category));
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('liveUpdate', handleLiveUpdate);
    socket.on('announcementUpdate', fetchAnnouncements);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('liveUpdate', handleLiveUpdate);
      socket.off('announcementUpdate', fetchAnnouncements);
    };
  }, [
    fetchAnnouncements,
    fetchLiveStatus,
    fetchMaintenanceAgentStatus,
    fetchOpsAgentHistory,
    fetchOpsAgentSettings,
    fetchOpsAgentStatus,
    fetchPlatformStatus,
    socket
  ]);

  useEffect(() => {
    return () => {
      revokeObjectUrls(mediaPreviewUrls);
      revokeObjectUrls(documentPreviewUrls);
    };
  }, [documentPreviewUrls, mediaPreviewUrls]);

  useEffect(() => {
    let cancelled = false;
    setMediaDimensionsByKey({});

    mediaFiles.forEach((file) => {
      const lookupKey = getDimensionLookupKey(file);
      detectMediaDimensions(file).then((dimensions) => {
        if (cancelled) {
          return;
        }

        setMediaDimensionsByKey((previous) => ({
          ...previous,
          [lookupKey]: {
            width: dimensions.width,
            height: dimensions.height
          }
        }));
      });
    });

    return () => {
      cancelled = true;
    };
  }, [mediaFiles]);

  const clearDropInteraction = useCallback(() => {
    windowFileDragDepthRef.current = 0;
    dropZoneDragDepthRef.current = {
      image: 0,
      video: 0,
      document: 0
    };
    setActiveDropZone('');
    setIsFileDragActive(false);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const handleWindowDragEnter = (event) => {
      if (!hasFileDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      windowFileDragDepthRef.current += 1;
      setIsFileDragActive(true);
    };

    const handleWindowDragOver = (event) => {
      if (!hasFileDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      setIsFileDragActive(true);
    };

    const handleWindowDragLeave = (event) => {
      if (!hasFileDragPayload(event.dataTransfer)) return;
      const nextDepth = Math.max(0, windowFileDragDepthRef.current - 1);
      windowFileDragDepthRef.current = nextDepth;

      if (
        nextDepth === 0 &&
        (!event.relatedTarget || event.relatedTarget === document.documentElement || event.relatedTarget === document.body)
      ) {
        clearDropInteraction();
      }
    };

    const handleWindowDrop = (event) => {
      if (!hasFileDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      clearDropInteraction();
    };

    const handleWindowBlur = () => {
      clearDropInteraction();
    };

    window.addEventListener('dragenter', handleWindowDragEnter);
    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('dragleave', handleWindowDragLeave);
    window.addEventListener('drop', handleWindowDrop);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('dragenter', handleWindowDragEnter);
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('dragleave', handleWindowDragLeave);
      window.removeEventListener('drop', handleWindowDrop);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [clearDropInteraction]);

  const clearSelectedAttachmentDrafts = () => {
    revokeObjectUrls(mediaPreviewUrls);
    revokeObjectUrls(documentPreviewUrls);
    clearDropInteraction();
    setMediaFiles([]);
    setMediaPreviewUrls([]);
    setMediaDimensionsByKey({});
    setDocumentFiles([]);
    setDocumentPreviewUrls([]);
    setMediaReplaceIndex(-1);
    setDocumentReplaceIndex(-1);
    if (mediaInputRef.current) mediaInputRef.current.value = '';
    if (videoInputRef.current) videoInputRef.current.value = '';
    if (mediaReplaceInputRef.current) mediaReplaceInputRef.current.value = '';
    if (documentInputRef.current) documentInputRef.current.value = '';
    if (documentReplaceInputRef.current) documentReplaceInputRef.current.value = '';
  };

  const resetForm = () => {
    setEditingId(null);
    setFormData({
      title: '',
      content: '',
      priority: 1,
      duration: 7,
      isActive: true,
      category: '',
      startAt: getDefaultStart(),
      endAt: getDefaultEnd()
    });
    setEditAttachmentRemoved(false);
    clearSelectedAttachmentDrafts();
    setAnnouncementLiveLinkInput('');
    setAnnouncementLiveLinks([]);
    setAnnouncementLiveInputError('');
  };

  const addAnnouncementLiveLinksFromInput = () => {
    const parsedLinks = parseLiveLinkList(announcementLiveLinkInput);
    if (parsedLinks.length === 0) {
      setAnnouncementLiveInputError(
        'Enter at least one valid YouTube, Vimeo, or Twitch link.'
      );
      setRequestError('');
      return;
    }

    const mergedLinks = normalizeLiveLinkArray([...announcementLiveLinks, ...parsedLinks]);
    setAnnouncementLiveLinks(mergedLinks);
    setAnnouncementLiveLinkInput('');
    setAnnouncementLiveInputError('');

    if (mergedLinks.length < announcementLiveLinks.length + parsedLinks.length) {
      setAnnouncementLiveInputError(`Announcement stream links are limited to ${MAX_LIVE_LINKS} unique links.`);
      setRequestError('');
      return;
    }
    setRequestError('');
  };

  const updateAnnouncementLiveLinkAt = (index, value) => {
    setAnnouncementLiveLinks((previous) =>
      previous.map((item, itemIndex) => (itemIndex === index ? String(value || '') : item))
    );
    setAnnouncementLiveInputError('');
  };

  const removeAnnouncementLiveLinkAt = (index) => {
    setAnnouncementLiveLinks((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
    setRequestError('');
    setAnnouncementLiveInputError('');
  };

  const clearAnnouncementLiveLinks = () => {
    setAnnouncementLiveLinks([]);
    setAnnouncementLiveLinkInput('');
    setRequestError('');
    setAnnouncementLiveInputError('');
  };

  const handleAnnouncementLiveInputKeyDown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addAnnouncementLiveLinksFromInput();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setRequestError('');

    try {
      const normalizedTitle = String(formData.title || '').trim();
      const normalizedContent = String(formData.content || '').trim();
      const pendingAnnouncementLinks = parseLiveLinkList(announcementLiveLinkInput);
      const editingAnnouncement = editingId
        ? announcements.find((announcement) => announcement.id === editingId)
        : null;
      const editingBatchSize = editingAnnouncement ? getBatchAttachmentCount(editingAnnouncement) : 1;
      const hasExistingAttachment = Boolean(
        editingAnnouncement && editingAnnouncement.image && !editAttachmentRemoved
      );
      const normalizedAnnouncementLiveLinks = normalizeLiveLinkArray([
        ...announcementLiveLinks,
        ...pendingAnnouncementLinks
      ]);
      const selectedMediaFiles = [...mediaFiles];
      const selectedDocumentFiles = [...documentFiles];
      const selectedAttachmentEntries = [
        ...selectedMediaFiles.map((file) => ({ file, kind: 'media' })),
        ...selectedDocumentFiles.map((file) => ({ file, kind: 'document' }))
      ];
      const hasNewAttachment = selectedAttachmentEntries.length > 0;

      if (announcementLiveLinkInput.trim() && pendingAnnouncementLinks.length === 0) {
        setAnnouncementLiveInputError(
          'The pending stream input is not a valid YouTube, Vimeo, or Twitch link.'
        );
        return;
      }
      setAnnouncementLiveInputError('');

      if (selectedAttachmentEntries.length > MAX_BATCH_ATTACHMENTS) {
        setRequestError(`You can upload up to ${MAX_BATCH_ATTACHMENTS} files at a time.`);
        return;
      }

      if (editingId && selectedAttachmentEntries.length > 1) {
        setRequestError('Editing mode supports only one replacement attachment.');
        return;
      }

      if (
        !normalizedTitle &&
        !normalizedContent &&
        !hasNewAttachment &&
        !hasExistingAttachment &&
        normalizedAnnouncementLiveLinks.length === 0
      ) {
        setRequestError('Add at least one: title, content, live stream, media, or document.');
        return;
      }

      const startAtIso = toApiDateTime(formData.startAt);
      const endAtIso = toApiDateTime(formData.endAt);

      const appendBaseFields = (payload, options = {}) => {
        payload.append('title', normalizedTitle);
        payload.append('content', normalizedContent);
        payload.append('priority', String(formData.priority));
        payload.append('duration', String(formData.duration));
        payload.append('active', String(formData.isActive));
        payload.append('category', formData.category || '');
        payload.append('liveStreamLinks', JSON.stringify(normalizedAnnouncementLiveLinks));
        if (options.removeAttachment) {
          payload.append('removeAttachment', 'true');
        }
        if (options.mediaWidth && options.mediaHeight) {
          payload.append('mediaWidth', String(options.mediaWidth));
          payload.append('mediaHeight', String(options.mediaHeight));
        }
        if (startAtIso) {
          payload.append('startAt', startAtIso);
        }
        if (endAtIso) {
          payload.append('endAt', endAtIso);
        }
        if (options.displayBatchId) {
          payload.append('displayBatchId', options.displayBatchId);
        }
        if (options.displayBatchSlot) {
          payload.append('displayBatchSlot', String(options.displayBatchSlot));
        }
      };

      const appendDirectUploadMetadata = (payload, directUploadPayload) => {
        if (!directUploadPayload) return;
        payload.append('attachmentUrl', directUploadPayload.attachmentUrl);
        payload.append('attachmentFileName', directUploadPayload.attachmentFileName);
        payload.append('attachmentMimeType', directUploadPayload.attachmentMimeType);
        payload.append('attachmentFileSizeBytes', String(directUploadPayload.attachmentFileSizeBytes || ''));
      };

      const appendAttachmentPayload = async (payload, file, kind) => {
        if (!file) return;

        let directUploadPayload = null;
        let shouldUseMultipartUpload = true;

        try {
          directUploadPayload = await uploadAttachmentToStorage(file);
          shouldUseMultipartUpload = false;
        } catch (uploadError) {
          const canFallbackToMultipart = file.size <= MULTIPART_FALLBACK_MAX_BYTES;
          if (!canFallbackToMultipart) {
            throw uploadError;
          }
          console.warn('Direct upload unavailable. Falling back to multipart upload.', uploadError);
        }

        if (directUploadPayload) {
          appendDirectUploadMetadata(payload, directUploadPayload);
          return;
        }

        if (shouldUseMultipartUpload) {
          payload.append(kind === 'document' ? 'document' : 'image', file);
        }
      };

      const submitLegacyMultipartBatch = async (displayBatchId, preparedEntries = []) => {
        for (let index = 0; index < preparedEntries.length; index += 1) {
          const entry = preparedEntries[index];
          const file = entry.file;
          const selectedKind = entry.kind;
          const payload = new FormData();
          appendBaseFields(payload, {
            mediaWidth: entry.mediaWidth,
            mediaHeight: entry.mediaHeight,
            displayBatchId,
            displayBatchSlot: index + 1
          });
          if (entry.directUploadPayload) {
            appendDirectUploadMetadata(payload, entry.directUploadPayload);
          } else {
            await appendAttachmentPayload(payload, file, selectedKind);
          }

          await apiClient.post(apiUrl('/api/announcements'), payload, {
            ...applyWorkspaceAuth({
              headers: { 'Content-Type': 'multipart/form-data' }
            })
          });
        }
      };

      if (editingId) {
        const payload = new FormData();
        const selectedEntry = selectedAttachmentEntries[0] || null;
        const selectedAttachment = selectedEntry ? selectedEntry.file : null;
        const selectedKind = selectedEntry ? selectedEntry.kind : 'media';
        const selectedDimensions =
          selectedAttachment && selectedKind === 'media'
            ? mediaDimensionsByKey[getDimensionLookupKey(selectedAttachment)] || {}
            : {};
        appendBaseFields(payload, {
          removeAttachment: editAttachmentRemoved,
          mediaWidth: selectedDimensions.width,
          mediaHeight: selectedDimensions.height
        });
        if (selectedAttachment) {
          await appendAttachmentPayload(payload, selectedAttachment, selectedKind);
        }

        const shouldUpdateBatchScope =
          Boolean(editingAnnouncement && editingAnnouncement.displayBatchId) &&
          editingBatchSize > 1 &&
          !selectedAttachment;
        await apiClient.put(apiUrl(`/api/announcements/${editingId}`), payload, {
          ...applyWorkspaceAuth({
            headers: { 'Content-Type': 'multipart/form-data' },
            params: shouldUpdateBatchScope ? { scope: 'batch' } : {}
          })
        });
      } else if (selectedAttachmentEntries.length > 1) {
        const displayBatchId = createDisplayBatchId();
        const preparedEntries = [];
        let shouldFallbackToLegacyMultipart = false;

        for (const entry of selectedAttachmentEntries) {
          const selectedDimensions =
            entry.kind === 'media'
              ? mediaDimensionsByKey[getDimensionLookupKey(entry.file)] || {}
              : {};
          try {
            const directUploadPayload = await uploadAttachmentToStorage(entry.file);
            preparedEntries.push({
              ...entry,
              directUploadPayload,
              mediaWidth: selectedDimensions.width,
              mediaHeight: selectedDimensions.height
            });
          } catch (uploadError) {
            const canFallbackToMultipart = entry.file.size <= MULTIPART_FALLBACK_MAX_BYTES;
            if (!canFallbackToMultipart) {
              throw uploadError;
            }
            shouldFallbackToLegacyMultipart = true;
            preparedEntries.push({
              ...entry,
              directUploadPayload: null,
              mediaWidth: selectedDimensions.width,
              mediaHeight: selectedDimensions.height
            });
          }
        }

        if (shouldFallbackToLegacyMultipart) {
          await submitLegacyMultipartBatch(displayBatchId, preparedEntries);
        } else {
          const batchPayload = {
            title: normalizedTitle,
            content: normalizedContent,
            priority: Number(formData.priority),
            duration: Number(formData.duration),
            active: Boolean(formData.isActive),
            category: formData.category || '',
            displayBatchId,
            liveStreamLinks: normalizedAnnouncementLiveLinks,
            attachments: preparedEntries.map((entry) => ({
              attachmentUrl: entry.directUploadPayload.attachmentUrl,
              attachmentFileName: entry.directUploadPayload.attachmentFileName,
              attachmentMimeType: entry.directUploadPayload.attachmentMimeType,
              attachmentFileSizeBytes: entry.directUploadPayload.attachmentFileSizeBytes,
              mediaWidth: entry.mediaWidth || null,
              mediaHeight: entry.mediaHeight || null
            }))
          };
          if (startAtIso) {
            batchPayload.startAt = startAtIso;
          }
          if (endAtIso) {
            batchPayload.endAt = endAtIso;
          }

          await apiClient.post(apiUrl('/api/announcements/batch'), batchPayload, applyWorkspaceAuth());
        }
      } else {
        const payload = new FormData();
        const selectedEntry = selectedAttachmentEntries[0] || null;
        const selectedAttachment = selectedEntry ? selectedEntry.file : null;
        const selectedKind = selectedEntry ? selectedEntry.kind : 'media';
        const selectedDimensions =
          selectedAttachment && selectedKind === 'media'
            ? mediaDimensionsByKey[getDimensionLookupKey(selectedAttachment)] || {}
            : {};
        appendBaseFields(payload, {
          mediaWidth: selectedDimensions.width,
          mediaHeight: selectedDimensions.height
        });
        if (selectedAttachment) {
          await appendAttachmentPayload(payload, selectedAttachment, selectedKind);
        }

        await apiClient.post(apiUrl('/api/announcements'), payload, {
          ...applyWorkspaceAuth({
            headers: { 'Content-Type': 'multipart/form-data' }
          })
        });
      }

      await fetchAnnouncements();
      resetForm();
    } catch (error) {
      if (!error.response && error.message) {
        setRequestError(error.message);
        return;
      }
      if (handleRequestError(error, 'Failed to save announcement.')) return;
      console.error('Error saving announcement:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (announcement) => {
    if (!announcement || !announcement.id) return;
    const batchItemCount = getBatchAttachmentCount(announcement);
    const isBatchDelete = batchItemCount > 1 && announcement.displayBatchId;
    const accepted = window.confirm(
      isBatchDelete
        ? `Delete this full announcement batch (${batchItemCount} attachments)?`
        : 'Delete this announcement?'
    );
    if (!accepted) return;

    try {
      setRequestError('');
      await apiClient.delete(
        apiUrl(`/api/announcements/${announcement.id}`),
        applyWorkspaceAuth({
          params: isBatchDelete ? { scope: 'batch' } : {}
        })
      );
      await fetchAnnouncements();
      if (editingId === announcement.id) {
        resetForm();
      }
    } catch (error) {
      if (handleRequestError(error, 'Failed to delete announcement.')) return;
      console.error('Error deleting announcement:', error);
    }
  };

  const handleEdit = (announcement) => {
    setEditingId(announcement.id);
    setFormData({
      title: announcement.title || '',
      content: announcement.content || '',
      priority: announcement.priority ?? 1,
      duration: announcement.duration ?? 7,
      isActive: announcement.isActive !== false,
      category: announcement.category || '',
      startAt: toInputDateTime(announcement.startAt),
      endAt: toInputDateTime(announcement.endAt)
    });
    setEditAttachmentRemoved(false);
    clearSelectedAttachmentDrafts();
    setAnnouncementLiveLinkInput('');
    setAnnouncementLiveLinks(normalizeLiveLinkArray(announcement.liveStreamLinks || []));
    setAnnouncementLiveInputError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const discardReplacementAttachment = () => {
    clearSelectedAttachmentDrafts();
    setEditAttachmentRemoved(false);
    setRequestError('');
  };

  const removeExistingAttachment = () => {
    if (!editingAnnouncementPreview?.image) {
      return;
    }
    if (!canRemoveEditingAttachment) {
      setRequestError('Batch items cannot remove the current attachment. Replace the file instead.');
      return;
    }
    clearSelectedAttachmentDrafts();
    setEditAttachmentRemoved(true);
    setRequestError('');
  };

  const appendMediaFiles = (incomingFiles, mode = 'all') => {
    if (!Array.isArray(incomingFiles) || incomingFiles.length === 0) {
      return;
    }
    if (!validateUploadSize(incomingFiles)) {
      return;
    }

    const filteredFiles = incomingFiles.filter((file) => {
      if (!file) return false;
      if (mode === 'image') return isImageFile(file);
      if (mode === 'video') return isVideoFile(file);
      return isLikelyMediaFile(file);
    });

    if (filteredFiles.length === 0) {
      setRequestError(
        mode === 'video'
          ? 'Please select video files only in Video Upload.'
          : mode === 'image'
            ? 'Please select image files only in Image Upload.'
            : 'Please select image or video files in Media Upload.'
      );
      return;
    }

    if (filteredFiles.length !== incomingFiles.length) {
      setRequestError(
        mode === 'video'
          ? 'Some non-video files were ignored. Only video files were added.'
          : mode === 'image'
            ? 'Some non-image files were ignored. Only image files were added.'
            : 'Some non-media files were ignored. Only image/video files were added.'
      );
    } else {
      setRequestError('');
    }

    if (editingId) {
      const selectedFile = filteredFiles[0] || null;
      if (!selectedFile) return;

      revokeObjectUrls(mediaPreviewUrls);
      revokeObjectUrls(documentPreviewUrls);
      setMediaFiles([selectedFile]);
      setMediaPreviewUrls([URL.createObjectURL(selectedFile)]);
      setDocumentFiles([]);
      setDocumentPreviewUrls([]);
      setEditAttachmentRemoved(false);
      if (filteredFiles.length > 1 || incomingFiles.length > 1) {
        setRequestError('Editing mode supports only one replacement attachment.');
      }
      return;
    }

    const remainingSlotCount = Math.max(0, MAX_BATCH_ATTACHMENTS - (mediaFiles.length + documentFiles.length));
    if (remainingSlotCount <= 0) {
      setRequestError(
        `Total attachments cannot exceed ${MAX_BATCH_ATTACHMENTS}. Remove existing media/document items first.`
      );
      return;
    }

    const boundedFiles = filteredFiles.slice(0, remainingSlotCount);
    if (filteredFiles.length > remainingSlotCount) {
      setRequestError(
        `Only ${remainingSlotCount} more attachment${remainingSlotCount === 1 ? '' : 's'} can be added.`
      );
    }

    if (boundedFiles.length === 0) return;

    const nextPreviewUrls = boundedFiles.map((file) => URL.createObjectURL(file));
    setMediaFiles((previous) => [...previous, ...boundedFiles]);
    setMediaPreviewUrls((previous) => [...previous, ...nextPreviewUrls]);
  };

  const appendDocumentFiles = (incomingFiles) => {
    if (!Array.isArray(incomingFiles) || incomingFiles.length === 0) return;
    if (!validateUploadSize(incomingFiles)) {
      return;
    }

    const invalidMediaFile = incomingFiles.find((file) => {
      const mime = String(file.type || '').toLowerCase();
      return mime.startsWith('image/') || mime.startsWith('video/');
    });
    if (invalidMediaFile) {
      setRequestError('Please use the Image Upload or Video Upload field for image/video files.');
      return;
    }

    if (editingId) {
      const selectedFile = incomingFiles[0] || null;
      if (!selectedFile) return;

      revokeObjectUrls(mediaPreviewUrls);
      revokeObjectUrls(documentPreviewUrls);
      setMediaFiles([]);
      setMediaPreviewUrls([]);
      setMediaDimensionsByKey({});
      setDocumentFiles([selectedFile]);
      setDocumentPreviewUrls([URL.createObjectURL(selectedFile)]);
      setEditAttachmentRemoved(false);
      setRequestError(
        incomingFiles.length > 1 ? 'Editing mode supports only one replacement attachment.' : ''
      );
      return;
    }

    const remainingSlotCount = Math.max(0, MAX_BATCH_ATTACHMENTS - (mediaFiles.length + documentFiles.length));
    if (remainingSlotCount <= 0) {
      setRequestError(
        `Total attachments cannot exceed ${MAX_BATCH_ATTACHMENTS}. Remove existing media/document items first.`
      );
      return;
    }

    const boundedFiles = incomingFiles.slice(0, remainingSlotCount);
    if (incomingFiles.length > remainingSlotCount) {
      setRequestError(
        `Only ${remainingSlotCount} more attachment${remainingSlotCount === 1 ? '' : 's'} can be added.`
      );
    } else {
      setRequestError('');
    }

    if (boundedFiles.length === 0) return;

    const nextPreviewUrls = boundedFiles.map((file) => URL.createObjectURL(file));
    setDocumentFiles((previous) => [...previous, ...boundedFiles]);
    setDocumentPreviewUrls((previous) => [...previous, ...nextPreviewUrls]);
  };

  const openUploadPicker = (zone) => {
    if (zone === 'image') {
      mediaInputRef.current?.click();
      return;
    }
    if (zone === 'video') {
      videoInputRef.current?.click();
      return;
    }
    if (zone === 'document') {
      documentInputRef.current?.click();
    }
  };

  const handleDropZoneDragEnter = (zone) => (event) => {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dropZoneDragDepthRef.current[zone] = (dropZoneDragDepthRef.current[zone] || 0) + 1;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    setIsFileDragActive(true);
    setActiveDropZone(zone);
  };

  const handleDropZoneDragOver = (zone) => (event) => {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    setIsFileDragActive(true);
    setActiveDropZone(zone);
  };

  const handleDropZoneDragLeave = (zone) => (event) => {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const nextDepth = Math.max(0, (dropZoneDragDepthRef.current[zone] || 0) - 1);
    dropZoneDragDepthRef.current[zone] = nextDepth;
    if (nextDepth === 0) {
      setActiveDropZone((previous) => (previous === zone ? '' : previous));
    }
    const hasActiveZone = DROP_ZONE_KEYS.some((key) => (dropZoneDragDepthRef.current[key] || 0) > 0);
    if (!hasActiveZone && windowFileDragDepthRef.current === 0) {
      setIsFileDragActive(false);
    }
  };

  const handleDropZoneDrop = (zone) => (event) => {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    clearDropInteraction();

    const droppedFiles = extractDroppedFiles(event.dataTransfer);
    if (droppedFiles.length === 0) return;

    if (zone === 'document') {
      appendDocumentFiles(droppedFiles);
      return;
    }

    appendMediaFiles(droppedFiles, zone);
  };

  const handleImageChange = (event) => {
    const incomingFiles = Array.from(event.target.files || []);
    if (mediaInputRef.current) {
      mediaInputRef.current.value = '';
    }
    appendMediaFiles(incomingFiles, 'image');
  };

  const handleVideoChange = (event) => {
    const incomingFiles = Array.from(event.target.files || []);
    if (videoInputRef.current) {
      videoInputRef.current.value = '';
    }
    appendMediaFiles(incomingFiles, 'video');
  };

  const handleDocumentChange = (event) => {
    const incomingFiles = Array.from(event.target.files || []);
    if (documentInputRef.current) {
      documentInputRef.current.value = '';
    }
    appendDocumentFiles(incomingFiles);
  };

  const removeMediaAt = (index) => {
    if (index < 0 || index >= mediaFiles.length) return;

    setMediaFiles((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
    setMediaPreviewUrls((previous) => {
      const next = [...previous];
      const removed = next[index];
      if (removed) {
        URL.revokeObjectURL(removed);
      }
      next.splice(index, 1);
      return next;
    });
    setRequestError('');
  };

  const removeDocumentAt = (index) => {
    if (index < 0 || index >= documentFiles.length) return;

    setDocumentFiles((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
    setDocumentPreviewUrls((previous) => {
      const next = [...previous];
      const removed = next[index];
      if (removed) {
        URL.revokeObjectURL(removed);
      }
      next.splice(index, 1);
      return next;
    });
    setRequestError('');
  };

  const openMediaReplacePicker = (index) => {
    if (index < 0 || index >= mediaFiles.length) return;
    setMediaReplaceIndex(index);
    if (mediaReplaceInputRef.current) {
      mediaReplaceInputRef.current.value = '';
      mediaReplaceInputRef.current.click();
    }
  };

  const openDocumentReplacePicker = (index) => {
    if (index < 0 || index >= documentFiles.length) return;
    setDocumentReplaceIndex(index);
    if (documentReplaceInputRef.current) {
      documentReplaceInputRef.current.value = '';
      documentReplaceInputRef.current.click();
    }
  };

  const handleMediaReplaceChange = (event) => {
    const selectedFile = Array.from(event.target.files || [])[0] || null;
    const targetIndex = mediaReplaceIndex;
    setMediaReplaceIndex(-1);
    if (mediaReplaceInputRef.current) {
      mediaReplaceInputRef.current.value = '';
    }
    if (!selectedFile || targetIndex < 0 || targetIndex >= mediaFiles.length) {
      return;
    }

    const existingFile = mediaFiles[targetIndex];
    const existingIsVideo = isVideoFile(existingFile);
    const existingIsImage = isImageFile(existingFile);
    const selectedIsVideo = isVideoFile(selectedFile);
    const selectedIsImage = isImageFile(selectedFile);

    if (existingIsVideo && !selectedIsVideo) {
      setRequestError('Please choose a video file to replace this video item.');
      return;
    }
    if (existingIsImage && !selectedIsImage) {
      setRequestError('Please choose an image file to replace this image item.');
      return;
    }
    if (!selectedIsVideo && !selectedIsImage && !isLikelyMediaFile(selectedFile)) {
      setRequestError('Please choose an image or video file for media replacement.');
      return;
    }

    setMediaFiles((previous) =>
      previous.map((file, index) => (index === targetIndex ? selectedFile : file))
    );
    setMediaPreviewUrls((previous) => {
      const next = [...previous];
      if (next[targetIndex]) {
        URL.revokeObjectURL(next[targetIndex]);
      }
      next[targetIndex] = URL.createObjectURL(selectedFile);
      return next;
    });
    setEditAttachmentRemoved(false);
    setRequestError('');
  };

  const handleDocumentReplaceChange = (event) => {
    const selectedFile = Array.from(event.target.files || [])[0] || null;
    const targetIndex = documentReplaceIndex;
    setDocumentReplaceIndex(-1);
    if (documentReplaceInputRef.current) {
      documentReplaceInputRef.current.value = '';
    }
    if (!selectedFile || targetIndex < 0 || targetIndex >= documentFiles.length) {
      return;
    }

    const mime = String(selectedFile.type || '').toLowerCase();
    if (mime.startsWith('image/') || mime.startsWith('video/')) {
      setRequestError('Please use the Image Upload or Video Upload field for image/video files.');
      return;
    }

    setDocumentFiles((previous) =>
      previous.map((file, index) => (index === targetIndex ? selectedFile : file))
    );
    setDocumentPreviewUrls((previous) => {
      const next = [...previous];
      if (next[targetIndex]) {
        URL.revokeObjectURL(next[targetIndex]);
      }
      next[targetIndex] = URL.createObjectURL(selectedFile);
      return next;
    });
    setEditAttachmentRemoved(false);
    setRequestError('');
  };

  const addLiveDraftLinks = () => {
    const parsedLinks = parseLiveLinkList(liveLinkInput);
    if (parsedLinks.length === 0) {
      setLiveLinkInputError('Enter at least one valid YouTube, Vimeo, or Twitch link.');
      setRequestError('');
      return;
    }

    const merged = normalizeLiveLinkArray([...liveDraftLinks, ...parsedLinks]);
    setLiveDraftLinks(merged);
    setLiveLinkInput('');
    setLiveLinkInputError('');

    if (merged.length < liveDraftLinks.length + parsedLinks.length) {
      setLiveLinkInputError(`Live stream list is limited to ${MAX_LIVE_LINKS} unique links.`);
      setRequestError('');
      return;
    }

    setRequestError('');
  };

  const handleLiveInputKeyDown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addLiveDraftLinks();
  };

  const updateLiveDraftLinkAt = (index, value) => {
    setLiveDraftLinks((previous) =>
      previous.map((item, itemIndex) => (itemIndex === index ? String(value || '') : item))
    );
    setRequestError('');
    setLiveLinkInputError('');
  };

  const removeLiveDraftLinkAt = (index) => {
    setLiveDraftLinks((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
    setRequestError('');
    setLiveLinkInputError('');
  };

  const clearLiveDraftLinks = () => {
    setLiveDraftLinks([]);
    setLiveLinkInput('');
    setRequestError('');
    setLiveLinkInputError('');
  };

  const useCurrentLiveLinks = () => {
    if (!Array.isArray(liveLinks) || liveLinks.length === 0) {
      setRequestError('No active live links are available to copy.');
      return;
    }

    setLiveDraftLinks(normalizeLiveLinkArray(liveLinks));
    setLiveLinkInput('');
    setRequestError('');
    setLiveLinkInputError('');
  };

  const startLive = async () => {
    if (liveActionPending) {
      return;
    }
    const parsedLinks =
      liveDraftLinks.length > 0 ? normalizeLiveLinkArray(liveDraftLinks) : parseLiveLinkList(liveLinkInput);
    if (parsedLinks.length === 0) {
      setLiveLinkInputError('Add at least one supported live stream URL before starting.');
      setRequestError('');
      return;
    }

    setLiveLinkInputError('');
    setLiveActionPending('start');
    try {
      setRequestError('');
      const response = await apiClient.post(
        apiUrl('/api/start'),
        { link: parsedLinks[0], links: parsedLinks, category: liveCategory },
        applyWorkspaceAuth()
      );
      const statusPayload = response.data || {};
      const nextLinks =
        Array.isArray(statusPayload.links) && statusPayload.links.length > 0
          ? statusPayload.links
          : statusPayload.link
            ? [statusPayload.link]
            : parsedLinks;
      setLiveStatus(statusPayload.status || 'ON');
      setLiveLinks(nextLinks);
      setLiveDraftLinks(normalizeLiveLinkArray(nextLinks));
      setLiveCategory(normalizeLiveCategory(statusPayload.category || liveCategory));
      setLiveLinkInput('');
      if (statusPayload.warning) {
        setRequestError(String(statusPayload.warning));
      }
    } catch (error) {
      if (handleRequestError(error, 'Failed to start live feed.')) return;
      console.error('Error starting live:', error);
    } finally {
      setLiveActionPending('');
      await fetchLiveStatus();
    }
  };

  const stopLive = async () => {
    if (liveActionPending) {
      return;
    }
    setLiveActionPending('stop');
    try {
      setRequestError('');
      const response = await apiClient.post(apiUrl('/api/stop'), {}, applyWorkspaceAuth());
      setLiveStatus(response.data?.status || 'OFF');
      setLiveLinks([]);
      setLiveDraftLinks([]);
      setLiveCategory(normalizeLiveCategory(response.data?.category || 'all'));
      if (response.data?.warning) {
        setRequestError(String(response.data.warning));
      }
    } catch (error) {
      if (handleRequestError(error, 'Failed to stop live feed.')) return;
      console.error('Error stopping live:', error);
    } finally {
      setLiveActionPending('');
      await fetchLiveStatus();
    }
  };

  const addCategory = async () => {
    const trimmed = newCategory.trim();
    if (!trimmed) {
      setRequestError('Enter a category name first.');
      return;
    }
    if (categorySaving) return;

    setCategorySaving(true);
    setRequestError('');
    try {
      await apiClient.post(apiUrl('/api/categories'), { name: trimmed }, applyWorkspaceAuth());
      setNewCategory('');
      await fetchCategories();
    } catch (error) {
      if (handleRequestError(error, 'Failed to create category.')) return;
    } finally {
      setCategorySaving(false);
    }
  };

  const handleTopbarCategorySubmit = async (event) => {
    event.preventDefault();
    await addCategory();
  };

  const deleteCategory = async (id) => {
    const accepted = window.confirm('Delete this category?');
    if (!accepted) return false;

    setCategoryDeleting(true);
    setRequestError('');
    try {
      await apiClient.delete(apiUrl(`/api/categories/${id}`), applyWorkspaceAuth());
      await fetchCategories();
      if (deleteCategoryId === id) {
        setDeleteCategoryId('');
      }
      return true;
    } catch (error) {
      if (handleRequestError(error, 'Failed to delete category.')) return false;
      console.error('Error deleting category:', error);
      return false;
    } finally {
      setCategoryDeleting(false);
    }
  };

  const handleTopbarCategoryDelete = async (event) => {
    event.preventDefault();
    if (!deleteCategoryId) {
      setRequestError('Select a category to delete.');
      return;
    }
    await deleteCategory(deleteCategoryId);
  };

  const toggleEmergency = async (announcement) => {
    const nextPriority = announcement.priority === 0 ? 1 : 0;

    try {
      setRequestError('');
      const payload = new FormData();
      payload.append('priority', String(nextPriority));

      await apiClient.put(apiUrl(`/api/announcements/${announcement.id}`), payload, {
        ...applyWorkspaceAuth({
          headers: { 'Content-Type': 'multipart/form-data' }
        })
      });

      await fetchAnnouncements();
    } catch (error) {
      if (handleRequestError(error, 'Failed to update emergency status.')) return;
      console.error('Error changing emergency state:', error);
    }
  };

  const createDisplayUser = async (event) => {
    event.preventDefault();
    const username = accessForm.username.trim().toLowerCase();
    const password = accessForm.password.trim();
    const category = accessForm.category.trim();

    if (!username || !password || !category) {
      setRequestError('Username, password, and category are required.');
      return;
    }

    setAccessSaving(true);
    setRequestError('');
    try {
      await apiClient.post(
        apiUrl('/api/display-users'),
        { username, password, category },
        applyWorkspaceAuth()
      );
      setAccessForm({ username: '', password: '', category: '' });
      await fetchDisplayUsers();
    } catch (error) {
      if (handleRequestError(error, 'Failed to create display access user.')) return;
    } finally {
      setAccessSaving(false);
    }
  };

  const deleteDisplayUser = async (id) => {
    const accepted = window.confirm('Delete this display access user?');
    if (!accepted) return;

    try {
      setRequestError('');
      await apiClient.delete(apiUrl(`/api/display-users/${id}`), applyWorkspaceAuth());
      await fetchDisplayUsers();
    } catch (error) {
      if (handleRequestError(error, 'Failed to delete display access user.')) return;
    }
  };

  const createStaffUser = async (event) => {
    event.preventDefault();
    const username = staffAccessForm.username.trim().toLowerCase();
    const password = staffAccessForm.password.trim();

    if (!username || !password) {
      setRequestError('Username and password are required.');
      return;
    }

    setStaffAccessSaving(true);
    setRequestError('');
    try {
      await apiClient.post(apiUrl('/api/staff-users'), { username, password }, applyWorkspaceAuth());
      setStaffAccessForm({ username: '', password: '' });
      await fetchStaffUsers();
    } catch (error) {
      if (handleRequestError(error, 'Failed to create staff access user.')) return;
    } finally {
      setStaffAccessSaving(false);
    }
  };

  const deleteStaffUser = async (id) => {
    const accepted = window.confirm('Delete this staff access user?');
    if (!accepted) return;

    try {
      setRequestError('');
      await apiClient.delete(apiUrl(`/api/staff-users/${id}`), applyWorkspaceAuth());
      await fetchStaffUsers();
    } catch (error) {
      if (handleRequestError(error, 'Failed to delete staff access user.')) return;
    }
  };

  const handleLogout = async () => {
    const logoutEndpoint = isStaffWorkspace ? '/api/staff-auth/logout' : '/api/auth/logout';
    try {
      await apiClient.post(apiUrl(logoutEndpoint), {}, applyWorkspaceAuth());
    } catch (error) {
      console.error('Error logging out:', error);
    } finally {
      clearWorkspaceSession();
      navigate(workspaceLoginRoute);
    }
  };

  return (
    <div className="app-shell app-shell--admin fade-up">
      <header className={`topbar topbar--admin card${isStaffWorkspace ? ' topbar--staff' : ' topbar--admin-v2'}`}>
        {isAdminWorkspace ? (
          <>
            <div className="topbar__brand topbar__brand--admin topbar-admin__intro topbar-admin-v2__left">
              <p className="topbar__eyebrow">Control Workspace</p>
              <h1 className="topbar__title">Digital Notice Board Admin</h1>
              <p className="topbar__subtitle">Manage the credentials and view History of the announcements</p>
              <div className="topbar-admin__kpis">
                <span className="pill pill--info">Total: {summary.total}</span>
                <span className="pill pill--success">Active: {summary.active}</span>
                <span className="pill pill--danger">Emergency: {summary.emergency}</span>
              </div>
            </div>

            <div className="topbar-admin-v2__middle">
              <TopbarStatus className="topbar-status--admin" />
              <div className="topbar-admin-v2__category">
                <div className="topbar-admin__category-head">
                  <span className="topbar__mini-heading">Category controls</span>
                </div>
                <form className="topbar-category-form" onSubmit={handleTopbarCategorySubmit}>
                  <input
                    type="text"
                    value={newCategory}
                    onChange={(event) => setNewCategory(event.target.value)}
                    placeholder="New category"
                    aria-label="New category name"
                  />
                  <button className="btn btn--primary btn--tiny" type="submit" disabled={categorySaving}>
                    {categorySaving ? 'Adding...' : 'Add'}
                  </button>
                </form>
                <form className="topbar-category-form" onSubmit={handleTopbarCategoryDelete}>
                  <select
                    value={deleteCategoryId}
                    onChange={(event) => setDeleteCategoryId(event.target.value)}
                    aria-label="Select category to delete"
                    disabled={categories.length === 0 || categoryDeleting}
                  >
                    <option value="">
                      {categories.length === 0 ? 'No categories' : 'Select to delete'}
                    </option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn--danger btn--tiny"
                    type="submit"
                    disabled={!deleteCategoryId || categoryDeleting}
                  >
                    {categoryDeleting ? 'Deleting...' : 'Delete'}
                  </button>
                </form>
              </div>
            </div>

            <div className="topbar-admin-v2__right">
              <div className="topbar-admin-v2__right-row">
                <button className="btn btn--ghost btn--tiny" type="button" onClick={() => navigate('/display/login')}>
                  Open Display
                </button>
                <button className="btn btn--ghost btn--tiny" type="button" onClick={toggleTheme}>
                  {isDark ? 'Light Mode' : 'Dark Mode'}
                </button>
              </div>

              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => setShowAccessManager((value) => !value)}
              >
                Credentials
              </button>

              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => navigate(workspaceHistoryRoute)}
              >
                View History
              </button>

              <button
                className="btn btn--danger topbar__logout topbar__logout--wide"
                type="button"
                onClick={handleLogout}
              >
                Logout
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="topbar__brand topbar__brand--admin topbar-admin__intro">
              <p className="topbar__eyebrow">Staff Workspace</p>
              <h1 className="topbar__title">Digital Notice Board Staff Dashboard</h1>
              <p className="topbar__subtitle">Publish announcements and control live media with staff permissions.</p>
              <div className="topbar-admin__kpis">
                <span className="pill pill--info">Total: {summary.total}</span>
                <span className="pill pill--success">Active: {summary.active}</span>
                <span className="pill pill--danger">Emergency: {summary.emergency}</span>
              </div>
            </div>

            <div className="topbar-admin__status-column">
              <TopbarStatus className="topbar-status--admin" />
            </div>

            <div className="topbar__workspace topbar-admin__center">
              <div className="topbar__control-row">
                <div className="topbar__actions topbar__actions--admin topbar-admin__actions">
                  <div className="topbar-admin__action-row topbar-admin__action-row--staff-main">
                    <button className="btn btn--ghost btn--tiny" type="button" onClick={toggleTheme}>
                      {isDark ? 'Light Mode' : 'Dark Mode'}
                    </button>
                    <button
                      className="btn btn--ghost btn--tiny"
                      type="button"
                      onClick={() => navigate(workspaceHistoryRoute)}
                    >
                      View History
                    </button>
                    <button
                      className="btn btn--ghost btn--tiny"
                      type="button"
                      onClick={() => navigate('/display/login')}
                    >
                      Open Display
                    </button>
                  </div>

                  <button
                    className="btn btn--danger topbar__logout topbar__logout--wide"
                    type="button"
                    onClick={handleLogout}
                  >
                    Logout
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </header>

      {requestError ? <div className="auth-error">{requestError}</div> : null}

      {showAccessManager && isAdminWorkspace ? (
        <section className="card section fade-up-delay">
          <div className="section-title">
            <div className="section-title__text">
              <h2>{credentialsSection === 'display' ? 'Display Access Credentials' : 'Staff Access Credentials'}</h2>
              <p>
                {credentialsSection === 'display'
                  ? 'Create username/password accounts and assign one category per credential.'
                  : 'Create staff credentials for staff dashboard access.'}
              </p>
            </div>
            <div className="inline-actions">
              <button
                className={credentialsSection === 'display' ? 'btn btn--primary btn--tiny' : 'btn btn--ghost btn--tiny'}
                type="button"
                onClick={() => setCredentialsSection('display')}
              >
                Display Access
              </button>
              <button
                className={credentialsSection === 'staff' ? 'btn btn--primary btn--tiny' : 'btn btn--ghost btn--tiny'}
                type="button"
                onClick={() => setCredentialsSection('staff')}
              >
                Staff Access
              </button>
              <span className="pill pill--info">
                {credentialsSection === 'display' ? displayUsers.length : staffUsers.length} users
              </span>
            </div>
          </div>

          {credentialsSection === 'display' ? (
            <>
              <form className="access-user-form" onSubmit={createDisplayUser}>
                <div className="field">
                  <label htmlFor="display-user-username">Username</label>
                  <input
                    id="display-user-username"
                    type="text"
                    value={accessForm.username}
                    onChange={(event) =>
                      setAccessForm((prev) => ({ ...prev, username: event.target.value }))
                    }
                    placeholder="display_user"
                    required
                  />
                </div>

                <div className="field">
                  <label htmlFor="display-user-password">Password</label>
                  <input
                    id="display-user-password"
                    type="text"
                    value={accessForm.password}
                    onChange={(event) =>
                      setAccessForm((prev) => ({ ...prev, password: event.target.value }))
                    }
                    placeholder="minimum 6 characters"
                    required
                  />
                </div>

                <div className="field">
                  <label htmlFor="display-user-category">Category</label>
                  <select
                    id="display-user-category"
                    value={accessForm.category}
                    onChange={(event) =>
                      setAccessForm((prev) => ({ ...prev, category: event.target.value }))
                    }
                    required
                  >
                    <option value="">Select category</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={accessSaving || categories.length === 0}
                >
                  {accessSaving ? 'Creating...' : 'Create'}
                </button>
              </form>
              {categories.length === 0 ? (
                <p className="file-help">Create at least one category before creating credentials.</p>
              ) : null}

              {displayUsers.length === 0 ? (
                <div className="empty-state">No display access users yet.</div>
              ) : (
                <div className="access-user-grid">
                  {displayUsers.map((user) => (
                    <article key={user.id} className="access-user-card">
                      <p className="access-user-card__name">{user.username}</p>
                      <p className="access-user-card__meta">
                        Category:{' '}
                        {user.categoryName ||
                          categories.find((category) => category.id === user.categoryId)?.name ||
                          'Unknown'}
                      </p>
                      <p className="access-user-card__meta">
                        Created: {new Date(user.createdAt || Date.now()).toLocaleString()}
                      </p>
                      <button
                        className="btn btn--danger btn--tiny"
                        type="button"
                        onClick={() => deleteDisplayUser(user.id)}
                      >
                        Delete
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <form className="access-user-form access-user-form--staff" onSubmit={createStaffUser}>
                <div className="field">
                  <label htmlFor="staff-user-username">Username</label>
                  <input
                    id="staff-user-username"
                    type="text"
                    value={staffAccessForm.username}
                    onChange={(event) =>
                      setStaffAccessForm((prev) => ({ ...prev, username: event.target.value }))
                    }
                    placeholder="staff_user"
                    required
                  />
                </div>

                <div className="field">
                  <label htmlFor="staff-user-password">Password</label>
                  <input
                    id="staff-user-password"
                    type="text"
                    value={staffAccessForm.password}
                    onChange={(event) =>
                      setStaffAccessForm((prev) => ({ ...prev, password: event.target.value }))
                    }
                    placeholder="minimum 6 characters"
                    required
                  />
                </div>

                <button className="btn btn--primary" type="submit" disabled={staffAccessSaving}>
                  {staffAccessSaving ? 'Creating...' : 'Create'}
                </button>
              </form>

              {staffUsers.length === 0 ? (
                <div className="empty-state">No staff access users yet.</div>
              ) : (
                <div className="access-user-grid">
                  {staffUsers.map((user) => (
                    <article key={user.id} className="access-user-card">
                      <p className="access-user-card__name">{user.username}</p>
                      <p className="access-user-card__meta">Role: Staff Dashboard</p>
                      <p className="access-user-card__meta">
                        Created: {new Date(user.createdAt || Date.now()).toLocaleString()}
                      </p>
                      <button
                        className="btn btn--danger btn--tiny"
                        type="button"
                        onClick={() => deleteStaffUser(user.id)}
                      >
                        Delete
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      ) : null}

      <section className="card section fade-up-delay">
        <div className="section-title">
          <div className="section-title__text">
            <h2>AI Agent Control Center</h2>
            <p>Compact monitoring for health, repairs, and AI agent activity.</p>
          </div>
          <div className="inline-actions">
            <span className={maintenanceAgentPillClass}>Runtime {maintenanceAgentState.toUpperCase()}</span>
            <span className={platformPillClass}>Platform {platformState.toUpperCase()}</span>
            <span className={opsAgentPillClass}>Ops {opsAgentState.toUpperCase()}</span>
            <button
              className="btn btn--ghost btn--tiny"
              type="button"
              onClick={() => setShowAgentCenterDetails((value) => !value)}
            >
              {showAgentCenterDetails ? 'Hide AI Details' : 'Show AI Details'}
            </button>
          </div>
        </div>

        <div className="agent-console agent-console--compact">
          <div className="agent-console__summary">
            <article className="agent-console__summary-card">
              <span className="agent-console__summary-label">Runtime</span>
              <strong>{maintenanceAgentState.toUpperCase()}</strong>
              <span className="agent-action-card__meta">
                API {formatLatencyLabel(maintenanceAgentChecks?.api?.latencyMs)} • DB {maintenanceAgentDatabaseStatus}
              </span>
            </article>
            <article className="agent-console__summary-card">
              <span className="agent-console__summary-label">Auto-Fix</span>
              <strong>{opsAgentAutoFixLabel}</strong>
              <span className="agent-action-card__meta">
                Interval {opsAgentRuntimeSettings?.intervalMs || 'manual'}ms
              </span>
            </article>
            <article className="agent-console__summary-card">
              <span className="agent-console__summary-label">Recommendations</span>
              <strong>{opsAgentRecommendations.length}</strong>
              <span className="agent-action-card__meta">
                {opsActionCards.filter((action) => action.available).length} actions available
              </span>
            </article>
            <article className="agent-console__summary-card">
              <span className="agent-console__summary-label">Last Repair</span>
              <strong>{opsAgentLastRepair?.label || 'No repairs yet'}</strong>
              <span className="agent-action-card__meta">
                {opsAgentLastRepair?.completedAt
                  ? formatAgentRelativeTime(opsAgentLastRepair.completedAt)
                  : 'Waiting for first run'}
              </span>
            </article>
          </div>

          <div className="inline-actions">
            <button
              className="btn btn--ghost btn--tiny"
              type="button"
              onClick={() => {
                fetchMaintenanceAgentStatus();
                fetchPlatformStatus();
                fetchOpsAgentStatus();
                fetchOpsAgentSettings();
                fetchOpsAgentHistory();
              }}
              disabled={Boolean(opsAgentActionPending) || opsAgentSettingsPending}
            >
              Refresh Diagnostics
            </button>
            {isAdminWorkspace ? (
              <button
                className="btn btn--primary btn--tiny"
                type="button"
                onClick={() =>
                  updateOpsAgentSettings(!(opsAgentRuntimeSettings?.requestedAutoFixEnabled === true))
                }
                disabled={opsAgentSettingsPending || opsAgentRuntimeSettings?.serverless === true}
                title={
                  opsAgentRuntimeSettings?.serverless
                    ? 'Serverless runtime keeps auto-fix in manual mode.'
                    : 'Toggle AI agent auto-fix mode.'
                }
              >
                {opsAgentSettingsPending
                  ? 'Saving...'
                  : opsAgentRuntimeSettings?.requestedAutoFixEnabled
                    ? 'Disable Auto-Fix'
                    : 'Enable Auto-Fix'}
              </button>
            ) : null}
            <button
              className="btn btn--ghost btn--tiny"
              type="button"
              onClick={() => navigate(workspaceHistoryRoute)}
            >
              Open Full History
            </button>
          </div>

          {opsAgentSummary?.message ? <p className="file-help">{opsAgentSummary.message}</p> : null}
          {opsAgentActionResult ? (
            <p className={opsAgentActionResult.success ? 'file-help' : 'field-error'}>
              Action result: {opsAgentActionResult.message}
            </p>
          ) : null}
          {maintenanceAgentError ? <p className="field-error">{maintenanceAgentError}</p> : null}
          {platformStatusError ? <p className="field-error">{platformStatusError}</p> : null}
          {opsAgentError ? <p className="field-error">{opsAgentError}</p> : null}
          {opsAgentSettingsError ? <p className="field-error">{opsAgentSettingsError}</p> : null}
          {opsAgentHistoryError ? <p className="field-error">{opsAgentHistoryError}</p> : null}

          {showAgentCenterDetails ? (
            <div className="agent-console__details">
              <details className="agent-disclosure" open>
                <summary className="agent-disclosure__summary">
                  <span>Control</span>
                  <span className="pill pill--info">Auto-fix {opsAgentAutoFixLabel}</span>
                </summary>
                <div className="agent-disclosure__body">
                  <div className="agent-console__chips">
                    <span className="pill">Mode: {maintenanceAgentMode}</span>
                    <span className="pill">API: {formatLatencyLabel(maintenanceAgentChecks?.api?.latencyMs)}</span>
                    <span className="pill">Network: {formatLatencyLabel(maintenanceAgentChecks?.network?.latencyMs)}</span>
                    <span className="pill">Checks: {opsAgentSummary?.checksCompleted || 0}</span>
                    <span className="pill">Repairs: {opsAgentSummary?.repairsSucceeded || 0}</span>
                    <span className="pill">Ops failed: {opsAgentSummary?.repairsFailed || 0}</span>
                    <span className="pill">Runtime failures: {maintenanceAgentFailures}</span>
                    <span className="pill">Cooldown: {opsAgentRuntimeSettings?.cooldownMs || 'n/a'}ms</span>
                    <span className="pill">Interval: {opsAgentRuntimeSettings?.intervalMs || 'manual'}ms</span>
                    <span className="pill">Runtime DB: {maintenanceAgentDatabaseStatus}</span>
                    {maintenanceAgentSource ? <span className="pill">Source: {maintenanceAgentSource}</span> : null}
                  </div>
                  {opsAgentLastRepair ? (
                    <p className={opsAgentLastRepair.success ? 'file-help' : 'field-error'}>
                      Last repair: {opsAgentLastRepair.label} {opsAgentLastRepair.success ? 'succeeded' : 'failed'}{' '}
                      {formatAgentRelativeTime(opsAgentLastRepair.completedAt)}. {opsAgentLastRepair.message}
                    </p>
                  ) : null}
                </div>
              </details>

              <details className="agent-disclosure">
                <summary className="agent-disclosure__summary">
                  <span>AI Insights</span>
                  <span className="pill">{opsAgentInsights.length}</span>
                </summary>
                <div className="agent-disclosure__body">
                  {opsAgentInsights.length > 0 ? (
                    <div className="agent-insight-list">
                      {opsAgentInsights.map((insight) => (
                        <article className="agent-insight-card" key={insight.id || insight.title}>
                          <div className="agent-insight-card__head">
                            <h4>{insight.title}</h4>
                            <span className={getInsightPillClass(insight.severity)}>
                              {String(insight.severity || 'info').toUpperCase()}
                            </span>
                          </div>
                          <p className="agent-action-card__copy">{insight.message}</p>
                          {insight.actionId ? (
                            <p className="agent-action-card__meta">Suggested action: {insight.actionId}</p>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="file-help">No AI insights are available yet.</p>
                  )}
                </div>
              </details>

              <details className="agent-disclosure">
                <summary className="agent-disclosure__summary">
                  <span>Repair Actions</span>
                  <span className="pill">{opsActionCards.length}</span>
                </summary>
                <div className="agent-disclosure__body">
                  {opsActionCards.length > 0 ? (
                    <div className="agent-action-grid">
                      {opsActionCards.map((action) => (
                        <article className="agent-action-card" key={action.id}>
                          <div className="agent-action-card__head">
                            <h4>{action.label}</h4>
                            <span className={action.recommended ? 'pill pill--info' : action.available ? 'pill pill--success' : 'pill'}>
                              {action.recommended ? 'Recommended' : action.available ? 'Available' : 'Unavailable'}
                            </span>
                          </div>
                          <p className="agent-action-card__copy">{action.description}</p>
                          <p className="agent-action-card__meta">{action.reason || 'No extra details available.'}</p>
                          <button
                            className="btn btn--ghost btn--tiny"
                            type="button"
                            onClick={() => runOpsAgentAction(action)}
                            disabled={!isAdminWorkspace || !action.available || Boolean(opsAgentActionPending)}
                            title={!isAdminWorkspace ? 'Admin workspace required.' : action.reason || action.description || action.label}
                          >
                            {opsAgentActionPending === action.id ? `Running ${action.label}...` : `Run ${action.label}`}
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="file-help">No repair actions are available in this environment.</p>
                  )}
                </div>
              </details>

              <details className="agent-disclosure">
                <summary className="agent-disclosure__summary">
                  <span>Platform Monitoring</span>
                  <span className="pill">{platformIntegrationCards.length}</span>
                </summary>
                <div className="agent-disclosure__body">
                  <div className="agent-integration-list">
                    {platformIntegrationCards.map((integration) => (
                      <article className="agent-integration-card" key={integration.id}>
                        <div className="agent-integration-card__head">
                          <h4>{integration.label}</h4>
                          <span className={getStatusPillClass(integration.status)}>
                            {String(integration.status || 'unknown').toUpperCase()}
                          </span>
                        </div>
                        <p className="agent-action-card__copy">{integration.message}</p>
                        <p className="agent-action-card__meta">Latency: {formatLatencyLabel(integration.latencyMs)}</p>
                      </article>
                    ))}
                  </div>
                </div>
              </details>

              <details className="agent-disclosure">
                <summary className="agent-disclosure__summary">
                  <span>Guardrails</span>
                  <span className="pill">{opsAgentGuardrails.length}</span>
                </summary>
                <div className="agent-disclosure__body">
                  <div className="agent-console__chips">
                    {Object.entries(opsAgentCapabilities)
                      .filter(([, enabled]) => enabled === true)
                      .map(([key]) => (
                        <span className="pill pill--success" key={`capability-${key}`}>
                          {key.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase())}
                        </span>
                      ))}
                  </div>
                  {opsAgentGuardrails.length > 0 ? (
                    <div className="agent-guardrail-list">
                      {opsAgentGuardrails.map((guardrail, index) => (
                        <div className="agent-guardrail-item" key={`guardrail-${index}`}>
                          {guardrail}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="file-help">No guardrail details are available.</p>
                  )}
                </div>
              </details>

              <details className="agent-disclosure">
                <summary className="agent-disclosure__summary">
                  <span>Recent Agent Activity</span>
                  <span className="pill">{opsAgentHistory.length}</span>
                </summary>
                <div className="agent-disclosure__body">
                  {opsAgentHistory.length > 0 ? (
                    <div className="agent-activity-list">
                      {opsAgentHistory.map((item) => (
                        <article className="agent-activity-item" key={item.id}>
                          <div className="agent-activity-item__head">
                            <h4>{item.title}</h4>
                            <span className={item.type === 'system_ops_error' ? 'pill pill--danger' : item.type === 'system_ops_success' ? 'pill pill--success' : 'pill pill--info'}>
                              {item.type === 'system_ops_error'
                                ? 'FAILED'
                                : item.type === 'system_ops_success'
                                  ? 'SUCCESS'
                                  : 'LOGGED'}
                            </span>
                          </div>
                          {item.content ? <p className="agent-action-card__copy">{item.content}</p> : null}
                          <p className="agent-action-card__meta">
                            {item.userEmail || 'System'} • {formatAgentTimestamp(item.createdAt)} • {String(item.action || '').replace(/_/g, ' ')}
                          </p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="file-help">No AI agent activity has been recorded yet.</p>
                  )}
                </div>
              </details>
            </div>
          ) : null}
        </div>
      </section>

      <div className="grid-2">
        <section className="card section fade-up-delay">
          <div className="section-title">
            <div className="section-title__text">
              <h2>Live Broadcast</h2>
            </div>
            <span className={liveStatus === 'ON' ? 'pill pill--success' : 'pill pill--danger'}>
              <span className="badge-dot" />
              {liveStatus}
            </span>
          </div>

          <div className="field">
            <label htmlFor="live-link">Stream Link(s)</label>
            <div className="announcement-live-input-row">
              <input
                id="live-link"
                type="text"
                value={liveLinkInput}
                onChange={(event) => {
                  setLiveLinkInput(event.target.value);
                  setLiveLinkInputError('');
                }}
                onKeyDown={handleLiveInputKeyDown}
                placeholder="https://www.youtube.com/watch?v=... (comma/newline supports bulk add)"
                autoComplete="off"
              />
              <button className="btn btn--ghost btn--tiny" type="button" onClick={addLiveDraftLinks}>
                Add
              </button>
            </div>
            {liveLinkInputError ? <p className="field-error">{liveLinkInputError}</p> : null}
          </div>

          {liveDraftLinks.length > 0 ? (
            <div className="announcement-live-list">
              {liveDraftLinks.map((link, index) => (
                <div className="announcement-live-list__item" key={`live-draft-${index}`}>
                  <input
                    type="url"
                    value={link}
                    onChange={(event) => updateLiveDraftLinkAt(index, event.target.value)}
                    placeholder="https://..."
                  />
                  <button
                    className="btn btn--danger btn--tiny"
                    type="button"
                    onClick={() => removeLiveDraftLinkAt(index)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="inline-actions">
            <button className="btn btn--ghost btn--tiny" type="button" onClick={useCurrentLiveLinks}>
              Use Current Links
            </button>
            <button className="btn btn--ghost btn--tiny" type="button" onClick={clearLiveDraftLinks}>
              Clear Draft
            </button>
          </div>

          <div className="live-broadcast-metrics">
            <span className="pill pill--info">Draft: {liveDraftLinks.length}</span>
            <span className="pill pill--success">Active: {liveLinks.length}</span>
            <span className="pill">Limit: {MAX_LIVE_LINKS}</span>
          </div>

          <div className="field">
            <label htmlFor="live-category">Live Category</label>
            <select
              id="live-category"
              value={liveCategory}
              onChange={(event) => setLiveCategory(event.target.value)}
            >
              <option value="all">All categories (global)</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="inline-actions">
            <button
              className="btn btn--success"
              type="button"
              onClick={startLive}
              disabled={Boolean(liveActionPending)}
            >
              {liveActionPending === 'start' ? 'Starting...' : 'Start Live'}
            </button>
            <button
              className="btn btn--danger"
              type="button"
              onClick={stopLive}
              disabled={Boolean(liveActionPending) || (liveStatus !== 'ON' && liveLinks.length === 0)}
            >
              {liveActionPending === 'stop' ? 'Stopping...' : 'Stop Live'}
            </button>
          </div>

          {liveLinks.length > 0 ? (
            <p className="file-help">
              Category: {liveCategoryLabel}
              <br />
              Current live links:{' '}
              {liveLinks.map((link, index) => (
                <React.Fragment key={`${link}-${index}`}>
                  <a href={link} target="_blank" rel="noreferrer">
                    {link}
                  </a>
                  {index < liveLinks.length - 1 ? ', ' : ''}
                </React.Fragment>
              ))}
            </p>
          ) : (
            <p className="file-help">No live link is currently active.</p>
          )}

          <div className="section-title section-title--spaced">
            <div className="section-title__text">
              <h2>Category Overview</h2>
            </div>
          </div>

          {categories.length === 0 ? (
            <div className="empty-state empty-state--compact">No categories yet. Add one from the top bar.</div>
          ) : (
            <div className="category-chips">
              {categories.map((category) => (
                <span className="category-chip category-chip--static" key={category.id}>
                  {category.name}
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="card section fade-up-delay">
          <div className="section-title">
            <div className="section-title__text">
              <h2>{editingId ? 'Edit Announcement' : 'Create Announcement'}</h2>
            </div>
            {editingId ? <span className="pill pill--info">Editing mode</span> : null}
          </div>

          {isEditingBatchGroup ? (
            <p className="file-help">
              This item is part of a batch with {editingBatchCount} attachments. Text/schedule updates will apply to
              the full batch when no replacement file is selected.
            </p>
          ) : null}

          <form className="stack" onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="announcement-category">Category</label>
              <select
                id="announcement-category"
                value={formData.category}
                onChange={(event) => setFormData({ ...formData, category: event.target.value })}
              >
                <option value="">All categories (global)</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="announcement-title">Title (Optional)</label>
              <input
                id="announcement-title"
                type="text"
                value={formData.title}
                onChange={(event) => setFormData({ ...formData, title: event.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="announcement-content">Content (Optional)</label>
              <textarea
                id="announcement-content"
                value={formData.content}
                onChange={(event) => setFormData({ ...formData, content: event.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="announcement-live-link">Announcement Live Stream Link(s)</label>
              <div className="announcement-live-input-row">
                <input
                  id="announcement-live-link"
                  type="text"
                  value={announcementLiveLinkInput}
                  onChange={(event) => {
                    setAnnouncementLiveLinkInput(event.target.value);
                    setAnnouncementLiveInputError('');
                  }}
                  onKeyDown={handleAnnouncementLiveInputKeyDown}
                  placeholder="https://www.youtube.com/watch?v=... (use comma/newline for multiple)"
                  autoComplete="off"
                />
                <button
                  className="btn btn--ghost btn--tiny"
                  type="button"
                  onClick={addAnnouncementLiveLinksFromInput}
                >
                  Add Stream
                </button>
              </div>
              {announcementLiveInputError ? <p className="field-error">{announcementLiveInputError}</p> : null}
              {announcementLiveLinks.length > 0 ? (
                <div className="announcement-live-list">
                  {announcementLiveLinks.map((link, index) => (
                    <div className="announcement-live-list__item" key={`announcement-stream-${index}`}>
                      <input
                        type="url"
                        value={link}
                        onChange={(event) => updateAnnouncementLiveLinkAt(index, event.target.value)}
                        placeholder="https://..."
                      />
                      <button
                        className="btn btn--danger btn--tiny"
                        type="button"
                        onClick={() => removeAnnouncementLiveLinkAt(index)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <div className="inline-actions">
                    <button className="btn btn--ghost btn--tiny" type="button" onClick={clearAnnouncementLiveLinks}>
                      Clear All Streams
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="field">
              <label htmlFor="announcement-image">Image Upload</label>
              <div
                className={`upload-dropzone ${isFileDragActive ? 'is-file-drag' : ''} ${activeDropZone === 'image' ? 'is-active' : ''}`.trim()}
                role="button"
                tabIndex={0}
                aria-label="Image upload dropzone"
                onClick={() => openUploadPicker('image')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openUploadPicker('image');
                  }
                }}
                onDragEnter={handleDropZoneDragEnter('image')}
                onDragOver={handleDropZoneDragOver('image')}
                onDragLeave={handleDropZoneDragLeave('image')}
                onDrop={handleDropZoneDrop('image')}
              >
                <div className="upload-dropzone__copy">
                  <p className="upload-dropzone__title">Drag and drop image files here</p>
                  <p className="upload-dropzone__hint">
                    JPG, PNG, WEBP, HEIC and other image formats. Currently up to {activeUploadMaxSizeMb} MB
                    per file on this workspace.
                  </p>
                </div>
                <div className="upload-dropzone__actions">
                  <button
                    className="btn btn--ghost btn--tiny"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openUploadPicker('image');
                    }}
                  >
                    Browse Images
                  </button>
                  <span className="upload-dropzone__meta">
                    {editingId ? 'One replacement file' : 'Multiple files allowed'}
                  </span>
                </div>
              </div>
              <input
                id="announcement-image"
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                onChange={handleImageChange}
                ref={mediaInputRef}
                className="visually-hidden"
              />
            </div>

            <div className="field">
              <label htmlFor="announcement-video">Video Upload</label>
              <div
                className={`upload-dropzone ${isFileDragActive ? 'is-file-drag' : ''} ${activeDropZone === 'video' ? 'is-active' : ''}`.trim()}
                role="button"
                tabIndex={0}
                aria-label="Video upload dropzone"
                onClick={() => openUploadPicker('video')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openUploadPicker('video');
                  }
                }}
                onDragEnter={handleDropZoneDragEnter('video')}
                onDragOver={handleDropZoneDragOver('video')}
                onDragLeave={handleDropZoneDragLeave('video')}
                onDrop={handleDropZoneDrop('video')}
              >
                <div className="upload-dropzone__copy">
                  <p className="upload-dropzone__title">Drag and drop video files here</p>
                  <p className="upload-dropzone__hint">
                    MP4, MOV, WEBM, MKV and other video formats. Currently up to {activeUploadMaxSizeMb} MB
                    per file on this workspace.
                  </p>
                </div>
                <div className="upload-dropzone__actions">
                  <button
                    className="btn btn--ghost btn--tiny"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openUploadPicker('video');
                    }}
                  >
                    Browse Videos
                  </button>
                  <span className="upload-dropzone__meta">
                    {editingId ? 'One replacement file' : 'Multiple files allowed'}
                  </span>
                </div>
              </div>
              <input
                id="announcement-video"
                type="file"
                accept={VIDEO_ACCEPT}
                multiple
                onChange={handleVideoChange}
                ref={videoInputRef}
                className="visually-hidden"
              />
              <input
                type="file"
                accept={MEDIA_ACCEPT}
                onChange={handleMediaReplaceChange}
                ref={mediaReplaceInputRef}
                className="visually-hidden"
                tabIndex={-1}
                aria-hidden="true"
              />
            </div>

            <div className="field">
              <label htmlFor="announcement-document">Document Upload (PDF/Word/PPT/Etc)</label>
              <div
                className={`upload-dropzone ${isFileDragActive ? 'is-file-drag' : ''} ${activeDropZone === 'document' ? 'is-active' : ''}`.trim()}
                role="button"
                tabIndex={0}
                aria-label="Document upload dropzone"
                onClick={() => openUploadPicker('document')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openUploadPicker('document');
                  }
                }}
                onDragEnter={handleDropZoneDragEnter('document')}
                onDragOver={handleDropZoneDragOver('document')}
                onDragLeave={handleDropZoneDragLeave('document')}
                onDrop={handleDropZoneDrop('document')}
              >
                <div className="upload-dropzone__copy">
                  <p className="upload-dropzone__title">Drag and drop document files here</p>
                  <p className="upload-dropzone__hint">
                    PDF, Word, PowerPoint, Excel and archive files. Currently up to {activeUploadMaxSizeMb} MB
                    per file on this workspace.
                  </p>
                </div>
                <div className="upload-dropzone__actions">
                  <button
                    className="btn btn--ghost btn--tiny"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openUploadPicker('document');
                    }}
                  >
                    Browse Documents
                  </button>
                  <span className="upload-dropzone__meta">
                    {editingId ? 'One replacement file' : 'Multiple files allowed'}
                  </span>
                </div>
              </div>
              <input
                id="announcement-document"
                type="file"
                accept={DOCUMENT_ACCEPT}
                multiple
                onChange={handleDocumentChange}
                ref={documentInputRef}
                className="visually-hidden"
              />
              <input
                type="file"
                accept={DOCUMENT_ACCEPT}
                onChange={handleDocumentReplaceChange}
                ref={documentReplaceInputRef}
                className="visually-hidden"
                tabIndex={-1}
                aria-hidden="true"
              />
            </div>

            {showExistingAttachmentEditor ? (
              <div className="batch-preview-grid">
                <div className="batch-preview-card">
                  <AttachmentPreview
                    filePath={editingAnnouncementPreview.image}
                    fileName={editingAnnouncementPreview.fileName}
                    typeHint={editingAnnouncementPreview.fileMimeType || editingAnnouncementPreview.type}
                    fileSizeBytes={editingAnnouncementPreview.fileSizeBytes}
                    title="Current attachment"
                    imageAlt="Current attachment"
                    className={
                      editingExistingAttachmentKind === 'document'
                        ? 'document-preview--full'
                        : 'media-preview--full'
                    }
                    documentPreview={false}
                  />
                  <div className="batch-preview-card__actions">
                    <span className="batch-preview-card__label">
                      Current {editingExistingAttachmentKind || 'attachment'}
                      {editingAnnouncementPreview.fileName ? ` • ${editingAnnouncementPreview.fileName}` : ''}
                    </span>
                    <div className="inline-actions">
                      <button
                        className="btn btn--danger btn--tiny"
                        type="button"
                        onClick={removeExistingAttachment}
                        disabled={!canRemoveEditingAttachment}
                      >
                        Remove Current Attachment
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {editingAnnouncementPreview?.image && editAttachmentRemoved && !hasSelectedEditAttachmentReplacement ? (
              <div className="field">
                <p className="file-help">
                  The current attachment will be removed when you update this announcement.
                </p>
                <div className="inline-actions">
                  <button
                    className="btn btn--ghost btn--tiny"
                    type="button"
                    onClick={() => setEditAttachmentRemoved(false)}
                  >
                    Keep Current Attachment
                  </button>
                </div>
              </div>
            ) : null}

            {editingAnnouncementPreview?.image && hasSelectedEditAttachmentReplacement ? (
              <div className="field">
                <p className="file-help">
                  The selected replacement will overwrite the current attachment when you update.
                </p>
                <div className="inline-actions">
                  <button
                    className="btn btn--ghost btn--tiny"
                    type="button"
                    onClick={discardReplacementAttachment}
                  >
                    Use Current Attachment Instead
                  </button>
                </div>
              </div>
            ) : null}

            {mediaPreviewUrls.length > 0 ? (
              <div className="batch-preview-grid">
                {mediaPreviewUrls.map((previewUrl, index) => {
                  const file = mediaFiles[index];
                  const mediaKindLabel = getMediaKindLabel(file);
                  return (
                    <div className="batch-preview-card" key={`${file?.name || 'media'}-${index}`}>
                      <AttachmentPreview
                        fileUrl={previewUrl}
                        fileName={file && file.name}
                        typeHint={file && file.type}
                        fileSizeBytes={file && file.size}
                        title={`Media preview ${index + 1}`}
                      />
                      <div className="batch-preview-card__actions">
                        <span className="batch-preview-card__label">
                          {mediaKindLabel} {index + 1}
                          {file?.name ? ` • ${file.name}` : ''}
                        </span>
                        <div className="inline-actions">
                          <button
                            className="btn btn--ghost btn--tiny"
                            type="button"
                            onClick={() => openMediaReplacePicker(index)}
                          >
                            {`Change ${mediaKindLabel}`}
                          </button>
                          <button
                            className="btn btn--danger btn--tiny"
                            type="button"
                            onClick={() => removeMediaAt(index)}
                          >
                            {`Remove ${mediaKindLabel}`}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {documentFiles.length > 0 && documentPreviewUrls.length > 0 ? (
              <div className="batch-preview-grid">
                {documentFiles.map((file, index) => (
                  <div className="batch-preview-card" key={`${file.name || 'document'}-${index}`}>
                    <AttachmentPreview
                      fileUrl={documentPreviewUrls[index]}
                      fileName={file.name}
                      typeHint={file.type}
                      fileSizeBytes={file.size}
                      title={`Document preview ${index + 1}`}
                      className="document-preview--full"
                      documentPreview
                      documentSlideshow
                      documentSlideshowAutoplay={false}
                    />
                    <div className="batch-preview-card__actions">
                      <span className="batch-preview-card__label">
                        Document {index + 1}
                        {file?.name ? ` • ${file.name}` : ''}
                      </span>
                      <div className="inline-actions">
                        <button
                          className="btn btn--ghost btn--tiny"
                          type="button"
                          onClick={() => openDocumentReplacePicker(index)}
                        >
                          Change
                        </button>
                        <button
                          className="btn btn--danger btn--tiny"
                          type="button"
                          onClick={() => removeDocumentAt(index)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="grid-2-equal">
              <div className="field">
                <label htmlFor="announcement-priority">Priority</label>
                <select
                  id="announcement-priority"
                  value={formData.priority}
                  onChange={(event) =>
                    setFormData({ ...formData, priority: Number.parseInt(event.target.value, 10) })
                  }
                >
                  <option value={0}>Emergency (Top)</option>
                  <option value={1}>Priority 1 (High)</option>
                  <option value={2}>Priority 2 (Normal)</option>
                  <option value={3}>Priority 3 (Low)</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="announcement-duration">Duration (days)</label>
                <input
                  id="announcement-duration"
                  type="number"
                  min="1"
                  value={formData.duration}
                  onChange={(event) =>
                    setFormData({ ...formData, duration: Number.parseInt(event.target.value, 10) || 1 })
                  }
                />
              </div>
            </div>

            <div className="grid-2-equal">
              <div className="field">
                <label htmlFor="announcement-start">Start Date & Time</label>
                <input
                  id="announcement-start"
                  type="datetime-local"
                  value={formData.startAt}
                  onChange={(event) => setFormData({ ...formData, startAt: event.target.value })}
                />
              </div>

              <div className="field">
                <label htmlFor="announcement-end">End Date & Time</label>
                <input
                  id="announcement-end"
                  type="datetime-local"
                  value={formData.endAt}
                  onChange={(event) => setFormData({ ...formData, endAt: event.target.value })}
                />
              </div>
            </div>

            <label className="checkbox-row" htmlFor="announcement-active">
              <input
                id="announcement-active"
                type="checkbox"
                checked={formData.isActive}
                onChange={(event) => setFormData({ ...formData, isActive: event.target.checked })}
              />
              <span>{formData.isActive ? 'Active and visible on board' : 'Inactive and hidden from board'}</span>
            </label>

            <div className="form-footer">
              <button className="btn btn--primary" type="submit" disabled={loading}>
                {loading ? 'Saving...' : editingId ? 'Update Announcement' : 'Create Announcement'}
              </button>
              {editingId ? (
                <button className="btn btn--ghost" type="button" onClick={resetForm}>
                  Cancel Editing
                </button>
              ) : null}
            </div>
          </form>
        </section>
      </div>

      <section className="card section">
        <div className="section-title">
          <div className="section-title__text">
            <h2>Published Announcements</h2>
          </div>
          <span className="pill">{announcements.length} records</span>
        </div>

        {announcements.length === 0 ? (
          <div className="empty-state">No announcements yet. Create your first one from the form above.</div>
        ) : (
          <div className="notice-grid">
            {announcements.map((announcement) => {
              const noticeTitle = String(announcement.title || '').trim();
              const noticeContent = String(announcement.content || '').trim();
              const batchItemCount = getBatchAttachmentCount(announcement);
              const streamCount = normalizeLiveLinkArray(announcement.liveStreamLinks || []).length;
              const hasAttachment = Boolean(announcement.image);
              const hasStream = streamCount > 0;
              const cardTitle = noticeTitle || (hasAttachment || hasStream ? 'Media-only post' : 'Untitled notice');
              const cardContent =
                noticeContent ||
                (hasAttachment
                  ? 'No text content.'
                  : hasStream
                    ? 'Live stream links are attached to this announcement.'
                    : 'No content.');

              return (
              <article className="notice-card" key={announcement.id} onClick={() => handleEdit(announcement)}>
                <div className="notice-card__top">
                  <span className={announcement.isActive !== false ? 'pill pill--success' : 'pill pill--danger'}>
                    <span className="badge-dot" />
                    {announcement.isActive !== false ? 'Active' : 'Inactive'}
                  </span>
                  <span className="pill">P{announcement.priority ?? 1}</span>
                </div>

                <h3 className="notice-card__title">{cardTitle}</h3>

                {announcement.image ? (
                  <AttachmentPreview
                    filePath={announcement.image}
                    fileName={announcement.fileName}
                    typeHint={announcement.fileMimeType || announcement.type}
                    fileSizeBytes={announcement.fileSizeBytes}
                    className="media-preview--full"
                    preview={!shouldUseSummaryPreviews}
                    documentPreview={false}
                    showActions={false}
                    title={cardTitle}
                    imageAlt={cardTitle}
                  />
                ) : null}

                <p className="notice-card__content">{cardContent}</p>

                <div className="notice-card__meta">
                  <div>
                    Category:{' '}
                    {categories.find((category) => category.id === announcement.category)?.name ||
                      'All categories'}
                  </div>
                  {streamCount > 0 ? <div>Live streams: {streamCount}</div> : null}
                  {batchItemCount > 1 ? <div>Batch attachments: {batchItemCount}</div> : null}
                  <div>Created: {new Date(announcement.createdAt).toLocaleString()}</div>
                </div>

                <div className="notice-card__footer" onClick={(event) => event.stopPropagation()}>
                  <div className="inline-actions">
                    <button className="btn btn--ghost btn--tiny" type="button" onClick={() => handleEdit(announcement)}>
                      Edit
                    </button>
                    <button
                      className="btn btn--danger btn--tiny"
                      type="button"
                      onClick={() => handleDelete(announcement)}
                    >
                      {batchItemCount > 1 ? 'Delete Batch' : 'Delete'}
                    </button>
                  </div>

                  <button className="btn btn--primary btn--tiny" type="button" onClick={() => toggleEmergency(announcement)}>
                    {announcement.priority === 0 ? 'Remove Emergency' : 'Mark Emergency'}
                  </button>
                </div>
              </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

export default AdminPanel;
