<script lang="ts">
  // 24.02 charsheet/membership.py: one equal-width column for each current
  // membership. The old self actions now live on the corporation column.
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { allianceLogoUrl, remoteImageUrl } from "./ownerImages.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const image = flow.imageServer;
  // svelte-ignore state_referenced_locally
  const logos = flow.ownerLogos;
  const M = "UI/CharacterSheet/CharacterSheetWindow/Memberships/", C = "UI/Corporations/Common/";
  const labels = { corporation: "UI/Common/Corporation", alliance: "UI/Common/Alliance", faction: "UI/Common/Faction",
    length: M + "ServiceLength", since: M + "EnlistedSince", title: M + "Title", allow: M + "AllowNewRoles", hint: M + "NewRolesHint",
    resign: M + "ResignAsCEO", remove: M + "RemoveAllRoles", quit: "UI/Corporations/CorpUIHome/QuitCorp", role: C + "Role", roles: C + "Roles",
    ceo: C + "CEO", rank: "UI/FactionWarfare/Rank" } as const;
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? "") || fallback;
  const online = $derived($station.online);
  let row = $state<Awaited<ReturnType<AppFlow["characterMembership"]>> | null>(null);
  let busy = $state(false), error = $state(""), refresh = $state(0);
  $effect(() => {
    void refresh;
    const id = online?.characterID, corp = online?.corporationID, alliance = online?.allianceID, fw = online?.warFactionID;
    if (!id || !corp) return;
    let current = true;
    flow.requestWords(Object.values(labels));
    flow.loadImageServer();
    flow.loadOwnerLogos();
    flow.requestNames([{ kind: "corporation", id: corp }, ...(alliance ? [{ kind: "alliance" as const, id: alliance }] : []), ...(fw ? [{ kind: "owner" as const, id: fw }] : [])]);
    error = "";
    void flow.characterMembership().then(data => { if (current) row = data; }, e => { if (current) { row = null; error = e instanceof Error ? e.message : String(e); } });
    return () => { current = false; };
  });

  async function corporationAction(action: "quit" | "removeRoles" | "resign") {
    const id = online?.characterID;
    if (!id) return;
    busy = true; error = "";
    try {
      if (action === "resign") await (await flow.corporationCEOMenu([id]))?.confirm();
      else await (await flow.corporationQuitMenu([id]))?.[action]();
      refresh++;
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  async function changeRoles(allow: boolean) {
    busy = true; error = "";
    try { await flow.setMembershipAllowsRoles(allow); refresh++; }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  async function openRolesSummary(characterID: number) {
    error = "";
    try { await flow.openCorporationMemberDetails(characterID, "roles_summary"); }
    catch (cause) {
      if ((cause as { code?: string })?.code !== "SESSION_REQUEST_RETIRED") error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  function since(ticks: string): { date: string; duration: string } {
    const ms = Number((BigInt(ticks) - 116444736000000000n) / 10000n);
    let days = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
    const years = Math.floor(days / 365); days %= 365;
    const months = Math.floor(days / 30); days %= 30;
    return { date: new Date(ms).toLocaleDateString("en-GB", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }),
      duration: [years && `${years}y`, months && `${months}m`, `${days}d`].filter(Boolean).join(" ") };
  }
</script>

{#snippet service(ticks: string | null | undefined)}
  {#if ticks && BigInt(ticks) > 116444736000000000n}
    {@const d = since(ticks)}
    <div class="info"><small>{word(labels.length, "Length of Service")}</small><strong>{d.duration}</strong>
      <span>{plainText(formatTemplate($words.templates[labels.since] ?? "Enlisted since {date}", { date: d.date }, { nameOf: () => "" }))}</span></div>
  {/if}
{/snippet}

{#if error}<p role="alert">{error}</p>{/if}
<div class="memberships">
  {#if online?.corporationID}
    {@const id = online.corporationID}
    {@const resource = $logos?.corporations[String(id)]}
    {@const logo = resource ? clientTexture(resource) : remoteImageUrl($image, "Corporation", id, 64, ".png")}
    <section aria-label={word(labels.corporation, "Corporation")}>
      <div>{word(labels.corporation, "Corporation")}</div>
      <button type="button" class="group" onclick={() => showInfo({ kind: "corporation", corporationID: id })}>
        {#if logo}<img alt="" src={logo} />{/if}<strong>{resolvedName($names.resolved, "corporation", id, "Corporation")}</strong>
      </button>
      {#if row?.playerCorporation}
        <div class="actions">
          {#if row.ceo}<button type="button" disabled={busy} onclick={() => corporationAction("resign")}>{word(labels.resign, "Resign as CEO")}</button>
          {:else}
            {#if row.roles.length || row.director}<button type="button" disabled={busy} onclick={() => corporationAction("removeRoles")}>{word(labels.remove, "Remove All Roles")}</button>{/if}
            <button type="button" disabled={busy} onclick={() => corporationAction("quit")}>{word(labels.quit, "Quit Corporation")}</button>
          {/if}
        </div>
        <div class="info"><small>{row.ceo || row.director ? word(labels.role, "Role") : word(labels.roles, "Roles")}</small>
          <span>{row.ceo ? word(labels.ceo, "CEO") : row.director ? "Director" : row.roles.slice(0, 4).join(", ") || "None"}{#if row.roles.length > 4 && online?.characterID}{@const characterID = online.characterID}{", "}<button class="more evelink" type="button" onclick={() => void openRolesSummary(characterID)}>{row.roles.length - 4} more</button>{/if}</span>
          {#if row.acceptsRoles !== null}
            <label title={word(labels.hint, "Allow new roles to be assigned to you")}><input type="checkbox" checked={row.acceptsRoles} disabled={busy} onclick={(event) => { event.preventDefault(); void changeRoles(!row?.acceptsRoles); }} /> {word(labels.allow, "Allow New Roles")}</label>
          {/if}
        </div>
      {/if}
      {@render service(row?.corporationSince)}
      {#if row?.title}<div class="info"><small>{word(labels.title, "Title")}</small><span>{plainText(row.title)}</span></div>{/if}
    </section>
  {/if}
  {#if online?.allianceID}
    {@const id = online.allianceID}
    {@const logo = allianceLogoUrl($image, id)}
    <section aria-label={word(labels.alliance, "Alliance")}>
      <div>{word(labels.alliance, "Alliance")}</div>
      <button type="button" class="group" onclick={() => showInfo({ kind: "alliance", allianceID: id })}>
        {#if logo}<img alt="" src={logo} />{/if}<strong>{resolvedName($names.resolved, "alliance", id, "Alliance")}</strong>
      </button>
      {@render service(row?.allianceSince)}
    </section>
  {/if}
  {#if online?.warFactionID}
    {@const id = online.warFactionID}
    {@const resource = $logos?.factions[String(id)]}
    <section aria-label={word(labels.faction, "Faction")}>
      <div>{word(labels.faction, "Faction")}</div>
      <button type="button" class="group" onclick={() => showInfo({ kind: "faction", factionID: id })}>
        {#if resource}<img alt="" src={clientTexture(resource)} />{/if}<strong>{resolvedName($names.resolved, "owner", id, "Faction")}</strong>
      </button>
      {#if row?.rank !== null && row?.rank !== undefined}<div class="info"><small>{word(labels.rank, "Rank")}</small><span>{row.rank}</span></div>{/if}
    </section>
  {/if}
</div>

<style>
  .memberships { display: flex; gap: 8px; margin: 8px; align-items: stretch; }
  section { flex: 1; min-width: 0; padding: 16px; background: #ffffff0d; }
  .group { display: flex; align-items: center; text-align: left; gap: 8px; min-height: 72px; width: 100%; border: 0; border-bottom: 1px solid #ffffff26; background: transparent; color: inherit; }
  .group strong { font-size: 20px; }
  img { width: 64px; height: 64px; object-fit: contain; }
  .info, .actions { display: flex; flex-direction: column; gap: 4px; padding-top: 12px; }
  small { color: #b7bec5; }
  .actions button { background: #ffffff10; color: inherit; border: 1px solid #ffffff2a; padding: 6px; }
  .more { background: transparent; border: 0; padding: 0; }
</style>
