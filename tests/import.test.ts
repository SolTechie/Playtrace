import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { gameInputSchema } from '../shared/schema';
// The real archive is deliberately not distributed with the public source code.
it.skipIf(!existsSync('data/games.json'))(
  'validates the optional local archive without embedding it in the app',
  () => {
    const seed = JSON.parse(readFileSync('data/games.json', 'utf8'));
    expect(seed.length).toBeGreaterThan(0);
    expect(new Set(seed.map((g: any) => g.id)).size).toBe(seed.length);
    for (const raw of seed) {
      const game = gameInputSchema.parse(raw);
      for (const image of game.images) expect(existsSync(`public${image.url}`)).toBe(true);
    }
  },
);
