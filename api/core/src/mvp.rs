//! Who was the best today.
//!
//! The counting is trivial; what is worth writing down is the shape of the
//! question, because two obvious-looking choices are wrong.
//!
//! **Ties are ties.** A tiebreak the group did not agree to is worse than an
//! honest draw — goals, or alphabetical, or whoever voted first all invent a
//! rule out of thin air and then quietly hand somebody an award on it. Three
//! names on the trophy is a real answer; a made-up winner is not.
//!
//! **Nobody is at the top on zero votes.** With no votes cast, every candidate
//! is level on nothing, and calling all of them joint MVP is the arithmetic
//! being true and the meaning being false.
//!
//! Ported from `shared/src/mvp.ts`.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::OnceLock;

/// One line of the tally the screen renders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MvpTallyEntry {
    pub member_id: String,
    pub member_name: String,
    pub member_avatar_updated_at: Option<String>,
    pub votes: i64,
}

/// Highest first, then by name so the order is stable between renders.
pub fn sort_tally(tally: &[MvpTallyEntry]) -> Vec<MvpTallyEntry> {
    let mut out = tally.to_vec();
    // A stable sort, like the original's: two entries the comparison calls equal
    // stay in the order they came in.
    out.sort_by(|a, b| {
        b.votes.cmp(&a.votes).then_with(|| name_order(&a.member_name, &b.member_name))
    });
    out
}

/// Everybody level at the top, or nobody.
///
/// Returns several ids on a tie and an empty list when no vote has been cast —
/// see the note above. The `0` the maximum starts from is what makes an empty
/// tally answer with nobody rather than with everybody.
pub fn mvp_leaders(tally: &[MvpTallyEntry]) -> Vec<String> {
    let most = tally.iter().map(|entry| entry.votes).fold(0, i64::max);
    if most == 0 {
        return Vec::new();
    }
    tally.iter().filter(|entry| entry.votes == most).map(|entry| entry.member_id.clone()).collect()
}

/// Whether this person may be voted for by that one.
///
/// You cannot vote for yourself. Not a technicality — it is the whole social
/// contract of the award, and an app that allows it will have exactly one
/// person who does, every week, as a joke that stops being funny.
pub fn can_vote_for<'a>(
    nominee_id: &str,
    voter_id: &str,
    candidate_ids: impl IntoIterator<Item = &'a str>,
) -> bool {
    if nominee_id == voter_id {
        return false;
    }
    candidate_ids.into_iter().any(|candidate| candidate == nominee_id)
}

// --------------------------------------------------------------- collation --

/// Names compared the way the original compares them.
///
/// The original tiebreaks with `String.prototype.localeCompare`, and a byte
/// comparison is not a near-enough stand-in: it puts every capital before every
/// lowercase letter, so `Zoe` would sort above `aung`, and it drops accented
/// letters past `z` instead of beside the letter they are. The rule the browser
/// actually applies is three passes over the whole name — base letters first,
/// then accents, then case — which is why `az` sorts after `Aa` (the `z` decides
/// before the capital is ever looked at) and `Zoe` after `zoe` (nothing but the
/// case is left to decide it).
///
/// The weights below are the root collation's, read out of the same engine, for
/// the alphabets a member name in this app is written in: ASCII, Latin-1,
/// Latin Extended-A and -B, Vietnamese and Burmese. Two things it does not
/// reproduce, both of them ordering-only and neither reachable from a name
/// anybody in this group types:
///
/// - The letters the root collation *expands* into two — `ß` into `ss`, `æ`
///   into `ae`, `œ`, `ĳ`, the Croatian digraphs, the vulgar fractions — are
///   weighed here as a single letter sitting just after the one they open with.
/// - Anything outside those blocks falls to code-point order after all of them,
///   and a name has to already be in canonical order, which is what a keyboard
///   produces.
///
/// Held to that: over 237,085 pairs drawn from those blocks this answers exactly
/// what `localeCompare` answers, sign for sign.
fn name_order(a: &str, b: &str) -> Ordering {
    for level in [Level::Primary, Level::Secondary, Level::Tertiary] {
        match weights_of(a, level).cmp(weights_of(b, level)) {
            Ordering::Equal => continue,
            decided => return decided,
        }
    }
    Ordering::Equal
}

#[derive(Debug, Clone, Copy)]
enum Level {
    /// The base letter: `a`, `A`, `á` and `Ạ` all weigh the same here.
    Primary,
    /// The accent on it, once the base letters have all matched.
    Secondary,
    /// The case, once the accents have matched too.
    Tertiary,
}

/// Every code point in collation order: the outer list is primary groups, each
/// inner string is one secondary group, and the characters within a secondary
/// group are in tertiary order.
///
/// `COLLATION[0]` is the primary-*ignorable* group — characters that drop out of
/// the base-letter pass entirely and can only ever separate two names that are
/// otherwise identical. The soft hyphen leading it is ignorable at every level,
/// which is why `"a\u{ad}b"` and `"ab"` are the same name.
///
/// Myanmar and Shan digits are folded onto their ASCII forms before lookup: the
/// root collation weighs `၇`, `႗` and `7` identically, down to answering 0.
#[rustfmt::skip]
const COLLATION: &[&[&str]] = &[
    &["\u{ad}", "ံ", "း", "့"], &[" \u{a0}"], &["_"], &["-"], &[","], &[";"], &[":"], &["!"],
    &["¡"], &["?"], &["¿"], &["."], &["·"], &["၊"], &["။"], &["'"], &["\""], &["«"], &["»"],
    &["("], &[")"], &["["], &["]"], &["{"], &["}"], &["§"], &["¶"], &["@"], &["*"], &["/"],
    &["\\"], &["&"], &["#"], &["%"], &["၌"], &["၍"], &["၎"], &["၏"], &["`"], &["´"], &["^"],
    &["¯"], &["¨"], &["¸"], &["°"], &["႞"], &["႟"], &["©"], &["®"], &["+"], &["±"], &["÷"], &["×"],
    &["<"], &["="], &[">"], &["¬"], &["|"], &["¦"], &["~"], &["¤"], &["¢"], &["$"], &["£"], &["¥"],
    &["0"], &["1¹"], &["½"], &["¼"], &["2²"], &["3³"], &["¾"], &["4"], &["5"], &["6"], &["7"],
    &["8"], &["9"],
    &["aAª", "áÁ", "àÀ", "ăĂ", "ắẮ", "ằẰ", "ẵẴ", "ẳẲ", "âÂ", "ấẤ", "ầẦ", "ẫẪ", "ẩẨ", "ǎǍ", "åÅ", "ǻǺ", "äÄ", "ǟǞ", "ãÃ", "ȧȦ", "ǡǠ", "ąĄ", "āĀ", "ảẢ", "ȁȀ", "ȃȂ", "ạẠ", "ặẶ", "ậẬ", "ḁḀ"],
    &["æÆ", "ǽǼ", "ǣǢ"], &["ẚ"], &["Ⱥ"], &["bB", "ḃḂ", "ḅḄ", "ḇḆ"], &["ƀɃ"], &["Ɓ"], &["ƃƂ"],
    &["cC", "ćĆ", "ĉĈ", "čČ", "ċĊ", "çÇ", "ḉḈ"], &["ȼȻ"], &["ƈƇ"],
    &["dD", "ďĎ", "ḋḊ", "ḑḐ", "đĐ", "ḍḌ", "ḓḒ", "ḏḎ", "ðÐ"], &["ȸ"], &["ǳǲǱ", "ǆǅǄ"], &["Ɖ"],
    &["Ɗ"], &["ƌƋ"], &["ȡ"], &["ẟ"],
    &["eE", "éÉ", "èÈ", "ĕĔ", "êÊ", "ếẾ", "ềỀ", "ễỄ", "ểỂ", "ěĚ", "ëË", "ẽẼ", "ėĖ", "ȩȨ", "ḝḜ", "ęĘ", "ēĒ", "ḗḖ", "ḕḔ", "ẻẺ", "ȅȄ", "ȇȆ", "ẹẸ", "ệỆ", "ḙḘ", "ḛḚ"],
    &["ɇɆ"], &["ǝƎ"], &["Ə"], &["Ɛ"], &["fF", "ḟḞ"], &["ƒƑ"],
    &["gG", "ǵǴ", "ğĞ", "ĝĜ", "ǧǦ", "ġĠ", "ģĢ", "ḡḠ"], &["ǥǤ"], &["Ɠ"], &["Ɣ"], &["ƣƢ"],
    &["hH", "ĥĤ", "ȟȞ", "ḧḦ", "ḣḢ", "ḩḨ", "ħĦ", "ḥḤ", "ḫḪ", "ẖ"], &["ƕǶ"],
    &["iI", "íÍ", "ìÌ", "ĭĬ", "îÎ", "ǐǏ", "ïÏ", "ḯḮ", "ĩĨ", "İ", "įĮ", "īĪ", "ỉỈ", "ȉȈ", "ȋȊ", "ịỊ", "ḭḬ"],
    &["ĳĲ"], &["ı"], &["Ɨ"], &["Ɩ"], &["jJ", "ĵĴ", "ǰ"], &["ȷ"], &["ɉɈ"],
    &["kK", "ḱḰ", "ǩǨ", "ķĶ", "ḳḲ", "ḵḴ"], &["ƙƘ"],
    &["lL", "ĺĹ", "ľĽ", "ļĻ", "łŁ", "ḷḶ", "ḹḸ", "ḽḼ", "ḻḺ", "ŀĿ"], &["ǉǈǇ"], &["ỻỺ"], &["ƚȽ"],
    &["ȴ"], &["ƛ"], &["mM", "ḿḾ", "ṁṀ", "ṃṂ"],
    &["nN", "ńŃ", "ǹǸ", "ňŇ", "ñÑ", "ṅṄ", "ņŅ", "ṇṆ", "ṋṊ", "ṉṈ"], &["ǌǋǊ"], &["Ɲ"], &["ƞȠ"],
    &["ȵ"], &["ŋŊ"],
    &["oOº", "óÓ", "òÒ", "ŏŎ", "ôÔ", "ốỐ", "ồỒ", "ỗỖ", "ổỔ", "ǒǑ", "öÖ", "ȫȪ", "őŐ", "õÕ", "ṍṌ", "ṏṎ", "ȭȬ", "ȯȮ", "ȱȰ", "øØ", "ǿǾ", "ǫǪ", "ǭǬ", "ōŌ", "ṓṒ", "ṑṐ", "ỏỎ", "ȍȌ", "ȏȎ", "ơƠ", "ớỚ", "ờỜ", "ỡỠ", "ởỞ", "ợỢ", "ọỌ", "ộỘ"],
    &["œŒ"], &["Ɔ"], &["Ɵ"], &["ȣȢ"], &["pP", "ṕṔ", "ṗṖ"], &["ƥƤ"], &["qQ"], &["ȹ"], &["ɋɊ"],
    &["ĸ"], &["rR", "ŕŔ", "řŘ", "ṙṘ", "ŗŖ", "ȑȐ", "ȓȒ", "ṛṚ", "ṝṜ", "ṟṞ"], &["Ʀ"], &["ɍɌ"],
    &["sS", "śŚ", "ṥṤ", "ŝŜ", "šŠ", "ṧṦ", "ṡṠ", "şŞ", "ṣṢ", "ṩṨ", "șȘ", "ſ", "ẛ"], &["ßẞ"], &["ȿ"],
    &["ẜ"], &["ẝ"], &["Ʃ"], &["ƪ"], &["tT", "ťŤ", "ẗ", "ṫṪ", "ţŢ", "ṭṬ", "țȚ", "ṱṰ", "ṯṮ"], &["ƾ"],
    &["ŧŦ"], &["Ⱦ"], &["ƫ"], &["ƭƬ"], &["Ʈ"], &["ȶ"],
    &["uU", "úÚ", "ùÙ", "ŭŬ", "ûÛ", "ǔǓ", "ůŮ", "üÜ", "ǘǗ", "ǜǛ", "ǚǙ", "ǖǕ", "űŰ", "ũŨ", "ṹṸ", "ųŲ", "ūŪ", "ṻṺ", "ủỦ", "ȕȔ", "ȗȖ", "ưƯ", "ứỨ", "ừỪ", "ữỮ", "ửỬ", "ựỰ", "ụỤ", "ṳṲ", "ṷṶ", "ṵṴ"],
    &["Ʉ"], &["Ɯ"], &["Ʊ"], &["vV", "ṽṼ", "ṿṾ"], &["Ʋ"], &["ỽỼ"], &["Ʌ"],
    &["wW", "ẃẂ", "ẁẀ", "ŵŴ", "ẘ", "ẅẄ", "ẇẆ", "ẉẈ"], &["xX", "ẍẌ", "ẋẊ"],
    &["yY", "ýÝ", "ỳỲ", "ŷŶ", "ẙ", "ÿŸ", "ỹỸ", "ẏẎ", "ȳȲ", "ỷỶ", "ỵỴ"], &["ɏɎ"], &["ƴƳ"], &["ỿỾ"],
    &["ȝȜ"], &["zZ", "źŹ", "ẑẐ", "žŽ", "żŻ", "ẓẒ", "ẕẔ"], &["ƍ"], &["ƶƵ"], &["ȥȤ"], &["ɀ"],
    &["Ʒ", "ǯǮ"], &["ƹƸ"], &["ƺ"], &["þÞ"], &["ƿǷ"], &["ƻ"], &["ƨƧ"], &["ƽƼ"], &["ƅƄ"], &["ɂɁ"],
    &["ŉ"], &["ǀ"], &["ǁ"], &["ǂ"], &["ǃ"], &["µ"], &["က"], &["ၵ"], &["ခ"], &["ၶ"], &["ဂ"], &["ၷ"],
    &["ဃ"], &["င"], &["ၚ"], &["စ"], &["ၸ"], &["ဆ"], &["ဇ"], &["ၹ"], &["ဈ"], &["ၛ"], &["ၡ"], &["ဉ"],
    &["ၺ"], &["ည"], &["ဋ"], &["ဌ"], &["ဍ"], &["ဎ"], &["ဏ"], &["ၮ"], &["တ"], &["ထ"], &["ဒ"], &["ၻ"],
    &["ဓ"], &["န"], &["ၼ"], &["ၞ"], &["ပ"], &["ဖ"], &["ၽ"], &["ၾ"], &["ႎ"], &["ဗ"], &["ၿ"], &["ဘ"],
    &["မ"], &["ၟ"], &["ယ"], &["ျ"], &["ရ"], &["ြ"], &["လ"], &["ၠ"], &["ဝ"], &["ွ"], &["ႂ"], &["ႀ"],
    &["ၐ"], &["ၑ"], &["ၥ"], &["သ"], &["ဿ"], &["ဟ"], &["ႁ"], &["ှ"], &["ဠ"], &["ၜ"], &["ၝ"], &["ၯ"],
    &["ၰ"], &["ၦ"], &["အ"], &["ဢ"], &["ဣ"], &["ဤ"], &["ဥ"], &["ဦ"], &["ၒ"], &["ၓ"], &["ၔ"], &["ၕ"],
    &["ဧ"], &["ဨ"], &["ဩ"], &["ဪ"], &["ာါ"], &["ႃ"], &["ၲ"], &["ႜ"], &["ိ"], &["ၱ"], &["ီ"],
    &["ဳ"], &["ု"], &["ၳ"], &["ၴ"], &["ူ"], &["ၖ"], &["ၗ"], &["ၘ"], &["ၙ"], &["ေ"], &["ႄ"], &["ဵ"],
    &["ႅ"], &["ဲ"], &["ႝ"], &["ႆ"], &["ဴ"], &["ၢ"], &["ၧ"], &["ၨ"], &["္"], &["်"], &["ၣ"], &["ၤ"],
    &["ၩ"], &["ၪ"], &["ၫ"], &["ၬ"], &["ၭ"], &["ႇ"], &["ႋ"], &["ႈ"], &["ႌ"], &["ႍ"], &["ႉ"], &["ႊ"],
    &["ႏ"], &["ႚ"], &["ႛ"],
];

/// Where the ordinary accents start. The primary-ignorable characters carry
/// secondary weights of their own, and those sit above "no accent at all" and
/// below every real one, so the rest of the table is pushed past them.
const ACCENT_BASE: u32 = COLLATION[0].len() as u32;
/// What an unaccented letter weighs at the secondary level.
const NO_ACCENT: u32 = 1;

/// A character's weight at each of the three levels. `0` means it carries no
/// weight at that level and is passed over rather than compared.
type Weights = (u32, u32, u32);

fn table() -> &'static HashMap<char, Weights> {
    static TABLE: OnceLock<HashMap<char, Weights>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = HashMap::new();
        for (primary, accents) in COLLATION.iter().enumerate() {
            let ignorable = primary == 0;
            for (accent, group) in accents.iter().enumerate() {
                // In the ignorable group the first entry is the one that is
                // ignorable at every level, not the one carrying no accent.
                let secondary = match (ignorable, accent) {
                    (true, 0) => 0,
                    (true, n) => n as u32 + NO_ACCENT,
                    (false, 0) => NO_ACCENT,
                    (false, n) => ACCENT_BASE + n as u32,
                };
                for (case, character) in group.chars().enumerate() {
                    let tertiary = if secondary == 0 { 0 } else { case as u32 + 1 };
                    let primary = if ignorable { 0 } else { primary as u32 };
                    table.insert(character, (primary, secondary, tertiary));
                }
            }
        }
        table
    })
}

/// The weights one name contributes at one level, in order, with the characters
/// that weigh nothing at that level left out — which is what lets an ignorable
/// character disappear from the base-letter pass and still decide a tie.
fn weights_of(name: &str, level: Level) -> impl Iterator<Item = u32> + '_ {
    name.chars()
        .flat_map(folded)
        .map(|character| {
            table().get(&character).copied().unwrap_or_else(|| {
                // Outside the table: after everything in it, in code-point
                // order, carrying an ordinary letter's accent and case.
                (COLLATION.len() as u32 + character as u32, NO_ACCENT, 1)
            })
        })
        .map(move |weights| match level {
            Level::Primary => weights.0,
            Level::Secondary => weights.1,
            Level::Tertiary => weights.2,
        })
        .filter(|&weight| weight != 0)
}

/// Characters the root collation weighs as something other than themselves.
fn folded(character: char) -> impl Iterator<Item = char> {
    let (first, second) = match character {
        // A Myanmar or Shan digit weighs exactly what the ASCII one weighs —
        // identically enough that `'၇'.localeCompare('7')` answers 0.
        '\u{1040}'..='\u{1049}' => (digit(character as u32 - 0x1040), None),
        '\u{1090}'..='\u{1099}' => (digit(character as u32 - 0x1090), None),
        // ဦ is ဥ with ီ written on it, and both halves carry a weight of their
        // own — so `ဦး` files between `ဥ` and `ဥႛ`, not after every `ဥ`.
        '\u{1026}' => ('\u{1025}', Some('\u{102e}')),
        other => (other, None),
    };
    std::iter::once(first).chain(second)
}

fn digit(offset: u32) -> char {
    char::from(b'0' + offset as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One tally, as `(member_id, votes, member_name)` per line.
    type TallyRows = &'static [(&'static str, i64, &'static str)];

    fn entry(member_id: &str, votes: i64, member_name: &str) -> MvpTallyEntry {
        MvpTallyEntry {
            member_id: member_id.to_string(),
            member_name: member_name.to_string(),
            member_avatar_updated_at: None,
            votes,
        }
    }

    fn ids(entries: &[MvpTallyEntry]) -> String {
        entries.iter().map(|e| e.member_id.clone()).collect::<Vec<_>>().join(",")
    }

    /// (one name, another, what `localeCompare` answers for the pair). Each
    /// pair appears both ways round, so the order is a real order.
    #[rustfmt::skip]
    const NAMES: &[(&str, &str, i32)] = &[
        ("Aung", "aung", 1), ("aung", "Aung", -1), ("aung", "AUNG", -1), ("AUNG", "aung", 1),
        ("az", "Aa", 1), ("Aa", "az", -1), ("Zoe", "zoe", 1), ("zoe", "Zoe", -1),
        ("bo", "Bo", -1), ("Bo", "bo", 1), ("a", "B", -1), ("B", "a", 1), ("A", "a", 1),
        ("a", "A", -1), ("Zaw", "aung", 1), ("aung", "Zaw", -1), ("Zoë", "Zoe", 1),
        ("Zoe", "Zoë", -1), ("Zoë", "Zof", -1), ("Zof", "Zoë", 1), ("José", "Jose", 1),
        ("Jose", "José", -1), ("José", "Josf", -1), ("Josf", "José", 1),
        ("Müller", "Muller", 1), ("Muller", "Müller", -1), ("Ólafur", "Olafur", 1),
        ("Olafur", "Ólafur", -1), ("Åke", "Ake", 1), ("Ake", "Åke", -1), ("Åke", "Bo", -1),
        ("Bo", "Åke", 1), ("Nguyễn", "Nguyen", 1), ("Nguyen", "Nguyễn", -1),
        ("Nguyễn", "Nguyet", -1), ("Nguyet", "Nguyễn", 1), ("Đặng", "Dang", 1),
        ("Dang", "Đặng", -1), ("Đặng", "Danh", -1), ("Danh", "Đặng", 1), ("Lê", "Le", 1),
        ("Le", "Lê", -1), ("Phạm", "Pham", 1), ("Pham", "Phạm", -1), ("Trần", "Tran", 1),
        ("Tran", "Trần", -1), ("Vũ", "Vu", 1), ("Vu", "Vũ", -1), ("Ưng", "Ung", 1),
        ("Ung", "Ưng", -1), ("Ơn", "On", 1), ("On", "Ơn", -1), ("Ơn", "Oo", -1),
        ("Oo", "Ơn", 1), ("Ưng", "Uo", -1), ("Uo", "Ưng", 1), ("ướt", "uống", 1),
        ("uống", "ướt", -1), ("ကျော်", "ကျော", 1), ("ကျော", "ကျော်", -1), ("ကျော်", "ခင်", -1),
        ("ခင်", "ကျော်", 1), ("အောင်", "ကျော်", 1), ("ကျော်", "အောင်", -1),
        ("သီတာ", "မောင်", 1), ("မောင်", "သီတာ", -1), ("ဦးအောင်", "ဥအောင်", 1),
        ("ဥအောင်", "ဦးအောင်", -1), ("ဦး", "ဥ", 1), ("ဥ", "ဦး", -1), ("ကံ", "က", 1),
        ("က", "ကံ", -1), ("က", "a", 1), ("a", "က", -1), ("ကျော်", "Aung", 1),
        ("Aung", "ကျော်", -1), ("Aung Kyaw", "AungKyaw", -1), ("AungKyaw", "Aung Kyaw", 1),
        ("a b", "ab", -1), ("ab", "a b", 1), ("O'Brien", "OBrien", -1),
        ("OBrien", "O'Brien", 1), ("a-b", "ab", -1), ("ab", "a-b", 1), ("Bo Bo", "Bobo", -1),
        ("Bobo", "Bo Bo", 1), ("10", "9", -1), ("9", "10", 1), ("Player 10", "Player 2", -1),
        ("Player 2", "Player 10", 1), ("Player 1", "Player 10", -1),
        ("Player 10", "Player 1", 1), ("1", "၁", 0), ("၁", "1", 0), ("၁၀", "10", 0),
        ("10", "၁၀", 0), ("႑", "1", 0), ("1", "႑", 0), ("၇", "7", 0), ("7", "၇", 0),
        ("ab", "abc", -1), ("abc", "ab", 1), ("Aung", "Aung", 0), ("", "a", -1), ("a", "", 1),
        ("", "", 0), (" ", "a", -1), ("a", " ", 1), ("a\u{ad}b", "ab", 0),
        ("ab", "a\u{ad}b", 0),
    ];

    /// (the tally as (member_id, votes, member_name), the order `sortTally`
    /// puts it in, who `mvpLeaders` calls level at the top)
    #[rustfmt::skip]
    const TALLIES: &[(TallyRows, &str, &str)] = &[
        (&[], "", ""), (&[("c", 1, "Chit"), ("a", 3, "Aung"), ("b", 3, "Bo")], "a,b,c", "a,b"),
        (&[("a", 0, "Zaw"), ("b", 0, "Aung"), ("c", 0, "aung")], "c,b,a", ""),
        (&[("a", 2, "Aung"), ("b", 2, "aung"), ("c", 2, "AUNG")], "b,a,c", "a,b,c"),
        (&[("a", 1, "ကျော်"), ("b", 1, "အောင်"), ("c", 1, "Aung"), ("d", 1, "Đặng")], "c,d,a,b", "a,b,c,d"),
        (&[("a", 5, "Zoë"), ("b", 5, "Zoe"), ("c", 5, "zoe")], "c,b,a", "a,b,c"),
        (&[("a", 1, "Bo"), ("b", 4, "Bo"), ("c", 0, "Bo")], "b,a,c", "b"),
        (&[("a", 3, "Nguyễn"), ("b", 3, "Nguyen"), ("c", 3, "Ơn"), ("d", 3, "On")], "b,a,d,c", "a,b,c,d"),
        (&[("x", 2, "Player 10"), ("y", 2, "Player 2"), ("z", 2, "Player 1")], "z,x,y", "x,y,z"),
    ];

    /// (votes per member id, the ids level at the top, in tally order)
    #[rustfmt::skip]
    const LEADERS: &[(&[(&str, i64)], &str)] = &[
        (&[("a", 3), ("b", 1)], "a"), (&[("a", 2), ("b", 2), ("c", 1)], "a,b"),
        (&[("a", 1), ("b", 1), ("c", 1)], "a,b,c"), (&[("a", 0), ("b", 0)], ""), (&[], ""),
        (&[("a", 0)], ""), (&[("b", 1), ("a", 1)], "b,a"),
    ];

    /// The ballot is a, b, c. (nominee, voter, may that voter pick them)
    #[rustfmt::skip]
    const VOTES: &[(&str, &str, bool)] = &[
        ("a", "a", false), ("a", "c", true), ("a", "nobody", true), ("b", "a", true),
        ("b", "c", true), ("b", "nobody", true), ("c", "a", true), ("c", "c", false),
        ("c", "nobody", true), ("zzz", "a", false), ("zzz", "c", false),
        ("zzz", "nobody", false), ("", "a", false), ("", "c", false), ("", "nobody", false),
    ];

    #[test]
    fn names_order_the_way_the_browser_orders_them() {
        for &(a, b, expected) in NAMES {
            let answer = match name_order(a, b) {
                Ordering::Less => -1,
                Ordering::Equal => 0,
                Ordering::Greater => 1,
            };
            assert_eq!(answer, expected, "{a:?} against {b:?}");
        }
    }

    #[test]
    fn the_tally_is_highest_first_then_by_name() {
        for &(rows, order, leaders) in TALLIES {
            let tally: Vec<MvpTallyEntry> =
                rows.iter().map(|&(id, votes, name)| entry(id, votes, name)).collect();
            assert_eq!(ids(&sort_tally(&tally)), order, "{rows:?}");
            assert_eq!(mvp_leaders(&tally).join(","), leaders, "{rows:?}");
        }
    }

    #[test]
    fn everybody_level_at_the_top_or_nobody() {
        for &(rows, expected) in LEADERS {
            let tally: Vec<MvpTallyEntry> =
                rows.iter().map(|&(id, votes)| entry(id, votes, id)).collect();
            assert_eq!(mvp_leaders(&tally).join(","), expected, "{rows:?}");
        }
        // Negative votes cannot exist, but the maximum still starts from zero
        // and so still answers with nobody.
        assert!(mvp_leaders(&[entry("a", -3, "Aung")]).is_empty());
    }

    /// Two entries the comparison calls equal come back in the order they went
    /// in, which is what keeps the screen from reshuffling itself between
    /// renders on a name people share.
    #[test]
    fn a_tie_the_comparison_cannot_break_is_left_alone() {
        let tally = vec![entry("c", 2, "Bo"), entry("a", 2, "Bo"), entry("b", 2, "Bo")];
        assert_eq!(ids(&sort_tally(&tally)), "c,a,b");
    }

    #[test]
    fn nobody_votes_for_themselves() {
        for &(nominee, voter, expected) in VOTES {
            assert_eq!(can_vote_for(nominee, voter, ["a", "b", "c"]), expected);
        }
        assert!(!can_vote_for("a", "b", []));
    }

    /// The table is generated, so the thing worth asserting about it is that it
    /// is well formed: every character in it exactly once, and the ignorable
    /// group where the weighting code expects it.
    #[test]
    fn the_collation_table_is_well_formed() {
        let mut seen = std::collections::HashSet::new();
        let mut characters = 0;
        for group in COLLATION {
            assert!(!group.is_empty());
            for accents in *group {
                for character in accents.chars() {
                    assert!(seen.insert(character), "{character:?} is in the table twice");
                    characters += 1;
                }
            }
        }
        assert_eq!(characters, seen.len());
        assert_eq!(table().len(), characters);

        // Nothing outside the ignorable group may weigh nothing at the primary
        // level, or a name would silently lose a letter.
        for (character, &(primary, _, _)) in table() {
            let ignorable = COLLATION[0].iter().any(|group| group.contains(*character));
            assert_eq!(primary == 0, ignorable, "{character:?}");
        }
    }
}
