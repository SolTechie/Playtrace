import type { SupabaseClient } from '@supabase/supabase-js';

// Persist stable object references; signed URLs only exist in API responses.
export function storagePath(imageUrl: string, supabaseUrl: string): string | null {
  try {
    const url = new URL(imageUrl);
    if (url.origin !== new URL(supabaseUrl).origin) return null;
    const match = url.pathname.match(/^\/storage\/v1\/object\/(public|sign)\/game-images\/(.+)$/);
    if (!match) return null;
    return decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}
export function stableImages<T extends object>(data: T, url: string): T {
  const record = data as T & { images?: { url: string; alt: string }[] };
  if (!record.images) return data;
  return {
    ...data,
    images: record.images.map((image) => {
      const path = storagePath(image.url, url);
      return path
        ? {
            ...image,
            url: `${url}/storage/v1/object/public/game-images/${path.split('/').map(encodeURIComponent).join('/')}`,
          }
        : image;
    }),
  };
}
export async function signImages<T extends { images?: { url: string; alt: string }[] }>(
  records: T[],
  db: SupabaseClient,
  url: string,
): Promise<T[]> {
  const paths = [
    ...new Set(
      records.flatMap((r) =>
        (r.images || []).map((i) => storagePath(i.url, url)).filter((p): p is string => !!p),
      ),
    ),
  ];
  if (!paths.length) return records;
  const { data, error } = await db.storage.from('game-images').createSignedUrls(paths, 900);
  if (error) throw new Error('Image signing failed');
  const signed = new Map((data || []).map((i) => [i.path, i.signedUrl]));
  return records.map((r) => ({
    ...r,
    images: (r.images || []).map((i) => ({
      ...i,
      url: signed.get(storagePath(i.url, url) || '') || i.url,
    })),
  }));
}
