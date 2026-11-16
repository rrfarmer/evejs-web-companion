import type { Object3D } from "three";

/** A space object's kept controller inputs. A command may write the same value again. */
export function setControllerVariable(object: Object3D, name: string, value: number, repeat = false): void {
  const vars = (object.userData.controllerVars ??= {}) as Record<string, number>;
  if (!repeat && vars[name] === value) return;
  const version = ((object.userData.controllerVarsVersion as number | undefined) ?? 0) + 1;
  vars[name] = value;
  const writes = (object.userData.controllerVarWrites ??= {}) as Record<string, number>;
  writes[name] = version;
  object.userData.controllerVarsVersion = version;
}
