import { describe, it, expect, vi } from 'vitest';
import { allowedImageUrl, imageFetch, pageImages, collectGameImages } from '../bridge/images';
import { rasterInfo, limitedBytes } from '../shared/image-file';
import { gameInputSchema } from '../shared/schema';
function png(width = 1280, height = 720, variant = 0) {
  const bytes = new Uint8Array(40),
    view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[30] = variant;
  return bytes;
}
describe('AI game images', () => {
  it('restricts public providers and rejects credentials, local addresses and deceptive suffixes', () => {
    for (const url of [
      'http://www.nintendo.com/x.jpg',
      'https://127.0.0.1/x',
      'https://169.254.169.254/x',
      'https://nintendo.com.evil.test/x',
      'https://user:pass@www.nintendo.com/x',
      'https://www.nintendo.com:8443/x',
    ])
      expect(allowedImageUrl(url)).toBe(false);
    expect(allowedImageUrl('https://www.nintendo.com/game')).toBe(true);
    expect(allowedImageUrl('https://cdn.akamai.steamstatic.com/game.jpg')).toBe(true);
  });
  it('rechecks redirect destinations before fetching and sends no authentication', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
      );
    await expect(imageFetch('https://www.nintendo.com/game', fetcher)).rejects.toThrow(
      'Unsupported',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });
  it('extracts cover and large screenshot links, excluding decorations and unrelated links', () => {
    const result = pageImages(
      `<meta content="/cover.jpg?a=1&amp;b=2" property="og:image"><a href="/screenshots/one.jpg">Full screenshot</a><img data-xs="/screenshots/two.png" src="/grey.gif"><img src="/icon.png"><a href="https://evil.test/screenshots/three.jpg">x</a>`,
      'https://www.nintendo.com/game',
    );
    expect(result).toEqual([
      'https://www.nintendo.com/cover.jpg?a=1&b=2',
      'https://www.nintendo.com/screenshots/one.jpg',
      'https://www.nintendo.com/screenshots/two.png',
    ]);
  });
  it('uses full-size gallery data and deduplicates resized covers', () => {
    const result = pageImages(
      `<meta property="og:image" content="/cover_image1280w.jpg"><meta property="og:image:secure_url" content="/cover.jpg"><img src="/screenshots/one_TM_Standard.jpg"><script>items.push({'image_url':'https://www.nintendo.com/screenshots/one.jpg'});</script>`,
      'https://www.nintendo.com/game',
    );
    expect(result).toEqual([
      'https://www.nintendo.com/cover_image1280w.jpg',
      'https://www.nintendo.com/screenshots/one.jpg',
    ]);
  });
  it('rejects SVG/HTML as raster and reads actual raster dimensions', () => {
    expect(rasterInfo(new TextEncoder().encode('<svg onload="bad"/>'))).toBeNull();
    expect(rasterInfo(png())).toMatchObject({ type: 'image/png', width: 1280, height: 720 });
  });
  it('bounds chunked downloads even without content-length', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.enqueue(new Uint8Array(4));
          controller.close();
        },
      }),
    );
    await expect(limitedBytes(response, 6)).rejects.toThrow('size limit');
  });
  it('saves extracted images before returning, deduplicating bytes and dropping tiny assets', async () => {
    const game = gameInputSchema.parse({
      title: 'Test',
      images: [{ url: 'https://www.nintendo.com/game', alt: '' }],
      sources: [{ url: 'https://example.test' }],
    });
    expect(game).not.toHaveProperty('sources');
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/game'))
        return new Response(
          '<meta property="og:image" content="/cover.png"><img src="/screenshots/duplicate.png"><img src="/screenshots/tiny.png"><img src="/screenshots/other.png">',
          { headers: { 'content-type': 'text/html' } },
        );
      return new Response(
        png(url.includes('tiny') ? 20 : 1280, 720, url.includes('other') ? 1 : 0),
        { headers: { 'content-type': 'image/png' } },
      );
    }) as typeof fetch;
    const upload = vi.fn(async () => `https://own.supabase.co/image/${Math.random()}`);
    const result = await collectGameImages(game, { fetcher, upload, progress: vi.fn() });
    expect(result).toHaveLength(2);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(result.every((i) => i.url.startsWith('https://own.supabase.co/'))).toBe(true);
  });
  it('surfaces storage errors instead of claiming an external image was saved', async () => {
    const game = gameInputSchema.parse({
      title: 'Test',
      images: [{ url: 'https://www.nintendo.com/cover.png', alt: '' }],
    });
    await expect(
      collectGameImages(game, {
        fetcher: vi.fn().mockResolvedValue(new Response(png())),
        progress: vi.fn(),
        upload: vi.fn().mockRejectedValue(new Error('Storage unavailable')),
      }),
    ).rejects.toThrow('Storage unavailable');
  });
});
