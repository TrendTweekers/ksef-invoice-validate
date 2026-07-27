# ksef-invoice-validate

Pre-submission checks for Polish invoices headed for **KSeF** (Krajowy System e-Faktur).
Zero dependencies, no network calls, no file I/O. Everything runs locally, including in the browser.

The Ministry of Finance publishes SDKs for Java and .NET. This is a small piece of the
same job for the TypeScript side: catching the mistakes that get an invoice rejected
before it is worth talking to KSeF at all.

## What it checks

- **NIP checksum** - ten digits, weighted `[6,5,7,2,3,4,5,6,7]` modulo 11. Separators tolerated.
- **Dates** - `YYYY-MM-DD`, real calendar dates only (`2026-02-31` is rejected), future dates flagged.
- **Amounts** - non-negative, and net + VAT equals gross. Compared in integer grosze, so
  `0.1 + 0.2 === 0.3` behaves the way an accountant expects.

## What it does not do

It is **not** a substitute for validating against the official FA(3) XSD, and it cannot check
anything that requires the Ministry's systems: duplicate detection, counterparty status,
authorisation, or session handling. Think of it as the cheap check you run first.

## Usage

```ts
import { validateInvoiceForKsef, isValidNip } from "ksef-invoice-validate";

isValidNip("111-111-11-11"); // true

const result = validateInvoiceForKsef({
  invoice_number: "FV/2026/07/1",
  issue_date: "2026-07-01",
  seller_nip: "1111111111",
  buyer_nip: "1111111111",
  amount_net: 1000,
  amount_vat: 230,
  amount_gross: 1230,
});

result.valid; // true
```

A failure returns stable codes you can switch on, rather than prose you have to parse:

```ts
validateInvoiceForKsef({ amount_net: 100, amount_vat: 23, amount_gross: 999 });
// {
//   valid: false,
//   errors: [
//     { field: "invoice_number", code: "field.required", message: "Invoice number is required." },
//     { field: "amount_gross",   code: "amount.mismatch", message: "Net plus VAT does not equal gross.",
//       details: { differencePln: "876.00" } },
//     ...
//   ]
// }
```

Buyer NIP is required by default, since the common case is a B2B invoice. Waive it for
consumers and foreign buyers:

```ts
validateInvoiceForKsef(invoice, { requireBuyerNip: false });
```

## API

| Export | Purpose |
| --- | --- |
| `validateInvoiceForKsef(invoice, options?)` | Runs every check, returns `{ valid, errors }` |
| `validateNip(nip, field?)` | NIP format and checksum |
| `isValidNip(nip)` | Boolean convenience wrapper |
| `validateDate(value, field, options?)` | Format, real-date and future checks |
| `validateAmounts(net, vat, gross)` | Sign and net + VAT = gross |

Error codes: `nip.format`, `nip.checksum`, `date.format`, `date.invalid`, `date.future`,
`amount.negative`, `amount.mismatch`, `field.required`.

## Tests

```bash
node --test "test/**/*.test.ts"
```

Requires Node 22 or newer, which strips TypeScript types natively.

## Origin

Extracted from the validation layer of [FakturaFlow](https://fakturaflow.pl), a KSeF tool for
Polish accounting offices, and released separately because NIP and invoice-arithmetic checks
are useful well beyond it.

MIT licensed.
