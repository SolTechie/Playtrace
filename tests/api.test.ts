import { describe, it, expect, vi } from 'vitest';
import worker from '../worker/index';
describe('public API boundaries', () => {
  it('exposes only public setup values, never service credentials', async () => {
    const response = await worker.fetch(new Request('https://playtrace.test/api/config'), {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'public',
      SUPABASE_SERVICE_ROLE_KEY: 'private-secret',
    });
    const data = await response.text();
    expect(data).not.toContain('private-secret');
    expect(JSON.parse(data).configured).toBe(true);
  });
  it('does not pretend mutations succeeded before Supabase is connected', async () => {
    const response = await worker.fetch(
      new Request('https://playtrace.test/api/games', {
        method: 'POST',
        body: JSON.stringify({ title: 'New game' }),
      }),
      {},
    );
    expect(response.status).toBe(503);
  });
  it('keeps the configured public endpoint read-only without sign-in', async () => {
    const response = await worker.fetch(new Request('https://playtrace.test/api/me'), {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'public',
      SUPABASE_SERVICE_ROLE_KEY: 'server',
    });
    expect(await response.json()).toEqual({ admin: false, expiresAt: null });
  });
  it('rejects every retired AI route before credentials or database access', async () => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected request'));
    const routes: [string, string, number][] = [
      ['POST', '/api/jobs', 410],
      ['GET', '/api/jobs', 410],
      ['GET', '/api/jobs/old-job', 410],
      ['GET', '/api/jobs/old-job/events', 410],
      ['POST', '/api/jobs/old-job/retry', 410],
      ['POST', '/api/jobs/old-job/answer', 410],
      ['POST', '/api/jobs/old-job/cancel', 410],
      ['POST', '/api/jobs/old-job/save', 410],
      ['POST', '/api/jobs/?old-client=true', 410],
      ['POST', '/api/%6aobs', 410],
      ['GET', '/api/agents', 410],
      ['POST', '/api/agents', 410],
      ['DELETE', '/api/agents/old-device', 410],
      ['POST', '/api/bridge/claim', 403],
      ['GET', '/api/bridge/context', 403],
      ['PATCH', '/api/bridge/jobs/old-job', 403],
      ['POST', '/api/bridge/jobs/old-job/images', 403],
      ['POST', '/api/bridge%2fclaim', 403],
    ];
    try {
      for (const configured of [false, true]) {
        for (const [method, path, status] of routes) {
          const response = await worker.fetch(
            new Request(`https://playtrace.test${path}`, {
              method,
              headers: {
                Origin: 'https://playtrace.test',
                Authorization: `Bearer pt_${'1'.repeat(72)}`,
                Cookie: `__Host-playtrace_session=ps_${'1'.repeat(64)}`,
              },
            }),
            configured
              ? { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server' }
              : {},
          );
          expect(response.status, `${method} ${path}`).toBe(status);
          expect(await response.json()).toMatchObject({ code: 'REMOTE_AI_DISABLED' });
        }
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
  it('advertises that remote AI is disabled without exposing credentials', async () => {
    const response = await worker.fetch(new Request('https://playtrace.test/api/config'), {});
    expect(await response.json()).toEqual({ configured: false, access: 'invite', remoteAi: false });
  });
});
