/* Zenitude Desk — HR module: staff records, leave, payroll, onboarding/offboarding.
 *
 * Only members of the HR desk (set on the Desks page) can open these pages, and
 * firestore.rules enforce the same on Firebase's servers.
 *
 * Data:
 *   employees/{id}                 staff record (+ /docs/{did} and /docs/{did}/content/full for files)
 *   leave/{id}                     leave records
 *   payruns/{YYYY-MM}              one pay run per month, with every employee's payslip
 *   hrSettings/main                departments, working days, holidays, leave types, checklists
 *   hrSettings/payroll             tax and contribution rates per tax year
 */
window.ZenHRModule = function (A) {
  'use strict';
  const { S, esc, opt, icon, name, byName, rel, toast, fail, dbMsg, render, go, now, isAgentOf, slaFor, categoriesOf, prepareImage, dataUrlToBlob, HOUR } = A;
  const P = window.ZenPayroll;

  /* ---------- defaults ---------- */
  const DEFAULT_MAIN = {
    departments: ['Concierge', 'Operations', 'Front office', 'Sales & Marketing', 'Finance', 'HR', 'IT', 'Management'],
    workDays: [1, 2, 3, 4, 5],            // Monday–Friday (0 = Sunday)
    holidays: [],                        // [{ date: 'YYYY-MM-DD', name }]
    leaveTypes: [
      { id: 'annual', name: 'Annual leave', days: 20, paid: true },
      { id: 'sick', name: 'Sick leave', days: 15, paid: true },
      { id: 'maternity', name: 'Maternity leave', days: 0, paid: true },
      { id: 'paternity', name: 'Paternity leave', days: 0, paid: true },
      { id: 'compassionate', name: 'Compassionate leave', days: 0, paid: true },
      { id: 'unpaid', name: 'Unpaid leave', days: 0, paid: false },
    ],
    onboarding: ['Signed contract received', 'Copy of NIC and certificates filed', 'Bank details recorded', 'Employee Declaration Form (EDF) received',
      'IT accounts and equipment requested', 'Welcome and induction done', 'Probation review date set'],
    offboarding: ['Resignation or termination letter filed', 'Last day and notice period confirmed', 'IT access removal requested',
      'Laptop, phone, keys and badge returned', 'Final pay and leave balance settled', 'Certificate of employment issued'],
  };
  const CONTRACTS = ['Permanent', 'Fixed-term', 'Part-time', 'Probation', 'Casual', 'Intern'];
  const KINDS = { basic: 'Basic salary', allowance: 'Allowance', overtime: 'Overtime', bonus: 'Bonus', other: 'Other' };
  const LEAVE_ST = ['Pending', 'Approved', 'Rejected', 'Cancelled'];
  const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MAX_DOC_CHARS = 900000;

  /* ---------- state ---------- */
  const H = (S.hr = {
    on: false, unsub: {}, err: '', loaded: {},
    emps: {}, leave: {}, runs: {}, main: null, pay: null,
    q: '', dept: '', show: 'active', ed: null, docs: {}, docsSub: null, docsFor: null, docBusy: false,
    lv: { tab: 'requests', status: 'Pending', year: String(new Date().getFullYear()), month: new Date().toISOString().slice(0, 7), q: '' },
    run: null, runSrc: '', slipId: null, set: null,
  });

  /* ---------- helpers ---------- */
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const parseD = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
  const isoD = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const fmtD = (s) => (s ? parseD(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const fmtM = (m) => (m ? parseD(m + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : '');
  const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return isoD(d); };
  const addMonths = (m, n) => { const d = parseD(m + '-01'); d.setMonth(d.getMonth() + n); return isoD(d).slice(0, 7); };
  const monthEnd = (m) => { const d = parseD(m + '-01'); d.setMonth(d.getMonth() + 1); d.setDate(0); return isoD(d); };
  const num = (v) => { const n = Number(String(v ?? '').replace(/[, ]/g, '')); return isFinite(n) ? n : 0; };
  const money = (n) => 'Rs ' + (Math.round(Number(n) || 0)).toLocaleString('en-US');
  const money2 = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const uid = () => Math.random().toString(36).slice(2, 10);
  const emp = (id) => H.emps[id];
  const empName = (id) => (H.emps[id] ? H.emps[id].fullName : 'Former employee');
  const empList = () => Object.entries(H.emps).map(([id, e]) => Object.assign({ id }, e)).sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
  const activeEmps = () => empList().filter((e) => e.status !== 'Left');
  const main = () => Object.assign({}, DEFAULT_MAIN, H.main || {});
  const leaveTypes = () => main().leaveTypes;
  const ltype = (id) => leaveTypes().find((t) => t.id === id) || { id, name: id, days: 0, paid: true };
  const ratesFor = (ty) => (H.pay && H.pay.years && H.pay.years[ty]) || P.DEFAULT_RATES[ty] || null;
  const allYears = () => [...new Set(Object.keys(P.DEFAULT_RATES).concat(Object.keys((H.pay && H.pay.years) || {})))].sort();
  const deskRef = () => S.hrDeskId;
  const isHR = () => !!S.hrDeskId && !!S.desks[S.hrDeskId] && isAgentOf(S.hrDeskId);
  const loaded = () => ['e', 'l', 's', 'r'].every((k) => H.loaded[k]);
  const pillHR = (v) => `<span class="pill hr-${String(v).toLowerCase().replace(/[^a-z]/g, '')}"><i></i>${esc(v)}</span>`;
  const back = (href, label) => `<div class="small no-print" style="margin-bottom:.8rem"><a href="#${href}">← ${label}</a></div>`;
  function csv(rows, file) {
    const q = (v) => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = file; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // Working days between two dates (inclusive), skipping non-working weekdays and public holidays.
  function workingDays(from, to, half) {
    if (!from || !to || to < from) return 0;
    const m = main(), hol = new Set((m.holidays || []).map((h) => h.date));
    let n = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) if (m.workDays.includes(parseD(d).getDay()) && !hol.has(d)) n++;
    return half && from === to ? Math.min(n, 0.5) : n;
  }
  // Part of a leave record that falls between two dates.
  function daysWithin(l, start, end) {
    const a = l.from > start ? l.from : start, b = l.to < end ? l.to : end;
    if (a > b) return 0;
    if (a === l.from && b === l.to) return Number(l.days) || 0;
    return workingDays(a, b, false);
  }
  const leaveArr = () => Object.entries(H.leave).map(([id, l]) => Object.assign({ id }, l));
  function usedDays(empId, typeId, year) {
    const s = year + '-01-01', e = year + '-12-31';
    return leaveArr().filter((l) => l.empId === empId && l.typeId === typeId && l.status === 'Approved').reduce((t, l) => t + daysWithin(l, s, e), 0);
  }
  function entitlement(e, t) { const o = e && e.leaveDays && e.leaveDays[t.id]; return o != null && o !== '' ? Number(o) : Number(t.days) || 0; }
  const onLeave = (empId, date) => leaveArr().find((l) => l.empId === empId && l.status === 'Approved' && l.from <= date && l.to >= date);

  /* ---------- live data ---------- */
  function start() {
    if (H.on) return;
    H.on = true; H.err = ''; H.loaded = {};
    const db = S.db, onErr = (k) => (e) => { console.error('[Zenitude HR] ' + k, e); H.err = 'HR data couldn\'t load: ' + dbMsg(e) + (e && e.code ? ' [' + e.code + ']' : ''); H.loaded[k] = true; render(); };
    H.unsub.e = db.collection('employees').onSnapshot((s) => { const o = {}; s.docs.forEach((d) => { o[d.id] = d.data(); }); H.emps = o; H.loaded.e = true; refreshDrafts(); render(); }, onErr('e'));
    H.unsub.l = db.collection('leave').onSnapshot((s) => { const o = {}; s.docs.forEach((d) => { o[d.id] = d.data(); }); H.leave = o; H.loaded.l = true; render(); }, onErr('l'));
    H.unsub.s = db.collection('hrSettings').onSnapshot((s) => { H.main = null; H.pay = null; s.docs.forEach((d) => { if (d.id === 'main') H.main = d.data(); if (d.id === 'payroll') H.pay = d.data(); }); H.loaded.s = true; render(); }, onErr('s'));
    H.unsub.r = db.collection('payruns').onSnapshot((s) => { const o = {}; s.docs.forEach((d) => { o[d.id] = d.data(); }); H.runs = o; H.loaded.r = true; refreshDrafts(); render(); }, onErr('r'));
  }
  function stop() {
    Object.values(H.unsub).forEach((u) => { try { u(); } catch (e) { } });
    if (H.docsSub) { try { H.docsSub(); } catch (e) { } }
    Object.assign(H, { on: false, unsub: {}, err: '', loaded: {}, emps: {}, leave: {}, runs: {}, main: null, pay: null, ed: null, docs: {}, docsSub: null, docsFor: null, run: null, runSrc: '', slipId: null, set: null });
  }
  function sync() { if (S.phase === 'ready' && isHR()) start(); else if (H.on) stop(); }
  // Keep open drafts in step with the database when they haven't been edited.
  function refreshDrafts() {
    const r = S.route;
    if (r.startsWith('payrun-') && H.run && H.runs[H.run.month] && !runDirty()) copyRun(H.run.month);
    if (r.startsWith('staff-') && H.ed && H.ed.id && !H.ed.touched && H.emps[H.ed.id]) H.ed = edFrom(H.ed.id);
  }
  function watchDocs(id) {
    if (H.docsFor === id) return;
    if (H.docsSub) { try { H.docsSub(); } catch (e) { } H.docsSub = null; }
    H.docsFor = id; H.docs[id] = null;
    if (!id) return;
    H.docsSub = S.db.collection('employees').doc(id).collection('docs').onSnapshot((s) => {
      H.docs[id] = s.docs.map((d) => Object.assign({ id: d.id }, d.data())).sort((a, b) => b.at - a.at); render();
    }, (e) => { console.error(e); H.docs[id] = []; H.err = 'Documents couldn\'t load: ' + dbMsg(e); render(); });
  }

  /* ---------- routing ---------- */
  const owns = (r) => r === 'hr' || r === 'staff' || r.startsWith('staff-') || r === 'leave' || r === 'payroll' || r.startsWith('payrun-') || r.startsWith('payslip-') || r === 'hr-settings';
  function prepare(r) {
    if (!r.startsWith('staff-')) { H.ed = null; watchDocs(null); }
    if (!r.startsWith('payrun-')) { H.run = null; H.runSrc = ''; H.slipId = null; }
    if (r !== 'hr-settings') H.set = null;
    if (!H.on) return;
    if (r === 'staff-new') { if (!H.ed || H.ed.id) H.ed = edFrom(null); }
    else if (r.startsWith('staff-')) { const id = r.slice(6); if (!H.ed || H.ed.id !== id) H.ed = H.emps[id] ? edFrom(id) : null; watchDocs(H.emps[id] ? id : null); }
    if (r.startsWith('payrun-')) { const m = r.slice(7); if (!H.run || H.run.month !== m) { H.slipId = null; copyRun(m); } }
    if (r === 'hr-settings' && !H.set) H.set = setFrom();
  }
  function links() {
    if (!isHR()) return [];
    const pending = H.on ? leaveArr().filter((l) => l.status === 'Pending').length : 0;
    return [['hr', 'HR overview', 'heart'], ['staff', 'Staff', 'users'], ['leave', 'Leave', 'calendar', pending], ['payroll', 'Payroll', 'cash'], ['hr-settings', 'HR settings', 'cog']];
  }
  function navOn(k, r) {
    return r === k || (k === 'staff' && r.startsWith('staff-')) || (k === 'payroll' && (r.startsWith('payrun-') || r.startsWith('payslip-')));
  }
  function view(r) {
    if (!isHR()) return `<div class="panel empty">These pages are for the HR desk. ${A.isAdmin() ? 'Tick <b>HR desk</b> on the <a href="#desks">Desks</a> page, and add yourself as a member if you need access.' : ''}</div>`;
    if (!H.on) start();
    const err = H.err ? `<div class="banner banner--bad">${esc(H.err)}</div>` : '';
    if (!loaded()) return err + `<div class="empty"><img src="assets/img/emblem-gold.png" alt="">Loading HR records…</div>`;
    prepare(r);
    let out;
    if (r === 'hr') out = overview();
    else if (r === 'staff') out = staffList();
    else if (r.startsWith('staff-')) out = staffView();
    else if (r === 'leave') out = leaveView();
    else if (r === 'payroll') out = payrollView();
    else if (r.startsWith('payrun-')) out = runView();
    else if (r.startsWith('payslip-')) out = payslipView(r.slice(8, 15), r.slice(16));
    else out = settingsView();
    return err + out;
  }

  /* ---------- overview ---------- */
  function overview() {
    const t = today(), list = activeEmps(), soon = addDays(t, 30);
    const away = list.filter((e) => onLeave(e.id, t));
    const week = leaveArr().filter((l) => l.status === 'Approved' && l.to >= t && l.from <= addDays(t, 7) && !(l.from <= t && l.to >= t)).sort((a, b) => a.from.localeCompare(b.from));
    const pending = leaveArr().filter((l) => l.status === 'Pending').sort((a, b) => a.from.localeCompare(b.from));
    const joiners = empList().filter((e) => e.startDate && e.startDate >= t && e.startDate <= soon);
    const leavers = list.filter((e) => e.endDate && e.endDate >= t && e.endDate <= soon);
    const tasks = list.flatMap((e) => ['onboarding', 'offboarding'].flatMap((k) => (e[k] || []).filter((x) => !x.done).map((x) => ({ e, k, t: x.t }))));
    const probation = list.filter((e) => e.probationEnd && e.probationEnd >= t && e.probationEnd <= soon);
    const cur = t.slice(0, 7), run = H.runs[cur];
    const kpi = (k, v, s, href) => `<a class="panel kpi" href="#${href}" style="text-decoration:none"><div class="kpi__k">${k}</div><div class="kpi__v">${v}</div><div class="kpi__s">${s || '&nbsp;'}</div></a>`;
    const item = (html) => `<div class="hr-item">${html}</div>`;
    return `<div class="head"><div class="grow"><div class="eyebrow">Human resources</div><h1>HR overview</h1><p>${fmtD(t)} · ${list.length} active staff</p></div>
      <a class="btn btn--ghost" href="#staff-new">${icon('plus')} Add employee</a><button class="btn btn--primary" data-act="hr-leave-new">${icon('plus')} Record leave</button></div>
    <div class="kpis">
      ${kpi('Active staff', list.length, Object.keys(H.emps).length - list.length + ' former', 'staff')}
      ${kpi('Away today', away.length, away.length ? esc(away.slice(0, 2).map((e) => e.fullName.split(' ')[0]).join(', ')) + (away.length > 2 ? '…' : '') : 'Everyone in', 'leave')}
      ${kpi('Leave to approve', pending.length, pending.length ? 'Waiting for a decision' : 'All done', 'leave')}
      ${kpi('Joining soon', joiners.length, 'Next 30 days', 'staff')}
      ${kpi('Leaving soon', leavers.length, 'Next 30 days', 'staff')}
      ${kpi('Payroll ' + esc(fmtM(cur).split(' ')[0]), run ? (run.status === 'final' ? 'Done' : 'Draft') : '—', run ? money(runTotals(cur).net) + ' net' : 'Not started', run ? 'payrun-' + cur : 'payroll')}
    </div>
    <div class="grid2">
      <div class="panel"><div class="panel__h"><h2>Who's away</h2></div><div class="panel__b">
        ${away.length ? away.map((e) => { const l = onLeave(e.id, t); return item(`<a href="#staff-${esc(e.id)}"><b>${esc(e.fullName)}</b></a> <span class="muted">· ${esc(ltype(l.typeId).name)} until ${fmtD(l.to)}</span>`); }).join('') : '<div class="muted small">Nobody is on leave today.</div>'}
        ${week.length ? `<div class="lbl" style="margin-top:1rem">Coming up this week</div>` + week.map((l) => item(`<b>${esc(empName(l.empId))}</b> <span class="muted">· ${esc(ltype(l.typeId).name)}, ${fmtD(l.from)}${l.to !== l.from ? ' – ' + fmtD(l.to) : ''}</span>`)).join('') : ''}
      </div></div>
      <div class="panel"><div class="panel__h"><h2>Leave to approve</h2></div><div class="panel__b">
        ${pending.length ? pending.slice(0, 8).map((l) => item(`<div class="row wrap"><span class="grow"><b>${esc(empName(l.empId))}</b> <span class="muted">· ${esc(ltype(l.typeId).name)}, ${fmtD(l.from)}${l.to !== l.from ? ' – ' + fmtD(l.to) : ''} (${l.days} day${l.days === 1 ? '' : 's'})</span></span>
          <button class="btn btn--primary btn--sm" data-act="hr-leave-set" data-id="${esc(l.id)}" data-v="Approved">Approve</button><button class="btn btn--ghost btn--sm" data-act="hr-leave-set" data-id="${esc(l.id)}" data-v="Rejected">Reject</button></div>`)).join('') : '<div class="muted small">Nothing waiting.</div>'}
      </div></div>
    </div>
    <div class="grid2">
      <div class="panel"><div class="panel__h"><h2>Joiners, leavers and probation</h2></div><div class="panel__b">
        ${joiners.map((e) => item(`<a href="#staff-${esc(e.id)}"><b>${esc(e.fullName)}</b></a> <span class="muted">· starts ${fmtD(e.startDate)}${e.jobTitle ? ' as ' + esc(e.jobTitle) : ''}</span>`)).join('')}
        ${leavers.map((e) => item(`<a href="#staff-${esc(e.id)}"><b>${esc(e.fullName)}</b></a> <span class="muted">· last day ${fmtD(e.endDate)}</span>`)).join('')}
        ${probation.map((e) => item(`<a href="#staff-${esc(e.id)}"><b>${esc(e.fullName)}</b></a> <span class="muted">· probation ends ${fmtD(e.probationEnd)}</span>`)).join('')}
        ${joiners.length + leavers.length + probation.length ? '' : '<div class="muted small">Nothing in the next 30 days.</div>'}
      </div></div>
      <div class="panel"><div class="panel__h"><h2>Checklist items open</h2><span class="small muted">${tasks.length}</span></div><div class="panel__b">
        ${tasks.length ? tasks.slice(0, 10).map((x) => item(`<a href="#staff-${esc(x.e.id)}"><b>${esc(x.e.fullName)}</b></a> <span class="muted">· ${x.k === 'onboarding' ? 'Joining' : 'Leaving'}: ${esc(x.t)}</span>`)).join('') + (tasks.length > 10 ? `<div class="muted small">…and ${tasks.length - 10} more</div>` : '') : '<div class="muted small">All joining and leaving checklists are complete.</div>'}
      </div></div>
    </div>`;
  }

  /* ---------- staff list ---------- */
  function staffList() {
    const q = H.q.trim().toLowerCase(), yr = today().slice(0, 4), annual = leaveTypes().find((t) => t.id === 'annual');
    const list = empList().filter((e) => (H.show === 'all' || (H.show === 'left' ? e.status === 'Left' : e.status !== 'Left'))
      && (!H.dept || e.department === H.dept)
      && (!q || [e.fullName, e.empNo, e.email, e.jobTitle, e.nic].join(' ').toLowerCase().includes(q)));
    const depts = [...new Set(main().departments.concat(empList().map((e) => e.department)).filter(Boolean))].sort();
    return `<div class="head"><div class="grow"><div class="eyebrow">Human resources</div><h1>Staff</h1><p>${list.length} ${list.length === 1 ? 'person' : 'people'}</p></div>
      <button class="btn btn--ghost" data-act="hr-staff-csv" ${list.length ? '' : 'disabled'}>${icon('download')} Export</button>
      <a class="btn btn--primary" href="#staff-new">${icon('plus')} Add employee</a></div>
    <div class="panel"><div class="filters">
      <input id="hr-q" class="input search" placeholder="Search name, employee no., job, NIC…" value="${esc(H.q)}" data-bind="hr.q" data-rr aria-label="Search staff">
      <select id="hr-dept" class="input" data-bind="hr.dept" data-rr aria-label="Department">${opt('', 'All departments', H.dept)}${depts.map((d) => opt(d, d, H.dept)).join('')}</select>
      <select id="hr-show" class="input" data-bind="hr.show" data-rr aria-label="Status">${opt('active', 'Current staff', H.show)}${opt('left', 'Former staff', H.show)}${opt('all', 'Everyone', H.show)}</select>
    </div>
    ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Department</th><th>Started</th><th>Contract</th><th>Status</th><th class="num">Basic</th>${annual ? '<th class="num">Annual leave left</th>' : ''}</tr></thead><tbody>
      ${list.map((e) => { const left = annual ? entitlement(e, annual) - usedDays(e.id, 'annual', yr) : 0, away = onLeave(e.id, today());
        return `<tr class="click" data-act="hr-open" data-href="staff-${esc(e.id)}"><td><a class="ttl" href="#staff-${esc(e.id)}">${esc(e.fullName)}</a><div class="sub">${esc([e.empNo, e.jobTitle].filter(Boolean).join(' · ') || '—')}</div></td>
        <td>${esc(e.department || '—')}</td><td class="nowrap">${fmtD(e.startDate)}</td><td>${esc(e.contractType || '—')}</td>
        <td>${e.status === 'Left' ? pillHR('Left') : away ? pillHR('On leave') : e.endDate ? pillHR('Leaving') : pillHR('Active')}</td>
        <td class="num nowrap">${e.basic ? money(e.basic) : '—'}</td>${annual ? `<td class="num">${e.status === 'Left' ? '—' : money2(left)}</td>` : ''}</tr>`; }).join('')}
    </tbody></table></div>` : `<div class="empty">${Object.keys(H.emps).length ? 'Nobody matches these filters.' : 'No staff records yet. <a href="#staff-new">Add the first employee</a>.'}</div>`}</div>`;
  }

  /* ---------- employee record ---------- */
  function edFrom(id) {
    const e = id ? H.emps[id] : null, ld = {};
    leaveTypes().forEach((t) => { ld[t.id] = e && e.leaveDays && e.leaveDays[t.id] != null ? String(e.leaveDays[t.id]) : ''; });
    return {
      id, touched: false, err: '',
      fullName: e ? e.fullName || '' : '', empNo: e ? e.empNo || '' : nextEmpNo(), nic: e ? e.nic || '' : '', email: e ? e.email || '' : '', phone: e ? e.phone || '' : '',
      address: e ? e.address || '' : '', dob: e ? e.dob || '' : '', emergency: e ? e.emergency || '' : '',
      department: e ? e.department || '' : '', jobTitle: e ? e.jobTitle || '' : '', manager: e ? e.manager || '' : '',
      startDate: e ? e.startDate || '' : '', contractType: e ? e.contractType || 'Permanent' : 'Permanent', probationEnd: e ? e.probationEnd || '' : '',
      endDate: e ? e.endDate || '' : '', status: e ? e.status || 'Active' : 'Active', userId: e ? e.userId || '' : '',
      bankName: e ? e.bankName || '' : '', bankAccount: e ? e.bankAccount || '' : '',
      basic: e && e.basic != null ? String(e.basic) : '', allowances: e ? (e.allowances || []).map((a) => ({ label: a.label, amount: String(a.amount), taxable: a.taxable !== false })) : [],
      dependents: e ? String(e.dependents || 0) : '0', otherReliefs: e && e.otherReliefs ? String(e.otherReliefs) : '',
      csg: e ? e.csg !== false : true, nsf: e ? e.nsf !== false : true, prgf: e ? e.prgf !== false : true, levy: e ? e.levy !== false : true,
      openTY: e && e.opening ? e.opening.taxYear : '', openEmol: e && e.opening ? String(e.opening.emol) : '', openPaye: e && e.opening ? String(e.opening.paye) : '',
      leaveDays: ld, notes: e ? e.notes || '' : '',
    };
  }
  function nextEmpNo() {
    const ns = empList().map((e) => (/^(?:ZEN-?)?E?(\d+)$/i.exec(e.empNo || '') || [])[1]).filter(Boolean).map(Number);
    return 'E' + String((ns.length ? Math.max(...ns) : 100) + 1);
  }
  const fieldI = (id, label, bind, val, attrs, hint) => `<div class="field"><label class="lbl" for="${id}">${label}</label><input id="${id}" class="input" value="${esc(val)}" data-bind="${bind}" ${attrs || ''}>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  function staffView() {
    const d = H.ed;
    if (!d) return back('staff', 'Staff') + `<div class="panel empty">This employee record doesn't exist.</div>`;
    const e = d.id ? H.emps[d.id] : null, b = (k) => 'hr.ed.' + k;
    const depts = [...new Set(main().departments.concat(d.department ? [d.department] : []))];
    const users = Object.entries(S.users).filter(([, u]) => u.active !== false).map(([id]) => id).sort(byName);
    const ty = P.taxYearOf(today().slice(0, 7));
    const form = `<form data-form="hr-emp-save" class="desk-form">
      <div class="panel"><div class="panel__h"><h2>Personal details</h2></div><div class="panel__b"><div class="g2">
        ${fieldI('he-name', 'Full name <span class="req">*</span>', b('fullName'), d.fullName, 'maxlength="100" autocomplete="off"')}
        ${fieldI('he-no', 'Employee no.', b('empNo'), d.empNo, 'maxlength="20"')}
        ${fieldI('he-nic', 'NIC number', b('nic'), d.nic, 'maxlength="20"')}
        ${fieldI('he-dob', 'Date of birth', b('dob'), d.dob, 'type="date"')}
        ${fieldI('he-email', 'Email', b('email'), d.email, 'type="email" maxlength="160"')}
        ${fieldI('he-phone', 'Phone', b('phone'), d.phone, 'maxlength="40"')}
        ${fieldI('he-addr', 'Address', b('address'), d.address, 'maxlength="200"')}
        ${fieldI('he-emer', 'Emergency contact', b('emergency'), d.emergency, 'maxlength="120" placeholder="Name and phone"')}
      </div></div></div>
      <div class="panel"><div class="panel__h"><h2>Job</h2></div><div class="panel__b"><div class="g2">
        ${fieldI('he-job', 'Job title', b('jobTitle'), d.jobTitle, 'maxlength="80"')}
        <div class="field"><label class="lbl" for="he-dept">Department</label><select id="he-dept" class="input" data-bind="${b('department')}">${opt('', 'Choose…', d.department)}${depts.map((x) => opt(x, x, d.department)).join('')}</select></div>
        ${fieldI('he-mgr', 'Reports to', b('manager'), d.manager, 'maxlength="80"')}
        <div class="field"><label class="lbl" for="he-ct">Contract</label><select id="he-ct" class="input" data-bind="${b('contractType')}">${CONTRACTS.map((x) => opt(x, x, d.contractType)).join('')}</select></div>
        ${fieldI('he-start', 'Start date <span class="req">*</span>', b('startDate'), d.startDate, 'type="date"')}
        ${fieldI('he-prob', 'Probation ends', b('probationEnd'), d.probationEnd, 'type="date"')}
        <div class="field"><label class="lbl" for="he-user">Zenitude Desk account</label><select id="he-user" class="input" data-bind="${b('userId')}">${opt('', 'Not linked', d.userId)}${users.map((u) => opt(u, name(u) + ' · ' + (S.users[u].email || ''), d.userId)).join('')}</select><div class="hint">Links their tickets to this record.</div></div>
        ${e ? `<div class="field"><label class="lbl">Status</label><div style="padding-top:.45rem">${d.status === 'Left' ? pillHR('Left') + (d.endDate ? ' <span class="small muted">on ' + fmtD(d.endDate) + '</span>' : '') : d.endDate ? pillHR('Leaving') + ' <span class="small muted">last day ' + fmtD(d.endDate) + '</span>' : pillHR('Active')}</div></div>` : ''}
      </div></div></div>
      <div class="panel"><div class="panel__h"><h2>Pay and tax</h2><span class="small muted">used to prepare each month's payroll</span></div><div class="panel__b">
        <div class="g2">
          ${fieldI('he-basic', 'Basic salary per month (Rs)', b('basic'), d.basic, 'inputmode="decimal" placeholder="e.g. 35000"')}
          <div class="field"><label class="lbl" for="he-dep">Dependents (from their EDF)</label><select id="he-dep" class="input" data-bind="${b('dependents')}">${[0, 1, 2, 3, 4].map((n) => opt(String(n), n === 0 ? 'None' : n + (n === 4 ? ' or more' : ''), d.dependents)).join('')}</select></div>
          ${fieldI('he-bank', 'Bank', b('bankName'), d.bankName, 'maxlength="60" placeholder="e.g. MCB"')}
          ${fieldI('he-acc', 'Account number', b('bankAccount'), d.bankAccount, 'maxlength="40"')}
        </div>
        <div class="lbl" style="margin-top:.4rem">Regular allowances</div>
        ${d.allowances.map((a, i) => `<div class="line"><input id="he-al-${i}" class="input" maxlength="60" placeholder="e.g. Transport allowance" value="${esc(a.label)}" data-bind="${b('allowances.' + i + '.label')}" aria-label="Allowance name">
          <input id="he-aa-${i}" class="input num" inputmode="decimal" placeholder="Rs per month" value="${esc(a.amount)}" data-bind="${b('allowances.' + i + '.amount')}" aria-label="Amount">
          <label class="check"><input type="checkbox" id="he-at-${i}" data-bind="${b('allowances.' + i + '.taxable')}" ${a.taxable ? 'checked' : ''}> Taxable</label>
          <button type="button" class="btn btn--danger-ghost btn--sm" data-act="hr-al-del" data-i="${i}">Remove</button></div>`).join('')}
        <button type="button" class="btn btn--ghost btn--sm" data-act="hr-al-add">${icon('plus')} Add allowance</button>
        <details class="more" ${d.otherReliefs || d.openTY || !d.csg || !d.nsf || !d.prgf || !d.levy ? 'open' : ''}><summary>More tax settings</summary>
          <div class="g2" style="margin-top:.8rem">
            ${fieldI('he-rel', 'Other yearly reliefs from their EDF (Rs)', b('otherReliefs'), d.otherReliefs, 'inputmode="decimal" placeholder="0"', 'E.g. medical insurance or housing loan interest they claim. Leave empty if none.')}
            <div class="field"><label class="lbl">Contributions that apply</label><div class="row wrap" style="gap:1rem;padding-top:.4rem">
              <label class="check"><input type="checkbox" id="he-csg" data-bind="${b('csg')}" ${d.csg ? 'checked' : ''}> CSG</label><label class="check"><input type="checkbox" id="he-nsf" data-bind="${b('nsf')}" ${d.nsf ? 'checked' : ''}> NSF</label>
              <label class="check"><input type="checkbox" id="he-prgf" data-bind="${b('prgf')}" ${d.prgf ? 'checked' : ''}> PRGF</label><label class="check"><input type="checkbox" id="he-levy" data-bind="${b('levy')}" ${d.levy ? 'checked' : ''}> Training levy</label></div></div>
          </div>
          <div class="lbl" style="margin-top:.6rem">Joined during the tax year? Pay and PAYE from their previous employer</div>
          <div class="row wrap" style="gap:.8rem;align-items:flex-start">
            <div class="field" style="width:140px"><label class="lbl" for="he-oty">Tax year</label><select id="he-oty" class="input" data-bind="${b('openTY')}">${opt('', 'None', d.openTY)}${[...new Set(allYears().concat([ty]))].map((y) => opt(y, y, d.openTY)).join('')}</select></div>
            <div class="field grow" style="min-width:160px"><label class="lbl" for="he-oe">Taxable pay (Rs)</label><input id="he-oe" class="input" inputmode="decimal" value="${esc(d.openEmol)}" data-bind="${b('openEmol')}"></div>
            <div class="field grow" style="min-width:160px"><label class="lbl" for="he-op">PAYE already paid (Rs)</label><input id="he-op" class="input" inputmode="decimal" value="${esc(d.openPaye)}" data-bind="${b('openPaye')}"></div>
          </div>
        </details>
      </div></div>
      <div class="panel"><div class="panel__h"><h2>Leave allowance</h2><span class="small muted">days per calendar year · empty = company default</span></div><div class="panel__b"><div class="row wrap" style="gap:1rem">
        ${leaveTypes().filter((t) => Number(t.days) > 0).map((t) => `<div class="field" style="width:150px"><label class="lbl" for="he-ld-${esc(t.id)}">${esc(t.name)}</label><input id="he-ld-${esc(t.id)}" class="input" inputmode="decimal" placeholder="${esc(t.days)}" value="${esc(d.leaveDays[t.id] || '')}" data-bind="${b('leaveDays.' + t.id)}"></div>`).join('')}
      </div></div></div>
      <div class="panel"><div class="panel__h"><h2>Notes</h2></div><div class="panel__b"><textarea id="he-notes" class="input" rows="3" maxlength="3000" data-bind="${b('notes')}" placeholder="Anything HR should remember (only HR can see this)">${esc(d.notes)}</textarea></div></div>
      ${d.err ? `<div class="banner banner--bad">${esc(d.err)}</div>` : ''}
      <div class="row" style="justify-content:flex-end;gap:.6rem"><a class="btn btn--ghost" href="#staff">Cancel</a><button class="btn btn--primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Saving…' : e ? 'Save changes' : 'Add employee'}</button></div>
    </form>`;
    if (!e) return back('staff', 'Staff') + `<div class="head"><div class="grow"><div class="eyebrow">New employee</div><h1>${esc(d.fullName || 'Add employee')}</h1><p>A joining checklist is created from your HR settings when you save.</p></div></div>` + form;
    return back('staff', 'Staff') + `<div class="head"><div class="grow"><div class="eyebrow">${esc([e.empNo, e.department].filter(Boolean).join(' · ') || 'Employee')}</div><h1>${esc(e.fullName)}</h1><p>${esc(e.jobTitle || '')}${e.startDate ? (e.jobTitle ? ' · ' : '') + 'since ' + fmtD(e.startDate) : ''}</p></div>
      <button class="btn btn--ghost" data-act="hr-leave-new" data-emp="${esc(d.id)}">${icon('plus')} Record leave</button>
      ${e.status === 'Left' ? `<button class="btn btn--ghost" data-act="hr-rehire" data-id="${esc(d.id)}">Mark as current again</button>` : e.endDate ? `<button class="btn btn--ghost" data-act="hr-mark-left" data-id="${esc(d.id)}">Mark as left</button>` : `<button class="btn btn--ghost" data-act="hr-offboard" data-id="${esc(d.id)}">Start leaving process</button>`}</div>
    <div class="detail"><div>${form}</div><aside class="col-side">${sideCards(d.id, e)}</aside></div>`;
  }
  function checklist(id, e, key, title) {
    const list = e[key] || []; if (!list.length) return '';
    const done = list.filter((x) => x.done).length;
    return `<div class="panel"><div class="panel__h"><h2>${title}</h2><span class="small muted">${done}/${list.length}</span></div><div class="panel__b">
      <div class="progress"><span style="width:${Math.round(done / list.length * 100)}%"></span></div>
      ${list.map((x, i) => `<label class="check todo"><input type="checkbox" id="hc-${key}-${i}" data-chg="hr-check" data-id="${esc(id)}" data-k="${key}" data-i="${i}" ${x.done ? 'checked' : ''}><span>${esc(x.t)}${x.done && x.by ? `<br><span class="small muted">${esc(name(x.by))} · ${fmtD(isoD(new Date(x.at)))}</span>` : ''}</span></label>`).join('')}
    </div></div>`;
  }
  function sideCards(id, e) {
    const yr = today().slice(0, 4), docs = H.docs[id];
    const its = (e.itTickets || []).slice().reverse();
    const hist = leaveArr().filter((l) => l.empId === id).sort((a, b) => b.from.localeCompare(a.from)).slice(0, 6);
    const itDesk = itDeskId();
    return `
      <div class="panel"><div class="panel__h"><h2>Leave ${yr}</h2></div><div class="panel__b">
        <div class="kv">${leaveTypes().map((t) => { const used = usedDays(id, t.id, yr), ent = entitlement(e, t);
          return ent > 0 || used > 0 ? `<span class="k">${esc(t.name.replace(/ leave$/, ''))}</span><span>${ent > 0 ? `<b>${money2(ent - used)}</b> left <span class="muted small">of ${money2(ent)}</span>` : `${money2(used)} day${used === 1 ? '' : 's'} taken`}</span>` : ''; }).join('')}</div>
        ${hist.length ? `<div class="lbl" style="margin-top:1rem">Recent</div>${hist.map((l) => `<div class="hr-item small"><span class="grow">${esc(ltype(l.typeId).name)} · ${fmtD(l.from)}${l.to !== l.from ? ' – ' + fmtD(l.to) : ''} · ${l.days}d</span> ${pillHR(l.status)}</div>`).join('')}` : ''}
      </div></div>
      ${checklist(id, e, 'onboarding', 'Joining checklist')}
      ${checklist(id, e, 'offboarding', 'Leaving checklist')}
      <div class="panel"><div class="panel__h"><h2>IT requests</h2></div><div class="panel__b">
        ${itDesk ? `<div class="row wrap" style="gap:.5rem">
          <button class="btn btn--ghost btn--sm" data-act="hr-it" data-id="${esc(id)}" data-k="join" ${e.status === 'Left' ? 'disabled' : ''}>Ask IT to set up accounts</button>
          ${e.endDate || e.status === 'Left' ? `<button class="btn btn--ghost btn--sm" data-act="hr-it" data-id="${esc(id)}" data-k="leave">Ask IT to remove access</button>` : ''}</div>` : '<div class="muted small">No open IT desk to send requests to.</div>'}
        ${its.map((t) => `<div class="hr-item small"><a href="#ticket-${esc(t.id)}">ZEN-${esc(t.num)}</a> · ${t.kind === 'join' ? 'Set up accounts' : 'Remove access'} <span class="muted">· ${rel(t.at)}</span></div>`).join('')}
      </div></div>
      <div class="panel"><div class="panel__h"><h2>Documents</h2></div><div class="panel__b">
        ${docs == null ? '<div class="muted small">Loading…</div>' : docs.length ? docs.map((f) => `<div class="hr-item"><button type="button" class="btn btn--link grow" style="text-align:left" data-act="hr-doc-open" data-emp="${esc(id)}" data-id="${esc(f.id)}">${esc(f.name)}</button><span class="small muted">${fmtD(isoD(new Date(f.at)))}</span></div>`).join('') : '<div class="muted small">No documents yet.</div>'}
        <label class="btn btn--ghost btn--sm att__btn ${H.docBusy ? 'is-off' : ''}" style="margin-top:.7rem">${icon('image')} ${H.docBusy ? 'Uploading…' : 'Add PDF or photo'}<input type="file" accept="application/pdf,image/*" multiple data-hrdoc="${esc(id)}" ${H.docBusy ? 'disabled' : ''}></label>
        <div class="hint">Contracts, NIC copies, certificates, medical notes. PDFs up to about 650 KB; photos are shrunk automatically.</div>
      </div></div>
      ${(e.log || []).length ? `<div class="panel"><div class="panel__h"><h2>History</h2></div><div class="panel__b"><div class="timeline">${(e.log || []).slice(-8).reverse().map((l) => `<div class="ev"><span class="ev__dot"></span><div><b>${esc(name(l.by))}</b> ${esc(l.text)} <span title="${esc(new Date(l.at).toLocaleString())}">· ${rel(l.at)}</span></div></div>`).join('')}</div></div></div>` : ''}`;
  }
  async function saveEmp() {
    const d = H.ed; if (!d) return;
    const old = d.id ? H.emps[d.id] : null;
    const fullName = d.fullName.trim(), email = d.email.trim().toLowerCase();
    const allowances = d.allowances.map((a) => ({ label: a.label.trim(), amount: num(a.amount), taxable: !!a.taxable })).filter((a) => a.label || a.amount);
    const leaveDays = {}; Object.entries(d.leaveDays || {}).forEach(([k, v]) => { if (String(v).trim() !== '') leaveDays[k] = num(v); });
    d.err = fullName.length < 2 ? 'Enter the employee\'s full name.'
      : !d.startDate ? 'Enter the start date.'
      : email && !A.emailOk(email) ? 'The email address doesn\'t look right.'
      : num(d.basic) < 0 ? 'Basic salary can\'t be negative.'
      : allowances.some((a) => !a.label) ? 'Every allowance needs a name.'
      : d.endDate && d.endDate < d.startDate ? 'The last day is before the start date.'
      : d.openTY && (num(d.openEmol) < 0 || num(d.openPaye) < 0) ? 'Previous employer amounts can\'t be negative.' : '';
    if (d.err) return render();
    const at = now(), by = S.me.id, log = old ? (old.log || []).slice(-80) : [{ at, by, text: 'added the record' }];
    const doc = {
      fullName, empNo: d.empNo.trim(), nic: d.nic.trim().toUpperCase(), email, phone: d.phone.trim(), address: d.address.trim(), dob: d.dob, emergency: d.emergency.trim(),
      department: d.department, jobTitle: d.jobTitle.trim(), manager: d.manager.trim(), startDate: d.startDate, contractType: d.contractType, probationEnd: d.probationEnd,
      endDate: d.endDate || '', status: d.status || 'Active', userId: d.userId || '',
      bankName: d.bankName.trim(), bankAccount: d.bankAccount.trim(), basic: num(d.basic), allowances,
      dependents: Math.min(4, Math.max(0, Math.round(num(d.dependents)))), otherReliefs: num(d.otherReliefs),
      csg: !!d.csg, nsf: !!d.nsf, prgf: !!d.prgf, levy: !!d.levy,
      opening: d.openTY ? { taxYear: d.openTY, emol: num(d.openEmol), paye: num(d.openPaye) } : null,
      leaveDays, notes: d.notes.trim(), updatedAt: at, updatedBy: by,
    };
    if (old) {
      if (Number(old.basic || 0) !== doc.basic) log.push({ at, by, text: `changed basic salary from ${money(old.basic)} to ${money(doc.basic)}` });
      if ((old.jobTitle || '') !== doc.jobTitle || (old.department || '') !== doc.department) log.push({ at, by, text: `changed job to ${[doc.jobTitle, doc.department].filter(Boolean).join(', ') || '—'}` });
      if ((old.contractType || '') !== doc.contractType) log.push({ at, by, text: `changed contract to ${doc.contractType}` });
      if (JSON.stringify(old.allowances || []) !== JSON.stringify(allowances)) log.push({ at, by, text: 'updated allowances' });
      if (log.length === (old.log || []).slice(-80).length) log.push({ at, by, text: 'updated the record' });
    } else {
      doc.createdAt = at; doc.createdBy = by;
      doc.onboarding = main().onboarding.map((t) => ({ t, done: false }));
      doc.offboarding = []; doc.itTickets = [];
    }
    doc.log = log;
    S.busy = true; render();
    try {
      if (old) await S.db.collection('employees').doc(d.id).update(doc);
      else { const ref = S.db.collection('employees').doc(); await ref.set(doc); d.id = ref.id; }
      S.busy = false; H.ed = null;
      toast(old ? fullName + '\'s record saved.' : fullName + ' added. Their joining checklist is ready.');
      go('staff-' + d.id);
    } catch (e) { S.busy = false; d.err = dbMsg(e); render(); }
  }
  function itDeskId() {
    if (S.desks.it && S.desks.it.active !== false) return 'it';
    return Object.keys(S.desks).find((k) => k !== deskRef() && S.desks[k].active !== false) || '';
  }
  async function raiseIt(id, kind) {
    const e = H.emps[id], desk = itDeskId(); if (!e || !desk) return;
    const join = kind === 'join', n = now(), me = S.user.uid, cats = categoriesOf(desk);
    const title = (join ? `New joiner: ${e.fullName}, starts ${fmtD(e.startDate)}` : `Leaver: ${e.fullName}, last day ${fmtD(e.endDate || today())}`).slice(0, 120);
    const lines = [join ? 'Please set up IT for a new member of staff.' : 'Please remove IT access for a member of staff who is leaving.', '',
      'Name: ' + e.fullName, e.jobTitle ? 'Job: ' + e.jobTitle : '', e.department ? 'Department: ' + e.department : '', e.email ? 'Email: ' + e.email : '',
      join ? 'Start date: ' + fmtD(e.startDate) : 'Last day: ' + fmtD(e.endDate || today()), '',
      join ? 'Needed: email account, Zenitude Desk account, computer/phone as agreed with their manager.' : 'Needed: disable accounts after the last day, collect laptop/phone, forward or archive their mailbox.'].filter((x, i, a) => x !== '' || a[i - 1] !== '');
    const base = { deskId: desk, title, description: lines.join('\n'), category: cats.includes('Accounts & Access') ? 'Accounts & Access' : cats.includes('Other') ? 'Other' : cats[0],
      priority: join ? 'Medium' : 'High', status: 'Open', requesterId: me, assigneeId: null, createdBy: me, createdAt: n, updatedAt: n,
      dueAt: n + slaFor(desk, join ? 'Medium' : 'High') * HOUR, resolvedAt: null, closedAt: null, resolution: '', history: [{ at: n, by: me, text: 'raised the ticket from HR' }] };
    const counter = S.db.doc('meta/counter'), tRef = S.db.collection('tickets').doc();
    try {
      const num_ = await S.db.runTransaction(async (tx) => { const c = await tx.get(counter); const x = c.exists ? c.data().next : 1001; tx.set(counter, { next: x + 1 }); tx.set(tRef, Object.assign({ num: x }, base)); return x; });
      await S.db.collection('employees').doc(id).update({ itTickets: (e.itTickets || []).concat([{ kind, id: tRef.id, num: num_, at: n }]), log: (e.log || []).slice(-80).concat([{ at: n, by: me, text: `asked IT to ${join ? 'set up accounts' : 'remove access'} (ZEN-${num_})` }]) });
      toast(`ZEN-${num_} sent to ${A.deskName(desk)}.`);
    } catch (err) { fail(err); }
  }
  async function uploadDocs(id, files) {
    const e = H.emps[id]; if (!e || !files || !files.length) return;
    H.docBusy = true; render();
    for (const f of [...files].slice(0, 5)) {
      try {
        let data, type, nm = (f.name || 'document').slice(0, 140);
        if (/^image\//.test(f.type)) { const p = await prepareImage(f); data = p.full; type = 'image/jpeg'; nm = p.name; }
        else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '')) {
          data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('could not be read')); r.readAsDataURL(f); });
          type = 'application/pdf'; if (!/^data:application\/pdf/.test(data)) data = 'data:application/pdf;base64,' + data.split(',')[1];
        } else throw new Error('only PDFs and photos can be added');
        if (data.length > MAX_DOC_CHARS) throw new Error('too large (about 650 KB is the limit). Compress the PDF first');
        const ref = S.db.collection('employees').doc(id).collection('docs').doc(), b = S.db.batch();
        b.set(ref, { name: nm, type, size: Math.round(data.length * 0.75), at: now(), by: S.me.id });
        b.set(ref.collection('content').doc('full'), { data });
        await b.commit();
      } catch (err) { toast((f.name || 'File') + ': ' + (err.code ? dbMsg(err) : err.message) + '.', 'error'); }
    }
    H.docBusy = false; render();
  }
  async function openDoc(empId, did) {
    const f = (H.docs[empId] || []).find((x) => x.id === did); if (!f) return;
    S.modal = { type: 'hr-doc', empId, did, name: f.name, kind: f.type, url: null, err: '' }; render();
    try {
      const d = await S.db.collection('employees').doc(empId).collection('docs').doc(did).collection('content').doc('full').get();
      if (!S.modal || S.modal.did !== did) return;
      if (!d.exists) { S.modal.err = 'This document is no longer available.'; return render(); }
      S.modal.url = URL.createObjectURL(dataUrlToBlob(d.data().data)); render();
    } catch (e) { if (S.modal && S.modal.did === did) { S.modal.err = dbMsg(e); render(); } }
  }

  /* ---------- leave ---------- */
  function leaveModalFrom(l, empId) {
    const t = today();
    return l ? { type: 'hr-leave', id: l.id, empId: l.empId, typeId: l.typeId, from: l.from, to: l.to, half: !!l.half, reason: l.reason || '', status: l.status, err: '' }
      : { type: 'hr-leave', id: null, empId: empId || '', typeId: 'annual', from: t, to: t, half: false, reason: '', status: 'Approved', err: '' };
  }
  function leaveView() {
    const L = H.lv;
    const tabs = `<div class="seg" role="tablist">${[['requests', 'Leave records'], ['calendar', 'Calendar'], ['balances', 'Balances']].map(([k, l]) => `<button class="${L.tab === k ? 'on' : ''}" data-act="hr-lv-tab" data-v="${k}">${l}</button>`).join('')}</div>`;
    const headr = `<div class="head"><div class="grow"><div class="eyebrow">Human resources</div><h1>Leave</h1><p>Days are working days: weekends and the public holidays in HR settings don't count.</p></div>
      <button class="btn btn--primary" data-act="hr-leave-new">${icon('plus')} Record leave</button></div>`;
    if (L.tab === 'calendar') return headr + tabs + leaveCalendar();
    if (L.tab === 'balances') return headr + tabs + leaveBalances();
    const q = L.q.trim().toLowerCase();
    const list = leaveArr().filter((l) => (!L.status || (L.status === 'Closed' ? ['Rejected', 'Cancelled'].includes(l.status) : l.status === L.status))
      && (l.from.slice(0, 4) === L.year || l.to.slice(0, 4) === L.year || L.status === 'Pending')
      && (!q || empName(l.empId).toLowerCase().includes(q))).sort((a, b) => (L.status === 'Pending' ? a.from.localeCompare(b.from) : b.from.localeCompare(a.from)));
    const years = [...new Set(leaveArr().flatMap((l) => [l.from.slice(0, 4), l.to.slice(0, 4)]).concat([today().slice(0, 4)]))].sort().reverse();
    return headr + tabs + `<div class="panel"><div class="filters">
      <input id="lv-q" class="input search" placeholder="Search a name…" value="${esc(L.q)}" data-bind="hr.lv.q" data-rr aria-label="Search">
      <select id="lv-st" class="input" data-bind="hr.lv.status" data-rr aria-label="Status">${opt('Pending', 'Waiting for approval', L.status)}${opt('Approved', 'Approved', L.status)}${opt('Closed', 'Rejected or cancelled', L.status)}${opt('', 'All', L.status)}</select>
      <select id="lv-yr" class="input" data-bind="hr.lv.year" data-rr aria-label="Year">${years.map((y) => opt(y, y, L.year)).join('')}</select>
    </div>
    ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th class="num">Days</th><th>Status</th><th>Reason</th><th></th></tr></thead><tbody>
      ${list.map((l) => `<tr><td><a class="ttl" href="#staff-${esc(l.empId)}">${esc(empName(l.empId))}</a></td><td>${esc(ltype(l.typeId).name)}</td>
        <td class="nowrap">${fmtD(l.from)}${l.to !== l.from ? ' – ' + fmtD(l.to) : l.half ? ' (half day)' : ''}</td><td class="num">${money2(l.days)}</td><td>${pillHR(l.status)}</td>
        <td class="small t2" style="max-width:260px">${esc(l.reason || '')}</td>
        <td class="nowrap">${l.status === 'Pending' ? `<button class="btn btn--primary btn--sm" data-act="hr-leave-set" data-id="${esc(l.id)}" data-v="Approved">Approve</button> <button class="btn btn--ghost btn--sm" data-act="hr-leave-set" data-id="${esc(l.id)}" data-v="Rejected">Reject</button> ` : ''}<button class="btn btn--ghost btn--sm" data-act="hr-leave-edit" data-id="${esc(l.id)}">Edit</button></td></tr>`).join('')}
    </tbody></table></div>` : `<div class="empty">${L.status === 'Pending' ? 'No leave waiting for approval.' : 'No leave records here.'}</div>`}</div>`;
  }
  function leaveCalendar() {
    const m = H.lv.month, first = m + '-01', last = monthEnd(m), days = [];
    for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
    const mm = main(), hol = {}; (mm.holidays || []).forEach((h) => { hol[h.date] = h.name; });
    const ls = leaveArr().filter((l) => ['Approved', 'Pending'].includes(l.status) && l.from <= last && l.to >= first);
    const ids = [...new Set(ls.map((l) => l.empId))].sort((a, b) => empName(a).localeCompare(empName(b)));
    const types = leaveTypes().map((t) => t.id), color = (id) => 'lc' + (types.indexOf(id) % 6 + 6) % 6;
    return `<div class="panel"><div class="filters"><button class="btn btn--ghost btn--sm" data-act="hr-cal" data-v="-1" aria-label="Previous month">‹</button><b style="min-width:150px;text-align:center">${fmtM(m)}</b><button class="btn btn--ghost btn--sm" data-act="hr-cal" data-v="1" aria-label="Next month">›</button>
      <span class="grow"></span>${leaveTypes().map((t) => `<span class="small nowrap"><i class="lsw ${color(t.id)}"></i>${esc(t.name)}</span>`).join(' ')}</div>
      ${ids.length ? `<div class="tbl-wrap"><table class="cal"><thead><tr><th class="cal__n">Employee</th>${days.map((d) => { const w = parseD(d).getDay(), off = !mm.workDays.includes(w) || hol[d];
        return `<th class="${off ? 'off' : ''} ${d === today() ? 'now' : ''}" title="${esc(hol[d] || '')}">${WEEK[w][0]}<br>${Number(d.slice(8))}</th>`; }).join('')}</tr></thead><tbody>
        ${ids.map((id) => `<tr><td class="cal__n"><a href="#staff-${esc(id)}">${esc(empName(id))}</a></td>${days.map((d) => { const l = ls.find((x) => x.empId === id && x.from <= d && x.to >= d), w = parseD(d).getDay(), off = !mm.workDays.includes(w) || hol[d];
          return `<td class="${off ? 'off' : ''}">${l ? `<i class="lb ${color(l.typeId)} ${l.status === 'Pending' ? 'pend' : ''}" title="${esc(ltype(l.typeId).name + (l.status === 'Pending' ? ' (waiting for approval)' : ''))}"></i>` : ''}</td>`; }).join('')}</tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Nobody has leave this month.</div>'}
      ${Object.keys(hol).filter((d) => d >= first && d <= last).length ? `<div class="panel__b small t2">Public holidays: ${Object.entries(hol).filter(([d]) => d >= first && d <= last).map(([d, n]) => fmtD(d) + ' ' + esc(n)).join(' · ')}</div>` : ''}
    </div>`;
  }
  function leaveBalances() {
    const y = H.lv.year, types = leaveTypes();
    const years = [...new Set(leaveArr().map((l) => l.from.slice(0, 4)).concat([today().slice(0, 4), String(Number(today().slice(0, 4)) + 1)]))].sort().reverse();
    const list = activeEmps();
    return `<div class="panel"><div class="filters"><select id="lv-by" class="input" data-bind="hr.lv.year" data-rr aria-label="Year">${years.map((x) => opt(x, x, y)).join('')}</select>
      <span class="small muted">Days left = allowance − approved days in ${esc(y)}. Set allowances per person on their staff record.</span><span class="grow"></span>
      <button class="btn btn--ghost btn--sm" data-act="hr-bal-csv">${icon('download')} Export</button></div>
      ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Employee</th>${types.map((t) => `<th class="num">${esc(t.name)}</th>`).join('')}</tr></thead><tbody>
        ${list.map((e) => `<tr><td><a class="ttl" href="#staff-${esc(e.id)}">${esc(e.fullName)}</a></td>${types.map((t) => { const u = usedDays(e.id, t.id, y), ent = entitlement(e, t);
          return `<td class="num nowrap">${ent > 0 ? `<b class="${ent - u < 0 ? 'neg' : ''}">${money2(ent - u)}</b> <span class="muted small">/ ${money2(ent)}</span>` : u ? money2(u) + ' <span class="muted small">taken</span>' : '<span class="muted">—</span>'}</td>`; }).join('')}</tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No current staff.</div>'}</div>`;
  }
  function leaveModal(m) {
    const emps = activeEmps(), days = workingDays(m.from, m.to, m.half), t = ltype(m.typeId), e = emp(m.empId);
    const yr = (m.from || today()).slice(0, 4), ent = e ? entitlement(e, t) : 0;
    const used = e ? usedDays(m.empId, m.typeId, yr) - (m.id && H.leave[m.id] && H.leave[m.id].status === 'Approved' && H.leave[m.id].typeId === m.typeId ? daysWithin(H.leave[m.id], yr + '-01-01', yr + '-12-31') : 0) : 0;
    const clash = m.empId && leaveArr().find((l) => l.id !== m.id && l.empId === m.empId && ['Approved', 'Pending'].includes(l.status) && l.from <= m.to && l.to >= m.from);
    return `<form data-form="hr-leave-save"><div class="modal" data-act="overlay"><div class="modal__box" role="dialog" aria-modal="true"><div class="modal__head"><h3>${m.id ? 'Edit leave' : 'Record leave'}</h3></div><div class="modal__body">
      <div class="field"><label class="lbl" for="lm-e">Employee</label><select id="lm-e" class="input" data-bind="modal.empId" data-rr>${opt('', 'Choose…', m.empId)}${emps.concat(m.empId && e && e.status === 'Left' ? [Object.assign({ id: m.empId }, e)] : []).map((x) => opt(x.id, x.fullName, m.empId)).join('')}</select></div>
      <div class="field"><label class="lbl" for="lm-t">Type</label><select id="lm-t" class="input" data-bind="modal.typeId" data-rr>${leaveTypes().map((x) => opt(x.id, x.name + (x.paid ? '' : ' (unpaid)'), m.typeId)).join('')}</select></div>
      <div class="row" style="gap:.8rem"><div class="field grow"><label class="lbl" for="lm-f">From</label><input id="lm-f" class="input" type="date" value="${esc(m.from)}" data-bind="modal.from" data-rr></div>
        <div class="field grow"><label class="lbl" for="lm-to">To</label><input id="lm-to" class="input" type="date" value="${esc(m.to)}" data-bind="modal.to" data-rr></div></div>
      ${m.from && m.from === m.to ? `<label class="check" style="margin-bottom:.8rem"><input type="checkbox" id="lm-h" data-bind="modal.half" ${m.half ? 'checked' : ''}> Half day</label>` : ''}
      <div class="note small" style="margin-bottom:.9rem"><b>${money2(days)} working day${days === 1 ? '' : 's'}</b>${e && ent > 0 ? ` · ${esc(t.name)} left in ${yr} after this: <b class="${ent - used - (m.status === 'Approved' ? days : 0) < 0 ? 'neg' : ''}">${money2(ent - used - (m.status === 'Approved' ? days : 0))}</b> of ${money2(ent)}` : ''}</div>
      ${clash ? `<div class="banner banner--bad small" style="margin-bottom:.8rem">Overlaps with ${esc(ltype(clash.typeId).name.toLowerCase())} already recorded (${fmtD(clash.from)} – ${fmtD(clash.to)}).</div>` : ''}
      <div class="field"><label class="lbl" for="lm-s">Status</label><select id="lm-s" class="input" data-bind="modal.status" data-rr>${LEAVE_ST.map((s) => opt(s, s === 'Pending' ? 'Waiting for approval' : s, m.status)).join('')}</select></div>
      <div class="field"><label class="lbl" for="lm-r">Reason or note</label><input id="lm-r" class="input" maxlength="300" value="${esc(m.reason)}" data-bind="modal.reason" placeholder="Optional"></div>
      ${m.err ? `<div class="err">${esc(m.err)}</div>` : ''}
    </div><div class="modal__foot">${m.id ? `<button type="button" class="btn btn--danger-ghost" data-act="hr-leave-del">Delete</button><span class="grow"></span>` : ''}<button type="button" class="btn btn--ghost" data-act="close-modal">Cancel</button><button class="btn btn--primary" type="submit" ${S.busy ? 'disabled' : ''}>Save</button></div></div></div></form>`;
  }
  async function saveLeave() {
    const m = S.modal, days = workingDays(m.from, m.to, m.half);
    m.err = !m.empId ? 'Choose the employee.' : !m.from || !m.to ? 'Enter both dates.' : m.to < m.from ? 'The end date is before the start date.' : days <= 0 ? 'Those dates have no working days.' : '';
    if (m.err) return render();
    const old = m.id ? H.leave[m.id] : null, at = now(), by = S.me.id;
    const doc = { empId: m.empId, typeId: m.typeId, from: m.from, to: m.to, half: !!(m.half && m.from === m.to), days, status: m.status, reason: (m.reason || '').trim(), updatedAt: at, updatedBy: by };
    if (!old || old.status !== m.status) { doc.decidedAt = m.status === 'Pending' ? null : at; doc.decidedBy = m.status === 'Pending' ? null : by; }
    S.busy = true; render();
    try {
      if (old) await S.db.collection('leave').doc(m.id).update(doc);
      else await S.db.collection('leave').add(Object.assign({ createdAt: at, createdBy: by }, doc));
      S.busy = false; S.modal = null; toast(`${ltype(doc.typeId).name} saved for ${empName(doc.empId)}: ${money2(days)} day${days === 1 ? '' : 's'}.`); render();
    } catch (e) { S.busy = false; m.err = dbMsg(e); render(); }
  }

  /* ---------- payroll ---------- */
  function priorFor(empId, month) {
    const ty = P.taxYearOf(month), e = H.emps[empId];
    const p = { emol: 0, paye: 0 };
    if (e && e.opening && e.opening.taxYear === ty) { p.emol += Number(e.opening.emol) || 0; p.paye += Number(e.opening.paye) || 0; }
    Object.values(H.runs).forEach((r) => { if (r.taxYear === ty && r.month < month && r.status === 'final' && r.slips && r.slips[empId] && r.slips[empId].calc) { p.emol += r.slips[empId].calc.taxable; p.paye += r.slips[empId].calc.paye; } });
    return p;
  }
  function slipFromEmp(e, month) {
    const first = month + '-01', last = monthEnd(month);
    const unpaid = leaveArr().filter((l) => l.empId === e.id && l.status === 'Approved' && !ltype(l.typeId).paid).reduce((t, l) => t + daysWithin(l, first, last), 0);
    return {
      name: e.fullName, empNo: e.empNo || '', nic: e.nic || '', department: e.department || '', jobTitle: e.jobTitle || '', bankName: e.bankName || '', bankAccount: e.bankAccount || '',
      earnings: [{ label: 'Basic salary', amount: Number(e.basic) || 0, kind: 'basic', taxable: true }].concat((e.allowances || []).map((a) => ({ label: a.label, amount: Number(a.amount) || 0, kind: 'allowance', taxable: a.taxable !== false }))),
      deductions: [], dependents: e.dependents || 0, otherReliefs: e.otherReliefs || 0,
      csg: e.csg !== false, nsf: e.nsf !== false, prgf: e.prgf !== false, levy: e.levy !== false, unpaidDays: unpaid,
      partial: (e.startDate > first || (e.endDate && e.endDate < last)) ? { from: e.startDate > first ? e.startDate : first, to: e.endDate && e.endDate < last ? e.endDate : last } : null,
    };
  }
  const inRun = (e, month) => e.startDate && e.startDate <= monthEnd(month) && !(e.endDate && e.endDate < month + '-01') && !(e.status === 'Left' && (!e.endDate || e.endDate < month + '-01'));
  function calcFor(slip, month) {
    const R = ratesFor(P.taxYearOf(month)); if (!R) return null;
    return P.calcSlip({ rates: R, month, earnings: slip.earnings.map((x) => ({ label: x.label, amount: num(x.amount), kind: x.kind, taxable: x.taxable !== false })),
      deductions: (slip.deductions || []).map((x) => ({ label: x.label, amount: num(x.amount) })), dependents: num(slip.dependents), otherReliefs: num(slip.otherReliefs),
      csg: slip.csg !== false, nsf: slip.nsf !== false, prgf: slip.prgf !== false, levy: slip.levy !== false, prior: priorFor(slip._id, month) });
  }
  function slipCalc(run, id) {
    const s = run.slips[id];
    if (run.status === 'final' && s.calc) return s.calc;
    return calcFor(Object.assign({ _id: id }, s), run.month);
  }
  function runTotals(month, src) {
    const run = src || H.runs[month], t = { staff: 0, gross: 0, net: 0, paye: 0, csgEe: 0, csgEr: 0, nsfEe: 0, nsfEr: 0, levy: 0, prgf: 0, otherDed: 0, employerCost: 0 };
    if (!run) return t;
    Object.keys(run.slips || {}).forEach((id) => { const c = slipCalc(run, id); if (!c) return; t.staff++; Object.keys(t).forEach((k) => { if (k !== 'staff') t[k] += c[k] || 0; }); });
    return t;
  }
  function payrollView() {
    const runs = Object.values(H.runs).sort((a, b) => b.month.localeCompare(a.month));
    const cur = today().slice(0, 7), ty = P.taxYearOf(cur), R = ratesFor(ty), nextTy = P.taxYearOf(addMonths(cur, 2));
    return `<div class="head"><div class="grow"><div class="eyebrow">Human resources</div><h1>Payroll</h1><p>Monthly pay runs with PAYE, CSG, NSF, training levy and PRGF worked out automatically.</p></div>
      <a class="btn btn--ghost" href="#hr-settings">Rates</a><button class="btn btn--primary" data-act="hr-run-new">${icon('plus')} New pay run</button></div>
    ${!R ? `<div class="banner banner--bad">There are no tax rates for ${esc(ty)} yet. Add them in <a href="#hr-settings">HR settings → Payroll rates</a> before running payroll.</div>`
      : !ratesFor(nextTy) ? `<div class="banner banner--info">Rates for the ${esc(nextTy)} tax year (from 1 July) aren't set yet. Add them in <a href="#hr-settings">HR settings</a> once the budget is out.</div>` : ''}
    <div class="banner banner--info small">Payroll uses the rates in HR settings (now: ${esc(ty)}). Have your accountant check the first pay run against your current payroll before you rely on it.</div>
    <div class="panel">${runs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Month</th><th>Status</th><th class="num">Staff</th><th class="num">Gross pay</th><th class="num">PAYE</th><th class="num">Net pay</th><th class="num">Cost to Zenitude</th></tr></thead><tbody>
      ${runs.map((r) => { const t = runTotals(r.month); return `<tr class="click" data-act="hr-open" data-href="payrun-${esc(r.month)}"><td><a class="ttl" href="#payrun-${esc(r.month)}">${esc(fmtM(r.month))}</a><div class="sub">Tax year ${esc(r.taxYear)}</div></td><td>${pillHR(r.status === 'final' ? 'Finalised' : 'Draft')}</td>
        <td class="num">${t.staff}</td><td class="num nowrap">${money(t.gross)}</td><td class="num nowrap">${money(t.paye)}</td><td class="num nowrap"><b>${money(t.net)}</b></td><td class="num nowrap">${money(t.employerCost)}</td></tr>`; }).join('')}
    </tbody></table></div>` : `<div class="empty">No pay runs yet. ${activeEmps().some((e) => e.basic) ? 'Click <b>New pay run</b> to prepare this month\'s payroll.' : 'First <a href="#staff">add staff</a> with their basic salary.'}</div>`}</div>`;
  }
  function copyRun(m) {
    const r = H.runs[m];
    if (!r) { H.run = { month: m, missing: true }; H.runSrc = ''; return; }
    H.run = JSON.parse(JSON.stringify(r)); H.run.month = m;
    Object.values(H.run.slips || {}).forEach((s) => { s.earnings.forEach((x) => { x.amount = String(x.amount); }); (s.deductions || []).forEach((x) => { x.amount = String(x.amount); }); s.dependents = String(s.dependents || 0); s.otherReliefs = String(s.otherReliefs || ''); });
    H.runSrc = JSON.stringify(H.run.slips);
  }
  const runDirty = () => !!H.run && !H.run.missing && H.run.status !== 'final' && JSON.stringify(H.run.slips) !== H.runSrc;
  function runView() {
    const run = H.run;
    if (!run || run.missing) return back('payroll', 'Payroll') + `<div class="panel empty">This pay run doesn't exist.</div>`;
    const final = run.status === 'final', R = ratesFor(run.taxYear), ids = Object.keys(run.slips || {}).sort((a, b) => run.slips[a].name.localeCompare(run.slips[b].name));
    const t = runTotals(run.month, run), dirty = runDirty();
    const earlierDraft = Object.values(H.runs).find((r) => r.taxYear === run.taxYear && r.month < run.month && r.status !== 'final');
    const laterFinal = Object.values(H.runs).find((r) => r.taxYear === run.taxYear && r.month > run.month && r.status === 'final');
    const missing = activeEmps().filter((e) => inRun(e, run.month) && !run.slips[e.id]);
    const kp = (k, v) => `<div class="panel kpi"><div class="kpi__k">${k}</div><div class="kpi__v" style="font-size:1.45rem">${v}</div></div>`;
    return back('payroll', 'Payroll') + `<div class="head"><div class="grow"><div class="eyebrow">Pay run · tax year ${esc(run.taxYear)}</div><h1>${esc(fmtM(run.month))}</h1><p>${final ? 'Finalised ' + (run.finalisedAt ? fmtD(isoD(new Date(run.finalisedAt))) + ' by ' + esc(name(run.finalisedBy)) : '') + '. Payslips are ready.' : 'Draft. Check each person, then finalise.'}</p></div>
      ${final ? `<button class="btn btn--ghost" data-act="hr-run-csv" data-k="bank">${icon('download')} Bank list</button><button class="btn btn--ghost" data-act="hr-run-csv" data-k="mra">${icon('download')} Contributions</button><button class="btn btn--ghost" data-act="hr-run-reopen">Reopen</button>`
        : `<button class="btn btn--danger-ghost" data-act="hr-run-del">Delete draft</button><button class="btn btn--ghost" data-act="hr-run-save" ${dirty && !S.busy ? '' : 'disabled'}>Save</button><button class="btn btn--primary" data-act="hr-run-final" ${S.busy || !R || earlierDraft || !ids.length ? 'disabled' : ''}>Finalise</button>`}</div>
    ${!R ? `<div class="banner banner--bad">No tax rates for ${esc(run.taxYear)}. Add them in <a href="#hr-settings">HR settings</a>.</div>` : ''}
    ${earlierDraft && !final ? `<div class="banner banner--bad">Finalise <a href="#payrun-${esc(earlierDraft.month)}">${esc(fmtM(earlierDraft.month))}</a> first: PAYE builds up month by month through the tax year.</div>` : ''}
    ${laterFinal && !final ? `<div class="banner banner--info">${esc(fmtM(laterFinal.month))} is already finalised. Changes here won't update its PAYE until you reopen and re-finalise it.</div>` : ''}
    ${dirty ? `<div class="banner banner--info">You have unsaved changes. <button class="btn btn--link" data-act="hr-run-save">Save now</button></div>` : ''}
    ${missing.length && !final ? `<div class="banner banner--info">${missing.length} current employee${missing.length === 1 ? ' isn\'t' : 's aren\'t'} in this pay run (${esc(missing.slice(0, 3).map((e) => e.fullName).join(', '))}${missing.length > 3 ? '…' : ''}). <button class="btn btn--link" data-act="hr-run-addmissing">Add ${missing.length === 1 ? 'them' : 'them all'}</button></div>` : ''}
    ${run.month.endsWith('-12') && !final ? `<div class="banner banner--info">December: the end-of-year bonus (1/12 of the year's earnings) is usually paid now. <button class="btn btn--link" data-act="hr-run-bonus">Add it for everyone</button></div>` : ''}
    <div class="kpis">${kp('Staff', t.staff)}${kp('Gross pay', money(t.gross))}${kp('PAYE', money(t.paye))}${kp('CSG + NSF', money(t.csgEe + t.csgEr + t.nsfEe + t.nsfEr))}${kp('Net pay', money(t.net))}${kp('Cost to Zenitude', money(t.employerCost))}</div>
    <div class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Employee</th><th class="num">Gross</th><th class="num">PAYE</th><th class="num">CSG</th><th class="num">NSF</th><th class="num">Other</th><th class="num">Net pay</th><th class="num hide-sm">Employer cost</th><th></th></tr></thead><tbody>
      ${ids.map((id) => { const s = run.slips[id], c = slipCalc(run, id); if (!c) return `<tr><td>${esc(s.name)}</td><td colspan="8" class="muted">No rates</td></tr>`;
        return `<tr class="click ${H.slipId === id ? 'sel' : ''}" data-act="hr-slip" data-id="${esc(id)}"><td><b>${esc(s.name)}</b><div class="sub">${esc([s.empNo, s.department].filter(Boolean).join(' · '))}${c.warnings.length ? ' · <span class="neg">check</span>' : ''}</div></td>
          <td class="num nowrap">${money(c.gross)}</td><td class="num nowrap">${money(c.paye)}</td><td class="num nowrap">${money(c.csgEe)}</td><td class="num nowrap">${money(c.nsfEe)}</td><td class="num nowrap">${c.otherDed ? money(c.otherDed) : '—'}</td>
          <td class="num nowrap"><b>${money(c.net)}</b></td><td class="num nowrap hide-sm">${money(c.employerCost)}</td>
          <td class="nowrap">${final ? `<a class="btn btn--ghost btn--sm" href="#payslip-${esc(run.month)}-${esc(id)}">Payslip</a>` : `<button class="btn btn--ghost btn--sm" data-act="hr-slip" data-id="${esc(id)}">${H.slipId === id ? 'Close' : 'Edit'}</button>`}</td></tr>
          ${H.slipId === id ? `<tr class="slip-row"><td colspan="9">${slipEditor(run, id, c, final)}</td></tr>` : ''}`; }).join('') || '<tr><td colspan="9" class="empty">Nobody in this pay run.</td></tr>'}
    </tbody></table></div></div>
    ${final ? `<div class="panel"><div class="panel__b small t2">To pay the MRA: PAYE ${money(t.paye)} · CSG ${money(t.csgEe + t.csgEr)} (employees ${money(t.csgEe)}, Zenitude ${money(t.csgEr)}) · NSF ${money(t.nsfEe + t.nsfEr)} · Training levy ${money(t.levy)} · PRGF ${money(t.prgf)}.</div></div>` : ''}`;
  }
  function slipEditor(run, id, c, final) {
    const s = run.slips[id], b = (k) => `hr.run.slips.${id}.${k}`, dis = final ? 'disabled' : '';
    return `<div class="slip">
      <div class="slip__cols"><div>
        <div class="lbl">Earnings</div>
        ${s.earnings.map((x, i) => `<div class="line line--4"><input id="se-l-${i}" class="input" maxlength="60" value="${esc(x.label)}" data-bind="${b('earnings.' + i + '.label')}" ${dis} aria-label="Description">
          <select id="se-k-${i}" class="input" data-bind="${b('earnings.' + i + '.kind')}" data-rr ${dis} aria-label="Type">${Object.entries(KINDS).map(([k, v]) => opt(k, v, x.kind)).join('')}</select>
          <input id="se-a-${i}" class="input num" inputmode="decimal" value="${esc(x.amount)}" data-bind="${b('earnings.' + i + '.amount')}" data-rr ${dis} aria-label="Amount">
          <label class="check"><input type="checkbox" id="se-t-${i}" data-bind="${b('earnings.' + i + '.taxable')}" ${x.taxable !== false ? 'checked' : ''} ${dis}> Taxable</label>
          ${final ? '' : `<button type="button" class="btn btn--danger-ghost btn--sm" data-act="hr-line-del" data-id="${esc(id)}" data-k="earnings" data-i="${i}" aria-label="Remove">×</button>`}</div>`).join('')}
        ${final ? '' : `<button type="button" class="btn btn--ghost btn--sm" data-act="hr-line-add" data-id="${esc(id)}" data-k="earnings">${icon('plus')} Add earning (overtime, bonus…)</button>`}
        <div class="lbl" style="margin-top:1rem">Other deductions</div>
        ${(s.deductions || []).map((x, i) => `<div class="line"><input id="sd-l-${i}" class="input" maxlength="60" value="${esc(x.label)}" data-bind="${b('deductions.' + i + '.label')}" ${dis} aria-label="Description">
          <input id="sd-a-${i}" class="input num" inputmode="decimal" value="${esc(x.amount)}" data-bind="${b('deductions.' + i + '.amount')}" data-rr ${dis} aria-label="Amount">
          ${final ? '' : `<button type="button" class="btn btn--danger-ghost btn--sm" data-act="hr-line-del" data-id="${esc(id)}" data-k="deductions" data-i="${i}" aria-label="Remove">×</button>`}</div>`).join('') || '<div class="small muted">None</div>'}
        ${final ? '' : `<button type="button" class="btn btn--ghost btn--sm" data-act="hr-line-add" data-id="${esc(id)}" data-k="deductions">${icon('plus')} Add deduction (advance, loan, absence…)</button>`}
        ${s.partial && !s.partial.done && !final ? (() => { const all = workingDays(run.month + '-01', monthEnd(run.month)), w = workingDays(s.partial.from, s.partial.to), bl = s.earnings.find((x) => x.kind === 'basic');
          return `<div class="note small" style="margin-top:.8rem">Employed ${fmtD(s.partial.from)} – ${fmtD(s.partial.to)}: ${w} of ${all} working days this month. ${bl ? `<button type="button" class="btn btn--link" data-act="hr-prorate" data-id="${esc(id)}">Pro-rate basic to ${money(num(bl.amount) * w / Math.max(1, all))}</button>` : ''}</div>`; })() : ''}
        ${s.unpaidDays && !final ? `<div class="note small" style="margin-top:.8rem">${money2(s.unpaidDays)} day${s.unpaidDays === 1 ? '' : 's'} of unpaid leave this month. <button type="button" class="btn btn--link" data-act="hr-unpaid" data-id="${esc(id)}">Deduct ${money(c.basic / Math.max(1, workingDays(run.month + '-01', monthEnd(run.month))) * s.unpaidDays)}</button> <span class="muted">(basic ÷ working days in the month × days)</span></div>` : ''}
        <div class="row wrap" style="gap:1rem;margin-top:1rem">
          <div class="field" style="width:170px"><label class="lbl" for="se-dep">Dependents</label><select id="se-dep" class="input" data-bind="${b('dependents')}" data-rr ${dis}>${[0, 1, 2, 3, 4].map((n) => opt(String(n), n === 0 ? 'None' : String(n), s.dependents)).join('')}</select></div>
          <div class="field" style="width:200px"><label class="lbl" for="se-rel">Other yearly reliefs (Rs)</label><input id="se-rel" class="input" inputmode="decimal" value="${esc(s.otherReliefs)}" data-bind="${b('otherReliefs')}" data-rr ${dis}></div>
          <div class="field"><label class="lbl">Contributions</label><div class="row wrap" style="gap:.8rem;padding-top:.4rem">${['csg', 'nsf', 'prgf', 'levy'].map((k) => `<label class="check"><input type="checkbox" id="se-${k}" data-bind="${b(k)}" ${s[k] !== false ? 'checked' : ''} ${dis}> ${k === 'levy' ? 'Levy' : k.toUpperCase()}</label>`).join('')}</div></div>
        </div>
        ${final ? '' : `<button type="button" class="btn btn--link small" data-act="hr-slip-reset" data-id="${esc(id)}">Reset from staff record</button> · <button type="button" class="btn btn--link small" data-act="hr-slip-remove" data-id="${esc(id)}">Remove from this pay run</button>`}
      </div>
      <div class="slip__calc">
        <div class="lbl">Worked out</div>
        <table class="mini"><tbody>
          <tr><td>Gross pay</td><td class="num">${money2(c.gross)}</td></tr>
          <tr><td>PAYE</td><td class="num">− ${money2(c.paye)}</td></tr>
          <tr><td>CSG (${c.csgRateEe}% of basic ${money(c.basic)})</td><td class="num">− ${money2(c.csgEe)}</td></tr>
          <tr><td>NSF (1% of ${money(c.nsfBase)})</td><td class="num">− ${money2(c.nsfEe)}</td></tr>
          ${c.otherDed ? `<tr><td>Other deductions</td><td class="num">− ${money2(c.otherDed)}</td></tr>` : ''}
          <tr class="tot"><td>Net pay</td><td class="num">${money2(c.net)}</td></tr>
        </tbody></table>
        <div class="lbl" style="margin-top:.9rem">Paid by Zenitude on top</div>
        <table class="mini"><tbody><tr><td>CSG (${c.csgRateEr}%)</td><td class="num">${money2(c.csgEr)}</td></tr><tr><td>NSF</td><td class="num">${money2(c.nsfEr)}</td></tr><tr><td>Training levy</td><td class="num">${money2(c.levy)}</td></tr><tr><td>PRGF</td><td class="num">${money2(c.prgf)}</td></tr><tr class="tot"><td>Total cost</td><td class="num">${money2(c.employerCost)}</td></tr></tbody></table>
        <details class="more"><summary>How PAYE was worked out</summary><div class="small t2" style="margin-top:.5rem;line-height:1.7">
          Month ${c.monthIndex} of the tax year · taxable pay so far ${money(c.cumEmol)}<br>− reliefs so far ${money(c.cumRelief)} (${money(c.annualRelief)} a year × ${c.monthIndex}/12)<br>= chargeable so far ${money(c.cumChargeable)} → tax so far ${money(c.cumTax)}<br>− PAYE already deducted ${money(c.cumPaye - c.paye)} = <b>${money(c.paye)}</b> this month</div></details>
        ${c.warnings.map((w) => `<div class="banner banner--bad small" style="margin-top:.7rem">${esc(w)}</div>`).join('')}
      </div></div></div>`;
  }
  function cleanSlip(s) {
    return Object.assign({}, s, {
      earnings: s.earnings.map((x) => ({ label: String(x.label || '').trim() || 'Earning', amount: num(x.amount), kind: KINDS[x.kind] ? x.kind : 'other', taxable: x.taxable !== false })),
      deductions: (s.deductions || []).map((x) => ({ label: String(x.label || '').trim() || 'Deduction', amount: num(x.amount) })),
      dependents: Math.min(4, Math.max(0, Math.round(num(s.dependents)))), otherReliefs: num(s.otherReliefs),
    });
  }
  async function saveRun(extra) {
    const run = H.run; if (!run || run.missing) return false;
    const slips = {}; Object.entries(run.slips).forEach(([id, s]) => { slips[id] = cleanSlip(s); delete slips[id].calc; });
    S.busy = true; render();
    try {
      await S.db.collection('payruns').doc(run.month).update(Object.assign({ slips, updatedAt: now(), updatedBy: S.me.id }, extra || {}));
      S.busy = false; H.runSrc = JSON.stringify(run.slips); render(); return true;
    } catch (e) { S.busy = false; fail(e); render(); return false; }
  }
  async function createRun(month) {
    const ty = P.taxYearOf(month);
    if (H.runs[month]) { S.modal = null; go('payrun-' + month); return; }
    const slips = {}; activeEmps().concat(empList().filter((e) => e.status === 'Left')).filter((e) => inRun(e, month)).forEach((e) => { slips[e.id] = slipFromEmp(e, month); });
    try {
      await S.db.collection('payruns').doc(month).set({ month, taxYear: ty, status: 'draft', slips, createdAt: now(), createdBy: S.me.id, updatedAt: now(), updatedBy: S.me.id, log: [{ at: now(), by: S.me.id, text: 'created the pay run' }] });
      S.modal = null; toast(`${fmtM(month)} pay run created with ${Object.keys(slips).length} ${Object.keys(slips).length === 1 ? 'person' : 'people'}.`); go('payrun-' + month);
    } catch (e) { if (S.modal) { S.modal.err = dbMsg(e); render(); } else fail(e); }
  }
  async function finaliseRun() {
    const run = H.run; if (!run) return;
    const slips = {};
    for (const [id, s] of Object.entries(run.slips)) {
      const cs = cleanSlip(s), c = calcFor(Object.assign({ _id: id }, cs), run.month);
      if (!c) { toast('No tax rates for ' + run.taxYear + '.', 'error'); return; }
      cs.calc = c; slips[id] = cs;
    }
    S.busy = true; render();
    try {
      await S.db.collection('payruns').doc(run.month).update({ slips, status: 'final', finalisedAt: now(), finalisedBy: S.me.id, updatedAt: now(), updatedBy: S.me.id, log: (H.runs[run.month].log || []).slice(-40).concat([{ at: now(), by: S.me.id, text: 'finalised the pay run' }]) });
      S.busy = false; H.slipId = null; toast(fmtM(run.month) + ' finalised. Payslips are ready.');
    } catch (e) { S.busy = false; fail(e); render(); }
  }
  function payslipView(month, id) {
    const run = H.runs[month], s = run && run.slips && run.slips[id];
    if (!s) return back('payroll', 'Payroll') + `<div class="panel empty">This payslip doesn't exist.</div>`;
    const c = slipCalc(run, id); if (!c) return back('payrun-' + month, fmtM(month)) + `<div class="panel empty">No tax rates for ${esc(run.taxYear)}.</div>`;
    const e = H.emps[id] || {};
    return back('payrun-' + month, fmtM(month)) + `<div class="row no-print" style="justify-content:flex-end;gap:.5rem;margin-bottom:.8rem">
      ${Object.keys(run.slips).length > 1 ? `<button class="btn btn--ghost btn--sm" data-act="hr-slip-step" data-m="${esc(month)}" data-id="${esc(id)}" data-v="-1">‹ Previous</button><button class="btn btn--ghost btn--sm" data-act="hr-slip-step" data-m="${esc(month)}" data-id="${esc(id)}" data-v="1">Next ›</button>` : ''}
      <button class="btn btn--primary btn--sm" data-act="hr-print">Print or save as PDF</button></div>
    <div class="payslip ${run.status === 'final' ? '' : 'payslip--draft'}">
      <div class="payslip__head"><img src="assets/img/emblem-gold.png" alt=""><div class="grow"><div class="payslip__co">ZENITUDE</div><div class="small muted">Payslip · ${esc(fmtM(month))}</div></div>${run.status === 'final' ? '' : '<span class="pill hr-draft"><i></i>Draft</span>'}</div>
      <div class="payslip__who">
        <div><span class="k">Employee</span><b>${esc(s.name)}</b></div><div><span class="k">Employee no.</span>${esc(s.empNo || '—')}</div>
        <div><span class="k">Job</span>${esc([s.jobTitle, s.department].filter(Boolean).join(', ') || '—')}</div><div><span class="k">NIC</span>${esc(s.nic || '—')}</div>
        <div><span class="k">Pay period</span>${fmtD(month + '-01')} – ${fmtD(monthEnd(month))}</div><div><span class="k">Paid to</span>${esc([s.bankName, s.bankAccount].filter(Boolean).join(' · ') || '—')}</div>
        ${e.startDate ? `<div><span class="k">Joined</span>${fmtD(e.startDate)}</div>` : ''}<div><span class="k">Tax year</span>${esc(run.taxYear)}</div>
      </div>
      <div class="payslip__cols">
        <table class="mini"><thead><tr><th>Earnings</th><th class="num">Rs</th></tr></thead><tbody>${s.earnings.map((x) => `<tr><td>${esc(x.label)}${x.taxable === false ? ' <span class="muted small">(not taxed)</span>' : ''}</td><td class="num">${money2(x.amount)}</td></tr>`).join('')}<tr class="tot"><td>Gross pay</td><td class="num">${money2(c.gross)}</td></tr></tbody></table>
        <table class="mini"><thead><tr><th>Deductions</th><th class="num">Rs</th></tr></thead><tbody>
          <tr><td>Income tax (PAYE)</td><td class="num">${money2(c.paye)}</td></tr><tr><td>CSG (${c.csgRateEe}%)</td><td class="num">${money2(c.csgEe)}</td></tr><tr><td>NSF</td><td class="num">${money2(c.nsfEe)}</td></tr>
          ${(s.deductions || []).map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${money2(x.amount)}</td></tr>`).join('')}
          <tr class="tot"><td>Total deductions</td><td class="num">${money2(c.totalDed)}</td></tr></tbody></table>
      </div>
      <div class="payslip__net"><span>Net pay</span><b>${money(c.net)}</b></div>
      <div class="payslip__foot">
        <div><span class="k">Paid by Zenitude on top of your salary</span>CSG ${money2(c.csgEr)} · NSF ${money2(c.nsfEr)} · Training levy ${money2(c.levy)} · PRGF ${money2(c.prgf)}</div>
        <div><span class="k">Tax year to date</span>Taxable pay ${money(c.cumEmol)} · PAYE ${money(c.cumPaye)}</div>
      </div>
    </div>`;
  }

  /* ---------- settings ---------- */
  function setFrom() {
    const m = main(), years = {};
    allYears().forEach((y) => { const r = ratesFor(y); years[y] = JSON.parse(JSON.stringify(r)); });
    const cur = P.taxYearOf(today().slice(0, 7));
    return {
      departments: m.departments.slice(), newDept: '', workDays: m.workDays.slice(), holidays: (m.holidays || []).map((h) => Object.assign({}, h)).sort((a, b) => a.date.localeCompare(b.date)), newHolDate: '', newHolName: '',
      leaveTypes: m.leaveTypes.map((t) => Object.assign({}, t, { days: String(t.days) })), onboardingText: m.onboarding.join('\n'), offboardingText: m.offboarding.join('\n'),
      years, ty: years[cur] ? cur : Object.keys(years).sort().pop(), err: '',
    };
  }
  function settingsView() {
    const d = H.set; if (!d) return '';
    const R = d.years[d.ty], b = (k) => `hr.set.years.${d.ty}.${k}`;
    const usedTypes = new Set(leaveArr().map((l) => l.typeId));
    return `<div class="head"><div class="grow"><div class="eyebrow">Human resources</div><h1>HR settings</h1><p>Only HR desk members can see or change these.</p></div></div>
    <form data-form="hr-set-save" class="desk-form">
      <div class="panel"><div class="panel__h"><h2>Departments</h2></div><div class="panel__b">
        <div class="chips">${d.departments.map((c, i) => `<span class="chip">${esc(c)}<button type="button" data-act="hr-dept-del" data-i="${i}" aria-label="Remove ${esc(c)}">×</button></span>`).join('')}</div>
        <div class="row" style="margin-top:.7rem;max-width:420px"><input id="hs-dept" class="input" maxlength="40" placeholder="Add a department" value="${esc(d.newDept)}" data-bind="hr.set.newDept"><button type="button" class="btn btn--ghost" data-act="hr-dept-add">Add</button></div>
      </div></div>
      <div class="panel"><div class="panel__h"><h2>Working days and public holidays</h2></div><div class="panel__b">
        <div class="row wrap" style="gap:1rem;margin-bottom:1rem">${[1, 2, 3, 4, 5, 6, 0].map((w) => `<label class="check"><input type="checkbox" id="hs-w${w}" data-chg="hr-wd" data-v="${w}" ${d.workDays.includes(w) ? 'checked' : ''}> ${WEEK[w]}</label>`).join('')}</div>
        <div class="hint" style="margin-bottom:.6rem">Leave only counts working days. Add Mauritius public holidays each year so they aren't counted.</div>
        ${d.holidays.map((h, i) => `<div class="hr-item"><span class="nowrap" style="width:120px">${fmtD(h.date)}</span><span class="grow">${esc(h.name)}</span><button type="button" class="btn btn--danger-ghost btn--sm" data-act="hr-hol-del" data-i="${i}">Remove</button></div>`).join('') || '<div class="small muted">No public holidays added yet.</div>'}
        <div class="row wrap" style="margin-top:.7rem;gap:.5rem;max-width:560px"><input id="hs-hd" class="input" type="date" style="width:170px" value="${esc(d.newHolDate)}" data-bind="hr.set.newHolDate" aria-label="Date"><input id="hs-hn" class="input grow" maxlength="60" placeholder="e.g. Independence Day" value="${esc(d.newHolName)}" data-bind="hr.set.newHolName" aria-label="Holiday name"><button type="button" class="btn btn--ghost" data-act="hr-hol-add">Add</button></div>
      </div></div>
      <div class="panel"><div class="panel__h"><h2>Leave types</h2><span class="small muted">default days per calendar year · 0 = no fixed allowance</span></div><div class="panel__b">
        ${d.leaveTypes.map((t, i) => `<div class="line"><input id="hs-lt-${i}" class="input" maxlength="40" value="${esc(t.name)}" data-bind="hr.set.leaveTypes.${i}.name" aria-label="Leave type name">
          <input id="hs-ld-${i}" class="input num" inputmode="decimal" value="${esc(t.days)}" data-bind="hr.set.leaveTypes.${i}.days" aria-label="Days per year">
          <label class="check"><input type="checkbox" id="hs-lp-${i}" data-bind="hr.set.leaveTypes.${i}.paid" ${t.paid ? 'checked' : ''}> Paid</label>
          <button type="button" class="btn btn--danger-ghost btn--sm" data-act="hr-lt-del" data-i="${i}" ${usedTypes.has(t.id) ? 'disabled title="Used by leave records"' : ''}>Remove</button></div>`).join('')}
        <button type="button" class="btn btn--ghost btn--sm" data-act="hr-lt-add">${icon('plus')} Add leave type</button>
        <div class="hint">Check the allowances against the Workers' Rights Act and your contracts. Unpaid leave shows up in payroll so you can deduct it.</div>
      </div></div>
      <div class="panel"><div class="panel__h"><h2>Checklists</h2><span class="small muted">one item per line</span></div><div class="panel__b"><div class="g2">
        <div class="field"><label class="lbl" for="hs-on">When someone joins</label><textarea id="hs-on" class="input" rows="8" data-bind="hr.set.onboardingText">${esc(d.onboardingText)}</textarea></div>
        <div class="field"><label class="lbl" for="hs-off">When someone leaves</label><textarea id="hs-off" class="input" rows="8" data-bind="hr.set.offboardingText">${esc(d.offboardingText)}</textarea></div>
      </div><div class="hint">Changes apply to new joiners and leavers. Existing checklists stay as they are.</div></div></div>
      <div class="panel"><div class="panel__h"><h2>Payroll rates</h2><span class="grow"></span>
        <select id="hs-ty" class="input" style="width:auto;height:34px" data-bind="hr.set.ty" data-rr aria-label="Tax year">${Object.keys(d.years).sort().map((y) => opt(y, 'Tax year ' + y, d.ty)).join('')}</select>
        <button type="button" class="btn btn--ghost btn--sm" data-act="hr-ty-add">${icon('plus')} Next tax year</button></div><div class="panel__b">
        <p class="small t2" style="margin-bottom:.9rem">1 July – 30 June. Update these when a budget changes the rates; each pay run uses the rates for its tax year. ${esc(R.note || '')}</p>
        <div class="lbl">Income tax bands (yearly chargeable income)</div>
        ${R.bands.map((x, i) => `<div class="line line--band"><span class="small t2">${i === 0 ? 'First' : 'Next, up to'}</span>${x.upTo == null ? '<span class="small t2">Everything above</span>' : `<input id="hs-bu-${i}" class="input num" inputmode="decimal" value="${esc(x.upTo)}" data-bind="${b('bands.' + i + '.upTo')}" aria-label="Up to Rs">`}
          <input id="hs-br-${i}" class="input num" inputmode="decimal" value="${esc(x.rate)}" data-bind="${b('bands.' + i + '.rate')}" aria-label="Rate %"><span class="small t2">%</span></div>`).join('')}
        <div class="lbl" style="margin-top:1rem">Deduction for dependents (Rs a year)</div>
        <div class="row wrap" style="gap:.6rem">${[1, 2, 3, 4].map((n) => `<div class="field" style="width:140px"><label class="lbl" for="hs-dp-${n}">${n}${n === 4 ? '+' : ''} dependent${n > 1 ? 's' : ''}</label><input id="hs-dp-${n}" class="input num" inputmode="decimal" value="${esc(R.dependents[n])}" data-bind="${b('dependents.' + n)}"></div>`).join('')}</div>
        <div class="g3" style="margin-top:.6rem">
          <div><div class="lbl">CSG</div>
            ${fieldI('hs-ct', 'Higher rate when basic is above (Rs)', b('csg.threshold'), R.csg.threshold, 'inputmode="decimal"')}
            <div class="row" style="gap:.5rem">${fieldI('hs-cel', 'Employee %', b('csg.eeLow'), R.csg.eeLow, 'inputmode="decimal"')}${fieldI('hs-ceh', 'above', b('csg.eeHigh'), R.csg.eeHigh, 'inputmode="decimal"')}</div>
            <div class="row" style="gap:.5rem">${fieldI('hs-crl', 'Employer %', b('csg.erLow'), R.csg.erLow, 'inputmode="decimal"')}${fieldI('hs-crh', 'above', b('csg.erHigh'), R.csg.erHigh, 'inputmode="decimal"')}</div></div>
          <div><div class="lbl">NSF</div>
            ${fieldI('hs-ne', 'Employee %', b('nsf.ee'), R.nsf.ee, 'inputmode="decimal"')}${fieldI('hs-nr', 'Employer %', b('nsf.er'), R.nsf.er, 'inputmode="decimal"')}${fieldI('hs-nc', 'Ceiling on basic (Rs a month)', b('nsf.ceiling'), R.nsf.ceiling, 'inputmode="decimal"')}</div>
          <div><div class="lbl">Employer only</div>
            ${fieldI('hs-lv', 'Training levy %', b('levy'), R.levy, 'inputmode="decimal"')}${fieldI('hs-pg', 'PRGF %', b('prgf'), R.prgf, 'inputmode="decimal"')}${fieldI('hs-mw', 'Minimum wage (Rs a month)', b('minWage'), R.minWage, 'inputmode="decimal"', 'Only used for a warning.')}</div>
        </div>
      </div></div>
      ${d.err ? `<div class="banner banner--bad">${esc(d.err)}</div>` : ''}
      <div class="row" style="justify-content:flex-end;gap:.6rem"><a class="btn btn--ghost" href="#hr">Cancel</a><button class="btn btn--primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Saving…' : 'Save settings'}</button></div>
    </form>`;
  }
  async function saveSettings() {
    const d = H.set; if (!d) return;
    const lines = (t) => [...new Set(String(t || '').split('\n').map((x) => x.trim()).filter(Boolean))].slice(0, 40);
    const leave = d.leaveTypes.map((t) => ({ id: t.id, name: String(t.name || '').trim(), days: num(t.days), paid: !!t.paid }));
    const years = {};
    for (const [y, r] of Object.entries(d.years)) {
      const bands = r.bands.map((x) => ({ upTo: x.upTo == null || x.upTo === '' ? null : num(x.upTo), rate: num(x.rate) }));
      years[y] = { bands, dependents: [0, 1, 2, 3, 4].map((n) => (n ? num(r.dependents[n]) : 0)),
        csg: { threshold: num(r.csg.threshold), eeLow: num(r.csg.eeLow), eeHigh: num(r.csg.eeHigh), erLow: num(r.csg.erLow), erHigh: num(r.csg.erHigh) },
        nsf: { ee: num(r.nsf.ee), er: num(r.nsf.er), ceiling: num(r.nsf.ceiling) }, levy: num(r.levy), prgf: num(r.prgf), minWage: num(r.minWage), note: String(r.note || '').slice(0, 300) };
      if (bands.some((x, i) => i < bands.length - 1 && (x.upTo == null || (i && x.upTo <= bands[i - 1].upTo)))) { d.err = `Tax year ${y}: each band's upper limit must be higher than the one before.`; return render(); }
    }
    d.err = !d.departments.length ? 'Keep at least one department.' : !d.workDays.length ? 'Choose at least one working day.' : leave.some((t) => !t.name) ? 'Every leave type needs a name.' : '';
    if (d.err) return render();
    S.busy = true; render();
    try {
      const at = now(), by = S.me.id, batch = S.db.batch();
      batch.set(S.db.doc('hrSettings/main'), { departments: d.departments, workDays: d.workDays.slice().sort(), holidays: d.holidays, leaveTypes: leave, onboarding: lines(d.onboardingText), offboarding: lines(d.offboardingText), updatedAt: at, updatedBy: by });
      batch.set(S.db.doc('hrSettings/payroll'), { years, updatedAt: at, updatedBy: by });
      await batch.commit();
      S.busy = false; H.set = null; toast('HR settings saved.'); go('hr');
    } catch (e) { S.busy = false; d.err = dbMsg(e); render(); }
  }

  /* ---------- modals ---------- */
  function modal(m) {
    const wrap = (title, body, foot, form) => `${form ? `<form data-form="${form}">` : ''}<div class="modal" data-act="overlay"><div class="modal__box" role="dialog" aria-modal="true"><div class="modal__head"><h3>${title}</h3></div><div class="modal__body">${body}</div><div class="modal__foot">${foot}</div></div></div>${form ? '</form>' : ''}`;
    const cancel = '<button type="button" class="btn btn--ghost" data-act="close-modal">Cancel</button>';
    if (m.type === 'hr-leave') return leaveModal(m);
    if (m.type === 'hr-newrun') return wrap('New pay run', `<div class="field"><label class="lbl" for="nr-m">Month</label><input id="nr-m" class="input" type="month" value="${esc(m.month)}" data-bind="modal.month"></div>
      <p class="small t2">Everyone employed during the month is added with their basic salary and allowances from their staff record. You can adjust each person before finalising.</p>${m.err ? `<div class="err">${esc(m.err)}</div>` : ''}`,
      cancel + `<button class="btn btn--primary" type="submit">Create</button>`, 'hr-run-create');
    if (m.type === 'hr-offboard') { const e = emp(m.id); return wrap(`${esc(e ? e.fullName : '')} is leaving`, `<div class="field"><label class="lbl" for="ob-d">Last working day</label><input id="ob-d" class="input" type="date" value="${esc(m.date)}" data-bind="modal.date"></div>
      <div class="field"><label class="lbl" for="ob-r">Reason</label><select id="ob-r" class="input" data-bind="modal.reason">${['Resignation', 'End of contract', 'Termination', 'Retirement', 'Other'].map((x) => opt(x, x, m.reason)).join('')}</select></div>
      <p class="small t2">A leaving checklist is created from your HR settings. They stay in payroll until their last month.</p>${m.err ? `<div class="err">${esc(m.err)}</div>` : ''}`, cancel + `<button class="btn btn--primary" type="submit">Start</button>`, 'hr-offboard'); }
    if (m.type === 'hr-confirm') return wrap(esc(m.title), `<p class="t2">${esc(m.text)}</p>`, cancel + `<button class="btn ${m.danger ? 'btn--danger' : 'btn--primary'}" data-act="hr-confirm-yes">${esc(m.yes)}</button>`);
    if (m.type === 'hr-doc') {
      const pdf = /pdf/.test(m.kind || '');
      return `<div class="modal" data-act="overlay"><div class="modal__box modal__box--wide" role="dialog" aria-modal="true">
        <div class="modal__head row"><h3 class="grow" style="font-size:1.2rem;overflow-wrap:anywhere">${esc(m.name)}</h3><button type="button" class="btn btn--ghost btn--sm" data-act="close-modal">Close</button></div>
        <div class="modal__body viewer">${m.err ? `<div class="err">${esc(m.err)}</div>` : m.url ? (pdf ? `<iframe src="${esc(m.url)}" title="${esc(m.name)}" style="width:100%;height:70vh;border:0"></iframe>` : `<img src="${esc(m.url)}" alt="${esc(m.name)}">`) : '<div class="muted">Loading…</div>'}</div>
        <div class="modal__foot">${m.confirm ? `<span class="small t2 grow">Delete this document?</span><button class="btn btn--ghost btn--sm" data-act="hr-doc-keep">Keep</button><button class="btn btn--danger btn--sm" data-act="hr-doc-del">Delete</button>` : `<button class="btn btn--danger-ghost btn--sm" data-act="hr-doc-ask">Delete</button><span class="grow"></span>${m.url ? `<a class="btn btn--ghost btn--sm" href="${esc(m.url)}" target="_blank" rel="noopener">Open in new tab</a><a class="btn btn--primary btn--sm" href="${esc(m.url)}" download="${esc(m.name)}">Download</a>` : ''}`}</div></div></div>`;
    }
    return '';
  }
  function confirm(title, text, yes, fn, danger) { S.modal = { type: 'hr-confirm', title, text, yes, danger, fn }; render(); }

  /* ---------- events ---------- */
  const actions = {
    'hr-open'(el, e) { if (e.target.closest('a,button')) return; go(el.dataset.href); },
    'hr-al-add'() { H.ed.allowances.push({ label: '', amount: '', taxable: true }); H.ed.touched = true; render(); const i = document.getElementById('he-al-' + (H.ed.allowances.length - 1)); if (i) i.focus(); },
    'hr-al-del'(el) { H.ed.allowances.splice(+el.dataset.i, 1); H.ed.touched = true; render(); },
    'hr-offboard'(el) { S.modal = { type: 'hr-offboard', id: el.dataset.id, date: addDays(today(), 30), reason: 'Resignation', err: '' }; render(); },
    'hr-mark-left'(el) { const e = emp(el.dataset.id); confirm(`Mark ${e.fullName} as left?`, 'They move to former staff and are no longer added to new pay runs after their last day. Their record, leave and payslips are kept.', 'Mark as left', async () => {
      try { await S.db.collection('employees').doc(el.dataset.id).update({ status: 'Left', endDate: e.endDate || today(), log: (e.log || []).slice(-80).concat([{ at: now(), by: S.me.id, text: 'marked as left' }]) }); toast(e.fullName + ' is now in former staff.'); } catch (x) { fail(x); } }); },
    'hr-rehire'(el) { const e = emp(el.dataset.id); confirm(`Make ${e.fullName} current staff again?`, 'Their last day is cleared and they appear in current staff and pay runs again.', 'Make current', async () => {
      try { await S.db.collection('employees').doc(el.dataset.id).update({ status: 'Active', endDate: '', log: (e.log || []).slice(-80).concat([{ at: now(), by: S.me.id, text: 'made current staff again' }]) }); toast(e.fullName + ' is current staff again.'); } catch (x) { fail(x); } }); },
    'hr-it'(el) { const e = emp(el.dataset.id), join = el.dataset.k === 'join'; confirm(join ? 'Ask IT to set up accounts?' : 'Ask IT to remove access?', `A ticket for ${e.fullName} is sent to the ${A.deskName(itDeskId())} desk. You'll be the requester, so you can follow it.`, 'Send to IT', () => raiseIt(el.dataset.id, el.dataset.k)); },
    'hr-confirm-yes'() { const fn = S.modal && S.modal.fn; S.modal = null; render(); if (fn) fn(); },
    'hr-doc-open'(el) { openDoc(el.dataset.emp, el.dataset.id); },
    'hr-doc-ask'() { S.modal.confirm = true; render(); },
    'hr-doc-keep'() { S.modal.confirm = false; render(); },
    async 'hr-doc-del'() { const { empId, did } = S.modal; try { const r = S.db.collection('employees').doc(empId).collection('docs').doc(did), b = S.db.batch(); b.delete(r.collection('content').doc('full')); b.delete(r); await b.commit(); A.closeModal(); toast('Document deleted.'); } catch (e) { fail(e); } },
    'hr-staff-csv'() {
      const rows = [['Employee no.', 'Name', 'Job title', 'Department', 'Contract', 'Start date', 'Probation ends', 'Last day', 'Status', 'Email', 'Phone', 'NIC', 'Basic salary', 'Allowances']];
      empList().forEach((e) => rows.push([e.empNo, e.fullName, e.jobTitle, e.department, e.contractType, e.startDate, e.probationEnd, e.endDate, e.status, e.email, e.phone, e.nic, e.basic, (e.allowances || []).map((a) => a.label + ' ' + a.amount).join('; ')]));
      csv(rows, `zenitude-staff-${today()}.csv`); toast('Exported ' + (rows.length - 1) + ' staff records.');
    },
    'hr-leave-new'(el) { S.modal = leaveModalFrom(null, el.dataset.emp || ''); render(); },
    'hr-leave-edit'(el) { S.modal = leaveModalFrom(Object.assign({ id: el.dataset.id }, H.leave[el.dataset.id])); render(); },
    async 'hr-leave-set'(el) { const l = H.leave[el.dataset.id], v = el.dataset.v; try { await S.db.collection('leave').doc(el.dataset.id).update({ status: v, decidedAt: now(), decidedBy: S.me.id, updatedAt: now(), updatedBy: S.me.id }); toast(`${empName(l.empId)}'s leave ${v.toLowerCase()}.`); } catch (e) { fail(e); } },
    'hr-leave-del'() { const id = S.modal.id, l = H.leave[id]; confirm('Delete this leave record?', `${ltype(l.typeId).name} for ${empName(l.empId)}, ${fmtD(l.from)} – ${fmtD(l.to)}. To keep a record, set it to Cancelled instead.`, 'Delete', async () => { try { await S.db.collection('leave').doc(id).delete(); toast('Leave record deleted.'); } catch (e) { fail(e); } }, true); },
    'hr-lv-tab'(el) { H.lv.tab = el.dataset.v; render(); },
    'hr-cal'(el) { H.lv.month = addMonths(H.lv.month, Number(el.dataset.v)); render(); },
    'hr-bal-csv'() {
      const y = H.lv.year, types = leaveTypes(), rows = [['Employee'].concat(types.flatMap((t) => [t.name + ' allowance', t.name + ' taken', t.name + ' left']))];
      activeEmps().forEach((e) => rows.push([e.fullName].concat(types.flatMap((t) => { const u = usedDays(e.id, t.id, y), ent = entitlement(e, t); return [ent || '', u, ent ? ent - u : '']; }))));
      csv(rows, `zenitude-leave-balances-${y}.csv`);
    },
    'hr-run-new'() {
      const months = Object.keys(H.runs).sort(), m = months.length ? addMonths(months[months.length - 1], 1) : today().slice(0, 7);
      S.modal = { type: 'hr-newrun', month: m, err: '' }; render();
    },
    'hr-slip'(el, e) { if (e.target.closest('input,select,label,a,.slip')) return; H.slipId = H.slipId === el.dataset.id ? null : el.dataset.id; render(); },
    'hr-line-add'(el) { const s = H.run.slips[el.dataset.id]; if (el.dataset.k === 'earnings') s.earnings.push({ label: '', amount: '', kind: 'overtime', taxable: true }); else (s.deductions = s.deductions || []).push({ label: '', amount: '' }); render(); },
    'hr-line-del'(el) { const s = H.run.slips[el.dataset.id]; s[el.dataset.k].splice(+el.dataset.i, 1); render(); },
    'hr-unpaid'(el) { const run = H.run, s = run.slips[el.dataset.id], c = calcFor(Object.assign({ _id: el.dataset.id }, s), run.month);
      (s.deductions = s.deductions || []).push({ label: `Unpaid leave (${money2(s.unpaidDays)} day${s.unpaidDays === 1 ? '' : 's'})`, amount: String(Math.round(c.basic / Math.max(1, workingDays(run.month + '-01', monthEnd(run.month))) * s.unpaidDays)) }); s.unpaidDays = 0; render(); },
    'hr-prorate'(el) {
      const run = H.run, s = run.slips[el.dataset.id], p = s.partial, all = workingDays(run.month + '-01', monthEnd(run.month)), w = workingDays(p.from, p.to);
      s.earnings.filter((x) => x.kind === 'basic').forEach((x) => { x.amount = String(Math.round(num(x.amount) * w / Math.max(1, all))); x.label = x.label + ` (${w}/${all} days)`; });
      p.done = true; render();
    },
    'hr-slip-reset'(el) { const e = H.emps[el.dataset.id]; if (!e) { toast('This person\'s staff record no longer exists.', 'error'); return; } H.run.slips[el.dataset.id] = slipFromEmp(Object.assign({ id: el.dataset.id }, e), H.run.month); copyStrings(H.run.slips[el.dataset.id]); render(); },
    'hr-slip-remove'(el) { delete H.run.slips[el.dataset.id]; H.slipId = null; render(); },
    'hr-run-addmissing'() { activeEmps().filter((e) => inRun(e, H.run.month) && !H.run.slips[e.id]).forEach((e) => { H.run.slips[e.id] = slipFromEmp(e, H.run.month); copyStrings(H.run.slips[e.id]); }); render(); },
    'hr-run-bonus'() {
      const run = H.run, y = run.month.slice(0, 4); let n = 0;
      Object.entries(run.slips).forEach(([id, s]) => {
        if (s.earnings.some((x) => x.kind === 'bonus' && /end.of.year|13th/i.test(x.label))) return;
        let earned = 0;
        Object.values(H.runs).forEach((r) => { if (r.month.slice(0, 4) === y && r.month < run.month && r.status === 'final' && r.slips[id]) earned += r.slips[id].earnings.filter((x) => x.kind !== 'bonus').reduce((t, x) => t + (Number(x.amount) || 0), 0); });
        earned += s.earnings.filter((x) => x.kind !== 'bonus').reduce((t, x) => t + num(x.amount), 0);
        s.earnings.push({ label: 'End-of-year bonus', amount: String(P.yearEndBonus(earned)), kind: 'bonus', taxable: true }); n++;
      });
      toast(n ? `End-of-year bonus added for ${n} ${n === 1 ? 'person' : 'people'}: 1/12 of this year's pay in Zenitude Desk. Check anyone who joined during the year.` : 'Everyone already has an end-of-year bonus line.'); render();
    },
    async 'hr-run-save'() { if (await saveRun()) toast('Pay run saved.'); },
    'hr-run-final'() { const run = H.run; confirm(`Finalise ${fmtM(run.month)}?`, 'Pay is locked and payslips become available. PAYE for later months builds on these figures. You can reopen it if something needs fixing.', 'Finalise', async () => { if (runDirty() && !(await saveRun())) return; finaliseRun(); }); },
    'hr-run-reopen'() { const run = H.run; confirm(`Reopen ${fmtM(run.month)}?`, 'It goes back to draft so you can change it. Finalise it again afterwards, and re-check any later months.', 'Reopen', async () => {
      try { await S.db.collection('payruns').doc(run.month).update({ status: 'draft', updatedAt: now(), updatedBy: S.me.id, log: (H.runs[run.month].log || []).slice(-40).concat([{ at: now(), by: S.me.id, text: 'reopened the pay run' }]) }); toast('Pay run reopened.'); } catch (e) { fail(e); } }); },
    'hr-run-del'() { const run = H.run; confirm(`Delete the ${fmtM(run.month)} draft?`, 'All changes in this draft are lost. Staff records are not affected.', 'Delete draft', async () => { try { await S.db.collection('payruns').doc(run.month).delete(); toast('Draft deleted.'); go('payroll'); } catch (e) { fail(e); } }, true); },
    'hr-run-csv'(el) {
      const run = H.runs[H.run.month], ids = Object.keys(run.slips).sort((a, b) => run.slips[a].name.localeCompare(run.slips[b].name));
      let rows;
      if (el.dataset.k === 'bank') { rows = [['Employee no.', 'Name', 'Bank', 'Account number', 'Net pay']]; ids.forEach((id) => { const s = run.slips[id], c = slipCalc(run, id); rows.push([s.empNo, s.name, s.bankName, s.bankAccount, c.net.toFixed(2)]); }); }
      else { rows = [['Employee no.', 'Name', 'NIC', 'Basic', 'Gross', 'Taxable', 'PAYE', 'CSG employee', 'CSG employer', 'NSF employee', 'NSF employer', 'Training levy', 'PRGF', 'Net pay']];
        ids.forEach((id) => { const s = run.slips[id], c = slipCalc(run, id); rows.push([s.empNo, s.name, s.nic, c.basic, c.gross, c.taxable, c.paye, c.csgEe, c.csgEr, c.nsfEe, c.nsfEr, c.levy, c.prgf, c.net]); }); }
      csv(rows, `zenitude-payroll-${run.month}-${el.dataset.k === 'bank' ? 'bank' : 'contributions'}.csv`);
    },
    'hr-slip-step'(el) { const run = H.runs[el.dataset.m], ids = Object.keys(run.slips).sort((a, b) => run.slips[a].name.localeCompare(run.slips[b].name)); const i = ids.indexOf(el.dataset.id); go(`payslip-${el.dataset.m}-${ids[(i + Number(el.dataset.v) + ids.length) % ids.length]}`); },
    'hr-print'() { window.print(); },
    'hr-dept-add'() { const d = H.set, v = (d.newDept || '').trim(); if (v && !d.departments.includes(v)) d.departments.push(v); d.newDept = ''; render(); },
    'hr-dept-del'(el) { H.set.departments.splice(+el.dataset.i, 1); render(); },
    'hr-hol-add'() { const d = H.set; if (!d.newHolDate || !d.newHolName.trim()) { toast('Enter the date and the name of the holiday.', 'error'); return; } d.holidays = d.holidays.filter((h) => h.date !== d.newHolDate).concat([{ date: d.newHolDate, name: d.newHolName.trim() }]).sort((a, b) => a.date.localeCompare(b.date)); d.newHolDate = ''; d.newHolName = ''; render(); },
    'hr-hol-del'(el) { H.set.holidays.splice(+el.dataset.i, 1); render(); },
    'hr-lt-add'() { H.set.leaveTypes.push({ id: 'lt' + uid(), name: '', days: '0', paid: true }); render(); },
    'hr-lt-del'(el) { H.set.leaveTypes.splice(+el.dataset.i, 1); render(); },
    'hr-ty-add'() {
      const d = H.set, ys = Object.keys(d.years).sort(), last = ys[ys.length - 1], start = Number(last.slice(0, 4)) + 1, ny = start + '-' + String((start + 1) % 100).padStart(2, '0');
      d.years[ny] = JSON.parse(JSON.stringify(d.years[last])); d.years[ny].note = `Copied from ${last}. Update these with the new budget's rates before running July payroll.`; d.ty = ny; render();
    },
  };
  function copyStrings(s) { s.earnings.forEach((x) => { x.amount = String(x.amount); }); s.dependents = String(s.dependents || 0); s.otherReliefs = String(s.otherReliefs || ''); }
  const changes = {
    async 'hr-check'(el) {
      const id = el.dataset.id, k = el.dataset.k, i = +el.dataset.i, e = H.emps[id]; if (!e) return;
      const list = (e[k] || []).map((x) => Object.assign({}, x));
      list[i] = Object.assign(list[i], el.checked ? { done: true, by: S.me.id, at: now() } : { done: false, by: null, at: null });
      try { await S.db.collection('employees').doc(id).update({ [k]: list }); } catch (x) { fail(x); render(); }
    },
    'hr-wd'(el) { const w = Number(el.dataset.v), a = H.set.workDays; if (el.checked) { if (!a.includes(w)) a.push(w); } else a.splice(a.indexOf(w), 1); render(); },
  };
  const forms = {
    'hr-emp-save'() { if (!S.busy) saveEmp(); },
    'hr-leave-save'() { if (!S.busy) saveLeave(); },
    'hr-run-create'() { const m = S.modal; if (!/^\d{4}-\d{2}$/.test(m.month || '')) { m.err = 'Choose a month.'; return render(); } if (!ratesFor(P.taxYearOf(m.month))) { m.err = `There are no tax rates for ${P.taxYearOf(m.month)}. Add them in HR settings first.`; return render(); } createRun(m.month); },
    async 'hr-offboard'() {
      const m = S.modal, e = H.emps[m.id]; if (!m.date) { m.err = 'Enter the last working day.'; return render(); }
      if (e.startDate && m.date < e.startDate) { m.err = 'The last day is before their start date.'; return render(); }
      try {
        await S.db.collection('employees').doc(m.id).update({ endDate: m.date, leaveReason: m.reason, offboarding: main().offboarding.map((t) => ({ t, done: false })), log: (e.log || []).slice(-80).concat([{ at: now(), by: S.me.id, text: `started the leaving process (${m.reason.toLowerCase()}, last day ${fmtD(m.date)})` }]) });
        S.modal = null; toast('Leaving checklist created for ' + e.fullName + '.'); render();
      } catch (x) { m.err = dbMsg(x); render(); }
    },
    'hr-set-save'() { if (!S.busy) saveSettings(); },
  };
  // Mark the employee form as edited so live updates don't overwrite it.
  document.addEventListener('input', (e) => { const b = e.target && e.target.dataset && e.target.dataset.bind; if (b && b.startsWith('hr.ed.') && H.ed) H.ed.touched = true; }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target) return;
    if (e.target.id === 'hs-dept') { e.preventDefault(); actions['hr-dept-add'](); }
    if (e.target.id === 'hs-hn') { e.preventDefault(); actions['hr-hol-add'](); }
  });

  return { isHR, sync, stop, owns, view, prepare, links, navOn, modal, actions, changes, forms, uploadDocs };
};
