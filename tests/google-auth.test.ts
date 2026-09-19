import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleAuthRoute, safeReturnPath, verifiedGoogleIdentity } from '../worker/google-auth';
import { sha256 } from '../worker/access';
const mock = vi.hoisted(() => ({
  exchange: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  options: null as any,
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: unknown) => {
    mock.options = options;
    return {
      auth: { exchangeCodeForSession: mock.exchange, getUser: mock.getUser, signOut: mock.signOut },
    };
  },
}));
const origin = 'https://playtrace.test';
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-secret',
};
const state = '1'.repeat(64);
const id = '11111111-1111-4111-a111-111111111111';
const user = {
  id,
  email_confirmed_at: '2026-01-01',
  identities: [
    {
      provider: 'google',
      identity_data: {
        email: 'owner@example.com',
        email_verified: true,
        sub: 'google-subject',
      },
    },
  ],
} as any;
function database(
  options: {
    flow?: unknown;
    accounts?: unknown[];
    native?: unknown;
    claim?: unknown[];
    sessionError?: unknown;
  } = {},
) {
  const writes: { table: string; method: string; value: any }[] = [];
  const rpc = vi.fn(async (name: string) => ({
    data: {
      consume_invite_attempt: [{ allowed: true }],
      consume_google_flow:
        options.flow === null
          ? []
          : [
              options.flow || {
                verifier: 'v'.repeat(64),
                return_path: '/insights',
                native_id: null,
              },
            ],
      bind_google_account: options.accounts ?? [{ id, email: 'owner@example.com' }],
      claim_google_native_login: options.claim ?? [],
    }[name],
    error: null,
  }));
  return {
    rpc,
    writes,
    from: vi.fn((table: string) => {
      let method = '';
      const result = () => ({
        data:
          table === 'google_native_logins'
            ? (options.native ?? {
                id,
                account_id: null,
                client_name: 'cli',
                expires_at: new Date(Date.now() + 300000).toISOString(),
              })
            : [],
        error: table === 'google_sessions' ? (options.sessionError ?? null) : null,
      });
      const query: any = { then: (resolve: any) => Promise.resolve(result()).then(resolve) };
      for (const name of ['select', 'eq', 'gt', 'lt', 'is']) query[name] = () => query;
      for (const name of ['insert', 'update', 'delete'])
        query[name] = (value: unknown) => {
          method = name;
          writes.push({ table, method, value });
          return query;
        };
      query.single = query.maybeSingle = async () => result();
      return query;
    }),
  } as any;
}
const post = (path: string, body: unknown = {}, requestOrigin = origin) =>
  new Request(origin + '/api/access/' + path, {
    method: 'POST',
    headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const callback = (params = `state=${state}&code=auth-code`, cookie = state) =>
  new Request(origin + '/api/access/google/callback?' + params, {
    headers: { Cookie: `__Host-playtrace_oauth=${cookie}` },
  });
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ external: { google: true } })),
  );
  mock.exchange.mockResolvedValue({
    data: { session: { access_token: 'verified-access-token' } },
    error: null,
  });
  mock.getUser.mockResolvedValue({ data: { user }, error: null });
  mock.signOut.mockResolvedValue({ error: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('Google OAuth and native login', () => {
  it('accepts only local return paths', () => {
    for (const value of [
      'https://evil.test',
      '//evil.test',
      '/\\evil.test',
      '/%2f/evil.test',
      '/api/access/exit',
      '/foo/../api/games',
      '/\n/evil.test',
    ])
      expect(safeReturnPath(value)).toBe('/');
    expect(safeReturnPath('/games/test?view=gallery')).toBe('/games/test?view=gallery');
  });
  it('uses PKCE, a browser-bound cookie, and no secret in the authorization URL', async () => {
    const db = database();
    const response = (await googleAuthRoute(
      post('google/start', { returnTo: '//evil.test' }),
      db,
      env,
    ))!;
    const { url } = await response.json();
    const parsed = new URL(url);
    expect(parsed.origin).toBe(env.SUPABASE_URL);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('s256');
    expect(parsed.searchParams.get('code_challenge')).toHaveLength(43);
    const record = db.writes.find(
      (r: any) => r.table === 'google_oauth_flows' && r.method === 'insert',
    ).value;
    expect(record.return_path).toBe('/');
    expect(url).not.toContain(record.verifier);
    expect(url).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
    const sentState = new URL(parsed.searchParams.get('redirect_to')!).searchParams.get('state')!;
    expect(record.state_hash).toBe(await sha256(sentState));
    expect(response.headers.get('set-cookie')).toContain(
      `=${sentState}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300; Secure`,
    );
  });
  it('rejects redirected Auth settings without forwarding the server key or creating a flow', async () => {
    const fetchSettings = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://other.example/settings' },
        }),
    );
    vi.stubGlobal('fetch', fetchSettings);
    const db = database();
    await expect(googleAuthRoute(post('google/start'), db, env)).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchSettings).toHaveBeenCalledTimes(1);
    expect(fetchSettings).toHaveBeenCalledWith(
      env.SUPABASE_URL + '/auth/v1/settings',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(db.writes).toEqual([]);
  });
  it('refuses unconfigured Google, cross-site starts and oversized inputs', async () => {
    await expect(
      googleAuthRoute(post('google/start', {}, 'https://evil.test'), database(), env),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      googleAuthRoute(post('google/start', { value: 'a'.repeat(3000) }), database(), env),
    ).rejects.toMatchObject({ status: 413 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ external: { google: false } })),
    );
    await expect(googleAuthRoute(post('google/start'), database(), env)).rejects.toMatchObject({
      status: 503,
    });
  });
  it('does not exchange a code with mismatched, missing or replayed browser state', async () => {
    for (const [request, db] of [
      [callback(undefined, 'wrong'), database()],
      [callback('code=x'), database()],
      [callback(), database({ flow: null })],
    ] as const) {
      expect((await googleAuthRoute(request, db, env))!.status).toBeGreaterThanOrEqual(400);
    }
    expect(mock.exchange).not.toHaveBeenCalled();
  });
  it('requires Google-owned verified identity data, not editable metadata', () => {
    expect(verifiedGoogleIdentity(user).email).toBe('owner@example.com');
    for (const bad of [
      { ...user, identities: [] },
      { ...user, email_confirmed_at: null },
      {
        ...user,
        identities: [{ provider: 'email', identity_data: user.identities[0].identity_data }],
      },
      {
        ...user,
        identities: [
          {
            provider: 'google',
            identity_data: { ...user.identities[0].identity_data, email_verified: false },
          },
        ],
      },
      {
        ...user,
        identities: [{ provider: 'google', identity_data: {} }],
        user_metadata: user.identities[0].identity_data,
      },
    ])
      expect(() => verifiedGoogleIdentity(bad)).toThrow();
  });
  it('binds verified subject and issues only an HttpOnly archive session', async () => {
    const db = database();
    const response = (await googleAuthRoute(callback(), db, env))!;
    expect(response.status).toBe(200);
    expect(mock.getUser).toHaveBeenCalledWith('verified-access-token');
    expect(db.rpc).toHaveBeenCalledWith('bind_google_account', {
      p_email: 'owner@example.com',
      p_subject: 'google-subject',
      p_user_id: id,
    });
    expect(mock.options.auth.storage.getItem('playtrace-oauth-code-verifier')).toBeNull();
    expect(response.headers.get('set-cookie')).toContain('__Host-playtrace_session=pg_');
    const text = await response.text();
    expect(text).toContain('/insights');
    expect(text).not.toContain('verified-access-token');
    expect(text).not.toContain('pg_');
    expect(mock.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(db.writes.find((r: any) => r.table === 'google_sessions').value.token_hash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
  it('never grants management to an unlisted account or a failed provider verification', async () => {
    const db = database({ accounts: [] });
    expect((await googleAuthRoute(callback(), db, env))!.status).toBe(403);
    expect(db.writes).toEqual([]);
    mock.getUser.mockResolvedValue({ data: { user: null }, error: new Error('bad token') });
    expect((await googleAuthRoute(callback(), database(), env))!.status).toBe(401);
  });
  it('does not set a management cookie when session storage fails', async () => {
    const response = (await googleAuthRoute(
      callback(),
      database({ sessionError: { code: 'offline' } }),
      env,
    ))!;
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).not.toContain('playtrace_session');
  });
  it('requires explicit native authorization and never puts the client secret in a browser URL', async () => {
    const db = database();
    const response = (await googleAuthRoute(
      post('native/start', { challenge: '2'.repeat(64), client: 'cli' }),
      db,
      env,
    ))!;
    const data = await response.json();
    expect(data.url).toBe(`${origin}/api/access/native/authorize?id=${id}`);
    expect(data.url).not.toContain('2'.repeat(64));
    const page = (await googleAuthRoute(new Request(data.url), db, env))!;
    expect(await page.text()).toContain('两处校验码一致');
    expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });
  it('approves only the pending native request, without logging the browser into management', async () => {
    const db = database({ flow: { verifier: 'v'.repeat(64), return_path: '/', native_id: id } });
    const response = (await googleAuthRoute(callback(), db, env))!;
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).not.toContain('playtrace_session');
    expect(db.writes).toEqual([
      { table: 'google_native_logins', method: 'update', value: { account_id: id } },
    ]);
  });
  it('hands a native session only to the proof-holding claimant', async () => {
    const secret = '3'.repeat(64),
      request = post('native/claim', { id, secret });
    const pending = (await googleAuthRoute(request, database(), env))!;
    expect(pending.status).toBe(202);
    expect(pending.headers.has('set-cookie')).toBe(false);
    const db = database({
      claim: [
        { email: 'owner@example.com', expires_at: new Date(Date.now() + 600000).toISOString() },
      ],
    });
    const response = (await googleAuthRoute(post('native/claim', { id, secret }), db, env))!;
    expect(response.status).toBe(200);
    expect(db.rpc).toHaveBeenCalledWith(
      'claim_google_native_login',
      expect.objectContaining({ p_secret_hash: await sha256(secret) }),
    );
    expect(response.headers.get('set-cookie')).toContain('playtrace_session=pg_');
    expect(await response.text()).not.toContain('pg_');
  });
});
