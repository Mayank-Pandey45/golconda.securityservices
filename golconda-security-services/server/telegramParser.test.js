import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdvanceMessage, parseTelegramAmount, parseTelegramDate } from "./telegramParser.js";

const employees = [
  { id: 11, employee_type: "guard", employee_code: "G-001", full_name: "Srikant Rao", status: "active" },
  { id: 12, employee_type: "guard", employee_code: "G-002", full_name: "Sarov Kumar", status: "active" },
  { id: 13, employee_type: "guard", employee_code: "G-003", full_name: "अविनाश", status: "active" },
  { id: 14, employee_type: "guard", employee_code: "G-004", full_name: "Ankush", status: "active" },
  { id: 15, employee_type: "guard", employee_code: "G-005", full_name: "रघुवरम", status: "active" },
  { id: 16, employee_type: "guard", employee_code: "G-006", full_name: "Bipul", status: "active" },
  { id: 17, employee_type: "guard", employee_code: "G-007", full_name: "Srikant Rao Duplicate", status: "active" },
  { id: 18, employee_type: "supervisor", employee_code: "S-001", full_name: "Srikant Rao", status: "active" },
];
const sites = [
  { id: 21, title: "VK Enclave", site_code: "VKE", status: "active" },
  { id: 22, title: "Golf Link Apartment", site_code: "GLA", status: "active" },
];
const aliases = [
  { entity_type: "guard", guard_id: 11, alias: "srekant" },
  { entity_type: "guard", guard_id: 11, alias: "श्रीकांत" },
  { entity_type: "guard", guard_id: 13, alias: "Avinash" },
  { entity_type: "supervisor", supervisor_id: 18, alias: "श्रीकांत" },
  { entity_type: "guard", guard_id: 15, alias: "रघुवरम" },
  { entity_type: "site", site_id: 21, alias: "vk enclave" },
  { entity_type: "site", site_id: 22, alias: "गोल्फ Link appartment" },
  { entity_type: "site", site_id: 22, alias: "tukugudda" },
  { entity_type: "site", site_id: 22, alias: "golf link appartment" },
];

function parse(text) { return parseAdvanceMessage(text, { employees, sites, aliases, now: new Date("2026-10-23T12:00:00.000Z") }); }

test("mixed-language sample messages resolve only actual employee and Site records", () => {
  const cases = [
    ["1000srekant ka vk Enclave", "G-001", "VKE", "1000.00", ""],
    ["500sarov food guard VK enclave", "G-002", "VKE", "500.00", "food"],
    ["200अविनाश vk Enclave", "G-003", "VKE", "200.00", ""],
    ["Ankush 250गोल्फ Link appartment", "G-004", "GLA", "250.00", ""],
    ["500रघुवरम tukugudda", "G-005", "GLA", "500.00", ""],
    ["500bipul ko golf link appartment", "G-006", "GLA", "500.00", ""],
  ];
  for (const [message, employeeCode, siteCode, amount, description] of cases) {
    const result = parse(message);
    assert.equal(result.status, "ready", message);
    assert.equal(result.advance.employee.employee_code, employeeCode, message);
    assert.equal(result.advance.site.site_code, siteCode, message);
    assert.equal(result.advance.amount, amount, message);
    assert.equal(result.advance.description, description, message);
  }
});

test("ambiguous employees and unknown abbreviations require clarification, never a write", () => {
  assert.equal(parse("500 श्रीकांत VK Enclave").status, "ambiguous_employee");
  const pp = parse("500श्रीकांत VK Enclave pp अविनाश");
  assert.equal(pp.status, "clarification");
  assert.match(pp.message, /pp/);
  const gp = parse("500bipul ko gp golf link appartment");
  assert.equal(gp.status, "clarification");
  assert.match(gp.message, /gp/);
  assert.equal(parse("₹800 reimbursement to Srikant at VK Enclave").status, "clarification");
});

test("Hindi numerals, dates, payment modes, and exact decimal amounts parse safely", () => {
  assert.equal(parseTelegramAmount("₹ १२,५००.५०").amount, "12500.50");
  assert.equal(parse("२०० अविनाश VKE cash 2026-10-20").advance.amount, "200.00");
  const result = parse("200 Avinash VKE cash 20/10/2026");
  assert.equal(result.status, "ready");
  assert.equal(result.advance.payment_mode, "Cash");
  assert.equal(result.advance.occurred_at, "2026-10-20T00:00:00+05:30");
  assert.equal(parseTelegramDate("31/02/2026", new Date("2026-10-23T00:00:00Z")).error, "That date is invalid.");
});

test("invalid, negative, zero, huge, and multiple amounts are rejected", () => {
  for (const value of ["0", "-20", "10000001", "1000 2000", "1.005"]) assert.ok(parseTelegramAmount(value).error, value);
  assert.equal(parse("-20 Srikant VKE").status, "clarification");
  assert.equal(parse("10000001 Srikant VKE").status, "clarification");
});

test("administrator-approved abbreviation aliases are expanded; unknown meanings are never guessed", () => {
  const message = "500bipul ko gp golf link appartment";
  const configured = [...aliases, { entity_type: "note", alias: "gp", replacement: "group payment" }];
  const result = parseAdvanceMessage(message, { employees, sites, aliases: configured, now: new Date("2026-10-23T12:00:00.000Z") });
  assert.equal(result.status, "ready");
  assert.match(result.advance.description, /group payment/);
});
