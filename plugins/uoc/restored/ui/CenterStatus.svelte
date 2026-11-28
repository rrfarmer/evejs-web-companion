<script lang="ts">
  let { state, label }: { state: string; label?: string } = $props();
  const tones: Record<string, string> = {
    ACTIVE: "active",
    RUNNING: "active",
    "ON A TRIP": "active",
    TRAINING: "active",
    READY: "ready",
    IDLE: "ready",
    VERIFIED: "ready",
    COMPLETED: "ready",
    PAUSED: "paused",
    ASSEMBLING: "paused",
    WAITING_FOR_HOST: "paused",
    STOPPING: "paused",
    PARKING: "paused",
    "FINISHING FREIGHT": "paused",
    "FREIGHT ON BOARD": "paused",
    "IN DEVELOPMENT": "paused",
    STOPPED: "stopped",
    "OFF DUTY": "stopped",
    ENDED: "stopped",
    ATTENTION: "attention",
    "NEEDS ATTENTION": "attention",
    FAILED: "attention",
    ERROR: "attention",
    PARKING_FAILED: "attention",
    UNKNOWN: "attention",
    RECOVERY_REQUIRED: "attention",
    INCOMPLETE: "attention",
    BLOCKED: "attention",
  };
  const tone = $derived(tones[state.trim().toUpperCase()] ?? "neutral");
</script>

<span class="center-status" data-tone={tone}>{label ?? state}</span>
