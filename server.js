const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;
const sessions = new Map();
const loginAttempts = new Map();

app.set('trust proxy', 1);
fs.mkdirSync(DATA_DIR, { recursive: true });
const recordsFile = path.join(DATA_DIR, 'records.json');
const studentsFile = path.join(DATA_DIR, 'students.json');

function readJson(filePath, fallback) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.trim() ? JSON.parse(content) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function loadState() {
  if (!supabase) {
    return { records: readJson(recordsFile, []), students: readJson(studentsFile, []) };
  }
  const { data, error } = await supabase.from('app_state').select('records, students').eq('id', 1).maybeSingle();
  if (error) throw error;
  if (!data) {
    const state = { records: readJson(recordsFile, []), students: readJson(studentsFile, []) };
    const { error: insertError } = await supabase.from('app_state').insert({ id: 1, ...state });
    if (insertError) throw insertError;
    return state;
  }
  return { records: data.records || [], students: data.students || [] };
}

async function saveState(state) {
  if (!supabase) {
    writeJson(recordsFile, state.records || []);
    writeJson(studentsFile, state.students || []);
    return;
  }
  const { error } = await supabase.from('app_state').upsert({
    id: 1,
    records: state.records || [],
    students: state.students || [],
    updated_at: new Date().toISOString()
  });
  if (error) throw error;
}

function ensureSeedFiles() {
  if (!fs.existsSync(recordsFile)) writeJson(recordsFile, []);
  if (!fs.existsSync(studentsFile)) writeJson(studentsFile, []);
}

function getCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || process.env.COOKIE_SECURE === 'true',
    maxAge: 60 * 60 * 1000
  };
}

function createSession(type, studentId = '') {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    type,
    studentId,
    expiresAt: Date.now() + 60 * 60 * 1000
  });
  return token;
}

function getSession(req, type) {
  const token = req.cookies?.[`${type}_session`];
  const session = token && sessions.get(token);
  if (!session || session.type !== type || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + 60 * 60 * 1000;
  return session;
}

function isRateLimited(key) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  const attempts = (loginAttempts.get(key) || []).filter(time => time > cutoff);
  loginAttempts.set(key, attempts);
  return attempts.length >= 10;
}

function recordFailedAttempt(key) {
  loginAttempts.set(key, [...(loginAttempts.get(key) || []), Date.now()]);
}

function requireAdmin(req, res, next) {
  if (!getSession(req, 'admin')) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireStudent(req, res, next) {
  const session = getSession(req, 'student');
  const requestedId = String(req.body?.studentId || '').trim().toLowerCase();
  if (!session || !requestedId || session.studentId !== requestedId) {
    return res.status(401).json({ error: 'Student authentication required' });
  }
  next();
}

ensureSeedFiles();
if (!ADMIN_PASSWORD_HASH) {
  throw new Error('ADMIN_PASSWORD_HASH is missing. Set it in the deployment environment.');
}

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(ROOT_DIR));

app.get('/health', (req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));
app.get('/', (req, res) => res.sendFile(path.join(ROOT_DIR, 'index.html')));

app.post('/api/admin/login', (req, res) => {
  const password = String(req.body?.password || '');
  const key = `admin:${req.ip}`;
  if (!password) return res.status(400).json({ error: 'Missing password' });
  if (isRateLimited(key)) return res.status(429).json({ error: 'Too many attempts' });
  if (!bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
    recordFailedAttempt(key);
    return res.status(401).json({ error: 'Invalid password' });
  }
  loginAttempts.delete(key);
  res.cookie('admin_session', createSession('admin'), getCookieOptions(req));
  res.json({ ok: true });
});

app.post('/api/student/access', async (req, res, next) => {
 try {
  const studentId = String(req.body?.studentId || '').trim().toLowerCase();
  const accessCode = String(req.body?.accessCode || '').trim();
  const key = `student:${req.ip}`;
  if (isRateLimited(key)) return res.status(429).json({ error: 'Too many attempts' });

  const state = await loadState();
  const student = state.students.find(item =>
    String(item.studentId || '').trim().toLowerCase() === studentId &&
    String(item.accessCode || '').trim() === accessCode &&
    item.active !== false
  );
  if (!student) {
    recordFailedAttempt(key);
    return res.status(401).json({ error: 'Invalid student access' });
  }

  const records = state.records;
  if (records.some(record => String(record.studentId || '').trim().toLowerCase() === studentId)) {
    return res.status(409).json({ error: 'Permit already submitted' });
  }

  loginAttempts.delete(key);
  res.cookie('student_session', createSession('student', studentId), getCookieOptions(req));
  res.json({ ok: true, studentName: student.name || 'طالبة', studentId });
 } catch (error) { next(error); }
});

app.get('/api/admin/data', requireAdmin, async (req, res, next) => {
  try { res.json(await loadState()); } catch (error) { next(error); }
});

app.post('/api/admin/permits/snapshot', requireAdmin, async (req, res, next) => {
  try {
    const state = await loadState();
    state.records = Array.isArray(req.body?.records) ? req.body.records : [];
    await saveState(state);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/admin/students', requireAdmin, async (req, res, next) => {
 try {
  const payload = req.body || {};
  const student = {
    studentId: String(payload.studentId || '').trim(),
    accessCode: String(payload.accessCode || '').trim(),
    name: String(payload.name || '').trim(),
    civilId: String(payload.civilId || '').trim(),
    active: payload.active !== false
  };
  if (!student.studentId || !student.accessCode || !student.name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const state = await loadState();
  const students = state.students;
  const index = students.findIndex(item => item.studentId.toLowerCase() === student.studentId.toLowerCase());
  if (index >= 0) students[index] = { ...students[index], ...student };
  else students.push(student);
  state.students = students;
  await saveState(state);
  res.json({ ok: true });
 } catch (error) { next(error); }
});

app.get('/api/admin/students', requireAdmin, async (req, res, next) => {
  try { res.json((await loadState()).students); } catch (error) { next(error); }
});
app.delete('/api/admin/students', requireAdmin, async (req, res, next) => {
  try {
    const state = await loadState();
    state.students = [];
    await saveState(state);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/student/permit-status', requireStudent, async (req, res, next) => {
 try {
  const studentId = String(req.body.studentId).trim().toLowerCase();
  const hasPermit = (await loadState()).records.some(record =>
    String(record.studentId || '').trim().toLowerCase() === studentId
  );
  res.json({ hasPermit });
 } catch (error) { next(error); }
});

app.post('/api/student/permits', requireStudent, async (req, res, next) => {
 try {
  const record = req.body || {};
  if (!record.studentId || !record.name) return res.status(400).json({ error: 'Missing record data' });
  const state = await loadState();
  const records = state.records;
  const studentId = String(record.studentId).trim().toLowerCase();
  if (records.some(item => String(item.studentId || '').trim().toLowerCase() === studentId)) {
    return res.status(409).json({ error: 'Permit already submitted' });
  }
  records.push(record);
  state.records = records;
  await saveState(state);
  res.json({ ok: true });
 } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Server storage error' });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
