const STAFF_TOKEN_KEY = 'staffToken';
const STAFF_USERNAME_KEY = 'staffUsername';
const STAFF_FLAG_KEY = 'isStaff';

function getStorage() {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function getStaffToken() {
  const storage = getStorage();
  return storage ? storage.getItem(STAFF_TOKEN_KEY) : null;
}

export function hasStaffSession() {
  const storage = getStorage();
  if (!storage) return false;
  return storage.getItem(STAFF_FLAG_KEY) === 'true' && Boolean(storage.getItem(STAFF_TOKEN_KEY));
}

export function setStaffSession({ username, token }) {
  const storage = getStorage();
  if (!storage) return;

  storage.setItem(STAFF_FLAG_KEY, 'true');
  storage.setItem(STAFF_USERNAME_KEY, String(username || '').trim().toLowerCase());
  storage.setItem(STAFF_TOKEN_KEY, token || '');
}

export function clearStaffSession() {
  const storage = getStorage();
  if (!storage) return;

  storage.removeItem(STAFF_FLAG_KEY);
  storage.removeItem(STAFF_USERNAME_KEY);
  storage.removeItem(STAFF_TOKEN_KEY);
}

export function withStaffAuthConfig(config = {}) {
  const token = getStaffToken();
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
