import { uocStore } from "../backendStores.ts";
import type { BackendRun, PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { reconcile, preDispatchRefusal } from "./reconcile.ts";
import type { JsonValue } from "../../../web/src/plugin-api/index.ts";

type Storage = { read(): unknown; write(v: unknown): void };
type Setup = {
  traineeID: number;
  authorityID: number;
  corporationID: number;
  stage: "invite" | "join" | "grant" | "grant-existing";
};
const RIGHTS = {
  roles: "9222811354509877120",
  grantableRoles: "9222811354509877120",
  rolesAtHQ: "558552041119758",
  grantableRolesAtHQ: "558552041119758",
  rolesAtBase: "558552041119758",
  grantableRolesAtBase: "558552041119758",
  rolesAtOther: "558552041119758",
  grantableRolesAtOther: "558552041119758",
} as const;
const object = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const positive = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const scalar = (x: any): any => (object(x) && Object.hasOwn(x, "value") ? x.value : x);
function fields(v: any): Record<string, any> {
  if (v?.type === "packedrow" && object(v.fields)) return v.fields;
  if (v?.type === "object" && v.args?.type === "dict" && Array.isArray(v.args.entries)) {
    const f = Object.fromEntries(v.args.entries) as Record<string, any>,
      names = f.header?.items,
      values = f.line?.items;
    return Array.isArray(names) && Array.isArray(values) && names.length === values.length
      ? Object.fromEntries(names.map((k: string, i: number) => [k, values[i]]))
      : f;
  }
  throw Error("Corporation record is unreadable.");
}
function setupOf(v: unknown, kind: "training-hr" | "training-join"): Setup | null {
  if (
    !object(v) ||
    Object.keys(v).sort().join(",") !== "authorityID,corporationID,stage,traineeID" ||
    !positive(v.traineeID) ||
    !positive(v.authorityID) ||
    v.traineeID === v.authorityID ||
    !positive(v.corporationID) ||
    !(kind === "training-hr" ? ["invite", "grant", "grant-existing"] : ["join"]).includes(v.stage)
  )
    return null;
  return {
    traineeID: v.traineeID,
    authorityID: v.authorityID,
    corporationID: v.corporationID,
    stage: v.stage,
  };
}
function applications(v: any, key: number, setup: Setup): Record<string, any>[] {
  if (v?.type !== "dict" || !Array.isArray(v.entries))
    throw Error("Corporation applications are unreadable.");
  const found = v.entries.filter((e: any) => Array.isArray(e) && Number(scalar(e[0])) === key);
  if (found.length > 1) throw Error("Corporation application scope is ambiguous.");
  if (!found.length) return [];
  const list = found[0][1];
  if (list?.type !== "list" || !Array.isArray(list.items))
    throw Error("Corporation applications are unreadable.");
  return list.items
    .map(fields)
    .filter(
      (r: Record<string, any>) =>
        Number(scalar(r.characterID)) === setup.traineeID &&
        Number(scalar(r.corporationID)) === setup.corporationID,
    );
}
function masks(v: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(RIGHTS)) {
    const raw = scalar(v[key]);
    if ((typeof raw === "number" && !Number.isSafeInteger(raw)) || !/^\d+$/.test(String(raw)))
      throw Error("Corporation role masks are unreadable.");
    out[key] = String(raw);
  }
  return out;
}
const exact = (value: Record<string, string>) =>
  Object.entries(RIGHTS).every(([k, v]) => value[k] === v);

/** Shared, per-trainee intent survives all three independently owned pilot runs. */
export function createTrainingHRRun(
  kind: "training-hr" | "training-join",
  storage: (s: Setup) => Storage,
  options: { reconcileDelayMs?: number } = {},
): BackendRun {
  return {
    check(input) {
      if (
        kind === "training-hr" &&
        object(input) &&
        Object.keys(input).sort().join(",") === "authorityID,stage" &&
        (input.stage === "inspect" || input.stage === "member-inspect") &&
        positive(input.authorityID)
      )
        return {
          ok: true,
          setup: input as JsonValue,
          name: "Inspect corporation authority",
          policy: { riskClasses: [], restartSafe: false },
        };
      const setup = setupOf(input, kind);
      return setup
        ? {
            ok: true,
            setup: setup as unknown as JsonValue,
            name: "Corporation onboarding",
            policy: { riskClasses: ["social"], restartSafe: false },
          }
        : { ok: false, refusal: "Choose the exact trainee, director and corporation." };
    },
    async start(run: PluginRunContext) {
      const inspectSetup: unknown = run.setup;
      if (
        kind === "training-hr" &&
        object(inspectSetup) &&
        Object.keys(inspectSetup).sort().join(",") === "authorityID,stage" &&
        (inspectSetup.stage === "inspect" || inspectSetup.stage === "member-inspect") &&
        positive(inspectSetup.authorityID)
      ) {
        const id = inspectSetup.authorityID;
        if (run.resumed || run.characterID !== id || run.held.characterID !== id)
          throw Error("Authority inspection actor does not match this run.");
        let active = true;
        const work = (async () => {
          const read = async (method: string, args: unknown[] = []) => {
            if (!active) throw Error("Authority inspection stopped.");
            const response = await run.fetch(`${run.baseUrl}/api/bridge/call`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                service: "corpRegistry",
                method,
                args,
                kwargs: null,
                pilot: true,
              }),
            });
            const data = (await response.json()) as any;
            if (!active) throw Error("Authority inspection stopped.");
            if (!response.ok || data?.ok === false)
              throw Error(data?.message || data?.error || "Corporation read failed.");
            return fields(data.result);
          };
          const c = await read("GetCorporation"),
            corporationID = Number(scalar(c.corporationID)),
            ceoID = Number(scalar(c.ceoID));
          if (!positive(corporationID) || !positive(ceoID))
            throw Error("Corporation identity is unavailable.");
          const m = await read("GetMember", [id]);
          if (
            Number(scalar(m.characterID)) !== id ||
            Number(scalar(m.corporationID)) !== corporationID
          )
            throw Error("Corporation member identity is unavailable.");
          const roleMasks = masks(m);
          const name = scalar(c.corporationName);
          const eligible = id !== ceoID && (BigInt(roleMasks.roles!) & 1n) !== 0n;
          if (inspectSetup.stage === "member-inspect") {
            const response = await run.fetch(`${run.baseUrl}/api/plugins/uoc/world`),
              world = (await response.json()) as any;
            if (
              !active ||
              !response.ok ||
              world?.ok !== true ||
              typeof world.worldID !== "string" ||
              !world.worldID
            )
              throw Error("Training world identity is unavailable.");
            const saved = storage({
              traineeID: id,
              authorityID: 0,
              corporationID,
              stage: "join",
            }).read();
            let enrollmentState = "UNKNOWN";
            if (
              object(saved) &&
              saved.worldID === world.worldID &&
              saved.traineeID === id &&
              saved.corporationID === corporationID &&
              typeof saved.phase === "string"
            )
              enrollmentState = ["INVITE_PENDING", "ACCEPT_PENDING", "RIGHTS_PENDING"].includes(
                saved.phase,
              )
                ? "PENDING"
                : saved.phase === "DONE"
                  ? "DONE"
                  : saved.phase;
            run.report({
              status: "stopped",
              phase: "Training membership inspected",
              readout: {
                characterID: id,
                corporationID,
                corporationName: typeof name === "string" && name.trim() ? name : null,
                roleMasks,
                rights:
                  id === ceoID || !exact(roleMasks)
                    ? "OTHER"
                    : scalar(m.blockRoles) === 0 || scalar(m.blockRoles) === "0"
                      ? "FULL_ACCESS_EXCEPT_CEO"
                      : "UNKNOWN",
                enrollmentState,
                worldID: world.worldID,
              },
            });
            return;
          }
          run.report({
            status: "stopped",
            phase: "Corporation authority inspected",
            readout: {
              characterID: id,
              corporationID,
              corporationName: typeof name === "string" && name.trim() ? name : null,
              ceoID,
              eligible,
              reason: eligible
                ? null
                : id === ceoID
                  ? "The CEO is protected; choose a non-CEO Director."
                  : "The pilot does not have the native Director role.",
              roleMasks,
            },
          });
        })().catch((error) => {
          if (active)
            run.report({
              status: "error",
              phase: "Authority inspection blocked",
              why: String(error?.message || error),
            });
        });
        return {
          async stop() {
            active = false;
            await work;
          },
        };
      }
      const setup = setupOf(run.setup, kind);
      if (
        !setup ||
        run.resumed ||
        run.held.characterID !== run.characterID ||
        run.characterID !== (kind === "training-hr" ? setup.authorityID : setup.traineeID)
      )
        throw Error("Onboarding actor does not match this run.");
      const db = storage(setup),
        previous = db.read();
      if (
        previous !== null &&
        (!object(previous) ||
          previous.version !== 1 ||
          previous.traineeID !== setup.traineeID ||
          previous.authorityID !== setup.authorityID ||
          previous.corporationID !== setup.corporationID)
      )
        throw Error("ONBOARDING_RECOVERY_REQUIRED: Previous authority evidence differs.");
      let worldID: string | null = null;
      try {
        const response = await run.fetch(`${run.baseUrl}/api/plugins/uoc/world`),
          world = (await response.json()) as any;
        if (response.ok && world?.ok === true && typeof world.worldID === "string" && world.worldID)
          worldID = world.worldID;
      } catch {
        /* Existing operation remains usable; unscoped journal is not projected as current-world evidence. */
      }
      if (
        object(previous) &&
        typeof previous.worldID === "string" &&
        worldID &&
        previous.worldID !== worldID
      )
        throw Error("ONBOARDING_RECOVERY_REQUIRED: Previous world identity differs.");
      const saved = object(previous) ? previous : null;
      let active = true,
        state: Record<string, any> = {
          version: 1,
          traineeID: setup.traineeID,
          authorityID: setup.authorityID,
          corporationID: setup.corporationID,
          phase: saved ? saved.phase : "NEW",
          worldID: saved ? saved.worldID : (worldID ?? undefined),
          ceoID: saved?.ceoID,
          applicationID: saved?.applicationID,
          membershipOrigin: saved?.membershipOrigin,
        };
      const save = (patch: Record<string, unknown>) => {
        if (!active) throw Error("Onboarding stopped.");
        const next = { ...state, ...patch };
        db.write(next);
        state = next;
      };
      const call = async (method: string, args: unknown[] = [], write = false, of?: number) => {
        if (!active) throw Error("Onboarding stopped.");
        const response = await run.fetch(`${run.baseUrl}/api/bridge/call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            service: "corpRegistry",
            method,
            args,
            kwargs: null,
            pilot: true,
            ...(write ? { confirm: true } : {}),
            ...(of ? { of } : {}),
          }),
        });
        const data = (await response.json()) as any;
        if (!active) throw Error("Onboarding stopped.");
        if (!response.ok || data?.ok === false) {
          const error = Error(data?.message || data?.error || "Corporation call failed.");
          if (preDispatchRefusal(response.status, data))
            Object.assign(error, { preDispatch: true });
          throw error;
        }
        return data.result;
      };
      const corp = async () => {
        const f = fields(await call("GetCorporation")),
          id = Number(scalar(f.corporationID)),
          ceo = Number(scalar(f.ceoID));
        if (!positive(id) || !positive(ceo)) throw Error("Corporation identity is unavailable.");
        return { id, ceo };
      };
      const hr = async () => {
        const c = await corp();
        if (c.id !== setup.corporationID || [setup.authorityID, setup.traineeID].includes(c.ceo))
          throw Error("Director or CEO authority changed.");
        const m = fields(await call("GetMember", [setup.authorityID])),
          role = scalar(m.roles);
        if (
          Number(scalar(m.characterID)) !== setup.authorityID ||
          Number(scalar(m.corporationID)) !== c.id ||
          (typeof role === "number" && !Number.isSafeInteger(role)) ||
          !/^\d+$/.test(String(role)) ||
          (BigInt(String(role)) & 1n) === 0n
        )
          throw Error("The selected pilot is not a verified non-CEO director.");
        return c;
      };
      const verifyInvitation = async (key: number) => {
        const rows = applications(
          await call(key === setup.traineeID ? "GetApplications" : "GetMyApplications"),
          key,
          setup,
        ).filter((r) => Number(scalar(r.status)) === 8);
        if (rows.length !== 1 || !positive(Number(scalar(rows[0]!.applicationID))))
          throw Error("ONBOARDING_RECOVERY_REQUIRED: Exact invitation is not verified.");
        return rows[0]!;
      };
      const work = async () => {
        if (setup.stage === "invite") {
          const c = await hr();
          if (state.phase === "NEW") {
            if (applications(await call("GetApplications"), setup.traineeID, setup).length)
              throw Error("An existing application requires review.");
            save({ phase: "INVITE_PENDING", ceoID: c.ceo });
            try {
              await call("InsertInvitation", [setup.traineeID], true, setup.corporationID);
            } catch (error) {
              if ((error as any)?.preDispatch) throw error; /* reconcile only */
            }
          } else if (state.phase !== "INVITE_PENDING" && state.phase !== "INVITED")
            throw Error("ONBOARDING_RECOVERY_REQUIRED: Invitation stage differs.");
          const invited = await reconcile(
            () => verifyInvitation(setup.traineeID),
            () => {
              if (!active) throw Error("Onboarding stopped.");
            },
            "ONBOARDING_RECOVERY_REQUIRED: Exact invitation is not verified.",
            options.reconcileDelayMs,
          );
          save({ phase: "INVITED", applicationID: Number(scalar(invited.applicationID)) });
          run.report({
            status: "stopped",
            phase: "Invitation verified",
            readout: { traineeID: setup.traineeID, corporationID: setup.corporationID },
          });
          return;
        }
        if (setup.stage === "join") {
          if (
            !["INVITED", "ACCEPT_PENDING", "JOINED"].includes(state.phase) ||
            !positive(state.applicationID)
          )
            throw Error("ONBOARDING_RECOVERY_REQUIRED: No verified invitation.");
          const before = await corp();
          if (before.id === setup.corporationID) {
            save({ phase: "JOINED" });
            run.report({
              status: "stopped",
              phase: "Membership verified",
              readout: { traineeID: setup.traineeID, corporationID: setup.corporationID },
            });
            return;
          }
          if (state.phase !== "INVITED")
            throw Error("ONBOARDING_RECOVERY_REQUIRED: Invitation acceptance is unverified.");
          const invitation = await verifyInvitation(setup.corporationID);
          if (Number(scalar(invitation.applicationID)) !== state.applicationID)
            throw Error("Invitation identity changed.");
          save({ phase: "ACCEPT_PENDING" });
          try {
            await call(
              "UpdateApplicationOffer",
              [
                state.applicationID,
                setup.traineeID,
                setup.corporationID,
                invitation.applicationText ?? "",
                2,
                "",
                null,
              ],
              true,
              before.id,
            );
          } catch (error) {
            if ((error as any)?.preDispatch) throw error; /* reconcile only */
          }
          let after: { id: number; ceo: number } | null = null;
          try {
            after = await corp();
          } catch {
            /* director will independently read membership */
          }
          if (after?.id !== setup.corporationID) {
            run.report({
              status: "stopped",
              phase: "Membership check needed",
              readout: { traineeID: setup.traineeID, corporationID: setup.corporationID },
            });
            return;
          }
          save({ phase: "JOINED" });
          run.report({
            status: "stopped",
            phase: "Membership verified",
            readout: { traineeID: setup.traineeID, corporationID: setup.corporationID },
          });
          return;
        }
        if (setup.stage === "grant-existing" && state.phase === "NEW") {
          const c = await hr();
          const member = fields(await call("GetMember", [setup.traineeID]));
          if (
            Number(scalar(member.characterID)) !== setup.traineeID ||
            Number(scalar(member.corporationID)) !== setup.corporationID ||
            Number(scalar(member.blockRoles)) !== 0
          )
            throw Error("Trainee membership or roles are not verified.");
          const originalMasks = masks(member);
          if ((BigInt(originalMasks.roles!) & 1n) !== 0n)
            throw Error("The trainee has protected Director roles.");
          save({ phase: "JOINED", ceoID: c.ceo, membershipOrigin: "EXISTING_NATIVE_MEMBER" });
        }
        if (!["JOINED", "ACCEPT_PENDING", "RIGHTS_PENDING", "DONE"].includes(state.phase))
          throw Error("ONBOARDING_RECOVERY_REQUIRED: Membership stage is unresolved.");
        const c = await hr();
        if (state.ceoID !== c.ceo) throw Error("The corporation CEO changed.");
        const readMember = async () => {
          const m = fields(await call("GetMember", [setup.traineeID]));
          if (
            Number(scalar(m.characterID)) !== setup.traineeID ||
            Number(scalar(m.corporationID)) !== setup.corporationID ||
            Number(scalar(m.blockRoles)) !== 0
          )
            throw Error("Trainee membership or roles are not verified.");
          return masks(m);
        };
        let observed = await readMember();
        if (!exact(observed)) {
          if (state.phase === "RIGHTS_PENDING" || state.phase === "DONE")
            throw Error("ONBOARDING_RECOVERY_REQUIRED: Original role change is unverified.");
          if ((BigInt(observed.roles!) & 1n) !== 0n)
            throw Error("The trainee has protected Director roles.");
          save({ phase: "RIGHTS_PENDING" });
          const typed = Object.values(RIGHTS).map((value) => ({ type: "long", value }));
          try {
            await call(
              "UpdateMember",
              [setup.traineeID, null, null, null, ...typed, null, null, null],
              true,
            );
          } catch (error) {
            if ((error as any)?.preDispatch) throw error; /* reconcile only */
          }
          observed = await reconcile(
            async () => {
              const m = await readMember();
              return exact(m) ? m : null;
            },
            () => {
              if (!active) throw Error("Onboarding stopped.");
            },
            "ONBOARDING_RECOVERY_REQUIRED: Original role change is unverified.",
            options.reconcileDelayMs,
          );
        }
        if ((await hr()).ceo !== state.ceoID) throw Error("The corporation CEO changed.");
        save({ phase: "DONE", applicationID: undefined });
        run.report({
          status: "stopped",
          phase: "Onboarding verified",
          readout: {
            traineeID: setup.traineeID,
            corporationID: setup.corporationID,
            roleMasksVerified: true,
          },
        });
      };
      const running = work().catch((error) => {
        if (active)
          run.report({
            status: "error",
            phase: "Onboarding blocked",
            why: String(error?.message || error),
          });
      });
      return {
        async stop() {
          active = false;
          await running;
        },
      };
    },
  };
}
export function trainingDocument(name: string) {
  return uocStore("training-onboarding.sqlite").document(name);
}
const storage = (s: Setup) => trainingDocument(`onboarding:${s.traineeID}:${s.corporationID}`);
export const trainingHRRun = createTrainingHRRun("training-hr", storage);
export const trainingJoinRun = createTrainingHRRun("training-join", storage);
