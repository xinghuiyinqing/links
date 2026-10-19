/* ============================================================================
   textures.js —— 运行时 canvas 生成的全部贴图
   ----------------------------------------------------------------------------
   一条硬规则：这个站点不加载任何外部图片。所有纹理都是启动时用 2D canvas
   画出来再包成 CanvasTexture 的，所以离线可用、和 CanvasWebGL 零 CORS 烦恼。

   贴图清单（共 3 张，别再加了，显存和启动时间都要给）：
     · steelSet   —— 铆接钢板：一张颜色（几乎中性）+ 一张法线（铆钉凸起）
     · coalMap    —— 煤堆的碎块噪声
     · puffMap    —— 蒸汽的软烟团（带噪声边缘，避免出现完美的圆）
   ========================================================================== */
import * as THREE from 'three';
import { makeRng, clamp } from './util.js';

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function tex(cv, repeat, srgb) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (repeat) t.repeat.set(repeat, repeat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

/* ---------------------------------------------------------------------------
   steelSet：铆接钢板
   布局（可无缝平铺）：整张贴图 = 一块钢板；左边和上边各走一条凹槽焊缝；
   焊缝内侧打一排铆钉。这样贴在锅炉上一转，就是一圈圈的箍环 + 铆钉带。
--------------------------------------------------------------------------- */
export function makeSteelSet(size) {
  const S = size || 512;
  const cv = canvas2d(S, S);
  const g = cv.getContext('2d');

  const rand = makeRng(20260214);

  /* 底色：中性灰白。真正的颜色靠 material.color（近黑蓝钢）给，
     这里只提供 ±8% 的明度起伏，避免大片死板。 */
  g.fillStyle = '#d8dde3';
  g.fillRect(0, 0, S, S);

  /* 大尺度脏污：几团很淡的椭圆 */
  for (let i = 0; i < 26; i++) {
    const x = rand() * S, y = rand() * S, r = 22 + rand() * 90;
    const a = 0.03 + rand() * 0.05;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(120,130,142,' + a.toFixed(3) + ')');
    grd.addColorStop(1, 'rgba(120,130,142,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  /* 细划痕：短促的浅色线，钢板轧制的方向性 */
  g.lineWidth = 1;
  for (let i = 0; i < 60; i++) {
    const x = rand() * S, y = rand() * S, len = 8 + rand() * 46;
    g.strokeStyle = 'rgba(255,255,255,' + (0.05 + rand() * 0.10).toFixed(3) + ')';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + len, y + (rand() - 0.5) * 3);
    g.stroke();
  }

  /* 焊缝凹槽（左/上边缘）—— 用深色 + 亮边模拟倒角 */
  const groove = 7;
  g.fillStyle = 'rgba(96,104,114,0.75)';
  g.fillRect(0, 0, groove, S);
  g.fillRect(0, 0, S, groove);
  g.fillStyle = 'rgba(255,255,255,0.30)';
  g.fillRect(groove, 0, 2, S);
  g.fillRect(0, groove, S, 2);

  /* 铆钉：沿焊缝内侧两排 */
  const rv = 13;              // 铆钉半径
  const pad = groove + 7;
  function rivet(x, y) {
    const grd = g.createRadialGradient(x - rv * 0.28, y - rv * 0.32, rv * 0.1, x, y, rv);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.55, 'rgba(224,230,238,0.85)');
    grd.addColorStop(1, 'rgba(118,126,138,0.55)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, rv, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(70,78,90,0.45)';
    g.lineWidth = 1.4;
    g.beginPath(); g.arc(x, y, rv, 0, Math.PI * 2); g.stroke();
  }
  const step = S / 8;
  for (let k = 0; k < 8; k++) {
    rivet(pad + step * (k + 0.5), pad + 4);
    rivet(pad + 4, pad + step * (k + 0.5));
  }

  const map = tex(cv, 1, true);

  /* ---------------- 法线图：解析式生成，铆钉是一个球冠 ---------------- */
  const nc = canvas2d(S, S);
  const ng = nc.getContext('2d');
  const img = ng.createImageData(S, S);
  const data = img.data;

  /* 高度场：凹槽为负，铆钉为半球正 */
  const H = new Float32Array(S * S);
  const gr = groove;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let h = 0;
      /* 沿边缘的 V 形凹槽 */
      const dx = Math.min(x, S - 1 - x) === x ? x : S - 1 - x;
      const dy = y;
      const dEdge = Math.min(dx, dy * 1.0, S - 1 - y > 0 ? S - 1 - y : 0);
      /* 简化：只在 x<gr 或 y<gr 处挖槽（平铺后左右上下自然接上） */
      const gx = Math.min(x, S - x) < gr ? Math.min(x, S - x) : gr;
      const gy = Math.min(y, S - y) < gr ? Math.min(y, S - y) : gr;
      const gd = Math.min(gx, gy);
      if (gd < gr) h -= (1 - gd / gr) * 0.9;
      H[y * S + x] = h;
    }
  }
  /* 铆钉球冠 */
  const rr = rv;
  function addRivet(cx, cy) {
    for (let dy = -rr; dy <= rr; dy++) {
      for (let dx = -rr; dx <= rr; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > rr * rr) continue;
        const x = ((cx + dx) % S + S) % S;
        const y = ((cy + dy) % S + S) % S;
        const t = Math.sqrt(1 - d2 / (rr * rr));
        H[y * S + x] += t * 0.72;
      }
    }
  }
  for (let k = 0; k < 8; k++) {
    addRivet(pad + step * (k + 0.5), pad + 4);
    addRivet(pad + 4, pad + step * (k + 0.5));
  }

  const strength = 1.35;
  for (let y = 0; y < S; y++) {
    const ym = (y - 1 + S) % S, yp = (y + 1) % S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S, xp = (x + 1) % S;
      const hl = H[y * S + xm], hr = H[y * S + xp];
      const hd = H[ym * S + x], hu = H[yp * S + x];
      let nx = (hl - hr) * strength;
      let ny = (hd - hu) * strength;
      let nz = 1.0;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;
      const o = (y * S + x) * 4;
      data[o] = (nx * 0.5 + 0.5) * 255;
      data[o + 1] = (ny * 0.5 + 0.5) * 255;
      data[o + 2] = (nz * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  ng.putImageData(img, 0, 0);
  const normalMap = tex(nc, 1, false);

  return { map, normalMap, dispose() { map.dispose(); normalMap.dispose(); } };
}

/* ------------------------------------------------------------- 煤堆噪声 */
export function makeCoalMap(size) {
  const S = size || 128;
  const cv = canvas2d(S, S);
  const g = cv.getContext('2d');
  const rand = makeRng(778899);
  g.fillStyle = '#22262c';
  g.fillRect(0, 0, S, S);
  /* 碎煤块：几层越来越小的多边形 */
  for (let layer = 0; layer < 3; layer++) {
    const n = 90 - layer * 25;
    const r0 = 9 - layer * 2.4;
    for (let i = 0; i < n; i++) {
      const cx = rand() * S, cy = rand() * S;
      const r = r0 * (0.5 + rand());
      const shade = 26 + rand() * 46;
      g.fillStyle = 'rgb(' + (shade | 0) + ',' + ((shade * 1.06) | 0) + ',' + ((shade * 1.18) | 0) + ')';
      g.beginPath();
      const sides = 4 + ((rand() * 3) | 0);
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2 + rand() * 0.4;
        const rr = r * (0.6 + rand() * 0.6);
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        if (s === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath(); g.fill();
    }
  }
  /* 一点点光泽碎点 */
  for (let i = 0; i < 220; i++) {
    const x = rand() * S, y = rand() * S;
    g.fillStyle = 'rgba(190,205,220,' + (0.05 + rand() * 0.22).toFixed(3) + ')';
    g.fillRect(x, y, 1.4, 1.4);
  }
  return tex(cv, 2, true);
}

/* ------------------------------------------------------------- 蒸汽烟团
   一朵 puff：中心浓、边缘碎。用几个偏移的高斯团叠出「翻卷」的形状，
   再加一层噪声把轮廓打碎，否则会看出是一个圆。 */
export function makePuffMap(size) {
  const S = size || 128;
  const cv = canvas2d(S, S);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  const rand = makeRng(31415926);

  g.globalCompositeOperation = 'lighter';
  const blobs = 7;
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + rand() * 0.9;
    const rad = S * (0.11 + rand() * 0.09);
    const dist = S * (0.06 + rand() * 0.14);
    const cx = S * 0.5 + Math.cos(a) * dist;
    const cy = S * 0.5 + Math.sin(a) * dist;
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grd.addColorStop(0, 'rgba(255,255,255,0.55)');
    grd.addColorStop(0.45, 'rgba(255,255,255,0.30)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
  }
  /* 中心核 */
  const core = g.createRadialGradient(S * 0.5, S * 0.5, 0, S * 0.5, S * 0.5, S * 0.30);
  core.addColorStop(0, 'rgba(255,255,255,0.85)');
  core.addColorStop(0.6, 'rgba(255,255,255,0.35)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core;
  g.beginPath(); g.arc(S * 0.5, S * 0.5, S * 0.30, 0, Math.PI * 2); g.fill();

  /* 用 alpha 擦出噪声边缘 */
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    const a = rand() * Math.PI * 2;
    const dist = S * (0.30 + rand() * 0.22);
    const cx = S * 0.5 + Math.cos(a) * dist;
    const cy = S * 0.5 + Math.sin(a) * dist;
    const rad = S * (0.02 + rand() * 0.07);
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    const al = 0.10 + rand() * 0.45;
    grd.addColorStop(0, 'rgba(0,0,0,' + al.toFixed(3) + ')');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
  }
  /* 外圈再压一次，保证贴图边界完全透明（不然 billboard 会出方框） */
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(S * 0.5, S * 0.5, S * 0.28, S * 0.5, S * 0.5, S * 0.5);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mask;
  g.fillRect(0, 0, S, S);

  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

/* ------------------------------------------------- 车厢内壁/车窗框的木纹
   只为黄铜窗框内侧的一层衬里，非常便宜。 */
export function makeWoodMap(size) {
  const S = size || 64;
  const cv = canvas2d(S, S);
  const g = cv.getContext('2d');
  const rand = makeRng(5150);
  g.fillStyle = '#3a2418';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 26; i++) {
    const y = rand() * S;
    g.strokeStyle = 'rgba(' + (90 + rand() * 70 | 0) + ',' + (58 + rand() * 44 | 0) + ',' + (34 + rand() * 30 | 0) + ',' + (0.10 + rand() * 0.22).toFixed(3) + ')';
    g.lineWidth = 0.7 + rand() * 2.2;
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= S; x += 8) g.lineTo(x, y + Math.sin(x * 0.11 + i) * 1.8);
    g.stroke();
  }
  return tex(cv, 3, true);
}

export { clamp };
