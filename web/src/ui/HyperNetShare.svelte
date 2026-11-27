<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { hyperNetLinkLabel, hyperNetOfferLinkText, hyperNetOfferUrl } from "../bridge/hyperNetOfferLink.ts";
  import { labelEscaped } from "../bridge/labelMarkup.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { startLinkDrag } from "./linkFollowers.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, id, name, privateOffer }: {
    store: ClientStore; flow: AppFlow; id: number; name: string; privateOffer: boolean;
  } = $props();
  const hintLabel = "UI/HyperNet/LinkButtonHint";
  const privateLabel = "UI/HyperNet/PrivateRaffle";
  const privateHint = "UI/HyperNet/PrivateRaffleHint";
  const words = $derived(store.words);
  const url = $derived(hyperNetOfferUrl(id));
  const text = $derived(hyperNetOfferLinkText(name, $words.templates[hyperNetLinkLabel]));
  const hint = $derived(plainText($words.templates[hintLabel] ?? "Drag into chat or mail to share this offer") +
    (privateOffer ? "\n\n" + plainText($words.templates[privateHint] ?? "This private offer can be found through its link.") : ""));
  const icon = clientTexture("res:/UI/Texture/classes/HyperNet/hyperlink_icon.png");
  let copied = $state<"copied" | "failed" | null>(null);
  $effect(() => flow.requestWords([hyperNetLinkLabel, hintLabel, privateLabel, privateHint]));

  async function copy() {
    try {
      await navigator.clipboard.writeText(`<a href="${url}">${labelEscaped(text)}</a>`);
      copied = "copied";
    } catch {
      copied = "failed";
    }
  }
</script>

<div class="hypernet-share">
  <button type="button" data-hypernet-share draggable="true" title={hint} aria-label="Copy HyperNet offer link"
    ondragstart={event => startLinkDrag(event, url, text)} onclick={() => void copy()}>
    <img src={icon} alt="" />
    {#if privateOffer}<span data-hypernet-private>{plainText($words.templates[privateLabel] ?? "Private offer")}</span>{/if}
  </button>
  {#if copied}<span role="status">{copied === "copied" ? "Link copied." : "The link could not be copied."}</span>{/if}
</div>

<style>
  .hypernet-share, button { display: flex; align-items: center; gap: 6px; }
  button { cursor: grab; }
  button img { width: 20px; height: 20px; }
</style>
