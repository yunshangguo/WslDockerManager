// Local admin authentication. Seeds an `admin` user on first run with a random
// password (or PASSWORD_OVERRIDE env), prints the password to the log file once.
// Password hashing uses Node's built-in scrypt (no native deps). Sessions are
// persisted to data/sessions.json so a server (or supervisor) restart does NOT
// force every user to log in again — previously sessions lived only in memory
// and were wiped on every restart, which was the cause of "keeps asking to
// re-login".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const log = require('./logger');

const TOKEN_TTL_MS = (cfg.session.ttlHours || 12) * 3600 * 1000;

// token -> { username, role, expires }
const sessions = new Map();

const SESSIONS_FILE = path.join(cfg.secretsDirAbs, 'sessions.json');

function loadSessions() {
  try {
    const arr = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (Array.isArray(arr)) {
      const now = Date.now();
      for (const s of arr) {
        if (s && s.token && s.expires > now) {
          sessions.set(s.token, { username: s.username, role: s.role, expires: s.expires });
        }
      }
    }
  } catch (e) {
    /* file missing or corrupt - start fresh */
  }
}

let saveTimer = null;
let saveScheduled = false;
function scheduleSave() {
  if (saveScheduled) return;
  saveScheduled = true;
  saveTimer = setTimeout(flushSessions, 400);
}
function flushSessions() {
  saveScheduled = false;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const arr = [];
    for (const [token, s] of sessions) {
      arr.push({ token, username: s.username, role: s.role, expires: s.expires });
    }
    fs.mkdirSync(cfg.secretsDirAbs, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    /* best-effort persistence; ignore write errors */
  }
}

// Periodically flush so we never lose a freshly created session if the process
// dies before the debounce timer fires.
setInterval(flushSessions, 60000);
process.on('exit', flushSessions);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(cfg.usersFile, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveUsers(users) {
  fs.mkdirSync(cfg.secretsDirAbs, { recursive: true });
  fs.writeFileSync(cfg.usersFile, JSON.stringify(users, null, 2));
}

function seedAdmin() {
  const users = loadUsers();
  // Skip seeding if an 'admin' user exists OR any admin-role account already
  // exists (e.g. the desktop settings window created one with a custom name).
  // This prevents a stray random-password 'admin' from being added.
  if (users.find((u) => u.username === 'admin') || users.find((u) => u.role === 'admin')) return;
  const pw = process.env.PASSWORD_OVERRIDE || crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  users.push({ username: 'admin', passwordHash: hashPassword(pw), role: 'admin' });
  saveUsers(users);
  log.info(`Seeded admin user. Username: admin  Password: ${pw}  (set env PASSWORD_OVERRIDE to override, or change via UI later)`);
}

function login(username, password) {
  const users = loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user || !verifyPassword(password || '', user.passwordHash)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + TOKEN_TTL_MS;
  sessions.set(token, { username: user.username, role: user.role, expires });
  scheduleSave();
  return { token, username: user.username, role: user.role, isAdmin: user.role === 'admin' };
}

function sessionFromToken(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    scheduleSave();
    return null;
  }
  return s;
}

function logout(token) {
  if (token) {
    sessions.delete(token);
    scheduleSave();
  }
}

loadSessions();


// ---------------------------------------------------------------------------
// user-management helpers (used by the /api/users route, admin only)
// ---------------------------------------------------------------------------
function listUsers() {
  return loadUsers().map((u) => ({ username: u.username, role: u.role }));
}

function createUser({ username, password, role }) {
  if (!username || !password) throw new Error('用户名和密码必填');
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) throw new Error('用户名只能包含字母、数字、下划线、点、连字符');
  if (String(password).length < 4) throw new Error('密码至少 4 个字符');
  const users = loadUsers();
  if (users.find((u) => u.username === username)) throw new Error('用户名已存在');
  const r = (role === 'admin') ? 'admin' : 'user';
  users.push({ username, passwordHash: hashPassword(password), role: r });
  saveUsers(users);
  return { username, role: r };
}

function updateUser(username, { role, password } = {}) {
  const users = loadUsers();
  const u = users.find((x) => x.username === username);
  if (!u) throw new Error('用户不存在');
  if (role) u.role = (role === 'admin') ? 'admin' : 'user';
  if (password) {
    if (String(password).length < 4) throw new Error('密码至少 4 个字符');
    u.passwordHash = hashPassword(password);
  }
  saveUsers(users);
  return { username, role: u.role };
}

function deleteUser(username) {
  const users = loadUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx < 0) throw new Error('用户不存在');
  users.splice(idx, 1);
  saveUsers(users);
  return { ok: true };
}

module.exports = { seedAdmin, login, sessionFromToken, logout, hashPassword, listUsers, createUser, updateUser, deleteUser };
