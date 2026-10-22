import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { normalizeImportDate } from './importDate.js';
import { normalizeGuardRow } from './guardValidation.js';
import { normalizeSiteRecord, normalizeImportedPerson } from './operationsValidation.js';

test('calendar dates use explicit day-first parsing and the approved fixed century rule', () => {
  for (const [input, iso] of [['31-12-2026', '2026-12-31'], ['01/04/26', '2026-04-01'], ['03/04/90', '1990-04-03'], ['1/1/49', '2049-01-01'], ['1/1/50', '1950-01-01'], ['29/02/00', '2000-02-29'], ['2026-4-1', '2026-04-01'], [45292, '2024-01-01'], [new Date('2026-04-01T00:00:00Z'), '2026-04-01']]) assert.equal(normalizeImportDate(input), iso);
  for (const invalid of ['31/04/26', '29/02/25', '29/02/1900', '04/13/26', '1-2/26', '2026-01-01T20:00:00Z', { formula: '1+1' }, new Date('invalid')]) assert.throws(() => normalizeImportDate(invalid));
  assert.equal(normalizeImportDate(' '), null);
});

test('Guard, Site and employee date fields all normalize before persistence', () => {
  const guard = normalizeGuardRow({ 'Full Name': 'Test', Phone: '9876543210', 'Joining Date': '01-04-2026', 'Date of Birth': '01/04/90', 'Employment End Date': '30/04/26', 'Salary Effective Date': '01/04/26' });
  assert.equal(guard.joining_date, '2026-04-01'); assert.equal(guard.date_of_birth, '1990-04-01'); assert.equal(guard.employment_end_date, '2026-04-30'); assert.equal(guard.salary_effective_date, '2026-04-01');
  assert.equal(normalizeSiteRecord({ site_code: 'S1', title: 'Test', payroll_effective_date: '01/04/26' }).payroll_effective_date, '2026-04-01');
  assert.equal(normalizeImportedPerson({ full_name: 'Test', phone: '9876543210', joining_date: '01-04-2026', salary_effective_from: '01/04/26' }, 'guard').salary_effective_from, '2026-04-01');
});

test('Excel Date calendar values remain stable across Kolkata and negative-offset timezones', () => {
  const moduleUrl = new URL('./importDate.js', import.meta.url).href;
  for (const TZ of ['Asia/Kolkata', 'America/Los_Angeles']) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', 'import { normalizeImportDate } from ' + JSON.stringify(moduleUrl) + '; console.log(normalizeImportDate(new Date("2026-04-01T00:00:00Z")));'], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(output.trim(), '2026-04-01');
  }
});
