<script lang="ts">
  // Character Sheet page (goal R56): who this character is — name, security
  // status, corporation, alliance, home station, bio and the active clone's
  // implants. A pure reader of the store; the read lives in app/flow.ts
  // (loadCharacterSheet) and the BFF holds the session.
  //
  // ⚠ R7d is the whole point. Every id is turned into a NAME by resolvedName,
  // which NEVER returns the raw number: corporationID / allianceID / home
  // stationID / implant typeIDs all resolve through /api/names, and an id static
  // data cannot name (a PLAYER corporation — Farmer's own corp does exactly this)
  // degrades to a plain "Unknown …" label, not the id. securityStatus is a float
  // shown as-is; bloodline / race / ancestry have no name path and are not read
  // at all.
  //
  // ⚠ empty vs failed, per section. Each field is null while unread OR when its
  // read FAILED (the reason rides in the matching *Error); an empty bio ("") and
  // a clean clone (no implants) are REAL answers shown honestly, not failures.
  //
  // The skill history is the client's History panel's skills tab (bridge/skillHistoryPanel.ts): the date, the
  // skill, what happened and the level, the newest first, in the client's own words where the player's install
  // has them.
  import { getContext, onMount } from "svelte";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { formatSecurityStatus } from "../bridge/characterSheet.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { EMPLOYMENT_WORD_LABELS, type EmploymentLine } from "../bridge/employmentHistory.ts";
  import {
    SKILL_HISTORY_DATE_LABEL,
    SKILL_HISTORY_HEADER_LABELS,
    SKILL_HISTORY_OWN_ACTION_WORDS,
    SKILL_HISTORY_WORD_LABELS,
    skillHistoryActionLabel,
  } from "../bridge/skillHistoryPanel.ts";
  import { resolvedName } from "../store/names.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import ExpertSystems from "./ExpertSystems.svelte";
  import Standings from "./Standings.svelte";
  import { sheetPanelRequest, type SheetPanel } from "./characterSheetPanels.ts";

  // The client's Character Sheet's tabs (characterSheetWindow.GetMainTabData; charsheet GetPanelName): Character,
  // Interactions, PLEX, Personalization and History, of which the page has Character (characterPanel: Home Station,
  // Implants & Boosters, Bio, Expert Systems of its tabs), Interactions (interactionsPanel: Standings, the pilot's
  // standings panel, of its tabs) and History (historyPanel: Employment History and Skill History).
  type SheetTab = "character" | "interactions" | "history";

  /** The tabs' names, with the page's own words where the install's are not had. */
  const TAB_WORDS: Readonly<Record<string, string>> = {
    "Tooltips/CharacterSheet/Character": "Character",
    "Tooltips/CharacterSheet/Interactions": "Dealings",
    "Tooltips/CharacterSheet/History": "Past",
    "Tooltips/CharacterSheet/HomeStation": "Home",
    "Tooltips/CharacterSheet/Augmentations": "Implants",
    "Tooltips/CharacterSheet/Bio": "Bio",
    "Tooltips/CharacterSheet/ExpertSystems": "Expert systems",
    "Tooltips/CharacterSheet/EmploymentHistory": "Corporations",
    "Tooltips/CharacterSheet/Skills": "Skills trained",
    "Tooltips/CharacterSheet/Standings": "Standing",
  };
  const tabWord = (label: string): string => {
    const template = $words.templates[label];
    return typeof template === "string" ? template : TAB_WORDS[label] ?? "";
  };

  let { store, flow, panel = null }: { store: ClientStore; flow: AppFlow; panel?: SheetPanel | null } = $props();
  // svelte-ignore state_referenced_locally
  const opening = panel;
  let sheetTab = $state<SheetTab>(opening === "standings" ? "interactions" : opening === "employment" || opening === "skills" ? "history" : "character");
  let characterTab = $state<"home" | "implants" | "bio" | "expert">(opening === "implants" || opening === "bio" || opening === "expert" ? opening : "home");
  let historyTab = $state<"employment" | "skills">(opening === "skills" ? "skills" : "employment");
  /** _StartLoadingPanel: a panel asked for while the window is open, or as it opens (characterSheetPanels.ts). */
  function loadPanel(panel: SheetPanel): void {
    if (panel === "standings") {
      sheetTab = "interactions";
    } else if (panel === "employment" || panel === "skills") {
      sheetTab = "history";
      historyTab = panel;
    } else {
      sheetTab = "character";
      characterTab = panel;
    }
  }
  $effect(() => {
    const asked = $sheetPanelRequest;
    if (asked === null) return;
    loadPanel(asked);
    sheetPanelRequest.set(null);
  });

  // svelte-ignore state_referenced_locally
  const sheet = store.characterSheet;
  /**
   * On the play page the window as CharacterSheetWindow lays it out (characterSheetWindow.py: 1235 x 768; the leftCont
   * LEFT_SIDE_WIDTH_EXPANDED 340 - characterOverviewPanel.CharacterSheetCharacterOverviewPanel: the pilot's picture
   * behind, the caption CharacterSheetCaption at the top, the name over a divider, then Born, Total Net Worth,
   * Security Status, Home Station, Total Skill Points (CHAR_INFO_ELEMENT_HEIGHT rows: a title over a value), the
   * corporation's and alliance's icons and Skills at the bottom; the panels at the right under the header's tabs).
   * The page's identity, security status and home station fill it; Born, Net Worth and Skill Points are not read.
   */
  const retail = getContext("retailChrome") === true;
  const imageServer = flow.imageServer;
  const CS_WORDS = ["UI/CharacterSheet/CharacterSheetWindow/CharacterSheetCaption", "UI/CharacterSheet/CharacterSheetWindow/SecurityStatusTitle",
    "UI/CharacterSheet/CharacterSheetWindow/HomeStationTitle", "UI/CharacterSheet/CharacterSheetWindow/SkillTabs/Skills"];
  $effect(() => { if (retail) { flow.requestWords(CS_WORDS); flow.loadImageServer(); } });
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;

  let busy = $state(false);
  let error = $state("");

  async function run(action: () => Promise<void> | void): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        return;
      }
      error =
        panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }

  function refresh(): void {
    void run(async () => {
      await Promise.all([flow.loadCharacterSheet(), flow.loadSkillHistory(), flow.loadEmploymentHistory()]);
    });
  }

  onMount(() => {
    flow.requestWords([...SKILL_HISTORY_WORD_LABELS, ...Object.values(EMPLOYMENT_WORD_LABELS), ...Object.keys(TAB_WORDS)]);
    refresh();
  });

  /** The client's word for a label, from the player's install; the page's own where there is none to read. */
  function word(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? template : own;
  }

  /** FmtDate(logDate, 'ls'): the client's label with the date in it; the game's date and time plainly without it. */
  function historyDate(logDate: string): string {
    return formatTemplate(word(SKILL_HISTORY_DATE_LABEL, "{[datetime]datetime}"), { datetime: logDate }, {
      nameOf: (kind, id) => resolvedName($names.resolved, kind, id, ""),
    });
  }

  /** A client's template filled, in the page's own words where the install has none. */
  function filled(label: string, own: string, args: Record<string, string | number>): string {
    return formatTemplate(word(label, own), args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  }

  /**
   * A line of the employment tab as the client makes it (infosvc.py 2849 to 2864): the corporation, "(Closed)"
   * beside a closed one, from its date to the next's or to this day, and the days between.
   */
  function employmentText(line: EmploymentLine): string {
    const name = resolvedName($names.resolved, "corporation", line.corporationID, "Unknown corporation");
    const corpName = line.deleted ? filled(EMPLOYMENT_WORD_LABELS.closed, "{corpName} (Closed)", { corpName: name }) : name;
    const fromDate = historyDate(line.fromDate);
    const text = line.toDate === null
      ? filled(EMPLOYMENT_WORD_LABELS.toThisDay, "{corpName} {fromDate} to this day", { corpName, fromDate })
      : filled(EMPLOYMENT_WORD_LABELS.fromTo, "{corpName} {fromDate} to {toDate}", { corpName, fromDate, toDate: historyDate(line.toDate) });
    const days = filled(EMPLOYMENT_WORD_LABELS.days, "{numDays} days", { numDays: line.days }).trim();
    return plainText(`${text} (${days})`);
  }

  /** A transfer as the client lists it (infosvc.py 2887): the label given the date itself, which it formats. */
  function transferText(date: string): string {
    return plainText(filled(EMPLOYMENT_WORD_LABELS.transferredOn, "Transferred {[datetime]transferDate}", { transferDate: date }));
  }

  // The security-status colour band, matching the retail scale: positive is
  // lawful (good), negative is an outlaw (bad), exactly 0 is neutral.
  function securityTone(status: number): "good" | "bad" | "neutral" {
    if (status > 0) {
      return "good";
    }
    if (status < 0) {
      return "bad";
    }
    return "neutral";
  }
</script>

<section class="panel" class:cs-retail={retail}>
  <!-- ⚠ REFRESH LIVES IN THE STRIP, NOT AT THE BOTTOM OF THE PAGE. It used
       to be a bare <p><button> after the last section, so this window put its
       one action somewhere no other window puts one — below content of
       unpredictable length, which on a full read meant scrolling past
       everything to reach it. Nothing was added or taken away; the control
       moved to the band every other window keeps its controls in. -->
  <header class="panel-head">
    <h2 class="panel-title">Character Sheet</h2>
    <span class="controls">
      <button type="button" disabled={busy} onclick={refresh}>Refresh</button>
    </span>
  </header>

  {#if error}
    <p class="error">Could not read your character sheet: {error}</p>
  {/if}

  <!-- Identity: name, corporation, alliance, security status. -->
  {#if $sheet.identityError}
    <p class="error">{$sheet.identityError}</p>
  {:else if $sheet.identity === null}
    <p class="empty">Reading your character…</p>
  {:else}
    <h3 class="name">{$sheet.identity.characterName}</h3>
    <dl class="facts">
      <div>
        <dt>Corporation</dt>
        <dd>
          {resolvedName(
            $names.resolved,
            "corporation",
            $sheet.identity.corporationID,
            "Unknown corporation",
          )}
        </dd>
      </div>
      {#if $sheet.identity.allianceID !== null}
        <div>
          <dt>Alliance</dt>
          <dd>
            {resolvedName(
              $names.resolved,
              "alliance",
              $sheet.identity.allianceID,
              "Unknown alliance",
            )}
          </dd>
        </div>
      {/if}
      <div>
        <dt>Security status</dt>
        <dd class="value {securityTone($sheet.identity.securityStatus)}">
          {formatSecurityStatus($sheet.identity.securityStatus)}
        </dd>
      </div>
    </dl>
  {/if}
  {#if retail && $sheet.identity}
    {@const portrait = portraitUrl($imageServer, $sheet.identity.characterID, 512) ?? clientTexture(portraitDefaultPath(512))}
    <aside class="cs-left" style={portrait ? `--portrait: url(${portrait})` : undefined}>
      <span class="cap">{tabWord("UI/CharacterSheet/CharacterSheetWindow/CharacterSheetCaption")}</span>
      <div class="info">
        <b class="nm">{$sheet.identity.characterName}</b>
        <span class="div"></span>
        <span class="row"><small>{tabWord("UI/CharacterSheet/CharacterSheetWindow/SecurityStatusTitle")}</small>
          <span class={securityTone($sheet.identity.securityStatus)}>{formatSecurityStatus($sheet.identity.securityStatus)}</span></span>
        <span class="row"><small>{tabWord("UI/CharacterSheet/CharacterSheetWindow/HomeStationTitle")}</small>
          <span>{$sheet.homeStationID !== null ? resolvedName($names.resolved, "station", $sheet.homeStationID, "") : ""}</span></span>
      </div>
      <div class="bottom">
        <span>{resolvedName($names.resolved, "corporation", $sheet.identity.corporationID, "")}{#if $sheet.identity.allianceID !== null} · {resolvedName($names.resolved, "alliance", $sheet.identity.allianceID, "")}{/if}</span>
      </div>
    </aside>
  {/if}
  <div class="cs-main">

  <!-- The window's tabs, then the tab's own. -->
  <nav class="sheet-tabs" aria-label="Character Sheet">
    {#each [["character", "Tooltips/CharacterSheet/Character"], ["interactions", "Tooltips/CharacterSheet/Interactions"], ["history", "Tooltips/CharacterSheet/History"]] as [id, label] (id)}
      <button type="button" class:active={sheetTab === id} aria-pressed={sheetTab === id} onclick={() => (sheetTab = id as SheetTab)}>{tabWord(label!)}</button>
    {/each}
  </nav>
  {#if sheetTab === "character"}
  <nav class="sheet-tabs sub" aria-label="Character">
    {#each [["home", "Tooltips/CharacterSheet/HomeStation"], ["implants", "Tooltips/CharacterSheet/Augmentations"], ["bio", "Tooltips/CharacterSheet/Bio"], ["expert", "Tooltips/CharacterSheet/ExpertSystems"]] as [id, label] (id)}
      <button type="button" class:active={characterTab === id} aria-pressed={characterTab === id} onclick={() => (characterTab = id as typeof characterTab)}>{tabWord(label!)}</button>
    {/each}
  </nav>
  {#if characterTab === "home"}
  <!-- Home station (the medical-clone home), by name. -->
  <h3>Home station</h3>
  {#if $sheet.homeStationError}
    <p class="error">{$sheet.homeStationError}</p>
  {:else if $sheet.homeStationID === null}
    <p class="empty">Reading your home station…</p>
  {:else}
    <p>{resolvedName($names.resolved, "station", $sheet.homeStationID, "Unknown station")}</p>
  {/if}

  {/if}
  {#if characterTab === "bio"}
  <!-- Bio. An empty bio is a real answer, not a failure. -->
  <h3>Bio</h3>
  {#if $sheet.descriptionError}
    <p class="error">{$sheet.descriptionError}</p>
  {:else if $sheet.description === null}
    <p class="empty">Reading your bio…</p>
  {:else if $sheet.description.trim() === ""}
    <p class="empty">You have not written a bio.</p>
  {:else}
    <p class="bio">{$sheet.description}</p>
  {/if}

  {/if}
  {#if characterTab === "implants"}
  <!-- Active clone's implants, by name. A clean clone is a real answer. -->
  <h3>Implants</h3>
  {#if $sheet.cloneError}
    <p class="error">{$sheet.cloneError}</p>
  {:else if $sheet.clone === null}
    <p class="empty">Reading your clone…</p>
  {:else if $sheet.clone.implants.length === 0}
    <p class="empty">Your active clone has no implants.</p>
  {:else}
    <ul class="implants">
      {#each $sheet.clone.implants as implant (implant.typeID)}
        <li>{resolvedName($names.resolved, "type", implant.typeID, "Unknown implant")}</li>
      {/each}
    </ul>
  {/if}

  {/if}
  {#if characterTab === "expert"}
  <!-- The character panel's Expert Systems tab (characterPanel.py: expertSystems.ExpertSystemsPanel). -->
  <ExpertSystems {store} {flow} />
  {/if}
  {/if}
  {#if sheetTab === "history"}
  <nav class="sheet-tabs sub" aria-label="History">
    {#each [["employment", "Tooltips/CharacterSheet/EmploymentHistory"], ["skills", "Tooltips/CharacterSheet/Skills"]] as [id, label] (id)}
      <button type="button" class:active={historyTab === id} aria-pressed={historyTab === id} onclick={() => (historyTab = id as typeof historyTab)}>{tabWord(label!)}</button>
    {/each}
  </nav>
  {#if historyTab === "employment"}
  <!-- The employment history, as the client's History panel's employment tab lists it (its first tab). -->
  <h3>Employment history</h3>
  {#if $sheet.employmentHistoryError}
    <p class="error">{$sheet.employmentHistoryError}</p>
  {:else if $sheet.employmentHistory === null}
    <p class="empty">Reading your employment history…</p>
  {:else}
    <ul class="employment-history">
      {#each $sheet.employmentHistory.lines as line, place (place)}
        <li>{employmentText(line)}</li>
      {/each}
    </ul>
    {#if $sheet.employmentHistory.transfers.length > 0}
      <h4>{plainText(word(EMPLOYMENT_WORD_LABELS.transfers, "Character Transfers"))}</h4>
      <ul class="employment-history">
        {#each $sheet.employmentHistory.transfers as date, place (place)}
          <li>{transferText(date)}</li>
        {/each}
      </ul>
    {/if}
  {/if}

  {/if}
  {#if historyTab === "skills"}
  <!-- The skill history, as the client's History panel's skills tab lists it. No rows is a real answer. -->
  <h3>Skill history</h3>
  {#if $sheet.skillHistoryError}
    <p class="error">{$sheet.skillHistoryError}</p>
  {:else if $sheet.skillHistory === null}
    <p class="empty">Reading your skill history…</p>
  {:else if $sheet.skillHistory.length === 0}
    <p class="empty">{word(SKILL_HISTORY_HEADER_LABELS.none, "No records found.")}</p>
  {:else}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow skill-history">
        <thead>
          <tr>
            <th>{word(SKILL_HISTORY_HEADER_LABELS.date, "Date")}</th>
            <th>{word(SKILL_HISTORY_HEADER_LABELS.skill, "Skill")}</th>
            <th>{word(SKILL_HISTORY_HEADER_LABELS.action, "Action")}</th>
            <th>{word(SKILL_HISTORY_HEADER_LABELS.level, "Level")}</th>
          </tr>
        </thead>
        <tbody>
          {#each $sheet.skillHistory as line, place (place)}
            <tr>
              <td class="value">{historyDate(line.logDate)}</td>
              <td>{resolvedName($names.resolved, "type", line.skillTypeID, "Unknown skill")}</td>
              <td>{word(skillHistoryActionLabel(line.eventTypeID), SKILL_HISTORY_OWN_ACTION_WORDS[line.eventTypeID] ?? "Unknown")}</td>
              <td class="value">{line.level}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {/if}
  {/if}
  {#if sheetTab === "interactions"}
  <nav class="sheet-tabs sub" aria-label="Interactions">
    <button type="button" class="active" aria-pressed="true">{tabWord("Tooltips/CharacterSheet/Standings")}</button>
  </nav>
  <!-- interactionsPanel's Standings: the pilot's standings panel (toID the pilot). -->
  <Standings {store} {flow} scopes={["char"]} />
  {/if}
  </div>

</section>

<style>
  .sheet-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin: 0.5rem 0;
    border-bottom: 1px solid var(--color-line);
  }
  .sheet-tabs.sub {
    border-bottom: 0;
    margin-top: 0;
  }
  .sheet-tabs button {
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    font: inherit;
    color: var(--color-muted);
  }
  .sheet-tabs button.active {
    color: var(--color-text-bright);
    border-bottom-color: var(--color-accent);
  }
  .name {
    margin-bottom: 0.25rem;
  }
  dl.facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0 0 0.75rem 0;
  }
  dl.facts > div {
    display: contents;
  }
  dl.facts dt {
    color: rgba(128, 128, 128, 0.9);
  }
  dl.facts dd {
    margin: 0;
  }
  .value {
    font-variant-numeric: tabular-nums;
  }
  .bio {
    white-space: pre-wrap;
    max-width: 48rem;
  }
  ul.implants {
    list-style: none;
    margin: 0 0 0.75rem 0;
    padding: 0;
  }
  ul.implants li {
    padding: 0.35rem 0.5rem;
    min-height: 40px;
    display: flex;
    align-items: center;
    border-bottom: 1px solid rgba(128, 128, 128, 0.25);
  }
  .empty {
    color: rgba(128, 128, 128, 0.9);
  }
  /* ⚠ NO LOCAL `button` RULE HERE. It set `min-height: 40px` — which is
     exactly what the shared button already is (R8's touch minimum, 2.5rem in
     styles.css), so it changed nothing a player could see. What it did do,
     being a component-scoped rule, was outrank the layered stylesheet: this
     panel's Refresh ignored the strip's own sizing and left the Character
     Sheet window standing 10px taller than every other window's strip. A
     per-panel restatement of a shared rule costs nothing until the shared
     rule changes, and then it is the one panel that does not follow. */
  .good {
    color: #2e7d32;
  }
  .bad {
    color: #c62828;
  }
  @media (prefers-color-scheme: dark) {
    .good {
      color: #7fce82;
    }
    .bad {
      color: #ef8a8a;
    }
  }
</style>
