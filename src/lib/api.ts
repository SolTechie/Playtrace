import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { gameInputSchema, type Game } from '../../shared/schema';

export async function loadSeedGames(): Promise<Game[]> {
  if (!import.meta.env.DEV) return [];
  const response = await fetch('/dev-data/games.json');
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
    return [];
  const initial = (await response.json()) as (Game & { id: string })[];
  return initial.map((g) => ({ ...gameInputSchema.parse(g), id: g.id, version: 1 }));
}
let session: Session | null = null;
export let supabase: SupabaseClient | null = null;
let configuration: Promise<boolean> | null = null;
export function configure() {
  return (configuration ??= initialize());
}
async function initialize() {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('无法连接网站服务，请稍后重试。');
  const config = await response.json();
  if (config.configured) {
    supabase = createClient(config.url, config.key);
    session = (await supabase.auth.getSession()).data.session;
    supabase.auth.onAuthStateChange((_event, value) => {
      session = value;
    });
  }
  return config.configured as boolean;
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  const response = await fetch(`/api${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({ error: '服务器响应异常' }));
  if (!response.ok) throw new Error(data.error || '操作失败，请重试');
  return data as T;
}
