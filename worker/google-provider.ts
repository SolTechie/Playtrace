import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AccessError } from './access';

export type AuthEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
};
type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string };
// A fixed Google endpoint; never resolve keys from a token-supplied URL.
// jose caches keys, handles rotation, verifies signatures and rejects redirects.
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export function googleConfig(env: AuthEnv, request: Request): GoogleConfig {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  let callback: URL;
  try {
    callback = new URL(env.GOOGLE_REDIRECT_URI || '');
  } catch {
    throw new AccessError(503, 'Google 登录尚未配置，请联系档案管理员');
  }
  const local =
    callback.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(callback.hostname);
  if (
    !clientId ||
    !clientSecret ||
    (!local && callback.protocol !== 'https:') ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    callback.pathname !== '/api/access/google/callback' ||
    callback.origin !== new URL(request.url).origin
  )
    throw new AccessError(503, 'Google 登录配置与当前网址不匹配，请联系档案管理员');
  return { clientId, clientSecret, redirectUri: callback.href };
}

export async function exchangeGoogleCode(
  code: string,
  verifier: string,
  nonce: string,
  config: GoogleConfig,
) {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Token exchange failed');
    const tokens = (await response.json()) as { id_token?: unknown };
    if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 16384)
      throw new Error('Missing ID token');
    const { payload } = await jwtVerify(tokens.id_token, googleKeys, {
      algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: config.clientId,
      requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'email', 'email_verified'],
      maxTokenAge: '5 minutes',
      clockTolerance: 30,
    });
    if (
      payload.nonce !== nonce ||
      payload.email_verified !== true ||
      typeof payload.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      payload.sub.length > 255 ||
      (payload.azp !== undefined && payload.azp !== config.clientId) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)
    )
      throw new Error('Invalid Google identity');
    // Provider tokens exist only in this request; keep our own revocable session.
    return { email: payload.email.trim().toLowerCase(), subject: payload.sub };
  } catch {
    // Do not leak authorization codes, provider responses or credentials into logs/HTML.
    throw new AccessError(401, 'Google 登录验证失败，请重新登录');
  }
}
