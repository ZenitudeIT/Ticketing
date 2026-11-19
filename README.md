# Zenitude Desk

**Zenitude Desk** is a ticketing system for every team: **IT**, **HR**, and any other desk you add later.
Anyone can raise a ticket for a team. Members of that team's desk work on it, and administrators set up desks and people from the website.

It's plain **HTML, CSS and JavaScript** with no build step, running on **Firebase** (project `ticketing-de6b4`) on the free **Spark** plan. Email goes through **Microsoft 365**, handled by a free **Google Apps Script**.

## Who can do what
| | Team member | Desk member (e.g. HR) | Administrator |
|---|:-:|:-:|:-:|
| Raise tickets for any open desk, follow them, comment, add screenshots | ✓ | ✓ | ✓ |
| Confirm a fix (close) or reopen their own resolved ticket | ✓ | ✓ | ✓ |
| See **all** tickets of their desk, assign, change status, priority and category | | ✓ | if member |
| Internal notes (never visible to the requester) | | ✓ | if member |
| Move a ticket to another desk, log a ticket for a colleague | | ✓ | if member |
| Overview dashboard, workload, CSV export for their desks | | ✓ | if member |
| Create and edit **desks**: name, email, members, categories, targets, form questions | | | ✓ |
| Add people, change roles, disable access, send password reset emails | | | ✓ |

**Privacy:** only a desk's members can read its tickets, including internal notes and screenshots. Administrators manage desks but **don't** see a desk's tickets unless they add themselves as members, and that change is recorded in the desk's history. This is enforced by `firestore.rules` on Firebase's servers, not just by the website.

## Desks
An administrator opens **Desks** in the menu to create or edit one. Each desk has:
- **Name and description.** People see these when they choose a team for a new ticket.
- **Email address.** New-ticket alerts for the desk go here, emails sent to this address become tickets on the desk, and emails to requesters come from it. Leave it empty to use the main IT mailbox. You can change it any time.
- **Members.** The people who see and work on the desk's tickets and get its email alerts.
- **Categories** for the desk (e.g. HR: Leave, Payroll, Contracts).
- **Response targets** in hours for Critical, High, Medium and Low priority.
- **Extra questions** on the new-ticket form: short or long text, number, date, drop-down or yes/no, each optional or required (e.g. Employee ID, Leave type, First day).
- **Open / closed.** A closed desk takes no new tickets. Its existing tickets stay.

Desks are never deleted, only closed. The **IT** desk is created automatically the first time an administrator signs in after this update. Existing technicians and admins become its members, and all existing tickets move into it.

**Ticket flow:** Open → In Progress / On Hold → Resolved (a resolution note is required) → Closed (confirmed by the requester). Tickets are numbered `ZEN-1001`, `ZEN-1002`, … across all desks.

**Screenshots:** people can attach up to 5 images when raising a ticket or replying. They can click **Add screenshots**, paste with **Ctrl+V**, or drag images in. Each image is shrunk and compressed in the browser and stored in Firestore, so no Cloud Storage or paid plan is needed.

## HR module: staff, leave and payroll
On the **Desks** page, tick **HR desk** on one desk (normally HR). Its members get extra pages: **HR overview, Staff, Leave, Payroll** and **HR settings**.
Nobody else can open them, administrators included, unless they're added to that desk. `firestore.rules` enforces this on Firebase's servers.

- **Staff:** one record per employee.
  - Personal and job details, contract, start date and probation, bank details, basic salary and allowances, dependents (from their EDF), and leave allowance overrides.
  - Documents: PDFs up to about 650 KB, and photos.
  - Joining and leaving checklists.
  - **Ask IT** buttons that raise a ticket on the IT desk for a new joiner or a leaver.
  - People are marked as left, never deleted.
- **Leave:** HR records leave and approves it.
  - Only working days count; set the working week and public holidays in HR settings.
  - Balances per calendar year, a month calendar, and CSV export.
  - Unpaid leave is flagged in payroll.
- **Payroll:** one pay run per month.
  - Everyone employed that month is added from their staff record. HR adjusts each person (overtime, bonus, deductions, pro-rating for mid-month joiners or leavers), then **finalises**.
  - A finalised run is locked and its payslips can be printed or saved as PDF. It can be reopened.
  - Exports: a bank list (net pay per person) and a contributions file (PAYE, CSG, NSF, levy, PRGF per person).
  - In December it offers the end-of-year bonus (1/12 of the year's pay).
- **Calculation** (`payroll.js`):
  - PAYE uses the MRA cumulative method across the tax year (1 July – 30 June).
  - CSG, NSF, the training levy and PRGF are worked out on basic salary.
  - The rates live in **HR settings → Payroll rates**, per tax year. 2026-27 is preset from the Finance Act 2026: bands 0% / 10% / 20% / 35% at Rs 500,000 / 1,000,000 / 12,000,000; CSG 1.5–3% employee and 3–6% employer around Rs 50,000; NSF 1% + 2.5% up to Rs 29,710; levy 1.5%; PRGF 4.5%.
  - When a budget changes the rates, click **Next tax year** and update them. The 2026-27 budget plans to replace NSF and PRGF with a new fund (NPPF) from July 2027.
  - Have your accountant check the first pay runs against your current payroll.

| Path | What |
|---|---|
| `meta/hr` | which desk runs the HR module |
| `employees/{id}` (+ `/docs/{id}`, `/docs/{id}/content/full`) | staff records and their documents |
| `leave/{id}` | leave records |
| `payruns/{YYYY-MM}` | one pay run per month with each person's payslip |
| `hrSettings/main`, `hrSettings/payroll` | departments, working days, holidays, leave types, checklists; tax and contribution rates |

Test the payroll maths offline with `node apps-script/test/payroll.test.js`.

## Files
```
index.html            the page
app.css               all styles (palette at the top)
app.js                the main app (sign-in, desks, tickets, dashboard, team)
hr.js                 HR module: staff, leave, payroll, HR settings
payroll.js            Mauritius payroll calculator (PAYE, CSG, NSF, levy, PRGF)
firebase-config.js    Firebase web config + options (sign-up, allowed email domains, main admin)
firestore.rules       security rules: who can read and change what
firebase.json         Firebase Hosting + Firestore deploy settings
.firebaserc           points the Firebase CLI at ticketing-de6b4
assets/img/           Zenitude emblem and favicons
apps-script/Code.gs   the email script, pasted into Google Apps Script
apps-script/src/      its source (gas.js + mail.js); build.py joins them into Code.gs
apps-script/test/     offline test for the email script: node apps-script/test/run.js
```

## Data (Cloud Firestore)
| Path | What |
|---|---|
| `users/{uid}` | name, email, role (`user` / `admin`; older accounts may say `tech`), active |
| `desks/{deskId}` | name, description, email, active, categories, sla {Low, Medium, High, Critical}, members [uid], fields [{id, label, type, required, options}], log |
| `tickets/{id}` | num, deskId, title, description, category, priority, status, requesterId, assigneeId, createdAt, updatedAt, dueAt, resolvedAt, closedAt, resolution, fields [{label, value}], history[] |
| `tickets/{id}/comments/{id}` | by, at, text, internal, resolution, files |
| `tickets/{id}/files/{id}` (+ `/content/full`) | screenshot preview, and the image itself |
| `meta/counter` | next ticket number |

## Set up / update Firebase
1. In the Firebase console (project **ticketing-de6b4**), make sure **Authentication → Email/Password** is enabled and a **Firestore** database exists.
2. From this folder, deploy the rules and the website:
   ```bash
   firebase deploy --only "firestore:rules,hosting"
   ```
   The site runs at **https://ticketing-de6b4.web.app**.
3. Sign in as the main administrator, **it@zenitudeconcierge.com**. It becomes an administrator automatically and can't be demoted or disabled from the app. To change the main admin, edit `MAIN_ADMIN()` in `firestore.rules` and `adminEmails` in `firebase-config.js`, then redeploy.
4. Open **Desks**: check the IT desk, then create HR (or other desks) and choose their members.

Optional: set `allowedEmailDomains: ["zenitudeconcierge.com"]` in `firebase-config.js` to limit self sign-up to work emails, or `allowSignup: false` so only administrators add people.

## Email (Microsoft 365), free with Google Apps Script
`apps-script/Code.gs` runs every 5 minutes in Google Apps Script, so emails go out and come in within about 5 minutes.

| When | Who gets an email | Sent from |
|---|---|---|
| A ticket is raised (in the app or by email) | The desk's members + the desk's email address, and a confirmation to the requester | the desk's address |
| A desk member posts a public reply | The requester (internal notes are never emailed) | the desk's address |
| The requester replies | The ticket owner, or the whole desk if nobody owns it | the desk's address |
| A ticket is assigned | The new owner (unless they took it themselves) | the desk's address |
| A ticket is moved to another desk | The new desk's members + address | the new desk's address |
| A ticket is resolved | The requester, with the resolution note | the desk's address |
| The requester reopens a ticket | The owner | the desk's address |

**Incoming mail**
- The script checks the main mailbox (`MAILBOX`, it@zenitudeconcierge.com) and every open desk's own email address.
- A **new email** to a desk's address becomes a ticket on that desk. Email to it@ goes to the IT desk.
- If the sender is new and uses an allowed domain (`zenitudeconcierge.com`), an account is created for them. They sign in later with **Forgot your password?**
- A **reply** with `[ZEN-1234]` in the subject becomes a comment on that ticket, whichever mailbox it arrives at. A reply to a closed ticket opens a follow-up.
- Screenshots in emails are copied onto the ticket: up to 5 images per email, 700 KB each.
- Ignored: out-of-office replies, bounces, mailing lists, other domains, Zenitude Desk's own notifications, mail from before a mailbox was first watched, and mail to a closed desk.
- A newly added desk address starts being watched on the next run. Only email arriving after that becomes tickets.
- If a desk's address isn't a Microsoft 365 mailbox the script can use, its emails are sent from it@ instead, and a warning appears under **Executions** in Apps Script.

### 1. Microsoft Entra app (Microsoft 365 admin, done once)
App registration **Zenitude Desk** (single tenant), with Microsoft Graph **Application** permissions **Mail.Send** and **Mail.ReadWrite** and **admin consent**. Put its client ID, tenant ID and a client secret in the Apps Script **Script Properties** (step 3).

The desk addresses (e.g. hr@zenitudeconcierge.com) must be real **Microsoft 365 mailboxes** (a shared mailbox is fine, and free). Recommended: limit the app to just these mailboxes. Create a mail-enabled security group (e.g. `zenitude-desk-mailboxes@…`) containing it@ and every desk mailbox, then run:
```powershell
Connect-ExchangeOnline
New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId zenitude-desk-mailboxes@zenitudeconcierge.com -AccessRight RestrictAccess -Description "Zenitude Desk mailboxes only"
```
When you add a desk with a new address, add that mailbox to the group.

### 2. Firebase service account key (free on Spark)
Firebase console → ⚙ **Project settings → Service accounts → Generate new private key**. Keep the `.json` file private and never put it on GitHub.

### 3. Apps Script
1. Go to <https://script.google.com> and create a project called `Zenitude Desk email`. Paste the whole of `apps-script/Code.gs` and click **Save**.
2. Open ⚙ **Project Settings → Script Properties** and add `SERVICE_ACCOUNT_JSON` (the whole key file), `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET`.
3. Run **setup** once and allow the permissions. The log shows ✓ for Firebase and Microsoft 365. Optionally run **sendTestEmail**.

**Updating the script later:** paste the new `Code.gs` over the old one and save. You don't need to run setup again. To pause email, run **stop**. To restart, run **setup**.

**Settings** are at the top of `Code.gs`: `MAILBOX`, `APP_URL`, `ALLOWED_DOMAINS`, `TIMEZONE` and `RUN_EVERY_MINUTES`.

## Free-plan limits
Everything runs on the Spark plan. Its daily Firestore allowance (50,000 reads, 20,000 writes, 1 GiB stored) easily covers a team of a few dozen people. Going over a limit pauses that service until the next day and never costs money. You can check usage under **Firestore → Usage**.

## Testing offline
```bash
node apps-script/test/run.js      # email script: fake Google, Firebase and Microsoft 365
```

## Security notes
- The Firebase API key in `firebase-config.js` is public by design. Protection comes from **Authentication + `firestore.rules`**. Always deploy the rules after updating.
- Anyone signed in can see the list of people and desks (names, emails, desk members), which is needed to show who raised or works a ticket.
- These rules haven't been run against the Firebase emulator. Try them in the console's **Rules Playground** before relying on them for sensitive HR matters.
