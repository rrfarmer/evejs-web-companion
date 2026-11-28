import { parse } from "yaml";

export const paperDollYaml = { customTags: [
  { tag: "tag:yaml.org,2002:python/tuple", collection: "seq" },
  { tag: "tag:yaml.org,2002:python/object:paperDoll.AvatarPartMetaData", collection: "map" },
  { tag: "tag:yaml.org,2002:python/unicode", resolve: value => value },
] };

export const readPaperDollYaml = (store, source) => parse(store.read(source).toString("utf8"), paperDollYaml);

export function paperDollMetadataPath(store, folder, variation) {
  return [`${folder}/${variation || "v0"}/metadata.yaml`, `${folder}/metadata.yaml`].find(file => store.has(file));
}

export function paperDollWaistTuck(store, paperDoll, metadata) {
  const source = "dependants/waisttucking/standard";
  const variation = `${paperDoll}/${source}/v1/metadata.yaml`;
  if (!metadata?.dependantModifiers?.some(path => /^dependants\/waisttucking\//i.test(path)) || !store.has(variation)) return null;
  return { source, occludes: readPaperDollYaml(store, variation).occludesModifiers ?? [] };
}

const bootTuckSource = "dependants/boottucking/standard";
const bootTuckVariant = paperDoll => `${paperDoll}/${bootTuckSource}/v1/metadata.yaml`;

export function paperDollHasBootTuck(store, paperDoll, metadata) {
  return Boolean(metadata?.dependantModifiers?.some(path => path.split("#", 1)[0].toLowerCase() === bootTuckSource) &&
    store.has(bootTuckVariant(paperDoll)));
}

export function paperDollBootTuck(store, paperDoll) {
  const variation = bootTuckVariant(paperDoll);
  return store.has(variation) ? { source: bootTuckSource, occludes: readPaperDollYaml(store, variation).occludesModifiers ?? [] } : null;
}
