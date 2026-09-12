// Legacy entry point retains the explicit write flag.
if (process.argv.includes('--apply')) await import('./migrate.mjs');
else console.log('Run npm run db:migrate to apply pending database migrations.');
