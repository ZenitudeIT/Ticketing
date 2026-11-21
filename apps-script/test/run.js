/* Offline test for Code.gs: runs it in Node with fake Apps Script services,
   a fake Firestore REST API, fake Firebase Auth and a fake Microsoft Graph.  node test/run.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto'), assert = require('assert');

const PROJECT = 'ticketing-de6b4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const FS_NAME = `projects/${PROJECT}/databases/(default)/documents`;

/* ---------- fake Firestore (stores REST-encoded documents) ---------- */
const store = new Map(); let tick = 0;
const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: encF(v) } };
const encF = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, enc(v)]));
const dec = (v) => 'nullValue' in v ? null : 'booleanValue' in v ? v.booleanValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue
  : 'stringValue' in v ? v.stringValue : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : 'mapValue' in v ? decF(v.mapValue.fields || {}) : null;
const decF = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dec(v)]));
const put = (p, data) => store.set(p, { fields: encF(data), updateTime: 't' + (++tick) });       // what the web app would write
const get = (p) => store.has(p) ? decF(store.get(p).fields) : undefined;
const docJson = (p) => ({ name: FS_NAME + '/' + p, fields: store.get(p).fields, updateTime: store.get(p).updateTime });
const childrenOf = (coll) => [...store.keys()].filter((k) => k.split('/').slice(0, -1).join('/') === coll);
function matches(fields, where) {
  if (!where) return true;
  if (where.compositeFilter) return where.compositeFilter.filters.every((f) => matches(fields, f));
  const f = where.fieldFilter, a = fields[f.field.fieldPath] ? dec(fields[f.field.fieldPath]) : undefined, b = dec(f.value);
  if (f.op === 'EQUAL') return a === b;
  if (f.op === 'GREATER_THAN') return typeof a === typeof b && a > b;
  throw new Error('op ' + f.op);
}
function firestore(method, url, body) {
  const rest = url.slice(FS_BASE.length);
  if (rest === ':commit') {
    for (const w of body.writes) {                                   // preconditions first (atomic)
      const p = w.update.name.slice(FS_NAME.length + 1), cur = store.get(p), cd = w.currentDocument || {};
      if (cd.exists === false && cur) return [400, { error: { status: 'FAILED_PRECONDITION' } }];
      if (cd.exists === true && !cur) return [404, { error: { status: 'NOT_FOUND' } }];
      if (cd.updateTime && (!cur || cur.updateTime !== cd.updateTime)) return [400, { error: { status: 'FAILED_PRECONDITION' } }];
    }
    for (const w of body.writes) {
      const p = w.update.name.slice(FS_NAME.length + 1);
      let fields = w.updateMask ? Object.assign({}, (store.get(p) || {}).fields) : {};
      if (w.updateMask) w.updateMask.fieldPaths.forEach((k) => { if (w.update.fields[k]) fields[k] = w.update.fields[k]; });
      else fields = w.update.fields;
      (w.updateTransforms || []).forEach((tr) => {
        const arr = fields[tr.fieldPath] ? fields[tr.fieldPath].arrayValue.values || [] : [];
        tr.appendMissingElements.values.forEach((v) => { if (!arr.some((x) => JSON.stringify(x) === JSON.stringify(v))) arr.push(v); });
        fields[tr.fieldPath] = { arrayValue: { values: arr } };
      });
      store.set(p, { fields, updateTime: 't' + (++tick) });
    }
    return [200, { writeResults: [] }];
  }
  if (rest.endsWith(':runQuery')) {
    const parent = rest.slice(1, -':runQuery'.length).replace(/^\//, '');
    const q = body.structuredQuery, coll = (parent ? parent + '/' : '') + q.from[0].collectionId;
    let docs = childrenOf(coll).filter((p) => matches(store.get(p).fields, q.where));
    if (q.limit) docs = docs.slice(0, q.limit);
    return [200, docs.length ? docs.map((p) => ({ document: docJson(p), readTime: 'x' })) : [{ readTime: 'x' }]];
  }
  const [pth, qs] = rest.slice(1).split('?');
  const params = new URLSearchParams(qs || '');
  const segs = pth.split('/').length;
  if (method === 'get' && segs % 2 === 0) return store.has(pth) ? [200, docJson(pth)] : [404, { error: { status: 'NOT_FOUND' } }];
  if (method === 'get') return [200, { documents: childrenOf(pth).map(docJson) }];
  if (method === 'post' && params.get('documentId')) {
    const p = pth + '/' + params.get('documentId');
    if (store.has(p)) return [409, { error: { status: 'ALREADY_EXISTS' } }];
    store.set(p, { fields: body.fields, updateTime: 't' + (++tick) }); return [200, docJson(p)];
  }
  if (method === 'delete') { store.delete(pth); return [200, {}]; }
  throw new Error('Unhandled Firestore call ' + method + ' ' + url);
}

/* ---------- fake Microsoft Graph & auth ---------- */
const sent = [], marked = []; let inbox = [], graphDown = false;
const inboxes = { 'it@zenitudeconcierge.com': () => inbox };   // mailbox -> messages
const realBoxes = ['it@zenitudeconcierge.com', 'hr@zenitudeconcierge.com'];   // other addresses don't exist (404)
const attachments = {};   // message id -> [{id,name,contentType,size,isInline,contentBytes}]
const authUsers = {};
function route(url, o) {
  const method = (o.method || 'get').toLowerCase();
  const body = o.payload && typeof o.payload === 'string' ? JSON.parse(o.payload) : o.payload;
  if (url === 'https://oauth2.googleapis.com/token') {
    assert.strictEqual(body.grant_type, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, s] = body.assertion.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    assert.strictEqual(claims.iss, 'desk@ticketing-de6b4.iam.gserviceaccount.com');
    assert(crypto.verify('RSA-SHA256', Buffer.from(h + '.' + c), publicKey, Buffer.from(s, 'base64url')), 'JWT signature valid');
    return [200, { access_token: 'gtok', expires_in: 3600 }];
  }
  if (url.startsWith('https://login.microsoftonline.com/')) { assert(url.includes('/tenant-1/')); assert.strictEqual(body.client_secret, 's3cret'); return [200, { access_token: 'mtok', expires_in: 3600 }]; }
  if (url.startsWith(FS_BASE)) { assert.strictEqual(o.headers.Authorization, 'Bearer gtok'); return firestore(method, url, body); }
  if (url.startsWith('https://identitytoolkit.googleapis.com/')) {
    if (url.endsWith(':lookup')) { const uid = authUsers[body.email[0]]; return [200, uid ? { users: [{ localId: uid }] } : {}]; }
    authUsers[body.email] = 'uid_' + body.email.split('@')[0]; return [200, { localId: authUsers[body.email] }];
  }
  const gm = /^https:\/\/graph\.microsoft\.com\/v1\.0\/users\/([^/]+)\//.exec(url);
  if (gm) {
    assert.strictEqual(o.headers.Authorization, 'Bearer mtok');
    const box = decodeURIComponent(gm[1]);
    if (graphDown) return [503, { error: 'down' }];
    if (realBoxes.indexOf(box) < 0) return [404, { error: { code: 'ErrorInvalidUser' } }];
    if (url.endsWith('/sendMail')) { sent.push(Object.assign({ from: box }, body.message)); return [202, null]; }
    const am = /\/messages\/([^/]+)\/attachments(?:\/([^?]+))?/.exec(url);
    if (am && method === 'get') {
      const list = attachments[decodeURIComponent(am[1])] || [];
      if (am[2]) { const a = list.find((x) => x.id === decodeURIComponent(am[2])); return [200, a]; }
      return [200, { value: list.map(({ contentBytes, ...meta }) => meta) }];
    }
    if (method === 'get') {
      const since = decodeURIComponent(/filter=([^&]+)/.exec(url)[1]).replace('receivedDateTime ge ', '');
      assert.strictEqual(o.headers.Prefer, 'outlook.body-content-type="text"');
      const list = inboxes[box] ? inboxes[box]() : [];
      return [200, { value: list.filter((m) => m.receivedDateTime >= since).sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime)) }];
    }
    if (method === 'patch') { marked.push(decodeURIComponent(url.split('/messages/')[1])); return [200, {}]; }
  }
  throw new Error('Unexpected call ' + method + ' ' + url);
}

/* ---------- fake Apps Script services ---------- */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const props = {
  SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: PROJECT, client_email: 'desk@ticketing-de6b4.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
  MS_TENANT_ID: 'tenant-1', MS_CLIENT_ID: 'client-1', MS_CLIENT_SECRET: 's3cret',
};
const cache = {}, triggers = [], logs = [];
const toSigned = (buf) => [...buf].map((b) => (b > 127 ? b - 256 : b));
const sandbox = {
  console: { log: (...a) => logs.push(['log', a.join(' ')]), warn: (...a) => logs.push(['warn', a.join(' ')]), error: (...a) => logs.push(['error', a.join(' ')]) },
  URLSearchParams, encodeURIComponent, decodeURIComponent, JSON, Math, Date, Number, String, Object, Array, Error, Set, Buffer,
  UrlFetchApp: { fetch(url, o) { const [code, json] = route(url, o); return { getResponseCode: () => code, getContentText: () => (json == null ? '' : JSON.stringify(json)) }; } },
  Utilities: {
    base64EncodeWebSafe: (x) => Buffer.from(typeof x === 'string' ? Buffer.from(x, 'utf8') : Uint8Array.from(x.map((b) => b & 0xff))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    computeRsaSha256Signature: (input, key) => toSigned(crypto.sign('RSA-SHA256', Buffer.from(input), key)),
    computeDigest: (alg, s) => toSigned(crypto.createHash('sha1').update(s).digest()),
    DigestAlgorithm: { SHA_1: 'SHA_1' },
    formatDate: (d, tz, f) => d.toISOString().slice(0, 16),
    sleep: () => {},
  },
  CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  ScriptApp: {
    getProjectTriggers: () => triggers.slice(), deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
    newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (m) => ({ create: () => triggers.push({ getHandlerFunction: () => fn, m }) }) }) }),
  },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8') + '\n;this.__api = { setup, tick, sendTestEmail, stop };', sandbox);
const api = sandbox.__api;

/* ---------- scenarios ---------- */
let pass = 0; const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const to = (m) => m.toRecipients.map((r) => r.emailAddress.address).sort().join(',');
const ticketsByNum = () => Object.fromEntries([...store.keys()].filter((k) => /^tickets\/[^/]+$/.test(k)).map((k) => [get(k).num, Object.assign({ id: k.split('/')[1] }, get(k))]));
const errors = () => logs.filter((l) => l[0] === 'error');

put('users/u_it', { name: 'IT Administrator', email: 'it@zenitudeconcierge.com', role: 'admin', active: true });
put('users/u_ravi', { name: 'Ravi Ramdin', email: 'ravi@zenitudeconcierge.com', role: 'tech', active: true });
put('users/u_kevin', { name: 'Kevin Li', email: 'kevin@zenitudeconcierge.com', role: 'user', active: true });
put('users/u_old', { name: 'Old Staff', email: 'old@zenitudeconcierge.com', role: 'tech', active: false });
Object.assign(authUsers, { 'it@zenitudeconcierge.com': 'u_it', 'ravi@zenitudeconcierge.com': 'u_ravi', 'kevin@zenitudeconcierge.com': 'u_kevin' });
const T0 = Date.now();
put('tickets/old1', { num: 1001, title: 'Old ticket before setup', description: 'Created before email was set up.', category: 'Other', priority: 'Low', status: 'Open',
  requesterId: 'u_kevin', assigneeId: null, createdAt: T0 - 3600e3, updatedAt: T0 - 3600e3, dueAt: T0, resolvedAt: null, closedAt: null, resolution: '', history: [{ at: T0 - 3600e3, by: 'u_kevin', text: 'raised the ticket' }] });
put('meta/counter', { next: 1002 });

console.log('setup');
api.setup();
assert.strictEqual(triggers.length, 1); assert.strictEqual(triggers[0].getHandlerFunction(), 'tick'); assert.strictEqual(triggers[0].m, 5);
assert(props.NOTIFY_START && props['MAIL_SINCE|it@zenitudeconcierge.com']);
api.setup();
assert.strictEqual(triggers.length, 1, 'running setup twice keeps one timer');
ok('setup checks both connections and creates one 5-minute timer');
api.sendTestEmail(); assert.strictEqual(sent.pop().subject, 'Zenitude Desk test email');
ok('test email');

console.log('outgoing');
const now = Date.now() + 1000;
put('tickets/t2', { num: 1002, title: 'Outlook asks for password', description: 'Every hour since this morning.', category: 'Email', priority: 'Medium', status: 'Open',
  requesterId: 'u_kevin', assigneeId: null, createdBy: 'u_kevin', createdAt: now, updatedAt: now, dueAt: now + 24 * 3600e3, resolvedAt: null, closedAt: null, resolution: '',
  history: [{ at: now, by: 'u_kevin', text: 'raised the ticket' }] });
put('meta/counter', { next: 1003 });
api.tick();
assert.strictEqual(sent.length, 2, JSON.stringify(sent.map((m) => m.subject)));
assert.strictEqual(to(sent[0]), 'it@zenitudeconcierge.com,ravi@zenitudeconcierge.com');
assert(sent[0].subject.startsWith('[ZEN-1002] New IT ticket (Medium)'));
assert.strictEqual(to(sent[1]), 'kevin@zenitudeconcierge.com');
assert(!sent.some((m) => m.subject.includes('1001')), 'old ticket not emailed');
ok('new ticket → IT team + confirmation; tickets from before setup are skipped');

sent.length = 0; api.tick(); api.tick();
assert.strictEqual(sent.length, 0);
ok('re-checking the same minutes sends nothing twice');

sent.length = 0;
const t2 = () => get('tickets/t2');
const h = (o) => t2().history.concat([o]);
put('tickets/t2', Object.assign(t2(), { assigneeId: 'u_ravi', status: 'In Progress', updatedAt: now + 10, history: h({ at: now + 10, by: 'u_it', text: 'assigned the ticket to Ravi Ramdin' }) }));
put('tickets/t2/comments/c1', { by: 'u_ravi', at: now + 20, text: 'Checking your MFA now.', internal: false });
put('tickets/t2/comments/c2', { by: 'u_ravi', at: now + 21, text: 'secret internal', internal: true });
put('tickets/t2', Object.assign(t2(), { updatedAt: now + 21 }));
api.tick();
assert.deepStrictEqual(sent.map((m) => [to(m), m.subject.split(':')[0]]), [
  ['ravi@zenitudeconcierge.com', '[ZEN-1002] Assigned to you (Medium)'],
  ['kevin@zenitudeconcierge.com', '[ZEN-1002] New reply from IT'],
]);
assert(!JSON.stringify(sent).includes('secret internal'));
ok('assigned → owner; IT public reply → requester; internal note → nobody');

console.log('incoming');
sent.length = 0;
const since = props['MAIL_SINCE|it@zenitudeconcierge.com'];
const at = (s) => new Date(new Date(since).getTime() + s * 1000).toISOString();
const msg = (id, sec, from, name, subject, body, extra) => Object.assign({ id, receivedDateTime: at(sec), from: { emailAddress: { address: from, name } }, subject, body: { content: body }, uniqueBody: { content: body }, importance: 'normal', internetMessageHeaders: [] }, extra || {});
// Emails to tickets is off unless a desk switches it on: a new email is left alone.
inbox = [msg('m0', 0.5, 'jade@zenitudeconcierge.com', 'Jade Moutou', 'Lunch on Friday?', 'Are you free for lunch on Friday?')];
api.tick();
assert.strictEqual(Object.keys(ticketsByNum()).length, 2, 'no ticket while emails to tickets is off');
assert.strictEqual(sent.length, 0, 'no automatic reply while off'); assert.deepStrictEqual(marked, [], 'left unread');
ok('emails to tickets off (default): a normal email stays a normal email, no ticket, no reply');
put('desks/it', Object.assign(get('desks/it'), { emailIn: true }));
inbox = [
  msg('old', -60, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'Before setup', 'Sent before the watcher started, must be ignored.'),
  msg('m1', 1, 'jade@zenitudeconcierge.com', 'Jade Moutou', 'Wi-Fi not working at reception', 'Hi IT,\nThe Wi-Fi at reception has been down since 9am.\nThanks, Jade', { importance: 'high' }),
  msg('m2', 2, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'RE: [ZEN-1002] New reply from IT: Outlook asks for password', 'It is still asking on my phone too.\n\n________________________________\nFrom: IT\n> Checking your MFA now.'),
  msg('m3', 3, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'Automatic reply: [ZEN-1002] New reply', 'I am out of office.'),
  msg('m4', 4, 'spam@gmail.com', 'Spam', 'Win a prize', 'Click here now to win a big prize.'),
  msg('m5', 5, 'it@zenitudeconcierge.com', 'IT', '[ZEN-1002] New IT ticket (High): Wi-Fi', 'Notification sent to ourselves.'),
];
api.tick();
const byNum = ticketsByNum();
const jade = byNum[1003];
assert(jade, 'ticket from Jade'); assert.strictEqual(jade.title, 'Wi-Fi not working at reception'); assert.strictEqual(jade.priority, 'High');
assert.strictEqual(jade.requesterId, 'uid_jade'); assert.strictEqual(get('users/uid_jade').role, 'user'); assert.strictEqual(get('meta/counter').next, 1004);
const emailComments = [...store.keys()].filter((k) => k.startsWith('tickets/t2/comments/')).map(get).filter((c) => c.source === 'email');
assert.strictEqual(emailComments.length, 1); assert.strictEqual(emailComments[0].text, 'It is still asking on my phone too.');
assert(t2().history.some((x) => x.text === 'added a comment by email'));
assert.strictEqual(Object.keys(byNum).length, 3, 'no tickets from spam, auto-reply, own mail or old mail');
assert.deepStrictEqual(marked.sort(), ['m1', 'm2']);
// emails triggered in the same run by the incoming mail
const subjects = sent.map((m) => to(m) + ' | ' + m.subject.split(':')[0]).sort();
assert.deepStrictEqual(subjects, [
  'it@zenitudeconcierge.com,ravi@zenitudeconcierge.com | [ZEN-1003] New IT ticket (High)',
  'jade@zenitudeconcierge.com | [ZEN-1003] We\'ve received your request',
  'ravi@zenitudeconcierge.com | [ZEN-1002] Kevin Li replied',
]);
ok('new email → ZEN-1003 with an account for Jade; she and IT are emailed in the same run');
ok('reply with [ZEN-1002] → comment (quote removed) → owner emailed');
ok('ignored: auto-reply, outside domain, own notification, older mail');

sent.length = 0; api.tick();
assert.strictEqual(Object.keys(ticketsByNum()).length, 3); assert.strictEqual(sent.length, 0);
ok('next run: no duplicate tickets, comments or emails');

console.log('resolve, reopen, closed follow-up');
sent.length = 0;
const n2 = Date.now();
put('tickets/t2', Object.assign(t2(), { status: 'Resolved', resolvedAt: n2, resolution: 'Re-registered MFA.', updatedAt: n2, history: h({ at: n2, by: 'u_ravi', text: 'changed status from In Progress to Resolved' }) }));
put('tickets/t2/comments/r1', { by: 'u_ravi', at: n2 + 5, text: 'Re-registered MFA.', internal: false, resolution: true });
api.tick();
assert.strictEqual(sent.length, 1); assert.strictEqual(to(sent[0]), 'kevin@zenitudeconcierge.com'); assert(sent[0].subject.startsWith('[ZEN-1002] Resolved') && sent[0].body.content.includes('Re-registered MFA.'));
sent.length = 0;
put('tickets/t2', Object.assign(t2(), { status: 'In Progress', resolvedAt: null, resolution: '', updatedAt: n2 + 50, history: h({ at: n2 + 50, by: 'u_kevin', text: 'reopened the ticket (Resolved → In Progress)' }) }));
api.tick();
assert.strictEqual(sent.length, 1); assert.strictEqual(to(sent[0]), 'ravi@zenitudeconcierge.com'); assert(sent[0].subject.includes('Reopened by Kevin Li'));
ok('resolved → requester with the fix; reopened by requester → owner');

sent.length = 0;
put('tickets/t2', Object.assign(t2(), { status: 'Closed', closedAt: n2 + 60, updatedAt: n2 + 60, history: h({ at: n2 + 60, by: 'u_kevin', text: 'confirmed the fix and closed the ticket' }) }));
inbox.push(msg('m7', 30, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'RE: [ZEN-1002] Resolved: Outlook asks for password', 'It came back today, same problem as before.'));
api.tick();
const fu = ticketsByNum()[1004];
assert(fu && fu.title === 'Outlook asks for password' && fu.description.startsWith('Follow-up to ZEN-1002'), fu && fu.title);
ok('reply to a closed ticket → follow-up ticket ZEN-1004');

console.log('resilience');
sent.length = 0; graphDown = true;
const n3 = Date.now();
put('tickets/t5', { num: 1005, title: 'Printer offline', description: 'Printer shows offline on all laptops.', category: 'Printer', priority: 'Low', status: 'Open',
  requesterId: 'u_kevin', assigneeId: null, createdAt: n3, updatedAt: n3, dueAt: n3 + 72 * 3600e3, resolvedAt: null, closedAt: null, resolution: '', history: [{ at: n3, by: 'u_kevin', text: 'raised the ticket' }] });
put('meta/counter', { next: 1006 });
api.tick();
assert.strictEqual(sent.length, 0); assert(errors().length > 0, 'failure is logged');
graphDown = false; logs.length = 0; api.tick();
assert(sent.some((m) => m.subject.startsWith('[ZEN-1005] New IT ticket')), 'sent on the next run after Microsoft recovers');
assert.strictEqual(errors().length, 0, JSON.stringify(errors()));
ok('if Microsoft is down, emails are retried on the next run');

const clockSkew = Date.now() - 10 * 60e3;   // a laptop clock 10 minutes slow
props.NOTIFY_START = String(Number(props.NOTIFY_START) - 3600e3);   // as if setup ran an hour ago
sent.length = 0;
put('tickets/t5/comments/k1', { by: 'u_kevin', at: clockSkew, text: 'Also the scanner.', internal: false });
put('tickets/t5', Object.assign(get('tickets/t5'), { updatedAt: clockSkew }));
api.tick();
assert(sent.some((m) => m.subject.includes('Kevin Li replied')), 'comment from a slow clock still emailed');
ok('a laptop clock that is 10 minutes slow is still handled');

console.log('screenshots by email');
sent.length = 0;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');
attachments.m8 = [
  { id: 'a1', name: 'error.png', contentType: 'image/png', size: 250000, isInline: false, contentBytes: png },
  { id: 'a2', name: 'huge-photo.jpg', contentType: 'image/jpeg', size: 4000000, isInline: false, contentBytes: 'x' },
  { id: 'a3', name: 'logo.png', contentType: 'image/png', size: 4000, isInline: true, contentBytes: png },          // signature logo
  { id: 'a4', name: 'invoice.pdf', contentType: 'application/pdf', size: 90000, isInline: false, contentBytes: 'x' },
];
inbox.push(msg('m8', 40, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'Teams keeps crashing', 'Teams crashes when I share my screen. Screenshot attached.'));
attachments.m9 = [{ id: 'b1', name: 'image001.png', contentType: 'image/png', size: 80000, isInline: true, contentBytes: png }];
api.tick();
const t6 = [...store.keys()].filter((k) => /^tickets\/[^/]+$/.test(k)).map((k) => Object.assign({ id: k.split('/')[1] }, get(k))).find((t) => t.title === 'Teams keeps crashing');
assert(t6, 'ticket from email with attachments');
const files6 = [...store.keys()].filter((k) => new RegExp('^tickets/' + t6.id + '/files/[^/]+$').test(k)).map((k) => Object.assign({ path: k }, get(k)));
assert.strictEqual(files6.length, 1, 'only the real screenshot is copied');
assert.strictEqual(files6[0].name, 'error.png'); assert.strictEqual(files6[0].commentId, null); assert.strictEqual(files6[0].internal, false);
assert(get(files6[0].path + '/content/full').data.startsWith('data:image/png;base64,iVBOR'));
assert(t6.description.includes('1 image was too large to copy here'));
const staffNew = sent.find((m) => m.subject.includes('New IT ticket') && m.subject.includes('Teams keeps crashing'));
assert(staffNew && staffNew.body.content.includes('1 screenshot attached'), 'IT email mentions the screenshot');
ok('email screenshot → saved on the ticket; huge photo noted; logos and PDFs skipped; IT told about it');

sent.length = 0;
inbox.push(msg('m9', 41, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'RE: [ZEN-' + t6.num + '] We\'ve received your request: Teams keeps crashing', ''));
api.tick();
const c6 = [...store.keys()].filter((k) => new RegExp('^tickets/' + t6.id + '/comments/[^/]+$').test(k)).map((k) => Object.assign({ id: k.split('/').pop() }, get(k)));
assert.strictEqual(c6.length, 1); assert.strictEqual(c6[0].text, 'Sent a screenshot by email.'); assert.strictEqual(c6[0].files.length, 1);
const f6 = get('tickets/' + t6.id + '/files/' + c6[0].files[0]);
assert.strictEqual(f6.commentId, c6[0].id);
const toIt = sent.find((m) => m.subject.includes('Kevin Li replied'));
assert(toIt && toIt.body.content.includes('1 screenshot attached'));
ok('reply with only a pasted screenshot → comment "Sent a screenshot by email." with the image');

console.log('desks');
// The first tick created the IT desk and moved older tickets into it.
const itDesk = get('desks/it');
assert(itDesk && itDesk.members.sort().join() === 'u_it,u_ravi', 'IT desk members = tech/admin users: ' + (itDesk && itDesk.members));
assert.strictEqual(get('tickets/old1').deskId, 'it');
ok('IT desk created automatically; older tickets moved into it');

put('users/u_amina', { name: 'Amina Joomun', email: 'amina@zenitudeconcierge.com', role: 'user', active: true });
authUsers['amina@zenitudeconcierge.com'] = 'u_amina';
put('desks/hr', { name: 'HR', description: 'People matters', email: 'hr@zenitudeconcierge.com', emailIn: true, active: true, categories: ['Leave', 'Payroll', 'Other'],
  sla: { Low: 120, Medium: 48, High: 24, Critical: 8 }, members: ['u_amina'], fields: [], order: 2, log: [] });
sent.length = 0;
const n4 = Date.now();
put('tickets/hr1', { num: 2001, deskId: 'hr', title: 'Payslip question', description: 'My November payslip is missing overtime.', category: 'Payroll', priority: 'Medium', status: 'Open',
  requesterId: 'u_kevin', assigneeId: null, createdAt: n4, updatedAt: n4, dueAt: n4 + 48 * 3600e3, resolvedAt: null, closedAt: null, resolution: '',
  fields: [{ id: 'f1', label: 'Employee ID', value: 'ZC-0042' }], history: [{ at: n4, by: 'u_kevin', text: 'raised the ticket' }] });
api.tick();
const hrNew = sent.find((m) => m.subject.startsWith('[ZEN-2001] New HR ticket'));
assert(hrNew, 'HR alert sent: ' + JSON.stringify(sent.map((m) => m.subject)));
assert.strictEqual(to(hrNew), 'amina@zenitudeconcierge.com,hr@zenitudeconcierge.com');
assert.strictEqual(hrNew.from, 'hr@zenitudeconcierge.com');
assert(hrNew.body.content.includes('ZC-0042') && hrNew.body.content.includes('HR DESK'));
const hrAck = sent.find((m) => m.subject.startsWith('[ZEN-2001] We\'ve received'));
assert(hrAck && hrAck.from === 'hr@zenitudeconcierge.com' && hrAck.body.content.includes('Thanks for contacting HR') && hrAck.body.content.includes('48 hours'));
assert(!sent.some((m) => /ravi|it@/.test(to(m)) && m.subject.includes('2001')), 'IT never gets HR emails');
ok('HR ticket → HR members + hr@ only, sent from hr@, with HR targets and form answers');

sent.length = 0;
const hrInbox = [];
inboxes['hr@zenitudeconcierge.com'] = () => hrInbox;
api.tick();                                            // first look at hr@: only starts watching
hrInbox.push(msg('h1', 3600, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'Leave next Friday', 'Can I take next Friday off? I have enough leave left.'));
hrInbox[0].receivedDateTime = new Date(Date.now() + 1000).toISOString();
api.tick();
const viaHr = Object.values(ticketsByNum()).find((t) => t.title === 'Leave next Friday');
assert(viaHr && viaHr.deskId === 'hr' && viaHr.category === 'Other', 'email to hr@ → HR ticket: ' + JSON.stringify(viaHr && [viaHr.deskId, viaHr.category]));
assert.strictEqual(viaHr.dueAt - viaHr.createdAt, 48 * 3600e3);
assert(sent.some((m) => m.subject.includes('New HR ticket') && m.subject.includes('Leave next Friday')));
ok('email to hr@ → ticket on the HR desk with HR targets; HR alerted');

sent.length = 0;
const t2now = get('tickets/t2'), n5 = Date.now() + 5000;
put('tickets/t2', Object.assign({}, t2now, { status: 'Open', closedAt: null, deskId: 'hr', assigneeId: null, updatedAt: n5, history: t2now.history.concat([{ at: n5, by: 'u_ravi', text: 'moved the ticket from IT to HR' }]) }));
api.tick();
const moved = sent.find((m) => m.subject.startsWith('[ZEN-1002] New HR ticket'));
assert(moved && to(moved) === 'amina@zenitudeconcierge.com,hr@zenitudeconcierge.com', 'moved ticket alerts HR: ' + JSON.stringify(sent.map((m) => [m.subject, to(m)])));
ok('ticket moved from IT to HR → HR desk alerted');

sent.length = 0; logs.length = 0;
put('desks/fin', { name: 'Finance', description: '', email: 'ghost@zenitudeconcierge.com', active: true, categories: ['Invoices'], sla: {}, members: ['u_it'], fields: [], order: 3, log: [] });
const n6 = Date.now() + 9000;
put('tickets/fin1', { num: 3001, deskId: 'fin', title: 'Invoice approval', description: 'Please approve invoice 778.', category: 'Invoices', priority: 'Low', status: 'Open',
  requesterId: 'u_kevin', assigneeId: null, createdAt: n6, updatedAt: n6, dueAt: n6 + 72 * 3600e3, resolvedAt: null, closedAt: null, resolution: '', history: [{ at: n6, by: 'u_kevin', text: 'raised the ticket' }] });
api.tick();
const finNew = sent.find((m) => m.subject.includes('New Finance ticket'));
assert(finNew && finNew.from === 'it@zenitudeconcierge.com', 'falls back to the main mailbox');
api.tick();   // a new mailbox is first noted, then read on the next run
assert(logs.some((l) => l[0] === 'warn' && l[1].includes("Can't send from ghost@")) && logs.some((l) => l[0] === 'warn' && l[1].includes("Can't read the inbox of ghost@")));
assert.strictEqual(errors().length, 0, JSON.stringify(errors()));
ok('desk address that isn\'t a real mailbox → sends from it@ instead and warns (no errors)');

put('desks/hr', Object.assign(get('desks/hr'), { active: false }));
hrInbox.push(msg('h2', 3700, 'kevin@zenitudeconcierge.com', 'Kevin Li', 'Another leave question', 'Is the office closed on the 24th?'));
hrInbox[1].receivedDateTime = new Date(Date.now() + 2000).toISOString();
api.tick();
assert(!Object.values(ticketsByNum()).some((t) => t.title === 'Another leave question'), 'closed desk takes no new email tickets');
ok('closed desk → its mailbox is no longer turned into tickets');

api.stop(); assert.strictEqual(triggers.length, 0);
ok('stop() removes the timer');
console.log(`\nAll ${pass} checks passed.`);
