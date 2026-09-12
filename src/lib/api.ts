import { gameInputSchema, type Game } from '../../shared/schema';
import { yearOnly } from '../../shared/release-year';

export async function loadSeedGames(): Promise<Game[]> {
  if (!import.meta.env.DEV) return [];
  const response = await fetch('/dev-data/games.json');
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
    return [];
  const initial = (await response.json()) as (Game & { id: string })[];
  return initial.map((g) => ({ ...gameInputSchema.parse(yearOnly(g)), id: g.id, version: 1 }));
}
let configuration: Promise<boolean> | null = null;
export function configure() {
  return (configuration ??= initialize());
}
async function initialize() {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('无法连接网站服务，请稍后重试。');
  const config = await response.json();
  return config.configured as boolean;
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({ error: '服务器响应异常' }));
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('playtrace:access'));
    throw new Error(data.error || '操作失败，请重试');
  }
  return data as T;
}

export function accessChanged() {
  window.dispatchEvent(new Event('playtrace:access'));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('playtrace-access');
    channel.postMessage('changed');
    channel.close();
  }
}
export async function enterManagement(code: string) {
  const result = await api('/access/verify', { method: 'POST', body: JSON.stringify({ code }) });
  accessChanged();
  return result;
}
export async function leaveManagement() {
  await api('/access/exit', { method: 'POST', body: '{}' });
  accessChanged();
}
