import React, { useEffect, useMemo } from 'react';
import io from 'socket.io-client';
import { SOCKET_URL } from '../config/api';
import { SocketContext } from './socket-context';

export const SocketProvider = ({ children }) => {
  const socket = useMemo(
    () =>
      io(SOCKET_URL, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000
      }),
    []
  );

  useEffect(() => {
    return () => {
      socket.close();
    };
  }, [socket]);

  return (
    <SocketContext.Provider value={{ socket }}>
      {children}
    </SocketContext.Provider>
  );
};
