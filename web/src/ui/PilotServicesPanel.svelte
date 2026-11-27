<script lang="ts">
  import { onMount } from "svelte";
  import { bridgeAsk } from "../app/api.ts";
  import { isSessionLost, type AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { readDictPairs, unwrapLong } from "../bridge/wire.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { LiveNotification } from "../store/types.ts";
  import PlexVaultBalance, { type PlexVaultStoreActions } from "./PlexVaultBalance.svelte";
  import { showInfo } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, vaultStoreActions }: {
    store: ClientStore; flow: AppFlow; vaultStoreActions?: PlexVaultStoreActions;
  } = $props();
  const words = $derived(store.words);
  const license = "UI/CharacterSheet/CharacterSheetWindow/PilotLicense/";
  const skillTabs = "UI/CharacterSheet/CharacterSheetWindow/SkillTabs/";
  const trainingToken = 34133;
  const labels = {
    clone: license + "CloneState", plex: license + "PlexDescription", expires: license + "DaysLeft",
    alpha: skillTabs + "CurrentCloneStateAlpha", alphaHint: skillTabs + "CurrentCloneStateAlphaDescription",
    omega: skillTabs + "CurrentCloneStateOmega", omegaHint: skillTabs + "CurrentCloneStateOmegaDescription",
    training: license + "MultipleCharacterTitle", detail: license + "MultipleCharacterDescription",
    active: license + "AdditionalQueueActive", inactive: license + "AdditionalQueueNotActive", slotExpiry: license + "AdditionalQueueExpires",
  };
  let omegaTime = $state<string | null | undefined>(undefined);
  let training = $state<readonly string[] | undefined>(undefined);
  let subscriptionError = $state("");
  let trainingError = $state("");
  let subscriptionRequest = 0;
  let trainingRequest = 0;

  function word(label: string, fallback: string, args: TemplateArguments = {}): string {
    const template = $words.templates[label] || fallback;
    return plainText(formatTemplate(template, args, { nameOf: () => "" }));
  }

  const description = $derived($words.templates[labels.detail] ||
    'Activate a <a href="showinfo:{typeID}">Multiple Pilot Training Certificate</a> to train another character on this account at the same time.');
  const descriptionLink = $derived(/<a href="showinfo:\{typeID\}">([\s\S]*?)<\/a>/i.exec(description));
  const cloneGrade = $derived(omegaTime ? "Omega" : "Alpha");

  async function readSubscription() {
    const request = ++subscriptionRequest;
    subscriptionError = "";
    try {
      const raw = await bridgeAsk(flow.requestOptions())("subscriptionMgr", "GetSubscriptionTime", []);
      if (request !== subscriptionRequest) return;
      const time = unwrapLong(raw);
      if (raw !== null && time === null) throw new Error("Could not read subscription time.");
      omegaTime = time && time > 0n ? time.toString() : null;
    } catch (cause) {
      if (request === subscriptionRequest && !isSessionLost(cause)) subscriptionError = panelErrorWords(cause);
    }
  }

  async function readTraining() {
    const request = ++trainingRequest;
    trainingError = "";
    try {
      const raw = await bridgeAsk(flow.requestOptions())("userSvc", "GetMultiCharactersTrainingSlots", []);
      if (request !== trainingRequest) return;
      if (typeof raw !== "object" || raw === null || !("type" in raw) || raw.type !== "dict" || !Array.isArray(raw.entries)) {
        throw new Error("Could not read additional training queues.");
      }
      training = readDictPairs(raw).map(([id, value]) => ({ id: Number(id), time: unwrapLong(value) }))
        .filter(row => Number.isSafeInteger(row.id) && row.time !== null && row.time > 0n)
        .sort((a, b) => a.id - b.id).slice(0, 2).map(row => String(row.time));
    } catch (cause) {
      if (request === trainingRequest && !isSessionLost(cause)) trainingError = panelErrorWords(cause);
    }
  }

  onMount(() => {
    flow.requestWords(Object.values(labels));
    void readSubscription();
    void readTraining();
    const latest = (rows: readonly LiveNotification[], method: string) => rows.findLast(row => row.method === method);
    const initial = store.live.get().notifications;
    let subscriptionNotice = latest(initial, "OnSubscriptionTimeUpdateServer");
    let trainingNotice = latest(initial, "OnMultipleCharactersTrainingUpdated");
    const unsubscribe = store.live.subscribe(({ notifications }) => {
      const subscription = latest(notifications, "OnSubscriptionTimeUpdateServer");
      const queues = latest(notifications, "OnMultipleCharactersTrainingUpdated");
      if (subscription && subscription !== subscriptionNotice) void readSubscription();
      if (queues && queues !== trainingNotice) void readTraining();
      subscriptionNotice = subscription;
      trainingNotice = queues;
    });
    return () => { unsubscribe(); subscriptionRequest++; trainingRequest++; };
  });
</script>

<section class="pilot-services" aria-label="Pilot Services" data-pilot-services>
  <PlexVaultBalance {flow} {store} storeActions={vaultStoreActions} inventoryDrop />
  <div class="license">
    <h3>{word(labels.clone, "Clone State Omega")}</h3>
    <p>{word(labels.plex, "Use PLEX to extend Omega game time.")}</p>
    {#if subscriptionError}<p role="alert">{subscriptionError}</p>{/if}
    {#if omegaTime !== undefined}
      <div class="clone" data-clone-grade={cloneGrade}>
        <img alt="" title={word(omegaTime ? labels.omegaHint : labels.alphaHint, cloneGrade)}
          src={clientTexture(`res:/UI/Texture/Classes/CloneGrade/${cloneGrade}_64.png`)} />
        <div>
          <strong>{omegaTime ? word(labels.omega, "Current clone state: Omega") : word(labels.alpha, "Current clone state: Alpha")}</strong>
          {#if omegaTime}<p>{word(labels.expires, "Expires {[datetime]expireDate}", { expireDate: omegaTime })}</p>{/if}
        </div>
      </div>
    {:else if !subscriptionError}
      <p role="status">Loading clone state…</p>
    {/if}
    <h3>{word(labels.training, "Multiple Character Training")}</h3>
    {#if descriptionLink}
      <p>{plainText(description.slice(0, descriptionLink.index))}<button class="type-link" type="button"
        onclick={() => showInfo({ kind: "type", typeID: trainingToken })}>{plainText(descriptionLink[1] ?? "")}</button>{plainText(description.slice(descriptionLink.index + descriptionLink[0].length))}</p>
    {:else}
      <p>{plainText(description)}</p>
    {/if}
    {#if trainingError}<p role="alert">{trainingError}</p>{/if}
    {#if training !== undefined}
      <ol class="queues" aria-label="Additional training queues">
        {#each [training[0], training[1]] as expiry, slot (slot)}
          <li class:active={!!expiry} data-training-slot={slot + 1} data-training-active={!!expiry}>
            <img alt="" src={clientTexture("res:/UI/Texture/Icons/additional_training_queue.png")} />
            <strong>{expiry ? word(labels.active, "Additional training queue active") : word(labels.inactive, "Additional training queue not active")}</strong>
            {#if expiry}<span>{word(labels.slotExpiry, "Expires {[datetime]expiryDate}", { expiryDate: expiry })}</span>{/if}
          </li>
        {/each}
      </ol>
    {:else if !trainingError}
      <p role="status">Loading training queues…</p>
    {/if}
  </div>
</section>

<style>
  .license { padding: 0 14px 14px; }
  h3 { margin: 18px 0 4px; }
  p { margin: 4px 0 10px; }
  .clone, .queues li { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #0005; }
  .clone img { width: 55px; height: 55px; }
  .clone p { margin: 4px 0 0; }
  .queues { display: grid; gap: 4px; padding: 0; margin: 0; }
  .queues img { width: 17px; height: 17px; opacity: .3; }
  .queues li.active strong { color: #48d971; }
  .queues li.active img { opacity: 1; }
  .queues span { margin-inline-start: auto; }
  .type-link { display: inline; padding: 0; border: 0; background: transparent; text-decoration: underline; }
  [role="alert"] { color: #fc9c95; }
</style>
