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

The Vite dev server serves the newest build's folder at `/client-assets`, or the one
`EVE_CLIENT_BUILD` names. `web/hull-viewer.html?hull=dx9/model/ship/caldari/battleship/cb1/cb1_t1`
draws one.

## What is in `lib/`

| File | What it reads |
| --- | --- |
| `resfiles.mjs` | `tq/resfileindex.txt` and `ResFiles/`: `res:` path to file |
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
