const DISPLAY_TOKEN_KEY = 'displayToken';
const DISPLAY_USERNAME_KEY = 'displayUsername';
const DISPLAY_CATEGORY_ID_KEY = 'displayCategoryId';
const DISPLAY_CATEGORY_LABEL_KEY = 'displayCategoryLabel';

function getStorage() {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function getDisplayToken() {
  const storage = getStorage();
  return storage ? storage.getItem(DISPLAY_TOKEN_KEY) : null;
}

export function hasDisplaySession() {
  return Boolean(getDisplayToken());
}

export function setDisplaySession({ token, username, categoryId, categoryLabel }) {
  const storage = getStorage();
  if (!storage) return;

  storage.setItem(DISPLAY_TOKEN_KEY, token || '');
  storage.setItem(DISPLAY_USERNAME_KEY, String(username || '').trim().toLowerCase());
  storage.setItem(DISPLAY_CATEGORY_ID_KEY, String(categoryId || 'all').trim());
  storage.setItem(DISPLAY_CATEGORY_LABEL_KEY, String(categoryLabel || 'All Categories').trim());
}

export function clearDisplaySession() {
  const storage = getStorage();
  if (!storage) return;

  storage.removeItem(DISPLAY_TOKEN_KEY);
  storage.removeItem(DISPLAY_USERNAME_KEY);
  storage.removeItem(DISPLAY_CATEGORY_ID_KEY);
  storage.removeItem(DISPLAY_CATEGORY_LABEL_KEY);
}

export function getDisplayUsername() {
  const storage = getStorage();
  return storage ? storage.getItem(DISPLAY_USERNAME_KEY) : null;
}

export function getDisplayCategoryId() {
  const storage = getStorage();
  if (!storage) return 'all';
  return storage.getItem(DISPLAY_CATEGORY_ID_KEY) || 'all';
}

export function getDisplayCategoryLabel() {
  const storage = getStorage();
  if (!storage) return 'All Categories';
  return storage.getItem(DISPLAY_CATEGORY_LABEL_KEY) || 'All Categories';
}

export function withDisplayAuthConfig(config = {}) {
  const token = getDisplayToken();
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
