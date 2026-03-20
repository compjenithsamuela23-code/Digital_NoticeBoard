import { useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_WEATHER_REFRESH_MS = 15 * 60 * 1000;
const WEATHER_TIMEOUT_MS = 7000;
const WEATHER_CACHE_KEY = 'dnb.clock-weather.cache';
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

function readCachedWeather(maxAgeMs) {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(WEATHER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const fetchedAtMs = Number.parseInt(parsed?.fetchedAtMs, 10);
    if (!Number.isFinite(fetchedAtMs) || Date.now() - fetchedAtMs > maxAgeMs) {
      return null;
    }
    return parsed?.weather || null;
  } catch {
    return null;
  }
}

function writeCachedWeather(weather) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      WEATHER_CACHE_KEY,
      JSON.stringify({
        fetchedAtMs: Date.now(),
        weather
      })
    );
  } catch {
    // Ignore storage quota/privacy failures.
  }
}

export function useClockWeather(options = {}) {
  const showSeconds = options.showSeconds !== false;
  const clockTickMs = Math.max(1000, Number.parseInt(options.clockTickMs, 10) || 1000);
  const weatherRefreshMs =
    Math.max(60 * 1000, Number.parseInt(options.weatherRefreshMs, 10) || DEFAULT_WEATHER_REFRESH_MS);
  const [now, setNow] = useState(new Date());
  const [weather, setWeather] = useState(() => readCachedWeather(weatherRefreshMs));
  const coordsRef = useRef(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), clockTickMs);
    return () => clearInterval(timer);
  }, [clockTickMs]);

  useEffect(() => {
    let active = true;
    let pendingController = null;

    const fetchWeather = async () => {
      try {
        if (!coordsRef.current) {
          coordsRef.current = (await getBrowserCoords()) || FALLBACK_COORDS;
        }
        const coords = coordsRef.current || FALLBACK_COORDS;
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
        const nextWeather = payload?.current_weather || null;
        setWeather(nextWeather);
        writeCachedWeather(nextWeather);
      } catch {
        if (active) setWeather(null);
      }
    };

    if (!weather) {
      fetchWeather();
    }
    const refresh = setInterval(fetchWeather, weatherRefreshMs);

    return () => {
      active = false;
      if (pendingController) {
        pendingController.abort();
      }
      clearInterval(refresh);
    };
  }, [weather, weatherRefreshMs]);

  const timeLabel = useMemo(
    () =>
      now.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        ...(showSeconds ? { second: '2-digit' } : {}),
        hour12: false
      }),
    [now, showSeconds]
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
