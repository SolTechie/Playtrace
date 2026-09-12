import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const email = process.argv[2]?.trim();
if (!email || !email.includes('@'))
  throw new Error('Usage: node --env-file=.env.local scripts/create-admin.mjs your@email');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
  throw new Error('Missing Supabase server configuration');
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
let user;
let page = 1;
while (!user) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 100 });
  if (error) throw new Error(error.message);
  user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (data.users.length < 100) break;
  page++;
}
if (!user) {
  const password = randomBytes(24).toString('base64url');
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  user = data.user;
  await writeFile(
    '.env.admin',
    `PLAYTRACE_ADMIN_EMAIL=${email}\nPLAYTRACE_ADMIN_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  console.log('New login details saved in ignored .env.admin. No email was sent.');
}
const { error } = await db.from('admin_users').upsert({ user_id: user.id });
if (error) throw new Error(error.message);
console.log(`Administrator configured: ${email}. Existing passwords are preserved.`);
