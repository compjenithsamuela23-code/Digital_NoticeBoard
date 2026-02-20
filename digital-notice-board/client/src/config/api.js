const LOCAL_DEV_API = 'http://localhost:5001';

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function inferRuntimeBaseUrl() {
  if (typeof window === 'undefined') {
    return LOCAL_DEV_API;
  }

  const { port, origin } = window.location;
  const isLikelyVitePort = /^517\d$/.test(port || '');

  if (import.meta.env.DEV || isLikelyVitePort) {
    const backendUrl = new URL(origin);
    backendUrl.port = '5001';
    return backendUrl.origin;
  }

  return origin;
}

const configuredBaseUrl = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL);

export const API_BASE_URL = configuredBaseUrl || normalizeBaseUrl(inferRuntimeBaseUrl());
export const SOCKET_URL = API_BASE_URL;

export function apiUrl(pathname) {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${API_BASE_URL}${path}`;
}

export function assetUrl(pathname) {
  if (!pathname) return pathname;
  if (/^https?:\/\//i.test(pathname)) return pathname;
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${API_BASE_URL}${path}`;
}
