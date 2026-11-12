<script lang="ts">
  // The client's Notepad (neocom/notepad.py NotepadWindow: 400 x 300, caption UI/Notepad/Notepad). Its nav at the left,
  // notepadscrollistwidth 128 wide: the folders as list groups - the Folders setting the client keeps in the pilot's own
  // notes (a note labelled "S:Folders" holding "id::type::parent::label|" entries; type F a folder, N a note whose label
  // is its noteID; Main, id 1, where there is none) - then the locked All Notes group of every note; New Folder and New
  // Note at the bottom. At the right the note: its icon and title over the editor (EditPlainText, at most 3900), the
  // General Information intro where no note is open; a note's text kept by charMgr.EditOwnerNote(noteID, "N:" + label,
  // text) as the client's SaveNote does when the note is left. A new note: AddOwnerNote("N:" + name, "<br>") and its
  // place in the folder chosen (Main where none), the Folders setting written back (SetSetting / SaveFolders).
  import { onMount } from "svelte";
  import { plainText } from "../bridge/clientWords.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const WORDS = {
    newFolder: "UI/Notepad/NewFolder", newNote: "UI/Notepad/NewNote", allNotes: "UI/Notepad/AllNotes", main: "UI/Notepad/Main",
    general: "UI/Notepad/GeneralInformation", intro: "UI/Notepad/NotepadIntro", folderName: "UI/Notepad/FolderName",
  } as const;
  const word = (label: string, own: string): string => {
    const t = $words.templates[label];
    return typeof t === "string" && t !== "" ? plainText(t) : own;
  };

  interface FolderEntry { id: number; type: string; parent: number; data: string }
  let notes = $state<Map<number, string>>(new Map());
  let folders = $state<FolderEntry[]>([]);
  let foldersNoteID = $state<number | null>(null);
  let open = $state<Record<number, boolean>>({ 1: true });
  let allOpen = $state(false);
  let active = $state<number | null>(null);
  let activeFolder = $state<number>(1);
  let text = $state("");
  let saved = "";
  let error = $state("");
  let naming = $state<"note" | "folder" | null>(null);
  let name = $state("");

  /** The client's note text is markup (EditPlainText): its line breaks shown as lines here, and written back. */
  const fromNote = (note: string): string => note.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const toNote = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

  async function load(): Promise<void> {
    error = "";
    try {
      const labels = await flow.notepadLabels();
      notes = new Map(labels.filter((l) => l.label.startsWith("N:")).map((l) => [l.noteID, l.label.slice(2)]));
      const setting = labels.filter((l) => l.label === "S:Folders").map((l) => l.noteID).sort((a, b) => a - b);
      foldersNoteID = setting[0] ?? null;
      let folderText = "";
      for (const id of setting) folderText += (await flow.notepadNote(id))?.note ?? "";
      const parsed: FolderEntry[] = [];
      for (const entry of folderText.split("|")) {
        const parts = entry.split("::");
        if (parts.length !== 4) continue;
        parsed.push({ id: Number(parts[0]), type: parts[1]!, parent: parts[2] === "None" ? 0 : Number(parts[2]), data: parts[3]! });
      }
      folders = parsed.length ? parsed : [{ id: 1, type: "F", parent: 0, data: word(WORDS.main, "Main") }];
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  onMount(() => {
    flow.requestWords(Object.values(WORDS));
    void load();
  });

  const topFolders = $derived(folders.filter((f) => f.type === "F" && f.parent === 0).sort((a, b) => a.data.localeCompare(b.data)));
  function childrenOf(folderID: number): FolderEntry[] {
    return folders.filter((f) => f.parent === folderID && (f.type === "F" || (f.type === "N" && notes.has(Number(f.data)))))
      .sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  }
  function labelOf(entry: FolderEntry): string {
    return entry.type === "N" ? notes.get(Number(entry.data)) ?? "" : entry.data;
  }

  async function saveActive(): Promise<void> {
    if (active === null || text === saved) return;
    const label = notes.get(active) ?? "";
    const value = text;
    try {
      await flow.notepadEditNote(active, `N:${label}`, toNote(value));
      saved = value;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  async function show(noteID: number): Promise<void> {
    if (active === noteID) return;
    await saveActive();
    active = noteID;
    const note = await flow.notepadNote(noteID);
    text = fromNote(note?.note.trim() ?? "");
    saved = text;
  }

  async function writeFolders(): Promise<void> {
    const value = folders.map((f) => `${f.id}::${f.type}::${f.parent}::${f.data}|`).join("");
    if (foldersNoteID === null) foldersNoteID = await flow.notepadAddNote("S:Folders", value);
    else await flow.notepadEditNote(foldersNoteID, "S:Folders", value);
  }
  async function create(): Promise<void> {
    const what = naming;
    const label = name.trim();
    naming = null;
    name = "";
    if (!label || what === null) return;
    try {
      const nextID = Math.max(1, ...folders.map((f) => f.id)) + 1;
      if (what === "folder") {
        folders = [...folders, { id: nextID, type: "F", parent: 0, data: label }];
      } else {
        const noteID = await flow.notepadAddNote(`N:${label}`, "<br>");
        notes = new Map([...notes, [noteID, label]]);
        folders = [...folders, { id: nextID, type: "N", parent: activeFolder, data: String(noteID) }];
        open = { ...open, [activeFolder]: true };
      }
      await writeFolders();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
</script>

{#snippet group(folder: FolderEntry, level: number)}
  <button type="button" class="np-group" class:sel={activeFolder === folder.id} style={`padding-left: ${4 + level * 12}px`}
    onclick={() => { open = { ...open, [folder.id]: !open[folder.id] }; activeFolder = folder.id; }}>
    {open[folder.id] ? "▾" : "▸"} {folder.data} <span class="np-count">[{childrenOf(folder.id).length}]</span>
  </button>
  {#if open[folder.id]}
    {#each childrenOf(folder.id) as child (child.id)}
      {#if child.type === "F"}{@render group(child, level + 1)}
      {:else}
        <button type="button" class="np-note" class:sel={active === Number(child.data)} style={`padding-left: ${16 + level * 12}px`}
          onclick={() => void show(Number(child.data))}>{labelOf(child)}</button>
      {/if}
    {/each}
  {/if}
{/snippet}

<section class="panel notepad">
  {#if error}<p class="error">{error}</p>{/if}
  <div class="np-body">
    <nav class="np-nav">
      <div class="np-list">
        {#each topFolders as folder (folder.id)}{@render group(folder, 0)}{/each}
        <button type="button" class="np-group" onclick={() => (allOpen = !allOpen)}>{allOpen ? "▾" : "▸"} {word(WORDS.allNotes, "All Notes")} <span class="np-count">[{notes.size}]</span></button>
        {#if allOpen}
          {#each [...notes].sort((a, b) => a[1].localeCompare(b[1])) as [noteID, label] (noteID)}
            <button type="button" class="np-note" class:sel={active === noteID} style="padding-left: 16px" onclick={() => void show(noteID)}>{label}</button>
          {/each}
        {/if}
      </div>
      {#if naming !== null}
        <form class="np-name" onsubmit={(event) => { event.preventDefault(); void create(); }}>
          <input bind:value={name} maxlength={naming === "folder" ? 20 : 100} placeholder={naming === "folder" ? word(WORDS.folderName, "Folder name") : ""} />
        </form>
      {/if}
      <div class="np-buttons">
        <button type="button" onclick={() => { naming = "folder"; name = ""; }}>{word(WORDS.newFolder, "New Folder")}</button>
        <button type="button" onclick={() => { naming = "note"; name = ""; }}>{word(WORDS.newNote, "New Note")}</button>
      </div>
    </nav>
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
</section>

<style>
  .notepad { height: 100%; display: flex; flex-direction: column; }
  .np-body { flex: 1; display: flex; gap: 4px; min-height: 0; }
  .np-nav { flex: 0 0 128px; display: flex; flex-direction: column; min-width: 0; }
  .np-list { flex: 1; overflow: auto; display: flex; flex-direction: column; }
  .np-group, .np-note { text-align: left; background: none; border: 0; color: inherit; font-size: 12px; height: 17px; padding: 0 4px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .np-group.sel, .np-note.sel { background: rgba(255, 255, 255, 0.1); }
  .np-count { opacity: 0.5; }
  .np-buttons { display: flex; flex-direction: column; gap: 4px; padding-top: 4px; }
  .np-buttons button { font-size: 12px; padding: 3px 6px; }
  .np-name input { width: 100%; box-sizing: border-box; font-size: 12px; }
  .np-note-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .np-title { display: flex; align-items: center; gap: 6px; height: 48px; font-size: 16px; }
  .np-title img { width: 32px; height: 32px; }
  .np-intro { font-size: 12px; opacity: 0.8; white-space: pre-wrap; }
  .np-note-pane textarea { flex: 1; resize: none; font-size: 12px; min-height: 120px; }
</style>
