<script lang="ts">
  // The market's Price History tab as the client draws it (eve/client/script/ui/shared/market/pricehistorychart.py
  // PriceHistory, marketGraph.py MarketGraph, carbonui/graphs):
  //
  //   the view       the graph at first (settings pricehistorytype 0), a button under it (ShowTable / ShowGraph) that
  //                  turns it into the table and back; the table's Time picker (5, 10 days, a month, 3, 6 months, a
  //                  year; 90 at first) beside the button while the table shows
  //   the table      the last Time + 1 days: Date, Orders, Quantity, Lowest, Highest, Average (FmtDate, FmtAmt,
  //                  FmtCurrency without the currency)
  //   the graph      the last 365 days, the last 30 in view (default_zoom); the top axis the months (30 high), the left
  //                  the price (70 wide; its data the average, low, high and both moving averages of the days in view,
  //                  margins 0.4 below and 0.15 above, ~10 ticks, none below 0), the right the volume (50 wide, from
  //                  nought, its bars in the bottom 0.3); the volume bars graphColors[0], the Donchian channel (5-day
  //                  MovingLow of the lows to MovingHigh of the highs) in (0.8, 0.8, 1, 0.1225), each day's low-high
  //                  line white at 0.2, the 5- and 20-day moving averages of the average graphColors[2] and [4], the
  //                  day's average a point graphColors[3]; a grid of the price ticks and the months at 0.1; a legend
//                  (_RebuildLegend: MedianDayPrice, MinMax, MovingAvg 5d / 20d, DonchianChannel, Volume)
  //
  // Not yet: the zoom and pan, the minimap under it, the settings menu (which series show, scale to data, the
  // animations), the hints.
  import type { MarketPriceHistoryRow } from "../store/types.ts";

  let { rows, word, isk }: {
    rows: readonly MarketPriceHistoryRow[];
    word: (label: string, args?: Record<string, string | number>) => string;
    isk: (value: string | number | null) => string;
  } = $props();

  let showTable = $state(false);
  let days = $state(90);
  const TIME_OPTIONS = [5, 10, 30, 90, 180, 365] as const;

  const dayMs = (day: bigint | null): number => (day === null ? NaN : Number(day / 10000n - 11644473600000n));
  const dateText = (day: bigint | null): string => {
    const ms = dayMs(day);
    return Number.isFinite(ms) ? new Date(ms).toLocaleDateString(undefined, { timeZone: "UTC" }) : "—";
  };
  /** the days in order, oldest first */
  const ordered = $derived([...rows].sort((a, b) => dayMs(a.day) - dayMs(b.day)));
  const tableRows = $derived(ordered.length > days ? ordered.slice(-(days + 1)) : ordered);
  const timeLabel = (n: number): string =>
    n === 30 ? word("UI/Common/DateWords/Month") : n === 365 ? word("UI/Common/DateWords/Year") : n >= 90 ? `${n / 30} ${word("UI/Common/DateWords/Months")}` : `${n} ${word("UI/Common/DateWords/Days")}`;

  // --- the graph -------------------------------------------------------------------------------------------------
  const COLORS = ["rgb(0, 63, 79)", "rgb(25, 102, 122)", "rgb(21, 169, 207)", "rgb(145, 70, 0)", "rgb(207, 111, 21)"];
  const W = 640, H = 300, TOP = 30, LEFT = 70, RIGHT = 50;
  const movingOp = (values: number[], op: (l: number[]) => number, n: number) => values.map((_, i) => op(values.slice(Math.max(i - n, 0), i + 1)));
  const graph = $derived.by(() => {
    const data = ordered.slice(-365);
    if (data.length === 0) return null;
    const avg = data.map((d) => Number(d.average)), low = data.map((d) => Number(d.low)), high = data.map((d) => Number(d.high));
    const vol = data.map((d) => d.volume);
    const mean = (l: number[]) => l.reduce((a, b) => a + b, 0) / l.length;
    const ma5 = movingOp(avg, mean, 5), ma20 = movingOp(avg, mean, 20);
    const donLow = movingOp(low, (l) => Math.min(...l), 5), donHigh = movingOp(high, (l) => Math.max(...l), 5);
    const count = data.length, zoom = Math.min(30, count);
    const first = count - zoom;
    const view = (l: number[]) => l.slice(first);
    const vals = [...view(avg), ...view(low), ...view(high), ...view(ma5), ...view(ma20)].filter(Number.isFinite);
    let min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || Math.abs(max) * 0.1 || 1;
    min = Math.max(0, min - span * 0.4); max = max + span * 0.15;
    const volMax = Math.max(1, ...view(vol));
    const innerW = W - LEFT - RIGHT, innerH = H - TOP;
    const x = (i: number) => LEFT + ((i - first + 0.5) / zoom) * innerW;
    const y = (v: number) => TOP + (1 - (v - min) / (max - min)) * innerH;
    const vy = (v: number) => H - (v / volMax) * innerH * 0.3;
    // ~10 ticks at a round step
    const raw = (max - min) / 10, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
    const ticks: number[] = [];
    for (let t = Math.ceil(min / step) * step; t <= max; t += step) if (t >= 0) ticks.push(t);
    const months: { x: number; label: string }[] = [];
    for (let i = first; i < count; i++) {
      const d = new Date(dayMs(data[i]!.day));
      if (d.getUTCDate() === 1 || i === first) months.push({ x: x(i), label: d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" }) });
    }
    const line = (l: number[]) => l.slice(first).map((v, k) => `${k ? "L" : "M"}${x(first + k).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const band = view(donHigh).map((v, k) => `${k ? "L" : "M"}${x(first + k).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
      + " " + view(donLow).map((v, k) => [x(first + k), y(v)] as const).reverse().map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join(" ") + " Z";
    const barW = Math.max(2, Math.min(20, (innerW / zoom) * 0.6));
    return {
      ticks: ticks.map((t) => ({ y: y(t), label: Math.abs(t) < 100 ? t.toFixed(1) : t < 1e3 ? t.toLocaleString(undefined, { maximumFractionDigits: 1 }) : t >= 1e9 ? `${(t / 1e9).toFixed(2)}B` : t >= 1e6 ? `${(t / 1e6).toFixed(2)}M` : t >= 1e3 ? `${(t / 1e3).toFixed(2)}K` : Math.round(t).toString() })),
      volTicks: [0, volMax / 2, volMax].map((v) => ({ y: vy(v), label: v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : Math.round(v).toString() })),
      months,
      bars: view(vol).map((v, k) => ({ x: x(first + k) - barW / 2, y: vy(v), w: barW, h: H - vy(v) })),
      lowHigh: view(low).map((v, k) => ({ x: x(first + k), y1: y(v), y2: y(view(high)[k]!) })),
      points: view(avg).map((v, k) => ({ x: x(first + k), y: y(v), title: `${dateText(data[first + k]!.day)}\n${isk(v)}` })),
      ma5: line(ma5), ma20: line(ma20), band,
    };
  });
</script>

<div class="mph">
  {#if !showTable}
    {#if graph}
      <div class="mph-legend">
        <span><i style="background: {COLORS[3]}; border-radius: 50%"></i>{word("UI/PriceHistory/MedianDayPrice")}</span>
        <span><i style="background: rgba(255, 255, 255, 0.4)"></i>{word("UI/PriceHistory/MinMax")}</span>
        <span><i style="background: {COLORS[2]}"></i>{word("UI/PriceHistory/MovingAvg", { numDays: word("/Carbon/UI/Common/WrittenDateTimeQuantityShort/Day", { value: 5 }) })}</span>
        <span><i style="background: {COLORS[4]}"></i>{word("UI/PriceHistory/MovingAvg", { numDays: word("/Carbon/UI/Common/WrittenDateTimeQuantityShort/Day", { value: 20 }) })}</span>
        <span><i style="background: rgba(204, 204, 255, 0.4)"></i>{word("UI/PriceHistory/DonchianChannel")}</span>
        <span><i style="background: {COLORS[0]}"></i>{word("UI/PriceHistory/Volume")}</span>
      </div>
      <svg class="mph-graph" viewBox="0 0 {W} {H}" role="img" aria-label="Price history">
        {#each graph.ticks as t, i (i)}
          <line x1={LEFT} x2={W - RIGHT} y1={t.y} y2={t.y} stroke="rgba(255,255,255,0.1)" />
          <text x={LEFT - 6} y={t.y + 4} text-anchor="end">{t.label}</text>
        {/each}
        {#each graph.months as mth, i (i)}
          <line x1={mth.x} x2={mth.x} y1={TOP} y2={H} stroke="rgba(255,255,255,0.1)" />
          <text x={mth.x} y={TOP - 8} text-anchor="middle">{mth.label}</text>
        {/each}
        {#each graph.volTicks as t, i (i)}<text x={W - RIGHT + 6} y={t.y} text-anchor="start">{t.label}</text>{/each}
        {#each graph.bars as b, i (i)}<rect x={b.x} y={b.y} width={b.w} height={b.h} fill={COLORS[0]} />{/each}
        <path d={graph.band} fill="rgba(204,204,255,0.1225)" />
        {#each graph.lowHigh as l, i (i)}<line x1={l.x} x2={l.x} y1={l.y1} y2={l.y2} stroke="rgba(255,255,255,0.2)" />{/each}
        <path d={graph.ma5} fill="none" stroke={COLORS[2]} />
        <path d={graph.ma20} fill="none" stroke={COLORS[4]} />
        {#each graph.points as p, i (i)}<circle cx={p.x} cy={p.y} r="3" fill={COLORS[3]}><title>{p.title}</title></circle>{/each}
      </svg>
    {/if}
  {:else}
    <div class="mph-table">
      <table>
        <thead><tr>
          <th>{word("UI/Common/Date")}</th><th class="r">{word("UI/Market/PriceHistory")}</th><th class="r">{word("UI/Market/PriceHistory/Quantity")}</th>
          <th class="r">{word("UI/Market/PriceHistory/LowestPrice")}</th><th class="r">{word("UI/Market/PriceHistory/HighestPrice")}</th><th class="r">{word("UI/Market/PriceHistory/AveragePrice")}</th>
        </tr></thead>
        <tbody>
          {#each tableRows as day, place (place)}
            <tr><td>{dateText(day.day)}</td><td class="r">{day.orders.toLocaleString()}</td><td class="r">{day.volume.toLocaleString()}</td>
              <td class="r">{isk(day.low).replace(/\s*ISK$/, "")}</td><td class="r">{isk(day.high).replace(/\s*ISK$/, "")}</td><td class="r">{isk(day.average).replace(/\s*ISK$/, "")}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  <div class="mph-options">
    <button type="button" onclick={() => (showTable = !showTable)}>{word(showTable ? "UI/PriceHistory/ShowGraph" : "UI/PriceHistory/ShowTable")}</button>
    {#if showTable}
      <label>{word("/Carbon/UI/Common/Time")}
        <select bind:value={days}>{#each TIME_OPTIONS as n (n)}<option value={n}>{timeLabel(n)}</option>{/each}</select>
      </label>
    {/if}
  </div>
</div>

<style>
  .mph { display: flex; flex-direction: column; gap: 6px; }
  .mph-legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 12px; font-size: 11px; color: rgba(255, 255, 255, 0.7); }
  .mph-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: -1px; }
  .mph-graph { width: 100%; height: auto; }
  .mph-graph text { fill: rgba(255, 255, 255, 0.6); font-size: 10px; }
  .mph-table { max-height: 320px; overflow: auto; border: 1px solid rgba(255, 255, 255, 0.08); }
  .mph-table table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .mph-table th { position: sticky; top: 0; background: #1b1d20; text-align: left; font-weight: 400; color: rgba(255, 255, 255, 0.6); padding: 3px 6px; }
  .mph-table td { padding: 2px 6px; color: rgba(255, 255, 255, 0.75); white-space: nowrap; }
  .mph-table .r { text-align: right; }
  .mph-options { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
  .mph-options button { background: none; border: 1px solid rgba(255, 255, 255, 0.25); color: rgba(255, 255, 255, 0.85); padding: 3px 10px; font-size: 12px; cursor: pointer; }
  .mph-options label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: rgba(255, 255, 255, 0.7); }
</style>
