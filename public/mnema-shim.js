/* Mnema · capa de servicios para la versión independiente.
   Imita la interfaz window.claude.use() que usa la app y la conecta con el servidor propio. */
(function () {
  'use strict';
  let meP = null;
  function me() { if (!meP) meP = fetch('/api/me', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({ user: null, ai: false })); return meP; }

  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (r.status === 401) throw { code: 'not_granted', message: 'Inicia sesión para continuar.' };
    if (r.status === 413) throw { code: 'quota_exceeded', message: 'Demasiado grande para guardarlo.' };
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch (e) {} throw { code: j.code || 'unavailable', message: j.message || j.error || ('Error ' + r.status) }; }
    return r.json();
  }
  const snap = (id, body) => ({ id, exists: !!body, data: () => body || undefined });

  /* ---- db ---- */
  function makeDb(user) {
    function route(path) {
      const s = path.split('/');
      if (s[0] === 'data' && s[1] === 'users' && s[2] === user.id && s.length === 4) return { kind: 'doc', id: s[3] };
      if (s[0] === 'shared' && s.length === 2) return { kind: 'shared', code: s[1] };
      if (s[0] === 'shared' && s[2] === 'scores' && s.length === 4) return { kind: 'score', code: s[1], uid: s[3] };
      throw new TypeError('Ruta no admitida: ' + path);
    }
    function doc(path) {
      const r = route(path);
      return {
        path,
        async get() {
          if (r.kind === 'doc') { const all = await api('GET', '/api/docs'); const f = all.find(x => x.id === r.id); return snap(r.id, f && f.body); }
          if (r.kind === 'shared') { const j = await api('GET', '/api/shared/' + encodeURIComponent(r.code)); return snap(r.code, j.exists ? j.body : null); }
          const list = await api('GET', '/api/shared/' + encodeURIComponent(r.code) + '/scores'); const f = list.find(x => x.id === r.uid); return snap(r.uid, f && f.body);
        },
        async set(body) {
          if (r.kind === 'doc') return void await api('PUT', '/api/docs/' + encodeURIComponent(r.id), body);
          if (r.kind === 'shared') return void await api('PUT', '/api/shared/' + encodeURIComponent(r.code), body);
          return void await api('PUT', '/api/shared/' + encodeURIComponent(r.code) + '/scores', body);
        },
        async update(body) { const cur = await this.get(); return this.set(Object.assign({}, cur.data() || {}, body)); },
        async delete() { if (r.kind === 'doc') return void await api('DELETE', '/api/docs/' + encodeURIComponent(r.id)); }
      };
    }
    function collection(path) {
      const s = path.split('/'); let n = 1000;
      const q = {
        path, limit(x) { n = x; return q; }, where() { return q; }, orderBy() { return q; },
        doc(id) { return doc(path + '/' + id); },
        async get() {
          let rows;
          if (s[0] === 'data' && s[1] === 'users' && s.length === 3) rows = await api('GET', '/api/docs');
          else if (s[0] === 'shared' && s[2] === 'scores' && s.length === 3) rows = await api('GET', '/api/shared/' + encodeURIComponent(s[1]) + '/scores');
          else throw new TypeError('Colección no admitida: ' + path);
          const docs = rows.slice(0, n).map(x => snap(x.id, x.body));
          return { docs, size: docs.length, empty: !docs.length };
        }
      };
      return q;
    }
    return Object.freeze({ doc, collection });
  }

  /* ---- user ---- */
  function makeUser(user) {
    return Object.freeze({
      async id() { return user.id; },
      async me() { return { id: user.id, name: user.username, isMe: true }; },
      async isOwner() { return true; }, async canEdit() { return true; }, async can() { return true; },
      async profiles(ids) { try { return await api('GET', '/api/profiles?ids=' + encodeURIComponent(ids.join(','))); } catch (e) { return {}; } }
    });
  }

  /* ---- assets ---- */
  const assets = Object.freeze({
    async upload(blob) {
      const r = await fetch('/api/assets', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob });
      if (!r.ok) { let j = {}; try { j = await r.json(); } catch (e) {} throw { code: 'upload_failed', message: j.error || 'No se pudo subir la imagen.' }; }
      return r.json();
    }
  });

  /* ---- downloads ---- */
  const downloads = Object.freeze({
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename || 'mnema.txt';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); return 'saved';
    }
  });

  /* ---- sample (Claude) ---- */
  function blobToB64(blob) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); }); }
  function shrink(blob, max) {
    return new Promise((res) => {
      if (blob.size < 3.5e6 && /jpeg|png|webp/.test(blob.type)) return res(blob);
      const img = new Image(); const u = URL.createObjectURL(blob);
      img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k); const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(u); cv.toBlob(b => res(b || blob), 'image/jpeg', 0.85); };
      img.onerror = () => res(blob); img.src = u;
    });
  }
  async function sample(input, opts) {
    opts = opts || {};
    const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input.map(m => ({ role: m.role, content: String(m.content || '') }));
    let images = [];
    if (opts.images) { const arr = Array.from(opts.images instanceof Blob ? [opts.images] : opts.images).slice(0, 4); for (const b of arr) { const s = await shrink(b, 1600); images.push({ media_type: s.type || 'image/jpeg', data: await blobToB64(s) }); } }
    const r = await fetch('/api/ai', { method: 'POST', credentials: 'same-origin', signal: opts.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, images, tier: opts.modelTier || 'default' }) });
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch (e) {} if (r.status === 401) throw { code: 'not_granted', message: 'Inicia sesión para usar la IA.' }; throw { code: j.code || 'unavailable', message: j.message || ('Error ' + r.status) }; }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let text = ''; let truncated = false;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      let delta = dec.decode(value, { stream: true });
      if (delta.includes('\u0000TRUNCATED')) { truncated = true; delta = delta.replace('\u0000TRUNCATED', ''); }
      if (!delta) continue; text += delta;
      if (opts.onText) try { opts.onText({ text, delta }); } catch (e) {}
    }
    return { text, truncated, modelTierApplied: opts.modelTier || 'default' };
  }
  function parseJSON(t) {
    try { return JSON.parse(t); } catch (e) {}
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch (e) {} }
    const a = t.search(/[\[{]/); const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    return undefined;
  }
  sample.json = async function (input, opts) {
    const extra = '\n\nIMPORTANTE: tu respuesta será leída por un programa. Responde únicamente con el JSON pedido, sin texto antes ni después.';
    const inp = typeof input === 'string' ? input + extra : input.map((m, i) => i === input.length - 1 ? { role: m.role, content: m.content + extra } : m);
    const r = await sample(inp, opts); const v = parseJSON(r.text);
    if (v === undefined || r.truncated) throw { code: 'invalid_json', message: 'Respuesta incompleta', text: r.text };
    return v;
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 4, maxInputBytes: 12e6, mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } });

  /* ---- punto de entrada ---- */
  window.claude = Object.freeze({
    async use(name) {
      if (name === 'downloads') return downloads;
      const m = await me(); if (!m.user) return null;
      if (name === 'db') return makeDb(m.user);
      if (name === 'user') return makeUser(m.user);
      if (name === 'assets') return assets;
      if (name === 'sample') return m.ai ? sample : null;
      return null;
    }
  });

  /* ---- cuenta: botón y ventana de acceso ---- */
  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function accountModal(mode) {
    const wrap = el('<div class="modal" id="authModal"><div class="box" role="dialog" aria-modal="true" aria-labelledby="authT">' +
      '<h3 id="authT">' + (mode === 'login' ? 'Entrar en Mnema' : 'Crear tu cuenta') + '</h3>' +
      '<p class="muted" style="margin:0;font-size:14px">' + (mode === 'login' ? 'Tu temario, tarjetas y progreso te esperan en cualquier dispositivo.' : 'Con una cuenta guardas tu progreso en la nube, usas la IA y estudias en grupo.') + '</p>' +
      '<form id="authForm" class="stack" style="gap:12px"><label class="lbl" for="aUser">Nombre de usuario<input type="text" id="aUser" autocomplete="username" required minlength="3" maxlength="30"></label>' +
      '<label class="lbl" for="aPass">Contraseña<input type="password" id="aPass" autocomplete="' + (mode === 'login' ? 'current-password' : 'new-password') + '" required minlength="6"></label>' +
      '<p id="authErr" class="status err" hidden></p>' +
      '<div class="row" style="justify-content:space-between"><button type="button" class="btn ghost small" id="authSwap">' + (mode === 'login' ? 'Crear una cuenta' : 'Ya tengo cuenta') + '</button><div class="row"><button type="button" class="btn ghost" id="authCancel">Cancelar</button><button type="submit" class="btn">' + (mode === 'login' ? 'Entrar' : 'Crear cuenta') + '</button></div></div></form></div></div>');
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    wrap.querySelector('#authCancel').onclick = close;
    wrap.querySelector('#authSwap').onclick = () => { close(); accountModal(mode === 'login' ? 'register' : 'login'); };
    wrap.querySelector('#authForm').onsubmit = async e => {
      e.preventDefault(); const err = wrap.querySelector('#authErr'); err.hidden = true;
      try { await api('POST', mode === 'login' ? '/api/login' : '/api/register', { username: wrap.querySelector('#aUser').value, password: wrap.querySelector('#aPass').value }); location.reload(); }
      catch (x) { err.textContent = x.message || 'No se pudo completar.'; err.hidden = false; }
    };
    setTimeout(() => wrap.querySelector('#aUser').focus(), 0);
  }
  async function mountAccount() {
    const host = document.querySelector('.subj'); if (!host) return;
    const m = await me();
    const btn = el('<button class="btn small ghost" type="button" id="acctBtn"></button>');
    if (m.user) { btn.textContent = 'Salir (' + m.user.username + ')'; btn.onclick = async () => { await api('POST', '/api/logout', {}); localStorage.removeItem('mnema.v1'); location.reload(); }; }
    else { btn.textContent = 'Entrar'; btn.className = 'btn small'; btn.onclick = () => accountModal('login'); }
    host.appendChild(btn);
    if (!m.user && !sessionStorage.getItem('mnema.hint')) {
      sessionStorage.setItem('mnema.hint', '1');
      const t = document.getElementById('toast'); if (t) { t.textContent = 'Entra o crea una cuenta para usar la IA y guardar tu progreso en la nube.'; t.hidden = false; setTimeout(() => { t.hidden = true; }, 6000); }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAccount); else mountAccount();
  window.MNEMA_LOGIN = () => accountModal('login');
})();
