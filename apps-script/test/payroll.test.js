const P = require('../../payroll.js');
const R = P.DEFAULT_RATES['2026-27'];
let fails = 0; const eq = (a, b, m) => { if (a !== b) { fails++; console.log('FAIL', m, a, '!=', b); } else console.log('ok  ', m, a); };
eq(P.taxYearOf('2026-11'), '2026-27', 'tax year Nov'); eq(P.taxYearOf('2027-06'), '2026-27', 'tax year Jun'); eq(P.taxYearOf('2027-07'), '2027-28', 'tax year Jul');
eq(P.monthIndex('2026-07'), 1, 'July idx'); eq(P.monthIndex('2027-06'), 12, 'June idx');
eq(P.annualTax(720000, R), 22000, 'annual tax 720k');            // 0 + 22,000
eq(P.annualTax(15000000, R), 50000 + 2200000 + 1050000, 'annual tax 15M (35% band)');
// steady 60k for 12 months: monthly PAYE sums to annual tax
function year(basic, allow, dep, start = '2026-07') {
  let prior = { emol: 0, paye: 0 }, total = 0, first;
  for (const mo of P.taxYearMonths('2026-27')) {
    const c = P.calcSlip({ rates: R, month: mo, earnings: [{ label: 'Basic', amount: basic, kind: 'basic' }, { label: 'Transport', amount: allow, kind: 'allowance' }], dependents: dep, prior });
    if (!first) first = c; total += c.paye; prior = { emol: c.cumEmol, paye: c.cumPaye };
  }
  return { total, first };
}
let y = year(60000, 0, 0); eq(y.first.paye, 1833, 'July PAYE 60k'); eq(y.total, 22000, 'year PAYE 60k = annual');
eq(y.first.csgEe, 1800, 'CSG ee 3% (>50k)'); eq(y.first.csgEr, 3600, 'CSG er 6%'); eq(y.first.nsfEe, 297, 'NSF ee capped'); eq(y.first.nsfEr, 743, 'NSF er capped');
eq(y.first.levy, 900, 'levy'); eq(y.first.prgf, 2700, 'PRGF'); eq(y.first.net, 60000 - 1833 - 1800 - 297, 'net');
y = year(40000, 5000, 1); eq(y.total, Math.round(P.annualTax(45000 * 12 - 110000, R)), 'year PAYE 45k gross, 1 dependent');
eq(y.first.csgEe, 600, 'CSG ee 1.5% (<=50k)');
y = year(25000, 0, 0); eq(y.total, 0, 'no PAYE under 500k'); eq(y.first.nsfEe, 250, 'NSF ee uncapped');
y = year(1100000, 0, 0); eq(y.total, Math.round(P.annualTax(13200000, R)), 'year PAYE 13.2M hits 35%');
// bonus month: PAYE catches up then nothing over-withheld
let prior = { emol: 0, paye: 0 }, tot = 0;
for (const mo of P.taxYearMonths('2026-27')) { const e = [{ label: 'Basic', amount: 50000, kind: 'basic' }]; if (mo === '2026-12') e.push({ label: 'Bonus', amount: 50000, kind: 'bonus' });
  const c = P.calcSlip({ rates: R, month: mo, earnings: e, prior }); tot += c.paye; prior = { emol: c.cumEmol, paye: c.cumPaye }; }
eq(tot, P.annualTax(650000, R), 'bonus year PAYE = annual');
const low = P.calcSlip({ rates: R, month: '2026-07', earnings: [{ label: 'Basic', amount: 15000, kind: 'basic' }] }); eq(low.warnings.length, 1, 'min wage warning');
console.log(fails ? fails + ' FAILED' : 'All payroll checks passed.'); process.exit(fails ? 1 : 0);
