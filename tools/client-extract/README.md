# client-extract

Pulls models and textures out of **your own installed EVE client** for the three.js play page
(`docs/threejs-play-plan.md`). The script is ours to share. What it extracts is CCP's, stays on the
machine that extracted it, and is never committed: `_local/client-assets/` is git-ignored.

Plain Node 22+, no dependencies.

```
node tools/client-extract/extract.mjs --client "C:\path\to\EVE Online" --hull cb1_t1 --hull ci1_t1
```

- `--client` is the install folder, the one that holds `tq\` and `ResFiles\`. If you leave it out,
  `EVE_CLIENT_DIR` is used, else the one install found in the usual places. The script refuses to
  guess when there are several.
- `--hull` takes a model's file stem (`cb1_t1`) or a full `res:/.../*.gr2` path.
- Output goes to `_local/client-assets/<build>/`, under the model's own `res:` path. The build
  number is read from `tq/start.ini`.
  - `<hull>.glb`: every LOD of the model. EVE is left-handed, so it is mirrored into glTF's
    right-handed space.
  - `<hull>_<x>.dds`: the hull's textures, copied untouched. They are BC4/BC5/BC7 and go to the
    GPU as they are.
  - `<hull>.json`: what came from where (LODs, material areas, vertex layout, textures).
  - `manifest.json`: the build and the hulls extracted so far.

- `--system-celestials <solarSystemID>` writes `celestials/<solarSystemID>.json`: the system's
  planets and moons, each as the client loads it (planet.py): its own shader preset's object file
  and its own height maps (`NormalHeight1`, `NormalHeight2`), from the SDE's `mapPlanets` and
  `mapMoons` (the SDE folder from `--sde` or from `config.json`).

- `--graphic <graphicID>` writes `graphics/<graphicID>.json` for a graphic that is no type's: a SOF hull
  (a station hangar's model, `hangarRegistry.py` hangarModelGraphicID: the model, its SOF build with the
  hull's `anchorpoint` locator and its point lights) or a hangar's scene (sceneGraphicID: its EveSpaceScene's
  environment cube maps, sun and ambient). The dev server makes them on demand at `/client-assets/graphic/<id>`.
- `--overview` writes `overviewPresets.json`: the client's default overview presets (each preset's
  groups, from `res:/staticdata/defaultoverviews.fsdbinary`, decoded by `lib/defaultOverviews.mjs`) and
  its first tabs (General, Mining, WarpTo), named in the client's English from its localization file.

The Vite dev server serves the newest build's folder at `/client-assets`, or the one
`EVE_CLIENT_BUILD` names, and extracts what a page asks for on first ask (a type's model, a
system's scene and celestials). `web/hull-viewer.html?type=588` draws a type as the play view does,
`?planet=40009082&system=30000142` a planet.

## What is in `lib/`

| File | What it reads |
| --- | --- |
| `resfiles.mjs` | `tq/resfileindex.txt` and `ResFiles/`: `res:` path to file |
| `wwiseVorbis.mjs` | Wwise Vorbis `.wem` to Ogg Vorbis, the codebook library read from the client's `_audio2.dll` |
| `granny.mjs` | Granny 3D `.gr2` version 7, in both the 32-bit and the 64-bit pointer layouts. It walks the file's own type definitions, so any Granny object comes out (meshes, skeletons, extended data). |
| `oodle1.mjs` | Section compression 2 |
| `bitknit.mjs` | Section compression 3 and 4. Format 4 also compresses the fixup and marshalling tables. |
| `mesh.mjs` | Granny meshes to flat arrays. Decodes the packed tangent frame as CCP's `cmf::UnpackTangentsLegacy`. |
| `glb.mjs` | glTF 2.0 binary writer |

Both decompressors were translated from the client's own `_trinity_dx11.dll`, through Ghidra
pseudo-C and the machine code. Comments name the function each part comes from. Over every
ship model in client build 3396210, they decode 3,109 of 3,109 Oodle1 sections and 4,905 of
4,905 BitKnit sections, with every pointer fixup in range.

A newer client may change a format. The reader stops with the file named when it meets a Granny
version, compression or texture format it does not know. It does not guess.

## Audio

`node tools/client-extract/audio.mjs --client "<EVE install>" --bank interface` converts a soundbank's embedded
sounds to `_local/client-assets/<build>/audio/<bank>/<id>.ogg` and writes `audio/events.json` (a Wwise event's
FNV-1 id to the sound its Play action plays), which the play page's `play/uiAudio.ts` reads.
