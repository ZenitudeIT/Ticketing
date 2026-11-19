/* =========================================================
   ZENITUDE DESK — service desk for every team (IT, HR, …)
   ---------------------------------------------------------
   Plain JavaScript, no build step. Data and sign-in use the
   Firebase JS SDK (v10, compat) on project ticketing-de6b4:
     • Firebase Authentication (email + password)
     • Cloud Firestore: users, desks, tickets (+ comments, files), meta/counter
   A desk is a team (IT, HR, …) with its own categories, response
   targets, members, form fields and email address. Only a desk's
   members can see its tickets.
   Security is enforced by firestore.rules, not by this file.
   ========================================================= */
(function () {
  'use strict';

  const CFG = window.ZEN_DESK_FIREBASE_CONFIG;
  const OPT = Object.assign({ allowSignup: true, allowedEmailDomains: [] }, window.ZEN_DESK_OPTIONS || {});
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const ADMIN_EMAILS = (OPT.adminEmails || []).map((e) => String(e).trim().toLowerCase());
  const isAdminEmail = (e) => !!e && ADMIN_EMAILS.includes(String(e).toLowerCase());

  const STATUSES = ['Open', 'In Progress', 'On Hold', 'Resolved', 'Closed'];
  const ACTIVE = ['Open', 'In Progress', 'On Hold'];
  const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
  const SLA_HOURS = { Low: 72, Medium: 24, High: 8, Critical: 4 };   // default response targets for a new desk
  const IT_CATEGORIES = ['Hardware', 'Software', 'Network & Wi-Fi', 'Accounts & Access', 'Email', 'Phones & Mobile', 'Website', 'Printer', 'Other'];
  const ROLES = { user: 'Team member', tech: 'Team member', admin: 'Administrator' };   // 'tech' = older accounts
  const ROLE_CHOICES = { user: 'Team member', admin: 'Administrator' };
  const DEFAULT_DEPTS = ['Concierge', 'Operations', 'Front office', 'Sales & Marketing', 'Finance', 'HR', 'IT', 'Management'];
  const FIELD_TYPES = { text: 'Short text', textarea: 'Long text', number: 'Number', date: 'Date', select: 'Drop-down list', checkbox: 'Yes / no' };
  const FLOW = {
    'Open': ['In Progress', 'On Hold', 'Resolved'],
    'In Progress': ['On Hold', 'Resolved'],
    'On Hold': ['In Progress', 'Resolved'],
    'Resolved': ['Closed', 'In Progress'],
    'Closed': ['In Progress'],
  };
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const MAX_FILES = 5;               // screenshots per message
  const MAX_IMAGE_CHARS = 900000;    // compressed image (data URL) must fit in one Firestore document
  const EMPTY_FILTERS = () => ({ q: '', status: 'active', priority: '', assignee: '', category: '', desk: '', sort: 'updated' });
  const EMPTY_NT = () => ({ deskId: '', title: '', description: '', category: '', priority: 'Medium', requesterId: '', fields: {}, err: '' });

  let HR = null;   // HR module (hr.js): staff, leave, payroll — only for members of the HR desk

  /* ---------- state ---------- */
  const S = {
    phase: 'boot',            // boot | signed-out | profile | disabled | ready | error
    fatal: '',
    fb: null, auth: null, db: null,
    user: null,               // Firebase auth user
    me: null,                 // users/{uid} document + id
    users: {}, tickets: {}, ticketsLoaded: false, usersLoaded: false,
    desks: {}, desksLoaded: false, hrDeskId: '', org: null, tsub: {}, tq: {}, tqLoaded: {}, deskDraft: null, dashDesk: '', settingUp: false,
    comments: [], cTid: null, cLoaded: false, cErr: false, extra: {}, probe: {},
    files: [], pending: {}, attBusy: null,
    unsub: {},
    route: 'dashboard', modal: null, busy: false, registering: false, dataErr: '',
    f: EMPTY_FILTERS(),
    authTab: 'login',
    draft: {
      comment: {}, internal: {},
      nt: EMPTY_NT(),
      login: { email: '', p: '', err: '', info: '' },
      reg: { name: '', email: '', p: '', p2: '', err: '' },
      profile: { name: '', err: '' },
      nu: { name: '', email: '', role: 'user', department: '', p: '', err: '' }, newDept: '',
    },
  };

  /* ---------- helpers ---------- */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();
  const cls = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  const ref = (t) => 'ZEN-' + t.num;
  const isAdmin = () => !!S.me && S.me.role === 'admin' && S.me.active !== false;
  // Desks
  const deskId = (t) => (t && t.deskId) || 'it';
  const deskName = (id) => (S.desks[id] && S.desks[id].name) || (id === 'it' ? 'IT' : id);
  const byOrder = (a, b) => ((S.desks[a].order ?? 99) - (S.desks[b].order ?? 99)) || deskName(a).localeCompare(deskName(b));
  const allDeskIds = () => Object.keys(S.desks).sort(byOrder);
  const activeDesks = () => allDeskIds().filter((id) => S.desks[id].active !== false);
  const memberOf = (uid, id) => !!S.desks[id] && (S.desks[id].members || []).includes(uid);
  const isAgentOf = (id) => !!S.me && S.me.active !== false && memberOf(S.me.id, id);
  const myDeskIds = () => allDeskIds().filter(isAgentOf);
  const isAgent = () => myDeskIds().length > 0;
  const slaFor = (id, p) => { const d = S.desks[id], v = d && d.sla && Number(d.sla[p]); return v > 0 ? v : SLA_HOURS[p]; };
  const categoriesOf = (id) => { const c = S.desks[id] && S.desks[id].categories; return c && c.length ? c : (id === 'it' ? IT_CATEGORIES : ['General', 'Other']); };
  const byName = (a, b) => name(a).localeCompare(name(b));
  const agentsOf = (id) => ((S.desks[id] && S.desks[id].members) || []).filter((u) => S.users[u] && S.users[u].active !== false).sort(byName);
  const agentsOfMany = (ids) => [...new Set(ids.flatMap(agentsOf))].sort(byName);
  // Departments: the company list (set in HR settings) plus any already in use.
  const deptList = () => ((S.org && S.org.departments) || DEFAULT_DEPTS).slice();
  const deptOpts = (cur) => { const l = deptList(); if (cur && !l.includes(cur)) l.push(cur); return l; };
  const desksOfUser = (uid) => allDeskIds().filter((id) => memberOf(uid, id));
  const isOverdue = (t) => ACTIVE.includes(t.status) && t.dueAt && now() > t.dueAt;
  const resTime = (t) => (t.resolvedAt ? t.resolvedAt - t.createdAt : null);
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  function rel(ms) {
    if (!ms) return '—';
    const d = now() - ms, a = Math.abs(d);
    if (a < 60e3) return 'just now';
    const m = Math.round(a / 60e3);
    const s = m < 60 ? m + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd';
    return d > 0 ? s + ' ago' : 'in ' + s;
  }
  function dur(ms) {
    if (ms == null || isNaN(ms)) return '—';
    const h = ms / HOUR;
    if (h < 1) return Math.max(1, Math.round(ms / 60e3)) + 'm';
    if (h < 48) return Math.round(h * 10) / 10 + 'h';
    return Math.round((h / 24) * 10) / 10 + 'd';
  }
  function name(id) { if (!id) return 'Unassigned'; const u = S.users[id]; return u ? u.name || u.email || 'Unknown' : (S.me && id === S.me.id ? S.me.name : 'Unknown user'); }
  const initials = (id) => name(id).split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const ticketsArr = () => Object.entries(S.tickets).map(([id, t]) => Object.assign({}, t, { id }));
  const visibleTickets = () => ticketsArr();                                   // the queries only return what you may see
  const agentTickets = () => ticketsArr().filter((t) => isAgentOf(deskId(t)));  // tickets of desks you work on
  const staffList = () => agentsOfMany(myDeskIds());
  function setPath(path, v) { const ks = path.split('.'); let o = S; for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = {}; o = o[ks[i]]; } o[ks[ks.length - 1]] = v; }
  const pill = (kind, v) => `<span class="pill ${kind}-${cls(v)}"><i></i>${esc(v)}</span>`;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  function slaCell(t) {
    if (!t.dueAt) return '<span class="muted">—</span>';
    if (ACTIVE.includes(t.status)) {
      const left = t.dueAt - now(), win = slaFor(deskId(t), t.priority) * HOUR;
      if (left < 0) return `<span class="sla sla--bad" title="Due ${esc(fmtDate(t.dueAt))}">Overdue ${dur(-left)}</span>`;
      return `<span class="sla ${left < win * 0.25 ? 'sla--warn' : ''}" title="Due ${esc(fmtDate(t.dueAt))}">Due in ${dur(left)}</span>`;
    }
    if (t.resolvedAt) return t.resolvedAt <= t.dueAt ? '<span class="sla sla--good">Met</span>' : '<span class="sla sla--bad">Breached</span>';
    return '<span class="muted">—</span>';
  }
  const emailOk = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  function domainOk(e) {
    const list = (OPT.allowedEmailDomains || []).map((d) => String(d).toLowerCase().replace(/^@/, ''));
    return !list.length || list.includes(e.split('@')[1].toLowerCase());
  }

  /* ---------- toasts ---------- */
  let toasts = [];
  function toast(msg, kind) {
    const t = { msg, kind: kind || '' };
    toasts.push(t); drawToasts();
    setTimeout(() => { toasts = toasts.filter((x) => x !== t); drawToasts(); }, kind === 'error' ? 6500 : 3500);
  }
  function drawToasts() { document.getElementById('toasts').innerHTML = toasts.map((t) => `<div class="toast ${t.kind ? 'toast--' + t.kind : ''}" role="status">${esc(t.msg)}</div>`).join(''); }

  function authMsg(e) {
    const c = (e && e.code) || '';
    const map = {
      'auth/invalid-credential': 'Incorrect email or password.',
      'auth/invalid-login-credentials': 'Incorrect email or password.',
      'auth/wrong-password': 'Incorrect email or password.',
      'auth/user-not-found': 'Incorrect email or password.',
      'auth/invalid-email': 'That email address doesn\'t look right.',
      'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
      'auth/weak-password': 'Choose a stronger password (at least 6 characters).',
      'auth/too-many-requests': 'Too many attempts. Wait a few minutes, or reset your password.',
      'auth/network-request-failed': 'No connection to Firebase. Check your internet connection.',
      'auth/operation-not-allowed': 'Email/password sign-in isn\'t switched on yet (Firebase console → Authentication → Sign-in method).',
      'auth/user-disabled': 'This account has been disabled.',
      'auth/requires-recent-login': 'Please sign out and in again, then retry.',
    };
    return map[c] || (e && e.message) || 'Something went wrong.';
  }
  function dbMsg(e) {
    const c = (e && e.code) || '';
    if (c === 'permission-denied') return 'You don\'t have permission to do that. If this is new, check that firestore.rules has been deployed.';
    if (c === 'unavailable') return 'Firebase can\'t be reached right now. Your change wasn\'t saved.';
    if (c === 'resource-exhausted') return 'Firebase quota reached. Try again later.';
    return (e && e.message) || 'Couldn\'t save that change.';
  }
  const errText = (e) => dbMsg(e) + (e && e.code ? ' [' + e.code + ']' : '');
  const fail = (e) => { console.error('[Zenitude Desk]', e); toast(dbMsg(e), 'error'); };

  /* ---------- Firebase boot ---------- */
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
  }
  async function boot() {
    readRoute();
    if (!CFG || !CFG.apiKey) { S.phase = 'error'; S.fatal = 'Firebase isn\'t configured. Add your web config to firebase-config.js.'; return render(); }
    try {
      await loadScript(SDK + 'firebase-app-compat.js');
      await Promise.all(['auth', 'firestore', 'analytics'].map((p) => loadScript(SDK + `firebase-${p}-compat.js`).catch((e) => { if (p !== 'analytics') throw e; })));
    } catch (e) {
      S.phase = 'error'; S.fatal = 'Couldn\'t load Firebase. Check your internet connection and reload.'; return render();
    }
    const fb = window.firebase;
    if (!fb.apps.length) fb.initializeApp(CFG);
    S.fb = fb; S.auth = fb.auth(); S.db = fb.firestore();
    try { if (fb.analytics && (await fb.analytics.isSupported())) fb.analytics(); } catch (e) { /* analytics is optional */ }
    S.auth.onAuthStateChanged(onAuth);
  }

  function stopAll() {
    Object.values(S.unsub).forEach((u) => { try { u(); } catch (e) { } });
    Object.values(S.tsub).forEach((u) => { try { u(); } catch (e) { } });
    S.unsub = {}; S.tsub = {}; S.tq = {}; S.tqLoaded = {}; S.cTid = null; S.hrDeskId = ''; S.org = null;
    if (HR) HR.stop();
    S.users = {}; S.desks = {}; S.tickets = {}; S.comments = []; S.extra = {}; S.probe = {}; S.files = []; S.pending = {};
    S.ticketsLoaded = false; S.usersLoaded = false; S.desksLoaded = false; S.dataErr = ''; S.deskDraft = null; S.dashDesk = '';
  }
  function onAuth(user) {
    stopAll();
    S.user = user; S.me = null; S.modal = null; S.autoAdmin = false;
    if (!user) { S.phase = 'signed-out'; S.authTab = 'login'; return render(); }
    S.phase = 'boot'; render();
    S.unsub.me = S.db.collection('users').doc(user.uid).onSnapshot((d) => {
      if (!d.exists && isAdminEmail(user.email) && !S.registering) {
        // Main IT admin account (e.g. created in the Firebase console): set up its profile automatically.
        if (!S.autoAdmin) {
          S.autoAdmin = true;
          S.db.collection('users').doc(user.uid).set({ name: user.displayName || 'IT Administrator', email: user.email, role: 'admin', active: true, createdAt: now() })
            .catch((e) => { S.phase = 'error'; S.fatal = dbMsg(e); render(); });
        }
        S.phase = 'boot'; return render();
      }
      if (!d.exists) { S.me = null; S.phase = 'profile'; S.draft.profile.name = S.draft.profile.name || user.displayName || ''; return render(); }
      S.me = Object.assign({ id: user.uid }, d.data());
      if (isAdminEmail(user.email) && (S.me.role !== 'admin' || S.me.active === false) && !S.autoAdmin) {
        S.autoAdmin = true;
        S.db.collection('users').doc(user.uid).update({ role: 'admin', active: true }).catch(fail);
      }
      if (S.me.role === 'admin' && S.me.active !== false) S.autoAdmin = false;
      if (S.me.active === false) { S.phase = 'disabled'; stopData(); return render(); }
      S.phase = 'ready';
      startData(); syncTickets();
      render();
    }, (e) => { S.phase = 'error'; S.fatal = dbMsg(e); render(); });
  }
  function stopData() {
    if (HR) HR.stop();
    ['u', 'd', 'c', 'f', 'h', 'o'].forEach((k) => { if (S.unsub[k]) { S.unsub[k](); delete S.unsub[k]; } });
    Object.values(S.tsub).forEach((u) => { try { u(); } catch (e) { } });
    S.tsub = {}; S.tq = {}; S.tqLoaded = {}; S.cTid = null; S.ticketsLoaded = false;
  }
  function startData() {
    if (!S.unsub.u) {
      S.unsub.u = S.db.collection('users').onSnapshot((s) => {
        const o = {}; s.docs.forEach((d) => { o[d.id] = d.data(); }); S.users = o; S.usersLoaded = true; firstTimeSetup(); render();
      }, (e) => { console.error('[Zenitude Desk] users listener', e); S.dataErr = 'Team list couldn\'t load: ' + errText(e); render(); });
    }
    if (!S.unsub.d) {
      S.unsub.d = S.db.collection('desks').onSnapshot((s) => {
        const o = {}; s.docs.forEach((d) => { o[d.id] = d.data(); }); S.desks = o; S.desksLoaded = true;
        firstTimeSetup(); syncTickets(); prepareRoute(); if (HR) HR.sync(); render();
      }, (e) => { console.error('[Zenitude Desk] desks listener', e); S.dataErr = 'Desks couldn\'t load: ' + errText(e); S.desksLoaded = true; syncTickets(); render(); });
    }
    if (!S.unsub.h) {
      // Which desk runs the HR module (staff, leave, payroll). Set by an administrator on the Desks page.
      S.unsub.h = S.db.doc('meta/hr').onSnapshot((d) => { S.hrDeskId = (d.exists && d.data().deskId) || ''; if (HR) HR.sync(); prepareRoute(); render(); },
        (e) => { console.error('[Zenitude Desk] HR setting', e); });
    }
    if (!S.unsub.o) {
      // Company-wide lists everyone can read (departments).
      S.unsub.o = S.db.doc('meta/org').onSnapshot((d) => { S.org = d.exists ? d.data() : null; render(); }, (e) => { console.error('[Zenitude Desk] org settings', e); });
    }
    syncTickets();
  }
  // One live query for your own tickets, plus one per desk you're a member of.
  function syncTickets() {
    if (!S.desksLoaded || S.phase !== 'ready') return;
    const want = ['mine'].concat(myDeskIds().map((d) => 'desk:' + d));
    Object.keys(S.tsub).forEach((k) => { if (!want.includes(k)) { S.tsub[k](); delete S.tsub[k]; delete S.tq[k]; delete S.tqLoaded[k]; } });
    want.forEach((k) => {
      if (S.tsub[k]) return;
      S.tqLoaded[k] = false;
      const q = k === 'mine' ? S.db.collection('tickets').where('requesterId', '==', S.user.uid) : S.db.collection('tickets').where('deskId', '==', k.slice(5));
      S.tsub[k] = q.onSnapshot((s) => {
        const o = {}; s.docs.forEach((d) => { o[d.id] = d.data(); }); S.tq[k] = o; S.tqLoaded[k] = true; mergeTickets(); render();
      }, (e) => { console.error('[Zenitude Desk] tickets listener ' + k, e); S.dataErr = 'Tickets couldn\'t load: ' + errText(e); S.tqLoaded[k] = true; mergeTickets(); render(); });
    });
    mergeTickets();
  }
  function mergeTickets() {
    const o = {}; Object.values(S.tq).forEach((m) => Object.assign(o, m));
    S.tickets = o;
    S.ticketsLoaded = Object.keys(S.tsub).length > 0 && Object.keys(S.tsub).every((k) => S.tqLoaded[k]);
    Object.keys(S.extra).forEach((k) => { if (o[k]) delete S.extra[k]; });
    syncComments();
  }
  // First sign-in of an administrator after the desks update: create the IT desk
  // (existing technicians and admins become its members). The email script then
  // moves existing tickets into it.
  function firstTimeSetup() {
    if (!S.desksLoaded || !S.usersLoaded || S.settingUp || !isAdmin() || Object.keys(S.desks).length) return;
    S.settingUp = true;
    const members = [...new Set(Object.entries(S.users).filter(([, u]) => (u.role === 'tech' || u.role === 'admin') && u.active !== false).map(([id]) => id).concat([S.me.id]))];
    S.db.collection('desks').doc('it').set({
      name: 'IT', description: 'Computers, accounts, email, Wi-Fi, phones, printers and software.',
      email: ADMIN_EMAILS[0] || '', active: true, categories: IT_CATEGORIES, sla: Object.assign({}, SLA_HOURS), members, fields: [], order: 1,
      log: [{ at: now(), by: S.me.id, text: 'created the IT desk' }], updatedAt: now(), updatedBy: S.me.id,
    }).then(() => toast('Desks are on. Your existing setup is now the IT desk.')).catch((e) => { S.settingUp = false; fail(e); });
  }
  function syncComments() {
    const id = S.phase === 'ready' && S.route.startsWith('ticket-') ? S.route.slice(7) : null;
    const t = id && (S.tickets[id] || S.extra[id]);
    const agent = !!t && isAgentOf(deskId(t));
    const key = id ? id + '|' + agent : null;
    if (key === S.cTid) return;
    if (S.unsub.c) { S.unsub.c(); delete S.unsub.c; }
    if (S.unsub.f) { S.unsub.f(); delete S.unsub.f; }
    S.cTid = key; S.comments = []; S.cLoaded = false; S.cErr = false; S.files = [];
    if (!id) return;
    let fq = S.db.collection('tickets').doc(id).collection('files');
    if (!agent) fq = fq.where('internal', '==', false);
    S.unsub.f = fq.onSnapshot((s) => {
      S.files = s.docs.map((d) => Object.assign({ id: d.id }, d.data())).sort((a, b) => a.at - b.at); render();
    }, (e) => console.error('[Zenitude Desk] files listener', e));
    if (!t) probeTicket(id);
    let q = S.db.collection('tickets').doc(id).collection('comments');
    if (!agent) q = q.where('internal', '==', false);
    S.unsub.c = q.onSnapshot((s) => {
      S.comments = s.docs.map((d) => Object.assign({ id: d.id }, d.data())).sort((a, b) => a.at - b.at);
      S.cLoaded = true; render();
    }, () => { S.cLoaded = true; S.cErr = true; render(); });
  }

  /* ---------- screenshots ---------- */
  // Images are shrunk and compressed in the browser, then stored in Firestore
  // (free plan friendly): tickets/{id}/files/{fid} holds a small preview,
  // tickets/{id}/files/{fid}/content/full holds the full image.
  function loadImg(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('this image could not be read')); };
      img.src = url;
    });
  }
  function toJpeg(img, maxDim, quality) {
    const r = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * r)), h = Math.max(1, Math.round(img.naturalHeight * r));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0, w, h);
    return { data: c.toDataURL('image/jpeg', quality), w, h };
  }
  async function prepareImage(file) {
    if (file.size > 25e6) throw new Error('larger than 25 MB');
    const img = await loadImg(file);
    let dim = 2000, q = 0.85, out = toJpeg(img, dim, q);
    while (out.data.length > MAX_IMAGE_CHARS && dim > 600) { if (q > 0.6) q -= 0.1; else dim = Math.round(dim * 0.8); out = toJpeg(img, dim, q); }
    if (out.data.length > MAX_IMAGE_CHARS) throw new Error('too large, even after compressing');
    let th = toJpeg(img, 360, 0.7); if (th.data.length > 70000) th = toJpeg(img, 220, 0.6);
    const base = (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name) ? file.name.replace(/\.[a-z0-9]+$/i, '') : 'screenshot-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'));
    return { id: 'p' + Math.random().toString(36).slice(2, 10), name: (base.slice(0, 140) + '.jpg'), full: out.data, thumb: th.data, width: out.w, height: out.h, size: Math.round(out.data.length * 0.75) };
  }
  async function addFiles(key, fileList) {
    const imgs = [...(fileList || [])].filter((f) => /^image\//.test(f.type));
    if (!imgs.length) { toast('Only images (PNG, JPG, screenshots) can be attached.', 'error'); return; }
    const list = (S.pending[key] = S.pending[key] || []);
    const room = MAX_FILES - list.length;
    if (room <= 0) { toast('You can attach up to ' + MAX_FILES + ' screenshots at a time.', 'error'); return; }
    S.attBusy = key; render();
    for (const f of imgs.slice(0, room)) {
      try { list.push(await prepareImage(f)); } catch (e) { toast((f.name || 'Image') + ': ' + e.message + '.', 'error'); }
    }
    if (imgs.length > room) toast('Only the first ' + MAX_FILES + ' screenshots were added.');
    S.attBusy = null; render();
  }
  // Adds the screenshot documents to a batch; returns their ids.
  function addFileWrites(batch, tid, list, internal, commentId) {
    return list.map((p) => {
      const ref = S.db.collection('tickets').doc(tid).collection('files').doc();
      batch.set(ref, { by: S.user.uid, at: now(), name: p.name, type: 'image/jpeg', width: p.width, height: p.height, size: p.size, internal: !!internal, commentId: commentId || null, thumb: p.thumb });
      batch.set(ref.collection('content').doc('full'), { data: p.full });
      return ref.id;
    });
  }
  function attachBox(key, disabled) {
    const list = S.pending[key] || [];
    return `<div class="att" data-drop="${esc(key)}">
      ${list.length ? `<div class="thumbs">${list.map((p) => `<div class="thumb"><img src="${esc(p.thumb)}" alt="${esc(p.name)}"><button type="button" class="thumb__x" data-act="unattach" data-key="${esc(key)}" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button></div>`).join('')}</div>` : ''}
      <div class="att__row">
        <label class="btn btn--ghost btn--sm att__btn ${disabled || list.length >= MAX_FILES ? 'is-off' : ''}">${icon('image')} Add screenshots<input type="file" accept="image/*" multiple data-attach="${esc(key)}" ${disabled ? 'disabled' : ''}></label>
        <span class="hint" style="margin:0">${S.attBusy === key ? 'Preparing image…' : `or paste (Ctrl+V) or drag images here · up to ${MAX_FILES}`}</span>
      </div></div>`;
  }
  function gallery(tid, list) {
    if (!list.length) return '';
    return `<div class="gallery">${list.map((f) => `<button type="button" class="shot" data-act="view-file" data-tid="${esc(tid)}" data-id="${esc(f.id)}" title="${esc(f.name)}">
      ${f.thumb ? `<img src="${esc(f.thumb)}" alt="${esc(f.name)}">` : `<span class="shot__ph">${icon('image')}<small>${esc(f.name)}</small></span>`}</button>`).join('')}</div>`;
  }
  function dataUrlToBlob(u) {
    const [head, b64] = u.split(','), type = (/data:([^;]+)/.exec(head) || [])[1] || 'image/jpeg';
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type });
  }
  async function openFile(tid, fid) {
    const f = S.files.find((x) => x.id === fid); if (!f) return;
    S.modal = { type: 'file', tid, fid, name: f.name, by: f.by, url: null, err: '' }; render();
    try {
      const d = await S.db.collection('tickets').doc(tid).collection('files').doc(fid).collection('content').doc('full').get();
      if (!S.modal || S.modal.fid !== fid) return;
      if (!d.exists) { S.modal.err = 'This screenshot is no longer available.'; return render(); }
      S.modal.url = URL.createObjectURL(dataUrlToBlob(d.data().data)); render();
    } catch (e) { if (S.modal && S.modal.fid === fid) { S.modal.err = dbMsg(e); render(); } }
  }
  function closeModal() { if (S.modal && S.modal.url) URL.revokeObjectURL(S.modal.url); S.modal = null; render(); }

  // Read one ticket directly when it isn't in the live list (just created, or the list failed to load).
  function probeTicket(id) {
    if (S.probe[id] && S.probe[id].state === 'loading') return;
    S.probe[id] = { state: 'loading' };
    S.db.collection('tickets').doc(id).get().then((d) => {
      if (d.exists) { S.extra[id] = d.data(); S.probe[id] = { state: 'ok' }; syncComments(); }
      else S.probe[id] = { state: 'missing' };
      render();
    }).catch((e) => { console.error('[Zenitude Desk] ticket read', e); S.probe[id] = { state: 'error', msg: errText(e) }; render(); });
  }

  /* ---------- routing ---------- */
  function readRoute() { S.route = (location.hash || '').replace(/^#\/?/, '') || 'dashboard'; }
  function go(r) { if ((location.hash || '').slice(1) === r) { readRoute(); prepareRoute(); syncComments(); render(); } else location.hash = r; window.scrollTo(0, 0); }
  window.addEventListener('hashchange', () => { readRoute(); S.modal = null; prepareRoute(); syncComments(); render(); window.scrollTo(0, 0); });
  // Desk editor: make an editable copy of the desk when you open it.
  function prepareRoute() {
    const r = S.route;
    if (HR) HR.prepare(r);
    if (r !== 'desk-new' && !(r.startsWith('desk-') && r !== 'desks')) { S.deskDraft = null; return; }
    if (!S.me) return;
    const id = r === 'desk-new' ? null : r.slice(5);
    if (S.deskDraft && S.deskDraft.id === id) return;
    if (id && !S.desks[id]) { S.deskDraft = null; return; }
    const d = id ? JSON.parse(JSON.stringify(S.desks[id])) : { name: '', description: '', email: '', active: true, categories: ['General', 'Other'], sla: Object.assign({}, SLA_HOURS), members: [S.me.id], fields: [] };
    S.deskDraft = {
      id, name: d.name || '', description: d.description || '', email: d.email || '', active: d.active !== false,
      categories: (d.categories || []).slice(), newCat: '', sla: Object.assign({}, SLA_HOURS, d.sla || {}), members: (d.members || []).slice(), q: '',
      fields: (d.fields || []).map((f) => Object.assign({}, f, { optionsText: (f.options || []).join(', ') })), err: '',
      isHR: !!id && S.hrDeskId === id,
    };
  }

  /* ---------- render ---------- */
  // Re-render safely: a redraw can make a focused box lose focus, which fires its
  // change event and asks for another redraw; queue that one instead of nesting it.
  let rendering = false, renderAgain = false;
  function render() {
    if (rendering) { renderAgain = true; return; }
    rendering = true;
    try { draw(); } finally { rendering = false; }
    if (renderAgain) { renderAgain = false; render(); }
  }
  function draw() {
    const app = document.getElementById('app');
    const ae = document.activeElement, fid = ae && ae.id;
    let sel = null;
    try { if (fid && typeof ae.selectionStart === 'number') sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) { }
    const y = window.scrollY;
    app.innerHTML = view();
    if (fid) { const el = document.getElementById(fid); if (el) { el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { } } }
    if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
  }
  function view() {
    if (S.phase === 'boot') return `<div class="boot"><img src="assets/img/emblem-gold.png" alt="Loading" class="boot__emblem"></div>`;
    if (S.phase === 'error') return authFrame(`<h1 class="auth__title">Something's not right</h1><p class="auth__sub">${esc(S.fatal)}</p><button class="btn btn--primary btn--full" data-act="reload">Reload</button>`);
    if (S.phase === 'signed-out') return authView();
    if (S.phase === 'profile') return S.registering ? `<div class="boot"><img src="assets/img/emblem-gold.png" alt="Loading" class="boot__emblem"></div>` : profileView();
    if (S.phase === 'disabled') return authFrame(`<h1 class="auth__title">Access paused</h1><p class="auth__sub">Your Zenitude Desk account has been disabled. Please contact your administrator.</p><button class="btn btn--ghost btn--full" data-act="logout">Sign out</button>`);
    if (!S.ticketsLoaded || !S.usersLoaded || !S.desksLoaded) return shell(`<div class="empty"><img src="assets/img/emblem-gold.png" alt="">Loading tickets…</div>`);
    return shell(content()) + modalView();
  }
  function authFrame(inner, foot) {
    return `<div class="auth"><div style="width:min(430px,100%)"><div class="auth__box"><div class="auth__brand"><img src="assets/img/emblem-gold.png" alt=""><span>ZENITUDE</span></div>${inner}</div>
      <p class="auth__foot">${foot || 'Zenitude Desk · service desk'}</p></div></div>`;
  }

  function shell(inner) {
    const r = S.route;
    const vis = visibleTickets();
    const act = vis.filter((t) => ACTIVE.includes(t.status)).length;
    const links = [['dashboard', 'Overview', 'grid'], ['tickets', isAgent() ? 'Tickets' : 'My tickets', 'list', act], ['new', 'New ticket', 'plus']];
    if (HR) links.push(...HR.selfLinks());
    if (isAdmin()) links.push(['desks', 'Desks', 'desk'], ['users', 'Team & roles', 'users']);
    const on = (k) => (r === k || (k === 'tickets' && r.startsWith('ticket-')) || (k === 'desks' && r.startsWith('desk-')) || (HR && HR.navOn(k, r)) ? 'on' : '');
    const hrLinks = HR ? HR.links() : [];
    const link = ([k, l, ic, c]) => `<a class="side__link ${on(k)}" href="#${k}">${icon(ic)}<span>${l}</span>${c ? `<span class="badge">${c}</span>` : ''}</a>`;
    const mine = myDeskIds();
    const roleLabel = isAdmin() ? 'Administrator' : mine.length ? mine.map(deskName).join(' · ') + ' desk' : 'Team member';
    return `<div class="layout">
      <aside class="side">
        <a class="side__brand" href="#dashboard"><img src="assets/img/emblem-gold.png" alt=""><div><strong>ZENITUDE</strong><small>Service Desk</small></div></a>
        <nav class="side__nav"><div class="side__label">Menu</div>
          ${links.map(link).join('')}
          ${hrLinks.length ? `<div class="side__label" style="margin-top:1rem">HR</div>${hrLinks.map(link).join('')}` : ''}
        </nav>
        <div class="side__foot">${mine.length ? 'Your desks: ' + esc(mine.map(deskName).join(', ')) : 'Zenitude Desk'}<br>${isAdmin() ? 'You manage desks and people' : 'Service desk'}</div>
      </aside>
      <div class="main">
        <header class="top">
          <div class="who">
            <div class="avatar ${isAgent() ? 'avatar--gold' : ''}">${esc(initials(S.me.id))}</div>
            <div class="who__text"><div class="who__name">${esc(S.me.name)}</div><div class="who__mail">${esc(S.me.email || '')}</div></div>
            <span class="role" title="${esc(roleLabel)}">${esc(roleLabel)}</span>
            <button class="btn btn--ghost btn--sm" data-act="chpw">Password</button>
            <button class="btn btn--ghost btn--sm" data-act="logout">Sign out</button>
          </div>
        </header>
        <section class="content">
          ${S.dataErr ? `<div class="banner banner--bad">${esc(S.dataErr)}</div>` : ''}
          ${inner}
        </section>
      </div></div>`;
  }
  function content() {
    const r = S.route;
    if (HR && HR.owns(r)) return HR.view(r);
    if (r === 'tickets') return ticketsView();
    if (r === 'new') return newTicketView();
    if (r === 'users') return isAdmin() ? usersView() : denied();
    if (r === 'desks') return isAdmin() ? desksView() : denied();
    if (r.startsWith('desk-')) return isAdmin() ? deskEditor() : denied();
    if (r.startsWith('ticket-')) return ticketView(r.slice(7));
    return isAgent() ? staffDash() : userDash();
  }
  const denied = () => `<div class="panel empty">You don't have access to this page.</div>`;

  /* ---------- dashboards ---------- */
  function stats(list) {
    const active = list.filter((t) => ACTIVE.includes(t.status));
    const resolved = list.filter((t) => t.resolvedAt);
    const avg = resolved.length ? resolved.reduce((s, t) => s + resTime(t), 0) / resolved.length : null;
    const met = resolved.filter((t) => t.resolvedAt <= t.dueAt).length;
    return {
      active, resolved, avg,
      unassigned: active.filter((t) => !t.assigneeId).length,
      overdue: active.filter(isOverdue).length,
      resolved7: resolved.filter((t) => t.resolvedAt >= now() - 7 * DAY).length,
      slaPct: resolved.length ? Math.round((met / resolved.length) * 100) : null,
    };
  }
  const kpi = (k, v, s, alert) => `<div class="panel kpi ${alert ? 'alert' : ''}"><div class="kpi__k">${k}</div><div class="kpi__v">${v}</div><div class="kpi__s">${s || '&nbsp;'}</div></div>`;
  function bars(items, key) {
    const max = Math.max(1, ...items.map((i) => i[1]));
    return `<div class="bars">${items.map(([label, v]) => `<button class="bar" data-act="drill" data-k="${key}" data-v="${esc(label)}" title="${esc(label)}: ${v} ticket${v === 1 ? '' : 's'}. Click to view.">
      <span class="bar__l">${esc(label)}</span><span class="bar__t"><span class="bar__f" style="width:${((v / max) * 100).toFixed(1)}%"></span></span><span class="bar__v">${v}</span></button>`).join('')}</div>`;
  }
  function createdChart(list) {
    const days = 14, start = new Date(); start.setHours(0, 0, 0, 0);
    const s0 = start.getTime() - (days - 1) * DAY;
    const counts = Array(days).fill(0);
    list.forEach((t) => { const i = Math.floor((t.createdAt - s0) / DAY); if (i >= 0 && i < days) counts[i]++; });
    const max = Math.max(1, ...counts);
    const lbl = (i) => new Date(s0 + i * DAY).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const tipPos = (i) => (i < 2 ? 'left:0;transform:none' : i > days - 3 ? 'left:auto;right:0;transform:none' : '');
    return `<div class="cols">${counts.map((c, i) => `<div class="col"><span class="col__tip" style="${tipPos(i)}">${esc(lbl(i))}: ${c} raised</span><div class="col__f" style="height:${((c / max) * 100).toFixed(1)}%;${c ? '' : 'opacity:.3'}"></div></div>`).join('')}</div>
      <div class="col-labels">${counts.map((c, i) => `<span>${i % 3 === 0 || i === days - 1 ? esc(lbl(i)) : ''}</span>`).join('')}</div>
      <div class="note">Busiest day: ${Math.max(...counts)} ticket${Math.max(...counts) === 1 ? '' : 's'}. Hover a column for its count.</div>`;
  }
  function staffDash() {
    const mine = myDeskIds();
    if (S.dashDesk && !mine.includes(S.dashDesk)) S.dashDesk = '';
    const desks = S.dashDesk ? [S.dashDesk] : mine;
    const all = agentTickets().filter((t) => desks.includes(deskId(t))), st = stats(all);
    const byStatus = ACTIVE.map((s) => [s, st.active.filter((t) => t.status === s).length]);
    const byPri = PRIORITIES.slice().reverse().map((p) => [p, st.active.filter((t) => t.priority === p).length]);
    const catCount = {}; all.forEach((t) => { catCount[t.category] = (catCount[t.category] || 0) + 1; });
    const byCat = Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const attention = st.active.filter((t) => isOverdue(t) || (!t.assigneeId && (t.priority === 'Critical' || t.priority === 'High'))).sort((a, b) => a.dueAt - b.dueAt).slice(0, 8);
    const techs = agentsOfMany(desks);
    const switcher = mine.length > 1 ? `<div class="seg" role="tablist">${[''].concat(mine).map((d) => `<button role="tab" class="${S.dashDesk === d ? 'on' : ''}" data-act="dash-desk" data-v="${esc(d)}">${d ? esc(deskName(d)) : 'All my desks'}</button>`).join('')}</div>` : '';
    return `<div class="head"><div class="grow"><div class="eyebrow">${esc(desks.map(deskName).join(' · '))} desk${desks.length === 1 ? '' : 's'}</div><h1>Overview</h1><p>Every ticket on ${desks.length === 1 ? 'the ' + esc(deskName(desks[0])) + ' desk' : 'your desks'}, live. Click a bar to open the matching list.</p></div>
      <button class="btn btn--ghost" data-act="export-all" ${all.length ? '' : 'disabled'}>${icon('download')} Export CSV</button>
      <a class="btn btn--primary" href="#new">${icon('plus')} New ticket</a></div>
    ${switcher}
    ${!all.length ? `<div class="banner banner--info">No tickets yet. Raise the first one with <b>New ticket</b>${isAdmin() ? ', or set up desks and people from <b>Desks</b> and <b>Team &amp; roles</b>' : ''}.</div>` : ''}
    <div class="kpis">
      ${kpi('Active', st.active.length, 'Open, in progress, on hold')}
      ${kpi('Unassigned', st.unassigned, 'Waiting for an owner', st.unassigned > 0)}
      ${kpi('Overdue', st.overdue, 'Past SLA target', st.overdue > 0)}
      ${kpi('Resolved · 7 days', st.resolved7, '')}
      ${kpi('Avg. resolution', st.avg == null ? '—' : dur(st.avg), 'Raised to resolved')}
      ${kpi('SLA met', st.slaPct == null ? '—' : st.slaPct + '%', st.resolved.length + ' resolved')}
    </div>
    <div class="grid2">
      <div class="panel"><div class="panel__h"><h2>Active by status</h2></div><div class="panel__b">${bars(byStatus, 'status')}</div></div>
      <div class="panel"><div class="panel__h"><h2>Active by priority</h2></div><div class="panel__b">${bars(byPri, 'priority')}</div></div>
      <div class="panel"><div class="panel__h"><h2>All tickets by category</h2></div><div class="panel__b">${byCat.length ? bars(byCat, 'category') : '<div class="muted small">No tickets yet.</div>'}</div></div>
      <div class="panel"><div class="panel__h"><h2>Raised, last 14 days</h2></div><div class="panel__b">${createdChart(all)}</div></div>
      <div class="panel span2"><div class="panel__h"><h2>Needs attention</h2><span class="small muted">Overdue, or high priority with no owner</span></div>
        <div class="panel__b panel__b--flush">${attention.length ? ticketTable(attention, true) : '<div class="empty">All calm. Nothing overdue, and every urgent ticket has an owner.</div>'}</div></div>
      <div class="panel span2"><div class="panel__h"><h2>Team workload</h2></div><div class="panel__b panel__b--flush"><div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Person</th><th>Active</th><th>Overdue</th><th>Resolved</th><th>Avg. resolution</th><th>SLA met</th></tr></thead>
        <tbody>${techs.map((id) => { const s = stats(all.filter((t) => t.assigneeId === id));
          return `<tr class="click" data-act="drill" data-k="assignee" data-v="${esc(id)}"><td><div class="row"><div class="avatar avatar--gold">${esc(initials(id))}</div><div><div class="ttl">${esc(name(id))}</div><div class="sub">${esc(desksOfUser(id).filter((d) => desks.includes(d)).map(deskName).join(', '))} desk</div></div></div></td>
            <td>${s.active.length}</td><td>${s.overdue ? `<span class="sla sla--bad">${s.overdue}</span>` : '0'}</td><td>${s.resolved.length}</td><td>${s.avg == null ? '—' : dur(s.avg)}</td><td>${s.slaPct == null ? '—' : s.slaPct + '%'}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">Nobody works this desk yet. Add members on the Desks page.</td></tr>'}</tbody></table></div></div></div>
    </div>`;
  }
  function userDash() {
    const mine = visibleTickets(), st = stats(mine);
    const awaiting = mine.filter((t) => t.status === 'Resolved');
    const recent = mine.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
    const first = (S.me.name || '').split(' ')[0];
    return `<div class="head"><div class="grow"><div class="eyebrow">Service desk</div><h1>Welcome${first ? ', ' + esc(first) : ''}</h1><p>Need something from ${esc(activeDesks().map(deskName).join(', ') || 'a team')}? Raise a ticket and follow it here.</p></div>
      <a class="btn btn--primary" href="#new">${icon('plus')} New request</a></div>
    <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      ${kpi('My active tickets', st.active.length, 'Being handled')}
      ${kpi('Awaiting your confirmation', awaiting.length, 'Marked resolved', awaiting.length > 0)}
      ${kpi('Closed', mine.filter((t) => t.status === 'Closed').length, 'All time')}
    </div>
    ${awaiting.length ? `<div class="banner">The team has resolved ${awaiting.length === 1 ? 'one of your tickets' : awaiting.length + ' of your tickets'}. Open ${awaiting.length === 1 ? 'it' : 'them'} to confirm the fix, or reopen if the problem continues.</div>` : ''}
    <div class="panel"><div class="panel__h"><h2>Recent activity</h2><a class="small" href="#tickets" style="margin-left:auto">View all</a></div>
      <div class="panel__b panel__b--flush">${recent.length ? ticketTable(recent, false) : `<div class="empty"><img src="assets/img/emblem-gold.png" alt="">You haven't raised any tickets yet.</div>`}</div></div>`;
  }

  /* ---------- ticket list ---------- */
  function filtered() {
    let a = visibleTickets();
    const f = S.f, q = f.q.trim().toLowerCase();
    if (q) a = a.filter((t) => [ref(t), t.title, t.description, name(t.requesterId), t.assigneeId ? name(t.assigneeId) : '', t.category, deskName(deskId(t))].concat((t.fields || []).map((x) => x.value)).join(' ').toLowerCase().includes(q));
    if (f.desk) a = a.filter((t) => deskId(t) === f.desk);
    if (f.status === 'active') a = a.filter((t) => ACTIVE.includes(t.status));
    else if (f.status === 'overdue') a = a.filter(isOverdue);
    else if (f.status) a = a.filter((t) => t.status === f.status);
    if (f.priority) a = a.filter((t) => t.priority === f.priority);
    if (f.category) a = a.filter((t) => t.category === f.category);
    if (isAgent()) {
      if (f.assignee === 'me') a = a.filter((t) => t.assigneeId === S.me.id);
      else if (f.assignee === 'none') a = a.filter((t) => !t.assigneeId);
      else if (f.assignee) a = a.filter((t) => t.assigneeId === f.assignee);
    }
    const pi = (t) => PRIORITIES.indexOf(t.priority);
    const sorters = {
      updated: (x, y) => y.updatedAt - x.updatedAt,
      newest: (x, y) => y.createdAt - x.createdAt,
      oldest: (x, y) => x.createdAt - y.createdAt,
      priority: (x, y) => pi(y) - pi(x) || x.dueAt - y.dueAt,
      due: (x, y) => ACTIVE.includes(y.status) - ACTIVE.includes(x.status) || x.dueAt - y.dueAt,
    };
    return a.sort(sorters[f.sort] || sorters.updated);
  }
  function ticketTable(list, staffCols) {
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Ref</th><th>Subject</th>${staffCols ? '<th>Raised by</th>' : ''}<th>Owner</th><th>Priority</th><th>Status</th><th>SLA</th><th class="hide-sm">Updated</th></tr></thead>
    <tbody>${list.map((t) => `<tr class="click" data-act="open" data-id="${esc(t.id)}">
      <td class="mono">${esc(ref(t))}</td>
      <td style="max-width:380px"><a class="ttl" href="#ticket-${esc(t.id)}">${esc(t.title)}</a><div class="sub">${Object.keys(S.desks).length > 1 ? `<span class="desk-tag">${esc(deskName(deskId(t)))}</span>` : ''}${esc(t.category)}</div></td>
      ${staffCols ? `<td>${esc(name(t.requesterId))}</td>` : ''}
      <td>${t.assigneeId ? esc(name(t.assigneeId)) : '<span class="muted">Unassigned</span>'}</td>
      <td>${pill('pr', t.priority)}</td><td>${pill('st', t.status)}</td><td>${slaCell(t)}</td>
      <td class="hide-sm small muted" title="${esc(fmtDate(t.updatedAt))}">${rel(t.updatedAt)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function ticketsView() {
    const list = filtered(), f = S.f, staff = isAgent();
    const any = f.q || f.status !== 'active' || f.priority || f.category || f.assignee || f.desk;
    const seenDesks = [...new Set(ticketsArr().map(deskId).concat(myDeskIds()))].filter((d) => S.desks[d]).sort(byOrder);
    const cats = [...new Set(ticketsArr().map((t) => t.category).concat(myDeskIds().flatMap(categoriesOf)))].filter(Boolean).sort();
    return `<div class="head"><div class="grow"><div class="eyebrow">Tickets</div><h1>${staff ? 'Tickets' : 'My tickets'}</h1><p>${list.length} ticket${list.length === 1 ? '' : 's'} match the current filters.</p></div>
      ${staff ? `<button class="btn btn--ghost" data-act="export-filtered" ${list.length ? '' : 'disabled'}>${icon('download')} Export view</button>` : ''}
      <a class="btn btn--primary" href="#new">${icon('plus')} New ticket</a></div>
    <div class="panel">
      <div class="filters">
        <input id="f-q" class="input search" placeholder="Search reference, subject, person…" value="${esc(f.q)}" data-bind="f.q" data-rr aria-label="Search tickets">
        <select id="f-status" class="input" data-bind="f.status" data-rr aria-label="Status">${opt('active', 'Active', f.status)}${opt('', 'Any status', f.status)}${opt('overdue', 'Overdue', f.status)}${STATUSES.map((s) => opt(s, s, f.status)).join('')}</select>
        <select id="f-pri" class="input" data-bind="f.priority" data-rr aria-label="Priority">${opt('', 'Any priority', f.priority)}${PRIORITIES.map((p) => opt(p, p, f.priority)).join('')}</select>
        ${seenDesks.length > 1 ? `<select id="f-desk" class="input" data-bind="f.desk" data-rr aria-label="Desk">${opt('', 'All desks', f.desk)}${seenDesks.map((d) => opt(d, deskName(d), f.desk)).join('')}</select>` : ''}
        <select id="f-cat" class="input" data-bind="f.category" data-rr aria-label="Category">${opt('', 'Any category', f.category)}${cats.map((c) => opt(c, c, f.category)).join('')}</select>
        ${staff ? `<select id="f-asg" class="input" data-bind="f.assignee" data-rr aria-label="Owner">${opt('', 'Any owner', f.assignee)}${opt('me', 'Mine', f.assignee)}${opt('none', 'Unassigned', f.assignee)}${staffList().map((id) => opt(id, name(id), f.assignee)).join('')}</select>` : ''}
        <select id="f-sort" class="input" data-bind="f.sort" data-rr aria-label="Sort">${opt('updated', 'Recently updated', f.sort)}${opt('newest', 'Newest', f.sort)}${opt('oldest', 'Oldest', f.sort)}${opt('priority', 'Priority', f.sort)}${opt('due', 'SLA due', f.sort)}</select>
        ${any ? '<button class="btn btn--link small" data-act="clear-filters">Clear</button>' : ''}
      </div>
      ${list.length ? ticketTable(list, staff) : '<div class="empty">No tickets match these filters.</div>'}
    </div>`;
  }

  /* ---------- new ticket ---------- */
  function fieldInput(f, val) {
    const id = 'cf-' + f.id, bind = 'draft.nt.fields.' + f.id, req = f.required ? ' <span class="req">*</span>' : '';
    const label = `<label class="lbl" for="${esc(id)}">${esc(f.label)}${req}</label>`;
    const v = val == null ? '' : val;
    if (f.type === 'checkbox') return `<div class="field"><label class="check"><input type="checkbox" id="${esc(id)}" data-bind="${esc(bind)}" ${v ? 'checked' : ''}> ${esc(f.label)}${req}</label></div>`;
    if (f.type === 'textarea') return `<div class="field">${label}<textarea id="${esc(id)}" class="input" rows="3" maxlength="2000" data-bind="${esc(bind)}">${esc(v)}</textarea></div>`;
    if (f.type === 'select') return `<div class="field">${label}<select id="${esc(id)}" class="input" data-bind="${esc(bind)}">${opt('', 'Choose…', v)}${(f.options || []).map((o) => opt(o, o, v)).join('')}</select></div>`;
    const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
    return `<div class="field">${label}<input id="${esc(id)}" class="input" type="${type}" maxlength="300" value="${esc(v)}" data-bind="${esc(bind)}"></div>`;
  }
  function newTicketView() {
    const d = S.draft.nt, desks = activeDesks();
    if (!desks.length) return `<div class="head"><div class="grow"><div class="eyebrow">New request</div><h1>New ticket</h1></div></div>
      <div class="panel empty">No desks are open yet. ${isAdmin() ? '<a href="#desks">Set up a desk</a> to start taking tickets.' : 'Please ask your administrator.'}</div>`;
    const sel = desks.includes(d.deskId) ? d.deskId : desks.length === 1 ? desks[0] : '';
    const desk = sel ? S.desks[sel] : null;
    const picker = `<div class="field"><label class="lbl">Which team is this for?</label><div class="desk-pick">${desks.map((id) => `<button type="button" class="desk-card ${sel === id ? 'on' : ''}" data-act="pick-desk" data-id="${esc(id)}" aria-pressed="${sel === id}">
      <b>${esc(deskName(id))}</b><span>${esc(S.desks[id].description || '')}</span></button>`).join('')}</div></div>`;
    if (!desk) return `<div class="head"><div class="grow"><div class="eyebrow">New request</div><h1>New ticket</h1><p>Choose the team, then describe what you need.</p></div></div>
      <div class="panel" style="max-width:820px"><div class="panel__b" style="padding:1.5rem">${picker}</div></div>`;
    const cats = categoriesOf(sel), cat = cats.includes(d.category) ? d.category : cats[0];
    const people = Object.entries(S.users).filter(([id, u]) => u.active !== false && id !== S.me.id).map(([id]) => id).sort(byName);
    return `<div class="head"><div class="grow"><div class="eyebrow">New request · ${esc(desk.name)}</div><h1>New ticket</h1><p>Describe what you need. The response target is set by the priority.</p></div></div>
    <div class="panel" style="max-width:820px"><form class="panel__b" data-form="new-ticket" style="padding:1.5rem">
      ${desks.length > 1 ? picker : ''}
      ${isAgentOf(sel) ? `<div class="field"><label class="lbl" for="nt-req">Raised for</label><select id="nt-req" class="input" data-bind="draft.nt.requesterId">${opt('', 'Myself', d.requesterId)}${people.map((u) => opt(u, name(u) + (S.users[u].email ? ' · ' + S.users[u].email : ''), d.requesterId)).join('')}</select><div class="hint">Log a ticket for a colleague, for example after a phone call.</div></div>` : ''}
      <div class="field"><label class="lbl" for="nt-title">Subject</label><input id="nt-title" class="input" maxlength="120" placeholder="A short summary" value="${esc(d.title)}" data-bind="draft.nt.title"></div>
      <div class="row wrap" style="gap:1rem;align-items:flex-start">
        <div class="field grow" style="min-width:200px"><label class="lbl" for="nt-cat">Category</label><select id="nt-cat" class="input" data-bind="draft.nt.category">${cats.map((c) => opt(c, c, cat)).join('')}</select></div>
        <div class="field grow" style="min-width:200px"><label class="lbl" for="nt-pri">Priority</label><select id="nt-pri" class="input" data-bind="draft.nt.priority">${PRIORITIES.map((p) => opt(p, `${p} · within ${slaFor(sel, p)}h`, d.priority)).join('')}</select></div>
      </div>
      ${(desk.fields || []).map((f) => fieldInput(f, d.fields[f.id])).join('')}
      <div class="field"><label class="lbl" for="nt-desc">Description</label><textarea id="nt-desc" class="input" rows="6" maxlength="5000" placeholder="What you need or what happened, with any useful details…" data-bind="draft.nt.description">${esc(d.description)}</textarea>
        <div class="hint">Use Critical only for something urgent that stops work for many people.</div></div>
      <div class="field"><label class="lbl">Screenshots <span style="text-transform:none;letter-spacing:0">(optional)</span></label>${attachBox('new', S.busy)}</div>
      ${d.err ? `<div class="err">${esc(d.err)}</div>` : ''}
      <div class="row" style="justify-content:flex-end;margin-top:.6rem"><a class="btn btn--ghost" href="#tickets">Cancel</a><button class="btn btn--primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Submitting…' : 'Submit ticket'}</button></div>
    </form></div>`;
  }
  async function createTicket() {
    const d = S.draft.nt, desks = activeDesks();
    const sel = desks.includes(d.deskId) ? d.deskId : desks.length === 1 ? desks[0] : '';
    if (!sel) { d.err = 'Choose which team the ticket is for.'; return render(); }
    const desk = S.desks[sel], cats = categoriesOf(sel);
    const title = d.title.trim(), description = d.description.trim();
    if (title.length < 5) { d.err = 'Give the ticket a subject of at least 5 characters.'; return render(); }
    const fields = [];
    for (const f of desk.fields || []) {
      let v = d.fields[f.id];
      if (f.type === 'checkbox') v = v ? 'Yes' : (f.required ? '' : 'No');
      v = v == null ? '' : String(v).trim();
      if (f.required && !v) { d.err = `Please fill in “${f.label}”.`; return render(); }
      if (v) fields.push({ id: f.id, label: f.label, value: v.slice(0, 2000) });
    }
    if (description.length < 10) { d.err = 'Add a description of at least 10 characters so the team can help.'; return render(); }
    const uid = S.user.uid, n = now();
    const requester = isAgentOf(sel) && d.requesterId ? d.requesterId : uid;
    const base = {
      deskId: sel, title, description, category: cats.includes(d.category) ? d.category : cats[0], priority: d.priority, status: 'Open',
      requesterId: requester, assigneeId: null, createdBy: uid,
      createdAt: n, updatedAt: n, dueAt: n + slaFor(sel, d.priority) * HOUR,
      resolvedAt: null, closedAt: null, resolution: '',
      history: [{ at: n, by: uid, text: requester !== uid ? 'logged the ticket for ' + name(requester) : 'raised the ticket' }],
    };
    if (fields.length) base.fields = fields;
    S.busy = true; d.err = ''; render();
    const counter = S.db.doc('meta/counter');
    const tRef = S.db.collection('tickets').doc();
    try {
      const num = await S.db.runTransaction(async (tx) => {
        const c = await tx.get(counter);
        const num = c.exists ? c.data().next : 1001;
        tx.set(counter, { next: num + 1 });
        tx.set(tRef, Object.assign({ num }, base));
        return num;
      });
      const shots = S.pending.new || [];
      if (shots.length) {
        try { const b = S.db.batch(); addFileWrites(b, tRef.id, shots, false, null); await b.commit(); }
        catch (e) { console.error(e); toast('The ticket was created, but the screenshots could not be uploaded: ' + dbMsg(e), 'error'); }
      }
      S.pending.new = [];
      S.draft.nt = EMPTY_NT();
      S.busy = false;
      toast(`ZEN-${num} sent to ${desk.name}. Target: within ${slaFor(sel, base.priority)}h.`);
      S.extra[tRef.id] = Object.assign({ num }, base); // show it now; the live list catches up a moment later
      go('ticket-' + tRef.id);
    } catch (e) { S.busy = false; d.err = dbMsg(e); render(); console.error(e); }
  }

  /* ---------- ticket detail ---------- */
  function ticketView(id) {
    const raw = S.tickets[id] || S.extra[id];
    if (!raw) {
      const pr = S.probe[id] || {};
      if (pr.state === 'loading') return `<div class="panel empty">Loading ticket…</div>`;
      if (pr.state === 'error') return `<div class="panel empty"><b>This ticket couldn't be loaded.</b><br>${esc(pr.msg)}<br><a href="#tickets">Back to tickets</a></div>`;
      return `<div class="panel empty">This ticket doesn't exist, was deleted, or isn't yours to view. <a href="#tickets">Back to tickets</a></div>`;
    }
    const t = Object.assign({}, raw, { id });
    const did = deskId(t), staff = isAgentOf(did), mine = t.requesterId === S.me.id, closed = t.status === 'Closed';
    const teamTag = (uid) => (memberOf(uid, did) ? `<span class="tag">${esc(deskName(did))}</span>` : '');
    const comments = S.comments.filter((c) => staff || !c.internal);
    const items = [...(t.history || []).map((h) => ({ k: 'h', at: h.at, h })), ...comments.map((c) => ({ k: 'c', at: c.at, c }))].sort((a, b) => a.at - b.at);
    const timeline = items.map((it) => it.k === 'h'
      ? `<div class="ev"><span class="ev__dot"></span><div><b>${esc(name(it.h.by))}</b> ${esc(it.h.text)} <span title="${esc(fmtDate(it.at))}">· ${rel(it.at)}</span></div></div>`
      : `<div class="cm"><div class="avatar ${memberOf(it.c.by, did) ? 'avatar--gold' : ''}">${esc(initials(it.c.by))}</div>
          <div class="cm__body ${it.c.internal ? 'cm__body--note' : ''} ${it.c.resolution ? 'cm__body--res' : ''}">
          <div class="cm__head"><b>${esc(name(it.c.by))}</b>${teamTag(it.c.by)}${it.c.internal ? '<span class="tag tag--note">Internal note</span>' : ''}${it.c.resolution ? '<span class="tag tag--res">Resolution</span>' : ''}${it.c.source === 'email' ? '<span class="tag">By email</span>' : ''}<span class="muted" title="${esc(fmtDate(it.at))}">${rel(it.at)}</span></div>
          <div class="cm__text">${esc(it.c.text)}</div>${gallery(id, S.files.filter((f) => f.commentId === it.c.id))}</div></div>`).join('');
    const next = (FLOW[t.status] || []).filter(() => !(closed && !isAdmin()));
    const statusCtl = staff
      ? `<select id="st-${esc(id)}" class="input" data-chg="status" data-id="${esc(id)}" ${next.length ? '' : 'disabled'} aria-label="Change status">${opt(t.status, t.status, t.status)}${next.map((s) => opt(s, '→ ' + s, '')).join('')}</select>`
      : pill('st', t.status);
    const owners = agentsOf(did);
    const confirmBox = !staff && mine && t.status === 'Resolved'
      ? `<div class="panel" style="margin-bottom:1.1rem;border-color:var(--gold)"><div class="panel__b"><h2 style="font-size:1.25rem">Is everything sorted?</h2><p class="small t2" style="margin:.3rem 0 .9rem">The ${esc(deskName(did))} team marked this ticket as resolved. Confirm to close it, or reopen it if the problem is still there.</p>
         <div class="row"><button class="btn btn--primary" data-act="confirm-close" data-id="${esc(id)}">Yes, close the ticket</button><button class="btn btn--ghost" data-act="reopen" data-id="${esc(id)}">No, reopen it</button></div></div></div>` : '';
    const canComment = !closed || staff;
    const cats = categoriesOf(did);
    const fieldsHtml = (t.fields || []).length ? `<dl class="cf">${t.fields.map((x) => `<dt>${esc(x.label)}</dt><dd>${esc(x.value)}</dd>`).join('')}</dl>` : '';
    return `<div class="small" style="margin-bottom:.8rem"><a href="#tickets">← ${isAgent() ? 'Tickets' : 'My tickets'}</a></div>
    <div class="head"><div class="grow"><div class="row wrap" style="margin-bottom:.5rem"><span class="mono muted">${esc(ref(t))}</span><span class="desk-tag desk-tag--lg">${esc(deskName(did))}</span>${pill('st', t.status)}${pill('pr', t.priority)}${slaCell(t)}</div><h1>${esc(t.title)}</h1></div>
      ${isAdmin() && staff ? `<button class="btn btn--danger-ghost btn--sm" data-act="delete-ticket" data-id="${esc(id)}">Delete</button>` : ''}</div>
    <div class="detail">
      <div>
        ${confirmBox}
        <div class="panel" style="margin-bottom:1.1rem"><div class="panel__h"><h2>Description</h2><span class="small muted" style="margin-left:auto">${esc(name(t.requesterId))} · ${esc(fmtDate(t.createdAt))}</span></div>
          <div class="panel__b">${fieldsHtml}<div class="desc">${esc(t.description)}</div>${gallery(id, S.files.filter((f) => !f.commentId))}
          ${t.resolution && (t.status === 'Resolved' || closed) ? `<div class="res"><b>Resolution</b><div class="desc">${esc(t.resolution)}</div></div>` : ''}</div></div>
        <div class="panel"><div class="panel__h"><h2>Activity</h2><span class="small muted">${comments.length} comment${comments.length === 1 ? '' : 's'} · ${(t.history || []).length} events</span></div>
          <div class="panel__b"><div class="timeline">${timeline}${!S.cLoaded ? '<div class="small muted">Loading comments…</div>' : ''}${S.cErr ? '<div class="err">Comments couldn\'t be loaded.</div>' : ''}</div>
          <div style="margin-top:1.3rem;border-top:1px solid var(--line);padding-top:1.1rem">
          ${canComment ? `<form data-form="comment" data-id="${esc(id)}">
            <label class="lbl" for="c-${esc(id)}">${staff ? 'Reply or add a note' : 'Add a comment'}</label>
            <textarea id="c-${esc(id)}" class="input" rows="3" maxlength="4000" placeholder="${staff ? 'Reply to the requester, or tick “Internal note” for ' + esc(deskName(did)) + ' team eyes only…' : 'Add detail or reply to the team…'}" data-bind="draft.comment.${esc(id)}">${esc(S.draft.comment[id] || '')}</textarea>
            ${attachBox(id)}
            <div class="row" style="margin-top:.6rem">${staff ? `<label class="check"><input type="checkbox" id="ci-${esc(id)}" data-bind="draft.internal.${esc(id)}" ${S.draft.internal[id] ? 'checked' : ''}> Internal note (hidden from requester)</label>` : ''}<span class="grow"></span><button class="btn ${S.draft.internal[id] ? 'btn--gold' : 'btn--primary'}" type="submit">${S.draft.internal[id] ? 'Add note' : 'Post comment'}</button></div>
          </form>` : '<div class="small muted">This ticket is closed. Raise a new ticket if the problem comes back.</div>'}
          </div></div></div>
      </div>
      <div>
        <div class="panel"><div class="panel__h"><h2>Details</h2></div><div class="panel__b"><div class="kv">
          <div class="k">Desk</div><div>${staff && !closed && activeDesks().length > 1 ? `<select id="dk-${esc(id)}" class="input" data-chg="desk" data-id="${esc(id)}" aria-label="Move to another desk">${activeDesks().concat(activeDesks().includes(did) ? [] : [did]).map((d) => opt(d, d === did ? deskName(d) : '→ Move to ' + deskName(d), did)).join('')}</select>` : esc(deskName(did))}</div>
          <div class="k">Status</div><div>${statusCtl}</div>
          <div class="k">Priority</div><div>${staff ? `<select id="pr-${esc(id)}" class="input" data-chg="priority" data-id="${esc(id)}" ${closed ? 'disabled' : ''} aria-label="Priority">${PRIORITIES.map((p) => opt(p, p + ' · ' + slaFor(did, p) + 'h', t.priority)).join('')}</select>` : pill('pr', t.priority)}</div>
          <div class="k">Category</div><div>${staff ? `<select id="ca-${esc(id)}" class="input" data-chg="category" data-id="${esc(id)}" ${closed ? 'disabled' : ''} aria-label="Category">${cats.concat(cats.includes(t.category) ? [] : [t.category]).map((c) => opt(c, c, t.category)).join('')}</select>` : esc(t.category)}</div>
          <div class="k">Owner</div><div>${staff ? `<select id="as-${esc(id)}" class="input" data-chg="assignee" data-id="${esc(id)}" ${closed ? 'disabled' : ''} aria-label="Owner">${opt('', 'Unassigned', t.assigneeId || '')}${owners.map((a) => opt(a, name(a), t.assigneeId || '')).join('')}${t.assigneeId && !owners.includes(t.assigneeId) ? opt(t.assigneeId, name(t.assigneeId) + ' (inactive)', t.assigneeId) : ''}</select>
            ${t.assigneeId !== S.me.id && !closed ? `<button class="btn btn--ghost btn--sm" style="margin-top:.45rem" data-act="take" data-id="${esc(id)}">Take ownership</button>` : ''}` : (t.assigneeId ? esc(name(t.assigneeId)) : '<span class="muted">Not assigned yet</span>')}</div>
          <div class="k">Raised by</div><div>${esc(name(t.requesterId))}</div>
          <div class="k">Raised</div><div>${esc(fmtDate(t.createdAt))}</div>
          <div class="k">Target</div><div>${esc(fmtDate(t.dueAt))}<div class="small">${slaCell(t)}</div></div>
          <div class="k">Resolved</div><div>${t.resolvedAt ? esc(fmtDate(t.resolvedAt)) + `<div class="small muted">after ${dur(resTime(t))}</div>` : '<span class="muted">—</span>'}</div>
          <div class="k">Updated</div><div title="${esc(fmtDate(t.updatedAt))}">${rel(t.updatedAt)}</div>
        </div></div></div>
        ${staff ? '<p class="small muted" style="margin:.8rem .3rem 0">Resolving asks for a note the requester will see. Changing the status of an unassigned ticket makes you its owner. Moving it to another desk hands it to that team.</p>' : ''}
      </div>
    </div>`;
  }

  /* ---------- ticket writes ---------- */
  async function update(id, changes, texts) {
    const n = now(), uid = S.user.uid;
    const data = Object.assign({}, changes, { updatedAt: n });
    if (texts && texts.length) data.history = S.fb.firestore.FieldValue.arrayUnion(...texts.map((text, i) => ({ at: n + i, by: uid, text })));
    try { await S.db.collection('tickets').doc(id).update(data); return true; } catch (e) { fail(e); return false; }
  }
  async function setStatus(id, to, note) {
    const t = S.tickets[id]; if (!t || t.status === to) return;
    const from = t.status, n = now(), ch = { status: to }, h = [];
    const reopening = ACTIVE.includes(to) && (from === 'Resolved' || from === 'Closed');
    const agent = isAgentOf(deskId(t));
    if (agent && !t.assigneeId && to !== 'Closed') { ch.assigneeId = S.user.uid; h.push('took ownership of the ticket'); }
    if (to === 'Resolved') { ch.resolvedAt = n; ch.resolution = note; }
    if (to === 'Closed') ch.closedAt = n;
    if (reopening) { ch.resolvedAt = null; ch.closedAt = null; ch.resolution = ''; }
    h.push(!agent && to === 'Closed' ? 'confirmed the fix and closed the ticket' : reopening ? `reopened the ticket (${from} → ${to})` : `changed status from ${from} to ${to}`);
    const ok = await update(id, ch, h);
    if (ok && to === 'Resolved') {
      try { await S.db.collection('tickets').doc(id).collection('comments').add({ by: S.user.uid, at: n + 5, text: note, internal: false, resolution: true }); } catch (e) { fail(e); }
    }
    return ok;
  }
  async function deleteTicket(id) {
    try {
      const ref = S.db.collection('tickets').doc(id);
      const cs = await ref.collection('comments').get();
      const fs = await ref.collection('files').get();
      for (const f of fs.docs) {                          // one screenshot per batch: each is up to ~1 MB
        const b = S.db.batch(); b.delete(f.ref.collection('content').doc('full')); b.delete(f.ref); await b.commit();
      }
      const batch = S.db.batch();
      cs.docs.forEach((d) => batch.delete(d.ref));
      batch.delete(ref);
      await batch.commit();
      return true;
    } catch (e) { fail(e); return false; }
  }

  /* ---------- team (admin) ---------- */
  function usersView() {
    const d = S.draft.nu, all = ticketsArr();
    const order = { admin: 0, tech: 1, user: 2 };
    const ids = Object.keys(S.users).sort((a, b) => ((order[S.users[a].role] ?? 2) - (order[S.users[b].role] ?? 2)) || name(a).localeCompare(name(b)));
    return `<div class="head"><div class="grow"><div class="eyebrow">Administration</div><h1>Team &amp; roles</h1><p>${ids.length} people. Everyone can raise tickets. Members of a desk handle that desk's tickets (choose them on the <a href="#desks">Desks</a> page). Administrators manage desks and people.</p></div></div>
    <div class="panel" style="margin-bottom:1.1rem"><div class="panel__h"><h2>Add a person</h2></div>
      <form class="panel__b" data-form="new-user"><div class="row wrap" style="gap:.8rem;align-items:flex-end">
        <div style="flex:1;min-width:160px"><label class="lbl" for="nu-name">Full name</label><input id="nu-name" class="input" value="${esc(d.name)}" data-bind="draft.nu.name" placeholder="Jade Moutou"></div>
        <div style="flex:1.2;min-width:190px"><label class="lbl" for="nu-email">Email</label><input id="nu-email" class="input" type="email" value="${esc(d.email)}" data-bind="draft.nu.email" placeholder="name@company.com" autocomplete="off"></div>
        <div style="width:170px"><label class="lbl" for="nu-dept">Department</label><select id="nu-dept" class="input" data-bind="draft.nu.department">${opt('', 'Choose…', d.department || '')}${deptList().map((x) => opt(x, x, d.department || '')).join('')}</select></div>
        <div style="width:170px"><label class="lbl" for="nu-role">Role</label><select id="nu-role" class="input" data-bind="draft.nu.role">${Object.entries(ROLE_CHOICES).map(([k, v]) => opt(k, v, d.role)).join('')}</select></div>
        <div style="flex:1;min-width:160px"><label class="lbl" for="nu-p">Temporary password</label><input id="nu-p" class="input" type="password" value="${esc(d.p)}" data-bind="draft.nu.p" autocomplete="new-password" placeholder="6+ characters"></div>
        <button class="btn btn--primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Adding…' : 'Add person'}</button>
      </div>${d.err ? `<div class="err">${esc(d.err)}</div>` : ''}<div class="hint">They can sign in straight away and change the password from the top bar.</div></form></div>
    <div class="panel" style="margin-bottom:1.1rem"><div class="panel__h"><h2>Departments</h2><span class="small muted">used for people here and in HR</span></div><div class="panel__b">
      <div class="chips">${deptList().map((x, i) => { const n = Object.values(S.users).filter((u) => u.department === x).length; return `<span class="chip dept-chip">${esc(x)}${n ? `<small>${n}</small>` : ''}<button type="button" data-act="dept-del" data-i="${i}" aria-label="Remove ${esc(x)}" title="${n ? 'People in it keep it until you change them' : 'Remove'}">×</button></span>`; }).join('')}</div>
      <div class="row" style="margin-top:.7rem;max-width:460px"><input id="dept-new" class="input" maxlength="40" placeholder="Add a department, e.g. Housekeeping" value="${esc(S.draft.newDept || '')}" data-bind="draft.newDept"><button type="button" class="btn btn--ghost" data-act="dept-add">Add</button></div>
    </div></div>
    <div class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Person</th><th>Department</th><th>Role</th><th>Desks</th><th>Raised</th><th>Access</th><th></th></tr></thead><tbody>
    ${ids.map((id) => { const u = S.users[id], self = id === S.me.id, off = u.active === false, locked = self || isAdminEmail(u.email);
      const ud = desksOfUser(id);
      return `<tr><td><div class="row"><div class="avatar ${ud.length ? 'avatar--gold' : ''}">${esc(initials(id))}</div><div><div class="ttl">${esc(u.name)}</div><div class="sub" style="overflow-wrap:anywhere">${esc(u.email || '')}</div>${self || isAdminEmail(u.email) ? `<div class="row" style="gap:.3rem;margin-top:.2rem">${self ? '<span class="tag">You</span>' : ''}${isAdminEmail(u.email) ? '<span class="tag tag--note">Main admin</span>' : ''}</div>` : ''}</div></div></td>
        <td><select id="dp-${esc(id)}" class="input" style="height:32px;min-width:150px" data-chg="dept" data-id="${esc(id)}" aria-label="Department for ${esc(u.name)}">${opt('', '—', u.department || '')}${deptOpts(u.department).map((x) => opt(x, x, u.department || '')).join('')}</select></td>
        <td><select id="ro-${esc(id)}" class="input" style="height:32px;min-width:150px" data-chg="role" data-id="${esc(id)}" ${locked ? 'disabled' : ''} aria-label="Role for ${esc(u.name)}">${Object.entries(ROLE_CHOICES).map(([k, v]) => opt(k, v, u.role === 'admin' ? 'admin' : 'user')).join('')}</select></td>
        <td>${ud.length ? ud.map((x) => `<span class="desk-tag">${esc(deskName(x))}</span>`).join(' ') : '<span class="muted small">None</span>'}</td>
        <td>${all.filter((t) => t.requesterId === id).length}</td>
        <td>${off ? '<span class="pill st-closed"><i></i>Disabled</span>' : '<span class="pill st-open"><i></i>Active</span>'}</td>
        <td class="nowrap"><div class="row" style="justify-content:flex-end;gap:.35rem"><button class="btn btn--ghost btn--sm" data-act="reset-mail" data-id="${esc(id)}" ${u.email ? '' : 'disabled'} title="Email them a link to set a new password">Reset password</button>
          <button class="btn btn--sm ${off ? 'btn--ghost' : 'btn--danger-ghost'}" data-act="toggle-user" data-id="${esc(id)}" ${locked ? 'disabled' : ''}>${off ? 'Enable' : 'Disable'}</button></div></td></tr>`; }).join('')}
    </tbody></table></div></div>`;
  }
  async function addPerson() {
    const d = S.draft.nu, email = d.email.trim().toLowerCase(), nm = d.name.trim();
    if (nm.length < 2) { d.err = 'Enter their full name.'; return render(); }
    if (!emailOk(email)) { d.err = 'Enter a valid email address.'; return render(); }
    if (d.p.length < 6) { d.err = 'The temporary password needs at least 6 characters.'; return render(); }
    S.busy = true; d.err = ''; render();
    // A second Firebase app creates the account, so the admin stays signed in.
    const sec = S.fb.apps.find((a) => a.name === 'zen-desk-admin') || S.fb.initializeApp(CFG, 'zen-desk-admin');
    try {
      const cred = await sec.auth().createUserWithEmailAndPassword(email, d.p);
      const doc = { name: nm, email, role: d.role, active: true, createdAt: now() };
      if (d.department) doc.department = d.department;
      await S.db.collection('users').doc(cred.user.uid).set(doc);
      await sec.auth().signOut();
      toast(nm + ' added (' + ROLE_CHOICES[d.role] + '). Add them to desks on the Desks page if they handle tickets.');
      S.draft.nu = { name: '', email: '', role: 'user', department: '', p: '', err: '' };
    } catch (e) { d.err = e && String(e.code || '').startsWith('auth/') ? authMsg(e) : dbMsg(e); console.error(e); }
    S.busy = false; render();
  }

  /* ---------- desks (admin) ---------- */
  function desksView() {
    const ids = allDeskIds();
    return `<div class="head"><div class="grow"><div class="eyebrow">Administration</div><h1>Desks</h1><p>Each desk is a team that handles its own tickets: IT, HR, and anything you add later.</p></div>
      <a class="btn btn--primary" href="#desk-new">${icon('plus')} New desk</a></div>
    <div class="banner banner--info">Only a desk's <b>members</b> can see its tickets. As an administrator you manage desks, but you only see the tickets of desks you're a member of.</div>
    <div class="desk-grid">${ids.map((id) => { const d = S.desks[id], ms = agentsOf(id), open = Object.values(S.tickets).filter((t) => deskId(t) === id && ACTIVE.includes(t.status)).length;
      return `<a class="panel desk-box" href="#desk-${esc(id)}">
        <div class="row"><h2 class="grow">${esc(d.name)}</h2>${S.hrDeskId === id ? '<span class="desk-tag">HR module</span>' : ''}${d.active === false ? '<span class="pill st-closed"><i></i>Closed</span>' : '<span class="pill st-open"><i></i>Open</span>'}</div>
        <p class="small t2">${esc(d.description || 'No description')}</p>
        <div class="desk-box__facts">
          <div><span class="k">Email</span>${d.email ? esc(d.email) : '<span class="muted">Main IT mailbox</span>'}</div>
          <div><span class="k">Members</span>${ms.length ? esc(ms.slice(0, 4).map(name).join(', ')) + (ms.length > 4 ? ` +${ms.length - 4}` : '') : '<span class="err" style="margin:0">Nobody yet</span>'}</div>
          <div><span class="k">Categories</span>${(d.categories || []).length}</div>
          <div><span class="k">Form fields</span>${(d.fields || []).length}</div>
          <div><span class="k">Targets</span>${PRIORITIES.slice().reverse().map((p) => `${p} ${slaFor(id, p)}h`).join(' · ')}</div>
          ${isAgentOf(id) ? `<div><span class="k">Open tickets</span>${open}</div>` : ''}
        </div>
        <span class="btn btn--ghost btn--sm" style="align-self:flex-start">Edit desk</span></a>`; }).join('') || '<div class="panel empty">No desks yet. Create the first one.</div>'}</div>`;
  }
  function deskEditor() {
    const d = S.deskDraft;
    if (!d) return `<div class="panel empty">This desk doesn't exist. <a href="#desks">Back to desks</a></div>`;
    const people = Object.entries(S.users).filter(([, u]) => u.active !== false).map(([id]) => id).sort(byName);
    const q = (d.q || '').trim().toLowerCase();
    const shown = people.filter((id) => !q || (name(id) + ' ' + (S.users[id].email || '')).toLowerCase().includes(q));
    const log = d.id && S.desks[d.id] ? (S.desks[d.id].log || []).slice(-8).reverse() : [];
    return `<div class="small" style="margin-bottom:.8rem"><a href="#desks">← Desks</a></div>
    <div class="head"><div class="grow"><div class="eyebrow">${d.id ? 'Edit desk' : 'New desk'}</div><h1>${esc(d.name || 'New desk')}</h1></div></div>
    <form data-form="desk-save" class="desk-form">
      <div class="panel"><div class="panel__h"><h2>About this desk</h2></div><div class="panel__b">
        <div class="row wrap" style="gap:1rem;align-items:flex-start">
          <div class="field grow" style="min-width:220px"><label class="lbl" for="dd-name">Desk name</label><input id="dd-name" class="input" maxlength="40" placeholder="e.g. HR" value="${esc(d.name)}" data-bind="deskDraft.name"></div>
          <div class="field grow" style="min-width:260px"><label class="lbl" for="dd-email">Desk email address</label><input id="dd-email" class="input" type="email" maxlength="160" placeholder="e.g. hr@zenitudeconcierge.com" value="${esc(d.email)}" data-bind="deskDraft.email">
            <div class="hint">New tickets for this desk are emailed here. Emails sent to this address become tickets on this desk, and replies to people come from it. Leave empty to use the main IT mailbox. You can change it any time.</div></div>
        </div>
        <div class="field"><label class="lbl" for="dd-desc">Description</label><input id="dd-desc" class="input" maxlength="160" placeholder="What people should come to this desk for" value="${esc(d.description)}" data-bind="deskDraft.description"><div class="hint">Shown when someone chooses a team for a new ticket.</div></div>
        <label class="check"><input type="checkbox" id="dd-active" data-bind="deskDraft.active" ${d.active ? 'checked' : ''}> Open: people can raise new tickets for this desk</label>
        <div style="margin-top:.7rem"><label class="check"><input type="checkbox" id="dd-hr" data-bind="deskDraft.isHR" ${d.isHR ? 'checked' : ''}> HR desk: its members also get Staff records, Leave and Payroll</label>
          <div class="hint">${S.hrDeskId && S.hrDeskId !== d.id && S.desks[S.hrDeskId] ? `Currently the ${esc(deskName(S.hrDeskId))} desk. Ticking this moves the HR pages to this desk.` : 'Salaries and staff records are only visible to this desk\'s members, not to other administrators.'}</div></div>
      </div></div>

      <div class="panel"><div class="panel__h"><h2>Members</h2><span class="small muted">${d.members.length} selected</span></div><div class="panel__b">
        <p class="small t2" style="margin-bottom:.7rem">Only these people can see and work on this desk's tickets, including internal notes. They also get the desk's email alerts.</p>
        <input id="dd-q" class="input" placeholder="Search people…" value="${esc(d.q)}" data-bind="deskDraft.q" data-rr style="margin-bottom:.6rem">
        <div class="member-list">${shown.map((id) => `<label class="check member"><input type="checkbox" id="dm-${esc(id)}" data-chg="member" data-id="${esc(id)}" ${d.members.includes(id) ? 'checked' : ''}><span class="avatar ${d.members.includes(id) ? 'avatar--gold' : ''}">${esc(initials(id))}</span><span><b>${esc(name(id))}</b><br><span class="small muted">${esc(S.users[id].email || '')}</span></span></label>`).join('') || '<div class="muted small">Nobody matches.</div>'}</div>
      </div></div>

      <div class="panel"><div class="panel__h"><h2>Categories</h2></div><div class="panel__b">
        <div class="chips">${d.categories.map((c, i) => `<span class="chip">${esc(c)}<button type="button" data-act="cat-del" data-i="${i}" aria-label="Remove ${esc(c)}">×</button></span>`).join('')}</div>
        <div class="row" style="margin-top:.7rem;max-width:420px"><input id="dd-newcat" class="input" maxlength="40" placeholder="Add a category, e.g. Payroll" value="${esc(d.newCat)}" data-bind="deskDraft.newCat"><button type="button" class="btn btn--ghost" data-act="cat-add">Add</button></div>
      </div></div>

      <div class="panel"><div class="panel__h"><h2>Response targets</h2><span class="small muted">hours from when a ticket is raised</span></div><div class="panel__b">
        <div class="row wrap" style="gap:1rem">${PRIORITIES.slice().reverse().map((p) => `<div class="field" style="width:150px"><label class="lbl" for="dd-sla-${p}">${p}</label><input id="dd-sla-${p}" class="input" type="number" min="1" max="2000" value="${esc(d.sla[p])}" data-bind="deskDraft.sla.${p}"></div>`).join('')}</div>
      </div></div>

      <div class="panel"><div class="panel__h"><h2>Extra questions on the form</h2><span class="small muted">optional</span></div><div class="panel__b">
        <p class="small t2" style="margin-bottom:.7rem">Ask for details this team always needs, e.g. employee ID or leave dates for HR, or the asset tag for IT.</p>
        ${d.fields.map((f, i) => `<div class="fld">
          <input id="df-l-${i}" class="input" maxlength="60" placeholder="Question, e.g. Employee ID" value="${esc(f.label)}" data-bind="deskDraft.fields.${i}.label" aria-label="Question ${i + 1}">
          <select id="df-t-${i}" class="input" data-bind="deskDraft.fields.${i}.type" data-rr aria-label="Answer type">${Object.entries(FIELD_TYPES).map(([k, v]) => opt(k, v, f.type)).join('')}</select>
          <label class="check"><input type="checkbox" id="df-r-${i}" data-bind="deskDraft.fields.${i}.required" ${f.required ? 'checked' : ''}> Required</label>
          <span class="fld__btns"><button type="button" class="btn btn--ghost btn--sm" data-act="field-up" data-i="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button type="button" class="btn btn--ghost btn--sm" data-act="field-down" data-i="${i}" ${i < d.fields.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button><button type="button" class="btn btn--danger-ghost btn--sm" data-act="field-del" data-i="${i}" aria-label="Remove question">Remove</button></span>
          ${f.type === 'select' ? `<input id="df-o-${i}" class="input fld__opts" maxlength="600" placeholder="Choices, separated by commas, e.g. Annual leave, Sick leave, Unpaid leave" value="${esc(f.optionsText || '')}" data-bind="deskDraft.fields.${i}.optionsText">` : ''}
        </div>`).join('')}
        <button type="button" class="btn btn--ghost btn--sm" data-act="field-add" ${d.fields.length >= 20 ? 'disabled' : ''}>${icon('plus')} Add a question</button>
      </div></div>

      ${d.err ? `<div class="banner banner--bad">${esc(d.err)}</div>` : ''}
      <div class="row" style="justify-content:flex-end;gap:.6rem"><a class="btn btn--ghost" href="#desks">Cancel</a><button class="btn btn--primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Saving…' : d.id ? 'Save changes' : 'Create desk'}</button></div>
      ${log.length ? `<div class="panel"><div class="panel__h"><h2>Recent changes</h2></div><div class="panel__b"><div class="timeline">${log.map((l) => `<div class="ev"><span class="ev__dot"></span><div><b>${esc(name(l.by))}</b> ${esc(l.text)} <span title="${esc(fmtDate(l.at))}">· ${rel(l.at)}</span></div></div>`).join('')}</div></div></div>` : ''}
    </form>`;
  }
  const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'desk';
  async function saveDesk() {
    const d = S.deskDraft; if (!d) return;
    const nm = d.name.trim(), email = d.email.trim().toLowerCase();
    const cats = [...new Set(d.categories.map((c) => c.trim()).filter(Boolean))];
    const sla = {}; let slaBad = false;
    PRIORITIES.forEach((p) => { const v = Math.round(Number(d.sla[p])); if (!(v >= 1 && v <= 2000)) slaBad = true; sla[p] = v; });
    const fields = d.fields.map((f) => ({ id: f.id, label: (f.label || '').trim(), type: FIELD_TYPES[f.type] ? f.type : 'text', required: !!f.required,
      options: f.type === 'select' ? [...new Set(String(f.optionsText || '').split(',').map((o) => o.trim()).filter(Boolean))].slice(0, 30) : [] }));
    d.err = nm.length < 2 ? 'Give the desk a name.'
      : email && !emailOk(email) ? 'The desk email address doesn\'t look right.'
      : !cats.length ? 'Add at least one category.'
      : slaBad ? 'Response targets must be between 1 and 2000 hours.'
      : fields.some((f) => !f.label) ? 'Every extra question needs a label.'
      : fields.some((f) => f.type === 'select' && !f.options.length) ? 'Drop-down questions need at least one choice.'
      : !d.members.length ? 'Add at least one member, otherwise nobody can see this desk\'s tickets.' : '';
    if (d.err) return render();
    let id = d.id;
    if (!id) { id = slug(nm); let i = 2; while (S.desks[id] || id === 'new' || id === 'desks') id = slug(nm).slice(0, 26) + '-' + i++; }
    const old = S.desks[id] || null, log = old ? (old.log || []).slice(-40) : [], at = now(), by = S.me.id;
    if (!old) log.push({ at, by, text: 'created the desk' });
    else {
      if (old.name !== nm) log.push({ at, by, text: `renamed the desk from ${old.name} to ${nm}` });
      if ((old.email || '') !== email) log.push({ at, by, text: `changed the desk email from ${old.email || '(main IT mailbox)'} to ${email || '(main IT mailbox)'}` });
      const added = d.members.filter((m) => !(old.members || []).includes(m)), removed = (old.members || []).filter((m) => !d.members.includes(m));
      if (added.length) log.push({ at, by, text: 'added ' + added.map(name).join(', ') + ' as member' + (added.length > 1 ? 's' : '') });
      if (removed.length) log.push({ at, by, text: 'removed ' + removed.map(name).join(', ') + ' from the desk' });
      if ((old.active !== false) !== d.active) log.push({ at, by, text: d.active ? 'opened the desk' : 'closed the desk to new tickets' });
      if (JSON.stringify(old.fields || []) !== JSON.stringify(fields) || JSON.stringify(old.categories || []) !== JSON.stringify(cats) || JSON.stringify(old.sla || {}) !== JSON.stringify(sla)) log.push({ at, by, text: 'updated categories, targets or questions' });
    }
    const doc = { name: nm, description: d.description.trim(), email, active: !!d.active, categories: cats, sla, members: d.members.slice(), fields,
      order: old ? (old.order ?? 50) : Object.keys(S.desks).length + 1, log, updatedAt: at, updatedBy: by };
    S.busy = true; render();
    try {
      await S.db.collection('desks').doc(id).set(doc);
      if (d.isHR && S.hrDeskId !== id) await S.db.doc('meta/hr').set({ deskId: id, updatedAt: now(), updatedBy: by });
      else if (!d.isHR && S.hrDeskId === id) await S.db.doc('meta/hr').set({ deskId: '', updatedAt: now(), updatedBy: by });
      S.busy = false; S.deskDraft = null;
      toast(old ? `${nm} desk saved.` : `${nm} desk created.`);
      go('desks');
    } catch (e) { S.busy = false; d.err = dbMsg(e); render(); }
  }

  /* ---------- auth screens ---------- */
  function authView() {
    const L = S.draft.login, R = S.draft.reg, tab = OPT.allowSignup ? S.authTab : 'login';
    const tabs = OPT.allowSignup ? `<div class="tabs" role="tablist"><button role="tab" class="${tab === 'login' ? 'on' : ''}" data-act="tab" data-v="login">Sign in</button><button role="tab" class="${tab === 'reg' ? 'on' : ''}" data-act="tab" data-v="reg">Create account</button></div>` : '';
    const body = tab === 'login'
      ? `<form data-form="login">
          <div class="field"><label class="lbl" for="l-e">Email</label><input id="l-e" class="input" type="email" autocomplete="username" value="${esc(L.email)}" data-bind="draft.login.email"></div>
          <div class="field"><label class="lbl" for="l-p">Password</label><input id="l-p" class="input" type="password" autocomplete="current-password" value="${esc(L.p)}" data-bind="draft.login.p"></div>
          ${L.err ? `<div class="err" style="margin:-.3rem 0 .8rem">${esc(L.err)}</div>` : ''}${L.info ? `<div class="banner banner--info" style="margin:-.3rem 0 .8rem">${esc(L.info)}</div>` : ''}
          <button class="btn btn--primary btn--full" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Signing in…' : 'Sign in'}</button>
          <div style="text-align:center;margin-top:.9rem"><button type="button" class="btn btn--link small" data-act="forgot">Forgot your password?</button></div>
        </form>`
      : `<form data-form="register">
          <div class="field"><label class="lbl" for="r-n">Full name</label><input id="r-n" class="input" autocomplete="name" value="${esc(R.name)}" data-bind="draft.reg.name"></div>
          <div class="field"><label class="lbl" for="r-e">Work email</label><input id="r-e" class="input" type="email" autocomplete="username" value="${esc(R.email)}" data-bind="draft.reg.email"></div>
          <div class="row" style="gap:.7rem"><div class="field grow"><label class="lbl" for="r-p">Password</label><input id="r-p" class="input" type="password" autocomplete="new-password" value="${esc(R.p)}" data-bind="draft.reg.p"></div>
          <div class="field grow"><label class="lbl" for="r-p2">Confirm</label><input id="r-p2" class="input" type="password" autocomplete="new-password" value="${esc(R.p2)}" data-bind="draft.reg.p2"></div></div>
          ${R.err ? `<div class="err" style="margin:-.3rem 0 .8rem">${esc(R.err)}</div>` : ''}
          <button class="btn btn--primary btn--full" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Creating…' : 'Create account'}</button>
          <div class="hint" style="text-align:center;margin-top:.8rem">New accounts can raise tickets. An administrator adds people to desks.</div>
        </form>`;
    return authFrame(`<h1 class="auth__title">Zenitude Desk</h1><p class="auth__sub">Raise and track requests with the team</p>${tabs}${body}`);
  }
  function profileView() {
    const d = S.draft.profile;
    return authFrame(`<h1 class="auth__title">One last step</h1><p class="auth__sub">Signed in as ${esc(S.user.email || '')}. Tell us your name to finish setting up.</p>
      <form data-form="profile"><div class="field"><label class="lbl" for="p-n">Full name</label><input id="p-n" class="input" value="${esc(d.name)}" data-bind="draft.profile.name"></div>
      ${d.err ? `<div class="err" style="margin:-.3rem 0 .8rem">${esc(d.err)}</div>` : ''}
      <button class="btn btn--primary btn--full" type="submit" ${S.busy ? 'disabled' : ''}>Continue</button>
      <div style="text-align:center;margin-top:.9rem"><button type="button" class="btn btn--link small" data-act="logout">Sign out</button></div></form>`);
  }

  /* ---------- modals ---------- */
  function modalView() {
    const m = S.modal; if (!m) return '';
    if (HR && String(m.type).startsWith('hr-')) return HR.modal(m);
    const wrap = (title, body, foot) => `<div class="modal" data-act="overlay"><div class="modal__box" role="dialog" aria-modal="true"><div class="modal__head"><h3>${title}</h3></div><div class="modal__body">${body}</div><div class="modal__foot">${foot}</div></div></div>`;
    const cancel = '<button type="button" class="btn btn--ghost" data-act="close-modal">Cancel</button>';
    if (m.type === 'resolve') return `<form data-form="resolve">${wrap('Resolve ticket',
      `<p class="small t2" style="margin-bottom:.8rem">Explain the fix in plain words. The requester sees this note and is asked to confirm.</p>
       <textarea id="m-note" class="input" rows="4" data-bind="modal.note" placeholder="e.g. Reconnected the office router and confirmed the internet is back.">${esc(m.note || '')}</textarea>${m.err ? `<div class="err">${esc(m.err)}</div>` : ''}`,
      cancel + '<button class="btn btn--primary" type="submit">Mark resolved</button>')}</form>`;
    if (m.type === 'delete') { const t = S.tickets[m.id]; return wrap(`Delete ${t ? esc(ref(t)) : 'ticket'}?`,
      `<p class="t2">“${t ? esc(t.title) : ''}”, with its comments and history, will be removed for everyone. This can't be undone.</p>`,
      cancel + `<button class="btn btn--danger" data-act="do-delete" data-id="${esc(m.id)}">Delete ticket</button>`); }
    if (m.type === 'file') {
      const canDelete = isAdmin() || m.by === S.me.id;
      return `<div class="modal" data-act="overlay"><div class="modal__box modal__box--wide" role="dialog" aria-modal="true">
        <div class="modal__head row"><h3 class="grow" style="font-size:1.2rem;overflow-wrap:anywhere">${esc(m.name)}</h3><button type="button" class="btn btn--ghost btn--sm" data-act="close-modal">Close</button></div>
        <div class="modal__body viewer">${m.err ? `<div class="err">${esc(m.err)}</div>` : m.url ? `<img src="${esc(m.url)}" alt="${esc(m.name)}">` : '<div class="muted">Loading screenshot…</div>'}</div>
        <div class="modal__foot">${canDelete ? (m.confirm ? `<span class="small t2 grow">Delete this screenshot for everyone?</span><button class="btn btn--ghost btn--sm" data-act="file-del-cancel">Keep</button><button class="btn btn--danger btn--sm" data-act="file-del">Delete</button>` : `<button class="btn btn--danger-ghost btn--sm" data-act="file-del-ask">Delete</button><span class="grow"></span>`) : '<span class="grow"></span>'}
          ${m.url && !m.confirm ? `<a class="btn btn--ghost btn--sm" href="${esc(m.url)}" target="_blank" rel="noopener">Open full size</a><a class="btn btn--primary btn--sm" href="${esc(m.url)}" download="${esc(m.name)}">Download</a>` : ''}</div>
      </div></div>`;
    }
    if (m.type === 'chpw') return `<form data-form="chpw">${wrap('Change your password',
      `<div class="field"><label class="lbl" for="m-c">Current password</label><input id="m-c" class="input" type="password" autocomplete="current-password" value="${esc(m.c || '')}" data-bind="modal.c"></div>
       <div class="field"><label class="lbl" for="m-n">New password</label><input id="m-n" class="input" type="password" autocomplete="new-password" value="${esc(m.n || '')}" data-bind="modal.n"></div>
       <div class="field"><label class="lbl" for="m-n2">Confirm new password</label><input id="m-n2" class="input" type="password" autocomplete="new-password" value="${esc(m.n2 || '')}" data-bind="modal.n2"></div>${m.err ? `<div class="err">${esc(m.err)}</div>` : ''}`,
      cancel + `<button class="btn btn--primary" type="submit" ${S.busy ? 'disabled' : ''}>Update password</button>`)}</form>`;
    return '';
  }

  /* ---------- CSV ---------- */
  function exportCsv(list, label) {
    const cols = ['Ref', 'Desk', 'Subject', 'Category', 'Priority', 'Status', 'Raised by', 'Owner', 'Raised', 'Target', 'Resolved', 'Closed', 'Resolution hours', 'SLA', 'Details'];
    const iso = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '');
    const q = (v) => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const rows = list.slice().sort((a, b) => a.num - b.num).map((t) => [ref(t), deskName(deskId(t)), t.title, t.category, t.priority, t.status, name(t.requesterId), t.assigneeId ? name(t.assigneeId) : '', iso(t.createdAt), iso(t.dueAt), iso(t.resolvedAt), iso(t.closedAt),
      t.resolvedAt ? (resTime(t) / HOUR).toFixed(1) : '', t.resolvedAt ? (t.resolvedAt <= t.dueAt ? 'Met' : 'Breached') : isOverdue(t) ? 'Overdue' : 'Pending', (t.fields || []).map((x) => x.label + ': ' + x.value).join('; ')]);
    const csv = '﻿' + [cols, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `zenitude-desk-${label}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Exported ' + rows.length + ' ticket' + (rows.length === 1 ? '' : 's') + '.');
  }

  /* ---------- events ---------- */
  async function saveDepts(list, msg) {
    try { await S.db.doc('meta/org').set({ departments: list, updatedAt: now(), updatedBy: S.me.id }, { merge: true }); toast(msg); }
    catch (e) { fail(e); }
  }
  const actions = {
    'dept-add'() {
      const v = (S.draft.newDept || '').trim().replace(/\s+/g, ' ');
      if (!v) { toast('Type the department name first.', 'error'); return; }
      const l = deptList(); if (l.some((x) => x.toLowerCase() === v.toLowerCase())) { toast(v + ' is already in the list.', 'error'); return; }
      S.draft.newDept = ''; saveDepts(l.concat([v]), v + ' added.');
    },
    'dept-del'(el) { const l = deptList(), v = l[+el.dataset.i]; l.splice(+el.dataset.i, 1); saveDepts(l, v + ' removed from the list.'); },
    reload() { location.reload(); },
    async logout() { try { await S.auth.signOut(); } catch (e) { } S.f = EMPTY_FILTERS(); history.replaceState(null, '', location.pathname + location.search); readRoute(); },
    tab(el) { S.authTab = el.dataset.v; render(); },
    async forgot() {
      const L = S.draft.login, email = L.email.trim();
      if (!emailOk(email)) { L.err = 'Type your email above first, then press “Forgot your password?”.'; L.info = ''; return render(); }
      try { await S.auth.sendPasswordResetEmail(email); L.err = ''; L.info = 'If an account exists for ' + email + ', a reset link is on its way.'; }
      catch (e) { L.err = authMsg(e); L.info = ''; }
      render();
    },
    open(el, e) { if (e.target.closest('a')) return; go('ticket-' + el.dataset.id); },
    drill(el) {
      const k = el.dataset.k, v = el.dataset.v;
      S.f = EMPTY_FILTERS(); S.f.sort = 'due';
      if (k === 'status') S.f.status = v; else { S.f[k] = v; if (k === 'category') S.f.status = ''; }
      go('tickets');
    },
    'clear-filters'() { S.f = EMPTY_FILTERS(); render(); },
    'export-all'() { exportCsv(agentTickets().filter((t) => !S.dashDesk || deskId(t) === S.dashDesk), S.dashDesk || 'all'); },
    'export-filtered'() { exportCsv(filtered(), 'view'); },
    async take(el) {
      const id = el.dataset.id, t = S.tickets[id]; if (!t) return;
      const ch = { assigneeId: S.user.uid }, h = ['took ownership of the ticket'];
      if (t.status === 'Open') { ch.status = 'In Progress'; h.push('changed status from Open to In Progress'); }
      if (await update(id, ch, h)) toast('You now own ' + ref(t) + '.');
    },
    async 'confirm-close'(el) { if (await setStatus(el.dataset.id, 'Closed')) toast('Thank you. Ticket closed.'); },
    async reopen(el) { if (await setStatus(el.dataset.id, 'In Progress')) toast('Ticket reopened. The team can see it in their queue again.'); },
    'delete-ticket'(el) { S.modal = { type: 'delete', id: el.dataset.id }; render(); },
    async 'do-delete'(el) { const id = el.dataset.id, t = S.tickets[id]; S.modal = null; go('tickets'); if (await deleteTicket(id)) toast((t ? ref(t) : 'Ticket') + ' deleted.'); },
    async 'reset-mail'(el) { const u = S.users[el.dataset.id]; try { await S.auth.sendPasswordResetEmail(u.email); toast('Password reset email sent to ' + u.email + '.'); } catch (e) { toast(authMsg(e), 'error'); } },
    async 'toggle-user'(el) {
      const id = el.dataset.id, u = S.users[id], active = u.active === false;
      try { await S.db.collection('users').doc(id).update({ active }); toast(u.name + (active ? ' can sign in again.' : ' has been disabled.')); } catch (e) { fail(e); }
    },
    chpw() { S.modal = { type: 'chpw' }; render(); },
    'close-modal'() { closeModal(); },
    overlay(el, e) { if (e.target === el) closeModal(); },
    'dash-desk'(el) { S.dashDesk = el.dataset.v; render(); },
    'pick-desk'(el) { const d = S.draft.nt; if (d.deskId !== el.dataset.id) { d.deskId = el.dataset.id; d.category = categoriesOf(d.deskId)[0]; d.fields = {}; d.err = ''; } render(); },
    'cat-add'() { const d = S.deskDraft, c = (d.newCat || '').trim(); if (c && !d.categories.includes(c)) d.categories.push(c); d.newCat = ''; render(); const i = document.getElementById('dd-newcat'); if (i) i.focus(); },
    'cat-del'(el) { S.deskDraft.categories.splice(+el.dataset.i, 1); render(); },
    'field-add'() { S.deskDraft.fields.push({ id: 'f' + Math.random().toString(36).slice(2, 8), label: '', type: 'text', required: false, optionsText: '' }); render(); const i = document.getElementById('df-l-' + (S.deskDraft.fields.length - 1)); if (i) i.focus(); },
    'field-del'(el) { S.deskDraft.fields.splice(+el.dataset.i, 1); render(); },
    'field-up'(el) { const f = S.deskDraft.fields, i = +el.dataset.i; if (i > 0) [f[i - 1], f[i]] = [f[i], f[i - 1]]; render(); },
    'field-down'(el) { const f = S.deskDraft.fields, i = +el.dataset.i; if (i < f.length - 1) [f[i + 1], f[i]] = [f[i], f[i + 1]]; render(); },
    unattach(el) { const k = el.dataset.key; S.pending[k] = (S.pending[k] || []).filter((p) => p.id !== el.dataset.id); render(); },
    'view-file'(el) { openFile(el.dataset.tid, el.dataset.id); },
    'file-del-ask'() { S.modal.confirm = true; render(); },
    'file-del-cancel'() { S.modal.confirm = false; render(); },
    async 'file-del'() {
      const { tid, fid } = S.modal;
      try {
        const ref = S.db.collection('tickets').doc(tid).collection('files').doc(fid);
        const b = S.db.batch(); b.delete(ref.collection('content').doc('full')); b.delete(ref); await b.commit();
        closeModal(); toast('Screenshot deleted.');
      } catch (e) { fail(e); }
    },
  };
  const changes = {
    async status(el) {
      const id = el.dataset.id, to = el.value; if (!S.tickets[id] || to === S.tickets[id].status) return;
      if (to === 'Resolved') { S.modal = { type: 'resolve', id, note: '' }; render(); const ta = document.getElementById('m-note'); if (ta) ta.focus(); return; }
      if (await setStatus(id, to)) toast('Status changed to ' + to + '.'); else render();
    },
    async priority(el) {
      const id = el.dataset.id, p = el.value, t = S.tickets[id]; if (!t || t.priority === p) return;
      if (!(await update(id, { priority: p, dueAt: t.createdAt + slaFor(deskId(t), p) * HOUR }, [`changed priority from ${t.priority} to ${p}`]))) render();
    },
    async category(el) {
      const id = el.dataset.id, c = el.value, t = S.tickets[id]; if (!t || t.category === c) return;
      if (!(await update(id, { category: c }, [`changed category from ${t.category} to ${c}`]))) render();
    },
    async assignee(el) {
      const id = el.dataset.id, a = el.value || null, t = S.tickets[id]; if (!t || (t.assigneeId || null) === a) return;
      if (!(await update(id, { assigneeId: a }, [a ? 'assigned the ticket to ' + name(a) : 'removed the owner']))) render();
    },
    member(el) { const m = S.deskDraft.members, id = el.dataset.id; if (el.checked) { if (!m.includes(id)) m.push(id); } else m.splice(m.indexOf(id), 1); render(); },
    async desk(el) {
      const id = el.dataset.id, to = el.value, t = S.tickets[id]; if (!t || deskId(t) === to) return;
      const from = deskId(t), cats = categoriesOf(to);
      const ch = { deskId: to, assigneeId: null, dueAt: t.createdAt + slaFor(to, t.priority) * HOUR };
      if (!cats.includes(t.category)) ch.category = cats.includes('Other') ? 'Other' : cats[0];
      if (await update(id, ch, [`moved the ticket from ${deskName(from)} to ${deskName(to)}`])) {
        toast(`${ref(t)} moved to ${deskName(to)}.`);
        if (!isAgentOf(to) && t.requesterId !== S.me.id) go('tickets');
      } else render();
    },
    async dept(el) {
      const id = el.dataset.id, v = el.value;
      try { await S.db.collection('users').doc(id).update({ department: v }); toast(name(id) + (v ? ' is now in ' + v + '.' : ' has no department.')); } catch (e) { fail(e); render(); }
    },
    async role(el) {
      const id = el.dataset.id, role = el.value;
      try { await S.db.collection('users').doc(id).update({ role }); toast(name(id) + ' is now: ' + ROLE_CHOICES[role] + '.'); } catch (e) { fail(e); render(); }
    },
  };
  const forms = {
    async login() {
      const L = S.draft.login, email = L.email.trim();
      if (!email || !L.p) { L.err = 'Enter your email and password.'; L.info = ''; return render(); }
      S.busy = true; L.err = ''; L.info = ''; render();
      try { await S.auth.signInWithEmailAndPassword(email, L.p); S.draft.login = { email: '', p: '', err: '', info: '' }; go('dashboard'); }
      catch (e) { L.err = authMsg(e); L.p = ''; }
      S.busy = false; render();
    },
    async register() {
      const R = S.draft.reg, email = R.email.trim().toLowerCase(), nm = R.name.trim();
      R.err = nm.length < 2 ? 'Enter your full name.'
        : !emailOk(email) ? 'Enter a valid email address.'
        : !domainOk(email) ? 'Use your Zenitude work email (' + OPT.allowedEmailDomains.join(', ') + ').'
        : R.p.length < 6 ? 'Passwords need at least 6 characters.'
        : R.p !== R.p2 ? 'The passwords don\'t match.' : '';
      if (R.err) return render();
      S.busy = true; S.registering = true; render();
      try {
        const cred = await S.auth.createUserWithEmailAndPassword(email, R.p);
        try { await cred.user.updateProfile({ displayName: nm }); } catch (e) { }
        await S.db.collection('users').doc(cred.user.uid).set({ name: nm, email: cred.user.email || email, role: isAdminEmail(email) ? 'admin' : 'user', active: true, createdAt: now() });
        S.draft.reg = { name: '', email: '', p: '', p2: '', err: '' };
        go('dashboard'); toast('Welcome to Zenitude Desk, ' + nm.split(' ')[0] + '.');
      } catch (e) { R.err = String(e.code || '').startsWith('auth/') ? authMsg(e) : dbMsg(e); S.draft.profile.name = nm; }
      S.busy = false; S.registering = false; render();
    },
    async profile() {
      const d = S.draft.profile, nm = d.name.trim();
      if (nm.length < 2) { d.err = 'Enter your full name.'; return render(); }
      S.busy = true; render();
      try { await S.db.collection('users').doc(S.user.uid).set({ name: nm, email: S.user.email, role: isAdminEmail(S.user.email) ? 'admin' : 'user', active: true, createdAt: now() }); d.err = ''; }
      catch (e) { d.err = dbMsg(e); }
      S.busy = false; render();
    },
    'new-ticket'() { if (!S.busy) createTicket(); },
    async comment(form) {
      const id = form.dataset.id, typed = (S.draft.comment[id] || '').trim(), shots = S.pending[id] || [];
      if (!typed && !shots.length) return;
      if (S.attBusy === id) { toast('Wait a moment, the screenshot is still being prepared.'); return; }
      const t = S.tickets[id] || S.extra[id];
      const internal = !!t && isAgentOf(deskId(t)) && !!S.draft.internal[id];
      const text = typed || (shots.length === 1 ? 'Attached a screenshot.' : `Attached ${shots.length} screenshots.`);
      S.draft.comment[id] = ''; S.draft.internal[id] = false; S.pending[id] = []; render();
      try {
        const tRef = S.db.collection('tickets').doc(id), cRef = tRef.collection('comments').doc();
        const batch = S.db.batch();
        const fids = addFileWrites(batch, id, shots, internal, cRef.id);
        const c = { by: S.user.uid, at: now(), text, internal };
        if (fids.length) c.files = fids;
        batch.set(cRef, c);
        await batch.commit();
        await update(id, {}, []);
      } catch (e) { S.draft.comment[id] = typed; S.pending[id] = shots; fail(e); render(); }
    },
    async resolve() {
      const m = S.modal, note = (m.note || '').trim();
      if (note.length < 5) { m.err = 'Write a short resolution note (at least 5 characters).'; return render(); }
      S.modal = null; render();
      if (await setStatus(m.id, 'Resolved', note)) toast('Resolved. The requester will be asked to confirm.');
    },
    async chpw() {
      const m = S.modal;
      if (!m.c) { m.err = 'Enter your current password.'; return render(); }
      if (!m.n || m.n.length < 6) { m.err = 'The new password needs at least 6 characters.'; return render(); }
      if (m.n !== m.n2) { m.err = 'The new passwords don\'t match.'; return render(); }
      S.busy = true; render();
      try {
        const cred = S.fb.auth.EmailAuthProvider.credential(S.user.email, m.c);
        await S.user.reauthenticateWithCredential(cred);
        await S.user.updatePassword(m.n);
        S.modal = null; toast('Password changed.');
      } catch (e) { m.err = authMsg(e); }
      S.busy = false; render();
    },
    'new-user'() { if (!S.busy) addPerson(); },
    'desk-save'() { if (!S.busy) saveDesk(); },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const fn = actions[el.dataset.act]; if (!fn) return;
    if (el.tagName === 'BUTTON' || el.dataset.act === 'drill') e.preventDefault();
    fn(el, e);
  });
  document.addEventListener('input', (e) => {
    const el = e.target; if (!el.dataset || !el.dataset.bind) return;
    setPath(el.dataset.bind, el.type === 'checkbox' ? el.checked : el.value);
    if (el.dataset.rr !== undefined || el.type === 'checkbox') render();
  });
  document.addEventListener('change', (e) => { const el = e.target; if (el.dataset && el.dataset.chg && changes[el.dataset.chg]) changes[el.dataset.chg](el); });
  document.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target.dataset.form; if (forms[f]) forms[f](e.target); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.modal) closeModal();
    if (e.key === 'Enter' && e.target && e.target.id === 'dd-newcat') { e.preventDefault(); actions['cat-add'](); }
    if (e.key === 'Enter' && e.target && e.target.id === 'dept-new') { e.preventDefault(); actions['dept-add'](); }
  });
  // Screenshots: file picker, paste (Ctrl+V) and drag-and-drop
  document.addEventListener('change', (e) => { const el = e.target; if (el.dataset && el.dataset.attach) { addFiles(el.dataset.attach, el.files); el.value = ''; } });
  document.addEventListener('change', (e) => { const el = e.target; if (HR && el.dataset && el.dataset.hrdoc) { HR.uploadDocs(el.dataset.hrdoc, el.files); el.value = ''; } });
  function attachKey() {
    if (S.phase !== 'ready' || (S.modal && S.modal.type !== undefined)) return null;
    if (S.route === 'new') return 'new';
    if (S.route.startsWith('ticket-') && document.querySelector('form[data-form="comment"]')) return S.route.slice(7);
    return null;
  }
  document.addEventListener('paste', (e) => {
    const key = attachKey(); if (!key || !e.clipboardData) return;
    const files = [...e.clipboardData.items].filter((i) => i.kind === 'file' && /^image\//.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault(); addFiles(key, files);
  });
  document.addEventListener('dragover', (e) => { const z = e.target.closest && e.target.closest('[data-drop]'); if (z) { e.preventDefault(); z.classList.add('is-over'); } });
  document.addEventListener('dragleave', (e) => { const z = e.target.closest && e.target.closest('[data-drop]'); if (z) z.classList.remove('is-over'); });
  document.addEventListener('drop', (e) => { const z = e.target.closest && e.target.closest('[data-drop]'); if (!z) return; e.preventDefault(); z.classList.remove('is-over'); addFiles(z.dataset.drop, e.dataTransfer && e.dataTransfer.files); });
  setInterval(() => { const a = document.activeElement, typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); if (S.phase === 'ready' && !S.modal && !typing) render(); }, 60000);

  /* ---------- icons ---------- */
  function icon(n) {
    const p = {
      grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
      list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.6 5.2"/>',
      download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
      desk: '<path d="M3 10h18M5 10V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3M6 10v9M18 10v9M9 14h6"/>',
      image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
      calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
      cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>',
      cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    }[n] || '';
    return `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  }

  /* ---------- HR module (hr.js) ---------- */
  HR = window.ZenHRModule ? window.ZenHRModule({
    S, esc, opt, icon, name, byName, rel, toast, fail, dbMsg, render, go, now, isAdmin, isAgentOf, deskName, slaFor, categoriesOf, emailOk, deptList,
    prepareImage, dataUrlToBlob, closeModal, HOUR,
  }) : null;
  if (HR) { Object.assign(actions, HR.actions); Object.assign(changes, HR.changes); Object.assign(forms, HR.forms); }

  boot();
})();
