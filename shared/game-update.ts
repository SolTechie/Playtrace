import { gameInputSchema, type Game, type AIResult, type GameInput } from './schema';
export class GameUpdateError extends Error {}
export function mergeGameUpdate(current: Game, result: AIResult): GameInput {
  if (
    !result.game ||
    result.target_game_id !== current.id ||
    result.target_version !== current.version
  )
    throw new GameUpdateError('原游戏已变化，请重新生成补全草稿');
  const fields = [...new Set(result.update_fields)];
  if (!fields.length) throw new GameUpdateError('没有指定要补全的内容');
  const merged = gameInputSchema.parse(current);
  for (const field of fields) {
    if (field === 'images') {
      if (!result.game.images.length && fields.length === 1)
        throw new GameUpdateError('暂未找到可补充的图片，原游戏未改动，请重试');
      const images = [...current.images, ...result.game.images];
      merged.images = [...new Map(images.map((image) => [image.url, image])).values()].slice(0, 12);
    } else {
      Object.assign(merged, { [field]: result.game[field] });
    }
  }
  return gameInputSchema.parse(merged);
}
