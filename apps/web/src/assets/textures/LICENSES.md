# Texture credits and licences

Floor textures are **CC0 1.0** (public domain dedication,
https://creativecommons.org/publicdomain/zero/1.0/) from [ambientCG](https://ambientcg.com) by
Lennart Demes. Credit is not required; we keep it anyway. The wallpapers (`wallpaper-*.jpg`) are
drawn by `scripts/make-textures.py` (project code, same licence as the app).

| File                      | Finish key  | ambientCG asset                                      | Changed                   |
| ------------------------- | ----------- | ---------------------------------------------------- | ------------------------- |
| `oak_light.jpg`           | oak_light   | [WoodFloor040](https://ambientcg.com/a/WoodFloor040) | 512 px                    |
| `oak.jpg`                 | oak         | [WoodFloor051](https://ambientcg.com/a/WoodFloor051) | 512 px                    |
| `walnut.jpg`              | walnut      | [WoodFloor051](https://ambientcg.com/a/WoodFloor051) | 512 px, tinted darker     |
| `herringbone.jpg`         | herringbone | [WoodFloor034](https://ambientcg.com/a/WoodFloor034) | 512 px                    |
| `tiles_white.jpg`         | tiles_white | [Tiles107](https://ambientcg.com/a/Tiles107)         | 512 px                    |
| `tiles_grey.jpg`          | tiles_grey  | [Tiles038](https://ambientcg.com/a/Tiles038)         | 512 px                    |
| `terracotta.jpg`          | terracotta  | [Tiles027](https://ambientcg.com/a/Tiles027)         | 512 px, tinted terracotta |
| `checker.jpg`             | checker     | [Tiles012](https://ambientcg.com/a/Tiles012)         | 512 px                    |
| `stone.jpg`               | stone       | [Tiles139](https://ambientcg.com/a/Tiles139)         | 512 px                    |
| `concrete.jpg`            | concrete    | [Concrete046](https://ambientcg.com/a/Concrete046)   | 512 px, 70 % desaturated  |
| `carpet.jpg`              | carpet      | [Carpet016](https://ambientcg.com/a/Carpet016)       | 512 px                    |
| `wallpaper-stripes.jpg`   | stripes     | (drawn)                                              | –                         |
| `wallpaper-floral.jpg`    | floral      | (drawn)                                              | –                         |
| `wallpaper-geometric.jpg` | geometric   | (drawn)                                              | –                         |
| `wallpaper-linen.jpg`     | linen       | (drawn)                                              | –                         |

## Source

Each asset's `1K-JPG` pack from `https://ambientcg.com/get?file=<asset>_1K-JPG.zip` (2026-11-10);
only the colour map (`<asset>_1K-JPG_Color.jpg`) is used. SHA-256 of the zips:

| Pack                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `Carpet016_1K-JPG.zip`    | `b9e67b5d42cb47cead082dedae3767ae228175c857b6b3af6fe7bd4e69237b81` |
| `Concrete046_1K-JPG.zip`  | `72bf4321acbb39ddbc3b786f5996813b2a3cede12efefb47955e97ea9668985b` |
| `Tiles012_1K-JPG.zip`     | `e9c91c6dbc4aabffaf91a744d1c4a095a40fb774696de64b3afd212136d3666b` |
| `Tiles027_1K-JPG.zip`     | `66241fadea940824f6ee8e20b70b372f4da6ec9a8d0c1e5c42b9620b2f255113` |
| `Tiles038_1K-JPG.zip`     | `2072127386eb349d71af31de1a23626581b8d745a16c1aed047b075f5e6bf3a3` |
| `Tiles107_1K-JPG.zip`     | `ec41de6439d087cbd4b88ecd373cf240206715a3b3e022c0d556f9eb677940d0` |
| `Tiles139_1K-JPG.zip`     | `0ac4f6e094874948027a1477ad4b9e4986d48ccede608ae59874672ab46265db` |
| `WoodFloor034_1K-JPG.zip` | `e737314ca85dd7d93709357c72dc01c1d569358542b3b8f287c9bd2b7aa38b58` |
| `WoodFloor040_1K-JPG.zip` | `c83a01f1733f2a1f6e95ad6703689eb12fe259e77245d4c0a5652728d07c87cb` |
| `WoodFloor051_1K-JPG.zip` | `3f493484eab1ec5e1c466b90e515003b286fc6d7f84ff8ff6485900bfc26cef5` |

## Pipeline

With the colour maps of those packs in a folder `K`:

```sh
uv run --project apps/api python -I apps/web/scripts/make-textures.py $K
```

It shrinks each map to 512 px (JPEG quality 80), applies the tints listed above, draws the
wallpapers and prints every texture's average colour, which is the finish's `color` in
`contract/finishes.json` (drawn while the texture loads). The real-world size of each repeat
(`size`, metres) is in that file too: from ambientCG's stated dimensions where it gives them,
else from counting tiles (20 cm terracotta, 30 cm checker squares); wallpapers repeat every 50 cm.
