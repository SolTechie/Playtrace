import { describe, it, expect } from 'vitest';
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
  it('rejects malformed device credentials before any database query', async () => {
    const response = await worker.fetch(
      new Request('https://playtrace.test/api/bridge/claim', {
        method: 'POST',
        headers: { Authorization: 'Bearer bad' },
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'public',
        SUPABASE_SERVICE_ROLE_KEY: 'server',
      },
    );
    expect(response.status).toBe(401);
  });
});
