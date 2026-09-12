import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
let db: PGlite;
const owner = '11111111-1111-4111-a111-111111111111',
  other = '22222222-2222-4222-a222-222222222222';
const device = '33333333-3333-4333-a333-333333333333',
  job = '44444444-4444-4444-a444-444444444444';
const invitation = '55555555-5555-4555-a555-555555555555',
  code = '1'.repeat(64),
  session = '2'.repeat(64);
const as = async (role: string, user = '') =>
  db.exec(
    `reset role;set role ${role};select set_config('request.jwt.claim.sub','${user}',false);`,
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
  const initial = await readFile('supabase/migrations/202609110001_initial.sql', 'utf8');
  await db.exec(initial.slice(0, initial.lastIndexOf('do $$ begin')));
  await db.exec(`insert into public.admin_users values('${owner}');
 insert into public.games(data,is_published) values('{"title":"Public"}',true),('{"title":"Private"}',false);
 insert into public.agent_devices(id,owner_id,name,token_hash) values('${device}','${owner}','computer','hash');
 insert into public.ai_jobs(id,owner_id,request_id,kind,prompt) values('${job}','${owner}',gen_random_uuid(),'game','Add a game');`);
  await db.exec(await readFile('supabase/migrations/202609110002_invite_access.sql', 'utf8'));
  await db.exec(await readFile('supabase/migrations/202609110003_salted_invites.sql', 'utf8'));
  await db.exec(await readFile('supabase/migrations/202609110004_update_game_drafts.sql', 'utf8'));
  await db.exec(
    await readFile('supabase/migrations/202609110005_draft_conflict_status.sql', 'utf8'),
  );
  await db.exec(
    `insert into public.archive_managers(id) values('${other}');insert into public.management_invites(id,manager_id,label,code_hash) values('${invitation}','${owner}','test','${code}');`,
  );
});
afterAll(async () => {
  await db?.close();
});
describe.sequential('invite access and durable AI jobs', () => {
  it('keeps published games available while all credentials and jobs remain private', async () => {
    await as('anon');
    expect((await db.query('select * from public.games')).rows).toHaveLength(1);
    for (const table of [
      'management_invites',
      'management_sessions',
      'invite_attempts',
      'archive_managers',
      'ai_jobs',
      'agent_devices',
    ])
      await expect(db.query(`select * from public.${table}`)).rejects.toThrow();
  });
  it('removes every legacy account route to elevated access', async () => {
    await as('authenticated', owner);
    expect((await db.query('select * from public.games')).rows).toHaveLength(1);
    await expect(
      db.query('insert into public.games(data) values(\'{"title":"x"}\')'),
    ).rejects.toThrow();
    await expect(db.query('select * from public.ai_jobs')).rejects.toThrow();
    await expect(
      db.query(`select * from public.redeem_management_invite('${code}','${session}')`),
    ).rejects.toThrow();
    await expect(
      db.query(`select public.save_ai_draft('${owner}','${job}','{"title":"x"}',true)`),
    ).rejects.toThrow();
  });
  it('preserves games and migrates task/device ownership without creating Auth users', async () => {
    await as('service_role');
    expect((await db.query('select * from public.games')).rows).toHaveLength(2);
    expect(
      (await db.query(`select id from public.archive_managers where id='${owner}'`)).rows,
    ).toHaveLength(1);
    expect(
      (await db.query(`select owner_id from public.agent_devices where id='${device}'`)).rows[0],
    ).toEqual({ owner_id: owner });
  });
  it('atomically limits attempts and resets only after the full window', async () => {
    await as('service_role');
    for (let i = 0; i < 10; i++)
      expect(
        (
          await db.query<{ allowed: boolean }>(
            "select * from public.consume_invite_attempt('client-a')",
          )
        ).rows[0].allowed,
      ).toBe(true);
    const blocked = (
      await db.query<{ allowed: boolean; retry_after: number }>(
        "select * from public.consume_invite_attempt('client-a')",
      )
    ).rows[0];
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_after).toBeGreaterThan(800);
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "select * from public.consume_invite_attempt('client-b')",
        )
      ).rows[0].allowed,
    ).toBe(true);
    await db.query(
      "update public.invite_attempts set window_started_at=now()-interval '16 minutes' where client_hash='client-a'",
    );
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "select * from public.consume_invite_attempt('client-a')",
        )
      ).rows[0].allowed,
    ).toBe(true);
  });
  it('issues a bounded session only for a valid invite digest', async () => {
    await as('service_role');
    expect(
      (
        await db.query(
          `select * from public.redeem_management_invite('${'9'.repeat(64)}','${session}')`,
        )
      ).rows,
    ).toHaveLength(0);
    const result = await db.query<{ manager_id: string; expires_at: Date }>(
      `select * from public.redeem_management_invite('${code}','${session}')`,
    );
    expect(result.rows[0].manager_id).toBe(owner);
    const row = (
      await db.query<{ token_hash: string }>(
        `select token_hash from public.management_sessions where token_hash='${session}'`,
      )
    ).rows[0];
    expect(row.token_hash).toBe(session);
    expect(
      (await db.query(`select * from public.resolve_management_session('${session}')`)).rows,
    ).toHaveLength(1);
  });
  it('rejects expired and revoked invites and invalidates existing sessions immediately', async () => {
    await as('service_role');
    await db.query(
      `update public.management_invites set revoked_at=now() where id='${invitation}'`,
    );
    expect(
      (await db.query(`select * from public.resolve_management_session('${session}')`)).rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query(
          `select * from public.redeem_management_invite('${code}','${'3'.repeat(64)}')`,
        )
      ).rows,
    ).toHaveLength(0);
    await db.query(
      `update public.management_invites set revoked_at=null,expires_at=now()-interval '1 minute' where id='${invitation}'`,
    );
    expect(
      (
        await db.query(
          `select * from public.redeem_management_invite('${code}','${'3'.repeat(64)}')`,
        )
      ).rows,
    ).toHaveLength(0);
    await db.query(`update public.management_invites set expires_at=null where id='${invitation}'`);
  });
  it('rejects expired sessions and makes logout revocation effective', async () => {
    await as('service_role');
    await db.query(
      `update public.management_sessions set expires_at=now()-interval '1 minute' where token_hash='${session}'`,
    );
    expect(
      (await db.query(`select * from public.resolve_management_session('${session}')`)).rows,
    ).toHaveLength(0);
    await db.query(`delete from public.management_sessions where token_hash='${session}'`);
    expect(
      (await db.query(`select * from public.resolve_management_session('${session}')`)).rows,
    ).toHaveLength(0);
  });
  it('claims a task only once and rejects stale lease writes after recovery', async () => {
    await as('service_role');
    const first = (
      await db.query<{ id: string; lease_token: string }>(
        `select * from public.claim_ai_job('${device}')`,
      )
    ).rows[0];
    expect(first.id).toBe(job);
    expect((await db.query(`select * from public.claim_ai_job('${device}')`)).rows).toHaveLength(0);
    await db.query(
      `update public.ai_jobs set lease_until=now()-interval '1 minute' where id='${job}'`,
    );
    const next = (
      await db.query<{ lease_token: string }>(`select * from public.claim_ai_job('${device}')`)
    ).rows[0];
    expect(next.lease_token).not.toBe(first.lease_token);
    expect(
      (
        await db.query(
          `update public.ai_jobs set status='ready' where id='${job}' and lease_token='${first.lease_token}' returning id`,
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('checks draft ownership and atomically saves repeated requests only once', async () => {
    await as('service_role');
    await db.query(`update public.ai_jobs set status='ready' where id='${job}'`);
    await expect(
      db.query(`select public.save_ai_draft('${other}','${job}','{"title":"Intrusion"}',true)`),
    ).rejects.toThrow();
    const first = await db.query(
      `select public.save_ai_draft('${owner}','${job}','{"title":"AI game"}',true)`,
    );
    const second = await db.query(
      `select public.save_ai_draft('${owner}','${job}','{"title":"Duplicate"}',true)`,
    );
    expect(second.rows[0]).toEqual(first.rows[0]);
    expect(
      (await db.query("select * from public.games where data->>'title'='AI game'")).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.games where data->>'title'='Duplicate'")).rows,
    ).toHaveLength(0);
  });
  it('updates the original game once without creating a duplicate', async () => {
    await as('service_role');
    const gameId = crypto.randomUUID(),
      updateJob = crypto.randomUUID();
    await db.query(
      `insert into public.games(id,data,is_published) values($1,'{"title":"Existing","hours":0,"notes":"keep"}',false)`,
      [gameId],
    );
    await db.query(
      `insert into public.ai_jobs(id,owner_id,request_id,kind,prompt,status,target_game_id,target_version) values($1,$2,gen_random_uuid(),'game','Add pictures','ready',$3,1)`,
      [updateJob, owner, gameId],
    );
    const before = (await db.query('select count(*)::int as count from public.games')).rows[0];
    const data = JSON.stringify({
      title: 'Existing',
      hours: 0,
      notes: 'keep',
      images: [{ url: 'https://storage.test/image.jpg', alt: 'picture' }],
    });
    for (let n = 0; n < 2; n++) {
      const saved = await db.query(`select public.save_ai_draft($1,$2,$3,false) as id`, [
        owner,
        updateJob,
        data,
      ]);
      expect(saved.rows[0].id).toBe(gameId);
    }
    expect((await db.query('select count(*)::int as count from public.games')).rows[0]).toEqual(
      before,
    );
    const saved = (
      await db.query('select version,data,is_published from public.games where id=$1', [gameId])
    ).rows[0];
    expect(saved.version).toBe(2);
    expect(saved.is_published).toBe(false);
    expect(saved.data).toEqual(JSON.parse(data));
  });
  it('rejects stale/deleted targets without changing the draft or inserting records', async () => {
    await as('service_role');
    for (const deleted of [false, true]) {
      const gameId = crypto.randomUUID(),
        updateJob = crypto.randomUUID();
      await db.query(
        `insert into public.games(id,data,version,deleted_at,is_published) values($1,'{"title":"Keep current","hours":12}',2,$2,false)`,
        [gameId, deleted ? new Date() : null],
      );
      await db.query(
        `insert into public.ai_jobs(id,owner_id,request_id,kind,prompt,status,target_game_id,target_version) values($1,$2,gen_random_uuid(),'game','Update','ready',$3,$4)`,
        [updateJob, owner, gameId, deleted ? 2 : 1],
      );
      await expect(
        db.query(`select public.save_ai_draft($1,$2,'{"title":"Stale"}',true)`, [owner, updateJob]),
      ).rejects.toMatchObject({ code: 'PT409' });
      expect(
        (await db.query('select version,data from public.games where id=$1', [gameId])).rows[0],
      ).toEqual({ version: 2, data: { title: 'Keep current', hours: 12 } });
      expect(
        (await db.query('select status from public.ai_jobs where id=$1', [updateJob])).rows[0]
          .status,
      ).toBe('ready');
    }
  });
  it('normalizes legacy game dates and pending drafts without changing play data or versions', async () => {
    await as('service_role');
    const gameId = crypto.randomUUID(),
      draftId = crypto.randomUUID();
    const original = {
      title: 'Legacy date',
      release_year: null,
      release_date: '2017-10-27',
      hours: 0,
      notes: 'Keep',
    };
    await db.query('insert into public.games(id,data,is_published) values($1,$2,false)', [
      gameId,
      JSON.stringify(original),
    ]);
    await db.query(
      `insert into public.ai_jobs(id,owner_id,request_id,kind,prompt,status,target_game_id,target_version,result) values($1,$2,gen_random_uuid(),'game','Update','ready',$3,1,$4)`,
      [
        draftId,
        owner,
        gameId,
        JSON.stringify({
          game: original,
          update_fields: ['release_date', 'release_year', 'images'],
        }),
      ],
    );
    await db.exec('reset role');
    await db.exec(await readFile('supabase/migrations/202609110006_release_year_only.sql', 'utf8'));
    await as('service_role');
    const expected = { title: 'Legacy date', release_year: 2017, hours: 0, notes: 'Keep' };
    expect(
      (await db.query('select data,version from public.games where id=$1', [gameId])).rows[0],
    ).toEqual({ data: expected, version: 1 });
    const draft = (
      await db.query('select result,target_version from public.ai_jobs where id=$1', [draftId])
    ).rows[0];
    expect(draft.result.game).toEqual(expected);
    expect(draft.result.update_fields).toEqual(['release_year', 'images']);
    expect(draft.target_version).toBe(1);
  });
  it('hides soft-deleted records from public readers', async () => {
    await as('service_role');
    await db.query("update public.games set deleted_at=now() where data->>'title'='Public'");
    await as('anon');
    expect(
      (await db.query("select * from public.games where data->>'title'='Public'")).rows,
    ).toHaveLength(0);
  });
});
