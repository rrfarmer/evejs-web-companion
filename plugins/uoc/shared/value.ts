/** JSON object key order is transport formatting, while array order and values remain part of the exact intent. */
export function sameJsonValue(a:unknown,b:unknown):boolean {
 const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,ordered(v[k])])):v;
 return JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
}
