//! VietQR payloads.
//!
//! Vietnam's bank-transfer QR is NAPAS's VietQR, which is the EMVCo "QR Code
//! Specification for Payment Systems — Merchant-Presented Mode" with a NAPAS
//! block inside it. Every major Vietnamese banking app reads one, and the
//! payload carries the amount, so the payer's app opens with the recipient and
//! the sum already filled in.
//!
//! That is the reason this exists rather than a deep link. The `vietqr://pay`
//! scheme that would open a banking app with an amount is documented by VietQR
//! itself as not yet implemented, and the link that does ship only launches the
//! app without filling anything — and would send the account number through a
//! third party to do it. The QR is the part that is actually standardised.
//!
//! ## The format
//!
//! Tag-Length-Value all the way down, where length is two decimal digits, so a
//! value longer than 99 characters cannot be represented at all. Everything is
//! ASCII.
//!
//! ```text
//! 00  payload format indicator      "01"
//! 01  point of initiation           "11" static, "12" dynamic — see below
//! 38  merchant account information  the NAPAS block
//!       00  GUID                    "A000000727"
//!       01  beneficiary
//!             00  acquirer id       the bank's six-digit BIN
//!             01  account number
//!       02  service code            "QRIBFTTA" — transfer to account
//! 53  currency                      "704" (VND, ISO 4217)
//! 54  amount                        decimal string, dynamic payloads only
//! 58  country                       "VN"
//! 62  additional data
//!       08  purpose of transaction  the transfer note
//! 63  CRC                           four uppercase hex digits
//! ```
//!
//! ## Why the amount is a suggestion, not a fixed bill
//!
//! Tag 01 is the lever. "12" means dynamic — one QR for one transaction — and
//! banking apps read that as a bill: they fill the amount in and *lock the
//! field*. "11" means static, a code that gets reused, so an amount alongside it
//! is a suggested figure the payer can still edit before confirming.
//!
//! In theory that second mode lets somebody round up or settle two weeks at once
//! without abandoning the scan. In practice it does not exist: tested against
//! BIDV and Zalo, both prefill the amount and lock the field whichever marker is
//! set. The amount in a VietQR is simply not negotiable on these rails, so "12"
//! is what we send — it is the honest description of what this is, a bill for
//! one person for one session.
//!
//! `amount_editable` stays because the distinction is real in the spec and the
//! behaviour is the bank's to change, not ours. If an app ever does honour it,
//! this is one boolean.
//!
//! The way to make the number right is therefore to bill the right number in the
//! first place — which is what attendance marking is for.
//!
//! Ported from `shared/src/vietqr.ts`, function for function.

/// NAPAS's registered application identifier. Constant for every VietQR.
const NAPAS_GUID: &str = "A000000727";
/// Inter-Bank Fund Transfer to an account number, as opposed to a card.
const SERVICE_TRANSFER_TO_ACCOUNT: &str = "QRIBFTTA";
const CURRENCY_VND: &str = "704";
const COUNTRY_VN: &str = "VN";

/// How much of a transfer note survives. Banks truncate longer descriptions
/// themselves, and unpredictably, so it is cut here where the cut is known.
const MAX_REFERENCE: usize = 25;

/// What a payload is built from.
///
/// The failures are strings because the messages are the contract: they are the
/// original's wording, and the Worker hands them straight back as the body of a
/// `bad_request`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VietQrInput<'a> {
    /// NAPAS acquirer id — six digits, e.g. `970436` for Vietcombank.
    pub bank_bin: &'a str,
    pub account_number: &'a str,
    /// Integer dong. `None` or a non-positive amount gives a static code the
    /// payer types an amount into themselves.
    ///
    /// The original rounds this before writing it; a dong is already the
    /// smallest unit there is, so here there is nothing left to round.
    pub amount: Option<i64>,
    /// Transfer note. Latin only in practice — see `sanitize_reference`.
    pub reference: Option<&'a str>,
    /// Ask for an amount the payer can edit. Defaults to false, because no
    /// Vietnamese app tested actually honours it — see the note above. Has no
    /// effect when there is no amount.
    pub amount_editable: bool,
}

impl<'a> VietQrInput<'a> {
    /// A static code: an account to pay, with no amount and no note.
    pub fn new(bank_bin: &'a str, account_number: &'a str) -> Self {
        Self { bank_bin, account_number, amount: None, reference: None, amount_editable: false }
    }
}

/// `tag` + zero-padded length + value. The whole format is this one shape.
///
/// Every value written here is ASCII by construction — the BIN and the account
/// number are validated, the rest are constants, digits, or a reference that has
/// been folded to ASCII — so a byte is a character and the two-digit length
/// describes both.
fn field(tag: &str, value: &str) -> Result<String, String> {
    let length = value.len();
    if length > 99 {
        return Err(format!("vietqr: field {tag} is {length} chars, max 99"));
    }
    Ok(format!("{tag}{length:02}{value}"))
}

/// CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection,
/// no final XOR.
///
/// Computed over the whole payload *including* the CRC field's own "6304"
/// tag-and-length prefix, which is the part that trips people up — the checksum
/// covers the header of the field it lives in.
///
/// The original walks `charCodeAt`, so the unit is a UTF-16 code unit, and the
/// register is masked to sixteen bits inside the bit loop — which quietly
/// discards the high byte of anything above U+00FF. Payloads are ASCII, so it
/// never comes up in practice, but the arithmetic is reproduced as written
/// rather than tidied, because this is a checksum other software verifies.
pub fn crc16(input: &str) -> String {
    let mut crc: u32 = 0xffff;
    for unit in input.encode_utf16() {
        crc ^= u32::from(unit) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                ((crc << 1) ^ 0x1021) & 0xffff
            } else {
                (crc << 1) & 0xffff
            };
        }
    }
    format!("{crc:04X}")
}

/// What one character contributes to a sanitised reference.
enum Fold {
    /// A combining mark, dropped without leaving a gap — the accent comes off
    /// the letter it was sitting on.
    Mark,
    /// An ASCII letter or digit, kept as itself.
    Ascii(u8),
    /// Anything else: a separator, whatever it was.
    Other,
}

/// Strip a transfer note down to what banks reliably accept.
///
/// Vietnamese banks are inconsistent about diacritics and punctuation in the
/// transfer description, and a rejected note can mean a rejected transfer. The
/// conservative move is to fold Vietnamese to ASCII and drop anything that is
/// not alphanumeric or a space, which is what every Vietnamese payment form ends
/// up doing anyway.
///
/// The original spells this as NFD, then delete U+0300..U+036F, then đ/Đ → d/D
/// (NFD does not decompose those), then collapse every remaining run of
/// non-alphanumerics to one space, collapse whitespace, trim, and cut to 25.
/// Note the cut comes *after* the trim, so a note that runs past 25 characters
/// can end on a space — that is the original's answer and it is preserved.
pub fn sanitize_reference(text: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in text.chars() {
        match fold(c) {
            Fold::Mark => {}
            // A separator only becomes a space once something follows it, which
            // is the trim and the whitespace-collapse in one pass.
            Fold::Other => gap = !out.is_empty(),
            Fold::Ascii(b) => {
                if gap {
                    out.push(' ');
                    gap = false;
                }
                out.push(b as char);
            }
        }
    }
    // Every byte is ASCII, so this is always on a character boundary.
    out.truncate(MAX_REFERENCE);
    out
}

fn fold(c: char) -> Fold {
    if c.is_ascii_alphanumeric() {
        return Fold::Ascii(c as u8);
    }
    let cp = u32::from(c);
    if (0x0300..=0x036F).contains(&cp) {
        return Fold::Mark;
    }
    match FOLDED.binary_search_by_key(&cp, |(key, _)| *key) {
        Ok(i) => Fold::Ascii(FOLDED[i].1),
        Err(_) => Fold::Other,
    }
}

/// Every code point that survives the fold as an ASCII letter or digit.
///
/// The original reaches this through `String.prototype.normalize('NFD')`, and a
/// full canonical decomposition is a large slice of the Unicode database to
/// carry for one transfer note. It is not needed: the only thing NFD can change
/// about the answer is whether a character leaves an ASCII base behind once its
/// combining marks are deleted. Everything else — Greek, Cyrillic, Hangul,
/// emoji, punctuation — becomes a separator either way, and separators collapse.
///
/// So this table is that question answered once, for all 1,114,112 code points,
/// by running the original: a code point is listed here exactly when
/// `sanitizeReference` folds it to a single ASCII character. `Đ`/`đ` (U+0110,
/// U+0111) are in the list because of the explicit `replace` that follows the
/// decomposition, not because NFD touches them. Everything absent is a
/// separator, except U+0300..U+036F which is handled above.
#[rustfmt::skip]
const FOLDED: &[(u32, u8)] = &[
    // Latin-1 Supplement
    (0x00C0, b'A'), (0x00C1, b'A'), (0x00C2, b'A'), (0x00C3, b'A'), (0x00C4, b'A'), (0x00C5, b'A'),
    (0x00C7, b'C'), (0x00C8, b'E'), (0x00C9, b'E'), (0x00CA, b'E'), (0x00CB, b'E'), (0x00CC, b'I'),
    (0x00CD, b'I'), (0x00CE, b'I'), (0x00CF, b'I'), (0x00D1, b'N'), (0x00D2, b'O'), (0x00D3, b'O'),
    (0x00D4, b'O'), (0x00D5, b'O'), (0x00D6, b'O'), (0x00D9, b'U'), (0x00DA, b'U'), (0x00DB, b'U'),
    (0x00DC, b'U'), (0x00DD, b'Y'), (0x00E0, b'a'), (0x00E1, b'a'), (0x00E2, b'a'), (0x00E3, b'a'),
    (0x00E4, b'a'), (0x00E5, b'a'), (0x00E7, b'c'), (0x00E8, b'e'), (0x00E9, b'e'), (0x00EA, b'e'),
    (0x00EB, b'e'), (0x00EC, b'i'), (0x00ED, b'i'), (0x00EE, b'i'), (0x00EF, b'i'), (0x00F1, b'n'),
    (0x00F2, b'o'), (0x00F3, b'o'), (0x00F4, b'o'), (0x00F5, b'o'), (0x00F6, b'o'), (0x00F9, b'u'),
    (0x00FA, b'u'), (0x00FB, b'u'), (0x00FC, b'u'), (0x00FD, b'y'), (0x00FF, b'y'),

    // Latin Extended-A
    (0x0100, b'A'), (0x0101, b'a'), (0x0102, b'A'), (0x0103, b'a'), (0x0104, b'A'), (0x0105, b'a'),
    (0x0106, b'C'), (0x0107, b'c'), (0x0108, b'C'), (0x0109, b'c'), (0x010A, b'C'), (0x010B, b'c'),
    (0x010C, b'C'), (0x010D, b'c'), (0x010E, b'D'), (0x010F, b'd'), (0x0110, b'D'), (0x0111, b'd'),
    (0x0112, b'E'), (0x0113, b'e'), (0x0114, b'E'), (0x0115, b'e'), (0x0116, b'E'), (0x0117, b'e'),
    (0x0118, b'E'), (0x0119, b'e'), (0x011A, b'E'), (0x011B, b'e'), (0x011C, b'G'), (0x011D, b'g'),
    (0x011E, b'G'), (0x011F, b'g'), (0x0120, b'G'), (0x0121, b'g'), (0x0122, b'G'), (0x0123, b'g'),
    (0x0124, b'H'), (0x0125, b'h'), (0x0128, b'I'), (0x0129, b'i'), (0x012A, b'I'), (0x012B, b'i'),
    (0x012C, b'I'), (0x012D, b'i'), (0x012E, b'I'), (0x012F, b'i'), (0x0130, b'I'), (0x0134, b'J'),
    (0x0135, b'j'), (0x0136, b'K'), (0x0137, b'k'), (0x0139, b'L'), (0x013A, b'l'), (0x013B, b'L'),
    (0x013C, b'l'), (0x013D, b'L'), (0x013E, b'l'), (0x0143, b'N'), (0x0144, b'n'), (0x0145, b'N'),
    (0x0146, b'n'), (0x0147, b'N'), (0x0148, b'n'), (0x014C, b'O'), (0x014D, b'o'), (0x014E, b'O'),
    (0x014F, b'o'), (0x0150, b'O'), (0x0151, b'o'), (0x0154, b'R'), (0x0155, b'r'), (0x0156, b'R'),
    (0x0157, b'r'), (0x0158, b'R'), (0x0159, b'r'), (0x015A, b'S'), (0x015B, b's'), (0x015C, b'S'),
    (0x015D, b's'), (0x015E, b'S'), (0x015F, b's'), (0x0160, b'S'), (0x0161, b's'), (0x0162, b'T'),
    (0x0163, b't'), (0x0164, b'T'), (0x0165, b't'), (0x0168, b'U'), (0x0169, b'u'), (0x016A, b'U'),
    (0x016B, b'u'), (0x016C, b'U'), (0x016D, b'u'), (0x016E, b'U'), (0x016F, b'u'), (0x0170, b'U'),
    (0x0171, b'u'), (0x0172, b'U'), (0x0173, b'u'), (0x0174, b'W'), (0x0175, b'w'), (0x0176, b'Y'),
    (0x0177, b'y'), (0x0178, b'Y'), (0x0179, b'Z'), (0x017A, b'z'), (0x017B, b'Z'), (0x017C, b'z'),
    (0x017D, b'Z'), (0x017E, b'z'),

    // Latin Extended-B
    (0x01A0, b'O'), (0x01A1, b'o'), (0x01AF, b'U'), (0x01B0, b'u'), (0x01CD, b'A'), (0x01CE, b'a'),
    (0x01CF, b'I'), (0x01D0, b'i'), (0x01D1, b'O'), (0x01D2, b'o'), (0x01D3, b'U'), (0x01D4, b'u'),
    (0x01D5, b'U'), (0x01D6, b'u'), (0x01D7, b'U'), (0x01D8, b'u'), (0x01D9, b'U'), (0x01DA, b'u'),
    (0x01DB, b'U'), (0x01DC, b'u'), (0x01DE, b'A'), (0x01DF, b'a'), (0x01E0, b'A'), (0x01E1, b'a'),
    (0x01E6, b'G'), (0x01E7, b'g'), (0x01E8, b'K'), (0x01E9, b'k'), (0x01EA, b'O'), (0x01EB, b'o'),
    (0x01EC, b'O'), (0x01ED, b'o'), (0x01F0, b'j'), (0x01F4, b'G'), (0x01F5, b'g'), (0x01F8, b'N'),
    (0x01F9, b'n'), (0x01FA, b'A'), (0x01FB, b'a'), (0x0200, b'A'), (0x0201, b'a'), (0x0202, b'A'),
    (0x0203, b'a'), (0x0204, b'E'), (0x0205, b'e'), (0x0206, b'E'), (0x0207, b'e'), (0x0208, b'I'),
    (0x0209, b'i'), (0x020A, b'I'), (0x020B, b'i'), (0x020C, b'O'), (0x020D, b'o'), (0x020E, b'O'),
    (0x020F, b'o'), (0x0210, b'R'), (0x0211, b'r'), (0x0212, b'R'), (0x0213, b'r'), (0x0214, b'U'),
    (0x0215, b'u'), (0x0216, b'U'), (0x0217, b'u'), (0x0218, b'S'), (0x0219, b's'), (0x021A, b'T'),
    (0x021B, b't'), (0x021E, b'H'), (0x021F, b'h'), (0x0226, b'A'), (0x0227, b'a'), (0x0228, b'E'),
    (0x0229, b'e'), (0x022A, b'O'), (0x022B, b'o'), (0x022C, b'O'), (0x022D, b'o'), (0x022E, b'O'),
    (0x022F, b'o'), (0x0230, b'O'), (0x0231, b'o'), (0x0232, b'Y'), (0x0233, b'y'),

    // Latin Extended Additional — where the Vietnamese vowels live
    (0x1E00, b'A'), (0x1E01, b'a'), (0x1E02, b'B'), (0x1E03, b'b'), (0x1E04, b'B'), (0x1E05, b'b'),
    (0x1E06, b'B'), (0x1E07, b'b'), (0x1E08, b'C'), (0x1E09, b'c'), (0x1E0A, b'D'), (0x1E0B, b'd'),
    (0x1E0C, b'D'), (0x1E0D, b'd'), (0x1E0E, b'D'), (0x1E0F, b'd'), (0x1E10, b'D'), (0x1E11, b'd'),
    (0x1E12, b'D'), (0x1E13, b'd'), (0x1E14, b'E'), (0x1E15, b'e'), (0x1E16, b'E'), (0x1E17, b'e'),
    (0x1E18, b'E'), (0x1E19, b'e'), (0x1E1A, b'E'), (0x1E1B, b'e'), (0x1E1C, b'E'), (0x1E1D, b'e'),
    (0x1E1E, b'F'), (0x1E1F, b'f'), (0x1E20, b'G'), (0x1E21, b'g'), (0x1E22, b'H'), (0x1E23, b'h'),
    (0x1E24, b'H'), (0x1E25, b'h'), (0x1E26, b'H'), (0x1E27, b'h'), (0x1E28, b'H'), (0x1E29, b'h'),
    (0x1E2A, b'H'), (0x1E2B, b'h'), (0x1E2C, b'I'), (0x1E2D, b'i'), (0x1E2E, b'I'), (0x1E2F, b'i'),
    (0x1E30, b'K'), (0x1E31, b'k'), (0x1E32, b'K'), (0x1E33, b'k'), (0x1E34, b'K'), (0x1E35, b'k'),
    (0x1E36, b'L'), (0x1E37, b'l'), (0x1E38, b'L'), (0x1E39, b'l'), (0x1E3A, b'L'), (0x1E3B, b'l'),
    (0x1E3C, b'L'), (0x1E3D, b'l'), (0x1E3E, b'M'), (0x1E3F, b'm'), (0x1E40, b'M'), (0x1E41, b'm'),
    (0x1E42, b'M'), (0x1E43, b'm'), (0x1E44, b'N'), (0x1E45, b'n'), (0x1E46, b'N'), (0x1E47, b'n'),
    (0x1E48, b'N'), (0x1E49, b'n'), (0x1E4A, b'N'), (0x1E4B, b'n'), (0x1E4C, b'O'), (0x1E4D, b'o'),
    (0x1E4E, b'O'), (0x1E4F, b'o'), (0x1E50, b'O'), (0x1E51, b'o'), (0x1E52, b'O'), (0x1E53, b'o'),
    (0x1E54, b'P'), (0x1E55, b'p'), (0x1E56, b'P'), (0x1E57, b'p'), (0x1E58, b'R'), (0x1E59, b'r'),
    (0x1E5A, b'R'), (0x1E5B, b'r'), (0x1E5C, b'R'), (0x1E5D, b'r'), (0x1E5E, b'R'), (0x1E5F, b'r'),
    (0x1E60, b'S'), (0x1E61, b's'), (0x1E62, b'S'), (0x1E63, b's'), (0x1E64, b'S'), (0x1E65, b's'),
    (0x1E66, b'S'), (0x1E67, b's'), (0x1E68, b'S'), (0x1E69, b's'), (0x1E6A, b'T'), (0x1E6B, b't'),
    (0x1E6C, b'T'), (0x1E6D, b't'), (0x1E6E, b'T'), (0x1E6F, b't'), (0x1E70, b'T'), (0x1E71, b't'),
    (0x1E72, b'U'), (0x1E73, b'u'), (0x1E74, b'U'), (0x1E75, b'u'), (0x1E76, b'U'), (0x1E77, b'u'),
    (0x1E78, b'U'), (0x1E79, b'u'), (0x1E7A, b'U'), (0x1E7B, b'u'), (0x1E7C, b'V'), (0x1E7D, b'v'),
    (0x1E7E, b'V'), (0x1E7F, b'v'), (0x1E80, b'W'), (0x1E81, b'w'), (0x1E82, b'W'), (0x1E83, b'w'),
    (0x1E84, b'W'), (0x1E85, b'w'), (0x1E86, b'W'), (0x1E87, b'w'), (0x1E88, b'W'), (0x1E89, b'w'),
    (0x1E8A, b'X'), (0x1E8B, b'x'), (0x1E8C, b'X'), (0x1E8D, b'x'), (0x1E8E, b'Y'), (0x1E8F, b'y'),
    (0x1E90, b'Z'), (0x1E91, b'z'), (0x1E92, b'Z'), (0x1E93, b'z'), (0x1E94, b'Z'), (0x1E95, b'z'),
    (0x1E96, b'h'), (0x1E97, b't'), (0x1E98, b'w'), (0x1E99, b'y'), (0x1EA0, b'A'), (0x1EA1, b'a'),
    (0x1EA2, b'A'), (0x1EA3, b'a'), (0x1EA4, b'A'), (0x1EA5, b'a'), (0x1EA6, b'A'), (0x1EA7, b'a'),
    (0x1EA8, b'A'), (0x1EA9, b'a'), (0x1EAA, b'A'), (0x1EAB, b'a'), (0x1EAC, b'A'), (0x1EAD, b'a'),
    (0x1EAE, b'A'), (0x1EAF, b'a'), (0x1EB0, b'A'), (0x1EB1, b'a'), (0x1EB2, b'A'), (0x1EB3, b'a'),
    (0x1EB4, b'A'), (0x1EB5, b'a'), (0x1EB6, b'A'), (0x1EB7, b'a'), (0x1EB8, b'E'), (0x1EB9, b'e'),
    (0x1EBA, b'E'), (0x1EBB, b'e'), (0x1EBC, b'E'), (0x1EBD, b'e'), (0x1EBE, b'E'), (0x1EBF, b'e'),
    (0x1EC0, b'E'), (0x1EC1, b'e'), (0x1EC2, b'E'), (0x1EC3, b'e'), (0x1EC4, b'E'), (0x1EC5, b'e'),
    (0x1EC6, b'E'), (0x1EC7, b'e'), (0x1EC8, b'I'), (0x1EC9, b'i'), (0x1ECA, b'I'), (0x1ECB, b'i'),
    (0x1ECC, b'O'), (0x1ECD, b'o'), (0x1ECE, b'O'), (0x1ECF, b'o'), (0x1ED0, b'O'), (0x1ED1, b'o'),
    (0x1ED2, b'O'), (0x1ED3, b'o'), (0x1ED4, b'O'), (0x1ED5, b'o'), (0x1ED6, b'O'), (0x1ED7, b'o'),
    (0x1ED8, b'O'), (0x1ED9, b'o'), (0x1EDA, b'O'), (0x1EDB, b'o'), (0x1EDC, b'O'), (0x1EDD, b'o'),
    (0x1EDE, b'O'), (0x1EDF, b'o'), (0x1EE0, b'O'), (0x1EE1, b'o'), (0x1EE2, b'O'), (0x1EE3, b'o'),
    (0x1EE4, b'U'), (0x1EE5, b'u'), (0x1EE6, b'U'), (0x1EE7, b'u'), (0x1EE8, b'U'), (0x1EE9, b'u'),
    (0x1EEA, b'U'), (0x1EEB, b'u'), (0x1EEC, b'U'), (0x1EED, b'u'), (0x1EEE, b'U'), (0x1EEF, b'u'),
    (0x1EF0, b'U'), (0x1EF1, b'u'), (0x1EF2, b'Y'), (0x1EF3, b'y'), (0x1EF4, b'Y'), (0x1EF5, b'y'),
    (0x1EF6, b'Y'), (0x1EF7, b'y'), (0x1EF8, b'Y'), (0x1EF9, b'y'),

    // Letterlike Symbols — the two whose canonical form is a plain letter
    (0x212A, b'K'), (0x212B, b'A'),
];

/// Build the payload a banking app expects to find in the QR.
///
/// The amount is written as an integer string because VND has no subunit —
/// putting `70000.00` here would be read by some apps as a different number.
pub fn build_vietqr_payload(input: &VietQrInput) -> Result<String, String> {
    let bin = input.bank_bin.trim();
    let account = input.account_number.trim();
    if bin.len() != 6 || !bin.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("vietqr: bank BIN must be six digits, got \"{bin}\""));
    }
    if !account.bytes().all(|b| b.is_ascii_alphanumeric()) || !(4..=19).contains(&account.len()) {
        return Err("vietqr: account number must be 4-19 letters or digits".to_string());
    }

    let amount = input.amount.filter(|dong| *dong > 0);

    let beneficiary = field("00", bin)? + &field("01", account)?;
    let napas = field("00", NAPAS_GUID)?
        + &field("01", &beneficiary)?
        + &field("02", SERVICE_TRANSFER_TO_ACCOUNT)?;

    let reference = input.reference.map(sanitize_reference).unwrap_or_default();

    // "12" fills the amount in and locks it; "11" asks for it to stay editable,
    // which nothing honours. See the note at the top of the file.
    let locked = amount.is_some() && !input.amount_editable;

    let mut body = field("00", "01")?;
    body += &field("01", if locked { "12" } else { "11" })?;
    body += &field("38", &napas)?;
    body += &field("53", CURRENCY_VND)?;
    if let Some(dong) = amount {
        body += &field("54", &dong.to_string())?;
    }
    body += &field("58", COUNTRY_VN)?;
    if !reference.is_empty() {
        body += &field("62", &field("08", &reference)?)?;
    }

    // The CRC covers its own tag and length, so they are appended before hashing.
    let with_crc_header = body + "6304";
    let crc = crc16(&with_crc_header);
    Ok(with_crc_header + &crc)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A published VietQR, used by the original as its known-good CRC vector.
    const PUBLISHED: &str = "00020001021238570010A00000072701270006970436011308810004580860208QRIBFTTA53037045802VN6304CD60";

    /// `(input, crc16(input))` straight out of `shared/src/vietqr.ts`.
    #[rustfmt::skip]
    const CRC_VECTORS: &[(&str, &str)] = &[
        ("", "FFFF"),
        ("0", "D7A3"),
        ("a", "9D77"),
        ("A", "B915"),
        ("123456789", "29B1"),
        ("QRIBFTTA", "1171"),
        ("00020001021238570010A00000072701270006970436011308810004580860208QRIBFTTA53037045802VN6304", "CD60"),
        ("00020001021238570010A00000072701270006970436011308810004580860208QRIBFTTA53037045802VN6304CD60", "BC04"),
        ("6304", "6007"),
        ("00020101021138570010A00000072701270006970436011308810004580860208QRIBFTTA53037045802VN6304", "BE11"),
        ("S\u{e2}n B\u{f3}ng", "90B2"),
        ("\u{1016}\u{1030}\u{1006}\u{101a}\u{103a}", "3D3B"),
        // Above U+00FF the original's register drops the high byte: U+00FF and
        // U+FFFF check-sum identically, and that is deliberately reproduced.
        ("\u{ff}", "FF00"),
        ("\u{100}", "E1F0"),
        ("\u{ffff}", "FF00"),
        ("\u{1f389}", "5D56"),
        ("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "CEFE"),
    ];

    #[test]
    fn the_checksum_answers_what_the_original_answers() {
        for &(input, expected) in CRC_VECTORS {
            assert_eq!(crc16(input), expected, "crc16({input:?})");
        }
    }

    #[test]
    fn the_published_payload_checks_out() {
        assert_eq!(crc16(&PUBLISHED[..PUBLISHED.len() - 4]), "CD60");
        assert_eq!(&PUBLISHED[PUBLISHED.len() - 4..], "CD60");
    }

    /// `(text, sanitizeReference(text))` straight out of `shared/src/vietqr.ts`.
    #[rustfmt::skip]
    const REFERENCE_VECTORS: &[(&str, &str)] = &[
        ("", ""),
        (" ", ""),
        ("   \t\n  ", ""),
        ("abc", "abc"),
        ("Futsal 14 Aug Bao", "Futsal 14 Aug Bao"),
        ("S\u{e2}n B\u{f3}ng Tao \u{110}\u{e0}n", "San Bong Tao Dan"),
        ("Futsal \u{2014} 14/08", "Futsal 14 08"),
        ("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
         "xxxxxxxxxxxxxxxxxxxxxxxxx"),
        ("\u{1016}\u{1030}\u{1006}\u{101a}\u{103a}", ""),
        ("Nguy\u{1ec5}n V\u{103}n Aa", "Nguyen Van Aa"),
        ("\u{110}\u{1eb6}NG \u{111}\u{ec}nh", "DANG dinh"),
        ("\u{111}", "d"),
        ("\u{110}", "D"),
        ("a\u{301}b", "ab"),
        // U+0344 decomposes to two marks, so it vanishes rather than separating.
        ("a\u{344}b", "ab"),
        ("a\u{300}\u{301}\u{302}b", "ab"),
        ("\u{301}", ""),
        ("e\u{301}", "e"),
        ("Caf\u{e9}", "Cafe"),
        ("Cafe\u{301}", "Cafe"),
        ("  leading and trailing  ", "leading and trailing"),
        ("a--b__c", "a b c"),
        ("a\tb\nc", "a b c"),
        ("a!!!!!!!!b", "a b"),
        ("\u{20ac}100", "100"),
        ("1.234.000d", "1 234 000d"),
        ("emoji \u{1f389} test", "emoji test"),
        ("\u{110}\u{c0} N\u{1eb4}NG 12/08 san 5", "DA NANG 12 08 san 5"),
        ("\u{bd}", ""),
        ("\u{216b}", ""),
        ("\u{212b}", "A"),
        ("\u{212a}", "K"),
        ("\u{2460}", ""),
        ("\u{fb01}", ""),
        ("\u{d55c}\u{ad6d}", ""),
        ("\u{f1}", "n"),
        ("\u{df}", ""),
        ("\u{c6}", ""),
        ("\u{d8}", ""),
        ("\u{f8}", ""),
        ("\u{141}", ""),
        ("\u{142}", ""),
        ("\u{130}", "I"),
        ("\u{131}", ""),
        ("a\u{a0}b", "a b"),
        ("a\u{2009}b", "a b"),
        ("a\u{3000}b", "a b"),
        ("a\u{feff}b", "a b"),
        ("a\u{85}b", "a b"),
        ("\u{feff}", ""),
        ("abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx"),
        ("abcdefghijklmnopqrstuvwxy", "abcdefghijklmnopqrstuvwxy"),
        ("abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxy"),
        // The cut is after the trim, so the 25th character can be a space.
        ("aaaaaaaaaaaaaaaaaaaaaaaa b", "aaaaaaaaaaaaaaaaaaaaaaaa "),
        ("aaaaaaaaaaaaaaaaaaaaaaa bc", "aaaaaaaaaaaaaaaaaaaaaaa b"),
        ("aaaaaaaaaaaaaaaaaaaaaaaaa b", "aaaaaaaaaaaaaaaaaaaaaaaaa"),
        ("aaaaaaaaaaaaaaaaaaaaaaaa   b", "aaaaaaaaaaaaaaaaaaaaaaaa "),
        ("Thanh toan san bong thu 6 tuan nay", "Thanh toan san bong thu 6"),
        ("TT 07/08 - Bao (2 khach)", "TT 07 08 Bao 2 khach"),
        ("   ---   ", ""),
        ("----------------------------------------", ""),
        ("0123456789", "0123456789"),
        ("\u{ff21}\u{ff42}\u{ff11}", ""),
        ("\u{ff21}\u{ff22}\u{ff23}", ""),
        ("\u{2170}\u{2171}", ""),
        ("A\u{327}", "A"),
        ("\u{e7}", "c"),
        ("c\u{327}", "c"),
        ("Ho Chi Minh City", "Ho Chi Minh City"),
        ("S\u{e2}n 5 \u{2014} 19:30 \u{2014} Tao \u{110}\u{e0}n", "San 5 19 30 Tao Dan"),
        ("\u{110}\u{111}\u{110}\u{111}", "DdDd"),
        ("Ng\u{f4} B\u{1ea3}o Ch\u{e2}u", "Ngo Bao Chau"),
        ("\u{c1}\u{c0}\u{1ea2}\u{c3}\u{1ea0}", "AAAAA"),
        ("\u{103}\u{e2}\u{ea}\u{f4}\u{1a1}\u{1b0}", "aaeoou"),
        ("\u{102}\u{c2}\u{ca}\u{d4}\u{1a0}\u{1af}", "AAEOOU"),
        ("y\u{1ef3}\u{fd}\u{1ef7}\u{1ef9}\u{1ef5}", "yyyyyy"),
    ];

    #[test]
    fn a_note_is_folded_the_way_the_original_folds_it() {
        for &(text, expected) in REFERENCE_VECTORS {
            let got = sanitize_reference(text);
            assert_eq!(got, expected, "sanitize_reference({text:?})");
            assert!(got.len() <= MAX_REFERENCE);
            assert!(got.bytes().all(|b| b.is_ascii_alphanumeric() || b == b' '));
        }
    }

    /// `(bank_bin, account_number, amount, reference, amount_editable, payload)`
    /// — every payload string is what `buildVietQrPayload` returned.
    #[rustfmt::skip]
    const PAYLOAD_VECTORS: &[(&str, &str, Option<i64>, Option<&str>, bool, &str)] = &[
        ("970436", "0881000458086", Some(70000), Some("Futsal 14 Aug Bao"), false,
         "00020101021238570010A00000072701270006970436011308810004580860208QRIBFTTA53037045405700005802VN62210817Futsal 14 Aug Bao6304E53E"),
        ("970436", "0881000458086", Some(70000), Some("Futsal 14 Aug Bao"), true,
         "00020101021138570010A00000072701270006970436011308810004580860208QRIBFTTA53037045405700005802VN62210817Futsal 14 Aug Bao630420F7"),
        ("970436", "0881000458086", None, Some("Futsal 14 Aug Bao"), false,
         "00020101021138570010A00000072701270006970436011308810004580860208QRIBFTTA53037045802VN62210817Futsal 14 Aug Bao6304EE00"),
        ("970436", "0881000458086", Some(0), Some("Futsal 14 Aug Bao"), false,
         "00020101021138570010A00000072701270006970436011308810004580860208QRIBFTTA53037045802VN62210817Futsal 14 Aug Bao6304EE00"),
        ("970436", "0881000458086", Some(-5), Some("Futsal 14 Aug Bao"), false,
         "00020101021138570010A00000072701270006970436011308810004580860208QRIBFTTA53037045802VN62210817Futsal 14 Aug Bao6304EE00"),
        ("970436", "0881000458086", None, None, true,
         "00020101021138570010A00000072701270006970436011308810004580860208QRIBFTTA53037045802VN6304BE11"),
        ("970436", "0881000458086", None, None, false,
         "00020101021138570010A00000072701270006970436011308810004580860208QRIBFTTA53037045802VN6304BE11"),
        ("970436", "0881000458086", Some(1), None, false,
         "00020101021238570010A00000072701270006970436011308810004580860208QRIBFTTA5303704540115802VN63047B7C"),
        ("970436", "0881000458086", Some(999999999), None, false,
         "00020101021238570010A00000072701270006970436011308810004580860208QRIBFTTA530370454099999999995802VN6304A9A2"),
        ("970436", "0881000458086", Some(1000), Some(""), false,
         "00020101021238570010A00000072701270006970436011308810004580860208QRIBFTTA5303704540410005802VN6304BF7E"),
        ("970436", "0881000458086", Some(1000), Some("   "), false,
         "00020101021238570010A00000072701270006970436011308810004580860208QRIBFTTA5303704540410005802VN6304BF7E"),
        ("970436", "0881000458086", Some(1000), Some("\u{1016}\u{1030}\u{1006}\u{101a}\u{103a}"), false,
         "00020101021238570010A00000072701270006970436011308810004580860208QRIBFTTA5303704540410005802VN6304BF7E"),
        ("970436", "0881000458086", Some(1000), Some("S\u{e2}n B\u{f3}ng Tao \u{110}\u{e0}n"), false,
         "00020101021238570010A00000072701270006970436011308810004580860208QRIBFTTA5303704540410005802VN62200816San Bong Tao Dan6304E0BA"),
        ("970436", "0881000458086", Some(1000),
         Some("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), false,
         "00020101021238570010A00000072701270006970436011308810004580860208QRIBFTTA5303704540410005802VN62290825xxxxxxxxxxxxxxxxxxxxxxxxx6304C8B4"),
        ("970418", "1234", Some(70000), Some("a"), false,
         "00020101021238480010A00000072701180006970418010412340208QRIBFTTA53037045405700005802VN62050801a6304C81A"),
        ("970415", "1234567890123456789", Some(999999999), Some("abcdefghijklmnopqrstuvwxyz1234"), false,
         "00020101021238630010A00000072701330006970415011912345678901234567890208QRIBFTTA530370454099999999995802VN62290825abcdefghijklmnopqrstuvwxy6304B6A7"),
        ("546034", "AbC123", Some(250000), Some("San 5 19h30"), false,
         "00020101021238500010A000000727012000065460340106AbC1230208QRIBFTTA530370454062500005802VN62150811San 5 19h30630486D9"),
        ("971025", "0909123456", Some(35000), Some("TT 07/08 - Bao (2 khach)"), false,
         "00020101021238540010A00000072701240006971025011009091234560208QRIBFTTA53037045405350005802VN62240820TT 07 08 Bao 2 khach63048126"),
        (" 970436 ", " 0881000458086 ", Some(70000), Some("Trimmed"), false,
         "00020101021238570010A00000072701270006970436011308810004580860208QRIBFTTA53037045405700005802VN62110807Trimmed63043188"),
        ("963388", "9999", Some(1000000000), Some("Round trip"), false,
         "00020101021238480010A00000072701180006963388010499990208QRIBFTTA5303704541010000000005802VN62140810Round trip6304FDEE"),
    ];

    #[test]
    fn every_payload_is_byte_for_byte_the_originals() {
        for &(bank_bin, account_number, amount, reference, amount_editable, expected) in
            PAYLOAD_VECTORS
        {
            let input =
                VietQrInput { bank_bin, account_number, amount, reference, amount_editable };
            assert_eq!(build_vietqr_payload(&input), Ok(expected.to_string()), "{input:?}");
        }
    }

    #[test]
    fn every_payload_carries_a_checksum_that_verifies_itself() {
        for &(.., expected) in PAYLOAD_VECTORS {
            let (body, crc) = expected.split_at(expected.len() - 4);
            assert_eq!(crc16(body), crc, "{expected}");
        }
    }

    /// `(bank_bin, account_number, thrown message)`.
    #[rustfmt::skip]
    const REFUSALS: &[(&str, &str, &str)] = &[
        ("97043", "0881000458086", "vietqr: bank BIN must be six digits, got \"97043\""),
        ("9704360", "0881000458086", "vietqr: bank BIN must be six digits, got \"9704360\""),
        ("97o436", "0881000458086", "vietqr: bank BIN must be six digits, got \"97o436\""),
        ("", "0881000458086", "vietqr: bank BIN must be six digits, got \"\""),
        // A fullwidth digit is not a digit; the message quotes it back verbatim.
        ("97043\u{ff16}", "0881000458086",
         "vietqr: bank BIN must be six digits, got \"97043\u{ff16}\""),
        ("970436", "", "vietqr: account number must be 4-19 letters or digits"),
        ("970436", "123", "vietqr: account number must be 4-19 letters or digits"),
        ("970436", "0881-0004", "vietqr: account number must be 4-19 letters or digits"),
        ("970436", "12345678901234567890",
         "vietqr: account number must be 4-19 letters or digits"),
        ("970436", "ab cd", "vietqr: account number must be 4-19 letters or digits"),
    ];

    #[test]
    fn a_refused_account_is_refused_with_the_originals_words() {
        for &(bank_bin, account_number, message) in REFUSALS {
            let input = VietQrInput::new(bank_bin, account_number);
            assert_eq!(build_vietqr_payload(&input), Err(message.to_string()), "{input:?}");
        }
    }

    #[test]
    fn a_field_is_a_tag_a_two_digit_length_and_a_value() {
        assert_eq!(field("00", "01"), Ok("000201".to_string()));
        assert_eq!(field("38", ""), Ok("3800".to_string()));
        assert_eq!(field("62", &"x".repeat(99)), Ok(format!("6299{}", "x".repeat(99))));
        assert_eq!(
            field("62", &"x".repeat(100)),
            Err("vietqr: field 62 is 100 chars, max 99".to_string())
        );
    }
}
