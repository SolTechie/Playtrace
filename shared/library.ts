import { z } from 'zod';
import { sortGames, statuses, type Game } from './schema';
export const librarySearchSchema = z
  .object({
    q: z.string().max(200).optional(),
    status: z.enum(statuses).optional(),
    platform: z.string().max(80).optional(),
    year: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    tag: z.string().max(80).optional(),
    developer: z.string().max(200).optional(),
    sort: z.enum(['recent', 'hours', 'title', 'rating']).optional(),
  })
  .strict();
export function searchLibrary(games: Game[], params: URLSearchParams) {
  const q = (params.get('q') || '').toLowerCase();
  return sortGames(
    games.filter(
      (g) =>
        (!q ||
          `${g.title} ${g.english_title} ${g.japanese_title} ${g.developer}`
            .toLowerCase()
            .includes(q)) &&
        (!params.get('status') || g.status === params.get('status')) &&
        (!params.get('platform') || g.platform === params.get('platform')) &&
        (!params.get('year') || g.played_years.includes(Number(params.get('year')))) &&
        (!params.get('tag') || g.tags.includes(params.get('tag')!)) &&
        (!params.get('developer') || g.developer === params.get('developer')),
    ),
    params.get('sort') || 'recent',
  );
}
