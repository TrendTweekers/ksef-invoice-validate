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

  if (!options?.allowFuture && date > (options?.now ?? new Date())) {
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
