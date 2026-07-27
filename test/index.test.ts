import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateNip,
  isValidNip,
  validateDate,
  validateAmounts,
  validateInvoiceForKsef,
} from "../src/index.ts";

test("accepts a NIP with a correct checksum", () => {
  assert.equal(isValidNip("1111111111"), true);
  assert.equal(isValidNip("111-111-11-11"), true);
});

test("rejects a NIP with a broken checksum", () => {
  const errors = validateNip("1111111112");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "nip.checksum");
});

test("rejects a NIP that is not ten digits", () => {
  assert.equal(validateNip("12345")[0].code, "nip.format");
  assert.equal(validateNip("abcdefghij")[0].code, "nip.format");
});

test("treats an empty NIP as the caller's problem, not an error", () => {
  assert.deepEqual(validateNip(""), []);
  assert.deepEqual(validateNip(null), []);
});

test("rejects impossible calendar dates", () => {
  assert.equal(validateDate("2026-02-31", "issue_date")[0].code, "date.invalid");
  assert.equal(validateDate("31-01-2026", "issue_date")[0].code, "date.format");
});

test("rejects future dates unless allowed", () => {
  const now = new Date("2026-07-27T00:00:00Z");
  assert.equal(validateDate("2027-01-01", "issue_date", { now })[0].code, "date.future");
  assert.deepEqual(validateDate("2027-01-01", "issue_date", { now, allowFuture: true }), []);
});

test("catches net + VAT that does not equal gross", () => {
  const errors = validateAmounts(100, 23, 130);
  assert.equal(errors[0].code, "amount.mismatch");
  assert.equal(errors[0].details?.differencePln, "7.00");
});

test("tolerates one grosz of rounding", () => {
  assert.deepEqual(validateAmounts(100.004, 23.001, 123.0), []);
});

test("does not use floating point comparison", () => {
  assert.deepEqual(validateAmounts(0.1, 0.2, 0.3), []);
});

test("validates a whole invoice", () => {
  const ok = validateInvoiceForKsef({
    invoice_number: "FV/2026/07/1",
    issue_date: "2026-07-01",
    seller_nip: "1111111111",
    buyer_nip: "1111111111",
    amount_net: 1000,
    amount_vat: 230,
    amount_gross: 1230,
  });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));

  const bad = validateInvoiceForKsef({ amount_net: 100, amount_vat: 23, amount_gross: 999 });
  assert.equal(bad.valid, false);
  const codes = bad.errors.map((e) => e.code);
  assert.ok(codes.includes("field.required"));
  assert.ok(codes.includes("amount.mismatch"));
});

test("buyer NIP can be waived for consumers and foreign buyers", () => {
  const r = validateInvoiceForKsef(
    { invoice_number: "1", seller_nip: "1111111111", issue_date: "2026-07-01" },
    { requireBuyerNip: false },
  );
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});
