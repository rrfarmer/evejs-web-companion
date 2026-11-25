<script lang="ts">
  import { onMount, tick } from "svelte";
  import { publicGatewayRequest } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const words = $derived(store.words);
  const labels = {
    hint: "UI/Accessories/AuraGuidance/InputHint",
    waiting: "UI/Accessories/AuraGuidance/WaitingResponse",
    unavailable: "UI/Accessories/AuraGuidance/UnableToGetResponse",
  };
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? "").trim() || fallback;
  onMount(() => flow.requestWords(Object.values(labels)));

  const portrait = clientTexture("res:/UI/Texture/classes/careerPortal/aura/aura_portrait_background_32.png");
  const suggestions = ["How do I mine?", "How do I fit my ship?", "How do I travel?"];
  type Message = { sender: "Aura" | "You"; text: string; fallback?: boolean };
  let messages = $state<Message[]>([{ sender: "Aura", text: "Hello Captain. How can I help?" }]);
  let input = $state("");
  let waiting = $state(false);
  let error = $state("");
  let transcript: HTMLDivElement;
  let field: HTMLTextAreaElement;

  async function scrollToBottom() {
    await tick();
    if (transcript?.isConnected) transcript.scrollTop = transcript.scrollHeight;
  }

  async function send(question: string) {
    const message = question.trim();
    if (waiting || !message || message.length > 500) return;
    waiting = true;
    error = "";
    input = "";
    messages = [...messages, { sender: "You", text: message }];
    void scrollToBottom();
    try {
      const answer = await publicGatewayRequest("eve_public.ai.assistant.chat.api.QueryRequest", { message }, flow.requestOptions());
      const payload = answer.payload;
      if (answer.statusCode !== 200 || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
      const formatted = payload.formatted_response;
      const text = formatted && typeof formatted === "object" && !Array.isArray(formatted)
        ? formatted.text : payload.response;
      if (typeof text !== "string" || !text.trim()) throw new Error();
      messages = [...messages, { sender: "Aura", text, fallback: payload.fallback === true }];
    } catch {
      error = word(labels.unavailable, "Unable to get a response from Aura.");
    } finally {
      waiting = false;
      await scrollToBottom();
      if (field?.isConnected) field.focus({ preventScroll: true });
    }
  }
</script>

<div class="aura-guidance">
  <div class="transcript" role="log" aria-label="Aura conversation" bind:this={transcript}>
    {#each messages as message}
      <div class="message" class:fallback={message.fallback} data-sender={message.sender}>
        {#if message.sender === "Aura"}<img src={portrait} alt="" />{/if}
        <div><strong>{message.sender}</strong><p>{message.text}</p></div>
      </div>
    {/each}
    {#if waiting}<p role="status">{word(labels.waiting, "Waiting for Aura…")}</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
  </div>
  <div class="suggestions">
    {#each suggestions as suggestion}
      <button type="button" disabled={waiting} onclick={() => void send(suggestion)}>{suggestion}</button>
    {/each}
  </div>
  <form onsubmit={(event) => { event.preventDefault(); void send(input); }}>
    <textarea bind:this={field} bind:value={input} maxlength="500" placeholder={word(labels.hint, "Ask Aura a question")}
      aria-label="Ask Aura" rows="2" onkeydown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(input); }
      }}></textarea>
    <div class="controls"><span>{input.length}/500</span><button type="submit" disabled={waiting || !input.trim()}>Send</button></div>
  </form>
</div>

<style>
  .aura-guidance { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; padding: 10px; box-sizing: border-box; }
  .transcript { flex: 1; overflow: auto; min-height: 0; }
  .message { display: flex; align-items: flex-start; gap: 9px; padding: 8px; }
  .message img { width: 32px; height: 32px; }
  .message p { margin: 3px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .message.fallback { color: #e8c296; }
  .suggestions { display: flex; gap: 5px; flex-wrap: wrap; }
  form { display: grid; gap: 5px; border-top: 1px solid var(--line, #39444b); padding-top: 8px; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; }
  .controls { display: flex; justify-content: space-between; align-items: center; }
  [role="alert"] { color: #fc9c95; }
</style>
