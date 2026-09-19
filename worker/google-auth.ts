import type { SupabaseClient } from '@supabase/supabase-js';
import { googleConfig, exchangeGoogleCode, type AuthEnv } from './google-provider';
export type { AuthEnv } from './google-provider';
import { AccessError, requireSameOrigin, sessionCookie, sessionToken, sha256 } from './access';

const lifetime = 300;
const hexPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const randomSecret = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers },
  });
function check(error: unknown) {
  if (error) throw new AccessError(503, '暂时无法完成登录，请稍后重试');
}
function flowCookieName(request: Request) {
  const url = new URL(request.url);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    ? 'playtrace_oauth'
    : '__Host-playtrace_oauth';
}
function flowCookie(request: Request, value: string, age = lifetime) {
  const name = flowCookieName(request);
  // Lax permits the top-level redirect from Google. Management stays Strict.
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${name.startsWith('__Host-') ? '; Secure' : ''}`;
}
function readFlowCookie(request: Request) {
  return (request.headers.get('Cookie') || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${flowCookieName(request)}=`))
    ?.split('=')[1];
}
export function safeReturnPath(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 500 ||
    !/^\/(?:$|[^/\\])/.test(value) ||
    /[\\\r\n%#]/.test(value) ||
    value.startsWith('/api/')
  )
    return '/';
  const parsed = new URL(value, 'https://playtrace.invalid');
  return parsed.origin === 'https://playtrace.invalid' && !parsed.pathname.startsWith('/api/')
    ? parsed.pathname + parsed.search
    : '/';
}
async function smallBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const bytes = new Uint8Array(2048);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > bytes.length) {
        await reader.cancel();
        throw new AccessError(413, '登录请求内容过长');
      }
      bytes.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(bytes.subarray(0, length));
  if (request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded'))
    return Object.fromEntries(new URLSearchParams(text));
  const body = JSON.parse(text || '{}');
  if (!body || Array.isArray(body) || typeof body !== 'object')
    throw new AccessError(400, '登录请求无效');
  return body;
}
async function rateLimit(request: Request, db: SupabaseClient) {
  const client = request.headers.get('CF-Connecting-IP') || 'local';
  const { data, error } = await db.rpc('consume_invite_attempt', {
    p_client_hash: await sha256(`google:${client}`),
  });
  check(error);
  if (!data?.[0]) throw new AccessError(503, '暂时无法验证登录请求');
  if (!data[0].allowed) throw new AccessError(429, '登录尝试过多，请稍后再试', data[0].retry_after);
}
async function cleanup(db: SupabaseClient) {
  for (const table of ['google_oauth_flows', 'google_native_logins', 'google_sessions']) {
    const { error } = await db.from(table).delete().lt('expires_at', new Date().toISOString());
    check(error);
  }
}
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
function page(title: string, content: string, status = 200, cookie?: string) {
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · 玩迹</title>
<style>body{background:#101214;color:#eee;font:16px/1.8 system-ui;margin:0;padding:24px}main{max-width:460px;margin:12vh auto}h1{font-size:26px}p{color:#b8bdb9}button,a{font:inherit;color:#bce99b}button{background:#bce99b;color:#101214;border:0;border-radius:10px;padding:12px 20px;cursor:pointer}code{font-size:26px;letter-spacing:4px}small{color:#aaa}</style>
<main><small>PLAYTRACE / 玩迹</small><h1>${escapeHtml(title)}</h1>${content}</main></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        ...(cookie ? { 'Set-Cookie': cookie } : {}),
      },
    },
  );
}
async function pendingNative(db: SupabaseClient, id: unknown) {
  if (typeof id !== 'string' || !uuidPattern.test(id)) throw new AccessError(400, '登录请求无效');
  const { data, error } = await db
    .from('google_native_logins')
    .select('id,client_name,account_id')
    .eq('id', id)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  check(error);
  if (!data || data.account_id)
    throw new AccessError(410, '本次登录已结束或超时，请从 App 或 CLI 重新登录');
  return data;
}
async function start(request: Request, db: SupabaseClient, env: AuthEnv) {
  requireSameOrigin(request);
  await rateLimit(request, db);
  const input = await smallBody(request);
  const native = input.nativeId ? await pendingNative(db, input.nativeId) : null;
  const config = googleConfig(env, request);
  await cleanup(db);
  const state = randomSecret(),
    verifier = randomSecret(),
    nonce = randomSecret();
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  const { error } = await db.from('google_oauth_flows').insert({
    state_hash: await sha256(state),
    verifier,
    nonce,
    redirect_uri: config.redirectUri,
    return_path: safeReturnPath(input.returnTo),
    native_id: native?.id || null,
  });
  check(error);
  if (native)
    return new Response(null, {
      status: 303,
      headers: {
        Location: authorize.href,
        'Set-Cookie': flowCookie(request, state),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  return json({ url: authorize.href }, 200, { 'Set-Cookie': flowCookie(request, state) });
}
async function removePreviousSession(request: Request, db: SupabaseClient) {
  const previous = sessionToken(request);
  if (previous) {
    const { error } = await db
      .from('google_sessions')
      .delete()
      .eq('token_hash', await sha256(previous));
    check(error);
  }
}
async function callback(request: Request, db: SupabaseClient, env: AuthEnv) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  try {
    if (!state || !hexPattern.test(state) || state !== readFlowCookie(request))
      throw new AccessError(400, '登录校验失败，请从刚才的浏览器重新发起登录');
    const { data, error } = await db.rpc('consume_google_flow', {
      p_state_hash: await sha256(state),
    });
    check(error);
    const flow = data?.[0];
    if (!flow) throw new AccessError(410, '登录已超时或已使用，请重新登录');
    if (url.searchParams.has('error')) throw new AccessError(400, 'Google 登录未完成，请重试');
    const code = url.searchParams.get('code');
    if (!code || code.length > 2048) throw new AccessError(400, '缺少 Google 登录结果，请重试');
    const config = googleConfig(env, request);
    if (!hexPattern.test(flow.nonce || '') || flow.redirect_uri !== config.redirectUri)
      throw new AccessError(410, '登录配置已更新，请重新发起登录');
    const google = await exchangeGoogleCode(code, flow.verifier, flow.nonce, config);
    const { data: accounts, error: accountError } = await db.rpc('bind_google_account', {
      p_email: google.email,
      p_subject: google.subject,
    });
    check(accountError);
    const account = accounts?.[0];
    if (!account)
      throw new AccessError(403, '这个 Google 账号尚未获得管理权限，请使用管理员授权的账号');
    if (flow.native_id) {
      const { data: approved, error: approvalError } = await db
        .from('google_native_logins')
        .update({ account_id: account.id })
        .eq('id', flow.native_id)
        .is('account_id', null)
        .gt('expires_at', new Date().toISOString())
        .select('id')
        .maybeSingle();
      check(approvalError);
      if (!approved) throw new AccessError(410, '桌面登录请求已结束，请在电脑重新登录');
      return page(
        '已授权本机登录',
        '<p>请返回刚才发起登录的玩迹 App 或终端。此页面可以关闭。</p>',
        200,
        flowCookie(request, '', 0),
      );
    }
    const token = `pg_${randomSecret()}`;
    const { error: sessionError } = await db.from('google_sessions').insert({
      token_hash: await sha256(token),
      account_id: account.id,
    });
    check(sessionError);
    await removePreviousSession(request, db);
    // An intermediate same-origin page ensures Strict cookies work after the OAuth redirect.
    const response = page(
      '登录成功',
      `<p>已使用 ${escapeHtml(google.email)} 登录。</p><a href="${escapeHtml(safeReturnPath(flow.return_path))}">继续使用玩迹 →</a>`,
      200,
      flowCookie(request, '', 0),
    );
    response.headers.append('Set-Cookie', sessionCookie(request, token, 7 * 86400));
    return response;
  } catch (error) {
    const status = error instanceof AccessError ? error.status : 503;
    const message = error instanceof AccessError ? error.message : '暂时无法完成登录，请重试';
    return page(
      '登录未完成',
      `<p>${escapeHtml(message)}</p><a href="/">返回玩迹重新登录</a>`,
      status,
      flowCookie(request, '', 0),
    );
  }
}
export async function googleAuthRoute(
  request: Request,
  db: SupabaseClient,
  env: AuthEnv,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === '/api/access/google/start' && request.method === 'POST')
    return start(request, db, env);
  if (path === '/api/access/google/callback' && request.method === 'GET')
    return callback(request, db, env);
  if (path === '/api/access/native/start' && request.method === 'POST') {
    requireSameOrigin(request);
    await rateLimit(request, db);
    const input = await smallBody(request);
    if (
      typeof input.challenge !== 'string' ||
      !hexPattern.test(input.challenge) ||
      !['desktop', 'cli'].includes(input.client as string)
    )
      throw new AccessError(400, '桌面登录请求无效');
    await cleanup(db);
    const { data, error } = await db
      .from('google_native_logins')
      .insert({
        secret_hash: input.challenge,
        client_name: input.client,
      })
      .select('id,expires_at')
      .single();
    check(error);
    if (!data) throw new AccessError(503, '无法创建桌面登录请求');
    const authorize = new URL('/api/access/native/authorize', request.url);
    authorize.searchParams.set('id', data.id);
    return json({
      id: data.id,
      url: authorize.href,
      displayCode: data.id.slice(0, 8).toUpperCase(),
      expiresAt: data.expires_at,
    });
  }
  if (path === '/api/access/native/authorize' && request.method === 'GET') {
    const native = await pendingNative(db, url.searchParams.get('id'));
    return page(
      native.client_name === 'cli' ? '授权本机 CLI' : '授权 Mac App',
      `<p>请核对本机显示的校验码：</p><p><code>${native.id.slice(0, 8).toUpperCase()}</code></p><p>仅在你刚刚主动发起登录、且两处校验码一致时继续。登录后，这个客户端可以管理你的游戏库。</p><form method="post" action="/api/access/google/start"><input type="hidden" name="nativeId" value="${native.id}"><button>使用 Google 账号授权</button></form>`,
    );
  }
  if (path === '/api/access/native/claim' && request.method === 'POST') {
    requireSameOrigin(request);
    const input = await smallBody(request);
    if (
      typeof input.id !== 'string' ||
      !uuidPattern.test(input.id) ||
      typeof input.secret !== 'string' ||
      !hexPattern.test(input.secret)
    )
      throw new AccessError(400, '桌面登录请求无效');
    const secretHash = await sha256(input.secret);
    const token = `pg_${randomSecret()}`;
    const { data, error } = await db.rpc('claim_google_native_login', {
      p_id: input.id,
      p_secret_hash: secretHash,
      p_session_hash: await sha256(token),
    });
    check(error);
    if (!data?.[0]) {
      const { data: pending, error: pendingError } = await db
        .from('google_native_logins')
        .select('id')
        .eq('id', input.id)
        .eq('secret_hash', secretHash)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      check(pendingError);
      if (!pending) throw new AccessError(410, '登录已结束或超时，请重新登录');
      return json({ pending: true }, 202, { 'Retry-After': '2' });
    }
    await removePreviousSession(request, db);
    return json({ admin: true, email: data[0].email, expiresAt: data[0].expires_at }, 200, {
      'Set-Cookie': sessionCookie(
        request,
        token,
        Math.max(0, Math.floor((Date.parse(data[0].expires_at) - Date.now()) / 1000)),
      ),
    });
  }
  return null;
}
