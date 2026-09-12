import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
let db: PGlite;
const owner = '11111111-1111-4111-a111-111111111111',
  other = '22222222-2222-4222-a222-222222222222';
const device = '33333333-3333-4333-a333-333333333333',
  job = '44444444-4444-4444-a444-444444444444';
const as = async (role: string, user = '') =>
  db.exec(
    `reset role; set role ${role}; select set_config('request.jwt.claim.sub','${user}',false);`,
  );
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid,bucket_id text);alter table storage.objects enable row level security;
 insert into auth.users values('${owner}'),('${other}');`);
  const migration = await readFile('supabase/migrations/202609110001_initial.sql', 'utf8');
  // PGlite tests PostgreSQL data policies/transactions. Realtime publications require hosted Supabase.
  await db.exec(migration.slice(0, migration.lastIndexOf('do $$ begin')));
  await db.exec(`grant all on all tables in schema public to service_role;grant usage on all sequences in schema public to service_role;
 insert into public.admin_users values('${owner}');
 insert into public.games(data,is_published) values(' {"title":"Public game"}',true),('{"title":"Private game"}',false);
 insert into public.agent_devices(id,owner_id,name,token_hash) values('${device}','${owner}','computer','hash');
 insert into public.ai_jobs(id,owner_id,request_id,kind,prompt) values('${job}','${owner}',gen_random_uuid(),'game','Add a game');`);
});
afterAll(async () => {
  await db?.close();
});
describe.sequential('Supabase authorization and durable tasks', () => {
  it('visitors can read only published records, never AI jobs or credentials', async () => {
    await as('anon');
    const games = await db.query<{ data: { title: string } }>('select data from public.games');
    expect(games.rows.map((r) => r.data.title)).toEqual(['Public game']);
    await expect(db.query('select * from public.ai_jobs')).rejects.toThrow();
    await expect(db.query('select * from public.agent_devices')).rejects.toThrow();
    await expect(
      db.query('insert into public.games(data) values(\'{"title":"x"}\')'),
    ).rejects.toThrow();
  });
  it('ordinary signed-in users do not become admins', async () => {
    await as('authenticated', other);
    expect(
      (await db.query<{ is_admin: boolean }>('select public.is_admin()')).rows[0].is_admin,
    ).toBe(false);
    expect((await db.query('select * from public.games')).rows).toHaveLength(1);
    expect((await db.query('select * from public.ai_jobs')).rows).toHaveLength(0);
    await expect(
      db.query('insert into public.games(data) values(\'{"title":"x"}\')'),
    ).rejects.toThrow();
    await expect(db.query(`select public.claim_ai_job('${device}')`)).rejects.toThrow();
  });
  it('the owner can edit records and see private ones, but cannot read device tokens directly', async () => {
    await as('authenticated', owner);
    expect((await db.query('select * from public.games')).rows).toHaveLength(2);
    await db.query('insert into public.games(data,is_published) values(\'{"title":"New"}\',false)');
    await expect(db.query('select * from public.agent_devices')).rejects.toThrow();
  });
  it('claims a task once within its lease window', async () => {
    await as('service_role');
    const first = await db.query<{ id: string; lease_token: string; attempts: number }>(
      `select * from public.claim_ai_job('${device}')`,
    );
    expect(first.rows[0].id).toBe(job);
    expect(first.rows[0].attempts).toBe(1);
    expect(first.rows[0].lease_token).toBeTruthy();
    expect((await db.query(`select * from public.claim_ai_job('${device}')`)).rows).toHaveLength(0);
  });
  it('recovers expired tasks and rejects stale lease results', async () => {
    await as('service_role');
    const old = await db.query<{ lease_token: string }>(
      `select lease_token from public.ai_jobs where id='${job}'`,
    );
    await db.query(
      `update public.ai_jobs set lease_until=now()-interval '1 minute' where id='${job}'`,
    );
    const next = await db.query<{ lease_token: string; attempts: number }>(
      `select * from public.claim_ai_job('${device}')`,
    );
    expect(next.rows[0].attempts).toBe(2);
    expect(next.rows[0].lease_token).not.toBe(old.rows[0].lease_token);
    const stale = await db.query(
      `update public.ai_jobs set status='ready' where id='${job}' and lease_token='${old.rows[0].lease_token}' returning id`,
    );
    expect(stale.rows).toHaveLength(0);
  });
  it('atomically saves a draft once even if the browser repeats the save request', async () => {
    await as('service_role');
    await db.query(`update public.ai_jobs set status='ready' where id='${job}'`);
    await as('authenticated', owner);
    const first = await db.query<{ save_ai_draft: string }>(
      `select public.save_ai_draft('${job}','{"title":"AI game"}',true)`,
    );
    const second = await db.query<{ save_ai_draft: string }>(
      `select public.save_ai_draft('${job}','{"title":"Duplicate"}',true)`,
    );
    expect(second.rows[0]).toEqual(first.rows[0]);
    expect(
      (await db.query("select * from public.games where data->>'title'='AI game'")).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.games where data->>'title'='Duplicate'")).rows,
    ).toHaveLength(0);
  });
  it('prevents another user from saving the owner’s task', async () => {
    await as('authenticated', other);
    await expect(
      db.query(`select public.save_ai_draft('${job}','{"title":"Intrusion"}',true)`),
    ).rejects.toThrow();
  });
  it('hides soft-deleted games from visitors', async () => {
    await as('authenticated', owner);
    await db.query("update public.games set deleted_at=now() where data->>'title'='Public game'");
    await as('anon');
    expect(
      (await db.query("select * from public.games where data->>'title'='Public game'")).rows,
    ).toHaveLength(0);
  });
});
