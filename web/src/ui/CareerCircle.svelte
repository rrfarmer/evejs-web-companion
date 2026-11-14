<script lang="ts">
  // careerPortal/circleView.CircleView: the nodes on a circle. The circle is min(MAX_CIRCLE_WIDTH 800, the window's
  // width / 2) square; a node's size the view's (CareerView min(NODE_MAX_SIZE 180, width * 0.215), ActivityView and
  // GoalView 48); the radius (size - nodeSize) / 2; node i at angle offset + i / count * 2pi (offset -pi/4 for the
  // careers, -pi/2 otherwise), its centre radius * (cos, sin) from the circle's. The outer ring (DashedCircle) a dash
  // between each two nodes, its colour LEAFY_GREEN where every node is completed, else white; the glow fill
  // (circle_glow.png) at 1.33 of the diameter.
  // Not here: the inner circles' masked texture, the animations between views, the node hover glows.
  import type { Snippet } from "svelte";
  let { nodes, size, nodeSize, offset, completed, node, centre }: {
    nodes: readonly unknown[]; size: number; nodeSize: number; offset: number; completed: boolean;
    node: Snippet<[unknown, number]>; centre?: Snippet;
  } = $props();
  import { clientTexture } from "./skillGroupIcons.ts";
  const radius = $derived((size - nodeSize) / 2);
  const at = (i: number) => {
    const a = offset + (i / Math.max(1, nodes.length)) * 2 * Math.PI;
    return { left: size / 2 + radius * Math.cos(a), top: size / 2 + radius * Math.sin(a) };
  };
  // GetOuterCircleVariables: the dashes between the nodes - the circumference less the nodes, each gap a node's width.
  const dash = $derived.by(() => {
    const n = Math.max(1, nodes.length), c = 2 * Math.PI * radius;
    const gap = Math.min(nodeSize, c / n), seg = Math.max(0, c / n - gap);
    return { seg, gap, start: radius * (offset + Math.PI / 2) - gap / 2 };
  });
  const colour = $derived(completed ? "#6ab04c" : "#ffffff");
</script>

<div class="cc" style:width={`${size}px`} style:height={`${size}px`}>
  <img class="cc-glow" alt="" src={clientTexture("res:/UI/Texture/classes/careerPortal/circle_glow.png")} style:width={`${(size - nodeSize) * 1.33}px`} style:height={`${(size - nodeSize) * 1.33}px`} />
  <svg class="cc-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
    <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={colour} stroke-opacity="0.8" stroke-width="2"
      stroke-dasharray={`${dash.seg} ${dash.gap}`} stroke-dashoffset={-dash.gap / 2} transform={`rotate(${(offset * 180) / Math.PI} ${size / 2} ${size / 2})`} />
  </svg>
  {#if centre}<div class="cc-centre">{@render centre()}</div>{/if}
  {#each nodes as n, i (i)}
    {@const p = at(i)}
    <div class="cc-node" style:left={`${p.left - nodeSize / 2}px`} style:top={`${p.top - nodeSize / 2}px`} style:width={`${nodeSize}px`} style:height={`${nodeSize}px`}>{@render node(n, i)}</div>
  {/each}
</div>

<style>
  .cc { position: relative; flex: none; margin: 0 auto; }
  .cc-glow { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); opacity: 0.25; pointer-events: none; }
  .cc-ring { position: absolute; inset: 0; pointer-events: none; }
  .cc-centre { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); text-align: center; max-width: 50%; }
  .cc-node { position: absolute; display: flex; align-items: center; justify-content: center; }
</style>
