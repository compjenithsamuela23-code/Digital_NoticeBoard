import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { apiUrl, assetUrl } from '../config/api';
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

const DisplayBoard = () => {
  const [announcements, setAnnouncements] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [liveStatus, setLiveStatus] = useState('OFF');
  const [liveLink, setLiveLink] = useState(null);
  const [liveCategory, setLiveCategory] = useState('all');
  const [categories, setCategories] = useState([]);
  const [mediaPreviewError, setMediaPreviewError] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(true);
  const [videoVolume, setVideoVolume] = useState(1);
  const [audioStatusHint, setAudioStatusHint] = useState('');
  const [requestError, setRequestError] = useState('');
  const liveVideoRef = useRef(null);

  const navigate = useNavigate();
  const { socket } = useSocket();
  const { isDark, toggleTheme } = useTheme();

  const isAdmin = hasAdminSession();
  const displayCategoryId = getDisplayCategoryId();
  const displayCategoryLabel = getDisplayCategoryLabel();

  const getYouTubeID = (url) => {
    const regex = /(?:youtube\.com.*v=|youtu\.be\/)([^&\n?#]+)/;
    const match = url && url.match(regex);
    return match ? match[1] : null;
  };

  const isVideoMedia = (announcement) => {
    if (!announcement || !announcement.image) return false;
    if (String(announcement.type || '').toLowerCase().includes('video')) return true;
    return /\.(mp4|m4v|m4p|mov|avi|mkv|webm|ogg|ogv|flv|f4v|wmv|asf|ts|m2ts|mts|3gp|3g2|mpg|mpeg|mpe|vob|mxf|rm|rmvb|qt|hevc|h265|h264|r3d|braw|cdng|prores|dnxhd|dnxhr|dv|mjpeg)$/i.test(
      announcement.image
    );
  };

  const isImageMedia = (announcement) => {
    if (!announcement || !announcement.image) return false;
    if (String(announcement.type || '').toLowerCase().includes('image')) return true;
    return /\.(jpg|jpeg|png|gif|bmp|tif|tiff|webp|avif|heif|heic|apng|svg|ai|eps|psd|raw|dng|cr2|cr3|nef|arw|orf|rw2)$/i.test(
      announcement.image
    );
  };

  const isDocumentMedia = (announcement) => {
    if (!announcement || !announcement.image) return false;
    const type = String(announcement.type || '').toLowerCase();
    if (type.includes('document')) return true;
    if (isVideoMedia(announcement)) return false;
    if (isImageMedia(announcement)) return false;
    return true;
  };

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
      setLiveStatus(response.data.status || 'OFF');
      setLiveLink(response.data.link || null);
      setLiveCategory(normalizeLiveCategory(response.data.category));
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
      setLiveStatus(data.status || 'OFF');
      setLiveLink(data.link || null);
      setLiveCategory(normalizeLiveCategory(data.category));
    });

    return () => {
      socket.off('connect', syncOnConnect);
      socket.off('announcementUpdate', fetchAnnouncements);
      socket.off('liveUpdate');
    };
  }, [fetchAnnouncements, fetchLiveStatus, socket]);

  const emergencyIndex = useMemo(
    () =>
      announcements.findIndex(
        (item) => item && (item.isEmergency === true || Number(item.priority) === 0)
      ),
    [announcements]
  );
  const hasEmergency = emergencyIndex !== -1;

  const activeSlideIndex = useMemo(() => {
    if (!announcements.length) return 0;
    if (hasEmergency) return emergencyIndex;
    return Math.min(currentIndex, announcements.length - 1);
  }, [announcements.length, currentIndex, emergencyIndex, hasEmergency]);

  useEffect(() => {
    if (!isPlaying || announcements.length <= 1 || hasEmergency) return;

    const interval = setInterval(() => {
      setCurrentIndex((previous) => (previous + 1) % announcements.length);
    }, 8000);

    return () => clearInterval(interval);
  }, [isPlaying, announcements.length, hasEmergency]);

  const currentAnnouncement = announcements[activeSlideIndex] || null;
  const currentAnnouncementHasImage = isImageMedia(currentAnnouncement);
  const currentAnnouncementHasVideo = isVideoMedia(currentAnnouncement);
  const currentAnnouncementHasDocument = isDocumentMedia(currentAnnouncement);
  const currentAnnouncementHasAnyMedia = Boolean(currentAnnouncement && currentAnnouncement.image);
  const currentAnnouncementTitle = String((currentAnnouncement && currentAnnouncement.title) || '').trim();
  const currentAnnouncementContent = String((currentAnnouncement && currentAnnouncement.content) || '').trim();
  const currentAnnouncementHasText = Boolean(currentAnnouncementTitle || currentAnnouncementContent);
  const isAttachmentOnlyAnnouncement = currentAnnouncementHasAnyMedia && !currentAnnouncementHasText;
  const shouldShowEmergencyContent = currentAnnouncementHasText || !currentAnnouncementHasAnyMedia;
  const currentAnnouncementMediaWidth = Number.parseInt(currentAnnouncement && currentAnnouncement.mediaWidth, 10);
  const currentAnnouncementMediaHeight = Number.parseInt(currentAnnouncement && currentAnnouncement.mediaHeight, 10);
  const hasMediaDimensions =
    Number.isFinite(currentAnnouncementMediaWidth) &&
    currentAnnouncementMediaWidth > 0 &&
    Number.isFinite(currentAnnouncementMediaHeight) &&
    currentAnnouncementMediaHeight > 0;
  const mediaAspectStyle = hasMediaDimensions
    ? { aspectRatio: `${currentAnnouncementMediaWidth} / ${currentAnnouncementMediaHeight}` }
    : undefined;
  const currentAnnouncementVideoUrl = currentAnnouncementHasVideo
    ? assetUrl(currentAnnouncement.image)
    : null;
  const activeYouTubeId = getYouTubeID(liveLink);
  const normalizedDisplayCategory = String(displayCategoryId || 'all').trim() || 'all';
  const normalizedLiveCategory = normalizeLiveCategory(liveCategory);
  const isLiveVisibleForDisplay =
    normalizedLiveCategory === 'all' ||
    normalizedDisplayCategory === 'all' ||
    normalizedDisplayCategory === normalizedLiveCategory;
  const isLiveOn = liveStatus === 'ON' && isLiveVisibleForDisplay;
  const showLivePanel = isLiveOn;
  const showAttachmentOnlyPanel = !showLivePanel && isAttachmentOnlyAnnouncement;
  const showAnnouncementMediaPanel =
    !showLivePanel && !showAttachmentOnlyPanel && (currentAnnouncementHasImage || currentAnnouncementHasVideo);
  const showSecondaryPanel = showLivePanel || showAnnouncementMediaPanel;
  const isSingleColumnLayout = showAttachmentOnlyPanel || !showSecondaryPanel;

  const categoryLabel = currentAnnouncement
    ? getCategoryName(currentAnnouncement.category)
    : null;

  const liveBadgeClass = isLiveOn ? 'pill pill--success' : 'pill pill--danger';
  const isEmergency = hasEmergency;

  const actionHint = useMemo(() => {
    if (!announcements.length) return 'No scheduled announcements';
    return `Slide ${activeSlideIndex + 1} of ${announcements.length}`;
  }, [announcements.length, activeSlideIndex]);

  const handleNext = () => {
    if (!announcements.length || hasEmergency) return;
    setCurrentIndex((previous) => (previous + 1) % announcements.length);
  };

  const handlePrev = () => {
    if (!announcements.length || hasEmergency) return;
    setCurrentIndex((previous) => (previous - 1 + announcements.length) % announcements.length);
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
    setAudioStatusHint('');
    setIsAudioMuted((value) => !value);
  };

  const handleVolumeChange = (event) => {
    const raw = Number.parseFloat(event.target.value);
    const next = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
    setVideoVolume(next);
    if (next === 0) {
      setIsAudioMuted(true);
    } else {
      setIsAudioMuted(false);
    }
  };

  useEffect(() => {
    setMediaPreviewError(false);
    setAudioStatusHint('');
  }, [currentAnnouncementVideoUrl]);

  useEffect(() => {
    if (!currentAnnouncementHasVideo) return;
    const videoElement = liveVideoRef.current;
    if (!videoElement) return;

    videoElement.volume = videoVolume;
    videoElement.muted = isAudioMuted;

    const tryPlay = async () => {
      try {
        await videoElement.play();
      } catch {
        if (!isAudioMuted) {
          videoElement.muted = true;
          setIsAudioMuted(true);
          setAudioStatusHint('Autoplay with sound was blocked. Click Unmute to enable audio.');
        }
      }
    };

    tryPlay();
  }, [currentAnnouncementHasVideo, currentAnnouncementVideoUrl, isAudioMuted, videoVolume]);

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
              Live Status: {isLiveOn ? 'ON' : 'OFF'}
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
                  {currentAnnouncementHasVideo
                    ? 'Playing uploaded video'
                    : currentAnnouncementHasDocument
                      ? 'Document attachment available'
                      : activeYouTubeId
                        ? 'Streaming from live link'
                        : 'No active stream link'}
                </p>
                {currentAnnouncementHasVideo || activeYouTubeId ? (
                  <button className="btn btn--ghost btn--tiny" type="button" onClick={handleAudioToggle}>
                    {isAudioMuted ? 'Unmute' : 'Mute'}
                  </button>
                ) : null}
                {currentAnnouncementHasVideo ? (
                  <label className="volume-control">
                    <span>Vol</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={videoVolume}
                      onChange={handleVolumeChange}
                    />
                  </label>
                ) : null}
              </div>
            </div>
            <div className="live-body">
              {currentAnnouncementHasVideo ? (
                !mediaPreviewError ? (
                  <video
                    ref={liveVideoRef}
                    className="live-body__video"
                    key={currentAnnouncementVideoUrl}
                    src={currentAnnouncementVideoUrl}
                    autoPlay
                    controls
                    loop
                    muted={isAudioMuted}
                    playsInline
                    style={mediaAspectStyle}
                    onError={() => setMediaPreviewError(true)}
                  />
                ) : (
                  <div className="live-placeholder">
                    <h3>Video Format Not Previewable</h3>
                    <p>Open or download this file to view it with an external player.</p>
                    <a className="btn btn--primary btn--tiny" href={currentAnnouncementVideoUrl} target="_blank" rel="noreferrer">
                      Open Video File
                    </a>
                  </div>
                )
              ) : activeYouTubeId ? (
                <iframe
                  className="live-body__iframe"
                  key={`${activeYouTubeId}-${isAudioMuted ? 'muted' : 'sound'}`}
                  title="Live Broadcast"
                  src={`https://www.youtube.com/embed/${activeYouTubeId}?autoplay=1&mute=${
                    isAudioMuted ? 1 : 0
                  }&controls=1&playsinline=1&rel=0&modestbranding=1`}
                  allow="autoplay; encrypted-media; fullscreen"
                  allowFullScreen
                />
              ) : currentAnnouncementHasDocument ? (
                <div className="live-document-wrap">
                  <AttachmentPreview
                    filePath={currentAnnouncement.image}
                    fileName={currentAnnouncement.fileName}
                    typeHint={currentAnnouncement.fileMimeType || currentAnnouncement.type}
                    fileSizeBytes={currentAnnouncement.fileSizeBytes}
                    className="document-preview--full live-document-preview"
                    documentPreview
                    title={currentAnnouncement.title}
                    imageAlt={currentAnnouncement.title}
                  />
                </div>
              ) : (
                <div className="live-placeholder">
                  <h3>Live Broadcast Unavailable</h3>
                  <p>Live mode is ON, but no stream source is currently available.</p>
                </div>
              )}
            </div>
            {audioStatusHint ? <p className="file-help">{audioStatusHint}</p> : null}
            </section>
          ) : null}

          {showAttachmentOnlyPanel ? (
            <section className={`announcement-panel display-panel display-panel--media-only ${isEmergency ? 'emergency-frame' : ''}`}>
              <div className="announcement-body announcement-body--media-only">
                <div className="announcement-media-frame announcement-media-frame--fullscreen" style={mediaAspectStyle}>
                  <AttachmentPreview
                    filePath={currentAnnouncement.image}
                    fileName={currentAnnouncement.fileName}
                    typeHint={currentAnnouncement.fileMimeType || currentAnnouncement.type}
                    fileSizeBytes={currentAnnouncement.fileSizeBytes}
                    className="media-preview--full media-preview--display media-preview--display-fullscreen"
                    documentPreview
                    title="Attachment"
                    imageAlt="Attachment"
                  />
                </div>
              </div>
            </section>
          ) : null}

          {showAnnouncementMediaPanel ? (
            <section className={`live-panel display-panel ${isEmergency ? 'emergency-frame' : ''}`}>
              <div className="panel-head">
                <h2>Announcement Media</h2>
                <div className="inline-actions">
                  <p className="topbar__subtitle">
                    {currentAnnouncementHasVideo ? 'Posted video' : 'Posted image'}
                  </p>
                </div>
              </div>
              <div className="live-body">
                <div className="announcement-media-frame announcement-media-frame--panel" style={mediaAspectStyle}>
                  <AttachmentPreview
                    filePath={currentAnnouncement.image}
                    fileName={currentAnnouncement.fileName}
                    typeHint={currentAnnouncement.fileMimeType || currentAnnouncement.type}
                    fileSizeBytes={currentAnnouncement.fileSizeBytes}
                    className="media-preview--full media-preview--display media-preview--display-panel"
                    documentPreview={false}
                    title={currentAnnouncementTitle || 'Attachment'}
                    imageAlt={currentAnnouncementTitle || 'Attachment'}
                  />
                </div>
              </div>
            </section>
          ) : null}

          {!showAttachmentOnlyPanel ? (
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
              {currentAnnouncementTitle ? (
                <h3 className="announcement-title">{currentAnnouncementTitle}</h3>
              ) : null}

              {currentAnnouncement.image &&
              !showAnnouncementMediaPanel &&
              (!currentAnnouncementHasVideo || !showLivePanel) ? (
                <div className="announcement-media-frame announcement-media-frame--inline" style={mediaAspectStyle}>
                  <AttachmentPreview
                    filePath={currentAnnouncement.image}
                    fileName={currentAnnouncement.fileName}
                    typeHint={currentAnnouncement.fileMimeType || currentAnnouncement.type}
                    fileSizeBytes={currentAnnouncement.fileSizeBytes}
                    className="media-preview--full media-preview--display"
                    documentPreview
                    title={currentAnnouncementTitle || 'Attachment'}
                    imageAlt={currentAnnouncementTitle || 'Attachment'}
                  />
                </div>
              ) : null}

              {currentAnnouncementContent ? (
                <p className="announcement-content">{currentAnnouncementContent}</p>
              ) : null}
            </div>
          </section>
          ) : null}
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
            {announcements.slice(0, 12).map((item, index) => (
              <span key={`${item.id}-${index}`} className={index === activeSlideIndex ? 'is-active' : ''} />
            ))}
          </div>
        </footer>
      </div>
    </div>
  );
};

export default DisplayBoard;
