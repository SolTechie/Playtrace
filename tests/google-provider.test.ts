import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { exchangeGoogleCode } from '../worker/google-provider';

const config = {
  clientId: 'test-client.apps.googleusercontent.com',
  clientSecret: 'server-only-secret',
  redirectUri: 'https://playtrace.test/api/access/google/callback',
};
const nonce = 'n'.repeat(64);
let privateKey: CryptoKey, otherKey: CryptoKey, jwk: object;
let claims: JWTPayload;
let status = 200;
let signingKey: CryptoKey;
let omitIdToken = false;
const calls: { url: string; init?: RequestInit }[] = [];
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'google-key', alg: 'RS256', use: 'sig' };
});
beforeEach(() => {
  calls.length = 0;
  status = 200;
  signingKey = privateKey;
  omitIdToken = false;
  claims = {
    iss: 'https://accounts.google.com',
    aud: config.clientId,
    sub: 'google-owner',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce,
    email: 'Owner@example.com',
    email_verified: true,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === 'https://www.googleapis.com/oauth2/v3/certs')
        return Response.json({ keys: [jwk] });
      if (url !== 'https://oauth2.googleapis.com/token') throw new Error('Unexpected endpoint');
      if (status !== 200)
        return new Response(null, { status, headers: { Location: 'https://attacker.test' } });
      const id_token = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'google-key' })
        .sign(signingKey);
      return Response.json({
        ...(omitIdToken ? {} : { id_token }),
        access_token: 'discard-access',
        refresh_token: 'discard-refresh',
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
describe('Google token exchange with real JWT signature validation', () => {
  it('uses fixed Google endpoints, client secret, exact callback and PKCE; returns only verified identity', async () => {
    expect(await exchangeGoogleCode('one-time-code', 'v'.repeat(64), nonce, config)).toEqual({
      email: 'owner@example.com',
      subject: 'google-owner',
    });
    const tokenRequest = calls[0];
    expect(tokenRequest.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(Object.fromEntries(tokenRequest.init!.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      code: 'one-time-code',
      code_verifier: 'v'.repeat(64),
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    });
    expect(calls.every((c) => !c.url.includes('supabase'))).toBe(true);
  });
  it.each([
    ['issuer', { iss: 'https://attacker.test' }],
    ['audience', { aud: 'other-client' }],
    ['nonce', { nonce: 'different-login' }],
    ['expiration', { exp: 1 }],
    ['unverified email', { email_verified: false }],
    ['untyped verification', { email_verified: 'true' }],
    ['empty subject', { sub: '' }],
    ['missing expiration', { exp: undefined }],
    ['missing nonce', { nonce: undefined }],
    ['future token', { iat: Math.floor(Date.now() / 1000) + 3600 }],
    ['authorized party', { azp: 'another-client' }],
    ['ambiguous audience', { aud: [config.clientId, 'another-client'] }],
  ])('rejects invalid %s', async (_name, override) => {
    Object.assign(claims, override);
    await expect(exchangeGoogleCode('code', 'verifier', nonce, config)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('rejects a token signed by an attacker even with matching identity claims', async () => {
    signingKey = otherKey;
    await expect(exchangeGoogleCode('code', 'verifier', nonce, config)).rejects.toMatchObject({
      status: 401,
    });
  });
  it.each([302, 400, 500])(
    'rejects HTTP %s without following redirects or exposing credentials',
    async (value) => {
      status = value;
      await expect(exchangeGoogleCode('code', 'verifier', nonce, config)).rejects.toMatchObject({
        status: 401,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].init?.redirect).toBe('manual');
    },
  );
  it('requires an ID token, not merely an access token', async () => {
    omitIdToken = true;
    await expect(exchangeGoogleCode('code', 'verifier', nonce, config)).rejects.toMatchObject({
      status: 401,
    });
  });
});
