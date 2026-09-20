import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
let db: PGlite;
const owner = '11111111-1111-4111-a111-111111111111';
const other = '22222222-2222-4222-a222-222222222222';
const native = '33333333-3333-4333-a333-333333333333';
const session = 'a'.repeat(64),
  secret = 'b'.repeat(64),
  state = 'c'.repeat(64);
const as = (role: string) => db.exec(`reset role;set role ${role}`);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid,bucket_id text);alter table storage.objects enable row level security;
    insert into auth.users values('${owner}'),('${other}');`);
  const initial = await readFile('supabase/migrations/202609110001_initial.sql', 'utf8');
  await db.exec(initial.slice(0, initial.lastIndexOf('do $$ begin')));
  await db.exec(
    `insert into public.admin_users values('${owner}');insert into public.games(data) values('{"title":"Preserved"}');`,
  );
  const migrations = (await readdir('supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .slice(1);
  for (const name of migrations) {
    await db.exec(await readFile('supabase/migrations/' + name, 'utf8'));
    if (name === '202609180001_google_access.sql') {
      await db.query(
        `insert into public.google_accounts(id,manager_id,email,google_subject,auth_user_id) values($1,$2,'existing@example.com','existing-google-subject',$1)`,
        [other, owner],
      );
      await db.query(`insert into public.google_sessions(token_hash,account_id) values($1,$2)`, [
        'd'.repeat(64),
        other,
      ]);
      await db.query(
        `insert into public.google_oauth_flows(state_hash,verifier,return_path) values($1,'legacy','/')`,
        ['e'.repeat(64)],
      );
    }
  }
  await db.query(
    `insert into public.google_accounts(id,manager_id,email) values($1,$1,'owner@example.com')`,
    [owner],
  );
});
afterAll(async () => {
  await db?.close();
});
describe.sequential('Google access migration and atomic grants', () => {
  it('preserves the archive and gives no Google user access by default', async () => {
    await as('service_role');
    expect((await db.query('select data from public.games')).rows).toEqual([
      { data: { title: 'Preserved' } },
    ]);
    expect(
      (await db.query('select * from public.archive_managers where id=$1', [owner])).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query('select * from public.bind_google_account($1,$2)', [
          'stranger@example.com',
          'stranger',
        ])
      ).rows,
    ).toHaveLength(0);
  });
  it('preserves existing Google bindings and sessions while removing legacy flows', async () => {
    expect(
      (await db.query('select google_subject from public.google_accounts where id=$1', [other]))
        .rows,
    ).toEqual([{ google_subject: 'existing-google-subject' }]);
    expect(
      (await db.query('select * from public.resolve_google_session($1)', ['d'.repeat(64)])).rows,
    ).toHaveLength(1);
    expect(
      (await db.query('select * from public.consume_google_flow($1)', ['e'.repeat(64)])).rows,
    ).toHaveLength(0);
  });
  it('prevents browser roles reading authentication tables or granting permissions', async () => {
    for (const role of ['anon', 'authenticated']) {
      await as(role);
      for (const table of [
        'google_accounts',
        'google_sessions',
        'google_oauth_flows',
        'google_native_logins',
      ])
        await expect(db.query('select * from public.' + table)).rejects.toThrow();
      await expect(
        db.query('select * from public.bind_google_account($1,$2)', [
          'owner@example.com',
          'hijack',
        ]),
      ).rejects.toThrow();
      await expect(
        db.query('select * from public.claim_google_native_login($1,$2,$3)', [
          native,
          secret,
          session,
        ]),
      ).rejects.toThrow();
      await expect(
        db.query('insert into public.google_accounts(manager_id,email) values($1,$2)', [
          owner,
          'hijack@example.com',
        ]),
      ).rejects.toThrow();
    }
  });
  it('retires database-level invite redemption even after a legacy client rollback', async () => {
    await as('service_role');
    await db.query(
      `insert into public.management_invites(manager_id,label,code_hash) values($1,'old tool',$2)`,
      [owner, secret],
    );
    expect(
      (await db.query('select * from public.redeem_management_invite($1,$2)', [secret, session]))
        .rows,
    ).toHaveLength(0);
    expect(
      (await db.query('select * from public.resolve_management_session($1)', [session])).rows,
    ).toHaveLength(0);
  });
  it('pins the immutable Google subject on the first authorized login', async () => {
    await as('service_role');
    const bind = (subject: string) =>
      db.query('select * from public.bind_google_account($1,$2)', ['owner@example.com', subject]);
    expect((await bind('google-owner')).rows).toHaveLength(1);
    expect((await bind('google-owner')).rows).toHaveLength(1);
    expect((await bind('different-subject')).rows).toHaveLength(0);
    // Retiring a Supabase Auth user cannot cascade-delete Playtrace ownership.
    await as('postgres');
    await db.query('delete from auth.users where id=$1', [owner]);
    await as('service_role');
    expect((await bind('google-owner')).rows).toHaveLength(1);
    expect((await db.query('select * from public.games')).rows).toHaveLength(1);
    await expect(db.query('select auth_user_id from public.google_accounts')).rejects.toThrow();
    await expect(
      db.query('select * from public.bind_google_account($1,$2,$3)', [
        'owner@example.com',
        'google-owner',
        owner,
      ]),
    ).rejects.toThrow();
  });
  it('consumes only unexpired OAuth state, exactly once', async () => {
    await db.query(
      `insert into public.google_oauth_flows(state_hash,verifier,return_path,nonce,redirect_uri) values($1,$2,$3,'nonce','https://playtrace.test/api/access/google/callback')`,
      [state, 'verifier', '/'],
    );
    expect(
      (await db.query('select * from public.consume_google_flow($1)', [secret])).rows,
    ).toHaveLength(0);
    expect(
      (await db.query('select * from public.consume_google_flow($1)', [state])).rows,
    ).toHaveLength(1);
    expect(
      (await db.query('select * from public.consume_google_flow($1)', [state])).rows,
    ).toHaveLength(0);
    await db.query(
      "insert into public.google_oauth_flows(state_hash,verifier,return_path,expires_at,nonce,redirect_uri) values($1,'verifier','/',now()-interval '1 minute','nonce','https://playtrace.test/api/access/google/callback')",
      [state],
    );
    expect(
      (await db.query('select * from public.consume_google_flow($1)', [state])).rows,
    ).toHaveLength(0);
  });
  it('requires both browser authorization and the initiating native secret, then issues once', async () => {
    await db.query(
      "insert into public.google_native_logins(id,secret_hash,client_name) values($1,$2,'cli')",
      [native, secret],
    );
    const claim = (proof: string) =>
      db.query('select * from public.claim_google_native_login($1,$2,$3)', [
        native,
        proof,
        session,
      ]);
    expect((await claim(secret)).rows).toHaveLength(0);
    await db.query('update public.google_native_logins set account_id=$1 where id=$2', [
      owner,
      native,
    ]);
    expect((await claim(state)).rows).toHaveLength(0);
    expect((await claim(secret)).rows).toHaveLength(1);
    expect((await claim(secret)).rows).toHaveLength(0);
    expect(
      (await db.query('select * from public.resolve_google_session($1)', [session])).rows,
    ).toHaveLength(1);
  });
  it('requires the OS callback proof as well as the initiating secret for App sessions', async () => {
    const appSession = 'f'.repeat(64),
      completion = '9'.repeat(64);
    await db.query(
      "insert into public.google_native_logins(id,secret_hash,client_name,return_to_app,account_id,completion_hash) values($1,$2,'desktop',true,$3,$4)",
      [native, secret, owner, completion],
    );
    const claim = (proof: string | null) =>
      db.query('select * from public.claim_google_native_login($1,$2,$3,$4)', [
        native,
        secret,
        appSession,
        proof,
      ]);
    // An attacker who initiates a login and sends its URL elsewhere cannot redeem it.
    expect(
      (
        await db.query('select * from public.claim_google_native_login($1,$2,$3)', [
          native,
          secret,
          appSession,
        ])
      ).rows,
    ).toHaveLength(0);
    expect((await claim(null)).rows).toHaveLength(0);
    expect((await claim(state)).rows).toHaveLength(0);
    expect((await claim(completion)).rows).toHaveLength(1);
    expect((await claim(completion)).rows).toHaveLength(0);
    await expect(
      db.query(
        "insert into public.google_native_logins(secret_hash,client_name,return_to_app) values($1,'cli',true)",
        [secret],
      ),
    ).rejects.toThrow();
  });
  it('rejects expired sessions, logout and account revocation immediately', async () => {
    await db.query(
      "update public.google_sessions set expires_at=now()-interval '1 second' where token_hash=$1",
      [session],
    );
    expect(
      (await db.query('select * from public.resolve_google_session($1)', [session])).rows,
    ).toHaveLength(0);
    await db.query(
      "update public.google_sessions set expires_at=now()+interval '1 day' where token_hash=$1",
      [session],
    );
    await db.query('update public.google_accounts set revoked_at=now() where id=$1', [owner]);
    expect(
      (await db.query('select * from public.resolve_google_session($1)', [session])).rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query('select * from public.bind_google_account($1,$2)', [
          'owner@example.com',
          'google-owner',
        ])
      ).rows,
    ).toHaveLength(0);
    await db.query('update public.google_accounts set revoked_at=null where id=$1', [owner]);
    await db.query('delete from public.google_sessions where token_hash=$1', [session]);
    expect(
      (await db.query('select * from public.resolve_google_session($1)', [session])).rows,
    ).toHaveLength(0);
  });
});
