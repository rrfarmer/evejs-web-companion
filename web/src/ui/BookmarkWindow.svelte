<script lang="ts">
  // The client's bookmark window (bookmarks/bookmarkLocationWindow.py BookmarkLocationWindow, "New Location"), with
  // what its popup asks first (neocom/addressBook/addressbookService.py BookmarkLocationPopup, 405 to 421):
  //
  //   a place already bookmarked asks AskBookmarkExistingLocation before going on (not the pilot's own spot);
  //   with no folder to put it in (an online folder the pilot may use, not full: bookmarkSvc.py
  //   GetFilteredFoldersAndSubfolders, 395 to 411) it asks CreateBookmarkFolderAsNoneValid and opens nothing;
  //   otherwise the window: Label (the place's default name, a hundred characters), Expire (Never, 2 days, 24 hours,
  //   4 hours, the one last chosen for the folder), Folder (the folders, "(Online)", personal first, each followed by
  //   its subfolders; the one last used; a warning where no personal folder is offered), Notes, Submit and Cancel;
  //   Submit refuses an empty label (msgPleaseTypeSomething), writes a tab as a space, bookmarks the place
  //   (bookmarkSvc.ACLBookmarkLocation: a place by BookmarkStaticLocation, a thing in space by the park), and keeps
  //   the folder and the folder's time (Confirm, 205 to 225).
  //
  // Opened for a bookmark (EditBookmark, addressbookService.py 475 to 483: Edit Location, a double click), it is
  // "Edit Location": the bookmark's label and note, its folder and subfolder chosen (its own folder offered even where
  // it is full), its expiry shown with the option to set a new time; Submit edits it
  // (bookmarkSvc.UpdateACLBookmark, 642 to 646), the folder kept as the last used.
  //
  // The folder's choice and the times are kept for the pilot in this browser, as the client keeps them in its own
  // settings. A shown window takes the folders as they are when it opens.
  import { onMount } from "svelte";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { BOOKMARK_EXPIRY } from "../bridge/bookmarkWrites.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ActiveBookmarks, Bookmark, BookmarkFolder, Subfolder } from "../bridge/bookmarks.ts";
  import { unzipMemo, type BookmarkPlace } from "../bridge/locationsList.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, place = null, scanResult = null, editing = null, onDone, onCreateFolder = null }: {
    store: ClientStore;
    flow: AppFlow;
    place?: BookmarkPlace | null;
    /**
     * A probe result's Bookmark Location (scanSvc.GetScannedDownMenu): the popup's scannerInfo, the result's own ID
     * and the name "id name" (bookmarkData, its default label: GetDefaultLocationName, 423 to 427). The pilot's
     * system is the place, so nothing is asked of a bookmark already there (BookmarkLocationPopup, 408 to 412).
     */
    scanResult?: { readonly resultID: string; readonly name: string } | null;
    editing?: Bookmark | null;
    onDone: (made: boolean) => void;
    /** The folder window for a new folder, which CreateBookmarkFolderAsNoneValid's Yes opens, where the caller has one. */
    onCreateFolder?: (() => void) | null;
  } = $props();

  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;

  /** The window's words (bookmarkLocationWindow.py 31 to 34, 59 to 108, 120 to 154; addressbookService.py 405 to 417). */
  const WORDS = {
    title: "UI/PeopleAndPlaces/NewBookmark",
    editTitle: "UI/PeopleAndPlaces/EditLocation",
    editExpiry: "UI/AclBookmarks/EditExpiryTime",
    expires: "UI/Common/Expires",
    dateTime: "/Carbon/UI/Common/DateTime/DateLongShort",
    label: "UI/PeopleAndPlaces/Label",
    expire: "UI/AclBookmarks/AutoExpire",
    folder: "UI/PeopleAndPlaces/Folder",
    notes: "UI/PeopleAndPlaces/Notes",
    active: "UI/AclBookmarks/Active",
    notActive: "UI/AclBookmarks/NotActive",
    submit: "UI/Common/Submit",
    cancel: "UI/Common/Cancel",
    noPersonal: "UI/AclBookmarks/NoPersonalFolderAvailable",
    expiryHelp: "UI/AclBookmarks/ExpiryOptionsHelpText",
    typeSomething: "UI/Map/MapPallet/msgPleaseTypeSomething",
    personalFolder: "UI/AclBookmarks/PersonalFolderType",
    sharedFolder: "UI/AclBookmarks/SharedFolderType",
    yes: "UI/Common/Buttons/Yes",
    no: "UI/Common/Buttons/No",
  } as const;
  /** BOOKMARK_EXPIRY_STRINGS, in the order the window offers them (122 to 128). */
  const EXPIRIES: readonly (readonly [number, string, string])[] = [
    [BOOKMARK_EXPIRY.none, "UI/AclBookmarks/ExpireNever", "Kept until deleted"],
    [BOOKMARK_EXPIRY.twoDays, "UI/AclBookmarks/ExpireIn2Days", "Gone in two days"],
    [BOOKMARK_EXPIRY.oneDay, "UI/AclBookmarks/ExpireIn24Hours", "Gone in a day"],
    [BOOKMARK_EXPIRY.fourHours, "UI/AclBookmarks/ExpireIn4Hours", "Gone in four hours"],
  ];
  const DIALOGS = ["AskBookmarkExistingLocation", "CreateBookmarkFolderAsNoneValid"] as const;
  /** appConst: the longest label and note, the access that only views, and how many a folder holds. */
  const MAX_NAME = 100;
  const MAX_NOTE = 3900;
  const ACCESS_VIEW = 2;
  const MAX_IN_PERSONAL = 3000;
  const MAX_IN_SHARED = 500;
  /** invConst.ownerSystem: a subfolder the system made is not offered (GetFolderAndSubfolderOptions, 146 to 147). */
  const OWNER_SYSTEM = 1;

  function word(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(template) : own;
  }

  function filled(label: string, own: string, args: TemplateArguments): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" ? template : own, args, {
      nameOf: (kind, id) => resolvedName($names.resolved, kind, id, ""),
    }));
  }

  interface FolderOption {
    readonly key: string;
    readonly folderID: number;
    readonly subfolderID: number | null;
    readonly line: string;
    readonly hint: string;
    readonly depth: number;
  }

  let phase = $state<"loading" | "known" | "noFolder" | "form" | "failed">("loading");
  let active = $state<ActiveBookmarks | null>(null);
  let options = $state<readonly FolderOption[]>([]);
  let personalOffered = $state(true);
  let chosen = $state("");
  let expiry = $state<number>(BOOKMARK_EXPIRY.none);
  let label = $state("");
  let note = $state("");
  let editExpiry = $state(false);
  let error = $state("");
  let busy = $state(false);

  const pilotID = $derived($station.online?.characterID ?? null);
  const keptFolderKey = (): string => `evejs.bookmarkFolderAndSubfolder.${pilotID ?? 0}`;
  const keptExpiryKey = (folderID: number, subfolderID: number | null): string => `evejs.bookmarkExpiryByFolder.${pilotID ?? 0}.${folderID}_${subfolderID ?? "None"}`;

  function readKept(key: string): unknown {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function keep(key: string, value: unknown): void {
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      // Not kept: the choice holds for this window's life.
    }
  }

  /** GetFilteredFoldersAndSubfolders (395 to 411): online, more than viewed, and not full (the bookmark's own folder may be). */
  function usableFolders(read: ActiveBookmarks, forcedFolderID: number | null): readonly BookmarkFolder[] {
    return read.folders.filter((folder) => {
      if (folder.accessLevel === ACCESS_VIEW || !folder.isActive) return false;
      const held = read.bookmarks.filter((bookmark) => bookmark.folderID === folder.folderID).length;
      return held < (folder.isPersonal ? MAX_IN_PERSONAL : MAX_IN_SHARED) || folder.folderID === forcedFolderID;
    });
  }

  /** GetFolderAndSubfolderOptions (130 to 160): each folder "(Online)", personal and online first, then its subfolders. */
  function optionsOf(folders: readonly BookmarkFolder[], subfolders: readonly Subfolder[]): readonly FolderOption[] {
    const lineOf = (folder: BookmarkFolder): string => `${folder.folderName} (${folder.isActive ? word(WORDS.active, "Online") : word(WORDS.notActive, "Offline")})`;
    const sorted = [...folders].sort((a, b) =>
      Number(b.isPersonal) - Number(a.isPersonal) || Number(b.isActive) - Number(a.isActive) || lineOf(a).toLowerCase().localeCompare(lineOf(b).toLowerCase()));
    const made: FolderOption[] = [];
    for (const folder of sorted) {
      const hint = folder.isPersonal ? word(WORDS.personalFolder, "Yours") : word(WORDS.sharedFolder, "Shared");
      made.push({ key: `${folder.folderID}:`, folderID: folder.folderID, subfolderID: null, line: lineOf(folder), hint, depth: 0 });
      const own = subfolders
        .filter((subfolder) => subfolder.folderID === folder.folderID && subfolder.creatorID !== OWNER_SYSTEM)
        .sort((a, b) => a.subfolderName.toLowerCase().localeCompare(b.subfolderName.toLowerCase()));
      for (const subfolder of own) {
        made.push({ key: `${folder.folderID}:${subfolder.subfolderID}`, folderID: folder.folderID, subfolderID: subfolder.subfolderID, line: subfolder.subfolderName, hint, depth: 1 });
      }
    }
    return made;
  }

  const chosenOption = $derived(options.find((option) => option.key === chosen) ?? null);
  const currentExpiry = $derived.by(() => {
    if (!editExpiry) return editing?.expiry ?? null;
    const hours = expiry === BOOKMARK_EXPIRY.twoDays ? 48 : expiry === BOOKMARK_EXPIRY.oneDay ? 24 : expiry === BOOKMARK_EXPIRY.fourHours ? 4 : 0;
    return hours === 0 ? null : 116444736000000000n + BigInt(Date.now() + hours * 3600000) * 10000n;
  });

  /** _LoadExpiryOptions (115 to 128): the time last chosen for this folder, else Never. */
  function expiryFor(option: FolderOption | null): number {
    if (option === null) return BOOKMARK_EXPIRY.none;
    const kept = readKept(keptExpiryKey(option.folderID, option.subfolderID));
    return typeof kept === "number" && EXPIRIES.some(([value]) => value === kept) ? kept : BOOKMARK_EXPIRY.none;
  }

  function openForm(read: ActiveBookmarks): void {
    const folders = usableFolders(read, editing?.folderID ?? null);
    if (folders.length === 0) {
      phase = "noFolder";
      return;
    }
    const usable = new Set(folders.map((folder) => folder.folderID));
    options = optionsOf(folders, read.subfolders.filter((subfolder) => usable.has(subfolder.folderID)));
    personalOffered = folders.some((folder) => folder.isPersonal);
    if (editing !== null) {
      // The bookmark's own folder and subfolder, label and note (EditBookmark; ApplyAttributes, 67 to 70).
      const ownKey = `${editing.folderID}:${editing.subfolderID ?? ""}`;
      chosen = options.some((option) => option.key === ownKey) ? ownKey : (options[0]?.key ?? "");
      label = unzipMemo(editing.memo)[0].slice(0, MAX_NAME);
      note = editing.note;
      editExpiry = false;
      expiry = expiryFor(options.find((option) => option.key === chosen) ?? null);
      phase = "form";
      return;
    }
    // The folder last used (settings.char.ui bookmarkFolderAndSubfolder), else the first offered.
    const kept = readKept(keptFolderKey());
    const keptKey = Array.isArray(kept) ? `${kept[0]}:${kept[1] ?? ""}` : "";
    chosen = options.some((option) => option.key === keptKey) ? keptKey : (options[0]?.key ?? "");
    expiry = expiryFor(options.find((option) => option.key === chosen) ?? null);
    label = (scanResult?.name ?? place?.name() ?? "").slice(0, MAX_NAME);
    note = "";
    phase = "form";
  }

  async function load(): Promise<void> {
    try {
      const read = await flow.readLocations();
      active = read;
      // CheckLocationID: a place already bookmarked is asked about (not the pilot's own spot or system).
      const known = place !== null && place.askIfKnown ? read.bookmarks.find((bookmark) => bookmark.itemID === place.itemID) : undefined;
      if (known !== undefined) {
        phase = "known";
        return;
      }
      openForm(read);
    } catch (cause) {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : panelErrorWords(cause);
      phase = "failed";
    }
  }

  onMount(() => {
    flow.requestWords([...Object.values(WORDS), ...EXPIRIES.map(([, labelPath]) => labelPath), ...DIALOGS.flatMap((name) => [`dialog:${name}/title`, `dialog:${name}/body`])]);
    void load();
  });

  const knownBookmark = $derived(active === null || place === null ? undefined : active.bookmarks.find((bookmark) => bookmark.itemID === place.itemID));

  function chooseFolder(key: string): void {
    chosen = key;
    // OnFolderChange: reload the folder's preferred mode.
    expiry = expiryFor(options.find((option) => option.key === key) ?? null);
  }

  async function submit(): Promise<void> {
    const option = chosenOption;
    if (option === null || busy) return;
    if (label.trim() === "") {
      error = word(WORDS.typeSomething, "Give the place a label first.");
      return;
    }
    busy = true;
    error = "";
    try {
      if (editing !== null) {
        await flow.updateBookmark({
          bookmarkID: editing.bookmarkID,
          folderID: editing.folderID,
          label: label.replace(/\t/g, " "),
          note,
          subfolderID: option.subfolderID,
          newFolderID: option.folderID,
          expiryMode: editExpiry ? expiry : null,
        });
        keep(keptFolderKey(), [option.folderID, option.subfolderID]);
        onDone(true);
        return;
      }
      if (scanResult !== null) {
        // _ConfirmAclBookmark (222 to 224): with scannerInfo, bookmarkSvc.ACLBookmarkScanResult.
        await flow.bookmarkProbeResult({
          resultID: scanResult.resultID,
          folderID: option.folderID,
          subfolderID: option.subfolderID,
          label: label.replace(/\t/g, " "),
          note,
          expiry,
        });
        keep(keptExpiryKey(option.folderID, option.subfolderID), expiry);
        keep(keptFolderKey(), [option.folderID, option.subfolderID]);
        onDone(true);
        return;
      }
      if (place === null) return;
      await flow.bookmarkPlace({
        itemID: place.itemID,
        folderID: option.folderID,
        subfolderID: option.subfolderID,
        label: label.replace(/\t/g, " "),
        note,
        expiry,
      });
      keep(keptExpiryKey(option.folderID, option.subfolderID), expiry);
      keep(keptFolderKey(), [option.folderID, option.subfolderID]);
      onDone(true);
    } catch (cause) {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }
</script>

{#if phase === "known" && knownBookmark !== undefined && active !== null}
  {@const folderName = active.folders.find((folder) => folder.folderID === knownBookmark.folderID)?.folderName ?? ""}
  <section class="bookmark-window">
    <h3>{filled("dialog:AskBookmarkExistingLocation/title", "Go on?", {})}</h3>
    <p>{filled("dialog:AskBookmarkExistingLocation/body", "{locationName} is saved already, in {folderName} as {caption}. Save it again?", {
      locationName: place?.typeName() ?? "",
      folderName,
      caption: knownBookmark.memo,
    })}</p>
    <p class="controls">
      <button type="button" class="primary" onclick={() => active !== null && openForm(active)}>{word(WORDS.yes, "Yes")}</button>
      <button type="button" class="minor" onclick={() => onDone(false)}>{word(WORDS.no, "No")}</button>
    </p>
  </section>
{:else if phase === "noFolder"}
  <!-- Yes opens the client's folder window (BookmarkContainerWindow) for a new folder, where the caller has it; the
       place is not saved either way. -->
  <section class="bookmark-window">
    <h3>{filled("dialog:CreateBookmarkFolderAsNoneValid/title", "No folder", {})}</h3>
    <p>{filled("dialog:CreateBookmarkFolderAsNoneValid/body", "There is no folder to save the place in. Make one?", {})}</p>
    <p class="controls">
      <button type="button" class="primary" onclick={() => { onDone(false); onCreateFolder?.(); }}>{word(WORDS.yes, "Yes")}</button>
      <button type="button" class="minor" onclick={() => onDone(false)}>{word(WORDS.no, "No")}</button>
    </p>
  </section>
{:else if phase === "form"}
  {@const heading = editing !== null ? word(WORDS.editTitle, "Change the place") : word(WORDS.title, "Save a place")}
  <section class="bookmark-window" aria-label={heading}>
    <h3>{heading}</h3>
    <p class="controls">
      <label>
        {word(WORDS.label, "Label")}
        <input type="text" maxlength={MAX_NAME} bind:value={label} onkeydown={(event) => { if (event.key === "Enter") void submit(); }} />
      </label>
    </p>
    {#if editing !== null}
      <p class="controls">
        {word(WORDS.expires, "Expires")}:
        {currentExpiry === null
          ? word("UI/AclBookmarks/ExpireNever", "Kept until deleted")
          : filled(WORDS.dateTime, "{[datetime]datetime}", { datetime: String(currentExpiry) })}
        <label><input type="checkbox" bind:checked={editExpiry} /> {word(WORDS.editExpiry, "Edit Expiry Time")}</label>
      </p>
    {/if}
    <fieldset class="bookmark-expiry" disabled={editing !== null && !editExpiry}>
      <legend title={word(WORDS.expiryHelp, "")}>{word(WORDS.expire, "Expire")}</legend>
      {#each EXPIRIES as [value, path, own] (value)}
        <label>
          <input type="radio" name="bookmark-expiry" checked={expiry === value} onchange={() => (expiry = value)} />
          {word(path, own)}
        </label>
      {/each}
    </fieldset>
    <p class="controls">
      <label>
        {word(WORDS.folder, "Folder")}
        {#if !personalOffered}<span class="warn" title={word(WORDS.noPersonal, "No folder of your own can take it.")}>⚠</span>{/if}
        <select value={chosen} onchange={(event) => chooseFolder(event.currentTarget.value)}>
          {#each options as option (option.key)}
            <option value={option.key} title={option.hint}>{option.depth > 0 ? " " : ""}{option.line}</option>
          {/each}
        </select>
      </label>
    </p>
    <label class="bookmark-notes">
      {word(WORDS.notes, "Notes")}
      <textarea rows="4" maxlength={MAX_NOTE} bind:value={note}></textarea>
    </label>
    {#if error}<p class="error">{error}</p>{/if}
    <p class="controls">
      <button type="button" class="primary" disabled={busy} onclick={() => void submit()}>{word(WORDS.submit, "Save")}</button>
      <button type="button" class="minor" onclick={() => onDone(false)}>{word(WORDS.cancel, "Cancel")}</button>
    </p>
  </section>
{:else if phase === "failed"}
  <section class="bookmark-window">
    <p class="error">{error}</p>
    <p class="controls"><button type="button" class="minor" onclick={() => onDone(false)}>{word(WORDS.cancel, "Cancel")}</button></p>
  </section>
{/if}

<style>
  .bookmark-window {
    border: 1px solid currentColor;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .bookmark-window textarea {
    width: 100%;
    font: inherit;
  }
  .bookmark-expiry {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    border: none;
    padding: 0;
  }
  .bookmark-notes {
    display: block;
  }
</style>
