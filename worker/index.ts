import {
  AccessError,
  verifyInvite,
  exitManagement,
  resolveManager,
  requireManager,
  requireSameOrigin,
} from './access';
import { signImages, stableImages, storagePath } from './media';
import { MAX_IMAGE_BYTES, limitedBytes, rasterInfo } from '../shared/image-file';
import { mergeGameUpdate, GameUpdateError } from '../shared/game-update';
import { yearOnly } from '../shared/release-year';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  aiResultSchema,
  gameInputSchema,
  gameUpdateFields,
  jobCreateSchema,
  themeInputSchema,
} from '../shared/schema';

type Env = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
const entity = (row: any): any => {
  const { sources: _legacySources, ...data } = row.data;
  return { ...yearOnly(data), id: row.id, version: row.version, is_published: row.is_published };
};
async function presentJobs(rows: any[], db: SupabaseClient, url: string) {
  const games = rows
    .filter((r) => r.result?.game)
    .map((r) => gameInputSchema.parse(yearOnly(r.result.game)));
  const signed = await signImages(games, db, url);
  let index = 0;
  return rows.map((row) =>
    row.result?.game ? { ...row, result: { ...row.result, game: signed[index++] } } : row,
  );
}
async function body(request: Request) {
  const text = await request.text();
  if (text.length > 100000) throw new HttpError(413, '内容过长');
  return JSON.parse(text);
}
async function digest(token: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
function check(error: any) {
  if (error) {
    console.error('Database operation failed', error.code);
    throw new HttpError(500, '数据操作失败，请检查服务配置或稍后重试');
  }
}
function service(env: Env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new HttpError(503, 'AI 服务尚未配置');
  return createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
async function ownedJob(db: SupabaseClient, id: string, owner: string) {
  const { data, error } = await db
    .from('ai_jobs')
    .select('*')
    .eq('id', id)
    .eq('owner_id', owner)
    .maybeSingle();
  check(error);
  if (!data) throw new HttpError(404, '任务不存在');
  return data;
}
async function bridge(request: Request, env: Env, path: string) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (!token.startsWith('pt_') || token.length > 200) throw new HttpError(401, '设备凭证无效');
  const db = service(env);
  const { data: device, error } = await db
    .from('agent_devices')
    .select('id,owner_id')
    .eq('token_hash', await digest(token))
    .is('revoked_at', null)
    .maybeSingle();
  check(error);
  if (!device) throw new HttpError(401, '设备凭证无效或已撤销');
  const { data: owner } = await db
    .from('archive_managers')
    .select('id')
    .eq('id', device.owner_id)
    .maybeSingle();
  if (!owner) throw new HttpError(403, '设备没有管理权限');
  await db
    .from('agent_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id);
  if (path === '/api/bridge/claim' && request.method === 'POST') {
    const { data, error } = await db.rpc('claim_ai_job', { p_device_id: device.id });
    check(error);
    return json({ job: data?.[0] || null });
  }
  if (path === '/api/bridge/context' && request.method === 'GET') {
    const { data, error } = await db
      .from('games')
      .select('id,data,version,is_published')
      .is('deleted_at', null)
      .limit(1000);
    check(error);
    return json({
      games: (data || []).map((r) => ({
        id: r.id,
        version: r.version,
        english_title: r.data.english_title,
        images_count: r.data.images?.length || 0,
        missing_fields: gameUpdateFields.filter(
          (field) =>
            r.data[field] == null ||
            r.data[field] === '' ||
            (Array.isArray(r.data[field]) && !r.data[field].length),
        ),
        title: r.data.title,
        developer: r.data.developer,
        tags: r.data.tags,
        platform: r.data.platform,
        series: r.data.series,
        status: r.data.status,
        played_years: r.data.played_years,
        hours: r.data.hours,
      })),
    });
  }
  const uploadJobId = path.match(/^\/api\/bridge\/jobs\/([\w-]+)\/images$/)?.[1];
  if (uploadJobId && request.method === 'POST') {
    const lease = z.uuid().parse(request.headers.get('X-Playtrace-Lease'));
    const job = await ownedJob(db, uploadJobId, device.owner_id);
    if (
      job.kind !== 'game' ||
      job.status !== 'running' ||
      job.device_id !== device.id ||
      job.lease_token !== lease ||
      Date.parse(job.lease_until) <= Date.now()
    )
      throw new HttpError(409, '任务已取消或由其他设备接手');
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await limitedBytes(
        new Response(request.body, { headers: request.headers }),
        MAX_IMAGE_BYTES,
      );
    } catch {
      throw new HttpError(413, '图片超过 8 MB 或内容为空');
    }
    const info = rasterInfo(bytes);
    if (!info || info.width < 250 || info.height < 200 || info.width * info.height > 40_000_000)
      throw new HttpError(400, '请选择有效的游戏封面或截图');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    const name = `${device.owner_id}/ai/${uploadJobId}/${hash}.${info.ext}`;
    const { error } = await db.storage
      .from('game-images')
      .upload(name, bytes, { contentType: info.type, upsert: true });
    check(error);
    return json({ url: `${env.SUPABASE_URL}/storage/v1/object/public/game-images/${name}` }, 201);
  }
  const match = path.match(/^\/api\/bridge\/jobs\/([\w-]+)$/);
  if (match && request.method === 'PATCH') {
    const input = z
      .object({
        lease_token: z.uuid(),
        progress: z.string().max(500).optional(),
        result: aiResultSchema.optional(),
        error: z.string().max(1000).optional(),
      })
      .parse(await body(request));
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      updated_at: now,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    };
    if (input.progress) updates.progress = input.progress;
    if (input.result) {
      const job = await ownedJob(db, match[1], device.owner_id);
      if (!input.result.question && !(job.kind === 'game' ? input.result.game : input.result.theme))
        throw new HttpError(422, 'AI 返回的结果类型不正确');
      if (!input.result.question) {
        if (
          job.kind === 'theme' &&
          (input.result.target_game_id ||
            input.result.target_version ||
            input.result.update_fields.length)
        )
          throw new HttpError(422, '主题任务不能修改游戏');
        if (job.target_game_id && input.result.target_game_id !== job.target_game_id)
          throw new HttpError(422, 'AI 结果没有对应指定的原游戏，请重新尝试');
        if (
          !input.result.target_game_id &&
          (input.result.target_version || input.result.update_fields.length)
        )
          throw new HttpError(422, '请明确要更新哪条游戏记录');
      }
      if (input.result.game && !input.result.question) {
        if (input.result.target_game_id && !input.result.update_fields.includes('images'))
          input.result.game.images = [];
        if (input.result.game.images.some((image) => !storagePath(image.url, env.SUPABASE_URL!)))
          throw new HttpError(422, '请先将 AI 图片保存到游戏图片库');
        input.result.game = stableImages(input.result.game, env.SUPABASE_URL!);
        if (input.result.target_game_id) {
          const { data: target, error: targetError } = await db
            .from('games')
            .select('*')
            .eq('id', input.result.target_game_id)
            .is('deleted_at', null)
            .maybeSingle();
          check(targetError);
          if (!target) throw new HttpError(409, '原游戏已移除，请重新选择');
          try {
            input.result.game = mergeGameUpdate(
              { ...gameInputSchema.parse(entity(target)), id: target.id, version: target.version },
              input.result,
            );
          } catch (error) {
            if (error instanceof GameUpdateError) throw new HttpError(409, error.message);
            throw error;
          }
          updates.target_game_id = target.id;
          updates.target_version = target.version;
        }
      }
      updates.result = input.result;
      updates.status = input.result.question ? 'needs_input' : 'ready';
      updates.progress = input.result.question
        ? '需要补充信息'
        : input.result.target_game_id
          ? '补全草稿已准备好，确认后更新原游戏'
          : input.result.game
            ? input.result.game.images.length
              ? `资料和 ${input.result.game.images.length} 张图片已整理好，等待保存`
              : '资料已整理好，暂未找到可保存的图片，可手动上传'
            : '主题已整理好，等待保存';
      updates.lease_until = null;
    }
    if (input.error) {
      updates.status = 'failed';
      updates.error = input.error;
      updates.progress = '任务未完成';
      updates.lease_until = null;
    }
    const { data, error } = await db
      .from('ai_jobs')
      .update(updates)
      .eq('id', match[1])
      .eq('device_id', device.id)
      .eq('lease_token', input.lease_token)
      .eq('status', 'running')
      .select('id')
      .maybeSingle();
    check(error);
    if (!data) throw new HttpError(409, '任务已取消或由其他设备接手');
    if (input.progress || input.result || input.error)
      await db.from('ai_job_events').insert({ job_id: match[1], message: updates.progress });
    return json({ ok: true });
  }
  throw new HttpError(404, '接口不存在');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/api/config')
        return json({
          configured: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
          access: 'invite',
        });
      if (path === '/api/health')
        return json({
          ok: true,
          configured: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
        });
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
        throw new HttpError(503, '云端尚未连接，当前为本地浏览预览');
      if (path.startsWith('/api/bridge/')) return await bridge(request, env, path);
      const db = service(env);
      if (path === '/api/access/verify' && request.method === 'POST')
        return await verifyInvite(request, db);
      if (path === '/api/access/exit' && request.method === 'POST')
        return await exitManagement(request, db);
      if (!['GET', 'HEAD'].includes(request.method)) requireSameOrigin(request);
      const manager = await resolveManager(request, db);
      if (path === '/api/me')
        return json({ admin: !!manager, expiresAt: manager?.expiresAt || null });
      const resource = path.match(/^\/api\/(games|themes)(?:\/([\w-]+))?$/);
      if (resource) {
        const [, table, id] = resource;
        if (request.method === 'GET') {
          let q = db.from(table).select('*').is('deleted_at', null);
          if (!manager) q = q.eq('is_published', true);
          if (id) {
            const { data, error } = await q.eq('id', id).maybeSingle();
            check(error);
            if (!data) throw new HttpError(404, '内容不存在');
            return json(
              table === 'games'
                ? (await signImages([entity(data)], service(env), env.SUPABASE_URL))[0]
                : entity(data),
            );
          }
          const { data, error } = await q.order('created_at', { ascending: false }).limit(1000);
          check(error);
          const records = (data || []).map(entity);
          return json(
            table === 'games' ? await signImages(records, service(env), env.SUPABASE_URL) : records,
          );
        }
        requireManager(manager);
        if (request.method === 'DELETE' && id) {
          const version = Number(url.searchParams.get('version'));
          if (!Number.isInteger(version) || version < 1)
            throw new HttpError(400, '缺少记录版本，请刷新后重试');
          const { data, error } = await db
            .from(table)
            .update({ deleted_at: new Date().toISOString(), version: version + 1 })
            .eq('id', id)
            .eq('version', version)
            .is('deleted_at', null)
            .select('id')
            .maybeSingle();
          check(error);
          if (!data) throw new HttpError(409, '记录已变化，请刷新后重试');
          return json({ ok: true });
        }
        if ((request.method === 'POST' && !id) || (request.method === 'PUT' && id)) {
          const raw = await body(request);
          const parsed = (table === 'games' ? gameInputSchema : themeInputSchema).parse(
            table === 'games' ? yearOnly(raw) : raw,
          );
          const { is_published, ...data } = parsed;
          const values = {
            data: table === 'games' ? stableImages(data, env.SUPABASE_URL) : data,
            is_published,
            updated_at: new Date().toISOString(),
          };
          if (id) {
            const version = z.number().int().positive().parse(raw.version);
            const { data: row, error } = await db
              .from(table)
              .update({ ...values, version: version + 1 })
              .eq('id', id)
              .eq('version', version)
              .is('deleted_at', null)
              .select('*')
              .maybeSingle();
            check(error);
            if (!row) throw new HttpError(409, '这条记录已在其他位置修改，请刷新后再编辑');
            return json(entity(row));
          }
          const { data: row, error } = await db.from(table).insert(values).select('*').single();
          check(error);
          return json(entity(row), 201);
        }
        throw new HttpError(405, '不支持的操作');
      }
      const user = requireManager(manager);
      if (path === '/api/upload' && request.method === 'POST') {
        const form = await request.formData();
        const file = form.get('file');
        if (
          !(file instanceof File) ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
          file.size > 10 * 1024 * 1024
        )
          throw new HttpError(400, '请选择 10 MB 以下的 JPG、PNG 或 WebP 图片');
        const ext = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1];
        const name = `${user.id}/${crypto.randomUUID()}.${ext}`;
        const { error } = await db.storage
          .from('game-images')
          .upload(name, file, { contentType: file.type, upsert: false });
        check(error);
        const { data: signed, error: signError } = await service(env)
          .storage.from('game-images')
          .createSignedUrl(name, 900);
        check(signError);
        return json({ url: signed!.signedUrl });
      }
      const srv = service(env);
      if (path === '/api/agents') {
        if (request.method === 'GET') {
          const { data, error } = await srv
            .from('agent_devices')
            .select('id,name,last_seen_at,created_at')
            .eq('owner_id', user.id)
            .is('revoked_at', null);
          check(error);
          return json(data || []);
        }
        if (request.method === 'POST') {
          const { name } = z
            .object({ name: z.string().trim().min(1).max(80) })
            .parse(await body(request));
          const token = `pt_${crypto.randomUUID()}${crypto.randomUUID()}`;
          const { data, error } = await srv
            .from('agent_devices')
            .insert({ owner_id: user.id, name, token_hash: await digest(token) })
            .select('id,name')
            .single();
          check(error);
          return json({ ...data, token }, 201);
        }
      }
      const agentId = path.match(/^\/api\/agents\/([\w-]+)$/)?.[1];
      if (agentId && request.method === 'DELETE') {
        const { error } = await srv
          .from('agent_devices')
          .update({ revoked_at: new Date().toISOString() })
          .eq('id', agentId)
          .eq('owner_id', user.id);
        check(error);
        return json({ ok: true });
      }
      if (path === '/api/jobs') {
        if (request.method === 'GET') {
          const { data, error } = await db
            .from('ai_jobs')
            .select(
              'id,kind,prompt,status,progress,result,error,created_at,updated_at,attempts,target_game_id,target_version',
            )
            .eq('owner_id', user.id)
            .order('created_at', { ascending: false })
            .limit(30);
          check(error);
          return json(await presentJobs(data || [], db, env.SUPABASE_URL));
        }
        if (request.method === 'POST') {
          const input = jobCreateSchema.parse(await body(request));
          if (input.kind !== 'game' && input.target_game_id)
            throw new HttpError(400, '主题任务不能指定游戏修改目标');
          const { data: old } = await srv
            .from('ai_jobs')
            .select('*')
            .eq('owner_id', user.id)
            .eq('request_id', input.request_id)
            .maybeSingle();
          if (old) return json(old);
          const { count, error: countError } = await srv
            .from('ai_jobs')
            .select('id', { count: 'exact', head: true })
            .eq('owner_id', user.id)
            .in('status', ['queued', 'running']);
          check(countError);
          if ((count || 0) >= 5) throw new HttpError(429, '已有 5 个任务等待处理，请稍后再添加');
          let targetVersion: number | null = null;
          if (input.target_game_id) {
            const { data: target, error: targetError } = await srv
              .from('games')
              .select('version')
              .eq('id', input.target_game_id)
              .is('deleted_at', null)
              .maybeSingle();
            check(targetError);
            if (!target) throw new HttpError(404, '要补全的游戏不存在');
            targetVersion = target.version;
          }
          const { data, error } = await srv
            .from('ai_jobs')
            .insert({ ...input, owner_id: user.id, target_version: targetVersion })
            .select('*')
            .single();
          if (error?.code === '23505') {
            const { data: existing, error: readError } = await srv
              .from('ai_jobs')
              .select('*')
              .eq('owner_id', user.id)
              .eq('request_id', input.request_id)
              .single();
            check(readError);
            return json(existing);
          }
          check(error);
          return json(data, 201);
        }
      }
      const jobPath = path.match(/^\/api\/jobs\/([\w-]+)(?:\/(events|cancel|retry|answer|save))?$/);
      if (jobPath) {
        const [, id, action] = jobPath;
        const job = await ownedJob(db, id, user.id);
        if (!action && request.method === 'GET')
          return json((await presentJobs([job], db, env.SUPABASE_URL))[0]);
        if (action === 'events' && request.method === 'GET') {
          const { data, error } = await db
            .from('ai_job_events')
            .select('id,message,created_at')
            .eq('job_id', id)
            .order('id', { ascending: true })
            .limit(200);
          check(error);
          return json(data || []);
        }
        if (request.method === 'POST') {
          if (action === 'save') {
            const raw = await body(request);
            const parsed = (job.kind === 'game' ? gameInputSchema : themeInputSchema).parse(
              job.kind === 'game' ? yearOnly(raw) : raw,
            );
            const { is_published, ...data } = parsed;
            const { data: entityId, error } = await db.rpc('save_ai_draft', {
              p_manager_id: user.id,
              p_job_id: id,
              p_data: job.kind === 'game' ? stableImages(data, env.SUPABASE_URL) : data,
              p_published: is_published,
            });
            if (error?.code === 'PT409' || error?.code === '40001')
              throw new HttpError(409, '原游戏已被修改或移除，请重新生成补全草稿');
            check(error);
            return json({ id: entityId, kind: job.kind });
          }
          let update: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
            lease_token: null,
            lease_until: null,
          };
          if (
            action === 'cancel' &&
            ['queued', 'running', 'needs_input', 'ready'].includes(job.status)
          )
            update = { ...update, status: 'cancelled', progress: '任务已取消' };
          else if (
            action === 'retry' &&
            (['failed', 'cancelled'].includes(job.status) ||
              (job.status === 'ready' && job.target_game_id))
          )
            update = {
              ...update,
              status: 'queued',
              progress: '等待电脑领取任务',
              attempts: 0,
              error: null,
              result: null,
            };
          else if (action === 'answer' && job.status === 'needs_input') {
            const { answer } = z
              .object({ answer: z.string().trim().min(1).max(1500) })
              .parse(await body(request));
            const prompt = `${job.prompt}\n\nAI 询问：${job.result?.question || ''}\n用户补充：${answer}`;
            if (prompt.length > 4000) throw new HttpError(400, '对话过长，请重新提交简短指令');
            update = {
              ...update,
              prompt,
              status: 'queued',
              progress: '已收到补充，等待电脑继续',
              result: null,
              error: null,
              attempts: 0,
            };
          } else throw new HttpError(409, '任务状态已变化，请刷新后重试');
          const { data, error } = await srv
            .from('ai_jobs')
            .update(update)
            .eq('id', id)
            .eq('owner_id', user.id)
            .eq('status', job.status)
            .select('*')
            .maybeSingle();
          check(error);
          if (!data) throw new HttpError(409, '任务状态已变化，请刷新后重试');
          return json(data);
        }
      }
      throw new HttpError(404, '接口不存在');
    } catch (error) {
      if (error instanceof AccessError) {
        const response = json({ error: error.message }, error.status);
        if (error.retryAfter) response.headers.set('Retry-After', String(error.retryAfter));
        return response;
      }
      if (error instanceof z.ZodError)
        return json(
          {
            error: error.issues
              .map((i) => i.message)
              .slice(0, 3)
              .join('；'),
          },
          400,
        );
      if (error instanceof SyntaxError) return json({ error: '请求格式无效' }, 400);
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Unexpected API error', error instanceof Error ? error.name : 'unknown');
      return json({ error: '服务暂时不可用，请稍后重试' }, 500);
    }
  },
};
