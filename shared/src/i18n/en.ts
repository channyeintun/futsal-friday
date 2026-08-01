/**
 * English catalogue — the source of truth for the shape of every other locale.
 *
 * Adding a key here without adding it to `my.ts` is a build error, which is the
 * whole point. Entries that take values are functions so the compiler checks
 * the arguments too.
 */
export const en = {
  app: {
    name: 'Futsal Friday',
    loading: 'Just a moment…',
    back: 'Back',
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
    done: 'Done',
    close: 'Close',
    add: 'Add',
    create: 'Create',
    working: 'One sec…',
    somethingWrong: 'Something went wrong',
    organizerSuffix: 'organizer',
  },

  nav: {
    session: 'Session',
    history: 'History',
    setup: 'Setup',
    payments: 'Payments',
    sessionTitle: 'Session',
  },

  claim: {
    tagline: 'Private group',
    signingIn: 'Signing you in…',
    noLink: 'This page needs an invite link.',
    failed: 'Could not sign you in',
    askOrganizer:
      'Ask the organizer to send you your personal link. It signs you in as you — no password to remember.',
  },

  join: {
    whichOne: 'Which one are you?',
    tapYourName: 'Tap your name. It locks to this phone, so nobody else can pick it.',
    loading: 'Loading the list…',
    allTaken: 'Everyone on the list has already joined. Ask the organizer to add you.',
    expired: 'That group link is not valid any more. Ask the organizer for the new one.',
    taken: 'Somebody already took that name. Pick another, or ask the organizer.',
    failed: 'Could not sign you in',
  },

  invite: {
    title: 'Invite links',
    groupLink: 'Group invite link',
    groupLinkBody:
      'Paste this once into the group chat. Each person taps their own name, and it locks to their phone. Organizers are never listed — send them a personal link instead.',
    createGroupLink: 'Create group link',
    copyGroupLink: 'Copy group link',
    rotateGroupLink: 'Replace link',
    groupLinkCopied: 'Group link copied — paste it in the chat',
    waitingToJoin: (count: number) =>
      count === 1 ? '1 person still to join' : `${count} people still to join`,
    everyoneJoined: 'Everyone has joined.',
    rotateWarning: 'Replacing it stops the copy already in the chat from working.',
    couldNotRotate: 'Could not replace the link',
    copyLink: 'Copy link',
    reissue: 'New link',
    claimed: 'joined',
    pending: 'link sent',
    notYet: 'not invited',
    linkReady: (name: string) => `Link for ${name}`,
    linkBody:
      'Send this to that person only. It signs in whoever opens it first, and stops working after that.',
    expires: (when: string) => `Works until ${when}`,
    copied: 'Link copied — send it to them directly',
    couldNotMint: 'Could not create a link',
    myDevice: 'Add another device',
    myDeviceBody:
      'Open this link on your other phone or laptop to sign in there as well.',
    removeAccess: 'Sign out their devices',
    removeAccessBody:
      'Signs out every device they are using and cancels any unused link. They will need a new one.',
    confirmRemove: (name: string) => `Sign out all of ${name}'s devices?`,
    removed: (name: string) => `${name} signed out everywhere`,
    couldNotRemove: 'Could not do that',
  },

  session: {
    cancelled: 'Cancelled',
    finished: 'Finished',
    noVenue: 'Venue not decided yet',
    perPerson: (amount: string) => `~${amount} each`,
    openMap: 'Open map',
    wasCancelled: 'This session was cancelled.',
    imIn: "I'm in",
    cantMakeIt: "Can't make it",
    leaveWaitlist: 'Leave the waitlist',
    registrationClosed: 'Registration is closed for this session.',
    playing: (count: number, max?: number | null) =>
      max ? `Playing ${count} / ${max}` : `Playing ${count}`,
    nobodyYet: 'Nobody yet. Be the first.',
    you: 'you',
    waitlistHeading: (count: number) => `Waitlist (${count})`,
    waiting: 'waiting',
    copyList: 'Copy list for chat',
    splitTheBill: 'Split the bill',
    edit: 'Edit',
    cancelSession: 'Cancel session',
    confirmCancelTitle: 'Cancel this session?',
    confirmCancelBody:
      'Everyone registered will see it as cancelled. This cannot be undone from the app.',
    keepIt: 'Keep it',
    thatDidNotWork: 'That did not work',
    noSuchSession: 'That session no longer exists.',
    loading: 'Loading session…',
  },

  connection: {
    live: 'Live',
    polling: 'Updating every 30s',
    connecting: 'Connecting…',
    idle: 'Paused',
    pollingShort: '30s',
  },

  home: {
    loading: 'Loading…',
    noSession: 'No session scheduled',
    noSessionOrganizer:
      'The next Friday game is created automatically every week. If one is missing, add it from the admin screen.',
    noSessionMember:
      'The next Friday game is created automatically every week. If one is missing, nudge the organizer.',
    previously: 'Previously',
    badgeCancelled: 'cancelled',
    badgeNotSplit: 'not split',
    noVenue: 'No venue',
  },

  toast: {
    youreIn: "You're in",
    youreOnWaitlist: "You're on the waitlist",
    youreOut: "You're out",
    youreOutPromoted: (name: string) => `You're out — ${name} moves up`,
    copied: 'Copied — paste it in the group chat',
    sessionUpdated: 'Session updated',
    sessionCancelled: 'Session cancelled',
    sessionCreated: 'Session created',
    venueSaved: 'Venue saved',
    memberAdded: (name: string) => `${name} added`,
    memberRemoved: (name: string) => `${name} removed`,
    amountsRebalanced: 'Amounts rebalanced',
    amountsRecalculated: 'Amounts recalculated',
    splitDone: 'Split between everyone who played',
    markedPaid: 'Marked as paid — waiting for confirmation',
    confirmed: (name: string) => `${name} confirmed`,
    rejected: (name: string) => `${name} rejected`,
    remindersOn: 'Reminders on for this device',
    remindersOff: 'Reminders off for this device',
    testSent: 'Sent — check your notifications',
    testNoDevice: 'No device could be reached',
  },

  payments: {
    notSplitYet: 'Not split yet',
    notSplitYetBody: 'The organizer has not entered the field charge for this session yet.',
    fieldTotal: 'Field total',
    collected: 'Collected',
    stillOwed: 'Still owed',
    changeTotal: 'Change total',
    changeTotalTitle: 'Change the total',
    changeTotalBody:
      "Everyone's share is recalculated. Amounts you pinned by hand stay pinned, and payments already confirmed stay confirmed.",
    everyone: (count: number) => `Everyone (${count})`,
    nothingToSplit: 'Nothing to split yet.',
    copyStatus: 'Copy status for chat',
    splitTitle: 'Split the bill',
    splitBody:
      'Enter what the pitch cost in total. It is divided between everyone who was in — not the waitlist — and rounded to the nearest 1.000d.',
    totalCharge: 'Total field charge',
    splitIt: 'Split it',
    splitting: 'Splitting…',
    enterAmount: 'Enter the amount the pitch cost, e.g. 560k',
    couldNotSplit: 'Could not split that',
    youOwe: 'You owe',
    rejectedWithReason: (reason: string) => `Rejected: ${reason}`,
    paidConfirmed: 'Paid and confirmed. Thanks.',
    waitingConfirm: 'Waiting for the organizer to confirm.',
    undoClaim: 'That was a mistake — undo',
    paidWithShot: 'I paid — attach screenshot',
    paidNoShot: 'I paid, no screenshot',
    couldNotMark: 'Could not mark that',
    couldNotUndo: 'Could not undo that',
    fixed: 'fixed',
    statusPaid: 'paid',
    statusChecking: 'checking',
    statusUnpaid: 'unpaid',
    screenshot: 'Screenshot',
    amount: 'Amount',
    confirm: 'Confirm',
    reject: 'Reject',
    rejectReason: 'Amount did not match',
    backToEqual: 'Back to equal split',
    shareTitle: (name: string) => `${name}'s share`,
    shareBody: (name: string) => `Pin an amount for ${name}. Everyone else splits what is left.`,
    loading: 'Loading payments…',
    transferOf: (name: string) => `${name}'s transfer`,
    couldNotLoadImage: 'Could not load that screenshot',
  },

  history: {
    sessionsPlayed: (count: number) => `${count} sessions played`,
    youOwe: 'You owe',
    yourSessions: 'Your sessions',
    nonePlayed: 'You have not played a session yet.',
    whoOwes: 'Who owes what',
    noPayments: 'No payments recorded yet.',
    waitlisted: 'waitlisted',
    loading: 'Loading history…',
  },

  admin: {
    signedInAs: (name: string) => `Signed in as ${name}`,
    organizersOnly: 'Only organizers can edit the roster and venues.',
    signOut: 'Sign out',
    signOutAs: (name: string) => `Sign out (${name})`,
    players: (count: number) => `Players (${count})`,
    addPlayer: 'Add a player',
    name: 'Name',
    removeNote:
      'Removing someone keeps their past sessions and payments — they just stop appearing on the sign-in list.',
    couldNotAdd: 'Could not add that person',
    couldNotRemove: 'Could not remove that person',
    couldNotChange: 'Could not change that',
    venues: 'Venues',
    newVenue: 'New venue',
    editVenue: 'Edit venue',
    address: 'Address',
    mapLink: 'Map link',
    priceNote: 'Price note',
    priceNoteHint: 'e.g. 600.000d/hour',
    retired: '(retired)',
    couldNotSaveVenue: 'Could not save that venue',
    couldNotRetireVenue: 'Could not retire that venue',
    extraSession: 'Extra session',
    extraSessionBody:
      'The next Friday at 19:30 is created automatically every week. Use this for a one-off.',
    createSession: 'Create a session',
    newSession: 'New session',
    kickoffLabel: 'Kickoff (Ho Chi Minh time)',
    newSessionHint: 'Venue, fee and cap can be set once it exists.',
    couldNotCreateSession: 'Could not create that session',
    language: 'Language',
    languageBody: 'Changes the app, reminders and the text you copy into the chat.',
  },

  editor: {
    title: 'Edit session',
    venue: 'Venue',
    noVenueOption: 'No venue yet',
    feeLabel: 'Estimated fee per person',
    feeHint: 'e.g. 70k',
    maxPlayers: 'Max players',
    maxPlayersHint: 'Leave empty for no cap. Extra players go on a waitlist.',
    notes: 'Notes',
    feeNotANumber: 'Fee should be a number, e.g. 70k',
    capNotANumber: 'Max players should be a whole number',
    couldNotSave: 'Could not save',
  },

  reminders: {
    title: 'Reminders',
    notConfigured: 'Not configured on this server yet.',
    installFirst: 'Add to Home Screen first.',
    installBody:
      'iPhone only delivers notifications to installed apps. Tap Share, then Add to Home Screen, and open Futsal Friday from there.',
    unsupported: 'This browser cannot do notifications.',
    thisDevice: 'This device',
    blocked: 'Blocked in browser settings — allow notifications there first.',
    onHere: 'Notifications are on here.',
    offHere: 'Get a nudge before kickoff and when you owe money.',
    deviceCount: (count: number) => `Reminders are on for ${count} devices.`,
    beforeMatch: 'Before the match',
    beforeMatchBody: "About 3 hours before kickoff, if you're playing.",
    unpaidTitle: 'Unpaid reminders',
    unpaidBody: 'A weekly nudge while you still owe for a session.',
    sendTest: 'Send a test notification',
    couldNotTest: 'Could not send a test',
    couldNotChange: 'Could not change that',
    couldNotSave: 'Could not save that',
    denied: 'Notifications were blocked. Allow them for this site in your browser settings.',
    needsInstall: 'Add the app to your Home Screen first, then turn this on from there.',
    disabled: 'Reminders are not configured on this server.',
    failed: 'Could not turn reminders on. Try again.',
  },

  copy: {
    fallbackTitle: 'Copy this',
    fallbackBody: 'Your browser blocked the clipboard. Select the text below and copy it by hand.',
  },

  /**
   * The banter bank for the random chat announcement.
   *
   * Each locale writes its own jokes. These are deliberately not translations
   * of each other — the Burmese list is what a Burmese friend group actually
   * says to each other, not these lines rendered in Myanmar script.
   */
  announce: {
    title: 'Hype the group',
    body: 'A random announcement for the chat. Shuffle until one makes you laugh.',
    open: 'Write an announcement',
    shuffle: 'Another one',
    copy: 'Copy announcement',
    openers: [
      'Legs itching yet? 🦵',
      'Futsal Friday is back ⚽',
      'The pitch is calling. Pick up 📣',
      'Time to run it back this week!',
      'Off the sofa, onto the pitch 🛋➡️⚽',
      'Dig the boots out 👟',
      'Team sheet is open 📝',
      'No FIFA this week. The real thing 🎮❌',
    ],
    teases: [
      'Everyone who was "busy" last week — you will need a fresh excuse 😏',
      'Bad knee, bad back, big meeting. Not accepted this week 🙅',
      'If nobody calls keeper, everybody is keeper 🥅',
      'PS: those of you who still owe money. Yes. You 👀',
      'Said yes and then vanished? There is a list 📋',
      'Do not think about how you will feel tomorrow morning 💪',
      'Score once and you get to bring it up all week 🏆',
      'Last one to arrive buys the water 💧',
    ],
    callToAction: [
      'Tap in now 👇',
      'Get your name down 👇',
      'Before the spots go 👇',
      'You in? 👇',
    ],
    nobodyYet: 'Nobody has signed up yet. Someone has to go first 🥇',
    soFar: (going: number) => `${going} in so far`,
    spotsLeft: (going: number, left: number) => `${going} in · ${left} spots left`,
    full: 'We are full — waitlist is open, and people always drop out 🤞',
  },

  /** Plain-text snapshots pasted into the group chat. */
  summary: {
    matchHeader: 'FUTSAL',
    cancelled: 'CANCELLED',
    perPersonApprox: (amount: string) => `~${amount}/person`,
    inHeading: (count: number, max?: number | null) => (max ? `IN (${count}/${max})` : `IN (${count})`),
    nobodyYet: '— nobody yet —',
    waitlistHeading: (count: number) => `WAITLIST (${count})`,
    paymentsHeader: 'PAYMENTS',
    fieldTotal: (amount: string) => `Field total: ${amount}`,
    collectedOutstanding: (collected: string, outstanding: string) =>
      `Collected ${collected} · Outstanding ${outstanding}`,
    paid: (count: number) => `PAID (${count})`,
    checking: (count: number) => `CHECKING (${count})`,
    notYet: (count: number) => `NOT YET (${count})`,
  },

  /** Push notification copy. Written on the server, in the member's language. */
  push: {
    matchTitle: (time: string) => `Futsal today, ${time}`,
    matchBodyAtVenue: (hours: number, venue: string) =>
      `Kickoff in about ${hours}h at ${venue}.`,
    matchBody: (hours: number) => `Kickoff in about ${hours}h.`,
    unpaidTitle: 'Still to settle up',
    unpaidBody: (amount: string, when: string) => `${amount} for ${when}.`,
    testTitle: 'Futsal Friday',
    testBody: (name: string) => `Reminders are working, ${name}.`,
  },

  errors: {
    offline: 'No connection — check your network',
    generic: 'Something went wrong on our side',
    signInFirst: 'Sign in first',
  },
};
// Deliberately not `as const`: literal types here would make every translated
// string a type error ("မလုပ်တော့ပါ" is not assignable to "Cancel"). The shape
// is what other locales must match, not the values.
