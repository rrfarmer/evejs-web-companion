# Client asset compression plan

Branch `FarmerThreeJSFun`. Draft for review, 2026-11-16. Nothing here is built yet. It is a
plan backed by one measured hull.

## Why

The three.js client draws real hulls extracted from the installed EVE client
(`tools/client-extract`, served by `src/clientData/clientAssets.js` under `/client-assets/`). So
far 427 models have been extracted, 5.7 GB in `_local/client-assets/3396210`: 3.5 GB of DDS
textures, 1.9 GB of GLB meshes and 0.3 GB of everything else.

The total does not matter much. The page already loads per type and per system on demand
(`hullModel.ts`, `turretModel.ts`, `celestialModel.ts`), and one system needs a few dozen hulls, not
thousands. Zero Hour has to send its whole 2.7 GB bundle because its original engine expects a
local filesystem. EVE's working set is small, so we can stream it.

What does matter is how many bytes each hull costs on the wire. Today that is every byte on disk:

- `/client-assets/` is served with `res.sendFile` and no compression middleware.
- There is no `Cache-Control` beyond Express's default (`max-age=0` with an ETag), so the browser
  revalidates every file on every load.

On one machine this costs nothing. For a browser on another machine, a hull is about 12 MB.

## What we measured

One hull: `ship/caldari/cruiser/cc1` (`cc1_t1.glb` plus 9 textures, 12.06 MB). The tools were
gltfpack 1.3, KTX-Software 4.4.2 and DirectXTex texconv (May 2026), unpacked into a scratch folder
without installing anything.

### Today's textures are already GPU-compressed

| Texture | Role | Format | On disk |
| --- | --- | --- | ---: |
| `_a` | albedo | BC7 | 1366 KB |
| `_n` | normal | BC5 | 1365 KB |
| `_r` | gloss | BC4 | 683 KB |
| `_d` | dirt | BC4 | 683 KB |
| `_m` | material | BC4 | 683 KB |
| `_g` | glow | BC4 | 683 KB |
| `_p3` | paint mask | BC4 | 683 KB |
| `effect/_mask_01a` | effect mask | BC1 | 683 KB |
| `effect/backglow_01a` | effect glow | BC3 | 43 KB |

`ddsTexture.ts` uploads these to the GPU as they are. KTX2 therefore gains less here than it
usually does, and re-encoding to Basis is a second lossy step on top of BC.

### Sizes

| Option | Textures | Mesh | Hull total | Loss |
| --- | ---: | ---: | ---: | --- |
| Served as today | 7.04 MB | 5.02 MB | **12.06 MB** | none |
| Brotli (q11) on the same files | 2.28 MB | 0.88 MB | **3.16 MB** | none |
| gzip -9 on the same files | 2.58 MB | 2.50 MB | 5.08 MB | none |
| KTX2 holding the same BC data + zstd 19 | 2.42 MB | | | none; worse than brotli |
| KTX2 UASTC (q2) + zstd 18 | 3.07 MB | | | lossy and **larger** than brotli |
| KTX2 ETC1S (BasisLZ, qlevel 128) | 0.68 MB | | | lossy |
| Mesh quantized (KHR_mesh_quantization), then brotli | | 0.29 MB | | about 2 cm position step |
| Mesh meshopt (`gltfpack -cc`) | | 0.58 MB (0.35 brotli) | | same quantization |
| **ETC1S except the normal map (BC5 + brotli), quantized mesh + brotli** | 1.02 MB | 0.29 MB | **≈1.3 MB** | colour/mask maps only |

Findings:

- **Brotli alone cuts 74% with no loss and no client change.** gzip does badly on the float GLB.
- **UASTC is a loss for EVE's textures.** It stores 8 bits per pixel, the same as BC7. That is
  twice BC4's size, and zstd does not win it back.
- **Quantizing the mesh and then applying brotli beat meshopt.** Meshopt only pays when there is
  no HTTP compression.
- Quantization kept every LOD's triangle count. 14-bit positions over this 367 m hull give a step
  of about 2.2 cm.

### Quality (ETC1S against the BC-decoded original, level 0, channels each map uses)

| Texture | PSNR | Seen at 4× zoom |
| --- | ---: | --- |
| albedo | 42.9 dB | faint noise along hard edges only |
| normal | 31.6 dB | **blocky errors along panel edges** |
| gloss | 44.8 dB | fine |
| dirt / material | 37.4 / 38.4 dB | fine for masks |
| effect mask / effect glow | 41.9 / 32.4 dB | fine at the sizes they are drawn |
| glow / paint mask | 51.6 / 52.7 dB | fine |

Rendered side by side with a simple lit material (albedo, normal, gloss; not our hull shader),
the two hulls could not be told apart at normal viewing distance. The normal map is the only
texture that visibly degrades, so it stays BC5.

Not yet checked: the real hull shader (with material and paint tinting), the GPU transcode step
(ETC1S → BC7 adds a little more loss), and any hull other than cc1.

## The plan

The steps are ordered by return for the effort. Each one is useful on its own.

### 1. Brotli and real cache headers on `/client-assets/`

- Write a `.br` beside every `.glb`, `.dds` and large `.json` when it is extracted, using Node's
  built-in `zlib.brotliCompress`. The extractor stays dependency-free. Do not compress on the fly:
  quality 11 on a 5 MB GLB is too slow per request.
- In `clientAssets.js`, when the request's `Accept-Encoding` includes `br` and the sibling
  exists, send it with `Content-Encoding: br`, `Vary: Accept-Encoding` and the original type.
- Add `Cache-Control: public, max-age=…`. Extracted files only change with the client build, so
  key the cache on the build (in the ETag, or as a build segment in the URL) and make them
  long-lived and immutable.
- Expected: 12.06 → 3.16 MB for cc1, no quality change, no page change.

### 2. Quantized meshes from the extractor

- Write positions, normals, tangents and UVs as quantized integers (`KHR_mesh_quantization`):
  14-bit positions for subcapital hulls and 16-bit above a size threshold (capitals and
  structures), 8-bit normals and tangents, 12-bit UVs. Implement this in the extractor's own
  GLB writer, not with gltfpack. gltfpack split cc1's 7 meshes into 9 by material, which our LOD
  and area handling would have to learn, and it adds a native dependency.
- `GLTFLoader` reads `KHR_mesh_quantization` natively. No decoder is needed. Check that nothing
  in `hullModel.ts` / `hullChildren.ts` reads positions as raw floats (bounds, hardpoint
  locators, area splits) without the node's dequantizing transform.
- Skip meshopt for now. With brotli in front it lost.
- Expected: mesh 0.88 → 0.29 MB brotli'd for cc1.

### 3. ETC1S for colour and mask textures, BC5 kept for normals

- Encode `_a`, `_r`, `_d`, `_m`, `_g`, `_p3` and the effect textures to KTX2 ETC1S at extraction
  time. Keep `_n` as the original BC5 DDS with brotli.
- Encoder: the extractor is dependency-free today. The options are Basis Universal's own
  WebAssembly encoder (keeps it Node-only) or KTX-Software's `ktx` CLI found on the machine.
  Prefer the WebAssembly encoder.
- Page: `KTX2Loader` with its Basis transcoder, served from our own bundle.
- **GPU memory trade-off.** On desktop, three's `KTX2Loader` transcodes ETC1S to BC7 whenever
  BPTC is supported (`KTX2Loader.js`, the transcoder target table). A one-channel map then goes
  from BC4 (0.5 B/px) to BC7 (1 B/px), doubling its VRAM. The transcoder can target BC4, so either
  pick that target for one-channel maps or accept the cost. Measure VRAM before deciding.
- **Mobile.** Today's DDS path needs BPTC/RGTC, which phones generally lack. KTX2 transcodes to
  ASTC/ETC2 there, so this step is also what would make hulls load on mobile. The normal map
  would then need a mobile path too (UASTC or ETC2 RG for that one texture).
- Adopt per texture role, after a visual check in the real hull shader on a few hulls from each
  race. Expected: textures 2.28 → 1.02 MB for cc1.

### 4. Progressive load

- The extractor already writes `*_lowdetail.dds` (about 1.5 KB each). Bind those first and swap
  in the full textures when they arrive. A hull then appears at once in its real colours.
- The GLB holds every LOD in one file. Splitting the far LODs into their own files lets a distant
  hull load a fraction of the mesh first.

### 5. Persistent cache (only if HTTP caching is not enough)

Step 1's immutable headers should keep returning players from downloading anything twice. A
service worker with the Cache API or OPFS, keyed by client build, is only worth it if browsers
evict too much. Measure with step 1 in place first.

## What stays the same

- Extracted data stays where `docs/threejs-play-plan.md` puts it. It comes from the player's own
  client, lives under the git-ignored `_local/client-assets/`, and is never committed or
  distributed. Compressed files are extracted data too.
- `ddsTexture.ts` stays for the textures we keep as DDS (normals) and for anything not converted.
- Extraction stays on demand, per type, as `clientAssets.js` does it now.

## Open items

1. Run the measurement on more hulls: one per race, plus a capital and a structure, to confirm
   the per-hull ratios and the 16-bit threshold for quantized positions.
2. Visual check of ETC1S in the real hull shader, including faction paint (material and paint
   maps drive the tint) and at close camera range.
3. VRAM with ETC1S → BC7 against keeping BC4, on a busy grid.
4. Whether the extractor may take a WebAssembly dependency for the Basis encoder.
5. Encode time for ETC1S per hull, since extraction happens on first request.

## Reproducing the measurement

Tools: `gltfpack` (zeux/meshoptimizer releases), `ktx` (KhronosGroup/KTX-Software releases,
unpacked from the installer with 7-Zip) and `texconv` (microsoft/DirectXTex releases). Work in
a scratch folder, never under `_local/client-assets`.

```bash
# DDS -> PNG, raw values (without --ignore-srgb texconv applies a gamma curve)
texconv -ft png -f R8G8B8A8_UNORM --ignore-srgb -o png cc1_t1_a.dds

# ETC1S; one-channel maps use --format R8_UNORM, the normal map R8G8_UNORM with --normal-mode
ktx create --format R8G8B8A8_UNORM --assign-tf linear --generate-mipmap \
  --encode basis-lz --qlevel 128 --compare-psnr png/cc1_t1_a.png cc1_t1_a.ktx2

# Mesh: quantized only, and meshopt
gltfpack -i cc1_t1.glb -o q.glb -kn -km
gltfpack -i cc1_t1.glb -o cc.glb -cc -kn -km
```

Lossless sizes came from Node's `zlib` (`gzipSync` level 9, `brotliCompressSync` quality 11,
`zstdCompressSync` level 19) over the files as extracted.
