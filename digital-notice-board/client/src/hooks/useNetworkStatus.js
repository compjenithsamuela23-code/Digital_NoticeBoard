import { useEffect, useState } from 'react';

function readConnectionMeta() {
  if (typeof navigator === 'undefined') {
    return {
      effectiveType: 'unknown',
      downlink: null
    };
  }

  const connection =
    navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  if (!connection) {
    return {
      effectiveType: 'unknown',
      downlink: null
    };
  }

  return {
    effectiveType: String(connection.effectiveType || 'unknown'),
    downlink: Number.isFinite(connection.downlink) ? connection.downlink : null
  };
}

export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator === 'undefined' ? true : Boolean(navigator.onLine)
  );
  const [connectionMeta, setConnectionMeta] = useState(readConnectionMeta);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    const handleConnectionChange = () => setConnectionMeta(readConnectionMeta());

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const connection =
      navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    if (connection && typeof connection.addEventListener === 'function') {
      connection.addEventListener('change', handleConnectionChange);
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (connection && typeof connection.removeEventListener === 'function') {
        connection.removeEventListener('change', handleConnectionChange);
      }
    };
  }, []);

  return {
    isOnline,
    effectiveType: connectionMeta.effectiveType,
    downlink: connectionMeta.downlink
  };
}
