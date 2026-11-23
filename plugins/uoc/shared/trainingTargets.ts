const object=(x:unknown):x is Record<string,any>=>!!x&&typeof x==="object"&&!Array.isArray(x);
const positive=(x:unknown):x is number=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
type Entry={typeID:number;toLevel:number};
export function trainingTargets(goal: number | readonly number[], required: unknown): Entry[] {
  if (!object(required)) throw Error("Required skill data is unavailable.");
  const result: Entry[] = [], levels = new Map<number, number>(), visiting = new Set<number>();
  const visit = (typeID: number) => {
    if (visiting.has(typeID)) throw Error("Skill prerequisites contain a cycle.");
    const dependencies = required[String(typeID)];
    if (!object(dependencies)) throw Error("Required skill data is incomplete.");
    visiting.add(typeID);
    for (const [raw, level] of Object.entries(dependencies)) {
      const skill = Number(raw);
      if (!positive(skill) || !positive(level) || level > 5) throw Error("Invalid skill prerequisite.");
      visit(skill);
      const previous = levels.get(skill) ?? 0;
      for (let n = previous + 1; n <= level; n++) result.push({ typeID: skill, toLevel: n });
      levels.set(skill, Math.max(previous, level));
    }
    visiting.delete(typeID);
  };
  for (const typeID of typeof goal === "number" ? [goal] : goal) visit(typeID); return result;
}

/** Explicit reviewed skill goals reuse the same native prerequisite expansion and queue engine. */
export function trainingPlanTargets(types:readonly number[],required:unknown,goals:readonly {typeID:number;level:number}[]=[]):Entry[]{
 const targets=trainingTargets([...new Set([...types,...goals.map(g=>g.typeID)])],required);
 for(const g of goals)for(let level=1;level<=g.level;level++)targets.push({typeID:g.typeID,toLevel:level});
 const seen=new Set<string>();return targets.filter(t=>{const key=`${t.typeID}:${t.toLevel}`;if(seen.has(key))return false;seen.add(key);return true;});
}
