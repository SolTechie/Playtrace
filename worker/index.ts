import {
  AccessError,
  exitManagement,
  resolveManager,
  requireManager,
  requireSameOrigin,
} from './access';
import { googleAuthRoute } from './google-auth';
import { signImages, stableImages } from './media';
import { yearOnly } from '../shared/release-year';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { gameInputSchema, themeInputSchema } from '../shared/schema';

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
async function body(request: Request) {
  const text = await request.text();
  if (text.length > 100000) throw new HttpError(413, '内容过长');
  return JSON.parse(text);
}
function check(error: any) {
  if (error) {
    console.error('Database operation failed', error.code);
    throw new HttpError(500, '数据操作失败，请检查服务配置或稍后重试');
  }
}
function service(env: Env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new HttpError(503, '云端尚未配置');
  return createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname);
      // Reject retired routes before authentication or any database access.
      // This also blocks stale browsers and older bridges with valid credentials.
      if (/^\/api\/(bridge|jobs|agents)(?:\/|$)/.test(path))
        return json(
          {
            code: 'REMOTE_AI_DISABLED',
            error: '网页 AI 任务与电脑连接已停用，请在电脑上主动使用 AI 整理资料。',
          },
          // Older bridges exit on 403; 410 would leave them polling indefinitely.
          /^\/api\/bridge(?:\/|$)/.test(path) ? 403 : 410,
        );
      if (path === '/api/access/verify')
        return json(
          {
            code: 'INVITE_LOGIN_DISABLED',
            error: '数字邀请码已停用，请使用 Google 账号登录并更新 Mac App / CLI。',
          },
          410,
        );
      if (path === '/api/config')
        return json({
          configured: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
          access: 'google',
          remoteAi: false,
        });
      if (path === '/api/health')
        return json({
          ok: true,
          configured: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
        });
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
        throw new HttpError(503, '云端尚未连接，当前为本地浏览预览');
      const db = service(env);
      const authResponse = await googleAuthRoute(request, db, env);
      if (authResponse) return authResponse;
      if (path === '/api/access/exit' && request.method === 'POST')
        return await exitManagement(request, db);
      if (!['GET', 'HEAD'].includes(request.method)) requireSameOrigin(request);
      const manager = await resolveManager(request, db);
      if (path === '/api/me')
        return json({
          admin: !!manager,
          email: manager?.email || null,
          expiresAt: manager?.expiresAt || null,
        });
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
      if (error instanceof SyntaxError || error instanceof URIError)
        return json({ error: '请求格式无效' }, 400);
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Unexpected API error', error instanceof Error ? error.name : 'unknown');
      return json({ error: '服务暂时不可用，请稍后重试' }, 500);
    }
  },
};
