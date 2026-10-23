const asCents = value => {
  if (typeof value === "number" && !Number.isFinite(value)) return 0;
  const text = String(value ?? "0").trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) {
    const amount = Number(text);
    return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = match[3] || "";
  const cents = Number((fraction + "00").slice(0, 2));
  const roundsUp = Number(fraction[2] || 0) >= 5;
  return sign * (whole * 100 + cents + Number(roundsUp));
};

const fromCents = value => Number((value / 100).toFixed(2));

/**
 * Add a non-persisted advance-recovery proposal to an authoritative payroll row.
 * `remaining_advance_balance` and `recovered_period` are returned by the payroll
 * RPC using the selected salary period's date cutoffs.
 */
export function calculatePayrollRecovery(row) {
  const totalSalary = row?.salary_eligible === false
    ? 0
    : Math.max(0, asCents(row?.total_salary ?? row?.gross_for_period));
  const additions = Math.max(0, asCents(row?.approved_additions));
  const deductions = Math.max(0, asCents(row?.approved_deductions));
  const finalizedRecovery = Math.max(0, asCents(row?.recovered_period));
  const outstandingAfterFinalized = Math.max(0, asCents(row?.remaining_advance_balance));
  const payableBeforeRecovery = totalSalary + additions - deductions;
  const netAfterFinalized = Math.max(0, payableBeforeRecovery - finalizedRecovery);
  const amountAvailableForProposal = Math.max(0, payableBeforeRecovery - finalizedRecovery);
  const proposedRecovery = Math.min(outstandingAfterFinalized, amountAvailableForProposal);

  return {
    ...row,
    total_salary: fromCents(totalSalary),
    // Retain this API alias for older clients; it now means the configured
    // monthly Total Salary, never a date-prorated amount.
    gross_for_period: fromCents(totalSalary),
    advance_outstanding_before_payroll: fromCents(outstandingAfterFinalized + finalizedRecovery),
    finalized_recovery_amount: fromCents(finalizedRecovery),
    proposed_advance_recovery: fromCents(proposedRecovery),
    advance_outstanding_after_proposed_recovery: fromCents(outstandingAfterFinalized - proposedRecovery),
    net_payable_estimate: fromCents(netAfterFinalized),
    net_payable_after_proposed_recovery: fromCents(Math.max(0, netAfterFinalized - proposedRecovery)),
  };
}

export function enrichPayrollRows(rows) {
  return Array.isArray(rows) ? rows.map(calculatePayrollRecovery) : [];
}
