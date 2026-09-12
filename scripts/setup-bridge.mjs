import { writeFile, access } from 'node:fs/promises';
const site = new URL(process.argv[2] || '');
if (site.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(site.hostname))
  throw new Error('Use your own Playtrace HTTPS site URL');
try {
  await access('.env.bridge');
  throw new Error(
    'Existing .env.bridge retained. Reuse it or revoke the device before pairing again.',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const code = process.env.PLAYTRACE_INVITE_CODE;
if (!code || !/^\d{12}$/.test(code)) throw new Error('Load .env.invite before pairing');
const headers = { Origin: site.origin, 'Content-Type': 'application/json' };
const response = await fetch(new URL('/api/access/verify', site), {
  method: 'POST',
  headers,
  body: JSON.stringify({ code }),
});
if (!response.ok) throw new Error((await response.json()).error || 'Invite verification failed');
const cookie = response.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('No management session returned');
try {
  const paired = await fetch(new URL('/api/agents', site), {
    method: 'POST',
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify({ name: 'Playtrace local computer' }),
  });
  const device = await paired.json();
  if (!paired.ok) throw new Error(device.error || 'Pairing failed');
  await writeFile(
    '.env.bridge',
    `GAME_API_URL=${site.origin}\nGAME_DEVICE_TOKEN=${device.token}\nGAME_DEVICE_ID=${device.id}\nBRIDGE_POLL_MS=4000\nBRIDGE_TIMEOUT_MS=900000\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'Computer paired. Credentials saved in ignored .env.bridge. Start with npm run bridge.',
  );
} finally {
  await fetch(new URL('/api/access/exit', site), {
    method: 'POST',
    headers: { ...headers, Cookie: cookie },
    body: '{}',
  }).catch(() => {});
}
