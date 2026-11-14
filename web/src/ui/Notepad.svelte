<script lang="ts">
  // The client's Notepad (neocom/notepad.py NotepadWindow: 400 x 300, at least 350 x 200, caption UI/Notepad/Notepad).
  //  - The nav at the left, notepadscrollistwidth wide (128; its divider 100 - 256, kept): the folders as list groups
  //    (17 px; a folder's notes and folders under it, by name), then the locked All Notes group (notegroup.png) of every
  //    note; New Folder and New Note under it. A note entry: note.png 24 px, 18 px high.
  //  - The Folders setting in the pilot's own notes: "S:Folders" notes in 6000-character parts (SetSetting: the parts
  //    written in order, spare ones removed; GetSetting: read and joined) of "id::type::parent::label|" entries - F a
  //    folder, N a note (its label its noteID); Main (id 1) where there is none. LoadNotesData removes notes whose label
  //    is not I / N / S.
  //  - New Folder / New Note: NamePopup (FolderName / TypeNewFolderName, 20; NoteName / TypeNewNoteLabel, 80), the name
  //    refused with CustomInfo FolderAlreadyExists / NoteAlreadyExists where it is taken; the button's note in no folder
  //    (All Notes only), a group menu's in that folder; a new note shown (AddOwnerNote("N:" + name, "<br>")).
  //  - A group's menu (ListGroup.GetMenu + GroupMenu): Expand / Collapse, Change Label (NamePopup TypeInNewName /
  //    TypeInNewFolderName), Delete Folder (ConfirmDeleteFolder; its folders and entries gone, the notes kept), New
  //    Folder (below sublevel 5), New Note. A note's (NoteItem.GetMenu): in a folder Rename Note, Remove Note (DeleteEntry:
  //    the folder's entry gone); under All Notes Rename Note, Delete Note (DeleteNote: every entry of it and the note).
  //    Delete on a selected note does the same as its Remove / Delete. A note dragged onto a folder goes into it (Shift
  //    keeps it where it was too).
  //  - The note: its icon and title over the editor (EditPlainText, 3900 counted with tags), General Information and
  //    the intro where none is open (read only); kept by EditOwnerNote(noteID, "N:" + label, text) when another is shown,
  //    every 60 s and on leaving (SaveNote; a text over 3900 asks NoteTooLong); the open note remembered (activeNote).
  import { onDestroy, onMount } from "svelte";
  import { plainText } from "../bridge/clientWords.ts";
  import NamePopup from "./NamePopup.svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const N = "UI/Notepad/";
  const SE = "/Carbon/UI/Controls/ScrollEntries/";
  const WORDS = {
    newFolder: `${N}NewFolder`, newNote: `${N}NewNote`, allNotes: `${N}AllNotes`, main: `${N}Main`, general: `${N}GeneralInformation`,
    intro: `${N}NotepadIntro`, folderName: `${N}FolderName`, typeFolderName: `${N}TypeNewFolderName`, noteName: `${N}NoteName`,
    typeNoteLabel: `${N}TypeNewNoteLabel`, folderExists: `${N}FolderAlreadyExists`, noteExists: `${N}NoteAlreadyExists`,
    renameNote: `${N}RenameNote`, removeNote: `${N}RemoveNote`, deleteNote: `${N}DeleteNote`, changeLabel: `${SE}ChangeLabel`,
    deleteFolder: `${SE}DeleteFolder`, typeInNewName: `${SE}TypeInNewName`, typeInNewFolderName: `${SE}TypeInNewFolderName`,
    expand: "UI/Common/Expand", collapse: "UI/Common/Collapse", ok: "UI/Common/Buttons/OK", cancel: "UI/Common/Buttons/Cancel",
    pleaseType: "UI/Common/PleaseTypeSomething",
  } as const;
  const word = (label: string, own: string): string => {
    const t = $words.templates[label];
    return typeof t === "string" && t !== "" ? plainText(t) : own;
  };

  interface FolderEntry { readonly type: string; readonly parent: number; readonly data: string }
  let notes = $state<Map<number, string>>(new Map());
  let folders = $state<Map<number, FolderEntry>>(new Map());
  let lastID = 0;
  let settingIDs: number[] = [];
  let settingText: string | null = null;
  let open = $state<Record<string, boolean>>({});
  let active = $state<number | null>(null);
  /** The nav's selected entry: a folder's id ("F:3"), a note in a folder ("E:7", its folder entry), or one under All
   *  Notes ("A:noteID"). */
  let selected = $state<string | null>(null);
  let text = $state("");
  let saved = "";
  let error = $state("");
  let menu = $state<{ x: number; y: number; items: { label: string; run: () => void }[] } | null>(null);
  let popup = $state<{ caption: string; label: string; value: string; maxLength: number | null; onok: (name: string) => void } | null>(null);
  let navWidth = $state((() => { try { const v = Number(localStorage.getItem("evejs.play.notepadscrollistwidth")); return v >= 100 && v <= 256 ? v : 128; } catch { return 128; } })());
  let root: HTMLElement | undefined = $state();

  /** The client's note text is markup (EditPlainText): its line breaks shown as lines here, and written back. */
  const fromNote = (note: string): string => note.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const toNote = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  const fail = (cause: unknown) => { error = cause instanceof Error ? cause.message : String(cause); };

  async function load(): Promise<void> {
    error = "";
    try {
      const labels = await flow.notepadLabels();
      notes = new Map(labels.filter((l) => l.label.startsWith("N:")).map((l) => [l.noteID, l.label.slice(2)]));
      // LoadNotesData: a note whose label is not an I, N or S note is removed
      for (const bad of labels.filter((l) => !["I", "N", "S"].includes(l.label[0] ?? ""))) void flow.notepadRemoveNote(bad.noteID).catch(() => {});
      settingIDs = labels.filter((l) => l.label === "S:Folders").map((l) => l.noteID).sort((a, b) => a - b);
      let folderText: string | null = null;
      if (settingIDs.length) {
        folderText = "";
        for (const id of settingIDs) folderText += (await flow.notepadNote(id))?.note ?? "";
      }
      settingText = folderText;
      const parsed = new Map<number, FolderEntry>();
      lastID = 0;
      if (folderText !== null) {
        for (const entry of folderText.split("|")) {
          const parts = entry.split("::");
          if (parts.length !== 4) continue;
          const id = Number(parts[0]);
          parsed.set(id, { type: parts[1]!, parent: parts[2] === "None" ? 0 : Number(parts[2]), data: parts[3]! });
          lastID = Math.max(lastID, id);
        }
      } else {
        parsed.set(1, { type: "F", parent: 0, data: word(WORDS.main, "Main") });
        lastID = 1;
      }
      folders = parsed;
      // the note open last (settings.char.notepad activeNote)
      let last: string | null = null;
      try { last = localStorage.getItem("evejs.play.notepad.activeNote"); } catch { /* none */ }
      const lastNote = last?.startsWith("N:") ? Number(last.slice(2)) : NaN;
      if (notes.has(lastNote)) await show(lastNote);
    } catch (cause) { fail(cause); }
  }
  let autosave: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    flow.requestWords(Object.values(WORDS));
    void load();
    autosave = setInterval(() => void saveActive(), 60_000);
    const closeMenu = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(".np-menu")) menu = null; };
    addEventListener("pointerdown", closeMenu, true);
    return () => removeEventListener("pointerdown", closeMenu, true);
  });
  onDestroy(() => { if (autosave) clearInterval(autosave); void saveActive(); });

  /** GetNotes(folderID): the entries directly under it. */
  function entriesOf(folderID: number): [number, FolderEntry][] {
    return [...folders].filter(([, f]) => f.parent === folderID && (f.type === "F" || (f.type === "N" && notes.has(Number(f.data)))))
      .sort((a, b) => labelOf(a[1]).toLowerCase().localeCompare(labelOf(b[1]).toLowerCase()));
  }
  function labelOf(entry: FolderEntry): string {
    return entry.type === "N" ? notes.get(Number(entry.data)) ?? "" : entry.data;
  }
  const allNotes = $derived([...notes].sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase())));

  /** SaveNote: the open note written back where it changed; false where it is too long and the pilot keeps it open. */
  async function saveActive(): Promise<boolean> {
    if (active === null || text === saved) return true;
    const value = toNote(text);
    if (value.length > 3900) return !(await flow.askClientDialogWith("NoteTooLong", { total: String(value.length) }, `The note is ${value.length} characters long. Keep editing?`));
    const label = notes.get(active) ?? "";
    try {
      await flow.notepadEditNote(active, `N:${label}`, value);
      saved = text;
    } catch (cause) { fail(cause); }
    return true;
  }
  async function show(noteID: number | null): Promise<void> {
    if (active === noteID) return;
    if (!(await saveActive())) return;
    active = noteID;
    try { localStorage.setItem("evejs.play.notepad.activeNote", noteID === null ? "" : `N:${noteID}`); } catch { /* not kept */ }
    if (noteID === null) { text = ""; saved = ""; return; }
    const note = await flow.notepadNote(noteID);
    text = fromNote(note?.note.trim() ?? "");
    saved = text;
  }

  /** SaveFolders / SetSetting: the entries in 6000-character parts, the spare parts removed. */
  async function saveFolders(): Promise<void> {
    let value = [...folders].map(([id, f]) => `${id}::${f.type}::${f.parent}::${f.data}|`).join("");
    if (value === settingText) return;
    settingText = value;
    const ids = [...settingIDs];
    const next: number[] = [];
    try {
      while (value.length > 0) {
        const part = value.slice(0, 6000);
        value = value.slice(6000);
        const id = ids.shift();
        if (id !== undefined) { await flow.notepadEditNote(id, "S:Folders", part); next.push(id); }
        else next.push(await flow.notepadAddNote("S:Folders", part));
      }
      await Promise.all(ids.map((id) => flow.notepadRemoveNote(id)));
      settingIDs = next;
    } catch (cause) { fail(cause); }
  }
  function addEntry(parent: number, type: string, data: string): void {
    lastID += 1;
    folders = new Map([...folders, [lastID, { type, parent, data }]]);
  }
  const info = (label: string, own: string) => flow.sayDialog("CustomInfo", { info: word(label, own) }, word(label, own));
  const exists = (type: "F" | "N", name: string) => type === "N" ? [...notes.values()].includes(name) : [...folders.values()].some((f) => f.type === "F" && f.data === name);
  function askName(caption: string, label: string, maxLength: number | null, value = ""): Promise<string | null> {
    return new Promise((resolve) => {
      popup = { caption, label, value, maxLength, onok: (name) => { popup = null; resolve(name); } };
      cancelPopup = () => { popup = null; resolve(null); };
    });
  }
  let cancelPopup = () => { popup = null; };

  async function newFolder(parent: number): Promise<void> {
    const name = await askName(word(WORDS.folderName, "Folder Name"), word(WORDS.typeFolderName, "Type in the new folder name"), 20);
    if (name === null) return;
    if (exists("F", name)) { info(WORDS.folderExists, "A folder with that name already exists."); return; }
    addEntry(parent, "F", name);
    if (parent) open = { ...open, [`F:${parent}`]: true };
    await saveFolders();
  }
  async function newNote(parent: number): Promise<void> {
    const name = await askName(word(WORDS.noteName, "Note Name"), word(WORDS.typeNoteLabel, "Type in the label for the new note"), 80);
    if (name === null) return;
    if (exists("N", name)) { info(WORDS.noteExists, "A note with that name already exists."); return; }
    try {
      const noteID = await flow.notepadAddNote(`N:${name}`, "<br>");
      notes = new Map([...notes, [noteID, name]]);
      if (parent) { addEntry(parent, "N", String(noteID)); open = { ...open, [`F:${parent}`]: true }; await saveFolders(); }
      await show(noteID);
    } catch (cause) { fail(cause); }
  }
  async function renameFolder(id: number): Promise<void> {
    const folder = folders.get(id);
    if (!folder) return;
    const name = await askName(word(WORDS.typeInNewName, "Type in new name"), word(WORDS.typeInNewFolderName, "Type in new folder name"), null, folder.data);
    if (!name) return;
    if (exists("F", name)) { info(WORDS.folderExists, "A folder with that name already exists."); return; }
    folders = new Map([...folders, [id, { ...folder, data: name }]]);
    await saveFolders();
  }
  /** GroupDeleteFolder: its folders deleted in turn, its entries and itself gone (the notes themselves kept). */
  function deleteFolderEntries(id: number, into: Map<number, FolderEntry>): void {
    for (const [childID, child] of [...into]) if (child.parent === id) { if (child.type === "F") deleteFolderEntries(childID, into); else into.delete(childID); }
    into.delete(id);
  }
  async function deleteFolder(id: number): Promise<void> {
    if (!(await flow.askClientDialog("ConfirmDeleteFolder", "Delete this folder?"))) return;
    const next = new Map(folders);
    deleteFolderEntries(id, next);
    folders = next;
    await saveFolders();
  }
  async function renameNote(noteID: number): Promise<void> {
    const name = await askName(word(WORDS.noteName, "Note Name"), word(WORDS.typeNoteLabel, "Type in the label for the new note"), 80, notes.get(noteID) ?? "");
    if (name === null) return;
    if (exists("N", name)) { info(WORDS.noteExists, "A note with that name already exists."); return; }
    try {
      await flow.notepadEditNote(noteID, `N:${name}`);
      notes = new Map([...notes, [noteID, name]]);
    } catch (cause) { fail(cause); }
  }
  /** RemoveFolder: a folder entry gone, asked (DeleteEntry) unless moved. */
  async function removeEntry(entryID: number, ask = true): Promise<void> {
    const entry = folders.get(entryID);
    if (!entry) return;
    if (ask && !(await flow.askClientDialog("DeleteEntry", "Remove this entry?"))) return;
    if (entry.type === "N" && active === Number(entry.data)) await show(null);
    const next = new Map(folders);
    next.delete(entryID);
    folders = next;
    await saveFolders();
  }
  /** DeleteNote: asked (DeleteNote); every entry of it gone, and the note (RemoveOwnerNote). */
  async function deleteNote(noteID: number): Promise<void> {
    if (!(await flow.askClientDialog("DeleteNote", "Delete this note?"))) return;
    if (active === noteID) { saved = text; await show(null); }
    folders = new Map([...folders].filter(([, f]) => !(f.type === "N" && f.data === String(noteID))));
    try {
      await flow.notepadRemoveNote(noteID);
      const next = new Map(notes);
      next.delete(noteID);
      notes = next;
      await saveFolders();
    } catch (cause) { fail(cause); }
  }

  function openMenu(event: MouseEvent, items: { label: string; run: () => void }[]): void {
    event.preventDefault();
    const box = root?.getBoundingClientRect();
    menu = { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0), items };
  }
  function folderMenu(event: MouseEvent, id: number, sublevel: number): void {
    const key = `F:${id}`;
    openMenu(event, [
      open[key] ? { label: word(WORDS.collapse, "Collapse"), run: () => (open = { ...open, [key]: false }) } : { label: word(WORDS.expand, "Expand"), run: () => (open = { ...open, [key]: true }) },
      { label: word(WORDS.changeLabel, "Change Label"), run: () => void renameFolder(id) },
      { label: word(WORDS.deleteFolder, "Delete Folder"), run: () => void deleteFolder(id) },
      ...(sublevel < 5 ? [{ label: word(WORDS.newFolder, "New Folder"), run: () => void newFolder(id) }] : []),
      { label: word(WORDS.newNote, "New Note"), run: () => void newNote(id) },
    ]);
  }
  const allNotesKey = "All Notes";

  // GroupDropNode: a note dropped on a folder goes into it unless it is there already; moved from its folder unless
  // Shift is held
  let dragged: { noteID: number; entryID: number | null } | null = null;
  async function dropOn(folderID: number, event: DragEvent): Promise<void> {
    event.preventDefault();
    const d = dragged;
    dragged = null;
    if (!d) return;
    const already = entriesOf(folderID).some(([, f]) => f.type === "N" && f.data === String(d.noteID));
    if (already) return;
    addEntry(folderID, "N", String(d.noteID));
    open = { ...open, [`F:${folderID}`]: true };
    if (d.entryID !== null && !event.shiftKey) await removeEntry(d.entryID, false);
    else await saveFolders();
  }

  /** OnDelete: the selected note's Remove (in a folder) or Delete (under All Notes); a folder is not deleted so. */
  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Delete" || !selected) return;
    if (selected.startsWith("E:")) void removeEntry(Number(selected.slice(2)));
    else if (selected.startsWith("A:")) void deleteNote(Number(selected.slice(2)));
  }

  // the divider (Divider 100 - 256), kept as notepadscrollistwidth
  function dragDivider(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX, startW = navWidth;
    const move = (m: PointerEvent) => { navWidth = Math.max(100, Math.min(256, startW + m.clientX - startX)); };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      try { localStorage.setItem("evejs.play.notepadscrollistwidth", String(navWidth)); } catch { /* not kept */ }
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }
</script>

{#snippet group(id: number, folder: FolderEntry, level: number)}
  {@const key = `F:${id}`}
  <button type="button" class="np-group" class:sel={selected === key} style={`padding-left: ${level * 16}px`}
    onclick={() => { open = { ...open, [key]: !open[key] }; selected = key; }} oncontextmenu={(e) => { selected = key; folderMenu(e, id, level); }}
    ondragover={(e) => e.preventDefault()} ondrop={(e) => void dropOn(id, e)}>
    <span class="np-arrow">{open[key] ? "▾" : "▸"}</span><img alt="" src="/client-res/ui/texture/eveicon/system_icons/folder_16px.png" />{folder.data} <span class="np-count">[{entriesOf(id).length}]</span>
  </button>
  {#if open[key]}
    {#each entriesOf(id) as [childID, child] (childID)}
      {#if child.type === "F"}{@render group(childID, child, level + 1)}
      {:else}
        {@const noteID = Number(child.data)}
        {@render noteEntry(noteID, `E:${childID}`, level + 1, childID)}
      {/if}
    {/each}
  {/if}
{/snippet}

{#snippet noteEntry(noteID: number, key: string, level: number, entryID: number | null)}
  <button type="button" class="np-note" class:sel={selected === key} class:open-note={active === noteID} style={`padding-left: ${level * 16}px`} draggable="true"
    ondragstart={(e) => { dragged = { noteID, entryID }; e.dataTransfer?.setData("text/plain", notes.get(noteID) ?? ""); }}
    onclick={() => { selected = key; void show(noteID); }}
    oncontextmenu={(e) => { selected = key; openMenu(e, entryID !== null
      ? [{ label: word(WORDS.renameNote, "Rename Note"), run: () => void renameNote(noteID) }, { label: word(WORDS.removeNote, "Remove Note"), run: () => void removeEntry(entryID) }]
      : [{ label: word(WORDS.renameNote, "Rename Note"), run: () => void renameNote(noteID) }, { label: word(WORDS.deleteNote, "Delete Note"), run: () => void deleteNote(noteID) }]); }}>
    <img alt="" src="/client-res/ui/texture/windowicons/note.png" />{notes.get(noteID) ?? ""}
  </button>
{/snippet}

<section class="panel notepad" bind:this={root}>
  {#if error}<p class="error">{error}</p>{/if}
  <div class="np-body">
    <nav class="np-nav" style:flex-basis={`${navWidth}px`}>
      <div class="np-list" role="tree" tabindex="-1" onkeydown={onKey}>
        {#each entriesOf(0).filter(([, f]) => f.type === "F") as [id, folder] (id)}{@render group(id, folder, 0)}{/each}
        <button type="button" class="np-group" onclick={() => (open = { ...open, [allNotesKey]: !open[allNotesKey] })}>
          <span class="np-arrow">{open[allNotesKey] ? "▾" : "▸"}</span><img alt="" src="/client-res/ui/texture/windowicons/notegroup.png" />{word(WORDS.allNotes, "All Notes")} <span class="np-count">[{notes.size}]</span>
        </button>
        {#if open[allNotesKey]}
          {#each allNotes as [noteID] (noteID)}{@render noteEntry(noteID, `A:${noteID}`, 1, null)}{/each}
        {/if}
      </div>
      <div class="np-buttons">
        <button type="button" onclick={() => void newFolder(0)}>{word(WORDS.newFolder, "New Folder")}</button>
        <button type="button" onclick={() => void newNote(0)}>{word(WORDS.newNote, "New Note")}</button>
      </div>
    </nav>
    <div class="np-divider" role="separator" aria-orientation="vertical" onpointerdown={dragDivider}></div>
    <div class="np-note-pane">
      <div class="np-title">
        <img alt="" src={active === null ? "/client-res/ui/texture/windowicons/notepad.png" : "/client-res/ui/texture/windowicons/note.png"} />
        <span>{active === null ? word(WORDS.general, "General Information") : notes.get(active) ?? ""}</span>
      </div>
      {#if active === null}
        <p class="np-intro">{word(WORDS.intro, "")}</p>
      {:else}
        <textarea bind:value={text} maxlength="3900" onblur={() => void saveActive()}></textarea>
      {/if}
    </div>
  </div>
  {#if menu}
    <div class="np-menu" role="menu" style:left={`${menu.x}px`} style:top={`${menu.y}px`}>
      {#each menu.items as item (item.label)}
        <button type="button" role="menuitem" onclick={() => { const run = item.run; menu = null; run(); }}>{item.label}</button>
      {/each}
    </div>
  {/if}
  {#if popup}
    <div class="np-popup">
      <NamePopup caption={popup.caption} label={popup.label} value={popup.value} maxLength={popup.maxLength}
        refusal={word(WORDS.pleaseType, "Please type something")} okWord={word(WORDS.ok, "OK")} cancelWord={word(WORDS.cancel, "Cancel")}
        onok={popup.onok} oncancel={() => cancelPopup()} />
    </div>
  {/if}
</section>

<style>
  .notepad { position: relative; height: 100%; display: flex; flex-direction: column; min-width: 350px; min-height: 200px; }
  .np-body { flex: 1; display: flex; min-height: 0; }
  .np-nav { flex: 0 0 128px; display: flex; flex-direction: column; min-width: 0; }
  .np-divider { flex: 0 0 4px; cursor: ew-resize; }
  .np-list { flex: 1; overflow: auto; display: flex; flex-direction: column; outline: none; }
  .np-group, .np-note { display: flex; align-items: center; gap: 2px; text-align: left; background: none; border: 0; color: inherit; font-size: 12px;
    height: 17px; padding: 0; white-space: nowrap; overflow: hidden; cursor: pointer; flex: 0 0 auto; }
  .np-note { height: 18px; }
  .np-group img { width: 16px; height: 16px; }
  .np-note img { width: 24px; height: 24px; margin: -3px 0; }
  .np-arrow { width: 12px; text-align: center; font-size: 10px; opacity: 0.7; }
  .np-group.sel, .np-note.sel { background: rgba(255, 255, 255, 0.12); }
  .np-count { opacity: 0.5; }
  .np-buttons { display: flex; flex-direction: column; gap: 4px; padding-top: 4px; }
  .np-buttons button { font-size: 12px; padding: 3px 6px; }
  .np-note-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .np-title { display: flex; align-items: flex-start; gap: 8px; height: 48px; font-size: 13px; }
  .np-title span { padding-top: 5px; }
  .np-title img { width: 32px; height: 32px; }
  .np-intro { font-size: 12px; opacity: 0.8; white-space: pre-wrap; }
  .np-note-pane textarea { flex: 1; resize: none; font-size: 12px; min-height: 120px; }
  .np-menu { position: absolute; z-index: 6; display: flex; flex-direction: column; min-width: 140px; padding: 4px 0;
    background: rgba(20, 22, 24, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); }
  .np-menu button { all: unset; padding: 3px 12px; font-size: 12px; cursor: default; white-space: nowrap; }
  .np-menu button:hover { background: rgba(255, 255, 255, 0.1); }
  .np-popup { position: absolute; inset: 0; z-index: 7; display: grid; place-items: center; background: rgba(0, 0, 0, 0.35); }
</style>
