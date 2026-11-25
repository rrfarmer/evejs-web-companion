<script lang="ts">
  import { onMount } from "svelte";
  import { Calculator, calculatorNumber } from "./calculator.ts";

  const keypad = [
    ["7", "7"], ["8", "8"], ["9", "9"], ["/", "÷"], ["clear", "C"], ["clearall", "CE"],
    ["4", "4"], ["5", "5"], ["6", "6"], ["*", "×"], ["(", "("], [")", ")"],
    ["1", "1"], ["2", "2"], ["3", "3"], ["-", "−"], ["percent", "%"], ["square", "x²"],
    ["0", "0"], [".", "."], ["=", "="], ["+", "+"], ["negate", "±"], ["root", "√"],
  ];
  const shortcuts: Record<string, string> = {
    Enter: "=", Backspace: "clear", Delete: "clearall", C: "clearall",
    r: "root", s: "square", p: "percent", "%": "percent", m: "negate",
  };
  const calculator = new Calculator();
  const storageKey = "evejs.play.calculator";
  const newSlots = () => Array.from({ length: 6 }, (_, index) => ({ name: `Memory ${index + 1}`, value: null as string | null }));
  let display = $state("0");
  let messages = $state("");
  let history = $state<string[]>([]);
  let slots = $state(newSlots());
  let activeMenu = $state<number | null>(null);
  let editingName = $state<number | null>(null);
  let annotation = $state("");
  let input: HTMLInputElement;

  onMount(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as { history?: string[]; slots?: ReturnType<typeof newSlots> } | null;
      if (Array.isArray(saved?.history)) history = saved.history.filter(value => typeof value === "string" && Number.isFinite(Number(value))).slice(0, 20);
      if (Array.isArray(saved?.slots) && saved.slots.length === 6) {
        slots = newSlots().map((fallback, index) => {
          const slot = saved.slots?.[index];
          return slot && typeof slot.name === "string" && (slot.value === null || (typeof slot.value === "string" && Number.isFinite(Number(slot.value)))) ? slot : fallback;
        });
      }
    } catch { /* The calculator also works without saved settings. */ }
    input.focus();
  });

  function save(): void {
    try { localStorage.setItem(storageKey, JSON.stringify({ history, slots })); } catch { /* Lasts the current window. */ }
  }

  function press(key: string): void {
    messages = "";
    const before = calculator.display;
    try {
      calculator.press(key);
      if (key === "=") {
        history = [before, ...history].slice(0, 20);
        save();
      }
    } catch (error) {
      messages = error instanceof Error ? error.message : "Invalid calculation";
    }
    display = calculator.display;
  }

  function recall(value: string): void {
    messages = "";
    calculator.recall(value);
    display = value;
    input.focus();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = shortcuts[event.key] ?? event.key;
    if (!/^[0-9.+*/=()-]$/.test(key) && !Object.hasOwn(shortcuts, event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    press(key);
  }

  function paste(event: ClipboardEvent): void {
    event.preventDefault();
    press("clearall");
    for (const key of event.clipboardData?.getData("text") ?? "") {
      const mapped = shortcuts[key] ?? key;
      if (/^[0-9.+*/=()-]$/.test(mapped) || Object.hasOwn(shortcuts, key)) press(mapped);
    }
  }

  function updateMemory(index: number, action: "set" | "add" | "subtract" | "clear"): void {
    const slot = slots[index];
    if (!slot) return;
    const before = Number(slot.value ?? 0), current = Number(display);
    const value = action === "clear" ? null : calculatorNumber(action === "set" ? current : action === "add" ? before + current : before - current);
    slot.value = value;
    activeMenu = null;
    save();
    input.focus();
  }

  function annotate(index: number) {
    editingName = index;
    annotation = slots[index]?.name ?? "";
    activeMenu = null;
  }

  function saveName(event: SubmitEvent) {
    event.preventDefault();
    if (editingName === null) return;
    const slot = slots[editingName];
    if (slot && annotation.trim()) slot.name = annotation.trim();
    editingName = null;
    save();
    input.focus();
  }
</script>

<div class="calculator">
  <div class="calc-display">
    <input aria-label="Calculator display" bind:this={input} value={display} readonly onkeydown={onKey} onpaste={paste} />
    <select aria-label="Calculator history" value="" onchange={(event) => { const value = history[Number(event.currentTarget.value)]; if (value !== undefined) recall(value); event.currentTarget.value = ""; }}>
      <option value="" disabled>History</option>
      {#each history as value, index (index)}<option value={index}>{value}</option>{/each}
    </select>
  </div>
  <div class="calc-memory">
    {#each slots as slot, index (index)}
      <div class="calc-slot">
        <button type="button" title={slot.value === null ? `${slot.name} is empty` : `${slot.name} · ${slot.value}`}
          onclick={() => { if (slot.value !== null) recall(slot.value); }}>M{index + 1}</button>
        <button type="button" aria-label={`Memory ${index + 1} actions`} aria-expanded={activeMenu === index}
          onclick={() => (activeMenu = activeMenu === index ? null : index)}>▾</button>
        {#if activeMenu === index}
          <div class="calc-memory-actions">
            <button type="button" onclick={() => updateMemory(index, "set")}>Set</button>
            {#if slot.value !== null}
              <button type="button" onclick={() => updateMemory(index, "add")}>Add</button>
              <button type="button" onclick={() => updateMemory(index, "subtract")}>Subtract</button>
              <button type="button" onclick={() => updateMemory(index, "clear")}>Clear</button>
            {/if}
            <button type="button" onclick={() => annotate(index)}>Annotate</button>
          </div>
        {/if}
      </div>
    {/each}
  </div>
  {#if editingName !== null}
    <form class="calc-annotation" onsubmit={saveName}>
      <label>Memory name <input bind:value={annotation} maxlength="16" /></label>
      <button type="submit">Save</button>
      <button type="button" onclick={() => (editingName = null)}>Cancel</button>
    </form>
  {/if}
  <div class="calc-keypad">
    {#each keypad as [key, label] (key)}
      <button type="button" data-calc-key={key} onclick={() => { press(key); input.focus(); }}>{label}</button>
    {/each}
  </div>
  {#if messages}<p class="error" role="status">{messages}</p>{/if}
</div>

<style>
  .calculator { display: grid; gap: 8px; padding: 8px; }
  .calc-display { display: flex; gap: 4px; }
  .calc-display input { min-width: 0; flex: 1; height: 32px; text-align: right; font-size: 16px; }
  .calc-display select { max-width: 74px; }
  .calc-memory { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
  .calc-slot { position: relative; display: flex; }
  .calc-slot > button:first-child { flex: 1; }
  .calc-slot > button { padding-inline: 5px; }
  .calc-memory-actions { position: absolute; z-index: 1; inset: 100% 0 auto; display: grid; background: #151a1e; border: 1px solid #515a61; }
  .calc-memory-actions button { padding-inline: 3px; }
  .calc-annotation { display: flex; align-items: end; gap: 4px; }
  .calc-annotation label { min-width: 0; }
  .calc-annotation input { width: 100%; }
  .calc-keypad { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; }
  .calc-keypad button { min-width: 0; height: 30px; padding: 0; }
  .error { margin: 0; }
</style>
