/* Mnema · capa de servicios para la versión con cuentas.
   Imita la interfaz window.claude.use() que usa la app y la conecta con el servidor propio.
   También pinta la página de presentación para quien no ha iniciado sesión y gestiona la instalación como app. */
(function () {
  'use strict';
  let meP = null;
  function me(force) { if (!meP || force) meP = fetch('/api/me', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({ user: null, ai: false })); return meP; }

  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (r.status === 401 && !/^\/api\/(login|account)/.test(url)) throw { code: 'not_granted', message: 'Inicia sesión para continuar.' };
    if (r.status === 413) throw { code: 'quota_exceeded', message: 'Demasiado grande para guardarlo.' };
    if (!r.ok) throw { code: j.code || 'error', message: j.message || j.error || ('Error ' + r.status) };
    return j;
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
      async me() { return { id: user.id, name: user.displayName || user.username, avatarUrl: user.avatarUrl, isMe: true }; },
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

  /* ---- IA ---- */
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
    const images = [];
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

  /* ---- cuenta (para la sección Mi cuenta) ---- */
  window.mnemaAccount = Object.freeze({
    async get() { const m = await me(); return m.user; },
    async update(fields) { const u = await api('PATCH', '/api/account', fields); meP = Promise.resolve({ user: u, ai: (await me()).ai }); return u; },
    async password(current, password) { await api('POST', '/api/account/password', { current, password }); },
    async avatar(blob) { const a = await assets.upload(blob); return this.update({ avatar: a.url }); },
    async logout() { await api('POST', '/api/logout', {}); try { localStorage.removeItem('mnema.v1'); } catch (e) {} location.href = '/'; },
    async remove(password) { await api('POST', '/api/account/delete', { password }); try { localStorage.removeItem('mnema.v1'); } catch (e) {} location.href = '/'; }
  });

  /* ---- instalar como app ---- */
  let deferred = null;
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; document.dispatchEvent(new Event('mnema-install-change')); });
  window.addEventListener('appinstalled', () => { deferred = null; document.dispatchEvent(new Event('mnema-install-change')); });
  window.mnemaInstall = Object.freeze({
    installed: () => standalone(),
    available: () => !!deferred,
    platform: isIOS ? 'ios' : isAndroid ? 'android' : 'desktop',
    async prompt() { if (!deferred) return false; deferred.prompt(); const r = await deferred.userChoice.catch(() => null); deferred = null; document.dispatchEvent(new Event('mnema-install-change')); return !!(r && r.outcome === 'accepted'); },
    howTo() {
      if (isIOS) return 'En Safari, pulsa el botón Compartir (el cuadrado con la flecha) y elige «Añadir a pantalla de inicio».';
      if (isAndroid) return 'En Chrome, abre el menú ⋮ y elige «Instalar aplicación» o «Añadir a pantalla de inicio».';
      return 'En Chrome o Edge, pulsa el icono de instalar que aparece a la derecha de la barra de direcciones, o abre el menú y elige «Instalar Mnema».';
    }
  });
  if ('serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });

  /* ---- acceso: ventana de entrar / crear cuenta ---- */
  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function accountModal(mode) {
    const old = document.getElementById('authModal'); if (old) old.remove();
    const reg = mode === 'register';
    const wrap = el('<div class="modal" id="authModal"><div class="box" role="dialog" aria-modal="true" aria-labelledby="authT">' +
      '<h3 id="authT">' + (reg ? 'Crear tu cuenta' : 'Entrar en Mnema') + '</h3>' +
      '<form id="authForm" class="stack" style="gap:12px">' +
      (reg ? '<label class="lbl" for="aUser">Nombre de usuario<input type="text" id="aUser" autocomplete="username" required minlength="3" maxlength="30" placeholder="sin espacios"></label>' +
             '<label class="lbl" for="aMail">Correo (opcional)<input type="email" id="aMail" autocomplete="email" placeholder="tu@correo.com"></label>'
           : '<label class="lbl" for="aUser">Usuario o correo<input type="text" id="aUser" autocomplete="username" required></label>') +
      '<label class="lbl" for="aPass">Contraseña<input type="password" id="aPass" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" required minlength="6"></label>' +
      '<p id="authErr" class="status err" hidden></p>' +
      '<button type="submit" class="btn">' + (reg ? 'Crear cuenta' : 'Entrar') + '</button>' +
      '<p class="muted" style="margin:0;font-size:14px;text-align:center">' + (reg ? '¿Ya tienes cuenta? ' : '¿Aún no tienes cuenta? ') + '<button type="button" class="btn small ghost" id="authSwap">' + (reg ? 'Inicia sesión' : 'Créala gratis') + '</button></p>' +
      '</form></div></div>');
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
    wrap.querySelector('#authSwap').onclick = () => accountModal(reg ? 'login' : 'register');
    wrap.querySelector('#authForm').onsubmit = async e => {
      e.preventDefault(); const err = wrap.querySelector('#authErr'); err.hidden = true;
      const btn = wrap.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const body = { username: wrap.querySelector('#aUser').value, password: wrap.querySelector('#aPass').value };
        if (reg) body.email = wrap.querySelector('#aMail').value;
        await api('POST', reg ? '/api/register' : '/api/login', body); location.href = '/';
      } catch (x) { err.textContent = x.message || 'No se pudo completar.'; err.hidden = false; btn.disabled = false; }
    };
    setTimeout(() => wrap.querySelector('#aUser').focus(), 0);
  }

  /* ---- página de presentación ---- */
  const ICON = {
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
    map: '<circle cx="12" cy="12" r="3"/><circle cx="4" cy="5" r="2"/><circle cx="20" cy="5" r="2"/><circle cx="4" cy="19" r="2"/><circle cx="20" cy="19" r="2"/><path d="M6 6l4 4M18 6l-4 4M6 18l4-4M18 18l-4-4"/>',
    head: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1"/><rect x="17" y="14" width="4" height="6" rx="1"/>',
    cards: '<rect x="3" y="7" width="13" height="13" rx="2"/><path d="M8 4h11a2 2 0 0 1 2 2v11"/>',
    check: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12z"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    group: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5M15 15c3 0 6 1.5 6 4.5"/>'
  };
  const ic = (k) => '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[k] + '</svg>';
  const LOGO = '<svg width="34" height="34" viewBox="0 0 84 84" aria-hidden="true"><polyline points="14,66 14,18 42,50 70,18 70,66" fill="none" stroke="var(--anil)" stroke-width="8" stroke-linejoin="round" stroke-linecap="round"/><circle cx="14" cy="66" r="7.5" fill="var(--anil)"/><circle cx="14" cy="18" r="7.5" fill="var(--anil)"/><circle cx="70" cy="18" r="7.5" fill="var(--anil)"/><circle cx="70" cy="66" r="7.5" fill="var(--anil)"/><circle cx="42" cy="50" r="11" fill="var(--spark)"/></svg>';
  function landing() {
    const feats = [
      ['upload', 'Sube lo que tengas', 'PDF, Word, texto o fotos de tus apuntes. Hasta los PDF escaneados.'],
      ['doc', 'Resúmenes con lo esencial', 'Cada tema resumido con los conceptos clave resaltados y lo que más cae en el examen.'],
      ['map', 'Mapas mentales y tablas', 'Ve cómo se conectan las ideas y compara autores, etapas o tipos de un vistazo.'],
      ['head', 'Pódcast de repaso', 'Dos voces repasan el tema contigo para estudiar andando o en el bus.'],
      ['cards', 'Tarjetas que no se olvidan', 'Repetición espaciada: te pregunta cada concepto justo antes de que se te olvide.'],
      ['check', 'Tests y simulacros', 'Tipo test, verdadero/falso y preguntas de desarrollo corregidas con nota.'],
      ['chat', 'Un tutor que conoce tu temario', 'Te explica lo que no entiendes o te hace preguntas para que razones tú.'],
      ['cal', 'Un plan hasta el examen', 'Pon la fecha y Mnema reparte los temas cada día según lo que peor llevas.'],
      ['group', 'Estudia en grupo', 'Comparte tus temas con un código y competid en una clasificación.']
    ];
    const faqs = [
      ['¿Mis apuntes son privados?', 'Sí. Tu temario, tus tarjetas y tu progreso solo los ves tú. Solo se comparte lo que tú decidas compartir con un grupo, y nunca tus archivos originales.'],
      ['¿Qué archivos puedo subir?', 'PDF (también escaneados), Word (.docx), texto, Markdown y fotos de tus apuntes o de un libro. También puedes pegar texto directamente.'],
      ['¿Se inventa cosas?', 'Mnema trabaja solo con tu temario y cada tarjeta y pregunta indica el fragmento de tus apuntes del que sale. Aun así, revisa lo que no te cuadre: puedes editar cualquier tarjeta.'],
      ['¿Puedo tenerla como app en el móvil y en el ordenador?', 'Sí. Mnema se instala como una aplicación más, con su icono, en Android, iPhone, Windows y Mac. Al instalarla se abre en su propia ventana.'],
      ['¿Sirve para oposiciones, selectividad o la universidad?', 'Para cualquier examen con temario: oposiciones, selectividad, carrera, FP, idiomas o certificaciones.']
    ];
    const installBtn = '<button class="btn ghost" type="button" data-l="install" id="landInstall" hidden>Instalar la app</button>';
    return '<div class="land" id="landing">' +
      '<div class="land-top"><div class="wrap in"><div class="brand">' + LOGO + '<span class="word">mnema</span></div><button class="btn" type="button" data-l="login">Entrar</button></div></div>' +
      '<div class="wrap">' +
      '<section class="land-hero"><div><span class="eyebrow">Tu temario, tu forma de estudiar</span><h1 style="margin-top:10px">Sube tus apuntes. <em>Mnema hace el resto.</em></h1><p class="lead">Convierte tu propio temario en resúmenes, mapas mentales, pódcast, tarjetas y tests corregidos, con un tutor y un plan día a día hasta el examen.</p><div class="row"><button class="btn" type="button" data-l="register" style="min-height:48px;padding:12px 22px;font-size:16px">Crear cuenta gratis</button>' + installBtn + '</div></div>' +
      '<div class="demo" aria-label="Ejemplo de tarjeta de estudio"><div class="row" style="justify-content:space-between"><span class="chip">Tema 1 · La teoría celular</span><span class="chip spark">Para hoy</span></div><div class="q">¿Qué significa «omnis cellula e cellula» y quién lo propuso?</div><div class="a">Toda célula procede de otra célula. Lo propuso Virchow en 1855.</div><div class="faint" style="font-size:13px;font-style:italic">Del temario: «Virchow (1855) añadió el principio…»</div><div class="grades" style="max-width:none"><span class="btn g0" style="cursor:default">Otra vez</span><span class="btn g1" style="cursor:default">Difícil</span><span class="btn g2" style="cursor:default">Bien</span><span class="btn g3" style="cursor:default">Fácil</span></div></div></section>' +
      '<section><h2>Todo lo que necesitas para aprobar, sacado de tu temario</h2><div class="feat">' + feats.map(f => '<div class="f">' + ic(f[0]) + '<h3>' + f[1] + '</h3><p>' + f[2] + '</p></div>').join('') + '</div></section>' +
      '<section><h2>Cómo funciona</h2><div class="steps"><div class="s"><b class="n">1</b><h3>Crea tu asignatura</h3><p>Ponle nombre y la fecha del examen.</p></div><div class="s"><b class="n">2</b><h3>Sube tu temario</h3><p>Mnema lo lee y lo divide en temas con sus conceptos clave.</p></div><div class="s"><b class="n">3</b><h3>Estudia cada día</h3><p>Sigue el plan de hoy: resúmenes, tarjetas, tests y tutor, centrados en lo que peor llevas.</p></div></div></section>' +
      '<section class="faq"><h2>Preguntas frecuentes</h2><div style="margin-top:12px">' + faqs.map((q, i) => '<details' + (i === 0 ? ' open' : '') + '><summary>' + q[0] + '</summary><p>' + q[1] + '</p></details>').join('') + '</div></section>' +
      '<div class="land-cta"><h2>Empieza hoy con tu temario</h2><p style="margin:0;max-width:46ch;opacity:.9">Crea tu cuenta en un minuto y prueba con un tema.</p><button class="btn" type="button" data-l="register">Crear cuenta gratis</button></div>' +
      '<p class="foot" style="padding-bottom:24px">Mnema · App de estudio</p></div></div>';
  }
  function refreshInstallBtn() {
    const b = document.getElementById('landInstall'); if (!b) return;
    b.hidden = window.mnemaInstall.installed() || !window.mnemaInstall.available();
  }
  async function boot() {
    const m = await me();
    document.documentElement.classList.remove('booting');
    if (m.user) { document.body.classList.remove('locked'); return; }
    document.body.classList.add('locked');
    const node = el(landing()); document.body.insertBefore(node, document.body.firstChild);
    node.addEventListener('click', e => {
      const b = e.target.closest('[data-l]'); if (!b) return;
      if (b.dataset.l === 'login') accountModal('login');
      else if (b.dataset.l === 'register') accountModal('register');
      else if (b.dataset.l === 'install') window.mnemaInstall.prompt();
    });
    refreshInstallBtn(); document.addEventListener('mnema-install-change', refreshInstallBtn);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
