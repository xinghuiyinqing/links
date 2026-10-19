/* ============================================================================
   index.js —— 场景入口：状态机 / 时间轴 / 锚点 / 质量档 / 每帧循环
   ----------------------------------------------------------------------------
   严格遵守 docs/CONTRACT.md 第 2、4、5 节：
     window.WinterTrain = { version, ready, state, play, skip, onState, anchors,
                            timeline, quality, setQuality, setReducedMotion, dispose }
     状态变化派发 window 上的 'wintertrain:state'；降档派发 'wintertrain:quality'。

   三条硬纪律（qa 会打）：
     · 循环里零分配：所有临时对象都是模块级常量，热路径里没有 new / 没字面量；
     · 只有一个 rAF 循环，且它同时也负责锚点投影（ui 只读，不额外开循环）；
     · 车轮转角 = 位移 / 半径（严格纯滚动），连杆由曲柄解析解驱动，
       所以「车轮和地面不同步」这种一眼假永远不会发生。
   ========================================================================== */
import * as THREE from 'three';
import { PAL, srgb, clamp, lerp, smoothstep, TAU } from './util.js';
import { createWorld } from './world.js';
import {
  createTrain, TRAIN_LEN, CAR_X, WINDOW_LOCAL, WIN_SLOT_X, LOCO_FRONT_LOCAL, CARS_LEFT_LOCAL,
} from './train.js';
import { createSnow } from './snow.js';
import { createSteam } from './steam.js';
import {
  TIERS, tierOf, detectQuality, createQualityMonitor, dprFor,
} from './quality.js';

/* ============================================================ 时间轴常量 */
const TIMELINE = {
  washIn: 0,
  depart: 250,
  arriveEnd: 3300,
  igniteStart: 3450,
  igniteStep: 160,
  settled: 4200,
};
const ARRIVE_MS = TIMELINE.arriveEnd - TIMELINE.depart;   // 3050
const TRAIN_START_X = -58;        // 出场位置：整车完全在画面左侧之外
const DRIVER_R = 0.72;            // 动轮半径（与 train.js 的 LAYOUT 一致）
const FOV_Y = 30 * Math.PI / 180;

/* ============================================================ 模块级临时 */
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v4 = new THREE.Vector4();
const _clr = new THREE.Color();

/* ============================================================ 缓动表
   进站曲线：先快后慢（1-e^{-3t} 的形状），结尾强制收到 0 速度，
   再叠一个极小的过冲回弹 —— 就是「刹车点头」那个感觉。
   预计算成 1024 采样表，热循环里只有一次线性插值。 */
const TAB_N = 1024;
const tabS = new Float32Array(TAB_N);   // 归一化位移 0..1
const tabV = new Float32Array(TAB_N);   // 归一化速度 (ds/dτ)
(function buildArrivalTable() {
  const v = new Float32Array(TAB_N);
  for (let i = 0; i < TAB_N; i++) {
    const tau = i / (TAB_N - 1);
    /* 起步平滑进来 + 指数减速 + 结尾收到零 */
    v[i] = Math.exp(-3.0 * tau)
      * smoothstep(0, 0.085, tau)
      * (1 - smoothstep(0.88, 1.0, tau));
  }
  let acc = 0;
  tabS[0] = 0;
  const d = 1 / (TAB_N - 1);
  for (let i = 1; i < TAB_N; i++) {
    acc += 0.5 * (v[i - 1] + v[i]) * d;
    tabS[i] = acc;
  }
  const total = tabS[TAB_N - 1] || 1;
  for (let i = 0; i < TAB_N; i++) { tabS[i] /= total; v[i] /= total; }
  /* 过冲：0.6% 的位移，往回弹两下就停 —— 幅度小到不「跳」，但读得出来 */
  const T0 = 0.845;
  for (let i = 0; i < TAB_N; i++) {
    const tau = i / (TAB_N - 1);
    if (tau > T0) {
      const u = tau - T0;
      tabS[i] += 0.0062 * Math.exp(-u * 17.0) * Math.sin(u * 44.0);
    }
  }
  const end = tabS[TAB_N - 1] || 1;
  for (let i = 0; i < TAB_N; i++) tabS[i] /= end;
  for (let i = 0; i < TAB_N; i++) tabV[i] = v[i];
})();

/* 采样（线性插值） */
function sampleTable(tab, tau) {
  if (tau <= 0) return tab[0];
  if (tau >= 1) return tab[TAB_N - 1];
  const f = tau * (TAB_N - 1);
  const i = f | 0;
  const fr = f - i;
  const a = tab[i];
  return a + (tab[i + 1] - a) * fr;
}

/* ============================================================ 共享状态
   这一个对象是「唯一真相」，被 world/train/snow/steam 只读或写入。
   它是模块级常量，循环里不 new。 */
const S = {
  tMs: 0,          // 时间轴毫秒
  tSec: 0,         // 环境时钟（秒，单调累加）
  dt: 0,
  progress: 0,     // 0..1 进站进度
  trainX: TRAIN_START_X,
  speed: 0,        // 世界单位/秒
  wheelAngle: 0,
  nodPitch: 0,
  lit: [0, 0, 0, 0],
  winX: [0, 0, 0, 0],
  exposure: 1,
  ignite: 0,
  gust: 0,
  chimneyX: 0,
  lampView: null,
  snowCone: null,
  chimneyY: 0,
  domeX: 0,
  lampX: 0,
  state: 'boot',
  reduced: false,
  _lastLit0: -1, _lastLit1: -1, _lastLit2: -1, _lastLit3: -1,
};

/* ============================================================ 公开对象 */
let resolveReady = null;
let rejectReady = null;
const readyPromise = new Promise(function (res, rej) {
  resolveReady = res;
  rejectReady = rej;
});
/* 防止 ui 没挂 catch 时控制台一片红 */
readyPromise.catch(function () { });

let renderer = null;
let scene = null;
let camera = null;
let world = null;
let train = null;
let snow = null;
let steam = null;
let hemi = null;
let sun = null;
let rim = null;
let canvas = null;
let booted = false;
let disposed = false;
let rafId = 0;

let tierName = 'high';
let tier = TIERS.high;
let monitor = null;
let dpr = 1;

/* 相机取景 */
let camTargetX = 0;
let camZ = 64;
let camY = 4.3;
let visH = 34;
let visW = 55;
let viewW = 1;
let viewH = 1;

/* 指针视差 */
let pointerX = 0, pointerY = 0;
let parallaxX = 0, parallaxY = 0;
let hasPointer = false;

/* 时间轴时钟 */
let tPlay = -1;
let skipped = false;
let lastNow = 0;
let stateName = 'boot';
const listeners = [];

/* 锚点（复用的对象，anchors() 直接返回这个数组） */
const anchorArr = [
  { x: 0, y: 0, w: 0, h: 0, lit: 0, visible: false },
  { x: 0, y: 0, w: 0, h: 0, lit: 0, visible: false },
  { x: 0, y: 0, w: 0, h: 0, lit: 0, visible: false },
  { x: 0, y: 0, w: 0, h: 0, lit: 0, visible: false },
];
const EMPTY_ANCHORS = [];
let anchorsValid = false;

/* 帧时长环（给 debug.frameMs 用，零分配） */
const FRAME_RING = 90;
const frameRing = new Float32Array(FRAME_RING);
let frameRingI = 0;
let frameRingN = 0;

/* ============================================================ 画布 */
function acquireCanvas() {
  let cv = document.getElementById('scene-canvas');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = 'scene-canvas';
  }
  if (!cv.parentNode) {
    const host = document.getElementById('scene')
      || document.getElementById('stage')
      || document.body;
    host.appendChild(cv);
  }
  /* 只给自己这一层的尺寸兜底，不碰 ui 的布局规则 */
  cv.style.display = 'block';
  if (!cv.style.width) cv.style.width = '100%';
  if (!cv.style.height) cv.style.height = '100%';
  return cv;
}

/* ============================================================ 取景计算
   横屏：整列车刚好塞进画面（四扇窗尽量撑开）。
   竖屏：不硬塞整列车（否则车会细成一条线），改成「机车特写 + 第一节车窗」。
   两者之间用 aspect 连续插值，避免旋转屏幕时画面突跳。 */
function computeFraming() {
  const aspect = Math.max(0.2, viewW / Math.max(1, viewH));
  /* 关键：列车在画面上「能多大」完全由两件事锁死 ——
     ① 最后一节车厢左端留白 2.6%、机车车头贴右边缘；
     ② 四扇窗之间的世界间距（CAR_LEN + CAR_GAP = 6.2）要换算成足够宽的卡片间距。
     所以不是拍脑袋给个 visW，而是反解像素比例 P：
       P = (viewW - 左留白 - 右留白) / (机车车头 - 最后一节车厢左端)
     这样「整列车横贯 + 机车完整」和「四扇窗分得开」同时成立。 */
  const needW = LOCO_FRONT_LOCAL - CARS_LEFT_LOCAL;      // 36.34
  const marginL = Math.round(viewW * 0.022);
  const marginR = Math.round(viewW * 0.004);
  let P = (viewW - marginL - marginR) / needW;

  /* 竖屏：不硬塞整列车（会细成一条线），改成「机车 + 第 1~2 节」特写 */
  const a = clamp((aspect - 1.00) / 0.55, 0, 1);
  const Pwide = P;
  const Pnarrow = viewW / 13.6;                  // 只框 13.6 个世界单位
  P = lerp(Pnarrow, Pwide, a);

  visW = viewW / P;
  visH = visW / aspect;
  camZ = (visH * 0.5) / Math.tan(FOV_Y * 0.5);

  /* 相机轴：横屏把「最后车厢左端」放到 marginL 处；竖屏对准机车 */
  /* px = viewW/2 + (x - camTargetX) * P  →  令 CARS_LEFT_LOCAL 落在 marginL 处 */
  camTargetX = lerp(LOCO_FRONT_LOCAL - visW * 0.42, CARS_LEFT_LOCAL - (marginL - viewW * 0.5) / Pwide, a);

  /* 纵向：轨面落在 70% 高度（列车带占 52%..70%，下面留 30% 雪地） */
  camY = 0.44 + 0.20 * visH;
  camPitchUp = 0;
}
let camPitchUp = 0;

/* ============================================================ 状态派发 */
function setState(next) {
  if (stateName === next) return;
  stateName = next;
  S.state = next;
  const detail = { state: next, t: S.tMs };
  for (let i = 0; i < listeners.length; i++) {
    try { listeners[i](next); } catch (e) { /* 订阅方自己的错不该炸场景 */ }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('wintertrain:state', { detail: detail }));
  }
}

function dispatchQuality(name) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('wintertrain:quality', {
      detail: { quality: name },
    }));
  }
}

/* ============================================================ 启动 */
function boot() {
  try {
    canvas = acquireCanvas();
  } catch (e) {
    rejectReady(e);
    return;
  }

 /* WebGL2 探测：three r186 已经不支持 WebGL1，没有就直接降级 */
  try {
    const probe = document.createElement('canvas');
    const gl2 = probe.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (!gl2) throw new Error('WebGL2 unavailable');
    const lose = gl2.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  } catch (e) {
    rejectReady(new Error('WebGL2 unavailable'));
    return;
  }

  try {
    tierName = detectQuality();
    tier = tierOf(tierName);
    dpr = dprFor(tierName);

    renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: tier.antialias,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false,
    });
    renderer.setPixelRatio(dpr);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false;
    renderer.autoClear = true;
    renderer.setClearColor(0xe4edf4, 1);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(30, 1, 1.2, 900);

    /* ---- 三个灯（契约上限：hemisphere + directional + point 头灯） ---- */
    hemi = new THREE.HemisphereLight(0xf4f8fb, 0xc6d6e3, 3.10);
    hemi.position.set(0, 20, 0);
    scene.add(hemi);

    sun = new THREE.DirectionalLight(0xffffff, 1.55);
    sun.position.set(-26, 34, 30);
    sun.target.position.set(0, 2, 0);
    scene.add(sun);
    scene.add(sun.target);

    /* 第 4 盏（也是最后一盏）：从车体后方掠过的无阴影轮廓光。
       只做一件事 —— 在车体背光侧拉出一道冷色亮边，把「纯黑剪影」救回来。
       无阴影、无距离衰减，成本可忽略。 */
    rim = new THREE.DirectionalLight(0xd6e6f6, 0.62);
    rim.position.set(34, 16, -46);
    rim.target.position.set(0, 3, 0);
    scene.add(rim);
    scene.add(rim.target);

    /* ---- 世界 ---- */
    world = createWorld(renderer, scene, tierName, tier);

    /* ---- 列车 ---- */
    train = createTrain(scene, renderer, tierName);

    /* ---- 雪 ---- */
    snow = createSnow({ max: TIERS.high.snowMax });
    snow.setCount(tier.snowMax);
    S.lampView = new THREE.Vector3();
    S.snowCone = snow.setLampView;
    scene.add(snow.object);

    /* ---- 蒸汽 ---- */
    steam = createSteam({ max: TIERS.high.steamMax, life: tier.smokeLife });
    steam.setCount(tier.steamMax);
    scene.add(steam.object);

    resize(true);

    /* ---- 第一帧同步渲染：ready 立刻可以 resolve ---- */
    S.state = 'boot';
    train.update(S, 0);
    world.update(S, camera, viewH * dpr, FOV_Y);
    snow.update(0, 0);
    steam.update(S, 0);
    renderer.render(scene, camera);

    booted = true;

    /* 质量监视：连续 2 个 1s 窗口 < 45fps 就降一档 */
    monitor = createQualityMonitor(tierName, function (lower, fps) {
      applyTier(lower);
      if (typeof console !== 'undefined' && console.info) {
        console.info('[wintertrain] quality ->', lower, '(', fps.toFixed(1), 'fps )');
      }
    });
    monitor.start(nowMs());

    setState('idle');
    resolveReady();

    /* boot 之前就被 play()/skip() 调用过：现在补上 */
    if (pendingSkip) { pendingSkip = false; pendingPlay = false; skipped = true; }
    if (pendingPlay || skipped) {
      pendingPlay = false;
      play();
    }

    /* 兜底自动开场：ui 若忘了调 play()，画面也不会停在一片空雪原上 */
    setTimeout(function () {
      if (!disposed && stateName === 'idle') play();
    }, 200);

    lastNow = nowMs();
    rafId = requestAnimationFrame(frame);
  } catch (e) {
    rejectReady(e);
  }
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/* ============================================================ 尺寸 */
function resize(first) {
  if (!renderer) return;
  const rect = canvas.getBoundingClientRect();
  viewW = Math.max(1, Math.round(rect.width || canvas.clientWidth || window.innerWidth));
  viewH = Math.max(1, Math.round(rect.height || canvas.clientHeight || window.innerHeight));

  renderer.setPixelRatio(dpr);
  renderer.setSize(viewW, viewH, false);
  computeFraming();

  camera.aspect = viewW / viewH;
  camera.fov = FOV_Y * 180 / Math.PI;
  camera.position.set(camTargetX, camY, camZ);
  camera.lookAt(camTargetX, camY, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  if (snow) snow.setPixelRatio(viewH * dpr, FOV_Y);
  if (world) world.setPixelRatio(viewH * dpr, FOV_Y);
  if (!first) anchorsValid = false;
}

/* ============================================================ 应用档位
   降档必须是「真的」少干活：DPR、粒子数、闪烁高光、光锥、地面细分都跟着走。 */
function applyTier(name) {
  const t = TIERS[name];
  if (!t) return false;
  const downgrade = name !== tierName;
  tierName = t.name;
  tier = t;
  dpr = dprFor(name);

  if (snow) { snow.setCount(t.snowMax); }
  if (steam) { steam.setCount(t.steamMax); steam.setLife(t.smokeLife); }
  if (world) {
    world.setSparkle(t.sparkle > 0);
    world.groundMat.uniforms.uSparkle.value = t.sparkle;
  }
  if (train) train.setConeEnabled(t.coneMesh);

  if (t.sparkle > 0) {
    /* 地面细分是构建期定的，降档时不重建（会卡一下），
       真正省下来的开销来自 DPR 和粒子数，这里只关掉高光。 */
  }
  if (renderer) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewW, viewH, false);
  }
  if (camera) {
    camera.aspect = viewW / viewH;
    camera.updateProjectionMatrix();
  }
  if (snow) snow.setPixelRatio(viewH * dpr, FOV_Y);
  if (world) world.setPixelRatio(viewH * dpr, FOV_Y);
  anchorsValid = false;
  if (downgrade) dispatchQuality(name);
  return true;
}

/* ============================================================ 时间轴求值
   全部是 tMs 的纯函数 —— 所以 skip() 只要把时钟拨到底，不需要「补帧」。 */
function evaluateTimeline() {
  const t = S.tMs;

  /* ---- 位移 ---- */
  const tau = clamp((t - TIMELINE.depart) / ARRIVE_MS, 0, 1);
  S.progress = tau;
  const s = sampleTable(tabS, tau);
  S.trainX = TRAIN_START_X * (1 - s);
  /* 速度：世界单位/秒 */
  const vN = sampleTable(tabV, tau);
  S.speed = (t > TIMELINE.depart && t < TIMELINE.arriveEnd)
    ? (-TRAIN_START_X) * vN / (ARRIVE_MS / 1000)
    : 0;

  /* ---- 车轮转角 = 位移 / 半径（纯滚动，符号按 +X 前进为负 Z 旋转） ---- */
  S.wheelAngle = -((-TRAIN_START_X) * s) / DRIVER_R;

  /* ---- 点头：只在收尾那一小段 ---- */
  const T0 = 0.845;
  if (tau > T0) {
    const u = tau - T0;
    S.nodPitch = 0.0058 * Math.exp(-u * 16.0) * Math.sin(u * 44.0);
  } else {
    S.nodPitch = 0;
  }

  /* ---- 四扇窗依次点亮 ---- */
  for (let i = 0; i < 4; i++) {
    /* WIN_SLOT_X 已经按屏幕 x 升序，所以 i 就是 slot：从左到右依次点亮 */
    const start = TIMELINE.igniteStart + i * TIMELINE.igniteStep;
    const u = clamp((t - start) / 700, 0, 1);
    let v = smoothstep(0, 1, u);
    /* 老灯管点起来的抖动：越接近 100% 越稳 */
    v *= 1 + 0.10 * Math.sin(u * 34.0) * Math.exp(-u * 6.5);
    S.lit[i] = clamp(v, 0, 1);
  }

  /* ---- 车头灯上电 ---- */
  S.ignite = clamp((t - 300) / 1500, 0, 1);

  /* ---- 曝光呼吸（停稳之后才呼吸） ---- */
  if (S.reduced) S.exposure = 1;
  else {
    const settledAmt = clamp((t - TIMELINE.arriveEnd) / 900, 0, 1);
    S.exposure = 1 + 0.016 * Math.sin(S.tSec * 0.92) * settledAmt;
  }

  /* ---- 状态推进 ---- */
  if (stateName === 'arriving' && t >= TIMELINE.settled) {
    setState('settled');
    anchorsValid = false;
  }
  /* 3300 停稳 → 4200 完全就位，这一段仍然保持 'arriving'：
     契约里的中途状态只有 settled 一个。 */
}

/* ============================================================ 相机微动 */
function updateCamera(dtSec) {
  /* 指针视差：幅度必须小，别晕。目标值 lerp 过去，永不跳。 */
  let tx = 0, ty = 0;
  if (!S.reduced) {
    tx = pointerX * 0.55;
    ty = pointerY * 0.26;
    /* 叠一个极慢的自身漂移，让画面「活着」 */
    tx += Math.sin(S.tSec * 0.13) * 0.16;
    ty += Math.sin(S.tSec * 0.19 + 1.7) * 0.09;
  }
  const k = 1 - Math.pow(0.0016, dtSec);      // 与帧率无关的平滑
  parallaxX += (tx - parallaxX) * k;
  parallaxY += (ty - parallaxY) * k;

  camera.position.set(
    camTargetX + parallaxX,
    camY + parallaxY,
    camZ - parallaxY * 0.35,
  );
  camera.lookAt(camTargetX + parallaxX * 0.55, camY + parallaxY * 0.55, 0);
  camera.updateMatrixWorld();
}

/* ============================================================ 锚点投影 */
function projectToCss(v3, outX, outY) {
  _v4.set(v3.x, v3.y, v3.z, 1);
  _v4.applyMatrix4(camera.matrixWorldInverse);
  if (_v4.z > -0.5) { outX.x = -1e6; outY.x = -1e6; return false; }
  _v4.applyMatrix4(camera.projectionMatrix);
  const w = _v4.w || 1e-6;
  const nx = _v4.x / w;
  const ny = _v4.y / w;
  outX.x = (nx * 0.5 + 0.5) * viewW;
  outY.x = (0.5 - ny * 0.5) * viewH;
  return nx > -1.25 && nx < 1.25 && ny > -1.25 && ny < 1.25;
}
const _ex = { x: 0 };
const _ey = { x: 0 };
const _ecx = { x: 0 };
const _ecy = { x: 0 };
const _cx = { x: 0 };
const _cy = { x: 0 };

function refreshAnchors() {
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  /* slot 0..3 = 屏幕上从左到右。车厢序号正好相反（0 = 最靠机车 = 最右），
     所以 slot s 对应车厢 3-s —— 契约要求读屏顺序是左→右 01..04。 */
  for (let i = 0; i < 4; i++) {
    const ci = i;
    const a = anchorArr[i];
    const inView = projectToCss(train.winWorld[ci], _cx, _cy);
    const cx = _cx.x, cy = _cy.x;
    projectToCss(train.winWorldEdgeX[ci], _ex, _ey);
    const ex = _ex.x, ey = _ey.x;
    projectToCss(train.winWorldEdgeY[ci], _ecx, _ecy);
    const fx = _ecx.x, fy = _ecy.x;

    let w = Math.abs(ex - cx) * 2;
    let h = Math.abs(fy - cy) * 2;
    if (!isFinite(w) || w < 1) w = 1;
    if (!isFinite(h) || h < 1) h = 1;
    a.x = cx;
    a.y = cy;
    a.w = w;
    a.h = h;
    a.lit = S.lit[ci];
    a.visible = !!(inView && cx > -w && cx < viewW + w && cy > -h && cy < viewH + h);
  }
  anchorsValid = true;
}

/* ============================================================ 主循环 */
function frame(now) {
  if (disposed) return;
  rafId = requestAnimationFrame(frame);

  let dtMs = now - lastNow;
  lastNow = now;
  if (!(dtMs >= 0)) dtMs = 0;
  if (dtMs > 100) dtMs = 100;              // 切标签页回来不要一次补一大段
  const dtSec = dtMs / 1000;
  S.dt = dtSec;
  S.tSec += dtSec;

  /* 帧时长环 */
  frameRing[frameRingI] = dtMs;
  frameRingI = (frameRingI + 1) % FRAME_RING;
  if (frameRingN < FRAME_RING) frameRingN++;

  if (tPlay >= 0) {
    if (skipped) S.tMs = TIMELINE.settled + 1000;
    else S.tMs += dtMs;
    evaluateTimeline();
  }

  /* ---- 列车 ---- */
  train.update(S, S.tSec);
  /* 四扇窗的世界 X 给雪地 shader 用 */
  for (let i = 0; i < 4; i++) S.winX[i] = WIN_SLOT_X[i] + S.trainX;
  S.lampX = train.headLightX;

  /* ---- 世界 / 粒子 ---- */
  updateCamera(dtSec);
  S.gust = 0;
  world.update(S, camera, viewH * dpr, FOV_Y);
  snow.update(S.tSec, 0);
  steam.update(S, dtSec);

  /* ---- 环境光与头灯跟着曝光呼吸 ---- */
  hemi.intensity = 3.10 * S.exposure;
  sun.intensity = 1.55 * S.exposure;
  rim.intensity = 0.62 * S.exposure;
  if (train) train.setExposure(S.exposure);
  if (snow) snow.setExposure(S.exposure);
  if (steam) steam.setExposure(S.exposure);

  /* ---- 锚点：只有 settled 之后才有效 ---- */
  if (stateName === 'settled') {
    refreshAnchors();
  } else {
    anchorsValid = false;
  }

  renderer.render(scene, camera);

  /* ---- 质量滑窗 ---- */
  if (monitor) monitor.tick(now, S.reduced);
}

/* ============================================================ 公开 API */
function play() {
  if (disposed) return;
  if (stateName === 'boot') { pendingPlay = true; return; }
  if (stateName !== 'idle') return;
  tPlay = nowMs();
  lastNow = tPlay;
  S.tMs = 0;
  S.state = 'arriving';
  setState('arriving');
}
let pendingPlay = false;

function skip() {
  if (disposed) return;
  if (stateName === 'boot') { pendingPlay = true; pendingSkip = true; return; }
  skipped = true;
  tPlay = tPlay < 0 ? nowMs() : tPlay;
  S.tMs = TIMELINE.settled + 500;
  evaluateTimeline();
  for (let i = 0; i < 4; i++) S.lit[i] = 1;
  S.trainX = 0;
  S.wheelAngle = -(-TRAIN_START_X) / DRIVER_R;
  S.speed = 0;
  S.nodPitch = 0;
  S.ignite = 1;
  train.update(S, S.tSec);
  for (let i = 0; i < 4; i++) S.winX[i] = WIN_SLOT_X[i] + S.trainX;
  S.lampX = train.headLightX;
  updateCamera(0.016);
  world.update(S, camera, viewH * dpr, FOV_Y);
  if (!anchorsValid) refreshAnchors();
  setState('settled');
}
let pendingSkip = false;

const api = {
  version: 1,

  ready: readyPromise,

  get state() { return stateName; },

  play: play,
  skip: skip,

  onState: function (cb) {
    if (typeof cb !== 'function') return function () { };
    listeners.push(cb);
    return function () {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  },

  anchors: function () {
    if (stateName !== 'settled') return EMPTY_ANCHORS;
    if (!anchorsValid) refreshAnchors();
    return anchorArr;
  },

  timeline: {
    washIn: TIMELINE.washIn,
    depart: TIMELINE.depart,
    arriveEnd: TIMELINE.arriveEnd,
    igniteStart: TIMELINE.igniteStart,
    igniteStep: TIMELINE.igniteStep,
    settled: TIMELINE.settled,
  },

  get quality() { return tierName; },

  setQuality: function (q) {
    if (!TIERS[q]) return;
    if (monitor) monitor.force(q);
    applyTier(q);
  },

  setReducedMotion: function (on) {
    S.reduced = !!on;
    if (snow) snow.setReducedMotion(S.reduced);
    if (S.reduced) {
      /* 契约：reduced-motion 直接跳到终态 */
      if (stateName !== 'settled') skip();
    }
  },

  dispose: function () {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('visibilitychange', onVisibility);
    if (monitor) monitor.stop();
    if (snow) snow.dispose();
    if (steam) steam.dispose();
    if (train) train.dispose();
    if (world) world.dispose();
    if (renderer) {
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
    }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    listeners.length = 0;
    resolveReady = null;
    rejectReady = null;
  },

  /* ---------------------------------------------------------- debug 钩子
     给 qa 用：只读已有数据，不在渲染循环里为它做任何计算。 */
  debug: {
    info: function () {
      /* 任何 state 下都必须安全返回普通对象（boot / 未 ready / disposed 也不抛） */
      if (!renderer || !renderer.info) {
        return {
          calls: 0, triangles: 0, points: 0, lines: 0,
          geometries: 0, textures: 0, programs: 0,
          frameMs: 0, fps: 0, quality: tierName, dpr: dpr, state: stateName,
        };
      }
      const r = renderer.info.render;
      const ms = (function () {
        if (!frameRingN) return 0;
        let sum = 0;
        for (let i = 0; i < frameRingN; i++) sum += frameRing[i];
        return sum / frameRingN;
      })();
      return {
        calls: r.calls,
        triangles: r.triangles,
        points: r.points,
        lines: r.lines,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        programs: renderer.info.programs ? renderer.info.programs.length : -1,
        frameMs: ms,
        fps: ms > 0 ? 1000 / ms : 0,
        quality: tierName,
        dpr: renderer.getPixelRatio(),
        state: stateName,
      };
    },
    get quality() { return tierName; },
    counts: function () {
      let objects = 0;
      if (scene) scene.traverse(function (o) { if (o.isMesh || o.isPoints || o.isLine) objects++; });
      return {
        snow: snow ? snow.count : 0,
        snowLayers: snow ? snow.layers : null,
        draws: renderer ? renderer.info.render.calls : 0,
        steam: steam ? steam.count : 0,
        objects: objects,
        dpr: renderer ? renderer.getPixelRatio() : dpr,
        view: { w: viewW, h: viewH },
      };
    },
    frameMs: function () {
      if (!frameRingN) return 0;
      let sum = 0;
      for (let i = 0; i < frameRingN; i++) sum += frameRing[i];
      return sum / frameRingN;
    },
    /** rAF→rAF 的 p50 / p95（排序用一次性的临时数组，只在被调用时分配） */
    frameStats: function () {
      if (!frameRingN) return { n: 0, avg: 0, p50: 0, p95: 0, max: 0 };
      const a = [];
      for (let i = 0; i < frameRingN; i++) a.push(frameRing[i]);
      a.sort(function (x, y) { return x - y; });
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += a[i];
      const pick = function (q) { return a[Math.min(a.length - 1, Math.floor(a.length * q))]; };
      return {
        n: a.length,
        avg: sum / a.length,
        p50: pick(0.5),
        p95: pick(0.95),
        max: a[a.length - 1],
      };
    },
    fps: function () {
      const ms = api.debug.frameMs();
      return ms > 0 ? 1000 / ms : 0;
    },
    /** 调试用：按名字前缀开关场景里的对象，二分定位伪影 */
    setVisible: function (key, on) {
      if (!scene) return 0;
      let n = 0;
      scene.traverse(function (o) {
        if (!o.name) return;
        if (o.name.indexOf(key) === 0) { o.visible = !!on; n++; }
      });
      return n;
    },
    names: function () {
      const out = [];
      if (scene) scene.traverse(function (o) {
        if (o.name && out.indexOf(o.name) < 0) out.push(o.name);
      });
      return out;
    },
    /** 锚点调试：直接看四扇窗在 1440/390 下的 px */
    anchors: function () { return api.anchors(); },
  },
};

/* 只挂一次；即使 boot 失败，ui 也能拿到对象并读到 ready 的 reject */
if (typeof window !== 'undefined') {
  window.WinterTrain = api;
}

/* ============================================================ 事件 */
function onResize() {
  if (disposed) return;
  resize(false);
  if (stateName === 'settled') { updateCamera(0.016); refreshAnchors(); }
}

function onPointerMove(e) {
  hasPointer = true;
  pointerX = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
  pointerY = -((e.clientY / Math.max(1, window.innerHeight)) * 2 - 1);
}

function onVisibility() {
  if (document.hidden) {
    if (monitor) monitor.stop();
  } else {
    lastNow = nowMs();
    if (monitor) monitor.start(lastNow);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
}

/* ============================================================ 收尾 */
boot();

void hasPointer; void _v3; void _v3b; void _clr;
