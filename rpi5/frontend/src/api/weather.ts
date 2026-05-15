import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { WeatherForecastDay, WeatherNow } from './types';

export function useWeatherNow() {
  return useQuery({
    queryKey: ['weather', 'now'],
    queryFn: () => apiGet<WeatherNow>('/weather/now'),
    refetchInterval: 60_000,
  });
}

export function useWeatherForecast() {
  return useQuery({
    queryKey: ['weather', 'forecast'],
    queryFn: () => apiGet<WeatherForecastDay[]>('/weather/forecast'),
    refetchInterval: 30 * 60_000,
    staleTime: 15 * 60_000,
  });
}
