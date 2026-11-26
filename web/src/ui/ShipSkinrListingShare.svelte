<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { labelEscaped } from "../bridge/labelMarkup.ts";
  import { shipSkinrListingUrl } from "../bridge/shipSkinrListingLink.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { startLinkDrag } from "./linkFollowers.ts";

  let { store, flow, id, name }: { store: ClientStore; flow: AppFlow; id: string; name: string } = $props();
  const prefix = "UI/Personalization/ShipSkins/SKINR/";
  const labels = {
    text: [prefix + "Store/SkinListingLink", "Paragon Hub Listing: {name}"],
    share: [prefix + "Store/DragToShareShipSkinListing", "Click to copy or drag into chat to share this listing"],
    copied: [prefix + "LinkCopiedToClipboard", "Link copied to clipboard."],
    failed: [prefix + "LinkClipboardError", "The link could not be copied."],
  } as const;
  const words = $derived(store.words);
  const word = (key: keyof typeof labels) => $words.templates[labels[key][0]] ?? labels[key][1];
  const url = $derived(shipSkinrListingUrl(id));
  const text = $derived(plainText(formatTemplate(word("text"), { name: labelEscaped(name) }, { nameOf: () => "" })));
  let status = $state("");

  $effect(() => { flow.requestWords(Object.values(labels).map(([path]) => path)); });

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(`<a href="${url}">${labelEscaped(text)}</a>`);
      status = plainText(word("copied"));
    } catch {
      status = plainText(word("failed"));
    }
  }
</script>

{#if url}
  <button type="button" draggable="true" title={plainText(word("share"))}
    ondragstart={event => { if (url) startLinkDrag(event, url, text); }} onclick={() => void copy()}>Copy Listing Link</button>
  {#if status}<span class="copy-status" role="status">{status}</span>{/if}
{/if}

<style>
  .copy-status { display: block; margin-top: 6px; }
</style>
