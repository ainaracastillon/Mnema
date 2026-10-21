'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
/* IA: Groq como principal (texto) y Cloudflare Workers AI para imágenes y como respaldo */
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_MODEL_QUICK = process.env.GROQ_MODEL_QUICK || 'llama-3.1-8b-instant';
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const CF_MODEL = process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct';
const HAS_GROQ = !!GROQ_API_KEY;
const HAS_CF = !!(CF_ACCOUNT_ID && CF_API_TOKEN);
const AI_READY = HAS_GROQ || HAS_CF;

if (!DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(1); }
if (!process.env.SESSION_SECRET) console.warn('Aviso: SESSION_SECRET no está definido; las sesiones se cerrarán al reiniciar.');

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });

// Superadministradora: solo Ainara. Se reconoce por el identificador fijo de su cuenta, no por el nombre,
// así que nadie más puede llegar a serlo aunque se registre con un nombre parecido.
// Es la única que puede nombrar o quitar administradores y eliminar cuentas.
const SUPERADMIN_ID = (process.env.SUPERADMIN_ID || 'gQOHNACJwGC9Au-v').trim();

async function migrate() {
  const sql = [
    `CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, username text UNIQUE NOT NULL, pass text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS docs (user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, doc_id text NOT NULL, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, doc_id))`,
    `CREATE TABLE IF NOT EXISTS shared (code text PRIMARY KEY, owner text NOT NULL REFERENCES users(id) ON DELETE CASCADE, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS scores (code text NOT NULL REFERENCES shared(code) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (code, user_id))`,
    `CREATE TABLE IF NOT EXISTS assets (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, mime text NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS admin_log (id serial PRIMARY KEY, admin_id text, admin_name text NOT NULL DEFAULT '', action text NOT NULL, target_id text, target_label text NOT NULL DEFAULT '', detail text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS tts_cache (key text PRIMARY KEY, mime text NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS messages (id serial PRIMARY KEY, user_id text, username text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', kind text NOT NULL DEFAULT 'consulta', subject text NOT NULL DEFAULT '', body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolved_by text)`
  ];
  for (const q of sql) await pool.query(q);
  const extra = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email text`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at timestamptz`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS suspend_reason text`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_suggested_at timestamptz`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_suggested_by text`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_suggested_reason text`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_ver integer NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email)) WHERE email IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username))`
  ];
  for (const q of extra) { try { await pool.query(q); } catch (e) { console.warn('Migración:', e.message); } }
  // Solo hay una superadministradora: la cuenta con el identificador configurado.
  await pool.query("UPDATE users SET role='user' WHERE role='superadmin' AND id<>$1", [SUPERADMIN_ID]);
  await pool.query("UPDATE users SET role='superadmin', suspended_at=NULL, suspend_reason=NULL, delete_suggested_at=NULL WHERE id=$1", [SUPERADMIN_ID]);
}

/* ---------- sesiones ---------- */
const COOKIE = 'mnema_s';
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
function makeToken(uid, ver) { const exp = Date.now() + 1000 * 60 * 60 * 24 * 60; const v = uid + '.' + (ver || 0) + '.' + exp; return v + '.' + sign(v); }
function readToken(t) {
  if (!t) return null; const parts = t.split('.'); if (parts.length !== 4) return null;
  const v = parts.slice(0, 3).join('.'); const sig = parts[3]; const good = sign(v);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (Number(parts[2]) < Date.now()) return null; return { uid: parts[0], ver: Number(parts[1]) || 0 };
}
function cookies(req) { const out = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); }); return out; }
function setSession(res, u) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${u ? makeToken(u.id, u.session_ver) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${u ? 60 * 60 * 24 * 60 : 0}${secure}`);
}
const USER_COLS = 'id, username, email, display_name, avatar, role, suspended_at, suspend_reason, session_ver, last_seen_at, created_at, delete_suggested_at, delete_suggested_by, delete_suggested_reason';
const userCache = new Map();
function forget(uid) { userCache.delete(uid); }
async function loadUser(id) { const r = await pool.query(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [id]); return r.rows[0] || null; }
async function sessionUser(req) {
  const tok = readToken(cookies(req)[COOKIE]); if (!tok) return null;
  let c = userCache.get(tok.uid);
  if (!c || Date.now() - c.t > 15000) {
    c = { u: await loadUser(tok.uid), t: Date.now() }; userCache.set(tok.uid, c);
    if (c.u && (!c.u.last_seen_at || Date.now() - new Date(c.u.last_seen_at).getTime() > 5 * 60e3)) pool.query('UPDATE users SET last_seen_at=now() WHERE id=$1', [tok.uid]).catch(() => {});
  }
  if (!c.u || (c.u.session_ver || 0) !== tok.ver) return null;
  return c.u;
}
async function auth(req, res, next) {
  try {
    const u = await sessionUser(req);
    if (!u) return res.status(401).json({ error: 'not_signed_in' });
    if (u.suspended_at) return res.status(403).json({ code: 'suspended', error: 'Tu cuenta está suspendida.' + (u.suspend_reason ? ' Motivo: ' + u.suspend_reason : '') });
    req.uid = u.id; req.user = u; next();
  } catch (e) { next(e); }
}

function hashPass(p) { const salt = crypto.randomBytes(16); const h = crypto.scryptSync(p, salt, 64); return salt.toString('hex') + ':' + h.toString('hex'); }
function checkPass(p, stored) { const [s, h] = stored.split(':'); const hh = crypto.scryptSync(p, Buffer.from(s, 'hex'), 64); return crypto.timingSafeEqual(hh, Buffer.from(h, 'hex')); }
const newId = () => crypto.randomBytes(12).toString('base64url');

/* ---------- límites ---------- */
const buckets = new Map();
function limit(key, max, windowMs) {
  const now = Date.now(); const b = buckets.get(key) || []; const fresh = b.filter(t => now - t < windowMs);
  if (fresh.length >= max) { buckets.set(key, fresh); return false; } fresh.push(now); buckets.set(key, fresh); return true;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });
app.use('/api', express.json({ limit: '30mb' }));
/* errores de rutas async → manejador de errores */
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (p, ...hs) => orig(p, ...hs.map(h => (typeof h === 'function' && h.length < 4) ? (req, res, next) => { try { const r = h(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); } } : h));
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; this.expose = true; } }

app.get('/healthz', (req, res) => res.send('ok'));

/* ---------- cuentas ---------- */
const USER_RE = /^[\p{L}\p{N}_.\-]{3,30}$/u;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const isSuper = (u) => !!u && u.id === SUPERADMIN_ID && u.role === 'superadmin';
const isAdmin = (u) => !!u && (u.role === 'admin' || isSuper(u));
const publicUser = (u) => u && ({ id: u.id, username: u.username, email: u.email || '', displayName: u.display_name || '', avatarUrl: u.avatar || '', role: isSuper(u) ? 'superadmin' : u.role === 'admin' ? 'admin' : 'user', isAdmin: isAdmin(u), isSuperadmin: isSuper(u) });
function dupMsg(e) { const c = String(e.constraint || e.detail || ''); return /email/.test(c) ? 'Ese correo ya está registrado.' : 'Ese nombre de usuario ya está en uso.'; }
const USER_HELP = 'El nombre de usuario debe tener entre 3 y 30 letras, números, puntos, guiones o guiones bajos, sin espacios.';

app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim(); const password = String(req.body.password || '');
  const email = String(req.body.email || '').trim().toLowerCase(); const displayName = String(req.body.displayName || '').trim().slice(0, 60);
  if (!USER_RE.test(username)) return res.status(400).json({ error: USER_HELP });
  if (!email) return res.status(400).json({ error: 'El correo es obligatorio.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'El correo no parece válido.' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  if (!limit('reg:' + req.ip, 10, 3600e3)) return res.status(429).json({ error: 'Demasiados intentos. Prueba más tarde.' });
  const id = newId(); const role = 'user';
  try { await pool.query('INSERT INTO users (id, username, pass, email, display_name, role, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,now())', [id, username, hashPass(password), email, displayName || null, role]); }
  catch (e) { if (e.code === '23505') return res.status(409).json({ error: dupMsg(e) }); throw e; }
  const u = await loadUser(id); setSession(res, u); res.json(publicUser(u));
});
app.post('/api/login', async (req, res) => {
  const login = String(req.body.username || '').trim(); const password = String(req.body.password || '');
  if (!limit('login:' + req.ip, 20, 600e3)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  const r = await pool.query('SELECT id, pass FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1) LIMIT 1', [login]);
  if (!r.rows[0] || !checkPass(password, r.rows[0].pass)) return res.status(401).json({ error: 'Usuario, correo o contraseña incorrectos.' });
  const u = await loadUser(r.rows[0].id);
  if (u.suspended_at) return res.status(403).json({ error: 'Tu cuenta está suspendida.' + (u.suspend_reason ? ' Motivo: ' + u.suspend_reason : '') + ' Si crees que es un error, escribe a la administración.' });
  forget(u.id); setSession(res, u); res.json(publicUser(u));
});
app.post('/api/logout', (req, res) => { setSession(res, null); res.json({ ok: true }); });
app.get('/api/me', async (req, res) => {
  const u = await sessionUser(req);
  if (!u) return res.json({ user: null, ai: AI_READY, tts: HAS_CF });
  if (u.suspended_at) { setSession(res, null); return res.json({ user: null, ai: AI_READY, suspended: true, reason: u.suspend_reason || '' }); }
  res.json({ user: publicUser(u), ai: AI_READY, tts: HAS_CF });
});
app.patch('/api/account', auth, async (req, res) => {
  const b = req.body || {}; const sets = []; const vals = [];
  if (b.username !== undefined) {
    const v = String(b.username).trim();
    if (isSuper(req.user) && v.toLowerCase() !== req.user.username.toLowerCase()) return res.status(400).json({ error: 'El nombre de usuario de la superadministradora está fijado y no se puede cambiar.' });
    if (!USER_RE.test(v)) return res.status(400).json({ error: USER_HELP });
    vals.push(v); sets.push('username=$' + vals.length);
  }
  if (b.email !== undefined) { const v = String(b.email).trim().toLowerCase(); if (!v) return res.status(400).json({ error: 'El correo es obligatorio.' }); if (!EMAIL_RE.test(v)) return res.status(400).json({ error: 'El correo no parece válido.' }); vals.push(v); sets.push('email=$' + vals.length); }
  if (b.displayName !== undefined) { const v = String(b.displayName).trim().slice(0, 60); vals.push(v || null); sets.push('display_name=$' + vals.length); }
  if (b.avatar !== undefined) { const v = String(b.avatar || ''); if (v && !/^\/a\/[A-Za-z0-9_\-]{8,40}$/.test(v)) return res.status(400).json({ error: 'Foto no válida.' }); vals.push(v || null); sets.push('avatar=$' + vals.length); }
  if (sets.length) {
    vals.push(req.uid);
    try { await pool.query('UPDATE users SET ' + sets.join(', ') + ' WHERE id=$' + vals.length, vals); }
    catch (e) { if (e.code === '23505') return res.status(409).json({ error: dupMsg(e) }); throw e; }
    forget(req.uid);
  }
  res.json(publicUser(await loadUser(req.uid)));
});
app.post('/api/account/password', auth, async (req, res) => {
  const cur = String(req.body.current || ''); const next = String(req.body.password || '');
  if (!limit('pw:' + req.uid, 10, 600e3)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  if (next.length < 6) return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres.' });
  const r = await pool.query('SELECT pass FROM users WHERE id=$1', [req.uid]);
  if (!r.rows[0] || !checkPass(cur, r.rows[0].pass)) return res.status(401).json({ error: 'La contraseña actual no es correcta.' });
  await pool.query('UPDATE users SET pass=$1, session_ver=session_ver+1 WHERE id=$2', [hashPass(next), req.uid]);
  forget(req.uid); setSession(res, await loadUser(req.uid));
  res.json({ ok: true });
});
app.post('/api/account/delete', auth, async (req, res) => {
  if (isSuper(req.user)) return res.status(403).json({ error: 'La cuenta de la superadministradora no se puede eliminar desde la app.' });
  const r = await pool.query('SELECT pass FROM users WHERE id=$1', [req.uid]);
  if (!r.rows[0] || !checkPass(String(req.body.password || ''), r.rows[0].pass)) return res.status(401).json({ error: 'La contraseña no es correcta.' });
  await pool.query('DELETE FROM users WHERE id=$1', [req.uid]); forget(req.uid);
  setSession(res, null); res.json({ ok: true });
});
app.get('/api/profiles', auth, async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 200);
  const r = ids.length ? await pool.query('SELECT id, username, display_name, avatar FROM users WHERE id = ANY($1)', [ids]) : { rows: [] };
  const out = {}; r.rows.forEach(u => { out[u.id] = { id: u.id, name: u.display_name || u.username, username: u.username, avatarUrl: u.avatar || '' }; }); res.json(out);
});
app.post('/api/messages', auth, async (req, res) => {
  const kind = ['consulta', 'sugerencia', 'error'].includes(req.body.kind) ? req.body.kind : 'consulta';
  const subject = String(req.body.subject || '').trim().slice(0, 140); const body = String(req.body.body || '').trim().slice(0, 5000);
  if (body.length < 5) return res.status(400).json({ error: 'Escribe tu mensaje.' });
  if (!limit('msg:' + req.uid, 8, 3600e3)) return res.status(429).json({ error: 'Has enviado muchos mensajes seguidos. Prueba más tarde.' });
  await pool.query('INSERT INTO messages (user_id, username, email, kind, subject, body) VALUES ($1,$2,$3,$4,$5,$6)', [req.uid, req.user.username, req.user.email || '', kind, subject, body]);
  res.json({ ok: true });
});

/* ---------- panel de administración ---------- */
function requireAdmin(req) { if (!isAdmin(req.user)) throw new HttpError(403, 'Solo para administración.'); return req.user; }
function requireSuper(req) { if (!isSuper(req.user)) throw new HttpError(403, 'Solo la superadministradora puede hacer esto.'); return req.user; }
const label = (t) => `${t.display_name || t.username} (@${t.username})`;
async function logAdmin(admin, action, t, detail) {
  await pool.query('INSERT INTO admin_log (admin_id, admin_name, action, target_id, target_label, detail) VALUES ($1,$2,$3,$4,$5,$6)', [admin.id, admin.display_name || admin.username, action, t ? t.id : null, t ? label(t) : '', detail || '']);
}
async function targetUser(admin, id) {
  const t = await loadUser(id); if (!t) throw new HttpError(404, 'Esa cuenta ya no existe.');
  if (t.id === admin.id) throw new HttpError(400, 'No puedes hacer esto con tu propia cuenta desde el panel. Usa «Mi cuenta».');
  if (t.id === SUPERADMIN_ID || t.role === 'superadmin') throw new HttpError(403, 'La cuenta de la superadministradora está protegida.');
  if (t.role === 'admin' && !isSuper(admin)) throw new HttpError(403, 'Solo la superadministradora puede actuar sobre otros administradores.');
  return t;
}
const adminRow = (u) => ({ id: u.id, username: u.username, displayName: u.display_name || '', email: u.email || '', avatarUrl: u.avatar || '', role: u.role, createdAt: u.created_at, lastSeenAt: u.last_seen_at, suspendedAt: u.suspended_at, suspendReason: u.suspend_reason || '', deleteSuggestedAt: u.delete_suggested_at, deleteSuggestedBy: u.delete_suggested_by || '', deleteSuggestedReason: u.delete_suggested_reason || '', subjects: Number(u.subjects || 0) });
const n = async (q, p) => Number((await pool.query(q, p)).rows[0].n || 0);

app.get('/api/admin/stats', auth, async (req, res) => {
  requireAdmin(req);
  const signups = (await pool.query("SELECT to_char(created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD') AS d, count(*) AS n FROM users WHERE created_at >= now() - interval '30 days' GROUP BY 1")).rows;
  const map = Object.fromEntries(signups.map(r => [r.d, Number(r.n)]));
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
  const perDay = []; for (let i = 29; i >= 0; i--) { const k = fmt.format(new Date(Date.now() - i * 86400000)); perDay.push({ date: k, n: map[k] || 0 }); }
  res.json({
    users: {
      total: await n('SELECT count(*) AS n FROM users'),
      admins: await n("SELECT count(*) AS n FROM users WHERE role IN ('admin','superadmin')"),
      suspended: await n('SELECT count(*) AS n FROM users WHERE suspended_at IS NOT NULL'),
      deleteSuggested: await n('SELECT count(*) AS n FROM users WHERE delete_suggested_at IS NOT NULL'),
      new7: await n("SELECT count(*) AS n FROM users WHERE created_at >= now() - interval '7 days'"),
      new30: await n("SELECT count(*) AS n FROM users WHERE created_at >= now() - interval '30 days'"),
      active7: await n("SELECT count(*) AS n FROM users WHERE last_seen_at >= now() - interval '7 days'"),
      active30: await n("SELECT count(*) AS n FROM users WHERE last_seen_at >= now() - interval '30 days'"),
      noEmail: await n("SELECT count(*) AS n FROM users WHERE email IS NULL OR email = ''")
    },
    content: {
      subjects: await n("SELECT count(*) AS n FROM docs WHERE doc_id LIKE 's\\_%'"),
      files: await n("SELECT count(*) AS n FROM docs WHERE doc_id LIKE 'm\\_%'"),
      cards: await n("SELECT COALESCE(sum(jsonb_array_length(CASE WHEN jsonb_typeof(body->'cards')='array' THEN body->'cards' ELSE '[]'::jsonb END)),0) AS n FROM docs WHERE doc_id LIKE 's\\_%'"),
      groups: await n('SELECT count(*) AS n FROM shared'),
      images: await n('SELECT count(*) AS n FROM assets')
    },
    messagesOpen: await n('SELECT count(*) AS n FROM messages WHERE resolved_at IS NULL'),
    signupsPerDay: perDay,
    system: { database: 'PostgreSQL (Neon)', ai: [HAS_GROQ ? 'Groq' : null, HAS_CF ? 'Cloudflare Workers AI' : null].filter(Boolean), node: process.version, uptimeS: Math.round(process.uptime()) }
  });
});
app.get('/api/admin/users', auth, async (req, res) => {
  requireAdmin(req);
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100); const filter = String(req.query.filter || 'all');
  const where = []; const p = [];
  if (q) { p.push('%' + q + '%'); where.push(`(lower(u.username) LIKE $${p.length} OR lower(coalesce(u.email,'')) LIKE $${p.length} OR lower(coalesce(u.display_name,'')) LIKE $${p.length})`); }
  if (filter === 'admins') where.push("u.role IN ('admin','superadmin')");
  if (filter === 'suspended') where.push('u.suspended_at IS NOT NULL');
  if (filter === 'delete_suggested') where.push('u.delete_suggested_at IS NOT NULL');
  if (filter === 'active') where.push("u.last_seen_at >= now() - interval '7 days'");
  if (filter === 'no_email') where.push("(u.email IS NULL OR u.email = '')");
  const r = await pool.query(`SELECT u.*, (SELECT count(*) FROM docs d WHERE d.user_id=u.id AND d.doc_id LIKE 's\\_%') AS subjects FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE u.role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.created_at DESC LIMIT 300`, p);
  res.json(r.rows.map(adminRow));
});
app.get('/api/admin/users/:id', auth, async (req, res) => {
  requireAdmin(req);
  const r = await pool.query(`SELECT u.*, (SELECT count(*) FROM docs d WHERE d.user_id=u.id AND d.doc_id LIKE 's\\_%') AS subjects FROM users u WHERE u.id=$1`, [req.params.id]);
  if (!r.rows[0]) throw new HttpError(404, 'Esa cuenta ya no existe.');
  const id = req.params.id;
  res.json(Object.assign(adminRow(r.rows[0]), {
    files: await n("SELECT count(*) AS n FROM docs WHERE user_id=$1 AND doc_id LIKE 'm\\_%'", [id]),
    cards: await n("SELECT COALESCE(sum(jsonb_array_length(CASE WHEN jsonb_typeof(body->'cards')='array' THEN body->'cards' ELSE '[]'::jsonb END)),0) AS n FROM docs WHERE user_id=$1 AND doc_id LIKE 's\\_%'", [id]),
    groups: await n('SELECT count(*) AS n FROM shared WHERE owner=$1', [id])
  }));
});
app.put('/api/admin/users/:id/role', auth, async (req, res) => {
  const admin = requireSuper(req); const t = await targetUser(admin, req.params.id);
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (t.suspended_at && role === 'admin') throw new HttpError(400, 'Reactiva la cuenta antes de hacerla administradora.');
  await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, t.id]); forget(t.id);
  await logAdmin(admin, role === 'admin' ? 'Nombrar administrador' : 'Quitar administrador', t); res.json({ ok: true });
});
app.put('/api/admin/users/:id/suspend', auth, async (req, res) => {
  const admin = requireAdmin(req); const t = await targetUser(admin, req.params.id);
  const suspend = !!req.body.suspended; const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (suspend && !reason) throw new HttpError(400, 'Escribe el motivo de la suspensión.');
  if (suspend) await pool.query('UPDATE users SET suspended_at=now(), suspend_reason=$1, session_ver=session_ver+1 WHERE id=$2', [reason, t.id]);
  else await pool.query('UPDATE users SET suspended_at=NULL, suspend_reason=NULL WHERE id=$1', [t.id]);
  forget(t.id); await logAdmin(admin, suspend ? 'Suspender cuenta' : 'Reactivar cuenta', t, reason); res.json({ ok: true });
});
app.post('/api/admin/users/:id/suggest-delete', auth, async (req, res) => {
  const admin = requireAdmin(req); const t = await targetUser(admin, req.params.id);
  const reason = String(req.body.reason || '').trim().slice(0, 300); if (!reason) throw new HttpError(400, 'Escribe el motivo.');
  await pool.query('UPDATE users SET delete_suggested_at=now(), delete_suggested_by=$1, delete_suggested_reason=$2 WHERE id=$3', [admin.display_name || admin.username, reason, t.id]);
  forget(t.id); await logAdmin(admin, 'Sugerir eliminación', t, reason); res.json({ ok: true });
});
app.delete('/api/admin/users/:id/suggest-delete', auth, async (req, res) => {
  const admin = requireAdmin(req); const t = await targetUser(admin, req.params.id);
  await pool.query('UPDATE users SET delete_suggested_at=NULL, delete_suggested_by=NULL, delete_suggested_reason=NULL WHERE id=$1', [t.id]);
  forget(t.id); await logAdmin(admin, isSuper(admin) ? 'Descartar sugerencia de eliminación' : 'Retirar sugerencia de eliminación', t); res.json({ ok: true });
});
app.post('/api/admin/users/:id/logout', auth, async (req, res) => {
  const admin = requireAdmin(req); const t = await targetUser(admin, req.params.id);
  await pool.query('UPDATE users SET session_ver=session_ver+1 WHERE id=$1', [t.id]); forget(t.id);
  await logAdmin(admin, 'Cerrar sesiones', t); res.json({ ok: true });
});
app.delete('/api/admin/users/:id', auth, async (req, res) => {
  const admin = requireSuper(req); const t = await targetUser(admin, req.params.id);
  const r = await pool.query('SELECT pass FROM users WHERE id=$1', [admin.id]);
  if (!checkPass(String(req.body.password || ''), r.rows[0].pass)) throw new HttpError(401, 'Tu contraseña no es correcta.');
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  await logAdmin(admin, 'Eliminar cuenta', t, reason);
  await pool.query('DELETE FROM users WHERE id=$1', [t.id]); forget(t.id); res.json({ ok: true });
});
app.get('/api/admin/messages', auth, async (req, res) => {
  requireAdmin(req); const st = String(req.query.status || 'open');
  const where = st === 'open' ? 'WHERE resolved_at IS NULL' : st === 'resolved' ? 'WHERE resolved_at IS NOT NULL' : '';
  const r = await pool.query(`SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT 300`);
  res.json(r.rows.map(m => ({ id: m.id, userId: m.user_id, username: m.username, email: m.email, kind: m.kind, subject: m.subject, body: m.body, createdAt: m.created_at, resolvedAt: m.resolved_at, resolvedBy: m.resolved_by })));
});
app.put('/api/admin/messages/:id', auth, async (req, res) => {
  const admin = requireAdmin(req);
  if (req.body.resolved) await pool.query('UPDATE messages SET resolved_at=now(), resolved_by=$1 WHERE id=$2', [admin.display_name || admin.username, Number(req.params.id)]);
  else await pool.query('UPDATE messages SET resolved_at=NULL, resolved_by=NULL WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});
app.delete('/api/admin/messages/:id', auth, async (req, res) => {
  const admin = requireAdmin(req);
  await pool.query('DELETE FROM messages WHERE id=$1', [Number(req.params.id)]); await logAdmin(admin, 'Borrar mensaje', null, '#' + req.params.id); res.json({ ok: true });
});
app.get('/api/admin/log', auth, async (req, res) => {
  requireAdmin(req);
  const r = await pool.query('SELECT * FROM admin_log ORDER BY created_at DESC LIMIT 200');
  res.json(r.rows.map(l => ({ id: l.id, adminName: l.admin_name, action: l.action, target: l.target_label, detail: l.detail, createdAt: l.created_at })));
});

/* documentos privados */
const DOC_RE = /^[A-Za-z0-9_\-]{1,80}$/;
app.get('/api/docs', auth, async (req, res) => {
  const r = await pool.query('SELECT doc_id, body FROM docs WHERE user_id=$1 ORDER BY doc_id LIMIT 2000', [req.uid]);
  res.json(r.rows.map(x => ({ id: x.doc_id, body: x.body })));
});
app.put('/api/docs/:id', auth, async (req, res) => {
  if (!DOC_RE.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  const body = req.body; if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_body' });
  if (JSON.stringify(body).length > 2_000_000) return res.status(413).json({ error: 'too_large' });
  await pool.query('INSERT INTO docs (user_id, doc_id, body, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (user_id, doc_id) DO UPDATE SET body=EXCLUDED.body, updated_at=now()', [req.uid, req.params.id, body]);
  res.json({ ok: true });
});
app.delete('/api/docs/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM docs WHERE user_id=$1 AND doc_id=$2', [req.uid, req.params.id]); res.json({ ok: true });
});

/* grupos compartidos */
const CODE_RE = /^[A-Z0-9]{6}$/;
app.get('/api/shared/:code', auth, async (req, res) => {
  if (!CODE_RE.test(req.params.code)) return res.json({ exists: false });
  const r = await pool.query('SELECT body FROM shared WHERE code=$1', [req.params.code]);
  res.json(r.rows[0] ? { exists: true, body: r.rows[0].body } : { exists: false });
});
app.put('/api/shared/:code', auth, async (req, res) => {
  const code = req.params.code; if (!CODE_RE.test(code)) return res.status(400).json({ error: 'bad_code' });
  const body = req.body; if (!body || typeof body !== 'object') return res.status(400).json({ error: 'bad_body' });
  if (JSON.stringify(body).length > 2_000_000) return res.status(413).json({ error: 'too_large' });
  const cur = await pool.query('SELECT owner FROM shared WHERE code=$1', [code]);
  if (cur.rows[0] && cur.rows[0].owner !== req.uid) return res.status(403).json({ error: 'not_owner' });
  body.owner = req.uid;
  await pool.query('INSERT INTO shared (code, owner, body, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (code) DO UPDATE SET body=EXCLUDED.body, updated_at=now()', [code, req.uid, body]);
  res.json({ ok: true });
});
app.get('/api/shared/:code/scores', auth, async (req, res) => {
  const r = await pool.query('SELECT user_id, body FROM scores WHERE code=$1 LIMIT 500', [req.params.code]);
  res.json(r.rows.map(x => ({ id: x.user_id, body: Object.assign({}, x.body, { uid: x.user_id }) })));
});
app.put('/api/shared/:code/scores', auth, async (req, res) => {
  const code = req.params.code; const b = req.body || {};
  const ex = await pool.query('SELECT 1 FROM shared WHERE code=$1', [code]); if (!ex.rows[0]) return res.status(404).json({ error: 'no_group' });
  const body = { uid: req.uid, best: typeof b.best === 'number' ? Math.max(0, Math.min(1, b.best)) : null, match: typeof b.match === 'number' ? Math.max(0, b.match) : null, tests: Number(b.tests) || 0, updatedAt: Date.now() };
  await pool.query('INSERT INTO scores (code, user_id, body, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (code, user_id) DO UPDATE SET body=EXCLUDED.body, updated_at=now()', [code, req.uid, body]);
  res.json({ ok: true });
});

/* imágenes */
const ASSET_TYPES = /^(image\/(png|jpeg|webp|gif)|application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/plain|text\/markdown)$/;
app.post('/api/assets', auth, express.raw({ type: () => true, limit: '20mb' }), async (req, res) => {
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ASSET_TYPES.test(mime) || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Tipo de archivo no admitido.' });
  const id = newId();
  await pool.query('INSERT INTO assets (id, user_id, mime, data) VALUES ($1,$2,$3,$4)', [id, req.uid, mime, req.body]);
  res.json({ id, url: '/a/' + id, sizeBytes: req.body.length, contentType: mime });
});
app.get('/a/:id', async (req, res) => {
  const r = await pool.query('SELECT mime, data FROM assets WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).end();
  res.setHeader('Content-Type', r.rows[0].mime); res.setHeader('Content-Disposition', 'inline'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); res.end(r.rows[0].data);
});

/* IA (Groq + Cloudflare) */
const SYSTEM_PROMPT = 'Eres el asistente de estudio de la app Mnema. Responde siempre en español de España, con claridad. Sigue exactamente el formato que se te pida.';
/* Modelos de visión: se comprueban al arrancar y se usa el primero que funcione */
const VISION = { groq: HAS_GROQ ? GROQ_VISION_MODEL : null, cf: HAS_CF ? CF_MODEL : null, checked: false };
function tinyPng() {
  const w = 32, h = 32; const raw = Buffer.alloc((w * 3 + 1) * h, 255); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const zlib = require('zlib'); const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
async function visionWorks(url, key, model) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(25000),
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: [{ type: 'text', text: '¿De qué color es esta imagen? Una palabra.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + tinyPng() } }] }] }) });
    if (!r.ok) { console.error('visión', model, r.status, (await r.text().catch(() => '')).slice(0, 160)); return false; }
    return true;
  } catch (e) { console.error('visión', model, String(e && e.message)); return false; }
}
async function checkVision() {
  if (HAS_GROQ) {
    let ids = [];
    try { const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: 'Bearer ' + GROQ_API_KEY } }); const j = await r.json(); ids = (j.data || []).filter(m => m.active !== false).map(m => m.id); } catch (e) {}
    const pats = [/llama-4-maverick/i, /llama-4-scout/i, /qwen.*vl|vl.*qwen/i, /vision/i, /(^|[-\/])vl([-\/]|$)/i, /gemma-3/i, /llama-4/i];
    const cands = [GROQ_VISION_MODEL].concat(...pats.map(p => ids.filter(id => p.test(id)))).filter((x, i, a) => x && a.indexOf(x) === i && (!ids.length || ids.includes(x)));
    VISION.groq = null;
    for (const m of cands.slice(0, 6)) if (await visionWorks('https://api.groq.com/openai/v1/chat/completions', GROQ_API_KEY, m)) { VISION.groq = m; break; }
  }
  if (HAS_CF) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1/chat/completions`;
    VISION.cf = null;
    for (const m of [CF_MODEL, '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/google/gemma-3-12b-it'].filter((x, i, a) => a.indexOf(x) === i))
      if (await visionWorks(url, CF_API_TOKEN, m)) { VISION.cf = m; break; }
  }
  VISION.checked = true;
  console.log('Lectura de imágenes: groq=' + (VISION.groq || 'no') + ' · cloudflare=' + (VISION.cf || 'no'));
}
function providersFor(tier, hasImages) {
  const gModel = hasImages ? VISION.groq : tier === 'quick' ? GROQ_MODEL_QUICK : GROQ_MODEL;
  const cModel = hasImages ? VISION.cf : CF_MODEL;
  const groq = HAS_GROQ && gModel ? { name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: gModel, maxTokens: 8000, maxChars: 380000 } : null;
  const cf = HAS_CF && cModel ? { name: 'cloudflare', url: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1/chat/completions`, key: CF_API_TOKEN, model: cModel, maxTokens: 4096, maxChars: 300000 } : null;
  // Los modelos de Groq no leen imágenes: las fotos van a Cloudflare (Llama 4 Scout, con visión)
  const order = [groq, cf];
  return order.filter(Boolean);
}
function fitMessages(msgs, maxChars) {
  const size = () => msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : m.content.reduce((k, c) => k + (c.text ? c.text.length : 0), 0)), 0);
  let over = size() - maxChars;
  if (over <= 0) return msgs;
  // recorta el texto más largo por el medio
  let biggest = null, len = 0;
  msgs.forEach(m => { const t = typeof m.content === 'string' ? m.content : (m.content.find(c => c.text) || {}).text || ''; if (t.length > len) { len = t.length; biggest = m; } });
  if (!biggest) return msgs;
  const cut = (t) => { const keep = Math.max(2000, t.length - over - 200); const half = Math.floor(keep / 2); return t.slice(0, half) + '\n\n[…]\n\n' + t.slice(t.length - half); };
  if (typeof biggest.content === 'string') biggest.content = cut(biggest.content); else { const c = biggest.content.find(x => x.text); c.text = cut(c.text); }
  return msgs;
}
app.post('/api/ai', auth, async (req, res) => {
  if (!AI_READY) return res.status(503).json({ code: 'unavailable', message: 'La IA no está configurada en el servidor (faltan las claves de Groq o Cloudflare).' });
  if (!limit('ai:' + req.uid, 80, 3600e3)) return res.status(429).json({ code: 'rate_limited', message: 'Has hecho muchas peticiones seguidas.' });
  const { messages, images, tier } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ code: 'bad_request', message: 'Faltan mensajes.' });
  if (JSON.stringify(messages).length > 400_000) return res.status(413).json({ code: 'prompt_too_large', message: 'Demasiado texto.' });
  const base = [];
  for (const m of messages.slice(-30)) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'; const content = String(m.content || '…');
    if (base.length && base[base.length - 1].role === role) base[base.length - 1].content += '\n\n' + content; else base.push({ role, content });
  }
  if (base[0].role !== 'user') base.unshift({ role: 'user', content: '…' });
  const imgs = Array.isArray(images) ? images.slice(0, 4).filter(i => i && /^image\/(png|jpeg|webp|gif)$/.test(i.media_type) && typeof i.data === 'string') : [];
  const providers = providersFor(tier, imgs.length > 0);
  const ctrl = new AbortController(); req.on('close', () => ctrl.abort());
  let lastErr = null;
  for (const p of providers) {
    let msgs = base.map(m => ({ role: m.role, content: m.content }));
    msgs = fitMessages(msgs, p.maxChars);
    if (imgs.length) {
      const last = msgs[msgs.length - 1];
      last.content = [{ type: 'text', text: last.content }].concat(imgs.map(i => ({ type: 'image_url', image_url: { url: `data:${i.media_type};base64,${i.data}` } })));
    }
    let upstream; const t0 = Date.now();
    const pc = new AbortController(); const onAbort = () => pc.abort(); ctrl.signal.addEventListener('abort', onAbort);
    const firstByte = setTimeout(() => pc.abort(), imgs.length ? 60000 : 90000);
    try {
      upstream = await fetch(p.url, {
        method: 'POST', signal: pc.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.key },
        body: JSON.stringify({ model: p.model, stream: true, max_tokens: p.maxTokens, temperature: 0.4, messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(msgs) })
      });
    } catch (e) { clearTimeout(firstByte); if (ctrl.signal.aborted) return res.end(); lastErr = { status: 504, text: String(e && e.message) }; console.error('IA', p.name, p.model, 'sin respuesta tras', Date.now() - t0, 'ms', imgs.length ? '(' + imgs.length + ' imágenes)' : ''); continue; }
    clearTimeout(firstByte);
    if (!upstream.ok) { const txt = await upstream.text().catch(() => ''); lastErr = { status: upstream.status, text: txt.slice(0, 500) }; console.error(p.name, upstream.status, lastErr.text);
      if (imgs.length && (upstream.status === 404 || /model_not_found|does not exist|not support/i.test(txt))) { if (p.name === 'groq') VISION.groq = null; else VISION.cf = null; checkVision().catch(() => {}); }
      continue; }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Accel-Buffering', 'no'); res.setHeader('X-Mnema-Provider', p.name);
    const reader = upstream.body.getReader(); const dec = new TextDecoder(); let buf = ''; let finish = '';
    try {
      outer: for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim(); if (data === '[DONE]') break outer;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          const ch = ev.choices && ev.choices[0]; if (!ch) { if (typeof ev.response === 'string') res.write(ev.response); continue; }
          const t = ch.delta && typeof ch.delta.content === 'string' ? ch.delta.content : ''; if (t) res.write(t);
          if (ch.finish_reason) finish = ch.finish_reason;
        }
      }
    } catch (e) { /* cliente cerró */ }
    if (finish === 'length') res.write('\u0000TRUNCATED');
    if (imgs.length) console.log('IA', p.name, p.model, imgs.length + ' imágenes', (Date.now() - t0) + ' ms');
    return res.end();
  }
  const st = lastErr && lastErr.status;
  const code = st === 429 ? 'rate_limited' : st === 413 ? 'prompt_too_large' : 'unavailable';
  res.status(st === 429 ? 429 : 502).json({ code, message: 'La IA devolvió un error' + (st ? ' (' + st + ')' : '') + '. Prueba de nuevo en un momento.' });
});

/* voces naturales para pódcast y lectura en voz alta (Cloudflare Workers AI · Deepgram Aura 2 en español) */
const TTS_MODEL = process.env.CLOUDFLARE_TTS_MODEL || '@cf/deepgram/aura-2-es';
const TTS_VOICES = { A: process.env.TTS_VOICE_A || 'carina', B: process.env.TTS_VOICE_B || 'alvaro' };
async function cfTTS(text, speaker) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${TTS_MODEL}`, {
    method: 'POST', headers: { authorization: 'Bearer ' + CF_API_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ text, speaker, encoding: 'mp3' })
  });
  const ct = String(r.headers.get('content-type') || '');
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('TTS ' + r.status + ' ' + t.slice(0, 300)); }
  if (ct.includes('application/json')) {
    const j = await r.json();
    const b64 = j && (j.result && (j.result.audio || j.result) || j.audio);
    if (typeof b64 !== 'string') throw new Error('TTS: respuesta sin audio ' + JSON.stringify(j).slice(0, 200));
    return { mime: 'audio/mpeg', data: Buffer.from(b64, 'base64') };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('TTS: audio vacío');
  return { mime: ct.startsWith('audio/') ? ct.split(';')[0] : 'audio/mpeg', data: buf };
}
app.post('/api/tts', auth, async (req, res) => {
  if (!HAS_CF) return res.status(503).json({ code: 'unavailable', message: 'Las voces naturales no están configuradas.' });
  const text = String(req.body.text || '').replace(/\s+/g, ' ').trim().slice(0, 1800);
  const voz = req.body.voz === 'B' ? 'B' : 'A';
  if (!text) return res.status(400).json({ code: 'bad_request', message: 'Falta el texto.' });
  const key = crypto.createHash('sha256').update(TTS_MODEL + '|' + TTS_VOICES[voz] + '|' + text).digest('hex');
  const hit = await pool.query('SELECT mime, data FROM tts_cache WHERE key=$1', [key]);
  if (hit.rows[0]) { res.setHeader('Content-Type', hit.rows[0].mime); res.setHeader('Cache-Control', 'private, max-age=31536000'); return res.end(hit.rows[0].data); }
  if (!limit('tts:' + req.uid, 600, 3600e3)) return res.status(429).json({ code: 'rate_limited', message: 'Has generado mucho audio seguido. Espera un poco.' });
  let out;
  try { out = await cfTTS(text, TTS_VOICES[voz]); }
  catch (e) { console.error(e.message); return res.status(502).json({ code: 'unavailable', message: 'No se pudo generar la voz.' }); }
  pool.query('INSERT INTO tts_cache (key, mime, data) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING', [key, out.mime, out.data]).catch(() => {});
  res.setHeader('Content-Type', out.mime); res.setHeader('Cache-Control', 'private, max-age=31536000'); res.end(out.data);
});

/* estáticos */
app.get('/sw.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Service-Worker-Allowed', '/'); res.sendFile(path.join(__dirname, 'public', 'sw.js')); });
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h', setHeaders: (res, file) => { if (/\.(html|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get('*', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.use((err, req, res, next) => { if (!err.expose) console.error(err); if (res.headersSent) return res.end(); res.status(err.status || 500).json({ error: err.expose ? err.message : err.status === 413 ? 'Archivo demasiado grande.' : 'Error del servidor. Inténtalo de nuevo.' }); });

migrate().then(() => app.listen(PORT, () => {
  console.log('Mnema escuchando en ' + PORT);
  checkVision().catch(e => console.error('visión', e));
  if (HAS_CF) cfTTS('Prueba de voz de Mnema.', TTS_VOICES.A).then(o => console.log('Voces naturales OK: ' + o.mime + ' ' + o.data.length + ' bytes')).catch(e => console.error('Voces naturales NO disponibles: ' + e.message));
})).catch(e => { console.error('No se pudo preparar la base de datos', e); process.exit(1); });
