import { createClient } from '@supabase/supabase-js';
import { writeFile, access } from 'node:fs/promises';
const site = new URL(process.argv[2] || '');
if (site.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(site.hostname))
  throw new Error('Use the trusted HTTPS URL of your own Playtrace site');
try {
  await access('.env.bridge');
  throw new Error(
    'Existing .env.bridge retained. Reuse it or revoke the device before pairing again.',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, PLAYTRACE_ADMIN_EMAIL, PLAYTRACE_ADMIN_PASSWORD } =
  process.env;
if (
  !SUPABASE_URL ||
  !SUPABASE_PUBLISHABLE_KEY ||
  !PLAYTRACE_ADMIN_EMAIL ||
  !PLAYTRACE_ADMIN_PASSWORD
)
  throw new Error('Load .env.local and .env.admin before pairing');
const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await db.auth.signInWithPassword({
  email: PLAYTRACE_ADMIN_EMAIL,
  password: PLAYTRACE_ADMIN_PASSWORD,
});
if (error) throw new Error(error.message);
const response = await fetch(new URL('/api/agents', site), {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ name: 'Playtrace local computer' }),
});
const device = await response.json();
if (!response.ok) throw new Error(device.error || 'Device pairing failed');
await writeFile(
  '.env.bridge',
  `GAME_API_URL=${site.origin}\nGAME_DEVICE_TOKEN=${device.token}\nGAME_DEVICE_ID=${device.id}\nBRIDGE_POLL_MS=4000\nBRIDGE_TIMEOUT_MS=900000\n`,
  { mode: 0o600, flag: 'wx' },
);
await db.auth.signOut({ scope: 'local' });
console.log(
  'Computer paired. Credentials saved in ignored .env.bridge. Start it with npm run bridge.',
);
