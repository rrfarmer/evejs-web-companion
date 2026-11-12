<script lang="ts">
  // Mail page (goal R17, Slice A): the inbox, one message's text, and writing
  // to someone.
  //
  // A pure reader of the store's mail slice. Every call lives on the BFF and in
  // app/flow.ts; every identifier is translated to a name in bridge/mail.ts or
  // resolved through the shared name cache before it reaches this file. Nothing
  // here shows a characterID, a messageID or a corporationID (R7d) — a message
  // is identified by who sent it, what it is about and when it arrived.
  //
  // ⚠ THE BODY IS ALREADY PLAIN TEXT. mailMgr.GetBody answers a zlib-DEFLATED
  // buffer; the flow inflates it (bridge/mail.ts, inflateMailBody) so this file
  // never handles a compressed byte.
  //
  // ⚠ THE INBOX IS THE WHOLE MAILBOX. The flow keeps it as the client's mail
  // service does, so there is no paging to build and no "load more".
  import { getContext, onDestroy, onMount } from "svelte";
  import { mailFocus, mailFocusServed } from "./mailFocus.ts";
  import {
    MAIL_MAX_BODY,
    MAIL_MAX_TITLE,
    audienceOf,
    MAIL_MAX_RECIPIENTS,
    readFlags,
    isTrashed,
    MAIL_FOLDER_ALLIANCE,
    MAIL_FOLDER_CORPORATION,
    MAIL_FOLDER_INBOX,
    MAIL_FOLDER_SENT,
    MAIL_FOLDER_TRASH,
    mailsInFolder,
    mailsOfList,
    unreadByList,
    MAIL_LABEL_MAX,
    MAILING_LIST_NAME_MAX,
    unreadByLabel,
    MAILING_LIST_MEMBER_DEFAULT,
    MAILING_LIST_MEMBER_MUTED,
    MAILING_LIST_MEMBER_OPERATOR,
    MAILING_LIST_MEMBER_OWNER,
    MAILING_LIST_MEMBERS_PER_PAGE,
    mailingListMembersShown,
    type MailingListMember,
    type MailingListMemberAction,
    type MailingListMemberFilter,
    type MailingListSettings,
    MAILING_LIST_ALLOWED,
    MAILING_LIST_BLOCKED,
    type OwnerMatch,
    MAIL_MAX_TAGGED_BODY,
    MAILS_PER_PAGE,
    isSystemMailLabel,
    mailLabelColor,
    mailLabelParts,
    mailRecipientOf,
    mailRowState,
    mailsSorted,
    MAIL_SORT_KEYS,
    type MailSortKey,
    isCorporationOwner,
    isNpcOwner,
    isAllianceOwner,
    hasChatManagerRole,
  } from "../bridge/mail.ts";
  import { MAIL_QUOTE_LABELS, mailBodyLines, mailMarkupOfTyped, mailQuoteMarkup } from "../bridge/mailMarkup.ts";
  import { LINK_WORDS, linkFollowerOf, startLinkDrag } from "./linkFollowers.ts";
  import { ASKED_KEEPING_YES, DO_NOT_ASK_AGAIN_LABEL, suppressableKey } from "../bridge/dialogSuppression.ts";
  import { pyIntDictOrder } from "../bridge/pyDict.ts";
  import { isSearchMatch } from "../bridge/searchMatch.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { SWATCH_IDS, labelSwatch, swatchColor, swatchTag } from "../bridge/labelSwatches.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { CharacterMatch } from "../app/api.ts";
  import type { MailHeaderRow } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";
  import MailNotifications from "./MailNotifications.svelte";

  let { store, flow, openSkillPlanLink = null }: {
    store: ClientStore;
    flow: AppFlow;
    /** A skill plan's link in a mail, followed (link.py handle_link). */
    openSkillPlanLink?: ((url: string) => void) | null;
  } = $props();

  // svelte-ignore state_referenced_locally
  const mail = store.mail;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;

  /** FmtDate's 'ls' (format.py 93 to 94): this label with the date in it. */
  const DATE_LABEL = "/Carbon/UI/Common/DateTime/DateLongShort";

  /** The client's word for a label, from the player's install; the page's own where there is none to read. */
  function word(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? template : own;
  }

  /**
   * How a link in the open mail's body is followed (ui/linkFollowers.ts: the client's link registry, as the reading
   * pane's label follows its links), or null where it is not.
   */
  function followerOf(url: string, text: string) {
    return linkFollowerOf(url, flow, openSkillPlanLink, (label) => word(label, LINK_WORDS[label] ?? ""), text);
  }

  let busy = $state(false);
  let error = $state("");
  let tab = $state<"inbox" | "compose" | "notifications">("inbox");
  /**
   * On the play page the window as MailWindow lays it out (evemail.py: 800 x 600; the header's tabs Mail and
   * Notifications - Tooltips/Neocom/Mail, UI/Mail/Notifications/Notifications; MailForm: the toolbar, the folder tree
   * leftCont 200 wide (evemail_leftContWidth) at the left, the divider, the message list beside it and the reading
   * pane under it). A message is written from the toolbar's Compose (the client's own compose window).
   */
  const retail = getContext("retailChrome") === true;
  /** The window's second tab, by its label (evemail.py 103). */
  const NOTIFICATIONS_TAB = "UI/Mail/Notifications/Notifications";

  // Compose state. `recipients` are the pilots the window holds by name (its toChars); `receiverText` is its one
  // field of names (evemail.py NewNewMessage), each followed by ", ", as ValidateReceivers writes it.
  let recipients = $state<CharacterMatch[]>([]);
  let receiverText = $state("");
  let draftTitle = $state("");
  let draftBody = $state("");
  /** The message a reply answers (mailSvc.GetReplyWnd: isReplyTo=msg.messageID), 0 for a new message. */
  let replyTo = $state(0);
  /** The mailing list written to (the compose window's toListID), or null. */
  let toList = $state<number | null>(null);
  /** The corporation or alliance written to, by its name (the compose window's toCorpAlliance); none for none. */
  let toCorpAlliance = $state<readonly { readonly name: string; readonly ownerID: number }[]>([]);
  /** The list written to while the pilot has it joined, as ValidateReceivers keeps it (evemail.py 2198 to 2201). */
  const composeList = $derived(toList === null ? undefined : ($mail.lists ?? []).find((list) => list.listID === toList));
  /** The folder shown: a label's bit, all mails (null), or the trash; the inbox first, as the window opens (270). */
  let folder = $state<number | null>(MAIL_FOLDER_INBOX);
  /** The mailing list shown in place of a folder (evemail.py LoadMailinglistMails), or null. */
  let viewingList = $state<number | null>(null);

  /** The folder words, by their labels (evemail.py GetStaticLabelsGroups; LoadLeftSide; GetPanelLabel). */
  const FOLDER_WORDS = {
    all: "UI/Mail/LabelAllMails",
    inbox: "UI/Mail/LabelInbox",
    sent: "UI/Mail/LabelSent",
    corporation: "UI/Common/Corp",
    alliance: "UI/Common/Groups/Alliance",
    trash: "UI/Mail/LabelTrash",
    labels: "UI/Mail/Labels",
    lists: "UI/Mail/MailingLists",
    addList: "UI/Mail/AddMailingList",
    createOrJoin: "UI/Mail/CreateOrJoinML",
    listName: "UI/Mail/MailingListName",
    join: "UI/Mail/Join",
    create: "UI/Mail/Create",
    nameTooLong: "UI/Mail/NameIsTooLong",
    leaveList: "UI/Mail/LeaveMailingList",
    sendToList: "UI/Mail/SendMailToList",
    deleteList: "UI/Mail/DeleteMailingList",
    mailEntry: "UI/Mail/MailEntry",
    ml: "UI/Mail/ML",
    withCount: "UI/Mail/FolderLabelWithCount",
  } as const;
  /** The window's own folders, in its order: each its place, its word, and the page's own word. */
  const SYSTEM_FOLDERS: readonly (readonly [number | null, string, string])[] = [
    [null, FOLDER_WORDS.all, "All Mails"],
    [MAIL_FOLDER_INBOX, FOLDER_WORDS.inbox, "Inbox"],
    [MAIL_FOLDER_SENT, FOLDER_WORDS.sent, "Sent"],
    [MAIL_FOLDER_CORPORATION, FOLDER_WORDS.corporation, "Corp"],
    [MAIL_FOLDER_ALLIANCE, FOLDER_WORDS.alliance, "Alliance"],
    [MAIL_FOLDER_TRASH, FOLDER_WORDS.trash, "Trash"],
  ];
  const unreadCounts = $derived(unreadByLabel($mail));
  const ownLabels = $derived([...($mail.labels ?? [])].filter((label) => !isSystemMailLabel(label.labelID)).sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase())));
  const shownMessages = $derived(viewingList !== null ? mailsOfList($mail, viewingList) : mailsInFolder($mail, folder));
  /** The page of the folder shown (the window's startPos), the first as a folder is shown; newest first, thirty to a page. */
  let mailPage = $state(0);
  /** The list's sort as last left (the window's sortBy and sortOrder): Received, reversed, where none was. */
  const keptSort = flow.mailSort();
  let sortBy = $state<MailSortKey>(keptSort.by);
  let sortReversed = $state(keptSort.reversed);
  const sortedMessages = $derived(mailsSorted(shownMessages, sortBy, sortReversed, nameCell, (header) => mailRowState(statusByID.get(header.messageID))));
  const mailPages = $derived(Math.max(1, Math.ceil(sortedMessages.length / MAILS_PER_PAGE)));
  const pageShown = $derived(Math.min(mailPage, mailPages - 1));
  const pageMessages = $derived(sortedMessages.slice(pageShown * MAILS_PER_PAGE, (pageShown + 1) * MAILS_PER_PAGE));
  /** The Sent folder names a mail's recipient where any other names its sender (RefreshMsgScrollHeaders, evemail.py 656 to 672). */
  const inSent = $derived(viewingList === null && folder === MAIL_FOLDER_SENT);
  const statusByID = $derived(new Map($mail.statuses.map((status) => [status.messageID, status] as const)));
  const listUnread = $derived(unreadByList($mail));
  /** The lists joined, by name (GetMaillistSubContent). */
  const joinedLists = $derived([...($mail.lists ?? [])].sort((left, right) => left.displayName.toLowerCase().localeCompare(right.displayName.toLowerCase())));

  let addingList = $state(false);
  let listNameInput = $state("");

  /**
   * MailinglistWnd's Join and Create (evemail.py 2897 to 2919): an empty name refused (LookupStringMinimum), a
   * made one over sixty refused (UI/Mail/NameIsTooLong); then asked, and the window put away where it was done.
   */
  function addList(create: boolean): void {
    const name = listNameInput;
    labelNote = "";
    if (name.trim() === "") {
      labelNote = filledWord("dialog:LookupStringMinimum/body", "Type {minimum} or more characters.", { minimum: "1" });
      return;
    }
    if (create && name.length > MAILING_LIST_NAME_MAX) {
      labelNote = word(FOLDER_WORDS.nameTooLong, "That name runs too long.");
      return;
    }
    void run(async () => {
      const listID = create ? await flow.createMailingList(name) : await flow.joinMailingList(name);
      if (listID !== null) {
        listNameInput = "";
        addingList = false;
      }
    });
  }

  /** A list by its name, as the lists service keeps it: joined, or named before (GetDisplayName); null for one not yet named. */
  function listName(listID: number): string | null {
    return (($mail.lists ?? []).find((list) => list.listID === listID) ?? $mail.externalLists.find((list) => list.listID === listID))?.displayName ?? null;
  }

  /** Who sent a mail: a list's own mail named by the list (mailSvc.py 1145 to 1146), anyone else by name. */
  function senderName(header: MailHeaderRow): string {
    if (header.toListID !== null && header.senderID === header.toListID) {
      const name = listName(header.toListID);
      if (name !== null) return name;
    }
    return personName(header.senderID);
  }

  /** The words of a folder's writes, by their labels (evemail.py StaticMenu), and the dialogs' answers. */
  const FOLDER_WRITE_WORDS = {
    markAll: "UI/Mail/MarkAllAsReadWithFolderName",
    trashAll: "UI/Mail/TrashAllWithFolderName",
    all: "UI/Common/All",
    restoreAll: "UI/Mail/RestoreAll",
    emptyTrash: "UI/Mail/EmptyTrash",
    yes: "UI/Common/Buttons/Yes",
    no: "UI/Common/Buttons/No",
  } as const;
  /** The client's dialogs to be sure of a folder's write, by their names. */
  const FOLDER_DIALOGS = ["EvemailMailMarkAllRead", "EvemailMailTrashAll", "EvemailMailRestoreAll", "EvemailMaillDeleteAll", "EvemailMailReadLabelGroup", "EvemailMailTrashLabelGroup", "EvemailMailReadMailinglistGroup", "EvemailMailTrashMailinglistGroup", "DeleteMailingList"] as const;

  /** A folder's write waiting on the pilot's yes: the client's dialog, what fills it, and what it does. */
  let confirming = $state<{ readonly dialog: string; readonly args: Record<string, string>; readonly act: () => Promise<void> } | null>(null);

  /** The folder shown, by name (its word, or its label's name). */
  const folderName = $derived(
    folder === null || SYSTEM_FOLDERS.some(([id]) => id === folder)
      ? (() => {
          const found = SYSTEM_FOLDERS.find(([id]) => id === folder);
          return found ? word(found[1], found[2]) : "";
        })()
      : (ownLabels.find((label) => label.labelID === folder)?.name ?? ""),
  );

  /** A client's template filled, the page's own words where the install has none. */
  function filledWord(label: string, own: string, args: Record<string, string>): string {
    return plainText(formatTemplate(word(label, own), args, { nameOf: () => "" }));
  }

  /** "Do not ask again" ticked on the waiting dialog (dialogSuppression.ts). */
  let dontAskAgain = $state(false);

  /**
   * A dialog asked as prompt_player_fsd_dialog asks it: one the client asks keeping Yes whose Yes is kept is not
   * shown, and its write is done; any other is shown, its checkbox clear.
   */
  function ask(waiting: { readonly dialog: string; readonly args: Record<string, string>; readonly act: () => Promise<void> }): void {
    if (ASKED_KEEPING_YES.has(waiting.dialog) && flow.dialogYesKept(waiting.dialog)) {
      void run(waiting.act);
      return;
    }
    dontAskAgain = false;
    confirming = waiting;
  }

  /** One of the waiting dialog's two texts, filled. */
  function dialogText(part: "title" | "body"): string {
    const waiting = confirming;
    if (waiting === null) {
      return "";
    }
    return filledWord(`dialog:${waiting.dialog}/${part}`, part === "title" ? "Are you sure?" : "", waiting.args);
  }

  /** The words of the labels' writes, by their labels (ManageLabelsBase; GetMsgMenu; mailSvc.py 1290 to 1317). */
  const LABEL_WORDS = {
    manage: "UI/Mail/ManageLabels",
    name: "UI/Mail/LabelName",
    create: "UI/Mail/Create",
    rename: "UI/Mail/LabelRename",
    typeNew: "UI/Mail/LabelTypeNew",
    tooLong: "UI/Mail/LabelTooLong",
    assign: "UI/Mail/AssignLabel",
    remove: "UI/Mail/LabelRemove",
    assigned: "UI/Mail/LabelAssigned",
    removed: "UI/Mail/LabelRemoved",
    corp: "UI/Mail/LabelCorp",
    alliance: "UI/Mail/LabelAlliance",
    delete: "UI/Mail/Delete",
    ok: "UI/Common/Buttons/OK",
    cancel: "UI/Common/Buttons/Cancel",
    assignColor: "UI/Mail/AssignColor",
    selectColor: "UI/Mail/Select Color",
  } as const;
  /** The client's dialogs of the labels' writes, by their names. */
  const LABEL_DIALOGS = ["DeleteMailLabel", "MailLabelNameExists", "LookupStringMinimum"] as const;

  let managingLabels = $state(false);
  let newLabelName = $state("");
  let renaming = $state<{ readonly labelID: number; name: string } | null>(null);
  /** What the last label's write said (the client's note after an assignment or a removal), or a refusal. */
  let labelNote = $state("");

  /**
   * The label the colour window is open for (MailAssignColorWnd, evemail.py 2974 on: Assign Color in a folder's menu,
   * 557 to 575 and 1107, and in Manage Labels, 1632 to 1651), and where it was opened; none while it is shut.
   */
  let colorFor = $state<{ readonly labelID: number; readonly where: "folders" | "manage" } | null>(null);
  function openColorWindow(labelID: number, where: "folders" | "manage"): void {
    colorFor = colorFor !== null && colorFor.labelID === labelID && colorFor.where === where ? null : { labelID, where };
  }
  /** A swatch picked (PickCol): the window shut, and the label given that colour (ChangeLabelColorFromUI). */
  function pickColor(color: number): void {
    const chosen = colorFor;
    colorFor = null;
    if (chosen === null) return;
    void run(() => flow.setMailLabelColor(chosen.labelID, color));
  }
  /**
   * A folder's colour tag (MailGroup.Load, 1420 to 1428, for the inbox, sent, the corporation's and the alliance's;
   * MailLabelEntry.Load, 1501 to 1513, for the pilot's own): its label's swatch, none for no colour or white, and none
   * for All Mails and the trash.
   */
  function folderTag(id: number | null): string | null {
    if (id === null || id === MAIL_FOLDER_TRASH) return null;
    return swatchTag(mailLabelColor(id, $mail.labels ?? []));
  }

  /**
   * GetAllLabels(assignable=1) (mailSvc.py 681 to 710): the system's that may be given (the inbox, the
   * corporation's and the alliance's, by the client's own names) and the pilot's own, each by its bit and name.
   */
  const assignableLabels = $derived([
    { labelID: MAIL_FOLDER_INBOX, name: word(FOLDER_WORDS.inbox, "Inbox") },
    { labelID: MAIL_FOLDER_CORPORATION, name: word(LABEL_WORDS.corp, "Corp") },
    { labelID: MAIL_FOLDER_ALLIANCE, name: word(LABEL_WORDS.alliance, "Alliance") },
    ...ownLabels.map((label) => ({ labelID: label.labelID, name: label.name })),
  ]);

  /**
   * GetAssignLabelMenu and GetRemoveLabelMenu: the labels a message lacks, or has, sorted as the client sorts them,
   * the system's by "  " and their bit (so first, by bit) and the pilot's own by name.
   */
  function labelsFor(messageID: number, has: boolean): readonly { labelID: number; name: string }[] {
    const mask = $mail.statuses.find((row) => row.messageID === messageID)?.labelMask ?? 0;
    const system = new Set([MAIL_FOLDER_INBOX, MAIL_FOLDER_CORPORATION, MAIL_FOLDER_ALLIANCE]);
    const key = (label: { labelID: number; name: string }) => (system.has(label.labelID) ? `  ${label.labelID}` : label.name.toLowerCase());
    return assignableLabels
      .filter((label) => ((mask & label.labelID) === label.labelID) === has)
      .sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));
  }

  /** A message given a label, or one taken off it, and the client's note of it. */
  function labelMessage(messageID: number, labelID: number, give: boolean): void {
    const label = assignableLabels.find((each) => each.labelID === labelID);
    if (label === undefined) {
      return;
    }
    void run(async () => {
      const count = give ? await flow.assignMailLabel([messageID], labelID) : await flow.removeMailLabel([messageID], labelID);
      if (count > 0) {
        labelNote = filledWord(give ? LABEL_WORDS.assigned : LABEL_WORDS.removed, give ? "The label \"{labelName}\" has been assigned to {numMails} mails" : "The label \"{labelName}\" has been removed from {numMails} mails", { labelName: label.name, numMails: String(count) });
      }
    });
  }

  /**
   * The labels window's Create (CreateLabel, 1563 to 1580): the name trimmed, refused where a label has it (by the
   * client's own words), where it is empty, or where it is over forty; then made.
   */
  function createLabel(): void {
    const name = newLabelName.trim();
    labelNote = "";
    if (assignableLabels.some((label) => label.name.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === word(FOLDER_WORDS.sent, "Sent").toLowerCase()) {
      labelNote = filledWord("dialog:MailLabelNameExists/body", "A label goes by that name already.", {});
      return;
    }
    if (name.length < 1) {
      labelNote = filledWord("dialog:LookupStringMinimum/body", "Type {minimum} or more characters.", { minimum: "1" });
      return;
    }
    if (name.length > MAIL_LABEL_MAX) {
      labelNote = word(LABEL_WORDS.tooLong, "That label name runs too long.");
      return;
    }
    void run(async () => {
      if ((await flow.createMailLabel(name)) !== null) {
        newLabelName = "";
      }
    });
  }

  /** RenameLabelFromUI (1290 to 1299): a new name, trimmed; nothing done where it is empty. */
  function renameLabel(): void {
    const waiting = renaming;
    renaming = null;
    const name = waiting === null ? "" : waiting.name.trim();
    if (waiting === null || name === "") {
      return;
    }
    void run(() => flow.renameMailLabel(waiting.labelID, name));
  }

  /** The pilot's yes: kept where "do not ask again" was ticked on a dialog that keeps it, and the write done. */
  function confirmed(): void {
    const waiting = confirming;
    confirming = null;
    if (waiting !== null) {
      if (dontAskAgain && ASKED_KEEPING_YES.has(waiting.dialog)) {
        flow.keepDialogYes(waiting.dialog);
      }
      void run(waiting.act);
    }
  }

  /** A folder's unread count as the window keeps it: none beside sent or the trash (UpdateCounters). */
  function folderUnread(id: number | null): number {
    return id === MAIL_FOLDER_SENT || id === MAIL_FOLDER_TRASH ? 0 : (unreadCounts.get(id) ?? 0);
  }

  /** GetPanelLabel: the folder's name, and its unread count beside it where it has any. */
  function folderText(name: string, id: number | null): string {
    const count = folderUnread(id);
    return count > 0
      ? formatTemplate(word(FOLDER_WORDS.withCount, "{folderName} ({unreadCount})"), { folderName: name, unreadCount: count }, { nameOf: () => "" })
      : name;
  }

  /** The words of a message's writes, by their labels (evemail.py GetMsgMenu). */
  const WRITE_WORDS = {
    read: "UI/Mail/MarkAsRead",
    unread: "UI/Mail/MarkAsUnread",
    trash: "UI/Mail/Trash",
    restore: "UI/Mail/Restore",
    delete: "UI/Mail/Delete",
  } as const;

  /** Whether a message is in the trash, as its status says. */
  function inTrash(messageID: number): boolean {
    const status = $mail.statuses.find((row) => row.messageID === messageID);
    return status !== undefined && isTrashed(status);
  }

  /** The message a forward forwards (GetForwardWnd: isForwardedFrom=msg.messageID), 0 for none. */
  let forwardFrom = $state(0);
  /** The message quoted, in the mail's markup (GetReplyMessage), sent after what is typed; "" for none. */
  let quote = $state("");

  /** Always a NAME, never an id — and never an id-shaped fallback either. */
  function personName(characterID: number): string {
    return resolvedName($names.resolved, "character", characterID, "someone");
  }

  function ownerName(ownerID: number): string {
    return resolvedName($names.resolved, isAllianceOwner(ownerID) ? "alliance" : "corporation", ownerID, "their organisation");
  }

  /** Who a message went to, in words. */
  function audienceText(header: MailHeaderRow): string {
    const audience = audienceOf(header);
    if (audience.kind === "characters") {
      const shown = audience.characterIDs.slice(0, 3).map(personName);
      const extra = audience.characterIDs.length - shown.length;
      return extra > 0 ? `${shown.join(", ")} and ${extra} more` : shown.join(", ");
    }
    if (audience.kind === "list") {
      return listName(header.toListID ?? 0) ?? "a mailing list";
    }
    if (audience.kind === "corporation") {
      return `everyone at ${ownerName(audience.ownerID)}`;
    }
    // ⚠ A real shape: the server does not refuse mail addressed to nobody.
    return "nobody";
  }

  const flags = $derived(readFlags($mail.statuses));

  function isUnread(messageID: number): boolean {
    return flags.get(messageID) === false;
  }

  const openHeader = $derived(
    $mail.open === null
      ? null
      : ($mail.messages.find((row) => row.messageID === $mail.open?.messageID) ?? null),
  );


  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "Your session ended. Pick your character again."
        : cause instanceof Error
          ? cause.message
          : String(cause);
    } finally {
      busy = false;
    }
  }

  /** The compose window's words, by their labels (ConstructTopContainer; ClickSend; GetSearchWnd; ownerSearch.py). */
  const COMPOSE_WORDS = {
    to: "UI/Mail/To",
    subject: "UI/Mail/Subject",
    send: "UI/Mail/SendMail",
    searchFor: "UI/Mail/SearchForRecipients",
    searchBy: "UI/Common/SearchBy",
    search: "UI/Mail/Search",
    add: "UI/Mail/Add",
    added: "UI/Mail/CharacterAdded",
    partial: "UI/Search/UniversalSearch/PartialTerms",
    exactTerms: "UI/Search/UniversalSearch/ExactTerms",
    exactPhrase: "UI/Search/UniversalSearch/ExactPhrase",
    onlyExact: "UI/Search/UniversalSearch/OnlyExactPhrase",
    typeIn: "UI/Common/TypeInSearch",
    nothingFound: "UI/Market/NothingFoundWithSearch",
    manyFound: "UI/Mail/25OrMoreFound",
    listQ: "UI/Mail/SendToMailingListQ",
    listQ2: "UI/Mail/SendToMailingListQ2",
    noRecipient: "UI/Mail/NoRecipientForMessage",
    tooMany: "UI/Mail/TooManyRecipients",
    unknown: "UI/Common/Unknown",
    labelCorp: "UI/Mail/LabelCorp",
    labelAlliance: "UI/Mail/LabelAlliance",
    allContacts: "UI/Mail/AllContacts",
    noContacts: "UI/AddressBook/NoContacts",
  } as const;
  /** The client's dialogs the compose window says things with. */
  const COMPOSE_DIALOGS = [
    "EvemailCantFindRecipient", "EvemailMaxRecipients", "EvemailMaxListOrCorp", "PartialSearchLessThanMinLength",
    "EvemailCantSendToOtherCorp", "EvemailCantSendToNPCCorp", "EvemailSendingFailed", "DiscardMailMessage",
    "EvemailCantSendToOtherAlliance", "EvemailCantSendToAllianceNoRole",
  ] as const;
  /** What may be typed for the pilot's own corporation and alliance besides their names (evemail.py 62 to 63). */
  const CORP_TEXT = "corp";
  const ALLIANCE_TEXT = "alliance";
  /** The search's Search By (searchUtil.SEARCHBY_OPTIONS; search/const.py MatchBy): its four, in their order. */
  const SEARCH_BY: readonly (readonly [number, string, string])[] = [
    [0, COMPOSE_WORDS.partial, "Partial Terms"],
    [1, COMPOSE_WORDS.exactTerms, "Exact Terms"],
    [2, COMPOSE_WORDS.exactPhrase, "Exact Phrase"],
    [3, COMPOSE_WORDS.onlyExact, "Exact phrase only"],
  ];
  /** MatchBy.exact_phrase, as GetReceiver searches (evemail.py 2033); and the least a partial term may be (min_wildcard_length). */
  const MATCH_EXACT_PHRASE = 2;
  const MIN_WILDCARD_LENGTH = 3;
  /** The most groups (lists, corporations, alliances) a mail may go to (appConst.py 1783, mailMaxGroups). */
  const MAIL_MAX_GROUPS = 1;

  /** What the compose window last said (its dialogs), each a line. */
  let composeNotes = $state<readonly string[]>([]);
  /** A question of the window's waiting on the pilot (CustomQuestion), and its answer. */
  let composeQuestion = $state<{ readonly title: string; readonly body: string; readonly answer: (yes: boolean) => void } | null>(null);
  /** A pick of one among those found (ListWindow), the one picked, and what it said. */
  let composePick = $state<{ readonly caption: string; readonly hint: string; readonly options: readonly CharacterMatch[]; readonly answer: (characterID: number | null) => void } | null>(null);
  let composePicked = $state<number | null>(null);
  let composePickNote = $state("");
  /** The window "Find recipients" (MailSearchWindow): open or not, what is typed, Search By, and what it found. */
  let recipientSearchOpen = $state(false);
  let recipientSearchText = $state("");
  // svelte-ignore state_referenced_locally
  const keptSearchBy: unknown = flow.ownersSearchBy();
  let recipientMatchBy = $state(typeof keptSearchBy === "number" ? keptSearchBy : 0);
  let recipientResults = $state<readonly CharacterMatch[]>([]);
  let recipientSearchNote = $state("");
  /** The window's tabs (Search, All Contacts), its own entries found (lists, the corporation, the alliance), and the contacts once loaded. */
  let recipientSearchTab = $state<"search" | "contacts">("search");
  interface RecipientExtra {
    readonly kind: "corp" | "alliance" | "list";
    readonly id: number;
    readonly name: string;
  }
  let recipientExtras = $state<readonly RecipientExtra[]>([]);
  let recipientContacts = $state<readonly CharacterMatch[] | null>(null);

  /** A list as the compose window writes it among its recipients (AddList, 1951 to 1959: UI/Mail/MailEntry). */
  function mailEntryOf(name: string): string {
    return filledWord(FOLDER_WORDS.mailEntry, "{entryName} {entryType}", { entryName: name, entryType: word(FOLDER_WORDS.ml, "[ML]") });
  }

  /**
   * The field written from the receivers held: the pilots, the corporation, then the list, each followed by ", ", as the
   * window adds them as it opens (ApplyAttributes, 1803 to 1822; AddReceiver; ValidateReceivers).
   */
  function writeReceivers(): void {
    const parts = [...recipients.map((person) => person.name), ...toCorpAlliance.map((group) => group.name)];
    if (composeList !== undefined) {
      parts.push(mailEntryOf(composeList.displayName));
    }
    receiverText = parts.map((part) => `${part}, `).join("");
  }

  /** CustomQuestion, answered yes or no. */
  function askYesNo(title: string, body: string): Promise<boolean> {
    return new Promise((resolve) => {
      composeQuestion = { title, body, answer: (yes) => { composeQuestion = null; resolve(yes); } };
    });
  }

  /** ListWindow.ShowList, modal, one to be picked: the one picked, or none where it was put away. */
  function pickOne(caption: string, hint: string, options: readonly CharacterMatch[]): Promise<number | null> {
    composePicked = null;
    composePickNote = "";
    return new Promise((resolve) => {
      composePick = { caption, hint, options, answer: (characterID) => { composePick = null; resolve(characterID); } };
    });
  }

  /** GetCleanNameAndGroup (2205 to 2214): a name ending with the list's mark is a list's, the mark taken off. */
  function cleanNameAndGroup(raw: string): { readonly name: string; readonly listed: boolean } {
    const name = raw.trim();
    const mark = word(FOLDER_WORDS.ml, "[ML]");
    if (name.endsWith(mark)) {
      const taken = name.replace(mark, "");
      return { name: taken.endsWith(" ") ? taken.slice(0, -1) : taken, listed: true };
    }
    return { name, listed: false };
  }

  /** What one check of the field holds as it goes (ValidateReceivers' toChars, toCorpAlliance, toListID, and the names used). */
  interface ReceiverCheck {
    readonly toChars: Map<string, number>;
    readonly toCorpAlliance: Map<string, number>;
    listID: number | null;
    readonly charNamesUsed: Map<string, number>;
    readonly corpNamesUsed: Set<string>;
    readonly listNamesUsed: Set<string>;
    readonly notes: string[];
  }

  /**
   * GetMaxGroupText (2102 to 2116): the client's EvemailMaxListOrCorp, the group already held named: the corporation
   * held, else the list; "Unknown" where none is.
   */
  function maxGroupText(name: string, corpNames: Iterable<string>, listID: number | null): string {
    const held = listID === null ? undefined : ($mail.lists ?? []).find((list) => list.listID === listID);
    const groups = [...corpNames, ...(held !== undefined ? [held.displayName] : [])];
    const groupName = groups.length >= MAIL_MAX_GROUPS ? (groups[0] ?? "") : word(COMPOSE_WORDS.unknown, "Unknown");
    return filledWord("dialog:EvemailMaxListOrCorp/body", "'{name}' stays off: a mail goes to one mailing list, corporation or alliance at most, and {groupName} is it.", { name, groupName });
  }

  /**
   * ValidateCorpOrAlliance (1919 to 1937): a corporation the pilot's own and not an NPC's; an alliance the session's
   * own, and the pilot with the Communications Officer's role; each refused in the client's words; anything else
   * refused with nothing said. The session's alliance and roles are as the transport says them (the gateway says
   * neither, and the page then takes no alliance).
   */
  function validateCorpOrAlliance(ownerID: number, notes: string[]): boolean {
    if (isCorporationOwner(ownerID)) {
      if (ownerID !== ($station.online?.corporationID ?? null)) {
        notes.push(filledWord("dialog:EvemailCantSendToOtherCorp/body", "Mail can go to no corporation but your own.", {}));
        return false;
      }
      if (isNpcOwner(ownerID)) {
        notes.push(filledWord("dialog:EvemailCantSendToNPCCorp/body", "Mail can go to a corporation of players only.", {}));
        return false;
      }
      return true;
    }
    if (isAllianceOwner(ownerID)) {
      if (ownerID !== ($station.online?.allianceID ?? null)) {
        notes.push(filledWord("dialog:EvemailCantSendToOtherAlliance/body", "Mail can go to no alliance but your own.", {}));
        return false;
      }
      if (!hasChatManagerRole($station.online?.corpRole)) {
        notes.push(filledWord("dialog:EvemailCantSendToAllianceNoRole/body", "Mail to your alliance needs a role you do not have.", {}));
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * AddUnknownToValidate (2216 to 2243) by NewParseReceiver (1975 to 2018): a list joined by its very name, after the
   * client's question; else the pilot's own corporation by its name or "corp", where ValidateCorpOrAlliance takes it;
   * else a pilot by GetReceiver (2029 to 2046): one held by the name, or searchOld.Search for the exact phrase, one
   * found taken, more picked from, none: "Find recipients" opened with the name. Each group counted against
   * the most groups (TotalNumberOfGroups, 2099 to 2100). Null where nothing is added.
   */
  async function addUnknown(name: string, check: ReceiverCheck): Promise<{ readonly listed: boolean; readonly name: string } | null> {
    const trimmed = name.trim();
    const groupsHeld = () => check.toCorpAlliance.size + (check.listID !== null ? 1 : 0);
    const groupsUsed = () => check.corpNamesUsed.size + check.listNamesUsed.size;
    for (const list of $mail.lists ?? []) {
      if (list.displayName !== trimmed) {
        continue;
      }
      if (!(await askYesNo(word(COMPOSE_WORDS.listQ, "Write to the list?"), filledWord(COMPOSE_WORDS.listQ2, "{listName} is a mailing list you belong to. Mail the list?", { listName: trimmed })))) {
        continue;
      }
      if (groupsHeld() >= MAIL_MAX_GROUPS) {
        check.notes.push(maxGroupText(name, check.toCorpAlliance.keys(), check.listID));
        return null;
      }
      check.listID = list.listID;
      if (groupsUsed() >= MAIL_MAX_GROUPS) {
        check.notes.push(maxGroupText(name, check.corpNamesUsed, check.listID));
        return null;
      }
      if (check.listNamesUsed.has(name)) {
        return null;
      }
      check.listNamesUsed.add(name);
      return { listed: true, name };
    }
    // The pilot's own corporation (1986 to 1996), then its alliance where the session is in one (1997 to 2008): each
    // by its name or its word.
    const corporation = await flow.ownCorporation();
    const alliance = await flow.ownAlliance();
    const groups = [
      ...(corporation === null ? [] : [{ name: corporation.name, ownerID: corporation.corporationID, word: CORP_TEXT }]),
      ...(alliance === null ? [] : [{ name: alliance.name, ownerID: alliance.allianceID, word: ALLIANCE_TEXT }]),
    ];
    for (const group of groups) {
      if (![group.name.toLowerCase(), group.word].includes(trimmed.toLowerCase())) {
        continue;
      }
      if (!validateCorpOrAlliance(group.ownerID, check.notes)) {
        return null;
      }
      if (groupsHeld() >= MAIL_MAX_GROUPS) {
        check.notes.push(maxGroupText(group.name, check.toCorpAlliance.keys(), check.listID));
        return null;
      }
      check.toCorpAlliance.set(group.name, group.ownerID);
      if (groupsUsed() >= MAIL_MAX_GROUPS) {
        check.notes.push(maxGroupText(group.name, check.corpNamesUsed, check.listID));
        return null;
      }
      if (check.corpNamesUsed.has(group.name)) {
        return null;
      }
      check.corpNamesUsed.add(group.name);
      return { listed: false, name: group.name };
    }
    let found: CharacterMatch | null = null;
    const held = check.toChars.get(trimmed);
    if (held !== undefined) {
      found = { characterID: held, name: trimmed };
    } else {
      const text = trimmed.replace(/%/g, "").replace(/\?/g, "").replace(/\*/g, "").trim();
      const matches = text.length < 1 || text.length >= 100 ? [] : await flow.searchCharacters(text, MATCH_EXACT_PHRASE);
      if (matches.length === 1) {
        found = matches[0] ?? null;
      } else if (matches.length > 1) {
        const sorted = [...matches].sort((left, right) => (left.name.toLowerCase() < right.name.toLowerCase() ? -1 : 1));
        const picked = await pickOne(
          filledWord(ACCESS_WORDS.select, "Select {groupName}", { groupName: word(ACCESS_WORDS.character, "Character") }),
          filledWord(ACCESS_WORDS.found, "{itemCount} {groupNames} were found with \"{searchTerm}\" in their name.", { itemCount: String(sorted.length), groupNames: word(ACCESS_WORDS.characters, "Characters"), searchTerm: text }),
          sorted,
        );
        found = sorted.find((each) => each.characterID === picked) ?? null;
      } else {
        // MAIL_GET_SEARCH_WND, the client's default: the search window opened with the name.
        openRecipientSearch(trimmed);
      }
    }
    if (found === null) {
      return null;
    }
    if (check.toChars.size >= MAIL_MAX_RECIPIENTS) {
      check.notes.push(filledWord("dialog:EvemailMaxRecipients/body", "'{name}' stays off: a mail goes to {max} recipients at most.", { name: found.name, max: String(MAIL_MAX_RECIPIENTS) }));
      return null;
    }
    check.toChars.set(found.name, found.characterID);
    if (check.charNamesUsed.size >= MAIL_MAX_RECIPIENTS) {
      check.notes.push(filledWord("dialog:EvemailMaxRecipients/body", "'{name}' stays off: a mail goes to {max} recipients at most.", { name: found.name, max: String(MAIL_MAX_RECIPIENTS) }));
      return null;
    }
    if (check.charNamesUsed.has(found.name)) {
      return null;
    }
    check.charNamesUsed.set(found.name, found.characterID);
    return { listed: false, name: found.name };
  }

  /**
   * ValidateReceivers (evemail.py 2128 to 2201): each name in the field, a known one kept, any other added as the
   * client adds it or said not to be found; the field written again from what is kept, the pilots not named let go,
   * and the list let go where it is not named or no longer joined. One check at a time (parsingReceivers).
   */
  let receiverCheck: Promise<void> | null = null;
  function validateReceivers(): Promise<void> {
    receiverCheck ??= checkReceivers().finally(() => {
      receiverCheck = null;
    });
    return receiverCheck;
  }

  async function checkReceivers(): Promise<void> {
    const joined = $mail.lists ?? [];
    const joinedNames = joined.map((list) => list.displayName.toLowerCase());
    const check: ReceiverCheck = {
      toChars: new Map(recipients.map((person) => [person.name, person.characterID] as const)),
      toCorpAlliance: new Map(toCorpAlliance.map((group) => [group.name, group.ownerID] as const)),
      listID: composeList?.listID ?? null,
      charNamesUsed: new Map(),
      corpNamesUsed: new Set(),
      listNamesUsed: new Set(),
      notes: [],
    };
    const parts: string[] = [];
    for (const raw of receiverText.split(",")) {
      if (raw.trim() === "") {
        continue;
      }
      const clean = cleanNameAndGroup(raw);
      let cleanName = clean.name;
      let listed = clean.listed;
      const listName = check.listID === null ? null : (joined.find((list) => list.listID === check.listID)?.displayName ?? null);
      const known = [...check.toChars.keys(), ...check.toCorpAlliance.keys(), ...(listName !== null ? [listName] : [])];
      if (!known.includes(cleanName)) {
        const added = await addUnknown(cleanName, check);
        if (added === null) {
          check.notes.push(filledWord("dialog:EvemailCantFindRecipient/body", "Mail cannot go to \"{name}\".", { name: cleanName }));
          continue;
        }
        listed = added.listed;
        cleanName = added.name;
      } else if (listed) {
        if (joinedNames.includes(cleanName.toLowerCase())) {
          if (check.listNamesUsed.has(cleanName)) {
            continue;
          }
          check.listNamesUsed.add(cleanName);
        }
      } else if (check.toChars.has(cleanName) && !check.charNamesUsed.has(cleanName)) {
        check.charNamesUsed.set(cleanName, check.toChars.get(cleanName) ?? 0);
      } else if (check.toCorpAlliance.has(cleanName) && !check.corpNamesUsed.has(cleanName)) {
        check.corpNamesUsed.add(cleanName);
      } else {
        const added = await addUnknown(cleanName, check);
        if (added === null) {
          continue;
        }
        listed = added.listed;
        cleanName = added.name;
      }
      parts.push(listed ? mailEntryOf(cleanName) : cleanName);
    }
    receiverText = parts.map((part) => `${part}, `).join("");
    recipients = [...check.charNamesUsed].map(([name, characterID]) => ({ characterID, name }));
    toCorpAlliance = [...check.toCorpAlliance].filter(([name]) => check.corpNamesUsed.has(name)).map(([name, ownerID]) => ({ name, ownerID }));
    toList = check.listID !== null && check.listNamesUsed.size > 0 && joined.some((list) => list.listID === check.listID) ? check.listID : null;
    composeNotes = [...composeNotes, ...check.notes];
  }

  /**
   * The field left, or a comma typed in it (OnFocusLost, OnInsert: ValidateReceiver, 2118 to 2126): the names checked.
   * (Not as busy: the field is left as Send is pressed, and Send waits for the same check.)
   */
  function receiversChanged(): void {
    composeNotes = [];
    validateReceivers().catch((cause: unknown) => {
      error = cause instanceof Error ? cause.message : String(cause);
    });
  }

  /** One of the field's offers (ReceiverEdit.GetValid): what it shows, the name it writes, and whose it is. */
  interface ReceiverOffer {
    readonly group: "char" | "list" | "corp";
    readonly displayName: string;
    readonly name: string;
    readonly id: number;
  }
  /** The field's offers shown (CheckHistory: the first five), the one gone to by the arrow keys, and what is before the last comma. */
  let receiverOffers = $state<readonly ReceiverOffer[]>([]);
  let activeOffer = $state(-1);
  let offerRest = "";

  /**
   * ReceiverEdit.GetValid (2384 to 2426), as each letter is typed or taken out (CheckHistory): what follows the last
   * comma matched as the start of the name of each of the pilot's buddies (its contacts that are characters and not
   * NPCs, evemail.py 1782), offered by name; of each list joined, as "name [ML]" in the order the client's dict holds
   * them; of the pilot's own corporation where it is not an NPC's, as "name [Corp]"; and of its alliance where the
   * pilot has the Communications Officer's role, as "name [Alliance]"; a name that is all the field holds not offered
   * (the client's own comparison, of what is typed as it is); sorted by the length of the name, the first five shown.
   */
  async function checkOffers(): Promise<void> {
    const value = receiverText;
    const lastComma = value.lastIndexOf(",");
    const rest = lastComma > -1 ? value.slice(0, lastComma + 1) : "";
    const current = lastComma > -1 ? value.slice(lastComma + 1) : value;
    const typed = current.trim().toLowerCase();
    const valid: ReceiverOffer[] = [];
    // The buddies first (2400 to 2403): the pilot's contacts that are characters and not NPCs (evemail.py 1782).
    for (const buddy of await flow.mailContacts().catch(() => [])) {
      if (buddy.name.toLowerCase().startsWith(typed) && buddy.name !== current) {
        valid.push({ group: "char", displayName: buddy.name, name: buddy.name, id: buddy.characterID });
      }
    }
    const lists = $mail.lists ?? [];
    for (const listID of pyIntDictOrder(lists.map((list) => list.listID))) {
      const list = lists.find((each) => each.listID === listID);
      if (list !== undefined && list.displayName.toLowerCase().startsWith(typed) && list.displayName !== current) {
        valid.push({ group: "list", displayName: mailEntryOf(list.displayName), name: list.displayName, id: list.listID });
      }
    }
    // The corporation, then the alliance (GetAllOptions' corpAll, 2048 to 2058): an NPC's not offered, nor an
    // alliance without the Communications Officer's role.
    const corporation = await flow.ownCorporation();
    const alliance = await flow.ownAlliance();
    const owners = [
      ...(corporation === null ? [] : [{ id: corporation.corporationID, name: corporation.name, mark: word(COMPOSE_WORDS.labelCorp, "[Corp]") }]),
      ...(alliance === null || !hasChatManagerRole($station.online?.corpRole) ? [] : [{ id: alliance.allianceID, name: alliance.name, mark: word(COMPOSE_WORDS.labelAlliance, "[Alliance]") }]),
    ];
    for (const owner of owners) {
      if (!isNpcOwner(owner.id) && owner.name.toLowerCase().startsWith(typed) && owner.name !== current) {
        const displayName = filledWord(FOLDER_WORDS.mailEntry, "{entryName} {entryType}", { entryName: owner.name, entryType: owner.mark });
        valid.push({ group: "corp", displayName, name: owner.name, id: owner.id });
      }
    }
    if (receiverText !== value) {
      return;
    }
    offerRest = rest;
    receiverOffers = [...valid].sort((left, right) => left.name.length - right.name.length).slice(0, 5);
    activeOffer = -1;
  }

  /**
   * An offer taken (OnReceiverHistoryClick, 2060 to 2079): a list by AddList, a corporation by AddCorpAllianceReciver
   * (ValidateCorpOrAlliance, then the most groups), each in part: the field then what was before the last comma and
   * the name, a list's with its mark; where it is not taken, what was before the comma alone.
   */
  function takeOffer(offer: ReceiverOffer): void {
    receiverOffers = [];
    activeOffer = -1;
    const notes: string[] = [];
    const groupsHeld = toCorpAlliance.length + (toList !== null ? 1 : 0);
    const corpNames = toCorpAlliance.map((group) => group.name);
    let taken: string | null = null;
    if (offer.group === "char") {
      // AddCharacterReceiver(id, partly=1) (1905 to 1917): no more than the most recipients.
      if (recipients.length >= MAIL_MAX_RECIPIENTS) {
        notes.push(filledWord("dialog:EvemailMaxRecipients/body", "'{name}' stays off: a mail goes to {max} recipients at most.", { name: offer.name, max: String(MAIL_MAX_RECIPIENTS) }));
      } else {
        recipients = [...recipients.filter((person) => person.name !== offer.name), { characterID: offer.id, name: offer.name }];
        taken = offer.name;
      }
    } else if (offer.group === "list") {
      if (groupsHeld >= MAIL_MAX_GROUPS) {
        notes.push(maxGroupText(offer.name, corpNames, toList));
      } else {
        toList = offer.id;
        taken = mailEntryOf(offer.name);
      }
    } else if (validateCorpOrAlliance(offer.id, notes)) {
      if (groupsHeld >= MAIL_MAX_GROUPS) {
        notes.push(maxGroupText(offer.name, corpNames, toList));
      } else {
        toCorpAlliance = [...toCorpAlliance.filter((group) => group.name !== offer.name), { name: offer.name, ownerID: offer.id }];
        taken = offer.name;
      }
    }
    receiverText = taken === null ? offerRest : `${offerRest}${offerRest !== "" ? " " : ""}${taken}`;
    composeNotes = notes;
  }

  /** The arrow keys go through the offers, and Enter takes the one gone to (BrowseHistory; ReceiverEdit.Confirm). */
  function offerKeys(event: KeyboardEvent): void {
    if (receiverOffers.length === 0) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      activeOffer = Math.min(receiverOffers.length - 1, Math.max(0, activeOffer + step));
    } else if (event.key === "Enter" && activeOffer >= 0) {
      event.preventDefault();
      const offer = receiverOffers[activeOffer];
      if (offer !== undefined) {
        takeOffer(offer);
      }
    } else if (event.key === "Escape") {
      receiverOffers = [];
      activeOffer = -1;
    }
  }

  /**
   * The To button (OpenReceiverSearch) or a name not found (GetSearchWnd, 2336 to 2353): "Find recipients",
   * opened afresh on its Search tab with what is given, and searched at once where something is.
   */
  function openRecipientSearch(input = ""): void {
    recipientSearchOpen = true;
    recipientSearchTab = "search";
    recipientSearchText = input;
    recipientResults = [];
    recipientExtras = [];
    recipientContacts = null;
    recipientSearchNote = word(COMPOSE_WORDS.typeIn, "Enter a name, then search.");
    if (input !== "") {
      searchRecipients();
    }
  }

  /**
   * MailSearchWindow.GetExtraSearchEntries (evemail.py 2927 to 2946): the lists joined that match what was typed
   * (searchUtil.IsMatch, by Search By), by their names; before them the alliance where the pilot has the
   * Communications Officer's role, and before that the corporation where it is not an NPC's, each where it matches.
   */
  async function extraRecipientEntries(typed: string, matchBy: number): Promise<RecipientExtra[]> {
    const lists = $mail.lists ?? [];
    const extras: RecipientExtra[] = pyIntDictOrder(lists.map((list) => list.listID))
      .flatMap((listID) => lists.filter((list) => list.listID === listID))
      .filter((list) => isSearchMatch(typed, list.displayName, matchBy))
      .map((list) => ({ kind: "list" as const, id: list.listID, name: list.displayName }))
      .sort((left, right) => (left.name.toLowerCase() < right.name.toLowerCase() ? -1 : left.name.toLowerCase() > right.name.toLowerCase() ? 1 : 0));
    const alliance = await flow.ownAlliance();
    if (alliance !== null && hasChatManagerRole($station.online?.corpRole) && isSearchMatch(typed, alliance.name, matchBy)) {
      extras.unshift({ kind: "alliance", id: alliance.allianceID, name: alliance.name });
    }
    const corporation = await flow.ownCorporation();
    if (corporation !== null && !isNpcOwner(corporation.corporationID) && isSearchMatch(typed, corporation.name, matchBy)) {
      extras.unshift({ kind: "corp", id: corporation.corporationID, name: corporation.name });
    }
    return extras;
  }

  /**
   * OwnerSearchWindow.Search (ownerSearch.py 137 to 163) by searchOld.Search, with hideNPC and Search By: nothing
   * typed asks nothing; % and ? and * taken out; partial terms need a term of three or more
   * (PartialSearchLessThanMinLength); the window's own entries first (GetExtraSearchEntries), then the pilots
   * found by name, or the client's words for none.
   */
  function searchRecipients(): void {
    const typed = recipientSearchText;
    if (typed.trim() === "") {
      recipientResults = [];
      recipientExtras = [];
      recipientSearchNote = word(COMPOSE_WORDS.typeIn, "Enter a name, then search.");
      return;
    }
    const matchBy = recipientMatchBy;
    const text = typed.replace(/%/g, "").replace(/\?/g, "").replace(/\*/g, "").trim();
    if (matchBy === 0 && !text.split(/\s+/).some((term) => term.length >= MIN_WILDCARD_LENGTH)) {
      recipientSearchNote = filledWord("dialog:PartialSearchLessThanMinLength/body", "A partial search needs a term longer than {minChars} characters.", { minChars: String(MIN_WILDCARD_LENGTH) });
      return;
    }
    void run(async () => {
      const found = text.length < 1 || text.length >= 100 ? [] : await flow.searchCharacters(text, matchBy);
      const extras = await extraRecipientEntries(typed, matchBy);
      recipientResults = [...found].sort((left, right) => (left.name.toLowerCase() < right.name.toLowerCase() ? -1 : 1));
      recipientExtras = extras;
      recipientSearchNote = found.length === 0 && extras.length === 0
        ? filledWord(COMPOSE_WORDS.nothingFound, "No name holds \"{search}\".", { search: typed })
        : found.length >= 500 ? filledWord(COMPOSE_WORDS.manyFound, "25 or more characters were found with \"{name}\".", { name: typed }) : "";
    });
  }

  /** Search By chosen (ChangeSearchBy, ownerSearch.py 95 to 97): kept in the user's settings. */
  function recipientSearchByChanged(): void {
    flow.keepOwnersSearchBy(recipientMatchBy);
  }

  /**
   * The All Contacts tab (ownerSearch.py LoadContacts, 190 to 204), loaded once as it is first shown: the
   * pilot's contacts that are characters and not NPCs, by name.
   */
  function showRecipientContacts(): void {
    recipientSearchTab = "contacts";
    if (recipientContacts !== null) {
      return;
    }
    void run(async () => {
      const contacts = await flow.mailContacts();
      recipientContacts = [...contacts].sort((left, right) => (left.name.toLowerCase() < right.name.toLowerCase() ? -1 : left.name.toLowerCase() > right.name.toLowerCase() ? 1 : 0));
    });
  }

  /**
   * AddReceiverFromSearch (2318 to 2334) for one of the window's own entries: a list by AddList (1951 to 1959), a
   * corporation or an alliance by AddCorpAllianceReciver (1938 to 1949), each refused where the most groups are
   * held; then AddReceiver (1962 to 1972): its name added to the field, a list's with its mark, and the names checked.
   */
  function addExtraFromSearch(entry: RecipientExtra): void {
    composeNotes = [];
    const notes: string[] = [];
    const groupsHeld = toCorpAlliance.length + (toList !== null ? 1 : 0);
    const corpNames = toCorpAlliance.map((group) => group.name);
    let added: string | null = null;
    if (entry.kind === "list") {
      if (groupsHeld >= MAIL_MAX_GROUPS) {
        notes.push(maxGroupText(entry.name, corpNames, toList));
      } else {
        toList = entry.id;
        added = mailEntryOf(entry.name);
      }
    } else if (validateCorpOrAlliance(entry.id, notes)) {
      if (groupsHeld >= MAIL_MAX_GROUPS) {
        notes.push(maxGroupText(entry.name, corpNames, toList));
      } else {
        toCorpAlliance = [...toCorpAlliance.filter((group) => group.name !== entry.name), { name: entry.name, ownerID: entry.id }];
        added = entry.name;
      }
    }
    composeNotes = notes;
    if (added === null) {
      return;
    }
    receiverText = receiverText === "" ? added : `${receiverText}, ${added}`;
    void run(validateReceivers);
  }

  /** AddReceiverFromSearch by AddCharacterReceiver (1905 to 1917, 2318 to 2334): the pilot's name added to the field, then the names checked. */
  function addFromSearch(person: CharacterMatch): void {
    composeNotes = [];
    if (recipients.length >= MAIL_MAX_RECIPIENTS) {
      composeNotes = [filledWord("dialog:EvemailMaxRecipients/body", "'{name}' stays off: a mail goes to {max} recipients at most.", { name: person.name, max: String(MAIL_MAX_RECIPIENTS) })];
      return;
    }
    if (!recipients.some((each) => each.name === person.name)) {
      recipients = [...recipients, person];
    }
    receiverText = receiverText.trim() === "" ? person.name : `${receiverText}, ${person.name}`;
    void run(validateReceivers);
  }

  /** The compose window put away: what it held let go. */
  function clearCompose(): void {
    recipients = [];
    toCorpAlliance = [];
    receiverOffers = [];
    receiverText = "";
    draftTitle = "";
    draftBody = "";
    replyTo = 0;
    forwardFrom = 0;
    quote = "";
    toList = null;
    composeNotes = [];
    recipientSearchOpen = false;
  }

  /**
   * The compose window closed by the pilot (CloseByUser, 2360 to 2365): where the body holds anything (the quote is
   * in the client's editor, so a reply's or a forward's always does), the client's DiscardMailMessage first, and on no
   * the window kept.
   */
  function neverMind(): void {
    void run(async () => {
      if ((draftBody + quote).trim() !== "" && !(await askYesNo(
        filledWord("dialog:DiscardMailMessage/title", "Discard?", {}),
        filledWord("dialog:DiscardMailMessage/body", "Throw this message away?", {}),
      ))) {
        return;
      }
      clearCompose();
      tab = "inbox";
    });
  }

  /** Opening a message marks it read — the player's own deliberate act. */
  function open(messageID: number): void {
    void run(() => flow.openMail(messageID, isUnread(messageID)));
  }

  // A popup's click (mailFocus.ts): a new mail's opens the mail (mailSvc.OnOpenPopupMail), once the mailbox holds it;
  // a notification's shows the notifications tab, which takes it from there.
  let focusedMail = $state<{ readonly messageID: number; readonly n: number } | null>(null);
  const stopFocus = mailFocus.subscribe((focus) => {
    if (focus === null) return;
    if (focus.kind === "notification") {
      tab = "notifications";
      return;
    }
    if (focus.kind === "compose") {
      mailFocusServed(focus.n);
      composeTo(focus.characterID, focus.name);
      return;
    }
    tab = "inbox";
    focusedMail = { messageID: focus.messageID, n: focus.n };
  });
  onDestroy(stopFocus);
  $effect(() => {
    const focus = focusedMail;
    if (focus === null || !$mail.loaded || !$mail.messages.some((header) => header.messageID === focus.messageID)) return;
    focusedMail = null;
    mailFocusServed(focus.n);
    open(focus.messageID);
  });

  /**
   * ClickSend (evemail.py 2245 to 2297): the names checked first; then no recipient, more than the most, no subject
   * and a subject too long refused in the client's words; the corporation checked again (ValidateCorpOrAlliance,
   * else EvemailSendingFailed); then sent, the subject as typed.
   */
  function send(): void {
    void run(async () => {
      composeNotes = [];
      await validateReceivers();
      const count = recipients.length + toCorpAlliance.length + (composeList !== undefined ? 1 : 0);
      if (count < 1) {
        composeNotes = [...composeNotes, word(COMPOSE_WORDS.noRecipient, "There is no recipient for this message.")];
        return;
      }
      if (count > MAIL_MAX_RECIPIENTS + 1) {
        composeNotes = [...composeNotes, filledWord(COMPOSE_WORDS.tooMany, "A mail goes to {max} recipients at most.", { max: String(MAIL_MAX_RECIPIENTS) })];
        return;
      }
      if (draftTitle.trim() === "") {
        composeNotes = [...composeNotes, filledWord("dialog:NoSubject/body", "A mail needs a subject.", {})];
        return;
      }
      if (draftTitle.length > MAIL_MAX_TITLE) {
        composeNotes = [...composeNotes, word(FOLDER_WORDS.nameTooLong, "That name runs too long.")];
        return;
      }
      const corpAlliance = toCorpAlliance[0]?.ownerID ?? null;
      if (corpAlliance !== null) {
        const notes: string[] = [];
        if (!validateCorpOrAlliance(corpAlliance, notes)) {
          composeNotes = [...composeNotes, ...notes, filledWord("dialog:EvemailSendingFailed/body", "The mail could not go to that corporation.", {})];
          return;
        }
      }
      await flow.sendMail({
        toCharacterIDs: recipients.map((person) => person.characterID),
        toListID: composeList?.listID ?? null,
        toCorpOrAllianceID: corpAlliance,
        title: draftTitle,
        body: draftBody,
        quote,
        isReplyTo: replyTo,
        isForwardedFrom: forwardFrom,
      });
      const outcome = store.get().mail.lastOutcome;
      if (outcome && outcome.applied) {
        clearCompose();
        tab = "inbox";
      }
    });
  }

  /** The message quoted (GetReplyMessage), its body read as the client reads it; "" where it was not read. */
  async function quoteOf(header: MailHeaderRow): Promise<string> {
    const body = await flow.quotedMailBody(header.messageID);
    if (body === null) {
      return "";
    }
    const status = $mail.statuses.find((row) => row.messageID === header.messageID);
    const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, kind, id, "");
    return mailQuoteMarkup(
      {
        subject: header.title,
        senderID: header.senderID,
        senderName: senderName(header),
        automated: status !== undefined && (status.statusMask & 32) === 32,
        sentText: header.sentDate === null ? "" : formatTemplate(word(DATE_LABEL, "{[datetime]datetime}"), { datetime: String(header.sentDate) }, { nameOf }),
        corporationName: header.toCorpOrAllianceID === null ? null : ownerName(header.toCorpOrAllianceID),
        recipients: header.toCharacterIDs.map((id) => ({ id, name: personName(id) })),
        body,
      },
      {
        from: word(MAIL_QUOTE_LABELS.from, "From"),
        sent: word(MAIL_QUOTE_LABELS.sent, "Sent"),
        to: word(MAIL_QUOTE_LABELS.to, "To"),
        bold: (name) => formatTemplate(word(MAIL_QUOTE_LABELS.boldName, "<b>{name}</b>"), { name }, { nameOf }),
      },
      MAIL_MAX_BODY,
    );
  }

  /**
   * Reply (mailSvc.GetReplyWnd): to whoever wrote, or to all (the recipients less the pilot, the sender, and the
   * mailing list it went to, where the pilot has it joined: the compose window keeps no other, evemail.py 1816 to 1821); with
   * the client's "Re:" before the subject unless it begins so; answering that message; the message quoted.
   */
  function reply(header: MailHeaderRow, all = false): void {
    void run(async () => {
      const me = $station.online?.characterID ?? 0;
      const people = all ? [...header.toCharacterIDs.filter((id) => id !== me), header.senderID] : [header.senderID];
      recipients = [...new Set(people)].map((id) => ({ characterID: id, name: personName(id) }));
      const re = word(MAIL_QUOTE_LABELS.re, "Re:");
      draftTitle = header.title.startsWith(re) ? header.title : `${re} ${header.title}`;
      draftBody = "";
      toList = all ? header.toListID : null;
      // To all, the corporation it went to as well (GetReplyWnd, 1014 to 1016), taken as AddCorpAllianceReciver takes
      // it; and the list then refused where it was taken, the most groups being one (AddList, 1951 to 1954).
      const notes: string[] = [];
      toCorpAlliance = [];
      const corpAlliance = all ? header.toCorpOrAllianceID : null;
      if (corpAlliance !== null && validateCorpOrAlliance(corpAlliance, notes)) {
        toCorpAlliance = [{ name: ownerName(corpAlliance), ownerID: corpAlliance }];
        if (composeList !== undefined) {
          notes.push(maxGroupText(composeList.displayName, toCorpAlliance.map((group) => group.name), null));
          toList = null;
        }
      }
      // SendMsgDlg (994 to 997): the window's field written from what it is opened with (ApplyAttributes, 1803 to 1822).
      writeReceivers();
      composeNotes = notes;
      replyTo = header.messageID;
      forwardFrom = 0;
      quote = await quoteOf(header);
      tab = "compose";
    });
  }

  /** Forward (mailSvc.GetForwardWnd): to no one yet, "FW:" before the subject, forwarding it, the message quoted. */
  function forward(header: MailHeaderRow): void {
    void run(async () => {
      recipients = [];
      toCorpAlliance = [];
      toList = null;
      receiverText = "";
      composeNotes = [];
      draftTitle = `FW: ${header.title}`;
      draftBody = "";
      replyTo = 0;
      forwardFrom = header.messageID;
      quote = await quoteOf(header);
      tab = "compose";
    });
  }

  /** An owner's menu's Send Pilot EVEMail (menusvc.py 590 to 591; mailSvc.SendMsgDlg([charID])): a new message to the pilot alone. */
  function composeTo(characterID: number, name: string): void {
    clearCompose();
    recipients = [{ characterID, name }];
    // SendMsgDlg (994 to 997): the window's field written from what it is opened with (ApplyAttributes, 1803 to 1822).
    writeReceivers();
    tab = "compose";
  }

  /** A list's Send Mail to Mailing List (evemail.py SendMailToList; mailSvc.SendMsgDlg): a new message to the list alone. */
  function sendToList(listID: number): void {
    recipients = [];
    toCorpAlliance = [];
    toList = listID;
    writeReceivers();
    composeNotes = [];
    draftTitle = "";
    draftBody = "";
    replyTo = 0;
    forwardFrom = 0;
    quote = "";
    tab = "compose";
  }

  /** Whom a sent message went to, in the page's words. */
  function sentTo(count: number, list: string | null, corporation: string | null): string {
    const people = count === 1 ? "one person" : `${count} people`;
    const group = list !== null ? `the mailing list ${list}` : corporation !== null ? corporation : null;
    if (group === null) return people;
    return count === 0 ? group : `${group} and ${people}`;
  }

  /** The management window's words, by their labels (evemailingListConfig.py 54 to 130, 238 to 260). */
  const MANAGE_WORDS = {
    open: "UI/Mail/OpenMailingListMgmt",
    caption: "UI/EVEMail/MailingLists/Caption",
    membersTab: "UI/EVEMail/MailingLists/MembersTab",
    show: "UI/EVEMail/MailingLists/ShowLabel",
    all: "UI/Common/All",
    normal: "UI/EVEMail/MailingLists/NormalMembers",
    muted: "UI/EVEMail/MailingLists/MutedMembers",
    operators: "UI/Chat/Operators",
    byName: "UI/EVEMail/MailingLists/SearchByName",
    searchString: "UI/PeopleAndPlaces/SearchString",
    search: "UI/Common/Buttons/Search",
    previous: "UI/Common/Previous",
    next: "UI/Common/Next",
    setMember: "UI/EVEMail/MailingLists/SetRoleMember",
    setMuted: "UI/EVEMail/MailingLists/SetRoleMuted",
    setOperator: "UI/EVEMail/MailingLists/SetRoleOperator",
    kick: "UI/EVEMail/MailingLists/Kick",
    applyTo: "UI/EVEMail/MailingLists/ApplyToSelected",
    apply: "UI/Generic/Apply",
    member: "UI/EVEMail/MailingLists/Member",
    mutedMember: "UI/EVEMail/MailingLists/MutedMember",
    operator: "UI/EVEMail/MailingLists/Operator",
    owner: "UI/EVEMail/MailingLists/Owner",
    name: "UI/Generic/NamePerson",
    role: "UI/EVEMail/MailingLists/Role",
    none: "UI/EVEMail/MailingLists/NoMembersFound",
  } as const;
  /** The client's dialogs to be sure of the pilot's own place changed. */
  const MANAGE_DIALOGS = ["MailingListMemberSelfConfirm", "MailingListMuteSelfConfirm"] as const;
  /** Show's choices, in the window's order (StartupMembersPanel, 81 to 91). */
  const MEMBER_FILTERS: readonly (readonly [MailingListMemberFilter, string, string])[] = [
    ["all", MANAGE_WORDS.all, "All"],
    ["members", MANAGE_WORDS.normal, "Normal members"],
    ["muted", MANAGE_WORDS.muted, "Muted members"],
    ["operators", MANAGE_WORDS.operators, "Operators"],
    ["byName", MANAGE_WORDS.byName, "Find by name"],
  ];
  /** Apply to selected's choices, in the window's order (110 to 119). */
  const MEMBER_ACTIONS: readonly (readonly [MailingListMemberAction, string, string])[] = [
    ["member", MANAGE_WORDS.setMember, "Make a member"],
    ["muted", MANAGE_WORDS.setMuted, "Mute"],
    ["operator", MANAGE_WORDS.setOperator, "Make an operator"],
    ["kick", MANAGE_WORDS.kick, "Kick"],
  ];
  /** Each place's word (self.roles, 121 to 124). */
  const ROLE_WORDS: Readonly<Record<number, readonly [string, string]>> = {
    [MAILING_LIST_MEMBER_DEFAULT]: [MANAGE_WORDS.member, "Member"],
    [MAILING_LIST_MEMBER_MUTED]: [MANAGE_WORDS.mutedMember, "Muted member"],
    [MAILING_LIST_MEMBER_OPERATOR]: [MANAGE_WORDS.operator, "Operator"],
    [MAILING_LIST_MEMBER_OWNER]: [MANAGE_WORDS.owner, "Owner"],
  };

  /** The list whose management window is open, or null. */
  let managingList = $state<number | null>(null);
  /** The list's settings as the window last asked them: the Access tab's lists. */
  let listSettings = $state<MailingListSettings | null>(null);
  /** The members as the window last asked them, and the choice and search they were shown by then. */
  let listMembers = $state<readonly MailingListMember[]>([]);
  let shownFilter = $state<MailingListMemberFilter>("all");
  let shownSearch = $state("");
  /** Show's choice and the search as they stand, the page shown, Apply's choice, and the members chosen. */
  let memberFilter = $state<MailingListMemberFilter>("all");
  let memberSearch = $state("");
  let memberPage = $state(0);
  let memberAction = $state<MailingListMemberAction>("member");
  let chosenMembers = $state<ReadonlySet<number>>(new Set());
  const managedList = $derived(managingList === null ? undefined : ($mail.lists ?? []).find((list) => list.listID === managingList));
  const shownMembers = $derived(mailingListMembersShown(listMembers, shownFilter, shownSearch, personName));
  /** PageMembers (223 to 236): pages of fifty, none where no member is shown, as the window counts them. */
  const memberPages = $derived(Math.ceil(shownMembers.length / MAILING_LIST_MEMBERS_PER_PAGE));
  const pageOfMembers = $derived(shownMembers.slice(memberPage * MAILING_LIST_MEMBERS_PER_PAGE, (memberPage + 1) * MAILING_LIST_MEMBERS_PER_PAGE));

  /**
   * Open Mailing List Management (MaillistSetupWindow.ApplyAttributes, 54 to 77): the Access panel, built first,
   * asks the settings three times (its two choices, 378 and 389, and its lists, 437); then the Members tab, the one
   * selected, asks the members (Load, 522 to 524).
   */
  function openListManagement(listID: number): void {
    managingList = listID;
    listSettings = null;
    listMembers = [];
    memberFilter = "all";
    memberSearch = "";
    memberAction = "member";
    manageTab = "members";
    entityText = "";
    entityPick = null;
    accessNote = "";
    chosenAccess = new Set();
    // The Welcome Mail panel, built as the window opens: its box as last left for the list (463), its fields empty.
    welcomeLoaded = false;
    welcomeSubject = "";
    welcomeBody = "";
    welcomeNote = "";
    welcomeToAllChecked = flow.welcomeToAll(listID);
    void run(async () => {
      // The Access tab's two choices are built from the first two asks (378, 389) and are not built again.
      const first = await flow.readMailingListSettings(listID);
      accessChoice = first?.defaultAccess ?? MAILING_LIST_BLOCKED;
      const second = await flow.readMailingListSettings(listID);
      roleChoice = second?.defaultMemberAccess ?? MAILING_LIST_MEMBER_DEFAULT;
      listSettings = await flow.readMailingListSettings(listID);
      await updateMembers();
    });
  }

  /** UpdateMembersScroll (166 to 174): the members asked again and shown by the choice and search as they stand, from the first page. */
  async function updateMembers(): Promise<void> {
    const listID = managingList;
    if (listID === null) {
      return;
    }
    const members = await flow.readMailingListMembers(listID);
    if (managingList !== listID) {
      return;
    }
    listMembers = members;
    shownFilter = memberFilter;
    shownSearch = memberSearch;
    memberPage = 0;
    chosenMembers = new Set();
  }

  /** OnShowMembersComboChanged (138 to 146): a choice other than by name asks the members again; by name waits for its search. */
  function chooseMemberFilter(filter: MailingListMemberFilter): void {
    memberFilter = filter;
    if (filter !== "byName") {
      void run(updateMembers);
    }
  }

  /** ChangeMembersPage (148 to 164): another page, nothing chosen on it. */
  function turnMemberPage(change: number): void {
    memberPage += change;
    chosenMembers = new Set();
  }

  function chooseMember(characterID: number, chosen: boolean): void {
    const next = new Set(chosenMembers);
    if (chosen) {
      next.add(characterID);
    } else {
      next.delete(characterID);
    }
    chosenMembers = next;
  }

  /**
   * ApplyActionToMembers (266 to 293): the members chosen, in the order shown. The pilot made a member or muted is
   * asked to be sure of first, and the window put away after; a kick asks the settings again
   * (UpdateAccessScrollData, 435 to 451) before the members; anything else asks the members again.
   */
  function applyToMembers(): void {
    const listID = managingList;
    if (listID === null) {
      return;
    }
    const chosen = pageOfMembers.filter((member) => chosenMembers.has(member.characterID)).map((member) => member.characterID);
    const action = memberAction;
    const me = $station.online?.characterID ?? 0;
    const write = async (closing: boolean): Promise<void> => {
      if (!(await flow.setMailingListMembers(listID, chosen, action))) {
        return;
      }
      if (action === "kick") {
        await rereadAccess(listID);
      }
      if (closing) {
        managingList = null;
        return;
      }
      await updateMembers();
    };
    if ((action === "member" || action === "muted") && chosen.includes(me)) {
      ask({ dialog: action === "member" ? "MailingListMemberSelfConfirm" : "MailingListMuteSelfConfirm", args: {}, act: () => write(true) });
      return;
    }
    void run(() => write(false));
  }

  /** The Access tab's words, by their labels (StartupAccessPanel, 370 to 425; searchOld.py SearchOwners; listwindow.py). */
  const ACCESS_WORDS = {
    tab: "UI/EVEMail/MailingLists/AccessTab",
    defaultAccess: "UI/EVEMail/MailingLists/DefaultAccessLabel",
    private: "UI/EVEMail/MailingLists/PrivateAccess",
    public: "UI/EVEMail/MailingLists/PublicAccess",
    apply: "UI/Common/Buttons/Apply",
    defaultRole: "UI/EVEMail/MailingLists/DefaultMemberRole",
    normal: "UI/EVEMail/MailingLists/Normal",
    mutedRole: "UI/EVEMail/MailingLists/MutedRole",
    entity: "UI/EVEMail/MailingLists/EntitySearchLabel",
    allow: "UI/EVEMail/MailingLists/Allow",
    block: "UI/PeopleAndPlaces/BlockContact",
    blocked: "UI/EVEMail/MailingLists/BlockedLabel",
    allowed: "UI/EVEMail/MailingLists/AllowedLabel",
    remove: "UI/EVEMail/MailingLists/RemoveSelected",
    type: "UI/Common/Type",
    character: "UI/Common/Character",
    characters: "UI/Common/Characters",
    corporation: "UI/Common/Corporation",
    corporations: "UI/Common/Corporations",
    alliance: "UI/Common/Alliance",
    alliances: "UI/Common/Alliances",
    tooLong: "UI/Common/SearchStringTooLong",
    noneFound: "UI/Search/NoGroupFoundWith",
    select: "UI/Search/GenericSelection",
    found: "UI/Search/ManyGroupsFoundWith",
    ok: "UI/Common/Buttons/OK",
    cancel: "UI/Common/Buttons/Cancel",
    mustSelect: "UI/Control/ListWindow/MustSelectError",
  } as const;
  /**
   * SearchOwners' groups for the window (ALLOWED_GROUP_IDS: character 1, corporation 2, alliance 32), each with its
   * word and its plural, in the order the client's dict of them gives them (asked of its own Python: 32, 1, 2).
   */
  const OWNER_GROUPS: readonly (readonly [number, string, string, string, string])[] = [
    [32, ACCESS_WORDS.alliance, "Alliance", ACCESS_WORDS.alliances, "Alliances"],
    [1, ACCESS_WORDS.character, "Character", ACCESS_WORDS.characters, "Characters"],
    [2, ACCESS_WORDS.corporation, "Corporation", ACCESS_WORDS.corporations, "Corporations"],
  ];

  /** An entry of the Access tab's lists: an owner, and whether it is let in or kept out. */
  interface AccessRow {
    readonly ownerID: number;
    readonly access: number;
  }

  /** The window's tab shown (the client remembers its last; the page opens on Members). */
  let manageTab = $state<"members" | "access" | "welcome">("members");
  /** The Access tab's two choices, as the window built them and as changed since. */
  let accessChoice = $state<number>(MAILING_LIST_BLOCKED);
  let roleChoice = $state<number>(MAILING_LIST_MEMBER_DEFAULT);
  /** What is typed to search for, a search's owners offered to pick from and the one picked, the rows chosen, and what was said. */
  let entityText = $state("");
  let entityPick = $state<{ readonly access: number; readonly searchTerm: string; readonly owners: readonly OwnerMatch[] } | null>(null);
  let pickedOwner = $state<number | null>(null);
  let pickNote = $state("");
  let chosenAccess = $state<ReadonlySet<number>>(new Set());
  let accessNote = $state("");
  /** UpdateAccessScrollData (435 to 451): the settings' access in the order the client's dict gives it, blocked and allowed apart. */
  const accessRows = $derived(
    listSettings === null ? [] : pyIntDictOrder([...listSettings.access.keys()]).map((ownerID) => ({ ownerID, access: listSettings?.access.get(ownerID) ?? MAILING_LIST_BLOCKED })),
  );
  const blockedRows = $derived(accessRows.filter((row) => row.access === MAILING_LIST_BLOCKED));
  const allowedRows = $derived(accessRows.filter((row) => row.access === MAILING_LIST_ALLOWED));

  /**
   * A tab chosen (Load, 522 to 530): Members asks the members again; Access asks nothing; Welcome Mail asks the
   * welcome mail until one is had.
   */
  function chooseManageTab(tab: "members" | "access" | "welcome"): void {
    manageTab = tab;
    const listID = managingList;
    if (tab === "members") {
      void run(updateMembers);
    } else if (tab === "welcome" && !welcomeLoaded && listID !== null) {
      void run(() => updateWelcome(listID));
    }
  }

  /** The Welcome Mail tab's words, by their labels (StartupWelcomePanel, 462 to 474). */
  const WELCOME_WORDS = {
    tab: "UI/EVEMail/MailingLists/WelcomeMailTab",
    toAll: "UI/EVEMail/MailingLists/SendWelcomeMailToAllCheckbox",
    subject: "UI/EVEMail/MailingLists/WelcomeMailSubject",
    save: "UI/Common/Buttons/Save",
  } as const;

  /** Whether a welcome mail was had (the window's welcomeText), its subject and its mail as shown, the box, and what was said. */
  let welcomeLoaded = $state(false);
  let welcomeSubject = $state("");
  let welcomeBody = $state("");
  let welcomeToAllChecked = $state(false);
  let welcomeNote = $state("");

  /** UpdateWelcome (482 to 492): none, the fields emptied; one, its subject and its mail shown, and not asked again. */
  async function updateWelcome(listID: number): Promise<void> {
    const welcome = await flow.readMailingListWelcome(listID);
    if (managingList !== listID) {
      return;
    }
    if (welcome === null) {
      welcomeSubject = "";
      welcomeBody = "";
      return;
    }
    welcomeLoaded = true;
    welcomeSubject = welcome.title;
    welcomeBody = mailBodyLines(welcome.body).map((line) => line.map((run) => run.text).join("")).join("\n");
  }

  /** OnCheckboxChange (476 to 480): the box kept for the list. */
  function tickWelcomeToAll(checked: boolean): void {
    welcomeToAllChecked = checked;
    if (managingList !== null) {
      flow.keepWelcomeToAll(managingList, checked);
    }
  }

  /**
   * SaveWelcomeMail (494 to 507): a subject and a mail both empty clear the welcome mail; a mail with no subject is
   * refused (NoSubject); else it is saved, and sent to every member as it is when the box is ticked. Nothing is asked
   * after.
   */
  function saveWelcome(): void {
    const listID = managingList;
    if (listID === null) {
      return;
    }
    welcomeNote = "";
    const subject = welcomeSubject;
    const body = mailMarkupOfTyped(welcomeBody);
    if (subject.length < 1 && body.length < 1) {
      void run(async () => {
        await flow.clearMailingListWelcome(listID);
      });
      return;
    }
    if (subject.length < 1) {
      welcomeNote = filledWord("dialog:NoSubject/body", "A mail needs a subject.", {});
      return;
    }
    const toAll = welcomeToAllChecked;
    void run(async () => {
      await flow.saveMailingListWelcome(listID, subject, body, toAll);
    });
  }

  /** The settings asked again (UpdateAccessScrollData), its lists drawn afresh with nothing chosen. */
  async function rereadAccess(listID: number): Promise<void> {
    listSettings = await flow.readMailingListSettings(listID);
    chosenAccess = new Set();
  }

  /** An owner by name, as the access lists name it. */
  function ownerLabel(ownerID: number): string {
    return resolvedName($names.resolved, "owner", ownerID, "someone");
  }

  /** The search's groups, by their words or their plurals, joined as SearchOwners joins them. */
  function ownerGroupNames(plural: boolean): string {
    return OWNER_GROUPS.map(([, label, own, labels, owns]) => (plural ? word(labels, owns) : word(label, own))).join("/");
  }

  /** ApplySettings (453 to 457): SetDefaultAccess with the two choices and no cost; nothing asked again. */
  function applyAccessDefaults(): void {
    const listID = managingList;
    if (listID === null) {
      return;
    }
    void run(async () => {
      await flow.setMailingListDefaults(listID, accessChoice, roleChoice);
    });
  }

  /**
   * AddToAllowed and AddToBlocked (313 to 326) by SearchOwners (searchOld.py 216 to 279), with hideNPC and
   * notifyOneMatch: what is typed, its % and ? taken out; nothing refused (LookupStringMinimum), a hundred or more
   * refused (SearchStringTooLong); else LookupPCOwners, the characters, corporations and alliances kept, none said so
   * (NoGroupFoundWith), and those found offered to pick from even when one is (ListWindow, ordered: by what each is
   * shown as).
   */
  function searchEntity(access: number): void {
    const listID = managingList;
    if (listID === null) {
      return;
    }
    accessNote = "";
    const text = entityText.replace(/%/g, "").replace(/\?/g, "");
    if (text.length < 1) {
      accessNote = filledWord("dialog:LookupStringMinimum/body", "Type {minimum} or more characters.", { minimum: "1" });
      return;
    }
    if (text.length >= 100) {
      accessNote = word(ACCESS_WORDS.tooLong, "That search runs too long.");
      return;
    }
    void run(async () => {
      const kept = new Set(OWNER_GROUPS.map(([groupID]) => groupID));
      const owners = (await flow.lookupPlayerOwners(text)).filter((owner) => kept.has(owner.groupID));
      if (owners.length === 0) {
        accessNote = filledWord(ACCESS_WORDS.noneFound, "No {groupName} has a name starting \"{searchTerm}\".", { groupName: ownerGroupNames(false), searchTerm: text });
        return;
      }
      const sorted = [...owners].sort((left, right) => {
        const x = pickLabel(left).toLowerCase();
        const y = pickLabel(right).toLowerCase();
        return x < y ? -1 : x === y ? 0 : 1;
      });
      entityPick = { access, searchTerm: text, owners: sorted };
      pickedOwner = null;
      pickNote = "";
    });
  }

  /** How the pick list shows an owner: its name and its group's word (searchOld.py 264). */
  function pickLabel(owner: OwnerMatch): string {
    const group = OWNER_GROUPS.find(([groupID]) => groupID === owner.groupID);
    return group === undefined ? owner.ownerName : `${owner.ownerName} ${word(group[1], group[2])}`;
  }

  /** The pick list's OK (listwindow.py Confirm): one must be picked (MustSelectError); then its access set, and the settings asked again. */
  function pickConfirmed(): void {
    const listID = managingList;
    const pick = entityPick;
    if (listID === null || pick === null) {
      return;
    }
    const ownerID = pickedOwner;
    if (ownerID === null) {
      pickNote = filledWord(ACCESS_WORDS.mustSelect, "Choose {num}.", { num: "1" });
      return;
    }
    entityPick = null;
    void run(async () => {
      if (await flow.setMailingListAccess(listID, ownerID, pick.access)) {
        await rereadAccess(listID);
      }
    });
  }

  function chooseAccess(ownerID: number, chosen: boolean): void {
    const next = new Set(chosenAccess);
    if (chosen) {
      next.add(ownerID);
    } else {
      next.delete(ownerID);
    }
    chosenAccess = next;
  }

  /**
   * ClearAccessForSelected (302 to 311): the blocked chosen and then the allowed, each cleared in turn, then the
   * settings asked again; none chosen refused (PICKERRORNOTIFY).
   */
  function removeChosenAccess(): void {
    const listID = managingList;
    if (listID === null) {
      return;
    }
    accessNote = "";
    const chosen = [...blockedRows, ...allowedRows].filter((row) => chosenAccess.has(row.ownerID)).map((row) => row.ownerID);
    if (chosen.length === 0) {
      accessNote = filledWord("dialog:PICKERRORNOTIFY/body", "Choose {num} or more.", { num: "1" }).trim();
      return;
    }
    void run(async () => {
      for (const ownerID of chosen) {
        if (!(await flow.clearMailingListAccess(listID, ownerID))) {
          return;
        }
      }
      await rereadAccess(listID);
    });
  }

  /** The mail list's words, by their labels (LoadMails 640 to 645; RefreshMsgScrollHeaders; MailEntry; GetAllLabels). */
  const LIST_WORDS = {
    status: "UI/Mail/Status",
    sender: "UI/Mail/Sender",
    recipient: "UI/Mail/Recipient",
    subject: "UI/Mail/Subject",
    received: "UI/Mail/Received",
    dateSent: "UI/Mail/DateSent",
    labels: "UI/Mail/Labels",
    unread: "UI/Mail/Unread",
    read: "UI/Mail/Read",
    replied: "UI/Mail/Replied",
    forwarded: "UI/Mail/Forwarded",
    multiple: "UI/Mail/Multiple",
    noMails: "UI/Mail/NoMailsFound",
    previous: "UI/Common/Previous",
    next: "UI/Common/Next",
    labelAlliance: "UI/Mail/LabelAlliance",
    labelCorp: "UI/Mail/LabelCorp",
    labelInbox: "UI/Mail/LabelInbox",
    labelSent: "UI/Mail/LabelSent",
  } as const;
  /** The window's four labels by their words, as the Labels column names them (GetAllLabels, mailSvc.py 681 to 710). */
  const fourLabelNames = $derived(
    new Map<number, string>([
      [MAIL_FOLDER_ALLIANCE, word(LIST_WORDS.labelAlliance, "[Alliance]")],
      [MAIL_FOLDER_CORPORATION, word(LIST_WORDS.labelCorp, "[Corp]")],
      [MAIL_FOLDER_INBOX, word(LIST_WORDS.labelInbox, "Inbox")],
      [MAIL_FOLDER_SENT, word(LIST_WORDS.labelSent, "Sent")],
    ]),
  );

  /** A mail's Status as the window writes it (MailEntry.LoadMailEntry: its icon's hint). */
  function stateWord(messageID: number): string {
    const state = mailRowState(statusByID.get(messageID));
    return state === "unread" ? word(LIST_WORDS.unread, "Unread") : state === "replied" ? word(LIST_WORDS.replied, "Replied") : state === "forwarded" ? word(LIST_WORDS.forwarded, "Forwarded") : word(LIST_WORDS.read, "Read");
  }

  /** A mail's name column (GetMsgEntry, 678 to 681): its sender, or in the Sent folder its recipient (GetRecipient). */
  function nameCell(header: MailHeaderRow): string {
    if (!inSent) {
      return senderName(header);
    }
    const recipient = mailRecipientOf(header);
    switch (recipient.kind) {
      case "multiple":
        return word(LIST_WORDS.multiple, "[Multiple]");
      case "character":
        return personName(recipient.id);
      case "corporation":
        return ownerName(recipient.id);
      case "list":
        return listName(recipient.listID) ?? "a mailing list";
      default:
        return "";
    }
  }

  /** A mail's Labels column (GetLabelText): its labels by name, each in its colour, joined by commas. */
  function labelParts(header: MailHeaderRow): readonly { readonly name: string; readonly color: string | null }[] {
    return mailLabelParts(statusByID.get(header.messageID)?.labelMask ?? 0, $mail.labels ?? [], fourLabelNames)
      .map((part) => ({ name: part.name, color: labelSwatch(part.color) }));
  }

  /** FmtDate(sentDate, 'ls'), as the list writes a mail's date (GetMsgEntry, 677). */
  function dateText(sentDate: bigint | null): string {
    if (sentDate === null) {
      return "";
    }
    const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, kind, id, "");
    return plainText(formatTemplate(word(DATE_LABEL, "{[datetime]datetime}"), { datetime: String(sentDate) }, { nameOf }));
  }

  /** A folder shown, from its first page (the window's startPos 0). */
  function showFolder(id: number | null): void {
    folder = id;
    viewingList = null;
    mailPage = 0;
    nameSentLists();
  }

  /** A mailing list's mails shown, from their first page (LoadMailinglistMails, evemail.py 529 to 534). */
  function showList(listID: number): void {
    viewingList = listID;
    mailPage = 0;
  }

  /** BrowseMail: the page before or after. */
  function turnMailPage(change: number): void {
    mailPage = pageShown + change;
    nameSentLists();
  }

  /**
   * A header clicked (the scroll's ChangeSortBy, carbonui/control/scroll.py 966 to 992; SortMail, evemail.py 910 to
   * 923): the header sorted by again reverses the order, another sorts by it not reversed; kept; from the first page.
   * Labels sorts nothing.
   */
  function sortMail(by: MailSortKey): void {
    const reversed = by === sortBy ? !sortReversed : false;
    sortBy = by;
    sortReversed = reversed;
    flow.keepMailSort(by, reversed);
    mailPage = 0;
    nameSentLists();
  }

  /** A sortable header's words: Sender and Received read Recipient and Date Sent in the Sent folder. */
  function headerText(key: MailSortKey): string {
    switch (key) {
      case "status":
        return word(LIST_WORDS.status, "Status");
      case "sender":
        return inSent ? word(LIST_WORDS.recipient, "Recipient") : word(LIST_WORDS.sender, "Sender");
      case "subject":
        return word(LIST_WORDS.subject, "Subject");
      default:
        return inSent ? word(LIST_WORDS.dateSent, "Date Sent") : word(LIST_WORDS.received, "Received");
    }
  }

  /**
   * The Sent folder's page drawn (GetMsgEntry, 678 to 679): a list that is a mail's one recipient named, asked where
   * not known (GetDisplayName); sorted by Recipient, every sent mail's (PrepareOrder's GetRecipient, mailSvc.py 584).
   */
  function nameSentLists(): void {
    if (!inSent) {
      return;
    }
    const unnamed = [...new Set((sortBy === "sender" ? sortedMessages : pageMessages).flatMap((header) => {
      const recipient = mailRecipientOf(header);
      return recipient.kind === "list" && listName(recipient.listID) === null ? [recipient.listID] : [];
    }))];
    if (unnamed.length > 0) {
      void run(async () => {
        for (const listID of unnamed) {
          await flow.nameMailingList(listID);
        }
      });
    }
  }

  onMount(() => {
    flow.requestWords([
      ...Object.values(MAIL_QUOTE_LABELS), DATE_LABEL, NOTIFICATIONS_TAB, ...Object.values(FOLDER_WORDS), ...Object.values(WRITE_WORDS), ...Object.values(FOLDER_WRITE_WORDS),
      ...FOLDER_DIALOGS.flatMap((dialog) => [`dialog:${dialog}/title`, `dialog:${dialog}/body`, suppressableKey(dialog)]),
      DO_NOT_ASK_AGAIN_LABEL,
      ...Object.values(LABEL_WORDS),
      ...LABEL_DIALOGS.flatMap((dialog) => [`dialog:${dialog}/title`, `dialog:${dialog}/body`]),
      ...Object.values(MANAGE_WORDS),
      ...MANAGE_DIALOGS.flatMap((dialog) => [`dialog:${dialog}/title`, `dialog:${dialog}/body`]),
      ...Object.values(ACCESS_WORDS),
      ...Object.keys(LINK_WORDS),
      "dialog:PICKERRORNOTIFY/title",
      "dialog:PICKERRORNOTIFY/body",
      ...Object.values(WELCOME_WORDS),
      ...Object.values(LIST_WORDS),
      ...Object.values(COMPOSE_WORDS),
      ...COMPOSE_DIALOGS.flatMap((dialog) => [`dialog:${dialog}/title`, `dialog:${dialog}/body`]),
      "dialog:NoSubject/title",
      "dialog:NoSubject/body",
      "dialog:MailingListNoSuchList/title",
      "dialog:MailingListNoSuchList/body",
    ]);
    void run(async () => {
      await flow.loadMail();
      await flow.loadMailLabels();
      await flow.loadMailingLists();
    });
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Mail</h2>
    <!-- ⚠ THE COUNT LEAVES THE TITLE RATHER THAN GOING WITH IT. A host that
         already says MAIL clips the title, and the unread badge was INSIDE it —
         so the one fact on this strip that changes would have been hidden by
         the rule that hides the word it sat next to. -->
    {#if $mail.unreadCount > 0}
      <p class="stat-line"><span class="badge accent">{$mail.unreadCount} unread</span></p>
    {/if}
    <p class="controls">
      <button type="button" class="primary" disabled={busy} onclick={() => void run(() => flow.refreshMail())}>
        Check for new mail
      </button>
    </p>
  </header>

  {#if error}
    <p class="error">{error}</p>
  {/if}
  <!-- (A refusal the client's own dialog said is not said again here: ClientDialogs.svelte.) -->
  {#if $mail.actionError && !$mail.actionErrorSaid}
    <p class="error">{$mail.actionError}</p>
  {/if}
  {#if $mail.inboxError}
    <p class="error">Your mail could not be loaded just now.</p>
  {/if}

  {#if $mail.lastOutcome}
    {#if $mail.lastOutcome.applied}
      <p class="note">
        Your message was sent to {sentTo($mail.lastOutcome.recipientCount, $mail.lastOutcome.toList ?? null, $mail.lastOutcome.toCorpOrAlliance ?? null)}.
      </p>
    {:else if $mail.lastOutcome.declinedSilently}
      <!-- ⚠ SendMail answers a bare null with no reason. Say exactly that. -->
      <p class="error">
        {$mail.lastOutcome.message ??
          "The server did not send that message, and did not say why."}
      </p>
    {/if}
  {/if}

  {#if retail}
  <nav class="tabs mail-head-tabs">
    <button type="button" class:active={tab !== "notifications"} onclick={() => (tab = "inbox")}>{plainText(word("Tooltips/Neocom/Mail", "Mail"))}</button>
    <button type="button" class:active={tab === "notifications"} onclick={() => (tab = "notifications")}>{plainText(word(NOTIFICATIONS_TAB, "Notifications"))}</button>
    {#if tab !== "notifications"}<button type="button" class="mail-compose" onclick={() => (tab = tab === "compose" ? "inbox" : "compose")}>{tab === "compose" ? plainText(word("UI/Mail/EveMail", "Mail")) : plainText(word("UI/Mail/Compose", "Compose"))}</button>{/if}
  </nav>
  {:else}
  <nav class="tabs">
    <button type="button" class:active={tab === "inbox"} onclick={() => (tab = "inbox")}>
      Inbox
    </button>
    <button type="button" class:active={tab === "compose"} onclick={() => (tab = "compose")}>
      Write a message
    </button>
    <!-- The mail window's second tab (evemail.py ConstructTabGroup, 100 to 104): the notifications. -->
    <button type="button" class:active={tab === "notifications"} onclick={() => (tab = "notifications")}>
      {plainText(word(NOTIFICATIONS_TAB, "Notifications"))}
    </button>
  </nav>
  {/if}

  {#if tab === "notifications"}
    <MailNotifications {store} {flow} />
  {/if}

  {#if tab === "inbox"}
    <!-- The labels window (evemail.py ManageLabelsBase): a new label by name, and each of the pilot's own renamed or deleted. -->
    <p class="controls">
      <button type="button" class="minor" onclick={() => (managingLabels = !managingLabels)}>{word(LABEL_WORDS.manage, "Manage Labels")}</button>
      <!-- The mail window's Add Mailing List (evemail.py 237): MailinglistWnd, a name, Join or Create. -->
      <button type="button" class="minor" onclick={() => (addingList = !addingList)}>{word(FOLDER_WORDS.addList, "Add a list")}</button>
    </p>
    {#if addingList}
      <section class="bulk mail-add-list">
        <h3>{word(FOLDER_WORDS.createOrJoin, "Make or join a list")}</h3>
        <p class="controls">
          <label>
            {word(FOLDER_WORDS.listName, "List name")}
            <input type="text" maxlength={MAILING_LIST_NAME_MAX} bind:value={listNameInput} />
          </label>
          <button type="button" disabled={busy} onclick={() => addList(false)}>{word(FOLDER_WORDS.join, "Join")}</button>
          <button type="button" class="minor" disabled={busy} onclick={() => addList(true)}>{word(FOLDER_WORDS.create, "Create")}</button>
        </p>
      </section>
    {/if}
    {#if labelNote !== ""}
      <p class="note">{labelNote}</p>
    {/if}
    {#if managingLabels}
      <section class="bulk mail-labels">
        <h3>{word(LABEL_WORDS.manage, "Manage Labels")}</h3>
        <p class="controls">
          <label>
            {word(LABEL_WORDS.name, "Label Name")}
            <input type="text" maxlength={MAIL_LABEL_MAX} bind:value={newLabelName} />
          </label>
          <button type="button" disabled={busy} onclick={createLabel}>{word(LABEL_WORDS.create, "Create")}</button>
        </p>
        <ul class="mail-label-list">
          <!-- GetAllLabels(assignable=1) (mailSvc.py 681 to 710): the inbox, the corporation's and the alliance's, by their
               numbers first, Assign Color alone their menu (ManageLabelsBase.GetLabelMenu, 1632 to 1645). -->
          {#each assignableLabels.filter((label) => isSystemMailLabel(label.labelID)) as label (label.labelID)}
            <li>
              {label.name}
              <button type="button" class="minor" disabled={busy} aria-expanded={colorFor !== null && colorFor.labelID === label.labelID && colorFor.where === "manage"} onclick={() => openColorWindow(label.labelID, "manage")}>{word(LABEL_WORDS.assignColor, "Colour")}</button>
            </li>
          {/each}
          {#each ownLabels as label (label.labelID)}
            <li>
              {label.name}
              <button type="button" class="minor" disabled={busy} aria-expanded={colorFor !== null && colorFor.labelID === label.labelID && colorFor.where === "manage"} onclick={() => openColorWindow(label.labelID, "manage")}>{word(LABEL_WORDS.assignColor, "Colour")}</button>
              <button type="button" class="minor" disabled={busy} onclick={() => (renaming = { labelID: label.labelID, name: label.name })}>{word(LABEL_WORDS.rename, "Rename")}</button>
              <button type="button" class="minor" disabled={busy} onclick={() => (ask({ dialog: "DeleteMailLabel", args: { labelName: label.name }, act: () => flow.deleteMailLabel(label.labelID) }))}>{word(LABEL_WORDS.delete, "Delete")}</button>
            </li>
          {/each}
        </ul>
      {#if colorFor !== null && colorFor.where === "manage"}
        {@render colorWindow()}
      {/if}
        {#if renaming !== null}
          <p class="controls">
            <label>
              {word(LABEL_WORDS.typeNew, "Name the new label.")}
              <input type="text" maxlength={MAIL_LABEL_MAX} bind:value={renaming.name} />
            </label>
            <button type="button" disabled={busy} onclick={renameLabel}>{word(LABEL_WORDS.ok, "OK")}</button>
            <button type="button" class="minor" onclick={() => (renaming = null)}>{word(LABEL_WORDS.cancel, "Cancel")}</button>
          </p>
        {/if}
      </section>
    {/if}
    {#if managingList !== null}
      <!-- The list's management window (evemailingListConfig.py MaillistSetupWindow): its Members, Access and Welcome
           Mail tabs. -->
      <section class="bulk mail-list-management">
        <h3>{filledWord(MANAGE_WORDS.caption, "Managing {mailinglistName}", { mailinglistName: managedList?.displayName ?? "" })}</h3>
        <p class="controls">
          <button type="button" class:active={manageTab === "members"} disabled={busy} onclick={() => chooseManageTab("members")}>{word(MANAGE_WORDS.membersTab, "Members")}</button>
          <button type="button" class:active={manageTab === "access"} disabled={busy} onclick={() => chooseManageTab("access")}>{word(ACCESS_WORDS.tab, "Access")}</button>
          <button type="button" class:active={manageTab === "welcome"} disabled={busy} onclick={() => chooseManageTab("welcome")}>{word(WELCOME_WORDS.tab, "Welcome Mail")}</button>
          <button type="button" class="minor" onclick={() => (managingList = null)}>✕</button>
        </p>
        {#if manageTab === "members"}
        <p class="controls">
          <label>
            {word(MANAGE_WORDS.show, "Show")}
            <select value={memberFilter} disabled={busy} onchange={(event) => chooseMemberFilter(event.currentTarget.value as MailingListMemberFilter)}>
              {#each MEMBER_FILTERS as [filter, label, own] (filter)}
                <option value={filter}>{word(label, own)}</option>
              {/each}
            </select>
          </label>
          {#if memberFilter === "byName"}
            <label>
              {word(MANAGE_WORDS.searchString, "Search String")}
              <input type="search" bind:value={memberSearch} onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); void run(updateMembers); } }} />
            </label>
            <button type="button" disabled={busy} onclick={() => void run(updateMembers)}>{word(MANAGE_WORDS.search, "Search")}</button>
          {/if}
          <button type="button" class="minor" disabled={busy || memberPages <= 1 || memberPage === 0} onclick={() => turnMemberPage(-1)}>{word(MANAGE_WORDS.previous, "Previous")}</button>
          <span>{memberPage + 1} / {memberPages}</span>
          <button type="button" class="minor" disabled={busy || memberPages <= 1 || memberPage >= memberPages - 1} onclick={() => turnMemberPage(1)}>{word(MANAGE_WORDS.next, "Next")}</button>
        </p>
        {#if pageOfMembers.length === 0}
          <p class="empty">{word(MANAGE_WORDS.none, "No member matches.")}</p>
        {:else}
          <div class="table-wrap overflow-x-auto">
            <table class="guests reflow">
              <thead>
                <tr>
                  <th></th>
                  <th>{word(MANAGE_WORDS.name, "Name")}</th>
                  <th>{word(MANAGE_WORDS.role, "Role")}</th>
                </tr>
              </thead>
              <tbody>
                {#each pageOfMembers as member (member.characterID)}
                  {@const role = ROLE_WORDS[member.access]}
                  <tr>
                    <td data-label=""><input type="checkbox" aria-label={personName(member.characterID)} checked={chosenMembers.has(member.characterID)} disabled={busy} onchange={(event) => chooseMember(member.characterID, event.currentTarget.checked)} /></td>
                    <td data-label={word(MANAGE_WORDS.name, "Name")}>{personName(member.characterID)}</td>
                    <td data-label={word(MANAGE_WORDS.role, "Role")}>{role === undefined ? "" : word(role[0], role[1])}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        <p class="controls">
          <label>
            {word(MANAGE_WORDS.applyTo, "Apply to those chosen")}
            <select bind:value={memberAction} disabled={busy}>
              {#each MEMBER_ACTIONS as [action, label, own] (action)}
                <option value={action}>{word(label, own)}</option>
              {/each}
            </select>
          </label>
          <button type="button" disabled={busy || chosenMembers.size === 0} onclick={applyToMembers}>{word(MANAGE_WORDS.apply, "Apply")}</button>
        </p>
        {:else if manageTab === "access"}
          <!-- The Access tab (StartupAccessPanel, 370 to 425): who may join and as what, with Apply; a character,
               corporation or alliance blocked or allowed by a search; the blocked and the allowed; Remove Selected. -->
          <p class="controls">
            <label>
              {word(ACCESS_WORDS.defaultAccess, "Who may join")}
              <select bind:value={accessChoice} disabled={busy}>
                <option value={MAILING_LIST_BLOCKED}>{word(ACCESS_WORDS.private, "Private: those let in")}</option>
                <option value={MAILING_LIST_ALLOWED}>{word(ACCESS_WORDS.public, "Public: anyone")}</option>
              </select>
            </label>
            <label>
              {word(ACCESS_WORDS.defaultRole, "A new member's role")}
              <select bind:value={roleChoice} disabled={busy}>
                <option value={MAILING_LIST_MEMBER_DEFAULT}>{word(ACCESS_WORDS.normal, "Normal")}</option>
                <option value={MAILING_LIST_MEMBER_MUTED}>{word(ACCESS_WORDS.mutedRole, "Muted")}</option>
              </select>
            </label>
            <button type="button" disabled={busy} onclick={applyAccessDefaults}>{word(ACCESS_WORDS.apply, "Apply")}</button>
          </p>
          <p class="controls">
            <label>
              {word(ACCESS_WORDS.entity, "Character/Corp/Alliance")}
              <input type="text" bind:value={entityText} />
            </label>
            <button type="button" disabled={busy} onclick={() => searchEntity(MAILING_LIST_BLOCKED)}>{word(ACCESS_WORDS.block, "Block")}</button>
            <button type="button" disabled={busy} onclick={() => searchEntity(MAILING_LIST_ALLOWED)}>{word(ACCESS_WORDS.allow, "Allow")}</button>
          </p>
          {#if accessNote !== ""}
            <p class="note">{accessNote}</p>
          {/if}
          {#if entityPick !== null}
            <!-- The client's pick list (ListWindow.ShowList): its caption, its hint, the owners found, OK and Cancel. -->
            <div class="mail-confirm" role="dialog" aria-label={filledWord(ACCESS_WORDS.select, "Select {groupName}", { groupName: ownerGroupNames(false) })}>
              <strong>{filledWord(ACCESS_WORDS.select, "Select {groupName}", { groupName: ownerGroupNames(false) })}</strong>
              <p>{filledWord(ACCESS_WORDS.found, "{itemCount} {groupNames} were found with \"{searchTerm}\" in their name.", { itemCount: String(entityPick.owners.length), groupNames: ownerGroupNames(true), searchTerm: entityPick.searchTerm })}</p>
              <ul class="mail-label-list">
                {#each entityPick.owners as owner (owner.ownerID)}
                  <li>
                    <label>
                      <input type="radio" name="mail-owner-pick" checked={pickedOwner === owner.ownerID} onchange={() => (pickedOwner = owner.ownerID)} />
                      {pickLabel(owner)}
                    </label>
                  </li>
                {/each}
              </ul>
              {#if pickNote !== ""}
                <p class="error">{pickNote}</p>
              {/if}
              <p class="controls">
                <button type="button" disabled={busy} onclick={pickConfirmed}>{word(ACCESS_WORDS.ok, "OK")}</button>
                <button type="button" class="minor" onclick={() => (entityPick = null)}>{word(ACCESS_WORDS.cancel, "Cancel")}</button>
              </p>
            </div>
          {/if}
          {#snippet accessList(title: string, rows: readonly AccessRow[])}
            <h4>{title}</h4>
            <div class="table-wrap overflow-x-auto">
              <table class="guests reflow">
                <thead>
                  <tr>
                    <th></th>
                    <th>{word(MANAGE_WORDS.name, "Name")}</th>
                    <th>{word(ACCESS_WORDS.type, "Type")}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each rows as row (row.ownerID)}
                    <tr>
                      <td data-label=""><input type="checkbox" aria-label={ownerLabel(row.ownerID)} checked={chosenAccess.has(row.ownerID)} disabled={busy} onchange={(event) => chooseAccess(row.ownerID, event.currentTarget.checked)} /></td>
                      <td data-label={word(MANAGE_WORDS.name, "Name")}>{ownerLabel(row.ownerID)}</td>
                      <td data-label={word(ACCESS_WORDS.type, "Type")}>{resolvedName($names.resolved, "ownerGroup", row.ownerID, "")}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/snippet}
          {@render accessList(word(ACCESS_WORDS.blocked, "Blocked"), blockedRows)}
          {@render accessList(word(ACCESS_WORDS.allowed, "Allowed"), allowedRows)}
          <p class="controls">
            <button type="button" disabled={busy} onclick={removeChosenAccess}>{word(ACCESS_WORDS.remove, "Remove Selected")}</button>
          </p>
        {:else}
          <!-- The Welcome Mail tab (StartupWelcomePanel, 462 to 474): a subject, the mail, whether to send it to every
               member when it is saved, and Save. -->
          <p class="controls">
            <input type="text" class="grow" aria-label={word(WELCOME_WORDS.subject, "Subject")} placeholder={word(WELCOME_WORDS.subject, "Subject")} maxlength={MAIL_MAX_TITLE} bind:value={welcomeSubject} />
          </p>
          <p class="controls">
            <textarea class="grow" rows="8" maxlength={MAIL_MAX_TAGGED_BODY} bind:value={welcomeBody}></textarea>
          </p>
          <p class="controls">
            <label>
              <input type="checkbox" checked={welcomeToAllChecked} onchange={(event) => tickWelcomeToAll(event.currentTarget.checked)} />
              {word(WELCOME_WORDS.toAll, "On saving, mail the welcome to every member.")}
            </label>
          </p>
          {#if welcomeNote !== ""}
            <p class="note">{welcomeNote}</p>
          {/if}
          <p class="controls">
            <button type="button" disabled={busy} onclick={saveWelcome}>{word(WELCOME_WORDS.save, "Save")}</button>
          </p>
        {/if}
      </section>
    {/if}
    {#if confirming !== null}
      <!-- The client's dialog to be sure of it: its title, its question, yes and no. -->
      <div class="mail-confirm" role="alertdialog" aria-label={dialogText("title")}>
        <strong>{dialogText("title")}</strong>
        <p>{dialogText("body")}</p>
        {#if $words.templates[suppressableKey(confirming.dialog)] === "1"}
          <!-- The message box's checkbox (messagebox.py construct_suppress_checkbox), on a dialog the install lets keep its answer. -->
          <label class="dont-ask"><input type="checkbox" bind:checked={dontAskAgain} /> {plainText(word(DO_NOT_ASK_AGAIN_LABEL, "Skip this question from now on"))}</label>
        {/if}
        <p class="controls">
          <button type="button" disabled={busy} onclick={confirmed}>{word(FOLDER_WRITE_WORDS.yes, "Yes")}</button>
          <button type="button" class="minor" onclick={() => (confirming = null)}>{word(FOLDER_WRITE_WORDS.no, "No")}</button>
        </p>
      </div>
    {/if}
    {#if !$mail.loaded}
      <p class="note">Fetching your mail…</p>
    {:else}
      <!-- The window's folders, then the pilot's labels by name (evemail.py LoadLeftSide), whatever the mailbox holds. -->
      <div class="mail-split" class:on={retail}>
      <nav class="mail-folders">
        {#each SYSTEM_FOLDERS as [id, label, own] (label)}
          <button type="button" class:active={viewingList === null && folder === id} class:mail-bold={folderUnread(id) > 0} onclick={() => showFolder(id)}>
            {folderText(word(label, own), id)}
            {#if folderTag(id) !== null}<span class="mail-label-tag" style:background={folderTag(id)}></span>{/if}
          </button>
        {/each}
        {#if ownLabels.length > 0}
          <span class="mail-folders-group">{word(FOLDER_WORDS.labels, "Labels")}</span>
          {#each ownLabels as label (label.labelID)}
            <button type="button" class:active={viewingList === null && folder === label.labelID} class:mail-bold={folderUnread(label.labelID) > 0} onclick={() => showFolder(label.labelID)}>
              {folderText(label.name, label.labelID)}
              {#if folderTag(label.labelID) !== null}<span class="mail-label-tag" style:background={folderTag(label.labelID)}></span>{/if}
            </button>
          {/each}
        {/if}
        {#if joinedLists.length > 0}
          <span class="mail-folders-group">{word(FOLDER_WORDS.lists, "Mailing Lists")}</span>
          {#each joinedLists as list (list.listID)}
            {@const unread = listUnread.get(list.listID) ?? 0}
            <button type="button" class:active={viewingList === list.listID} class:mail-bold={unread > 0} onclick={() => showList(list.listID)}>
              {unread > 0 ? filledWord(FOLDER_WORDS.withCount, "{folderName} ({unreadCount})", { folderName: list.displayName, unreadCount: String(unread) }) : list.displayName}
            </button>
          {/each}
        {/if}
      </nav>
      <div class="mail-right">
      <!-- The folder's own writes (evemail.py StaticMenu), each asked to be sure of in the client's words. -->
      <p class="controls mail-folder-actions">
        {#if viewingList !== null}
          <!-- A list's own menu (evemail.py MaillistMenu 536 to 555), in its order: writing to it where the pilot is
               not muted; its mails read and trashed, each asked to be sure of; and Leave, or for its owner Delete,
               asked to be sure of. For an operator or owner, its management window (OpenMaillistSetup, 511). -->
          {@const shownList = ($mail.lists ?? []).find((each) => each.listID === viewingList)}
          {#if shownList !== undefined}
            <!-- (A {@const} is read again each time it is used: the list's number is taken at the click, before the
                 list shown is let go, or a write is sent without it, as Leave(None) was, seen 2026-10-14.) -->
            {@const listID = shownList.listID}
            {@const listName = shownList.displayName}
            {#if !shownList.isMuted}
              <button type="button" class="minor" disabled={busy} onclick={() => sendToList(listID)}>
                {word(FOLDER_WORDS.sendToList, "Mail the list")}
              </button>
            {/if}
            {#if shownList.isOperator || shownList.isOwner}
              <button type="button" class="minor" disabled={busy} onclick={() => openListManagement(listID)}>
                {word(MANAGE_WORDS.open, "Manage the list")}
              </button>
            {/if}
            <button type="button" class="minor" disabled={busy} onclick={() => { const id = listID; ask({ dialog: "EvemailMailReadMailinglistGroup", args: { listName }, act: () => flow.readListMail(id) }); }}>
              {filledWord(FOLDER_WRITE_WORDS.markAll, "Read all of {folderName}", { folderName: listName })}
            </button>
            <button type="button" class="minor" disabled={busy} onclick={() => { const id = listID; ask({ dialog: "EvemailMailTrashMailinglistGroup", args: { listName }, act: () => flow.trashListMail(id) }); }}>
              {filledWord(FOLDER_WRITE_WORDS.trashAll, "Trash all of {folderName}", { folderName: listName })}
            </button>
            {#if shownList.isOwner}
              <button type="button" class="minor" disabled={busy} onclick={() => { const id = listID; ask({ dialog: "DeleteMailingList", args: { mailinglistName: listName }, act: async () => { await flow.deleteMailingList(id); if (!(store.get().mail.lists ?? []).some((each) => each.listID === id)) viewingList = null; } }); }}>
                {word(FOLDER_WORDS.deleteList, "Delete the list")}
              </button>
            {:else}
              <button type="button" class="minor" disabled={busy} onclick={() => { const id = listID; viewingList = null; void run(() => flow.leaveMailingList(id)); }}>
                {word(FOLDER_WORDS.leaveList, "Leave the list")}
              </button>
            {/if}
          {/if}
        {:else if folder === MAIL_FOLDER_TRASH}
          <button type="button" class="minor" disabled={busy} onclick={() => (ask({ dialog: "EvemailMailRestoreAll", args: {}, act: () => flow.restoreAllMail() }))}>
            {word(FOLDER_WRITE_WORDS.restoreAll, "Restore All")}
          </button>
          <button type="button" class="minor" disabled={busy} onclick={() => (ask({ dialog: "EvemailMaillDeleteAll", args: {}, act: () => flow.emptyMailTrash() }))}>
            {word(FOLDER_WRITE_WORDS.emptyTrash, "Empty Trash")}
          </button>
        {:else if folder === null}
          <button type="button" class="minor" disabled={busy} onclick={() => (ask({ dialog: "EvemailMailMarkAllRead", args: {}, act: () => flow.readAllMail(null) }))}>
            {filledWord(FOLDER_WRITE_WORDS.markAll, "Read all of {folderName}", { folderName: word(FOLDER_WRITE_WORDS.all, "All") })}
          </button>
          <button type="button" class="minor" disabled={busy} onclick={() => (ask({ dialog: "EvemailMailTrashAll", args: {}, act: () => flow.trashAllMail(null) }))}>
            {filledWord(FOLDER_WRITE_WORDS.trashAll, "Trash all of {folderName}", { folderName: word(FOLDER_WRITE_WORDS.all, "All") })}
          </button>
        {:else}
          {@const labelID = folder}
          <button type="button" class="minor" disabled={busy} aria-expanded={colorFor !== null && colorFor.labelID === labelID && colorFor.where === "folders"} onclick={() => openColorWindow(labelID, "folders")}>
            {word(LABEL_WORDS.assignColor, "Colour")}
          </button>
          <button type="button" class="minor" disabled={busy} onclick={() => (ask({ dialog: "EvemailMailReadLabelGroup", args: { labelName: folderName }, act: () => flow.readAllMail(labelID) }))}>
            {filledWord(FOLDER_WRITE_WORDS.markAll, "Read all of {folderName}", { folderName })}
          </button>
          <button type="button" class="minor" disabled={busy} onclick={() => (ask({ dialog: "EvemailMailTrashLabelGroup", args: { labelName: folderName }, act: () => flow.trashAllMail(labelID) }))}>
            {filledWord(FOLDER_WRITE_WORDS.trashAll, "Trash all of {folderName}", { folderName })}
          </button>
        {/if}
      </p>
      {#if colorFor !== null && colorFor.where === "folders"}
        {@render colorWindow()}
      {/if}
      {#if shownMessages.length === 0}
        <p class="empty">{word(LIST_WORDS.noMails, "No mail here.")}</p>
      {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <!-- The window's columns (LoadMails, 640 to 645): Status, Sender (Recipient in the Sent folder), Subject,
               Received (Date Sent in the Sent folder), Labels; an unread mail in bold (MailEntry.UpdateLabel). -->
          <thead>
            <tr>
              <!-- Each header but Labels sorts the list by it (SortMail), its arrow where it is the one sorted by. -->
              {#each MAIL_SORT_KEYS as key (key)}
                <th aria-sort={sortBy === key ? (sortReversed ? "descending" : "ascending") : "none"}>
                  <button type="button" class="mail-sort" onclick={() => sortMail(key)}>{headerText(key)}{sortBy === key ? (sortReversed ? " ▼" : " ▲") : ""}</button>
                </th>
              {/each}
              <th>{word(LIST_WORDS.labels, "Labels")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each pageMessages as header (header.messageID)}
              <tr class:unread={isUnread(header.messageID)} class:mail-bold={isUnread(header.messageID)}>
                <td data-label={word(LIST_WORDS.status, "Status")}>{stateWord(header.messageID)}</td>
                <td data-label={inSent ? word(LIST_WORDS.recipient, "Recipient") : word(LIST_WORDS.sender, "Sender")}>{nameCell(header)}</td>
                <td data-label={word(LIST_WORDS.subject, "Subject")}>{header.title}</td>
                <td data-label={inSent ? word(LIST_WORDS.dateSent, "Date Sent") : word(LIST_WORDS.received, "Received")}>{dateText(header.sentDate)}</td>
                <td data-label={word(LIST_WORDS.labels, "Labels")}>{#each labelParts(header) as part, at (at)}{at > 0 ? ", " : ""}<span style:color={part.color}>{part.name}</span>{/each}</td>
                <td data-label="">
                  <div class="row-actions">
                    <button type="button" disabled={busy} onclick={() => open(header.messageID)}>
                      Read it
                    </button>
                    <button
                      type="button"
                      class="minor"
                      disabled={busy}
                      onclick={() => reply(header)}
                    >
                      Reply
                    </button>
                    <!-- The mail window's menu of a message (GetMsgMenu): read or not, and trash; restore and delete in the trash. -->
                    {#if isUnread(header.messageID)}
                      <button type="button" class="minor" disabled={busy} onclick={() => void run(() => flow.markMail([header.messageID], true))}>
                        {word(WRITE_WORDS.read, "Mark read")}
                      </button>
                    {:else}
                      <button type="button" class="minor" disabled={busy} onclick={() => void run(() => flow.markMail([header.messageID], false))}>
                        {word(WRITE_WORDS.unread, "Mark unread")}
                      </button>
                    {/if}
                    {#if inTrash(header.messageID)}
                      <button type="button" class="minor" disabled={busy} onclick={() => void run(() => flow.restoreMail([header.messageID]))}>
                        {word(WRITE_WORDS.restore, "Restore")}
                      </button>
                      <button type="button" class="minor" disabled={busy} onclick={() => void run(() => flow.deleteMail([header.messageID]))}>
                        {word(WRITE_WORDS.delete, "Delete")}
                      </button>
                    {:else}
                      <!-- GetAssignLabelMenu and GetRemoveLabelMenu: the labels it lacks, and those it has. -->
                      {@const lacking = labelsFor(header.messageID, false)}
                      {@const having = labelsFor(header.messageID, true)}
                      {#if lacking.length > 0}
                        <select aria-label={word(LABEL_WORDS.assign, "Assign Label")} disabled={busy} onchange={(event) => { const select = event.currentTarget; labelMessage(header.messageID, Number(select.value), true); select.value = ""; }}>
                          <option value="">{word(LABEL_WORDS.assign, "Assign Label")}</option>
                          {#each lacking as label (label.labelID)}
                            <option value={label.labelID}>{label.name}</option>
                          {/each}
                        </select>
                      {/if}
                      {#if having.length > 0}
                        <select aria-label={word(LABEL_WORDS.remove, "Remove Label")} disabled={busy} onchange={(event) => { const select = event.currentTarget; labelMessage(header.messageID, Number(select.value), false); select.value = ""; }}>
                          <option value="">{word(LABEL_WORDS.remove, "Remove Label")}</option>
                          {#each having as label (label.labelID)}
                            <option value={label.labelID}>{label.name}</option>
                          {/each}
                        </select>
                      {/if}
                      <button type="button" class="minor" disabled={busy} onclick={() => void run(() => flow.trashMail([header.messageID]))}>
                        {word(WRITE_WORDS.trash, "Trash")}
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <!-- ShowHideBrowse (716 to 736): Previous where there is a page before, Next where there is one after, and the
           page of the pages where either is. -->
      {#if pageShown > 0 || (pageShown + 1) * MAILS_PER_PAGE < sortedMessages.length}
        <p class="controls">
          {#if pageShown > 0}
            <button type="button" class="minor" disabled={busy} onclick={() => turnMailPage(-1)}>{word(LIST_WORDS.previous, "Previous")}</button>
          {/if}
          {#if (pageShown + 1) * MAILS_PER_PAGE < sortedMessages.length}
            <button type="button" class="minor" disabled={busy} onclick={() => turnMailPage(1)}>{word(LIST_WORDS.next, "Next")}</button>
          {/if}
          <span>{pageShown + 1}/{mailPages}</span>
        </p>
      {/if}
      {/if}
      </div>
      </div>
    {/if}

    {#if $mail.open !== null}
      <section class="bulk">
        <h2>{openHeader ? openHeader.title || "(no subject)" : "Message"}</h2>
        {#if openHeader}
          <p class="note">
            <!-- The date as the reading pane writes it, FmtDate(sentDate, 'ls') (mailSvc.py 1092), as the list does. -->
            From {senderName(openHeader)}, to {audienceText(openHeader)},
            {dateText(openHeader.sentDate) || "—"}.
          </p>
        {/if}
        {#if $mail.open.unreadable}
          <!-- The body arrived but would not inflate. Say so; show no garbage. -->
          <p class="error">This message arrived damaged and cannot be read.</p>
        {:else}
          <!-- The body's markup as the client's reading pane shows it: its lines, and in them runs as marked. -->
          <div class="mail-body">
            {#each mailBodyLines($mail.open.body) as line, place (place)}
              <p class="mail-line">{#each line as run, at (at)}{@const follower = run.link === null ? null : followerOf(run.link, run.text)}{#if follower !== null}<button
                    type="button"
                    class="evelink {follower.kind}"
                    class:mail-italic={run.italic}
                    title={follower.hint}
                    draggable="true"
                    ondragstart={(event) => startLinkDrag(event, run.link ?? "", run.text)}
                    onclick={follower.follow}>{run.text}</button>{:else}<span
                    class:mail-bold={run.bold}
                    class:mail-italic={run.italic}
                    class:mail-underline={run.underline || run.link !== null}
                    title={run.link ?? undefined}>{run.text}</span>{/if}{/each}</p>
            {/each}
          </div>
        {/if}
        {#if $mail.open.markedRead === null}
          <p class="note">
            This message could not be marked as read just now, so it may still
            show as unread.
          </p>
        {/if}
        <p class="controls">
          {#if openHeader}
            <button type="button" disabled={busy} onclick={() => reply(openHeader)}>
              Reply
            </button>
            <button type="button" class="minor" disabled={busy} onclick={() => reply(openHeader, true)}>
              Reply to all
            </button>
            <button type="button" class="minor" disabled={busy} onclick={() => forward(openHeader)}>
              Forward
            </button>
          {/if}
          <button type="button" class="minor" disabled={busy} onclick={() => flow.closeMail()}>
            Close
          </button>
        </p>
      </section>
    {/if}
  {:else}
    <section class="bulk">
      <h2>Write a message</h2>

      <!-- The window's To button and its one field of names (ConstructTopContainer; ReceiverEdit), checked as a comma
           is typed and as the field is left (ValidateReceivers). -->
      <p class="controls">
        <button type="button" class="minor" onclick={() => openRecipientSearch()}>{word(COMPOSE_WORDS.to, "To")}</button>
        <input
          type="text"
          class="grow"
          aria-label={word(COMPOSE_WORDS.to, "To")}
          bind:value={receiverText}
          onblur={() => {
            receiverOffers = [];
            receiversChanged();
          }}
          onkeydown={offerKeys}
          oninput={(event) => {
            void checkOffers();
            if ((event as InputEvent).data === ",") receiversChanged();
          }}
        />
      </p>
      {#if receiverOffers.length > 0}
        <!-- The field's offers (ReceiverEdit.GetValid; SingleLineEditHistory), taken by the mouse as it is pressed (HEMouseDown),
             or by the arrow keys and Enter. -->
        <ul class="mail-offers" role="listbox" aria-label={word(COMPOSE_WORDS.to, "To")}>
          {#each receiverOffers as offer, place (`${offer.group}:${offer.id}`)}
            <li role="option" aria-selected={place === activeOffer}>
              <button
                type="button"
                class="minor"
                class:active={place === activeOffer}
                tabindex="-1"
                onmousedown={(event) => {
                  event.preventDefault();
                  takeOffer(offer);
                }}>{offer.displayName}</button
              >
            </li>
          {/each}
        </ul>
      {/if}
      {#if composeQuestion !== null}
        <!-- CustomQuestion: its header, its question, yes and no. -->
        <div class="mail-confirm" role="alertdialog" aria-label={composeQuestion.title}>
          <strong>{composeQuestion.title}</strong>
          <p>{composeQuestion.body}</p>
          <p class="controls">
            <button type="button" onclick={() => composeQuestion?.answer(true)}>{word(FOLDER_WRITE_WORDS.yes, "Yes")}</button>
            <button type="button" class="minor" onclick={() => composeQuestion?.answer(false)}>{word(FOLDER_WRITE_WORDS.no, "No")}</button>
          </p>
        </div>
      {/if}
      {#if composePick !== null}
        <!-- ListWindow.ShowList, modal: its caption, its hint, those found, OK and Cancel. -->
        <div class="mail-confirm" role="dialog" aria-label={composePick.caption}>
          <strong>{composePick.caption}</strong>
          <p>{composePick.hint}</p>
          <ul class="mail-label-list">
            {#each composePick.options as person (person.characterID)}
              <li>
                <label>
                  <input type="radio" name="mail-receiver-pick" checked={composePicked === person.characterID} onchange={() => (composePicked = person.characterID)} />
                  {person.name}
                </label>
              </li>
            {/each}
          </ul>
          {#if composePickNote !== ""}
            <p class="error">{composePickNote}</p>
          {/if}
          <p class="controls">
            <button type="button" onclick={() => { if (composePicked === null) { composePickNote = filledWord(ACCESS_WORDS.mustSelect, "Choose {num}.", { num: "1" }); } else { composePick?.answer(composePicked); } }}>{word(ACCESS_WORDS.ok, "OK")}</button>
            <button type="button" class="minor" onclick={() => composePick?.answer(null)}>{word(ACCESS_WORDS.cancel, "Cancel")}</button>
          </p>
        </div>
      {/if}
      {#if recipientSearchOpen}
        <!-- "Find recipients" (MailSearchWindow; ownerSearch.py OwnerSearchWindow): its two tabs, Search and All
             Contacts. Search: Search By, the name, Search, the window's own entries (the corporation, the alliance,
             the lists) and then the pilots found, each with Add, a pilot marked where added. All Contacts: the
             pilot's contacts, the same. -->
        <section class="bulk mail-recipient-search">
          <h3>{word(COMPOSE_WORDS.searchFor, "Find recipients")}</h3>
          <p class="controls">
            <button type="button" class="minor" class:active={recipientSearchTab === "search"} onclick={() => (recipientSearchTab = "search")}>{word(COMPOSE_WORDS.search, "Search")}</button>
            <button type="button" class="minor" class:active={recipientSearchTab === "contacts"} onclick={showRecipientContacts}>{word(COMPOSE_WORDS.allContacts, "All Contacts")}</button>
            <button type="button" class="minor" onclick={() => (recipientSearchOpen = false)}>✕</button>
          </p>
          {#if recipientSearchTab === "search"}
            <p class="controls">
              <label>
                {word(COMPOSE_WORDS.searchBy, "Search By")}
                <select bind:value={recipientMatchBy} disabled={busy} onchange={recipientSearchByChanged}>
                  {#each SEARCH_BY as [matchBy, label, own] (matchBy)}
                    <option value={matchBy}>{word(label, own)}</option>
                  {/each}
                </select>
              </label>
              <input type="text" maxlength="50" bind:value={recipientSearchText} onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); searchRecipients(); } }} />
              <button type="button" disabled={busy} onclick={searchRecipients}>{word(COMPOSE_WORDS.search, "Search")}</button>
            </p>
            {#if recipientSearchNote !== ""}
              <p class="note">{recipientSearchNote}</p>
            {/if}
            {#if recipientExtras.length > 0 || recipientResults.length > 0}
              <ul class="mail-label-list">
                {#each recipientExtras as entry (`${entry.kind}:${entry.id}`)}
                  <li>
                    {entry.kind === "list"
                      ? mailEntryOf(entry.name)
                      : filledWord(FOLDER_WORDS.mailEntry, "{entryName} {entryType}", { entryName: entry.name, entryType: entry.kind === "corp" ? word(COMPOSE_WORDS.labelCorp, "[Corp]") : word(COMPOSE_WORDS.labelAlliance, "[Alliance]") })}
                    <button type="button" class="minor" disabled={busy} onclick={() => addExtraFromSearch(entry)}>{word(COMPOSE_WORDS.add, "Add")}</button>
                  </li>
                {/each}
                {#each recipientResults as person (person.characterID)}
                  <li>
                    {person.name}
                    {#if recipients.some((each) => each.characterID === person.characterID)}
                      <span class="note">{word(COMPOSE_WORDS.added, "Character Added")}</span>
                    {:else}
                      <button type="button" class="minor" disabled={busy} onclick={() => addFromSearch(person)}>{word(COMPOSE_WORDS.add, "Add")}</button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          {:else if recipientContacts !== null}
            {#if recipientContacts.length === 0}
              <p class="note">{word(COMPOSE_WORDS.noContacts, "No contacts")}</p>
            {:else}
              <ul class="mail-label-list">
                {#each recipientContacts as person (person.characterID)}
                  <li>
                    {person.name}
                    {#if recipients.some((each) => each.characterID === person.characterID)}
                      <span class="note">{word(COMPOSE_WORDS.added, "Character Added")}</span>
                    {:else}
                      <button type="button" class="minor" disabled={busy} onclick={() => addFromSearch(person)}>{word(COMPOSE_WORDS.add, "Add")}</button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </section>
      {/if}

      <p class="controls">
        <label>
          {word(COMPOSE_WORDS.subject, "Subject")}
          <input type="text" maxlength={MAIL_MAX_TITLE} bind:value={draftTitle} />
        </label>
      </p>
      <p class="controls">
        <label class="grow">
          Message
          <textarea rows="8" maxlength={MAIL_MAX_BODY} bind:value={draftBody}></textarea>
        </label>
      </p>
      {#if quote !== ""}
        <!-- The message quoted, sent below what is typed, as the client's editor holds it. -->
        <div class="mail-body mail-quote">
          {#each mailBodyLines(quote) as line, place (place)}
            <p class="mail-line">{#each line as run, at (at)}<span
                  class:mail-bold={run.bold}
                  class:mail-italic={run.italic}
                  class:mail-underline={run.underline || run.link !== null}
                  title={run.link ?? undefined}>{run.text}</span>{/each}</p>
          {/each}
        </div>
      {/if}

      {#each composeNotes as said, place (place)}
        <p class="error">{said}</p>
      {/each}

      <p class="controls">
        <button type="button" disabled={busy} onclick={send}>
          {word(COMPOSE_WORDS.send, "Send Mail")}
        </button>
        <button
          type="button"
          class="minor"
          disabled={busy}
          onclick={neverMind}
        >
          Never mind
        </button>
      </p>
    </section>
  {/if}
</section>

{#snippet colorWindow()}
  <!-- The colour window (MailAssignColorWnd, evemail.py 2974 on): "Select Color" over the service's swatches in its
       order (swatchColors.values()), five to a row as its 104-pixel window holds them; one picked shuts it. -->
  <section class="mail-color-window" aria-label={word(LABEL_WORDS.selectColor, "Pick a colour")}>
    <strong>{word(LABEL_WORDS.selectColor, "Pick a colour")}</strong>
    <div class="mail-swatches">
      {#each SWATCH_IDS as swatchID (swatchID)}
        <button type="button" class="mail-swatch" style:background={swatchColor(swatchID)} aria-label={swatchColor(swatchID)} title={swatchColor(swatchID)} disabled={busy} onclick={() => pickColor(swatchID)}></button>
      {/each}
    </div>
  </section>
{/snippet}

<style>
  /* A label's colour tag beside its folder (MailLabelEntry: eight pixels square, at 0.75 opacity). */
  .mail-label-tag {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-left: 0.35rem;
    opacity: 0.75;
    vertical-align: middle;
  }
  .mail-color-window {
    display: inline-flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.35rem;
    margin-bottom: 0.5rem;
    border: 1px solid var(--color-line-strong);
  }
  .mail-swatches {
    display: grid;
    grid-template-columns: repeat(5, 16px);
    gap: 2px;
  }
  .mail-swatch {
    width: 16px;
    height: 16px;
    min-width: 0;
    padding: 0;
    border: 1px solid transparent;
  }
  /* Message text keeps the sender's own line breaks and never runs off the
   * side of a phone. */
  .mail-body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .mail-line {
    margin: 0;
    min-height: 1lh;
  }
  .mail-quote {
    opacity: 0.8;
  }
  .mail-sort {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .mail-folders {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  .mail-folders button.active {
    text-decoration: underline;
  }
  .mail-folders-group {
    margin-left: 0.5rem;
    opacity: 0.8;
  }
  /* The field's offers, under it, one to a line; the one gone to by the arrow keys marked without colour alone. */
  .mail-offers {
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
    border: 1px solid var(--color-line-strong);
  }
  .mail-offers button {
    display: block;
    width: 100%;
    text-align: left;
  }
  .mail-offers button.active {
    text-decoration: underline;
    font-weight: 600;
  }
  .mail-confirm {
    border: 1px solid currentColor;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .mail-bold {
    font-weight: 700;
  }
  .mail-italic {
    font-style: italic;
  }
  .mail-underline {
    text-decoration: underline;
  }
  /* An unread row reads as unread without relying on colour alone. */
  tr.unread td {
    font-weight: 600;
  }
  .badge {
    font-size: 12px;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 0;
    border: 1px solid var(--color-line-strong);
    vertical-align: middle;
  }
  label.grow {
    flex: 1 1 100%;
  }
  textarea {
    width: 100%;
    font: inherit;
    min-height: 8rem;
  }
</style>
