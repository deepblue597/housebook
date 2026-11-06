#!/usr/bin/env node
// Convert a Kenney OBJ + MTL (flat colours, no textures) into a small GLB for src/assets/models.
// No dependencies: the files are simple (v / vn / f / usemtl, Kd colours), so a tiny writer is
// enough and keeps converter tooling out of package.json. One primitive per material.
//
//   node scripts/obj-to-glb.mjs <in.obj> <out.glb>
//
// The geometry is written as authored; orientation and size are normalised at load time
// (src/features/scene3d/models/normalise.ts) using the manifest in src/assets/models.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: obj-to-glb.mjs <in.obj> <out.glb>');
  process.exit(2);
}

const obj = readFileSync(input, 'utf8');
const mtlName = /^mtllib\s+(.+?)\s*$/m.exec(obj)?.[1];
const colours = new Map();
if (mtlName) {
  let current = null;
  for (const line of readFileSync(join(dirname(input), mtlName), 'utf8').split(/\r?\n/)) {
    const [k, ...rest] = line.trim().split(/\s+/);
    if (k === 'newmtl') current = rest.join(' ');
    else if (k === 'Kd' && current) colours.set(current, rest.slice(0, 3).map(Number));
  }
}

const pos = [];
const nrm = [];
const groups = new Map(); // material -> { verts: Map<key, index>, p: [], n: [], idx: [] }
let mat = '_default';
const group = (m) => {
  if (!groups.has(m)) groups.set(m, { verts: new Map(), p: [], n: [], idx: [] });
  return groups.get(m);
};
for (const line of obj.split(/\r?\n/)) {
  const [k, ...a] = line.trim().split(/\s+/);
  if (k === 'v') pos.push(a.slice(0, 3).map(Number));
  else if (k === 'vn') nrm.push(a.slice(0, 3).map(Number));
  else if (k === 'usemtl') mat = a.join(' ');
  else if (k === 'f') {
    const g = group(mat);
    const ids = a.map((tok) => {
      const [vi, , ni] = tok.split('/');
      const v = Number(vi) < 0 ? pos.length + Number(vi) : Number(vi) - 1;
      const n = ni ? (Number(ni) < 0 ? nrm.length + Number(ni) : Number(ni) - 1) : -1;
      const key = `${v}/${n}`;
      let i = g.verts.get(key);
      if (i === undefined) {
        i = g.p.length / 3;
        g.verts.set(key, i);
        g.p.push(...pos[v]);
        g.n.push(...(n >= 0 ? nrm[n] : [0, 1, 0]));
      }
      return i;
    });
    for (let j = 1; j + 1 < ids.length; j++) g.idx.push(ids[0], ids[j], ids[j + 1]);
  }
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
