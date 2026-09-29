'use strict';
/**
 * One-time helper: writes SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY into .env.
 *
 *   node scripts/setup-supabase.js <project-url> <service-role-key>
 *
 * It only appends the keys if they are not already present, so running it
 * again will not create duplicates.
 */
const fs = require('node:fs');
const path = require('node:path');

const envPath = path.resolve(__dirname, '..', '.env');
const [url, key] = process.argv.slice(2);

if (!url || !key) {
  console.error('Usage: node scripts/setup-supabase.js <project-url> <service-role-key>');
  console.error('Get both values from Supabase > Project Settings > API.');
  process.exit(1);
}
if (!/^https:\/\/.+\.supabase\.co$/.test(url)) {
  console.error(`That does not look like a Supabase project URL: ${url}`);
  process.exit(1);
}

const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const lines = existing ? existing.split(/\r?\n/) : [];

function upsert(name, value) {
  const index = lines.findIndex(line => line.startsWith(`${name}=`));
  if (index >= 0) {
    lines[index] = `${name}=${value}`;
    return 'updated';
  }
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push(`${name}=${value}`, '');
  return 'added';
}

const urlState = upsert('SUPABASE_URL', url);
const keyState = upsert('SUPABASE_SERVICE_ROLE_KEY', key);
fs.writeFileSync(envPath, lines.join('\n'));

console.log(`SUPABASE_URL          ${urlState} in .env`);
console.log(`SUPABASE_SERVICE_ROLE_KEY ${keyState} in .env`);
console.log('Done. .env is git-ignored, so these values stay off GitHub.');
