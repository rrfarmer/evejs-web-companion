<script lang="ts">
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { PANE_LABELS } from "../bridge/missionObjectivePane.ts";
  import LabelText from "./LabelText.svelte";

  let { listID, nameID, templates, onOpen }: {
    listID: number;
    nameID: number | null;
    templates: Readonly<Record<string, string | null | undefined>>;
    onOpen: (listID: number, nameID: number | null) => void;
  } = $props();

  const link = $derived(`mission-fitted-restrictions:${listID}`);
  const hint = $derived(plainText(templates["UI/Commands/ShowInfo"] ?? "Show Info"));
  const notice = $derived(formatTemplate(
    templates[PANE_LABELS.fittedRestrictions] ?? "This site contains special {startHttpLink}fitting restrictions{endHttpLink}.",
    { startHttpLink: `<a href="${link}">`, endHttpLink: "</a>" },
    { nameOf: () => "" },
  ));
</script>

<div class="objective-fitted-restrictions">
  <LabelText markup={`<color=0xffe3170d>${notice}</color>`} followerOf={url => url === link
    ? { kind: "showInfo", hint, follow: () => onOpen(listID, nameID) } : null} />
</div>
