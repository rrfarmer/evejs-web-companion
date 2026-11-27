<script lang="ts">
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { PANE_LABELS } from "../bridge/missionObjectivePane.ts";
  import LabelText from "./LabelText.svelte";
  import { LINK_WORDS } from "./linkFollowers.ts";

  let { dungeonID, special, templates, onOpen }: {
    dungeonID: number;
    special: boolean;
    templates: Readonly<Record<string, string | null | undefined>>;
    onOpen: (dungeonID: number) => void;
  } = $props();

  const link = $derived(`mission-ship-restrictions:${dungeonID}`);
  const hint = $derived(plainText(templates["UI/Commands/ShowInfo"] ?? LINK_WORDS["UI/Commands/ShowInfo"]));
  const markup = $derived.by(() => {
    const label = special ? PANE_LABELS.specialShipRestrictions : PANE_LABELS.normalShipRestrictions;
    const fallback = special ? "This site contains special {startHttpLink}ship restrictions{endHttpLink}."
      : "This site contains normal {startHttpLink}ship restrictions{endHttpLink}.";
    const notice = formatTemplate(templates[label] ?? fallback, {
      startHttpLink: `<a href="${link}">`, endHttpLink: "</a>",
    }, { nameOf: () => "" });
    return special ? `<color=0xffe3170d>${notice}</color>` : notice;
  });
</script>

<div class="objective-restrictions">
  <LabelText {markup} followerOf={url => url === link
    ? { kind: "showInfo", hint, follow: () => onOpen(dungeonID) } : null} />
</div>
