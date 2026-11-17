/* =========================================================
   Zenitude Desk: email for tickets (Microsoft 365 via Microsoft Graph)

   Outgoing
     • New ticket          → IT team (technicians + admins) and a confirmation to the requester
     • Public reply by IT  → requester
     • Reply by requester  → ticket owner (or the whole IT team if nobody owns it)
     • Assigned            → the new owner
     • Resolved            → requester, with the resolution note
     • Reopened            → ticket owner
   Incoming (checks the mailbox every 2 minutes)
     • New email                       → new ticket (sender becomes the requester)
     • Reply with [ZEN-1234] in subject → comment on that ticket
   ========================================================= */
'use strict';

const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineString, defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');

const mail = require('./mail');
const graph = require('./graph');

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// Must match your Firestore database location (Firestore → Settings shows it).
// e.g. "europe-west1", "asia-south1", "us-central1". For multi-region "eur3" use "europe-west1"; for "nam5" use "us-central1".
const REGION = 'europe-west1';
setGlobalOptions({ region: REGION, maxInstances: 3 });

const MS_TENANT_ID = defineString('MS_TENANT_ID', { description: 'Microsoft Entra Directory (tenant) ID' });
const MS_CLIENT_ID = defineString('MS_CLIENT_ID', { description: 'Entra app registration Application (client) ID' });
const MS_CLIENT_SECRET = defineSecret('MS_CLIENT_SECRET');
const MAILBOX = defineString('MAILBOX', { default: 'it@zenitudeconcierge.com', description: 'Shared IT mailbox that sends and receives ticket email' });
const APP_URL = defineString('APP_URL', { default: 'https://ticketing-de6b4.web.app', description: 'Where Zenitude Desk is hosted' });
const ALLOWED_DOMAINS = defineString('ALLOWED_DOMAINS', { default: 'zenitudeconcierge.com', description: 'Comma-separated sender domains that may open tickets by email' });
const TIMEZONE = defineString('TIMEZONE', { default: 'Indian/Mauritius' });

const secrets = [MS_CLIENT_SECRET];
const cfg = () => ({
  tenant: MS_TENANT_ID.value(), clientId: MS_CLIENT_ID.value(), secret: MS_CLIENT_SECRET.value(),
  mailbox: MAILBOX.value().trim().toLowerCase(), notifyMailbox: true,
});
const appUrl = () => APP_URL.value().replace(/\/+$/, '');
const link = (id) => appUrl() + '/#ticket-' + id;

/* ---------- shared helpers ---------- */
async function loadUsers() {
  const snap = await db.collection('users').get();
  const users = {};
  snap.forEach((d) => { users[d.id] = d.data(); });
  return users;
}
const nameOf = (users, id) => (users[id] && (users[id].name || users[id].email)) || 'Someone';
const emailOf = (users, id) => (users[id] && users[id].active !== false && users[id].email) || null;
const isStaff = (u) => !!u && u.active !== false && (u.role === 'tech' || u.role === 'admin');
const staffEmails = (users, exceptIds) => Object.entries(users)
  .filter(([id, u]) => isStaff(u) && u.email && !(exceptIds || []).includes(id))
  .map(([, u]) => u.email);

async function send(to, msg) {
  try { const n = await graph.sendMail(cfg(), Object.assign({ to }, msg)); if (n) logger.info('Email sent', { to, subject: msg.subject }); }
  catch (e) { logger.error('Email failed', { to, subject: msg.subject, error: e.message }); }
}

/* ---------- outgoing: ticket created ---------- */
exports.emailOnTicketCreated = onDocumentCreated({ document: 'tickets/{id}', secrets }, async (event) => {
  const t = event.data && event.data.data(); if (!t) return;
  const id = event.params.id;
  const users = await loadUsers();
  const requesterName = nameOf(users, t.requesterId);
  await send(staffEmails(users, [t.requesterId]), mail.templates.newTicketForStaff(t, { link: link(id), requesterName, tz: TIMEZONE.value() }));
  const reqEmail = emailOf(users, t.requesterId);
  if (reqEmail) await send([reqEmail], mail.templates.receivedForRequester(t, { link: link(id), firstName: requesterName.split(' ')[0], appUrl: appUrl() }));
});

/* ---------- outgoing: ticket changed ---------- */
exports.emailOnTicketUpdated = onDocumentUpdated({ document: 'tickets/{id}', secrets }, async (event) => {
  const before = event.data.before.data(), t = event.data.after.data();
  if (!before || !t) return;
  const id = event.params.id;
  const last = (t.history || [])[(t.history || []).length - 1] || {};
  const actor = last.by;
  const users = await loadUsers();

  if (t.assigneeId && t.assigneeId !== before.assigneeId && t.assigneeId !== actor) {
    const to = emailOf(users, t.assigneeId);
    if (to) await send([to], mail.templates.assigned(t, { link: link(id), byName: nameOf(users, actor), requesterName: nameOf(users, t.requesterId) }));
  }
  if (t.status === 'Resolved' && before.status !== 'Resolved') {
    const to = emailOf(users, t.requesterId);
    if (to && t.requesterId !== actor) await send([to], mail.templates.resolved(t, { link: link(id), byName: nameOf(users, actor) }));
  }
  const reopened = ['Open', 'In Progress', 'On Hold'].includes(t.status) && ['Resolved', 'Closed'].includes(before.status);
  if (reopened && actor === t.requesterId) {
    const to = t.assigneeId ? [emailOf(users, t.assigneeId)] : staffEmails(users, [actor]);
    await send(to, mail.templates.reopened(t, { link: link(id), byName: nameOf(users, actor) }));
  }
});

/* ---------- outgoing: comment added ---------- */
exports.emailOnComment = onDocumentCreated({ document: 'tickets/{tid}/comments/{cid}', secrets }, async (event) => {
  const c = event.data && event.data.data(); if (!c) return;
  if (c.internal || c.resolution) return;           // internal notes stay internal; resolutions have their own email
  const tid = event.params.tid;
  const tSnap = await db.collection('tickets').doc(tid).get(); if (!tSnap.exists) return;
  const t = tSnap.data();
  const users = await loadUsers();
  const authorName = nameOf(users, c.by);
  if (c.by === t.requesterId) {
    const owner = t.assigneeId && emailOf(users, t.assigneeId);
    await send(owner ? [owner] : staffEmails(users, [c.by]), mail.templates.replyForStaff(t, c, { link: link(tid), authorName }));
  } else {
    const to = emailOf(users, t.requesterId);
    if (to) await send([to], mail.templates.replyForRequester(t, c, { link: link(tid), authorName }));
  }
});

/* ---------- incoming: check the mailbox ---------- */
async function ensureAccount(email, displayName, users) {
  let uid;
  try { uid = (await admin.auth().getUserByEmail(email)).uid; }
  catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    uid = (await admin.auth().createUser({ email, displayName: displayName || undefined, emailVerified: false })).uid;
    logger.info('Created account from email', { email });
  }
  if (!users[uid]) {
    const profile = { name: (displayName || email.split('@')[0]).slice(0, 80), email, role: 'user', active: true, createdAt: Date.now() };
    if (profile.name.length < 2) profile.name = email;
    await db.collection('users').doc(uid).set(profile);
    users[uid] = profile;
  }
  return uid;
}

async function newTicketFromEmail(msg, uid, followUpOf) {
  const counter = db.doc('meta/counter');
  const ref = db.collection('tickets').doc();
  const num = await db.runTransaction(async (tx) => {
    const c = await tx.get(counter);
    const n = c.exists ? c.data().next : 1001;
    tx.set(counter, { next: n + 1 });
    tx.set(ref, mail.ticketFromEmail(msg, uid, n, Date.now(), followUpOf));
    return n;
  });
  logger.info('Ticket created from email', { num, from: msg.from.emailAddress.address });
  return num;
}

async function commentFromEmail(msg, ticketRef, t, uid, users) {
  const text = mail.stripQuoted((msg.uniqueBody && msg.uniqueBody.content) || (msg.body && msg.body.content) || '').slice(0, 4000);
  if (!text) return false;
  const now = Date.now();
  await ticketRef.collection('comments').add({ by: uid, at: now, text, internal: false, source: 'email' });
  await ticketRef.update({
    updatedAt: now,
    history: FieldValue.arrayUnion({ at: now, by: uid, text: isStaff(users[uid]) ? 'replied by email' : 'added a comment by email' }),
  });
  logger.info('Comment added from email', { num: t.num, from: msg.from.emailAddress.address });
  return true;
}

// Returns a short label describing what happened, for the log.
async function handleMessage(msg, users) {
  const c = cfg();
  const from = msg.from.emailAddress.address.toLowerCase();
  const fromName = msg.from.emailAddress.name || '';
  let uid = Object.keys(users).find((k) => String(users[k].email || '').toLowerCase() === from) || null;
  if (uid && users[uid].active === false) return 'ignored: disabled account';

  const num = mail.parseTicketNumber(msg.subject);
  let followUpOf = null;
  if (num) {
    const q = await db.collection('tickets').where('num', '==', num).limit(1).get();
    if (!q.empty) {
      const doc = q.docs[0], t = doc.data();
      const allowed = uid && (uid === t.requesterId || isStaff(users[uid]));
      if (allowed && t.status !== 'Closed') return (await commentFromEmail(msg, doc.ref, t, uid, users)) ? 'comment' : 'ignored: empty reply';
      if (allowed && t.status === 'Closed' && uid !== t.requesterId) return 'ignored: staff reply to closed ticket';
      // Closed ticket from its requester, or someone outside the ticket → start a new ticket below.
      if (t.status === 'Closed') followUpOf = t.num;
    }
  }
  if (!uid) {
    if (!mail.domainAllowed(from, ALLOWED_DOMAINS.value())) return 'ignored: sender domain not allowed';
    uid = await ensureAccount(from, fromName, users);
  }
  await newTicketFromEmail(msg, uid, followUpOf);
  return 'ticket';
}

exports.checkMailbox = onSchedule({ schedule: 'every 2 minutes', secrets, timeoutSeconds: 120, retryCount: 0 }, async () => {
  const c = cfg();
  const stateRef = db.doc('meta/mailbox');
  const state = await stateRef.get();
  if (!state.exists) {
    // First run: start from now, so older mail in the inbox is never imported.
    await stateRef.set({ since: new Date().toISOString(), startedAt: Date.now() });
    logger.info('Mailbox watcher started', { mailbox: c.mailbox });
    return;
  }
  const since = state.data().since;
  const messages = await graph.listInbox(c, since, 25);
  if (!messages.length) return;
  const users = await loadUsers();
  let watermark = since;

  for (const msg of messages) {
    const key = crypto.createHash('sha1').update(msg.id).digest('hex');
    const logRef = db.collection('mailLog').doc(key);
    const seen = await logRef.get();
    if (seen.exists && seen.data().state === 'done') { watermark = msg.receivedDateTime; continue; }
    if (mail.isAutomated(msg, c.mailbox)) {
      await logRef.set({ state: 'done', result: 'ignored: automated or own message', at: Date.now() });
      watermark = msg.receivedDateTime; continue;
    }
    try {
      const result = await handleMessage(msg, users);
      await logRef.set({ state: 'done', result, from: msg.from.emailAddress.address.toLowerCase(), subject: String(msg.subject || '').slice(0, 200), at: Date.now() });
      if (result === 'ticket' || result === 'comment') { try { await graph.markRead(c, msg.id); } catch (e) { logger.warn('Could not mark email as read', { error: e.message }); } }
      watermark = msg.receivedDateTime;
    } catch (e) {
      // Stop here; this email (and anything after it) is retried on the next run.
      logger.error('Could not process email', { subject: msg.subject, error: e.message });
      break;
    }
  }
  if (watermark !== since) await stateRef.update({ since: watermark, checkedAt: Date.now() });
});

// Exposed only for offline tests (never deployed as a function).
if (process.env.ZEN_DESK_TEST) exports._test = { handleMessage, cfg };
