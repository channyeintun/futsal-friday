/**
 * VietQR payloads.
 *
 * Vietnam's bank-transfer QR is NAPAS's VietQR, which is the EMVCo "QR Code
 * Specification for Payment Systems — Merchant-Presented Mode" with a NAPAS
 * block inside it. Every major Vietnamese banking app reads one, and a
 * *dynamic* payload carries the amount, so the payer's app opens with the
 * recipient and the sum already filled in.
 *
 * That is the reason this exists rather than a deep link. The `vietqr://pay`
 * scheme that would open a banking app with an amount is documented by VietQR
 * itself as not yet implemented, and the link that does ship only launches the
 * app without filling anything — and would send the account number through a
 * third party to do it. The QR is the part that is actually standardised.
 *
 * ## The format
 *
 * Tag-Length-Value all the way down, where length is two decimal digits, so a
 * value longer than 99 characters cannot be represented at all. Everything is
 * ASCII.
 *
 *   00  payload format indicator      "01"
 *   01  point of initiation           "11" static, "12" dynamic (has an amount)
 *   38  merchant account information  the NAPAS block
 *         00  GUID                    "A000000727"
 *         01  beneficiary
 *               00  acquirer id       the bank's six-digit BIN
 *               01  account number
 *         02  service code            "QRIBFTTA" — transfer to account
 *   53  currency                      "704" (VND, ISO 4217)
 *   54  amount                        decimal string, dynamic payloads only
 *   58  country                       "VN"
 *   62  additional data
 *         08  purpose of transaction  the transfer note
 *   63  CRC                           four uppercase hex digits
 */

/** NAPAS's registered application identifier. Constant for every VietQR. */
const NAPAS_GUID = 'A000000727';
/** Inter-Bank Fund Transfer to an account number, as opposed to a card. */
const SERVICE_TRANSFER_TO_ACCOUNT = 'QRIBFTTA';
const CURRENCY_VND = '704';
const COUNTRY_VN = 'VN';

export interface VietQrInput {
  /** NAPAS acquirer id — six digits, e.g. `970436` for Vietcombank. */
  bankBin: string;
  accountNumber: string;
  /**
   * Integer dong. Omit or pass 0 for a static code the payer types an amount
   * into themselves.
   */
  amount?: number;
  /** Transfer note. Latin only in practice — see `sanitizeReference`. */
  reference?: string;
}

/** `tag` + zero-padded length + value. The whole format is this one shape. */
function field(tag: string, value: string): string {
  const length = value.length.toString().padStart(2, '0');
  if (value.length > 99) {
    throw new Error(`vietqr: field ${tag} is ${value.length} chars, max 99`);
  }
  return `${tag}${length}${value}`;
}

/**
 * CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection,
 * no final XOR.
 *
 * Computed over the whole payload *including* the CRC field's own "6304"
 * tag-and-length prefix, which is the part that trips people up — the
 * checksum covers the header of the field it lives in.
 */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Strip a transfer note down to what banks reliably accept.
 *
 * Vietnamese banks are inconsistent about diacritics and punctuation in the
 * transfer description, and a rejected note can mean a rejected transfer. The
 * conservative move is to fold Vietnamese to ASCII and drop anything that is
 * not alphanumeric or a space, which is what every Vietnamese payment form
 * ends up doing anyway.
 */
export function sanitizeReference(text: string): string {
  return text
    .normalize('NFD')
    // Combining marks, plus đ/Đ which NFD does not decompose.
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 25);
}

/**
 * Build the payload a banking app expects to find in the QR.
 *
 * The amount is written as an integer string because VND has no subunit —
 * putting `70000.00` here would be read by some apps as a different number.
 */
export function buildVietQrPayload(input: VietQrInput): string {
  const bin = input.bankBin.trim();
  const account = input.accountNumber.trim();
  if (!/^\d{6}$/.test(bin)) throw new Error(`vietqr: bank BIN must be six digits, got "${bin}"`);
  if (!/^[A-Za-z0-9]{4,19}$/.test(account)) {
    throw new Error('vietqr: account number must be 4-19 letters or digits');
  }

  const amount = input.amount != null && input.amount > 0 ? Math.round(input.amount) : null;

  const beneficiary = field('00', bin) + field('01', account);
  const napas =
    field('00', NAPAS_GUID) +
    field('01', beneficiary) +
    field('02', SERVICE_TRANSFER_TO_ACCOUNT);

  const reference = input.reference ? sanitizeReference(input.reference) : '';

  const body =
    field('00', '01') +
    // "12" is not decoration: an app seeing "11" may ignore the amount.
    field('01', amount === null ? '11' : '12') +
    field('38', napas) +
    field('53', CURRENCY_VND) +
    (amount === null ? '' : field('54', String(amount))) +
    field('58', COUNTRY_VN) +
    (reference ? field('62', field('08', reference)) : '');

  // The CRC covers its own tag and length, so they are appended before hashing.
  const withCrcHeader = `${body}6304`;
  return `${withCrcHeader}${crc16(withCrcHeader)}`;
}
