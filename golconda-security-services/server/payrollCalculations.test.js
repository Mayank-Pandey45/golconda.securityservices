import test from "node:test";
import assert from "node:assert/strict";
import { calculatePayrollRecovery, enrichPayrollRows } from "./payrollCalculations.js";
import { getPayrollSummary } from "./operations.js";

const row = overrides => ({
  employee_type: "guard",
  employee_id: 7,
  gross_for_period: 18500,
  approved_additions: 0,
  approved_deductions: 0,
  recovered_period: 0,
  remaining_advance_balance: 0,
  ...overrides,
});

test("proposes outstanding advance recovery up to salary and keeps the net at or above zero", () => {
  const result = calculatePayrollRecovery(row({ remaining_advance_balance: 1000 }));
  assert.equal(result.advance_outstanding_before_payroll, 1000);
  assert.equal(result.proposed_advance_recovery, 1000);
  assert.equal(result.net_payable_after_proposed_recovery, 17500);
  assert.equal(result.advance_outstanding_after_proposed_recovery, 0);

  const noAdvance = calculatePayrollRecovery(row());
  assert.equal(noAdvance.proposed_advance_recovery, 0);
  assert.equal(noAdvance.net_payable_after_proposed_recovery, 18500);

  const largerAdvance = calculatePayrollRecovery(row({ remaining_advance_balance: 20000 }));
  assert.equal(largerAdvance.proposed_advance_recovery, 18500);
  assert.equal(largerAdvance.net_payable_after_proposed_recovery, 0);
  assert.equal(largerAdvance.advance_outstanding_after_proposed_recovery, 1500);
});

test("prior and finalized partial recoveries are not proposed a second time", () => {
  const priorPeriodRecovery = calculatePayrollRecovery(row({ remaining_advance_balance: 700 }));
  assert.equal(priorPeriodRecovery.advance_outstanding_before_payroll, 700);
  assert.equal(priorPeriodRecovery.proposed_advance_recovery, 700);

  const partialCurrentRecovery = calculatePayrollRecovery(row({
    recovered_period: 100,
    remaining_advance_balance: 900,
  }));
  assert.equal(partialCurrentRecovery.advance_outstanding_before_payroll, 1000);
  assert.equal(partialCurrentRecovery.finalized_recovery_amount, 100);
  assert.equal(partialCurrentRecovery.proposed_advance_recovery, 900);
  assert.equal(partialCurrentRecovery.net_payable_after_proposed_recovery, 17500);
  assert.equal(partialCurrentRecovery.advance_outstanding_after_proposed_recovery, 0);
});

test("approved additions and deductions set the available salary cap", () => {
  const result = calculatePayrollRecovery(row({
    gross_for_period: 18500,
    approved_additions: 250,
    approved_deductions: 500,
    remaining_advance_balance: 20000,
  }));
  assert.equal(result.proposed_advance_recovery, 18250);
  assert.equal(result.net_payable_after_proposed_recovery, 0);
  assert.equal(result.advance_outstanding_after_proposed_recovery, 1750);

  const deductionsExceedPay = calculatePayrollRecovery(row({
    approved_deductions: 20000,
    remaining_advance_balance: 1000,
  }));
  assert.equal(deductionsExceedPay.proposed_advance_recovery, 0);
  assert.equal(deductionsExceedPay.net_payable_after_proposed_recovery, 0);
});

test("Total Salary uses the configured monthly amount and subtracts one capped advance proposal", () => {
  const examples = [
    ["19000.00", "1000.00", 18000],
    ["18500.00", "1000.00", 17500],
    ["36000.01", "0.00", 36000.01],
  ];
  for (const [salary, advance, expected] of examples) {
    const result = calculatePayrollRecovery(row({
      total_salary: salary,
      remaining_advance_balance: advance,
      joining_date: "2026-10-20",
      employment_end_date: "2026-10-24",
    }));
    assert.equal(result.total_salary, Number(salary));
    assert.equal(result.net_payable_after_proposed_recovery, expected);
  }
});

test("finalized and proposed recovery, adjustments, and eligibility do not double deduct", () => {
  const result = calculatePayrollRecovery(row({
    total_salary: "19000.00",
    approved_additions: "1500.00",
    approved_deductions: "500.00",
    recovered_period: "500.00",
    remaining_advance_balance: "500.00",
  }));
  assert.equal(result.proposed_advance_recovery, 500);
  assert.equal(result.net_payable_after_proposed_recovery, 19000);

  const notEligible = calculatePayrollRecovery(row({
    total_salary: "19000.00",
    salary_eligible: false,
    remaining_advance_balance: "25000.00",
  }));
  assert.equal(notEligible.total_salary, 0);
  assert.equal(notEligible.proposed_advance_recovery, 0);
  assert.equal(notEligible.net_payable_after_proposed_recovery, 0);
});

test("same recovery calculation covers guards, supervisors, field officers and transferred staff", () => {
  const rows = enrichPayrollRows([
    row({ employee_type: "guard", employee_id: 7, remaining_advance_balance: 1000, site_ids: [11, 12] }),
    row({ employee_type: "supervisor", employee_id: 8, gross_for_period: 24000, remaining_advance_balance: 2000 }),
    row({ employee_type: "field_officer", employee_id: 9, gross_for_period: 28000, remaining_advance_balance: 3000, status: "relieved" }),
  ]);
  assert.deepEqual(rows.map(item => item.proposed_advance_recovery), [1000, 2000, 3000]);
  assert.deepEqual(rows.map(item => item.net_payable_after_proposed_recovery), [17500, 22000, 25000]);
});

test("joining and exit dates do not prorate eligible monthly salary; month eligibility is explicit", () => {
  const midMonthJoiner = calculatePayrollRecovery(row({
    total_salary: 19000,
    gross_for_period: 5516.13,
    joining_date: "2026-10-20",
    salary_eligible: true,
    remaining_advance_balance: 1000,
  }));
  const midMonthExit = calculatePayrollRecovery(row({
    total_salary: 19000,
    employment_end_date: "2026-10-15",
    salary_eligible: true,
  }));
  const notYetJoined = calculatePayrollRecovery(row({
    total_salary: 19000,
    salary_eligible: false,
    salary_eligibility_status: "Not eligible for selected month",
  }));
  assert.equal(midMonthJoiner.total_salary, 19000);
  assert.equal(midMonthJoiner.proposed_advance_recovery, 1000);
  assert.equal(midMonthJoiner.net_payable_after_proposed_recovery, 18000);
  assert.equal(midMonthExit.total_salary, 19000);
  assert.equal(midMonthExit.net_payable_after_proposed_recovery, 19000);
  assert.equal(notYetJoined.total_salary, 0);
  assert.equal(notYetJoined.salary_eligibility_status, "Not eligible for selected month");
});

test("a proposal is repeatable and does not mutate finalized recovery or ledger balances", () => {
  const input = row({ recovered_period: 600, remaining_advance_balance: 1400 });
  const first = calculatePayrollRecovery(input);
  const retry = calculatePayrollRecovery(input);
  assert.deepEqual(retry, first);
  assert.equal(input.recovered_period, 600);
  assert.equal(input.remaining_advance_balance, 1400);
  assert.equal(first.finalized_recovery_amount, 600);
  assert.equal(first.proposed_advance_recovery, 1400);
  assert.equal(first.net_payable_after_proposed_recovery, 16500);
});

test("payroll API service enriches the authorized database result without changing its input rows", async () => {
  const databaseRow = row({ remaining_advance_balance: 1000 });
  const calls = [];
  const database = { async rpc(name, args) { calls.push({ name, args }); return { data: [databaseRow], error: null }; } };
  const result = await getPayrollSummary(database, "2026-10", "synthetic-admin");
  assert.deepEqual(calls, [{ name: "get_payroll_summary", args: { p_period: "2026-10-01", p_actor_id: "synthetic-admin" } }]);
  assert.equal(result.employees[0].proposed_advance_recovery, 1000);
  assert.equal(result.employees[0].net_payable_after_proposed_recovery, 17500);
  assert.equal(databaseRow.recovered_period, 0);
  assert.equal(databaseRow.remaining_advance_balance, 1000);
});
