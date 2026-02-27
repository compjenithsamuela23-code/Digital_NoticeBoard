import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { apiUrl } from '../config/api';
import { clearAdminSession, hasAdminSession, withAuthConfig } from '../config/auth';
import { clearStaffSession, hasStaffSession, withStaffAuthConfig } from '../config/staffAuth';
import { apiClient, extractApiError } from '../config/http';
import { useTheme } from '../hooks/useTheme';
import DocumentAttachment from './DocumentAttachment';
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
const MULTIPART_FALLBACK_MAX_BYTES = Math.floor(3.5 * 1024 * 1024);
const MAX_BATCH_ATTACHMENTS = 24;
const MAX_LIVE_LINKS = 4;

const parseLiveLinkList = (rawValue) =>
  [...new Set(String(rawValue || '').split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))].slice(
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
  const [liveStatus, setLiveStatus] = useState('OFF');
  const [liveLinks, setLiveLinks] = useState([]);
  const [liveCategory, setLiveCategory] = useState('all');
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
  const mediaInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const mediaReplaceInputRef = useRef(null);
  const documentInputRef = useRef(null);
  const documentReplaceInputRef = useRef(null);
  const [mediaReplaceIndex, setMediaReplaceIndex] = useState(-1);
  const [documentReplaceIndex, setDocumentReplaceIndex] = useState(-1);

  const navigate = useNavigate();
  const { socket } = useSocket();
  const { isDark, toggleTheme } = useTheme();

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
  const selectedVideoCount = useMemo(
    () => mediaFiles.filter((file) => isVideoFile(file)).length,
    [mediaFiles]
  );
  const selectedImageCount = useMemo(
    () => mediaFiles.filter((file) => isImageFile(file)).length,
    [mediaFiles]
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

  const uploadAttachmentToStorage = useCallback(
    async (file) => {
      if (!file) return null;

      const fileName = String(file.name || '').trim() || 'attachment';
      const mimeType = String(file.type || '').trim() || 'application/octet-stream';
      const fileSizeBytes = Number.parseInt(file.size, 10);
      if (Number.isNaN(fileSizeBytes) || fileSizeBytes <= 0) {
        throw new Error('Selected file is invalid.');
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
      if (!signedUrl || !publicUrl) {
        throw new Error('Upload URL could not be generated for this file.');
      }

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

      return {
        attachmentUrl: publicUrl,
        attachmentFileName: fileName,
        attachmentMimeType: mimeType,
        attachmentFileSizeBytes: fileSizeBytes
      };
    },
    [applyWorkspaceAuth]
  );

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

  const fetchAnnouncements = useCallback(async () => {
    try {
      const response = await apiClient.get(apiUrl('/api/announcements'), applyWorkspaceAuth());
      setAnnouncements(response.data || []);
      setRequestError('');
    } catch (error) {
      if (handleRequestError(error, 'Unable to load announcements.')) return;
      console.error('Error fetching announcements:', error);
    }
  }, [applyWorkspaceAuth, handleRequestError]);

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
      setLiveLinks(nextLinks);
      setLiveCategory(normalizeLiveCategory(statusPayload.category));
    } catch (error) {
      console.error('Error fetching live status:', error);
    }
  }, []);

  const fetchCategories = useCallback(async () => {
    try {
      const response = await apiClient.get(apiUrl('/api/categories'), applyWorkspaceAuth());
      setCategories(response.data || []);
      setRequestError('');
    } catch (error) {
      if (handleRequestError(error, 'Unable to load categories.')) return;
      console.error('Error fetching categories:', error);
    }
  }, [applyWorkspaceAuth, handleRequestError]);

  const fetchDisplayUsers = useCallback(async () => {
    if (!isAdminWorkspace) {
      setDisplayUsers([]);
      return;
    }
    try {
      const response = await apiClient.get(apiUrl('/api/display-users'), applyWorkspaceAuth());
      setDisplayUsers(response.data || []);
      setRequestError('');
    } catch (error) {
      if (handleRequestError(error, 'Unable to load display users.')) return;
      console.error('Error fetching display users:', error);
    }
  }, [applyWorkspaceAuth, handleRequestError, isAdminWorkspace]);

  const fetchStaffUsers = useCallback(async () => {
    if (!isAdminWorkspace) {
      setStaffUsers([]);
      return;
    }
    try {
      const response = await apiClient.get(apiUrl('/api/staff-users'), applyWorkspaceAuth());
      setStaffUsers(response.data || []);
      setRequestError('');
    } catch (error) {
      if (handleRequestError(error, 'Unable to load staff users.')) return;
      console.error('Error fetching staff users:', error);
    }
  }, [applyWorkspaceAuth, handleRequestError, isAdminWorkspace]);

  useEffect(() => {
    const hasWorkspaceSession = isStaffWorkspace ? hasStaffSession() : hasAdminSession();
    if (!hasWorkspaceSession) {
      navigate(workspaceLoginRoute);
      return;
    }

    fetchAnnouncements();
    fetchLiveStatus();
    fetchCategories();
    if (isAdminWorkspace) {
      fetchDisplayUsers();
      fetchStaffUsers();
    }
  }, [
    fetchAnnouncements,
    fetchCategories,
    fetchDisplayUsers,
    fetchLiveStatus,
    fetchStaffUsers,
    isAdminWorkspace,
    isStaffWorkspace,
    navigate,
    workspaceLoginRoute
  ]);

  useEffect(() => {
    const livePoll = setInterval(fetchLiveStatus, 5000);
    const announcementsPoll = setInterval(fetchAnnouncements, 5000);

    return () => {
      clearInterval(livePoll);
      clearInterval(announcementsPoll);
    };
  }, [fetchAnnouncements, fetchLiveStatus]);

  useEffect(() => {
    if (!socket) return;

    socket.on('liveUpdate', (payload) => {
      const nextLinks =
        Array.isArray(payload?.links) && payload.links.length > 0
          ? payload.links
          : payload?.link
            ? [payload.link]
            : [];
      setLiveStatus(payload?.status || 'OFF');
      setLiveLinks(nextLinks);
      setLiveCategory(normalizeLiveCategory(payload?.category));
    });

    socket.on('announcementUpdate', fetchAnnouncements);

    return () => {
      socket.off('liveUpdate');
      socket.off('announcementUpdate', fetchAnnouncements);
    };
  }, [fetchAnnouncements, socket]);

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
    revokeObjectUrls(mediaPreviewUrls);
    revokeObjectUrls(documentPreviewUrls);
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

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setRequestError('');

    try {
      const normalizedTitle = String(formData.title || '').trim();
      const normalizedContent = String(formData.content || '').trim();
      const editingAnnouncement = editingId
        ? announcements.find((announcement) => announcement.id === editingId)
        : null;
      const hasExistingAttachment = Boolean(editingAnnouncement && editingAnnouncement.image);
      const selectedMediaFiles = [...mediaFiles];
      const selectedDocumentFiles = [...documentFiles];
      const selectedAttachmentEntries = [
        ...selectedMediaFiles.map((file) => ({ file, kind: 'media' })),
        ...selectedDocumentFiles.map((file) => ({ file, kind: 'document' }))
      ];
      const hasNewAttachment = selectedAttachmentEntries.length > 0;

      if (selectedAttachmentEntries.length > MAX_BATCH_ATTACHMENTS) {
        setRequestError(`You can upload up to ${MAX_BATCH_ATTACHMENTS} files at a time.`);
        return;
      }

      if (editingId && selectedAttachmentEntries.length > 1) {
        setRequestError('Editing mode supports only one replacement attachment.');
        return;
      }

      if (!normalizedTitle && !normalizedContent && !hasNewAttachment && !hasExistingAttachment) {
        setRequestError('Add at least one: title, content, media, or document.');
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
          payload.append('attachmentUrl', directUploadPayload.attachmentUrl);
          payload.append('attachmentFileName', directUploadPayload.attachmentFileName);
          payload.append('attachmentMimeType', directUploadPayload.attachmentMimeType);
          payload.append(
            'attachmentFileSizeBytes',
            String(directUploadPayload.attachmentFileSizeBytes || '')
          );
          return;
        }

        if (shouldUseMultipartUpload) {
          payload.append(kind === 'document' ? 'document' : 'image', file);
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
          mediaWidth: selectedDimensions.width,
          mediaHeight: selectedDimensions.height
        });
        if (selectedAttachment) {
          await appendAttachmentPayload(payload, selectedAttachment, selectedKind);
        }

        await apiClient.put(apiUrl(`/api/announcements/${editingId}`), payload, {
          ...applyWorkspaceAuth({
            headers: { 'Content-Type': 'multipart/form-data' }
          })
        });
      } else if (selectedAttachmentEntries.length > 1) {
        const displayBatchId = createDisplayBatchId();

        for (let index = 0; index < selectedAttachmentEntries.length; index += 1) {
          const entry = selectedAttachmentEntries[index];
          const file = entry.file;
          const selectedKind = entry.kind;
          const payload = new FormData();
          const selectedDimensions =
            selectedKind === 'media' ? mediaDimensionsByKey[getDimensionLookupKey(file)] || {} : {};
          appendBaseFields(payload, {
            mediaWidth: selectedDimensions.width,
            mediaHeight: selectedDimensions.height,
            displayBatchId,
            displayBatchSlot: index + 1
          });
          await appendAttachmentPayload(payload, file, selectedKind);

          await apiClient.post(apiUrl('/api/announcements'), payload, {
            ...applyWorkspaceAuth({
              headers: { 'Content-Type': 'multipart/form-data' }
            })
          });
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

  const handleDelete = async (id) => {
    const accepted = window.confirm('Delete this announcement?');
    if (!accepted) return;

    try {
      setRequestError('');
      await apiClient.delete(apiUrl(`/api/announcements/${id}`), applyWorkspaceAuth());
      await fetchAnnouncements();
      if (editingId === id) {
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
    revokeObjectUrls(mediaPreviewUrls);
    revokeObjectUrls(documentPreviewUrls);
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
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const appendMediaFiles = (incomingFiles, mode = 'all') => {
    if (!Array.isArray(incomingFiles) || incomingFiles.length === 0) {
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
      setMediaFiles([selectedFile]);
      setMediaPreviewUrls([URL.createObjectURL(selectedFile)]);
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
    if (incomingFiles.length === 0) return;

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

      revokeObjectUrls(documentPreviewUrls);
      setDocumentFiles([selectedFile]);
      setDocumentPreviewUrls([URL.createObjectURL(selectedFile)]);
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
    setRequestError('');
  };

  const startLive = async () => {
    const parsedLinks = parseLiveLinkList(liveLinkInput);
    if (parsedLinks.length === 0) {
      setRequestError('Paste at least one live YouTube link first.');
      return;
    }

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
      setLiveCategory(normalizeLiveCategory(statusPayload.category || liveCategory));
      setLiveLinkInput('');
    } catch (error) {
      if (handleRequestError(error, 'Failed to start live feed.')) return;
      console.error('Error starting live:', error);
    }
  };

  const stopLive = async () => {
    try {
      setRequestError('');
      const response = await apiClient.post(apiUrl('/api/stop'), {}, applyWorkspaceAuth());
      setLiveStatus(response.data?.status || 'OFF');
      setLiveLinks([]);
      setLiveCategory(normalizeLiveCategory(response.data?.category || 'all'));
    } catch (error) {
      if (handleRequestError(error, 'Failed to stop live feed.')) return;
      console.error('Error stopping live:', error);
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

      <div className="grid-2">
        <section className="card section fade-up-delay">
          <div className="section-title">
            <div className="section-title__text">
              <h2>Live Broadcast</h2>
              <p>Start or stop the external live stream shown on public display.</p>
            </div>
            <span className={liveStatus === 'ON' ? 'pill pill--success' : 'pill pill--danger'}>
              <span className="badge-dot" />
              {liveStatus}
            </span>
          </div>

          <div className="field">
            <label htmlFor="live-link">YouTube Live Link(s)</label>
            <textarea
              id="live-link"
              value={liveLinkInput}
              onChange={(event) => setLiveLinkInput(event.target.value)}
              placeholder={`https://www.youtube.com/watch?v=...\nhttps://youtu.be/...\n(Use newline or comma to add up to ${MAX_LIVE_LINKS} links)`}
            />
            <p className="file-help">You can start 1 to {MAX_LIVE_LINKS} streams at the same time.</p>
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
            <button className="btn btn--success" type="button" onClick={startLive}>
              Start Live
            </button>
            <button className="btn btn--danger" type="button" onClick={stopLive}>
              Stop Live
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
              <p>Manage categories from top controls. Active categories are listed here.</p>
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
              <p>Write the message, attach media, and schedule visibility window.</p>
            </div>
            {editingId ? <span className="pill pill--info">Editing mode</span> : null}
          </div>

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
                placeholder="Exam timetable updated for semester 2"
              />
            </div>

            <div className="field">
              <label htmlFor="announcement-content">Content (Optional)</label>
              <textarea
                id="announcement-content"
                value={formData.content}
                onChange={(event) => setFormData({ ...formData, content: event.target.value })}
                placeholder="Add detailed message for students and staff"
              />
              <p className="file-help">
                You can leave title and content empty when uploading only media/document.
              </p>
            </div>

            <div className="field">
              <label htmlFor="announcement-image">Image Upload</label>
              <input
                id="announcement-image"
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                onChange={handleImageChange}
                ref={mediaInputRef}
              />
              <p className="file-help">
                Add one or more images. You can keep adding images in multiple rounds.
              </p>
            </div>

            <div className="field">
              <label htmlFor="announcement-video">Video Upload</label>
              <input
                id="announcement-video"
                type="file"
                accept={VIDEO_ACCEPT}
                multiple
                onChange={handleVideoChange}
                ref={videoInputRef}
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
              <p className="file-help">
                Add one or more videos. You can change/remove the 2nd, 3rd, 4th, 5th, etc video before publishing.
              </p>
              <p className="file-help">
                Total selected media limit: {MAX_BATCH_ATTACHMENTS} (current: {selectedImageCount} images,{' '}
                {selectedVideoCount} videos).
              </p>
            </div>

            <div className="field">
              <label htmlFor="announcement-document">Document Upload (PDF/Word/PPT/Etc)</label>
              <input
                id="announcement-document"
                type="file"
                accept={DOCUMENT_ACCEPT}
                multiple
                onChange={handleDocumentChange}
                ref={documentInputRef}
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
              <p className="file-help">
                All document formats are accepted. Select up to {MAX_BATCH_ATTACHMENTS} files total (media + document).
              </p>
            </div>

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
                    <DocumentAttachment
                      fileUrl={documentPreviewUrls[index]}
                      fileName={file.name}
                      mimeType={file.type}
                      fileSizeBytes={file.size}
                      title={`Document preview ${index + 1}`}
                      className="document-preview--full"
                      slideshow
                      slideshowAutoplay={false}
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
            <p>Select any card to quickly load it into edit form.</p>
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
              const cardTitle = noticeTitle || (announcement.image ? 'Attachment-only post' : 'Untitled notice');
              const cardContent = noticeContent || (announcement.image ? 'No text content.' : 'No content.');

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
                    documentPreview={false}
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
                      onClick={() => handleDelete(announcement.id)}
                    >
                      Delete
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
