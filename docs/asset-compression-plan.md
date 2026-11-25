# Client asset compression plan

Branch `FarmerThreeJSFun`. Brotli asset transport and KTX2 ETC1S for eligible ship
albedo maps are implemented. Mesh quantization and other texture roles are still proposals.

## Using the lossless pass

New extractions write Brotli variants alongside DDS, PNG, JPEG, GLB and JSON files.
JSON below 8 KiB is served directly. Already-compressed images keep their original
representation if Brotli would make them larger. The original files stay available
for clients that request identity encoding, for byte ranges, and for local tools.

Run `npm run compress:assets` once to prepare an existing `_local/client-assets` cache.
It handles all local build directories and skips source files that have already
been prepared. `SetupWebClient.bat` runs the same pass when it finds an existing cache,
including when the companion runs in Docker. The pass uses Node’s built-in Brotli
encoder and needs no extra install or browser decoder. After the first pass, assets
extracted on demand get their variants as part of extraction.

The server negotiates Brotli through `Accept-Encoding`. The original media type and
decoded bytes are preserved. Fixed asset URLs can stay fresh for one day. Manifests
revalidate to pick up new extraction data. Validators include the client build,
file revision and selected encoding. Build-specific immutable URLs remain a
separate improvement for users whose client build changes frequently.

On the 3698585 cache, 5,581 extracted textures totaled 5.61 GB before HTTP
compression and 2.57 GB in their negotiated representations. The originals and
Brotli sidecars both occupy local disk. In Chrome, the cc1 sample albedo, normal
map and model transferred 2.40 MB cold, decoded to 7.82 MB, and transferred zero
bytes on a second navigation.

## Using ETC1S for ship albedo

`SetupWebClient.bat` installs the pinned Khronos libktx 4.4.2 WebAssembly encoder
under the local extraction cache. Native and Docker setup share the same files.
`npm run compress:assets` fills in missing or stale variants for all cached builds.
A standalone extraction prepares its textures when the encoder is available. For
hulls extracted on demand, the first request can use DDS while the encoder prepares
the alternative in the background.

The encoder reads the installed BC7 albedo and preserves its authored mip chain.
It publishes KTX2 for ship albedo maps up to 2048 pixels across when the variant
saves at least 16 KiB and 25% against the served DDS. The browser uses the bundled
Basis transcoder on BPTC-capable renderers and falls back to DDS when it cannot load
KTX2. Both formats remain in the local cache. Normals stay BC5, and mask and effect
textures use Brotli DDS.

### Build 3698585 comparison

The q128 pilot sample used the authored mip chains for 30 textures on five hulls.
The full sample transferred 10.60 MB with Brotli DDS and occupied 2.50 MB as ETC1S.
Four of the hulls were A/B rendered with the companion's Ship Info camera,
lighting and SOF hull shaders on an RTX 3070 Ti. The figures below compare individual
map swaps on the visible hull. Smaller pixel differences are better. Repeated
DDS frames measured 0–1 at the 99th percentile.

| Map | Brotli DDS, five hulls | ETC1S, five hulls | 99th-percentile RGB error, four hulls |
| --- | ---: | ---: | ---: |
| Albedo | 3,601,747 B | 714,002 B | 1–7 of 255 |
| Roughness | 3,175,204 B | 660,314 B | 2–5 of 255 |
| Dirt | 2,917,693 B | 715,351 B | 2–5 of 255 |
| Material | 773,530 B | 321,334 B | 4–18 of 255 |
| Glow | 116,563 B | 68,734 B | 0–8 of 255 |
| Paint | 15,227 B | 17,585 B | 0–6 of 255 |

Albedo retained its 1,398,128-byte GPU mip chain. The stock Three.js transcoder
uploaded the masks as BC7, increasing each 1024² mask from 699,064 to 1,398,128 GPU
bytes. Material-mask swaps reached 18 of 255 at the 99th percentile on the Caldari
sample. Several paint maps were already smaller with Brotli. Effects were outside
the live hull A/B comparison.

An offline ETC1S check of the particle atlas, warp reveal mask and lightning
atlas reduced their combined 243,725 B of Brotli DDS to 99,370 B. Base-mip PSNR
was 43–50 dB. They still use DDS because their actual shader output and blend
edges have yet to be compared.

In the production Rifter preview, albedo transferred 210,883 B after conversion by
the setup encoder, compared with 741,837 B for Brotli DDS. A warm request
transferred zero bytes. An Inquisitor preview used its 595,548 B Brotli DDS when
its KTX2 request returned 404. On the first KTX2 use, the browser fetched 644,327 B
of shared loader and transcoder assets. The 96 prepared maps in the local 3698585
cache total 91.10 MB as served by Brotli and 15.85 MB as KTX2. The 3396210 cache
has 42 variants at 39.58 MB Brotli and 6.91 MB KTX2.

The companion excludes video playback and video resources from extraction and
serving. The installed client's files remain in place.

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

### 1. Brotli and cache headers on `/client-assets/`

- The extractor prepares `.br` sidecars at quality 6 and keeps only worthwhile variants.
  A new source revision invalidates its old sidecar. Compression runs during extraction
  or cache preparation, and an HTTP read of an existing asset can fall back to identity.
- Quality 6 trades some transfer size for faster extraction. On the cc1 mesh alone it
  produced 1.08 MB in 148 ms, compared with 0.88 MB in 10.1 s at quality 11 on this host.
- Changing image encodings or quantizing meshes is outside the lossless pass.

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

### 3. Further mask and effect experiments

- Test BC4 as an ETC1S transcode target for single-channel masks. The current DDS
  path uses 0.5 B/px for these masks and the stock desktop KTX2 path uses 1 B/px.
- Compare material and paint masks with faction SKINs at close range. Check the
  channels, alpha and blending for each effect texture before considering it.
- Mobile renderers need compatible GPU formats for the full set of maps. Normals
  would need their own path before enabling hull alternatives on that hardware.

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
2. Compare faction SKINs using an ETC1S-to-BC4 mask path and measure it on a busy grid.
3. Compare effect atlases and masks in their own shaders.

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
