<script lang="ts">
  // agencyNew/ui/contentPages/contentPageProjectDiscovery: on the left a Section 330 wide (UI/Agency/ProjectDiscovery/
  // Caption) with Description; on the right, 10 in, a Section 450 wide (CurrentProject): the window icon (64) beside
  // the active project's title (bold, white) and description, the project's image (430 x 230, centred, 10 below), and
  // Open Project Discovery (its window icon) on the right, 16 below. projectdiscovery/common/const ACTIVE_PROJECT_ID is
  // COVID_PROJECT_ID: projectdiscovery/client/ui/const TITLE_BY_PROJECT_ID (Covid/Covid), DESCRIPTION_BY_PROJECT_ID
  // (Covid/Description), IMAGE_BY_PROJECT_ID (projectDiscovery_Covid.png).
  // Not here: the Project Discovery window itself (get_project_discovery_window_class().Open; its button drawn disabled).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import LabelText from "./LabelText.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const P = "UI/Agency/ProjectDiscovery/";
  const markup = (label: string) => formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  const word = (label: string) => plainText(markup(label));
  $effect(() => { flow.requestWords([`${P}Caption`, `${P}Description`, `${P}CurrentProject`, `${P}Covid/Covid`, `${P}Covid/Description`, `${P}OpenProjectDiscovery`]); });
  const ICON = "res:/UI/Texture/WindowIcons/projectDiscovery.png";
</script>

<div class="apd">
  <section class="apd-sec apd-left"><h4>{word(`${P}Caption`)}</h4><div><LabelText markup={markup(`${P}Description`)} /></div></section>
  <section class="apd-sec apd-right"><h4>{word(`${P}CurrentProject`)}</h4>
    <div class="apd-head"><img alt="" src={clientTexture(ICON)} /><div><b>{word(`${P}Covid/Covid`)}</b><div class="apd-desc"><LabelText markup={markup(`${P}Covid/Description`)} /></div></div></div>
    <img class="apd-image" alt="" src={clientTexture("res:/UI/Texture/classes/agency/ActivityImages/projectDiscovery_Covid.png")} />
    <div class="apd-btn"><button type="button" disabled><img alt="" src={clientTexture(ICON)} />{word(`${P}OpenProjectDiscovery`)}</button></div>
  </section>
</div>

<style>
  .apd { display: flex; gap: 10px; font-size: 13px; }
  .apd-sec { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 6px 10px 10px; box-sizing: border-box; }
  .apd-sec h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; opacity: 0.8; }
  .apd-left { width: 330px; flex: none; }
  .apd-right { width: 450px; flex: none; }
  .apd-head { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
  .apd-head > img { width: 64px; height: 64px; }
  .apd-head b { color: #fff; }
  .apd-desc { margin-top: 4px; }
  .apd-image { display: block; width: 430px; height: 230px; margin: 10px auto 0; }
  .apd-btn { display: flex; justify-content: flex-end; margin-top: 16px; }
  .apd-btn button { display: inline-flex; align-items: center; gap: 6px; }
  .apd-btn img { width: 16px; height: 16px; }
</style>
