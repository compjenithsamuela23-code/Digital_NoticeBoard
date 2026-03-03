import React from 'react';
import { useClockWeather } from '../hooks/useClockWeather';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

const TopbarStatus = ({ className = '' }) => {
  const { timeLabel, dateLabel, dayLabel, weatherLabel } = useClockWeather();
  const { isOnline, effectiveType } = useNetworkStatus();
  const networkLabel = isOnline
    ? `Online${effectiveType && effectiveType !== 'unknown' ? ` • ${effectiveType}` : ''}`
    : 'Offline';

  return (
    <div className={`topbar-status ${className}`.trim()}>
      <div className="topbar-status__time">{timeLabel}</div>
      <div className="topbar-status__date">{dateLabel}</div>
      <div className="topbar-status__day">{dayLabel}</div>
      <div className="topbar-status__weather">{weatherLabel}</div>
      <div className={`topbar-status__network ${isOnline ? 'is-online' : 'is-offline'}`}>{networkLabel}</div>
    </div>
  );
};

export default TopbarStatus;
