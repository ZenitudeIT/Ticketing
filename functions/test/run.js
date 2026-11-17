/* Offline test for the email functions: fakes Firebase (Firestore, Auth, triggers)
   and Microsoft Graph, then runs realistic scenarios. Run with:  node test/run.js   */
'use strict';
const Module = require('module');
const assert = require('assert');
const path = require('path');

/* ---------- fake Firestore + Auth ---------- */
const store = new Map();
let autoId = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
const AU = Symbol('arrayUnion');
function applyUpdate(cur, data) {
  const out = clone(cur);
  for (const [k, v] of Object.entries(data)) {
    if (v && v[AU]) out[k] = (out[k] || []).concat(v[AU]);
    else out[k] = v === undefined ? undefined : clone(v);
  }
  return out;
}
function snap(p) { const d = store.get(p); return { id: p.split('/').pop(), exists: d !== undefined, data: () => (d === undefined ? undefined : clone(d)), ref: docRef(p) }; }
function docRef(p) {
  return {
    id: p.split('/').pop(), path: p,
    async get() { return snap(p); },
    async set(d) { store.set(p, clone(d)); },
    async create(d) { if (store.has(p)) { const e = new Error('exists'); e.code = 6; throw e; } store.set(p, clone(d)); },
    async update(d) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, applyUpdate(store.get(p), d)); },
    async delete() { store.delete(p); },
    collection: (s) => coll(p + '/' + s),
  };
}
function coll(p, filters = [], lim = 0) {
  const run = () => {
    let docs = [...store.keys()].filter((k) => k.split('/').slice(0, -1).join('/') === p).map(snap)
      .filter((s) => filters.every(([f, , v]) => s.data()[f] === v));
    if (lim) docs = docs.slice(0, lim);
    return { docs, empty: !docs.length, size: docs.length, forEach: (fn) => docs.forEach(fn) };
  };
  return {
    doc: (id) => docRef(p + '/' + (id || 'auto' + (++autoId))),
    async add(d) { const r = docRef(p + '/auto' + (++autoId)); await r.set(d); return r; },
    where: (f, op, v) => coll(p, filters.concat([[f, op, v]]), lim),
    limit: (n) => coll(p, filters, n),
    async get() { return run(); },
  };
}
const fakeDb = {
  collection: (p) => coll(p), doc: (p) => docRef(p),
  async runTransaction(fn) { const w = []; const r = await fn({ get: async (ref) => snap(ref.path), set: (ref, d) => w.push([ref.path, d]) }); w.forEach(([p, d]) => store.set(p, clone(d))); return r; },
};
const authUsers = {}; // email -> uid
const fakeAdmin = {
  initializeApp() {},
  firestore: Object.assign(() => fakeDb, { FieldValue: { arrayUnion: (...v) => ({ [AU]: v }) } }),
  auth: () => ({
    async getUserByEmail(e) { if (!authUsers[e]) { const err = new Error('nf'); err.code = 'auth/user-not-found'; throw err; } return { uid: authUsers[e] }; },
    async createUser({ email }) { authUsers[email] = 'uid_' + email.split('@')[0]; return { uid: authUsers[email] }; },
  }),
};

/* ---------- fake firebase-functions ---------- */
const env = { MS_TENANT_ID: 'tenant-1', MS_CLIENT_ID: 'client-1', MS_CLIENT_SECRET: 's3cret' };
const param = (n, o) => ({ value: () => (env[n] !== undefined ? env[n] : o && o.default) });
const logs = [];
const fakes = {
  'firebase-functions/v2': { setGlobalOptions() {} },
  'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => h, onDocumentUpdated: (o, h) => h },
  'firebase-functions/v2/scheduler': { onSchedule: (o, h) => h },
  'firebase-functions/params': { defineString: param, defineSecret: (n) => param(n) },
  'firebase-functions/logger': { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) },
  'firebase-admin': fakeAdmin,
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) { return fakes[req] || origLoad.apply(this, arguments); };

/* ---------- fake Microsoft Graph ---------- */
const sent = [], marked = [];
let inbox = [], tokenCalls = 0;
global.fetch = async (url, opts) => {
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (body == null ? '' : JSON.stringify(body)) });
  if (url.includes('login.microsoftonline.com')) {
    tokenCalls++;
    assert(url.includes('/tenant-1/'), 'tenant in token URL');
    assert(String(opts.body).includes('client_secret=s3cret'));
    return res(200, { access_token: 'tok', expires_in: 3600 });
  }
  assert.strictEqual(opts.headers.Authorization, 'Bearer tok');
  if (url.endsWith('/sendMail')) { sent.push(JSON.parse(opts.body).message); return res(202, null); }
  if (opts.method === 'GET' && url.includes('/mailFolders/inbox/messages')) {
    const since = decodeURIComponent(/receivedDateTime%20ge%20([^&]+)|receivedDateTime ge ([^&]+)/.exec(url).slice(1).find(Boolean));
    assert.strictEqual(opts.headers.Prefer, 'outlook.body-content-type="text"');
    return res(200, { value: inbox.filter((m) => m.receivedDateTime >= since).sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime)) });
  }
  if (opts.method === 'PATCH') { marked.push(decodeURIComponent(url.split('/messages/')[1])); return res(200, {}); }
  throw new Error('Unexpected Graph call ' + opts.method + ' ' + url);
};

/* ---------- load the real functions ---------- */
process.env.ZEN_DESK_TEST = '1';
const fns = require(path.join(__dirname, '..', 'index.js'));
const mail = require(path.join(__dirname, '..', 'mail.js'));
const created = (p) => ({ data: { data: () => clone(store.get(p)) }, params: paramsOf(p) });
function paramsOf(p) { const s = p.split('/'); return s.length === 2 ? { id: s[1] } : { tid: s[1], cid: s[3] }; }
const updated = (p, before) => ({ data: { before: { data: () => before }, after: { data: () => clone(store.get(p)) } }, params: { id: p.split('/')[1] } });
const to = (m) => m.toRecipients.map((r) => r.emailAddress.address).sort().join(',');
let pass = 0; const ok = (name) => { pass++; console.log('  ✓ ' + name); };

(async () => {
  console.log('mail.js helpers');
  assert.strictEqual(mail.parseTicketNumber('RE: [ZEN-1001] Printer'), 1001);
  assert.strictEqual(mail.parseTicketNumber('Printer jam'), null);
  assert.strictEqual(mail.cleanSubject('RE: Fw: [ZEN-1001]  Printer   jam'), 'Printer jam');
  assert.strictEqual(mail.cleanSubject('RE: [ZEN-1001] New reply from IT: Printer jam'), 'Printer jam');
  assert.strictEqual(mail.cleanSubject('Resolved: my own subject'), 'Resolved: my own subject');
  assert.strictEqual(mail.stripQuoted('Still broken.\n\n________________________________\nFrom: IT <it@x.com>\nSent: today\n> old'), 'Still broken.');
  assert.strictEqual(mail.stripQuoted('Thanks!\nOn Tue, 17 Nov 2026 at 10:00, IT <it@x.com> wrote:\n> hello'), 'Thanks!');
  assert(mail.isAutomated({ from: { emailAddress: { address: 'kevin@zenitudeconcierge.com' } }, subject: 'Automatic reply: [ZEN-1] x' }, 'it@x'));
  assert(mail.isAutomated({ from: { emailAddress: { address: 'kevin@z.com' } }, subject: 'hi', internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }, 'it@x'));
  assert(!mail.isAutomated({ from: { emailAddress: { address: 'kevin@z.com' } }, subject: 'Laptop', internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'no' }] }, 'it@x'));
  assert(mail.domainAllowed('a@Zenitudeconcierge.com', 'zenitudeconcierge.com') && !mail.domainAllowed('a@gmail.com', 'zenitudeconcierge.com'));
  ok('subject tags, quote stripping, auto-reply detection, domains');

  // Team as the web app would have stored it.
  store.set('users/u_it', { name: 'IT Administrator', email: 'it@zenitudeconcierge.com', role: 'admin', active: true });
  store.set('users/u_ravi', { name: 'Ravi Ramdin', email: 'ravi@zenitudeconcierge.com', role: 'tech', active: true });
  store.set('users/u_kevin', { name: 'Kevin Li', email: 'kevin@zenitudeconcierge.com', role: 'user', active: true });
  store.set('users/u_old', { name: 'Old Staff', email: 'old@zenitudeconcierge.com', role: 'tech', active: false });
  Object.assign(authUsers, { 'it@zenitudeconcierge.com': 'u_it', 'ravi@zenitudeconcierge.com': 'u_ravi', 'kevin@zenitudeconcierge.com': 'u_kevin' });

  console.log('outgoing');
  const now = Date.now();
  store.set('meta/counter', { next: 1002 });
  store.set('tickets/t1', { num: 1001, title: 'Outlook asks for password', description: 'Every hour since this morning.', category: 'Email', priority: 'Medium', status: 'Open',
    requesterId: 'u_kevin', assigneeId: null, createdBy: 'u_kevin', createdAt: now, updatedAt: now, dueAt: now + 24 * 3600e3, resolvedAt: null, closedAt: null, resolution: '',
    history: [{ at: now, by: 'u_kevin', text: 'raised the ticket' }] });
  await fns.emailOnTicketCreated(created('tickets/t1'));
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(to(sent[0]), 'it@zenitudeconcierge.com,ravi@zenitudeconcierge.com');   // staff, not the disabled tech
  assert(sent[0].subject.startsWith('[ZEN-1001] New ticket (Medium)'));
  assert.strictEqual(to(sent[1]), 'kevin@zenitudeconcierge.com');
  assert(sent[1].subject.startsWith('[ZEN-1001] We\'ve received your request'));
  assert(sent[1].body.content.includes('#ticket-t1') && sent[1].body.content.includes('24 hours'));
  ok('new ticket → IT team + confirmation to requester');

  sent.length = 0;
  let before = clone(store.get('tickets/t1'));
  await fakeDb.doc('tickets/t1').update({ assigneeId: 'u_ravi', status: 'In Progress', history: fakeAdmin.firestore.FieldValue.arrayUnion({ at: now, by: 'u_it', text: 'assigned the ticket to Ravi Ramdin' }) });
  await fns.emailOnTicketUpdated(updated('tickets/t1', before));
  assert.strictEqual(sent.length, 1); assert.strictEqual(to(sent[0]), 'ravi@zenitudeconcierge.com'); assert(sent[0].subject.includes('Assigned to you'));
  ok('assigned → new owner');

  sent.length = 0;
  before = clone(store.get('tickets/t1'));
  await fakeDb.doc('tickets/t1').update({ assigneeId: 'u_ravi', history: fakeAdmin.firestore.FieldValue.arrayUnion({ at: now, by: 'u_ravi', text: 'took ownership' }) });
  await fns.emailOnTicketUpdated(updated('tickets/t1', before));
  assert.strictEqual(sent.length, 0);
  ok('no email when nothing relevant changed');

  sent.length = 0;
  await fakeDb.collection('tickets/t1/comments').add({ by: 'u_ravi', at: now, text: 'Checking your MFA now.', internal: false });
  await fns.emailOnComment(created('tickets/t1/comments/auto' + autoId));
  await fakeDb.collection('tickets/t1/comments').add({ by: 'u_ravi', at: now, text: 'secret internal', internal: true });
  await fns.emailOnComment(created('tickets/t1/comments/auto' + autoId));
  assert.strictEqual(sent.length, 1); assert.strictEqual(to(sent[0]), 'kevin@zenitudeconcierge.com'); assert(!JSON.stringify(sent).includes('secret internal'));
  ok('IT public reply → requester; internal note → nobody');

  console.log('incoming');
  sent.length = 0;
  await fns.checkMailbox();                                  // first run only records the starting point
  const since = store.get('meta/mailbox').since;
  assert(since && !inbox.length);
  const at = (s) => new Date(new Date(since).getTime() + s * 1000).toISOString();
  const msg = (id, sec, from, name, subject, body, extra) => Object.assign({ id, receivedDateTime: at(sec), from: { emailAddress: { address: from, name } }, subject, body: { content: body }, uniqueBody: { content: body }, importance: 'normal', internetMessageHeaders: [] }, extra || {});
  inbox = [
    msg('old', -60, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'Old mail', 'Sent before the watcher started, must be ignored.'),
    msg('m1', 1, 'jade@zenitudeconcierge.com', 'Jade Moutou', 'Wi-Fi not working at reception', 'Hi IT,\nThe Wi-Fi at reception has been down since 9am.\nThanks, Jade', { importance: 'high' }),
    msg('m2', 2, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'RE: [ZEN-1001] New reply from IT: Outlook asks for password', 'It is still asking on my phone too.\n\n________________________________\nFrom: IT <it@zenitudeconcierge.com>\nSent: Tuesday\n> Checking your MFA now.'),
    msg('m3', 3, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'Automatic reply: [ZEN-1001] New reply', 'I am out of office.'),
    msg('m4', 4, 'spam@gmail.com', 'Spam', 'Win a prize', 'Click here now to win a big prize.'),
    msg('m5', 5, 'it@zenitudeconcierge.com', 'IT', '[ZEN-1002] New ticket (High): Wi-Fi', 'Notification sent to ourselves.'),
    msg('m6', 6, 'ravi@zenitudeconcierge.com', 'Ravi Ramdin', 'RE: [ZEN-1001] Kevin Li replied', 'Please restart the Outlook app once, then it should stop.\n\nOn Tue, 17 Nov 2026, Kevin wrote:\n> still asking'),
  ];
  await fns.checkMailbox();
  const tickets = [...store.keys()].filter((k) => /^tickets\/[^/]+$/.test(k)).map((k) => store.get(k));
  const jadeT = tickets.find((t) => t.num === 1002);
  assert(jadeT, 'ticket created from Jade email');
  assert.strictEqual(jadeT.title, 'Wi-Fi not working at reception');
  assert.strictEqual(jadeT.priority, 'High'); assert.strictEqual(jadeT.source, 'email'); assert.strictEqual(jadeT.requesterId, 'uid_jade');
  assert.deepStrictEqual(store.get('users/uid_jade').role, 'user');
  assert.strictEqual(store.get('meta/counter').next, 1003);
  const comments = [...store.keys()].filter((k) => k.startsWith('tickets/t1/comments/')).map((k) => store.get(k)).filter((c) => c.source === 'email');
  assert.strictEqual(comments.length, 2);
  assert.strictEqual(comments[0].text, 'It is still asking on my phone too.');
  assert.strictEqual(comments[0].by, 'u_kevin');
  assert.strictEqual(comments[1].text, 'Please restart the Outlook app once, then it should stop.');
  assert.strictEqual(comments[1].by, 'u_ravi');
  assert.strictEqual(tickets.length, 2, 'no ticket from spam, auto-reply, own mail or old mail');
  assert.deepStrictEqual(marked.sort(), ['m1', 'm2', 'm6']);
  ok('new email → ticket ZEN-1002 + account for new colleague (High importance kept)');
  ok('replies with [ZEN-1001] → comments, quoted history removed');
  ok('ignored: auto-replies, outside domains, own notifications, mail older than setup');

  await fns.checkMailbox();
  const t2 = [...store.keys()].filter((k) => /^tickets\/[^/]+$/.test(k)).length;
  const c2 = [...store.keys()].filter((k) => k.startsWith('tickets/t1/comments/')).length;
  assert.strictEqual(t2, 2); assert.strictEqual(c2, 4);
  ok('running again creates no duplicates');

  console.log('emails triggered by incoming mail');
  sent.length = 0;
  const jadeId = [...store.keys()].find((k) => /^tickets\/[^/]+$/.test(k) && store.get(k).num === 1002);
  await fns.emailOnTicketCreated(created(jadeId));
  assert.strictEqual(to(sent[1]), 'jade@zenitudeconcierge.com');
  assert(sent[1].body.content.includes('Forgot your password?'));
  const kevinCommentPath = [...store.keys()].find((k) => k.startsWith('tickets/t1/comments/') && store.get(k).by === 'u_kevin');
  sent.length = 0;
  await fns.emailOnComment(created(kevinCommentPath));
  assert.strictEqual(to(sent[0]), 'ravi@zenitudeconcierge.com'); assert(sent[0].subject.includes('Kevin Li replied'));
  ok('Jade gets a confirmation with sign-in help; Kevin\'s emailed reply goes to the owner, Ravi');

  sent.length = 0;
  before = clone(store.get('tickets/t1'));
  await fakeDb.doc('tickets/t1').update({ status: 'Resolved', resolvedAt: Date.now(), resolution: 'Re-registered MFA.', history: fakeAdmin.firestore.FieldValue.arrayUnion({ at: now, by: 'u_ravi', text: 'changed status from In Progress to Resolved' }) });
  await fns.emailOnTicketUpdated(updated('tickets/t1', before));
  assert.strictEqual(to(sent[0]), 'kevin@zenitudeconcierge.com'); assert(sent[0].subject.startsWith('[ZEN-1001] Resolved') && sent[0].body.content.includes('Re-registered MFA.'));
  sent.length = 0;
  before = clone(store.get('tickets/t1'));
  await fakeDb.doc('tickets/t1').update({ status: 'In Progress', resolvedAt: null, resolution: '', history: fakeAdmin.firestore.FieldValue.arrayUnion({ at: now, by: 'u_kevin', text: 'reopened the ticket' }) });
  await fns.emailOnTicketUpdated(updated('tickets/t1', before));
  assert.strictEqual(to(sent[0]), 'ravi@zenitudeconcierge.com'); assert(sent[0].subject.includes('Reopened by Kevin Li'));
  ok('resolved → requester with the fix; reopened by requester → owner');

  console.log('reply to a closed ticket');
  await fakeDb.doc('tickets/t1').update({ status: 'Closed' });
  inbox.push(msg('m7', 10, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'RE: [ZEN-1001] Resolved: Outlook asks for password', 'It came back today, same problem as before.'));
  await fns.checkMailbox();
  const t3 = [...store.keys()].filter((k) => /^tickets\/[^/]+$/.test(k)).map((k) => store.get(k)).find((t) => t.num === 1003);
  assert(t3 && t3.requesterId === 'u_kevin' && t3.title === 'Outlook asks for password', t3 && t3.title);
  assert(t3.description.startsWith('Follow-up to ZEN-1001') && t3.history[0].text.includes('follow-up to ZEN-1001'));
  ok('reply to a closed ticket opens a new ticket (ZEN-1003)');

  assert(tokenCalls === 1, 'Microsoft token is reused');
  ok('Microsoft sign-in token cached between calls');
  const errs = logs.filter((l) => l[0] === 'error');
  assert.strictEqual(errs.length, 0, JSON.stringify(errs));
  console.log(`\nAll ${pass} checks passed.`);
})().catch((e) => { console.error('\nFAILED:', e); console.error(logs.filter((l) => l[0] !== 'info')); process.exit(1); });
