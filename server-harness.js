'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const bcrypt = require('bcryptjs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'server.js');

const ADMIN_PASSWORD = 'sup3r-secret-admin-pw';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 4);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return await res.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server did not become healthy in ${timeoutMs}ms: ${lastError && lastError.message}`);
}

/**
 * Boots `server.js` in a child process against a throwaway DATA_DIR.
 * @param {{dataDir?: string, env?: Record<string, string|undefined>}} options
 */
async function startServer(options = {}) {
  const dataDir = options.dataDir
    || fs.mkdtempSync(path.join(os.tmpdir(), 'permit-test-'));
  fs.mkdirSync(dataDir, { recursive: true });

  const port = await getFreePort();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD_HASH,
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      ...(options.env || {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\n--- server output ---\n${logs.join('')}`);
  }

  return {
    baseUrl,
    dataDir,
    port,
    logs,
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGKILL');
        setTimeout(resolve, 2000).unref?.();
      });
    }
  };
}

function readDataFile(dataDir, name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
}

function writeDataFile(dataDir, name, value) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
}

async function api(baseUrl, route, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (init.body !== undefined && typeof init.body !== 'string') {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(init.body) };
  }
  const res = await fetch(`${baseUrl}${route}`, { ...init, headers });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = undefined; }
  return { status: res.status, body: json, text, headers: res.headers };
}

async function loginAdmin(baseUrl) {
  const res = await api(baseUrl, '/api/admin/login', {
    method: 'POST',
    body: { password: ADMIN_PASSWORD }
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('admin_session='));
  return { res, cookie: cookie && cookie.split(';')[0] };
}

function cookieHeader(cookie) {
  return { cookie };
}

module.exports = {
  ADMIN_PASSWORD,
  ADMIN_PASSWORD_HASH,
  PROJECT_ROOT,
  SERVER_ENTRY,
  api,
  cookieHeader,
  loginAdmin,
  readDataFile,
  startServer,
  writeDataFile
};
