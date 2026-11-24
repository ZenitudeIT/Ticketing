/* Zenitude Desk — Mauritius payroll calculator (pure functions, no Firebase).
 *
 * Works out, for one employee and one month:
 *   PAYE (cumulative method used by the MRA), CSG, NSF, HRDC training levy and PRGF.
 *
 * Rates live in the HR settings per tax year (1 July – 30 June) and can be edited
 * on the website when a budget changes them. DEFAULT_RATES below are the 2026-27
 * figures (Finance Act 2026; MRA NSF limits from 1 July 2026).
 * Bases (Mauritius):
 *   CSG, NSF, training levy: basic wage (excludes overtime, bonus and allowances). CSG on the
 *     end-of-year bonus is worked out separately on the bonus, with its own Rs 50,000 test.
 *   PRGF: basic wage + productivity/attendance bonus + payment for extra work (overtime);
 *     not payable when basic is above Rs 200,000.
 *   NSF is rounded down to the rupee.
 * Earning kinds: basic, allowance, overtime, bonus (productivity/attendance), eoy (end-of-year bonus), other.
 */
(function (root) {
  'use strict';

  const DEFAULT_RATES = {
    '2026-27': {
      // Annual chargeable income bands (Rs). The last band has no upper limit.
      bands: [{ upTo: 500000, rate: 0 }, { upTo: 1000000, rate: 10 }, { upTo: 12000000, rate: 20 }, { upTo: null, rate: 35 }],
      // Deduction for dependents (EDF), by number of dependents 0–4.
      dependents: [0, 110000, 190000, 275000, 355000],
      // CSG on monthly basic: lower rates up to the threshold, higher rates on the whole basic above it.
      csg: { threshold: 50000, eeLow: 1.5, eeHigh: 3, erLow: 3, erHigh: 6 },
      // NSF on monthly basic, capped at the ceiling.
      nsf: { ee: 1, er: 2.5, ceiling: 29710 },
      levy: 1.5,      // HRDC training levy, employer, % of basic
      prgf: 4.5,      // Portable Retirement Gratuity Fund, employer, % of monthly remuneration
      prgfMaxBasic: 200000, // no PRGF for a worker whose basic is above this
      minWage: 17745, // national minimum wage per month (warning only)
      note: 'Finance Act 2026 bands; MRA NSF limits from 1 July 2026.',
    },
  };

  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const rs = (n) => Math.round(Number(n) || 0);

  // '2026-11' -> '2026-27'; '2027-03' -> '2026-27'
  function taxYearOf(month) {
    const [y, m] = String(month).split('-').map(Number);
    const start = m >= 7 ? y : y - 1;
    return start + '-' + String((start + 1) % 100).padStart(2, '0');
  }
  // Month number inside the tax year: July = 1 … June = 12
  function monthIndex(month) { const m = Number(String(month).split('-')[1]); return m >= 7 ? m - 6 : m + 6; }
  function taxYearMonths(ty) {
    const y = Number(String(ty).slice(0, 4)), out = [];
    for (let i = 0; i < 12; i++) { const mm = ((6 + i) % 12) + 1, yy = mm >= 7 ? y : y + 1; out.push(yy + '-' + String(mm).padStart(2, '0')); }
    return out;
  }

  // Tax on a chargeable income using bands scaled by `fraction` of the year (cumulative method).
  function bandTax(income, bands, fraction) {
    let tax = 0, lower = 0;
    for (const b of bands) {
      const upper = b.upTo == null ? Infinity : b.upTo * fraction;
      if (income > lower) tax += (Math.min(income, upper) - lower) * (Number(b.rate) || 0) / 100;
      lower = upper;
      if (income <= upper) break;
    }
    return tax;
  }
  function annualTax(income, rates) { return bandTax(Math.max(0, income), rates.bands, 1); }

  /**
   * calcSlip(input) -> result
   * input = {
   *   rates,                 // one tax year's rates (see DEFAULT_RATES)
   *   month: 'YYYY-MM',
   *   earnings: [{ label, amount, kind: 'basic'|'allowance'|'overtime'|'bonus'|'other', taxable: true }],
   *   deductions: [{ label, amount }],   // other deductions (advance, loan, absence…)
   *   dependents: 0..4, otherReliefs: annual Rs (other EDF reliefs),
   *   csg: true, nsf: true, prgf: true, levy: true,  // whether each applies to this employee
   *   prior: { emol, paye }  // taxable pay and PAYE already counted this tax year, before this month
   * }
   */
  function calcSlip(input) {
    const R = input.rates || DEFAULT_RATES['2026-27'];
    const earnings = (input.earnings || []).map((e) => ({ label: e.label, amount: r2(e.amount), kind: e.kind || 'other', taxable: e.taxable !== false }));
    const deductions = (input.deductions || []).map((d) => ({ label: d.label, amount: r2(d.amount) }));
    const gross = r2(earnings.reduce((s, e) => s + e.amount, 0));
    const taxable = r2(earnings.filter((e) => e.taxable).reduce((s, e) => s + e.amount, 0));
    const basic = r2(earnings.filter((e) => e.kind === 'basic').reduce((s, e) => s + e.amount, 0));
    const sumKind = (...k) => r2(earnings.filter((e) => k.includes(e.kind)).reduce((s, e) => s + e.amount, 0));
    const eoy = sumKind('eoy');

    // PAYE — cumulative method
    const m = monthIndex(input.month), frac = m / 12;
    const dep = Math.max(0, Math.min(4, Math.round(Number(input.dependents) || 0)));
    const annualRelief = (Number((R.dependents || [])[dep]) || 0) + Math.max(0, Number(input.otherReliefs) || 0);
    const prior = input.prior || { emol: 0, paye: 0 };
    const cumEmol = r2((Number(prior.emol) || 0) + taxable);
    const cumRelief = r2(annualRelief * frac);
    const cumChargeable = Math.max(0, r2(cumEmol - cumRelief));
    const cumTax = r2(bandTax(cumChargeable, R.bands, frac));
    const paye = Math.max(0, rs(cumTax - (Number(prior.paye) || 0)));

    // Contributions on basic
    const C = R.csg, N = R.nsf;
    const high = basic > C.threshold;
    const csgOn = input.csg !== false;
    const bHigh = eoy > C.threshold;   // the bonus is tested on its own
    const csgBonusEe = csgOn && eoy > 0 ? rs(eoy * (bHigh ? C.eeHigh : C.eeLow) / 100) : 0;
    const csgBonusEr = csgOn && eoy > 0 ? rs(eoy * (bHigh ? C.erHigh : C.erLow) / 100) : 0;
    const csgEe = (csgOn ? rs(Math.max(0, basic) * (high ? C.eeHigh : C.eeLow) / 100) : 0) + csgBonusEe;
    const csgEr = (csgOn ? rs(Math.max(0, basic) * (high ? C.erHigh : C.erLow) / 100) : 0) + csgBonusEr;
    const nsfBase = Math.max(0, Math.min(basic, Number(N.ceiling) || Infinity));
    const nsfEe = input.nsf === false ? 0 : Math.floor(nsfBase * N.ee / 100);
    const nsfEr = input.nsf === false ? 0 : Math.floor(nsfBase * N.er / 100);
    const levy = input.levy === false ? 0 : rs(Math.max(0, basic) * R.levy / 100);
    const prgfBase = Math.max(0, r2(basic + sumKind('overtime', 'bonus')));
    const prgfOff = input.prgf === false || (R.prgfMaxBasic && basic > R.prgfMaxBasic);
    const prgf = prgfOff ? 0 : rs(prgfBase * R.prgf / 100);

    const otherDed = r2(deductions.reduce((s, d) => s + d.amount, 0));
    const totalDed = r2(paye + csgEe + nsfEe + otherDed);
    const net = r2(gross - totalDed);
    const employerCost = r2(gross + csgEr + nsfEr + levy + prgf);
    const warnings = [];
    if (basic > 0 && R.minWage && basic < R.minWage) warnings.push('Basic salary is below the national minimum wage (Rs ' + R.minWage.toLocaleString('en') + ' a month) — fine for part-time staff, otherwise check it.');
    if (net < 0) warnings.push('Deductions are more than the pay for this month.');
    // Workers' Rights Act s.34: other deductions (advances, loans…) in total may not exceed half the pay;
    // recovering an advance may not exceed one fifth of the basic wage.
    if (otherDed > gross / 2) warnings.push('Other deductions are more than half of this month\'s pay. The Workers\' Rights Act (s.34) doesn\'t allow that.');
    const adv = deductions.filter((d) => /advance|avance/i.test(d.label)).reduce((s, d) => s + d.amount, 0);
    if (adv > basic / 5) warnings.push('Recovering an advance is limited to one fifth of the basic wage per pay period (Workers\' Rights Act s.34).');
    if (eoy > 0 && basic > 100000) warnings.push('The end-of-year bonus under the Workers\' Rights Act only applies when basic pay is Rs 100,000 or less (s.54). Above that it is a company bonus.');
    return {
      month: input.month, monthIndex: m, gross, taxable, basic,
      paye, csgEe, csgEr, csgRateEe: input.csg === false ? 0 : (high ? C.eeHigh : C.eeLow), csgRateEr: input.csg === false ? 0 : (high ? C.erHigh : C.erLow),
      nsfEe, nsfEr, nsfBase, levy, prgf, prgfBase, csgBonusEe, csgBonusEr, eoy, otherDed, totalDed, net, employerCost,
      cumEmol, cumRelief, cumChargeable, cumTax, cumPaye: r2((Number(prior.paye) || 0) + paye), annualRelief, warnings,
    };
  }

  // End-of-year bonus suggestion: 1/12 of the year's earnings (bonus lines excluded).
  function yearEndBonus(earningsThisYear) { return rs((Number(earningsThisYear) || 0) / 12); }

  const api = { DEFAULT_RATES, taxYearOf, monthIndex, taxYearMonths, bandTax, annualTax, calcSlip, yearEndBonus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZenPayroll = api;
})(typeof window !== 'undefined' ? window : globalThis);
