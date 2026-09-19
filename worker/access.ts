import type { SupabaseClient } from '@supabase/supabase-js';
export class AccessError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
export type Manager = { id: string; email: string; expiresAt: string };
export async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function requireSameOrigin(request: Request) {
  if (
    request.headers.get('Origin') !== new URL(request.url).origin ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  )
    throw new AccessError(403, '请从玩迹网页发起此操作');
}
function cookieName(request: Request) {
  const url = new URL(request.url);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    ? 'playtrace_session'
    : '__Host-playtrace_session';
}
export function sessionToken(request: Request) {
  const value = (request.headers.get('Cookie') || '')
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName(request)}=`))
    ?.split('=')[1];
  return value && /^pg_[a-f0-9]{64}$/.test(value) ? value : null;
}
export function sessionCookie(request: Request, token: string, maxAge: number) {
  const secure = cookieName(request).startsWith('__Host-') ? '; Secure' : '';
  return `${cookieName(request)}=${token}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${maxAge}`;
}
export async function resolveManager(
  request: Request,
  db: SupabaseClient,
): Promise<Manager | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const { data, error } = await db.rpc('resolve_google_session', {
    p_token_hash: await sha256(token),
  });
  if (error) throw new AccessError(503, '暂时无法验证管理权限，请稍后重试');
  return data?.[0]
    ? { id: data[0].manager_id, email: data[0].email, expiresAt: data[0].expires_at }
    : null;
}
export function requireManager(manager: Manager | null): Manager {
  if (!manager) throw new AccessError(401, '请使用已授权的 Google 账号登录');
  return manager;
}
export async function exitManagement(request: Request, db: SupabaseClient) {
  requireSameOrigin(request);
  const token = sessionToken(request);
  if (token) {
    const { error } = await db
      .from('google_sessions')
      .delete()
      .eq('token_hash', await sha256(token));
    if (error) throw new AccessError(503, '暂时无法退出管理模式，请重试');
  }
  return Response.json(
    { admin: false },
    { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(request, '', 0) } },
  );
}
