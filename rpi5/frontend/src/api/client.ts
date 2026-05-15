const BASE_URL = '/api';

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API ${status}: ${body}`);
  }
}

async function request<T>(method: string, path: string, opts: { params?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const url = new URL(BASE_URL + path, window.location.origin);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const init: RequestInit = {
    method,
    headers: { Accept: 'application/json' },
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(url.toString(), init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text);
  }
  return (await res.json()) as T;
}

export function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  return request<T>('GET', path, { params });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, { body });
}
