import React from 'react';

const RouteLoader = ({ message = 'Loading workspace...' }) => (
  <div className="route-loader" role="status" aria-live="polite">
    <div className="route-loader__pulse" aria-hidden="true" />
    <p className="route-loader__message">{message}</p>
  </div>
);

export default RouteLoader;
