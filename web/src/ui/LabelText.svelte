<!--
  A text in the client's label markup, drawn as the client's label draws it (bridge/labelMarkup.ts: trinity's
  ParseLabelText and carbonui's label walking its tags). Each line its own block, aligned as its tags say; its tab
  cells side by side; each run bold, italic, underlined, coloured, sized or spaced as marked; a link drawn as a link
  followed where the caller supplies the client's link registry; a hint shown on the pointer. An empty line keeps
  its height, as the label pushes a space for it.
-->
<script lang="ts">
  import { labelColorCss, labelLines, type LabelRun } from "../bridge/labelMarkup.ts";
  import { startLinkDrag, type LinkFollower } from "./linkFollowers.ts";

  let { markup, followerOf }: { markup: string; followerOf?: (url: string, text: string) => LinkFollower | null } = $props();
  const lines = $derived(labelLines(markup));
</script>

<!-- No whitespace between the tags inside a line: under pre-wrap it would be drawn as text. -->
{#each lines as line, n (n)}
  <div class="label-line" style:text-align={line.align}>{#each line.tabs as cell, c (c)}<span
        class="label-cell" class:tabbed={line.tabs.length > 1}>{#each cell as run, r (r)}{@const follower = run.link === null ? null : followerOf?.(run.link, run.text)}{#if follower}<button type="button"
          class="evelink {follower.kind}" title={run.hint ?? follower.hint} draggable="true"
          ondragstart={event => startLinkDrag(event, run.link ?? "", run.text)} onclick={follower.follow}
          oncontextmenu={follower.contextMenu} onkeydown={event => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) follower.contextMenu?.(event);
          }}>{@render styledRun(run)}</button>{:else}{@render styledRun(run)}{/if}{/each}</span>{/each}{#if line.tabs.every((cell) => cell.length === 0)}&nbsp;{/if}</div>
{/each}

{#snippet styledRun(run: LabelRun)}<span
            class:label-bold={run.bold}
            class:label-italic={run.italic}
            class:label-underline={run.underline}
            class:label-link={run.link !== null}
            style:color={run.color === null ? undefined : labelColorCss(run.color)}
            style:font-size={run.fontSize === null ? undefined : `${run.fontSize}px`}
            style:letter-spacing={run.letterSpace === null ? undefined : `${run.letterSpace}px`}
            title={run.hint ?? undefined}>{run.text}</span>{/snippet}

<style>
  .label-line { white-space: pre-wrap; overflow-wrap: anywhere; }
  .label-cell.tabbed { display: inline-block; min-width: 1rem; margin-right: 1rem; vertical-align: top; }
  .label-bold { font-weight: 700; }
  .label-italic { font-style: italic; }
  .label-underline { text-decoration: underline; }
  .label-link { color: var(--color-accent-bright, #a9d3f0); }
  .label-link:hover { text-decoration: underline; }
</style>
