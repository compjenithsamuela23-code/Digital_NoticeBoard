import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { apiUrl } from '../config/api';
import { clearAdminSession, hasAdminSession, withAuthConfig } from '../config/auth';
import { apiClient, buildConditionalGetConfig, extractApiError, getResponseEtag } from '../config/http';
import {
  clearDisplaySession,
  getDisplayCategoryId,
  getDisplayCategoryLabel,
  withDisplayAuthConfig
} from '../config/displayAuth';
import { useTheme } from '../hooks/useTheme';
import { useAdaptivePolling } from '../hooks/useAdaptivePolling';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { usePageVisibility } from '../hooks/usePageVisibility';
import { usePerformanceMode } from '../hooks/usePerformanceMode';
import { applyAnnouncementSocketEvent } from '../utils/announcementSync';
import AttachmentPreview from './AttachmentPreview';
import TopbarStatus from './TopbarStatus';

const normalizeLiveCategory = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.toLowerCase() === 'all') {
    return 'all';
  }
  return normalized;
};

const MAX_VISIBLE_SPLIT_ITEMS = 4;
const MAX_ANNOUNCEMENT_STREAM_LINKS = 24;
const MAX_GLOBAL_STREAM_LINKS = 24;
const DISPLAY_ROTATION_INTERVAL_MS = 8000;
const DISPLAY_ROTATION_INTERVAL_LITE_MS = 12000;
const ANNOUNCEMENT_TEXT_SLIDE_MAX_CHARS = 520;
const ANNOUNCEMENT_TEXT_SLIDE_MAX_LINES = 7;
const DISPLAY_CACHE_KEYS = {
  announcements: 'dnb.display.announcements',
  categories: 'dnb.display.categories',
  live: 'dnb.display.live'
};

const normalizeLiveLinkArray = (rawValues = [], maxLinks = MAX_ANNOUNCEMENT_STREAM_LINKS) =>
  [...new Set((Array.isArray(rawValues) ? rawValues : []).map((item) => String(item || '').trim()).filter(Boolean))].slice(
    0,
    maxLinks
  );

const readCachedDisplayPayload = (key, fallbackValue) => {
  if (typeof window === 'undefined') {
    return fallbackValue;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallbackValue;
    }

    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallbackValue : parsed;
  } catch {
    return fallbackValue;
  }
};

const writeCachedDisplayPayload = (key, value) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota/privacy failures and keep the live in-memory state.
  }
};

const getDisplayAnnouncementsCacheKey = (categoryId) => {
  const normalized = String(categoryId || 'all').trim() || 'all';
  return `${DISPLAY_CACHE_KEYS.announcements}:${normalized}`;
};

const getCachedLiveState = () => {
  const cached = readCachedDisplayPayload(DISPLAY_CACHE_KEYS.live, null);
  if (!cached || typeof cached !== 'object') {
    return {
      status: 'OFF',
      link: null,
      links: [],
      category: 'all'
    };
  }

  return {
    status: cached.status || 'OFF',
    link: cached.link || null,
    links: Array.isArray(cached.links) ? cached.links : cached.link ? [cached.link] : [],
    category: cached.category || 'all'
  };
};

const withCachedContentNotice = (message, hasCachedContent) =>
  hasCachedContent ? `${message} Showing last synced display content.` : message;

const getAnnouncementLiveLinks = (announcement) =>
  normalizeLiveLinkArray(announcement?.liveStreamLinks || [], MAX_ANNOUNCEMENT_STREAM_LINKS);

const isTakeoverAnnouncement = (announcement) => {
  if (!announcement) return false;
  return announcement.isEmergency === true || Number(announcement.priority) === 0 || getAnnouncementLiveLinks(announcement).length > 0;
};

const getTakeoverReason = (announcement) => {
  if (!announcement) return 'announcement';
  if (announcement.isEmergency === true || Number(announcement.priority) === 0) {
    return 'emergency';
  }
  if (getAnnouncementLiveLinks(announcement).length > 0) {
    return 'live';
  }
  return 'announcement';
};

const buildTakeoverVersion = (slide) => {
  const announcement = slide?.announcement;
  if (!announcement) return '';

  const liveLinks = getAnnouncementLiveLinks(announcement);
  return [
    slide.id,
    announcement.id || '',
    announcement.updatedAt || announcement.createdAt || '',
    announcement.priority ?? 1,
    liveLinks.join('|')
  ].join('::');
};

const splitAnnouncementTextIntoSlides = (
  value,
  { maxChars = ANNOUNCEMENT_TEXT_SLIDE_MAX_CHARS, maxLines = ANNOUNCEMENT_TEXT_SLIDE_MAX_LINES } = {}
) => {
  const normalized = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const chunks = [];
  let buffer = [];
  let charsInBuffer = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const chunk = buffer.join('\n').trim();
    if (chunk) {
      chunks.push(chunk);
    }
    buffer = [];
    charsInBuffer = 0;
  };

  lines.forEach((line) => {
    const safeLine = String(line || '').trim();
    if (!safeLine && buffer.length > 0) {
      buffer.push('');
      charsInBuffer += 1;
      return;
    }

    const nextChars = charsInBuffer + safeLine.length + 1;
    if (buffer.length > 0 && (buffer.length >= maxLines || nextChars > maxChars)) {
      flush();
    }

    buffer.push(safeLine);
    charsInBuffer += safeLine.length + 1;
  });

  flush();
  return chunks.slice(0, 40);
};

const buildAnnouncementTextSlides = (title, content) => {
  const safeTitle = String(title || '').trim();
  const safeContent = String(content || '').replace(/\r\n/g, '\n').trim();

  if (!safeTitle && !safeContent) {
    return [];
  }

  const contentChunks = splitAnnouncementTextIntoSlides(safeContent);
  if (contentChunks.length === 0) {
    return [
      {
        id: 'announcement-text-1',
        title: safeTitle || 'Announcement',
        content: safeContent || ''
      }
    ];
  }

  return contentChunks.map((chunk, index) => ({
    id: `announcement-text-${index + 1}`,
    title: safeTitle || `Announcement ${index + 1}`,
    content: chunk
  }));
};

const safeUrl = (value) => {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
};

const getYouTubeIdFromUrl = (sourceUrl) => {
  const parsed = safeUrl(sourceUrl);
  if (!parsed) return null;

  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = parsed.pathname.replace(/^\/+/, '').split('/')[0];
    return id || null;
  }

  if (host.endsWith('youtube.com')) {
    const queryId = parsed.searchParams.get('v');
    if (queryId) return queryId;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] === 'embed' && segments[1]) return segments[1];
    if (segments[0] === 'live' && segments[1]) return segments[1];
    if (segments[0] === 'shorts' && segments[1]) return segments[1];
  }

  return null;
};

const getVimeoIdFromUrl = (sourceUrl) => {
  const parsed = safeUrl(sourceUrl);
  if (!parsed) return null;
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (!host.endsWith('vimeo.com')) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  const numericSegment = [...segments].reverse().find((segment) => /^\d+$/.test(segment));
  return numericSegment || null;
};

const getTwitchTargetFromUrl = (sourceUrl) => {
  const parsed = safeUrl(sourceUrl);
  if (!parsed) return null;
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (!host.endsWith('twitch.tv')) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (!segments[0]) return null;

  if (segments[0].toLowerCase() === 'videos' && segments[1]) {
    return {
      type: 'video',
      value: segments[1].replace(/^v/i, '')
    };
  }

  return {
    type: 'channel',
    value: segments[0]
  };
};

const toLiveStreamEmbed = (sourceUrl, options = {}) => {
  const normalized = String(sourceUrl || '').trim();
  if (!normalized) return null;

  const isAudioMuted = options.isAudioMuted !== false;
  const parentHost = options.parentHost || 'localhost';

  const youTubeId = getYouTubeIdFromUrl(normalized);
  if (youTubeId) {
    return {
      id: `youtube:${youTubeId}`,
      provider: 'YouTube',
      sourceUrl: normalized,
      embedUrl: `https://www.youtube.com/embed/${youTubeId}?autoplay=1&mute=${isAudioMuted ? 1 : 0}&playsinline=1`
    };
  }

  const vimeoId = getVimeoIdFromUrl(normalized);
  if (vimeoId) {
    return {
      id: `vimeo:${vimeoId}`,
      provider: 'Vimeo',
      sourceUrl: normalized,
      embedUrl: `https://player.vimeo.com/video/${vimeoId}?autoplay=1&muted=${isAudioMuted ? 1 : 0}`
    };
  }

  const twitchTarget = getTwitchTargetFromUrl(normalized);
  if (twitchTarget) {
    const baseUrl =
      twitchTarget.type === 'video'
        ? `https://player.twitch.tv/?video=v${twitchTarget.value}`
        : `https://player.twitch.tv/?channel=${encodeURIComponent(twitchTarget.value)}`;
    return {
      id: `twitch:${twitchTarget.type}:${twitchTarget.value}`,
      provider: 'Twitch',
      sourceUrl: normalized,
      embedUrl: `${baseUrl}&parent=${encodeURIComponent(parentHost)}&autoplay=true&muted=${isAudioMuted ? 'true' : 'false'}`
    };
  }

  return null;
};

const withAutoplay = (embedUrl, provider, shouldAutoplay) => {
  try {
    const parsed = new URL(String(embedUrl || '').trim());
    if (!parsed) return embedUrl;
    if (String(provider || '').toLowerCase() === 'twitch') {
      parsed.searchParams.set('autoplay', shouldAutoplay ? 'true' : 'false');
    } else {
      parsed.searchParams.set('autoplay', shouldAutoplay ? '1' : '0');
    }
    return parsed.toString();
  } catch {
    return embedUrl;
  }
};

const getSplitColumnCount = (count) => {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 2;
};

const getSplitRowCount = (count, columns) => {
  if (count <= 0) return 1;
  const safeColumns = Math.max(1, Number.parseInt(columns, 10) || 1);
  return Math.max(1, Math.ceil(count / safeColumns));
};

const sortBatchMediaItems = (left, right) => {
  const leftSlot = Number.parseInt(left && left.displayBatchSlot, 10);
  const rightSlot = Number.parseInt(right && right.displayBatchSlot, 10);
  const hasLeftSlot = Number.isFinite(leftSlot) && leftSlot > 0;
  const hasRightSlot = Number.isFinite(rightSlot) && rightSlot > 0;
  if (hasLeftSlot && hasRightSlot && leftSlot !== rightSlot) {
    return leftSlot - rightSlot;
  }
  if (hasLeftSlot !== hasRightSlot) {
    return hasLeftSlot ? -1 : 1;
  }

  const leftCreatedAt = left && left.createdAt ? new Date(left.createdAt).getTime() : 0;
  const rightCreatedAt = right && right.createdAt ? new Date(right.createdAt).getTime() : 0;
  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }

  return String((left && left.id) || '').localeCompare(String((right && right.id) || ''));
};

const toDisplaySlides = (rows = []) => {
  const slideOrder = [];
  const bySlideId = new Map();

  rows.forEach((row, index) => {
    if (!row) return;

    const batchId = String(row.displayBatchId || '').trim();
    const slideId = batchId ? `batch:${batchId}` : `announcement:${String(row.id || index)}`;
    const existing = bySlideId.get(slideId);

    if (existing) {
      existing.items.push(row);
      return;
    }

    const nextSlide = {
      id: slideId,
      batchId: batchId || null,
      items: [row]
    };
    bySlideId.set(slideId, nextSlide);
    slideOrder.push(nextSlide);
  });

  return slideOrder.map((slide) => {
    const mediaItems = slide.items
      .filter((item) => item && item.image)
      .sort(sortBatchMediaItems);
    const primaryAnnouncement = mediaItems[0] || slide.items[0] || null;

    return {
      id: slide.id,
      batchId: slide.batchId,
      announcement: primaryAnnouncement,
      mediaItems
    };
  });
};

const DisplayBoard = () => {
  const [announcements, setAnnouncements] = useState(() =>
    readCachedDisplayPayload(getDisplayAnnouncementsCacheKey(getDisplayCategoryId()), [])
  );
  const [currentSlideId, setCurrentSlideId] = useState('');
  const [currentMediaGroupPage, setCurrentMediaGroupPage] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [liveStatus, setLiveStatus] = useState(() => getCachedLiveState().status);
  const [liveLink, setLiveLink] = useState(() => getCachedLiveState().link);
  const [liveLinks, setLiveLinks] = useState(() => getCachedLiveState().links);
  const [liveCategory, setLiveCategory] = useState(() => normalizeLiveCategory(getCachedLiveState().category));
  const [categories, setCategories] = useState(() => readCachedDisplayPayload(DISPLAY_CACHE_KEYS.categories, []));
  const [isAudioMuted, setIsAudioMuted] = useState(true);
  const [requestError, setRequestError] = useState('');
  const [documentSlideCount, setDocumentSlideCount] = useState(1);
  const [documentSlideIndex, setDocumentSlideIndex] = useState(1);
  const [currentAnnouncementTextPage, setCurrentAnnouncementTextPage] = useState(0);
  const [liveReconnectToken, setLiveReconnectToken] = useState(0);
  const [takeoverQueue, setTakeoverQueue] = useState([]);
  const previousDocumentSlideIndexRef = useRef(1);
  const documentCycleCountRef = useRef(0);
  const takeoverResumeSlideIdRef = useRef('');
  const knownTakeoverVersionsRef = useRef(new Map());
  const hasHydratedTakeoversRef = useRef(false);
  const announcementsRef = useRef(announcements);
  const announcementsEtagRef = useRef('');
  const categoriesRef = useRef(categories);
  const liveStateRef = useRef({
    link: liveLink,
    links: liveLinks
  });

  const navigate = useNavigate();
  const { socket } = useSocket();
  const { isDark, toggleTheme } = useTheme();
  const { shouldLimitConcurrentMedia } = usePerformanceMode();
  const { isOnline } = useNetworkStatus();
  const isPageVisible = usePageVisibility();
  const wasOnlineRef = useRef(isOnline);
  const [socketConnected, setSocketConnected] = useState(Boolean(socket?.connected));

  const isAdmin = hasAdminSession();
  const displayCategoryId = getDisplayCategoryId();
  const displayCategoryLabel = getDisplayCategoryLabel();
  const preferSocket = Boolean(socket) && socketConnected;
  const maxVisibleMediaItems = shouldLimitConcurrentMedia ? 1 : MAX_VISIBLE_SPLIT_ITEMS;
  const displayRotationIntervalMs = shouldLimitConcurrentMedia
    ? DISPLAY_ROTATION_INTERVAL_LITE_MS
    : DISPLAY_ROTATION_INTERVAL_MS;
  const documentSlideshowIntervalMs = shouldLimitConcurrentMedia ? 9000 : 6000;

  useEffect(() => {
    announcementsRef.current = announcements;
  }, [announcements]);

  useEffect(() => {
    announcementsEtagRef.current = '';
  }, [displayCategoryId]);

  useEffect(() => {
    categoriesRef.current = categories;
  }, [categories]);

  useEffect(() => {
    liveStateRef.current = {
      link: liveLink,
      links: liveLinks
    };
  }, [liveLink, liveLinks]);

  const isVideoMedia = useCallback((announcement) => {
    if (!announcement || !announcement.image) return false;
    if (String(announcement.type || '').toLowerCase().includes('video')) return true;
    return /\.(mp4|m4v|m4p|mov|avi|mkv|webm|ogg|ogv|flv|f4v|wmv|asf|ts|m2ts|mts|3gp|3g2|mpg|mpeg|mpe|vob|mxf|rm|rmvb|qt|hevc|h265|h264|r3d|braw|cdng|prores|dnxhd|dnxhr|dv|mjpeg)$/i.test(
      announcement.image
    );
  }, []);

  const isImageMedia = useCallback((announcement) => {
    if (!announcement || !announcement.image) return false;
    if (String(announcement.type || '').toLowerCase().includes('image')) return true;
    return /\.(jpg|jpeg|png|gif|bmp|tif|tiff|webp|avif|heif|heic|apng|svg|ai|eps|psd|raw|dng|cr2|cr3|nef|arw|orf|rw2)$/i.test(
      announcement.image
    );
  }, []);

  const isDocumentMedia = useCallback((announcement) => {
    if (!announcement || !announcement.image) return false;
    const type = String(announcement.type || '').toLowerCase();
    if (type.includes('document')) return true;
    if (isVideoMedia(announcement)) return false;
    if (isImageMedia(announcement)) return false;
    return true;
  }, [isImageMedia, isVideoMedia]);

  const isPresentationMedia = useCallback((announcement) => {
    if (!announcement || !announcement.image) return false;
    const mime = String(announcement.fileMimeType || '').toLowerCase();
    const references = [
      String(announcement.fileName || ''),
      String(announcement.image || '')
    ].join(' ');

    return (
      mime === 'application/vnd.ms-powerpoint' ||
      mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mime === 'application/vnd.openxmlformats-officedocument.presentationml.slideshow' ||
      /\.(ppt|pptx|pps|ppsx)\b/i.test(references)
    );
  }, []);

  const handleDocumentSlideCountChange = useCallback((count) => {
    const parsed = Number.parseInt(count, 10);
    const next = Number.isNaN(parsed) || parsed <= 0 ? 1 : parsed;
    setDocumentSlideCount(next);
  }, []);

  const handleDocumentSlideIndexChange = useCallback((index) => {
    const parsed = Number.parseInt(index, 10);
    const next = Number.isNaN(parsed) || parsed <= 0 ? 1 : parsed;
    setDocumentSlideIndex(next);
  }, []);

  const getCategoryName = (categoryId) => {
    if (!categoryId) return null;
    const category = categories.find((item) => item.id === categoryId);
    return category ? category.name : null;
  };

  const syncAnnouncements = useCallback(
    (nextAnnouncements) => {
      const safeAnnouncements = Array.isArray(nextAnnouncements) ? nextAnnouncements : [];
      setAnnouncements(safeAnnouncements);
      writeCachedDisplayPayload(getDisplayAnnouncementsCacheKey(displayCategoryId), safeAnnouncements);
    },
    [displayCategoryId]
  );

  const fetchAnnouncements = useCallback(async () => {
    if (!isOnline) {
      setRequestError(
        withCachedContentNotice('Network appears offline. Waiting to reconnect...', announcementsRef.current.length > 0)
      );
      return;
    }

    try {
      const categoryFilter = String(displayCategoryId || 'all').trim();
      const response = await apiClient.get(
        apiUrl('/api/announcements/public'),
        buildConditionalGetConfig(announcementsEtagRef.current, {
          params: categoryFilter && categoryFilter !== 'all' ? { category: categoryFilter } : {}
        })
      );
      if (response.status === 304) {
        setRequestError('');
        return;
      }
      announcementsEtagRef.current = getResponseEtag(response) || announcementsEtagRef.current;
      const nextAnnouncements = Array.isArray(response.data) ? response.data : [];
      syncAnnouncements(nextAnnouncements);
      setRequestError('');
    } catch (error) {
      console.error('Error fetching announcements:', error);
      setRequestError(
        withCachedContentNotice(
          extractApiError(error, 'Unable to load announcements.'),
          announcementsRef.current.length > 0
        )
      );
    }
  }, [displayCategoryId, isOnline, syncAnnouncements]);

  const fetchCategories = useCallback(async () => {
    if (!isOnline) {
      return;
    }

    try {
      const response = await apiClient.get(apiUrl('/api/categories'));
      const nextCategories = Array.isArray(response.data) ? response.data : [];
      setCategories(nextCategories);
      writeCachedDisplayPayload(DISPLAY_CACHE_KEYS.categories, nextCategories);
      setRequestError('');
    } catch (error) {
      console.error('Error fetching categories:', error);
      const hasCachedDisplayContent =
        categoriesRef.current.length > 0 ||
        announcementsRef.current.length > 0 ||
        liveStateRef.current.links.length > 0 ||
        Boolean(liveStateRef.current.link);
      setRequestError(
        withCachedContentNotice(extractApiError(error, 'Unable to load categories.'), hasCachedDisplayContent)
      );
    }
  }, [isOnline]);

  const fetchLiveStatus = useCallback(async () => {
    if (!isOnline) {
      return;
    }

    try {
      const response = await apiClient.get(apiUrl('/api/status'));
      const statusPayload = response.data || {};
      const nextLinks =
        Array.isArray(statusPayload.links) && statusPayload.links.length > 0
          ? statusPayload.links
          : statusPayload.link
            ? [statusPayload.link]
            : [];
      const nextLivePayload = {
        status: statusPayload.status || 'OFF',
        link: statusPayload.link || null,
        links: nextLinks,
        category: normalizeLiveCategory(statusPayload.category)
      };
      setLiveStatus(nextLivePayload.status);
      setLiveLink(nextLivePayload.link);
      setLiveLinks(nextLivePayload.links);
      setLiveCategory(nextLivePayload.category);
      writeCachedDisplayPayload(DISPLAY_CACHE_KEYS.live, nextLivePayload);
      setRequestError('');
    } catch (error) {
      console.error('Error fetching live status:', error);
      const hasCachedDisplayContent =
        announcementsRef.current.length > 0 ||
        categoriesRef.current.length > 0 ||
        liveStateRef.current.links.length > 0 ||
        Boolean(liveStateRef.current.link);
      setRequestError(
        withCachedContentNotice(extractApiError(error, 'Unable to load live status.'), hasCachedDisplayContent)
      );
    }
  }, [isOnline]);

  useEffect(() => {
    fetchAnnouncements();
    fetchCategories();
    fetchLiveStatus();
  }, [fetchAnnouncements, fetchCategories, fetchLiveStatus]);

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
    baseIntervalMs: preferSocket ? 30000 : 15000,
    hiddenIntervalMs: 50000,
    offlineIntervalMs: 90000
  });

  useAdaptivePolling(fetchCategories, {
    enabled: true,
    online: isOnline,
    visible: isPageVisible,
    immediate: false,
    baseIntervalMs: 180000,
    hiddenIntervalMs: 300000,
    offlineIntervalMs: 300000,
    jitterRatio: 0.08
  });

  useEffect(() => {
    const syncVisibleDisplay = () => {
      if (!isOnline) return;
      fetchAnnouncements();
      fetchLiveStatus();
    };
    const handleOnline = () => {
      setRequestError('');
      fetchAnnouncements();
      fetchCategories();
      fetchLiveStatus();
    };

    window.addEventListener('focus', syncVisibleDisplay);
    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('focus', syncVisibleDisplay);
      window.removeEventListener('online', handleOnline);
    };
  }, [fetchAnnouncements, fetchCategories, fetchLiveStatus, isOnline]);

  useEffect(() => {
    if (isOnline && !wasOnlineRef.current) {
      setLiveReconnectToken((value) => value + 1);
    }
    wasOnlineRef.current = isOnline;
  }, [isOnline]);

  useEffect(() => {
    if (!socket) {
      setSocketConnected(false);
      return;
    }

    setSocketConnected(Boolean(socket.connected));

    const syncOnConnect = () => {
      setSocketConnected(true);
      fetchAnnouncements();
      fetchLiveStatus();
    };
    const handleDisconnect = () => {
      setSocketConnected(false);
    };
    const handleLiveUpdate = (data) => {
      const nextLinks =
        Array.isArray(data?.links) && data.links.length > 0
          ? data.links
          : data?.link
            ? [data.link]
            : [];
      const nextLivePayload = {
        status: data?.status || 'OFF',
        link: data?.link || null,
        links: nextLinks,
        category: normalizeLiveCategory(data?.category)
      };
      setLiveStatus(nextLivePayload.status);
      setLiveLink(nextLivePayload.link);
      setLiveLinks(nextLivePayload.links);
      setLiveCategory(nextLivePayload.category);
      writeCachedDisplayPayload(DISPLAY_CACHE_KEYS.live, nextLivePayload);
    };
    const handleAnnouncementUpdate = (payload) => {
      const nextAnnouncements = applyAnnouncementSocketEvent(announcementsRef.current, payload, {
        scope: 'public',
        category: displayCategoryId
      });

      if (!nextAnnouncements) {
        fetchAnnouncements();
        return;
      }

      announcementsEtagRef.current = '';
      syncAnnouncements(nextAnnouncements);
      setRequestError('');
    };

    socket.on('connect', syncOnConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('announcementUpdate', handleAnnouncementUpdate);
    socket.on('liveUpdate', handleLiveUpdate);

    return () => {
      socket.off('connect', syncOnConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('announcementUpdate', handleAnnouncementUpdate);
      socket.off('liveUpdate', handleLiveUpdate);
    };
  }, [displayCategoryId, fetchAnnouncements, fetchLiveStatus, socket, syncAnnouncements]);

  const displaySlides = useMemo(() => toDisplaySlides(announcements), [announcements]);

  useEffect(() => {
    if (!displaySlides.length) {
      setCurrentSlideId('');
      return;
    }
    setCurrentSlideId((previous) => {
      if (previous && displaySlides.some((slide) => slide.id === previous)) {
        return previous;
      }
      return displaySlides[0].id;
    });
  }, [displaySlides]);

  useEffect(() => {
    const nextTakeoverVersions = new Map();
    const takeoverEventsBySlideId = new Map();

    displaySlides.forEach((slide) => {
      const announcement = slide?.announcement;
      if (!isTakeoverAnnouncement(announcement)) {
        return;
      }

      const version = buildTakeoverVersion(slide);
      nextTakeoverVersions.set(slide.id, version);
      takeoverEventsBySlideId.set(slide.id, {
        id: version,
        slideId: slide.id,
        reason: getTakeoverReason(announcement)
      });
    });

    setTakeoverQueue((previous) => {
      const filtered = previous.filter((item) => nextTakeoverVersions.get(item.slideId) === item.id);

      if (!hasHydratedTakeoversRef.current) {
        return filtered;
      }

      const queuedIds = new Set(filtered.map((item) => item.id));
      const additions = [];

      nextTakeoverVersions.forEach((version, slideId) => {
        if (knownTakeoverVersionsRef.current.get(slideId) === version) {
          return;
        }
        if (slideId === currentSlideId) {
          return;
        }
        if (queuedIds.has(version)) {
          return;
        }

        additions.push(takeoverEventsBySlideId.get(slideId));
      });

      if (additions.length > 0 && !takeoverResumeSlideIdRef.current) {
        takeoverResumeSlideIdRef.current = currentSlideId || filtered[0]?.slideId || displaySlides[0]?.id || '';
      }

      return additions.length > 0 ? [...filtered, ...additions] : filtered;
    });

    knownTakeoverVersionsRef.current = nextTakeoverVersions;

    if (!hasHydratedTakeoversRef.current) {
      hasHydratedTakeoversRef.current = true;
    }
  }, [currentSlideId, displaySlides]);

  const currentSlideIndex = useMemo(() => {
    if (!displaySlides.length) return -1;
    return displaySlides.findIndex((slide) => slide.id === currentSlideId);
  }, [currentSlideId, displaySlides]);
  const normalActiveSlideIndex = displaySlides.length === 0 ? 0 : currentSlideIndex === -1 ? 0 : currentSlideIndex;
  const activeTakeover = takeoverQueue[0] || null;
  const activeTakeoverSlideIndex = useMemo(() => {
    if (!activeTakeover || !activeTakeover.slideId) return -1;
    return displaySlides.findIndex((slide) => slide.id === activeTakeover.slideId);
  }, [activeTakeover, displaySlides]);
  const activeSlideIndex = activeTakeoverSlideIndex !== -1 ? activeTakeoverSlideIndex : normalActiveSlideIndex;

  useEffect(() => {
    if (takeoverQueue.length === 0) {
      takeoverResumeSlideIdRef.current = '';
    }
  }, [takeoverQueue.length]);

  const currentSlide = displaySlides[activeSlideIndex] || null;
  const currentAnnouncement = currentSlide ? currentSlide.announcement : null;
  const currentAnnouncementMediaGroup = useMemo(
    () => (currentSlide && Array.isArray(currentSlide.mediaItems) ? currentSlide.mediaItems : []),
    [currentSlide]
  );
  const currentAnnouncementMediaGroupCount = currentAnnouncementMediaGroup.length;
  const announcementMediaPageCount = Math.max(
    1,
    Math.ceil(currentAnnouncementMediaGroupCount / maxVisibleMediaItems)
  );
  const activeAnnouncementMediaPage = Math.min(
    currentMediaGroupPage,
    Math.max(0, announcementMediaPageCount - 1)
  );
  const currentAnnouncementMediaGroupPageItems = useMemo(() => {
    if (currentAnnouncementMediaGroupCount === 0) return [];
    const startIndex = activeAnnouncementMediaPage * maxVisibleMediaItems;
    return currentAnnouncementMediaGroup.slice(startIndex, startIndex + maxVisibleMediaItems);
  }, [activeAnnouncementMediaPage, currentAnnouncementMediaGroup, currentAnnouncementMediaGroupCount, maxVisibleMediaItems]);

  const currentAnnouncementId = currentAnnouncement ? String(currentAnnouncement.id || '') : '';
  const currentAnnouncementHasVideo = isVideoMedia(currentAnnouncement);
  const currentAnnouncementHasDocument = isDocumentMedia(currentAnnouncement);
  const currentAnnouncementIsPresentation = isPresentationMedia(currentAnnouncement);
  const currentAnnouncementHasAnyMedia = currentAnnouncementMediaGroupCount > 0;
  const currentAnnouncementTitle = String((currentAnnouncement && currentAnnouncement.title) || '').trim();
  const currentAnnouncementContent = String((currentAnnouncement && currentAnnouncement.content) || '').trim();
  const announcementTextSlides = useMemo(
    () => buildAnnouncementTextSlides(currentAnnouncementTitle, currentAnnouncementContent),
    [currentAnnouncementContent, currentAnnouncementTitle]
  );
  const announcementTextPageCount = announcementTextSlides.length;
  const activeAnnouncementTextPage = Math.min(
    currentAnnouncementTextPage,
    Math.max(0, announcementTextPageCount - 1)
  );
  const currentAnnouncementTextSlide =
    announcementTextSlides[activeAnnouncementTextPage] || null;
  const currentAnnouncementHasText = Boolean(currentAnnouncementTitle || currentAnnouncementContent);
  const shouldShowEmergencyContent = currentAnnouncementHasText || !currentAnnouncementHasAnyMedia;
  const currentAnnouncementMediaWidth = Number.parseInt(currentAnnouncement && currentAnnouncement.mediaWidth, 10);
  const currentAnnouncementMediaHeight = Number.parseInt(currentAnnouncement && currentAnnouncement.mediaHeight, 10);
  const hasMediaDimensions =
    Number.isFinite(currentAnnouncementMediaWidth) &&
    currentAnnouncementMediaWidth > 0 &&
    Number.isFinite(currentAnnouncementMediaHeight) &&
    currentAnnouncementMediaHeight > 0;
  const mediaAspectStyle = useMemo(() => {
    if (!currentAnnouncementHasAnyMedia) {
      return undefined;
    }
    if (!currentAnnouncementHasDocument) {
      return undefined;
    }
    if (hasMediaDimensions) {
      return { aspectRatio: `${currentAnnouncementMediaWidth} / ${currentAnnouncementMediaHeight}` };
    }
    return { aspectRatio: currentAnnouncementIsPresentation ? '16 / 9' : '16 / 10' };
  }, [
    currentAnnouncementHasAnyMedia,
    currentAnnouncementHasDocument,
    currentAnnouncementIsPresentation,
    currentAnnouncementMediaHeight,
    currentAnnouncementMediaWidth,
    hasMediaDimensions
  ]);
  const globalLiveLinks = useMemo(() => {
    const sourceLinks =
      Array.isArray(liveLinks) && liveLinks.length > 0 ? liveLinks : liveLink ? [liveLink] : [];
    return normalizeLiveLinkArray(sourceLinks, MAX_GLOBAL_STREAM_LINKS);
  }, [liveLink, liveLinks]);
  const announcementLiveLinks = useMemo(
    () => normalizeLiveLinkArray(currentAnnouncement?.liveStreamLinks || [], MAX_ANNOUNCEMENT_STREAM_LINKS),
    [currentAnnouncement]
  );
  const normalizedDisplayCategory = String(displayCategoryId || 'all').trim() || 'all';
  const normalizedLiveCategory = normalizeLiveCategory(liveCategory);
  const isLiveVisibleForDisplay =
    normalizedLiveCategory === 'all' ||
    normalizedDisplayCategory === 'all' ||
    normalizedDisplayCategory === normalizedLiveCategory;
  const isLiveOn = liveStatus === 'ON' && isLiveVisibleForDisplay;
  const hasAnnouncementStreams = announcementLiveLinks.length > 0;
  const showLivePanel = isLiveOn || hasAnnouncementStreams;
  const shouldUsePresentationFocusLayout =
    !showLivePanel &&
    currentAnnouncementMediaGroupCount <= 1 &&
    currentAnnouncementIsPresentation &&
    !currentAnnouncementHasText;
  const activeLiveStreamEmbeds = useMemo(() => {
    const parentHost =
      typeof window !== 'undefined' && window.location && window.location.hostname
        ? window.location.hostname
        : 'localhost';
    const candidateLinks = normalizeLiveLinkArray(
      isLiveOn ? [...globalLiveLinks, ...announcementLiveLinks] : announcementLiveLinks,
      MAX_GLOBAL_STREAM_LINKS + MAX_ANNOUNCEMENT_STREAM_LINKS
    );
    const seenStreamIds = new Set();

    return candidateLinks
      .map((link) => toLiveStreamEmbed(link, { isAudioMuted, parentHost }))
      .filter((stream) => {
        if (!stream || seenStreamIds.has(stream.id)) {
          return false;
        }
        seenStreamIds.add(stream.id);
        return true;
      });
  }, [announcementLiveLinks, globalLiveLinks, isAudioMuted, isLiveOn]);
  const visibleLiveStreamEmbeds = useMemo(
    () => activeLiveStreamEmbeds.slice(0, maxVisibleMediaItems),
    [activeLiveStreamEmbeds, maxVisibleMediaItems]
  );
  const hiddenLiveStreamCount = Math.max(0, activeLiveStreamEmbeds.length - visibleLiveStreamEmbeds.length);
  const liveSourceTiles = useMemo(() => {
    if (!showLivePanel) return [];
    return visibleLiveStreamEmbeds.map((stream, index) => ({
        id: `stream-${stream.id}-${index}`,
        kind: 'stream',
        stream
    }));
  }, [showLivePanel, visibleLiveStreamEmbeds]);
  const combinedLiveTiles = useMemo(() => {
    if (!showLivePanel) return [];
    return liveSourceTiles;
  }, [liveSourceTiles, showLivePanel]);
  const showAnnouncementMediaPanel =
    !showLivePanel && currentAnnouncementMediaGroupCount > 0 && !shouldUsePresentationFocusLayout;
  const isAnnouncementMediaShownInLivePanel = false;
  const showSecondaryPanel = showLivePanel || showAnnouncementMediaPanel;
  const isSingleColumnLayout = !showSecondaryPanel;
  const activePanelPageCount = showLivePanel ? 1 : announcementMediaPageCount;
  const activePanelPageIndex = showLivePanel ? 0 : activeAnnouncementMediaPage;

  useEffect(() => {
    const maxPageIndex = Math.max(0, activePanelPageCount - 1);
    if (currentMediaGroupPage <= maxPageIndex) {
      return;
    }
    setCurrentMediaGroupPage(maxPageIndex);
  }, [activePanelPageCount, currentMediaGroupPage]);

  const announcementMediaStatusLabel =
    currentAnnouncementMediaGroupCount > 1
      ? `Posted ${currentAnnouncementMediaGroupCount} attachments${
          announcementMediaPageCount > 1
            ? ` • Panel ${activeAnnouncementMediaPage + 1} of ${announcementMediaPageCount}`
            : ''
        }`
      : currentAnnouncementHasVideo
        ? 'Posted video'
        : currentAnnouncementHasDocument
          ? 'Posted document'
          : 'Posted image';
  const liveTileCount = combinedLiveTiles.length;
  const liveSplitColumns = getSplitColumnCount(liveTileCount);
  const liveSplitRows = getSplitRowCount(liveTileCount, liveSplitColumns);
  const mediaSplitColumns = getSplitColumnCount(currentAnnouncementMediaGroupPageItems.length);
  const mediaSplitRows = getSplitRowCount(
    currentAnnouncementMediaGroupPageItems.length,
    mediaSplitColumns
  );
  const liveGridStyle = useMemo(
    () => ({
      gridTemplateColumns: `repeat(${liveSplitColumns}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${liveSplitRows}, minmax(0, 1fr))`
    }),
    [liveSplitColumns, liveSplitRows]
  );
  const mediaGridStyle = useMemo(
    () => ({
      gridTemplateColumns: `repeat(${mediaSplitColumns}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${mediaSplitRows}, minmax(0, 1fr))`
    }),
    [mediaSplitColumns, mediaSplitRows]
  );
  const liveStreamsStatusText = useMemo(() => {
    const visibleCount = liveSourceTiles.length;
    if (visibleCount === 0) {
      return 'No active stream source';
    }
    if (hiddenLiveStreamCount > 0) {
      return `${activeLiveStreamEmbeds.length} streams configured • showing ${visibleCount} always-on`;
    }
    return `${visibleCount} ${visibleCount === 1 ? 'stream' : 'streams'} live`;
  }, [activeLiveStreamEmbeds.length, hiddenLiveStreamCount, liveSourceTiles.length]);
  const showAnnouncementFallbackText =
    currentAnnouncementHasAnyMedia && !currentAnnouncementHasText && !shouldUsePresentationFocusLayout;
  const shouldShowTextSlideHero =
    !showLivePanel && !currentAnnouncementHasAnyMedia && announcementTextPageCount > 0;
  const shouldTreatTextSlidesAsPrimaryPages =
    !showLivePanel && !showAnnouncementMediaPanel && announcementTextPageCount > 1;
  const shouldUseAnnouncementStageLayout =
    shouldUsePresentationFocusLayout || shouldShowTextSlideHero;
  const announcementPanelTitle =
    currentAnnouncementTextSlide?.title ||
    currentAnnouncementTitle ||
    (currentAnnouncementIsPresentation ? 'Presentation' : 'Notice Attachment');
  const announcementPanelContent =
    currentAnnouncementTextSlide?.content ||
    currentAnnouncementContent ||
    'Media has been posted without additional text content.';

  useEffect(() => {
    const maxPageIndex = Math.max(0, announcementTextPageCount - 1);
    if (currentAnnouncementTextPage <= maxPageIndex) {
      return;
    }
    setCurrentAnnouncementTextPage(maxPageIndex);
  }, [announcementTextPageCount, currentAnnouncementTextPage]);

  const getAdjacentSlideId = useCallback(
    (baseSlideId, direction = 1) => {
      if (!displaySlides.length) {
        return '';
      }

      const safeDirection = direction < 0 ? -1 : 1;
      const baseIndex = displaySlides.findIndex((slide) => slide.id === baseSlideId);
      if (baseIndex === -1) {
        return displaySlides[safeDirection === -1 ? displaySlides.length - 1 : 0]?.id || '';
      }

      const nextIndex = (baseIndex + safeDirection + displaySlides.length) % displaySlides.length;
      return displaySlides[nextIndex]?.id || displaySlides[0]?.id || '';
    },
    [displaySlides]
  );

  const advanceScheduledSequence = useCallback(
    (direction = 1) => {
      if (!displaySlides.length) {
        setCurrentSlideId('');
        return;
      }

      if (activeTakeover) {
        const resumeBaseId = takeoverResumeSlideIdRef.current || currentSlideId || displaySlides[0]?.id || '';
        const hasMoreQueuedTakeovers = takeoverQueue.length > 1;
        setTakeoverQueue((previous) => previous.slice(1));

        if (!hasMoreQueuedTakeovers) {
          takeoverResumeSlideIdRef.current = '';
          setCurrentSlideId(getAdjacentSlideId(resumeBaseId, direction));
        }
        return;
      }

      setCurrentSlideId((previous) => getAdjacentSlideId(previous, direction));
    },
    [activeTakeover, currentSlideId, displaySlides, getAdjacentSlideId, takeoverQueue.length]
  );

  useEffect(() => {
    if (!isPlaying) return;

    const canRotatePanels = activePanelPageCount > 1;
    const canRotateSlides = displaySlides.length > 1;
    if (!canRotatePanels && !canRotateSlides) {
      return;
    }

    const shouldPauseAnnouncementRotation =
      !showLivePanel &&
      currentAnnouncementMediaGroupCount <= 1 &&
      currentAnnouncementHasDocument &&
      documentSlideCount > 1;
    const shouldPauseAnnouncementRotationForText = shouldTreatTextSlidesAsPrimaryPages;
    if (shouldPauseAnnouncementRotation || shouldPauseAnnouncementRotationForText) {
      return;
    }

    const interval = setInterval(() => {
      setCurrentMediaGroupPage((previousPage) => {
        if (canRotatePanels && previousPage < activePanelPageCount - 1) {
          return previousPage + 1;
        }
        if (canRotateSlides) {
          advanceScheduledSequence(1);
        }
        return 0;
      });
    }, displayRotationIntervalMs);

    return () => clearInterval(interval);
  }, [
    activePanelPageCount,
    advanceScheduledSequence,
    currentAnnouncementHasDocument,
    currentAnnouncementMediaGroupCount,
    displayRotationIntervalMs,
    displaySlides.length,
    documentSlideCount,
    isPlaying,
    shouldTreatTextSlidesAsPrimaryPages,
    showLivePanel
  ]);

  const categoryLabel = currentAnnouncement
    ? getCategoryName(currentAnnouncement.category)
    : null;

  const liveBadgeClass = showLivePanel ? 'pill pill--success' : 'pill pill--danger';
  const liveStatusLabel = isLiveOn ? 'ON' : hasAnnouncementStreams ? 'ANNOUNCEMENT' : 'OFF';
  const isEmergency =
    currentAnnouncement?.isEmergency === true || Number(currentAnnouncement?.priority) === 0;

  useEffect(() => {
    setCurrentMediaGroupPage(0);
    setDocumentSlideCount(1);
    setDocumentSlideIndex(1);
    setCurrentAnnouncementTextPage(0);
    previousDocumentSlideIndexRef.current = 1;
    documentCycleCountRef.current = 0;
  }, [currentAnnouncementId]);

  useEffect(() => {
    if (!isPlaying || announcementTextPageCount <= 1) {
      return undefined;
    }

    const interval = setInterval(() => {
      setCurrentAnnouncementTextPage((previous) => {
        if (previous < announcementTextPageCount - 1) {
          return previous + 1;
        }

        if (shouldTreatTextSlidesAsPrimaryPages && displaySlides.length > 1) {
          advanceScheduledSequence(1);
        }

        return 0;
      });
    }, displayRotationIntervalMs);

    return () => clearInterval(interval);
  }, [
    advanceScheduledSequence,
    announcementTextPageCount,
    displayRotationIntervalMs,
    displaySlides.length,
    isPlaying,
    shouldTreatTextSlidesAsPrimaryPages
  ]);

  useEffect(() => {
    if (
      !isPlaying ||
      showLivePanel ||
      displaySlides.length <= 1 ||
      currentAnnouncementMediaGroupCount > 1 ||
      !currentAnnouncementHasDocument ||
      documentSlideCount <= 1
    ) {
      previousDocumentSlideIndexRef.current = documentSlideIndex;
      return;
    }

    const previousIndex = previousDocumentSlideIndexRef.current;
    if (previousIndex === documentSlideCount && documentSlideIndex === 1) {
      documentCycleCountRef.current += 1;

      // Let each document complete at least one full loop and restart from page 1.
      if (documentCycleCountRef.current >= 2) {
        advanceScheduledSequence(1);
        documentCycleCountRef.current = 0;
      }
    }

    previousDocumentSlideIndexRef.current = documentSlideIndex;
  }, [
    currentAnnouncementMediaGroupCount,
    currentAnnouncementHasDocument,
    displaySlides.length,
    documentSlideCount,
    documentSlideIndex,
    advanceScheduledSequence,
    isPlaying,
    showLivePanel
  ]);

  const actionHint = useMemo(() => {
    if (!displaySlides.length) {
      if (showLivePanel) {
        if (hiddenLiveStreamCount > 0) {
          return `Live always on (${liveSourceTiles.length} of ${activeLiveStreamEmbeds.length} streams shown)`;
        }
        return `${liveSourceTiles.length > 0 ? `Live always on (${liveSourceTiles.length} ${liveSourceTiles.length === 1 ? 'stream' : 'streams'})` : 'Live mode active'}`;
      }
      return 'No scheduled announcements';
    }
    const announcementLabel = `Slide ${activeSlideIndex + 1} of ${displaySlides.length}`;
    if (activeTakeover) {
      const takeoverLabel =
        activeTakeover.reason === 'emergency'
          ? 'Emergency announcement is leading the rotation'
          : activeTakeover.reason === 'live'
            ? 'Live announcement is leading the rotation'
            : 'Priority announcement is leading the rotation';
      return `${announcementLabel} • ${takeoverLabel} • resuming the scheduled next slide after this item`;
    }
    if (showLivePanel) {
      if (hiddenLiveStreamCount > 0) {
        return `${announcementLabel} • Live always on (${liveSourceTiles.length}/${activeLiveStreamEmbeds.length} streams shown)`;
      }
      return `${announcementLabel} • Live always on (${liveSourceTiles.length} ${liveSourceTiles.length === 1 ? 'stream' : 'streams'})`;
    }
    if (shouldTreatTextSlidesAsPrimaryPages) {
      return `${announcementLabel} • Text slide ${activeAnnouncementTextPage + 1} of ${announcementTextPageCount}`;
    }
    if (currentAnnouncementMediaGroupCount > 1) {
      if (announcementMediaPageCount > 1) {
        return `${announcementLabel} • Split view (${currentAnnouncementMediaGroupCount} attachments) • Panel ${
          activeAnnouncementMediaPage + 1
        } of ${announcementMediaPageCount}`;
      }
      return `${announcementLabel} • Split view (${currentAnnouncementMediaGroupCount} attachments)`;
    }
    if (!showLivePanel && currentAnnouncementHasDocument && documentSlideCount > 1) {
      const slideLabel = currentAnnouncementIsPresentation ? 'Slide' : 'Page';
      const suffix = currentAnnouncementIsPresentation ? ' • Presentation loop active' : '';
      return `${announcementLabel} • ${slideLabel} ${documentSlideIndex} of ${documentSlideCount}${suffix}`;
    }
    return announcementLabel;
  }, [
    activeLiveStreamEmbeds.length,
    activeAnnouncementMediaPage,
    activeAnnouncementTextPage,
    activeSlideIndex,
    activeTakeover,
    announcementMediaPageCount,
    announcementTextPageCount,
    currentAnnouncementMediaGroupCount,
    currentAnnouncementHasDocument,
    currentAnnouncementIsPresentation,
    displaySlides.length,
    documentSlideCount,
    documentSlideIndex,
    hiddenLiveStreamCount,
    liveSourceTiles.length,
    shouldTreatTextSlidesAsPrimaryPages,
    showLivePanel
  ]);
  const rotationControlLabel = isPlaying ? 'Pause Auto-Rotate' : 'Resume Auto-Rotate';

  useEffect(() => {
    if (showLivePanel && !isPlaying) {
      setIsPlaying(true);
    }
  }, [isPlaying, showLivePanel]);

  const handleNext = () => {
    if (!displaySlides.length) {
      if (!showLivePanel || activePanelPageCount <= 1) return;
      setCurrentMediaGroupPage((previous) =>
        previous < activePanelPageCount - 1 ? previous + 1 : 0
      );
      return;
    }

    if (shouldTreatTextSlidesAsPrimaryPages && activeAnnouncementTextPage < announcementTextPageCount - 1) {
      setCurrentAnnouncementTextPage((previous) =>
        Math.min(previous + 1, Math.max(0, announcementTextPageCount - 1))
      );
      return;
    }

    if (activePanelPageCount > 1 && activePanelPageIndex < activePanelPageCount - 1) {
      setCurrentMediaGroupPage((previous) => Math.min(previous + 1, activePanelPageCount - 1));
      return;
    }

    if (shouldTreatTextSlidesAsPrimaryPages) {
      setCurrentAnnouncementTextPage(0);
    }
    setCurrentMediaGroupPage(0);
    advanceScheduledSequence(1);
  };

  const handlePrev = () => {
    if (!displaySlides.length) {
      if (!showLivePanel || activePanelPageCount <= 1) return;
      setCurrentMediaGroupPage((previous) =>
        previous > 0 ? previous - 1 : Math.max(0, activePanelPageCount - 1)
      );
      return;
    }

    if (shouldTreatTextSlidesAsPrimaryPages && activeAnnouncementTextPage > 0) {
      setCurrentAnnouncementTextPage((previous) => Math.max(previous - 1, 0));
      return;
    }

    if (activePanelPageCount > 1 && activePanelPageIndex > 0) {
      setCurrentMediaGroupPage((previous) => Math.max(previous - 1, 0));
      return;
    }

    if (shouldTreatTextSlidesAsPrimaryPages) {
      setCurrentAnnouncementTextPage(Math.max(0, announcementTextPageCount - 1));
    }
    setCurrentMediaGroupPage(0);
    advanceScheduledSequence(-1);
  };

  const handleLogout = async () => {
    try {
      await apiClient.post(apiUrl('/api/auth/logout'), {}, withAuthConfig());
    } catch (error) {
      console.error('Error logging out:', error);
    } finally {
      clearAdminSession();
      window.location.reload();
    }
  };

  const handleDisplayLogout = async () => {
    try {
      await apiClient.post(apiUrl('/api/display-auth/logout'), {}, withDisplayAuthConfig());
    } catch (error) {
      console.error('Error logging out display access:', error);
    } finally {
      clearDisplaySession();
      navigate('/display/login');
    }
  };

  const handleAudioToggle = () => {
    setIsAudioMuted((value) => !value);
  };

  if (!currentAnnouncement && !showLivePanel) {
    return (
      <div className="display-page fade-up">
        <div className="display-shell">
          <header className="display-header">
            <div className="display-header__brand">
              <p className="topbar__eyebrow">Digital Notice Board</p>
              <h2>Public Display</h2>
            </div>
            <div className="display-header__title">
              <h1>No Announcements Yet</h1>
              <p>
                {displayCategoryLabel
                  ? `No announcements in ${displayCategoryLabel}.`
                  : 'No announcements are available.'}
              </p>
            </div>
            <div className="display-meta display-meta--header">
              <TopbarStatus className="topbar-status--display" />
              <div className="display-meta__actions">
                <button className="btn btn--ghost btn--tiny" type="button" onClick={toggleTheme}>
                  {isDark ? 'Light Mode' : 'Dark Mode'}
                </button>
                <button className="btn btn--danger btn--tiny" type="button" onClick={handleDisplayLogout}>
                  Display Logout
                </button>
                {isAdmin ? (
                  <button className="btn btn--danger btn--tiny" type="button" onClick={handleLogout}>
                    Admin Logout
                  </button>
                ) : null}
              </div>
            </div>
          </header>

          {requestError ? <div className="auth-error">{requestError}</div> : null}

          <main className="card section empty-state">
            <h3 className="display-empty-title">Display Is Ready</h3>
            <p className="display-empty-copy">
              The board is online and waiting for published announcements.
            </p>
          </main>

          <footer className="display-footer">
            <p className="footer-hint">Publish notices from Admin to start the display cycle.</p>
          </footer>
        </div>
      </div>
    );
  }

  if (!currentAnnouncement && showLivePanel) {
    return (
      <div className="display-page fade-up">
        <div className="display-shell">
          <header className="display-header">
            <div className="display-header__brand">
              <p className="topbar__eyebrow">Digital Notice Board</p>
              <div className={`${liveBadgeClass} live-status-pill`}>
                <span className="badge-dot" />
                Live Status: {liveStatusLabel}
              </div>
            </div>
            <div className="display-header__title display-header__title--main">
              <h1>Live Broadcast Mode</h1>
              <p>
                {displayCategoryLabel
                  ? `Viewing: ${displayCategoryLabel}`
                  : 'Live stream is running without scheduled announcements.'}
              </p>
            </div>
            <div className="display-meta display-meta--header">
              <TopbarStatus className="topbar-status--display" />
              <div className="display-meta__actions">
                <button className="btn btn--ghost btn--tiny" type="button" onClick={toggleTheme}>
                  {isDark ? 'Light Mode' : 'Dark Mode'}
                </button>
                <button className="btn btn--danger btn--tiny" type="button" onClick={handleDisplayLogout}>
                  Display Logout
                </button>
                {isAdmin ? (
                  <button className="btn btn--danger btn--tiny" type="button" onClick={handleLogout}>
                    Admin Logout
                  </button>
                ) : null}
              </div>
            </div>
          </header>

          {requestError ? <div className="auth-error">{requestError}</div> : null}

          <main className="display-main display-main--single">
            <section className="live-panel display-panel">
              <div className="panel-head">
                <h2>Live Broadcast</h2>
                <div className="inline-actions live-panel-actions">
                  <p className="topbar__subtitle">{liveStreamsStatusText}</p>
                  {activeLiveStreamEmbeds.length > 0 ? (
                    <button className="btn btn--ghost btn--tiny" type="button" onClick={handleAudioToggle}>
                      {isAudioMuted ? 'Unmute' : 'Mute'}
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="live-body">
                {liveTileCount > 0 ? (
                  <div
                    className="live-stream-grid"
                    style={liveGridStyle}
                  >
                    {combinedLiveTiles.map((tile, index) => {
                      const tileStream = tile.stream;
                      const streamSrc = withAutoplay(tileStream.embedUrl, tileStream.provider, true);
                      return (
                        <iframe
                          className="live-stream-grid__frame"
                          key={`${tile.id}-${isAudioMuted ? 'muted' : 'sound'}-${liveReconnectToken}`}
                          title={`${tileStream.provider || 'Live'} Broadcast ${index + 1}`}
                          src={streamSrc}
                          allow="autoplay; encrypted-media; fullscreen"
                          allowFullScreen
                        />
                      );
                    })}
                  </div>
                ) : (
                  <div className="live-placeholder">
                    <h3>Live Broadcast Unavailable</h3>
                    <p>Live mode is ON, but no stream source is currently available.</p>
                  </div>
                )}
              </div>
            </section>
          </main>

          <footer className="display-footer">
            <p className="footer-hint">{actionHint}</p>

            <div className="controls">
              <button className="btn btn--ghost btn--tiny" type="button" onClick={handlePrev}>
                Previous
              </button>
              <button className="btn btn--ghost btn--tiny" type="button" onClick={handleNext}>
                Next
              </button>
            </div>

            <div className="dot-pager">
              {Array.from({ length: Math.max(1, activePanelPageCount) }).map((_, index) => (
                <span key={`live-only-page-${index}`} className={index === activePanelPageIndex ? 'is-active' : ''} />
              ))}
            </div>
          </footer>
        </div>
      </div>
    );
  }

  if (isEmergency) {
    return (
      <div className="display-page display-page--emergency display-page--emergency-override fade-up">
        <div className="display-shell display-shell--emergency-override">
          <header className="emergency-override-header card emergency-frame">
            <div className="emergency-override-header__left">
              <p className="topbar__eyebrow emergency-override-header__eyebrow">Emergency Override</p>
              <h1>Emergency Broadcast Mode</h1>
              <p className="emergency-override-header__meta">
                {categoryLabel
                  ? `Category: ${categoryLabel}`
                  : displayCategoryLabel
                    ? `Viewing: ${displayCategoryLabel}`
                    : 'General Announcements'}
              </p>
              <span className="emergency-banner emergency-banner--strong">
                Emergency Announcement Active
              </span>
            </div>

            <div className="emergency-override-header__right">
              <TopbarStatus className="topbar-status--display" />
              <div className="display-meta__actions">
                <button className="btn btn--ghost btn--tiny" type="button" onClick={toggleTheme}>
                  {isDark ? 'Light Mode' : 'Dark Mode'}
                </button>
                <button className="btn btn--danger btn--tiny" type="button" onClick={handleDisplayLogout}>
                  Display Logout
                </button>
                {isAdmin ? (
                  <button className="btn btn--danger btn--tiny" type="button" onClick={handleLogout}>
                    Admin Logout
                  </button>
                ) : null}
              </div>
            </div>
          </header>

          {requestError ? <div className="auth-error">{requestError}</div> : null}

          <main className="emergency-override-main card emergency-frame">
            <div
              className={`emergency-override-main__grid ${
                currentAnnouncementHasAnyMedia && shouldShowEmergencyContent
                  ? 'emergency-override-main__grid--with-media'
                  : ''
              }`.trim()}
            >
              {currentAnnouncementHasAnyMedia ? (
                <section className="emergency-override-main__media">
                  <div className="announcement-media-frame announcement-media-frame--emergency" style={mediaAspectStyle}>
                    <AttachmentPreview
                      filePath={currentAnnouncement.image}
                      fileName={currentAnnouncement.fileName}
                      typeHint={currentAnnouncement.fileMimeType || currentAnnouncement.type}
                      fileSizeBytes={currentAnnouncement.fileSizeBytes}
                      className="media-preview--full media-preview--display media-preview--emergency"
                      documentPreview
                    documentHideHeader
                    documentShowActions={false}
                    documentSlideshow
                    documentSlideshowAutoplay={isPlaying}
                    documentSlideshowIntervalMs={documentSlideshowIntervalMs}
                    documentSlideshowShowControls={false}
                    documentSlideshowShowDots={false}
                    showActions={false}
                    title={currentAnnouncementTitle || 'Attachment'}
                    imageAlt={currentAnnouncementTitle || 'Attachment'}
                    />
                  </div>
                </section>
              ) : null}

              {shouldShowEmergencyContent ? (
                <section className="emergency-override-main__content">
                  <p className="announcement-kicker emergency-override-main__kicker">
                    Immediate Attention Required
                  </p>
                  {currentAnnouncementTitle ? (
                    <h2 className="emergency-override-main__title">{currentAnnouncementTitle}</h2>
                  ) : null}
                  {currentAnnouncementContent ? (
                    <p className="emergency-override-main__copy">{currentAnnouncementContent}</p>
                  ) : null}
                </section>
              ) : null}
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className={`display-page fade-up ${isEmergency ? 'display-page--emergency' : ''}`}>
      <div className="display-shell">
        <header className="display-header">
          <div className="display-header__brand">
            <p className="topbar__eyebrow">Digital Notice Board</p>
            <div className={`${liveBadgeClass} live-status-pill`}>
              <span className="badge-dot" />
              Live Status: {liveStatusLabel}
            </div>
          </div>

          <div className="display-header__title display-header__title--main">
            <h1>{isEmergency ? 'Emergency Broadcast Mode' : 'Smart Notice Display'}</h1>
            <p>
              {categoryLabel
                ? `Category: ${categoryLabel}`
                : displayCategoryLabel
                  ? `Viewing: ${displayCategoryLabel}`
                  : 'General Announcements'}
            </p>
            {isEmergency ? <span className="emergency-banner">Emergency Active</span> : null}
          </div>

          <div className="display-meta display-meta--header">
            <TopbarStatus className="topbar-status--display" />
            <div className="display-meta__actions">
              <button className="btn btn--ghost btn--tiny" type="button" onClick={toggleTheme}>
                {isDark ? 'Light Mode' : 'Dark Mode'}
              </button>
              <button className="btn btn--danger btn--tiny" type="button" onClick={handleDisplayLogout}>
                Display Logout
              </button>
              {isAdmin ? (
                <button className="btn btn--danger btn--tiny" type="button" onClick={handleLogout}>
                  Admin Logout
                </button>
              ) : null}
            </div>
          </div>
        </header>

        {requestError ? <div className="auth-error">{requestError}</div> : null}

        <main className={`display-main ${isSingleColumnLayout ? 'display-main--single' : ''}`.trim()}>
          {showLivePanel ? (
            <section className={`live-panel display-panel ${isEmergency ? 'emergency-frame' : ''}`}>
            <div className="panel-head">
              <h2>Live Broadcast</h2>
              <div className="inline-actions live-panel-actions">
                <p className="topbar__subtitle">{liveStreamsStatusText}</p>
                {activeLiveStreamEmbeds.length > 0 ? (
                  <button className="btn btn--ghost btn--tiny" type="button" onClick={handleAudioToggle}>
                    {isAudioMuted ? 'Unmute' : 'Mute'}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="live-body">
              {liveTileCount > 0 ? (
                <div
                  className="live-stream-grid"
                  style={liveGridStyle}
                >
                  {combinedLiveTiles.map((tile, index) => {
                    const tileStream = tile.stream;
                    const streamSrc = withAutoplay(tileStream.embedUrl, tileStream.provider, true);
                    return (
                      <iframe
                        className="live-stream-grid__frame"
                        key={`${tile.id}-${isAudioMuted ? 'muted' : 'sound'}-${liveReconnectToken}`}
                        title={`${tileStream.provider || 'Live'} Broadcast ${index + 1}`}
                        src={streamSrc}
                        allow="autoplay; encrypted-media; fullscreen"
                        allowFullScreen
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="live-placeholder">
                  <h3>Live Broadcast Unavailable</h3>
                  <p>
                    {isLiveOn
                      ? 'Live mode is ON, but no stream source is currently available.'
                      : 'This announcement has live links, but none could be embedded on this display.'}
                  </p>
                </div>
              )}
            </div>
            </section>
          ) : null}

          {showAnnouncementMediaPanel ? (
            <section className={`live-panel display-panel ${isEmergency ? 'emergency-frame' : ''}`}>
              <div className="panel-head">
                <h2>Announcement Media</h2>
                <div className="inline-actions">
                  <p className="topbar__subtitle">
                    {announcementMediaStatusLabel}
                  </p>
                </div>
              </div>
              <div className="live-body">
                <div
                  className={`announcement-media-frame announcement-media-frame--panel ${
                    currentAnnouncementMediaGroupCount > 1 ? 'announcement-media-frame--split' : ''
                  }`.trim()}
                  style={
                    currentAnnouncementMediaGroupCount > 1
                      ? { aspectRatio: 'auto' }
                      : mediaAspectStyle
                  }
                >
                  {currentAnnouncementMediaGroupCount > 1 ? (
                    <div
                      className="announcement-media-split-grid"
                      style={mediaGridStyle}
                    >
                      {currentAnnouncementMediaGroupPageItems.map((item, index) => (
                        <div className="announcement-media-split-grid__item" key={item.id || `split-${index}`}>
                          <AttachmentPreview
                            filePath={item.image}
                            fileName={item.fileName}
                            typeHint={item.fileMimeType || item.type}
                            fileSizeBytes={item.fileSizeBytes}
                            className="media-preview--full media-preview--display media-preview--display-panel media-preview--split-item"
                            documentPreview
                            documentHideHeader
                            documentShowActions={false}
                            documentSlideshow
                            documentSlideshowAutoplay={isPlaying}
                            documentSlideshowIntervalMs={documentSlideshowIntervalMs}
                            documentSlideshowShowControls={false}
                            documentSlideshowShowDots={false}
                            title={item.title || `Attachment ${index + 1}`}
                            imageAlt={item.title || `Attachment ${index + 1}`}
                            showActions={false}
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <AttachmentPreview
                      filePath={
                        currentAnnouncementMediaGroupPageItems[0]?.image ||
                        currentAnnouncementMediaGroup[0]?.image ||
                        currentAnnouncement.image
                      }
                      fileName={
                        currentAnnouncementMediaGroupPageItems[0]?.fileName ||
                        currentAnnouncementMediaGroup[0]?.fileName ||
                        currentAnnouncement.fileName
                      }
                      typeHint={
                        currentAnnouncementMediaGroupPageItems[0]?.fileMimeType ||
                        currentAnnouncementMediaGroupPageItems[0]?.type ||
                        currentAnnouncementMediaGroup[0]?.fileMimeType ||
                        currentAnnouncementMediaGroup[0]?.type ||
                        currentAnnouncement.fileMimeType ||
                        currentAnnouncement.type
                      }
                      fileSizeBytes={
                        currentAnnouncementMediaGroupPageItems[0]?.fileSizeBytes ||
                        currentAnnouncementMediaGroup[0]?.fileSizeBytes ||
                        currentAnnouncement.fileSizeBytes
                      }
                      className={`media-preview--full media-preview--display media-preview--display-panel ${
                        currentAnnouncementIsPresentation ? 'media-preview--presentation-stage' : ''
                      }`.trim()}
                      documentPreview
                      documentHideHeader
                      documentShowActions={false}
                      documentSlideshow
                      documentSlideshowAutoplay={isPlaying}
                      documentSlideshowIntervalMs={documentSlideshowIntervalMs}
                      documentSlideshowShowControls={false}
                      documentSlideshowShowDots={false}
                      onDocumentSlideCountChange={
                        currentAnnouncementHasDocument && currentAnnouncementMediaGroupCount <= 1
                          ? handleDocumentSlideCountChange
                          : undefined
                      }
                      onDocumentSlideIndexChange={
                        currentAnnouncementHasDocument && currentAnnouncementMediaGroupCount <= 1
                          ? handleDocumentSlideIndexChange
                          : undefined
                      }
                      title={announcementPanelTitle}
                      imageAlt={announcementPanelTitle}
                      showActions={false}
                    />
                  )}
                </div>
              </div>
            </section>
          ) : null}

          <section
            className={`announcement-panel display-panel ${
              shouldUseAnnouncementStageLayout ? 'display-panel--media-only' : ''
            } ${isEmergency ? 'emergency-frame' : ''}`.trim()}
          >
            {!shouldUseAnnouncementStageLayout ? (
              <div className="panel-head">
                <h2>Current Announcement</h2>
                <div className="inline-actions">
                  <span className="pill pill--info">Priority {currentAnnouncement.priority || 1}</span>
                  {categoryLabel ? <span className="pill">{categoryLabel}</span> : null}
                  {announcementTextPageCount > 1 ? (
                    <span className="pill">
                      Text {activeAnnouncementTextPage + 1}/{announcementTextPageCount}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div
              className={`announcement-body ${
                shouldUsePresentationFocusLayout ? 'announcement-body--media-only' : ''
              } ${shouldShowTextSlideHero ? 'announcement-body--text-stage' : ''}`.trim()}
            >
              {shouldShowTextSlideHero ? (
                <div className="announcement-text-stage">
                  <div className="announcement-text-stage__chrome">
                    <p className="announcement-kicker">
                      {isEmergency ? 'Immediate Attention Required' : 'Scheduled Notice'}
                    </p>
                    {announcementTextPageCount > 1 ? (
                      <span className="pill">
                        Text {activeAnnouncementTextPage + 1}/{announcementTextPageCount}
                      </span>
                    ) : null}
                  </div>
                  <div className="announcement-text-stage__inner">
                    {announcementPanelTitle ? (
                      <h3 className="announcement-title announcement-title--stage">
                        {announcementPanelTitle}
                      </h3>
                    ) : null}
                    {announcementPanelContent ? (
                      <p className="announcement-content announcement-content--stage">
                        {announcementPanelContent}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {!shouldUseAnnouncementStageLayout ? (
                <p className="announcement-kicker">
                  {isEmergency ? 'Immediate Attention Required' : 'Scheduled Notice'}
                </p>
              ) : null}
              {!shouldUseAnnouncementStageLayout && (announcementPanelTitle || showAnnouncementFallbackText) ? (
                <h3 className="announcement-title">{announcementPanelTitle}</h3>
              ) : null}

              {currentAnnouncementHasAnyMedia &&
              !showAnnouncementMediaPanel &&
              !isAnnouncementMediaShownInLivePanel &&
              (!currentAnnouncementHasVideo || !showLivePanel) ? (
                <div
                  className={`announcement-media-frame ${
                    shouldUsePresentationFocusLayout
                      ? 'announcement-media-frame--fullscreen'
                      : 'announcement-media-frame--inline'
                  }`.trim()}
                  style={mediaAspectStyle}
                >
                  <AttachmentPreview
                    filePath={currentAnnouncement.image}
                    fileName={currentAnnouncement.fileName}
                    typeHint={currentAnnouncement.fileMimeType || currentAnnouncement.type}
                    fileSizeBytes={currentAnnouncement.fileSizeBytes}
                    className={`media-preview--full media-preview--display ${
                      shouldUsePresentationFocusLayout ? 'media-preview--display-fullscreen' : ''
                    } ${currentAnnouncementIsPresentation ? 'media-preview--presentation-stage' : ''}`.trim()}
                    documentPreview
                    documentHideHeader
                    documentShowActions={false}
                    documentSlideshow
                    documentSlideshowAutoplay={isPlaying}
                    documentSlideshowIntervalMs={documentSlideshowIntervalMs}
                    documentSlideshowShowControls={false}
                    documentSlideshowShowDots={false}
                    onDocumentSlideCountChange={
                      currentAnnouncementHasDocument ? handleDocumentSlideCountChange : undefined
                    }
                    onDocumentSlideIndexChange={
                      currentAnnouncementHasDocument ? handleDocumentSlideIndexChange : undefined
                    }
                    title={announcementPanelTitle}
                    imageAlt={announcementPanelTitle}
                    showActions={false}
                  />
                </div>
              ) : null}

              {!shouldUseAnnouncementStageLayout && (announcementPanelContent || showAnnouncementFallbackText) ? (
                <p className="announcement-content">{announcementPanelContent}</p>
              ) : null}
            </div>
          </section>
        </main>

        <footer className="display-footer">
          <p className="footer-hint">{actionHint}</p>

          <div className="controls">
            <button className="btn btn--ghost btn--tiny" type="button" onClick={handlePrev}>
              Previous
            </button>
            {!showLivePanel ? (
              <button
                className="btn btn--primary btn--tiny"
                type="button"
                onClick={() => setIsPlaying((value) => !value)}
              >
                {rotationControlLabel}
              </button>
            ) : null}
            <button className="btn btn--ghost btn--tiny" type="button" onClick={handleNext}>
              Next
            </button>
          </div>

          <div className="dot-pager">
            {displaySlides.slice(0, 12).map((item, index) => (
              <span key={`${item.id}-${index}`} className={index === activeSlideIndex ? 'is-active' : ''} />
            ))}
          </div>
        </footer>
      </div>
    </div>
  );
};

export default DisplayBoard;
