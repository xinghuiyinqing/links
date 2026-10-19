/* ============================================================================
   snow.js —— 单 draw call 飘雪
   ----------------------------------------------------------------------------
   性能要点（每一条都是为了「CPU 每帧零循环零分配」）：
     · 整片雪只有一个 THREE.Points，一次 draw call；
     · 位置动画 100% 在顶点着色器里：uniform 时间 + 每颗粒固定的 seed/speed/相位；
     · 顶点位置直接写在「视空间」，所以只用 projectionMatrix，连 modelView
       都不用乘 —— 雪永远跟着相机，永远不会「跑出屏幕就没了」；
     · 三档粒子数只是改 drawRange，不重建 buffer、不重新分配；
     · CPU 每帧只写 4 个 uniform。
   三层视差：layer 0 远（小、慢、淡）→ layer 2 近（大、快、带虚边）。
   ========================================================================== */
import * as THREE from 'three';
import { SNOW_VERT, SNOW_FRAG } from './glsl.js';
import { makeRng, lerp } from './util.js';

const BOX = {
  halfX: 30,     // 横向盒子收窄：之前 80 米宽，绝大多数粒子根本不在视锥里
  yMin: -17,
  spanY: 38,
  z0: -70,       // 视空间 z：-70 = 前方 70 米
  z1: 0.5,       // 视空间 z 必须是负数或 0，正数＝相机身后，会被 depth 判死
};

export function createSnow(opts) {
  const max = Math.max(1, opts.max | 0);
  const rnd = makeRng(13579);

  const pos = new Float32Array(max * 3);
  const par = new Float32Array(max * 4);
  const siz = new Float32Array(max);
  const sed = new Float32Array(max);

  /* 前 64 颗专门做「近景大雪花」：穿过镜头、带虚边，这是暴雪感的来源。
     其余按层均匀分配，层内按透视密度分布：越近越密。 */
  const NEAR = Math.min(110, Math.max(16, max >> 6));
  const BOKEH = Math.min(12, Math.max(0, max >> 9));
  for (let i = 0; i < max; i++) {
    if (i < BOKEH) {
      /* 近景失焦散景：镜头前 3~8 米、极大极虚的白斑，缓慢横飘。
         靠着色器里的 layer>2.5 分支走单独路径，不增加 draw call。 */
      pos[i * 3] = (rnd() * 2 - 1) * BOX.halfX;
      pos[i * 3 + 1] = BOX.yMin + rnd() * BOX.spanY;
      pos[i * 3 + 2] = -(3.0 + rnd() * 5.0);
      par[i * 4] = 0.10 + rnd() * 0.16;
      par[i * 4 + 1] = 1.6 + rnd() * 1.6;
      par[i * 4 + 2] = rnd() * Math.PI * 2;
      par[i * 4 + 3] = 3;
      siz[i] = 0.30 + rnd() * 0.42;
      sed[i] = rnd();
      continue;
    }
    if (i < BOKEH + NEAR) {
      /* 近景大雪花：depth 2.2~13 米（视空间 z 取负！），屏幕 8~22px */
      pos[i * 3] = (rnd() * 2 - 1) * BOX.halfX;
      pos[i * 3 + 1] = BOX.yMin + rnd() * BOX.spanY;
      pos[i * 3 + 2] = -lerp(2.2, 13.0, Math.pow(rnd(), 0.55));
      par[i * 4] = 3.0 + rnd() * 3.2;
      par[i * 4 + 1] = 0.9 + rnd() * 1.5;
      par[i * 4 + 2] = rnd() * Math.PI * 2;
      par[i * 4 + 3] = 2;
      siz[i] = 0.115 + rnd() * 0.150;
      sed[i] = 0.62 + rnd() * 0.38;
      continue;
    }
    const layer = i % 3;

    /* depth 直接按「视深」抽，再取负写进 z：
       近中景偏一点、远层平铺，保证每个深度都有粒子落在视锥里。 */
    const nearBias = layer === 2 ? 2.1 : (layer === 1 ? 1.35 : 0.85);
    const depth = lerp(3.5, 70.0, Math.pow(rnd(), nearBias));
    const z = -depth;

    pos[i * 3] = (rnd() * 2 - 1) * BOX.halfX;
    pos[i * 3 + 1] = BOX.yMin + rnd() * BOX.spanY;
    pos[i * 3 + 2] = z;

    /* 速度：远层 0.55，近层 2.4（视差感全靠这个） */
    const spd = layer === 2 ? 1.9 + rnd() * 1.4 : (layer === 1 ? 0.95 + rnd() * 0.55 : 0.45 + rnd() * 0.3);
    const sway = layer === 2 ? 0.55 + rnd() * 0.8 : (layer === 1 ? 0.3 + rnd() * 0.35 : 0.12 + rnd() * 0.18);
    par[i * 4] = spd;
    par[i * 4 + 1] = sway;
    par[i * 4 + 2] = rnd() * Math.PI * 2;
    par[i * 4 + 3] = layer;

    /* 尺寸（世界单位，着色器里按 uHeightK/depth 换算成设备像素） */
    siz[i] = layer === 2 ? 0.046 + rnd() * 0.052
           : (layer === 1 ? 0.024 + rnd() * 0.024 : 0.014 + rnd() * 0.016);
    sed[i] = rnd();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aPar', new THREE.BufferAttribute(par, 4));
  geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(sed, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -40), 400);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uHeightK: { value: 900 },
      uWind: { value: 1.15 },
      uGust: { value: 0 },
      uFall: { value: 1 },
      uBoxX: { value: BOX.halfX },
      uBoxY: { value: BOX.spanY },
      uBoxYMin: { value: BOX.yMin },
      uBoxZ0: { value: BOX.z0 },
      uBoxZ1: { value: BOX.z1 },
      uColor: { value: new THREE.Color(0xfbfdff) },
      uLampColor: { value: new THREE.Color(0xffb257) },
      uLampView: { value: new THREE.Vector3(9999, 9999, 0) },
      uLampCone: { value: 0 },
      uExposure: { value: 1 },
    },
    vertexShader: SNOW_VERT,
    fragmentShader: SNOW_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 18;
  points.name = 'snowfall';

  let activeCount = max;
  geo.setDrawRange(0, max);

  const uniforms = mat.uniforms;

  return {
    object: points,
    get count() { return activeCount; },
    /** 三档计数（远/中/近），给验收用 */
    get layers() {
      const n = activeCount;
      const near = Math.min(n, Math.min(110, Math.max(16, max >> 6)));
      const rest = n - near;
      return {
        near: near,
        mid: Math.floor(rest / 3),
        far: rest - Math.floor(rest / 3),
        total: n,
      };
    },
    get nearCount() { return Math.min(110, Math.max(16, max >> 6)); },
    setCount(n) {
      const v = Math.max(0, Math.min(max, n | 0));
      if (v === activeCount) return;
      activeCount = v;
      geo.setDrawRange(0, v);
      points.visible = v > 0;
    },
    /** 相机竖直 FOV 变了要重新算像素比例 */
    setPixelRatio(heightDevicePx, fovRad) {
      uniforms.uHeightK.value = (heightDevicePx * 0.5) / Math.tan(fovRad * 0.5);
    },
    setExposure(e) { uniforms.uExposure.value = e; },
    setReducedMotion(on) {
      uniforms.uFall.value = on ? 0.22 : 1;
      uniforms.uWind.value = on ? 0.22 : 1.15;
    },
    /** 车头灯在视空间的位置（每帧由 world.update 算好传进来） */
    setLampView(x, y, z, power) {
      uniforms.uLampView.value.set(x, y, z);
      uniforms.uLampCone.value = power;
    },
    /** 每帧：只写这几个 uniform，没有任何分配 */
    update(tSec, gustPhase) {
      uniforms.uTime.value = tSec;
      uniforms.uGust.value = gustPhase;
    },
    dispose() {
      if (points.parent) points.parent.remove(points);
      geo.dispose();
      mat.dispose();
    },
  };
}
