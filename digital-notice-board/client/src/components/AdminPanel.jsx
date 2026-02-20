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

const DOCUMENT_ACCEPT = 'application/*,text/*,*/*';
const MEDIA_ACCEPT =
  'image/*,video/*,.jpg,.jpeg,.png,.gif,.bmp,.tif,.tiff,.webp,.avif,.heif,.heic,.apng,.svg,.ai,.eps,.psd,.raw,.dng,.cr2,.cr3,.nef,.arw,.orf,.rw2,.mp4,.m4v,.m4p,.mov,.avi,.mkv,.webm,.ogg,.ogv,.flv,.f4v,.wmv,.asf,.ts,.m2ts,.mts,.3gp,.3g2,.mpg,.mpeg,.mpe,.vob,.mxf,.rm,.rmvb,.qt,.hevc,.h265,.h264,.r3d,.braw,.cdng,.prores,.dnxhd,.dnxhr,.dv,.mjpeg';

const AdminPanel = ({ workspaceRole = 'admin' }) => {
  const isStaffWorkspace = workspaceRole === 'staff';
  const isAdminWorkspace = !isStaffWorkspace;
  const [announcements, setAnnouncements] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [image, setImage] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [documentFile, setDocumentFile] = useState(null);
  const [documentPreviewUrl, setDocumentPreviewUrl] = useState(null);
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
  const [liveLink, setLiveLink] = useState(null);
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
  const documentInputRef = useRef(null);

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

  const summary = useMemo(() => {
    const total = announcements.length;
    const active = announcements.filter((announcement) => announcement.isActive !== false).length;
    const emergency = announcements.filter((announcement) => announcement.priority === 0).length;
    return { total, active, emergency };
  }, [announcements]);

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
      setLiveStatus(response.data.status || 'OFF');
      setLiveLink(response.data.link || null);
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
    if (!socket) return;

    socket.on('liveUpdate', (payload) => {
      setLiveStatus(payload.status || 'OFF');
      setLiveLink(payload.link || null);
    });

    socket.on('announcementUpdate', fetchAnnouncements);

    return () => {
      socket.off('liveUpdate');
      socket.off('announcementUpdate', fetchAnnouncements);
    };
  }, [fetchAnnouncements, socket]);

  useEffect(() => {
    return () => {
      if (imagePreview) {
        URL.revokeObjectURL(imagePreview);
      }
      if (documentPreviewUrl) {
        URL.revokeObjectURL(documentPreviewUrl);
      }
    };
  }, [documentPreviewUrl, imagePreview]);

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
    setImage(null);
    setImagePreview(null);
    setDocumentFile(null);
    if (documentPreviewUrl) {
      URL.revokeObjectURL(documentPreviewUrl);
      setDocumentPreviewUrl(null);
    }
    if (mediaInputRef.current) mediaInputRef.current.value = '';
    if (documentInputRef.current) documentInputRef.current.value = '';
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setRequestError('');

    try {
      const payload = new FormData();
      payload.append('title', formData.title);
      payload.append('content', formData.content);
      payload.append('priority', String(formData.priority));
      payload.append('duration', String(formData.duration));
      payload.append('active', String(formData.isActive));
      payload.append('category', formData.category || '');
      payload.append('startAt', formData.startAt);
      payload.append('endAt', formData.endAt);

      if (image) {
        payload.append('image', image);
      }

      if (documentFile) {
        payload.append('document', documentFile);
      }

      if (editingId) {
        await apiClient.put(apiUrl(`/api/announcements/${editingId}`), payload, {
          ...applyWorkspaceAuth({
            headers: { 'Content-Type': 'multipart/form-data' }
          })
        });
      } else {
        await apiClient.post(apiUrl('/api/announcements'), payload, {
          ...applyWorkspaceAuth({
            headers: { 'Content-Type': 'multipart/form-data' }
          })
        });
      }

      await fetchAnnouncements();
      resetForm();
    } catch (error) {
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
    setImage(null);
    setImagePreview(null);
    setDocumentFile(null);
    if (documentPreviewUrl) {
      URL.revokeObjectURL(documentPreviewUrl);
      setDocumentPreviewUrl(null);
    }
    if (mediaInputRef.current) mediaInputRef.current.value = '';
    if (documentInputRef.current) documentInputRef.current.value = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleImageChange = (event) => {
    const file = event.target.files[0];

    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }

    if (!file) {
      setImage(null);
      setImagePreview(null);
      return;
    }

    setDocumentFile(null);
    if (documentPreviewUrl) {
      URL.revokeObjectURL(documentPreviewUrl);
      setDocumentPreviewUrl(null);
    }
    if (documentInputRef.current) documentInputRef.current.value = '';
    setImage(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleDocumentChange = (event) => {
    const file = event.target.files[0];
    if (documentPreviewUrl) {
      URL.revokeObjectURL(documentPreviewUrl);
      setDocumentPreviewUrl(null);
    }

    if (!file) {
      setDocumentFile(null);
      return;
    }

    const mime = String(file.type || '').toLowerCase();
    if (mime.startsWith('image/') || mime.startsWith('video/')) {
      setRequestError('Please use the Media Upload field for image or video files.');
      setDocumentFile(null);
      if (documentInputRef.current) documentInputRef.current.value = '';
      return;
    }

    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }
    setDocumentFile(file);
    setDocumentPreviewUrl(URL.createObjectURL(file));
    setImage(null);
    setImagePreview(null);
    if (mediaInputRef.current) mediaInputRef.current.value = '';
  };

  const startLive = async () => {
    const trimmed = liveLinkInput.trim();
    if (!trimmed) {
      setRequestError('Paste a live YouTube link first.');
      return;
    }

    try {
      setRequestError('');
      await apiClient.post(apiUrl('/api/start'), { link: trimmed }, applyWorkspaceAuth());
      setLiveStatus('ON');
      setLiveLink(trimmed);
      setLiveLinkInput('');
    } catch (error) {
      if (handleRequestError(error, 'Failed to start live feed.')) return;
      console.error('Error starting live:', error);
    }
  };

  const stopLive = async () => {
    try {
      setRequestError('');
      await apiClient.post(apiUrl('/api/stop'), {}, applyWorkspaceAuth());
      setLiveStatus('OFF');
      setLiveLink(null);
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
      <header className={`topbar topbar--admin card${isStaffWorkspace ? ' topbar--staff' : ''}`}>
        <div className="topbar__brand topbar__brand--admin topbar-admin__intro">
          <p className="topbar__eyebrow">{isStaffWorkspace ? 'Staff Workspace' : 'Control Workspace'}</p>
          <h1 className="topbar__title">
            {isStaffWorkspace
              ? 'Digital Notice Board Staff Dashboard'
              : 'Digital Notice Board Admin'}
          </h1>
          <p className="topbar__subtitle">
            {isStaffWorkspace
              ? 'Publish announcements and control live media with staff permissions.'
              : 'Publish updates, control live media, and manage secure display access.'}
          </p>
          <div className="topbar-admin__kpis">
            <span className="pill pill--info">Total: {summary.total}</span>
            <span className="pill pill--success">Active: {summary.active}</span>
            <span className="pill pill--danger">
              Emergency: {summary.emergency}
            </span>
          </div>
          {isAdminWorkspace ? (
            <div className="topbar-admin__status-wrap">
              <TopbarStatus className="topbar-status--admin" />
            </div>
          ) : null}
        </div>

        {isStaffWorkspace ? (
          <div className="topbar-admin__status-column">
            <TopbarStatus className="topbar-status--admin" />
          </div>
        ) : null}

        <div className="topbar__workspace topbar-admin__center">
          <div className="topbar__control-row">
            <div className="topbar__actions topbar__actions--admin topbar-admin__actions">
              {isAdminWorkspace ? (
                <>
                  <div className="topbar-admin__category">
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

                  <div className="topbar-admin__divider" />
                </>
              ) : null}

              {isAdminWorkspace ? (
                <>
                  <div className="topbar-admin__action-row">
                    <button className="btn btn--ghost btn--tiny" type="button" onClick={toggleTheme}>
                      {isDark ? 'Light Mode' : 'Dark Mode'}
                    </button>
                    <button
                      className="btn btn--ghost btn--tiny"
                      type="button"
                      onClick={() => setShowAccessManager((value) => !value)}
                    >
                      {showAccessManager ? 'Hide Credentials' : 'Credentials'}
                    </button>
                  </div>

                  <div className="topbar-admin__action-row">
                    <button
                      className="btn btn--ghost"
                      type="button"
                      onClick={() => navigate(workspaceHistoryRoute)}
                    >
                      View History
                    </button>
                    <button
                      className="btn btn--ghost"
                      type="button"
                      onClick={() => navigate('/display/login')}
                    >
                      Open Display
                    </button>
                  </div>

                  <button
                    className="btn btn--danger topbar__logout"
                    type="button"
                    onClick={handleLogout}
                  >
                    Logout
                  </button>
                </>
              ) : (
                <>
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
                </>
              )}
            </div>
          </div>
        </div>
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
            <label htmlFor="live-link">YouTube Live Link</label>
            <input
              id="live-link"
              type="text"
              value={liveLinkInput}
              onChange={(event) => setLiveLinkInput(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
            />
          </div>

          <div className="inline-actions">
            <button className="btn btn--success" type="button" onClick={startLive}>
              Start Live
            </button>
            <button className="btn btn--danger" type="button" onClick={stopLive}>
              Stop Live
            </button>
          </div>

          {liveLink ? (
            <p className="file-help">
              Current live link:{' '}
              <a href={liveLink} target="_blank" rel="noreferrer">
                {liveLink}
              </a>
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
              <label htmlFor="announcement-title">Title</label>
              <input
                id="announcement-title"
                type="text"
                value={formData.title}
                onChange={(event) => setFormData({ ...formData, title: event.target.value })}
                placeholder="Exam timetable updated for semester 2"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="announcement-content">Content</label>
              <textarea
                id="announcement-content"
                value={formData.content}
                onChange={(event) => setFormData({ ...formData, content: event.target.value })}
                placeholder="Add detailed message for students and staff"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="announcement-media">Media Upload (Image/Video)</label>
              <input
                id="announcement-media"
                type="file"
                accept={MEDIA_ACCEPT}
                onChange={handleImageChange}
                ref={mediaInputRef}
              />
              <p className="file-help">Supported video: mp4, webm, ogg, mov, m4v, avi, mkv.</p>
            </div>

            <div className="field">
              <label htmlFor="announcement-document">Document Upload (PDF/Word/PPT/Etc)</label>
              <input
                id="announcement-document"
                type="file"
                accept={DOCUMENT_ACCEPT}
                onChange={handleDocumentChange}
                ref={documentInputRef}
              />
              <p className="file-help">
                All document formats are accepted. The board will attempt inline preview and fall back to open/download when browser limits apply.
              </p>
            </div>

            {imagePreview ? (
              <AttachmentPreview
                fileUrl={imagePreview}
                fileName={image && image.name}
                typeHint={image && image.type}
                fileSizeBytes={image && image.size}
                title="Media preview"
              />
            ) : null}

            {documentFile && documentPreviewUrl ? (
              <DocumentAttachment
                fileUrl={documentPreviewUrl}
                fileName={documentFile.name}
                mimeType={documentFile.type}
                fileSizeBytes={documentFile.size}
                title="Document preview"
                className="document-preview--full"
              />
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
            {announcements.map((announcement) => (
              <article className="notice-card" key={announcement.id} onClick={() => handleEdit(announcement)}>
                <div className="notice-card__top">
                  <span className={announcement.isActive !== false ? 'pill pill--success' : 'pill pill--danger'}>
                    <span className="badge-dot" />
                    {announcement.isActive !== false ? 'Active' : 'Inactive'}
                  </span>
                  <span className="pill">P{announcement.priority ?? 1}</span>
                </div>

                <h3 className="notice-card__title">{announcement.title}</h3>

                {announcement.image ? (
                  <AttachmentPreview
                    filePath={announcement.image}
                    fileName={announcement.fileName}
                    typeHint={announcement.fileMimeType || announcement.type}
                    fileSizeBytes={announcement.fileSizeBytes}
                    className="media-preview--full"
                    documentPreview={false}
                    title={announcement.title}
                    imageAlt={announcement.title}
                  />
                ) : null}

                <p className="notice-card__content">{announcement.content}</p>

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
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default AdminPanel;
