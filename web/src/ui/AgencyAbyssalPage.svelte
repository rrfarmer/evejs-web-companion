<script lang="ts">
  // agencyNew/ui/contentGroupPages/abyssalDeadspaceContentGroupPage (group 37): on the left (0.5) the Overview (Header;
  // abyssalSummary with the Triglavians' link, a scroll 130 high; the video AbyssalSpaceTestv04 looping, 234 high, 10
  // below; abyssalTimeWarning in WARNING_ORANGE 10 below); on the right (10 apart) Game Modes - the solo cruiser, the
  // destroyer co-op and the co-op, each GameModeContainer (its title HIGHLIGHT, its description SECONDARY 274 wide,
  // Requirements and its text on the right) - and Take Me To with the Filaments card (HorizontalContentGroupCard).
  // contentPages/contentPageAbyssalFilaments (group 44): on the left (CONTENT_PAGE_WIDTH / 2) Abyssal Filaments (the
  // L3 filament's icon, filamentsDescription, howToGetFilaments and its three ways, the data sites' with Jump To
  // Cosmic Signatures), Weather Types (each its icon 40, its name and its hint, sorted by name) and Information (the
  // rewards with AbyssalDeadspaceRewardsTooltip); on the right (/ 1.65, 10 in) Filament Search: Filament Type and
  // Weather Effect, then each of DIFFICULTY_TIERS (0 to 6) its filament icon, its name and difficulty, the chosen
  // weather's icon, the weather combo (random.choice(WEATHER_TYPE_IDS) first) and Market Search
  // (ShowMarketDetails(KEY_TYPE_BY_TIER_AND_WEATHER)).
  // Not here: the tooltip's Triglavian ship tree button (shipTreeUI: no such window in the page).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { AGENCY_GROUPS } from "./agencyContentGroups.ts";
  import { LINK_WORDS, linkFollowerOf } from "./linkFollowers.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import LabelText from "./LabelText.svelte";

  let { store, flow, page, onShow }: { store: ClientStore; flow: AppFlow; page: "deadspace" | "filaments"; onShow?: (groupID: number) => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const D = "UI/Agency/AbyssalDeadspace/";
  const nameOf = (kind: "owner" | "type", id: number) => resolvedName($names.resolved, kind as never, id, "");
  const markup = (label: string, args: Record<string, unknown> = {}) => formatTemplate($words.templates[label] ?? "", args as never, { nameOf: nameOf as never });
  const word = (label: string, args: Record<string, unknown> = {}) => plainText(markup(label, args));
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => word(label), text);
  const TRIGLAVIAN = 500026, TYPE_FACTION = 30;
  // abyss/client/constants: the weathers' names, hints and icons; the tiers' names, difficulties and icons; the keys.
  const WEATHERS: readonly { readonly id: number; readonly name: string; readonly hint: string; readonly icon: string }[] = [
    { id: 47865, name: "UI/Abyss/WeatherNames/Electrical", hint: "UI/Agency/Tooltips/Encounters/AbyssalDeadspace/Electrical", icon: "weatherLightning" },
    { id: 47862, name: "UI/Abyss/WeatherNames/Exotic", hint: "UI/Agency/Tooltips/Encounters/AbyssalDeadspace/Exotic", icon: "weatherCaustic" },
    { id: 47864, name: "UI/Abyss/WeatherNames/Firestorm", hint: "UI/Agency/Tooltips/Encounters/AbyssalDeadspace/Firestorm", icon: "weatherInfernal" },
    { id: 47866, name: "UI/Abyss/WeatherNames/Gamma", hint: "UI/Agency/Tooltips/Encounters/AbyssalDeadspace/Gamma", icon: "weatherXenonGas" },
    { id: 47863, name: "UI/Abyss/WeatherNames/Dark", hint: "UI/Agency/Tooltips/Encounters/AbyssalDeadspace/Dark", icon: "weatherDarkness" },
  ].map((w) => ({ ...w, icon: `res:/UI/Texture/Icons/StatusEffects/${w.icon}.png` }));
  // KEY_TYPE_BY_TIER_AND_WEATHER: each tier's filament for Electrical, Exotic, Firestorm, Gamma and Dark.
  const KEYS: Readonly<Record<number, Readonly<Record<number, number>>>> = {
    0: { 47865: 56131, 47862: 56133, 47864: 56134, 47866: 56136, 47863: 56132 },
    1: { 47865: 47765, 47862: 47761, 47864: 47763, 47866: 47764, 47863: 47762 },
    2: { 47865: 47904, 47862: 47888, 47864: 47896, 47866: 47900, 47863: 47892 },
    3: { 47865: 47905, 47862: 47889, 47864: 47897, 47866: 47901, 47863: 47893 },
    4: { 47865: 47906, 47862: 47890, 47864: 47898, 47866: 47902, 47863: 47894 },
    5: { 47865: 47907, 47862: 47891, 47864: 47899, 47866: 47903, 47863: 47895 },
    6: { 47865: 56139, 47862: 56141, 47864: 56142, 47866: 56143, 47863: 56140 },
  };
  const TIERS = [0, 1, 2, 3, 4, 5, 6];
  const WEATHER_IDS = [47865, 47862, 47864, 47866, 47863];
  // ApplyAttributes: the weathers sorted by their names.
  const weathers = $derived([...WEATHERS].sort((a, b) => word(a.name).localeCompare(word(b.name))));
  // Each entry's combo: random.choice(WEATHER_TYPE_IDS).
  let chosen = $state<Record<number, number>>(Object.fromEntries(TIERS.map((t) => [t, WEATHER_IDS[Math.floor(Math.random() * WEATHER_IDS.length)]!])));
  const MODES = [["soloCruiser", "soloAbyssalDescription", "soloRequirements"], ["abyssalDestroyerCoOpTitle", "abyssalDestroyerCoOpDescription", "destroyerCoOpRequirements"],
    ["abyssalCoOpTitle", "abyssalCoOpDescription", "coOpRequirements"]] as const;
  $effect(() => {
    flow.requestWords([...Object.keys(LINK_WORDS), "UI/Overview/Overview", "UI/InfoWindow/Information", "UI/Agency/takeMeTo", "UI/Agency/jumpTo", "UI/Agency/ContentGroups/ContentGroupSignatures",
      ...["abyssalSummary", "abyssalTimeWarning", "gameModes", "requirements", "rewards", "filamentSearch", "filamentType", "weatherEffect", "weatherTypes", "abyssalFilaments",
        "filamentsDescription", "howToGetFilaments", "filamentsAtDataSites", "filamentsInCaches", "filamentsInMarket", "marketSearch", ...MODES.flat()].map((k) => `${D}${k}`),
      ...WEATHERS.flatMap((w) => [w.name, w.hint]), ...TIERS.flatMap((t) => [`UI/Abyss/TierNames/Tier${t}`, `UI/Abyss/TierDifficulties/Tier${t}`]),
      ...["RewardsFromDifficulty", "TriglavianBlueprintReward", "MutaplasmidRewards"].map((k) => `UI/Agency/Tooltips/Encounters/AbyssalDeadspace/${k}`),
      AGENCY_GROUPS[44]?.name ?? "", AGENCY_GROUPS[44]?.description ?? ""].filter(Boolean));
  });
  $effect(() => { flow.requestNames([{ kind: "owner", id: TRIGLAVIAN }]); });
  const filaments = $derived(AGENCY_GROUPS[44]);
  const rewardsHint = $derived(["RewardsFromDifficulty", "TriglavianBlueprintReward", "MutaplasmidRewards"].map((k) => word(`UI/Agency/Tooltips/Encounters/AbyssalDeadspace/${k}`)).join("\n\n"));
</script>

{#if page === "deadspace"}
<div class="aad">
  <section class="aad-left">
    <h3 class="aad-header">{word("UI/Overview/Overview")}</h3>
    <div class="aad-summary"><LabelText markup={markup(`${D}abyssalSummary`, { ownerTypeID: TYPE_FACTION, ownerID: TRIGLAVIAN })} {followerOf} /></div>
    <div class="aad-video"><!-- svelte-ignore a11y_media_has_caption --><video autoplay loop muted src={clientTexture("res:/video/agency/AbyssalSpaceTestv04.webm")}></video></div>
    <p class="aad-warn">⚠ {word(`${D}abyssalTimeWarning`)}</p>
  </section>
  <div class="aad-right">
    <section class="aad-sec"><h4>{word(`${D}gameModes`)}</h4>
      {#each MODES as [title, desc, req] (title)}
        <div class="aad-mode">
          <div class="aad-mode-main"><b>{word(`${D}${title}`)}</b><p>{word(`${D}${desc}`)}</p></div>
          <div class="aad-req"><small>{word(`${D}requirements`)}</small><p>{word(`${D}${req}`)}</p></div>
        </div>
      {/each}
    </section>
    <section class="aad-sec aad-take"><h4>{word("UI/Agency/takeMeTo")}</h4>
      {#if filaments}
        <button type="button" class="aad-card" onclick={() => onShow?.(44)}>
          {#if filaments.card}<img alt="" src={clientTexture(filaments.card)} />{/if}
          <span><b>{word(filaments.name ?? "")}</b><small>{filaments.description ? word(filaments.description) : ""}</small></span>
        </button>
      {/if}
    </section>
  </div>
</div>
{:else}
<div class="aad aaf">
  <div class="aaf-left">
    <section class="aad-sec"><h4>{word(`${D}abyssalFilaments`)}</h4>
      <div class="aaf-scroll">
        <div class="aaf-desc"><img alt="" src={clientTexture("res:/UI/Texture/Icons/Inventory/abyssalFilamentL3.png")} /><p>{word(`${D}filamentsDescription`)}</p></div>
        <p>{word(`${D}howToGetFilaments`)}</p>
        <p class="aaf-way">{word(`${D}filamentsAtDataSites`)}</p>
        <p class="aaf-jump">{word("UI/Agency/jumpTo")} <button type="button" onclick={() => onShow?.(39)}>{word("UI/Agency/ContentGroups/ContentGroupSignatures")}</button></p>
        <p class="aaf-way">{word(`${D}filamentsInCaches`)}</p>
        <p class="aaf-way">{word(`${D}filamentsInMarket`)}</p>
      </div>
    </section>
    <section class="aad-sec"><h4>{word(`${D}weatherTypes`)}</h4>
      <div class="aaf-weathers">{#each weathers as w (w.id)}<span class="aaf-weather" title={word(w.hint)}><img alt="" src={clientTexture(w.icon)} />{word(w.name)} ⓘ</span>{/each}</div>
    </section>
    <section class="aad-sec"><h4>{word("UI/InfoWindow/Information")}</h4><p class="aaf-info" title={rewardsHint}>ⓘ {word(`${D}rewards`)}</p></section>
  </div>
  <div class="aaf-right">
    <section class="aad-sec"><h4>{word(`${D}filamentSearch`)}</h4>
      <div class="aaf-head"><span>{word(`${D}filamentType`)}</span><span>{word(`${D}weatherEffect`)}</span></div>
      {#each TIERS as t (t)}
        {@const weather = WEATHERS.find((w) => w.id === chosen[t])}
        <div class="aaf-tier">
          <img alt="" src={clientTexture(`res:/UI/Texture/Icons/Inventory/abyssalFilamentL${t}.png`)} />
          <span class="aaf-tier-name"><b>{word(`UI/Abyss/TierNames/Tier${t}`)}</b><small>{word(`UI/Abyss/TierDifficulties/Tier${t}`)}</small></span>
          <img alt="" class="aaf-weather-icon" src={weather ? clientTexture(weather.icon) : ""} />
          <select value={chosen[t]} onchange={(e) => (chosen = { ...chosen, [t]: Number(e.currentTarget.value) })}>{#each weathers as w (w.id)}<option value={w.id}>{word(w.name)}</option>{/each}</select>
          <button type="button" onclick={() => { const key = KEYS[t]?.[chosen[t] ?? 0]; if (key) showMarketDetails(key); }}>{word(`${D}marketSearch`)}</button>
        </div>
      {/each}
    </section>
  </div>
</div>
{/if}

<style>
  .aad { display: flex; gap: 10px; height: 100%; min-height: 0; font-size: 13px; }
  .aad-left { width: 50%; flex: none; background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 0 10px 10px; display: flex; flex-direction: column; box-sizing: border-box; }
  .aad-header { margin: 0 -10px 10px; padding: 6px 10px; font-size: 13px; text-transform: uppercase; border-bottom: 1px solid rgb(255 255 255 / 0.12); }
  .aad-summary { height: 130px; overflow: auto; }
  .aad-video { height: 234px; margin-top: 10px; padding: 10px; box-sizing: border-box; border: 1px solid rgb(255 255 255 / 0.2); }
  .aad-video video { width: 100%; height: 100%; object-fit: cover; }
  .aad-warn { margin: 10px 0 0; color: #f0a030; }
  .aad-right { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
  .aad-sec { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 6px 10px 10px; }
  .aad-sec h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; opacity: 0.8; }
  .aad-mode { display: flex; gap: 10px; margin-bottom: 10px; }
  .aad-mode-main { width: 274px; flex: none; }
  .aad-mode-main b { font-size: 16px; color: #fff; }
  .aad-mode-main p, .aad-req p { margin: 4px 0 0; opacity: 0.7; }
  .aad-req { flex: 1; text-align: right; max-width: 130px; margin-left: auto; }
  .aad-req p { opacity: 1; }
  .aad-card { all: unset; cursor: pointer; display: flex; gap: 10px; align-items: center; margin: 10px auto; padding: 6px; border: 1px solid rgb(255 255 255 / 0.12); }
  .aad-card img { width: 120px; height: 70px; object-fit: cover; }
  .aad-card span { display: flex; flex-direction: column; gap: 4px; max-width: 150px; }
  .aaf-left { width: 45%; flex: none; display: flex; flex-direction: column; gap: 6px; overflow: auto; }
  .aaf-right { flex: 1; min-width: 0; }
  .aaf-scroll { max-height: 175px; overflow: auto; }
  .aaf-desc { display: flex; gap: 8px; }
  .aaf-desc img { width: 64px; height: 64px; }
  .aaf-scroll p { margin: 6px 0 0; opacity: 0.75; }
  .aaf-way { padding-left: 5px; }
  .aaf-jump { padding-left: 25px; opacity: 1 !important; }
  .aaf-weathers { display: flex; flex-wrap: wrap; gap: 10px 20px; }
  .aaf-weather { width: 195px; height: 40px; display: flex; align-items: center; gap: 10px; cursor: help; }
  .aaf-weather img, .aaf-weather-icon { width: 40px; height: 40px; }
  .aaf-info { cursor: help; margin: 6px 0; }
  .aaf-head { display: flex; gap: 130px; padding: 10px 0 0 10px; font-size: 15px; }
  .aaf-tier { display: flex; align-items: center; gap: 10px; height: 40px; margin: 10px 0 0 10px; }
  .aaf-tier > img:first-child { width: 40px; height: 40px; }
  .aaf-tier-name { width: 100px; display: flex; flex-direction: column; margin-right: auto; }
  .aaf-tier-name b { font-size: 15px; }
  .aaf-tier-name small { opacity: 0.6; }
  .aaf-tier select { width: 115px; height: 25px; }
</style>
