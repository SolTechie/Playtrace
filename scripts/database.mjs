import pg from 'pg';
import { readFile } from 'node:fs/promises';
const connection = {
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
};
if (!connection.host || !connection.password)
  throw new Error('Missing database connection configuration');
const db = new pg.Client(connection);
try {
  await db.connect();
  if (process.argv.includes('--apply')) {
    const initial = await db.query("select to_regclass('public.games') as table_name");
    if (initial.rows[0].table_name)
      throw new Error(
        'Existing games table found; use versioned Supabase migrations for later updates.',
      );
    await db.query('begin');
    await db.query(await readFile('supabase/migrations/202609110001_initial.sql', 'utf8'));
    await db.query('commit');
    console.log('Playtrace schema, RLS, storage and realtime initialized.');
  }
  console.log(
    JSON.stringify(
      (
        await db.query(
          "select tablename from pg_tables where schemaname='public' order by tablename",
        )
      ).rows,
    ),
  );
} catch (e) {
  await db.query('rollback').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
