'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { api, cookieHeader, loginAdmin, readDataFile, startServer } = require('./helpers/server-harness');

/**
 * Regression: deleting a permit must not depend on — or clobber — the admin
 * panel's in-memory snapshot of the records list.
 */
test('permit deletion', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const { cookie } = await loginAdmin(server.baseUrl);
  const admin = { ...cookieHeader(cookie), 'content-type': 'application/json' };

  const ids = async () => readDataFile(server.dataDir, 'records.json').map(r => r.id).sort();

  await t.test('DELETE /api/admin/permits/:id removes only the target record', async () => {
    await api(server.baseUrl, '/api/admin/permits/snapshot', {
      method: 'POST', headers: admin,
      body: {
        replaceAll: true, records: [
          { id: 'REC-1', name: 'Ana', studentId: 'st-1' },
          { id: 'REC-2', name: 'Bea', studentId: 'st-2' },
          { id: 'REC-3', name: 'Cy', studentId: 'st-3' }
        ]
      }
    });

    const res = await api(server.baseUrl, '/api/admin/permits/REC-2', { method: 'DELETE', headers: cookieHeader(cookie) });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(await ids(), ['REC-1', 'REC-3'], 'only REC-2 should be gone');
  });

  await t.test('a record added after the panel loaded survives an unrelated delete', async () => {
    // Simulates the admin panel holding a stale 2-record view.
    const staleView = readDataFile(server.dataDir, 'records.json');

    // A student submits a new permit after the panel was opened.
    await api(server.baseUrl, '/api/admin/permits/snapshot', {
      method: 'POST', headers: admin,
      body: { records: [...staleView, { id: 'REC-4', name: 'Dee', studentId: 'st-4' }] }
    });
    assert.deepEqual(await ids(), ['REC-1', 'REC-3', 'REC-4']);

    // The admin deletes REC-1 from their stale view.
    const res = await api(server.baseUrl, '/api/admin/permits/REC-1', { method: 'DELETE', headers: cookieHeader(cookie) });
    assert.equal(res.status, 200);
    assert.deepEqual(await ids(), ['REC-3', 'REC-4'],
      'REC-3 and REC-4 must survive; this is the bug that made permits reappear');
  });

  await t.test('deleting an unknown id returns 404', async () => {
    const res = await api(server.baseUrl, '/api/admin/permits/NOPE', { method: 'DELETE', headers: cookieHeader(cookie) });
    assert.equal(res.status, 404);
    assert.deepEqual(await ids(), ['REC-3', 'REC-4'], 'a failed delete must not change data');
  });

  await t.test('DELETE requires admin auth', async () => {
    const res = await api(server.baseUrl, '/api/admin/permits/REC-3', { method: 'DELETE' });
    assert.equal(res.status, 401);
  });

  await t.test('by-student delete targets the right permit and is case-insensitive', async () => {
    const res = await api(server.baseUrl, '/api/admin/permits/by-student/ST-3', {
      method: 'DELETE', headers: cookieHeader(cookie)
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await ids(), ['REC-4']);
  });

  await t.test('by-student delete on an unknown student returns 404', async () => {
    const res = await api(server.baseUrl, '/api/admin/permits/by-student/ghost', {
      method: 'DELETE', headers: cookieHeader(cookie)
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await ids(), ['REC-4']);
  });

  await t.test('snapshot without replaceAll merges instead of overwriting', async () => {
    await api(server.baseUrl, '/api/admin/permits/snapshot', {
      method: 'POST', headers: admin, body: { records: [{ id: 'REC-9', name: 'Eve', studentId: 'st-9' }] }
    });
    assert.deepEqual(await ids(), ['REC-4', 'REC-9'], 'merge keeps REC-4 and adds REC-9');
  });

  await t.test('snapshot with replaceAll:true still wipes the list', async () => {
    await api(server.baseUrl, '/api/admin/permits/snapshot', {
      method: 'POST', headers: admin, body: { replaceAll: true, records: [{ id: 'REC-X', studentId: 'st-x' }] }
    });
    assert.deepEqual(await ids(), ['REC-X']);
  });

  await t.test('a deleted permit frees the student to submit again', async () => {
    await api(server.baseUrl, '/api/admin/students', {
      method: 'POST', headers: admin, body: { studentId: 'st-77', accessCode: 'c77', name: 'Zed' }
    });
    const access = await api(server.baseUrl, '/api/student/access', {
      method: 'POST', body: { studentId: 'st-77', accessCode: 'c77' }
    });
    const sc = access.headers.getSetCookie().find(c => c.startsWith('student_session=')).split(';')[0];
    const student = { ...cookieHeader(sc), 'content-type': 'application/json' };

    const first = await api(server.baseUrl, '/api/student/permits', {
      method: 'POST', headers: student, body: { id: 'REC-A', name: 'Zed', studentId: 'st-77' }
    });
    assert.equal(first.status, 200);

    const blocked = await api(server.baseUrl, '/api/student/permits', {
      method: 'POST', headers: student, body: { id: 'REC-B', name: 'Zed', studentId: 'st-77' }
    });
    assert.equal(blocked.status, 409);

    await api(server.baseUrl, '/api/admin/permits/REC-A', { method: 'DELETE', headers: cookieHeader(cookie) });

    const status = await api(server.baseUrl, '/api/student/permit-status', {
      method: 'POST', headers: student, body: { studentId: 'st-77' }
    });
    assert.deepEqual(status.body, { hasPermit: false });

    const again = await api(server.baseUrl, '/api/student/permits', {
      method: 'POST', headers: student, body: { id: 'REC-C', name: 'Zed', studentId: 'st-77' }
    });
    assert.equal(again.status, 200, 're-submission must succeed after deletion');
  });
});
