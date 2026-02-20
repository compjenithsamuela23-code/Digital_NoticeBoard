import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiUrl } from '../config/api';
import { setAdminSession } from '../config/auth';
import { apiClient, extractApiError } from '../config/http';
import { useTheme } from '../hooks/useTheme';
import TopbarStatus from './TopbarStatus';

const AdminLogin = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { isDark, toggleTheme } = useTheme();

  const handleLogin = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    const normalizedUsername = username.trim().toLowerCase();

    try {
      const response = await apiClient.post(apiUrl('/api/auth/login'), {
        username: normalizedUsername,
        password: password.trim()
      });

      if ((response.data.success || response.data.message === 'Login successful') && response.data.token) {
        setAdminSession({
          email: normalizedUsername,
          token: response.data.token
        });
        navigate('/admin');
        return;
      }

      setError('Invalid credentials');
    } catch (err) {
      const responseData = err.response?.data || {};
      if (responseData.accountType === 'staff') {
        navigate('/staff/login', {
          state: {
            prefillUsername: normalizedUsername,
            handoffMessage: 'This username is for Staff Dashboard. Continue in Staff Login.'
          }
        });
        return;
      }

      if (responseData.accountType === 'display') {
        navigate('/display/login', {
          state: {
            prefillUsername: normalizedUsername,
            prefillCategoryId: responseData.displayCategoryId || '',
            prefillCategory: responseData.displayCategoryName || '',
            handoffMessage:
              'This username is a display credential. Continue in Display Access and enter its assigned category.'
          }
        });
        return;
      }

      setError(extractApiError(err, 'Login failed. Please try again.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page fade-up">
      <div className="auth-shell">
        <aside className="auth-side">
          <p className="topbar__eyebrow auth-brand-eyebrow">
            Digital Notice Board
          </p>
          <h1>Control Center For Broadcast, Notices, And Campus Updates</h1>
          <p>
            This panel lets you run daily communication with confidence. Publish urgent alerts,
            schedule notices, and control live media from one clean workspace.
          </p>
          <div className="auth-highlights">
            <div className="auth-highlight">Real-time announcement publishing</div>
            <div className="auth-highlight">Image and video notice support</div>
            <div className="auth-highlight">Live stream controls and status tracking</div>
          </div>
        </aside>

        <section className="auth-card card fade-up-delay">
          <div className="auth-card__head">
            <TopbarStatus className="topbar-status--auth topbar-status--auth-card" />
            <div className="auth-card__tools">
              <button className="btn btn--ghost btn--tiny" type="button" onClick={toggleTheme}>
                {isDark ? 'Light Mode' : 'Dark Mode'}
              </button>
            </div>
          </div>

          <div className="section-title__text">
            <p className="topbar__eyebrow">Access</p>
            <h2>Sign In</h2>
            <p>Enter admin workspace credentials. Staff and display accounts use their own login pages.</p>
          </div>

          <form className="auth-form" onSubmit={handleLogin}>
            <div className="field">
              <label htmlFor="email">Username</label>
              <input
                id="email"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="workspace_user"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
              />
            </div>

            {error ? <div className="auth-error">{error}</div> : null}

            <button className="btn btn--primary btn--wide" type="submit" disabled={loading}>
              {loading ? 'Authenticating...' : 'Access'}
            </button>
          </form>

          <div className="auth-footer-actions">
            <button className="btn btn--ghost" type="button" onClick={() => navigate('/staff/login')}>
              Staff Dashboard Login
            </button>
            <button className="btn btn--ghost" type="button" onClick={() => navigate('/display/login')}>
              Back To Display Access
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};

export default AdminLogin;
