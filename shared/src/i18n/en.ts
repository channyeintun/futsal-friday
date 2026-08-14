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
    remove: 'Remove',
  },

  paste: {
    title: 'Got a link?',
    body: "Paste it here. Handy when the app is on your home screen — there's no address bar to open a link in.",
    label: 'Paste your invite link',
    go: 'Use this link',
    fromClipboard: 'Paste from clipboard',
    notALink: "That doesn't look like an invite link. Copy the whole thing from the chat.",
    pasteBlocked: 'Your browser would not let the app read the clipboard. Paste into the box instead.',
  },

  pay: {
    title: 'How to pay',
    body: 'Scan with your banking app — the amount is already in the QR.',
    bank: 'Bank',
    accountNumber: 'Account number',
    accountName: 'Account name',
    reference: 'Transfer note',
    copyAccount: 'Copy account number',
    copyAmount: 'Copy amount',
    copied: 'Copied',
    scanHint:
      'Paying from this phone? Screenshot the QR, then pick it from your photos in your banking app.',
    youOweThis: (amount: string) => `You owe ${amount}`,
    nothingSet: 'The organizer has not added payment details yet.',
    // Organizer editor.
    editTitle: 'Payment details',
    editBody:
      'Shown to everyone with the amount they owe, so nobody has to scroll the chat for your account number.',
    setUp: 'Add payment details',
    edit: 'Edit',
    save: 'Save',
    remove: 'Remove details',
    confirmRemove: 'Remove the payment details?',
    confirmRemoveBody: 'The group loses the account number and the QR until you add them again.',
    pickBank: 'Bank',
    noteLabel: 'Anything else to say',
    notePlaceholder: 'e.g. put your name in the transfer note',
    couldNotSave: 'Could not save the payment details',
  },

  waiting: {
    title: 'Almost in',
    body: (name: string) =>
      `You're on the list as ${name}. An organizer has to let you in — you'll get a nudge when they do.`,
    check: 'Check again',
    stillWaiting: 'Not yet. Give them a moment.',
    wrongName: 'Wrong name? Ask the organizer to fix it.',
  },

  approvals: {
    heading: (count: number) => (count === 1 ? '1 waiting to join' : `${count} waiting to join`),
    body: 'They added themselves from the group link. Let them in, or turn them away.',
    approve: 'Let in',
    reject: 'Turn away',
    approved: (name: string) => `${name} is in`,
    rejected: (name: string) => `Turned ${name} away`,
    confirmReject: (name: string) => `Turn ${name} away?`,
    confirmRejectBody: 'Their name goes back on the list, so they — or somebody else — can ask again.',
    couldNotApprove: 'Could not let them in',
  },

  profile: {
    title: 'Profile',
    currentStreak: 'Streak',
    bestStreak: 'Best',
    played: 'Played',
    playedOf: (played: number, total: number) => `Played ${played} of ${total} matches`,
    owes: (amount: string) => `Owes ${amount}`,
    keepItUp: (count: number) =>
      count === 1 ? 'One in a row. Do not stop now.' : `${count} in a row. Do not break it.`,
    noStreak: 'No run going. The next match starts one.',
    changePicture: 'Change picture',
    removePicture: 'Remove picture',
    removePictureBody: 'Your initials will show instead. You can add a new one any time.',
    pictureUpdated: 'Picture updated',
    couldNotUpload: 'Could not save that picture',
    couldNotLoad: 'Could not load that profile',
  },

  form: {
    label: (played: number, of: number) => `Played ${played} of the last ${of}`,
  },

  board: {
    title: 'Leaderboard',
    streaks: 'Streaks',
    goals: 'Goals',
    streakBody: 'Games in a row. Turning up is the whole trick.',
    goalsBody: 'Goals scored, since the app started counting.',
    inARow: (count: number) => (count === 1 ? '1 in a row' : `${count} in a row`),
    bestEver: (count: number) => `best ${count}`,
    goalCount: (count: number) => (count === 1 ? '1 goal' : `${count} goals`),
    mvps: 'MVPs',
    mvpBody: 'Games the group voted you the best in. A shared win counts for everyone tied.',
    noMvpsYet: 'Nobody has been voted best player yet.',
    nobodyYet: 'Nothing to rank yet. Play a game.',
    noGoalsYet: 'No goals recorded yet. Say what you scored after the match.',
    loading: 'Working out the table…',
    you: 'you',
  },

  goals: {
    title: 'Scored?',
    body: 'How many did you get? Only you and the organizer can change this.',
    none: 'None',
    mine: (count: number) => (count === 1 ? '1 goal' : `${count} goals`),
    add: 'Goals',
    total: 'Goals',
    failed: 'Could not save that',
  },

  nav: {
    session: 'Session',
    history: 'History',
    setup: 'Setup',
    payments: 'Payments',
    players: 'Players',
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
    nobodyListed: 'Nobody has been added to this group yet. Put your name in below.',
    expired: 'That group link is not valid any more. Ask the organizer for the new one.',
    taken: 'Somebody already took that name. Pick another, or ask the organizer.',
    failed: 'Could not sign you in',
    notListed: "My name isn't here",
    addYourName: 'Add your name',
    addYourNameBody:
      'The organizer will get a nudge and has to let you in. Use the name they know you by.',
    yourName: 'Your name',
    requestSent: 'Sent. Waiting for the organizer.',
    couldNotAdd: 'Could not add your name',
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
    confirmRotate: 'Replace the group link?',
    confirmRotateBody:
      'The link already in the chat stops working straight away. Anybody who has not joined yet will need the new one.',
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
    myDevice: 'Sign in somewhere else',
    myDeviceBody:
      'Open this link in another browser, or on another phone or laptop, to sign in there too. Each browser signs in on its own — being signed in on Chrome does not sign you in on Safari.',
    removeAccess: 'Sign out everywhere',
    removeAccessBody:
      'Signs them out of every browser they are signed in on, and cancels any unused link. They will need a new one.',
    confirmRemove: (name: string) => `Sign ${name} out of everywhere?`,
    removed: (name: string) => `${name} signed out everywhere`,
    couldNotRemove: 'Could not do that',
  },

  session: {
    cancelled: 'Cancelled',
    finished: 'Finished',
    noVenue: 'Venue not decided yet',
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
    bringingGuests: (count: number) =>
      count === 1 ? 'bringing 1 guest' : `bringing ${count} guests`,
    guestChip: (count: number) => `+${count}`,
    guestsTitle: 'Bringing anyone?',
    guestsBody:
      'Friends without the app. They take a spot each, and their share goes on your bill.',
    guestsNone: 'Just me',
    guestsCount: (count: number) => (count === 1 ? 'Me + 1 friend' : `Me + ${count} friends`),
    guestsSave: 'Save',
    guestsFull: 'Not enough room for that many.',
    guestsFailed: 'Could not change that',
    playingWithGuests: (players: number, guests: number) =>
      guests === 1 ? `${players} playing · 1 guest` : `${players} playing · ${guests} guests`,
    waitlistHeading: (count: number) => `Waitlist (${count})`,
    waiting: 'waiting',
    /* --------------------------------------------------- who turned up */
    attendanceTitle: 'Who played?',
    attendanceBody:
      'Everyone on the list counts unless you say otherwise. Only mark the people who did not turn up — their share goes to whoever did.',
    attendanceUnchecked: 'Nobody has checked this yet',
    attendanceCount: (heads: number) => (heads === 1 ? '1 played' : `${heads} played`),
    iWasThere: 'I was there',
    iMissedIt: 'I missed it',
    didNotPlay: 'did not play',
    played: 'played',
    markAbsent: 'Mark as no-show',
    markPresent: 'Mark as played',
    unmark: 'Clear',
    guestsArrivedTitle: 'How many friends came?',
    guestsArrivedBody: (registered: number) =>
      `You put down ${registered}. Only the ones who turned up are billed.`,
    guestsArrivedNone: 'None came',
    guestsArrivedCount: (count: number) => (count === 1 ? '1 came' : `${count} came`),
    guestsArrivedChip: (came: number, registered: number) => `${came} of ${registered}`,
    attendanceFailed: 'Could not save that',
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

  /* --------------------------------------------------------------- mvp */

  mvp: {
    title: 'Best player',
    body: 'Who was the best today? Tap a name.',
    changeBody: 'Changed your mind? Tap somebody else.',
    yours: 'your vote',
    takeItBack: 'Take my vote back',
    playersOnly: 'Only people who played can vote.',
    turnout: (cast: number, of: number) => `${cast} of ${of} voted`,
    votes: (count: number) => (count === 1 ? '1 vote' : `${count} votes`),
    leadingWith: (count: number) => (count === 1 ? 'with 1 vote' : `with ${count} votes`),
    shared: (count: number) => (count === 1 ? 'tied on 1 vote' : `tied on ${count} votes`),
    failed: 'Could not save your vote',
  },

  /* -------------------------------------------------------- trash talk */

  talk: {
    title: 'Trash talk',
    count: (n: number) => (n === 1 ? '1 message' : `${n} messages`),
    empty: 'Nobody has said anything. Somebody has to start it 😏',
    emptyClosed: 'Nothing was said about this one.',
    placeholder: 'Say something',
    send: 'Post it',
    remove: 'Take it down',
    tooLong: (max: number) => `A bit long — ${max} characters at most.`,
    failed: 'Could not post that',
  },

  /* ------------------------------------------------------------- teams */

  teams: {
    title: 'Teams',
    split: 'Split into teams',
    body: 'Everyone who turned up, dealt out at random. Anyone can shuffle again.',
    bodyBefore: 'Everyone who is in, dealt out at random. Anyone can shuffle again.',
    notEnoughYet: 'Not enough players signed up yet.',
    nobodyYet: 'Mark who turned up first — the draw uses the same list the bill does.',
    howMany: 'How many teams?',
    onThePitch: (heads: number) =>
      heads === 1 ? '1 player on the pitch' : `${heads} players on the pitch`,
    willBe: (sizes: string) => `Sides of ${sizes}`,
    deal: 'Deal the teams',
    dealing: 'Dealing…',
    teamName: (letter: string) => `Team ${letter}`,
    teamSize: (count: number) => (count === 1 ? '1 player' : `${count} players`),
    /* A guest has no name of their own, so the row carries whoever brought
       them. Two guests from the same person are interchangeable, which is
       true of them on the pitch as well. */
    guest: 'guest',
    empty: 'Nobody',
    drawnBy: (name: string, when: string) => `${name} shuffled these ${when}`,
    shuffle: 'Shuffle again',
    clear: 'Clear',
    missing: (count: number) =>
      count === 1
        ? '1 more player has turned up since. Shuffle again to deal them in.'
        : `${count} more players have turned up since. Shuffle again to deal them in.`,
    // Annotated, or two string literals narrow the type and every other
    // locale is forced to return one of these exact English strings.
    dealThemIn: (count: number): string =>
      count === 1 ? 'Add them to a side' : 'Add them to the sides',
    failed: 'Could not split the teams',

    /* ------------------------------------------- settling on a draw */
    confirm: 'These are the teams',
    confirmHint: 'Everyone happy? This fixes the sides and lists the games.',
    settledBy: (name: string, when: string) => `${name} settled these ${when}`,
    locked: 'Settled. Only an organizer can change the sides now.',
    redoWarning: 'Dealing again unsettles the teams and clears any scores recorded against them.',

    /* -------------------------------------------------- the fixtures */
    matches: 'Games',
    matchesHint: 'Everyone plays everyone. Put the score in when a game finishes.',
    neverSettled:
      'These sides were never settled, so no games were listed. It is not too late to settle them.',
    notPlayed: 'Not played yet',
    scoreTitle: (first: string, second: string) => `${first} v ${second}`,
    markNotPlayed: 'Mark as not played',
    scoredBy: (name: string) => `entered by ${name}`,
    record: (won: number, drawn: number, lost: number) => `${won}W ${drawn}D ${lost}L`,
    scoreFailed: 'Could not save the score',
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
    noneYet: 'No games played yet.',
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
    notSplitYetBody: 'The organizer has not put in what the pitch cost yet.',
    fieldTotal: 'Whole bill',
    collected: 'Collected',
    stillOwed: 'Still owed',
    changeTotal: 'Change the amount',
    changeTotalTitle: 'Change what each person pays',
    changeTotalBody:
      'Everyone\'s share is worked out again. Amounts you set by hand stay as they are, and anyone already marked paid stays paid.',
    everyone: (count: number) => `Everyone (${count})`,
    nothingToSplit: 'Nothing to split yet.',
    copyStatus: 'Copy status for chat',
    seeSession: 'The teams and who played',
    splittingBetween: (heads: number) =>
      heads === 1 ? '1 person played' : `${heads} people played`,
    splitTitle: 'Split the bill',
    splitBody:
      'Only the people who played are charged. Shares are rounded to the nearest 1.000d.',
    perPersonCharge: 'What each person pays',
    enterEach: 'What one person pays. You can type 70k.',
    splitIt: 'Split it',
    splitting: 'Splitting…',
    comesTo: (heads: number, total: string) =>
      heads === 1 ? `1 played · ${total} in all` : `${heads} played · ${total} in all`,
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
    fixed: 'set by hand',
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
    shareBody: (name: string) =>
      `Charge ${name} a set amount. Everyone else splits whatever is left of the total.`,
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
    whoOwesBody: 'Everyone in the group sees this list. The quick way off it is to pay.',
    expandList: 'Give the list the whole screen',
    collapseList: 'Shrink the list back down',
    settledUp: 'all square',
    noPayments: 'No payments recorded yet.',
    waitlisted: 'waitlisted',
    loading: 'Loading history…',
    recent: 'Recent matches',
  },

  admin: {
    signedInAs: (name: string) => `Signed in as ${name}`,
    organizersOnly: 'Only organizers can edit the roster and venues.',
    signOut: 'Sign out',
    signOutAs: (name: string) => `Sign out (${name})`,
    players: (count: number) => `Players (${count})`,
    addPlayer: 'Add a player',
    managePlayers: 'Open the player list',
    addPlayerBody: 'They get a name on the list. Send them an invite link afterwards so they can sign in.',
    playerName: 'Their name',
    loadingPlayers: 'Loading players…',
    thatIsEveryone: "That's everyone.",
    refreshPlayers: 'Refresh',
    name: 'Name',
    confirmRemoveMember: (name: string) => `Remove ${name} from the group?`,
    confirmRemoveMemberBody:
      'They stop appearing on the roster and cannot sign in. Their past matches and payments are kept. Getting them back means inviting them again.',
    confirmRetireVenue: (name: string) => `Retire ${name}?`,
    confirmRetireVenueBody:
      'It stops being offered for new sessions. Sessions already played there keep it.',
    confirmSignOut: 'Sign out of this browser?',
    confirmSignOutBody:
      'You will need an invite link to get back in — there is no password to type.',
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
    retireVenue: 'Retire venue',
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
    clock: 'Clock',
    clockBody: 'How times are shown across the app, and in your reminders.',
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
    writeIn: 'Write it in',
    teaseLabel: 'Your own dig',
    teaseHint: 'Name names. Leave it empty and the app picks a joke.',
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
    guestSuffix: (count: number) => ` (+${count})`,
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
    joinRequestTitle: 'Someone wants to join',
    joinRequestBody: (name: string) => `${name} is waiting to be let in.`,
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
