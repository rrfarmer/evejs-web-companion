<script lang="ts">
  // corporation/corp_ui_member_auditing.py CorpAuditing (Administration > General > Auditing, an auditor's): Back /
  // Forward at the top right (Browse: the from / to window moved by its own length), two DatePickers - from a week
  // ago plus a day, to tomorrow -, the member combo (Member; the corporation's members, fewer than 24 - else a search
  // field), then the scroll (headers Date, Action). ShowJournal: without the auditor's role AuditorRoleRequired; else
  // corpmgr.AuditMember(memberID, from, to (from + a day where equal), 10): its log events and role changes merged
  // newest first, at most 10 rows - an event (FmtDate 'ss'; 12 CreatedCorporation, 13 DeletedCorporation, 14
  // LeftCorporation, 15 AppliedForMembershipOfCorporation, 16 BecameCEOOfCorporation, 17
  // LeftCEOPositionOfCorporation, 44 JoinedCorporation {corpName}, else 'logItem' - the chain read from the compiled
  // bytecode; the decompiled text misplaces its jumps), a role change (RolesAdded / RolesRemoved / RolesKept of
  // iter_role_names joined by ListGenericDelimiter, in SummaryOfChanges, then KnownCharChanged(Grantable)Roles
  // {changingChar - CONCORD for -1 -, changedChar, corpName, whatChanged}); NoAuditingRecordsFound where none.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CorporationAudit } from "../app/flow.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const A = "UI/Corporations/CorporationWindow/Members/Auditing/";
  const EVENT_LABELS: Record<number, string> = { 12: "CreatedCorporation", 13: "DeletedCorporation", 14: "LeftCorporation", 15: "AppliedForMembershipOfCorporation",
    16: "BecameCEOOfCorporation", 17: "LeftCEOPositionOfCorporation", 44: "JoinedCorporation" };
  const LABELS = [...Object.values(EVENT_LABELS), "RolesAdded", "RolesRemoved", "RolesKept", "SummaryOfChanges", "KnownCharChangedRoles", "KnownCharChangedGrantableRoles",
    "AuditorRoleRequired", "NoAuditingRecordsFound"].map((k) => A + k)
    .concat(["UI/Common/Date", "UI/Common/Action", "UI/Common/NoDataAvailable", "UI/Wallet/WalletWindow/Member", "UI/Browser/Forward", "UI/Browser/Back",
      "UI/Common/Formatting/ListGenericDelimiter", DATE_LABELS.ss!, ...Object.keys(LINK_WORDS)]);
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const fill = (label: string, values: Record<string, unknown> = {}) => formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny });
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), text);
  const DAY = 864_000_000_000n, WEEK = 7n * DAY;
  const auditor = $derived((BigInt($station.online?.corpRole ?? "0") & 4096n) !== 0n);
  // a FILETIME's date (UTC) as [year, month, day], and back
  const parts = (t: bigint) => { const d = new Date(Number((t - 116444736000000000n) / 10000n)); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()] as const; };
  const filetime = (y: number, m: number, d: number) => BigInt(Date.UTC(y, m - 1, d)) * 10000n + 116444736000000000n;
  const now = BigInt(Date.now()) * 10000n + 116444736000000000n;
  let from = $state([...parts(now - WEEK + DAY)]), to = $state([...parts(now + DAY)]);
  let members = $state<readonly { id: number; name: string }[]>([]), memberID = $state<number | null>(null);
  let error = $state("");
  let roleNames = $state<readonly { mask: bigint; nameID: number }[]>([]);
  const years = Array.from({ length: 30 }, (_, i) => 2003 + i);
  onMount(() => {
    flow.requestWords(LABELS);
    void flow.corporationMemberTracking().then((t) => {
      const ids = t.members.map((m) => m.characterID);
      flow.requestNames(ids.map((id) => ({ kind: "owner" as const, id })));
      members = ids.map((id) => ({ id, name: "" }));
      // settings.user.ui memberID
      try { const kept = Number(localStorage.getItem("evejs.play.auditMemberID")); memberID = ids.includes(kept) ? kept : ids[0] ?? null; } catch { memberID = ids[0] ?? null; }
      void show();
    }).catch((e) => { error = e instanceof Error ? e.message : String(e); });
    // iter_role_names: the roles in their ids' order, each its nameID
    void flow.corporationMemberRoleOptions().then((r) => {
      roleNames = r.map((x) => ({ mask: BigInt(x.roleID), nameID: x.nameID })).sort((a, b) => (a.mask < b.mask ? -1 : a.mask > b.mask ? 1 : 0));
      flow.requestWords(r.map((x) => `#${x.nameID}`));
    }).catch(() => {});
  });
  let audit = $state<CorporationAudit | null>(null), window_ = $state<{ from: bigint; to: bigint } | null>(null);
  async function show(browse: 1 | -1 | null = null): Promise<void> {
    if (!auditor || memberID === null) return;
    let f = filetime(from[0]!, from[1]!, from[2]!), t = filetime(to[0]!, to[1]!, to[2]!);
    if (f === t) t += DAY;
    if (browse !== null) { const span = t - f; f += BigInt(browse) * span; t += BigInt(browse) * span; }
    from = [...parts(f)]; to = [...parts(t)];
    try { audit = await flow.auditMember(memberID, f, t, 10); window_ = { from: f, to: t }; error = ""; } catch (e) { error = e instanceof Error ? e.message : String(e); audit = null; }
  }
  const date = (t: bigint) => plainText(fill(DATE_LABELS.ss!, { datetime: { type: "long", value: t.toString() } }));
  const roleList = (masks: readonly bigint[]) => masks.map((m) => plainText($words.templates[`#${roleNames.find((r) => r.mask === m)?.nameID ?? 0}`] ?? "")).join(plainText($words.templates["UI/Common/Formatting/ListGenericDelimiter"] ?? ", "));
  // the merge: newest first, at most 10
  const lines = $derived.by(() => {
    void $words; void $names;
    if (!audit) return [];
    const events = [...audit.events].sort((a, b) => (b.eventDateTime > a.eventDateTime ? 1 : b.eventDateTime < a.eventDateTime ? -1 : 0));
    const changes = [...audit.roles].sort((a, b) => (b.changeTime > a.changeTime ? 1 : b.changeTime < a.changeTime ? -1 : 0));
    const out: { time: string; action: string }[] = [];
    for (let ix = 1; (events.length || changes.length) && ix <= 10; ix++) {
      let ev = events[0] ?? null, ch = changes[0] ?? null;
      if (ev && ch) { if (ev.eventDateTime > ch.changeTime) ch = null; else ev = null; }
      if (ev) {
        events.shift();
        const corpName = ev.corporationID ? nameAny("owner", ev.corporationID) : "";
        out.push({ time: date(ev.eventDateTime), action: EVENT_LABELS[ev.eventTypeID] ? fill(A + EVENT_LABELS[ev.eventTypeID]!, { corpName }) : "logItem" });
      } else if (ch) {
        changes.shift();
        const masks = roleNames.map((r) => r.mask);
        const before = masks.filter((m) => (ch!.oldRoles & m) === m), after = masks.filter((m) => (ch!.newRoles & m) === m);
        const added = masks.filter((m) => !before.includes(m) && after.includes(m)), removed = masks.filter((m) => before.includes(m) && !after.includes(m)), kept = masks.filter((m) => before.includes(m) && after.includes(m));
        const summary = fill(A + "SummaryOfChanges", {
          firstListMessage: added.length ? fill(A + "RolesAdded", { listOfAddedRoles: roleList(added) }) : "",
          secondListMessage: removed.length ? fill(A + "RolesRemoved", { listOfRemovedRoles: roleList(removed) }) : "",
          thirdListMessage: kept.length ? fill(A + "RolesKept", { listOfKeptRoles: roleList(kept) }) : "" });
        const issuer = ch.issuerID === -1 ? 1000125 : ch.issuerID;
        out.push({ time: date(ch.changeTime), action: fill(A + (ch.grantable ? "KnownCharChangedGrantableRoles" : "KnownCharChangedRoles"),
          { changingChar: issuer, changedChar: ch.charID, corpName: nameAny("owner", ch.corporationID), whatChanged: summary }) });
      }
    }
    return out;
  });
</script>

<div class="au">
  <div class="au-top">
    <span class="au-browse"><button type="button" title={plainText(fill("UI/Browser/Back"))} onclick={() => void show(-1)}>◀</button><button type="button" title={plainText(fill("UI/Browser/Forward"))} onclick={() => void show(1)}>▶</button></span>
    <div class="au-filters">
      {#each [from, to] as d, i (i)}
        <span class="au-date">
          <select value={d[0]} onchange={(e) => { const v = Number(e.currentTarget.value); if (i === 0) from = [v, from[1]!, from[2]!]; else to = [v, to[1]!, to[2]!]; void show(); }}>{#each years as y (y)}<option value={y}>{y}</option>{/each}</select>
          <select value={d[1]} onchange={(e) => { const v = Number(e.currentTarget.value); if (i === 0) from = [from[0]!, v, from[2]!]; else to = [to[0]!, v, to[2]!]; void show(); }}>{#each Array(12) as _, m (m)}<option value={m + 1}>{m + 1}</option>{/each}</select>
          <select value={d[2]} onchange={(e) => { const v = Number(e.currentTarget.value); if (i === 0) from = [from[0]!, from[1]!, v]; else to = [to[0]!, to[1]!, v]; void show(); }}>{#each Array(31) as _, x (x)}<option value={x + 1}>{x + 1}</option>{/each}</select>
        </span>
      {/each}
      <label class="au-member">{plainText(fill("UI/Wallet/WalletWindow/Member"))}
        <select value={memberID} onchange={(e) => { memberID = Number(e.currentTarget.value); try { localStorage.setItem("evejs.play.auditMemberID", String(memberID)); } catch { /* not kept */ } void show(); }}>
          {#each members as m (m.id)}<option value={m.id}>{nameAny("owner", m.id) || m.id}</option>{/each}
        </select>
      </label>
    </div>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  <div class="au-scroll">
    {#if !auditor}
      <p class="au-hint"><LabelText markup={fill(A + "AuditorRoleRequired", { auditorMessageID: 60180 })} {followerOf} /></p>
    {:else}
      <div class="au-row au-head"><span>{plainText(fill("UI/Common/Date"))}</span><span>{plainText(fill("UI/Common/Action"))}</span></div>
      {#each lines as r, i (i)}<div class="au-row"><span>{r.time}</span><LabelText markup={r.action} {followerOf} /></div>
      {:else}{#if audit && window_}<p class="au-hint">{plainText(fill(A + "NoAuditingRecordsFound"))}</p>{/if}{/each}
    {/if}
  </div>
</div>

<style>
  .au { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .au-top { display: flex; flex-direction: row-reverse; gap: 16px; padding-top: 32px; }
  .au-browse { display: flex; gap: 4px; align-items: flex-start; }
  .au-filters { flex: 1; display: flex; flex-wrap: wrap; gap: 24px 16px; }
  .au-date { display: flex; gap: 2px; width: 256px; }
  .au-member { display: flex; flex-direction: column; font-size: 11px; width: 100px; }
  .au-scroll { flex: 1; overflow-y: auto; margin: 4px; }
  .au-row { display: grid; grid-template-columns: 130px 1fr; align-items: start; min-height: 19px; padding: 2px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .au-head { font-size: 11px; opacity: 0.7; }
  .au-hint { opacity: 0.8; padding: 4px; }
</style>
