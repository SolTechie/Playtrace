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
export type Manager = { id: string; expiresAt: string };
export async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
// Random numeric invites use a per-invite salt and a slow, server-side verifier.
export async function deriveInviteHash(code: string, salt: string) {
  if (!/^[a-f0-9]{32}$/.test(salt)) throw new AccessError(503, '邀请码配置异常');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(code),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: 100_000,
      salt: Uint8Array.from(salt.match(/../g)!, (pair) => parseInt(pair, 16)),
    },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function sameHash(a: string, b: string) {
  if (a.length !== 64 || b.length !== 64) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
async function inviteBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AccessError(400, '请输入 12 位数字邀请码');
  const bytes = new Uint8Array(200);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > bytes.length) {
        await reader.cancel();
        throw new AccessError(400, '请输入 12 位数字邀请码');
      }
      bytes.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, length));
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
  return value && /^ps_[a-f0-9]{64}$/.test(value) ? value : null;
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
  const { data, error } = await db.rpc('resolve_management_session', {
    p_token_hash: await sha256(token),
  });
  if (error) throw new AccessError(503, '暂时无法验证管理权限，请稍后重试');
  return data?.[0] ? { id: data[0].manager_id, expiresAt: data[0].expires_at } : null;
}
export function requireManager(manager: Manager | null): Manager {
  if (!manager) throw new AccessError(401, '请输入管理邀请码');
  return manager;
}
export async function verifyInvite(request: Request, db: SupabaseClient) {
  requireSameOrigin(request);
  const client = request.headers.get('CF-Connecting-IP') || 'local';
  const { data: attempt, error: attemptError } = await db.rpc('consume_invite_attempt', {
    p_client_hash: await sha256(`client:${client}`),
  });
  if (attemptError || !attempt?.[0]) throw new AccessError(503, '暂时无法验证邀请码');
  if (!attempt[0].allowed)
    throw new AccessError(429, '尝试次数过多，请 15 分钟后再试', attempt[0].retry_after);
  const body = await inviteBody(request);
  let code: unknown;
  try {
    code = JSON.parse(body).code;
  } catch {
    throw new AccessError(400, '请输入 12 位数字邀请码');
  }
  if (typeof code !== 'string' || !/^\d{12}$/.test(code))
    throw new AccessError(400, '请输入 12 位数字邀请码');
  const { data: candidates, error: lookupError } = await db
    .from('management_invites')
    .select('code_hash,salt')
    .is('revoked_at', null)
    .not('salt', 'is', null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .limit(11);
  if (lookupError || !candidates || candidates.length > 10)
    throw new AccessError(503, '暂时无法验证邀请码');
  let matched: string | null = null;
  for (const candidate of candidates) {
    if (sameHash(await deriveInviteHash(code, candidate.salt), candidate.code_hash))
      matched = candidate.code_hash;
  }
  if (!matched) throw new AccessError(401, '邀请码无效或已停用');
  const token = `ps_${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const { data, error } = await db.rpc('redeem_management_invite', {
    p_code_hash: matched,
    p_session_hash: await sha256(token),
  });
  if (error) throw new AccessError(503, '暂时无法验证邀请码');
  if (!data?.[0]) throw new AccessError(401, '邀请码无效或已停用');
  const old = sessionToken(request);
  if (old)
    await db
      .from('management_sessions')
      .delete()
      .eq('token_hash', await sha256(old));
  return Response.json(
    { admin: true, expiresAt: data[0].expires_at },
    {
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(
          request,
          token,
          Math.max(0, Math.floor((Date.parse(data[0].expires_at) - Date.now()) / 1000)),
        ),
      },
    },
  );
}
export async function exitManagement(request: Request, db: SupabaseClient) {
  requireSameOrigin(request);
  const token = sessionToken(request);
  if (token) {
    const { error } = await db
      .from('management_sessions')
      .delete()
      .eq('token_hash', await sha256(token));
    if (error) throw new AccessError(503, '暂时无法退出管理模式，请重试');
  }
  return Response.json(
    { admin: false },
    { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(request, '', 0) } },
  );
}
