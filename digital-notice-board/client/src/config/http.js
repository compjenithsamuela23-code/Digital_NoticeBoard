import axios from 'axios';
import { API_BASE_URL } from './api';

const REQUEST_TIMEOUT_MS = Number.parseInt(import.meta.env.VITE_API_TIMEOUT_MS, 10) || 20000;
const MAX_RETRY_ATTEMPTS =
  Number.parseInt(import.meta.env.VITE_API_RETRY_ATTEMPTS, 10) || 2;

const RETRYABLE_METHODS = new Set(['get', 'head', 'options']);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
  return typeof error.message === 'string' && error.message.toLowerCase().includes('timeout');
}

export function isNetworkError(error) {
  if (!error) return false;
  if (error.response) return false;
  return RETRYABLE_ERROR_CODES.has(String(error.code || '')) || isTimeoutError(error);
}

function shouldRetry(error) {
  const config = error?.config;
  if (!config) return false;
  if (config.__retryDisabled) return false;

  const method = String(config.method || 'get').toLowerCase();
  if (!RETRYABLE_METHODS.has(method)) return false;

  const retryCount = Number(config.__retryCount || 0);
  if (retryCount >= MAX_RETRY_ATTEMPTS) return false;

  const status = error?.response?.status;
  if (status && RETRYABLE_STATUS.has(status)) return true;

  return isNetworkError(error);
}

function getRetryDelayMs(config) {
  const retryCount = Number(config.__retryCount || 0);
  return Math.min(450 * 2 ** retryCount, 3500);
}

export function getNetworkErrorMessage() {
  return `Cannot connect to backend at ${API_BASE_URL}. Check internet/network/server and retry.`;
}

export function extractApiError(error, fallbackMessage = 'Request failed. Please try again.') {
  const payload = error?.response?.data;
  if (payload && typeof payload === 'object') {
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
  }

  if (isNetworkError(error)) {
    return getNetworkErrorMessage();
  }

  if (isTimeoutError(error)) {
    return 'Request timed out. Check connection and retry.';
  }

  const status = Number(error?.response?.status);
  if (!Number.isNaN(status) && status >= 500) {
    return 'Server error. Please retry in a moment.';
  }

  return fallbackMessage;
}

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Accept: 'application/json'
  }
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (!shouldRetry(error)) {
      return Promise.reject(error);
    }

    const config = error.config;
    config.__retryCount = Number(config.__retryCount || 0) + 1;
    await sleep(getRetryDelayMs(config));
    return apiClient(config);
  }
);

