const asCents = value => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
};

const fromCents = value => Number((value / 100).toFixed(2));

/**
 * Add a non-persisted advance-recovery proposal to an authoritative payroll row.
 * `remaining_advance_balance` and `recovered_period` are returned by the payroll
 * RPC using the selected salary period's date cutoffs.
 */
export function calculatePayrollRecovery(row) {
  const gross = Math.max(0, asCents(row?.gross_for_period));
  const additions = Math.max(0, asCents(row?.approved_additions));
  const deductions = Math.max(0, asCents(row?.approved_deductions));
  const finalizedRecovery = Math.max(0, asCents(row?.recovered_period));
  const outstandingAfterFinalized = Math.max(0, asCents(row?.remaining_advance_balance));
  const payableBeforeRecovery = gross + additions - deductions;
  const netAfterFinalized = Math.max(0, payableBeforeRecovery - finalizedRecovery);
  const amountAvailableForProposal = Math.max(0, payableBeforeRecovery - finalizedRecovery);
  const proposedRecovery = Math.min(outstandingAfterFinalized, amountAvailableForProposal);

  return {
    ...row,
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
