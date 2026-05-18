import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { WeatherForecastV2, WeatherNowV2 } from './types';

export function useWeatherNow() {
  return useQuery({
    queryKey: ['weather', 'now-v2'],
    queryFn: () => apiGet<WeatherNowV2>('/weather/now-v2'),
    refetchInterval: 60_000,
  });
}

export function useWeatherForecast() {
  return useQuery({
    queryKey: ['weather', 'forecast-v2'],
    queryFn: () => apiGet<WeatherForecastV2>('/weather/forecast-v2'),
    refetchInterval: 5 * 60_000,
    staleTime: 5 * 60_000,
  });
}
