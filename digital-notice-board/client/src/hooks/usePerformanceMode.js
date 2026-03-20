import { useEffect, useMemo, useState } from 'react';

const LITE_DEVICE_MEMORY_GB = 8;
const ULTRA_LITE_DEVICE_MEMORY_GB = 4;
const LITE_CPU_THREADS = 8;
const ULTRA_LITE_CPU_THREADS = 4;
const SLOW_NETWORK_TYPES = new Set(['slow-2g', '2g', '3g']);
const VERY_SLOW_NETWORK_TYPES = new Set(['slow-2g', '2g']);
const PERFORMANCE_STORAGE_KEY = 'digital-notice-performance-mode';

function getNavigatorConnection() {
  if (typeof navigator === 'undefined') {
    return null;
  }

  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
}

function getStoredModeOverride() {
  if (typeof window === 'undefined') {
    return '';
  }

  try {
    const stored = window.localStorage.getItem(PERFORMANCE_STORAGE_KEY);
    if (stored === 'lite' || stored === 'full') {
      return stored;
    }
  } catch {
    // Ignore storage access issues.
  }

  return '';
}

function readPerformanceState() {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const connection = getNavigatorConnection();
  const deviceMemory = Number.parseFloat(nav?.deviceMemory);
  const hardwareConcurrency = Number.parseInt(nav?.hardwareConcurrency, 10);
  const effectiveType = String(connection?.effectiveType || 'unknown').trim().toLowerCase();
  const saveData = Boolean(connection?.saveData);
  const prefersReducedMotion = Boolean(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const modeOverride = getStoredModeOverride();

  const lowMemory = Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= LITE_DEVICE_MEMORY_GB;
  const ultraLowMemory =
    Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= ULTRA_LITE_DEVICE_MEMORY_GB;
  const lowCpu = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 && hardwareConcurrency <= LITE_CPU_THREADS;
  const ultraLowCpu =
    Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 && hardwareConcurrency <= ULTRA_LITE_CPU_THREADS;
  const slowNetwork = SLOW_NETWORK_TYPES.has(effectiveType);
  const verySlowNetwork = VERY_SLOW_NETWORK_TYPES.has(effectiveType);

  const autoLiteMode = prefersReducedMotion || saveData || lowMemory || lowCpu || slowNetwork;
  const autoUltraLiteMode = saveData || ultraLowMemory || ultraLowCpu || verySlowNetwork;
  const isLiteMode = modeOverride ? modeOverride === 'lite' : autoLiteMode;
  const isUltraLiteMode = modeOverride ? modeOverride === 'lite' && autoUltraLiteMode : autoUltraLiteMode;

  return {
    isLiteMode,
    isUltraLiteMode,
    saveData,
    effectiveType,
    deviceMemory: Number.isFinite(deviceMemory) ? deviceMemory : null,
    hardwareConcurrency: Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : null,
    prefersReducedMotion,
    modeOverride
  };
}

export function usePerformanceMode() {
  const [state, setState] = useState(readPerformanceState);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const handleChange = () => {
      setState(readPerformanceState());
    };

    const connection = getNavigatorConnection();
    const motionQuery =
      typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    if (connection && typeof connection.addEventListener === 'function') {
      connection.addEventListener('change', handleChange);
    }
    if (motionQuery && typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', handleChange);
    } else if (motionQuery && typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(handleChange);
    }
    window.addEventListener('storage', handleChange);

    return () => {
      if (connection && typeof connection.removeEventListener === 'function') {
        connection.removeEventListener('change', handleChange);
      }
      if (motionQuery && typeof motionQuery.removeEventListener === 'function') {
        motionQuery.removeEventListener('change', handleChange);
      } else if (motionQuery && typeof motionQuery.removeListener === 'function') {
        motionQuery.removeListener(handleChange);
      }
      window.removeEventListener('storage', handleChange);
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const root = document.documentElement;
    root.setAttribute('data-performance', state.isLiteMode ? 'lite' : 'full');
    root.setAttribute('data-device-tier', state.isUltraLiteMode ? 'ultra-lite' : state.isLiteMode ? 'lite' : 'full');
  }, [state.isLiteMode, state.isUltraLiteMode]);

  return useMemo(
    () => ({
      ...state,
      shouldReduceEffects: state.isLiteMode,
      shouldReduceBackgroundWork: state.isLiteMode,
      shouldUseSummaryPreviews: state.isLiteMode,
      shouldLimitConcurrentMedia: state.isLiteMode,
      clockTickMs: state.isLiteMode ? 30000 : 1000,
      showClockSeconds: !state.isLiteMode,
      weatherRefreshMs: state.isLiteMode ? 30 * 60 * 1000 : 15 * 60 * 1000
    }),
    [state]
  );
}

export function setPerformanceModeOverride(mode) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (mode === 'lite' || mode === 'full') {
      window.localStorage.setItem(PERFORMANCE_STORAGE_KEY, mode);
      return;
    }
    window.localStorage.removeItem(PERFORMANCE_STORAGE_KEY);
  } catch {
    // Ignore storage access issues.
  }
}
