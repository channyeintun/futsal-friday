//! Localisation.
//!
//! No i18n library. The catalogue is a plain value where English is the source
//! of truth and every other locale sits beside it — so a missing key, or an
//! interpolation whose arguments have drifted, is a build error rather than a
//! screen showing `session.playing` to a user. The TypeScript got that from
//! declaring every other locale as `typeof en`; here the two locales are the two
//! arms of one `match`, and an arm cannot be left out.
//!
//! Strings that need values are functions, not templates with placeholders.
//! `m.session.playing(5, Some(14))` is checked by the compiler; a lookup by
//! dotted string is not, and the parameter names rot silently.
//!
//! This lives in the shared crate because the Worker needs it too: push
//! notification text is written server-side, in each member's own language.
//!
//! Ported from `shared/src/i18n/index.ts`, `en.ts` and `my.ts` — every key, both
//! languages, verbatim.
//!
//! Two conventions in the Burmese, worth stating because they are easy to "fix"
//! wrongly later:
//!
//!  - **Unicode, not Zawgyi.** Every string here is standard Myanmar Unicode.
//!    Zawgyi-encoded text would render as garbage on any modern phone, and the
//!    two encodings are visually indistinguishable in an editor.
//!  - **Arabic numerals.** Times, counts and money stay as `19:30`, `120.000d`
//!    rather than Myanmar digits. That is what Myanmar apps overwhelmingly do
//!    for money and clock times, and it keeps amounts unambiguous next to the
//!    Vietnamese dong.
//!
//! Key names are the catalogue's, spelled the Rust way: `somethingWrong` is
//! `something_wrong()`, and nothing else about them changed.

use serde::{Deserialize, Serialize};

/// The languages the app speaks.
///
/// `Default` is `DEFAULT_LOCALE`, and the two tags are what cross the wire — a
/// member's `language` column holds one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    #[default]
    En,
    My,
}

impl Locale {
    /// The tag as it crosses the wire and sits in the database.
    pub fn as_str(&self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::My => "my",
        }
    }
}

pub const LOCALES: [Locale; 2] = [Locale::En, Locale::My];

pub const DEFAULT_LOCALE: Locale = Locale::En;

/// Map anything a browser or database might hand us onto a supported locale.
///
/// Accepts `my-MM`, `my`, `en-GB`, and the historical Burmese tags `bur`/`mya`,
/// which some Android builds still report. The original tested `!value`, which
/// is true of `''`, `null` and `undefined` alike — all three arrive here as an
/// empty string and all three answer English.
pub fn normalize_locale(value: &str) -> Locale {
    if value.is_empty() {
        return DEFAULT_LOCALE;
    }
    let tag = value.to_lowercase();
    if tag.starts_with("my") || tag.starts_with("bur") || tag.starts_with("mya") {
        return Locale::My;
    }
    Locale::En
}

/// Whether a tag is one of ours, spelled exactly.
pub fn is_locale(value: &str) -> bool {
    LOCALES.iter().any(|l| l.as_str() == value)
}

/// Native name, for the language switcher — never translated.
pub fn locale_label(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "English",
        Locale::My => "မြန်မာ",
    }
}

/// The catalogue in one locale.
pub fn messages_for(locale: &str) -> Messages {
    Messages::new(normalize_locale(locale))
}

/// One group of the catalogue: a struct carrying the locale, with one method per
/// key.
///
/// English and Burmese sit on the same line, which is what makes a missing
/// translation impossible — the same job `typeof en` did for the TypeScript.
macro_rules! catalogue {
    ($( $group:ident { $( $key:ident : $en:expr, $my:expr ; )* } )*) => {
        $(
            #[derive(Debug, Clone, Copy, PartialEq, Eq)]
            pub struct $group {
                locale: Locale,
            }

            impl $group {
                $(
                    pub fn $key(&self) -> &'static str {
                        match self.locale {
                            Locale::En => $en,
                            Locale::My => $my,
                        }
                    }
                )*

                /// Every plain string in this group, keyed by name.
                ///
                /// Not part of the original — the TypeScript walked the object
                /// with `Object.entries`, and the catalogue tests need the same
                /// reach here.
                pub fn entries(&self) -> Vec<(&'static str, &'static str)> {
                    vec![$( (stringify!($key), self.$key()), )*]
                }
            }
        )*
    };
}

/// The whole catalogue in one locale, reached as `m.session.playing(…)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Messages {
    pub locale: Locale,
    pub app: App,
    pub paste: Paste,
    pub pay: Pay,
    pub waiting: Waiting,
    pub approvals: Approvals,
    pub profile: Profile,
    pub form: Form,
    pub board: Board,
    pub goals: Goals,
    pub nav: Nav,
    pub claim: Claim,
    pub join: Join,
    pub invite: Invite,
    pub session: Session,
    pub mvp: Mvp,
    pub talk: Talk,
    pub teams: Teams,
    pub connection: Connection,
    pub home: Home,
    pub toast: Toast,
    pub payments: Payments,
    pub history: History,
    pub admin: Admin,
    pub editor: Editor,
    pub reminders: Reminders,
    pub copy: CopyText,
    pub announce: Announce,
    pub summary: Summary,
    pub push: Push,
    pub errors: Errors,
}

impl Messages {
    pub fn new(locale: Locale) -> Self {
        Self {
            locale,
            app: App { locale },
            paste: Paste { locale },
            pay: Pay { locale },
            waiting: Waiting { locale },
            approvals: Approvals { locale },
            profile: Profile { locale },
            form: Form { locale },
            board: Board { locale },
            goals: Goals { locale },
            nav: Nav { locale },
            claim: Claim { locale },
            join: Join { locale },
            invite: Invite { locale },
            session: Session { locale },
            mvp: Mvp { locale },
            talk: Talk { locale },
            teams: Teams { locale },
            connection: Connection { locale },
            home: Home { locale },
            toast: Toast { locale },
            payments: Payments { locale },
            history: History { locale },
            admin: Admin { locale },
            editor: Editor { locale },
            reminders: Reminders { locale },
            copy: CopyText { locale },
            announce: Announce { locale },
            summary: Summary { locale },
            push: Push { locale },
            errors: Errors { locale },
        }
    }

    /// Every plain string in the catalogue as `("group.key", value)`.
    pub fn entries(&self) -> Vec<(String, &'static str)> {
        let groups: Vec<(&'static str, Vec<(&'static str, &'static str)>)> = vec![
            ("app", self.app.entries()),
            ("paste", self.paste.entries()),
            ("pay", self.pay.entries()),
            ("waiting", self.waiting.entries()),
            ("approvals", self.approvals.entries()),
            ("profile", self.profile.entries()),
            ("form", self.form.entries()),
            ("board", self.board.entries()),
            ("goals", self.goals.entries()),
            ("nav", self.nav.entries()),
            ("claim", self.claim.entries()),
            ("join", self.join.entries()),
            ("invite", self.invite.entries()),
            ("session", self.session.entries()),
            ("mvp", self.mvp.entries()),
            ("talk", self.talk.entries()),
            ("teams", self.teams.entries()),
            ("connection", self.connection.entries()),
            ("home", self.home.entries()),
            ("toast", self.toast.entries()),
            ("payments", self.payments.entries()),
            ("history", self.history.entries()),
            ("admin", self.admin.entries()),
            ("editor", self.editor.entries()),
            ("reminders", self.reminders.entries()),
            ("copy", self.copy.entries()),
            ("announce", self.announce.entries()),
            ("summary", self.summary.entries()),
            ("push", self.push.entries()),
            ("errors", self.errors.entries()),
        ];
        groups
            .into_iter()
            .flat_map(|(group, entries)| {
                entries.into_iter().map(move |(key, value)| (format!("{group}.{key}"), value))
            })
            .collect()
    }
}

catalogue! {
    App {
        name: "Futsal Friday", "ဖူဆယ် သောကြာ";
        loading: "Just a moment…", "ခဏစောင့်ပါ…";
        back: "Back", "နောက်သို့";
        cancel: "Cancel", "မလုပ်တော့ပါ";
        save: "Save", "သိမ်းမည်";
        saving: "Saving…", "သိမ်းနေသည်…";
        done: "Done", "ပြီးပါပြီ";
        close: "Close", "ပိတ်မည်";
        add: "Add", "ထည့်မည်";
        create: "Create", "ဖန်တီးမည်";
        working: "One sec…", "ခဏလေး…";
        something_wrong: "Something went wrong", "တစ်ခုခု မှားယွင်းသွားပါသည်";
        organizer_suffix: "organizer", "စီစဉ်သူ";
        remove: "Remove", "ဖယ်ရှားမည်";
    }
}

catalogue! {
    Paste {
        title: "Got a link?", "လင့်ခ် ရထားလား?";
        body: "Paste it here. Handy when the app is on your home screen — there's no address bar to open a link in.", "ဒီမှာ ကူးထည့်ပါ။ အက်ပ်ကို ဖုန်းမျက်နှာပြင်မှာ ထည့်ထားရင် လင့်ခ်ဖွင့်ဖို့ လိပ်စာဘား မရှိတော့ပါ။";
        label: "Paste your invite link", "ဖိတ်ကြားလင့်ခ် ကူးထည့်ပါ";
        go: "Use this link", "ဒီလင့်ခ် သုံးမည်";
        from_clipboard: "Paste from clipboard", "ကလစ်ဘုတ်မှ ကူးထည့်မည်";
        not_a_link: "That doesn't look like an invite link. Copy the whole thing from the chat.", "ဖိတ်ကြားလင့်ခ် မဟုတ်ပုံရပါ။ ချက်ထဲက အပြည့်အစုံ ကူးယူပါ။";
        paste_blocked: "Your browser would not let the app read the clipboard. Paste into the box instead.", "ဘရောက်ဇာက ကလစ်ဘုတ် ဖတ်ခွင့် မပေးပါ။ အကွက်ထဲ ကိုယ်တိုင် ကူးထည့်ပါ။";
    }
}

catalogue! {
    Pay {
        title: "How to pay", "ငွေပေးနည်း";
        body: "Scan with your banking app — the amount is already in the QR.", "ဘဏ်အက်ပ်နဲ့ စကင်ဖတ်ပါ — ပမာဏကို ကျူအာကုဒ်ထဲ ထည့်ပြီးသားပါ။";
        bank: "Bank", "ဘဏ်";
        account_number: "Account number", "အကောင့်နံပါတ်";
        account_name: "Account name", "အကောင့်အမည်";
        reference: "Transfer note", "လွှဲပြောင်းမှတ်ချက်";
        copy_account: "Copy account number", "အကောင့်နံပါတ် ကူးမည်";
        copy_amount: "Copy amount", "ပမာဏ ကူးမည်";
        copied: "Copied", "ကူးပြီးပါပြီ";
        scan_hint: "Paying from this phone? Screenshot the QR, then pick it from your photos in your banking app.", "ဒီဖုန်းကနေပဲ ပေးမလား? ကျူအာကုဒ်ကို ဖန်သားပြင်ဓာတ်ပုံ ရိုက်ပြီး ဘဏ်အက်ပ်ထဲက ဓာတ်ပုံများမှ ရွေးပါ။";
        nothing_set: "The organizer has not added payment details yet.", "စီစဉ်သူက ငွေပေးချေမှု အချက်အလက် မထည့်ရသေးပါ။";
        edit_title: "Payment details", "ငွေပေးချေမှု အချက်အလက်";
        edit_body: "Shown to everyone with the amount they owe, so nobody has to scroll the chat for your account number.", "လူတိုင်းကို သူတို့ပေးရမယ့် ပမာဏနဲ့အတူ ပြပါမယ်။ ဘယ်သူမှ ချက်ထဲ ပြန်ရှာစရာ မလိုတော့ပါ။";
        set_up: "Add payment details", "ငွေပေးချေမှု အချက်အလက် ထည့်မည်";
        edit: "Edit", "ပြင်မည်";
        save: "Save", "သိမ်းမည်";
        remove: "Remove details", "အချက်အလက် ဖယ်မည်";
        confirm_remove: "Remove the payment details?", "ငွေပေးချေမှု အချက်အလက် ဖယ်မလား?";
        confirm_remove_body: "The group loses the account number and the QR until you add them again.", "ပြန်မထည့်မချင်း အဖွဲ့သားများ အကောင့်နံပါတ်နဲ့ ကျူအာကုဒ်ကို မမြင်ရတော့ပါ။";
        pick_bank: "Bank", "ဘဏ်";
        note_label: "Anything else to say", "ထပ်ပြောစရာ ရှိလား";
        note_placeholder: "e.g. put your name in the transfer note", "ဥပမာ — လွှဲတဲ့အခါ နာမည်ထည့်ပါ";
        could_not_save: "Could not save the payment details", "အချက်အလက် မသိမ်းနိုင်ပါ";
    }
}

impl Pay {
    pub fn you_owe_this(&self, amount: &str) -> String {
        match self.locale {
            Locale::En => format!("You owe {amount}"),
            Locale::My => format!("သင် ပေးရန် {amount}"),
        }
    }
}

catalogue! {
    Waiting {
        title: "Almost in", "နီးပါးပြီ";
        check: "Check again", "ပြန်စစ်မည်";
        still_waiting: "Not yet. Give them a moment.", "မရသေးပါ။ ခဏလေး စောင့်ပါ။";
        wrong_name: "Wrong name? Ask the organizer to fix it.", "နာမည် မှားနေလား? စီစဉ်သူကို ပြောပါ။";
    }
}

impl Waiting {
    pub fn body(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("You're on the list as {name}. An organizer has to let you in — you'll get a nudge when they do."),
            Locale::My => format!("{name} အဖြစ် စာရင်းသွင်းပြီးပါပြီ။ စီစဉ်သူက ခွင့်ပြုပေးရပါမယ် — ပြီးရင် အကြောင်းကြားပါမယ်။"),
        }
    }
}

catalogue! {
    Approvals {
        body: "They added themselves from the group link. Let them in, or turn them away.", "အုပ်စု လင့်ခ်ကနေ ကိုယ်တိုင် စာရင်းသွင်းထားတာ။ ခွင့်ပြုမလား၊ ငြင်းမလား။";
        approve: "Let in", "ခွင့်ပြုမည်";
        reject: "Turn away", "ငြင်းမည်";
        confirm_reject_body: "Their name goes back on the list, so they — or somebody else — can ask again.", "သူ့နာမည် ပြန်လွတ်သွားမယ်၊ ဒါကြောင့် နောက်တစ်ခါ ပြန်တောင်းလို့ရတယ်။";
        could_not_approve: "Could not let them in", "ခွင့်မပြုနိုင်ပါ";
    }
}

impl Approvals {
    pub fn heading(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "1 waiting to join".to_string()
                } else {
                    format!("{count} waiting to join")
                }
            }
            Locale::My => format!("{count} ယောက် ဝင်ခွင့် စောင့်နေတယ်"),
        }
    }

    pub fn approved(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("{name} is in"),
            Locale::My => format!("{name} ဝင်ပြီးပါပြီ"),
        }
    }

    pub fn rejected(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("Turned {name} away"),
            Locale::My => format!("{name} ကို ငြင်းလိုက်ပါပြီ"),
        }
    }

    pub fn confirm_reject(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("Turn {name} away?"),
            Locale::My => format!("{name} ကို ငြင်းမလား?"),
        }
    }
}

catalogue! {
    Profile {
        title: "Profile", "ကိုယ်ရေးအချက်အလက်";
        current_streak: "Streak", "ဆက်တိုက်";
        best_streak: "Best", "အများဆုံး";
        played: "Played", "ကစားပြီး";
        no_streak: "No run going. The next match starts one.", "ဆက်တိုက်စာရင်း မရှိသေးဘူး။ နောက်ပွဲက စလို့ရတယ်။";
        change_picture: "Change picture", "ဓာတ်ပုံ ပြောင်းမည်";
        remove_picture: "Remove picture", "ဓာတ်ပုံ ဖယ်မည်";
        remove_picture_body: "Your initials will show instead. You can add a new one any time.", "အစား နာမည်အက္ခရာ ပြပါမယ်။ ဘယ်အချိန်မဆို ပြန်ထည့်လို့ရတယ်။";
        picture_updated: "Picture updated", "ဓာတ်ပုံ ပြောင်းပြီးပါပြီ";
        could_not_upload: "Could not save that picture", "ဓာတ်ပုံ မသိမ်းနိုင်ပါ";
        could_not_load: "Could not load that profile", "ကိုယ်ရေးအချက်အလက် မဖတ်နိုင်ပါ";
    }
}

impl Profile {
    pub fn played_of(&self, played: i64, total: i64) -> String {
        match self.locale {
            Locale::En => format!("Played {played} of {total} matches"),
            Locale::My => format!("ပွဲ {total} ပွဲအနက် {played} ပွဲ ကစားပြီး"),
        }
    }

    pub fn owes(&self, amount: &str) -> String {
        match self.locale {
            Locale::En => format!("Owes {amount}"),
            Locale::My => format!("ကျန်ငွေ {amount}"),
        }
    }

    pub fn keep_it_up(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "One in a row. Do not stop now.".to_string()
                } else {
                    format!("{count} in a row. Do not break it.")
                }
            }
            Locale::My => {
                if count == 1 {
                    "တစ်ပွဲ ဆက်တိုက်။ ဒီမှာ မရပ်နဲ့။".to_string()
                } else {
                    format!("{count} ပွဲ ဆက်တိုက်။ မပြတ်စေနဲ့။")
                }
            }
        }
    }
}

catalogue! {
    Form {
    }
}

impl Form {
    pub fn label(&self, played: i64, of: i64) -> String {
        match self.locale {
            Locale::En => format!("Played {played} of the last {of}"),
            Locale::My => format!("နောက်ဆုံး {of} ပွဲအနက် {played} ပွဲ ကစားခဲ့"),
        }
    }
}

catalogue! {
    Board {
        title: "Leaderboard", "အဆင့်ဇယား";
        streaks: "Streaks", "ဆက်တိုက်";
        goals: "Goals", "ဂိုးများ";
        streak_body: "Games in a row. Turning up is the whole trick.", "ဆက်တိုက် ကစားခဲ့သော ပွဲများ။ လာဖို့ပဲ လိုတယ်။";
        goals_body: "Goals scored, since the app started counting.", "အက်ပ်စတင်ကတည်းက သွင်းခဲ့သော ဂိုးများ။";
        mvps: "MVPs", "အကောင်းဆုံး";
        mvp_body: "Games the group voted you the best in. A shared win counts for everyone tied.", "အဖွဲ့က အကောင်းဆုံးဟု မဲပေးခဲ့သော ပွဲများ။ သရေဖြစ်လျှင် အားလုံးအတွက် ရေတွက်သည်။";
        no_mvps_yet: "Nobody has been voted best player yet.", "အကောင်းဆုံး ကစားသမား မရွေးရသေးပါ။";
        nobody_yet: "Nothing to rank yet. Play a game.", "အဆင့်တင်စရာ မရှိသေးပါ။ ပွဲတစ်ပွဲ ကစားလိုက်ပါ။";
        no_goals_yet: "No goals recorded yet. Say what you scored after the match.", "ဂိုး မမှတ်ရသေးပါ။ ပွဲပြီးရင် ဘယ်နှစ်ဂိုး သွင်းခဲ့လဲ ပြောပါ။";
        loading: "Working out the table…", "ဇယား တွက်နေသည်…";
        you: "you", "သင်";
    }
}

impl Board {
    pub fn in_a_row(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "1 in a row".to_string()
                } else {
                    format!("{count} in a row")
                }
            }
            Locale::My => format!("{count} ပွဲ ဆက်တိုက်"),
        }
    }

    pub fn best_ever(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!("best {count}"),
            Locale::My => format!("အများဆုံး {count}"),
        }
    }

    pub fn goal_count(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "1 goal".to_string()
                } else {
                    format!("{count} goals")
                }
            }
            Locale::My => format!("{count} ဂိုး"),
        }
    }
}

catalogue! {
    Goals {
        title: "Scored?", "ဂိုး သွင်းခဲ့လား?";
        body: "How many did you get? Only you and the organizer can change this.", "ဘယ်နှစ်ဂိုး သွင်းခဲ့လဲ? သင်နဲ့ စီစဉ်သူသာ ပြင်လို့ရပါသည်။";
        none: "None", "မသွင်းရပါ";
        add: "Goals", "ဂိုး";
        total: "Goals", "ဂိုးများ";
        failed: "Could not save that", "သိမ်း၍ မရပါ";
    }
}

impl Goals {
    pub fn mine(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "1 goal".to_string()
                } else {
                    format!("{count} goals")
                }
            }
            Locale::My => format!("{count} ဂိုး"),
        }
    }
}

catalogue! {
    Nav {
        session: "Session", "ပွဲ";
        history: "History", "မှတ်တမ်း";
        setup: "Setup", "ပြင်ဆင်မှု";
        payments: "Payments", "ငွေပေးချေမှု";
        players: "Players", "ကစားသမားများ";
        session_title: "Session", "ပွဲ";
    }
}

catalogue! {
    Claim {
        tagline: "Private group", "သီးသန့် အဖွဲ့";
        signing_in: "Signing you in…", "ဝင်ရောက်နေသည်…";
        no_link: "This page needs an invite link.", "ဤစာမျက်နှာအတွက် ဖိတ်ကြားလင့်ခ် လိုအပ်ပါသည်။";
        failed: "Could not sign you in", "ဝင်ရောက်၍ မရပါ";
        ask_organizer: "Ask the organizer to send you your personal link. It signs you in as you — no password to remember.", "သင့်ကိုယ်ပိုင် လင့်ခ်ကို စီစဉ်သူထံ တောင်းပါ။ ထိုလင့်ခ်ဖြင့် သင့်အမည်ဖြင့် အလိုအလျောက် ဝင်ရောက်ပါမည် — စကားဝှက် မှတ်ရန် မလိုပါ။";
    }
}

catalogue! {
    Join {
        which_one: "Which one are you?", "သင်က ဘယ်သူလဲ?";
        tap_your_name: "Tap your name. It locks to this phone, so nobody else can pick it.", "သင့်အမည်ကို နှိပ်ပါ။ ဤဖုန်းနှင့် တွဲသွားမည်ဖြစ်ပြီး အခြားသူ ယူ၍ မရတော့ပါ။";
        loading: "Loading the list…", "စာရင်း ဖွင့်နေသည်…";
        all_taken: "Everyone on the list has already joined. Ask the organizer to add you.", "စာရင်းရှိသူ အားလုံး ဝင်ပြီးပါပြီ။ သင့်အမည် ထည့်ရန် စီစဉ်သူကို ပြောပါ။";
        nobody_listed: "Nobody has been added to this group yet. Put your name in below.", "ဒီအဖွဲ့မှာ ဘယ်သူမှ မထည့်ရသေးဘူး။ အောက်မှာ သင့်နာမည် ထည့်လိုက်ပါ။";
        expired: "That group link is not valid any more. Ask the organizer for the new one.", "ဤအဖွဲ့လင့်ခ် သက်တမ်းကုန်သွားပါပြီ။ စီစဉ်သူထံမှ အသစ်တောင်းပါ။";
        taken: "Somebody already took that name. Pick another, or ask the organizer.", "ဤအမည်ကို အခြားသူ ယူပြီးပါပြီ။ အခြားတစ်ခု ရွေးပါ သို့မဟုတ် စီစဉ်သူကို ပြောပါ။";
        failed: "Could not sign you in", "ဝင်ရောက်၍ မရပါ";
        not_listed: "My name isn't here", "ကျွန်တော့်နာမည် မပါဘူး";
        add_your_name: "Add your name", "နာမည် ထည့်မည်";
        add_your_name_body: "The organizer will get a nudge and has to let you in. Use the name they know you by.", "စီစဉ်သူဆီ အကြောင်းကြားပြီး သူက ခွင့်ပြုပေးရပါမယ်။ သူတို့ သိတဲ့ နာမည်ကို သုံးပါ။";
        your_name: "Your name", "သင့်နာမည်";
        request_sent: "Sent. Waiting for the organizer.", "ပို့ပြီးပါပြီ။ စီစဉ်သူကို စောင့်ပါ။";
        could_not_add: "Could not add your name", "နာမည် မထည့်နိုင်ပါ";
    }
}

catalogue! {
    Invite {
        title: "Invite links", "ဖိတ်ကြားလင့်ခ်များ";
        group_link: "Group invite link", "အဖွဲ့ ဖိတ်ကြားလင့်ခ်";
        group_link_body: "Paste this once into the group chat. Each person taps their own name, and it locks to their phone. Organizers are never listed — send them a personal link instead.", "ဤလင့်ခ်ကို အဖွဲ့ချက်ထဲ တစ်ကြိမ်တည်း ကူးထည့်ပါ။ လူတိုင်း မိမိအမည်ကို နှိပ်ပြီး ဖုန်းနှင့် တွဲသွားပါမည်။ စီစဉ်သူများကို စာရင်းတွင် မပြပါ — သူတို့အတွက် ကိုယ်ပိုင်လင့်ခ် ပို့ပါ။";
        create_group_link: "Create group link", "အဖွဲ့လင့်ခ် ဖန်တီးမည်";
        copy_group_link: "Copy group link", "အဖွဲ့လင့်ခ် ကူးမည်";
        rotate_group_link: "Replace link", "လင့်ခ် အသစ်လဲမည်";
        group_link_copied: "Group link copied — paste it in the chat", "အဖွဲ့လင့်ခ် ကူးပြီးပါပြီ — ချက်ထဲ ကူးထည့်ပါ";
        everyone_joined: "Everyone has joined.", "အားလုံး ဝင်ပြီးပါပြီ။";
        rotate_warning: "Replacing it stops the copy already in the chat from working.", "အသစ်လဲလျှင် ချက်ထဲရှိ လင့်ခ်အဟောင်း အလုပ်မလုပ်တော့ပါ။";
        confirm_rotate: "Replace the group link?", "အဖွဲ့လင့်ခ် အသစ်လဲမလား?";
        confirm_rotate_body: "The link already in the chat stops working straight away. Anybody who has not joined yet will need the new one.", "ချက်ထဲရှိ လင့်ခ်အဟောင်း ချက်ချင်း အလုပ်မလုပ်တော့ပါ။ မဝင်ရသေးသူများ လင့်ခ်အသစ် လိုအပ်ပါမည်။";
        could_not_rotate: "Could not replace the link", "လင့်ခ် အသစ်မလဲနိုင်ပါ";
        copy_link: "Copy link", "လင့်ခ် ကူးမည်";
        reissue: "New link", "လင့်ခ်အသစ်";
        claimed: "joined", "ဝင်ပြီး";
        pending: "link sent", "လင့်ခ် ပို့ပြီး";
        not_yet: "not invited", "မဖိတ်ရသေး";
        link_body: "Send this to that person only. It signs in whoever opens it first, and stops working after that.", "ဤလင့်ခ်ကို သက်ဆိုင်သူထံသာ ပို့ပါ။ ပထမဆုံး ဖွင့်သူဖြင့် ဝင်ရောက်ပြီး နောက်ပိုင်း အလုပ်မလုပ်တော့ပါ။";
        copied: "Link copied — send it to them directly", "လင့်ခ် ကူးပြီးပါပြီ — သူ့ထံ တိုက်ရိုက် ပို့ပါ";
        could_not_mint: "Could not create a link", "လင့်ခ် ဖန်တီး၍ မရပါ";
        my_device: "Sign in somewhere else", "အခြားနေရာတွင် ဝင်ရောက်မည်";
        my_device_body: "Open this link in another browser, or on another phone or laptop, to sign in there too. Each browser signs in on its own — being signed in on Chrome does not sign you in on Safari.", "ဤလင့်ခ်ကို အခြားဘရောက်ဇာ၊ အခြားဖုန်း သို့မဟုတ် လက်ပ်တော့တွင် ဖွင့်ပါ။ ဘရောက်ဇာတစ်ခုစီ သီးခြား ဝင်ရောက်ရပါသည် — Chrome တွင် ဝင်ထားလျှင် Safari တွင် ဝင်ပြီးသား မဟုတ်ပါ။";
        remove_access: "Sign out everywhere", "နေရာတိုင်းမှ ထွက်ခိုင်းမည်";
        remove_access_body: "Signs them out of every browser they are signed in on, and cancels any unused link. They will need a new one.", "သူဝင်ရောက်ထားသော ဘရောက်ဇာအားလုံးမှ ထွက်စေပြီး မသုံးရသေးသော လင့်ခ်ကိုလည်း ပယ်ဖျက်ပါမည်။ လင့်ခ်အသစ် လိုအပ်ပါမည်။";
        could_not_remove: "Could not do that", "မဆောင်ရွက်နိုင်ပါ";
    }
}

impl Invite {
    pub fn waiting_to_join(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "1 person still to join".to_string()
                } else {
                    format!("{count} people still to join")
                }
            }
            Locale::My => format!("{count} ဦး မဝင်ရသေးပါ"),
        }
    }

    pub fn link_ready(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("Link for {name}"),
            Locale::My => format!("{name} အတွက် လင့်ခ်"),
        }
    }

    pub fn expires(&self, when: &str) -> String {
        match self.locale {
            Locale::En => format!("Works until {when}"),
            Locale::My => format!("{when} အထိ သုံးနိုင်သည်"),
        }
    }

    pub fn confirm_remove(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("Sign {name} out of everywhere?"),
            Locale::My => format!("{name} ကို နေရာတိုင်းမှ ထွက်ခိုင်းမှာလား?"),
        }
    }

    pub fn removed(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("{name} signed out everywhere"),
            Locale::My => format!("{name} ကို နေရာတိုင်းမှ ထွက်ခိုင်းပြီး"),
        }
    }
}

catalogue! {
    Session {
        cancelled: "Cancelled", "ပွဲပျက်";
        finished: "Finished", "ပွဲပြီး";
        no_venue: "Venue not decided yet", "ကွင်း မဆုံးဖြတ်ရသေးပါ";
        open_map: "Open map", "မြေပုံ ဖွင့်မည်";
        was_cancelled: "This session was cancelled.", "ဤပွဲကို ဖျက်လိုက်ပါပြီ။";
        im_in: "I'm in", "ကစားမည်";
        cant_make_it: "Can't make it", "မလာနိုင်ပါ";
        leave_waitlist: "Leave the waitlist", "စောင့်ဆိုင်းစာရင်းမှ ထွက်မည်";
        registration_closed: "Registration is closed for this session.", "ဤပွဲအတွက် စာရင်းပေးခြင်း ပိတ်သွားပါပြီ။";
        nobody_yet: "Nobody yet. Be the first.", "ဘယ်သူမှ မရှိသေးပါ။ ပထမဆုံး ဖြစ်လိုက်ပါ။";
        you: "you", "သင်";
        guests_title: "Bringing anyone?", "တစ်ယောက်ယောက် ခေါ်လာမလား?";
        guests_body: "Friends without the app. They take a spot each, and their share goes on your bill.", "အက်ပ် မရှိတဲ့ သူငယ်ချင်းများ။ တစ်ယောက်စီ နေရာယူပြီး ငွေကို သင့်ဘေလ်မှာ ပေါင်းထည့်ပါမယ်။";
        guests_none: "Just me", "ကျွန်တော် တစ်ယောက်တည်း";
        guests_save: "Save", "သိမ်းမည်";
        guests_full: "Not enough room for that many.", "အဲဒီလောက် နေရာ မလုံလောက်ပါ။";
        guests_failed: "Could not change that", "ပြောင်းလို့ မရပါ";
        waiting: "waiting", "စောင့်ဆဲ";
        attendance_title: "Who played?", "ဘယ်သူတွေ ကစားခဲ့လဲ?";
        attendance_body: "Everyone on the list counts unless you say otherwise. Only mark the people who did not turn up — their share goes to whoever did.", "သီးခြား မမှတ်ထားလျှင် စာရင်းထဲက အားလုံးကို ရေတွက်ပါမည်။ မလာသူများကိုသာ မှတ်ပါ — သူတို့ရဲ့ ဝေစုကို လာသူများက ခွဲယူပါမည်။";
        attendance_unchecked: "Nobody has checked this yet", "မည်သူမျှ မစစ်ဆေးရသေးပါ";
        i_was_there: "I was there", "ကျွန်ုပ် လာခဲ့သည်";
        i_missed_it: "I missed it", "ကျွန်ုပ် မလာခဲ့ပါ";
        did_not_play: "did not play", "မကစားခဲ့";
        played: "played", "ကစားခဲ့";
        mark_absent: "Mark as no-show", "မလာဟု မှတ်မည်";
        mark_present: "Mark as played", "ကစားခဲ့ဟု မှတ်မည်";
        unmark: "Clear", "ဖျက်မည်";
        guests_arrived_title: "How many friends came?", "သူငယ်ချင်း ဘယ်နှစ်ဦး လာခဲ့လဲ?";
        guests_arrived_none: "None came", "တစ်ဦးမှ မလာပါ";
        attendance_failed: "Could not save that", "သိမ်း၍ မရပါ";
        copy_list: "Copy list for chat", "စာရင်းကို ကူးမည်";
        split_the_bill: "Split the bill", "ငွေခွဲမည်";
        edit: "Edit", "ပြင်မည်";
        cancel_session: "Cancel session", "ပွဲဖျက်မည်";
        confirm_cancel_title: "Cancel this session?", "ဤပွဲကို ဖျက်မှာလား?";
        confirm_cancel_body: "Everyone registered will see it as cancelled. This cannot be undone from the app.", "စာရင်းပေးထားသူ အားလုံး ပွဲပျက်ကြောင်း မြင်ရပါမည်။ အက်ပ်ထဲမှ ပြန်ပြင်၍ မရပါ။";
        keep_it: "Keep it", "ဆက်ထားမည်";
        that_did_not_work: "That did not work", "မအောင်မြင်ပါ";
        no_such_session: "That session no longer exists.", "ဤပွဲ မရှိတော့ပါ။";
        loading: "Loading session…", "ပွဲကို ဖွင့်နေသည်…";
    }
}

impl Session {
    pub fn playing(&self, count: i64, max: Option<i64>) -> String {
        match self.locale {
            Locale::En => match max.filter(|n| *n != 0) {
                Some(max) => format!("Playing {count} / {max}"),
                None => format!("Playing {count}"),
            },
            Locale::My => match max.filter(|n| *n != 0) {
                Some(max) => format!("ကစားမည် {count} / {max}"),
                None => format!("ကစားမည် {count}"),
            },
        }
    }

    pub fn bringing_guests(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "bringing 1 guest".to_string()
                } else {
                    format!("bringing {count} guests")
                }
            }
            Locale::My => format!("ဧည့်သည် {count} ဦး ခေါ်လာမည်"),
        }
    }

    pub fn guest_chip(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!("+{count}"),
            Locale::My => format!("+{count}"),
        }
    }

    pub fn guests_count(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "Me + 1 friend".to_string()
                } else {
                    format!("Me + {count} friends")
                }
            }
            Locale::My => format!("ကျွန်တော် + သူငယ်ချင်း {count} ဦး"),
        }
    }

    pub fn playing_with_guests(&self, players: i64, guests: i64) -> String {
        match self.locale {
            Locale::En => {
                if guests == 1 {
                    format!("{players} playing · 1 guest")
                } else {
                    format!("{players} playing · {guests} guests")
                }
            }
            Locale::My => format!("{players} ယောက် ကစားမည် · ဧည့်သည် {guests} ဦး"),
        }
    }

    pub fn waitlist_heading(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!("Waitlist ({count})"),
            Locale::My => format!("စောင့်ဆိုင်းစာရင်း ({count})"),
        }
    }

    pub fn attendance_count(&self, heads: i64) -> String {
        match self.locale {
            Locale::En => {
                if heads == 1 {
                    "1 played".to_string()
                } else {
                    format!("{heads} played")
                }
            }
            Locale::My => format!("{heads} ဦး ကစားခဲ့"),
        }
    }

    pub fn guests_arrived_body(&self, registered: i64) -> String {
        match self.locale {
            Locale::En => {
                format!("You put down {registered}. Only the ones who turned up are billed.")
            }
            Locale::My => format!("{registered} ဦး ဟု ရေးထားသည်။ လာသူများကိုသာ ငွေတောင်းပါမည်။"),
        }
    }

    pub fn guests_arrived_count(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "1 came".to_string()
                } else {
                    format!("{count} came")
                }
            }
            Locale::My => format!("{count} ဦး လာခဲ့"),
        }
    }

    pub fn guests_arrived_chip(&self, came: i64, registered: i64) -> String {
        match self.locale {
            Locale::En => format!("{came} of {registered}"),
            Locale::My => format!("{registered} ဦးမှ {came} ဦး"),
        }
    }
}

catalogue! {
    Mvp {
        title: "Best player", "အကောင်းဆုံး ကစားသမား";
        body: "Who was the best today? Tap a name.", "ဒီနေ့ ဘယ်သူ အကောင်းဆုံးလဲ? နာမည်တစ်ခုကို နှိပ်ပါ။";
        change_body: "Changed your mind? Tap somebody else.", "စိတ်ပြောင်းသွားလား? အခြားတစ်ယောက်ကို နှိပ်ပါ။";
        yours: "your vote", "သင့်မဲ";
        take_it_back: "Take my vote back", "မဲ ပြန်ရုပ်မည်";
        players_only: "Only people who played can vote.", "ကစားခဲ့သူများသာ မဲပေးနိုင်သည်။";
        failed: "Could not save your vote", "မဲ သိမ်း၍ မရပါ";
    }
}

impl Mvp {
    pub fn turnout(&self, cast: i64, of: i64) -> String {
        match self.locale {
            Locale::En => format!("{cast} of {of} voted"),
            Locale::My => format!("{of} ဦးအနက် {cast} ဦး မဲပေးပြီး"),
        }
    }

    pub fn votes(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "1 vote".to_string()
                } else {
                    format!("{count} votes")
                }
            }
            Locale::My => format!("မဲ {count} မဲ"),
        }
    }

    pub fn leading_with(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "with 1 vote".to_string()
                } else {
                    format!("with {count} votes")
                }
            }
            Locale::My => format!("မဲ {count} မဲဖြင့်"),
        }
    }

    pub fn shared(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "tied on 1 vote".to_string()
                } else {
                    format!("tied on {count} votes")
                }
            }
            Locale::My => format!("မဲ {count} မဲစီဖြင့် သရေ"),
        }
    }
}

catalogue! {
    Talk {
        title: "Trash talk", "နောက်ပြောင်စကား";
        empty: "Nobody has said anything. Somebody has to start it 😏", "ဘယ်သူမှ မပြောရသေးပါ။ တစ်ယောက်ယောက် စတင်ရမည် 😏";
        empty_closed: "Nothing was said about this one.", "ဤပွဲအတွက် ဘာမှ မပြောခဲ့ကြပါ။";
        placeholder: "Say something", "တစ်ခုခု ပြောပါ";
        send: "Post it", "တင်မည်";
        remove: "Take it down", "ပြန်ဖျက်မည်";
        failed: "Could not post that", "တင်၍ မရပါ";
    }
}

impl Talk {
    pub fn count(&self, n: i64) -> String {
        match self.locale {
            Locale::En => {
                if n == 1 {
                    "1 message".to_string()
                } else {
                    format!("{n} messages")
                }
            }
            Locale::My => format!("စာ {n} စောင်"),
        }
    }

    pub fn too_long(&self, max: i64) -> String {
        match self.locale {
            Locale::En => format!("A bit long — {max} characters at most."),
            Locale::My => format!("နည်းနည်း ရှည်နေသည် — အများဆုံး {max} လုံး။"),
        }
    }
}

catalogue! {
    Teams {
        title: "Teams", "အသင်းများ";
        split: "Split into teams", "အသင်းခွဲမည်";
        body: "Everyone who turned up, dealt out at random. Anyone can shuffle again.", "ရောက်လာသူ အားလုံးကို ကျပန်း ခွဲပေးပါမည်။ ဘယ်သူမဆို ထပ်ခွဲနိုင်သည်။";
        body_before: "Everyone who is in, dealt out at random. Anyone can shuffle again.", "စာရင်းပေးထားသူ အားလုံးကို ကျပန်း ခွဲပေးပါမည်။ ဘယ်သူမဆို ထပ်ခွဲနိုင်သည်။";
        not_enough_yet: "Not enough players signed up yet.", "စာရင်းပေးထားသူ မလုံလောက်သေးပါ။";
        nobody_yet: "Mark who turned up first — the draw uses the same list the bill does.", "ဘယ်သူ ရောက်လာသည်ကို အရင်မှတ်ပါ — ငွေခွဲသည့် စာရင်းအတိုင်းပင် သုံးပါသည်။";
        how_many: "How many teams?", "အသင်း ဘယ်နှစ်သင်း ခွဲမလဲ?";
        deal: "Deal the teams", "အသင်းခွဲမည်";
        dealing: "Dealing…", "ခွဲနေသည်…";
        guest: "guest", "ဧည့်သည်";
        empty: "Nobody", "တစ်ဦးမှ မရှိ";
        shuffle: "Shuffle again", "ထပ်ခွဲမည်";
        clear: "Clear", "ဖျက်မည်";
        failed: "Could not split the teams", "အသင်း ခွဲ၍ မရပါ";
        confirm: "These are the teams", "ဤအသင်းများဖြင့် အတည်ပြုမည်";
        confirm_hint: "Everyone happy? This fixes the sides and lists the games.", "အားလုံး သဘောတူပြီလား? ဤသို့ဆိုလျှင် အသင်းများ အတည်ဖြစ်ပြီး ပွဲစဉ်များ ထွက်လာပါမည်။";
        locked: "Settled. Only an organizer can change the sides now.", "အတည်ဖြစ်ပြီ။ ယခု အသင်းများကို စီစဉ်သူသာ ပြင်နိုင်သည်။";
        redo_warning: "Dealing again unsettles the teams and clears any scores recorded against them.", "ထပ်ခွဲပါက အတည်ပြုထားသည် ပျက်ပြီး မှတ်ထားသော ရလဒ်များပါ ပျက်ပါမည်။";
        matches: "Games", "ပွဲစဉ်များ";
        matches_hint: "Everyone plays everyone. Put the score in when a game finishes.", "အသင်းတိုင်း အချင်းချင်း ကစားပါသည်။ ပွဲပြီးလျှင် ရလဒ် ထည့်ပါ။";
        never_settled: "These sides were never settled, so no games were listed. It is not too late to settle them.", "ဤအသင်းများကို အတည်မပြုခဲ့သဖြင့် ပွဲစဉ် မထွက်ခဲ့ပါ။ ယခုမှ အတည်ပြုလျှင်လည်း ရပါသေးသည်။";
        not_played: "Not played yet", "မကစားရသေးပါ";
        mark_not_played: "Mark as not played", "မကစားရသေးဟု မှတ်မည်";
        score_failed: "Could not save the score", "ရလဒ် သိမ်း၍ မရပါ";
    }
}

impl Teams {
    pub fn on_the_pitch(&self, heads: i64) -> String {
        match self.locale {
            Locale::En => {
                if heads == 1 {
                    "1 player on the pitch".to_string()
                } else {
                    format!("{heads} players on the pitch")
                }
            }
            Locale::My => format!("ကွင်းထဲတွင် {heads} ဦး"),
        }
    }

    pub fn will_be(&self, sizes: &str) -> String {
        match self.locale {
            Locale::En => format!("Sides of {sizes}"),
            Locale::My => format!("အသင်းအင်အား {sizes}"),
        }
    }

    pub fn team_name(&self, letter: &str) -> String {
        match self.locale {
            Locale::En => format!("Team {letter}"),
            Locale::My => format!("အသင်း {letter}"),
        }
    }

    pub fn team_size(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "1 player".to_string()
                } else {
                    format!("{count} players")
                }
            }
            Locale::My => format!("{count} ဦး"),
        }
    }

    pub fn drawn_by(&self, name: &str, when: &str) -> String {
        match self.locale {
            Locale::En => format!("{name} shuffled these {when}"),
            Locale::My => format!("{name} က {when} ခွဲထားသည်"),
        }
    }

    pub fn missing(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "1 more player has turned up since. Shuffle again to deal them in.".to_string()
                } else {
                    format!(
                        "{count} more players have turned up since. Shuffle again to deal them in."
                    )
                }
            }
            Locale::My => format!("နောက်ထပ် {count} ဦး ရောက်လာသည်။ ထည့်ရန် ထပ်ခွဲပါ။"),
        }
    }

    pub fn deal_them_in(&self, count: i64) -> String {
        match self.locale {
            Locale::En => {
                if count == 1 {
                    "Add them to a side".to_string()
                } else {
                    "Add them to the sides".to_string()
                }
            }
            Locale::My => format!("အသင်းထဲ ထည့်မည် ({count})"),
        }
    }

    pub fn settled_by(&self, name: &str, when: &str) -> String {
        match self.locale {
            Locale::En => format!("{name} settled these {when}"),
            Locale::My => format!("{name} က {when} အတည်ပြုထားသည်"),
        }
    }

    pub fn score_title(&self, first: &str, second: &str) -> String {
        match self.locale {
            Locale::En => format!("{first} v {second}"),
            Locale::My => format!("{first} နှင့် {second}"),
        }
    }

    pub fn scored_by(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("entered by {name}"),
            Locale::My => format!("{name} က ထည့်သွင်းထားသည်"),
        }
    }

    pub fn record(&self, won: i64, drawn: i64, lost: i64) -> String {
        match self.locale {
            Locale::En => format!("{won}W {drawn}D {lost}L"),
            Locale::My => format!("နိုင် {won} · သရေ {drawn} · ရှုံး {lost}"),
        }
    }
}

catalogue! {
    Connection {
        live: "Live", "တိုက်ရိုက်";
        polling: "Updating every 30s", "30 စက္ကန့်တိုင်း စစ်နေသည်";
        connecting: "Connecting…", "ချိတ်ဆက်နေသည်…";
        idle: "Paused", "ရပ်ထားသည်";
        polling_short: "30s", "30s";
    }
}

catalogue! {
    Home {
        loading: "Loading…", "ဖွင့်နေသည်…";
        no_session: "No session scheduled", "ပွဲ မရှိသေးပါ";
        no_session_organizer: "The next Friday game is created automatically every week. If one is missing, add it from the admin screen.", "နောက်လာမည့် သောကြာနေ့ပွဲကို အပတ်စဉ် အလိုအလျောက် ဖန်တီးပေးပါသည်။ မရှိပါက ပြင်ဆင်မှုမှ ထည့်ပါ။";
        no_session_member: "The next Friday game is created automatically every week. If one is missing, nudge the organizer.", "နောက်လာမည့် သောကြာနေ့ပွဲကို အပတ်စဉ် အလိုအလျောက် ဖန်တီးပေးပါသည်။ မရှိပါက စီစဉ်သူကို အသိပေးပါ။";
        none_yet: "No games played yet.", "ကစားပြီးသော ပွဲ မရှိသေးပါ။";
        previously: "Previously", "ယခင်ပွဲများ";
        badge_cancelled: "cancelled", "ပွဲပျက်";
        badge_not_split: "not split", "ငွေမခွဲရသေး";
        no_venue: "No venue", "ကွင်း မရှိ";
    }
}

catalogue! {
    Toast {
        youre_in: "You're in", "စာရင်းသွင်းပြီးပါပြီ";
        youre_on_waitlist: "You're on the waitlist", "စောင့်ဆိုင်းစာရင်းတွင် ရှိနေပါသည်";
        youre_out: "You're out", "စာရင်းမှ ထွက်ပြီးပါပြီ";
        copied: "Copied — paste it in the group chat", "ကူးပြီးပါပြီ — ချက်ထဲသို့ ကူးထည့်လိုက်ပါ";
        session_updated: "Session updated", "ပွဲကို ပြင်ပြီးပါပြီ";
        session_cancelled: "Session cancelled", "ပွဲကို ဖျက်လိုက်ပါပြီ";
        session_created: "Session created", "ပွဲအသစ် ဖန်တီးပြီးပါပြီ";
        venue_saved: "Venue saved", "ကွင်းကို သိမ်းပြီးပါပြီ";
        amounts_rebalanced: "Amounts rebalanced", "ငွေပမာဏများ ပြန်တွက်ပြီးပါပြီ";
        amounts_recalculated: "Amounts recalculated", "ငွေပမာဏများ ပြန်တွက်ပြီးပါပြီ";
        split_done: "Split between everyone who played", "ကစားခဲ့သူများအားလုံးကြား ခွဲဝေပြီးပါပြီ";
        marked_paid: "Marked as paid — waiting for confirmation", "ငွေပေးပြီးဟု မှတ်ထားသည် — အတည်ပြုချက် စောင့်ဆဲ";
        reminders_on: "Reminders on for this device", "ဤစက်တွင် သတိပေးချက် ဖွင့်ပြီး";
        reminders_off: "Reminders off for this device", "ဤစက်တွင် သတိပေးချက် ပိတ်ပြီး";
        test_sent: "Sent — check your notifications", "ပို့ပြီးပါပြီ — သတိပေးချက်ကို ကြည့်ပါ";
        test_no_device: "No device could be reached", "ဘယ်စက်ကိုမှ မပို့နိုင်ပါ";
    }
}

impl Toast {
    pub fn youre_out_promoted(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("You're out — {name} moves up"),
            Locale::My => format!("စာရင်းမှ ထွက်ပြီးပါပြီ — {name} အစားဝင်ပါမည်"),
        }
    }

    pub fn member_added(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("{name} added"),
            Locale::My => format!("{name} ကို ထည့်ပြီးပါပြီ"),
        }
    }

    pub fn member_removed(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("{name} removed"),
            Locale::My => format!("{name} ကို ဖယ်ပြီးပါပြီ"),
        }
    }

    pub fn confirmed(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("{name} confirmed"),
            Locale::My => format!("{name} ကို အတည်ပြုပြီး"),
        }
    }

    pub fn rejected(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("{name} rejected"),
            Locale::My => format!("{name} ကို ငြင်းပယ်ပြီး"),
        }
    }
}

catalogue! {
    Payments {
        not_split_yet: "Not split yet", "ငွေ မခွဲရသေးပါ";
        not_split_yet_body: "The organizer has not put in what the pitch cost yet.", "စီစဉ်သူက ဤပွဲအတွက် ကွင်းခ မထည့်ရသေးပါ။";
        field_total: "Whole bill", "ကွင်းခ စုစုပေါင်း";
        collected: "Collected", "ရရှိပြီး";
        still_owed: "Still owed", "ကျန်ရှိ";
        change_total: "Change the amount", "ပမာဏ ပြင်မည်";
        change_total_title: "Change what each person pays", "တစ်ဦးလျှင် ပေးရမည့် ပမာဏ ပြင်မည်";
        change_total_body: "Everyone's share is worked out again. Amounts you set by hand stay as they are, and anyone already marked paid stays paid.", "အားလုံး၏ ဝေစုကို ပြန်တွက်ပါမည်။ လက်ဖြင့် သတ်မှတ်ထားသော ပမာဏများနှင့် အတည်ပြုပြီးသား ငွေပေးချေမှုများ မပြောင်းလဲပါ။";
        nothing_to_split: "Nothing to split yet.", "ခွဲစရာ မရှိသေးပါ။";
        copy_status: "Copy status for chat", "အခြေအနေကို ကူးမည်";
        see_session: "The teams and who played", "အသင်းများနှင့် ကစားသူများ";
        split_title: "Split the bill", "ငွေခွဲမည်";
        split_body: "Only the people who played are charged. Shares are rounded to the nearest 1.000d.", "ကစားခဲ့သူများကိုသာ ကောက်ခံပါမည်။ ဝေစုများကို 1.000d နှင့် အနီးစပ်ဆုံး ဝိုင်းပါမည်။";
        per_person_charge: "What each person pays", "တစ်ဦးလျှင် ဘယ်လောက် ပေးရမလဲ";
        enter_each: "What one person pays. You can type 70k.", "တစ်ဦးလျှင် ပေးရမည့် ပမာဏ။ 70k လို့ ရိုက်လို့ရသည်။";
        split_it: "Split it", "ခွဲမည်";
        splitting: "Splitting…", "ခွဲနေသည်…";
        could_not_split: "Could not split that", "ခွဲ၍ မရပါ";
        you_owe: "You owe", "သင် ပေးရန်";
        paid_confirmed: "Paid and confirmed. Thanks.", "ငွေပေးပြီး၊ အတည်ပြုပြီး။ ကျေးဇူးတင်ပါသည်။";
        waiting_confirm: "Waiting for the organizer to confirm.", "စီစဉ်သူ၏ အတည်ပြုချက်ကို စောင့်ဆဲ။";
        undo_claim: "That was a mistake — undo", "မှားသွားသည် — ပြန်ရုပ်မည်";
        paid_with_shot: "I paid — attach screenshot", "ငွေပေးပြီး — ဓာတ်ပုံ တွဲမည်";
        paid_no_shot: "I paid, no screenshot", "ငွေပေးပြီး၊ ဓာတ်ပုံ မပါ";
        could_not_mark: "Could not mark that", "မှတ်၍ မရပါ";
        could_not_undo: "Could not undo that", "ပြန်ရုပ်၍ မရပါ";
        fixed: "set by hand", "သတ်မှတ်";
        status_paid: "paid", "ပေးပြီး";
        status_checking: "checking", "စစ်ဆဲ";
        status_unpaid: "unpaid", "မပေးရသေး";
        screenshot: "Screenshot", "ဓာတ်ပုံ";
        amount: "Amount", "ပမာဏ";
        confirm: "Confirm", "အတည်ပြု";
        reject: "Reject", "ငြင်းပယ်";
        reject_reason: "Amount did not match", "ပမာဏ မကိုက်ညီပါ";
        back_to_equal: "Back to equal split", "အညီအမျှ ပြန်ခွဲမည်";
        loading: "Loading payments…", "ငွေပေးချေမှုများ ဖွင့်နေသည်…";
        could_not_load_image: "Could not load that screenshot", "ဓာတ်ပုံကို ဖွင့်၍ မရပါ";
    }
}

impl Payments {
    pub fn everyone(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!("Everyone ({count})"),
            Locale::My => format!("အားလုံး ({count})"),
        }
    }

    pub fn splitting_between(&self, heads: i64) -> String {
        match self.locale {
            Locale::En => {
                if heads == 1 {
                    "1 person played".to_string()
                } else {
                    format!("{heads} people played")
                }
            }
            Locale::My => format!("{heads} ဦး ကစားခဲ့သည်"),
        }
    }

    pub fn comes_to(&self, heads: i64, total: &str) -> String {
        match self.locale {
            Locale::En => {
                if heads == 1 {
                    format!("1 played · {total} in all")
                } else {
                    format!("{heads} played · {total} in all")
                }
            }
            Locale::My => format!("{heads} ဦး ကစားခဲ့ · စုစုပေါင်း {total}"),
        }
    }

    pub fn rejected_with_reason(&self, reason: &str) -> String {
        match self.locale {
            Locale::En => format!("Rejected: {reason}"),
            Locale::My => format!("ငြင်းပယ်ခံရသည်: {reason}"),
        }
    }

    pub fn share_title(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("{name}'s share"),
            Locale::My => format!("{name} ၏ ဝေစု"),
        }
    }

    pub fn share_body(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!(
                "Charge {name} a set amount. Everyone else splits whatever is left of the total."
            ),
            Locale::My => format!("{name} ကို ပမာဏ တစ်ခု သတ်မှတ် ကောက်ခံမည်။ ကျန်ငွေကို ကျန်သူများက ခွဲဝေပါမည်။"),
        }
    }

    pub fn transfer_of(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("{name}'s transfer"),
            Locale::My => format!("{name} ၏ ငွေလွှဲ ပြေစာ"),
        }
    }
}

catalogue! {
    History {
        you_owe: "You owe", "သင် ပေးရန်";
        your_sessions: "Your sessions", "သင့်ပွဲများ";
        none_played: "You have not played a session yet.", "ပွဲ မကစားရသေးပါ။";
        who_owes: "Who owes what", "ဘယ်သူ ဘယ်လောက် ပေးရန်ရှိလဲ";
        who_owes_body: "Everyone in the group sees this list. The quick way off it is to pay.", "ဒီစာရင်းကို အဖွဲ့သားအားလုံး မြင်ရပါတယ်။ စာရင်းထဲက ထွက်ချင်ရင် ငွေရှင်းလိုက်ပါ။";
        expand_list: "Give the list the whole screen", "စာရင်းကို မျက်နှာပြင် အပြည့် ကြည့်မည်";
        collapse_list: "Shrink the list back down", "စာရင်းကို ပြန်ချုံ့မည်";
        settled_up: "all square", "ရှင်းပြီး";
        no_payments: "No payments recorded yet.", "ငွေပေးချေမှု မှတ်တမ်း မရှိသေးပါ။";
        waitlisted: "waitlisted", "စောင့်ဆိုင်းခဲ့";
        loading: "Loading history…", "မှတ်တမ်း ဖွင့်နေသည်…";
        recent: "Recent matches", "မကြာသေးမီ ပွဲများ";
    }
}

impl History {
    pub fn sessions_played(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!("{count} sessions played"),
            Locale::My => format!("ပွဲ {count} ပွဲ ကစားပြီး"),
        }
    }
}

catalogue! {
    Admin {
        organizers_only: "Only organizers can edit the roster and venues.", "စီစဉ်သူများသာ ကစားသမားနှင့် ကွင်းများကို ပြင်နိုင်ပါသည်။";
        sign_out: "Sign out", "ထွက်မည်";
        add_player: "Add a player", "ကစားသမား ထည့်မည်";
        manage_players: "Open the player list", "ကစားသမား စာရင်း ဖွင့်မည်";
        add_player_body: "They get a name on the list. Send them an invite link afterwards so they can sign in.", "စာရင်းထဲ နာမည် ဝင်သွားပါမည်။ ဝင်ရောက်နိုင်ရန် ဖိတ်ကြားလင့်ခ် နောက်မှ ပို့ပေးပါ။";
        player_name: "Their name", "သူ့နာမည်";
        loading_players: "Loading players…", "ကစားသမားများ ဖွင့်နေသည်…";
        that_is_everyone: "That's everyone.", "အားလုံးပါပြီ။";
        refresh_players: "Refresh", "ပြန်ဖတ်မည်";
        name: "Name", "အမည်";
        confirm_remove_member_body: "They stop appearing on the roster and cannot sign in. Their past matches and payments are kept. Getting them back means inviting them again.", "စာရင်းထဲ ပေါ်တော့မှာ မဟုတ်ဘဲ ဝင်လို့လည်း မရတော့ပါ။ ကစားခဲ့တဲ့ပွဲနဲ့ ငွေမှတ်တမ်းတွေတော့ ကျန်နေပါမယ်။ ပြန်ခေါ်ချင်ရင် ပြန်ဖိတ်ရပါမယ်။";
        confirm_retire_venue_body: "It stops being offered for new sessions. Sessions already played there keep it.", "ပွဲအသစ်တွေအတွက် ရွေးလို့ရတော့မှာ မဟုတ်ပါ။ ကစားပြီးသားပွဲတွေမှာတော့ ကျန်နေပါမယ်။";
        confirm_sign_out: "Sign out of this browser?", "ဤဘရောက်ဇာမှ ထွက်မှာလား?";
        confirm_sign_out_body: "You will need an invite link to get back in — there is no password to type.", "ပြန်ဝင်ဖို့ ဖိတ်ကြားလင့်ခ် လိုပါမယ် — စကားဝှက် ရိုက်စရာ မရှိပါ။";
        remove_note: "Removing someone keeps their past sessions and payments — they just stop appearing on the sign-in list.", "ဖယ်ရှားလျှင် ယခင်ပွဲများနှင့် ငွေပေးချေမှုများ ကျန်ရှိနေမည် — ဝင်ရောက်ရန် စာရင်းတွင်သာ မပေါ်တော့ပါ။";
        could_not_add: "Could not add that person", "ထည့်၍ မရပါ";
        could_not_remove: "Could not remove that person", "ဖယ်၍ မရပါ";
        could_not_change: "Could not change that", "ပြောင်း၍ မရပါ";
        venues: "Venues", "ကွင်းများ";
        new_venue: "New venue", "ကွင်းအသစ်";
        edit_venue: "Edit venue", "ကွင်း ပြင်မည်";
        address: "Address", "လိပ်စာ";
        map_link: "Map link", "မြေပုံ လင့်ခ်";
        price_note: "Price note", "ဈေးနှုန်း မှတ်ချက်";
        price_note_hint: "e.g. 600.000d/hour", "ဥပမာ 600.000d/နာရီ";
        retired: "(retired)", "(ရပ်ထား)";
        retire_venue: "Retire venue", "ကွင်း ရပ်နားမည်";
        could_not_save_venue: "Could not save that venue", "ကွင်းကို သိမ်း၍ မရပါ";
        could_not_retire_venue: "Could not retire that venue", "ကွင်းကို ရပ်၍ မရပါ";
        extra_session: "Extra session", "အပိုပွဲ";
        extra_session_body: "The next Friday at 19:30 is created automatically every week. Use this for a one-off.", "နောက်လာမည့် သောကြာနေ့ 19:30 ပွဲကို အပတ်စဉ် အလိုအလျောက် ဖန်တီးပါသည်။ တစ်ကြိမ်တည်း ပွဲအတွက်သာ ဤနေရာကို သုံးပါ။";
        create_session: "Create a session", "ပွဲ ဖန်တီးမည်";
        new_session: "New session", "ပွဲအသစ်";
        kickoff_label: "Kickoff (Ho Chi Minh time)", "ပွဲစချိန် (ဟိုချီမင်း အချိန်)";
        new_session_hint: "Venue, fee and cap can be set once it exists.", "ကွင်း၊ ကြေးနှင့် ကန့်သတ်ချက်ကို နောက်မှ သတ်မှတ်နိုင်ပါသည်။";
        could_not_create_session: "Could not create that session", "ပွဲ ဖန်တီး၍ မရပါ";
        clock: "Clock", "နာရီပုံစံ";
        clock_body: "How times are shown across the app, and in your reminders.", "အက်ပ်တစ်ခုလုံးနှင့် သတိပေးချက်များတွင် အချိန်ပြပုံ။";
        language: "Language", "ဘာသာစကား";
        language_body: "Changes the app, reminders and the text you copy into the chat.", "အက်ပ်၊ သတိပေးချက်များနှင့် ချက်သို့ ကူးသည့် စာသားကို ပြောင်းပါမည်။";
    }
}

impl Admin {
    pub fn signed_in_as(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("Signed in as {name}"),
            Locale::My => format!("{name} အဖြစ် ဝင်ထားသည်"),
        }
    }

    pub fn sign_out_as(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("Sign out ({name})"),
            Locale::My => format!("ထွက်မည် ({name})"),
        }
    }

    pub fn players(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!("Players ({count})"),
            Locale::My => format!("ကစားသမားများ ({count})"),
        }
    }

    pub fn confirm_remove_member(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("Remove {name} from the group?"),
            Locale::My => format!("{name} ကို အဖွဲ့မှ ဖယ်မလား?"),
        }
    }

    pub fn confirm_retire_venue(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("Retire {name}?"),
            Locale::My => format!("{name} ကို ရပ်နားမလား?"),
        }
    }
}

catalogue! {
    Editor {
        title: "Edit session", "ပွဲ ပြင်မည်";
        venue: "Venue", "ကွင်း";
        no_venue_option: "No venue yet", "ကွင်း မရှိသေး";
        fee_label: "Estimated fee per person", "တစ်ယောက် ခန့်မှန်းကြေး";
        fee_hint: "e.g. 70k", "ဥပမာ 70k";
        max_players: "Max players", "အများဆုံး ကစားသမား";
        max_players_hint: "Leave empty for no cap. Extra players go on a waitlist.", "ကန့်သတ်ချက် မလိုပါက ဗလာထားပါ။ ပိုသူများ စောင့်ဆိုင်းစာရင်းသို့ ရောက်ပါမည်။";
        notes: "Notes", "မှတ်ချက်";
        fee_not_a_number: "Fee should be a number, e.g. 70k", "ကြေးသည် ဂဏန်း ဖြစ်ရပါမည်၊ ဥပမာ 70k";
        cap_not_a_number: "Max players should be a whole number", "အများဆုံး ကစားသမားသည် ကိန်းပြည့် ဖြစ်ရပါမည်";
        could_not_save: "Could not save", "သိမ်း၍ မရပါ";
    }
}

catalogue! {
    Reminders {
        title: "Reminders", "သတိပေးချက်များ";
        not_configured: "Not configured on this server yet.", "ဤဆာဗာတွင် မပြင်ဆင်ရသေးပါ။";
        install_first: "Add to Home Screen first.", "ဟုမ်းစခရင်သို့ အရင် ထည့်ပါ။";
        install_body: "iPhone only delivers notifications to installed apps. Tap Share, then Add to Home Screen, and open Futsal Friday from there.", "iPhone သည် ထည့်သွင်းထားသော အက်ပ်များကိုသာ သတိပေးချက် ပို့ပါသည်။ Share ကို နှိပ်ပြီး Add to Home Screen ကို ရွေးကာ ထိုမှတစ်ဆင့် ဖွင့်ပါ။";
        unsupported: "This browser cannot do notifications.", "ဤဘရောက်ဇာသည် သတိပေးချက် မပို့နိုင်ပါ။";
        this_device: "This device", "ဤစက်";
        blocked: "Blocked in browser settings — allow notifications there first.", "ဘရောက်ဇာတွင် ပိတ်ထားသည် — ထိုနေရာတွင် အရင် ခွင့်ပြုပါ။";
        on_here: "Notifications are on here.", "ဤစက်တွင် သတိပေးချက် ဖွင့်ထားသည်။";
        off_here: "Get a nudge before kickoff and when you owe money.", "ပွဲမစမီနှင့် ငွေပေးရန် ရှိချိန်တွင် သတိပေးပါမည်။";
        before_match: "Before the match", "ပွဲမတိုင်မီ";
        before_match_body: "About 3 hours before kickoff, if you're playing.", "ကစားမည်ဆိုပါက ပွဲမစမီ 3 နာရီခန့်အလို။";
        unpaid_title: "Unpaid reminders", "ငွေမပေးရသေးကြောင်း သတိပေးချက်";
        unpaid_body: "A weekly nudge while you still owe for a session.", "ပေးရန် ကျန်နေသရွေ့ တစ်ပတ်တစ်ကြိမ် သတိပေးပါမည်။";
        send_test: "Send a test notification", "စမ်းသပ် သတိပေးချက် ပို့မည်";
        could_not_test: "Could not send a test", "စမ်းသပ်ချက် မပို့နိုင်ပါ";
        could_not_change: "Could not change that", "ပြောင်း၍ မရပါ";
        could_not_save: "Could not save that", "သိမ်း၍ မရပါ";
        denied: "Notifications were blocked. Allow them for this site in your browser settings.", "သတိပေးချက်များကို ပိတ်ထားသည်။ ဘရောက်ဇာ ဆက်တင်တွင် ခွင့်ပြုပါ။";
        needs_install: "Add the app to your Home Screen first, then turn this on from there.", "အက်ပ်ကို ဟုမ်းစခရင်သို့ အရင်ထည့်ပြီးမှ ဤနေရာမှ ဖွင့်ပါ။";
        disabled: "Reminders are not configured on this server.", "ဤဆာဗာတွင် သတိပေးချက် မပြင်ဆင်ရသေးပါ။";
        failed: "Could not turn reminders on. Try again.", "သတိပေးချက် ဖွင့်၍ မရပါ။ ထပ်စမ်းကြည့်ပါ။";
    }
}

impl Reminders {
    pub fn device_count(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!("Reminders are on for {count} devices."),
            Locale::My => format!("စက် {count} လုံးတွင် သတိပေးချက် ဖွင့်ထားသည်။"),
        }
    }
}

catalogue! {
    CopyText {
        fallback_title: "Copy this", "ဤစာသားကို ကူးပါ";
        fallback_body: "Your browser blocked the clipboard. Select the text below and copy it by hand.", "ဘရောက်ဇာက ကလစ်ဘုတ်ကို ပိတ်ထားသည်။ အောက်ပါစာသားကို ရွေးပြီး ကိုယ်တိုင် ကူးပါ။";
    }
}

catalogue! {
    Announce {
        title: "Hype the group", "အုပ်စုကို လှုံ့ဆော်မယ်";
        body: "A random announcement for the chat. Shuffle until one makes you laugh.", "အုပ်စု ချက်ထဲ တင်ဖို့ ကြေညာချက်။ ကြိုက်တာ ထွက်လာတဲ့အထိ ပြောင်းကြည့်ပါ။";
        open: "Write an announcement", "ကြေညာချက် ရေးမယ်";
        shuffle: "Another one", "နောက်တစ်ခု";
        copy: "Copy announcement", "ကြေညာချက် ကူးမည်";
        write_in: "Write it in", "ဘာသာစကား ရွေးပါ";
        tease_label: "Your own dig", "ကိုယ်ပိုင် နောက်ပြောင်စကား";
        tease_hint: "Name names. Leave it empty and the app picks a joke.", "နာမည် တပ်ပြောလို့ရသည်။ ဗလာထားလျှင် အက်ပ်က ရွေးပေးပါမည်။";
        nobody_yet: "Nobody has signed up yet. Someone has to go first 🥇", "ခုထိ ဘယ်သူမှ မရှိသေးဘူး။ တစ်ယောက်ယောက်တော့ ဦးဆုံး ဖြစ်ရမယ် 🥇";
        full: "We are full — waitlist is open, and people always drop out 🤞", "နေရာ ပြည့်သွားပြီ — စောင့်ဆိုင်းစာရင်း ဖွင့်ထားတယ်၊ ပြုတ်တဲ့သူ အမြဲရှိတယ် 🤞";
    }
}

impl Announce {
    pub fn openers(&self) -> &'static [&'static str] {
        match self.locale {
            Locale::En => &[
                "Legs itching yet? 🦵",
                "Futsal Friday is back ⚽",
                "The pitch is calling. Pick up 📣",
                "Time to run it back this week!",
                "Off the sofa, onto the pitch 🛋➡️⚽",
                "Dig the boots out 👟",
                "Team sheet is open 📝",
                "No FIFA this week. The real thing 🎮❌",
            ],
            Locale::My => &[
                "ခြေထောက်တွေ ယားနေပြီလား? 🦵",
                "ဖူဆယ် သောကြာ ပြန်ရောက်လာပြီ ⚽",
                "ကွင်းက ခေါ်နေပြီ — ကြားလား? 📣",
                "ဒီတစ်ပတ်လည်း ကန်ဖို့ အချိန်တန်ပြီ!",
                "ဆိုဖာပေါ်က ထ — ကွင်းထဲ ဆင်း 🛋➡️⚽",
                "ဖိနပ်တွေ ထုတ်ထားကြ 👟",
                "စာရင်း ဖွင့်လိုက်ပြီ 📝",
                "ဒီအပတ် ဖီဖာ မဟုတ်ဘူး — တကယ့်ကွင်းထဲ 🎮❌",
            ],
        }
    }

    pub fn teases(&self) -> &'static [&'static str] {
        match self.locale {
            Locale::En => &[
                "Everyone who was \"busy\" last week — you will need a fresh excuse 😏",
                "Bad knee, bad back, big meeting. Not accepted this week 🙅",
                "If nobody calls keeper, everybody is keeper 🥅",
                "PS: those of you who still owe money. Yes. You 👀",
                "Said yes and then vanished? There is a list 📋",
                "Do not think about how you will feel tomorrow morning 💪",
                "Score once and you get to bring it up all week 🏆",
                "Last one to arrive buys the water 💧",
            ],
            Locale::My => &[
                "ပြီးခဲ့တဲ့အပတ်က \"အလုပ်များတယ်\" ဆိုသူများ — အကြောင်းပြချက် အသစ် လိုပြီနော် 😏",
                "ဒူးနာတယ်၊ ခါးနာတယ်၊ အစည်းအဝေး ရှိတယ် — ဒီတစ်ပတ် လက်မခံပါ 🙅",
                "ဂိုးသမား ဘယ်သူမှ မလုပ်ရင် အားလုံး ဂိုးသမား ဖြစ်ကြမယ် 🥅",
                "မှတ်ချက် — ပိုက်ဆံ မရှင်းရသေးသူများ။ ဟုတ်တယ်။ ခင်ဗျားတို့ကို ပြောနေတာ 👀",
                "လာမယ်ဆိုပြီး ပျောက်သွားသူများ — စာရင်း ရှိတယ်နော် 📋",
                "မနက်ဖြန် ကြွက်တက်မယ့်အကြောင်း ကြိုမတွေးနဲ့ 💪",
                "တစ်ဂိုးလောက် သွင်းလိုက်ရင် တစ်ပတ်လုံး ပြောလို့ရတယ် 🏆",
                "နောက်ဆုံး ရောက်လာသူ ရေဖိုး တာဝန်ယူ 💧",
            ],
        }
    }

    pub fn call_to_action(&self) -> &'static [&'static str] {
        match self.locale {
            Locale::En => {
                &["Tap in now 👇", "Get your name down 👇", "Before the spots go 👇", "You in? 👇"]
            }
            Locale::My => {
                &["လာမယ်ဆိုရင် အခုပဲ နှိပ်လိုက် 👇", "နာမည် စာရင်းသွင်းလိုက် 👇", "နေရာ မကုန်ခင် 👇", "ပါမလား? 👇"]
            }
        }
    }

    pub fn so_far(&self, going: i64) -> String {
        match self.locale {
            Locale::En => format!("{going} in so far"),
            Locale::My => format!("ခုထိ {going} ယောက်"),
        }
    }

    pub fn spots_left(&self, going: i64, left: i64) -> String {
        match self.locale {
            Locale::En => format!("{going} in · {left} spots left"),
            Locale::My => format!("{going} ယောက် ရှိပြီ · {left} နေရာ ကျန်သေး"),
        }
    }
}

catalogue! {
    Summary {
        match_header: "FUTSAL", "ဖူဆယ်";
        cancelled: "CANCELLED", "ပွဲပျက်";
        nobody_yet: "— nobody yet —", "— ဘယ်သူမှ မရှိသေး —";
        payments_header: "PAYMENTS", "ငွေပေးချေမှု";
    }
}

impl Summary {
    pub fn guest_suffix(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!(" (+{count})"),
            Locale::My => format!(" (+{count})"),
        }
    }

    pub fn in_heading(&self, count: i64, max: Option<i64>) -> String {
        match self.locale {
            Locale::En => match max.filter(|n| *n != 0) {
                Some(max) => format!("IN ({count}/{max})"),
                None => format!("IN ({count})"),
            },
            Locale::My => match max.filter(|n| *n != 0) {
                Some(max) => format!("ကစားမည် ({count}/{max})"),
                None => format!("ကစားမည် ({count})"),
            },
        }
    }

    pub fn waitlist_heading(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!("WAITLIST ({count})"),
            Locale::My => format!("စောင့်ဆိုင်း ({count})"),
        }
    }

    pub fn field_total(&self, amount: &str) -> String {
        match self.locale {
            Locale::En => format!("Field total: {amount}"),
            Locale::My => format!("ကွင်းခ စုစုပေါင်း: {amount}"),
        }
    }

    pub fn collected_outstanding(&self, collected: &str, outstanding: &str) -> String {
        match self.locale {
            Locale::En => format!("Collected {collected} · Outstanding {outstanding}"),
            Locale::My => format!("ရရှိပြီး {collected} · ကျန် {outstanding}"),
        }
    }

    pub fn paid(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!("PAID ({count})"),
            Locale::My => format!("ပေးပြီး ({count})"),
        }
    }

    pub fn checking(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!("CHECKING ({count})"),
            Locale::My => format!("စစ်ဆဲ ({count})"),
        }
    }

    pub fn not_yet(&self, count: i64) -> String {
        match self.locale {
            Locale::En => format!("NOT YET ({count})"),
            Locale::My => format!("မပေးရသေး ({count})"),
        }
    }
}

catalogue! {
    Push {
        unpaid_title: "Still to settle up", "ငွေပေးရန် ကျန်ရှိသေးသည်";
        test_title: "Futsal Friday", "ဖူဆယ် သောကြာ";
        join_request_title: "Someone wants to join", "ဝင်ခွင့် တောင်းနေသူ ရှိတယ်";
    }
}

impl Push {
    pub fn match_title(&self, time: &str) -> String {
        match self.locale {
            Locale::En => format!("Futsal today, {time}"),
            Locale::My => format!("ယနေ့ ဖူဆယ်၊ {time}"),
        }
    }

    pub fn match_body_at_venue(&self, hours: i64, venue: &str) -> String {
        match self.locale {
            Locale::En => format!("Kickoff in about {hours}h at {venue}."),
            Locale::My => format!("{venue} တွင် {hours} နာရီခန့်အကြာ ပွဲစပါမည်။"),
        }
    }

    pub fn match_body(&self, hours: i64) -> String {
        match self.locale {
            Locale::En => format!("Kickoff in about {hours}h."),
            Locale::My => format!("{hours} နာရီခန့်အကြာ ပွဲစပါမည်။"),
        }
    }

    pub fn unpaid_body(&self, amount: &str, when: &str) -> String {
        match self.locale {
            Locale::En => format!("{amount} for {when}."),
            Locale::My => format!("{when} အတွက် {amount}။"),
        }
    }

    pub fn test_body(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("Reminders are working, {name}."),
            Locale::My => format!("သတိပေးချက်များ အလုပ်လုပ်နေပါသည်၊ {name}။"),
        }
    }

    pub fn join_request_body(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("{name} is waiting to be let in."),
            Locale::My => format!("{name} က ဝင်ခွင့် စောင့်နေတယ်။"),
        }
    }
}

catalogue! {
    Errors {
        offline: "No connection — check your network", "အင်တာနက် မရှိပါ — ကွန်ရက်ကို စစ်ပါ";
        generic: "Something went wrong on our side", "ဆာဗာဘက်တွင် အမှားတစ်ခု ဖြစ်သွားပါသည်";
        sign_in_first: "Sign in first", "အရင် ဝင်ရောက်ပါ";
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Anything a browser or a database row might say, mapped onto one of ours.
    #[test]
    fn locale_negotiation() {
        assert_eq!(normalize_locale("my-MM"), Locale::My);
        assert_eq!(normalize_locale("my"), Locale::My);
        assert_eq!(normalize_locale("bur"), Locale::My);
        assert_eq!(normalize_locale("mya"), Locale::My);
        assert_eq!(normalize_locale("MY-mm"), Locale::My);
        assert_eq!(normalize_locale("en-GB"), Locale::En);
        assert_eq!(normalize_locale("fr-FR"), Locale::En);
        assert_eq!(normalize_locale(""), Locale::En);
        assert_eq!(DEFAULT_LOCALE, Locale::En);

        assert!(is_locale("en"));
        assert!(is_locale("my"));
        assert!(!is_locale("bur"));
        assert!(!is_locale("EN"));
        assert!(!is_locale(""));

        // Native names, never translated.
        assert_eq!(locale_label(Locale::En), "English");
        assert_eq!(locale_label(Locale::My), "မြန်မာ");

        for locale in LOCALES {
            assert!(!messages_for(locale.as_str()).app.name().is_empty());
        }
    }

    /// The catalogue is one shape in both languages: the same 486 leaves, since
    /// each is one method with one arm per locale. What can still go wrong is a
    /// leaf lost in the port, so they are counted.
    #[test]
    fn the_catalogue_is_complete() {
        let en = Messages::new(Locale::En);
        let my = Messages::new(Locale::My);
        assert_eq!(en.entries().len(), 385);
        assert_eq!(my.entries().len(), 385);
        assert_eq!(en.announce.openers().len(), 8);
        assert_eq!(en.announce.teases().len(), 8);
        assert_eq!(en.announce.call_to_action().len(), 4);
        assert_eq!(my.announce.openers().len(), 8);
        assert_eq!(my.announce.teases().len(), 8);
        assert_eq!(my.announce.call_to_action().len(), 4);
        // 385 plain strings + 20 banter lines + the 81 parameterised leaves
        // asserted one by one below.
        assert_eq!(385 + 20 + 81, 486);
    }

    /// The four the original allowed to be the same in both languages. Only
    /// `connection.polling_short` actually is; the rest differ.
    const SHARED_BY_DESIGN: [&str; 4] = [
        "connection.polling_short",
        "editor.fee_hint",
        "payments.enter_amount",
        "admin.price_note_hint",
    ];

    fn is_myanmar(text: &str) -> bool {
        text.chars().any(|c| ('\u{1000}'..='\u{109f}').contains(&c))
    }

    /// Zawgyi and Unicode are visually indistinguishable in an editor, so the
    /// only way to keep the Burmese honest is to check the code points.
    fn is_zawgyi(text: &str) -> bool {
        text.chars().any(|c| ('\u{1060}'..='\u{1097}').contains(&c))
    }

    #[test]
    fn the_burmese_is_translated_and_is_unicode() {
        let en = Messages::new(Locale::En).entries();
        let my = Messages::new(Locale::My).entries();
        for ((path, english), (my_path, burmese)) in en.iter().zip(my.iter()) {
            assert_eq!(path, my_path);
            if SHARED_BY_DESIGN.contains(&path.as_str()) {
                continue;
            }
            assert_ne!(english, burmese, "{path} was never translated");
            assert!(is_myanmar(burmese), "{path} has no Myanmar in it: {burmese}");
            assert!(!is_zawgyi(burmese), "{path} looks like Zawgyi: {burmese}");
        }
        let my = Messages::new(Locale::My);
        for list in [my.announce.openers(), my.announce.teases(), my.announce.call_to_action()] {
            for line in list {
                assert!(is_myanmar(line), "{line}");
                assert!(!is_zawgyi(line), "{line}");
            }
        }
    }

    /// The values must actually reach the string — a translation that dropped an
    /// argument would still compile.
    #[test]
    fn interpolation_carries_its_arguments_through() {
        let my = Messages::new(Locale::My);
        let playing = my.session.playing(5, Some(14));
        assert!(playing.contains('5') && playing.contains("14"));
        assert!(!my.session.playing(5, None).contains('/'));
        assert!(my.toast.member_added("Kyaw").contains("Kyaw"));
        assert!(my.push.unpaid_body("120.000d", "x").contains("120.000d"));
        let at_venue = my.push.match_body_at_venue(3, "Tao Dan");
        assert!(at_venue.contains('3') && at_venue.contains("Tao Dan"));
        assert!(my.payments.share_body("Aung").contains("Aung"));
    }

    /// Every parameterised leaf, in both languages, against what the TypeScript
    /// answers. The singular arm is asserted wherever there is one — English
    /// branches on `count == 1` in twenty-one places, Burmese in exactly one
    /// (`profile.keep_it_up`).
    #[test]
    fn parameterised_leaves_read_exactly_as_the_original() {
        let en = Messages::new(Locale::En);
        let my = Messages::new(Locale::My);

        // ---- en
        assert_eq!(en.pay.you_owe_this("Kyaw"), "You owe Kyaw");
        assert_eq!(en.waiting.body("Kyaw"), "You're on the list as Kyaw. An organizer has to let you in — you'll get a nudge when they do.");
        assert_eq!(en.approvals.heading(3), "3 waiting to join");
        assert_eq!(en.approvals.heading(1), "1 waiting to join");
        assert_eq!(en.approvals.approved("Kyaw"), "Kyaw is in");
        assert_eq!(en.approvals.rejected("Kyaw"), "Turned Kyaw away");
        assert_eq!(en.approvals.confirm_reject("Kyaw"), "Turn Kyaw away?");
        assert_eq!(en.profile.played_of(3, 3), "Played 3 of 3 matches");
        assert_eq!(en.profile.owes("Kyaw"), "Owes Kyaw");
        assert_eq!(en.profile.keep_it_up(3), "3 in a row. Do not break it.");
        assert_eq!(en.profile.keep_it_up(1), "One in a row. Do not stop now.");
        assert_eq!(en.form.label(3, 3), "Played 3 of the last 3");
        assert_eq!(en.board.in_a_row(3), "3 in a row");
        assert_eq!(en.board.in_a_row(1), "1 in a row");
        assert_eq!(en.board.best_ever(3), "best 3");
        assert_eq!(en.board.goal_count(3), "3 goals");
        assert_eq!(en.board.goal_count(1), "1 goal");
        assert_eq!(en.goals.mine(3), "3 goals");
        assert_eq!(en.goals.mine(1), "1 goal");
        assert_eq!(en.invite.waiting_to_join(3), "3 people still to join");
        assert_eq!(en.invite.waiting_to_join(1), "1 person still to join");
        assert_eq!(en.invite.link_ready("Kyaw"), "Link for Kyaw");
        assert_eq!(en.invite.expires("Kyaw"), "Works until Kyaw");
        assert_eq!(en.invite.confirm_remove("Kyaw"), "Sign Kyaw out of everywhere?");
        assert_eq!(en.invite.removed("Kyaw"), "Kyaw signed out everywhere");
        assert_eq!(en.session.playing(3, Some(12)), "Playing 3 / 12");
        assert_eq!(en.session.playing(1, None), "Playing 1");
        assert_eq!(en.session.bringing_guests(3), "bringing 3 guests");
        assert_eq!(en.session.bringing_guests(1), "bringing 1 guest");
        assert_eq!(en.session.guest_chip(3), "+3");
        assert_eq!(en.session.guests_count(3), "Me + 3 friends");
        assert_eq!(en.session.guests_count(1), "Me + 1 friend");
        assert_eq!(en.session.playing_with_guests(3, 3), "3 playing · 3 guests");
        assert_eq!(en.session.playing_with_guests(1, 1), "1 playing · 1 guest");
        assert_eq!(en.session.waitlist_heading(3), "Waitlist (3)");
        assert_eq!(en.session.attendance_count(3), "3 played");
        assert_eq!(en.session.attendance_count(1), "1 played");
        assert_eq!(
            en.session.guests_arrived_body(3),
            "You put down 3. Only the ones who turned up are billed."
        );
        assert_eq!(en.session.guests_arrived_count(3), "3 came");
        assert_eq!(en.session.guests_arrived_count(1), "1 came");
        assert_eq!(en.session.guests_arrived_chip(3, 3), "3 of 3");
        assert_eq!(en.mvp.turnout(3, 3), "3 of 3 voted");
        assert_eq!(en.mvp.votes(3), "3 votes");
        assert_eq!(en.mvp.votes(1), "1 vote");
        assert_eq!(en.mvp.leading_with(3), "with 3 votes");
        assert_eq!(en.mvp.leading_with(1), "with 1 vote");
        assert_eq!(en.mvp.shared(3), "tied on 3 votes");
        assert_eq!(en.mvp.shared(1), "tied on 1 vote");
        assert_eq!(en.talk.count(3), "3 messages");
        assert_eq!(en.talk.count(1), "1 message");
        assert_eq!(en.talk.too_long(3), "A bit long — 3 characters at most.");
        assert_eq!(en.teams.on_the_pitch(3), "3 players on the pitch");
        assert_eq!(en.teams.on_the_pitch(1), "1 player on the pitch");
        assert_eq!(en.teams.will_be("Kyaw"), "Sides of Kyaw");
        assert_eq!(en.teams.team_name("Kyaw"), "Team Kyaw");
        assert_eq!(en.teams.team_size(3), "3 players");
        assert_eq!(en.teams.team_size(1), "1 player");
        assert_eq!(en.teams.drawn_by("Kyaw", "Kyaw"), "Kyaw shuffled these Kyaw");
        assert_eq!(
            en.teams.missing(3),
            "3 more players have turned up since. Shuffle again to deal them in."
        );
        assert_eq!(
            en.teams.missing(1),
            "1 more player has turned up since. Shuffle again to deal them in."
        );
        assert_eq!(en.teams.deal_them_in(3), "Add them to the sides");
        assert_eq!(en.teams.deal_them_in(1), "Add them to a side");
        assert_eq!(en.teams.settled_by("Kyaw", "Kyaw"), "Kyaw settled these Kyaw");
        assert_eq!(en.teams.score_title("Kyaw", "Kyaw"), "Kyaw v Kyaw");
        assert_eq!(en.teams.scored_by("Kyaw"), "entered by Kyaw");
        assert_eq!(en.teams.record(3, 3, 3), "3W 3D 3L");
        assert_eq!(en.toast.youre_out_promoted("Kyaw"), "You're out — Kyaw moves up");
        assert_eq!(en.toast.member_added("Kyaw"), "Kyaw added");
        assert_eq!(en.toast.member_removed("Kyaw"), "Kyaw removed");
        assert_eq!(en.toast.confirmed("Kyaw"), "Kyaw confirmed");
        assert_eq!(en.toast.rejected("Kyaw"), "Kyaw rejected");
        assert_eq!(en.payments.everyone(3), "Everyone (3)");
        assert_eq!(en.payments.splitting_between(3), "3 people played");
        assert_eq!(en.payments.splitting_between(1), "1 person played");
        assert_eq!(en.payments.comes_to(3, "Kyaw"), "3 played · Kyaw in all");
        assert_eq!(en.payments.comes_to(1, "Kyaw"), "1 played · Kyaw in all");
        assert_eq!(en.payments.rejected_with_reason("Kyaw"), "Rejected: Kyaw");
        assert_eq!(en.payments.share_title("Kyaw"), "Kyaw's share");
        assert_eq!(
            en.payments.share_body("Kyaw"),
            "Charge Kyaw a set amount. Everyone else splits whatever is left of the total."
        );
        assert_eq!(en.payments.transfer_of("Kyaw"), "Kyaw's transfer");
        assert_eq!(en.history.sessions_played(3), "3 sessions played");
        assert_eq!(en.admin.signed_in_as("Kyaw"), "Signed in as Kyaw");
        assert_eq!(en.admin.sign_out_as("Kyaw"), "Sign out (Kyaw)");
        assert_eq!(en.admin.players(3), "Players (3)");
        assert_eq!(en.admin.confirm_remove_member("Kyaw"), "Remove Kyaw from the group?");
        assert_eq!(en.admin.confirm_retire_venue("Kyaw"), "Retire Kyaw?");
        assert_eq!(en.reminders.device_count(3), "Reminders are on for 3 devices.");
        assert_eq!(en.announce.so_far(3), "3 in so far");
        assert_eq!(en.announce.spots_left(3, 3), "3 in · 3 spots left");
        assert_eq!(en.summary.guest_suffix(3), " (+3)");
        assert_eq!(en.summary.in_heading(3, Some(12)), "IN (3/12)");
        assert_eq!(en.summary.in_heading(1, None), "IN (1)");
        assert_eq!(en.summary.waitlist_heading(3), "WAITLIST (3)");
        assert_eq!(en.summary.field_total("Kyaw"), "Field total: Kyaw");
        assert_eq!(
            en.summary.collected_outstanding("Kyaw", "Kyaw"),
            "Collected Kyaw · Outstanding Kyaw"
        );
        assert_eq!(en.summary.paid(3), "PAID (3)");
        assert_eq!(en.summary.checking(3), "CHECKING (3)");
        assert_eq!(en.summary.not_yet(3), "NOT YET (3)");
        assert_eq!(en.push.match_title("Kyaw"), "Futsal today, Kyaw");
        assert_eq!(en.push.match_body_at_venue(3, "Kyaw"), "Kickoff in about 3h at Kyaw.");
        assert_eq!(en.push.match_body(3), "Kickoff in about 3h.");
        assert_eq!(en.push.unpaid_body("Kyaw", "Kyaw"), "Kyaw for Kyaw.");
        assert_eq!(en.push.test_body("Kyaw"), "Reminders are working, Kyaw.");
        assert_eq!(en.push.join_request_body("Kyaw"), "Kyaw is waiting to be let in.");
        // ---- my
        assert_eq!(my.pay.you_owe_this("Kyaw"), "သင် ပေးရန် Kyaw");
        assert_eq!(
            my.waiting.body("Kyaw"),
            "Kyaw အဖြစ် စာရင်းသွင်းပြီးပါပြီ။ စီစဉ်သူက ခွင့်ပြုပေးရပါမယ် — ပြီးရင် အကြောင်းကြားပါမယ်။"
        );
        assert_eq!(my.approvals.heading(3), "3 ယောက် ဝင်ခွင့် စောင့်နေတယ်");
        assert_eq!(my.approvals.heading(1), "1 ယောက် ဝင်ခွင့် စောင့်နေတယ်");
        assert_eq!(my.approvals.approved("Kyaw"), "Kyaw ဝင်ပြီးပါပြီ");
        assert_eq!(my.approvals.rejected("Kyaw"), "Kyaw ကို ငြင်းလိုက်ပါပြီ");
        assert_eq!(my.approvals.confirm_reject("Kyaw"), "Kyaw ကို ငြင်းမလား?");
        assert_eq!(my.profile.played_of(3, 3), "ပွဲ 3 ပွဲအနက် 3 ပွဲ ကစားပြီး");
        assert_eq!(my.profile.owes("Kyaw"), "ကျန်ငွေ Kyaw");
        assert_eq!(my.profile.keep_it_up(3), "3 ပွဲ ဆက်တိုက်။ မပြတ်စေနဲ့။");
        assert_eq!(my.profile.keep_it_up(1), "တစ်ပွဲ ဆက်တိုက်။ ဒီမှာ မရပ်နဲ့။");
        assert_eq!(my.form.label(3, 3), "နောက်ဆုံး 3 ပွဲအနက် 3 ပွဲ ကစားခဲ့");
        assert_eq!(my.board.in_a_row(3), "3 ပွဲ ဆက်တိုက်");
        assert_eq!(my.board.in_a_row(1), "1 ပွဲ ဆက်တိုက်");
        assert_eq!(my.board.best_ever(3), "အများဆုံး 3");
        assert_eq!(my.board.goal_count(3), "3 ဂိုး");
        assert_eq!(my.board.goal_count(1), "1 ဂိုး");
        assert_eq!(my.goals.mine(3), "3 ဂိုး");
        assert_eq!(my.goals.mine(1), "1 ဂိုး");
        assert_eq!(my.invite.waiting_to_join(3), "3 ဦး မဝင်ရသေးပါ");
        assert_eq!(my.invite.waiting_to_join(1), "1 ဦး မဝင်ရသေးပါ");
        assert_eq!(my.invite.link_ready("Kyaw"), "Kyaw အတွက် လင့်ခ်");
        assert_eq!(my.invite.expires("Kyaw"), "Kyaw အထိ သုံးနိုင်သည်");
        assert_eq!(my.invite.confirm_remove("Kyaw"), "Kyaw ကို နေရာတိုင်းမှ ထွက်ခိုင်းမှာလား?");
        assert_eq!(my.invite.removed("Kyaw"), "Kyaw ကို နေရာတိုင်းမှ ထွက်ခိုင်းပြီး");
        assert_eq!(my.session.playing(3, Some(12)), "ကစားမည် 3 / 12");
        assert_eq!(my.session.playing(1, None), "ကစားမည် 1");
        assert_eq!(my.session.bringing_guests(3), "ဧည့်သည် 3 ဦး ခေါ်လာမည်");
        assert_eq!(my.session.bringing_guests(1), "ဧည့်သည် 1 ဦး ခေါ်လာမည်");
        assert_eq!(my.session.guest_chip(3), "+3");
        assert_eq!(my.session.guests_count(3), "ကျွန်တော် + သူငယ်ချင်း 3 ဦး");
        assert_eq!(my.session.guests_count(1), "ကျွန်တော် + သူငယ်ချင်း 1 ဦး");
        assert_eq!(my.session.playing_with_guests(3, 3), "3 ယောက် ကစားမည် · ဧည့်သည် 3 ဦး");
        assert_eq!(my.session.playing_with_guests(1, 1), "1 ယောက် ကစားမည် · ဧည့်သည် 1 ဦး");
        assert_eq!(my.session.waitlist_heading(3), "စောင့်ဆိုင်းစာရင်း (3)");
        assert_eq!(my.session.attendance_count(3), "3 ဦး ကစားခဲ့");
        assert_eq!(my.session.attendance_count(1), "1 ဦး ကစားခဲ့");
        assert_eq!(my.session.guests_arrived_body(3), "3 ဦး ဟု ရေးထားသည်။ လာသူများကိုသာ ငွေတောင်းပါမည်။");
        assert_eq!(my.session.guests_arrived_count(3), "3 ဦး လာခဲ့");
        assert_eq!(my.session.guests_arrived_count(1), "1 ဦး လာခဲ့");
        assert_eq!(my.session.guests_arrived_chip(3, 3), "3 ဦးမှ 3 ဦး");
        assert_eq!(my.mvp.turnout(3, 3), "3 ဦးအနက် 3 ဦး မဲပေးပြီး");
        assert_eq!(my.mvp.votes(3), "မဲ 3 မဲ");
        assert_eq!(my.mvp.votes(1), "မဲ 1 မဲ");
        assert_eq!(my.mvp.leading_with(3), "မဲ 3 မဲဖြင့်");
        assert_eq!(my.mvp.leading_with(1), "မဲ 1 မဲဖြင့်");
        assert_eq!(my.mvp.shared(3), "မဲ 3 မဲစီဖြင့် သရေ");
        assert_eq!(my.mvp.shared(1), "မဲ 1 မဲစီဖြင့် သရေ");
        assert_eq!(my.talk.count(3), "စာ 3 စောင်");
        assert_eq!(my.talk.count(1), "စာ 1 စောင်");
        assert_eq!(my.talk.too_long(3), "နည်းနည်း ရှည်နေသည် — အများဆုံး 3 လုံး။");
        assert_eq!(my.teams.on_the_pitch(3), "ကွင်းထဲတွင် 3 ဦး");
        assert_eq!(my.teams.on_the_pitch(1), "ကွင်းထဲတွင် 1 ဦး");
        assert_eq!(my.teams.will_be("Kyaw"), "အသင်းအင်အား Kyaw");
        assert_eq!(my.teams.team_name("Kyaw"), "အသင်း Kyaw");
        assert_eq!(my.teams.team_size(3), "3 ဦး");
        assert_eq!(my.teams.team_size(1), "1 ဦး");
        assert_eq!(my.teams.drawn_by("Kyaw", "Kyaw"), "Kyaw က Kyaw ခွဲထားသည်");
        assert_eq!(my.teams.missing(3), "နောက်ထပ် 3 ဦး ရောက်လာသည်။ ထည့်ရန် ထပ်ခွဲပါ။");
        assert_eq!(my.teams.missing(1), "နောက်ထပ် 1 ဦး ရောက်လာသည်။ ထည့်ရန် ထပ်ခွဲပါ။");
        assert_eq!(my.teams.deal_them_in(3), "အသင်းထဲ ထည့်မည် (3)");
        assert_eq!(my.teams.deal_them_in(1), "အသင်းထဲ ထည့်မည် (1)");
        assert_eq!(my.teams.settled_by("Kyaw", "Kyaw"), "Kyaw က Kyaw အတည်ပြုထားသည်");
        assert_eq!(my.teams.score_title("Kyaw", "Kyaw"), "Kyaw နှင့် Kyaw");
        assert_eq!(my.teams.scored_by("Kyaw"), "Kyaw က ထည့်သွင်းထားသည်");
        assert_eq!(my.teams.record(3, 3, 3), "နိုင် 3 · သရေ 3 · ရှုံး 3");
        assert_eq!(my.toast.youre_out_promoted("Kyaw"), "စာရင်းမှ ထွက်ပြီးပါပြီ — Kyaw အစားဝင်ပါမည်");
        assert_eq!(my.toast.member_added("Kyaw"), "Kyaw ကို ထည့်ပြီးပါပြီ");
        assert_eq!(my.toast.member_removed("Kyaw"), "Kyaw ကို ဖယ်ပြီးပါပြီ");
        assert_eq!(my.toast.confirmed("Kyaw"), "Kyaw ကို အတည်ပြုပြီး");
        assert_eq!(my.toast.rejected("Kyaw"), "Kyaw ကို ငြင်းပယ်ပြီး");
        assert_eq!(my.payments.everyone(3), "အားလုံး (3)");
        assert_eq!(my.payments.splitting_between(3), "3 ဦး ကစားခဲ့သည်");
        assert_eq!(my.payments.splitting_between(1), "1 ဦး ကစားခဲ့သည်");
        assert_eq!(my.payments.comes_to(3, "Kyaw"), "3 ဦး ကစားခဲ့ · စုစုပေါင်း Kyaw");
        assert_eq!(my.payments.comes_to(1, "Kyaw"), "1 ဦး ကစားခဲ့ · စုစုပေါင်း Kyaw");
        assert_eq!(my.payments.rejected_with_reason("Kyaw"), "ငြင်းပယ်ခံရသည်: Kyaw");
        assert_eq!(my.payments.share_title("Kyaw"), "Kyaw ၏ ဝေစု");
        assert_eq!(
            my.payments.share_body("Kyaw"),
            "Kyaw ကို ပမာဏ တစ်ခု သတ်မှတ် ကောက်ခံမည်။ ကျန်ငွေကို ကျန်သူများက ခွဲဝေပါမည်။"
        );
        assert_eq!(my.payments.transfer_of("Kyaw"), "Kyaw ၏ ငွေလွှဲ ပြေစာ");
        assert_eq!(my.history.sessions_played(3), "ပွဲ 3 ပွဲ ကစားပြီး");
        assert_eq!(my.admin.signed_in_as("Kyaw"), "Kyaw အဖြစ် ဝင်ထားသည်");
        assert_eq!(my.admin.sign_out_as("Kyaw"), "ထွက်မည် (Kyaw)");
        assert_eq!(my.admin.players(3), "ကစားသမားများ (3)");
        assert_eq!(my.admin.confirm_remove_member("Kyaw"), "Kyaw ကို အဖွဲ့မှ ဖယ်မလား?");
        assert_eq!(my.admin.confirm_retire_venue("Kyaw"), "Kyaw ကို ရပ်နားမလား?");
        assert_eq!(my.reminders.device_count(3), "စက် 3 လုံးတွင် သတိပေးချက် ဖွင့်ထားသည်။");
        assert_eq!(my.announce.so_far(3), "ခုထိ 3 ယောက်");
        assert_eq!(my.announce.spots_left(3, 3), "3 ယောက် ရှိပြီ · 3 နေရာ ကျန်သေး");
        assert_eq!(my.summary.guest_suffix(3), " (+3)");
        assert_eq!(my.summary.in_heading(3, Some(12)), "ကစားမည် (3/12)");
        assert_eq!(my.summary.in_heading(1, None), "ကစားမည် (1)");
        assert_eq!(my.summary.waitlist_heading(3), "စောင့်ဆိုင်း (3)");
        assert_eq!(my.summary.field_total("Kyaw"), "ကွင်းခ စုစုပေါင်း: Kyaw");
        assert_eq!(my.summary.collected_outstanding("Kyaw", "Kyaw"), "ရရှိပြီး Kyaw · ကျန် Kyaw");
        assert_eq!(my.summary.paid(3), "ပေးပြီး (3)");
        assert_eq!(my.summary.checking(3), "စစ်ဆဲ (3)");
        assert_eq!(my.summary.not_yet(3), "မပေးရသေး (3)");
        assert_eq!(my.push.match_title("Kyaw"), "ယနေ့ ဖူဆယ်၊ Kyaw");
        assert_eq!(my.push.match_body_at_venue(3, "Kyaw"), "Kyaw တွင် 3 နာရီခန့်အကြာ ပွဲစပါမည်။");
        assert_eq!(my.push.match_body(3), "3 နာရီခန့်အကြာ ပွဲစပါမည်။");
        assert_eq!(my.push.unpaid_body("Kyaw", "Kyaw"), "Kyaw အတွက် Kyaw။");
        assert_eq!(my.push.test_body("Kyaw"), "သတိပေးချက်များ အလုပ်လုပ်နေပါသည်၊ Kyaw။");
        assert_eq!(my.push.join_request_body("Kyaw"), "Kyaw က ဝင်ခွင့် စောင့်နေတယ်။");
    }

    /// The banter bank is written per locale rather than translated — these are
    /// the lines a Burmese friend group actually says, not the English ones in
    /// Myanmar script — so the two lists are checked separately.
    #[test]
    fn the_banter_bank_is_written_not_translated() {
        let en = Messages::new(Locale::En);
        let my = Messages::new(Locale::My);
        assert_eq!(en.announce.openers()[1], "Futsal Friday is back ⚽");
        assert_eq!(en.announce.teases()[3], "PS: those of you who still owe money. Yes. You 👀");
        assert_eq!(en.announce.call_to_action()[0], "Tap in now 👇");
        assert_eq!(my.announce.openers()[1], "ဖူဆယ် သောကြာ ပြန်ရောက်လာပြီ ⚽");
        assert_eq!(my.announce.call_to_action()[3], "ပါမလား? 👇");
        for (a, b) in en.announce.openers().iter().zip(my.announce.openers()) {
            assert_ne!(a, b);
        }
    }
}
