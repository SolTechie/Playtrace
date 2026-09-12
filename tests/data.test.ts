import { describe, expect, it } from 'vitest';
import {
  filterGames,
  gameInputSchema,
  groupGames,
  sortGames,
  summarize,
  themeInputSchema,
  type Game,
} from '../shared/schema';
import { cleanEnvironment, eventProgress } from '../bridge/codex';
const sample = (id: string, values: Record<string, unknown>): Game => ({
  ...gameInputSchema.parse({ title: '示例游戏', ...values }),
  id,
  version: 1,
});
const games = [
  sample('a', {
    title: '旅程 第一章',
    developer: 'Studio',
    hours: 10,
    played_years: [2025, 2026],
    platform: 'PC',
    status: '完成',
  }),
  sample('b', {
    title: '旅程 第二章',
    hours: 0,
    platform: 'Steam',
    status: '完成',
    played_years: [2026],
  }),
  sample('c', {
    title: '另一款游戏',
    developer: 'Studio',
    hours: null,
    platform: 'Switch',
    status: '进行中',
  }),
];
describe('game records and aggregation', () => {
  it('keeps cross-year hours as a single cumulative record', () => {
    expect(summarize([games[0]]).hours).toBe(10);
    expect(groupGames([games[0]], 'year')).toEqual([
      { label: '2025', value: 1 },
      { label: '2026', value: 1 },
    ]);
  });
  it('counts only known hours and distinguishes zero from missing', () => {
    expect(summarize(games)).toMatchObject({ hours: 10, recorded: 2, count: 3 });
  });
  it('matches series titles without including unrelated games by the same studio', () => {
    const filters = themeInputSchema.parse({
      title: '旅程',
      filters: { title_keywords: ['旅程'] },
    }).filters;
    expect(filterGames(games, filters).map((g) => g.id)).toEqual(['a', 'b']);
  });
  it('combines filter groups with AND, values within each group with OR', () => {
    const f = themeInputSchema.parse({
      title: 'filter',
      filters: { statuses: ['完成'], platforms: ['Steam', 'PC'], years: [2026] },
    }).filters;
    expect(filterGames(games, f).map((g) => g.id)).toEqual(['a', 'b']);
  });
  it('sorts known hours ahead of missing without changing original order', () => {
    const copy = [...games];
    expect(sortGames(games, 'hours').map((g) => g.hours)).toEqual([10, 0, null]);
    expect(games).toEqual(copy);
  });
});
describe('untrusted AI results and user edits', () => {
  it('rejects negative hours and invalid critic scores', () => {
    expect(gameInputSchema.safeParse({ ...games[0], hours: -1 }).success).toBe(false);
    expect(
      gameInputSchema.safeParse({ ...games[0], mc_scores: [{ platform: 'PC', score: 101 }] })
        .success,
    ).toBe(false);
  });
  it('rejects executable links and unsupported theme instructions', () => {
    expect(
      gameInputSchema.safeParse({ ...games[0], wikipedia_url: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(
      gameInputSchema.safeParse({ ...games[0], images: [{ url: 'data:text/html,test', alt: 'x' }] })
        .success,
    ).toBe(false);
    expect(themeInputSchema.safeParse({ title: 'x', layout: 'execute_sql' }).success).toBe(false);
  });
  it('never forwards app, database, or device secrets to the Codex child process', () => {
    const env = cleanEnvironment({
      HOME: '/home/user',
      PATH: '/bin',
      GAME_DEVICE_TOKEN: 'secret',
      SUPABASE_SERVICE_ROLE_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });
    expect(env).toEqual({ HOME: '/home/user', PATH: '/bin' });
  });
  it('reports actual tool events without exposing reasoning content', () => {
    expect(
      eventProgress({ type: 'item.completed', item: { type: 'reasoning', text: 'private' } }),
    ).toBeNull();
    expect(eventProgress({ type: 'item.started', item: { type: 'web_search' } })).toContain('搜索');
  });
});
