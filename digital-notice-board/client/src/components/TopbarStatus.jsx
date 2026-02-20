import React from 'react';
import { useClockWeather } from '../hooks/useClockWeather';

const TopbarStatus = ({ className = '' }) => {
  const { timeLabel, dateLabel, dayLabel, weatherLabel } = useClockWeather();

  return (
    <div className={`topbar-status ${className}`.trim()}>
      <div className="topbar-status__time">{timeLabel}</div>
      <div className="topbar-status__date">{dateLabel}</div>
      <div className="topbar-status__day">{dayLabel}</div>
      <div className="topbar-status__weather">{weatherLabel}</div>
    </div>
  );
};

export default TopbarStatus;
