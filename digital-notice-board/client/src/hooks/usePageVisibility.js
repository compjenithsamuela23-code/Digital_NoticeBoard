import { useEffect, useState } from 'react';

function getCurrentVisibility() {
  if (typeof document === 'undefined') {
    return true;
  }
  return !document.hidden;
}

export function usePageVisibility() {
  const [isVisible, setIsVisible] = useState(getCurrentVisibility);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return isVisible;
}
