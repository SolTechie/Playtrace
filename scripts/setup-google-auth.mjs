import { createClient } from '@supabase/supabase-js';
const args = process.argv.slice(2);
const apply = args.length === 3 && args[2] === '--apply';
const email = args[0] === '--email' ? args[1]?.trim().toLowerCase() : undefined;
if (
  args.length &&
  (!email ||
    ![2, 3].includes(args.length) ||
    (args.length === 3 && !apply) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
) {
  console.error('Usage: npm run auth:setup -- [--email owner@example.com [--apply]]');
  process.exit(1);
}
const url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
try {
  const response = await fetch(url + '/auth/v1/settings', {
    headers: { apikey: key },
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Cannot read Supabase Auth settings.');
  const settings = await response.json();
  console.log(
    JSON.stringify({
      googleEnabled: !!settings.external?.google,
      googleCallback: url + '/auth/v1/callback',
    }),
  );
  if (!email) process.exit(0);
  const { data: managers, error } = await db.from('archive_managers').select('id').limit(2);
  if (error || managers?.length !== 1)
    throw new Error(
      'Expected exactly one archive manager. Select the intended manager explicitly in Supabase before granting access.',
    );
  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, email, managerId: managers[0].id }));
    process.exit(0);
  }
  if (!settings.external?.google)
    throw new Error('Enable Google in Supabase before granting access and deploying.');
  const { data: existing, error: lookupError } = await db
    .from('google_accounts')
    .select('id,revoked_at')
    .eq('email', email)
    .maybeSingle();
  if (lookupError)
    throw new Error('Apply the Google access migration before configuring the authorized account.');
  if (existing?.revoked_at)
    throw new Error(
      'This account was revoked. Review it in Supabase; this command will not silently reactivate it.',
    );
  if (!existing) {
    const { error: insertError } = await db
      .from('google_accounts')
      .insert({ email, manager_id: managers[0].id });
    if (insertError) throw new Error('Could not authorize the account.');
  }
  console.log(JSON.stringify({ authorized: true, email, existing: !!existing }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Google setup failed.');
  process.exitCode = 1;
}
