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

async function migrate() {
  const sql = [
    `CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, username text UNIQUE NOT NULL, pass text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS docs (user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, doc_id text NOT NULL, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, doc_id))`,
    `CREATE TABLE IF NOT EXISTS shared (code text PRIMARY KEY, owner text NOT NULL REFERENCES users(id) ON DELETE CASCADE, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS scores (code text NOT NULL REFERENCES shared(code) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (code, user_id))`,
    `CREATE TABLE IF NOT EXISTS assets (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, mime text NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`
  ];
  for (const q of sql) await pool.query(q);
}

/* ---------- sesiones ---------- */
const COOKIE = 'mnema_s';
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
function makeToken(uid) { const exp = Date.now() + 1000 * 60 * 60 * 24 * 60; const v = uid + '.' + exp; return v + '.' + sign(v); }
function readToken(t) {
  if (!t) return null; const parts = t.split('.'); if (parts.length !== 3) return null;
  const v = parts[0] + '.' + parts[1]; const sig = parts[2]; const good = sign(v);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (Number(parts[1]) < Date.now()) return null; return parts[0];
}
function cookies(req) { const out = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); }); return out; }
function setSession(res, uid) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${uid ? makeToken(uid) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${uid ? 60 * 60 * 24 * 60 : 0}${secure}`);
}
function auth(req, res, next) { const uid = readToken(cookies(req)[COOKIE]); if (!uid) return res.status(401).json({ error: 'not_signed_in' }); req.uid = uid; next(); }

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

app.get('/healthz', (req, res) => res.send('ok'));

/* cuentas */
app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim(); const password = String(req.body.password || '');
  if (!/^[\p{L}\p{N}_.\- ]{3,30}$/u.test(username)) return res.status(400).json({ error: 'El nombre debe tener entre 3 y 30 letras o números.' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  if (!limit('reg:' + req.ip, 10, 3600e3)) return res.status(429).json({ error: 'Demasiados intentos. Prueba más tarde.' });
  const id = newId();
  try { await pool.query('INSERT INTO users (id, username, pass) VALUES ($1,$2,$3)', [id, username, hashPass(password)]); }
  catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Ese nombre ya está en uso.' }); throw e; }
  setSession(res, id); res.json({ id, username });
});
app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim(); const password = String(req.body.password || '');
  if (!limit('login:' + req.ip, 20, 600e3)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  const r = await pool.query('SELECT id, username, pass FROM users WHERE lower(username)=lower($1)', [username]);
  if (!r.rows[0] || !checkPass(password, r.rows[0].pass)) return res.status(401).json({ error: 'Nombre o contraseña incorrectos.' });
  setSession(res, r.rows[0].id); res.json({ id: r.rows[0].id, username: r.rows[0].username });
});
app.post('/api/logout', (req, res) => { setSession(res, null); res.json({ ok: true }); });
app.get('/api/me', async (req, res) => {
  const uid = readToken(cookies(req)[COOKIE]); if (!uid) return res.json({ user: null, ai: AI_READY });
  const r = await pool.query('SELECT id, username FROM users WHERE id=$1', [uid]);
  res.json({ user: r.rows[0] || null, ai: AI_READY });
});
app.get('/api/profiles', auth, async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 200);
  const r = ids.length ? await pool.query('SELECT id, username FROM users WHERE id = ANY($1)', [ids]) : { rows: [] };
  const out = {}; r.rows.forEach(u => { out[u.id] = { id: u.id, name: u.username }; }); res.json(out);
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
app.post('/api/assets', auth, express.raw({ type: ['image/*'], limit: '12mb' }), async (req, res) => {
  const mime = String(req.headers['content-type'] || '').split(';')[0];
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mime) || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Solo imágenes PNG, JPG, WEBP o GIF.' });
  const id = newId();
  await pool.query('INSERT INTO assets (id, user_id, mime, data) VALUES ($1,$2,$3,$4)', [id, req.uid, mime, req.body]);
  res.json({ id, url: '/a/' + id, sizeBytes: req.body.length, contentType: mime });
});
app.get('/a/:id', async (req, res) => {
  const r = await pool.query('SELECT mime, data FROM assets WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).end();
  res.setHeader('Content-Type', r.rows[0].mime); res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); res.end(r.rows[0].data);
});

/* IA (Groq + Cloudflare) */
const SYSTEM_PROMPT = 'Eres el asistente de estudio de la app Mnema. Responde siempre en español de España, con claridad. Sigue exactamente el formato que se te pida.';
function providersFor(tier, hasImages) {
  const groq = HAS_GROQ ? { name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: hasImages ? GROQ_VISION_MODEL : tier === 'quick' ? GROQ_MODEL_QUICK : GROQ_MODEL, maxTokens: 8000, maxChars: 380000 } : null;
  const cf = HAS_CF ? { name: 'cloudflare', url: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1/chat/completions`, key: CF_API_TOKEN, model: CF_MODEL, maxTokens: 4096, maxChars: 300000 } : null;
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
    let upstream;
    try {
      upstream = await fetch(p.url, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.key },
        body: JSON.stringify({ model: p.model, stream: true, max_tokens: p.maxTokens, temperature: 0.4, messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(msgs) })
      });
    } catch (e) { if (ctrl.signal.aborted) return res.end(); lastErr = { status: 502, text: String(e && e.message) }; console.error(p.name, 'fetch', lastErr.text); continue; }
    if (!upstream.ok) { const txt = await upstream.text().catch(() => ''); lastErr = { status: upstream.status, text: txt.slice(0, 500) }; console.error(p.name, upstream.status, lastErr.text); continue; }
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
    return res.end();
  }
  const st = lastErr && lastErr.status;
  const code = st === 429 ? 'rate_limited' : st === 413 ? 'prompt_too_large' : 'unavailable';
  res.status(st === 429 ? 429 : 502).json({ code, message: 'La IA devolvió un error' + (st ? ' (' + st + ')' : '') + '. Prueba de nuevo en un momento.' });
});

/* estáticos */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Error del servidor' }); });

migrate().then(() => app.listen(PORT, () => console.log('Mnema escuchando en ' + PORT))).catch(e => { console.error('No se pudo preparar la base de datos', e); process.exit(1); });
