import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { apiUrl } from '../config/api';
import { clearAdminSession, hasAdminSession, withAuthConfig } from '../config/auth';
import { apiClient, extractApiError } from '../config/http';
import {
  clearDisplaySession,
  getDisplayCategoryId,
  getDisplayCategoryLabel,
  withDisplayAuthConfig
} from '../config/displayAuth';
import { useTheme } from '../hooks/useTheme';
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

const normalizeLiveLinkArray = (rawValues = [], maxLinks = MAX_ANNOUNCEMENT_STREAM_LINKS) =>
  [...new Set((Array.isArray(rawValues) ? rawValues : []).map((item) => String(item || '').trim()).filter(Boolean))].slice(
    0,
    maxLinks
  );

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

const getSplitColumnCount = (count) => {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 2;
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
  const [announcements, setAnnouncements] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentMediaGroupPage, setCurrentMediaGroupPage] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [liveStatus, setLiveStatus] = useState('OFF');
  const [liveLink, setLiveLink] = useState(null);
  const [liveLinks, setLiveLinks] = useState([]);
  const [liveCategory, setLiveCategory] = useState('all');
  const [categories, setCategories] = useState([]);
  const [isAudioMuted, setIsAudioMuted] = useState(true);
  const [requestError, setRequestError] = useState('');
  const [documentSlideCount, setDocumentSlideCount] = useState(1);
  const [documentSlideIndex, setDocumentSlideIndex] = useState(1);
  const previousDocumentSlideIndexRef = useRef(1);
  const documentCycleCountRef = useRef(0);

  const navigate = useNavigate();
  const { socket } = useSocket();
  const { isDark, toggleTheme } = useTheme();

  const isAdmin = hasAdminSession();
  const displayCategoryId = getDisplayCategoryId();
  const displayCategoryLabel = getDisplayCategoryLabel();

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

  const fetchAnnouncements = useCallback(async () => {
    try {
      const categoryFilter = String(displayCategoryId || 'all').trim();
      const response = await apiClient.get(apiUrl('/api/announcements/public'), {
        params: categoryFilter && categoryFilter !== 'all' ? { category: categoryFilter } : {}
      });
      setAnnouncements(response.data || []);
      setRequestError('');
    } catch (error) {
      console.error('Error fetching announcements:', error);
      setRequestError(extractApiError(error, 'Unable to load announcements.'));
    }
  }, [displayCategoryId]);

  const fetchCategories = useCallback(async () => {
    try {
      const response = await apiClient.get(apiUrl('/api/categories'));
      setCategories(response.data || []);
      setRequestError('');
    } catch (error) {
      console.error('Error fetching categories:', error);
      setRequestError(extractApiError(error, 'Unable to load categories.'));
    }
  }, []);

  const fetchLiveStatus = useCallback(async () => {
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
      setLiveLink(statusPayload.link || null);
      setLiveLinks(nextLinks);
      setLiveCategory(normalizeLiveCategory(statusPayload.category));
      setRequestError('');
    } catch (error) {
      console.error('Error fetching live status:', error);
      setRequestError(extractApiError(error, 'Unable to load live status.'));
    }
  }, []);

  useEffect(() => {
    const initialFetch = setTimeout(() => {
      fetchAnnouncements();
      fetchCategories();
      fetchLiveStatus();
    }, 0);

    const livePoll = setInterval(fetchLiveStatus, 5000);
    const announcementsPoll = setInterval(fetchAnnouncements, 15000);

    const syncVisibleDisplay = () => {
      fetchAnnouncements();
      fetchLiveStatus();
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        syncVisibleDisplay();
      }
    };

    window.addEventListener('focus', syncVisibleDisplay);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearTimeout(initialFetch);
      clearInterval(livePoll);
      clearInterval(announcementsPoll);
      window.removeEventListener('focus', syncVisibleDisplay);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchAnnouncements, fetchCategories, fetchLiveStatus]);

  useEffect(() => {
    if (!socket) return;

    const syncOnConnect = () => {
      fetchAnnouncements();
      fetchLiveStatus();
    };

    socket.on('connect', syncOnConnect);
    socket.on('announcementUpdate', fetchAnnouncements);
    socket.on('liveUpdate', (data) => {
      const nextLinks =
        Array.isArray(data?.links) && data.links.length > 0
          ? data.links
          : data?.link
            ? [data.link]
            : [];
      setLiveStatus(data?.status || 'OFF');
      setLiveLink(data?.link || null);
      setLiveLinks(nextLinks);
      setLiveCategory(normalizeLiveCategory(data?.category));
    });

    return () => {
      socket.off('connect', syncOnConnect);
      socket.off('announcementUpdate', fetchAnnouncements);
      socket.off('liveUpdate');
    };
  }, [fetchAnnouncements, fetchLiveStatus, socket]);

  const displaySlides = useMemo(() => toDisplaySlides(announcements), [announcements]);

  useEffect(() => {
    if (!displaySlides.length) {
      setCurrentIndex(0);
      return;
    }
    setCurrentIndex((previous) => Math.min(previous, displaySlides.length - 1));
  }, [displaySlides.length]);

  const emergencyIndex = useMemo(
    () =>
      displaySlides.findIndex((slide) => {
        const item = slide && slide.announcement;
        return item && (item.isEmergency === true || Number(item.priority) === 0);
      }),
    [displaySlides]
  );
  const hasEmergency = emergencyIndex !== -1;

  const activeSlideIndex = useMemo(() => {
    if (!displaySlides.length) return 0;
    if (hasEmergency) return emergencyIndex;
    return Math.min(currentIndex, displaySlides.length - 1);
  }, [currentIndex, displaySlides.length, emergencyIndex, hasEmergency]);

  const currentSlide = displaySlides[activeSlideIndex] || null;
  const currentAnnouncement = currentSlide ? currentSlide.announcement : null;
  const currentAnnouncementMediaGroup = useMemo(
    () => (currentSlide && Array.isArray(currentSlide.mediaItems) ? currentSlide.mediaItems : []),
    [currentSlide]
  );
  const currentAnnouncementMediaGroupCount = currentAnnouncementMediaGroup.length;
  const announcementMediaPageCount = Math.max(
    1,
    Math.ceil(currentAnnouncementMediaGroupCount / MAX_VISIBLE_SPLIT_ITEMS)
  );
  const activeAnnouncementMediaPage = Math.min(
    currentMediaGroupPage,
    Math.max(0, announcementMediaPageCount - 1)
  );
  const currentAnnouncementMediaGroupPageItems = useMemo(() => {
    if (currentAnnouncementMediaGroupCount === 0) return [];
    const startIndex = activeAnnouncementMediaPage * MAX_VISIBLE_SPLIT_ITEMS;
    return currentAnnouncementMediaGroup.slice(startIndex, startIndex + MAX_VISIBLE_SPLIT_ITEMS);
  }, [activeAnnouncementMediaPage, currentAnnouncementMediaGroup, currentAnnouncementMediaGroupCount]);

  const currentAnnouncementId = currentAnnouncement ? String(currentAnnouncement.id || '') : '';
  const currentAnnouncementHasVideo = isVideoMedia(currentAnnouncement);
  const currentAnnouncementHasDocument = isDocumentMedia(currentAnnouncement);
  const currentAnnouncementHasAnyMedia = currentAnnouncementMediaGroupCount > 0;
  const currentAnnouncementTitle = String((currentAnnouncement && currentAnnouncement.title) || '').trim();
  const currentAnnouncementContent = String((currentAnnouncement && currentAnnouncement.content) || '').trim();
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
    if (hasMediaDimensions) {
      return { aspectRatio: `${currentAnnouncementMediaWidth} / ${currentAnnouncementMediaHeight}` };
    }
    if (!currentAnnouncementHasAnyMedia) {
      return undefined;
    }
    if (currentAnnouncementHasDocument) {
      return { aspectRatio: '16 / 10' };
    }
    return { aspectRatio: '16 / 9' };
  }, [
    currentAnnouncementHasAnyMedia,
    currentAnnouncementHasDocument,
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
  const liveSourceTiles = useMemo(() => {
    if (!showLivePanel) return [];
    const tiles = [];

    activeLiveStreamEmbeds.forEach((stream, index) => {
      tiles.push({
        id: `stream-${stream.id}-${index}`,
        kind: 'stream',
        stream
      });
    });

    currentAnnouncementMediaGroup.forEach((announcement, index) => {
      if (!announcement || !announcement.image) return;
      tiles.push({
        id: `announcement-${announcement.id || index}`,
        kind: 'announcement',
        announcement
      });
    });

    return tiles;
  }, [activeLiveStreamEmbeds, currentAnnouncementMediaGroup, showLivePanel]);
  const livePageCount = Math.max(1, Math.ceil(liveSourceTiles.length / MAX_VISIBLE_SPLIT_ITEMS));
  const activeLivePage = Math.min(currentMediaGroupPage, Math.max(0, livePageCount - 1));
  const combinedLiveTiles = useMemo(() => {
    if (!showLivePanel || liveSourceTiles.length === 0) return [];
    const startIndex = activeLivePage * MAX_VISIBLE_SPLIT_ITEMS;
    return liveSourceTiles.slice(startIndex, startIndex + MAX_VISIBLE_SPLIT_ITEMS);
  }, [activeLivePage, liveSourceTiles, showLivePanel]);
  const showAnnouncementMediaPanel = !showLivePanel && currentAnnouncementMediaGroupCount > 0;
  const isAnnouncementMediaShownInLivePanel = showLivePanel && combinedLiveTiles.some(
    (tile) => tile.kind === 'announcement'
  );
  const showSecondaryPanel = showLivePanel || showAnnouncementMediaPanel;
  const isSingleColumnLayout = !showSecondaryPanel;
  const activePanelPageCount = showLivePanel ? livePageCount : announcementMediaPageCount;
  const activePanelPageIndex = showLivePanel ? activeLivePage : activeAnnouncementMediaPage;

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
  const mediaSplitColumns = getSplitColumnCount(currentAnnouncementMediaGroupPageItems.length);
  const showAnnouncementFallbackText = currentAnnouncementHasAnyMedia && !currentAnnouncementHasText;
  const announcementPanelTitle = currentAnnouncementTitle || 'Notice Attachment';
  const announcementPanelContent =
    currentAnnouncementContent || 'Media has been posted without additional text content.';

  useEffect(() => {
    if (!isPlaying || displaySlides.length <= 1 || hasEmergency) return;

    const shouldPauseAnnouncementRotation =
      !showLivePanel &&
      currentAnnouncementMediaGroupCount <= 1 &&
      currentAnnouncementHasDocument &&
      documentSlideCount > 1;
    if (shouldPauseAnnouncementRotation) {
      return;
    }

    const interval = setInterval(() => {
      setCurrentMediaGroupPage((previousPage) => {
        if (activePanelPageCount > 1 && previousPage < activePanelPageCount - 1) {
          return previousPage + 1;
        }
        setCurrentIndex((previous) => (previous + 1) % displaySlides.length);
        return 0;
      });
    }, 8000);

    return () => clearInterval(interval);
  }, [
    activePanelPageCount,
    currentAnnouncementHasDocument,
    currentAnnouncementMediaGroupCount,
    displaySlides.length,
    documentSlideCount,
    hasEmergency,
    isPlaying,
    showLivePanel
  ]);

  const categoryLabel = currentAnnouncement
    ? getCategoryName(currentAnnouncement.category)
    : null;

  const liveBadgeClass = showLivePanel ? 'pill pill--success' : 'pill pill--danger';
  const liveStatusLabel = isLiveOn ? 'ON' : hasAnnouncementStreams ? 'ANNOUNCEMENT' : 'OFF';
  const isEmergency = hasEmergency;

  useEffect(() => {
    setCurrentMediaGroupPage(0);
    setDocumentSlideCount(1);
    setDocumentSlideIndex(1);
    previousDocumentSlideIndexRef.current = 1;
    documentCycleCountRef.current = 0;
  }, [currentAnnouncementId]);

  useEffect(() => {
    if (
      !isPlaying ||
      hasEmergency ||
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
        setCurrentIndex((previous) => (previous + 1) % displaySlides.length);
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
    hasEmergency,
    isPlaying,
    showLivePanel
  ]);

  const actionHint = useMemo(() => {
    if (!displaySlides.length) return 'No scheduled announcements';
    const announcementLabel = `Slide ${activeSlideIndex + 1} of ${displaySlides.length}`;
    if (showLivePanel) {
      if (activePanelPageCount > 1) {
        return `${announcementLabel} • Live split (${liveSourceTiles.length} items) • Panel ${
          activePanelPageIndex + 1
        } of ${activePanelPageCount}`;
      }
      return `${announcementLabel} • Live split (${liveSourceTiles.length} items)`;
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
      return `${announcementLabel} • Page ${documentSlideIndex} of ${documentSlideCount}`;
    }
    return announcementLabel;
  }, [
    activeAnnouncementMediaPage,
    activeSlideIndex,
    activePanelPageCount,
    activePanelPageIndex,
    announcementMediaPageCount,
    currentAnnouncementMediaGroupCount,
    currentAnnouncementHasDocument,
    displaySlides.length,
    documentSlideCount,
    documentSlideIndex,
    liveSourceTiles.length,
    showLivePanel
  ]);

  const handleNext = () => {
    if (!displaySlides.length || hasEmergency) return;

    if (activePanelPageCount > 1 && activePanelPageIndex < activePanelPageCount - 1) {
      setCurrentMediaGroupPage((previous) => Math.min(previous + 1, activePanelPageCount - 1));
      return;
    }

    setCurrentMediaGroupPage(0);
    setCurrentIndex((previous) => (previous + 1) % displaySlides.length);
  };

  const handlePrev = () => {
    if (!displaySlides.length || hasEmergency) return;

    if (activePanelPageCount > 1 && activePanelPageIndex > 0) {
      setCurrentMediaGroupPage((previous) => Math.max(previous - 1, 0));
      return;
    }

    const previousSlideIndex = (activeSlideIndex - 1 + displaySlides.length) % displaySlides.length;
    setCurrentIndex(previousSlideIndex);
    setCurrentMediaGroupPage(0);
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

  if (!currentAnnouncement) {
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
                      documentSlideshowIntervalMs={6000}
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
                <p className="topbar__subtitle">
                  {liveSourceTiles.length > 1
                    ? `${liveSourceTiles.length} items in split view${
                        activePanelPageCount > 1
                          ? ` • Panel ${activePanelPageIndex + 1} of ${activePanelPageCount}`
                          : ''
                      }`
                    : liveSourceTiles.length === 1
                      ? '1 live item active'
                      : 'No active stream or attachment'}
                </p>
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
                  style={{ gridTemplateColumns: `repeat(${liveSplitColumns}, minmax(0, 1fr))` }}
                >
                  {combinedLiveTiles.map((tile, index) => {
                    if (tile.kind === 'stream') {
                      const tileStream = tile.stream;
                      return (
                        <iframe
                          className="live-stream-grid__frame"
                          key={`${tile.id}-${isAudioMuted ? 'muted' : 'sound'}`}
                          title={`${tileStream.provider || 'Live'} Broadcast ${index + 1}`}
                          src={tileStream.embedUrl}
                          allow="autoplay; encrypted-media; fullscreen"
                          allowFullScreen
                        />
                      );
                    }

                    const tileAnnouncement = tile.announcement;
                    const tileHasDocument = isDocumentMedia(tileAnnouncement);
                    const trackDocumentSlide = liveTileCount === 1 && tileHasDocument;
                    return (
                      <div className="announcement-media-split-grid__item" key={tile.id}>
                        <AttachmentPreview
                          filePath={tileAnnouncement.image}
                          fileName={tileAnnouncement.fileName}
                          typeHint={tileAnnouncement.fileMimeType || tileAnnouncement.type}
                          fileSizeBytes={tileAnnouncement.fileSizeBytes}
                          className="media-preview--full media-preview--display media-preview--display-panel media-preview--split-item"
                          documentPreview
                          documentHideHeader
                          documentShowActions={false}
                          documentSlideshow
                          documentSlideshowAutoplay={isPlaying}
                          documentSlideshowIntervalMs={6000}
                          onDocumentSlideCountChange={
                            trackDocumentSlide ? handleDocumentSlideCountChange : undefined
                          }
                          onDocumentSlideIndexChange={
                            trackDocumentSlide ? handleDocumentSlideIndexChange : undefined
                          }
                          title={tileAnnouncement.title || `Attachment ${index + 1}`}
                          imageAlt={tileAnnouncement.title || `Attachment ${index + 1}`}
                          showActions={false}
                        />
                      </div>
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
                      style={{ gridTemplateColumns: `repeat(${mediaSplitColumns}, minmax(0, 1fr))` }}
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
                            documentSlideshowIntervalMs={6000}
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
                      className="media-preview--full media-preview--display media-preview--display-panel"
                      documentPreview
                      documentHideHeader
                      documentShowActions={false}
                      documentSlideshow
                      documentSlideshowAutoplay={isPlaying}
                      documentSlideshowIntervalMs={6000}
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

          <section className={`announcement-panel display-panel ${isEmergency ? 'emergency-frame' : ''}`}>
            <div className="panel-head">
              <h2>Current Announcement</h2>
              <div className="inline-actions">
                <span className="pill pill--info">Priority {currentAnnouncement.priority || 1}</span>
                {categoryLabel ? <span className="pill">{categoryLabel}</span> : null}
              </div>
            </div>

            <div className="announcement-body">
              <p className="announcement-kicker">
                {isEmergency ? 'Immediate Attention Required' : 'Scheduled Notice'}
              </p>
              {currentAnnouncementTitle || showAnnouncementFallbackText ? (
                <h3 className="announcement-title">{announcementPanelTitle}</h3>
              ) : null}

              {currentAnnouncementHasAnyMedia &&
              !showAnnouncementMediaPanel &&
              !isAnnouncementMediaShownInLivePanel &&
              (!currentAnnouncementHasVideo || !showLivePanel) ? (
                <div className="announcement-media-frame announcement-media-frame--inline" style={mediaAspectStyle}>
                  <AttachmentPreview
                    filePath={currentAnnouncement.image}
                    fileName={currentAnnouncement.fileName}
                    typeHint={currentAnnouncement.fileMimeType || currentAnnouncement.type}
                    fileSizeBytes={currentAnnouncement.fileSizeBytes}
                    className="media-preview--full media-preview--display"
                    documentPreview
                    documentHideHeader
                    documentShowActions={false}
                    documentSlideshow
                    documentSlideshowAutoplay={isPlaying}
                    documentSlideshowIntervalMs={6000}
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

              {currentAnnouncementContent || showAnnouncementFallbackText ? (
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
            <button
              className="btn btn--primary btn--tiny"
              type="button"
              onClick={() => setIsPlaying((value) => !value)}
            >
              {isPlaying ? 'Pause Auto-Rotate' : 'Resume Auto-Rotate'}
            </button>
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
