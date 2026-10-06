// Kaki Planner: group event scheduler + expense splitter for a small friend group.
// No dependencies. Run: node server.js  (needs Node 22.13+ for node:sqlite)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'kaki.db'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, salt TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
    length INTEGER NOT NULL, currency TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS members (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY (event_id, user_id));
  CREATE TABLE IF NOT EXISTS unavailable (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL, PRIMARY KEY (event_id, user_id, day));
  -- Who has filled in their availability (marked a day, or said they're free on all days).
  CREATE TABLE IF NOT EXISTS responses (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY (event_id, user_id));
  INSERT OR IGNORE INTO responses SELECT DISTINCT event_id, user_id FROM unavailable;
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    item TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL, rate REAL NOT NULL,
    paid_by INTEGER NOT NULL REFERENCES users(id), created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS shares (
    expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY (expense_id, user_id));
`);

const q = sql => db.prepare(sql);
const SESSION_DAYS = 30;

// ---------- auth ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
function newSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').run(token, userId, Date.now());
  res.setHeader('set-cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
function currentUser(req) {
  const sid = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]+)/)?.[1];
  if (!sid) return null;
  const row = q(`SELECT u.id, u.username, s.created FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(sid);
  if (!row || Date.now() - row.created > SESSION_DAYS * 86400000) return null;
  return { id: row.id, username: row.username, sid };
}

// ---------- dates ----------
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const todaySG = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

// Best date blocks: earliest blocks with the fewest people who can't make it. Past days are skipped.
function suggest(ev, memberIds, unavail) {
  const busy = new Map(); // day -> Set(userId)
  for (const u of unavail) {
    if (!busy.has(u.day)) busy.set(u.day, new Set());
    busy.get(u.day).add(u.user_id);
  }
  const from = ev.start_date > todaySG() ? ev.start_date : todaySG();
  const options = [];
  for (let start = from; daysBetween(start, ev.end_date) >= ev.length - 1; start = addDays(start, 1)) {
    const clash = new Set();
    for (let i = 0; i < ev.length; i++) for (const id of busy.get(addDays(start, i)) || []) clash.add(id);
    options.push({ start, end: addDays(start, ev.length - 1), clashes: [...clash].filter(id => memberIds.includes(id)) });
  }
  options.sort((a, b) => a.clashes.length - b.clashes.length || a.start.localeCompare(b.start));
  return options.slice(0, 3);
}

// ---------- money ----------
const cents = x => Math.round(x * 100) / 100;
// Net balance per user in the event's currency (+ = is owed money), and the fewest transfers to settle.
function settle(expenses, shareRows, memberIds) {
  const bal = new Map(memberIds.map(id => [id, 0]));
  const sharesBy = new Map();
  for (const s of shareRows) (sharesBy.get(s.expense_id) || sharesBy.set(s.expense_id, []).get(s.expense_id)).push(s.user_id);
  for (const e of expenses) {
    const total = e.amount * e.rate;
    const who = sharesBy.get(e.id) || [];
    if (!who.length) continue;
    bal.set(e.paid_by, (bal.get(e.paid_by) || 0) + total);
    for (const id of who) bal.set(id, (bal.get(id) || 0) - total / who.length);
  }
  const debtors = [], creditors = [];
  for (const [id, b] of bal) {
    if (b < -0.005) debtors.push({ id, amt: -b });
    else if (b > 0.005) creditors.push({ id, amt: b });
  }
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].amt, creditors[j].amt);
    if (amt >= 0.005) transfers.push({ from: debtors[i].id, to: creditors[j].id, amount: cents(amt) });
    debtors[i].amt -= amt; creditors[j].amt -= amt;
    if (debtors[i].amt < 0.005) i++;
    if (creditors[j].amt < 0.005) j++;
  }
  return { balances: Object.fromEntries([...bal].map(([id, b]) => [id, cents(b)])), transfers };
}

// ---------- http helpers ----------
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) reject(new HttpError(413, 'Body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, 'Bad JSON')); } });
  });
}
const str = (v, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const currency = v => (/^[A-Za-z]{3}$/.test(v || '') ? v.toUpperCase() : fail(400, 'Currency must be a 3-letter code'));

function loadEvent(id, user) {
  const ev = q('SELECT * FROM events WHERE id = ?').get(id) || fail(404, 'Event not found');
  if (!q('SELECT 1 FROM members WHERE event_id = ? AND user_id = ?').get(id, user.id)) fail(403, 'You are not in this event');
  return ev;
}
function memberIdsOf(eventId) {
  return q('SELECT user_id FROM members WHERE event_id = ?').all(eventId).map(r => r.user_id);
}

function eventDetail(id, user) {
  const ev = loadEvent(id, user);
  const memberIds = memberIdsOf(id);
  const unavail = q('SELECT user_id, day FROM unavailable WHERE event_id = ? ORDER BY day').all(id);
  const expenses = q('SELECT * FROM expenses WHERE event_id = ? ORDER BY id DESC').all(id);
  const shareRows = q('SELECT s.* FROM shares s JOIN expenses e ON e.id = s.expense_id WHERE e.event_id = ?').all(id);
  const shares = {};
  for (const s of shareRows) (shares[s.expense_id] ||= []).push(s.user_id);
  return {
    event: ev,
    members: q(`SELECT u.id, u.username FROM members m JOIN users u ON u.id = m.user_id WHERE m.event_id = ? ORDER BY u.username`).all(id),
    unavailable: unavail,
    responded: q('SELECT user_id FROM responses WHERE event_id = ?').all(id).map(r => r.user_id).filter(uid => memberIds.includes(uid)),
    suggestions: suggest(ev, memberIds, unavail),
    expenses: expenses.map(e => ({ ...e, shares: shares[e.id] || [] })),
    ...settle(expenses, shareRows, memberIds),
  };
}

// ---------- routes ----------
async function api(req, res, url, user) {
  const m = req.method;
  const p = url.pathname;
  let match;

  if (p === '/api/register' && m === 'POST') {
    const b = await readBody(req);
    const username = str(b.username, 30);
    if (!/^[\w .-]{2,30}$/.test(username)) fail(400, 'Username: 2-30 letters, numbers, spaces, . _ -');
    if (typeof b.password !== 'string' || b.password.length < 6) fail(400, 'Password must be at least 6 characters');
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'That username is taken');
    const { salt, hash } = hashPassword(b.password);
    const { lastInsertRowid } = q('INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)').run(username, salt, hash);
    newSession(res, Number(lastInsertRowid));
    return send(res, 200, { id: Number(lastInsertRowid), username });
  }
  if (p === '/api/login' && m === 'POST') {
    const b = await readBody(req);
    const u = q('SELECT * FROM users WHERE username = ?').get(str(b.username, 30));
    if (!u || typeof b.password !== 'string' || !checkPassword(b.password, u)) fail(401, 'Wrong username or password');
    newSession(res, u.id);
    return send(res, 200, { id: u.id, username: u.username });
  }
  if (p === '/api/logout' && m === 'POST') {
    if (user) q('DELETE FROM sessions WHERE token = ?').run(user.sid);
    res.setHeader('set-cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  if (!user) fail(401, 'Please log in');

  if (p === '/api/me' && m === 'GET') return send(res, 200, { id: user.id, username: user.username });
  if (p === '/api/users' && m === 'GET') return send(res, 200, q('SELECT id, username FROM users ORDER BY username').all());

  if (p === '/api/events' && m === 'GET') {
    return send(res, 200, q(`SELECT e.*, (SELECT COUNT(*) FROM members WHERE event_id = e.id) AS member_count
      FROM events e JOIN members m ON m.event_id = e.id AND m.user_id = ? ORDER BY e.start_date`).all(user.id));
  }
  if (p === '/api/events' && m === 'POST') {
    const b = await readBody(req);
    const title = str(b.title) || fail(400, 'Title required');
    if (!isDate(b.start) || !isDate(b.end)) fail(400, 'Valid start and end dates required');
    const span = daysBetween(b.start, b.end) + 1;
    if (span < 1 || span > 366) fail(400, 'Date window must be 1-366 days');
    const length = Number(b.length);
    if (!Number.isInteger(length) || length < 1 || length > span) fail(400, 'Length must fit inside the window');
    const ids = new Set([user.id, ...(Array.isArray(b.members) ? b.members.map(Number) : [])]);
    const valid = new Set(q('SELECT id FROM users').all().map(r => r.id));
    db.exec('BEGIN');
    try {
      const { lastInsertRowid: id } = q('INSERT INTO events (title, start_date, end_date, length, currency, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(title, b.start, b.end, length, currency(b.currency || 'SGD'), user.id);
      for (const uid of ids) if (valid.has(uid)) q('INSERT INTO members (event_id, user_id) VALUES (?, ?)').run(id, uid);
      db.exec('COMMIT');
      return send(res, 200, { id: Number(id) });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  if ((match = p.match(/^\/api\/events\/(\d+)$/))) {
    const id = Number(match[1]);
    if (m === 'GET') return send(res, 200, eventDetail(id, user));
    if (m === 'DELETE') {
      const ev = loadEvent(id, user);
      if (ev.created_by !== user.id) fail(403, 'Only the creator can delete this event');
      q('DELETE FROM events WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }
  }

  if ((match = p.match(/^\/api\/events\/(\d+)\/unavailable$/)) && m === 'PUT') {
    const id = Number(match[1]);
    const ev = loadEvent(id, user);
    const b = await readBody(req);
    const days = [...new Set(Array.isArray(b.days) ? b.days : [])].filter(d => isDate(d) && d >= ev.start_date && d <= ev.end_date);
    db.exec('BEGIN');
    try {
      q('DELETE FROM unavailable WHERE event_id = ? AND user_id = ?').run(id, user.id);
      for (const d of days) q('INSERT INTO unavailable (event_id, user_id, day) VALUES (?, ?, ?)').run(id, user.id, d);
      q('INSERT OR IGNORE INTO responses (event_id, user_id) VALUES (?, ?)').run(id, user.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return send(res, 200, eventDetail(id, user));
  }

  if ((match = p.match(/^\/api\/events\/(\d+)\/expenses$/)) && m === 'POST') {
    const id = Number(match[1]);
    const ev = loadEvent(id, user);
    const memberIds = memberIdsOf(id);
    const b = await readBody(req);
    const item = str(b.item) || fail(400, 'Item required');
    const amount = Number(b.amount);
    if (!(amount > 0) || amount > 1e9) fail(400, 'Amount must be positive');
    const cur = currency(b.currency || ev.currency);
    const rate = cur === ev.currency ? 1 : Number(b.rate);
    if (!(rate > 0)) fail(400, `Enter the rate: 1 ${cur} = ? ${ev.currency}`);
    const paidBy = Number(b.paidBy);
    if (!memberIds.includes(paidBy)) fail(400, 'Payer must be in the event');
    const split = [...new Set((Array.isArray(b.splitWith) ? b.splitWith : []).map(Number))].filter(x => memberIds.includes(x));
    if (!split.length) fail(400, 'Pick at least one person to split with');
    db.exec('BEGIN');
    try {
      const { lastInsertRowid: eid } = q(`INSERT INTO expenses (event_id, item, amount, currency, rate, paid_by, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, item, amount, cur, rate, paidBy, user.id, new Date().toISOString());
      for (const uid of split) q('INSERT INTO shares (expense_id, user_id) VALUES (?, ?)').run(eid, uid);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return send(res, 200, eventDetail(id, user));
  }

  if ((match = p.match(/^\/api\/expenses\/(\d+)$/)) && m === 'DELETE') {
    const exp = q('SELECT * FROM expenses WHERE id = ?').get(Number(match[1])) || fail(404, 'Expense not found');
    const ev = loadEvent(exp.event_id, user);
    if (exp.created_by !== user.id && ev.created_by !== user.id) fail(403, 'Only who added it or the event creator can delete');
    q('DELETE FROM expenses WHERE id = ?').run(exp.id);
    return send(res, 200, eventDetail(ev.id, user));
  }

  fail(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url, currentUser(req));
    if (url.pathname !== '/' && url.pathname !== '/index.html') return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    send(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Server error' });
  }
});

server.listen(PORT, () => console.log(`Kaki Planner running at http://localhost:${PORT}`));
