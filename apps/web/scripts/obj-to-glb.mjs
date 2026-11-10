#!/usr/bin/env node
// Convert a Kenney OBJ + MTL (flat colours, no textures) into a small GLB for src/assets/models.
// No dependencies: the files are simple (v / vn / f / usemtl, Kd colours), so a tiny writer is
// enough and keeps converter tooling out of package.json. One primitive per material.
//
//   node scripts/obj-to-glb.mjs <in.obj> <out.glb> [--keep x0:x1,y0:y1,z0:z1] [--add <b.obj>@dx,dy,dz]...
//
// --keep  keeps only the connected parts (faces sharing vertices, per material) whose bounds lie
//         inside the box, in the OBJ's own units: e.g. the window out of a wall-with-window piece,
//         or a door leaf without its frame.
// --add   merges another OBJ (same MTL colours by material name), moved by dx,dy,dz: e.g. a
//         keyboard and mouse in front of a screen. Repeatable. --keep applies to <in.obj> only.
//
// The geometry is written as authored; orientation and size are normalised at load time
// (src/features/scene3d/models/normalise.ts) using the manifest in src/assets/models.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const args = process.argv.slice(2);
const [input, output] = args;
const usage =
  'usage: obj-to-glb.mjs <in.obj> <out.glb> [--keep x0:x1,y0:y1,z0:z1] [--add b.obj@dx,dy,dz]';
if (!input || !output || input.startsWith('--') || output.startsWith('--')) {
  console.error(usage);
  process.exit(2);
}
let keep = null;
const adds = [];
for (let i = 2; i < args.length; i += 2) {
  const [flag, value] = [args[i], args[i + 1]];
  if (flag === '--keep' && value) {
    keep = value.split(',').map((r) => r.split(':').map(Number));
    if (keep.length !== 3 || keep.flat().some((n) => !Number.isFinite(n))) {
      console.error(`bad --keep box: ${value}`);
      process.exit(2);
    }
  } else if (flag === '--add' && value) {
    const [file, at = '0,0,0'] = value.split('@');
    const d = at.split(',').map(Number);
    if (d.length !== 3 || d.some((n) => !Number.isFinite(n))) {
      console.error(`bad --add offset: ${value}`);
      process.exit(2);
    }
    adds.push({ file, d });
  } else {
    console.error(usage);
    process.exit(2);
  }
}

const colours = new Map();
function readColours(objPath, obj) {
  const mtlName = /^mtllib\s+(.+?)\s*$/m.exec(obj)?.[1];
  if (!mtlName) return;
  let current = null;
  for (const line of readFileSync(join(dirname(objPath), mtlName), 'utf8').split(/\r?\n/)) {
    const [k, ...rest] = line.trim().split(/\s+/);
    if (k === 'newmtl') current = rest.join(' ');
    else if (k === 'Kd' && current && !colours.has(current))
      colours.set(current, rest.slice(0, 3).map(Number));
  }
}

/** Faces of an OBJ as { mat, corners: [{ v, p, n }] }, positions moved by `d`. */
function readFaces(objPath, d = [0, 0, 0]) {
  const obj = readFileSync(objPath, 'utf8');
  readColours(objPath, obj);
  const pos = [];
  const nrm = [];
  const faces = [];
  let mat = '_default';
  for (const line of obj.split(/\r?\n/)) {
    const [k, ...a] = line.trim().split(/\s+/);
    if (k === 'v') pos.push(a.slice(0, 3).map((x, j) => Number(x) + d[j]));
    else if (k === 'vn') nrm.push(a.slice(0, 3).map(Number));
    else if (k === 'usemtl') mat = a.join(' ');
    else if (k === 'f') {
      const corners = a.map((tok) => {
        const [vi, , ni] = tok.split('/');
        const v = Number(vi) < 0 ? pos.length + Number(vi) : Number(vi) - 1;
        const n = ni ? (Number(ni) < 0 ? nrm.length + Number(ni) : Number(ni) - 1) : -1;
        return { v, p: pos[v], n: n >= 0 ? nrm[n] : [0, 1, 0], key: `${v}/${n}` };
      });
      faces.push({ mat, corners });
    }
  }
  return faces;
}

/** The faces of the connected parts (per material, by shared vertex) inside `box`. */
function keepInside(faces, box) {
  const parent = new Map();
  const find = (a) => {
    while (parent.get(a) !== a) a = parent.get(a);
    return a;
  };
  const id = (f, c) => `${f.mat}|${c.p.map((x) => x.toFixed(4)).join(',')}`;
  for (const f of faces)
    for (const c of f.corners) if (!parent.has(id(f, c))) parent.set(id(f, c), id(f, c));
  for (const f of faces) {
    const root = find(id(f, f.corners[0]));
    for (const c of f.corners.slice(1)) parent.set(find(id(f, c)), root);
  }
  const inside = new Map();
  for (const f of faces) {
    const root = find(id(f, f.corners[0]));
    const ok = f.corners.every((c) => c.p.every((x, j) => x >= box[j][0] && x <= box[j][1]));
    inside.set(root, (inside.get(root) ?? true) && ok);
  }
  return faces.filter((f) => inside.get(find(id(f, f.corners[0]))));
}

let faces = readFaces(input);
if (keep) faces = keepInside(faces, keep);
adds.forEach((a, i) =>
  faces.push(
    ...readFaces(a.file, a.d).map((f) => ({
      ...f,
      corners: f.corners.map((c) => ({ ...c, key: `a${i}:${c.key}` })),
    })),
  ),
);
if (faces.length === 0) {
  console.error('nothing left to write (check --keep)');
  process.exit(1);
}

const groups = new Map(); // material -> { verts: Map<key, index>, p: [], n: [], idx: [] }
const group = (m) => {
  if (!groups.has(m)) groups.set(m, { verts: new Map(), p: [], n: [], idx: [] });
  return groups.get(m);
};
for (const f of faces) {
  const g = group(f.mat);
  const ids = f.corners.map((c) => {
    let i = g.verts.get(c.key);
    if (i === undefined) {
      i = g.p.length / 3;
      g.verts.set(c.key, i);
      g.p.push(...c.p);
      g.n.push(...c.n);
    }
    return i;
  });
  for (let j = 1; j + 1 < ids.length; j++) g.idx.push(ids[0], ids[j], ids[j + 1]);
}

// sRGB display colour (MTL Kd) -> linear glTF baseColorFactor.
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const round = (x) => Math.round(x * 1e4) / 1e4;

const chunks = [];
let offset = 0;
const bufferViews = [];
const accessors = [];
const push = (typed, target) => {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (bytes.length % 4)) % 4;
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
  chunks.push(bytes, Buffer.alloc(pad));
  offset += bytes.length + pad;
  return bufferViews.length - 1;
};

const materials = [];
const primitives = [];
for (const [name, g] of groups) {
  if (g.idx.length === 0) continue;
  const p = new Float32Array(g.p);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    min[i % 3] = Math.min(min[i % 3], p[i]);
    max[i % 3] = Math.max(max[i % 3], p[i]);
  }
  const count = p.length / 3;
  const pv = push(p, 34962);
  const nv = push(new Float32Array(g.n), 34962);
  const big = count > 65535;
  const iv = push(big ? new Uint32Array(g.idx) : new Uint16Array(g.idx), 34963);
  accessors.push(
    { bufferView: pv, componentType: 5126, count, type: 'VEC3', min, max },
    { bufferView: nv, componentType: 5126, count, type: 'VEC3' },
    { bufferView: iv, componentType: big ? 5125 : 5123, count: g.idx.length, type: 'SCALAR' },
  );
  const kd = colours.get(name) ?? [0.8, 0.8, 0.8];
  materials.push({
    name,
    pbrMetallicRoughness: {
      baseColorFactor: [...kd.map((c) => round(lin(c))), 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
  });
  const a = accessors.length;
  primitives.push({
    attributes: { POSITION: a - 3, NORMAL: a - 2 },
    indices: a - 1,
    material: materials.length - 1,
  });
}

const name = basename(input).replace(/\.obj$/i, '');
const bin = Buffer.concat(chunks);
const json = {
  asset: { version: '2.0', generator: 'housebook obj-to-glb' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name, mesh: 0 }],
  meshes: [{ name, primitives }],
  materials,
  accessors,
  bufferViews,
  buffers: [{ byteLength: bin.length }],
};
let jsonBuf = Buffer.from(JSON.stringify(json));
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
const chunkHeader = (len, type) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(len, 0);
  b.writeUInt32LE(type, 4);
  return b;
};
writeFileSync(
  output,
  Buffer.concat([
    header,
    chunkHeader(jsonBuf.length, 0x4e4f534a),
    jsonBuf,
    chunkHeader(bin.length, 0x004e4942),
    bin,
  ]),
);
console.log(
  `${output}: ${primitives.length} primitives, ${((12 + 16 + jsonBuf.length + bin.length) / 1024) | 0} KB`,
);
