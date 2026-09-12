import { describe, it, expect } from 'vitest';
import { gameInputSchema, aiResultSchema, type Game } from '../shared/schema';
import { mergeGameUpdate } from '../shared/game-update';
const id = '11111111-1111-4111-a111-111111111111';
const current: Game = {
  ...gameInputSchema.parse({
    title: '哈迪斯2',
    english_title: 'Hades II',
    hours: 0,
    status: '进行中',
    played_years: [2026],
    notes: '保留这段笔记',
    personal_rating: 9,
    is_published: false,
    images: [{ url: 'https://storage.test/existing.jpg', alt: '原封面' }],
  }),
  id,
  version: 3,
};
const draft = () =>
  aiResultSchema.parse({
    target_game_id: id,
    target_version: 3,
    update_fields: ['images'],
    game: {
      title: '错误默认标题',
      hours: null,
      status: '想玩',
      is_published: true,
      images: [{ url: 'https://storage.test/new.jpg', alt: '新图片' }],
    },
    theme: null,
    question: null,
  });
describe('existing-game AI patches', () => {
  it('applies only requested pictures while preserving all play data and visibility', () => {
    const merged = mergeGameUpdate(current, draft());
    expect({ ...merged, images: current.images }).toEqual(gameInputSchema.parse(current));
    expect(merged.images.map((i) => i.url)).toEqual([
      'https://storage.test/existing.jpg',
      'https://storage.test/new.jpg',
    ]);
  });
  it('rejects another game or a stale snapshot', () => {
    expect(() => mergeGameUpdate({ ...current, version: 4 }, draft())).toThrow('已变化');
    expect(() => mergeGameUpdate({ ...current, id: crypto.randomUUID() }, draft())).toThrow(
      '已变化',
    );
  });
  it('updates an explicitly selected subjective field and leaves other fields intact', () => {
    const result = draft();
    result.update_fields = ['hours'];
    result.game!.hours = 42.5;
    expect(mergeGameUpdate(current, result)).toEqual({
      ...gameInputSchema.parse(current),
      hours: 42.5,
    });
  });
  it('rejects an empty image patch and an empty field selection', () => {
    const result = draft();
    result.game!.images = [];
    expect(() => mergeGameUpdate(current, result)).toThrow('未找到');
    result.update_fields = [];
    expect(() => mergeGameUpdate(current, result)).toThrow('没有指定');
  });
  it('retains the old cover and deduplicates already stored image references', () => {
    const result = draft();
    result.game!.images = [...current.images, ...result.game!.images];
    const merged = mergeGameUpdate(current, result);
    expect(merged.images).toHaveLength(2);
    expect(merged.images[0]).toEqual(current.images[0]);
  });
});
