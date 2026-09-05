/**
 * ksef-invoice-validate
 *
 * Pre-submission checks for Polish invoices headed for KSeF (Krajowy System e-Faktur).
 * Zero dependencies, no network access, no I/O. Everything runs locally.
 *
 * These are structural and arithmetic checks. They catch the mistakes that get an
 * invoice bounced before it is worth talking to KSeF at all. They are NOT a
 * substitute for validating against the official FA(3) XSD, and they do not
 * check anything that requires the Ministry's systems (duplicate detection,
 * counterparty status, authorisation).
 */

/** Stable, machine-readable reason a value was rejected. */
export type ValidationCode =
  | "nip.format"
  | "nip.checksum"
  | "date.format"
  | "date.invalid"
  | "date.future"
  | "amount.negative"
  | "amount.mismatch"
  | "field.required";

export interface ValidationError {
  /** Field the problem belongs to, e.g. "seller_nip". */
  field: string;
  /** Stable code, safe to switch on or map to your own copy. */
  code: ValidationCode;
  /** Human-readable English explanation. Not intended for end users. */
  message: string;
  /** Extra context, present on some codes. */
  details?: Record<string, string>;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const err = (
  field: string,
  code: ValidationCode,
  message: string,
  details?: Record<string, string>,
): ValidationError => (details ? { field, code, message, details } : { field, code, message });

/**
 * Validate a Polish NIP (tax identification number).
 *
 * A NIP is ten digits. The tenth is a checksum over the first nine, weighted
 * [6,5,7,2,3,4,5,6,7] and reduced modulo 11. A remainder of 10 can never match a
 * single digit, so such numbers are simply invalid.
 *
 * Separators are tolerated: "123-456-32-18" and "1234563218" are treated alike.
 * An empty value returns no errors - requiredness is the caller's decision.
 */
export function validateNip(
  nip: string | null | undefined,
  field = "nip",
): ValidationError[] {
  if (!nip || nip.trim() === "") return [];

  const cleaned = nip.replace(/[\s-]/g, "");

  if (!/^\d{10}$/.test(cleaned)) {
    return [err(field, "nip.format", "NIP must be exactly 10 digits.")];
  }

  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const digits = cleaned.split("").map(Number);
  const checksum = weights.reduce((sum, w, i) => sum + w * digits[i], 0) % 11;

  if (checksum !== digits[9]) {
    return [err(field, "nip.checksum", "NIP checksum digit does not match.")];
  }

  return [];
}

/** True when the NIP is well-formed and its checksum matches. */
export function isValidNip(nip: string | null | undefined): boolean {
  return !!nip && nip.trim() !== "" && validateNip(nip).length === 0;
}

/**
 * The Polish calendar date of an instant, as YYYY-MM-DD.
 *
 * `toISOString().slice(0, 10)` is the obvious way to do this and it is wrong.
 * It renders UTC. Poland runs UTC+2 in summer and UTC+1 in winter, so any
 * instant between midnight and the offset falls on the previous UTC day.
 *
 * That matters because an issue date on a Polish invoice is a Polish calendar
 * date, wherever the server happens to run. Get it wrong at the turn of a
 * month and the invoice lands in the wrong VAT period, which is a correcting
 * invoice rather than a typo.
 *
 * The offset comes from the timezone database, so DST is handled. A hardcoded
 * +2 is correct until the last Sunday in October and silently wrong after it.
 */
const WARSAW_YMD = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Warsaw",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function polishDate(instant: Date): string {
  return WARSAW_YMD.format(instant);
}

/** The Polish calendar date of a unix timestamp in SECONDS, as YYYY-MM-DD. */
export function polishDateFromUnix(seconds: number): string {
  return polishDate(new Date(seconds * 1000));
}

/** Today's date in Poland, as YYYY-MM-DD. */
export function polishToday(now: Date = new Date()): string {
  return polishDate(now);
}

/**
 * Registered legal forms in a buyer name, Polish and the common foreign ones.
 *
 * A missing buyer NIP is correct for a consumer: FA(3) carries BrakID instead,
 * and roughly three quarters of a real Polish B2C invoice book has no buyer
 * NIP at all. It is NOT correct for a company, and filing a business sale as a
 * consumer sale needs a correcting invoice afterwards.
 *
 * Nothing in the invoice data distinguishes the two. The name sometimes does.
 * Use it to decide whether a missing NIP is worth a human look, never to
 * reject an invoice outright.
 *
 * Deliberately does not match generic words like "Usługi", "Firma" or "Group":
 * measured against a 1,142-invoice production book, these patterns flagged 6
 * of 733 NIP-less invoices and every one was a genuine company. A sole trader
 * is a business with a NIP whose name is a person's name, so no pattern finds
 * those.
 */
const LEGAL_FORM =
  /(\bsp(?:ó[łl]ka)?\.?\s*z\s*\.?\s*o\.?\s*\.?\s*o|\bs\.?\s*a\.?(?:\s|$|,)|\bp\.?\s*s\.?\s*a\.?(?:\s|$|,)|\bs\.?\s*c\.?(?:\s|$|,)|\bsp\.?\s*[jk]\.?(?:\s|$|,)|spółka|fundacja|stowarzyszenie|spółdzielnia|\bltd\b|\bgmbh\b|\bllc\b|\binc\b|\bs\.\s*r\.\s*o\b|\bb\.\s*v\b)/i;

/** True when a buyer name carries a registered legal form. */
export function looksLikeCompany(name: string | null | undefined): boolean {
  return !!name && LEGAL_FORM.test(name);
}

/**
 * True when the name says company but no NIP was supplied, so the invoice
 * would be filed as a sale to a private individual. Advisory, not a rejection.
 */
export function mayNeedBuyerNip(invoice: {
  buyer_nip?: string | null;
  buyer_name?: string | null;
}): boolean {
  const nip = invoice.buyer_nip;
  if (nip != null && String(nip).trim() !== "") return false;
  return looksLikeCompany(invoice.buyer_name);
}

/**
 * Validate an ISO date string (YYYY-MM-DD).
 *
 * Future dates are rejected unless `allowFuture` is set, because an issue date
 * in the future is almost always a data-entry or timezone bug. An empty value
 * returns no errors.
 */
export function validateDate(
  value: string | null | undefined,
  field: string,
  options?: { allowFuture?: boolean; now?: Date },
): ValidationError[] {
  if (!value || value.trim() === "") return [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return [err(field, "date.format", "Date must be in YYYY-MM-DD format.")];
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return [err(field, "date.invalid", "Date is not a real calendar date.")];
  }

  // Reject e.g. 2026-02-31, which Date happily rolls over into March.
  if (date.toISOString().slice(0, 10) !== value) {
    return [err(field, "date.invalid", "Date is not a real calendar date.")];
  }

  // Compare calendar dates, not instants.
  //
  // This used to be `date > now`, which compares an invoice date parsed as UTC
  // midnight against the current instant. Between midnight and 02:00 in Poland
  // that makes today look like tomorrow, so an invoice correctly dated today
  // was rejected as being in the future. The bug only fires in that window,
  // which is exactly when a nightly billing run issues invoices.
  //
  // Both sides are now YYYY-MM-DD strings in the Polish calendar, and ISO
  // dates compare correctly as strings.
  if (!options?.allowFuture && value > polishToday(options?.now)) {
    return [err(field, "date.future", "Date is in the future.")];
  }

  return [];
}

/**
 * Check that amounts are non-negative and that net + VAT equals gross,
 * within a one-grosz tolerance to absorb rounding.
 *
 * Amounts are compared in integer grosze to avoid floating-point drift.
 */
export function validateAmounts(
  amountNet: number | null | undefined,
  amountVat: number | null | undefined,
  amountGross: number | null | undefined,
): ValidationError[] {
  const errors: ValidationError[] = [];

  const nonNegative: Array<[string, number | null | undefined]> = [
    ["amount_net", amountNet],
    ["amount_vat", amountVat],
    ["amount_gross", amountGross],
  ];

  for (const [field, value] of nonNegative) {
    if (value != null && value < 0) {
      errors.push(err(field, "amount.negative", "Amount must not be negative."));
    }
  }

  if (amountNet != null && amountVat != null && amountGross != null) {
    const grosze = (n: number) => Math.round(n * 100);
    const diff = Math.abs(grosze(amountNet) + grosze(amountVat) - grosze(amountGross));
    if (diff > 1) {
      errors.push(
        err(
          "amount_gross",
          "amount.mismatch",
          "Net plus VAT does not equal gross.",
          { differencePln: (diff / 100).toFixed(2) },
        ),
      );
    }
  }

  return errors;
}

/** The subset of invoice fields these checks care about. */
export interface InvoiceInput {
  invoice_number?: string | null;
  issue_date?: string | null;
  sale_date?: string | null;
  seller_nip?: string | null;
  buyer_nip?: string | null;
  amount_net?: number | null;
  amount_vat?: number | null;
  amount_gross?: number | null;
}

/**
 * Run every check against one invoice.
 *
 * `buyer_nip` is required by default because the common case is a B2B invoice.
 * Pass `requireBuyerNip: false` for a counterparty that legitimately has no
 * Polish NIP, such as a consumer or a foreign buyer.
 */
export function validateInvoiceForKsef(
  invoice: InvoiceInput,
  options?: { requireBuyerNip?: boolean; allowFutureDates?: boolean },
): ValidationResult {
  const errors: ValidationError[] = [];
  const requireBuyerNip = options?.requireBuyerNip ?? true;

  if (!invoice.invoice_number?.trim()) {
    errors.push(err("invoice_number", "field.required", "Invoice number is required."));
  }
  if (!invoice.seller_nip?.trim()) {
    errors.push(err("seller_nip", "field.required", "Seller NIP is required."));
  }
  if (requireBuyerNip && !invoice.buyer_nip?.trim()) {
    errors.push(err("buyer_nip", "field.required", "Buyer NIP is required."));
  }

  errors.push(...validateNip(invoice.seller_nip, "seller_nip"));
  errors.push(...validateNip(invoice.buyer_nip, "buyer_nip"));

  const dateOpts = { allowFuture: options?.allowFutureDates };
  errors.push(...validateDate(invoice.issue_date, "issue_date", dateOpts));
  errors.push(...validateDate(invoice.sale_date, "sale_date", dateOpts));

  errors.push(
    ...validateAmounts(invoice.amount_net, invoice.amount_vat, invoice.amount_gross),
  );

  return { valid: errors.length === 0, errors };
}
