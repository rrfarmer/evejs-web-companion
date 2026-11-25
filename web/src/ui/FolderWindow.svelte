<script lang="ts">
  // The client's folder window (bookmarks/bookmarkContainerWindow.py BookmarkContainerWindow):
  //
  //   "New Folder", from Create Folder at the Locations window's bottom and the Yes of CreateBookmarkFolderAsNoneValid:
  //   Name (forty characters), Type (Personal Folder or Shared Folder), Notes (3900), and for a shared folder its four
  //   access levels, View, Use, Manage and Admin, each one of the pilot's access lists or "-" (GetAccessGroups,
  //   134 to 136: ownerGroupManager.GetMyGroups; an NPC corporation's list by the corporation's name, the system's by its
  //   label; sorted by name, "-" last);
  //   "Edit Folder", from a folder's menu, on the folder as the server has it (EditACLFolder asks GetFolderInfo first):
  //   its name, notes and access lists, and its type shown;
  //   Submit (Confirm, 197 to 242): a name of nothing is msgPleaseTypeSomething; a shared folder needs an admins' list
  //   (AdminAccessRequired); a new folder past the most the pilot may know is TooManyKnownFolders, and past the most
  //   online of its kind asks ConfirmCreateAsInactivePersonalFolder or ConfirmCreateAsInactiveSharedFolder; a name
  //   another known folder has asks ConfirmCreateFolderWithDuplicateName; then the folder is made (AddFolder) or
  //   changed (UpdateFolder). A new shared folder is told with SharedLocationFolderCreated.
  //
  // A shared folder's list that is none of the pilot's is asked of the server by its number and offered after the
  // pilot's (ApplyAttributes, 50 to 55; AddGroup, 146 to 151: ownerGroupManager.GetGroup).
  //
  // Not here: an access list dropped on a level (the client's drag from the access lists window), a list's tooltip and
  // its Show Access List Info.
  import { onMount } from "svelte";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { MAX_FOLDER_DESCRIPTION_LENGTH, MAX_FOLDER_NAME_LENGTH, type FolderAccess } from "../bridge/bookmarkWrites.ts";
  import { ASKED_KEEPING_YES, DO_NOT_ASK_AGAIN_LABEL, suppressableKey } from "../bridge/dialogSuppression.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { AccessGroup, ActiveBookmarks, BookmarkFolder } from "../bridge/bookmarks.ts";
  import { accessGroupLabel, accessGroupName, isNpcCorporation } from "./accessGroupNames.ts";
  import { showAccessGroupInfo } from "./accessGroupInfo.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, active, folder = null, onDone }: {
    store: ClientStore;
    flow: AppFlow;
    active: ActiveBookmarks;
    folder?: BookmarkFolder | null;
    onDone: (made: boolean, notice?: string) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  /** The window's words (bookmarkContainerWindow.py 31 to 132, 197 to 252). */
  const WORDS = {
    newTitle: "UI/AclBookmarks/NewFolder",
    editTitle: "UI/AclBookmarks/EditBookmarkFolder",
    name: "UI/PeopleAndPlaces/Name",
    type: "UI/AclBookmarks/FolderType",
    personal: "UI/AclBookmarks/PersonalFolderType",
    shared: "UI/AclBookmarks/SharedFolderType",
    notes: "UI/PeopleAndPlaces/Notes",
    view: "UI/AclBookmarks/ViewAccess",
    use: "UI/AclBookmarks/UseAccess",
    manage: "UI/AclBookmarks/ManageAccess",
    admin: "UI/AclBookmarks/AdminAccess",
    noList: "UI/AclBookmarks/NoAccessList",
    listInfo: "UI/AclBookmarks/ShowAccessListInfo",
    help: "UI/AclBookmarks/CreateFolderHelpText",
    submit: "UI/Common/Submit",
    cancel: "UI/Common/Cancel",
    yes: "UI/Common/Buttons/Yes",
    no: "UI/Common/Buttons/No",
    typeSomething: "UI/Map/MapPallet/msgPleaseTypeSomething",
    adminRequired: "dialog:AdminAccessRequired/body",
    tooManyKnown: "dialog:TooManyKnownFolders/body",
    created: "dialog:SharedLocationFolderCreated/body",
    question: "UI/Common/Question",
  } as const;
  const DIALOGS = ["ConfirmCreateAsInactivePersonalFolder", "ConfirmCreateAsInactiveSharedFolder", "ConfirmCreateFolderWithDuplicateName"] as const;
  type Question = (typeof DIALOGS)[number];
  const OWN_QUESTIONS: Readonly<Record<Question, readonly [string, string]>> = {
    ConfirmCreateAsInactivePersonalFolder: ["Make it offline?", "{[numeric]maxPersonalFolders} of your folders are online already. Make this one offline?"],
    ConfirmCreateAsInactiveSharedFolder: ["Make it offline?", "{[numeric]maxSharedFolders} shared folders are online already. Make this one offline?"],
    ConfirmCreateFolderWithDuplicateName: ["The same name?", "Another of your folders has that name. Use it again?"],
  };
  /** appConst: the most folders the pilot may know, online of each kind, and places of each kind in a folder. */
  const MAX_KNOWN = 30;
  const MAX_ONLINE_PERSONAL = 5;
  const MAX_ONLINE_SHARED = 3;
  const MAX_IN_PERSONAL = 3000;
  const MAX_IN_SHARED = 500;
  /** The combo's "no list" value (GetAccessGroupComboAndCont, 121 to 123). */
  const NO_LIST = -1;

  function word(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(template) : own;
  }

  function filled(label: string, own: string, args: TemplateArguments): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" ? template : own, args, {
      nameOf: (kind, id) => resolvedName($names.resolved, kind === "character" ? "owner" : kind, id, ""),
    }));
  }

  // svelte-ignore state_referenced_locally
  const isNew = folder === null;
  let name = $state("");
  let notes = $state("");
  let isPersonal = $state(true);
  let groups = $state<readonly AccessGroup[]>([]);
  /** A folder's lists that are none of the pilot's, as the server names them (AddGroup, 146 to 151). */
  let others = $state<readonly AccessGroup[]>([]);
  let levels = $state<{ view: number; use: number; manage: number; admin: number }>({ view: NO_LIST, use: NO_LIST, manage: NO_LIST, admin: NO_LIST });
  let error = $state("");
  let busy = $state(false);

  /** An access list's name (ApplyAttributes, 36 to 38; accessGroupNames.ts). */
  function groupName(group: AccessGroup): string {
    return accessGroupName(group, (id) => resolvedName($names.resolved, "owner", id, group.name), (path) => word(path, path));
  }

  /**
   * The combos' options: the pilot's lists by name, sorted; then a folder's lists that are none of them, as AddGroup
   * puts them after (by their number until the server has named them); then "-".
   */
  const options = $derived.by(() => {
    const known = new Set(groups.map((group) => group.groupID));
    const listed = groups.map((group) => ({ id: group.groupID, line: groupName(group) })).sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : a.id - b.id));
    const foreign = [levels.view, levels.use, levels.manage, levels.admin].filter((id, at, all) => id !== NO_LIST && !known.has(id) && all.indexOf(id) === at);
    const named = (id: number): string => {
      const group = others.find((each) => each.groupID === id);
      return group !== undefined ? groupName(group) : `#${id}`;
    };
    return [...listed, ...foreign.map((id) => ({ id, line: named(id) })), { id: NO_LIST, line: word(WORDS.noList, "-") }];
  });

  /** The owners and the labels the lists are named by, for the page's names and words to fetch. */
  function askNamesOf(read: readonly AccessGroup[]): void {
    const npc = read.map((group) => group.creatorID).filter(isNpcCorporation);
    if (npc.length > 0) flow.requestNames(npc.map((id) => ({ kind: "owner" as const, id })));
    const labels = read.map(accessGroupLabel).filter((path): path is string => path !== null);
    if (labels.length > 0) flow.requestWords(labels);
  }

  onMount(() => {
    flow.requestWords([...Object.values(WORDS), DO_NOT_ASK_AGAIN_LABEL, ...DIALOGS.flatMap((dialog) => [`dialog:${dialog}/title`, `dialog:${dialog}/body`, suppressableKey(dialog)])]);
    if (folder !== null) {
      name = folder.folderName;
      notes = folder.description;
      isPersonal = folder.isPersonal;
      levels = { view: folder.viewGroupID ?? NO_LIST, use: folder.useGroupID ?? NO_LIST, manage: folder.manageGroupID ?? NO_LIST, admin: folder.adminGroupID ?? NO_LIST };
    }
    // GetAccessGroups (134 to 136): asked as the window opens, as the client's controller asks once. A shared folder's
    // lists that are none of them are asked of the server by their numbers (ApplyAttributes, 50 to 55; AddGroup).
    void flow.readAccessGroups().then(async (read) => {
      groups = read;
      askNamesOf(read);
      if (folder === null || folder.isPersonal) return;
      const mine = new Set(read.map((group) => group.groupID));
      const wanted = [folder.viewGroupID, folder.useGroupID, folder.manageGroupID, folder.adminGroupID]
        .filter((id, at, all): id is number => id !== null && !mine.has(id) && all.indexOf(id) === at);
      const found = (await Promise.all(wanted.map((id) => flow.readAccessGroup(id)))).filter((group): group is AccessGroup => group !== null);
      others = found;
      askNamesOf(found);
    }).catch((cause) => {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : panelErrorWords(cause);
    });
  });

  /**
   * A question's title: the install's, or where the dialog has none the client's title for a question
   * (dialog_handler.py TITLE_BY_DIALOG_TYPE, 24 to 29, 107 to 109); the page's own while the words are not to hand.
   */
  function questionTitle(dialog: Question): string {
    const title = $words.templates[`dialog:${dialog}/title`];
    if (typeof title === "string") return plainText(title);
    return title === null ? word(WORDS.question, "Question") : OWN_QUESTIONS[dialog][0];
  }

  /** The client's question waiting for its answer, and what is given back with it. */
  let question = $state<{ readonly dialog: Question; readonly args: TemplateArguments; readonly answer: (yes: boolean) => void } | null>(null);
  let dontAskAgain = $state(false);

  /** prompt_player_fsd_dialog with suppress=ID_YES: Yes where it is kept, else the answer given. */
  function asked(dialog: Question, args: TemplateArguments): Promise<boolean> {
    if (ASKED_KEEPING_YES.has(dialog) && flow.dialogYesKept(dialog)) return Promise.resolve(true);
    dontAskAgain = false;
    return new Promise((resolve) => {
      question = { dialog, args, answer: resolve };
    });
  }

  function answer(yes: boolean): void {
    const waiting = question;
    question = null;
    if (waiting === null) return;
    // _persist_prompt_suppress_choice: Yes kept where the box was ticked.
    if (yes && dontAskAgain && ASKED_KEEPING_YES.has(waiting.dialog)) flow.keepDialogYes(waiting.dialog);
    waiting.answer(yes);
  }

  /** Confirm (197 to 242). */
  async function submit(): Promise<void> {
    error = "";
    const trimmed = name.trim();
    if (trimmed === "") {
      error = word(WORDS.typeSomething, "Type a name first.");
      return;
    }
    const list = (id: number): number | null => (id === NO_LIST ? null : id);
    const access: FolderAccess = { adminGroupID: list(levels.admin), manageGroupID: list(levels.manage), useGroupID: list(levels.use), viewGroupID: list(levels.view) };
    if (!isPersonal && access.adminGroupID === null) {
      error = word(WORDS.adminRequired, "Choose an access list for the folder's admins first.");
      return;
    }
    const known = active.folders;
    if (isNew) {
      if (known.length >= MAX_KNOWN) {
        error = filled(WORDS.tooManyKnown, "You know as many folders as you may ({[numeric]maxKnownFolders}).", { maxKnownFolders: MAX_KNOWN });
        return;
      }
      const online = known.filter((each) => each.isActive && each.isPersonal === isPersonal).length;
      if (online >= (isPersonal ? MAX_ONLINE_PERSONAL : MAX_ONLINE_SHARED)) {
        const yes = isPersonal
          ? await asked("ConfirmCreateAsInactivePersonalFolder", { maxPersonalFolders: MAX_ONLINE_PERSONAL })
          : await asked("ConfirmCreateAsInactiveSharedFolder", { maxSharedFolders: MAX_ONLINE_SHARED });
        if (!yes) return;
      }
    }
    if (known.some((each) => each.folderID !== folder?.folderID && each.folderName === trimmed)) {
      if (!(await asked("ConfirmCreateFolderWithDuplicateName", {}))) return;
    }
    busy = true;
    try {
      if (folder === null) {
        const made = await flow.addFolder(isPersonal, trimmed, notes, access);
        // DisplaySuccessPopup (247 to 252): a shared folder's, with its link (here its name: the page has no folder links).
        const notice = made !== null && !made.isPersonal
          ? filled(WORDS.created, "The shared folder \"{folderName}\" is made.", { folderName: made.folderName, folderLink: made.folderName })
          : undefined;
        onDone(true, notice);
      } else {
        await flow.updateFolder(folder.folderID, folder.isPersonal, trimmed, notes, access);
        onDone(true);
      }
    } catch (cause) {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }

  const heading = $derived(isNew ? word(WORDS.newTitle, "Make a folder") : word(WORDS.editTitle, "Change the folder"));
  const help = $derived(filled(WORDS.help, "A personal folder is yours alone; a shared one is for those its access lists name.", {
    maxPersonalBookmarks: MAX_IN_PERSONAL, maxSharedBookmarks: MAX_IN_SHARED, maxPersonalFolders: MAX_ONLINE_PERSONAL, maxSharedFolders: MAX_ONLINE_SHARED,
  }));
  /** The four levels in the window's order (LoadAccessGroupOptions, 107 to 119). */
  const LEVELS = [["view", WORDS.view, "Can see it"], ["use", WORDS.use, "Can add to it"], ["manage", WORDS.manage, "Can change it all"], ["admin", WORDS.admin, "Can run it"]] as const;
</script>

<section class="folder-window" aria-label={heading}>
  <h3>{heading}</h3>
  {#if question !== null}
    {@const own = OWN_QUESTIONS[question.dialog]}
    <!-- The client's question: its title and body, the box that keeps Yes where the install lets it, Yes and No. -->
    <div class="folder-question" role="alertdialog" aria-label={questionTitle(question.dialog)}>
      <strong>{questionTitle(question.dialog)}</strong>
      <p>{filled(`dialog:${question.dialog}/body`, own[1], question.args)}</p>
      {#if $words.templates[suppressableKey(question.dialog)] === "1"}
        <label><input type="checkbox" bind:checked={dontAskAgain} /> {word(DO_NOT_ASK_AGAIN_LABEL, "Skip this question from now on")}</label>
      {/if}
      <p class="controls">
        <button type="button" onclick={() => answer(true)}>{word(WORDS.yes, "Yes")}</button>
        <button type="button" class="minor" onclick={() => answer(false)}>{word(WORDS.no, "No")}</button>
      </p>
    </div>
  {/if}
  <p class="controls">
    <label>
      {word(WORDS.name, "Name")}
      <input type="text" maxlength={MAX_FOLDER_NAME_LENGTH} bind:value={name} onkeydown={(event) => { if (event.key === "Enter") void submit(); }} />
    </label>
  </p>
  <p class="controls">
    {word(WORDS.type, "Kind")}:
    {#if isNew}
      <label><input type="radio" name="folder-type" checked={isPersonal} onchange={() => (isPersonal = true)} /> {word(WORDS.personal, "Yours")}</label>
      <label><input type="radio" name="folder-type" checked={!isPersonal} onchange={() => (isPersonal = false)} /> {word(WORDS.shared, "Shared")}</label>
    {:else}
      {isPersonal ? word(WORDS.personal, "Yours") : word(WORDS.shared, "Shared")}
    {/if}
    <span class="folder-help" title={help} aria-label={help}>ⓘ</span>
  </p>
  {#if !isPersonal}
    <!-- LoadAccessGroupOptions: the four levels, each a list of the pilot's or "-". -->
    {#each LEVELS as [key, path, own] (key)}
      <p class="controls">
        <label>
          {word(path, own)}
          <select value={String(levels[key])} onchange={(event) => (levels = { ...levels, [key]: Number(event.currentTarget.value) })}>
            {#each options as option (option.id)}
              <option value={String(option.id)}>{option.line}</option>
            {/each}
          </select>
        </label>
        {#if levels[key] > 0}
          <button type="button" class="minor" title={word(WORDS.listInfo, "Show Access List Info")}
            aria-label={word(WORDS.listInfo, "Show Access List Info")}
            onclick={() => showAccessGroupInfo(flow, levels[key])}>ⓘ</button>
        {/if}
      </p>
    {/each}
  {/if}
  <label class="folder-notes">
    {word(WORDS.notes, "Notes")}
    <textarea rows="4" maxlength={MAX_FOLDER_DESCRIPTION_LENGTH} bind:value={notes}></textarea>
  </label>
  {#if error}<p class="error">{error}</p>{/if}
  <p class="controls">
    <button type="button" class="primary" disabled={busy || question !== null} onclick={() => void submit()}>{word(WORDS.submit, "Save")}</button>
    <button type="button" class="minor" onclick={() => onDone(false)}>{word(WORDS.cancel, "Cancel")}</button>
  </p>
</section>

<style>
  .folder-window {
    border: 1px solid currentColor;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .folder-window textarea {
    width: 100%;
    font: inherit;
  }
  .folder-notes {
    display: block;
  }
  .folder-help {
    cursor: help;
  }
  .folder-question {
    border: 1px solid currentColor;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
  }
</style>
