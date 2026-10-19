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
  halfX: 40,
  yMin: -16,
  spanY: 38,
  z0: -72,       // 最远
  z1: 3.5,       // 最近（相机身后一点）
};

export function createSnow(opts) {
  const max = Math.max(1, opts.max | 0);
  const rnd = makeRng(13579);

  const pos = new Float32Array(max * 3);
  const par = new Float32Array(max * 4);
  const siz = new Float32Array(max);
  const sed = new Float32Array(max);

  /* 按层均匀分配，层内按透视密度分布：越近越密 */
  for (let i = 0; i < max; i++) {
    const layer = i % 3;

    /* z：近层靠前、远层靠后，用指数偏置让近处看着更密 */
    const bias = layer === 2 ? 2.9 : (layer === 1 ? 1.75 : 1.0);
    const u = 1 - Math.pow(rnd(), bias);
    const z = lerp(BOX.z0, BOX.z1, u);

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
    siz[i] = layer === 2 ? 0.030 + rnd() * 0.022 : (layer === 1 ? 0.014 + rnd() * 0.010 : 0.008 + rnd() * 0.006);
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
      uColor: { value: new THREE.Color(0xffffff) },
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
