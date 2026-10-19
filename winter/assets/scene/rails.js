/* ============================================================================
   rails.js —— 双轨 / 枕木 / 道砟雪床
   ----------------------------------------------------------------------------
   轨道分两段：
     · 直线段 x ∈ [-78, 26]：列车只在这里跑动，钢轨用整根长盒子（零细分）。
     · 弯道段 x > 26：向右后方弯出去，在雾里消失 —— 车头灯正好照在弯道上。
   枕木用 InstancedMesh：286 根一次 draw call。因为它们是死物，矩阵只在构建期
   算一次，之后就再也不碰了。
   ========================================================================== */
import * as THREE from 'three';
import {
  TRACK, trackZ, trackYaw, noise2, clamp, fbm2, mergeAll, Batch, PAL, makeRng,
} from './util.js';
import { groundHeight } from './terrain.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
void _m; void _q; void _v; void _s;

/* --------------------------------------------------------------- 路径采样 */
function samplePath(stepX) {
  const pts = [];
  let s = 0, px = TRACK.x0, pz = trackZ(TRACK.x0);
  pts.push({ x: px, z: pz, s: 0, yaw: trackYaw(px) });
  for (let x = TRACK.x0 + stepX; x <= TRACK.x1 + 1e-6; x += stepX) {
    const z = trackZ(x);
    s += Math.hypot(x - px, z - pz);
    pts.push({ x, z, s, yaw: trackYaw(x) });
    px = x; pz = z;
  }
  return pts;
}

/* ------------------------------------------------------------------ 钢轨
   截面做三条：轨腰 + 轨头 + 底部压条，侧视的时候能看出「钢轨不只是根棍」 */
function buildRails() {
  const list = [];
  const HALF = TRACK.gauge * 0.5;
  const yTop = TRACK.railTop;
  const railH = 0.13;
  const railW = 0.10;

  /* ---- 直线段：一根长盒子 ---- */
  const x0 = TRACK.x0, x1 = Math.min(TRACK.curveStart, TRACK.x1);
  const lenStraight = x1 - x0;
  for (let side = -1; side <= 1; side += 2) {
    const zc = side * HALF;
    /* 轨腰 */
    list.push(mkBox(lenStraight, railH * 0.62, railW * 0.62, (x0 + x1) * 0.5, yTop - railH + railH * 0.31, zc));
    /* 轨头 */
    list.push(mkBox(lenStraight, railH * 0.40, railW, (x0 + x1) * 0.5, yTop - railH * 0.20, zc));
    /* 轨底 */
    list.push(mkBox(lenStraight, railH * 0.22, railW * 1.55, (x0 + x1) * 0.5, yTop - railH * 0.89, zc));
  }

  /* ---- 弯道段：按 1.4 一段切 ---- */
  const pts = samplePath(1.4);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.x < x1 - 1e-6) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) * 1.04;
    const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
    /* 法向单位向量（轨距方向 = 切线绕 Y 转 90°） */
    const nx = -dz / len, nz = dx / len;
    const yaw = Math.atan2(-dz, dx);
    for (let side = -1; side <= 1; side += 2) {
      const zc = mz + nz * HALF * side;
      const xc = mx + nx * HALF * side;
      list.push(mkBox(len, railH * 0.62, railW * 0.62, xc, yTop - railH + railH * 0.31, zc, yaw));
      list.push(mkBox(len, railH * 0.40, railW, xc, yTop - railH * 0.20, zc, yaw));
      list.push(mkBox(len, railH * 0.22, railW * 1.55, xc, yTop - railH * 0.89, zc, yaw));
    }
  }

  const geo = mergeAll(list, false);
  return geo;
}

function mkBox(w, h, d, x, y, z, yaw) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (yaw) g.rotateY(yaw);
  g.translate(x, y, z);
  return g;
}

/* ------------------------------------------------------------------ 枕木 */
const _mq = new THREE.Quaternion();
const _mv1 = new THREE.Vector3();
const _mv2 = new THREE.Vector3();
const _ms = new THREE.Vector3(1, 1, 1);

function buildSleepers() {
  const SPACING = 0.66;
  const pts = samplePath(0.22);
  const mats = [];
  let nextS = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.s < nextS) continue;
    nextS += SPACING;
    /* 枕木略微沉在雪里，个别被雪埋掉一半 —— 用噪声决定 */
    const bury = noise2(p.x * 0.7, p.z * 0.7);
    const y = 0.16 + bury * 0.055 + (i % 3) * 0.004;
    _mq.setFromAxisAngle(_mv1.set(0, 1, 0), p.yaw);
    _mv2.set(p.x, y, p.z);
    const m = new THREE.Matrix4();
    m.compose(_mv2, _mq, _ms);
    mats.push(m);
  }
  return mats;
}

/* ------------------------------------------------------------- 道砟雪床
   一块贴在雪面上的薄带子，用顶点色（aTint）在枕木头位置画深色道砟，
   中间是被踩实又被雪盖住的白色。材质直接借雪原那一个，所以颜色天然一致。 */
function buildBed() {
  const HALF = TRACK.bedHalf;
  const cols = 5;                 // 横向分 5 列
  const stepX = 1.15;
  const rnd = makeRng(66123);

  const xs = [];
  for (let x = TRACK.x0; x <= TRACK.x1 + 1e-6; x += stepX) xs.push(x);
  const rows = xs.length;
  const n = rows * (cols + 1);

  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const tint = new Float32Array(n * 3);

  let p = 0, q = 0, r = 0, c = 0;
  for (let i = 0; i < rows; i++) {
    const x = xs[i];
    const tz = trackZ(x);
    for (let j = 0; j <= cols; j++) {
      const u = j / cols;
      const dz = (u - 0.5) * 2 * HALF;
      const z = tz + dz;
      /* 贴着地面 +0.02；枕木之间被踩出一点凹 */
      const wave = Math.sin(x * 9.2 + dz * 2.0) * 0.006;
      const y = groundHeight(x, z) + 0.022 + wave;
      pos[p] = x; pos[p + 1] = y; pos[p + 2] = z; p += 3;
      nrm[q] = 0; nrm[q + 1] = 1; nrm[q + 2] = 0; q += 3;
      uv[r] = u * 4; uv[r + 1] = x * 0.35; r += 2;

      /* ---- 顶点色：道砟斑点 ---- */
      const az = Math.abs(dz);
      /* 中间两根钢轨之间基本被雪填满，只有靠枕木头的位置露出道砟 */
      const stoneBand = clamp((az - 0.42) / 0.5, 0, 1) * clamp((1.85 - az) / 0.45, 0, 1);
      const sp = fbm2(x * 3.1, z * 3.1, 3);
      const stone = clamp(stoneBand * (sp * 1.9 - 0.55) + 0.10, 0, 1);
      const g = 0.52 + (rnd() - 0.5) * 0.05;
      const tr = 1 - stone * 0.62;
      const tg = 1 - stone * 0.60;
      const tb = 1 - stone * 0.56;
      /* 边缘直接融进雪里（1.0 = 纯白） */
      const edge = 1 - clamp((az - HALF * 0.75) / (HALF * 0.25), 0, 1);
      tint[c] = tr * edge + (1 - edge) * 0.98;
      tint[c + 1] = tg * edge + (1 - edge) * 0.99;
      tint[c + 2] = tb * edge + (1 - edge) * 1.0;
      c += 3;
      void g;
    }
  }

  const idx = new Uint32Array((rows - 1) * cols * 6);
  let k = 0;
  const stride = cols + 1;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const c2 = a + stride;
      const d2 = c2 + 1;
      idx[k++] = a; idx[k++] = c2; idx[k++] = b;
      idx[k++] = b; idx[k++] = c2; idx[k++] = d2;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* -------------------------------------------------------------- 轨道外框
   返回的都是几何/矩阵，材质由 world.js 统一给（这样材质数量可控） */
export function buildTrack() {
  const railGeo = buildRails();
  const sleeperMatrices = buildSleepers();
  const bedGeo = buildBed();

  /* 枕木几何：深浸沥青的木方，两端略斜切 */
  const b = new Batch(1.4);
  const woodShade = function (x, y, z, col, o) {
    const n = (noise2(x * 5.1, z * 5.1) - 0.5) * 0.35;
    col[o] = 1 + n; col[o + 1] = 1 + n * 1.05; col[o + 2] = 1 + n * 1.15;
  };
  b.box(0.26, 0.17, 2.24, 0, 0, 0, woodShade);
  const sleeperGeo = b.build();

  return {
    railGeo,
    sleeperGeo,
    sleeperMatrices,
    sleeperCount: sleeperMatrices.length,
    bedGeo,
  };
}

/* ============================================================== 站台家具
   站台在列车「后面」（z 更负），所以主体的下缘会被列车挡住，但灯柱、
   水塔、信号机这些高出去的部分会露在雪线以上 —— 这就是纵深。 */
export function buildStationProps() {
  const dark = new Batch(1.1);
  const brass = new Batch(1.6);
  const rnd = makeRng(424242);

  /* ---- 站台：一段低矮的石台，边缘有雪 ---- */
  const platZ = -5.4;
  const platTop = 0.62;
  dark.box(46, 0.75, 3.1, -8, platTop - 0.38, platZ, null);
  /* 站台边缘的一条压顶石 */
  dark.box(46, 0.10, 0.34, -8, platTop + 0.02, platZ + 1.45, null);
  /* 雨棚整组移除：一根没有可见支撑的灰条读成「悬空平台」，不值得 */


  /* ---- 4 根站台灯柱（灯的亮点在 glow 层里） ---- */
  const lampPos = [];
  for (let i = 0; i < 4; i++) {
    const px = -28 + i * 12.5;
    const top = platTop + 4.15;
    dark.cyl(0.085, 0.105, 4.15, 8, px, platTop + 2.07, platZ + 0.9, null);
    /* 灯罩 */
    dark.cyl(0.30, 0.10, 0.30, 10, px, top + 0.05, platZ + 0.9, null);
    /* 灯杆上的小卷草装饰（黄铜） */
    brass.sph(0.055, 8, px, platTop + 1.2, platZ + 0.9, null);
    lampPos.push(px, top - 0.10, platZ + 0.9);
  }

  /* ---- 水塔：一根柱 + 一个木桶，是这类雪景里的必备剪影 ---- */
  const wtx = 34, wtz = -16;
  const wtop = 6.4;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.6;
    dark.cyl(0.10, 0.13, wtop, 6, wtx + Math.cos(a) * 0.95, wtop * 0.5, wtz + Math.sin(a) * 0.95, null);
  }
  /* 木桶 */
  dark.cyl(1.25, 1.05, 1.9, 14, wtx, wtop + 0.95, wtz, null);
  /* 桶的箍 */
  for (let i = 0; i < 3; i++) {
    dark.cyl(1.27, 1.27, 0.07, 14, wtx, wtop + 0.35 + i * 0.62, wtz, null);
  }
  /* 出水臂 */
  dark.box(0.14, 0.14, 2.0, wtx - 0.1, wtop + 1.6, wtz + 1.9, null);
  dark.cyl(0.11, 0.11, 0.7, 8, wtx - 0.1, wtop + 1.25, wtz + 2.85, null);

  /* ---- 信号机：一根杆 + 一面斜臂（远处那点红是唯一的非暖色暖色） ---- */
  const sgx = 20, sgz = -3.6;
  dark.cyl(0.14, 0.17, 4.6, 8, sgx, 2.3, sgz, null);
  dark.box(1.9, 0.10, 0.10, sgx + 0.85, 4.35, sgz, null, 0, 0, -0.34);
  dark.box(0.36, 0.42, 0.20, sgx, 3.2, sgz + 0.06, null);

  /* ---- 几根电线杆，往弯道方向排过去 ---- */
  for (let i = 0; i < 5; i++) {
    const px = 24 + i * 11 + rnd() * 2;
    const pz = -12 - i * 5.5 - rnd() * 2;
    dark.cyl(0.09, 0.12, 6.2 + rnd(), 6, px, 3.1, pz, null);
    dark.box(1.5, 0.08, 0.08, px, 5.6, pz, null);
  }

  return {
    darkGeo: dark.build(),
    brassGeo: brass.build(),
    lampPos,
    platTop,
    platZ,
  };
}
