import { createHash } from 'node:crypto';
import type { GameInput } from '../shared/schema';
import { MAX_IMAGE_BYTES, limitedBytes, rasterInfo } from '../shared/image-file';

// The downloader never sends credentials, and rechecks every redirect against these public providers.
const providers = [
  'nintendo.com',
  'nintendo.co.jp',
  'nintendo.net',
  'nintendo-europe.com',
  'steampowered.com',
  'steamstatic.com',
  'steamusercontent.com',
  'wikipedia.org',
  'wikimedia.org',
  'playstation.com',
  'playstation.net',
  'xbox.com',
  'xboxlive.com',
  's-microsoft.com',
  'gog.com',
  'gog-statics.com',
  'epicgames.com',
  'unrealengine.com',
];
export function allowedImageUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      providers.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}
export async function imageFetch(
  value: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  let url = value;
  for (let redirects = 0; redirects < 4; redirects++) {
    if (!allowedImageUrl(url)) throw new Error('Unsupported image provider');
    const response = await fetcher(url, {
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
      headers: {
        Accept: 'image/webp,image/png,image/jpeg,text/html;q=0.8',
        'User-Agent': 'Playtrace/0.1 (game archive image import)',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('Image redirect has no destination');
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Image request failed (${response.status})`);
    }
    return { response, url };
  }
  throw new Error('Too many image redirects');
}
const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:x([a-f0-9]+)|(\d+));/gi, (_, hex, dec) =>
      String.fromCodePoint(Math.min(0x10ffff, parseInt(hex || dec, hex ? 16 : 10))),
    );
export function pageImages(html: string, pageUrl: string) {
  const choices: { url: string; rank: number }[] = [];
  const add = (value: string, rank: number) => {
    try {
      const url = new URL(decode(value).trim(), pageUrl).href;
      if (allowedImageUrl(url) && !/logo|icon|avatar|spacer|pixel|sprite/i.test(url))
        choices.push({ url, rank });
    } catch {}
  };
  for (const match of html.matchAll(/<(meta|img|a)\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3];
    if (
      match[1].toLowerCase() === 'meta' &&
      /^(og:image(?::secure_url)?|twitter:image(?::src)?)$/.test(attrs.property || attrs.name || '')
    )
      add(attrs.content || '', 0);
    else {
      for (const key of ['href', 'data-full', 'data-src', 'data-xl', 'data-lg', 'data-xs', 'src']) {
        const value = attrs[key];
        if (!value || !/\.(jpe?g|png|webp)(?:[?#]|$)/i.test(value)) continue;
        const rank = /screenshot|\/ss_|_ss_|screenshots/i.test(value)
          ? 1
          : /screen_capture|gallery|hero|key.?art|cover|header/i.test(value)
            ? 2
            : /screen|wallpaper|artwork/i.test(value)
              ? 3
              : 5;
        if (rank < 5) add(value, rank);
      }
    }
  }
  // Official galleries often put full-size image URLs in JSON/JS data, not <img src>.
  // Extract string values only; never evaluate page code.
  for (const match of html.matchAll(
    /["'](?:image_url|screenshot_full|path_full)["']\s*:\s*["']([^"']+)["']/g,
  ))
    add(match[1].replace(/\\\//g, '/'), 0.5);
  const identity = (value: string) => {
    const url = new URL(value);
    return (
      url.origin + url.pathname.replace(/_image\d+w(?=\.)|_TM_Standard(?=\.)|\.\d+x\d+(?=\.)/g, '')
    );
  };
  const unique = new Map<string, string>();
  for (const choice of choices.sort((a, b) => a.rank - b.rank))
    if (!unique.has(identity(choice.url))) unique.set(identity(choice.url), choice.url);
  return [...unique.values()].slice(0, 24);
}
export type DownloadedImage = { bytes: Uint8Array; type: string; ext: string; alt: string };
export async function collectGameImages(
  game: GameInput,
  options: {
    upload: (image: DownloadedImage) => Promise<string>;
    progress: (message: string) => void;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  },
): Promise<GameInput['images']> {
  const result: GameInput['images'] = [],
    seen = new Set<string>(),
    hashes = new Set<string>();
  const pending = [...game.images.map((i) => i.url), game.wikipedia_url]
    .filter(Boolean)
    .filter(allowedImageUrl)
    .slice(0, 8);
  const deadline = Date.now() + 90000;
  let requests = 0;
  options.progress('正在查找游戏封面和截图');
  while (pending.length && result.length < 4 && requests < 22 && Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const candidate = pending.shift()!;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    requests++;
    let download: DownloadedImage;
    try {
      const { response, url } = await imageFetch(candidate, options.fetcher, options.signal);
      const html = response.headers.get('content-type')?.includes('text/html');
      const bytes = await limitedBytes(response, html ? 2 * 1024 * 1024 : MAX_IMAGE_BYTES);
      if (html) {
        pending.unshift(...pageImages(new TextDecoder().decode(bytes), url));
        continue;
      }
      const info = rasterInfo(bytes);
      if (!info || info.width < 250 || info.height < 200 || info.width * info.height > 40_000_000)
        continue;
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hashes.has(hash)) continue;
      hashes.add(hash);
      download = {
        bytes,
        type: info.type,
        ext: info.ext,
        alt: `${game.title} · ${result.length ? `游戏截图 ${result.length}` : '封面'}`,
      };
    } catch {
      options.signal?.throwIfAborted();
      continue; // A failed source can be replaced by another; storage failures below must surface.
    }
    options.progress(`正在保存游戏图片（${result.length + 1}/4）`);
    const stored = await options.upload(download);
    result.push({ url: stored, alt: download.alt });
  }
  options.progress(
    result.length
      ? `已保存 ${result.length} 张游戏图片`
      : '暂未找到可保存的图片，可在草稿中手动上传',
  );
  return result;
}
