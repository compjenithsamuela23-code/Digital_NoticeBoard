import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiUrl } from '../config/api';
import { apiClient, extractApiError } from '../config/http';
import { hasStaffSession, setStaffSession } from '../config/staffAuth';
import { useTheme } from '../hooks/useTheme';

const StaffLogin = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [handoffMessage, setHandoffMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();
  const { isDark, toggleTheme } = useTheme();

  useEffect(() => {
    if (hasStaffSession()) {
      navigate('/staff');
      return;
    }

    const state = location.state || {};
    if (state.prefillUsername) {
      setUsername(String(state.prefillUsername));
    }
    if (state.handoffMessage) {
      setHandoffMessage(String(state.handoffMessage));
    }
  }, [location.state, navigate]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);

    const normalizedUsername = username.trim().toLowerCase();
    try {
      const response = await apiClient.post(apiUrl('/api/staff-auth/login'), {
        username: normalizedUsername,
        password: password.trim()
      });

      if (!response.data?.token) {
        setError('Invalid login response.');
        return;
      }

      setStaffSession({
        username: response.data?.user?.username || normalizedUsername,
        token: response.data.token
      });
      navigate('/staff');
    } catch (loginError) {
      const responseData = loginError.response?.data || {};

      if (responseData.accountType === 'admin') {
        navigate('/admin/login', {
          state: {
            prefillUsername: normalizedUsername,
            handoffMessage: 'This account is for Admin Workspace. Continue in Admin Login.'
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
              'This username is a display credential. Continue in Display Access and select its category.'
          }
        });
        return;
      }

      setError(extractApiError(loginError, 'Login failed. Please try again.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page fade-up">
      <div className="auth-shell">
        <section className="auth-card card fade-up-delay">
          <div className="auth-card__head">
            <div className="auth-card__tools">
              <button className="btn btn--ghost btn--tiny" type="button" onClick={toggleTheme}>
                {isDark ? 'Light Mode' : 'Dark Mode'}
              </button>
            </div>
          </div>

          <div className="section-title__text section-title__text--center">
            <h2>STAFF LOGIN</h2>
            <p>Sign in to create,edit,and publish department Specific Notices.</p>
          </div>

          <form className="auth-form" onSubmit={handleLogin}>
            {handoffMessage ? <div className="auth-note">{handoffMessage}</div> : null}

            <div className="field">
              <label htmlFor="staff-username">Username</label>
              <input
                id="staff-username"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="staff_user"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="staff-password">Password</label>
              <input
                id="staff-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                required
              />
            </div>

            {error ? <div className="auth-error">{error}</div> : null}

            <button className="btn btn--primary btn--wide" type="submit" disabled={loading}>
              {loading ? 'Authenticating...' : 'Access Staff Dashboard'}
            </button>
          </form>

          <div className="auth-footer-actions">
            <button className="btn btn--ghost" type="button" onClick={() => navigate('/admin/login')}>
              Admin Login
            </button>
            <button className="btn btn--ghost" type="button" onClick={() => navigate('/display/login')}>
              Display Access
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};

export default StaffLogin;
