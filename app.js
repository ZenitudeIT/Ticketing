/* =========================================================
   ZENITUDE DESK — IT service desk
   ---------------------------------------------------------
   Plain JavaScript, no build step. Data and sign-in use the
   Firebase JS SDK (v10, compat) on project ticketing-de6b4:
     • Firebase Authentication (email + password)
     • Cloud Firestore: users, tickets, tickets/{id}/comments, meta/counter
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
  const SLA_HOURS = { Low: 72, Medium: 24, High: 8, Critical: 4 };
  const CATEGORIES = ['Hardware', 'Software', 'Network & Wi-Fi', 'Accounts & Access', 'Email', 'Phones & Mobile', 'Website', 'Printer', 'Other'];
  const ROLES = { user: 'Team member', tech: 'IT technician', admin: 'IT administrator' };
  const FLOW = {
    'Open': ['In Progress', 'On Hold', 'Resolved'],
    'In Progress': ['On Hold', 'Resolved'],
    'On Hold': ['In Progress', 'Resolved'],
    'Resolved': ['Closed', 'In Progress'],
    'Closed': ['In Progress'],
  };
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const EMPTY_FILTERS = () => ({ q: '', status: 'active', priority: '', assignee: '', category: '', sort: 'updated' });

  /* ---------- state ---------- */
  const S = {
    phase: 'boot',            // boot | signed-out | profile | disabled | ready | error
    fatal: '',
    fb: null, auth: null, db: null,
    user: null,               // Firebase auth user
    me: null,                 // users/{uid} document + id
    users: {}, tickets: {}, ticketsLoaded: false, usersLoaded: false,
    comments: [], cTid: null, cLoaded: false, cErr: false, extra: {}, probe: {},
    subStaff: null, unsub: {},
    route: 'dashboard', modal: null, busy: false, registering: false, dataErr: '',
    f: EMPTY_FILTERS(),
    authTab: 'login',
    draft: {
      comment: {}, internal: {},
      nt: { title: '', description: '', category: 'Hardware', priority: 'Medium', requesterId: '', err: '' },
      login: { email: '', p: '', err: '', info: '' },
      reg: { name: '', email: '', p: '', p2: '', err: '' },
      profile: { name: '', err: '' },
      nu: { name: '', email: '', role: 'user', p: '', err: '' },
    },
  };

  /* ---------- helpers ---------- */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();
  const cls = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  const ref = (t) => 'ZEN-' + t.num;
  const isStaff = () => !!S.me && (S.me.role === 'tech' || S.me.role === 'admin');
  const isAdmin = () => !!S.me && S.me.role === 'admin';
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
  const visibleTickets = () => (isStaff() ? ticketsArr() : ticketsArr().filter((t) => t.requesterId === S.me.id));
  const staffList = () => Object.entries(S.users).filter(([, u]) => (u.role === 'tech' || u.role === 'admin') && u.active !== false).map(([id]) => id).sort((a, b) => name(a).localeCompare(name(b)));
  function setPath(path, v) { const ks = path.split('.'); let o = S; for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = {}; o = o[ks[i]]; } o[ks[ks.length - 1]] = v; }
  const pill = (kind, v) => `<span class="pill ${kind}-${cls(v)}"><i></i>${esc(v)}</span>`;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  function slaCell(t) {
    if (!t.dueAt) return '<span class="muted">—</span>';
    if (ACTIVE.includes(t.status)) {
      const left = t.dueAt - now(), win = SLA_HOURS[t.priority] * HOUR;
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
    S.unsub = {}; S.subStaff = null; S.cTid = null;
    S.users = {}; S.tickets = {}; S.comments = []; S.extra = {}; S.probe = {}; S.ticketsLoaded = false; S.usersLoaded = false; S.dataErr = '';
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
      startData();
      render();
    }, (e) => { S.phase = 'error'; S.fatal = dbMsg(e); render(); });
  }
  function stopData() {
    ['t', 'u', 'c'].forEach((k) => { if (S.unsub[k]) { S.unsub[k](); delete S.unsub[k]; } });
    S.subStaff = null; S.cTid = null; S.ticketsLoaded = false;
  }
  function startData() {
    const staff = isStaff();
    if (!S.unsub.u) {
      S.unsub.u = S.db.collection('users').onSnapshot((s) => {
        const o = {}; s.docs.forEach((d) => { o[d.id] = d.data(); }); S.users = o; S.usersLoaded = true; render();
      }, (e) => { console.error('[Zenitude Desk] users listener', e); S.dataErr = 'Team list couldn\'t load: ' + errText(e); render(); });
    }
    if (S.subStaff !== staff) {
      if (S.unsub.t) S.unsub.t();
      S.subStaff = staff; S.ticketsLoaded = false;
      const q = staff ? S.db.collection('tickets') : S.db.collection('tickets').where('requesterId', '==', S.user.uid);
      S.unsub.t = q.onSnapshot((s) => {
        const o = {}; s.docs.forEach((d) => { o[d.id] = d.data(); }); S.tickets = o; S.ticketsLoaded = true;
        Object.keys(S.extra).forEach((k) => { if (o[k]) delete S.extra[k]; }); render();
      }, (e) => { console.error('[Zenitude Desk] tickets listener', e); S.dataErr = 'Tickets couldn\'t load: ' + errText(e); S.ticketsLoaded = true; render(); });
      S.cTid = '__resub__';
    }
    syncComments();
  }
  function syncComments() {
    const id = S.phase === 'ready' && S.route.startsWith('ticket-') ? S.route.slice(7) : null;
    if (id === S.cTid) return;
    if (S.unsub.c) { S.unsub.c(); delete S.unsub.c; }
    S.cTid = id; S.comments = []; S.cLoaded = false; S.cErr = false;
    if (!id) return;
    if (!S.tickets[id] && !S.extra[id]) probeTicket(id);
    let q = S.db.collection('tickets').doc(id).collection('comments');
    if (!isStaff()) q = q.where('internal', '==', false);
    S.unsub.c = q.onSnapshot((s) => {
      S.comments = s.docs.map((d) => Object.assign({ id: d.id }, d.data())).sort((a, b) => a.at - b.at);
      S.cLoaded = true; render();
    }, () => { S.cLoaded = true; S.cErr = true; render(); });
  }

  // Read one ticket directly when it isn't in the live list (just created, or the list failed to load).
  function probeTicket(id) {
    if (S.probe[id] && S.probe[id].state === 'loading') return;
    S.probe[id] = { state: 'loading' };
    S.db.collection('tickets').doc(id).get().then((d) => {
      if (d.exists) { S.extra[id] = d.data(); S.probe[id] = { state: 'ok' }; }
      else S.probe[id] = { state: 'missing' };
      render();
    }).catch((e) => { console.error('[Zenitude Desk] ticket read', e); S.probe[id] = { state: 'error', msg: errText(e) }; render(); });
  }

  /* ---------- routing ---------- */
  function readRoute() { S.route = (location.hash || '').replace(/^#\/?/, '') || 'dashboard'; }
  function go(r) { if ((location.hash || '').slice(1) === r) { readRoute(); syncComments(); render(); } else location.hash = r; window.scrollTo(0, 0); }
  window.addEventListener('hashchange', () => { readRoute(); S.modal = null; syncComments(); render(); window.scrollTo(0, 0); });

  /* ---------- render ---------- */
  function render() {
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
    if (S.phase === 'disabled') return authFrame(`<h1 class="auth__title">Access paused</h1><p class="auth__sub">Your Zenitude Desk account has been disabled. Please contact the IT team.</p><button class="btn btn--ghost btn--full" data-act="logout">Sign out</button>`);
    if (!S.ticketsLoaded || !S.usersLoaded) return shell(`<div class="empty"><img src="assets/img/emblem-gold.png" alt="">Loading tickets…</div>`);
    return shell(content()) + modalView();
  }
  function authFrame(inner, foot) {
    return `<div class="auth"><div style="width:min(430px,100%)"><div class="auth__box"><div class="auth__brand"><img src="assets/img/emblem-gold.png" alt=""><span>ZENITUDE</span></div>${inner}</div>
      <p class="auth__foot">${foot || 'Zenitude Desk · IT service desk'}</p></div></div>`;
  }

  function shell(inner) {
    const r = S.route;
    const vis = visibleTickets();
    const act = vis.filter((t) => ACTIVE.includes(t.status)).length;
    const links = [['dashboard', 'Overview', 'grid'], ['tickets', isStaff() ? 'All tickets' : 'My tickets', 'list', act], ['new', 'New ticket', 'plus']];
    if (isAdmin()) links.push(['users', 'Team & roles', 'users']);
    const on = (k) => (r === k || (k === 'tickets' && r.startsWith('ticket-')) ? 'on' : '');
    return `<div class="layout">
      <aside class="side">
        <a class="side__brand" href="#dashboard"><img src="assets/img/emblem-gold.png" alt=""><div><strong>ZENITUDE</strong><small>IT Service Desk</small></div></a>
        <nav class="side__nav"><div class="side__label">Desk</div>
          ${links.map(([k, l, ic, c]) => `<a class="side__link ${on(k)}" href="#${k}">${icon(ic)}<span>${l}</span>${c ? `<span class="badge">${c}</span>` : ''}</a>`).join('')}
        </nav>
        <div class="side__foot">Zenitude Desk<br>IT service desk</div>
      </aside>
      <div class="main">
        <header class="top">
          <div class="who">
            <div class="avatar ${isStaff() ? 'avatar--gold' : ''}">${esc(initials(S.me.id))}</div>
            <div class="who__text"><div class="who__name">${esc(S.me.name)}</div><div class="who__mail">${esc(S.me.email || '')}</div></div>
            <span class="role">${esc(ROLES[S.me.role] || S.me.role)}</span>
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
    if (r === 'tickets') return ticketsView();
    if (r === 'new') return newTicketView();
    if (r === 'users') return isAdmin() ? usersView() : denied();
    if (r.startsWith('ticket-')) return ticketView(r.slice(7));
    return isStaff() ? staffDash() : userDash();
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
    const all = ticketsArr(), st = stats(all);
    const byStatus = ACTIVE.map((s) => [s, st.active.filter((t) => t.status === s).length]);
    const byPri = PRIORITIES.slice().reverse().map((p) => [p, st.active.filter((t) => t.priority === p).length]);
    const byCat = CATEGORIES.map((c) => [c, all.filter((t) => t.category === c).length]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
    const attention = st.active.filter((t) => isOverdue(t) || (!t.assigneeId && (t.priority === 'Critical' || t.priority === 'High'))).sort((a, b) => a.dueAt - b.dueAt).slice(0, 8);
    const techs = staffList();
    return `<div class="head"><div class="grow"><div class="eyebrow">Service desk</div><h1>Overview</h1><p>Every ticket across the team, live. Click a bar to open the matching list.</p></div>
      <button class="btn btn--ghost" data-act="export-all" ${all.length ? '' : 'disabled'}>${icon('download')} Export CSV</button>
      <a class="btn btn--primary" href="#new">${icon('plus')} New ticket</a></div>
    ${!all.length ? `<div class="banner banner--info">No tickets yet. Raise the first one with <b>New ticket</b>, or invite the team from <b>Team &amp; roles</b>.</div>` : ''}
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
      <div class="panel span2"><div class="panel__h"><h2>Technician workload</h2></div><div class="panel__b panel__b--flush"><div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Technician</th><th>Active</th><th>Overdue</th><th>Resolved</th><th>Avg. resolution</th><th>SLA met</th></tr></thead>
        <tbody>${techs.map((id) => { const s = stats(all.filter((t) => t.assigneeId === id));
          return `<tr class="click" data-act="drill" data-k="assignee" data-v="${esc(id)}"><td><div class="row"><div class="avatar avatar--gold">${esc(initials(id))}</div><div><div class="ttl">${esc(name(id))}</div><div class="sub">${esc(ROLES[S.users[id].role])}</div></div></div></td>
            <td>${s.active.length}</td><td>${s.overdue ? `<span class="sla sla--bad">${s.overdue}</span>` : '0'}</td><td>${s.resolved.length}</td><td>${s.avg == null ? '—' : dur(s.avg)}</td><td>${s.slaPct == null ? '—' : s.slaPct + '%'}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">No technicians yet. Promote someone on Team &amp; roles.</td></tr>'}</tbody></table></div></div></div>
    </div>`;
  }
  function userDash() {
    const mine = visibleTickets(), st = stats(mine);
    const awaiting = mine.filter((t) => t.status === 'Resolved');
    const recent = mine.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
    const first = (S.me.name || '').split(' ')[0];
    return `<div class="head"><div class="grow"><div class="eyebrow">IT service desk</div><h1>Welcome${first ? ', ' + esc(first) : ''}</h1><p>Something not working? Tell the IT team and follow the fix here.</p></div>
      <a class="btn btn--primary" href="#new">${icon('plus')} Report an issue</a></div>
    <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      ${kpi('My active tickets', st.active.length, 'Being handled by IT')}
      ${kpi('Awaiting your confirmation', awaiting.length, 'Marked resolved', awaiting.length > 0)}
      ${kpi('Closed', mine.filter((t) => t.status === 'Closed').length, 'All time')}
    </div>
    ${awaiting.length ? `<div class="banner">IT has resolved ${awaiting.length === 1 ? 'one of your tickets' : awaiting.length + ' of your tickets'}. Open ${awaiting.length === 1 ? 'it' : 'them'} to confirm the fix, or reopen if the problem continues.</div>` : ''}
    <div class="panel"><div class="panel__h"><h2>Recent activity</h2><a class="small" href="#tickets" style="margin-left:auto">View all</a></div>
      <div class="panel__b panel__b--flush">${recent.length ? ticketTable(recent, false) : `<div class="empty"><img src="assets/img/emblem-gold.png" alt="">You haven't raised any tickets yet.</div>`}</div></div>`;
  }

  /* ---------- ticket list ---------- */
  function filtered() {
    let a = visibleTickets();
    const f = S.f, q = f.q.trim().toLowerCase();
    if (q) a = a.filter((t) => [ref(t), t.title, t.description, name(t.requesterId), t.assigneeId ? name(t.assigneeId) : '', t.category].join(' ').toLowerCase().includes(q));
    if (f.status === 'active') a = a.filter((t) => ACTIVE.includes(t.status));
    else if (f.status === 'overdue') a = a.filter(isOverdue);
    else if (f.status) a = a.filter((t) => t.status === f.status);
    if (f.priority) a = a.filter((t) => t.priority === f.priority);
    if (f.category) a = a.filter((t) => t.category === f.category);
    if (isStaff()) {
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
      <td style="max-width:380px"><a class="ttl" href="#ticket-${esc(t.id)}">${esc(t.title)}</a><div class="sub">${esc(t.category)}</div></td>
      ${staffCols ? `<td>${esc(name(t.requesterId))}</td>` : ''}
      <td>${t.assigneeId ? esc(name(t.assigneeId)) : '<span class="muted">Unassigned</span>'}</td>
      <td>${pill('pr', t.priority)}</td><td>${pill('st', t.status)}</td><td>${slaCell(t)}</td>
      <td class="hide-sm small muted" title="${esc(fmtDate(t.updatedAt))}">${rel(t.updatedAt)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function ticketsView() {
    const list = filtered(), f = S.f, staff = isStaff();
    const any = f.q || f.status !== 'active' || f.priority || f.category || f.assignee;
    return `<div class="head"><div class="grow"><div class="eyebrow">Tickets</div><h1>${staff ? 'All tickets' : 'My tickets'}</h1><p>${list.length} ticket${list.length === 1 ? '' : 's'} match the current filters.</p></div>
      ${staff ? `<button class="btn btn--ghost" data-act="export-filtered" ${list.length ? '' : 'disabled'}>${icon('download')} Export view</button>` : ''}
      <a class="btn btn--primary" href="#new">${icon('plus')} New ticket</a></div>
    <div class="panel">
      <div class="filters">
        <input id="f-q" class="input search" placeholder="Search reference, subject, person…" value="${esc(f.q)}" data-bind="f.q" data-rr aria-label="Search tickets">
        <select id="f-status" class="input" data-bind="f.status" data-rr aria-label="Status">${opt('active', 'Active', f.status)}${opt('', 'Any status', f.status)}${opt('overdue', 'Overdue', f.status)}${STATUSES.map((s) => opt(s, s, f.status)).join('')}</select>
        <select id="f-pri" class="input" data-bind="f.priority" data-rr aria-label="Priority">${opt('', 'Any priority', f.priority)}${PRIORITIES.map((p) => opt(p, p, f.priority)).join('')}</select>
        <select id="f-cat" class="input" data-bind="f.category" data-rr aria-label="Category">${opt('', 'Any category', f.category)}${CATEGORIES.map((c) => opt(c, c, f.category)).join('')}</select>
        ${staff ? `<select id="f-asg" class="input" data-bind="f.assignee" data-rr aria-label="Owner">${opt('', 'Any owner', f.assignee)}${opt('me', 'Mine', f.assignee)}${opt('none', 'Unassigned', f.assignee)}${staffList().map((id) => opt(id, name(id), f.assignee)).join('')}</select>` : ''}
        <select id="f-sort" class="input" data-bind="f.sort" data-rr aria-label="Sort">${opt('updated', 'Recently updated', f.sort)}${opt('newest', 'Newest', f.sort)}${opt('oldest', 'Oldest', f.sort)}${opt('priority', 'Priority', f.sort)}${opt('due', 'SLA due', f.sort)}</select>
        ${any ? '<button class="btn btn--link small" data-act="clear-filters">Clear</button>' : ''}
      </div>
      ${list.length ? ticketTable(list, staff) : '<div class="empty">No tickets match these filters.</div>'}
    </div>`;
  }

  /* ---------- new ticket ---------- */
  function newTicketView() {
    const d = S.draft.nt;
    const people = Object.entries(S.users).filter(([id, u]) => u.active !== false && id !== S.me.id).map(([id]) => id).sort((a, b) => name(a).localeCompare(name(b)));
    return `<div class="head"><div class="grow"><div class="eyebrow">Report an issue</div><h1>New ticket</h1><p>Describe what's wrong. The response target is set by the priority.</p></div></div>
    <div class="panel" style="max-width:780px"><form class="panel__b" data-form="new-ticket" style="padding:1.5rem">
      ${isStaff() ? `<div class="field"><label class="lbl" for="nt-req">Raised for</label><select id="nt-req" class="input" data-bind="draft.nt.requesterId">${opt('', 'Myself', d.requesterId)}${people.map((u) => opt(u, name(u) + (S.users[u].email ? ' · ' + S.users[u].email : ''), d.requesterId)).join('')}</select><div class="hint">Log a ticket for a colleague, for example after a phone call.</div></div>` : ''}
      <div class="field"><label class="lbl" for="nt-title">Subject</label><input id="nt-title" class="input" maxlength="120" placeholder="e.g. Shared drive won't open on my laptop" value="${esc(d.title)}" data-bind="draft.nt.title"></div>
      <div class="row wrap" style="gap:1rem;align-items:flex-start">
        <div class="field grow" style="min-width:200px"><label class="lbl" for="nt-cat">Category</label><select id="nt-cat" class="input" data-bind="draft.nt.category">${CATEGORIES.map((c) => opt(c, c, d.category)).join('')}</select></div>
        <div class="field grow" style="min-width:200px"><label class="lbl" for="nt-pri">Priority</label><select id="nt-pri" class="input" data-bind="draft.nt.priority">${PRIORITIES.map((p) => opt(p, `${p} · within ${SLA_HOURS[p]}h`, d.priority)).join('')}</select></div>
      </div>
      <div class="field"><label class="lbl" for="nt-desc">Description</label><textarea id="nt-desc" class="input" rows="6" maxlength="5000" placeholder="What happened, when it started, any error message, and what you've already tried…" data-bind="draft.nt.description">${esc(d.description)}</textarea>
        <div class="hint">Use Critical only when something stops the whole team from working, such as an email or network outage.</div></div>
      ${d.err ? `<div class="err">${esc(d.err)}</div>` : ''}
      <div class="row" style="justify-content:flex-end;margin-top:.6rem"><a class="btn btn--ghost" href="#tickets">Cancel</a><button class="btn btn--primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Submitting…' : 'Submit ticket'}</button></div>
    </form></div>`;
  }
  async function createTicket() {
    const d = S.draft.nt;
    const title = d.title.trim(), description = d.description.trim();
    if (title.length < 5) { d.err = 'Give the ticket a subject of at least 5 characters.'; return render(); }
    if (description.length < 10) { d.err = 'Add a description of at least 10 characters so IT can help.'; return render(); }
    const uid = S.user.uid, n = now();
    const requester = isStaff() && d.requesterId ? d.requesterId : uid;
    const base = {
      title, description, category: d.category, priority: d.priority, status: 'Open',
      requesterId: requester, assigneeId: null, createdBy: uid,
      createdAt: n, updatedAt: n, dueAt: n + SLA_HOURS[d.priority] * HOUR,
      resolvedAt: null, closedAt: null, resolution: '',
      history: [{ at: n, by: uid, text: requester !== uid ? 'logged the ticket for ' + name(requester) : 'raised the ticket' }],
    };
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
      S.draft.nt = { title: '', description: '', category: 'Hardware', priority: 'Medium', requesterId: '', err: '' };
      S.busy = false;
      toast('ZEN-' + num + ' raised. Target: within ' + SLA_HOURS[base.priority] + 'h.');
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
    const staff = isStaff(), mine = t.requesterId === S.me.id, closed = t.status === 'Closed';
    const comments = S.comments.filter((c) => staff || !c.internal);
    const items = [...(t.history || []).map((h) => ({ k: 'h', at: h.at, h })), ...comments.map((c) => ({ k: 'c', at: c.at, c }))].sort((a, b) => a.at - b.at);
    const timeline = items.map((it) => it.k === 'h'
      ? `<div class="ev"><span class="ev__dot"></span><div><b>${esc(name(it.h.by))}</b> ${esc(it.h.text)} <span title="${esc(fmtDate(it.at))}">· ${rel(it.at)}</span></div></div>`
      : `<div class="cm"><div class="avatar ${S.users[it.c.by] && S.users[it.c.by].role !== 'user' ? 'avatar--gold' : ''}">${esc(initials(it.c.by))}</div>
          <div class="cm__body ${it.c.internal ? 'cm__body--note' : ''} ${it.c.resolution ? 'cm__body--res' : ''}">
          <div class="cm__head"><b>${esc(name(it.c.by))}</b>${S.users[it.c.by] && S.users[it.c.by].role !== 'user' ? '<span class="tag">IT</span>' : ''}${it.c.internal ? '<span class="tag tag--note">Internal note</span>' : ''}${it.c.resolution ? '<span class="tag tag--res">Resolution</span>' : ''}${it.c.source === 'email' ? '<span class="tag">By email</span>' : ''}<span class="muted" title="${esc(fmtDate(it.at))}">${rel(it.at)}</span></div>
          <div class="cm__text">${esc(it.c.text)}</div></div></div>`).join('');
    const next = (FLOW[t.status] || []).filter(() => !(closed && !isAdmin()));
    const statusCtl = staff
      ? `<select id="st-${esc(id)}" class="input" data-chg="status" data-id="${esc(id)}" ${next.length ? '' : 'disabled'} aria-label="Change status">${opt(t.status, t.status, t.status)}${next.map((s) => opt(s, '→ ' + s, '')).join('')}</select>`
      : pill('st', t.status);
    const owners = staffList();
    const confirmBox = !staff && mine && t.status === 'Resolved'
      ? `<div class="panel" style="margin-bottom:1.1rem;border-color:var(--gold)"><div class="panel__b"><h2 style="font-size:1.25rem">Is everything working again?</h2><p class="small t2" style="margin:.3rem 0 .9rem">IT marked this ticket as resolved. Confirm to close it, or reopen it if the problem is still there.</p>
         <div class="row"><button class="btn btn--primary" data-act="confirm-close" data-id="${esc(id)}">Yes, close the ticket</button><button class="btn btn--ghost" data-act="reopen" data-id="${esc(id)}">No, reopen it</button></div></div></div>` : '';
    const canComment = !closed || staff;
    return `<div class="small" style="margin-bottom:.8rem"><a href="#tickets">← ${staff ? 'All tickets' : 'My tickets'}</a></div>
    <div class="head"><div class="grow"><div class="row wrap" style="margin-bottom:.5rem"><span class="mono muted">${esc(ref(t))}</span>${pill('st', t.status)}${pill('pr', t.priority)}${slaCell(t)}</div><h1>${esc(t.title)}</h1></div>
      ${isAdmin() ? `<button class="btn btn--danger-ghost btn--sm" data-act="delete-ticket" data-id="${esc(id)}">Delete</button>` : ''}</div>
    <div class="detail">
      <div>
        ${confirmBox}
        <div class="panel" style="margin-bottom:1.1rem"><div class="panel__h"><h2>Description</h2><span class="small muted" style="margin-left:auto">${esc(name(t.requesterId))} · ${esc(fmtDate(t.createdAt))}</span></div>
          <div class="panel__b"><div class="desc">${esc(t.description)}</div>
          ${t.resolution && (t.status === 'Resolved' || closed) ? `<div class="res"><b>Resolution</b><div class="desc">${esc(t.resolution)}</div></div>` : ''}</div></div>
        <div class="panel"><div class="panel__h"><h2>Activity</h2><span class="small muted">${comments.length} comment${comments.length === 1 ? '' : 's'} · ${(t.history || []).length} events</span></div>
          <div class="panel__b"><div class="timeline">${timeline}${!S.cLoaded ? '<div class="small muted">Loading comments…</div>' : ''}${S.cErr ? '<div class="err">Comments couldn\'t be loaded.</div>' : ''}</div>
          <div style="margin-top:1.3rem;border-top:1px solid var(--line);padding-top:1.1rem">
          ${canComment ? `<form data-form="comment" data-id="${esc(id)}">
            <label class="lbl" for="c-${esc(id)}">${staff ? 'Reply or add a note' : 'Add a comment'}</label>
            <textarea id="c-${esc(id)}" class="input" rows="3" maxlength="4000" placeholder="${staff ? 'Reply to the requester, or tick “Internal note” for IT eyes only…' : 'Add detail or reply to IT…'}" data-bind="draft.comment.${esc(id)}">${esc(S.draft.comment[id] || '')}</textarea>
            <div class="row" style="margin-top:.6rem">${staff ? `<label class="check"><input type="checkbox" id="ci-${esc(id)}" data-bind="draft.internal.${esc(id)}" ${S.draft.internal[id] ? 'checked' : ''}> Internal note (hidden from requester)</label>` : ''}<span class="grow"></span><button class="btn ${S.draft.internal[id] ? 'btn--gold' : 'btn--primary'}" type="submit">${S.draft.internal[id] ? 'Add note' : 'Post comment'}</button></div>
          </form>` : '<div class="small muted">This ticket is closed. Raise a new ticket if the problem comes back.</div>'}
          </div></div></div>
      </div>
      <div>
        <div class="panel"><div class="panel__h"><h2>Details</h2></div><div class="panel__b"><div class="kv">
          <div class="k">Status</div><div>${statusCtl}</div>
          <div class="k">Priority</div><div>${staff ? `<select id="pr-${esc(id)}" class="input" data-chg="priority" data-id="${esc(id)}" ${closed ? 'disabled' : ''} aria-label="Priority">${PRIORITIES.map((p) => opt(p, p + ' · ' + SLA_HOURS[p] + 'h', t.priority)).join('')}</select>` : pill('pr', t.priority)}</div>
          <div class="k">Category</div><div>${staff ? `<select id="ca-${esc(id)}" class="input" data-chg="category" data-id="${esc(id)}" ${closed ? 'disabled' : ''} aria-label="Category">${CATEGORIES.concat(CATEGORIES.includes(t.category) ? [] : [t.category]).map((c) => opt(c, c, t.category)).join('')}</select>` : esc(t.category)}</div>
          <div class="k">Owner</div><div>${staff ? `<select id="as-${esc(id)}" class="input" data-chg="assignee" data-id="${esc(id)}" ${closed ? 'disabled' : ''} aria-label="Owner">${opt('', 'Unassigned', t.assigneeId || '')}${owners.map((a) => opt(a, name(a), t.assigneeId || '')).join('')}${t.assigneeId && !owners.includes(t.assigneeId) ? opt(t.assigneeId, name(t.assigneeId) + ' (inactive)', t.assigneeId) : ''}</select>
            ${t.assigneeId !== S.me.id && !closed ? `<button class="btn btn--ghost btn--sm" style="margin-top:.45rem" data-act="take" data-id="${esc(id)}">Take ownership</button>` : ''}` : (t.assigneeId ? esc(name(t.assigneeId)) : '<span class="muted">Not assigned yet</span>')}</div>
          <div class="k">Raised by</div><div>${esc(name(t.requesterId))}</div>
          <div class="k">Raised</div><div>${esc(fmtDate(t.createdAt))}</div>
          <div class="k">Target</div><div>${esc(fmtDate(t.dueAt))}<div class="small">${slaCell(t)}</div></div>
          <div class="k">Resolved</div><div>${t.resolvedAt ? esc(fmtDate(t.resolvedAt)) + `<div class="small muted">after ${dur(resTime(t))}</div>` : '<span class="muted">—</span>'}</div>
          <div class="k">Updated</div><div title="${esc(fmtDate(t.updatedAt))}">${rel(t.updatedAt)}</div>
        </div></div></div>
        ${staff ? '<p class="small muted" style="margin:.8rem .3rem 0">Resolving asks for a note the requester will see. Changing the status of an unassigned ticket makes you its owner.</p>' : ''}
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
    if (isStaff() && !t.assigneeId && to !== 'Closed') { ch.assigneeId = S.user.uid; h.push('took ownership of the ticket'); }
    if (to === 'Resolved') { ch.resolvedAt = n; ch.resolution = note; }
    if (to === 'Closed') ch.closedAt = n;
    if (reopening) { ch.resolvedAt = null; ch.closedAt = null; ch.resolution = ''; }
    h.push(!isStaff() && to === 'Closed' ? 'confirmed the fix and closed the ticket' : reopening ? `reopened the ticket (${from} → ${to})` : `changed status from ${from} to ${to}`);
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
    const ids = Object.keys(S.users).sort((a, b) => (order[S.users[a].role] - order[S.users[b].role]) || name(a).localeCompare(name(b)));
    return `<div class="head"><div class="grow"><div class="eyebrow">Administration</div><h1>Team &amp; roles</h1><p>${ids.length} people. Team members raise tickets, technicians resolve them, administrators also manage the team.</p></div></div>
    <div class="panel" style="margin-bottom:1.1rem"><div class="panel__h"><h2>Add a person</h2></div>
      <form class="panel__b" data-form="new-user"><div class="row wrap" style="gap:.8rem;align-items:flex-end">
        <div style="flex:1;min-width:160px"><label class="lbl" for="nu-name">Full name</label><input id="nu-name" class="input" value="${esc(d.name)}" data-bind="draft.nu.name" placeholder="Jade Moutou"></div>
        <div style="flex:1.2;min-width:190px"><label class="lbl" for="nu-email">Email</label><input id="nu-email" class="input" type="email" value="${esc(d.email)}" data-bind="draft.nu.email" placeholder="name@company.com" autocomplete="off"></div>
        <div style="width:170px"><label class="lbl" for="nu-role">Role</label><select id="nu-role" class="input" data-bind="draft.nu.role">${Object.entries(ROLES).map(([k, v]) => opt(k, v, d.role)).join('')}</select></div>
        <div style="flex:1;min-width:160px"><label class="lbl" for="nu-p">Temporary password</label><input id="nu-p" class="input" type="password" value="${esc(d.p)}" data-bind="draft.nu.p" autocomplete="new-password" placeholder="6+ characters"></div>
        <button class="btn btn--primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Adding…' : 'Add person'}</button>
      </div>${d.err ? `<div class="err">${esc(d.err)}</div>` : ''}<div class="hint">They can sign in straight away and change the password from the top bar.</div></form></div>
    <div class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Person</th><th>Role</th><th>Raised</th><th>Owns</th><th>Access</th><th></th></tr></thead><tbody>
    ${ids.map((id) => { const u = S.users[id], self = id === S.me.id, off = u.active === false, locked = self || isAdminEmail(u.email);
      return `<tr><td><div class="row"><div class="avatar ${u.role !== 'user' ? 'avatar--gold' : ''}">${esc(initials(id))}</div><div><div class="ttl">${esc(u.name)}</div><div class="sub" style="overflow-wrap:anywhere">${esc(u.email || '')}</div>${self || isAdminEmail(u.email) ? `<div class="row" style="gap:.3rem;margin-top:.2rem">${self ? '<span class="tag">You</span>' : ''}${isAdminEmail(u.email) ? '<span class="tag tag--note">Main admin</span>' : ''}</div>` : ''}</div></div></td>
        <td><select id="ro-${esc(id)}" class="input" style="height:32px;min-width:150px" data-chg="role" data-id="${esc(id)}" ${locked ? 'disabled' : ''} aria-label="Role for ${esc(u.name)}">${Object.entries(ROLES).map(([k, v]) => opt(k, v, u.role)).join('')}</select></td>
        <td>${all.filter((t) => t.requesterId === id).length}</td><td class="nowrap">${all.filter((t) => t.assigneeId === id && ACTIVE.includes(t.status)).length} active</td>
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
      await S.db.collection('users').doc(cred.user.uid).set({ name: nm, email, role: d.role, active: true, createdAt: now() });
      await sec.auth().signOut();
      toast(nm + ' added (' + ROLES[d.role] + ').');
      S.draft.nu = { name: '', email: '', role: 'user', p: '', err: '' };
    } catch (e) { d.err = e && String(e.code || '').startsWith('auth/') ? authMsg(e) : dbMsg(e); console.error(e); }
    S.busy = false; render();
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
          <div class="hint" style="text-align:center;margin-top:.8rem">New accounts can raise tickets. The IT administrator grants technician access.</div>
        </form>`;
    return authFrame(`<h1 class="auth__title">Zenitude Desk</h1><p class="auth__sub">Raise and track IT support requests</p>${tabs}${body}`);
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
    const wrap = (title, body, foot) => `<div class="modal" data-act="overlay"><div class="modal__box" role="dialog" aria-modal="true"><div class="modal__head"><h3>${title}</h3></div><div class="modal__body">${body}</div><div class="modal__foot">${foot}</div></div></div>`;
    const cancel = '<button type="button" class="btn btn--ghost" data-act="close-modal">Cancel</button>';
    if (m.type === 'resolve') return `<form data-form="resolve">${wrap('Resolve ticket',
      `<p class="small t2" style="margin-bottom:.8rem">Explain the fix in plain words. The requester sees this note and is asked to confirm.</p>
       <textarea id="m-note" class="input" rows="4" data-bind="modal.note" placeholder="e.g. Reconnected the office router and confirmed the internet is back.">${esc(m.note || '')}</textarea>${m.err ? `<div class="err">${esc(m.err)}</div>` : ''}`,
      cancel + '<button class="btn btn--primary" type="submit">Mark resolved</button>')}</form>`;
    if (m.type === 'delete') { const t = S.tickets[m.id]; return wrap(`Delete ${t ? esc(ref(t)) : 'ticket'}?`,
      `<p class="t2">“${t ? esc(t.title) : ''}”, with its comments and history, will be removed for everyone. This can't be undone.</p>`,
      cancel + `<button class="btn btn--danger" data-act="do-delete" data-id="${esc(m.id)}">Delete ticket</button>`); }
    if (m.type === 'chpw') return `<form data-form="chpw">${wrap('Change your password',
      `<div class="field"><label class="lbl" for="m-c">Current password</label><input id="m-c" class="input" type="password" autocomplete="current-password" value="${esc(m.c || '')}" data-bind="modal.c"></div>
       <div class="field"><label class="lbl" for="m-n">New password</label><input id="m-n" class="input" type="password" autocomplete="new-password" value="${esc(m.n || '')}" data-bind="modal.n"></div>
       <div class="field"><label class="lbl" for="m-n2">Confirm new password</label><input id="m-n2" class="input" type="password" autocomplete="new-password" value="${esc(m.n2 || '')}" data-bind="modal.n2"></div>${m.err ? `<div class="err">${esc(m.err)}</div>` : ''}`,
      cancel + `<button class="btn btn--primary" type="submit" ${S.busy ? 'disabled' : ''}>Update password</button>`)}</form>`;
    return '';
  }

  /* ---------- CSV ---------- */
  function exportCsv(list, label) {
    const cols = ['Ref', 'Subject', 'Category', 'Priority', 'Status', 'Raised by', 'Owner', 'Raised', 'Target', 'Resolved', 'Closed', 'Resolution hours', 'SLA'];
    const iso = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '');
    const q = (v) => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const rows = list.slice().sort((a, b) => a.num - b.num).map((t) => [ref(t), t.title, t.category, t.priority, t.status, name(t.requesterId), t.assigneeId ? name(t.assigneeId) : '', iso(t.createdAt), iso(t.dueAt), iso(t.resolvedAt), iso(t.closedAt),
      t.resolvedAt ? (resTime(t) / HOUR).toFixed(1) : '', t.resolvedAt ? (t.resolvedAt <= t.dueAt ? 'Met' : 'Breached') : isOverdue(t) ? 'Overdue' : 'Pending']);
    const csv = '﻿' + [cols, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `zenitude-desk-${label}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Exported ' + rows.length + ' ticket' + (rows.length === 1 ? '' : 's') + '.');
  }

  /* ---------- events ---------- */
  const actions = {
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
    'export-all'() { exportCsv(ticketsArr(), 'all'); },
    'export-filtered'() { exportCsv(filtered(), 'view'); },
    async take(el) {
      const id = el.dataset.id, t = S.tickets[id]; if (!t) return;
      const ch = { assigneeId: S.user.uid }, h = ['took ownership of the ticket'];
      if (t.status === 'Open') { ch.status = 'In Progress'; h.push('changed status from Open to In Progress'); }
      if (await update(id, ch, h)) toast('You now own ' + ref(t) + '.');
    },
    async 'confirm-close'(el) { if (await setStatus(el.dataset.id, 'Closed')) toast('Thank you. Ticket closed.'); },
    async reopen(el) { if (await setStatus(el.dataset.id, 'In Progress')) toast('Ticket reopened. IT can see it in their queue again.'); },
    'delete-ticket'(el) { S.modal = { type: 'delete', id: el.dataset.id }; render(); },
    async 'do-delete'(el) { const id = el.dataset.id, t = S.tickets[id]; S.modal = null; go('tickets'); if (await deleteTicket(id)) toast((t ? ref(t) : 'Ticket') + ' deleted.'); },
    async 'reset-mail'(el) { const u = S.users[el.dataset.id]; try { await S.auth.sendPasswordResetEmail(u.email); toast('Password reset email sent to ' + u.email + '.'); } catch (e) { toast(authMsg(e), 'error'); } },
    async 'toggle-user'(el) {
      const id = el.dataset.id, u = S.users[id], active = u.active === false;
      try { await S.db.collection('users').doc(id).update({ active }); toast(u.name + (active ? ' can sign in again.' : ' has been disabled.')); } catch (e) { fail(e); }
    },
    chpw() { S.modal = { type: 'chpw' }; render(); },
    'close-modal'() { S.modal = null; render(); },
    overlay(el, e) { if (e.target === el) { S.modal = null; render(); } },
  };
  const changes = {
    async status(el) {
      const id = el.dataset.id, to = el.value; if (!S.tickets[id] || to === S.tickets[id].status) return;
      if (to === 'Resolved') { S.modal = { type: 'resolve', id, note: '' }; render(); const ta = document.getElementById('m-note'); if (ta) ta.focus(); return; }
      if (await setStatus(id, to)) toast('Status changed to ' + to + '.'); else render();
    },
    async priority(el) {
      const id = el.dataset.id, p = el.value, t = S.tickets[id]; if (!t || t.priority === p) return;
      if (!(await update(id, { priority: p, dueAt: t.createdAt + SLA_HOURS[p] * HOUR }, [`changed priority from ${t.priority} to ${p}`]))) render();
    },
    async category(el) {
      const id = el.dataset.id, c = el.value, t = S.tickets[id]; if (!t || t.category === c) return;
      if (!(await update(id, { category: c }, [`changed category from ${t.category} to ${c}`]))) render();
    },
    async assignee(el) {
      const id = el.dataset.id, a = el.value || null, t = S.tickets[id]; if (!t || (t.assigneeId || null) === a) return;
      if (!(await update(id, { assigneeId: a }, [a ? 'assigned the ticket to ' + name(a) : 'removed the owner']))) render();
    },
    async role(el) {
      const id = el.dataset.id, role = el.value;
      try { await S.db.collection('users').doc(id).update({ role }); toast(name(id) + ' is now: ' + ROLES[role] + '.'); } catch (e) { fail(e); render(); }
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
      const id = form.dataset.id, text = (S.draft.comment[id] || '').trim(); if (!text) return;
      const internal = isStaff() && !!S.draft.internal[id];
      S.draft.comment[id] = ''; S.draft.internal[id] = false; render();
      try {
        await S.db.collection('tickets').doc(id).collection('comments').add({ by: S.user.uid, at: now(), text, internal });
        await update(id, {}, []);
      } catch (e) { S.draft.comment[id] = text; fail(e); render(); }
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.modal) { S.modal = null; render(); } });
  setInterval(() => { const a = document.activeElement, typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); if (S.phase === 'ready' && !S.modal && !typing) render(); }, 60000);

  /* ---------- icons ---------- */
  function icon(n) {
    const p = {
      grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
      list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.6 5.2"/>',
      download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    }[n] || '';
    return `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  }

  boot();
})();
