import { describe, it, expect, vi } from 'vitest';
import { resolveManager, sessionCookie, sessionToken, requireSameOrigin } from '../worker/access';
import worker from '../worker/index';
const url = 'https://playtrace.test/api/access/exit';
describe('Google management session boundary', () => {
  it('rejects cross-site and missing-origin mutations', () => {
    for (const origin of [undefined, 'https://evil.test'])
      expect(() =>
        requireSameOrigin(
          new Request(url, { method: 'POST', headers: origin ? { Origin: origin } : {} }),
        ),
      ).toThrow();
    expect(() =>
      requireSameOrigin(new Request(url, { headers: { Origin: 'https://playtrace.test' } })),
    ).not.toThrow();
    expect(() =>
      requireSameOrigin(
        new Request(url, {
          headers: { Origin: 'https://playtrace.test', 'Sec-Fetch-Site': 'cross-site' },
        }),
      ),
    ).toThrow();
  });
  it('uses secure HttpOnly Strict cookies and rejects old invite tokens before database access', async () => {
    const cookie = sessionCookie(new Request(url), `pg_${'a'.repeat(64)}`, 600);
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(cookie).not.toContain('Domain=');
    const db = { rpc: vi.fn() } as any;
    for (const value of ['admin', `ps_${'a'.repeat(64)}`, `pg_${'x'.repeat(64)}`]) {
      const request = new Request(url, {
        headers: { Cookie: `__Host-playtrace_session=${value}` },
      });
      expect(sessionToken(request)).toBeNull();
      expect(await resolveManager(request, db)).toBeNull();
    }
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('fails closed when session validation is unavailable', async () => {
    const request = new Request(url, {
      headers: { Cookie: `__Host-playtrace_session=pg_${'a'.repeat(64)}` },
    });
    const db = { rpc: vi.fn().mockResolvedValue({ error: { message: 'offline' } }) } as any;
    await expect(resolveManager(request, db)).rejects.toMatchObject({ status: 503 });
    db.rpc.mockResolvedValue({
      data: [{ manager_id: 'owner', email: 'owner@example.com', expires_at: 'expiry' }],
    });
    expect(await resolveManager(request, db)).toEqual({
      id: 'owner',
      email: 'owner@example.com',
      expiresAt: 'expiry',
    });
  });
  it('retires every old invite HTTP method before database access', async () => {
    for (const method of ['GET', 'POST', 'PUT']) {
      const response = await worker.fetch(
        new Request('https://playtrace.test/api/access/verify', { method }),
        {},
      );
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: 'INVITE_LOGIN_DISABLED' });
    }
  });
});
