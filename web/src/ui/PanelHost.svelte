<script lang="ts">
  // The main-area host for a SELECTED tab — static (a Neocom pick) or
  // state-specific (a shell control). One place the tab -> real component
  // mapping lives, so App and both shells stay thin routers. Every panel here is
  // a pre-existing, working component; only the two state SHELLS themselves are
  // still placeholder chrome.
  import StationPanel from "./StationPanel.svelte";
  import Fitting from "./Fitting.svelte";
  import ProvisioningPanel from "./ProvisioningPanel.svelte";
  import Industry from "./Industry.svelte";
  import Market from "./Market.svelte";
  import Activity from "./Activity.svelte";
  import FleetCenter from "./FleetCenter.svelte";
  import Scanner from "./Scanner.svelte";
  import Mail from "./Mail.svelte";
  import Contacts from "./Contacts.svelte";
  import Watchlist from "./Watchlist.svelte";
  import Locations from "./Locations.svelte";
  import Contracts from "./Contracts.svelte";
  import PersonalAssets from "./PersonalAssets.svelte";
  import AgentsMissions from "./AgentsMissions.svelte";
  import AgentFinder from "./AgentFinder.svelte";
  import Flight from "./Flight.svelte";
  import Mining from "./Mining.svelte";
  import DronesPanel from "./DronesPanel.svelte";
  import ShotsPanel from "./ShotsPanel.svelte";
  import EquipmentPanel from "./EquipmentPanel.svelte";
  import Skills from "./Skills.svelte";
  import Planets from "./Planets.svelte";
  import Travel from "./Travel.svelte";
  import RouteWindow from "./RouteWindow.svelte";
  import MissionTracker from "./MissionTracker.svelte";
  import TypeCompare from "./TypeCompare.svelte";
  import Bots from "./Bots.svelte";
  import BotBuilder from "./BotBuilder.svelte";
  import Chat from "./Chat.svelte";
  import Wallet from "./Wallet.svelte";
  import CorpWallet from "./CorpWallet.svelte";
  import RedeemItems from "./RedeemItems.svelte";
  import LoginRewards from "./LoginRewards.svelte";
  import CharacterSheet from "./CharacterSheet.svelte";
  import CorporationWindow from "./CorporationWindow.svelte";
  import CorporationMemberDetails from "./CorporationMemberDetails.svelte";
  import CorporationMedalDesigner from "./CorporationMedalDesigner.svelte";
  import Settings from "./Settings.svelte";
  import NoticeLog from "./NoticeLog.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { deriveDocked, tabLabel, type TabID } from "./tabs.ts";
  import { globalWindowView } from "./globalWindowViews.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { Session } from "../app/sessions.ts";

  let {
    store,
    flow,
    tab,
    onOpen,
    onClose,
    sessions,
    onGoToPilot,
  }: {
    store: ClientStore;
    flow: AppFlow;
    tab: TabID;
    /**
     * Lets a panel navigate to another tab (e.g. Agent Finder -> Travel).
     *
     * The optional `sessionID` says WHICH pilot's workspace to open it on, and
     * exists for the Bot Manager: it lists every held pilot, and setting up a
     * built-in bot on one of them has to happen on that pilot's workspace,
     * because the panel reads the mounted pilot's fitting and holds. Omitted
     * means the active pilot, which is what every other caller wants.
     */
    onOpen?: (tab: TabID, sessionID?: string) => void;
    onClose?: () => void;
    // R107 — the full pilot roster (every session, not just the active one).
    // Optional and forwarded only to the Bot Manager panel, which is the only
    // one that needs to see pilots beyond its own store/flow.
    sessions?: readonly Session[];
    /**
     * Make another pilot the active cockpit. Forwarded to the global windows,
     * a roster of pilots among them, whose rows
     * are ABOUT a pilot you are not currently flying.
     */
    onGoToPilot?: (sessionID: string) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const stationSlice = store.station;
  // svelte-ignore state_referenced_locally
  const memberDetails = flow.memberDetailsShown;
  // svelte-ignore state_referenced_locally
  const medalDesigner = flow.medalDesignerShown;

  /**
   * Whether the pilot is docked, from the AUTHORITATIVE flag.
   *
   * ⚠ THE "Inventory & Ship" WINDOW IS THE STATION PANEL NOW, in both states —
   * one component, told where it is. It replaced `InventoryShip.svelte`, which
   * drew the Ship Hangar, Item Hangar and Corporate Hangar tabs while flying:
   * three places a pilot in space cannot reach, showing whatever the last
   * docked read had left in the store.
   */
  const isDocked = $derived(deriveDocked($flight.status, $stationSlice.online));

  /**
   * A global window's body, when `tab` is one (globalWindowViews.ts). On the
   * desktop these float on App's layer and never reach this host; a phone has no
   * floating layer, so here a global tab is a panel like any other.
   *
   * ⚠ NOT THE MOUNTED PILOT'S. Each is about every pilot and is given neither
   * this pilot's store nor its flow: the Bot Manager and plugin windows read
   * each session's own store, the PI board reads through throwaway sign-ins,
   * and an industry plan spans every signed-in pilot's blueprints.
   */
  const GlobalView = $derived(globalWindowView(tab));
</script>

<!-- One panel's failure is that panel's failure: a boundary per host keeps a
     broken Market from taking the Overview, the HUD and the character bar down
     with it, and names the panel in the report (see ErrorBoundary.svelte). -->
<ErrorBoundary name={tabLabel(tab)}>
{#if GlobalView}
  <GlobalView {sessions} onOpen={(id, sid) => onOpen?.(id, sid)} {onGoToPilot} />
{:else if tab === "inventory"}
  <StationPanel {store} {flow} {isDocked} {onClose} />
{:else if tab === "fitting"}
  <Fitting {store} {flow} showInventory={() => onOpen?.("inventory")} />
{:else if tab === "provisioning"}
  <ProvisioningPanel {store} {flow} />
{:else if tab === "industry"}
  <Industry {store} {flow} />
{:else if tab === "market"}
  <Market {store} {flow} />
{:else if tab === "activity"}
  <Activity {store} {flow} showMail={() => onOpen?.("mail")} openApplications={() => { flow.requestCorporationApplications(); onOpen?.("corporation"); }} />
{:else if tab === "fleet"}
  <FleetCenter {store} {flow} />
{:else if tab === "scanner"}
  <Scanner {store} {flow} />
{:else if tab === "mail"}
  <!-- A skill plan link in a mail, followed (link.py handle_link): the Skills window opens on it. -->
  <Mail {store} {flow} openSkillPlanLink={(url) => { flow.openSkillPlanLink(url); onOpen?.("skills"); }} />
{:else if tab === "contacts"}
  <Contacts {store} {flow} showAgents={() => onOpen?.("agents")} openMail={() => onOpen?.("mail")} openWatchlist={() => onOpen?.("watchlist")} />
{:else if tab === "locations"}
  <Locations {store} {flow} />
{:else if tab === "contracts"}
  <Contracts {store} {flow} />
{:else if tab === "assets"}
  <PersonalAssets {store} {flow} />
{:else if tab === "agents"}
  <AgentsMissions {store} {flow} />
{:else if tab === "finder"}
  <AgentFinder {store} {flow} showTravel={() => onOpen?.("travel")} />
{:else if tab === "flight"}
  <Flight {store} {flow} />
{:else if tab === "mining"}
  <Mining {store} {flow} />
{:else if tab === "drones"}
  <DronesPanel {store} {flow} />
{:else if tab === "shots"}
  <ShotsPanel {store} {flow} />
{:else if tab === "equipment"}
  <EquipmentPanel {store} {flow} />
{:else if tab === "skills"}
  <Skills {store} {flow} />
{:else if tab === "planets"}
  <Planets {store} {flow} />
{:else if tab === "travel"}
  <Travel {store} {flow} showRouteWindow={() => onOpen?.("routeWindow")} />
{:else if tab === "routeWindow"}
  <RouteWindow {store} {flow} />
{:else if tab === "missionTracker"}
  <MissionTracker {store} {flow} showAgents={() => onOpen?.("agents")} />
{:else if tab === "bots"}
  <Bots {store} {flow} />
{:else if tab === "botBuilder"}
  <BotBuilder {store} {flow} />
{:else if tab === "wallet"}
  <Wallet {store} {flow} />
{:else if tab === "corpWallet"}
  <CorpWallet {store} {flow} />
{:else if tab === "redeem"}
  <RedeemItems {store} {flow} />
{:else if tab === "loginRewards"}
  <LoginRewards {store} {flow} />
{:else if tab === "characterSheet"}
  <CharacterSheet {store} {flow} />
{:else if tab === "corporation"}
  <CorporationWindow {store} {flow} openMail={() => onOpen?.("mail")} openWatchlist={() => onOpen?.("watchlist")} />
{:else if tab === "memberDetails"}
  {#key $memberDetails?.characterID}<CorporationMemberDetails {store} {flow} {onClose} />{/key}
{:else if tab === "medalDesigner"}
  {#key $medalDesigner?.instance}<CorporationMedalDesigner {store} {flow} {onClose} />{/key}
{:else if tab === "watchlist"}
  <Watchlist {store} {flow} />
{:else if tab === "settings"}
  <Settings {store} {flow} />
{:else if tab === "log"}
  <!--
    ⚠ THIS BRANCH WAS MISSING, AND NOTHING SAID SO. `NoticeLog` was imported
    here and never rendered, so the Neocom's "Log" fell through to the `{:else}`
    below and told the player the panel no longer existed. `panelHost.test.ts`
    now walks every tab in `tabs.ts` against this chain so the next one cannot
    hide the same way.
  -->
  <NoticeLog />
{:else if tab === "chat"}
  <!-- A skill plan link in a message, followed (link.py handle_link): the Skills window opens on it. -->
  <Chat {store} {flow} openSkillPlanLink={(url) => { flow.openSkillPlanLink(url); onOpen?.("skills"); }} />
{:else if tab === "compare"}
  <TypeCompare {store} {flow} />
{:else}
  <!-- Every tab in `tabs.ts` is named above; this is the arm for a `TabID` that
       does not exist yet, and it says so rather than guessing. -->
  <p class="empty">There is no panel called {tab} yet.</p>
{/if}
</ErrorBoundary>
