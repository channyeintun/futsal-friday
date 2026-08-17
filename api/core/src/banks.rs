//! The banks a VietQR can be addressed to.
//!
//! A trimmed NAPAS list — the ones a Ho Chi Minh City friend group plausibly
//! banks with, plus the wallets, rather than all sixty-odd including foreign
//! branch offices. `bin` is the acquirer id VietQR identifies a bank by and is
//! the only field that must be exact; the names are for the picker.
//!
//! Shipped as data rather than fetched, deliberately. A remote list would put a
//! third party between the organizer and their own account number, and add a
//! network dependency to a screen that has to work when somebody is standing at
//! a pitch with one bar of signal.
//!
//! Ported from `shared/src/banks.ts`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bank {
    /// NAPAS acquirer id, six digits.
    pub bin: &'static str,
    pub name: &'static str,
}

/// The picker list, in the order it is shown — busiest banks first, then the
/// wallets. The order is part of the UI, so it is written out rather than sorted.
pub static BANKS: [Bank; 28] = [
    Bank { bin: "970436", name: "Vietcombank" },
    Bank { bin: "970415", name: "VietinBank" },
    Bank { bin: "970418", name: "BIDV" },
    Bank { bin: "970405", name: "Agribank" },
    Bank { bin: "970422", name: "MB Bank" },
    Bank { bin: "970407", name: "Techcombank" },
    Bank { bin: "970416", name: "ACB" },
    Bank { bin: "970432", name: "VPBank" },
    Bank { bin: "970423", name: "TPBank" },
    Bank { bin: "970403", name: "Sacombank" },
    Bank { bin: "970437", name: "HDBank" },
    Bank { bin: "970448", name: "OCB" },
    Bank { bin: "970441", name: "VIB" },
    Bank { bin: "970443", name: "SHB" },
    Bank { bin: "970431", name: "Eximbank" },
    Bank { bin: "970426", name: "MSB" },
    Bank { bin: "970440", name: "SeABank" },
    Bank { bin: "970449", name: "LPBank" },
    Bank { bin: "970429", name: "SCB" },
    Bank { bin: "970425", name: "ABBANK" },
    Bank { bin: "970428", name: "Nam A Bank" },
    Bank { bin: "970412", name: "PVcomBank" },
    Bank { bin: "970454", name: "BVBank" },
    Bank { bin: "963388", name: "Timo" },
    Bank { bin: "546034", name: "Cake by VPBank" },
    Bank { bin: "971025", name: "MoMo" },
    Bank { bin: "971005", name: "Viettel Money" },
    Bank { bin: "971011", name: "VNPT Money" },
];

/// The bank with this acquirer id, if it is one we ship.
///
/// Exact string equality on a six-digit code — no trimming, no case folding.
/// A BIN that is not in the list is not an error here: the QR only needs the
/// number, and the name is a label.
pub fn bank_by_bin(bin: &str) -> Option<&'static Bank> {
    BANKS.iter().find(|b| b.bin == bin)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `BANKS` verbatim from `shared/src/banks.ts`, in order.
    #[rustfmt::skip]
    const VECTORS: &[(&str, &str)] = &[
        ("970436", "Vietcombank"), ("970415", "VietinBank"), ("970418", "BIDV"),
        ("970405", "Agribank"), ("970422", "MB Bank"), ("970407", "Techcombank"),
        ("970416", "ACB"), ("970432", "VPBank"), ("970423", "TPBank"),
        ("970403", "Sacombank"), ("970437", "HDBank"), ("970448", "OCB"),
        ("970441", "VIB"), ("970443", "SHB"), ("970431", "Eximbank"),
        ("970426", "MSB"), ("970440", "SeABank"), ("970449", "LPBank"),
        ("970429", "SCB"), ("970425", "ABBANK"), ("970428", "Nam A Bank"),
        ("970412", "PVcomBank"), ("970454", "BVBank"), ("963388", "Timo"),
        ("546034", "Cake by VPBank"), ("971025", "MoMo"), ("971005", "Viettel Money"),
        ("971011", "VNPT Money"),
    ];

    #[test]
    fn the_list_matches_the_original_entry_for_entry() {
        assert_eq!(BANKS.len(), 28);
        assert_eq!(VECTORS.len(), 28);
        for (i, &(bin, name)) in VECTORS.iter().enumerate() {
            assert_eq!(BANKS[i].bin, bin, "bin at {i}");
            assert_eq!(BANKS[i].name, name, "name at {i}");
        }
    }

    #[test]
    fn every_bin_is_six_digits_and_unique() {
        for bank in &BANKS {
            assert_eq!(bank.bin.len(), 6, "{}", bank.name);
            assert!(bank.bin.bytes().all(|b| b.is_ascii_digit()), "{}", bank.name);
            assert_eq!(BANKS.iter().filter(|b| b.bin == bank.bin).count(), 1, "{}", bank.bin);
        }
    }

    #[test]
    fn a_bin_is_looked_up_by_exact_equality() {
        assert_eq!(bank_by_bin("970436").map(|b| b.name), Some("Vietcombank"));
        assert_eq!(bank_by_bin("546034").map(|b| b.name), Some("Cake by VPBank"));
        assert_eq!(bank_by_bin("971011").map(|b| b.name), Some("VNPT Money"));
        // `undefined` in the original, for anything not on the list.
        assert_eq!(bank_by_bin("000000"), None);
        assert_eq!(bank_by_bin(""), None);
        assert_eq!(bank_by_bin(" 970436"), None);
        assert_eq!(bank_by_bin("970436 "), None);
    }
}
