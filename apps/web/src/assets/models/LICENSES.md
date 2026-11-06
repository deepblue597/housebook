# 3D model credits and licences

Every file here is **CC0 1.0** (public domain dedication,
https://creativecommons.org/publicdomain/zero/1.0/). Credit is not required; we keep it anyway.
Types without a file below are built from primitives in code
(`src/features/scene3d/models/procedural.ts`, project code, same licence as the app).

| File            | Catalogue type | Source model                  | Pack                                             | Author             | Licence |
| --------------- | -------------- | ----------------------------- | ------------------------------------------------ | ------------------ | ------- |
| `fridge.glb`    | fridge         | `Models/kitchenFridge.obj`    | Furniture Kit (released as "Furniture Pack 1.0") | Kenney (kenney.nl) | CC0 1.0 |
| `oven.glb`      | oven           | `Models/kitchenStove.obj`     | same                                             | Kenney             | CC0 1.0 |
| `washer.glb`    | washer         | `Models/washer.obj`           | same                                             | Kenney             | CC0 1.0 |
| `dryer.glb`     | dryer          | `Models/dryer.obj`            | same                                             | Kenney             | CC0 1.0 |
| `microwave.glb` | microwave      | `Models/kitchenMicrowave.obj` | same                                             | Kenney             | CC0 1.0 |
| `tv.glb`        | tv             | `Models/televisionModern.obj` | same                                             | Kenney             | CC0 1.0 |

## Source

- Pack page: https://kenney.nl/assets/furniture-kit (CC0).
- Downloaded from Kenney's own upload on OpenGameArt, https://opengameart.org/content/furniture-kit
  (`kenney_furniturePack.zip`, sha256 `68afa4e6dc8a53942379fb47f1e84ec735d46b77bb1c1ceb968e245693dde067`,
  2026-11-06). Its `License.txt` reads: "License: (Creative Commons Zero, CC0)". kenney.nl itself
  refused scripted downloads (HTTP 403).

## Pipeline

The pack ships OBJ/MTL (flat colours, no textures). Each file was converted unchanged with
`node scripts/obj-to-glb.mjs <in.obj> <out.glb>` (no dependencies; one primitive per material).
The models are authored facing −z; orientation, size and mount height are normalised at load
time (`src/features/scene3d/models/manifest.ts`, `normalise.ts`).
