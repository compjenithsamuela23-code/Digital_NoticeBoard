import React from 'react';
import { useClockWeather } from '../hooks/useClockWeather';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { usePerformanceMode } from '../hooks/usePerformanceMode';

const TopbarStatus = ({ className = '' }) => {
  const { isLiteMode, showClockSeconds, clockTickMs, weatherRefreshMs } = usePerformanceMode();
  const { timeLabel, dateLabel, dayLabel, weatherLabel } = useClockWeather({
    showSeconds: showClockSeconds,
    clockTickMs,
    weatherRefreshMs
  });
  const { isOnline, effectiveType, saveData } = useNetworkStatus();
  const networkLabel = isOnline
    ? `Online${effectiveType && effectiveType !== 'unknown' ? ` • ${effectiveType}` : ''}${
        saveData ? ' • Saver' : isLiteMode ? ' • Lite' : ''
      }`
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
