import React, { useEffect, useMemo, useState } from 'react';
import io from 'socket.io-client';
import { SOCKET_URL } from '../config/api';
import { SocketContext } from './socket-context';

export const SocketProvider = ({ children }) => {
  const socketEnabled =
    String(import.meta.env.VITE_ENABLE_SOCKET || (import.meta.env.DEV ? 'true' : 'false')).toLowerCase() ===
    'true';
  const [isSocketConnected, setIsSocketConnected] = useState(false);

  const socket = useMemo(
    () => {
      if (!socketEnabled) {
        return null;
      }

      return io(SOCKET_URL, {
        transports: ['websocket', 'polling'],
        tryAllTransports: true,
        rememberUpgrade: true,
        autoConnect: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        randomizationFactor: 0.5,
        timeout: 12000
      });
    },
    [socketEnabled]
  );

  useEffect(() => {
    if (!socket) return undefined;

    const handleConnect = () => setIsSocketConnected(true);
    const handleDisconnect = () => setIsSocketConnected(false);
    const handleOnline = () => {
      socket.connect();
    };
    const handleOffline = () => {
      setIsSocketConnected(false);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      socket.close();
    };
  }, [socket]);

  return (
    <SocketContext.Provider
      value={{ socket, isSocketConnected: Boolean(socket && (socket.connected || isSocketConnected)), socketEnabled }}
    >
      {children}
    </SocketContext.Provider>
  );
};
