import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  user: process.env.SUPABASE_DB_USER || 'postgres',
  password: process.env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  ssl: {
    rejectUnauthorized: true,
    ca: await readFile(process.env.SUPABASE_DB_CA || '.bridge/supabase-ca.crt', 'utf8'),
  },
  connectionTimeoutMillis: 15000,
});
try {
  await db.connect();
  await db.query('begin');
  await db.query(
    `create table if not exists public.playtrace_migrations(version text primary key,applied_at timestamptz not null default now());alter table public.playtrace_migrations enable row level security;revoke all on public.playtrace_migrations from anon,authenticated;`,
  );
  const legacy = await db.query(
    "select to_regclass('public.games') as games,to_regclass('public.admin_users') as admins,to_regclass('public.archive_managers') as managers",
  );
  if (legacy.rows[0].games && (legacy.rows[0].admins || legacy.rows[0].managers))
    await db.query(
      "insert into public.playtrace_migrations(version) values('202609110001_initial.sql') on conflict do nothing",
    );
  await db.query('commit');
  const applied = new Set(
    (await db.query('select version from public.playtrace_migrations')).rows.map((r) => r.version),
  );
  for (const file of (await readdir('supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (applied.has(file)) continue;
    await db.query('begin');
    await db.query(await readFile(`supabase/migrations/${file}`, 'utf8'));
    await db.query('insert into public.playtrace_migrations(version) values($1)', [file]);
    await db.query('commit');
    console.log(`Applied ${file}`);
  }
  console.log('Database migrations complete.');
} catch (error) {
  await db.query('rollback').catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
