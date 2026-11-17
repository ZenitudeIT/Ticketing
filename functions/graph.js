/* Minimal Microsoft Graph client (app-only / client-credentials).
   Uses Node 20's built-in fetch, so there are no extra dependencies. */
'use strict';

let cached = null; // { key, token, exp }

async function getToken(cfg) {
  const key = cfg.tenant + '|' + cfg.clientId;
  if (cached && cached.key === key && cached.exp > Date.now() + 60e3) return cached.token;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.secret,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
    }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error('Microsoft sign-in failed: ' + (j.error_description || j.error || res.status));
  cached = { key, token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return cached.token;
}

async function graph(cfg, method, path, body, extraHeaders) {
  const token = await getToken(cfg);
  const res = await fetch('https://graph.microsoft.com/v1.0' + path, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 202 || res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Graph ${method} ${path.split('?')[0]} failed (${res.status}): ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const box = (cfg) => '/users/' + encodeURIComponent(cfg.mailbox);

async function sendMail(cfg, { to, subject, html }) {
  const list = [...new Set((to || []).filter(Boolean).map((e) => String(e).trim().toLowerCase()))]
    .filter((e) => e !== cfg.mailbox.toLowerCase() || cfg.notifyMailbox);
  if (!list.length) return 0;
  await graph(cfg, 'POST', box(cfg) + '/sendMail', {
    message: {
      subject: subject.slice(0, 250),
      body: { contentType: 'HTML', content: html },
      toRecipients: list.map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: true,
  });
  return list.length;
}

// Inbox messages received at or after `sinceIso`, oldest first. Bodies come back as plain text.
async function listInbox(cfg, sinceIso, top) {
  const q = '?$filter=' + encodeURIComponent(`receivedDateTime ge ${sinceIso}`) +
    '&$orderby=' + encodeURIComponent('receivedDateTime asc') +
    '&$top=' + (top || 25) +
    '&$select=' + ['id', 'subject', 'from', 'body', 'uniqueBody', 'receivedDateTime', 'importance', 'isRead', 'internetMessageHeaders'].join(',');
  const res = await graph(cfg, 'GET', box(cfg) + '/mailFolders/inbox/messages' + q, null, { Prefer: 'outlook.body-content-type="text"' });
  return (res && res.value) || [];
}

async function markRead(cfg, id) {
  await graph(cfg, 'PATCH', box(cfg) + '/messages/' + encodeURIComponent(id), { isRead: true });
}

module.exports = { sendMail, listInbox, markRead, _graph: graph, _reset: () => { cached = null; } };
