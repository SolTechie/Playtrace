import { z } from 'zod';

export const statuses = ['进行中', '完成', '暂停', '中断', '想玩'] as const;
const text = (max = 200) => z.string().trim().max(max);
const httpUrl = z
  .string()
  .max(2000)
  .refine((v) => !v || /^https?:\/\//i.test(v), '请输入 http 或 https 链接');
const imageUrl = z
  .string()
  .max(2000)
  .refine(
    (v) =>
      /^https:\/\//i.test(v) ||
      /^\/game-images\/[a-z0-9-]+\/image_\d+\.(jpg|jpeg|png|webp)$/i.test(v),
    '图片链接无效',
  );
export const gameInputSchema = z.object({
  title: text().min(1, '请输入游戏名称'),
  english_title: text().default(''),
  japanese_title: text().default(''),
  developer: text().default(''),
  tags: z.array(text(80)).max(30).default([]),
  status: z.enum(statuses).default('想玩'),
  played_years: z.array(z.number().int().min(1970).max(2200)).max(100).default([]),
  hours: z.number().min(0).max(100000).nullable().default(null),
  release_year: z.number().int().min(1950).max(2200).nullable().default(null),
  release_date: z.iso.date().nullable().default(null),
  platform: text(80).default(''),
  mc_scores: z
    .array(z.object({ platform: text(40).min(1), score: z.number().int().min(0).max(100) }))
    .max(30)
    .default([]),
  wikipedia_url: httpUrl.default(''),
  images: z
    .array(z.object({ url: imageUrl, alt: text(300) }))
    .max(12)
    .default([]),
  notes: text(10000).default(''),
  personal_rating: z.number().min(0).max(10).nullable().default(null),
  series: text().default(''),
  is_published: z.boolean().default(true),
});
export type GameInput = z.infer<typeof gameInputSchema>;
export type Game = GameInput & { id: string; version: number };
export const themeInputSchema = z.object({
  title: text(100).min(1),
  description: text(1000).default(''),
  filters: z
    .object({
      title_keywords: z.array(text(100)).default([]),
      tags: z.array(text(80)).default([]),
      platforms: z.array(text(80)).default([]),
      statuses: z.array(z.enum(statuses)).default([]),
      years: z.array(z.number().int()).default([]),
      developers: z.array(text()).default([]),
      series: z.array(text()).default([]),
    })
    .default({
      title_keywords: [],
      tags: [],
      platforms: [],
      statuses: [],
      years: [],
      developers: [],
      series: [],
    }),
  layout: z.enum(['gallery', 'timeline']).default('gallery'),
  chart: z.enum(['platform', 'genre', 'year', 'developer']).default('platform'),
  sort: z.enum(['recent', 'hours', 'title', 'rating']).default('recent'),
  is_published: z.boolean().default(true),
});
export type ThemeInput = z.infer<typeof themeInputSchema>;
export type Theme = ThemeInput & { id: string; version: number };
export const jobCreateSchema = z.object({
  kind: z.enum(['game', 'theme']),
  prompt: text(4000).min(2),
  request_id: z.uuid(),
});
export const aiResultSchema = z.object({
  game: gameInputSchema.nullable(),
  theme: themeInputSchema.nullable(),
  question: text(1000).nullable(),
});
export type AIResult = z.infer<typeof aiResultSchema>;
export type Job = {
  id: string;
  kind: 'game' | 'theme';
  prompt: string;
  status: 'queued' | 'running' | 'needs_input' | 'ready' | 'saved' | 'failed' | 'cancelled';
  progress: string;
  result: AIResult | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  attempts: number;
  lease_token?: string;
};

export function filterGames(games: Game[], filters: ThemeInput['filters']) {
  return games.filter(
    (g) =>
      (!filters.title_keywords.length ||
        filters.title_keywords.some((k) =>
          `${g.title} ${g.english_title}`.toLowerCase().includes(k.toLowerCase()),
        )) &&
      (!filters.tags.length || filters.tags.some((t) => g.tags.includes(t))) &&
      (!filters.platforms.length || filters.platforms.includes(g.platform)) &&
      (!filters.statuses.length || filters.statuses.includes(g.status)) &&
      (!filters.years.length || filters.years.some((y) => g.played_years.includes(y))) &&
      (!filters.developers.length || filters.developers.includes(g.developer)) &&
      (!filters.series.length || filters.series.includes(g.series)),
  );
}
export function sortGames(games: Game[], sort: string) {
  return [...games].sort((a, b) =>
    sort === 'hours'
      ? (b.hours ?? -1) - (a.hours ?? -1)
      : sort === 'title'
        ? a.title.localeCompare(b.title, 'zh-CN')
        : sort === 'rating'
          ? (b.personal_rating ?? -1) - (a.personal_rating ?? -1)
          : Math.max(0, ...b.played_years) - Math.max(0, ...a.played_years) ||
            a.title.localeCompare(b.title, 'zh-CN'),
  );
}
export function summarize(games: Game[]) {
  const recorded = games.filter((g) => g.hours !== null);
  return {
    count: games.length,
    completed: games.filter((g) => g.status === '完成').length,
    playing: games.filter((g) => g.status === '进行中').length,
    hours: Math.round(recorded.reduce((n, g) => n + (g.hours ?? 0), 0) * 10) / 10,
    recorded: recorded.length,
  };
}
export function groupGames(games: Game[], by: ThemeInput['chart']) {
  const groups = new Map<string, number>();
  for (const g of games) {
    const keys =
      by === 'year'
        ? g.played_years.map(String)
        : by === 'genre'
          ? g.tags
          : [by === 'platform' ? g.platform : g.developer];
    for (const key of new Set(keys.filter(Boolean))) groups.set(key, (groups.get(key) || 0) + 1);
  }
  return [...groups.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => (by === 'year' ? Number(a.label) - Number(b.label) : b.value - a.value));
}
