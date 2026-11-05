<script lang="ts">
  // The Neocom (goal R74) — the persistent launcher rail down the left, present
  // in BOTH states, now as EVE's narrow ICON strip rather than a column of text
  // buttons.
  //
  // It lists the panels openable in the current state; clicking one opens it as a
  // window on the desktop, or brings it to the front if it is already open. Open
  // panels stay highlighted so the rail doubles as a "what is on my desktop" map,
  // and the front-most window is marked current. The two fixed-chrome panels
  // (Station / Overview) are not launched here — they live in the top-right dock.
  //
  // ⚠ THE GLYPH IS NEVER THE ONLY LABEL. Every button carries the panel's real
  // name as its accessible name AND its tooltip, so a screen reader and a hover
  // both get words. The rail is an accelerator for someone who has learnt it, not
  // a puzzle for someone who has not.
  //
  // WHAT IT GAINED BESIDES ICONS: the pilot's portrait plate at the top, and the
  // two readouts every EVE player keeps one eye on — the wallet balance and EVE
  // time — pinned at the bottom. Both are GLANCES that link to the real thing:
  // the balance opens the Wallet panel, where the exact, bigint-safe figure
  // lives.
  import { launchableTabsFor, type TabID } from "./tabs.ts";
  import { isWindowTab } from "./desktop.ts";
  import { eveClock, neocomGlyph, portraitInitials, shortIsk } from "./neocomIcons.ts";
  import { formatWholeIsk } from "./isk.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import { canClaimNow } from "../bridge/loginRewards.ts";
  import { seasonalClaimable, seasonalView } from "../bridge/seasonalCampaigns.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let {
    store,
    flow = null,
    isDocked,
    openIds,
    focusedId,
    onSelect,
  }: {
    /** Required: the rail reads the pilot and the wallet from it. */
    store: ClientStore;
    /**
     * Null renders the rail without its own reads (tests, embeddings). Every
     * real mount passes the session's flow — without it the wallet readout can
     * only ever show a dash, because nothing else pulls the balance until the
     * player happens to open the Wallet panel.
     */
    flow?: AppFlow | null;
    isDocked: boolean;
    openIds: Set<TabID>;
    focusedId: TabID | null;
    onSelect: (id: TabID) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const wallet = store.wallet;
  // svelte-ignore state_referenced_locally
  const redeem = store.redeem;
  // svelte-ignore state_referenced_locally
  const loginRewards = store.loginRewards;

  // Contextual panels (Show Info) are deliberately absent: they open on the thing
  // you clicked, so a rail entry could only ever open one onto nothing.
  const tabs = $derived(launchableTabsFor(isDocked).filter((tab) => isWindowTab(tab.id)));

  const pilotName = $derived($station.online?.characterName ?? null);
  const initials = $derived(portraitInitials(pilotName));
  // svelte-ignore state_referenced_locally
  const imageServer = flow?.imageServer ?? null;
  /**
   * ButtonCharacterIcon.UpdateIcon: photo.GetPortrait(session.charid, 256), the image server's portrait and the
   * client's silhouette behind it. None while the image server is not read (and with no flow): the initials then.
   */
  const portraitUrls = $derived.by<readonly string[]>(() => {
    const characterID = $station.online?.characterID ?? null;
    const portrait = characterID === null ? null : portraitUrl($imageServer ?? null, characterID, 256);
    return portrait === null ? [] : [portrait, clientTexture(portraitDefaultPath(256))];
  });
  const balance = $derived($wallet.cashBalance ?? null);
  /** The redeem button's count (redeemsvc.py GetRedeemTokenCount, 56 to 61): how many tokens the account has. */
  const redeemCount = $derived($redeem.tokens?.length ?? 0);

  /**
   * EVE time, re-read on a timer.
   *
   * ⚠ THE STATE IS THE FORMATTED STRING, NOT THE DATE. The rail shows HH:MM, so a
   * per-second `Date` in `$state` would re-render the whole Neocom sixty times
   * for every one time the display could possibly change. Assigning the string
   * instead means the signal only actually changes on the minute, and Svelte's
   * equality check drops the other fifty-nine.
   */
  let clock = $state(eveClock(new Date()));
  /**
   * The login rewards button's mark (loginCampaignService.get_rewards_available): the day's reward may be claimed now.
   * Looked at again as the clock's minute turns, so a reward that comes ready shows without anything else changing.
   */
  const loginRewardDue = $derived.by(() => {
    void clock;
    const { campaign, seasonal } = $loginRewards;
    const now = Date.now();
    const seasonalDue = seasonal === null ? false : seasonal.definition === null
      ? seasonalClaimable(seasonal.active, seasonal.history, now)
      : seasonalView(seasonal.definition, seasonal.active, seasonal.history, $station.cloneGrade !== 0, now).canClaim;
    return (campaign !== null && canClaimNow(campaign, now)) || seasonalDue;
  });
  $effect(() => {
    const tick = (): void => {
      clock = eveClock(new Date());
    };
    tick();
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  });

  /**
   * Pull the wallet once so the rail has a balance to show.
   *
   * The rail is mounted for the whole session, and before this nothing read the
   * wallet until the player opened the Wallet panel — so the readout would have
   * sat at a dash for anyone who never opened it, which is worse than not having
   * it. Fire-and-forget: a failed read leaves the dash, which is the honest
   * answer, and never disturbs the rail.
   */
  /** The image server's address, read once a pilot is online (the portrait is asked of it). */
  let imageServerAsked = false;
  $effect(() => {
    if (!flow || imageServerAsked || $station.online == null) {
      return;
    }
    imageServerAsked = true;
    flow.loadImageServer();
  });

  let walletAsked = false;
  $effect(() => {
    if (!flow || walletAsked || $station.online == null) {
      return;
    }
    walletAsked = true;
    void flow.loadWallet().catch(() => {});
  });
</script>

<nav class="neocom" aria-label="Panels">
  <!-- The pilot plate: the pilot's portrait from the image server the game server names (ButtonCharacterIcon), the
       client's silhouette where it has none; the initials plate until the image server is read. -->
  <div class="neocom-pilot" title={pilotName ?? "No pilot online"}>
    {#if portraitUrls.length > 0}
      <span class="neocom-portrait neocom-portrait-picture" aria-hidden="true"><OwnerPicture name={pilotName ?? ""} urls={portraitUrls} size={28} /></span>
    {:else}
      <span class="neocom-portrait" aria-hidden="true">{initials}</span>
    {/if}
    <span class="neocom-pilot-name">{pilotName ?? "—"}</span>
  </div>

  <ul class="neocom-list">
    {#each tabs as tab (tab.id)}
      <li>
        <button
          type="button"
          class="neocom-item"
          class:open={openIds.has(tab.id)}
          class:active={focusedId === tab.id}
          aria-pressed={openIds.has(tab.id)}
          title={tab.id === "redeem" && redeemCount > 0 ? `${tab.label} (${redeemCount})` : tab.id === "loginRewards" && loginRewardDue ? `${tab.label} (a reward is ready)` : tab.label}
          aria-label={tab.id === "redeem" && redeemCount > 0 ? `${tab.label}, ${redeemCount} to redeem` : tab.id === "loginRewards" && loginRewardDue ? `${tab.label}, a reward is ready` : tab.label}
          onclick={() => onSelect(tab.id)}
        >
          <svg class="neocom-glyph" viewBox="0 0 24 24" aria-hidden="true">
            {#each neocomGlyph(tab.id) as d (d)}
              <path {d} />
            {/each}
          </svg>
          <!-- The name, shown when the rail is wide enough for it (and always to
               a screen reader via aria-label above). Below the desktop
               breakpoint the rail becomes a horizontal strip and these are what
               keep it usable on a phone. -->
          <span class="neocom-item-label">{tab.label}</span>
          {#if tab.id === "redeem" && redeemCount > 0}
            <span class="neocom-badge" aria-hidden="true">{redeemCount}</span>
          {/if}
          {#if tab.id === "loginRewards" && loginRewardDue}
            <span class="neocom-dot" aria-hidden="true"></span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>

  <!-- The two readouts every EVE player keeps half an eye on. -->
  <div class="neocom-readouts">
    <button
      type="button"
      class="neocom-readout neocom-wallet"
      title={`Wallet — ${formatWholeIsk(balance, "round")}`}
      aria-label={`Wallet, ${formatWholeIsk(balance, "round")}. Open the wallet.`}
      onclick={() => onSelect("wallet")}
    >
      <span class="neocom-readout-value">{shortIsk(balance)}</span>
      <span class="neocom-readout-label">ISK</span>
    </button>
    <div class="neocom-readout neocom-clock" title={`EVE time (UTC) — ${clock}`}>
      <span class="neocom-readout-value">{clock}</span>
      <span class="neocom-readout-label">EVE</span>
    </div>
  </div>
</nav>
