import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSiteImportRows, normalizeSiteRecord } from "./operationsValidation.js";

const site = { site_code: "S-01", title: "North Gate", service_taken: "Both", phone_numbers: "+91 98765 43210", given_emails: "site@example.com" };

test("site validation separates service billing and leaves ESI/PF rates unconfigured by default", () => {
  const value = normalizeSiteRecord({ ...site, security_guard_monthly_billing: "45000", aso_monthly_billing: "₹25,000", esi_contribution_rate: "3.2500" });
  assert.equal(value.site_code, "S-01");
  assert.equal(value.security_guard_monthly_billing, 45000);
  assert.equal(value.aso_monthly_billing, 25000);
  assert.equal(value.esi_applicable, null);
  assert.equal(value.pf_applicable, null);
  assert.equal(value.esi_contribution_rate, 3.25);
});

test("site validation rejects duplicate phones, invalid emails, unknown services, and impossible dates", () => {
  assert.throws(() => normalizeSiteRecord({ ...site, phone_numbers: "9876543210; +91 98765 43210" }), /duplicates/i);
  assert.throws(() => normalizeSiteRecord({ ...site, given_emails: "bad-address" }), /valid email/i);
  assert.throws(() => normalizeSiteRecord({ ...site, service_taken: "Patrol" }), /security guard, aso, or both/i);
  assert.throws(() => normalizeSiteRecord({ ...site, payroll_effective_date: "2026-02-30" }), /YYYY-MM-DD/i);
});

test("site import groups repeated site codes and links multiple staff without matching by name", () => {
  const result = normalizeSiteImportRows([
    { rowNumber: 2, site, guard: { full_name: "Asha Rao", phone: "9876543210" } },
    { rowNumber: 3, site, guard: { full_name: "Bala Rao", phone: "9876543211" } },
    { rowNumber: 4, site: { ...site, site_code: "S-02", title: "South Gate" }, guard: { full_name: "Asha Rao", phone: "9876543212" } },
  ]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sites.length, 2);
  assert.equal(result.sites[0].guards.length, 2);
  assert.equal(result.sites[1].guards[0].phone, "9876543212");
});

test("site import rejects conflicting values, ambiguous same-phone details, and formula cells", () => {
  const result = normalizeSiteImportRows([
    { rowNumber: 2, site, guard: { full_name: "Asha Rao", phone: "9876543210" } },
    { rowNumber: 3, site: { ...site, title: "Changed name" }, guard: { full_name: "Asha Rao", phone: "9876543210" } },
    { rowNumber: 4, site: { ...site, site_code: "S-03", title: "Formula Site" }, __formula_fields: ["Site Name"] },
  ]);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors.map(error => error.message).join(" "), /conflicting|formulas/i);
});
