<script lang="ts">
  import { untrack } from "svelte";
  // Create a character. Reached from the select screen, and the only way off it
  // on an account with no characters at all.
  //
  // THE PLAYER PICKS FOUR THINGS: race, ancestry, gender, name. Everything else
  // the server decides, and there is a great deal of it — starter corporation,
  // station, rookie ship, 100k ISK, PLEX, 50k SP, attributes, employment
  // history, welcome mail, tutorial state. This screen deliberately does not
  // offer any of that, because none of it is a choice the world would honor.
  //
  // ANCESTRY, NOT BLOODLINE. Retail asks for both; the ancestries here are
  // GROUPED under their bloodline, so picking one names the bloodline too. That
  // is the id the write actually sends — CreateCharacterWithDoll derives race,
  // corp, station and rookie ship from the bloodline — so the grouping is not
  // decoration, it is the thing being chosen. An ancestry is preselected at
  // random so a player who does not care can ignore the whole column.
  //
  // THE NAME IS THE SERVER'S CALL. ValidateNameEx runs as the player types
  // (debounced) so a refusal — including "already taken", which no client-side
  // rule could know — arrives before they commit rather than after. It is still
  // only an early warning: the create runs the same validation server-side and
  // has the last word.
  import {
    loadCharCreationInfo,
    rollRandomCharacterName,
    validateCharacterName,
    loadCharacterCreationState,
    type CharacterCreationState,
  } from "../app/api.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { creationNeedsRecovery } from "../app/characterCreationSafety.ts";
  import {
    bloodlineChoicesForRace,
    bloodlineForAncestry,
    nameValidationMessage,
    type BloodlineChoice,
    type CharCreationTables,
  } from "../bridge/charCreation.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { factionIcon } from "./skillPlanIcons.ts";

  let { flow, onCancel, onCreated, initialName = "", flight = false }: {
    flow: Pick<AppFlow, "requestOptions" | "createCharacter">;
    /** Back to the character list without creating anything. */
    onCancel: () => void;
    /** The new pilot exists and the roster has been re-read. */
    onCreated: (characterID: number | null) => void;
    /** Convenience prefill only; normal name validation is unchanged. */
    initialName?: string;
    flight?: boolean;
  } = $props();

  let tables = $state<CharCreationTables | null>(null);
  let loadError = $state("");

  let raceID = $state(0);
  let ancestryID = $state(0);
  let chosenBloodlineID = $state<number | null>(null);
  let genderID = $state(1);
  let name = $state(untrack(() => initialName));

  let nameCode = $state<number | null>(null);
  let nameChecking = $state(false);
  // chooseNameSection.namesChecked: each name the screen has had an answer for, and the answer, so that a name is
  // asked about once; a name rolled is kept as valid (RandomizeName, CacheNameValid(name, True)). How many there are
  // goes with each asking. Not reactive: it is the screen's memory, not something drawn.
  const VALID = 1;
  const namesChecked = new Map<string, number>();
  let rollingName = $state(false);
  let creating = $state(false);
  let error = $state("");
  let creationState = $state<CharacterCreationState | null>(null);
  let uncertain = $state(false);

  const choices = $derived(tables ? bloodlineChoicesForRace(tables, raceID) : []);
  const bloodline = $derived((tables ? bloodlineForAncestry(tables, ancestryID) : null) ??
    choices.find((choice) => choice.bloodline.bloodlineID === chosenBloodlineID)?.bloodline ?? null);
  const activeBloodline = $derived(choices.find((choice) => choice.bloodline.bloodlineID === bloodline?.bloodlineID) ?? choices[0]);
  const shownBloodlines = $derived(flight ? (activeBloodline ? [activeBloodline] : []) : choices);
  const race = $derived(tables?.races.find((row) => row.raceID === raceID) ?? null);
  const nameProblem = $derived(nameValidationMessage(nameCode));
  const trimmedName = $derived(name.trim().replace(/\s+/g, " "));
  const empireArt = new Map([
    [1, { faction: 500001, color: "#8ac9e8" }],
    [2, { faction: 500002, color: "#ef9b7f" }],
    [4, { faction: 500003, color: "#e5cb86" }],
    [8, { faction: 500004, color: "#88d0ba" }],
  ]);
  const empireColor = $derived(empireArt.get(raceID)?.color ?? "#9bd4e7");
  // Require the account/slot read and a positive name verdict. The BFF repeats
  // these checks at creation time and never retries an ambiguous dispatch.
  const canCreate = $derived(
    !creating && !uncertain && creationState !== null && creationState.freeSlots > 0 && !creationState.pendingName &&
      trimmedName.length > 0 && raceID > 0 && nameCode === 1,
  );

  /**
   * "an Ibis", not "a Ibis". A plain vowel rule, which is right for all four
   * corvettes this world has (Ibis, Impairor, Reaper, Velator) — ship names are
   * data, so a hull whose spelling fights the rule would need a better one.
   */
  function article(word: string): string {
    return /^[aeiou]/i.test(word) ? "an" : "a";
  }

  /** A random ancestry of this race — the "everything else can be random" default. */
  function rollAncestryFor(nextRaceID: number): number {
    if (!tables) {
      return 0;
    }
    const pool = bloodlineChoicesForRace(tables, nextRaceID).flatMap((choice) => choice.ancestries);
    if (pool.length === 0) {
      return 0;
    }
    return pool[Math.floor(Math.random() * pool.length)].ancestryID;
  }

  function chooseRace(nextRaceID: number): void {
    if (nextRaceID === raceID) {
      return;
    }
    raceID = nextRaceID;
    chosenBloodlineID = null;
    // The old ancestry belongs to the old race's bloodline, so it cannot stand.
    // Rolling rather than blanking keeps the form always-submittable.
    ancestryID = rollAncestryFor(nextRaceID);
  }

  function chooseBloodline(choice: BloodlineChoice): void {
    if (activeBloodline === choice) return;
    chosenBloodlineID = choice.bloodline.bloodlineID;
    ancestryID = choice.ancestries[0]?.ancestryID ?? 0;
  }

  async function load(): Promise<void> {
    loadError = "";
    try {
      creationState = await loadCharacterCreationState(flow.requestOptions());
      if (creationState.recoveredCharacterID) { onCreated(creationState.recoveredCharacterID); return; }
      const loaded = await loadCharCreationInfo(flow.requestOptions());
      tables = loaded;
      if (loaded.races.length > 0) {
        raceID = loaded.races[0].raceID;
        ancestryID = rollAncestryFor(raceID);
      }
    } catch (cause) {
      loadError =
        panelErrorWords(cause);
    }
  }

  // One load, at mount. The creation tables are static config — re-reading them
  // would be a poll against something that cannot change.
  $effect(() => {
    void load();
  });

  // The name checked a second after the last keystroke (chooseNameSection.OnTextEditChange, _CheckNameValidThread:
  // Sleep(1.0), then CheckAvailability). The timer is cleared on teardown AND on every keystroke, so a burst of
  // typing produces one read rather than one per character; a name already answered is not asked again.
  $effect(() => {
    const candidate = trimmedName;
    if (!candidate) {
      nameCode = null;
      nameChecking = false;
      return;
    }
    const kept = namesChecked.get(candidate);
    if (kept !== undefined) {
      nameCode = kept;
      nameChecking = false;
      return;
    }
    nameChecking = true;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const code = await validateCharacterName(candidate, flow.requestOptions(), namesChecked.size);
          if (code !== null) namesChecked.set(candidate, code);
          // Ignore a verdict for a name the player has already typed past.
          if (candidate === trimmedName) {
            nameCode = code;
          }
        } catch {
          // A failed check is NOT a rejection — leave the last verdict alone and
          // let the create have the final word.
        } finally {
          if (candidate === trimmedName) {
            nameChecking = false;
          }
        }
      })();
    }, 1000);
    return () => clearTimeout(handle);
  });

  async function rollName(): Promise<void> {
    if (rollingName || raceID <= 0) {
      return;
    }
    rollingName = true;
    error = "";
    try {
      const rolled = await rollRandomCharacterName(raceID, flow.requestOptions());
      if (rolled) {
        namesChecked.set(rolled.trim().replace(/\s+/g, " "), VALID);
        name = rolled;
      }
    } catch (cause) {
      error = panelErrorWords(cause);
    } finally {
      rollingName = false;
    }
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canCreate) {
      return;
    }
    creating = true;
    error = "";
    try {
      const created = await flow.createCharacter({
        name: trimmedName,
        raceID,
        genderID,
        // Both are optional at the BFF, which rolls what it is not given. They
        // are sent because this screen HAS chosen them — an ancestry is
        // preselected, so "random" already happened here where it is visible.
        ...(bloodline ? { bloodlineID: bloodline.bloodlineID } : {}),
        ...(ancestryID > 0 ? { ancestryID } : {}),
      });
      onCreated(created.characterID);
    } catch (cause) {
      uncertain = creationNeedsRecovery(cause);
      error =
        cause instanceof BridgeCallError
          ? cause.code === "CharNameInvalid"
            ? "The server refused that name."
            : panelErrorWords(cause)
          : String(cause);
    } finally {
      creating = false;
    }
  }

  async function checkCreation(): Promise<void> {
    if (creating) return;
    creating = true;
    try {
      creationState = await loadCharacterCreationState(flow.requestOptions());
      const found = creationState.characters.find((row) => row.name.toLowerCase() === trimmedName.toLowerCase());
      if (creationState.recoveredCharacterID || found) onCreated(creationState.recoveredCharacterID || found!.characterID);
      else error = "Creation is not confirmed. Do not retry; inspect the account roster.";
    } catch (cause) { error = panelErrorWords(cause); }
    finally { creating = false; }
  }
</script>

<section class:panel={!flight} class:flight-creator={flight} style:--empire-color={flight ? empireColor : undefined}>
  <header class:panel-head={!flight} class:creator-header={flight}>
    {#if flight}
      <div>
        <h2>Create character</h2>
        <p>Choose your pilot’s origin and identity.</p>
      </div>
      {#if creationState}
        <p class="creator-slots">{creationState.freeSlots} of {creationState.slots} slots available</p>
      {/if}
    {:else}
      <h2>New character</h2>
    {/if}
  </header>
  {#if !flight}<p>Available slots: {creationState?.freeSlots ?? "UNKNOWN"} / {creationState?.slots ?? "UNKNOWN"}. Creation does not log the pilot in.</p>{/if}
  <div class:creator-body={flight}>
    {#if creationState?.pendingName}<p class="error">Unresolved creation: {creationState.pendingName}. Inspect the roster before another create.</p>{/if}
    {#if uncertain || creationState?.pendingName}<button type="button" disabled={creating} onclick={checkCreation}>Check creation result (read only)</button>{/if}

    {#if loadError}
      <p class="error" role="alert">{loadError}</p>
      <p><button type="button" class="minor" onclick={onCancel}>Back to characters</button></p>
    {:else if tables === null}
      <p class="note">Loading the creation tables…</p>
    {:else if tables.races.length === 0}
      <p class="empty">This server has no character-creation tables, so nothing can be created here.</p>
      <p><button type="button" class="minor" onclick={onCancel}>Back to characters</button></p>
    {:else}
      {#if !flight}<p class="note">
        Pick a race, a bloodline's ancestry, a gender and a name. Everything else —
        your corporation, station, first ship and starting skills — the server
        decides.
      </p>{/if}

      <form onsubmit={submit} class:creator-grid={flight}>
        <div class:creator-card={flight}>
          {#if flight}<h3>Origin</h3>{/if}
          <fieldset class="create-group">
            <legend>{flight ? "Empire" : "Race"}</legend>
            <ul class="race-list">
              {#each tables.races as row (row.raceID)}
                {@const empire = empireArt.get(row.raceID)}
                {@const mark = flight ? factionIcon(empire?.faction ?? null) : null}
                <li>
                  <button
                    type="button"
                    class="race-card"
                    class:selected={row.raceID === raceID}
                    style:--race-color={flight ? empire?.color : undefined}
                    aria-pressed={row.raceID === raceID}
                    disabled={creating}
                    onclick={() => chooseRace(row.raceID)}
                  >
                    {#if mark}
                      <img class="empire-mark" src={mark} alt="" width="34" height="34" />
                    {:else if !flight}
                      <TypeIcon typeID={row.shipTypeID} name={row.shipName} size="sm" />
                    {/if}
                    <span class="race-text">
                      <span class="name">{row.raceName}</span>
                      {#if !flight}<span class="detail">Starts in {article(row.shipName)} {row.shipName}</span>{/if}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          </fieldset>

          {#if flight && choices.length}
            <fieldset class="create-group">
              <legend>Bloodline</legend>
              <div class="bloodline-picker">
                {#each choices as choice (choice.bloodline.bloodlineID)}
                  <button type="button" class:selected={choice === activeBloodline} aria-pressed={choice === activeBloodline}
                    disabled={creating} onclick={() => chooseBloodline(choice)}>{choice.bloodline.bloodlineName}</button>
                {/each}
              </div>
            </fieldset>
          {/if}
          <fieldset class="create-group">
            <legend>Ancestry</legend>
            {#if !flight}<p class="note subtle">
              Grouped by bloodline — your pick names the bloodline too. One is chosen
              at random; change it or leave it.
            </p>{/if}
            {#each shownBloodlines as choice (choice.bloodline.bloodlineID)}
              <div class="bloodline-group">
                {#if !flight}<h3 class="bloodline-name">{choice.bloodline.bloodlineName}</h3>{/if}
                {#if choice.ancestries.length === 0}
                  <p class="detail">No ancestries recorded for this bloodline.</p>
                {:else}
                  <ul class="ancestry-list">
                    {#each choice.ancestries as row (row.ancestryID)}
                      <li>
                        <button
                          type="button"
                          class="ancestry-card"
                          class:selected={row.ancestryID === ancestryID}
                          aria-pressed={row.ancestryID === ancestryID}
                          disabled={creating}
                          onclick={() => (ancestryID = row.ancestryID)}
                        >
                          <span class="name">{row.name}</span>
                          <span class="detail">{row.shortDescription}</span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/each}
          </fieldset>
        </div>

        <div class:creator-card={flight} class:identity-card={flight}>
          {#if flight}<h3>Identity</h3>{/if}
          <fieldset class="create-group">
            <legend>Gender</legend>
            <div class="gender-row">
              <button
                type="button"
                class="gender-card"
                class:selected={genderID === 1}
                aria-pressed={genderID === 1}
                disabled={creating}
                onclick={() => (genderID = 1)}
              >Male</button>
              <button
                type="button"
                class="gender-card"
                class:selected={genderID === 0}
                aria-pressed={genderID === 0}
                disabled={creating}
                onclick={() => (genderID = 0)}
              >Female</button>
            </div>
          </fieldset>

          <div class:name-control={flight}>
            <label>
              Name
              <input
                type="text"
                bind:value={name}
                autocomplete="off"
                spellcheck="false"
                placeholder="Three to thirty-seven characters"
                disabled={creating}
              />
            </label>
            {#if flight}
              <button type="button" class="minor random-name" disabled={rollingName || creating} onclick={rollName}>
                {rollingName ? "Rolling…" : "Random name"}
              </button>
            {/if}
          </div>
          <p class="name-status" aria-live="polite">
            {#if !trimmedName}
              <span class="detail">A name is required.</span>
            {:else if nameProblem}
              <span class="error-inline">{nameProblem}</span>
            {:else if nameChecking}
              <span class="detail">Checking that name…</span>
            {:else if nameCode === 1}
              <span class="ok-inline">That name is available.</span>
            {:else}
              <span class="detail">The server will check this name when you create.</span>
            {/if}
          </p>

          {#if flight && race}
            <div class="starting-ship">
              <TypeIcon typeID={race.shipTypeID} name={race.shipName} size="md" />
              <div>
                <span>Starting ship</span>
                <strong>{race.shipName}</strong>
              </div>
            </div>
          {/if}
          {#if flight}
            <p class="customization-note">
              <strong>Customize later</strong>
              You can customize your character’s appearance later by selecting them in the desktop EVE client.
            </p>
          {/if}
          <div class="create-actions">
            {#if !flight}
            <button type="button" class="minor" disabled={rollingName || creating} onclick={rollName}>
              {rollingName ? "Rolling…" : "Roll a name"}
            </button>
            {/if}
            <button type="submit" class="primary" disabled={!canCreate}>
              {creating ? "Creating…" : "Create character"}
            </button>
            <button type="button" class="minor" disabled={creating} onclick={onCancel}>Cancel</button>
          </div>
          {#if flight && error}<p class="error" role="alert">{error}</p>{/if}
        </div>
      </form>

      {#if !flight && race}
        <p class="detail create-summary">
          {race.raceName}{bloodline ? ` · ${bloodline.bloodlineName}` : ""} · starts in
          {article(race.shipName)} {race.shipName}.
        </p>
      {/if}
      {#if !flight && error}
        <p class="error" role="alert">{error}</p>
      {/if}
    {/if}
  </div>
</section>

<style>
  .flight-creator {
    border: 1px solid #334352;
    background: #0d141c;
    box-shadow: 0 18px 68px #000a;
    color: #e6edf2;
  }
  .creator-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: .75rem 1rem;
    min-height: 126px;
    padding: clamp(18px, 3vw, 30px);
    border-bottom: 1px solid #334352;
    background: linear-gradient(90deg, #111e2a 12%, #111e2aeb 45%, #111e2a61),
      url("/client-res/ui/texture/charactercreation/background/bg1.png") right 45% / cover;
  }
  .creator-header h2 {
    margin: 0;
    font: 700 clamp(29px, 4vw, 44px) / 1 "EVE Sans Neue Condensed", var(--font, sans-serif);
    letter-spacing: .035em;
    color: #f3f7fa;
  }
  .creator-header p { margin: .45rem 0 0; color: #c0ced9; }
  .creator-header .creator-slots {
    padding: .35rem .65rem;
    border: 1px solid #ffffff36;
    background: #0b141cde;
    font-variant-numeric: tabular-nums;
  }
  .creator-body { padding: clamp(12px, 2.5vw, 24px); }
  .creator-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 16px; }
  .creator-card { min-width: 0; padding: clamp(14px, 2vw, 22px); border: 1px solid #2c3a47; background: #151e28; }
  .creator-card h3 {
    margin: 0 0 1.15rem;
    color: #f1f6fa;
    font: 700 22px / 1 "EVE Sans Neue Condensed", var(--font, sans-serif);
    letter-spacing: .035em;
  }
  .identity-card {
    display: flex;
    flex-direction: column;
    background: linear-gradient(160deg, #172530de, #101821f2),
      url("/client-res/ui/texture/charactercreation/assetbackground.png") center / cover;
  }
  .flight-creator .create-group { padding: 0; margin: 0 0 1rem; min-width: 0; border: 0; }
  .flight-creator .create-group:last-child { margin-bottom: 0; }
  .flight-creator .create-group > legend,
  .flight-creator .name-control label {
    padding: 0;
    margin: 0 0 .42rem;
    color: #c9d7e2;
    font-size: .71rem;
    font-weight: 700;
    letter-spacing: .12em;
    text-transform: uppercase;
  }
  .flight-creator .race-list { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .flight-creator .race-card {
    flex-direction: column;
    justify-content: center;
    min-height: 102px;
    height: 100%;
    padding: 10px 4px;
    gap: .4rem;
    border-color: #3a4856;
    background: #1c2732;
    font-size: .85rem;
    text-align: center;
  }
  .empire-mark { object-fit: contain; }
  .flight-creator .race-card.selected {
    border-color: var(--race-color, var(--empire-color));
    background: color-mix(in srgb, var(--race-color, var(--empire-color)) 16%, #17232d);
    box-shadow: inset 0 -2px var(--race-color, var(--empire-color));
  }
  .bloodline-picker { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .4rem; }
  .bloodline-picker button, .flight-creator .gender-card, .flight-creator .ancestry-card {
    border-color: #3a4856;
    background: #1c2732;
    color: #e6edf2;
  }
  .bloodline-picker button { padding: .45rem .25rem; line-height: 1.2; }
  .bloodline-picker button.selected, .flight-creator .gender-card.selected, .flight-creator .ancestry-card.selected {
    border-color: var(--empire-color);
    background: color-mix(in srgb, var(--empire-color) 13%, #17232d);
  }
  .flight-creator button:not(:disabled):hover { border-color: var(--empire-color); }
  .flight-creator button:focus-visible, .name-control input:focus-visible { outline: 2px solid var(--empire-color); outline-offset: 2px; }
  .flight-creator .ancestry-list { grid-template-columns: minmax(0, 1fr); }
  .flight-creator .ancestry-card { min-height: 49px; gap: .2rem; text-transform: none; letter-spacing: normal; }
  .flight-creator .ancestry-card .detail { color: #b7c6d3; line-height: 1.35; }
  .name-control { display: flex; align-items: end; gap: .4rem; }
  .flight-creator .name-control label { flex: 1; min-width: 0; margin-bottom: 0; }
  .name-control input {
    display: block;
    width: 100%;
    min-width: 0;
    margin-top: .42rem;
    background: #0d151d;
    font-size: .84rem;
    letter-spacing: normal;
    text-transform: none;
  }
  .name-control .random-name { flex: none; padding-inline: .5rem; font-size: .72rem; }
  .flight-creator .name-status { min-height: 2.5em; }
  .starting-ship {
    display: flex;
    align-items: center;
    gap: .65rem;
    padding: .65rem;
    border-block: 1px solid #364552;
    color: #f0f4f7;
  }
  .starting-ship span, .starting-ship strong { display: block; }
  .starting-ship div > span { color: #aebfce; font-size: .72rem; }
  .customization-note { margin: 1rem 0; padding: .65rem .8rem; border-left: 2px solid var(--empire-color); background: #0e1821; color: #c2d0db; }
  .customization-note strong { display: block; color: #f1f6fa; margin-bottom: .16rem; }
  .identity-card .create-actions { margin-top: auto; }
  .identity-card .create-actions .primary { flex: 1; }
  .identity-card .create-actions button { min-height: 42px; }

  @media (max-width: 820px) {
    .creator-grid { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 460px) {
    .flight-creator .race-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .flight-creator .race-card { min-height: 78px; }
    .name-control { flex-wrap: wrap; }
    .name-control .random-name { min-height: 40px; }
  }
</style>
