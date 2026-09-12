import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
  throw new Error('请在 .env.local 中设置 Supabase 地址和服务端密钥。');
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const check = (error) => {
  if (error) throw new Error(error.message);
};
const games = JSON.parse(await readFile('data/games.json', 'utf8'));
async function importGame(game) {
  const { data: existing, error: lookupError } = await db
    .from('games')
    .select('id')
    .eq('id', game.id)
    .maybeSingle();
  check(lookupError);
  if (existing) return 'skipped';
  const images = [];
  for (const image of game.images) {
    const filename = path.basename(image.url),
      storagePath = `import/${game.id}/${filename}`;
    const content = await readFile(path.join('public', image.url));
    const contentType = filename.endsWith('.webp')
      ? 'image/webp'
      : filename.endsWith('.png')
        ? 'image/png'
        : 'image/jpeg';
    const { error } = await db.storage
      .from('game-images')
      .upload(storagePath, content, { contentType, upsert: true });
    check(error);
    // Stable references are signed by the Worker after record-level authorization.
    images.push({
      ...image,
      url: db.storage.from('game-images').getPublicUrl(storagePath).data.publicUrl,
    });
  }
  const { id, version, is_published, ...data } = game;
  const { error } = await db
    .from('games')
    .insert({ id, version, is_published, data: { ...data, images } });
  check(error);
  return 'added';
}
let cursor = 0,
  added = 0,
  skipped = 0;
const failures = [];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (cursor < games.length) {
      const game = games[cursor++];
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const result = await importGame(game);
          result === 'added' ? added++ : skipped++;
          console.log(`已处理 ${added + skipped}/${games.length}：${game.title}`);
          break;
        } catch (error) {
          if (attempt === 3) {
            failures.push(game.title);
            console.error(`导入失败：${game.title} (${error.message})`);
          } else await sleep(1000 * 2 ** attempt);
        }
      }
    }
  }),
);
const themes = JSON.parse(await readFile('shared/default-themes.json', 'utf8'));
for (const theme of themes) {
  const { id, is_published, version, ...data } = theme;
  const { error } = await db
    .from('themes')
    .upsert({ id, is_published, version, data }, { onConflict: 'id', ignoreDuplicates: true });
  check(error);
}
console.log(`完成：新增 ${added}，已存在 ${skipped}，失败 ${failures.length}。未覆盖已有编辑。`);
if (failures.length) process.exitCode = 1;
