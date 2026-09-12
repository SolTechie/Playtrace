import { mkdir, writeFile } from 'node:fs/promises';
import { runCodex } from '../bridge/codex';
const result = await runCodex({
  kind: 'game',
  prompt: '添加《空洞骑士》（Hollow Knight，2017 年原版），Steam 上玩了 40 小时，2026 年通关。',
  context: [],
  onProgress: (message) => console.log(message),
  timeoutMs: 300000,
});
await mkdir('.bridge', { recursive: true });
await writeFile('.bridge/smoke-result.json', JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    title: result.game?.title,
    imageCandidates: result.game?.images.length,
    hours: result.game?.hours,
    years: result.game?.played_years,
    status: result.game?.status,
    question: result.question,
  }),
);
