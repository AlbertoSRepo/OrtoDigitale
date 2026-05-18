// Tipi rispecchiano gli endpoint reali di Node-RED (vedi rpi5/nodered/data/flows.json)

export interface SensorLast {
  sensor_id: string;
  aiuola: number | string | null;
  position: 'near' | 'far' | string | null;
  value: number | null;
  timestamp: number | null;
  battery_ok: boolean | null;
  rssi: number | null;
  online: boolean;
}

export interface TrendPoint {
  t: number;
  value: number;
}

export type SensorTrend = Record<string, TrendPoint[]>;

export interface ValveState {
  valve_id: string;
  state: 'ON' | 'OFF' | 'unknown';
  reachable: boolean | null;
  linkquality: number | null;
  last_change: number | null;
  open_since_seconds: number | null;
  auto_close_in_seconds: number | null;
  max_duration_seconds: number;
  requested_duration_seconds: number | null;
}

export interface ValveInterval {
  start: number;
  end: number;
  duration_seconds: number;
  trigger: 'auto' | 'manual' | string;
}

export interface ValveCumulative {
  total_open_seconds: number;
}

export interface WeatherNow {
  temperature_c: number | null;
  humidity_pct: number | null;
  precip_next_24h_mm: number | null;
  precip_next_6h_mm: number | null;
  timestamp: number | null;
  source: string;
}

export interface WeatherForecastDay {
  date: string;
  t_min: number | null;
  t_max: number | null;
  precip_mm: number | null;
  weather_code: number | null;
}

export interface WeatherTodayV2 {
  t_min: number | null;
  t_max: number | null;
  precip_sum_mm: number | null;
  precip_probability_pct: number | null;
  sunrise: string | null;
  sunset: string | null;
}

export interface WeatherNowV2 {
  fetched_at: string | null;
  age_seconds: number;
  stale: boolean;
  source: string;
  temperature_c: number | null;
  apparent_temperature_c: number | null;
  humidity_pct: number | null;
  precipitation_mm_last_hour: number | null;
  wind_speed_kmh: number | null;
  wind_direction_deg: number | null;
  weather_code: number | null;
  today: WeatherTodayV2;
}

export interface WeatherDay {
  date: string;
  weather_code: number | null;
  t_min: number | null;
  t_max: number | null;
  precip_sum_mm: number | null;
  precip_probability_pct: number | null;
  wind_speed_max_kmh: number | null;
  sunrise: string | null;
  sunset: string | null;
}

export interface WeatherForecastV2 {
  fetched_at: string | null;
  age_seconds: number;
  stale: boolean;
  source: string;
  days: WeatherDay[];
}

export interface SystemHealth {
  uptime_seconds: number;
  timestamp: number;
  config_loaded: boolean;
  mode: string | null;
  valve_state: 'ON' | 'OFF' | 'unknown';
  valve_reachable: boolean | null;
  sensors_online: number;
  sensors_total: number;
  weather_last_poll_seconds_ago: number | null;
}

export interface SystemStatsDisk {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  used_pct: number;
}

export interface SystemStatsRam {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  used_pct: number;
}

export interface SystemStatsCpu {
  used_pct: number;
  load_avg_1_5_15: [number, number, number];
}

export interface SystemStatsThermal {
  soc_temp_c: number | null;
}

export interface SystemStats {
  generated_at: string;
  age_seconds: number | null;
  stale: boolean;
  disk: SystemStatsDisk;
  ram: SystemStatsRam;
  cpu: SystemStatsCpu;
  thermal: SystemStatsThermal;
}

export interface ShutdownAck {
  ok: boolean;
  scheduled_in_seconds: number;
  countdown_minutes: number;
  message: string;
}

export interface CancelAck {
  ok: boolean;
  message: string;
}

export interface OpenValveAck {
  ok: boolean;
  state: string;
  duration_seconds_applied?: number;
}
