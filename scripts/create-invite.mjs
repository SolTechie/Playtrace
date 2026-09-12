import { createClient } from '@supabase/supabase-js';
import { randomInt, randomBytes, pbkdf2Sync } from 'node:crypto';
import { writeFile, access } from 'node:fs/promises';
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
  throw new Error('Load Supabase server configuration from .env.local');
try {
  await access('.env.invite');
  throw new Error(
    'Existing .env.invite retained. Move it to a private backup before generating another invite.',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data: manager, error: managerError } = await db
  .from('archive_managers')
  .select('id')
  .order('created_at', { ascending: true })
  .limit(1)
  .single();
if (managerError) throw new Error('Apply the invite migration before creating an invite');
const { count, error: countError } = await db
  .from('management_invites')
  .select('id', { count: 'exact', head: true })
  .is('revoked_at', null)
  .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
if (countError) throw new Error('Could not check active invitations');
if ((count || 0) >= 10)
  throw new Error('Revoke an existing invite before creating another (maximum 10 active).');
const code = String(randomInt(0, 1_000_000_000_000)).padStart(12, '0');
const salt = randomBytes(16).toString('hex');
const digest = pbkdf2Sync(code, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex');
const { data, error } = await db
  .from('management_invites')
  .insert({
    manager_id: manager.id,
    label: process.argv[2] || '管理邀请码',
    code_hash: digest,
    salt,
  })
  .select('id')
  .single();
if (error) throw new Error(error.message);
await writeFile('.env.invite', `PLAYTRACE_INVITE_CODE=${code}\nPLAYTRACE_INVITE_ID=${data.id}\n`, {
  mode: 0o600,
  flag: 'wx',
});
console.log(
  'Numeric invitation created. Database stores only its salted PBKDF2 hash. The code is in ignored .env.invite.',
);
