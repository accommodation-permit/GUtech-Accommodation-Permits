'use strict';
/**
 * Backup / restore the permit data stored in Supabase.
 *
 *   node scripts/backup-supabase.js backup  <file.json>
 *   node scripts/backup-supabase.js restore <file.json>
 *
 * Both commands read SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env.
 * The service-role key never leaves the machine.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured in .env');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const TABLE = 'app_state';

async function backup(target) {
  const { data, error } = await supabase
    .from(TABLE).select('records, students').eq('id', 1).maybeSingle();
  if (error) throw error;
  if (!data) {
    console.error('No row with id=1 found in ' + TABLE);
    process.exit(1);
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    records: data.records || [],
    students: data.students || []
  };
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(payload, null, 2));
  console.log(`Backed up ${payload.records.length} permits and ${payload.students.length} students -> ${target}`);
}

async function restore(source) {
  const payload = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (!Array.isArray(payload.records) || !Array.isArray(payload.students)) {
    console.error('Backup file must contain records[] and students[]');
    process.exit(1);
  }
  const { data: before, error: readErr } = await supabase
    .from(TABLE).select('records, students').eq('id', 1).maybeSingle();
  if (readErr) throw readErr;
  if (before) {
    fs.writeFileSync(`${source}.pre-restore.json`,
      JSON.stringify({ exportedAt: new Date().toISOString(), ...before }, null, 2));
    console.log(`Safety copy of the current state written to ${source}.pre-restore.json`);
  }

  const { error } = await supabase.from(TABLE).upsert({
    id: 1,
    records: payload.records,
    students: payload.students,
    updated_at: new Date().toISOString()
  });
  if (error) throw error;
  console.log(`Restored ${payload.records.length} permits and ${payload.students.length} students.`);
}

(async () => {
  const [command, file] = process.argv.slice(2);
  try {
    if (command === 'backup') await backup(file || 'backups/supabase-backup.json');
    else if (command === 'restore') await restore(file);
    else {
      console.error('Usage: node scripts/backup-supabase.js <backup|restore> <file.json>');
      process.exit(1);
    }
  } catch (error) {
    console.error('Failed:', error.message);
    process.exit(1);
  }
})();
