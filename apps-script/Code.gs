/* =========================================================
   Zenitude Desk: email for tickets (Google Apps Script edition)
   Free, no credit card. Runs every few minutes in Google's cloud.

   Each desk (IT, HR, …) can have its own email address, set on the
   Desks page of the website. That address:
     • sends the desk's emails (falls back to MAILBOX if it can't),
     • gets a copy of every new-ticket alert for the desk,
     • turns emails it receives into tickets for that desk.
   Desks without an address use MAILBOX. Replies with [ZEN-1234] in
   the subject become comments, whichever mailbox they arrive at.

   Setup (once): fill in Script Properties, then run setup(). See README.
   ========================================================= */

/* ---------- settings ---------- */
const PROJECT_ID = 'ticketing-de6b4';
const MAILBOX = 'it@zenitudeconcierge.com';         // main mailbox (IT desk, and any desk without its own address)
const APP_URL = 'https://ticketing-de6b4.web.app';
const ALLOWED_DOMAINS = 'zenitudeconcierge.com';   // who may open tickets by email (comma-separated)
const TIMEZONE = 'Indian/Mauritius';
const RUN_EVERY_MINUTES = 5;                       // 1, 5, 10, 15 or 30
const OVERLAP_MS = 20 * 60 * 1000;                 // re-check the last 20 minutes (covers clock differences)
const MAX_EMAIL_IMAGE_BYTES = 700 * 1024;          // larger email images stay in the mailbox (Firestore documents are max 1 MB)

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FS_NAME = `projects/${PROJECT_ID}/databases/(default)/documents`;
const ACTIVE = ['Open', 'In Progress', 'On Hold'];
const DEFAULT_SLA = { Low: 72, Medium: 24, High: 8, Critical: 4 };
const IT_CATEGORIES = ['Hardware', 'Software', 'Network & Wi-Fi', 'Accounts & Access', 'Email', 'Phones & Mobile', 'Website', 'Printer', 'Other'];

/* ---------- entry points ---------- */

// Run once from the editor after filling in Script Properties.
function setup() {
  const p = props_();
  ['SERVICE_ACCOUNT_JSON', 'MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET'].forEach((k) => {
    if (!p.getProperty(k)) throw new Error('Missing Script Property: ' + k + ' (Project Settings → Script Properties).');
  });
  const sa = serviceAccount_();
  if (sa.project_id && sa.project_id !== PROJECT_ID) throw new Error(`The service account key is for project "${sa.project_id}", not "${PROJECT_ID}".`);
  googleToken_(true);
  fsGetDoc_('meta/counter');
  console.log('✓ Firebase connection works');
  msToken_(true);
  graphListInbox_(MAILBOX, new Date().toISOString(), 1);
  console.log('✓ Microsoft 365 connection works (' + MAILBOX + ')');

  const now = Date.now();
  if (!p.getProperty('NOTIFY_START')) p.setProperty('NOTIFY_START', String(now));
  p.setProperty('NOTIFY_SINCE', String(now));
  p.setProperty('MAIL_SINCE|' + MAILBOX.toLowerCase(), new Date(now).toISOString());
  ScriptApp.getProjectTriggers().forEach((t) => { if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(RUN_EVERY_MINUTES).create();
  console.log(`✓ All set. Zenitude Desk email now runs every ${RUN_EVERY_MINUTES} minutes. Only tickets and emails from now on are handled.`);
}

// Optional: run from the editor to check that sending works.
function sendTestEmail() {
  graphSendMail_(MAILBOX, [MAILBOX], 'Zenitude Desk test email', layout('Test email', para('If you can read this, Zenitude Desk can send email from ' + esc(MAILBOX) + '.'), null, ' '));
  console.log('✓ Test email sent to ' + MAILBOX);
}

// Optional: stop everything.
function stop() {
  ScriptApp.getProjectTriggers().forEach((t) => { if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t); });
  console.log('Stopped. Run setup() to start again.');
}

// Called by the timer.
function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { console.log('Previous run still busy, skipping.'); return; }
  try {
    const users = loadUsers_();
    let desks = {};
    try { desks = ensureDesks_(users); } catch (e) { console.error('Desk setup failed: ' + (e && e.stack || e)); }
    try { checkMailboxes_(users, desks); } catch (e) { console.error('Mailbox check failed: ' + (e && e.stack || e)); }
    try { sendNotifications_(users, desks); } catch (e) { console.error('Notifications failed: ' + (e && e.stack || e)); }
  } finally { lock.releaseLock(); }
}

/* ---------- small helpers ---------- */
function props_() { return PropertiesService.getScriptProperties(); }
function serviceAccount_() {
  try { return JSON.parse(props_().getProperty('SERVICE_ACCOUNT_JSON')); }
  catch (e) { throw new Error('SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole downloaded key file.'); }
}
function b64url_(bytesOrString) { return Utilities.base64EncodeWebSafe(bytesOrString).replace(/=+$/, ''); }
function hex_(bytes) { return bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); }
function autoId_() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = ''; for (let i = 0; i < 20; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
function http_(url, options) {
  const res = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true }, options));
  const code = res.getResponseCode(), text = res.getContentText();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { code, json, text };
}
const link_ = (id) => APP_URL.replace(/\/+$/, '') + '/#ticket-' + id;

/* ---------- Google (Firebase) access with the service account ---------- */
function googleToken_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) { const t = cache.get('g_token'); if (t) return t; }
  const sa = serviceAccount_();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url_(JSON.stringify({
    iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform',
  }));
  const sig = b64url_(Utilities.computeRsaSha256Signature(header + '.' + claims, sa.private_key));
  const r = http_('https://oauth2.googleapis.com/token', {
    method: 'post', payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + claims + '.' + sig },
  });
  if (r.code !== 200 || !r.json || !r.json.access_token) throw new Error('Google sign-in with the service account failed: ' + r.text.slice(0, 300));
  cache.put('g_token', r.json.access_token, 3000);
  return r.json.access_token;
}

/* Firestore REST value conversion */
function enc_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc_) } };
  return { mapValue: { fields: encFields_(v) } };
}
function encFields_(o) { const f = {}; Object.keys(o).forEach((k) => { if (o[k] !== undefined) f[k] = enc_(o[k]); }); return f; }
function dec_(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec_);
  if ('mapValue' in v) return decFields_(v.mapValue.fields || {});
  return null;
}
function decFields_(f) { const o = {}; Object.keys(f || {}).forEach((k) => { o[k] = dec_(f[k]); }); return o; }
function docFrom_(d) { return Object.assign({ id: d.name.split('/').pop() }, decFields_(d.fields)); }

function fs_(method, pathAndQuery, body) {
  return http_(FS_BASE + pathAndQuery, {
    method, contentType: 'application/json', headers: { Authorization: 'Bearer ' + googleToken_() },
    payload: body ? JSON.stringify(body) : undefined,
  });
}
function fsFail_(what, r) { return new Error(`Firestore ${what} failed (${r.code}): ${r.text.slice(0, 300)}`); }
function fsGetDoc_(path) {
  const r = fs_('get', '/' + path);
  if (r.code === 404) return null;
  if (r.code !== 200) throw fsFail_('read ' + path, r);
  return { data: docFrom_(r.json), updateTime: r.json.updateTime };
}
function fsList_(coll) {
  const out = []; let token = '';
  do {
    const r = fs_('get', '/' + coll + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    if (r.code !== 200) throw fsFail_('list ' + coll, r);
    (r.json.documents || []).forEach((d) => out.push(docFrom_(d)));
    token = r.json.nextPageToken || '';
  } while (token);
  return out;
}
// filters: [[field, 'EQUAL' | 'GREATER_THAN', value]]
function fsQuery_(parentPath, collectionId, filters, limit) {
  const where = filters.map(([field, op, value]) => ({ fieldFilter: { field: { fieldPath: field }, op, value: enc_(value) } }));
  const q = { from: [{ collectionId }] };
  if (where.length === 1) q.where = where[0];
  else if (where.length > 1) q.where = { compositeFilter: { op: 'AND', filters: where } };
  if (limit) q.limit = limit;
  const r = fs_('post', (parentPath ? '/' + parentPath : '') + ':runQuery', { structuredQuery: q });
  if (r.code !== 200) throw fsFail_('query ' + collectionId, r);
  return (r.json || []).filter((x) => x.document).map((x) => docFrom_(x.document));
}
// Create a document with a fixed id. Returns false if it already exists.
function fsCreate_(coll, id, data) {
  const r = fs_('post', '/' + coll + '?documentId=' + encodeURIComponent(id), { fields: encFields_(data) });
  if (r.code === 409) return false;
  if (r.code !== 200) throw fsFail_('create ' + coll + '/' + id, r);
  return true;
}
function fsDelete_(path) { fs_('delete', '/' + path); }
// Returns true on success, false if a precondition failed (someone else wrote first).
function fsCommit_(writes) {
  const r = http_(FS_BASE + ':commit', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + googleToken_() },
    payload: JSON.stringify({ writes }),
  });
  if (r.code === 200) return true;
  const status = r.json && r.json.error && r.json.error.status;
  if (r.code === 409 || status === 'FAILED_PRECONDITION' || status === 'ALREADY_EXISTS' || status === 'ABORTED') return false;
  throw fsFail_('commit', r);
}

/* Firebase Authentication (accounts for colleagues who email in first) */
function ensureAccount_(email, displayName, users) {
  const it = (path, body) => http_(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/${path}`, {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + googleToken_() }, payload: JSON.stringify(body),
  });
  let uid = null;
  const look = it('accounts:lookup', { email: [email] });
  if (look.code === 200 && look.json && look.json.users && look.json.users.length) uid = look.json.users[0].localId;
  if (!uid) {
    const made = it('accounts', { email, displayName: displayName || undefined, emailVerified: false });
    if (made.code !== 200 || !made.json || !made.json.localId) throw new Error('Could not create an account for ' + email + ': ' + made.text.slice(0, 300));
    uid = made.json.localId;
    console.log('Created an account for ' + email);
  }
  if (!users[uid]) {
    let name = (displayName || email.split('@')[0]).slice(0, 80);
    if (name.length < 2) name = email;
    const profile = { name, email, role: 'user', active: true, createdAt: Date.now() };
    fsCreate_('users', uid, profile);
    users[uid] = profile;
  }
  return uid;
}

/* ---------- Microsoft Graph ---------- */
function msToken_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) { const t = cache.get('ms_token'); if (t) return t; }
  const p = props_();
  const r = http_(`https://login.microsoftonline.com/${encodeURIComponent(p.getProperty('MS_TENANT_ID'))}/oauth2/v2.0/token`, {
    method: 'post',
    payload: { client_id: p.getProperty('MS_CLIENT_ID'), client_secret: p.getProperty('MS_CLIENT_SECRET'), scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' },
  });
  if (r.code !== 200 || !r.json || !r.json.access_token) throw new Error('Microsoft sign-in failed: ' + ((r.json && (r.json.error_description || r.json.error)) || r.code));
  cache.put('ms_token', r.json.access_token, 3000);
  return r.json.access_token;
}
function graph_(method, path, body, extraHeaders) {
  const r = http_('https://graph.microsoft.com/v1.0' + path, {
    method, contentType: 'application/json',
    headers: Object.assign({ Authorization: 'Bearer ' + msToken_() }, extraHeaders || {}),
    payload: body ? JSON.stringify(body) : undefined,
  });
  if (r.code >= 300) {
    const err = new Error(`Microsoft Graph ${method.toUpperCase()} ${path.split('?')[0]} failed (${r.code}): ${r.text.slice(0, 300)}`);
    err.status = r.code;
    throw err;
  }
  return r.json;
}
const box_ = (mailbox) => '/users/' + encodeURIComponent(mailbox || MAILBOX);
// Sends from `from`; if that mailbox can't be used (not found / not allowed), sends from MAILBOX instead.
function graphSendMail_(from, to, subject, html) {
  const list = [...new Set((to || []).filter(Boolean).map((e) => String(e).trim().toLowerCase()))];
  if (!list.length) return 0;
  const body = {
    message: { subject: subject.slice(0, 250), body: { contentType: 'HTML', content: html }, toRecipients: list.map((address) => ({ emailAddress: { address } })) },
    saveToSentItems: true,
  };
  from = (from || MAILBOX).toLowerCase();
  try { graph_('post', box_(from) + '/sendMail', body); }
  catch (e) {
    if (from === MAILBOX.toLowerCase() || !(e.status === 403 || e.status === 404 || e.status === 400)) throw e;
    warnOnce_('send-' + from, `Can't send from ${from} (${e.status}); sending from ${MAILBOX} instead. Check that ${from} is a Microsoft 365 mailbox the Zenitude Desk app may use.`);
    graph_('post', box_(MAILBOX) + '/sendMail', body);
  }
  return list.length;
}
function graphListInbox_(mailbox, sinceIso, top) {
  const q = '?$filter=' + encodeURIComponent('receivedDateTime ge ' + sinceIso) +
    '&$orderby=' + encodeURIComponent('receivedDateTime asc') + '&$top=' + (top || 25) +
    '&$select=' + ['id', 'subject', 'from', 'body', 'uniqueBody', 'receivedDateTime', 'importance', 'internetMessageHeaders'].join(',');
  const res = graph_('get', box_(mailbox) + '/mailFolders/inbox/messages' + q, null, { Prefer: 'outlook.body-content-type="text"' });
  return (res && res.value) || [];
}
function graphMarkRead_(mailbox, id) { graph_('patch', box_(mailbox) + '/messages/' + encodeURIComponent(id), { isRead: true }); }
function warnOnce_(key, text) {
  const cache = CacheService.getScriptCache();
  if (cache.get('warn_' + key)) return;
  cache.put('warn_' + key, '1', 3600);
  console.warn(text);
}

/* ---------- people & desks ---------- */
function loadUsers_() { const u = {}; fsList_('users').forEach((d) => { const id = d.id; delete d.id; u[id] = d; }); return u; }
const nameOf_ = (users, id) => (users[id] && (users[id].name || users[id].email)) || 'Someone';
const emailOf_ = (users, id) => (users[id] && users[id].active !== false && users[id].email) || null;
const deskIdOf_ = (t) => (t && t.deskId) || 'it';
const deskOf_ = (desks, id) => desks[id] || { id, name: id === 'it' ? 'IT' : id, members: [], email: '', sla: DEFAULT_SLA, categories: id === 'it' ? IT_CATEGORIES : ['Other'], active: true };
const mailboxOf_ = (desk) => String((desk && desk.email) || MAILBOX).trim().toLowerCase();
const isAgent_ = (users, desk, uid) => !!uid && !!users[uid] && users[uid].active !== false && (desk.members || []).indexOf(uid) >= 0;
// Desk alert recipients: active members (except some ids) + the desk's own address.
const deskAlertTo_ = (users, desk, exceptIds) => (desk.members || [])
  .filter((id) => users[id] && users[id].active !== false && users[id].email && (exceptIds || []).indexOf(id) < 0)
  .map((id) => users[id].email).concat(desk.email ? [desk.email] : [MAILBOX]);
const slaHours_ = (desk, p) => Number((desk.sla || {})[p]) || DEFAULT_SLA[p];

// Creates the IT desk the first time (if the website hasn't yet), and gives tickets
// from before desks existed the IT desk. Runs the full check at most once a day.
function ensureDesks_(users) {
  const desks = {};
  fsList_('desks').forEach((d) => { desks[d.id] = d; });
  if (!desks.it) {
    const members = Object.keys(users).filter((id) => users[id].active !== false && (users[id].role === 'tech' || users[id].role === 'admin'));
    const it = { name: 'IT', description: 'Computers, accounts, email, Wi-Fi, phones, printers and software.', email: MAILBOX, active: true,
      categories: IT_CATEGORIES, sla: DEFAULT_SLA, members, fields: [], order: 1, log: [{ at: Date.now(), by: 'system', text: 'created the IT desk' }], updatedAt: Date.now(), updatedBy: 'system' };
    if (fsCreate_('desks', 'it', it)) console.log('Created the IT desk with ' + members.length + ' member(s).');
    desks.it = Object.assign({ id: 'it' }, it);
  }
  const p = props_(), last = Number(p.getProperty('DESK_BACKFILL_AT') || 0);
  if (Date.now() - last > 24 * 3600e3) {
    let moved = 0;
    fsList_('tickets').forEach((t) => {
      if (t.deskId) return;
      fsCommit_([{ update: { name: FS_NAME + '/tickets/' + t.id, fields: encFields_({ deskId: 'it' }) }, updateMask: { fieldPaths: ['deskId'] }, currentDocument: { exists: true } }]);
      moved++;
    });
    if (moved) console.log(`Moved ${moved} older ticket(s) to the IT desk.`);
    p.setProperty('DESK_BACKFILL_AT', String(Date.now()));
  }
  return desks;
}

/* ---------- outgoing ---------- */
// Each email is "claimed" in mailLog first, so it is sent once even though recent minutes are re-checked.
function sendOnce_(key, from, to, msg) {
  const list = (to || []).filter(Boolean);
  if (!list.length) return;
  if (!fsCreate_('mailLog', key, { at: Date.now(), subject: msg.subject.slice(0, 200) })) return;
  try { graphSendMail_(from, list, msg.subject, msg.html); console.log('Email sent: ' + msg.subject + ' → ' + list.join(', ')); }
  catch (e) { fsDelete_('mailLog/' + key); throw e; }
}

function sendNotifications_(users, desks) {
  const p = props_();
  const start = Number(p.getProperty('NOTIFY_START') || 0);
  const since = Number(p.getProperty('NOTIFY_SINCE') || 0);
  if (!start || !since) return;                       // setup() not run yet
  const now = Date.now();
  const from = Math.max(since - OVERLAP_MS, start);
  const tickets = fsQuery_('', 'tickets', [['updatedAt', 'GREATER_THAN', from]]);
  tickets.forEach((t) => {
    try { ticketEmails_(t, users, desks, from); } catch (e) { console.error(`Emails for ZEN-${t.num} failed: ${e.message}`); }
  });
  p.setProperty('NOTIFY_SINCE', String(now));
}

function ticketEmails_(t, users, desks, from) {
  const id = t.id, history = t.history || [], lnk = link_(id);
  const desk = deskOf_(desks, deskIdOf_(t)), deskName = desk.name, sender = mailboxOf_(desk);
  const requesterName = nameOf_(users, t.requesterId);

  // New ticket
  if (history.length && history[0].at > from) {
    const shots = fsQuery_('tickets/' + id, 'files', [['internal', 'EQUAL', false]]).filter((f) => !f.commentId).length;
    sendOnce_(`new_${id}`, sender, deskAlertTo_(users, desk, [t.requesterId]), templates.newTicketForStaff(t, { link: lnk, requesterName, tz: TIMEZONE, shots, deskName }));
    sendOnce_(`ack_${id}`, sender, [emailOf_(users, t.requesterId)], templates.receivedForRequester(t, { link: lnk, firstName: requesterName.split(' ')[0], appUrl: APP_URL, deskName, slaHours: slaHours_(desk, t.priority) }));
  }

  // Changes recorded in the ticket's history
  history.forEach((h, i) => {
    if (i === 0 || !(h.at > from)) return;
    const text = String(h.text || '');
    const laterOwnerChange = history.slice(i + 1).some((x) => /^(assigned the ticket to|took ownership|removed the owner|moved the ticket)/.test(x.text || ''));
    if (/^assigned the ticket to /.test(text) && t.assigneeId && h.by !== t.assigneeId && !laterOwnerChange) {
      sendOnce_(`h_${id}_${i}`, sender, [emailOf_(users, t.assigneeId)], templates.assigned(t, { link: lnk, byName: nameOf_(users, h.by), requesterName, deskName }));
    } else if (/ to Resolved$/.test(text) && t.status === 'Resolved' && h.by !== t.requesterId) {
      sendOnce_(`h_${id}_${i}`, sender, [emailOf_(users, t.requesterId)], templates.resolved(t, { link: lnk, byName: nameOf_(users, h.by), deskName }));
    } else if (/^reopened the ticket/.test(text) && h.by === t.requesterId && ACTIVE.indexOf(t.status) >= 0) {
      sendOnce_(`h_${id}_${i}`, sender, t.assigneeId ? [emailOf_(users, t.assigneeId)] : deskAlertTo_(users, desk, [h.by]), templates.reopened(t, { link: lnk, byName: nameOf_(users, h.by), deskName }));
    } else if (/^moved the ticket from /.test(text) && !history.slice(i + 1).some((x) => /^moved the ticket from /.test(x.text || ''))) {
      // Handed to another desk: alert the new desk like a new ticket.
      sendOnce_(`h_${id}_${i}`, sender, deskAlertTo_(users, desk, [t.requesterId, h.by]), templates.newTicketForStaff(t, { link: lnk, requesterName, tz: TIMEZONE, shots: 0, deskName }));
    }
  });

  // New comments (internal notes are never emailed; resolutions have their own email)
  fsQuery_('tickets/' + id, 'comments', [['at', 'GREATER_THAN', from]]).forEach((c) => {
    if (c.internal || c.resolution) return;
    const authorName = nameOf_(users, c.by);
    if (c.by === t.requesterId) {
      const owner = t.assigneeId && emailOf_(users, t.assigneeId);
      sendOnce_(`c_${id}_${c.id}`, sender, owner ? [owner] : deskAlertTo_(users, desk, [c.by]), templates.replyForStaff(t, c, { link: lnk, authorName, deskName }));
    } else {
      sendOnce_(`c_${id}_${c.id}`, sender, [emailOf_(users, t.requesterId)], templates.replyForRequester(t, c, { link: lnk, authorName, deskName }));
    }
  });
}

/* ---------- incoming ---------- */
// Which desk takes new emails arriving at a mailbox.
function deskForMailbox_(desks, mailbox) {
  const ids = Object.keys(desks).filter((id) => desks[id].active !== false && mailboxOf_(desks[id]) === mailbox);
  if (ids.indexOf('it') >= 0) return desks.it;
  return ids.length ? desks[ids.sort()[0]] : (mailbox === MAILBOX.toLowerCase() ? deskOf_(desks, 'it') : null);
}
function checkMailboxes_(users, desks) {
  const boxes = [MAILBOX.toLowerCase()];
  Object.keys(desks).forEach((id) => { const m = mailboxOf_(desks[id]); if (desks[id].active !== false && boxes.indexOf(m) < 0) boxes.push(m); });
  boxes.forEach((mailbox) => {
    try { checkMailbox_(mailbox, users, desks); }
    catch (e) { warnOnce_('read-' + mailbox, `Can't read the inbox of ${mailbox}: ${e.message}`); }
  });
}
function checkMailbox_(mailbox, users, desks) {
  const p = props_(), key = 'MAIL_SINCE|' + mailbox;
  let since = p.getProperty(key) || (mailbox === MAILBOX.toLowerCase() ? p.getProperty('MAIL_SINCE') : null);
  if (!since) { p.setProperty(key, new Date().toISOString()); console.log('Now watching ' + mailbox + ' for new emails.'); return; }
  const messages = graphListInbox_(mailbox, since, 25);
  let watermark = since;
  for (let k = 0; k < messages.length; k++) {
    const msg = messages[k];
    const logKey = 'm_' + hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, msg.id));
    if (fsGetDoc_('mailLog/' + logKey)) { watermark = msg.receivedDateTime; continue; }
    const ownBoxes = [MAILBOX.toLowerCase()].concat(Object.keys(desks).map((id) => mailboxOf_(desks[id])));
    const fromAddr = ((msg.from && msg.from.emailAddress && msg.from.emailAddress.address) || '').toLowerCase();
    if (isAutomated(msg, mailbox) || ownBoxes.indexOf(fromAddr) >= 0) {
      fsCreate_('mailLog', logKey, { at: Date.now(), result: 'ignored: automated or own message' });
      watermark = msg.receivedDateTime; continue;
    }
    try {
      const result = handleMessage_(msg, users, desks, mailbox);
      fsCreate_('mailLog', logKey, { at: Date.now(), result, mailbox, from: fromAddr, subject: String(msg.subject || '').slice(0, 200) });
      if (result.indexOf('ticket') === 0 || result === 'comment') { try { graphMarkRead_(mailbox, msg.id); } catch (e) { console.warn('Could not mark email as read: ' + e.message); } }
      console.log(`Email to ${mailbox} from ${fromAddr} → ${result}`);
      watermark = msg.receivedDateTime;
    } catch (e) {
      console.error('Could not process email "' + msg.subject + '": ' + e.message);   // retried next run
      break;
    }
  }
  if (watermark !== since) p.setProperty(key, watermark);
}

function handleMessage_(msg, users, desks, mailbox) {
  const from = msg.from.emailAddress.address.toLowerCase();
  const fromName = msg.from.emailAddress.name || '';
  let uid = Object.keys(users).find((k) => String(users[k].email || '').toLowerCase() === from) || null;
  if (uid && users[uid].active === false) return 'ignored: disabled account';

  const num = parseTicketNumber(msg.subject);
  let followUpOf = null;
  if (num) {
    const found = fsQuery_('', 'tickets', [['num', 'EQUAL', num]], 1)[0];
    if (found) {
      const fdesk = deskOf_(desks, deskIdOf_(found));
      const agent = isAgent_(users, fdesk, uid);
      const allowed = uid && (uid === found.requesterId || agent);
      if (allowed && found.status !== 'Closed') return commentFromEmail_(msg, mailbox, found, uid, agent, emailImages_(mailbox, msg)) ? 'comment' : 'ignored: empty reply';
      if (allowed && found.status === 'Closed' && uid !== found.requesterId) return 'ignored: reply to closed ticket';
      if (found.status === 'Closed') followUpOf = found.num;
    }
  }
  const desk = deskForMailbox_(desks, mailbox);
  if (!desk) return 'ignored: no open desk uses this mailbox';
  if (!uid) {
    if (!domainAllowed(from, ALLOWED_DOMAINS)) return 'ignored: sender domain not allowed';
    uid = ensureAccount_(from, fromName, users);
  }
  const images = emailImages_(mailbox, msg);
  const made = createTicket_(msg, uid, followUpOf, images.skipped, desk);
  saveEmailImages_(mailbox, msg, made.id, null, uid, images.ok);
  console.log(`Ticket ZEN-${made.num} created on the ${desk.name} desk` + (images.ok.length ? ' with ' + images.ok.length + ' screenshot(s)' : ''));
  return 'ticket (' + desk.name + ')';
}

// Image attachments of an email (skips small inline pictures such as signature logos).
function emailImages_(mailbox, msg) {
  const res = graph_('get', box_(mailbox) + '/messages/' + encodeURIComponent(msg.id) + '/attachments?$select=id,name,contentType,size,isInline');
  const imgs = ((res && res.value) || []).filter((a) => /^image\//i.test(a.contentType || '') && !(a.isInline && a.size < 15000));
  const ok = imgs.filter((a) => a.size <= MAX_EMAIL_IMAGE_BYTES).slice(0, 5);
  return { ok, skipped: imgs.length - ok.length };
}
function saveEmailImages_(mailbox, msg, tid, commentId, uid, list) {
  const ids = [];
  list.forEach((a) => {
    const full = graph_('get', box_(mailbox) + '/messages/' + encodeURIComponent(msg.id) + '/attachments/' + encodeURIComponent(a.id));
    if (!full || !full.contentBytes) return;
    const fid = autoId_();
    fsCommit_([
      { update: { name: FS_NAME + `/tickets/${tid}/files/${fid}`, fields: encFields_({ by: uid, at: Date.now(), name: String(a.name || 'screenshot').slice(0, 150), type: a.contentType, width: 0, height: 0, size: a.size, internal: false, commentId: commentId || null, thumb: '' }) }, currentDocument: { exists: false } },
      { update: { name: FS_NAME + `/tickets/${tid}/files/${fid}/content/full`, fields: encFields_({ data: 'data:' + a.contentType + ';base64,' + full.contentBytes }) }, currentDocument: { exists: false } },
    ]);
    ids.push(fid);
  });
  return ids;
}
const tooBigNote_ = (n) => (n ? `\n\n(${n} image${n === 1 ? ' was' : 's were'} too large to copy here. ${n === 1 ? 'It is' : 'They are'} in the desk's mailbox.)` : '');

function createTicket_(msg, uid, followUpOf, skippedImages, desk) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const counter = fsGetDoc_('meta/counter');
    const num = counter ? Number(counter.data.next) : 1001;
    const id = autoId_();
    const ticket = ticketFromEmail(msg, uid, num, Date.now(), followUpOf, { id: desk.id, sla: desk.sla, categories: desk.categories });
    ticket.description = (ticket.description + tooBigNote_(skippedImages)).slice(0, 5000);
    const ok = fsCommit_([
      { update: { name: FS_NAME + '/meta/counter', fields: encFields_({ next: num + 1 }) }, currentDocument: counter ? { updateTime: counter.updateTime } : { exists: false } },
      { update: { name: FS_NAME + '/tickets/' + id, fields: encFields_(ticket) }, currentDocument: { exists: false } },
    ]);
    if (ok) return { num, id };
    Utilities.sleep(300 + Math.floor(Math.random() * 700));
  }
  throw new Error('Could not reserve a ticket number (busy). Will retry.');
}

function commentFromEmail_(msg, mailbox, t, uid, agent, images) {
  images = images || { ok: [], skipped: 0 };
  let text = stripQuoted((msg.uniqueBody && msg.uniqueBody.content) || (msg.body && msg.body.content) || '');
  if (!text && !images.ok.length && !images.skipped) return false;
  if (!text) text = images.ok.length === 1 ? 'Sent a screenshot by email.' : images.ok.length ? `Sent ${images.ok.length} screenshots by email.` : '';
  text = (text + tooBigNote_(images.skipped)).trim().slice(0, 4000);
  const now = Date.now(), cid = autoId_();
  const fids = saveEmailImages_(mailbox, msg, t.id, cid, uid, images.ok);
  const comment = { by: uid, at: now, text, internal: false, source: 'email' };
  if (fids.length) comment.files = fids;
  fsCreate_('tickets/' + t.id + '/comments', cid, comment);
  fsCommit_([{
    update: { name: FS_NAME + '/tickets/' + t.id, fields: encFields_({ updatedAt: now }) },
    updateMask: { fieldPaths: ['updatedAt'] },
    updateTransforms: [{ fieldPath: 'history', appendMissingElements: { values: [enc_({ at: now, by: uid, text: agent ? 'replied by email' : 'added a comment by email' })] } }],
    currentDocument: { exists: true },
  }]);
  return true;
}

/* =========================================================
   Email helpers (from src/mail.js)
   ========================================================= */

const SLA_HOURS = { Low: 72, Medium: 24, High: 8, Critical: 4 };
const HOUR = 3600e3;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ref = (t) => 'ZEN-' + t.num;
const tag = (t) => '[' + ref(t) + ']';

/* ---------- incoming ---------- */

// "[ZEN-1001]" or "ZEN-1001" anywhere in the subject → 1001
function parseTicketNumber(subject) {
  const m = /\bZEN-(\d{3,7})\b/i.exec(String(subject || ''));
  return m ? parseInt(m[1], 10) : null;
}

// "RE: FW: [ZEN-12] Printer" → "Printer"
function cleanSubject(subject) {
  let s = String(subject || '');
  let prev;
  do { prev = s; s = s.replace(/^\s*((re|fw|fwd|aw|tr|sv|wg)\s*:\s*)/i, ''); } while (s !== prev);
  const hadTag = /\bZEN-\d{3,7}\b/i.test(s);
  s = s.replace(/\[?\bZEN-\d{3,7}\b\]?/ig, '').replace(/\s{2,}/g, ' ').trim();
  // Drop the wording Zenitude Desk itself puts in front of the title in its emails.
  if (hadTag) s = s.replace(/^(new (?:[^:()]{1,40} )?ticket \(\w+\)|we've received your request|new reply from [^:]{1,40}|resolved|assigned to you \(\w+\)|reopened by [^:]{1,60}|[^:]{1,60} replied)\s*:\s*/i, '');
  return s.trim();
}

// Out-of-office replies, bounces and bulk mail must never become tickets or comments.
function isAutomated(msg, mailbox) {
  const from = ((msg.from && msg.from.emailAddress && msg.from.emailAddress.address) || '').toLowerCase();
  if (!from || from === String(mailbox || '').toLowerCase()) return true;
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/i.test(from)) return true;
  const subject = String(msg.subject || '');
  if (/^\s*(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery (status notification|has failed)|mail delivery failed|returned mail)\b/i.test(subject)) return true;
  for (const h of msg.internetMessageHeaders || []) {
    const n = String(h.name || '').toLowerCase(), v = String(h.value || '').toLowerCase();
    if (n === 'auto-submitted' && v && v !== 'no') return true;
    if (n === 'precedence' && /^(bulk|junk|list|auto_reply)$/.test(v)) return true;
    if (n === 'x-autoreply' || n === 'x-autorespond') return true;
    if (n === 'list-id' || n === 'list-unsubscribe') return true;
  }
  return false;
}

// Keep only what the person just wrote: drop quoted history and signatures' separators.
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const l = line.trim();
    if (/^-{2,}\s*original message\s*-{2,}/i.test(l)) break;
    if (/^_{8,}$/.test(l)) break;                                  // Outlook reply separator
    if (/^from:\s.+/i.test(l) && out.length) break;                 // "From: …" header block of a forward/reply
    if (/^on .{3,200}wrote:$/i.test(l)) break;                      // Gmail/Apple style
    if (/^le .{3,200}a écrit\s?:$/i.test(l)) break;                 // French clients
    if (/^>/.test(l)) continue;                                     // quoted lines
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function domainOf(email) { return String(email || '').toLowerCase().split('@')[1] || ''; }
function domainAllowed(email, allowedCsv) {
  const list = String(allowedCsv || '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  return !list.length || list.includes(domainOf(email));
}

// Build the Firestore ticket for an email that starts a new conversation.
// desk: { id, sla: {Low,…}, categories: [...] } (defaults to the IT desk)
function ticketFromEmail(msg, uid, num, now, followUpOf, desk) {
  desk = desk || {};
  const sla = Object.assign({}, SLA_HOURS, desk.sla || {});
  const cats = desk.categories && desk.categories.length ? desk.categories : ['Other'];
  const fromName = (msg.from && msg.from.emailAddress && msg.from.emailAddress.name) || '';
  let title = cleanSubject(msg.subject).slice(0, 120);
  if (title.length < 5) title = ('Email from ' + (fromName || 'a colleague')).slice(0, 120);
  let description = stripQuoted((msg.body && msg.body.content) || '').slice(0, 5000);
  if (description.length < 10) description = (description ? description + '\n\n' : '') + '(Sent by email with no further details.)';
  if (followUpOf) description = (`Follow-up to ZEN-${followUpOf}, which was already closed.\n\n` + description).slice(0, 5000);
  const priority = String(msg.importance || '').toLowerCase() === 'high' ? 'High' : 'Medium';
  return {
    num, deskId: desk.id || 'it', title, description, category: cats.indexOf('Other') >= 0 ? 'Other' : cats[0], priority, status: 'Open',
    requesterId: uid, assigneeId: null, createdBy: uid,
    createdAt: now, updatedAt: now, dueAt: now + (Number(sla[priority]) || SLA_HOURS[priority]) * HOUR,
    resolvedAt: null, closedAt: null, resolution: '',
    history: [{ at: now, by: uid, text: followUpOf ? `raised the ticket by email (follow-up to ZEN-${followUpOf})` : 'raised the ticket by email' }],
    source: 'email',
  };
}

/* ---------- outgoing ---------- */

function layout(title, bodyHtml, button, footnote, deskLabel) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8f5ef;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f5ef;padding:24px 12px;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#2c2a27;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e6dfd2;border-radius:10px;overflow:hidden;">
<tr><td style="background:#17301a;padding:18px 28px;">
  <span style="font-family:Georgia,'Times New Roman',serif;font-size:20px;letter-spacing:4px;color:#f8f5ef;">ZENITUDE</span>
  <span style="font-size:11px;letter-spacing:3px;color:#d8c08a;padding-left:8px;">${esc(String(deskLabel || 'IT').toUpperCase())} DESK</span>
</td></tr>
<tr><td style="padding:26px 28px 8px;">
  <h1 style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:24px;color:#274d24;">${title}</h1>
  ${bodyHtml}
</td></tr>
${button ? `<tr><td style="padding:12px 28px 26px;"><a href="${esc(button.href)}" style="display:inline-block;background:#274d24;color:#f8f5ef;text-decoration:none;font-size:14px;padding:11px 20px;border-radius:6px;">${esc(button.label)}</a></td></tr>` : ''}
<tr><td style="padding:14px 28px;border-top:1px solid #e6dfd2;font-size:12px;color:#7a746b;">${footnote || 'Reply to this email to add a comment to the ticket. Keep the [ZEN-…] reference in the subject.'}</td></tr>
</table></td></tr></table></body></html>`;
}
const para = (html) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;">${html}</p>`;
const quote = (text) => `<div style="margin:0 0 14px;padding:12px 14px;background:#f8f5ef;border-left:3px solid #b89b5e;border-radius:4px;font-size:14px;line-height:1.55;white-space:pre-wrap;">${esc(text)}</div>`;
function facts(rows) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px;font-size:14px;">${rows.map(([k, v]) =>
    `<tr><td style="padding:3px 16px 3px 0;color:#7a746b;font-size:12px;letter-spacing:1px;text-transform:uppercase;">${esc(k)}</td><td style="padding:3px 0;">${esc(v)}</td></tr>`).join('')}</table>`;
}
const shotsNote = (n) => (n ? para(`📎 ${n} screenshot${n === 1 ? '' : 's'} attached. Open the ticket to view ${n === 1 ? 'it' : 'them'}.`) : '');
const fmt = (ms, tz) => (typeof Utilities !== 'undefined' && Utilities.formatDate
  ? Utilities.formatDate(new Date(ms), tz || 'Indian/Mauritius', 'dd MMM, HH:mm')   // Google Apps Script
  : new Date(ms).toLocaleString('en-GB', { timeZone: tz || 'Indian/Mauritius', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }));

// Every template receives { deskName } (e.g. 'IT', 'HR'); it labels the email header and wording.
const templates = {
  newTicketForStaff(t, { link, requesterName, tz, shots, deskName }) {
    const dn = deskName || 'IT';
    return {
      subject: `${tag(t)} New ${dn} ticket (${t.priority}): ${t.title}`,
      html: layout(`New ticket ${esc(ref(t))}`,
        para(`<b>${esc(requesterName)}</b> raised a new ticket for the ${esc(dn)} desk${t.source === 'email' ? ' by email' : ''}.`) +
        facts([['Subject', t.title], ['Priority', t.priority], ['Category', t.category], ['Target', fmt(t.dueAt, tz)]].concat((t.fields || []).map((x) => [x.label, x.value]))) +
        quote(t.description) + shotsNote(shots || 0),
        { href: link, label: 'Open in Zenitude Desk' },
        'Replying to this email posts a public reply that the requester will see.', dn),
    };
  },
  receivedForRequester(t, { link, firstName, appUrl, deskName, slaHours }) {
    const dn = deskName || 'IT';
    return {
      subject: `${tag(t)} We've received your request: ${t.title}`,
      html: layout('We have your request',
        para(`Hi ${esc(firstName || 'there')},`) +
        para(`Thanks for contacting ${esc(dn)}. Your request has reference <b>${esc(ref(t))}</b> and we aim to resolve it within <b>${slaHours || SLA_HOURS[t.priority]} hours</b> (${esc(t.priority.toLowerCase())} priority).`) +
        quote(t.description) +
        para(`To add anything, just reply to this email. You can also follow it in Zenitude Desk at <a href="${esc(appUrl)}" style="color:#274d24;">${esc(appUrl.replace(/^https?:\/\//, ''))}</a>. If it's your first time, use <i>Forgot your password?</i> with this email address to set a password.`),
        { href: link, label: 'View your ticket' }, null, dn),
    };
  },
  replyForRequester(t, c, { link, authorName, deskName }) {
    const dn = deskName || 'IT';
    return {
      subject: `${tag(t)} New reply from ${dn}: ${t.title}`,
      html: layout(`${esc(authorName)} replied`, quote(c.text) + shotsNote((c.files || []).length) + para('Reply to this email to answer.'), { href: link, label: 'View the conversation' }, null, dn),
    };
  },
  replyForStaff(t, c, { link, authorName, deskName }) {
    return {
      subject: `${tag(t)} ${authorName} replied: ${t.title}`,
      html: layout(`${esc(authorName)} replied on ${esc(ref(t))}`, quote(c.text) + shotsNote((c.files || []).length), { href: link, label: 'Open in Zenitude Desk' },
        'Replying to this email posts a public reply that the requester will see.', deskName),
    };
  },
  assigned(t, { link, byName, requesterName, deskName }) {
    return {
      subject: `${tag(t)} Assigned to you (${t.priority}): ${t.title}`,
      html: layout(`${esc(ref(t))} is now yours`,
        para(`${esc(byName)} assigned you a ${esc(deskName || 'IT')} ticket from <b>${esc(requesterName)}</b>.`) +
        facts([['Subject', t.title], ['Priority', t.priority], ['Status', t.status]]) + quote(t.description),
        { href: link, label: 'Open in Zenitude Desk' },
        'Replying to this email posts a public reply that the requester will see.', deskName),
    };
  },
  resolved(t, { link, byName, deskName }) {
    return {
      subject: `${tag(t)} Resolved: ${t.title}`,
      html: layout('Your ticket has been resolved',
        para(`${esc(byName)} marked <b>${esc(ref(t))}</b> as resolved:`) + quote(t.resolution || '') +
        para('Please confirm in Zenitude Desk so we can close the ticket. If it isn\'t sorted, reopen it there or reply to this email.'),
        { href: link, label: 'Confirm or reopen' }, null, deskName),
    };
  },
  reopened(t, { link, byName, deskName }) {
    return {
      subject: `${tag(t)} Reopened by ${byName}: ${t.title}`,
      html: layout(`${esc(ref(t))} was reopened`, para(`${esc(byName)} says it isn't sorted yet. The ticket is back in progress.`), { href: link, label: 'Open in Zenitude Desk' }, null, deskName),
    };
  },
};

