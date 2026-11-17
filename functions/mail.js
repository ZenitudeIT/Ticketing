/* Pure helpers for Zenitude Desk email: parsing incoming mail and building
   outgoing messages. No Firebase or network code here, so it is easy to test. */
'use strict';

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
  if (hadTag) s = s.replace(/^(new ticket \(\w+\)|we've received your request|new reply from it|resolved|assigned to you \(\w+\)|reopened by [^:]{1,60}|[^:]{1,60} replied)\s*:\s*/i, '');
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
function ticketFromEmail(msg, uid, num, now, followUpOf) {
  const fromName = (msg.from && msg.from.emailAddress && msg.from.emailAddress.name) || '';
  let title = cleanSubject(msg.subject).slice(0, 120);
  if (title.length < 5) title = ('Email from ' + (fromName || 'a colleague')).slice(0, 120);
  let description = stripQuoted((msg.body && msg.body.content) || '').slice(0, 5000);
  if (description.length < 10) description = (description ? description + '\n\n' : '') + '(Sent by email with no further details.)';
  if (followUpOf) description = (`Follow-up to ZEN-${followUpOf}, which was already closed.\n\n` + description).slice(0, 5000);
  const priority = String(msg.importance || '').toLowerCase() === 'high' ? 'High' : 'Medium';
  return {
    num, title, description, category: 'Other', priority, status: 'Open',
    requesterId: uid, assigneeId: null, createdBy: uid,
    createdAt: now, updatedAt: now, dueAt: now + SLA_HOURS[priority] * HOUR,
    resolvedAt: null, closedAt: null, resolution: '',
    history: [{ at: now, by: uid, text: followUpOf ? `raised the ticket by email (follow-up to ZEN-${followUpOf})` : 'raised the ticket by email' }],
    source: 'email',
  };
}

/* ---------- outgoing ---------- */

function layout(title, bodyHtml, button, footnote) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8f5ef;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f5ef;padding:24px 12px;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#2c2a27;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e6dfd2;border-radius:10px;overflow:hidden;">
<tr><td style="background:#17301a;padding:18px 28px;">
  <span style="font-family:Georgia,'Times New Roman',serif;font-size:20px;letter-spacing:4px;color:#f8f5ef;">ZENITUDE</span>
  <span style="font-size:11px;letter-spacing:3px;color:#d8c08a;padding-left:8px;">IT SERVICE DESK</span>
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
const fmt = (ms, tz) => new Date(ms).toLocaleString('en-GB', { timeZone: tz || 'Indian/Mauritius', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const templates = {
  newTicketForStaff(t, { link, requesterName, tz }) {
    return {
      subject: `${tag(t)} New ticket (${t.priority}): ${t.title}`,
      html: layout(`New ticket ${esc(ref(t))}`,
        para(`<b>${esc(requesterName)}</b> raised a new ticket${t.source === 'email' ? ' by email' : ''}.`) +
        facts([['Subject', t.title], ['Priority', t.priority], ['Category', t.category], ['Target', fmt(t.dueAt, tz)]]) +
        quote(t.description),
        { href: link, label: 'Open in Zenitude Desk' },
        'Replying to this email posts a public reply that the requester will see.'),
    };
  },
  receivedForRequester(t, { link, firstName, appUrl }) {
    return {
      subject: `${tag(t)} We've received your request: ${t.title}`,
      html: layout('We have your request',
        para(`Hi ${esc(firstName || 'there')},`) +
        para(`Thanks for contacting IT. Your request has reference <b>${esc(ref(t))}</b> and we aim to resolve it within <b>${SLA_HOURS[t.priority]} hours</b> (${esc(t.priority.toLowerCase())} priority).`) +
        quote(t.description) +
        para(`To add anything, just reply to this email. You can also follow it in Zenitude Desk at <a href="${esc(appUrl)}" style="color:#274d24;">${esc(appUrl.replace(/^https?:\/\//, ''))}</a>. If it's your first time, use <i>Forgot your password?</i> with this email address to set a password.`),
        { href: link, label: 'View your ticket' }),
    };
  },
  replyForRequester(t, c, { link, authorName }) {
    return {
      subject: `${tag(t)} New reply from IT: ${t.title}`,
      html: layout(`${esc(authorName)} replied`, quote(c.text) + para('Reply to this email to answer.'), { href: link, label: 'View the conversation' }),
    };
  },
  replyForStaff(t, c, { link, authorName }) {
    return {
      subject: `${tag(t)} ${authorName} replied: ${t.title}`,
      html: layout(`${esc(authorName)} replied on ${esc(ref(t))}`, quote(c.text), { href: link, label: 'Open in Zenitude Desk' },
        'Replying to this email posts a public reply that the requester will see.'),
    };
  },
  assigned(t, { link, byName, requesterName }) {
    return {
      subject: `${tag(t)} Assigned to you (${t.priority}): ${t.title}`,
      html: layout(`${esc(ref(t))} is now yours`,
        para(`${esc(byName)} assigned you a ticket from <b>${esc(requesterName)}</b>.`) +
        facts([['Subject', t.title], ['Priority', t.priority], ['Status', t.status]]) + quote(t.description),
        { href: link, label: 'Open in Zenitude Desk' },
        'Replying to this email posts a public reply that the requester will see.'),
    };
  },
  resolved(t, { link, byName }) {
    return {
      subject: `${tag(t)} Resolved: ${t.title}`,
      html: layout('Your ticket has been resolved',
        para(`${esc(byName)} marked <b>${esc(ref(t))}</b> as resolved:`) + quote(t.resolution || '') +
        para('Please confirm the fix in Zenitude Desk so we can close the ticket. If the problem is still there, reopen it there or reply to this email.'),
        { href: link, label: 'Confirm or reopen' }),
    };
  },
  reopened(t, { link, byName }) {
    return {
      subject: `${tag(t)} Reopened by ${byName}: ${t.title}`,
      html: layout(`${esc(ref(t))} was reopened`, para(`${esc(byName)} says the problem isn't fixed yet. The ticket is back in progress.`), { href: link, label: 'Open in Zenitude Desk' }),
    };
  },
};

module.exports = { SLA_HOURS, esc, ref, parseTicketNumber, cleanSubject, isAutomated, stripQuoted, domainAllowed, ticketFromEmail, templates };
