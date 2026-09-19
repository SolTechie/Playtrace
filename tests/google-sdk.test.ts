import { afterEach, expect, it, vi } from 'vitest';
import { googleAuthRoute } from '../worker/google-auth';
// Exercise the installed Supabase SDK, mocking only the remote HTTP boundary.
// This catches ignored custom storage, PKCE serialization and refresh/session mistakes.
afterEach(() => vi.unstubAllGlobals());
it('exchanges PKCE through the real SDK and discards its temporary Supabase session', async () => {
  const id = '11111111-1111-4111-a111-111111111111';
  const user = {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'owner@example.com',
    email_confirmed_at: '2026-01-01',
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: {},
    identities: [
      {
        provider: 'google',
        identity_data: { email: 'owner@example.com', email_verified: true, sub: 'owner-subject' },
      },
    ],
  };
  const token = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      'base64url',
    ),
    'signature',
  ].join('.');
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/token?grant_type=pkce')) {
        expect(JSON.parse(init?.body as string)).toEqual({
          auth_code: 'one-time-code',
          code_verifier: 'v'.repeat(64),
        });
        return Response.json({
          access_token: token,
          refresh_token: 'temporary-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          user,
        });
      }
      if (url.endsWith('/user')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + token);
        return Response.json(user);
      }
      if (url.endsWith('/logout?scope=local')) return new Response(null, { status: 204 });
      throw new Error('Unexpected auth HTTP request: ' + url);
    }),
  );
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'consume_google_flow'
        ? [{ verifier: 'v'.repeat(64), return_path: '/', native_id: null }]
        : [{ id, email: 'owner@example.com' }],
  }));
  const db = { rpc, from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })) } as any;
  const state = '1'.repeat(64);
  const response = (await googleAuthRoute(
    new Request(
      `https://playtrace.test/api/access/google/callback?state=${state}&code=one-time-code`,
      {
        headers: { Cookie: `__Host-playtrace_oauth=${state}` },
      },
    ),
    db,
    { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only-key' },
  ))!;
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('playtrace_session=pg_');
  expect(calls.map((r) => new URL(r.url).pathname)).toEqual([
    '/auth/v1/token',
    '/auth/v1/user',
    '/auth/v1/logout',
  ]);
  expect(rpc).toHaveBeenCalledWith('bind_google_account', {
    p_email: 'owner@example.com',
    p_subject: 'owner-subject',
    p_user_id: id,
  });
  const html = await response.text();
  expect(html).not.toContain(token);
  expect(html).not.toContain('temporary-refresh');
});
