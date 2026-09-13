import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('retired local bridge entry points', () => {
  for (const args of [['--import', 'tsx', 'bridge/index.ts'], ['scripts/setup-bridge.mjs']]) {
    it(`exits without credentials or starting Codex: ${args.at(-1)}`, () => {
      const result = spawnSync(process.execPath, args, {
        encoding: 'utf8',
        timeout: 5000,
        env: { PATH: process.env.PATH },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('网页 AI 任务与本机自动连接已停用');
      expect(result.stdout).toBe('');
    });
  }
});
