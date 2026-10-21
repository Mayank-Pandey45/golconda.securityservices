import assert from "node:assert/strict";
import { test } from "node:test";
import { GuardValidationError, normalizeGuardRow, normalizePhoneKey } from "./guardValidation.js";

test("guard validation accepts case-insensitive column variants and optional employment fields", () => {
  const guard = normalizeGuardRow({
    "FULL NAME": "  Asha Rao  ",
    "Phone Number": "+91 (987) 654-3210",
    "Email Address": "ASHA@example.com",
    Designation: "Supervisor",
    Status: "On Leave",
    "Date of Joining": "12/11/2024",
    "Assigned Site": "North Gate",
    "Salary Amount (INR)": "₹15,000.50",
    "Salary Frequency": "Monthly",
    "Effective Date": "2024-12-01",
    Notes: "Revised by management",
  });

  assert.deepEqual(guard, {
    employee_code: null,
    full_name: "Asha Rao",
    phone: "+91 (987) 654-3210",
    email: "asha@example.com",
    designation: "Supervisor",
    status: "on_leave",
    joining_date: "2024-11-12",
    employment_end_date: null,
    date_of_birth: null,
    residential_address: "",
    assigned_site: "North Gate",
    assigned_sites: ["North Gate"],
    salary_amount: 15000.5,
    salary_frequency: "monthly",
    salary_effective_date: "2024-12-01",
    salary_notes: "Revised by management",
  });
  assert.equal(normalizePhoneKey(guard.phone), "919876543210");
});

test("guard validation defaults optional designation and status without accepting bad private values", () => {
  const guard = normalizeGuardRow({ full_name: "Ravi Kumar", phone: "9876543210" });
  assert.equal(guard.designation, "Security Guard");
  assert.equal(guard.status, "active");
  assert.equal(guard.salary_amount, null);
  assert.equal(guard.assigned_site, null);
  assert.deepEqual(guard.assigned_sites, []);

  for (const bad of [
    { full_name: "", phone: "9876543210" },
    { full_name: "Ravi", phone: "123" },
    { full_name: "Ravi", phone: "9876543210", email: "not-an-email" },
    { full_name: "Ravi", phone: "9876543210", status: "suspended" },
    { full_name: "Ravi", phone: "9876543210", "Salary Amount": "-10" },
    { full_name: "Ravi", phone: "9876543210", "Joining Date": "2025-02-30" },
    { full_name: "Ravi", phone: "9876543210", "Joining Date": "2025-04-01", "Employment End Date": "2025-03-31" },
    { full_name: "Ravi", phone: "9876543210", "Employee Code": "bad code" },
    { full_name: "Ravi", phone: "9876543210", __formula_fields: ["Salary"] },
  ]) assert.throws(() => normalizeGuardRow(bad), GuardValidationError);
});

test("Excel serial dates are converted without evaluating formula results", () => {
  assert.equal(normalizeGuardRow({ "Full Name": "A", Phone: "9876543210", "Joining Date": 45292 }).joining_date, "2024-01-01");
  assert.throws(() => normalizeGuardRow({ "Full Name": "A", Phone: "9876543210", Salary: { formula: "1+1", result: 2 } }), /formulas are not accepted/i);
});
