import { useEffect, useRef } from 'react';

function jitteredInterval(baseMs, jitterRatio = 0.15) {
  const safeBase = Math.max(1000, Number.parseInt(baseMs, 10) || 1000);
  const safeRatio = Math.min(0.35, Math.max(0, Number(jitterRatio) || 0));
  const spread = Math.round(safeBase * safeRatio);
  return safeBase + Math.round((Math.random() * 2 - 1) * spread);
}

function getNetworkSlowdownMultiplier() {
  if (typeof navigator === 'undefined') {
    return 1;
  }

  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) {
    return 1;
  }

  if (connection.saveData) {
    return 2.4;
  }

  const effectiveType = String(connection.effectiveType || '').toLowerCase();
  if (effectiveType === 'slow-2g') return 3;
  if (effectiveType === '2g') return 2.5;
  if (effectiveType === '3g') return 1.7;
  return 1;
}

export function useAdaptivePolling(task, options = {}) {
  const {
    enabled = true,
    online = true,
    visible = true,
    immediate = true,
    baseIntervalMs = 15000,
    hiddenIntervalMs = 45000,
    offlineIntervalMs = 90000,
    jitterRatio = 0.15
  } = options;

  const taskRef = useRef(task);
  const inFlightRef = useRef(false);

  useEffect(() => {
    taskRef.current = task;
  }, [task]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let cancelled = false;
    let timerId = null;

    const computeNextInterval = () => {
      const slowdownMultiplier = getNetworkSlowdownMultiplier();
      if (!online) {
        return Math.round(offlineIntervalMs * slowdownMultiplier);
      }
      if (!visible) {
        return Math.round(hiddenIntervalMs * slowdownMultiplier);
      }
      return Math.round(baseIntervalMs * slowdownMultiplier);
    };

    const scheduleNext = () => {
      if (cancelled) return;
      const nextInterval = jitteredInterval(computeNextInterval(), jitterRatio);
      timerId = window.setTimeout(runOnce, nextInterval);
    };

    const runOnce = async () => {
      if (cancelled || inFlightRef.current) {
        scheduleNext();
        return;
      }

      inFlightRef.current = true;
      try {
        await taskRef.current();
      } finally {
        inFlightRef.current = false;
        scheduleNext();
      }
    };

    if (immediate) {
      runOnce();
    } else {
      scheduleNext();
    }

    return () => {
      cancelled = true;
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [
    baseIntervalMs,
    enabled,
    hiddenIntervalMs,
    immediate,
    jitterRatio,
    offlineIntervalMs,
    online,
    visible
  ]);
}
