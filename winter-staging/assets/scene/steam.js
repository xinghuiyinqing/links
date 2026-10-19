/* ============================================================================
   steam.js —— 单 draw call 蒸汽（实例化 billboard）
   ----------------------------------------------------------------------------
   为什么能只用一个 draw call：
     一整块 InstancedBufferGeometry：4 顶点 quad + N 个实例。
     每个实例只带 3 组属性（出生点 / 出生时间+相位+初速 / 尺寸），
     膨胀、上升、被风拉走、变淡、被车头灯染暖，全部在顶点/片元着色器里按
     age 算出来。CPU 只在「喷一下」的时候写 5 个数，其余什么都不做。

   喷射节奏（这是让它看起来像蒸汽机而不是烟雾机的关键）：
     由动轮转角驱动 —— 每转 π/2 喷一次，也就是一圈四拍。
     因为转角本身就等于位移/半径（见 index.js 的时间轴），
     所以车慢下来汽就慢下来，停稳后只剩余汽，物理上对得上。
   ========================================================================== */
import * as THREE from 'three';
import { STEAM_VERT, STEAM_FRAG } from './glsl.js';
import { makeRng } from './util.js';
import { makePuffMap } from './textures.js';

export function createSteam(opts) {
  const max = Math.max(4, opts.max | 0);
  const life = opts.life || 3.4;
  const rnd = makeRng(24680);

  const geo = new THREE.InstancedBufferGeometry();
  /* 一个 quad：position.xy 是 -0.5..0.5 的角点，z 不用 */
  const quad = new Float32Array([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(quad, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  const origin = new Float32Array(max * 3);
  const rand = new Float32Array(max * 3);   // x=birth, y=phase, z=初速倍率
  const scale = new Float32Array(max);

  /* 全部先写成「已过期」，第一帧不会有 500 个烟团从原点炸出来 */
  for (let i = 0; i < max; i++) rand[i * 3] = -9999;

  const aOrigin = new THREE.InstancedBufferAttribute(origin, 3);
  const aRand = new THREE.InstancedBufferAttribute(rand, 3);
  const aScale = new THREE.InstancedBufferAttribute(scale, 1);
  aOrigin.setUsage(THREE.DynamicDrawUsage);
  aRand.setUsage(THREE.DynamicDrawUsage);
  aScale.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aOrigin', aOrigin);
  geo.setAttribute('aRand', aRand);
  geo.setAttribute('aScale', aScale);
  geo.instanceCount = max;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 6, 0), 220);

  const puff = makePuffMap(128);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWind: { value: 0.62 },
      uLampPos: { value: new THREE.Vector2(0, 3) },
      uLampColor: { value: new THREE.Color(0xffb257) },
      uLampPower: { value: 0.6 },
      uLife: { value: life },
      uPixelScale: { value: 1 },
      uTex: { value: puff },
      uSteamColor: { value: new THREE.Color(0xeef4f9) },
      uExposure: { value: 1 },
    },
    vertexShader: STEAM_VERT,
    fragmentShader: STEAM_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 16;
  mesh.name = 'steam';

  const U = mat.uniforms;

  let activeMax = max;
  geo.instanceCount = max;
  let head = 0;
  let dirty = false;
  let lastChuff = -1;
  let residTimer = 0;
  let whistleDone = false;
  let emittedTotal = 0;

  function emit(x, y, tSec, speedMul, scaleMul) {
    const n = activeMax;
    if (n <= 0) return;
    if (head >= n) head = 0;
    const o = head * 3;
    origin[o] = x;
    origin[o + 1] = y;
    origin[o + 2] = (rnd() - 0.5) * 0.14;
    rand[o] = tSec;
    rand[o + 1] = rnd();
    rand[o + 2] = speedMul;
    scale[head] = scaleMul;
    head = (head + 1) % n;
    dirty = true;
    emittedTotal++;
  }

  const CHUFF = Math.PI * 0.5;   // 一圈四拍

  /**
   * @param {object} S 共享状态：wheelAngle / speed / wheelRadius / chimneyX,Y
   * @param {number} dt 秒
   */
  function update(S, dt) {
    const tSec = S.tSec;
    U.uTime.value = tSec;
    U.uLampPos.value.set(S.lampX, 2.94);
    U.uLampPower.value = 0.45 + 0.55 * S.exposure;

    const cx = S.chimneyX;
    const cy = S.chimneyY;
    const speed = S.speed;                 // 世界单位/秒

    /* ---- 四拍喷汽：由动轮转角直接推出来 ---- */
    const idx = Math.floor(S.wheelAngle / CHUFF);
    if (idx !== lastChuff) {
      let bursts = idx - lastChuff;
      if (lastChuff < 0 || bursts < 0) bursts = 1;
      if (bursts > 3) bursts = 3;          // 掉帧时不要一次性炸一堆
      lastChuff = idx;
      /* 速度越快每次喷得越多（到速度上限就饱和） */
      const per = speed > 9 ? 2 : 1;
      for (let b = 0; b < bursts; b++) {
        for (let k = 0; k < per; k++) {
          emit(
            cx + (rnd() - 0.5) * 0.10,
            cy + rnd() * 0.10,
            tSec,
            0.55 + speed * 0.035 + rnd() * 0.25,
            0.55 + rnd() * 0.30,
          );
        }
      }
    }

    /* ---- 汽笛：进站那一刻拉一下（t≈250ms，一次性的） ---- */
    if (!whistleDone && S.tMs >= 230) {
      whistleDone = true;
      for (let k = 0; k < 7; k++) {
        emit(cx + (rnd() - 0.5) * 0.2, cy + 0.35 + rnd() * 0.2, tSec, 0.9 + rnd() * 0.5, 0.55 + rnd() * 0.35);
      }
    }

    /* ---- 余汽：停稳之后烟囱还慢慢冒，安全阀也漏一点 ---- */
    const stopped = speed < 0.9;
    residTimer += dt;
    const residPeriod = stopped ? 0.42 : 1.6;
    if (residTimer >= residPeriod) {
      residTimer = 0;
      emit(cx + (rnd() - 0.5) * 0.08, cy + rnd() * 0.06, tSec, 0.30 + rnd() * 0.18, 0.42 + rnd() * 0.22);
      if (stopped && rnd() > 0.55) {
        /* 汽包上的安全阀：细长的一缕白汽 */
        emit(S.domeX, 3.62, tSec, 0.85 + rnd() * 0.3, 0.20 + rnd() * 0.12);
      }
    }

    if (dirty) {
      aOrigin.needsUpdate = true;
      aRand.needsUpdate = true;
      aScale.needsUpdate = true;
      dirty = false;
    }
  }

  return {
    object: mesh,
    get count() { return activeMax; },
    get emitted() { return emittedTotal; },
    setCount(n) {
      const v = Math.max(0, Math.min(max, n | 0));
      activeMax = v;
      geo.instanceCount = v;
      mesh.visible = v > 0;
      if (head >= v) head = 0;
    },
    setLife(l) { U.uLife.value = l; },
    setExposure(e) { U.uExposure.value = e; },
    update,
    dispose() {
      if (mesh.parent) mesh.parent.remove(mesh);
      puff.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
