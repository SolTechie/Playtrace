import { afterEach, describe, expect, it, vi } from 'vitest';

const reply = () =>
  Promise.resolve({ status: 200, body: Buffer.from('{"ok":true}').toString('base64') });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('bundled desktop API transport', () => {
  it('uses the native bridge and never falls back to a browser network request', async () => {
    vi.stubEnv('MODE', 'desktop');
    const postMessage = vi.fn(reply),
      fetch = vi.fn();
    vi.stubGlobal('window', { webkit: { messageHandlers: { playtrace: { postMessage } } } });
    vi.stubGlobal('fetch', fetch);
    const { apiFetch } = await import('../src/lib/transport');
    const response = await apiFetch('/games', { method: 'POST', body: '{"title":"test"}' });
    expect(await response.json()).toEqual({ ok: true });
    const payload = postMessage.mock.calls[0][0];
    expect(payload).toMatchObject({
      path: '/games',
      method: 'POST',
      contentType: 'application/json',
    });
    expect(Buffer.from(payload.body, 'base64').toString()).toBe('{"title":"test"}');
    expect(fetch).not.toHaveBeenCalled();
    expect(response.headers.has('set-cookie')).toBe(false);
  });
  it('serializes an uploaded file and its actual multipart boundary together', async () => {
    vi.stubEnv('MODE', 'desktop');
    const postMessage = vi.fn(reply);
    vi.stubGlobal('window', { webkit: { messageHandlers: { playtrace: { postMessage } } } });
    const { apiFetch } = await import('../src/lib/transport');
    const form = new FormData();
    form.append('file', new Blob(['image-content'], { type: 'image/png' }), 'cover.png');
    await apiFetch('/upload', { method: 'POST', body: form });
    const payload = postMessage.mock.calls[0][0];
    const boundary = payload.contentType.split('boundary=')[1];
    const body = Buffer.from(payload.body, 'base64').toString();
    expect(boundary).toBeTruthy();
    expect(body).toContain(`--${boundary}`);
    expect(body).toContain('name="file"; filename="cover.png"');
    expect(body).toContain('Content-Type: image/png');
    expect(body).toContain('image-content');
  });
  it('fails closed when the native bridge is absent', async () => {
    vi.stubEnv('MODE', 'desktop');
    const fetch = vi.fn();
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', fetch);
    const { apiFetch } = await import('../src/lib/transport');
    await expect(apiFetch('/games')).rejects.toThrow('桌面连接不可用');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves API errors without exposing native response headers', async () => {
    vi.stubEnv('MODE', 'desktop');
    const postMessage = vi.fn(async () => ({
      status: 409,
      body: Buffer.from('{"error":"版本冲突"}').toString('base64'),
    }));
    vi.stubGlobal('window', { webkit: { messageHandlers: { playtrace: { postMessage } } } });
    const { apiFetch } = await import('../src/lib/transport');
    const response = await apiFetch('/games/example');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: '版本冲突' });
  });
  it('keeps the mobile website on same-origin HTTP, even with a spoofed bridge', async () => {
    vi.stubEnv('MODE', 'production');
    const postMessage = vi.fn(reply),
      fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('window', { webkit: { messageHandlers: { playtrace: { postMessage } } } });
    vi.stubGlobal('fetch', fetch);
    const { apiFetch } = await import('../src/lib/transport');
    await apiFetch('/me');
    expect(fetch).toHaveBeenCalledWith('/api/me', { credentials: 'same-origin' });
    expect(postMessage).not.toHaveBeenCalled();
  });
});
