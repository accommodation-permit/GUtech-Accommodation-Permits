'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  SERVER_ENTRY,
  PROJECT_ROOT,
  ADMIN_PASSWORD_HASH
} = require('./helpers/server-harness');

/**
 * Server bootstrap validation: the module is expected to fail fast when the
 * required configuration is missing.
 */
test.describe('server bootstrap configuration', () => {
  test('throws when ADMIN_PASSWORD_HASH is not configured', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-boot-'));
    let stderr = '';
    try {
      execFileSync(process.execPath, [SERVER_ENTRY], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PORT: '0',
          DATA_DIR: dataDir,
          ADMIN_PASSWORD_HASH: '',
          SUPABASE_URL: '',
          SUPABASE_SERVICE_ROLE_KEY: ''
        },
        stdio: ['ignore', 'ignore', 'pipe']
      });
      assert.fail('expected the process to exit with an error');
    } catch (error) {
      stderr = String(error.stderr || '');
      assert.equal(error.status, 1);
      assert.match(stderr, /ADMIN_PASSWORD_HASH is missing/);
    }
  });

  test('accepts a bcrypt hash as ADMIN_PASSWORD_HASH', () => {
    assert.match(ADMIN_PASSWORD_HASH, /^\$2[aby]\$\d{2}\$/);
  });

  test('seeds records.json and students.json when the data dir is empty', () => {
    const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'permit-seed-')), 'nested', 'data');
    // The harness boots the app; reuse it to observe side effects on disk.
    const { startServer } = require('./helpers/server-harness');
    return startServer({ dataDir }).then(async (server) => {
      try {
        assert.ok(fs.existsSync(path.join(dataDir, 'records.json')));
        assert.ok(fs.existsSync(path.join(dataDir, 'students.json')));
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'records.json'), 'utf8')), []);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'students.json'), 'utf8')), []);
      } finally {
        await server.stop();
      }
    });
  });
});
