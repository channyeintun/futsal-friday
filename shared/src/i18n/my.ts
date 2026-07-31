import type { Messages } from './index.js';

/**
 * Burmese (မြန်မာ).
 *
 * Two conventions worth stating, because they are easy to "fix" wrongly later:
 *
 *  - **Unicode, not Zawgyi.** Every string here is standard Myanmar Unicode.
 *    Pasting Zawgyi-encoded text in would render as garbage on any modern
 *    phone, and the two encodings are visually indistinguishable in an editor.
 *  - **Arabic numerals.** Times, counts and money stay as `19:30`, `120.000d`
 *    rather than Myanmar digits. That is what Myanmar apps overwhelmingly do
 *    for money and clock times, and it keeps amounts unambiguous next to the
 *    Vietnamese dong.
 *
 * Typed as `Messages`, so a key missing here — or one whose interpolation
 * arguments have drifted from English — fails the build.
 */
export const my: Messages = {
  app: {
    name: 'ဖူဆယ် သောကြာ',
    loading: 'ခဏစောင့်ပါ…',
    back: 'နောက်သို့',
    cancel: 'မလုပ်တော့ပါ',
    save: 'သိမ်းမည်',
    saving: 'သိမ်းနေသည်…',
    done: 'ပြီးပါပြီ',
    close: 'ပိတ်မည်',
    add: 'ထည့်မည်',
    create: 'ဖန်တီးမည်',
    working: 'ခဏလေး…',
    somethingWrong: 'တစ်ခုခု မှားယွင်းသွားပါသည်',
    organizerSuffix: 'စီစဉ်သူ',
  },

  nav: {
    session: 'ပွဲ',
    history: 'မှတ်တမ်း',
    setup: 'ဆက်တင်',
    payments: 'ငွေပေးချေမှု',
    sessionTitle: 'ပွဲ',
  },

  claim: {
    tagline: 'သီးသန့် အဖွဲ့',
    signingIn: 'ဝင်ရောက်နေသည်…',
    noLink: 'ဤစာမျက်နှာအတွက် ဖိတ်ကြားလင့်ခ် လိုအပ်ပါသည်။',
    failed: 'ဝင်ရောက်၍ မရပါ',
    askOrganizer:
      'သင့်ကိုယ်ပိုင် လင့်ခ်ကို စီစဉ်သူထံ တောင်းပါ။ ထိုလင့်ခ်ဖြင့် သင့်အမည်ဖြင့် အလိုအလျောက် ဝင်ရောက်ပါမည် — စကားဝှက် မှတ်ရန် မလိုပါ။',
  },

  invite: {
    title: 'ဖိတ်ကြားလင့်ခ်များ',
    copyLink: 'လင့်ခ် ကူးမည်',
    reissue: 'လင့်ခ်အသစ်',
    claimed: 'ဝင်ပြီး',
    pending: 'လင့်ခ် ပို့ပြီး',
    notYet: 'မဖိတ်ရသေး',
    linkReady: (name) => `${name} အတွက် လင့်ခ်`,
    linkBody:
      'ဤလင့်ခ်ကို သက်ဆိုင်သူထံသာ ပို့ပါ။ ပထမဆုံး ဖွင့်သူဖြင့် ဝင်ရောက်ပြီး နောက်ပိုင်း အလုပ်မလုပ်တော့ပါ။',
    expires: (when) => `${when} အထိ သုံးနိုင်သည်`,
    copied: 'လင့်ခ် ကူးပြီးပါပြီ — သူ့ထံ တိုက်ရိုက် ပို့ပါ',
    couldNotMint: 'လင့်ခ် ဖန်တီး၍ မရပါ',
    myDevice: 'အခြားစက် ထပ်ထည့်မည်',
    myDeviceBody: 'ဤလင့်ခ်ကို သင့်အခြားဖုန်း သို့မဟုတ် လက်ပ်တော့တွင် ဖွင့်ပြီး ဝင်ရောက်ပါ။',
    removeAccess: 'သူ့စက်များကို ထွက်ခိုင်းမည်',
    removeAccessBody:
      'သူသုံးနေသော စက်အားလုံးမှ ထွက်စေပြီး မသုံးရသေးသော လင့်ခ်ကိုလည်း ပယ်ဖျက်ပါမည်။ လင့်ခ်အသစ် လိုအပ်ပါမည်။',
    confirmRemove: (name) => `${name} ၏ စက်အားလုံးကို ထွက်ခိုင်းမှာလား?`,
    removed: (name) => `${name} ကို နေရာတိုင်းမှ ထွက်ခိုင်းပြီး`,
    couldNotRemove: 'မဆောင်ရွက်နိုင်ပါ',
  },

  session: {
    cancelled: 'ပွဲပျက်',
    finished: 'ပွဲပြီး',
    noVenue: 'ကွင်း မဆုံးဖြတ်ရသေးပါ',
    perPerson: (amount) => `တစ်ယောက် ~${amount}`,
    openMap: 'မြေပုံ ဖွင့်မည်',
    wasCancelled: 'ဤပွဲကို ဖျက်လိုက်ပါပြီ။',
    imIn: 'ကစားမည်',
    cantMakeIt: 'မလာနိုင်ပါ',
    leaveWaitlist: 'စောင့်ဆိုင်းစာရင်းမှ ထွက်မည်',
    registrationClosed: 'ဤပွဲအတွက် စာရင်းပေးခြင်း ပိတ်သွားပါပြီ။',
    playing: (count, max) => (max ? `ကစားမည် ${count} / ${max}` : `ကစားမည် ${count}`),
    nobodyYet: 'ဘယ်သူမှ မရှိသေးပါ။ ပထမဆုံး ဖြစ်လိုက်ပါ။',
    you: 'သင်',
    waitlistHeading: (count) => `စောင့်ဆိုင်းစာရင်း (${count})`,
    waiting: 'စောင့်ဆဲ',
    copyList: 'စာရင်းကို ကူးမည်',
    splitTheBill: 'ငွေခွဲမည်',
    edit: 'ပြင်မည်',
    cancelSession: 'ပွဲဖျက်မည်',
    confirmCancelTitle: 'ဤပွဲကို ဖျက်မှာလား?',
    confirmCancelBody:
      'စာရင်းပေးထားသူ အားလုံး ပွဲပျက်ကြောင်း မြင်ရပါမည်။ အက်ပ်ထဲမှ ပြန်ပြင်၍ မရပါ။',
    keepIt: 'ဆက်ထားမည်',
    thatDidNotWork: 'မအောင်မြင်ပါ',
    noSuchSession: 'ဤပွဲ မရှိတော့ပါ။',
    loading: 'ပွဲကို ဖွင့်နေသည်…',
  },

  connection: {
    live: 'တိုက်ရိုက်',
    polling: '30 စက္ကန့်တိုင်း စစ်နေသည်',
    connecting: 'ချိတ်ဆက်နေသည်…',
    idle: 'ရပ်ထားသည်',
    pollingShort: '30s',
  },

  home: {
    loading: 'ဖွင့်နေသည်…',
    noSession: 'ပွဲ မရှိသေးပါ',
    noSessionOrganizer:
      'နောက်လာမည့် သောကြာနေ့ပွဲကို အပတ်စဉ် အလိုအလျောက် ဖန်တီးပေးပါသည်။ မရှိပါက ဆက်တင်မှ ထည့်ပါ။',
    noSessionMember:
      'နောက်လာမည့် သောကြာနေ့ပွဲကို အပတ်စဉ် အလိုအလျောက် ဖန်တီးပေးပါသည်။ မရှိပါက စီစဉ်သူကို အသိပေးပါ။',
    previously: 'ယခင်ပွဲများ',
    badgeCancelled: 'ပွဲပျက်',
    badgeNotSplit: 'ငွေမခွဲရသေး',
    noVenue: 'ကွင်း မရှိ',
  },

  toast: {
    youreIn: 'စာရင်းသွင်းပြီးပါပြီ',
    youreOnWaitlist: 'စောင့်ဆိုင်းစာရင်းတွင် ရှိနေပါသည်',
    youreOut: 'စာရင်းမှ ထွက်ပြီးပါပြီ',
    youreOutPromoted: (name) => `စာရင်းမှ ထွက်ပြီးပါပြီ — ${name} အစားဝင်ပါမည်`,
    copied: 'ကူးပြီးပါပြီ — ချက်ထဲသို့ ကူးထည့်လိုက်ပါ',
    sessionUpdated: 'ပွဲကို ပြင်ပြီးပါပြီ',
    sessionCancelled: 'ပွဲကို ဖျက်လိုက်ပါပြီ',
    sessionCreated: 'ပွဲအသစ် ဖန်တီးပြီးပါပြီ',
    venueSaved: 'ကွင်းကို သိမ်းပြီးပါပြီ',
    memberAdded: (name) => `${name} ကို ထည့်ပြီးပါပြီ`,
    memberRemoved: (name) => `${name} ကို ဖယ်ပြီးပါပြီ`,
    amountsRebalanced: 'ငွေပမာဏများ ပြန်တွက်ပြီးပါပြီ',
    amountsRecalculated: 'ငွေပမာဏများ ပြန်တွက်ပြီးပါပြီ',
    splitDone: 'ကစားခဲ့သူများအားလုံးကြား ခွဲဝေပြီးပါပြီ',
    markedPaid: 'ငွေပေးပြီးဟု မှတ်ထားသည် — အတည်ပြုချက် စောင့်ဆဲ',
    confirmed: (name) => `${name} ကို အတည်ပြုပြီး`,
    rejected: (name) => `${name} ကို ငြင်းပယ်ပြီး`,
    remindersOn: 'ဤစက်တွင် သတိပေးချက် ဖွင့်ပြီး',
    remindersOff: 'ဤစက်တွင် သတိပေးချက် ပိတ်ပြီး',
    testSent: 'ပို့ပြီးပါပြီ — သတိပေးချက်ကို ကြည့်ပါ',
    testNoDevice: 'ဘယ်စက်ကိုမှ မပို့နိုင်ပါ',
  },

  payments: {
    notSplitYet: 'ငွေ မခွဲရသေးပါ',
    notSplitYetBody: 'စီစဉ်သူက ဤပွဲအတွက် ကွင်းခ မထည့်ရသေးပါ။',
    fieldTotal: 'ကွင်းခ စုစုပေါင်း',
    collected: 'ရရှိပြီး',
    stillOwed: 'ကျန်ရှိ',
    changeTotal: 'စုစုပေါင်း ပြင်မည်',
    changeTotalTitle: 'စုစုပေါင်းကို ပြင်မည်',
    changeTotalBody:
      'အားလုံး၏ ဝေစုကို ပြန်တွက်ပါမည်။ လက်ဖြင့် သတ်မှတ်ထားသော ပမာဏများနှင့် အတည်ပြုပြီးသား ငွေပေးချေမှုများ မပြောင်းလဲပါ။',
    everyone: (count) => `အားလုံး (${count})`,
    nothingToSplit: 'ခွဲစရာ မရှိသေးပါ။',
    copyStatus: 'အခြေအနေကို ကူးမည်',
    splitTitle: 'ငွေခွဲမည်',
    splitBody:
      'ကွင်းခ စုစုပေါင်းကို ရိုက်ထည့်ပါ။ ကစားခဲ့သူများကြားတွင်သာ ခွဲဝေပါမည် — စောင့်ဆိုင်းစာရင်း မပါဝင်ပါ — ပြီးလျှင် 1.000d နှင့် အနီးစပ်ဆုံး ဝိုင်းပါမည်။',
    totalCharge: 'ကွင်းခ စုစုပေါင်း',
    splitIt: 'ခွဲမည်',
    splitting: 'ခွဲနေသည်…',
    enterAmount: 'ကွင်းခ ပမာဏကို ထည့်ပါ၊ ဥပမာ 560k',
    couldNotSplit: 'ခွဲ၍ မရပါ',
    youOwe: 'သင် ပေးရန်',
    rejectedWithReason: (reason) => `ငြင်းပယ်ခံရသည်: ${reason}`,
    paidConfirmed: 'ငွေပေးပြီး၊ အတည်ပြုပြီး။ ကျေးဇူးတင်ပါသည်။',
    waitingConfirm: 'စီစဉ်သူ၏ အတည်ပြုချက်ကို စောင့်ဆဲ။',
    undoClaim: 'မှားသွားသည် — ပြန်ရုပ်မည်',
    paidWithShot: 'ငွေပေးပြီး — ဓာတ်ပုံ တွဲမည်',
    paidNoShot: 'ငွေပေးပြီး၊ ဓာတ်ပုံ မပါ',
    couldNotMark: 'မှတ်၍ မရပါ',
    couldNotUndo: 'ပြန်ရုပ်၍ မရပါ',
    fixed: 'သတ်မှတ်',
    statusPaid: 'ပေးပြီး',
    statusChecking: 'စစ်ဆဲ',
    statusUnpaid: 'မပေးရသေး',
    screenshot: 'ဓာတ်ပုံ',
    amount: 'ပမာဏ',
    confirm: 'အတည်ပြု',
    reject: 'ငြင်းပယ်',
    rejectReason: 'ပမာဏ မကိုက်ညီပါ',
    backToEqual: 'အညီအမျှ ပြန်ခွဲမည်',
    shareTitle: (name) => `${name} ၏ ဝေစု`,
    shareBody: (name) => `${name} အတွက် ပမာဏ သတ်မှတ်ပါ။ ကျန်သူများက ကျန်ငွေကို ခွဲဝေပါမည်။`,
    loading: 'ငွေပေးချေမှုများ ဖွင့်နေသည်…',
    transferOf: (name) => `${name} ၏ ငွေလွှဲ ပြေစာ`,
    couldNotLoadImage: 'ဓာတ်ပုံကို ဖွင့်၍ မရပါ',
  },

  history: {
    sessionsPlayed: (count) => `ပွဲ ${count} ပွဲ ကစားပြီး`,
    youOwe: 'သင် ပေးရန်',
    yourSessions: 'သင့်ပွဲများ',
    nonePlayed: 'ပွဲ မကစားရသေးပါ။',
    whoOwes: 'ဘယ်သူ ဘယ်လောက် ပေးရန်ရှိလဲ',
    noPayments: 'ငွေပေးချေမှု မှတ်တမ်း မရှိသေးပါ။',
    waitlisted: 'စောင့်ဆိုင်းခဲ့',
    loading: 'မှတ်တမ်း ဖွင့်နေသည်…',
  },

  admin: {
    signedInAs: (name) => `${name} အဖြစ် ဝင်ထားသည်`,
    organizersOnly: 'စီစဉ်သူများသာ ကစားသမားနှင့် ကွင်းများကို ပြင်နိုင်ပါသည်။',
    signOut: 'ထွက်မည်',
    signOutAs: (name) => `ထွက်မည် (${name})`,
    players: (count) => `ကစားသမားများ (${count})`,
    addPlayer: 'ကစားသမား ထည့်မည်',
    name: 'အမည်',
    removeNote:
      'ဖယ်ရှားလျှင် ယခင်ပွဲများနှင့် ငွေပေးချေမှုများ ကျန်ရှိနေမည် — ဝင်ရောက်ရန် စာရင်းတွင်သာ မပေါ်တော့ပါ။',
    couldNotAdd: 'ထည့်၍ မရပါ',
    couldNotRemove: 'ဖယ်၍ မရပါ',
    couldNotChange: 'ပြောင်း၍ မရပါ',
    venues: 'ကွင်းများ',
    newVenue: 'ကွင်းအသစ်',
    editVenue: 'ကွင်း ပြင်မည်',
    address: 'လိပ်စာ',
    mapLink: 'မြေပုံ လင့်ခ်',
    priceNote: 'ဈေးနှုန်း မှတ်ချက်',
    priceNoteHint: 'ဥပမာ 600.000d/နာရီ',
    retired: '(ရပ်ထား)',
    couldNotSaveVenue: 'ကွင်းကို သိမ်း၍ မရပါ',
    couldNotRetireVenue: 'ကွင်းကို ရပ်၍ မရပါ',
    extraSession: 'အပိုပွဲ',
    extraSessionBody:
      'နောက်လာမည့် သောကြာနေ့ 19:30 ပွဲကို အပတ်စဉ် အလိုအလျောက် ဖန်တီးပါသည်။ တစ်ကြိမ်တည်း ပွဲအတွက်သာ ဤနေရာကို သုံးပါ။',
    createSession: 'ပွဲ ဖန်တီးမည်',
    newSession: 'ပွဲအသစ်',
    kickoffLabel: 'ပွဲစချိန် (ဟိုချီမင်း အချိန်)',
    newSessionHint: 'ကွင်း၊ ကြေးနှင့် ကန့်သတ်ချက်ကို နောက်မှ သတ်မှတ်နိုင်ပါသည်။',
    couldNotCreateSession: 'ပွဲ ဖန်တီး၍ မရပါ',
    language: 'ဘာသာစကား',
    languageBody: 'အက်ပ်၊ သတိပေးချက်များနှင့် ချက်သို့ ကူးသည့် စာသားကို ပြောင်းပါမည်။',
  },

  editor: {
    title: 'ပွဲ ပြင်မည်',
    venue: 'ကွင်း',
    noVenueOption: 'ကွင်း မရှိသေး',
    feeLabel: 'တစ်ယောက် ခန့်မှန်းကြေး',
    feeHint: 'ဥပမာ 70k',
    maxPlayers: 'အများဆုံး ကစားသမား',
    maxPlayersHint: 'ကန့်သတ်ချက် မလိုပါက ဗလာထားပါ။ ပိုသူများ စောင့်ဆိုင်းစာရင်းသို့ ရောက်ပါမည်။',
    notes: 'မှတ်ချက်',
    feeNotANumber: 'ကြေးသည် ဂဏန်း ဖြစ်ရပါမည်၊ ဥပမာ 70k',
    capNotANumber: 'အများဆုံး ကစားသမားသည် ကိန်းပြည့် ဖြစ်ရပါမည်',
    couldNotSave: 'သိမ်း၍ မရပါ',
  },

  reminders: {
    title: 'သတိပေးချက်များ',
    notConfigured: 'ဤဆာဗာတွင် မပြင်ဆင်ရသေးပါ။',
    installFirst: 'ဟုမ်းစခရင်သို့ အရင် ထည့်ပါ။',
    installBody:
      'iPhone သည် ထည့်သွင်းထားသော အက်ပ်များကိုသာ သတိပေးချက် ပို့ပါသည်။ Share ကို နှိပ်ပြီး Add to Home Screen ကို ရွေးကာ ထိုမှတစ်ဆင့် ဖွင့်ပါ။',
    unsupported: 'ဤဘရောက်ဇာသည် သတိပေးချက် မပို့နိုင်ပါ။',
    thisDevice: 'ဤစက်',
    blocked: 'ဘရောက်ဇာတွင် ပိတ်ထားသည် — ထိုနေရာတွင် အရင် ခွင့်ပြုပါ။',
    onHere: 'ဤစက်တွင် သတိပေးချက် ဖွင့်ထားသည်။',
    offHere: 'ပွဲမစမီနှင့် ငွေပေးရန် ရှိချိန်တွင် သတိပေးပါမည်။',
    deviceCount: (count) => `စက် ${count} လုံးတွင် သတိပေးချက် ဖွင့်ထားသည်။`,
    beforeMatch: 'ပွဲမတိုင်မီ',
    beforeMatchBody: 'ကစားမည်ဆိုပါက ပွဲမစမီ 3 နာရီခန့်အလို။',
    unpaidTitle: 'ငွေမပေးရသေးကြောင်း သတိပေးချက်',
    unpaidBody: 'ပေးရန် ကျန်နေသရွေ့ တစ်ပတ်တစ်ကြိမ် သတိပေးပါမည်။',
    sendTest: 'စမ်းသပ် သတိပေးချက် ပို့မည်',
    couldNotTest: 'စမ်းသပ်ချက် မပို့နိုင်ပါ',
    couldNotChange: 'ပြောင်း၍ မရပါ',
    couldNotSave: 'သိမ်း၍ မရပါ',
    denied: 'သတိပေးချက်များကို ပိတ်ထားသည်။ ဘရောက်ဇာ ဆက်တင်တွင် ခွင့်ပြုပါ။',
    needsInstall: 'အက်ပ်ကို ဟုမ်းစခရင်သို့ အရင်ထည့်ပြီးမှ ဤနေရာမှ ဖွင့်ပါ။',
    disabled: 'ဤဆာဗာတွင် သတိပေးချက် မပြင်ဆင်ရသေးပါ။',
    failed: 'သတိပေးချက် ဖွင့်၍ မရပါ။ ထပ်စမ်းကြည့်ပါ။',
  },

  copy: {
    fallbackTitle: 'ဤစာသားကို ကူးပါ',
    fallbackBody: 'ဘရောက်ဇာက ကလစ်ဘုတ်ကို ပိတ်ထားသည်။ အောက်ပါစာသားကို ရွေးပြီး ကိုယ်တိုင် ကူးပါ။',
  },

  summary: {
    matchHeader: 'ဖူဆယ်',
    cancelled: 'ပွဲပျက်',
    perPersonApprox: (amount) => `တစ်ယောက် ~${amount}`,
    inHeading: (count, max) => (max ? `ကစားမည် (${count}/${max})` : `ကစားမည် (${count})`),
    nobodyYet: '— ဘယ်သူမှ မရှိသေး —',
    waitlistHeading: (count) => `စောင့်ဆိုင်း (${count})`,
    paymentsHeader: 'ငွေပေးချေမှု',
    fieldTotal: (amount) => `ကွင်းခ စုစုပေါင်း: ${amount}`,
    collectedOutstanding: (collected, outstanding) =>
      `ရရှိပြီး ${collected} · ကျန် ${outstanding}`,
    paid: (count) => `ပေးပြီး (${count})`,
    checking: (count) => `စစ်ဆဲ (${count})`,
    notYet: (count) => `မပေးရသေး (${count})`,
  },

  push: {
    matchTitle: (time) => `ယနေ့ ဖူဆယ်၊ ${time}`,
    matchBodyAtVenue: (hours, venue) => `${venue} တွင် ${hours} နာရီခန့်အကြာ ပွဲစပါမည်။`,
    matchBody: (hours) => `${hours} နာရီခန့်အကြာ ပွဲစပါမည်။`,
    unpaidTitle: 'ငွေပေးရန် ကျန်ရှိသေးသည်',
    unpaidBody: (amount, when) => `${when} အတွက် ${amount}။`,
    testTitle: 'ဖူဆယ် သောကြာ',
    testBody: (name) => `သတိပေးချက်များ အလုပ်လုပ်နေပါသည်၊ ${name}။`,
  },

  errors: {
    offline: 'အင်တာနက် မရှိပါ — ကွန်ရက်ကို စစ်ပါ',
    generic: 'ဆာဗာဘက်တွင် အမှားတစ်ခု ဖြစ်သွားပါသည်',
    signInFirst: 'အရင် ဝင်ရောက်ပါ',
  },
};
