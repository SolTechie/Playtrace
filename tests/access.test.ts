import { describe, it, expect, vi } from 'vitest';
import { pbkdf2Sync } from 'node:crypto';
import {
  deriveInviteHash,
  verifyInvite,
  resolveManager,
  sessionCookie,
  sessionToken,
  requireSameOrigin,
} from '../worker/access';
const url = 'https://playtrace.test/api/access/verify';
const req = (body: unknown, origin = 'https://playtrace.test') =>
  new Request(url, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.1',
    },
    body: JSON.stringify(body),
  });
const salt = 'a'.repeat(32);
const hash = pbkdf2Sync('012345678901', Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString(
  'hex',
);
function fakeDatabase(
  rpc: ReturnType<typeof vi.fn>,
  candidates: unknown[] = [{ salt, code_hash: hash }],
) {
  const query: any = {};
  for (const method of ['select', 'is', 'not', 'or']) query[method] = () => query;
  query.limit = async () => ({ data: candidates, error: null });
  return { rpc, from: vi.fn(() => query) } as any;
}
describe('invite HTTP boundary', () => {
  it('matches PBKDF2 and produces distinct verifiers for different salts', async () => {
    expect(await deriveInviteHash('012345678901', salt)).toBe(hash);
    expect(await deriveInviteHash('012345678901', 'b'.repeat(32))).not.toBe(hash);
  });
  it('rejects cross-site and missing-origin mutations', () => {
    expect(() => requireSameOrigin(req({}, 'https://attacker.test'))).toThrow();
    expect(() => requireSameOrigin(new Request(url, { method: 'POST' }))).toThrow();
    expect(() => requireSameOrigin(req({}))).not.toThrow();
  });
  it('uses a host-only HttpOnly secure strict cookie and rejects invented session formats', () => {
    const token = `ps_${'a'.repeat(64)}`;
    const cookie = sessionCookie(req({}), token, 600);
    expect(cookie).toContain('__Host-playtrace_session=');
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(cookie).not.toContain('Domain=');
    expect(
      sessionToken(new Request(url, { headers: { Cookie: '__Host-playtrace_session=admin' } })),
    ).toBeNull();
  });
  it('does not perform a code lookup when the client is rate limited', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [{ allowed: false, retry_after: 900 }], error: null });
    await expect(
      verifyInvite(req({ code: '012345678901' }), fakeDatabase(rpc)),
    ).rejects.toMatchObject({ status: 429, retryAfter: 900 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('192.0.2.1');
  });
  it('preserves leading zeros and returns no invite or session token in JSON', async () => {
    const rpc = vi.fn().mockImplementation((name) =>
      Promise.resolve({
        data:
          name === 'consume_invite_attempt'
            ? [{ allowed: true }]
            : [{ manager_id: 'owner', expires_at: new Date(Date.now() + 600000).toISOString() }],
        error: null,
      }),
    );
    const response = await verifyInvite(
      req({ code: '012345678901' }),

      fakeDatabase(rpc),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    const text = await response.text();
    expect(text).not.toContain('012345678901');
    expect(text).not.toContain('ps_');
    expect(rpc.mock.calls[1][1].p_session_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects malformed input and unknown codes', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ allowed: true }], error: null });
    await expect(
      verifyInvite(req({ code: 123456789012 }), fakeDatabase(rpc)),
    ).rejects.toMatchObject({ status: 400 });
    rpc.mockImplementation((name) =>
      Promise.resolve({
        data: name === 'consume_invite_attempt' ? [{ allowed: true }] : [],
        error: null,
      }),
    );
    await expect(
      verifyInvite(req({ code: '012345678901' }), fakeDatabase(rpc)),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rejects oversized bodies before querying invite hashes', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ allowed: true }], error: null });
    const db = fakeDatabase(rpc);
    await expect(verifyInvite(req({ code: '1'.repeat(500) }), db)).rejects.toMatchObject({
      status: 400,
    });
    expect(db.from).not.toHaveBeenCalled();
  });
  it('never redeems a code that fails the slow verifier', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ allowed: true }], error: null });
    await expect(
      verifyInvite(req({ code: '999999999999' }), fakeDatabase(rpc)),
    ).rejects.toMatchObject({ status: 401 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('fails closed if session verification cannot reach the database', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'offline' } });
    const request = new Request(url, {
      headers: { Cookie: `__Host-playtrace_session=ps_${'a'.repeat(64)}` },
    });
    await expect(resolveManager(request, fakeDatabase(rpc))).rejects.toMatchObject({ status: 503 });
    expect(await resolveManager(new Request(url), fakeDatabase(rpc))).toBeNull();
  });
});
