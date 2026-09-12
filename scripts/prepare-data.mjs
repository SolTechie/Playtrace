import { readdir, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = process.cwd();
const folders = await readdir(path.join(root, 'resource'), { withFileTypes: true });
const games = [];
await mkdir(path.join(root, 'public/game-images'), { recursive: true });
await mkdir(path.join(root, 'data'), { recursive: true });
await mkdir(path.join(root, 'public/dev-data'), { recursive: true });
for (const folder of folders.filter((x) => x.isDirectory())) {
  const dir = path.join(root, 'resource', folder.name);
  const text = await readFile(path.join(dir, 'data.md'), 'utf8');
  const fields = Object.fromEntries(
    [...text.matchAll(/^- ([^：]+)：(.*)$/gm)].map((x) => [x[1], x[2].trim()]),
  );
  const hash = createHash('sha256').update(folder.name).digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const filenames = (await readdir(dir))
    .filter((x) => /^image_\d+\.(jpg|jpeg|png|webp)$/i.test(x))
    .sort();
  await mkdir(path.join(root, 'public/game-images', id), { recursive: true });
  for (const filename of filenames)
    await copyFile(path.join(dir, filename), path.join(root, 'public/game-images', id, filename));
  const hours = Number(fields['游玩时长（小时）']);
  const mc = [...(fields['Metacritic 评分'] || '').matchAll(/([^;:]+):\s*(\d+)\/100/g)].map(
    (x) => ({ platform: x[1].trim(), score: Number(x[2]) }),
  );
  games.push({
    id,
    title: fields['中文名称'] || folder.name,
    english_title: fields['英文名称'] || '',
    japanese_title: fields['日文名称'] || '',
    developer: fields['开发商'] || '',
    tags: (fields['游戏类型'] || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    status: fields['游玩状态'] || '进行中',
    played_years: [...new Set((fields['游玩年份'] || '').match(/\d{4}/g)?.map(Number) || [])].sort(
      (a, b) => b - a,
    ),
    hours: fields['游玩时长（小时）'] && Number.isFinite(hours) && hours >= 0 ? hours : null,
    release_year: Number(fields['游戏发布年份']) || null,
    release_date: null,
    platform: fields['游玩平台'] || '',
    mc_scores: mc,
    wikipedia_url: fields['Wikipedia 英文链接'] || '',
    images: filenames.map((filename, i) => ({
      url: `/game-images/${id}/${filename}`,
      alt: `${fields['中文名称'] || folder.name} · 图片 ${i + 1}`,
    })),
    sources: [],
    notes: '',
    personal_rating: null,
    series: '',
    is_published: true,
    version: 1,
  });
}
games.sort(
  (a, b) =>
    Math.max(...b.played_years) - Math.max(...a.played_years) ||
    a.title.localeCompare(b.title, 'zh-CN'),
);
await writeFile(path.join(root, 'data/games.json'), JSON.stringify(games, null, 2) + '\n');
await writeFile(path.join(root, 'public/dev-data/games.json'), JSON.stringify(games) + '\n');
console.log(
  `Prepared ${games.length} games and ${games.reduce((n, g) => n + g.images.length, 0)} images. Original files preserved.`,
);
