const TOKEN_KEY = 'adminToken';
const EMAIL_KEY = 'userEmail';
const ADMIN_FLAG_KEY = 'isAdmin';

function getStorage() {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function getAdminToken() {
  const storage = getStorage();
  return storage ? storage.getItem(TOKEN_KEY) : null;
}

export function hasAdminSession() {
  const storage = getStorage();
  if (!storage) return false;
  return storage.getItem(ADMIN_FLAG_KEY) === 'true' && Boolean(storage.getItem(TOKEN_KEY));
}

export function setAdminSession({ email, token }) {
  const storage = getStorage();
  if (!storage) return;

  storage.setItem(ADMIN_FLAG_KEY, 'true');
  storage.setItem(EMAIL_KEY, String(email || '').trim().toLowerCase());
  storage.setItem(TOKEN_KEY, token || '');
}

export function clearAdminSession() {
  const storage = getStorage();
  if (!storage) return;

  storage.removeItem(ADMIN_FLAG_KEY);
  storage.removeItem(EMAIL_KEY);
  storage.removeItem(TOKEN_KEY);
}

export function withAuthConfig(config = {}) {
  const token = getAdminToken();
  const headers = {
    ...(config.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return {
    ...config,
    headers
  };
}
