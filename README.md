# Zenitude Desk

**Zenitude Desk** is a standalone IT service desk (ticketing system).
Team members report IT problems. Technicians pick them up, work them and resolve them. The IT administrator manages the team and watches the numbers.

It uses a moss-green and gold palette on ivory with the Zenitude emblem, set in Cormorant Garamond and Jost. It is plain **HTML, CSS and JavaScript** with no build step, running on **Firebase** (project `ticketing-de6b4`).

## Features
| | Team member | IT technician | IT administrator |
|---|:-:|:-:|:-:|
| Raise a ticket, follow it, comment | ✓ | ✓ | ✓ |
| Confirm a fix (close) or reopen a resolved ticket | ✓ (own tickets) | | |
| See every ticket, filter, search, export CSV | | ✓ | ✓ |
| Take ownership, assign, change status, priority and category | | ✓ | ✓ |
| Internal notes (never visible to the requester) | | ✓ | ✓ |
| Log a ticket for a colleague | | ✓ | ✓ |
| Overview dashboard: KPIs, charts, SLA, technician workload | | ✓ | ✓ |
| Add people, change roles, disable access, send password reset emails | | | ✓ |
| Delete tickets, reopen closed tickets | | | ✓ |

**Ticket flow:** Open → In Progress / On Hold → Resolved (a resolution note is required) → Closed (confirmed by the requester).
**SLA targets by priority:** Critical 4h · High 8h · Medium 24h · Low 72h. Tickets are numbered `ZEN-1001`, `ZEN-1002`, …

## Files
```
index.html            the page
app.css               all styles (brand palette at the top)
app.js                the whole app (sign-in, tickets, dashboard, team)
firebase-config.js    Firebase web config + options (sign-up on/off, allowed email domains)
firestore.rules       security rules: who can read and change what
firebase.json         Firebase Hosting + Firestore deploy settings
.firebaserc           points the Firebase CLI at ticketing-de6b4
assets/img/           Zenitude emblem and favicons
functions/            email integration with Microsoft 365 (see "Email")
```

## Data (Cloud Firestore)
| Path | What |
|---|---|
| `users/{uid}` | name, email, role (`user` / `tech` / `admin`), active |
| `tickets/{id}` | num, title, description, category, priority, status, requesterId, assigneeId, createdAt, updatedAt, dueAt, resolvedAt, closedAt, resolution, history[] |
| `tickets/{id}/comments/{id}` | by, at, text, internal, resolution |
| `meta/counter` | next ticket number |

Times are stored as milliseconds since 1970 (`Date.now()`).

## Set up Firebase (one time)
1. In the [Firebase console](https://console.firebase.google.com), open the **ticketing-de6b4** project.
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable.**
3. **Build → Firestore Database → Create database** (production mode, pick the region closest to your users, e.g. `europe-west` or `asia-south1`).
4. Install the CLI and deploy the rules and the site:
   ```bash
   npm install -g firebase-tools
   firebase login
   cd zenitude-desk
   firebase deploy --only firestore:rules,hosting
   ```
   The site goes live at **https://ticketing-de6b4.web.app**.
5. **Sign in as the main administrator:** `it@zenitudeconcierge.com`.
   - If the account already exists in **Authentication → Users**, just sign in with its password. Its profile is created automatically with the **IT administrator** role.
   - If it doesn't exist yet, use **Create account** on the site with that email. It becomes the administrator straight away.
   - From then on, add everyone else from **Team & roles**. The main admin is protected: no one can demote or disable it from the app.
   - To change the main admin later, edit `MAIN_ADMIN()` in `firestore.rules` **and** `adminEmails` in `firebase-config.js`, then redeploy.

### Hosting on GitHub Pages instead
The code is also on GitHub (`ZenitudeIT/Ticketing`). To serve it from GitHub Pages:
1. Turn on **Settings → Pages → Deploy from branch → main / root**.
2. In Firebase, add `zenitudeit.github.io` under **Authentication → Settings → Authorised domains**. Sign-in won't work until you do.
3. Still deploy the security rules once with `firebase deploy --only firestore:rules`.

### Optional
- **Only allow work emails:** in `firebase-config.js`, set `allowedEmailDomains: ["yourcompany.com"]`, or set `allowSignup: false` so only the admin can add people. To enforce this on the server as well, add `&& request.auth.token.email.matches('.*@yourcompany[.]com$')` to the self sign-up rule in `firestore.rules`.
- **Authorised domains:** if you host somewhere other than `*.web.app` / `*.firebaseapp.com`, add the domain under **Authentication → Settings → Authorised domains**.

## Run locally
Run `npx serve .` or `python -m http.server 8000` in this folder, then open http://localhost:8000. It still uses the real Firebase project, so sign-in and data work the same as on the live site. `localhost` is an authorised domain by default.

## Security notes
- The Firebase API key in `firebase-config.js` is meant to be public. Protection comes from **Authentication + `firestore.rules`**. Always deploy the rules.
- The rules enforce the roles on the server:
  - Team members can only read their own tickets and never see internal notes.
  - Only staff can assign or change tickets.
  - Only admins can change roles, and never their own.
  - Disabled people lose access immediately.
- Anyone signed in can see the team list (names and emails), which is needed to show who raised or owns a ticket.
- These rules have **not been run against the Firebase emulator yet**. Test them on the project before real use, for example with the Rules Playground in the console, or with `firebase emulators:start` and a few sign-ins with different roles.
- Recommended: turn on **App Check** to limit abuse.

## Email (Microsoft 365)
`functions/` connects Zenitude Desk to the **it@zenitudeconcierge.com** mailbox through Microsoft Graph.

| When | Who gets an email |
|---|---|
| A ticket is raised (in the app or by email) | All active technicians and admins, plus a confirmation to the requester |
| IT posts a public reply | The requester (internal notes are never emailed) |
| The requester replies | The ticket owner, or all of IT if nobody owns it |
| A ticket is assigned | The new owner (unless they took it themselves) |
| A ticket is resolved | The requester, with the resolution note |
| The requester reopens a ticket | The owner |

**Incoming mail.** The mailbox is checked every 2 minutes.
- A **new email** becomes a ticket. The sender is the requester, the subject is the title, the body is the description, and Outlook's "High importance" sets High priority.
- If the sender is new and uses an allowed domain (by default `zenitudeconcierge.com`), an account is created for them. They can sign in later with **Forgot your password?**
- A **reply** with `[ZEN-1234]` in the subject becomes a comment on that ticket. Quoted history is removed. Replies from IT staff are posted as **public** replies.
- A reply to a **closed** ticket opens a new follow-up ticket.
- Ignored: out-of-office replies, bounces, mailing lists, senders outside the allowed domains, Zenitude Desk's own notifications, and anything already in the inbox before setup.
- Processed emails are marked as read. Everything else is left untouched for a person to read.
- If someone replies from the it@ mailbox itself (in Outlook), the reply goes straight to the person and is **not** recorded on the ticket. Reply from the app, or from your own mailbox, instead.

### 1. Register an app in Microsoft Entra (Microsoft 365 admin)
1. Go to <https://entra.microsoft.com> → **Applications → App registrations → New registration**. Name it `Zenitude Desk`, choose **Single tenant**, then **Register**.
2. On the overview page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. **Certificates & secrets → New client secret** (24 months). Copy the secret's **Value** now, because it is shown only once.
4. **API permissions → Add a permission → Microsoft Graph → Application permissions**. Tick **Mail.Send** and **Mail.ReadWrite**, then click **Grant admin consent**.
5. **Strongly recommended:** limit the app to the IT mailbox only. Without this step it could read every mailbox in the company. In Exchange Online PowerShell, run:
   ```powershell
   Connect-ExchangeOnline
   New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId it@zenitudeconcierge.com -AccessRight RestrictAccess -Description "Zenitude Desk: IT mailbox only"
   Test-ApplicationAccessPolicy -AppId <client-id> -Identity it@zenitudeconcierge.com   # should say Granted
   ```
   Microsoft's newer "RBAC for Applications" in Exchange does the same job if your tenant uses it.

### 2. Firebase
1. **Upgrade the project to the Blaze plan.** Cloud Functions require it. Pay-as-you-go includes a free monthly allowance, which a small help desk normally stays within. Set a **budget alert** (for example $5) under *Usage and billing*.
2. Check your **Firestore location** (Firestore → database details). If it isn't `europe-west1`, change `REGION` at the top of `functions/index.js`. Use `europe-west1` for `eur3` and `us-central1` for `nam5`.
3. Configure and deploy:
   ```bash
   cd functions
   cp .env.example .env          # then put your tenant ID and client ID in .env
   npm install
   npm test                      # offline self-test, no Microsoft or Firebase needed
   firebase functions:secrets:set MS_CLIENT_SECRET   # paste the secret Value from Entra
   cd ..
   firebase deploy --only functions,firestore:rules
   ```
   The first deploy switches on a few Google Cloud APIs and can take several minutes. If it fails with an API or permissions message, wait a minute and run it again.
4. Test it. Raise a ticket in the app, and the IT team plus the requester should get emails. Then send an email to it@zenitudeconcierge.com from a colleague's account. Within about 2 minutes it should appear as a new ticket.

**Logs:** run `firebase functions:log`, or open Firebase console → Functions → Logs. Every email sent, ticket created and email ignored is logged there.

**Settings** (in `functions/.env`): `MAILBOX`, `APP_URL` (the address used in email links; change it if you host on GitHub Pages), `ALLOWED_DOMAINS` (comma-separated) and `TIMEZONE`.

**Not included:** email attachments are not copied onto tickets yet. They stay in the mailbox.
