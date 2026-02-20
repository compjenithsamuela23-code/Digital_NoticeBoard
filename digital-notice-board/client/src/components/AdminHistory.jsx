import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiUrl } from '../config/api';
import { clearAdminSession, hasAdminSession, withAuthConfig } from '../config/auth';
import { clearStaffSession, hasStaffSession, withStaffAuthConfig } from '../config/staffAuth';
import { apiClient, extractApiError } from '../config/http';
import { useTheme } from '../hooks/useTheme';
import AttachmentPreview from './AttachmentPreview';
import TopbarStatus from './TopbarStatus';

const ACTION_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'created', label: 'Announcement Created' },
  { value: 'updated', label: 'Announcement Updated' },
  { value: 'deleted', label: 'Announcement Deleted' },
  { value: 'expired', label: 'Announcement Expired' }
];

const ACTION_LABELS = {
  created: 'Created',
  updated: 'Updated',
  deleted: 'Deleted',
  expired: 'Expired'
};

const ANNOUNCEMENT_ACTIONS = new Set(['created', 'updated', 'deleted', 'expired']);

function formatActionLabel(action) {
  if (!action) return 'Event';
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  return String(action)
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

const AdminHistory = ({ workspaceRole = 'admin' }) => {
  const isStaffWorkspace = workspaceRole === 'staff';
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const navigate = useNavigate();
  const { isDark, toggleTheme } = useTheme();
  const workspaceLoginRoute = isStaffWorkspace ? '/staff/login' : '/admin/login';
  const workspaceHomeRoute = isStaffWorkspace ? '/staff' : '/admin';

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

  const filterOptions = useMemo(() => ACTION_FILTER_OPTIONS, []);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setRequestError('');
    try {
      const response = await apiClient.get(apiUrl('/api/history'), applyWorkspaceAuth());
      const rows = Array.isArray(response.data) ? response.data : [];
      setHistory(rows.filter((item) => ANNOUNCEMENT_ACTIONS.has(String(item?.action || ''))));
    } catch (error) {
      if (error.response?.status === 401) {
        clearWorkspaceSession();
        navigate(workspaceLoginRoute);
        return;
      }
      console.error('Error fetching history:', error);
      setHistory([]);
      setRequestError(extractApiError(error, 'Unable to load history.'));
    } finally {
      setLoading(false);
    }
  }, [applyWorkspaceAuth, clearWorkspaceSession, navigate, workspaceLoginRoute]);

  useEffect(() => {
    const hasWorkspaceSession = isStaffWorkspace ? hasStaffSession() : hasAdminSession();
    if (!hasWorkspaceSession) {
      navigate(workspaceLoginRoute);
      return;
    }
    fetchHistory();
  }, [fetchHistory, isStaffWorkspace, navigate, workspaceLoginRoute]);

  useEffect(() => {
    setFilter((previous) => (ACTION_FILTER_OPTIONS.some((item) => item.value === previous) ? previous : 'all'));
  }, []);

  const filteredHistory = useMemo(() => {
    const term = search.trim().toLowerCase();
    return history.filter((item) => {
      const action = String(item.action || '');
      if (!ANNOUNCEMENT_ACTIONS.has(action)) return false;
      const matchesFilter = filter === 'all' || action === filter;
      const text = `${item.title || ''} ${item.content || ''} ${item.action || ''} ${
        item.user || ''
      } ${item.category || ''}`.toLowerCase();
      const matchesSearch = term.length === 0 || text.includes(term);
      return matchesFilter && matchesSearch;
    });
  }, [history, filter, search]);

  const stats = useMemo(() => {
    const values = {
      total: history.length,
      created: 0,
      updated: 0,
      deleted: 0,
      expired: 0
    };

    history.forEach((item) => {
      if (item.action === 'created') values.created += 1;
      if (item.action === 'updated') values.updated += 1;
      if (item.action === 'deleted') values.deleted += 1;
      if (item.action === 'expired') values.expired += 1;
    });

    return values;
  }, [history]);

  const getActionClass = (action) => {
    if (action === 'created') return 'action-label action-label--created';
    if (action === 'updated') return 'action-label action-label--updated';
    if (action === 'deleted') return 'action-label action-label--deleted';
    if (action === 'expired') return 'action-label action-label--expired';
    return 'action-label action-label--system';
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
    <div className="app-shell app-shell--history fade-up">
      <header className="topbar topbar--history card">
        <div className="topbar__brand">
          <p className="topbar__eyebrow">{isStaffWorkspace ? 'Staff Workspace' : 'Admin Workspace'}</p>
          <h1 className="topbar__title">
            Announcement History
          </h1>
          <p className="topbar__subtitle">
            {isStaffWorkspace
              ? 'Track announcement creation, updates, expiry, and removal.'
              : 'Track every creation, update, expiry, and removal with timestamps.'}
          </p>
        </div>
        <div className="topbar__workspace topbar__workspace--history">
          <div className="topbar__summary-row topbar__summary-row--history">
            <TopbarStatus className="topbar-status--history" />
            <div className="topbar__actions topbar__actions--history">
              <button className="btn btn--ghost" type="button" onClick={toggleTheme}>
                {isDark ? 'Light Mode' : 'Dark Mode'}
              </button>
              <button className="btn btn--ghost" type="button" onClick={() => navigate(workspaceHomeRoute)}>
                Back To Panel
              </button>
              <button className="btn btn--primary" type="button" onClick={fetchHistory}>
                Refresh
              </button>
              <button className="btn btn--danger" type="button" onClick={handleLogout}>
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <section className="card section fade-up-delay">
        {requestError ? <div className="auth-error">{requestError}</div> : null}
        <div className="history-toolbar">
          <div className="field">
            <label htmlFor="history-search">Search</label>
            <input
              id="history-search"
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by title or content"
            />
          </div>

          <div className="field">
            <label htmlFor="history-filter">Action Filter</label>
            <select
              id="history-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              {filterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Matching</label>
            <div className="pill pill--info">
              <span className="badge-dot" />
              {filteredHistory.length} records
            </div>
          </div>
        </div>

        <div className="history-stats">
          <div className="stat-card">
            <span className="stat-card__label">Total Events</span>
            <span className="stat-card__value">{stats.total}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Created</span>
            <span className="stat-card__value">{stats.created}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Updated</span>
            <span className="stat-card__value">{stats.updated}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Deleted</span>
            <span className="stat-card__value">{stats.deleted}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Expired</span>
            <span className="stat-card__value">{stats.expired}</span>
          </div>
        </div>
      </section>

      <section className="card section">
        <div className="section-title">
          <div className="section-title__text">
            <h2>Event Timeline</h2>
            <p>Newest actions are listed first.</p>
          </div>
        </div>

        {loading ? (
          <div className="empty-state">Loading history...</div>
        ) : filteredHistory.length === 0 ? (
          <div className="empty-state">No history entries match your filter.</div>
        ) : (
          <div className="history-grid">
            {filteredHistory.map((item, index) => (
              <article className="history-card" key={`${item.id || 'history'}-${item.actionAt || index}`}>
                <div className="history-card__head">
                  <h3 className="history-card__title">{item.title || 'Untitled announcement'}</h3>
                  <span className={getActionClass(item.action)}>{formatActionLabel(item.action)}</span>
                </div>

                {item.image ? (
                  <AttachmentPreview
                    filePath={item.image}
                    fileName={item.fileName}
                    typeHint={item.fileMimeType || item.type}
                    fileSizeBytes={item.fileSizeBytes}
                    className="media-preview--full"
                    documentPreview={false}
                    title={item.title || 'History attachment'}
                    imageAlt={item.title || 'History attachment'}
                  />
                ) : null}

                <p className="history-card__content">{item.content || 'No content provided.'}</p>

                <div className="history-card__meta">
                  <p>Action Time: {new Date(item.actionAt || item.deletedAt || Date.now()).toLocaleString()}</p>
                  <p>Created Time: {new Date(item.createdAt || Date.now()).toLocaleString()}</p>
                  <p>Priority: {item.priority ?? '-'}</p>
                  <p>Category: {item.category || 'None'}</p>
                  <p>By: {item.user || 'System'}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default AdminHistory;
