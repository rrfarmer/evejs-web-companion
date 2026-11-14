<script lang="ts">
  // agencyNew/ui/contentPages/contentPagePhasedFields.ContentPagePhasedFields: two columns (CONTENT_PAGE_WIDTH_HALF each,
  // 500 high). The left: Overview (OverviewHeader, OverviewText), then 10 below it Fracture (FractureHeader,
  // FractureText). The right: Phased Asteroid States (its header; the video phasedFieldsStages, looping, 436 x 102, 8
  // below; PhasedAsteroidStatesText 8 below). The texts with their links.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { LINK_WORDS, linkFollowerOf } from "./linkFollowers.ts";
  import LabelText from "./LabelText.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const P = "UI/Agency/PhasedFields/";
  const markup = (label: string) => formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  const word = (label: string) => plainText(markup(label));
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => word(label), text);
  $effect(() => { flow.requestWords([...Object.keys(LINK_WORDS), ...["Overview", "Fracture", "PhasedAsteroidStates"].flatMap((k) => [`${P}${k}Header`, `${P}${k}Text`])]); });
</script>

<div class="apf">
  <div class="apf-col">
    <section class="apf-sec"><h4>{word(`${P}OverviewHeader`)}</h4><LabelText markup={markup(`${P}OverviewText`)} {followerOf} /></section>
    <section class="apf-sec apf-gap"><h4>{word(`${P}FractureHeader`)}</h4><LabelText markup={markup(`${P}FractureText`)} {followerOf} /></section>
  </div>
  <div class="apf-col">
    <section class="apf-sec"><h4>{word(`${P}PhasedAsteroidStatesHeader`)}</h4>
      <!-- svelte-ignore a11y_media_has_caption -->
      <video class="apf-video" autoplay loop muted src={clientTexture("res:/video/agency/phasedFieldsStages.webm")}></video>
      <div class="apf-after"><LabelText markup={markup(`${P}PhasedAsteroidStatesText`)} {followerOf} /></div>
    </section>
  </div>
</div>

<style>
  .apf { display: flex; height: 500px; max-height: 100%; font-size: 13px; line-height: 1.35; }
  .apf-col { flex: 1; min-width: 0; overflow: auto; padding: 0 20px; }
  .apf-sec { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 6px 10px 10px; }
  .apf-sec h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; opacity: 0.8; }
  .apf-gap { margin-top: 10px; }
  .apf-video { display: block; width: 436px; height: 102px; max-width: 100%; margin-top: 8px; object-fit: cover; }
  .apf-after { margin-top: 8px; }
</style>
