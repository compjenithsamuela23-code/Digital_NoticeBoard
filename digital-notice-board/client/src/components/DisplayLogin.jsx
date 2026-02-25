import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiUrl } from '../config/api';
import { apiClient, extractApiError } from '../config/http';
import { hasDisplaySession, setDisplaySession } from '../config/displayAuth';
import { useTheme } from '../hooks/useTheme';

const normalizeCategories = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.categories)) return payload.categories;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
};

const DisplayLogin = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [error, setError] = useState('');
  const [handoffMessage, setHandoffMessage] = useState('');
  const [prefillCategoryId, setPrefillCategoryId] = useState('');
  const [prefillCategoryName, setPrefillCategoryName] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { isDark, toggleTheme } = useTheme();

  useEffect(() => {
    if (hasDisplaySession()) {
      navigate('/');
      return;
    }
  }, [navigate]);

  useEffect(() => {
    const state = location.state || {};
    if (state.prefillUsername) {
      setUsername(String(state.prefillUsername));
    }
    if (state.prefillCategoryId) {
      setPrefillCategoryId(String(state.prefillCategoryId));
      setCategory(String(state.prefillCategoryId));
    }
    if (state.prefillCategory) {
      setPrefillCategoryName(String(state.prefillCategory));
    }
    if (state.handoffMessage) {
      setHandoffMessage(String(state.handoffMessage));
    }
  }, [location.state]);

  useEffect(() => {
    let isMounted = true;
    const loadCategories = async () => {
      setCategoriesLoading(true);
      try {
        const response = await apiClient.get(apiUrl('/api/categories'));
        if (!isMounted) return;
        setCategories(normalizeCategories(response.data));
      } catch (fetchError) {
        if (!isMounted) return;
        console.error('Error fetching display categories:', fetchError);
      } finally {
        if (isMounted) {
          setCategoriesLoading(false);
        }
      }
    };

    loadCategories();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (category || categories.length === 0) return;

    if (prefillCategoryId) {
      const exact = categories.find((item) => item.id === prefillCategoryId);
      if (exact) {
        setCategory(exact.id);
        return;
      }
    }

    if (prefillCategoryName) {
      const byName = categories.find(
        (item) => String(item.name || '').toLowerCase() === prefillCategoryName.toLowerCase()
      );
      if (byName) {
        setCategory(byName.id);
        return;
      }
    }

    if (categories.length === 1) {
      setCategory(categories[0].id);
    }
  }, [categories, category, prefillCategoryId, prefillCategoryName]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setError('');
    if (!category.trim()) {
      setError('Select a category to continue.');
      return;
    }
    setLoading(true);

    try {
      const response = await apiClient.post(apiUrl('/api/display-auth/login'), {
        username: username.trim().toLowerCase(),
        password: password.trim(),
        category: category.trim()
      });

      if (!response.data?.token) {
        setError('Invalid login response.');
        return;
      }

      setDisplaySession({
        token: response.data.token,
        username: response.data?.user?.username || username.trim().toLowerCase(),
        categoryId: response.data?.category?.id || '',
        categoryLabel:
          response.data?.category?.name ||
          categories.find((item) => item.id === category)?.name ||
          category.trim()
      });

      navigate('/');
    } catch (loginError) {
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

          <div className="section-title__text">
            <p className="topbar__eyebrow">Display Access</p>
            <h2>Sign In</h2>
            <p>Enter username, password, and select your assigned category to continue.</p>
          </div>

          <form className="auth-form" onSubmit={handleLogin}>
            {handoffMessage ? <div className="auth-note">{handoffMessage}</div> : null}
            <div className="field">
              <label htmlFor="display-username">Username</label>
              <input
                id="display-username"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="display_user"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="display-password">Password</label>
              <input
                id="display-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="display-category">Category</label>
              <select
                id="display-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                disabled={categoriesLoading || categories.length === 0}
                required
              >
                <option value="">
                  {categoriesLoading
                    ? 'Loading categories...'
                    : categories.length === 0
                      ? 'No categories available'
                      : 'Select category'}
                </option>
                {categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>

            {error ? <div className="auth-error">{error}</div> : null}

            <button className="btn btn--primary btn--wide" type="submit" disabled={loading}>
              {loading ? 'Authenticating...' : 'Access Display'}
            </button>
          </form>

          <div className="auth-footer-actions">
            <button className="btn btn--ghost" type="button" onClick={() => navigate('/admin/login')}>
              Workspace Login
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};

export default DisplayLogin;
