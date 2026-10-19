/* ============================================================================
   util.js —— 数学 / 噪声 / 调色板 / 几何批处理
   ----------------------------------------------------------------------------
   这个文件里所有函数都是「构建期」或「纯函数」，不进入每帧热循环。
   热循环里只用标量运算和预分配的 Vector3/Matrix4（见 index.js 注释）。
   ========================================================================== */
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/BufferGeometryUtils.js';

/* ------------------------------------------------------------------ 调色板 */
/* 与 docs/DESIGN.md 的 6 色板一一对应。暖色只允许出现在 lamp 家族。 */
export const PAL = {
  snow0: 0xf4f8fb,
  snow1: 0xe4edf4,
  snow2: 0xc6d6e3,
  steel0: 0x0d1620,
  steel1: 0x1a2833,
  steel2: 0x2c3f4d,
  lamp: 0xffb257,
  lampHot: 0xffd9a0,
  lampDeep: 0xe07a1f,
  ice: 0x79cfe6,
  iceDeep: 0x2f7db0,
  ink: 0x0b1a26,
  ink2: 0x33556e,
  brass: 0xa8843c,
  brassDark: 0x6b5324,
  rust: 0x40281a,
  coal: 0x090c10,
};

/* --------------------------------------------------------------- 标量工具 */
export const TAU = Math.PI * 2;

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function invLerp(a, b, v) { return clamp((v - a) / (b - a), 0, 1); }
export function smoothstep(a, b, v) { const t = invLerp(a, b, v); return t * t * (3 - 2 * t); }
export function mix(a, b, t) { return a + (b - a) * t; }

/* 确定性伪随机：同一个 seed 永远同一个序列，截图可复现 */
export function makeRng(seed) {
  let s = (seed | 0) || 1;
  return function rng() {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return ((s >>> 0) % 1000003) / 1000003;
  };
}

/* ------------------------------------------------------------- 1D/2D 噪声 */
function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
export function noise1(x) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(hash1(i), hash1(i + 1), u);
}
/* 分形叠加，返回 0..1 */
export function fbm1(x, oct) {
  let a = 0.5, s = 0, b = 1, norm = 0;
  const n = oct || 4;
  for (let i = 0; i < n; i++) { s += a * noise1(x * b); norm += a; b *= 2.07; a *= 0.5; }
  return s / norm;
}
/* 脊线噪声：把 fbm 折起来，得到山脊那种带尖的轮廓 */
export function ridge1(x, oct) {
  let a = 0.5, s = 0, b = 1, norm = 0;
  const n = oct || 4;
  for (let i = 0; i < n; i++) {
    const v = 1 - Math.abs(noise1(x * b) * 2 - 1);
    s += a * v * v; norm += a; b *= 2.13; a *= 0.52;
  }
  return s / norm;
}

export function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7 + 74.7) * 43758.5453123;
  return s - Math.floor(s);
}
export function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}
export function fbm2(x, y, oct) {
  let a = 0.5, s = 0, norm = 0, b = 1;
  const n = oct || 4;
  for (let i = 0; i < n; i++) { s += a * noise2(x * b, y * b); norm += a; b *= 2.03; a *= 0.5; }
  return s / norm;
}

/* ------------------------------------------------------- 几何：UV 盒投影
   锅炉和车体都是大块贴图，默认 UV 是每个面 0..1，会把铆钉拉得大小不一。
   这里按主导法线方向做一次「盒投影」，让铆钉在整台车上尺寸一致。 */
export function boxProjectUv(geo, scale) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = pos.getX(i) * scale; v = pos.getZ(i) * scale; }
    else if (nx >= nz) { u = pos.getZ(i) * scale; v = pos.getY(i) * scale; }
    else { u = pos.getX(i) * scale; v = pos.getY(i) * scale; }
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/* ------------------------------------------------------------------ 批处理
   把一堆基础几何体（Box / Cylinder / Lathe / Torus …）按材质合并成一个
   BufferGeometry：一次 draw call 画完整个车体。
   shade(x,y,z,r,g,b) 在合并前逐顶点写 color，用来做「底部锈、顶部雪、
   焊口发暗」这类顶点着色 —— 比第二张贴图便宜，也比硬堆几何划算。         */
export class Batch {
  constructor(scale) {
    this.geoms = [];
    this.uvScale = scale === undefined ? 0.9 : scale;
    this.anyNonIndexed = false;
  }

  /** geo: BufferGeometry（会被就地改写并接管所有权） */
  add(geo, matrix, shade, uvScale) {
    if (matrix) geo.applyMatrix4(matrix);
    if (!geo.index) this.anyNonIndexed = true;

    const pos = geo.attributes.position;
    const n = pos.count;
    const col = new Float32Array(n * 3);
    if (shade) {
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        col[o] = 1; col[o + 1] = 1; col[o + 2] = 1;
        shade(pos.getX(i), pos.getY(i), pos.getZ(i), col, o);
      }
    } else {
      col.fill(1);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!geo.attributes.uv) {
      const uv = new Float32Array(n * 2);
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    } else if (uvScale !== 0) {
      boxProjectUv(geo, uvScale === undefined ? this.uvScale : uvScale);
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    this.geoms.push(geo);
    return this;
  }

  /** 便捷：长方体 */
  box(w, h, d, px, py, pz, shade, rx, ry, rz) {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = _m4();
    _euler.set(rx || 0, ry || 0, rz || 0);
    m.makeRotationFromEuler(_euler);
    m.setPosition(px, py, pz);
    return this.add(g, m, shade);
  }

  /** 便捷：圆柱（沿 Y 轴，靠 rot 旋转到需要的轴向） */
  cyl(rTop, rBot, h, seg, px, py, pz, shade, rx, ry, rz, open) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, !!open);
    const m = _m4();
    _euler.set(rx || 0, ry || 0, rz || 0);
    m.makeRotationFromEuler(_euler);
    m.setPosition(px, py, pz);
    return this.add(g, m, shade);
  }

  /** 便捷：球 */
  sph(r, seg, px, py, pz, shade, sx, sy, sz) {
    const g = new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1));
    if (sx !== undefined) g.scale(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz);
    const m = _m4();
    m.makeTranslation(px, py, pz);
    return this.add(g, m, shade);
  }

  /** 合并。返回 null 表示没有内容。 */
  build() {
    if (!this.geoms.length) return null;
    let list = this.geoms;
    if (this.anyNonIndexed) {
      /* 混编索引/非索引会合并失败，统一降级成非索引 */
      const conv = [];
      for (let i = 0; i < list.length; i++) conv.push(list[i].index ? list[i].toNonIndexed() : list[i]);
      list = conv;
    }
    const merged = mergeGeometries(list, false);
    for (let i = 0; i < this.geoms.length; i++) this.geoms[i].dispose();
    if (list !== this.geoms) for (let i = 0; i < list.length; i++) list[i].dispose();
    this.geoms.length = 0;
    if (merged) merged.computeBoundingSphere();
    return merged;
  }
}

/* 外部也常用：把一堆几何合并成一块（山、针叶林、枕木以外的静态件） */
export function mergeAll(list, useGroups) {
  const merged = mergeGeometries(list, !!useGroups);
  for (let i = 0; i < list.length; i++) list[i].dispose();
  if (merged) merged.computeBoundingSphere();
  return merged;
}

/* 预分配的临时对象（构建期复用，避免 GC 抖动） */
const _euler = new THREE.Euler();
const _m4pool = [];
let _m4i = 0;
function _m4() {
  if (_m4i >= _m4pool.length) _m4pool.push(new THREE.Matrix4());
  const m = _m4pool[_m4i++];
  m.identity();
  return m;
}
export function resetM4Pool() { _m4i = 0; }

/* ------------------------------------------------------------ 顶点着色器
   常用着色函数：底部锈、上部积雪、随机污渍。返回写进 col[o..o+2] 的值。 */
export const SHADE = {
  /** 近黑钢 + 底部锈斑 + 顶部一点点霜 */
  steel(rustAmount, frostAmount) {
    const r = rustAmount === undefined ? 1 : rustAmount;
    const f = frostAmount === undefined ? 1 : frostAmount;
    return function (x, y, z, col, o) {
      /* 底部（y 小）锈：0..1 */
      const rust = clamp((1.55 - y) / 1.35, 0, 1) * r;
      /* 顶部霜：y 越大越白一点点，别太亮（雪是单独一块几何） */
      const frost = clamp((y - 2.7) / 1.3, 0, 1) * f * 0.16;
      /* 一点确定性斑驳，避免大面积纯色 */
      const n = (hash2(Math.floor(x * 7.3), Math.floor(y * 7.3 + z * 2.1)) - 0.5) * 0.12;
      const base = 1 + n;
      const kr = 1 - rust * 0.34 + frost;
      const kg = 1 - rust * 0.42 + frost;
      const kb = 1 - rust * 0.56 + frost;
      col[o] = base * kr;
      col[o + 1] = base * kg;
      col[o + 2] = base * kb;
    };
  },
  /** 纯色（不改） */
  flat() { return function (x, y, z, col, o) { col[o] = 1; col[o + 1] = 1; col[o + 2] = 1; }; },
  /** 抛光黄铜：越靠下越脏 */
  brass() {
    return function (x, y, z, col, o) {
      const dirt = clamp((1.7 - y) / 1.4, 0, 1) * 0.30;
      const n = (hash2(Math.floor(x * 11.0), Math.floor(y * 11.0)) - 0.5) * 0.1;
      col[o] = 1 - dirt + n;
      col[o + 1] = 1 - dirt * 1.05 + n;
      col[o + 2] = 1 - dirt * 1.2 + n;
    };
  },
};

/* -------------------------------------------------------------- 轨道几何 */
/* 这一段直线用来放列车（列车只在 x <= curveStart 上动），
   curveStart 之后轨道向右后方弯出去，在雾里消失 —— 车头灯正好照在那里。 */
export const TRACK = {
  x0: -78,
  x1: 108,
  curveStart: 26,
  curveK: 0.0055,
  gauge: 1.5,       // 轨距（中心距）
  railTop: 0.44,    // 轮子接触面高度
  sleeperTop: 0.32,
  bedHalf: 2.0,
};

export function trackZ(x) {
  const d = x - TRACK.curveStart;
  return d <= 0 ? 0 : -d * d * TRACK.curveK;
}
export function trackSlope(x) {
  const d = x - TRACK.curveStart;
  return d <= 0 ? 0 : -2 * d * TRACK.curveK;
}
/** 轨道中心线在给定 x 处的朝向角（绕 Y，弧度） */
export function trackYaw(x) {
  return -Math.atan(trackSlope(x));
}

/* -------------------------------------------------------------- 颜色工具
   我所有手写着色器都是「直接把 sRGB 值写进 gl_FragColor」，不经过
   three 的 colorspace 转换（这样 DESIGN.md 里的 hex 和屏幕上像素完全一致）。
   所以往这些 shader 传颜色时，必须绕开 ColorManagement 的 linear 化，
   直接给 0..1 的 sRGB 分量。 */
export function srgb(hex) {
  return new THREE.Vector3(
    ((hex >> 16) & 255) / 255,
    ((hex >> 8) & 255) / 255,
    (hex & 255) / 255,
  );
}
/** 同上，但返回 THREE.Color（给 ShaderMaterial 里声明成 vec3 的 uniform 也行） */
export function srgbColor(hex, out) {
  const c = out || new THREE.Color();
  c.setRGB(
    ((hex >> 16) & 255) / 255,
    ((hex >> 8) & 255) / 255,
    (hex & 255) / 255,
    THREE.LinearSRGBColorSpace,
  );
  return c;
}

/* ------------------------------------------------------------------ 其他 */
export function disposeObject(obj) {
  if (!obj) return;
  obj.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) { for (let i = 0; i < m.length; i++) m[i].dispose(); }
    else m.dispose();
  });
}

export function disposeTree(o) {
  if (!o) return;
  if (o.parent) o.parent.remove(o);
  disposeObject(o);
}
