# 3D model credits and licences

Every file here is **CC0 1.0** (public domain dedication,
https://creativecommons.org/publicdomain/zero/1.0/). Credit is not required; we keep it anyway.
Types without a file below are built from primitives in code
(`src/features/scene3d/models/procedural.ts`, project code, same licence as the app).

| File                  | Catalogue type  | Source model                                                               | Pack                                             | Author             | Licence |
| --------------------- | --------------- | -------------------------------------------------------------------------- | ------------------------------------------------ | ------------------ | ------- |
| `fridge.glb`          | fridge          | `Models/kitchenFridge.obj`                                                 | Furniture Kit (released as "Furniture Pack 1.0") | Kenney (kenney.nl) | CC0 1.0 |
| `oven.glb`            | oven            | `Models/kitchenStove.obj`                                                  | same                                             | Kenney             | CC0 1.0 |
| `washer.glb`          | washer          | `Models/washer.obj`                                                        | same                                             | Kenney             | CC0 1.0 |
| `dryer.glb`           | dryer           | `Models/dryer.obj`                                                         | same                                             | Kenney             | CC0 1.0 |
| `microwave.glb`       | microwave       | `Models/kitchenMicrowave.obj`                                              | same                                             | Kenney             | CC0 1.0 |
| `tv.glb`              | tv              | `Models/televisionModern.obj`                                              | same                                             | Kenney             | CC0 1.0 |
| `computer.glb`        | computer        | `Models/computerScreen.obj` + `computerKeyboard.obj` + `computerMouse.obj` | same                                             | Kenney             | CC0 1.0 |
| `laptop.glb`          | laptop          | `Models/laptop.obj`                                                        | same                                             | Kenney             | CC0 1.0 |
| `door-frame.glb`      | (door frame)    | `Models/doorwayOpen.obj`                                                   | same                                             | Kenney             | CC0 1.0 |
| `door-leaf.glb`       | (interior door) | `Models/doorway.obj`, door and handles only                                | same                                             | Kenney             | CC0 1.0 |
| `front-door-leaf.glb` | (exterior door) | `Models/doorwayFront.obj`, door, glass and handles only                    | same                                             | Kenney             | CC0 1.0 |
| `window.glb`          | (window)        | `Models/wallWindow.obj`, window frame and glass only                       | same                                             | Kenney             | CC0 1.0 |

## Source

- Pack page: https://kenney.nl/assets/furniture-kit (CC0).
- Downloaded from Kenney's own upload on OpenGameArt, https://opengameart.org/content/furniture-kit
  (`kenney_furniturePack.zip`, sha256 `68afa4e6dc8a53942379fb47f1e84ec735d46b77bb1c1ceb968e245693dde067`,
  2026-11-06). Its `License.txt` reads: "License: (Creative Commons Zero, CC0)". kenney.nl itself
  refused scripted downloads (HTTP 403).

## Pipeline

The pack ships OBJ/MTL (flat colours, no textures). Each file was converted with
`node scripts/obj-to-glb.mjs <in.obj> <out.glb>` (no dependencies; one primitive per material),
unchanged except for these, run from `apps/web` with `K` the unpacked `Models/` folder:

```sh
node scripts/obj-to-glb.mjs $K/doorway.obj src/assets/models/door-leaf.glb --keep -4.7:-0.1,-1:11,-1:2
node scripts/obj-to-glb.mjs $K/doorwayFront.obj src/assets/models/front-door-leaf.glb --keep -4.7:-0.1,-1:11,-1:2
node scripts/obj-to-glb.mjs $K/wallWindow.obj src/assets/models/window.glb --keep -7:-3,3:11,-1:2
node scripts/obj-to-glb.mjs $K/computerScreen.obj src/assets/models/computer.glb \
  --add $K/computerKeyboard.obj@-0.55,0,-1.5 --add $K/computerMouse.obj@-3.77,0,-1.33
```

`--keep` drops the frame around a door leaf and the wall around the window; `--add` puts the
keyboard and mouse in front of the screen. Door and window parts aren't items: they are
stretched to fit each wall gap (`src/features/scene3d/models/openingFit.ts`, D37).
The models are authored facing −z; orientation, size and mount height are normalised at load
time (`src/features/scene3d/models/manifest.ts`, `normalise.ts`).
