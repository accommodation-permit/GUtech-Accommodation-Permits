'use strict';
/**
 * Migrate the live permit data into Supabase.
 *
 *   node scripts/migrate-to-supabase.js <admin-password> [site-url]
 *
 * Reads the current state from the running site through the admin API, so it
 * works whether the data currently lives on a Render disk or in Supabase, and
 * writes it into the Supabase `app_state` table. A local JSON copy is written
 * first, so the data is recoverable even if the Supabase write fails.
 *
 * The site is not modified by this script: it only reads.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const password = process.argv[2];
const siteUrl = (process.argv[3] || 'https://gutech-accommodation-permits.onrender.com').replace(/\/+$/, '');
const localCopy = path.resolve(__dirname, '..', 'backups', 'live-before-migration.json');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function main() {
  if (!password) {
    console.error('Usage: node scripts/migrate-to-supabase.js <admin-password> [site-url]');
    process.exit(1);
  }

  // 1. Read the current state from the live site.
  console.log(`Reading the live data from ${siteUrl} ...`);
  const login = await fetch(`${siteUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (!login.ok) {
    throw new Error(`Admin login failed (HTTP ${login.status}). Check the password.`);
  }
  const cookie = (login.headers.getSetCookie() || [])
    .find(c => c.startsWith('admin_session='))
    ?.split(';')[0];
  if (!cookie) throw new Error('No admin_session cookie was returned.');

  const dataRes = await fetch(`${siteUrl}/api/admin/data`, { headers: { cookie } });
  if (!dataRes.ok) throw new Error(`Could not read the data (HTTP ${dataRes.status}).`);
  const current = await dataRes.json();
  const records = Array.isArray(current.records) ? current.records : [];
  const students = Array.isArray(current.students) ? current.students : [];

  console.log(`Found ${records.length} permits and ${students.length} students on the live site.`);
  if (records.length === 0 && students.length === 0) {
    throw new Error('The live site returned no data. Aborting rather than writing an empty Supabase row.');
  }

  // 2. Keep a local copy before touching Supabase.
  fs.mkdirSync(path.dirname(localCopy), { recursive: true });
  fs.writeFileSync(localCopy, JSON.stringify({
    exportedAt: new Date().toISOString(), source: siteUrl, records, students
  }, null, 2));
  console.log(`Local safety copy written to ${localCopy}`);

  // 3. Supabase is only needed from here on.
  if (!supabaseUrl || !supabaseKey) {
    console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set, so Supabase was not touched.');
    console.log('Run scripts/setup-supabase.js first, then re-run this script.');
    return;
  }
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  const { data: before, error: readErr } = await supabase
    .from('app_state').select('records, students').eq('id', 1).maybeSingle();
  if (readErr) throw readErr;

  if (before) {
    const existing = (before.records || []).length + (before.students || []).length;
    if (existing > 0) {
      fs.writeFileSync(`${localCopy}.supabase-before.json`, JSON.stringify(before, null, 2));
      console.log('Supabase already holds data. A copy was saved before overwriting.');
    }
  }

  const { error } = await supabase.from('app_state').upsert({
    id: 1, records, students, updated_at: new Date().toISOString()
  });
  if (error) throw error;

  const { data: check, error: checkErr } = await supabase
    .from('app_state').select('records, students').eq('id', 1).maybeSingle();
  if (checkErr) throw checkErr;
  console.log(`Verified in Supabase: ${(check.records || []).length} permits, ${(check.students || []).length} students.`);
  console.log('Migration complete.');
}

main().catch((error) => {
  console.error('Failed:', error.message);
  process.exit(1);
});
