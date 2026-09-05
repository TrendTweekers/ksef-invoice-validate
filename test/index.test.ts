import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateNip,
  isValidNip,
  validateDate,
  validateAmounts,
  validateInvoiceForKsef,
  polishDate,
  polishDateFromUnix,
  polishToday,
  looksLikeCompany,
  mayNeedBuyerNip,
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

// ── Polish calendar dates ────────────────────────────────────────────────────
// toISOString() renders UTC. Poland is UTC+2 in summer, UTC+1 in winter, so
// anything between midnight and the offset falls on the previous UTC day.

test("midnight in Warsaw is today, not yesterday", () => {
  // 1788213600 = 2026-09-01 00:00:00 Europe/Warsaw = 2026-08-31T22:00:00Z
  assert.equal(polishDateFromUnix(1788213600), "2026-09-01");
  // The naive version, for contrast:
  assert.equal(new Date(1788213600 * 1000).toISOString().slice(0, 10), "2026-08-31");
});

test("handles winter, when the offset is +1 rather than +2", () => {
  // 1767222000 = 2026-01-01 00:00:00 Europe/Warsaw = 2025-12-31T23:00:00Z
  // A hardcoded +2 fails this.
  assert.equal(polishDateFromUnix(1767222000), "2026-01-01");
});

test("leaves a midday instant alone", () => {
  assert.equal(polishDateFromUnix(1788258000), "2026-09-01");
});

test("polishToday and polishDate agree", () => {
  const d = new Date("2026-08-31T22:00:00Z");
  assert.equal(polishToday(d), "2026-09-01");
  assert.equal(polishDate(d), "2026-09-01");
});

test("an invoice dated today is not 'in the future' just after midnight", () => {
  // 00:30 on 5 September in Warsaw. Before the fix this compared a UTC-midnight
  // Date against the instant and flagged today's invoice as future.
  const now = new Date("2026-09-04T22:30:00Z");
  assert.deepEqual(validateDate("2026-09-05", "issue_date", { now }), []);
  // A genuinely future date is still rejected.
  assert.equal(validateDate("2026-09-06", "issue_date", { now })[0].code, "date.future");
});

// ── Buyer type ───────────────────────────────────────────────────────────────
// A missing NIP is correct for a consumer and wrong for a company. Nothing in
// the invoice data separates them; the name sometimes does.

test("spots a registered legal form in a buyer name", () => {
  for (const name of [
    "Bookinghost Sp. z o.o.",
    "Imperial Tobacco Polska S.A.",
    "Magnitudo Group sp. z.o.o.",
    "MEDIAPLAN PIEKARSKA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ",
    "Fundacja Pomocny Ratel",
    "Acme Ltd",
    "Muster GmbH",
  ]) {
    assert.equal(looksLikeCompany(name), true, name);
  }
});

test("leaves private individuals alone", () => {
  // A false positive here nags somebody about a correct consumer invoice,
  // which is how a warning gets ignored.
  for (const name of [
    "Jan Kowalski",
    "Viktoriia Hlushko",
    "Blazej Werbanowski",
    "Aleksander Stefanowicz",
  ]) {
    assert.equal(looksLikeCompany(name), false, name);
  }
  assert.equal(looksLikeCompany(null), false);
  assert.equal(looksLikeCompany(""), false);
});

test("mayNeedBuyerNip only fires on a company with no NIP", () => {
  assert.equal(mayNeedBuyerNip({ buyer_name: "Bookinghost Sp. z o.o.", buyer_nip: null }), true);
  assert.equal(mayNeedBuyerNip({ buyer_name: "Bookinghost Sp. z o.o.", buyer_nip: "5260001236" }), false);
  assert.equal(mayNeedBuyerNip({ buyer_name: "Imperial Tobacco Polska S.A.", buyer_nip: "   " }), true);
  assert.equal(mayNeedBuyerNip({ buyer_name: "Jan Kowalski", buyer_nip: null }), false);
});
