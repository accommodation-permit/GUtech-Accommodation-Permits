'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  api,
  cookieHeader,
  loginAdmin,
  readDataFile,
  startServer
} = require('./helpers/server-harness');

/** Boots a fresh server for the whole suite. */
test('API surface', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await t.test('GET /health reports ok', async () => {
    const { status, body } = await api(server.baseUrl, '/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
  });

  await t.test('GET / serves the SPA', async () => {
    const { status, text } = await api(server.baseUrl, '/');
    assert.equal(status, 200);
    assert.match(text, /<html/i);
  });

  await t.test('unknown route returns 404 JSON', async () => {
    const { status, body } = await api(server.baseUrl, '/api/does-not-exist');
    assert.equal(status, 404);
    assert.deepEqual(body, { error: 'Not found' });
  });

  await t.test('GET /api/admin/data without a session is 401', async () => {
    const { status, body } = await api(server.baseUrl, '/api/admin/data');
    assert.equal(status, 401);
    assert.deepEqual(body, { error: 'Unauthorized' });
  });

  // ------------------------------------------------------------------
  // Admin login
  // ------------------------------------------------------------------
  await t.test('admin login rejects a missing password with 400', async () => {
    const { status, body } = await api(server.baseUrl, '/api/admin/login', { method: 'POST', body: {} });
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'Missing password' });
  });

  await t.test('admin login treats an empty-string password as missing', async () => {
    const { status, body } = await api(server.baseUrl, '/api/admin/login', { method: 'POST', body: { password: '' } });
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'Missing password' });
  });

  await t.test('admin login rejects a wrong password with 401', async () => {
    const { status, body, headers } = await api(server.baseUrl, '/api/admin/login', {
      method: 'POST', body: { password: 'wrong-password' }
    });
    assert.equal(status, 401);
    assert.deepEqual(body, { error: 'Invalid password' });
    assert.equal(headers.getSetCookie().length, 0);
  });

  await t.test('admin login accepts the correct password and issues a hardened cookie', async () => {
    const { res, cookie } = await loginAdmin(server.baseUrl);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.ok(cookie.startsWith('admin_session='));
    const raw = res.headers.getSetCookie().find((c) => c.startsWith('admin_session='));
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);
    assert.match(raw, /Max-Age=3600/i);
  });

  await t.test('an admin session cookie unlocks /api/admin/data', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const { status, body } = await api(server.baseUrl, '/api/admin/data', { headers: cookieHeader(cookie) });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.records));
    assert.ok(Array.isArray(body.students));
  });

  await t.test('a forged/garbage session cookie is rejected', async () => {
    const { status } = await api(server.baseUrl, '/api/admin/data', {
      headers: { cookie: 'admin_session=not-a-real-token' }
    });
    assert.equal(status, 401);
  });

  await t.test('a student session cookie cannot be used on admin routes', async () => {
    // Type isolation: sessions are keyed by cookie name AND checked by type.
    const { status } = await api(server.baseUrl, '/api/admin/data', {
      headers: { cookie: 'student_session=student_session' }
    });
    assert.equal(status, 401);
  });

  // ------------------------------------------------------------------
  // Admin: students CRUD
  // ------------------------------------------------------------------
  await t.test('POST /api/admin/students requires auth', async () => {
    const { status } = await api(server.baseUrl, '/api/admin/students', {
      method: 'POST', body: { studentId: 's1', accessCode: 'c1', name: 'N' }
    });
    assert.equal(status, 401);
  });

  await t.test('POST /api/admin/students rejects missing required fields', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };
    for (const payload of [
      { accessCode: 'c', name: 'N' },
      { studentId: 's', name: 'N' },
      { studentId: 's', accessCode: 'c' },
      { studentId: '  ', accessCode: 'c', name: 'N' },
      {}
    ]) {
      const { status, body } = await api(server.baseUrl, '/api/admin/students', { method: 'POST', headers, body: payload });
      assert.equal(status, 400, `payload ${JSON.stringify(payload)} should be rejected`);
      assert.deepEqual(body, { error: 'Missing required fields' });
    }
  });

  await t.test('POST /api/admin/students creates a record that is persisted', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };
    const { status, body } = await api(server.baseUrl, '/api/admin/students', {
      method: 'POST',
      headers,
      body: { studentId: ' ST-100 ', accessCode: ' code-1 ', name: ' Ana ', civilId: ' 123 ' }
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });

    const persisted = readDataFile(server.dataDir, 'students.json');
    const created = persisted.find((s) => s.studentId === 'ST-100');
    assert.ok(created, 'student should be written to disk');
    assert.equal(created.accessCode, 'code-1');
    assert.equal(created.name, 'Ana');
    assert.equal(created.civilId, '123');
    assert.equal(created.active, true);
  });

  await t.test('POST /api/admin/students updates in place (case-insensitive id match)', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };
    const { status } = await api(server.baseUrl, '/api/admin/students', {
      method: 'POST',
      headers,
      body: { studentId: 'st-100', accessCode: 'code-2', name: 'Ana Updated', active: false }
    });
    assert.equal(status, 200);

    const students = readDataFile(server.dataDir, 'students.json');
    assert.equal(students.length, 1, 'update must not create a duplicate entry');
    assert.equal(students[0].name, 'Ana Updated');
    assert.equal(students[0].active, false);
  });

  await t.test('GET /api/admin/students lists students', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const { status, body } = await api(server.baseUrl, '/api/admin/students', { headers: cookieHeader(cookie) });
    assert.equal(status, 200);
    assert.equal(body.length, 1);
    // The later update rewrote the id, and ids are stored exactly as submitted.
    assert.equal(body[0].studentId, 'st-100');
    assert.equal(body[0].name, 'Ana Updated');
  });

  await t.test('DELETE /api/admin/students clears the roster but keeps permits', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };

    // Seed a permit directly through the admin snapshot endpoint.
    const snap = await api(server.baseUrl, '/api/admin/permits/snapshot', {
      method: 'POST', headers, body: { replaceAll: true, records: [{ id: 'REC-1', studentId: 'st-100', name: 'Ana Updated' }] }
    });
    assert.equal(snap.status, 200);

    const { status, body } = await api(server.baseUrl, '/api/admin/students', { method: 'DELETE', headers: cookieHeader(cookie) });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(readDataFile(server.dataDir, 'students.json'), []);
    assert.equal(readDataFile(server.dataDir, 'records.json').length, 1, 'clearing the roster must not touch permits');
  });

  await t.test('POST /api/admin/permits/snapshot upserts by default and replaces on demand', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };

    // Default (no replaceAll) is an upsert: existing rows survive, new ones are added.
    const upserted = await api(server.baseUrl, '/api/admin/permits/snapshot', {
      method: 'POST', headers, body: { records: [{ id: 'x1', studentId: 's1' }] }
    });
    assert.equal(upserted.status, 200);
    assert.ok(readDataFile(server.dataDir, 'records.json').some(r => r.id === 'x1'), 'x1 should be added');
    assert.ok(readDataFile(server.dataDir, 'records.json').some(r => r.id === 'REC-1'), 'REC-1 must survive an upsert');
    assert.ok(Array.isArray(upserted.body.records), 'the response returns the merged list');

    // Updating the same id overwrites in place.
    const updated = await api(server.baseUrl, '/api/admin/permits/snapshot', {
      method: 'POST', headers, body: { records: [{ id: 'x1', studentId: 's1', name: 'Renamed' }] }
    });
    assert.equal(updated.status, 200);
    const rows = readDataFile(server.dataDir, 'records.json');
    assert.equal(rows.filter(r => r.id === 'x1').length, 1, 'upsert must not duplicate');
    assert.equal(rows.find(r => r.id === 'x1').name, 'Renamed');

    // replaceAll:true is the explicit "wipe everything" operation.
    const replaced = await api(server.baseUrl, '/api/admin/permits/snapshot', {
      method: 'POST', headers, body: { replaceAll: true, records: [] }
    });
    assert.equal(replaced.status, 200);
    assert.deepEqual(readDataFile(server.dataDir, 'records.json'), [], 'replaceAll with [] must clear the list');

    // A bad records payload is coerced to [] under replaceAll.
    const bogus = await api(server.baseUrl, '/api/admin/permits/snapshot', {
      method: 'POST', headers, body: { replaceAll: true, records: 'not-an-array' }
    });
    assert.equal(bogus.status, 200);
    assert.deepEqual(readDataFile(server.dataDir, 'records.json'), [], 'non-array records must fall back to []');
  });

  // ------------------------------------------------------------------
  // Student access
  // ------------------------------------------------------------------
  await t.test('student access rejects unknown ids with 401', async () => {
    const { status, body } = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'nope', accessCode: 'nope' }
    });
    assert.equal(status, 401);
    assert.deepEqual(body, { error: 'Invalid student access' });
  });

  await t.test('student access rejects a wrong access code with 401', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };
    await api(server.baseUrl, '/api/admin/students', {
      method: 'POST', headers, body: { studentId: 'st-200', accessCode: 'good', name: 'Bea' }
    });

    const { status, body } = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'st-200', accessCode: 'bad' }
    });
    assert.equal(status, 401);
    assert.deepEqual(body, { error: 'Invalid student access' });
  });

  await t.test('student access rejects an inactive student', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };
    await api(server.baseUrl, '/api/admin/students', {
      method: 'POST', headers, body: { studentId: 'st-201', accessCode: 'good', name: 'Cy', active: false }
    });

    const { status } = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'st-201', accessCode: 'good' }
    });
    assert.equal(status, 401);
  });

  await t.test('student access is case/whitespace insensitive and sets a session cookie', async () => {
    const { status, body } = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: '  ST-200  ', accessCode: '  good  ' }
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.studentId, 'st-200');
    assert.equal(body.studentName, 'Bea');
    const raw = (await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'st-200', accessCode: 'good' }
    })).headers.getSetCookie().find((c) => c.startsWith('student_session='));
    assert.match(raw, /HttpOnly/i);
  });

  await t.test('student access falls back to a default display name', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };
    await api(server.baseUrl, '/api/admin/students', {
      method: 'POST', headers, body: { studentId: 'st-202', accessCode: 'c', name: 'Dee' }
    });
    const students = readDataFile(server.dataDir, 'students.json');
    const target = students.find((s) => s.studentId === 'st-202');
    delete target.name;
    require('./helpers/server-harness').writeDataFile(server.dataDir, 'students.json', students);

    const { body } = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'st-202', accessCode: 'c' }
    });
    assert.equal(body.studentName, 'طالبة');
  });

  await t.test('student access is refused with 409 once a permit exists', async () => {
    const access = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'st-200', accessCode: 'good' }
    });
    const studentCookie = access.headers.getSetCookie()
      .find((c) => c.startsWith('student_session=')).split(';')[0];

    const submitted = await api(server.baseUrl, '/api/student/permits', {
      method: 'POST',
      headers: { ...cookieHeader(studentCookie), 'content-type': 'application/json' },
      body: { studentId: 'ST-200', name: 'Bea', apartment: 'A-1' }
    });
    assert.equal(submitted.status, 200);

    const again = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'st-200', accessCode: 'good' }
    });
    assert.equal(again.status, 409);
    assert.deepEqual(again.body, { error: 'Permit already submitted' });
  });

  // ------------------------------------------------------------------
  // Student permit endpoints
  // ------------------------------------------------------------------
  await t.test('POST /api/student/permits requires an authenticated student', async () => {
    const { status, body } = await api(server.baseUrl, '/api/student/permits', {
      method: 'POST', body: { studentId: 'st-200', name: 'Bea' }
    });
    assert.equal(status, 401);
    assert.deepEqual(body, { error: 'Student authentication required' });
  });

  await t.test('POST /api/student/permits rejects impersonating another student id', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };
    await api(server.baseUrl, '/api/admin/students', {
      method: 'POST', headers, body: { studentId: 'st-300', accessCode: 'c3', name: 'Eve' }
    });
    const access = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'st-300', accessCode: 'c3' }
    });
    const studentCookie = access.headers.getSetCookie()
      .find((c) => c.startsWith('student_session=')).split(';')[0];

    const { status } = await api(server.baseUrl, '/api/student/permits', {
      method: 'POST',
      headers: { ...cookieHeader(studentCookie), 'content-type': 'application/json' },
      body: { studentId: 'st-999', name: 'Mallory' }
    });
    assert.equal(status, 401);
  });

  await t.test('POST /api/student/permits validates required record fields', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };
    await api(server.baseUrl, '/api/admin/students', {
      method: 'POST', headers, body: { studentId: 'st-301', accessCode: 'c4', name: 'Fay' }
    });
    const access = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'st-301', accessCode: 'c4' }
    });
    const studentCookie = access.headers.getSetCookie()
      .find((c) => c.startsWith('student_session=')).split(';')[0];

    // A blank/absent studentId is rejected by the auth middleware first (401),
    // which is correct: the id must match the session before validation runs.
    for (const payload of [{ name: 'Fay' }, {}]) {
      const { status, body } = await api(server.baseUrl, '/api/student/permits', {
        method: 'POST', headers: { ...cookieHeader(studentCookie), 'content-type': 'application/json' }, body: payload
      });
      assert.equal(status, 401);
      assert.deepEqual(body, { error: 'Student authentication required' });
    }

    // Matching id but a missing name reaches the handler and fails validation.
    const missingName = await api(server.baseUrl, '/api/student/permits', {
      method: 'POST',
      headers: { ...cookieHeader(studentCookie), 'content-type': 'application/json' },
      body: { studentId: 'st-301' }
    });
    assert.equal(missingName.status, 400);
    assert.deepEqual(missingName.body, { error: 'Missing record data' });
  });

  await t.test('POST /api/student/permits rejects a duplicate submission with 409', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };
    await api(server.baseUrl, '/api/admin/students', {
      method: 'POST', headers, body: { studentId: 'st-302', accessCode: 'c5', name: 'Gus' }
    });
    const access = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'st-302', accessCode: 'c5' }
    });
    const studentCookie = access.headers.getSetCookie()
      .find((c) => c.startsWith('student_session=')).split(';')[0];

    const first = await api(server.baseUrl, '/api/student/permits', {
      method: 'POST', headers: { ...cookieHeader(studentCookie), 'content-type': 'application/json' },
      body: { studentId: 'st-302', name: 'Gus' }
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true });

    const second = await api(server.baseUrl, '/api/student/permits', {
      method: 'POST', headers: { ...cookieHeader(studentCookie), 'content-type': 'application/json' },
      body: { studentId: 'ST-302', name: 'Gus' }
    });
    assert.equal(second.status, 409);
    assert.deepEqual(second.body, { error: 'Permit already submitted' });
  });

  await t.test('POST /api/student/permit-status reports permit presence', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };
    await api(server.baseUrl, '/api/admin/students', {
      method: 'POST', headers, body: { studentId: 'st-400', accessCode: 'c6', name: 'Hal' }
    });

    const access = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'st-400', accessCode: 'c6' }
    });
    const studentCookie = access.headers.getSetCookie()
      .find((c) => c.startsWith('student_session=')).split(';')[0];
    const authHeaders = { ...cookieHeader(studentCookie), 'content-type': 'application/json' };

    const before = await api(server.baseUrl, '/api/student/permit-status', {
      method: 'POST', headers: authHeaders, body: { studentId: 'ST-400' }
    });
    assert.deepEqual(before.body, { hasPermit: false });

    await api(server.baseUrl, '/api/student/permits', {
      method: 'POST', headers: authHeaders, body: { studentId: 'st-400', name: 'Hal' }
    });

    const after = await api(server.baseUrl, '/api/student/permit-status', {
      method: 'POST', headers: authHeaders, body: { studentId: '  st-400 ' }
    });
    assert.deepEqual(after.body, { hasPermit: true });
  });

  await t.test('POST /api/student/permit-status requires auth', async () => {
    const { status } = await api(server.baseUrl, '/api/student/permit-status', {
      method: 'POST', body: { studentId: 'st-400' }
    });
    assert.equal(status, 401);
  });

  // ------------------------------------------------------------------
  // Malformed input
  // ------------------------------------------------------------------
  await t.test('malformed JSON body is handled without crashing the server', async () => {
    const { status } = await api(server.baseUrl, '/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json'
    });
    assert.equal(status, 500);

    const health = await api(server.baseUrl, '/health');
    assert.equal(health.status, 200, 'server must still be alive after a bad payload');
  });

  await t.test('a JSON null body surfaces as a 500 from the error handler, not a crash', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const headers = { ...cookieHeader(cookie), 'content-type': 'application/json' };
    const res = await api(server.baseUrl, '/api/admin/students', { method: 'POST', headers, body: null });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Server storage error' });
    assert.equal((await api(server.baseUrl, '/health')).status, 200);
  });

  await t.test('an endpoint with no body at all still validates as missing fields', async () => {
    const { cookie } = await loginAdmin(server.baseUrl);
    const res = await api(server.baseUrl, '/api/admin/students', {
      method: 'POST', headers: cookieHeader(cookie)
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Missing required fields' });
  });
});
