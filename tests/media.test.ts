import { expect, it } from 'vitest';
import { storagePath, stableImages } from '../worker/media';
const origin = 'https://example.supabase.co';
it('normalizes expiring image links before persisting edits', () => {
  const data = {
    images: [
      {
        url: `${origin}/storage/v1/object/sign/game-images/import/a/image_1.jpg?token=temporary`,
        alt: 'cover',
      },
    ],
  };
  expect(stableImages(data, origin).images[0].url).toBe(
    `${origin}/storage/v1/object/public/game-images/import/a/image_1.jpg`,
  );
  expect(storagePath(data.images[0].url, origin)).toBe('import/a/image_1.jpg');
});
it('never signs arbitrary external images with project credentials', () => {
  expect(
    storagePath('https://elsewhere.test/storage/v1/object/public/game-images/a.jpg', origin),
  ).toBeNull();
  expect(storagePath(`${origin}/storage/v1/object/public/other-bucket/a.jpg`, origin)).toBeNull();
});
