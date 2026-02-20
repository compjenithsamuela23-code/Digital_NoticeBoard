import { useEffect, useMemo, useState } from 'react';

const WEATHER_REFRESH_MS = 15 * 60 * 1000;
const WEATHER_TIMEOUT_MS = 7000;
const FALLBACK_COORDS = {
  latitude: 40.7128,
  longitude: -74.006
};

function getBrowserCoords() {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
      },
      () => resolve(null),
      {
        enableHighAccuracy: false,
        timeout: 5000,
        maximumAge: 10 * 60 * 1000
      }
    );
  });
}

export function useClockWeather() {
  const [now, setNow] = useState(new Date());
  const [weather, setWeather] = useState(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    let pendingController = null;

    const fetchWeather = async () => {
      try {
        const coords = (await getBrowserCoords()) || FALLBACK_COORDS;
        const { latitude, longitude } = coords;

        if (pendingController) {
          pendingController.abort();
        }

        const controller = new AbortController();
        pendingController = controller;
        const timeoutHandle = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
        let weatherResponse;
        try {
          weatherResponse = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&temperature_unit=celsius`,
            { signal: controller.signal }
          );
        } finally {
          clearTimeout(timeoutHandle);
        }

        if (!weatherResponse.ok) {
          throw new Error(`Weather request failed with status ${weatherResponse.status}`);
        }

        const payload = await weatherResponse.json();

        if (!active) return;
        setWeather(payload?.current_weather || null);
      } catch {
        if (active) setWeather(null);
      }
    };

    fetchWeather();
    const refresh = setInterval(fetchWeather, WEATHER_REFRESH_MS);

    return () => {
      active = false;
      if (pendingController) {
        pendingController.abort();
      }
      clearInterval(refresh);
    };
  }, []);

  const timeLabel = useMemo(
    () =>
      now.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }),
    [now]
  );

  const dateLabel = useMemo(() => now.toLocaleDateString('en-GB'), [now]);
  const dayLabel = useMemo(() => now.toLocaleDateString(undefined, { weekday: 'long' }), [now]);
  const weatherLabel = useMemo(() => {
    if (!weather) return '--°C, wind -- km/h';
    return `${weather.temperature}°C, wind ${weather.windspeed} km/h`;
  }, [weather]);

  return {
    now,
    weather,
    timeLabel,
    dateLabel,
    dayLabel,
    weatherLabel
  };
}
