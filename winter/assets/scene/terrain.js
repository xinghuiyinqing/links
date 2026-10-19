/* ============================================================================
   terrain.js —— 雪原网格 + 三层远山
   ----------------------------------------------------------------------------
   雪原不是一块 flat plane：它用一个低频谱的高度场做出雪丘、风压纹和起伏，
   但把轨道走廊（|z| < 4.2）压平，否则钢轨会从雪里翘出来。
   远山不用任何贴图，是「山脊曲线 + 垂直幕布」，颜色全部烘在顶点色里：
   近层偏蓝灰、远层几乎融进地平线 —— 空气透视就这样三行搞定。
   ========================================================================== */
import * as THREE from 'three';
import { fbm2, noise2, smoothstep, ridge1, clamp, lerp, PAL, makeRng, mergeAll, trackZ } from './util.js';

/* ------------------------------------------------------------- 雪原高度场 */
export const GROUND = {
  x0: -170, x1: 170,
  z0: -212, z1: 62,
};

export function groundHeight(x, z) {
  /* 轨道中心线的横向位置（直线段是 0，弯出去以后为负） */
  const tz = trackZ(x);
  const az = Math.abs(z - tz);

  /* 轨道走廊：0 = 完全压平，1 = 正常起伏 */
  const corridor = smoothstep(4.2, 10.5, az);

  let h = 0;
  /* 大雪丘 */
  h += (fbm2(x * 0.072 + 11.3, z * 0.072 + 7.1, 3) - 0.5) * 1.55;
  h += (fbm2(x * 0.022 + 2.1, z * 0.022 + 5.4, 2) - 0.5) * 2.20;
  /* 风压出来的横向雪垄（沿 x 拉长） */
  h += (fbm2(x * 0.045 + 3.7, z * 0.135 - 2.1, 3) - 0.5) * 0.52;
  /* 中频起伏 */
  h += (fbm2(x * 0.16 - 4.7, z * 0.16 + 2.9, 2) - 0.5) * 0.42;
  /* 高频雪壳 */
  h += (noise2(x * 0.55, z * 0.55) - 0.5) * 0.055;

  /* 远处轻轻抬一点，藏住网格的边界 */
  h += smoothstep(70, 190, -z) * 1.8;

  /* 相机这一侧（z 大）压低一点，让近景是一整片平雪 */
  h -= smoothstep(34, 62, z) * 0.25;

  h *= corridor;

  /* 道床：轨道中心抬高 0.2，两侧 3.2 米内落坡 */
  h += (1 - smoothstep(0.0, 3.2, az)) * 0.20;

  /* 道砟两侧被风堆起来的雪脊：贴着轨道 2.0~4.2 米那一圈鼓起来，
     再沿 x 压出横向风纹，这样侧视时钢轨两侧有「鼓包」而不是一条平雪。 */
  const shoulder = smoothstep(1.55, 2.35, az) * (1 - smoothstep(3.6, 5.0, az));
  h += shoulder * (0.10 + 0.14 * noise2(x * 0.35 + 5.1, z * 1.6));

  /* 前景雪堤：试过在 z>12 抬 0.55~1.4，结果是一块压死画面的白板（法线全朝上、
     受光项饱和），比原来的平雪更糟 —— 撤掉，前景只靠下面这套噪声的明暗对比。 */

  return h;
}

/**
 * 建雪原网格。分段数由档位决定。
 * 返回 { geometry, dispose } —— 顶点法线是 computeVertexNormals 算的，
 * 雪地 shader 靠 N.y 决定受光面亮度，所以法线一定要准。
 */
export function buildGround(tier) {
  const sx = tier.groundSegX || 128;
  const sz = tier.groundSegZ || 96;
  const nx = sx + 1, nz = sz + 1;
  const count = nx * nz;

  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const tint = new Float32Array(count * 3);
  tint.fill(1);

  let p = 0, q = 0, r = 0;
  for (let j = 0; j < nz; j++) {
    /* z 方向用非均匀分布：靠近相机与轨道更密，远场更疏。
       t=0 -> 相机侧，t=1 -> 最远。指数分布刚好对应透视下的等面积。 */
    const t = j / sz;
    const z = GROUND.z1 + (GROUND.z0 - GROUND.z1) * Math.pow(t, 1.9);
    for (let i = 0; i < nx; i++) {
      const u = i / sx;
      const x = GROUND.x0 + (GROUND.x1 - GROUND.x0) * u;
      const y = groundHeight(x, z);
      pos[p] = x; pos[p + 1] = y; pos[p + 2] = z; p += 3;
      nrm[q] = 0; nrm[q + 1] = 1; nrm[q + 2] = 0; q += 3;
      uv[r] = u * 40; uv[r + 1] = t * 40; r += 2;
    }
  }

  /* 索引 */
  const idxCount = sx * sz * 6;
  const IndexArray = count > 65535 ? Uint32Array : Uint16Array;
  const idx = new IndexArray(idxCount);
  let k = 0;
  for (let j = 0; j < sz; j++) {
    for (let i = 0; i < sx; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
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

/* ------------------------------------------------------------------ 远山 */
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

/**
 * 一层山脊幕布。
 * @param z      幕布的 z
 * @param baseY  幕布底部（要埋进雪里）
 * @param amp    山脊振幅
 * @param freq   脊线频率
 * @param seed   噪声偏移
 * @param near   0..1 远近程度（0 = 最近，1 = 最远）
 * @param half   水平半宽
 */
function ridgeCurtain(z, baseY, amp, freq, seed, near, half, steps, jitter) {
  const n = steps;
  const verts = new Float32Array(n * 2 * 3);
  const cols = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);

  /* 越远越淡越偏蓝灰：与天空地平线同源 */
  const horizon = new THREE.Color(PAL.snow1);
  const body = new THREE.Color(PAL.snow2);
  /* 远层几乎融进地平线，近层保留轮廓 */
  const far = clamp(0.22 + near * 0.62, 0, 1);
  const baseCol = body.clone().lerp(horizon, far);
  /* 顶部比底部稍「实」一点（雾在低处堆积） */
  const topCol = baseCol.clone().lerp(horizon, -0.10);
  /* 每层独立的临时色，别和上面的 horizon/body 复用同一个对象 */
  const cTopTmp = new THREE.Color();
  const cBotTmp = new THREE.Color();

  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const x = -half + half * 2 * u;
    /* 两道不同频率的脊线叠加，避免所有山都是同一个波长 */
    let h = ridge1(x * freq + seed, 4);
    h = Math.pow(h, 1.35);
    /* 一个很宽的低频包络，让山有「主峰群」的疏密 */
    const env = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(x * freq * 0.28 + seed * 2.3));
    /* h*env 在某些区间会接近 0，那样山脊会沉到地平线以下、左半幅就空了。
       所以给一个 0.34 的地板：任何 x 处都高过天际线，只是峰谷有别。 */
    let y = baseY + amp * (0.34 + 0.66 * h * env);
    if (jitter) y += (noise2(x * freq * 9.1, seed * 7.7) - 0.5) * jitter * amp;

    const o = i * 6;
    /* 上顶点 */
    verts[o] = x; verts[o + 1] = y; verts[o + 2] = z;
    /* 下顶点：埋到雪面以下，防止露出底边 */
    verts[o + 3] = x; verts[o + 4] = baseY - 26; verts[o + 5] = z;

    /* 颜色：底部更「雾」，顶部保留一点体块 */
    const fogBottom = clamp(far + 0.30, 0, 1);
    cBotTmp.copy(baseCol).lerp(horizon, fogBottom);
    cTopTmp.copy(topCol).multiplyScalar(0.84 + 0.26 * h);
    cols[o] = cTopTmp.r; cols[o + 1] = cTopTmp.g; cols[o + 2] = cTopTmp.b;
    cols[o + 3] = cBotTmp.r; cols[o + 4] = cBotTmp.g; cols[o + 5] = cBotTmp.b;

    const uo = i * 4;
    uvs[uo] = u; uvs[uo + 1] = 1;
    uvs[uo + 2] = u; uvs[uo + 3] = 0;
  }

  const idx = new Uint32Array((n - 1) * 6);
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx[k++] = a; idx[k++] = b; idx[k++] = c;
    idx[k++] = c; idx[k++] = b; idx[k++] = d;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  return geo;
}

/* 三层远山 + 近处一层雪坡。返回合并后的单块几何（一次 draw call）。 */
export function buildMountains() {
  const layers = [];
  const rnd = makeRng(9931);

  /* 频率是按「1440 宽下每层能看到 4~6 个峰」反解的：
     层在 z 处，画面可见半宽 ≈ (camZ - z) * 0.4288，波长取可见宽度的 1/5。
     振幅则按「最高峰要高出车顶」定：远层 26、第三层 18。 */
  /* 最近一层：有雪覆盖的缓坡，挡住地平线的死直 */
  layers.push(ridgeCurtain(-26, -0.5, 3.4, 0.084, 4.2, 0.05, 150, 220, 0.10));
  /* 第二层 */
  layers.push(ridgeCurtain(-52, -0.9, 11.0, 0.062, 17.6, 0.28, 210, 240, 0.16));
  /* 第三层：主峰群 */
  layers.push(ridgeCurtain(-96, -1.3, 27.0, 0.042, 41.1, 0.55, 300, 260, 0.20));
  /* 最远：几乎只剩剪影，但要顶到画面 y≈290 */
  layers.push(ridgeCurtain(-158, -1.7, 40.0, 0.029, 73.9, 0.88, 440, 260, 0.24));

  return mergeAll(layers, false);
}

/* -------------------------------------------------------------- 远景针叶林
   一排很小的剪影云杉，压在第二层山前面。它做的事情很便宜但极其有效：
   给出「有距离的物」的参照，否则雪原会看起来像一块布。 */
export function buildTreeline() {
  const rnd = makeRng(20250131);
  const geos = [];
  const cTop = new THREE.Color(0x7d93a8);
  const cBot = new THREE.Color(0x9fb2c4);

  const groups = 8;
  for (let g = 0; g < groups; g++) {
    const gx = -180 + (360 / groups) * g + rnd() * 24;
    const gz = -34 - rnd() * 10;
    const n = 3 + ((rnd() * 4) | 0);
    for (let i = 0; i < n; i++) {
      const x = gx + (rnd() - 0.5) * 16;
      const z = gz + (rnd() - 0.5) * 5;
      const hgt = 2.6 + rnd() * 3.4;
      const rad = hgt * (0.17 + rnd() * 0.07);
      /* 一棵树 = 3 个锥体叠起来 */
      for (let t = 0; t < 3; t++) {
        const yy = hgt * (0.22 + t * 0.26);
        const rr = rad * (1 - t * 0.26);
        const hh = hgt * 0.44;
        const cone = new THREE.ConeGeometry(rr, hh, 5, 1, true);
        cone.translate(0, yy + hh * 0.5, 0);
        cone.rotateY(rnd() * 3);
        cone.translate(x, groundHeight(x, z) - 0.2, z);
        const n2 = cone.attributes.position.count;
        const col = new Float32Array(n2 * 3);
        for (let v = 0; v < n2; v++) {
          const vy = cone.attributes.position.getY(v);
          const k = clamp(vy / (hgt + 1), 0, 1);
          const cr = lerp(cBot.r, cTop.r, k);
          const cg = lerp(cBot.g, cTop.g, k);
          const cb = lerp(cBot.b, cTop.b, k);
          col[v * 3] = cr; col[v * 3 + 1] = cg; col[v * 3 + 2] = cb;
        }
        cone.setAttribute('color', new THREE.BufferAttribute(col, 3));
        if (!cone.attributes.uv) {
          cone.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n2 * 2), 2));
        }
        geos.push(cone);
      }
    }
  }
  return mergeAll(geos, false);
}

export { lerp, clamp, PAL };
