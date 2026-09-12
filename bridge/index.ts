import { setTimeout as sleep } from 'node:timers/promises';
import { findCodex, runCodex } from './codex';
import { collectGameImages } from './images';
import type { Job } from '../shared/schema';

const base = process.env.GAME_API_URL?.replace(/\/$/, ''),
  token = process.env.GAME_DEVICE_TOKEN;
if (!base || !token) {
  console.error('请复制 .env.bridge.example 为 .env.bridge，并填入网站地址和设备密钥。');
  process.exit(1);
}
const target = new URL(base);
if (target.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(target.hostname)) {
  console.error('云端地址必须使用 HTTPS。');
  process.exit(1);
}
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request<T>(
  route: string,
  body?: unknown,
  method = body ? 'POST' : 'GET',
): Promise<T> {
  const response = await fetch(`${base}/api/bridge${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = (await response.json()) as any;
  if (!response.ok) throw new ApiError(response.status, data.error || '连接失败');
  return data;
}
let stopping = false;
let active: AbortController | null = null;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stopping = true;
    active?.abort();
  });
const bin = await findCodex();
console.log(`Playtrace 连接服务已启动。网站：${base}`);
while (!stopping) {
  try {
    const { job } = await request<{ job: Job | null }>('/claim', {});
    if (!job) {
      await sleep(Math.max(2000, Number(process.env.BRIDGE_POLL_MS) || 4000));
      continue;
    }
    console.log(`开始 ${job.kind === 'game' ? '游戏资料' : '主题'}任务 ${job.id}`);
    const controller = new AbortController();
    active = controller;
    let updates = Promise.resolve();
    let lastMessage = '';
    let lastSuccess = Date.now();
    const update = async (values: unknown) => {
      await request(
        `/jobs/${job.id}`,
        { lease_token: job.lease_token, ...(values as object) },
        'PATCH',
      );
      lastSuccess = Date.now();
    };
    const report = (message: string) => {
      if (message === lastMessage) return;
      lastMessage = message;
      console.log(message);
      updates = updates
        .then(() => update({ progress: message }))
        .catch((e) => {
          if (e instanceof ApiError && [401, 403, 409].includes(e.status)) controller.abort();
        });
    };
    const heartbeat = setInterval(() => {
      void update({}).catch((e) => {
        if (
          (e instanceof ApiError && [401, 403, 409].includes(e.status)) ||
          Date.now() - lastSuccess > 90000
        )
          controller.abort();
      });
    }, 20000);
    try {
      const context = await request<{ games: unknown[] }>('/context');
      const result = await runCodex({
        kind: job.kind,
        prompt: job.prompt,
        context: context.games,
        targetGameId: job.target_game_id,
        onProgress: report,
        signal: controller.signal,
        timeoutMs: Number(process.env.BRIDGE_TIMEOUT_MS) || 900000,
        bin,
      });
      if (
        job.kind === 'game' &&
        result.game &&
        !result.question &&
        (!result.target_game_id || result.update_fields.includes('images'))
      ) {
        result.game.images = await collectGameImages(result.game, {
          progress: report,
          signal: controller.signal,
          upload: async (image) => {
            const response = await fetch(`${base}/api/bridge/jobs/${job.id}/images`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': image.type,
                'X-Playtrace-Lease': job.lease_token!,
              },
              body: new Blob([new Uint8Array(image.bytes)], { type: image.type }),
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
            });
            const data = (await response.json()) as { url?: string; error?: string };
            if (!response.ok || !data.url)
              throw new ApiError(response.status, data.error || '图片保存失败，请重试');
            return data.url;
          },
        });
      }
      await updates;
      await update({ result });
      console.log(result.question ? '等待用户补充信息' : '草稿已回传到网页');
    } catch (e) {
      const message = e instanceof Error ? e.message : '任务执行失败';
      console.error(message);
      try {
        await updates;
        await update({ error: message });
      } catch {
        /* Lease expires if the server cannot be reached. */
      }
    } finally {
      clearInterval(heartbeat);
      active = null;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : '连接失败');
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      console.error('请在网页重新创建设备连接密钥。');
      process.exitCode = 1;
      break;
    }
    if (!stopping) await sleep(10000);
  }
}
console.log('Playtrace 连接服务已停止。');
