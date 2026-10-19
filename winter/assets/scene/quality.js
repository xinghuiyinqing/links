/* ============================================================================
   quality.js —— 档位判定 + 自适应降档
   ----------------------------------------------------------------------------
   两段式：
     1. 启动时一次性判定（hardwareConcurrency / devicePixelRatio / 是否移动 /
        WebGL2 上限），偏保守 —— 宁可先低一档，也别让首屏卡。
     2. 运行期 1s 滑窗 FPS 采样，连续 2 个窗口 < 45fps 降一档，并且是**真的**
        减粒子数、减 DPR、关掉闪烁高光和头灯光锥，不是只改个变量。

   降档只降不升：升档会来回抖，那个抖动比一直低一档难受得多。
   ========================================================================== */
import { clamp } from './util.js';

/* -------------------------------------------------------------- 档位参数表 */
export const TIERS = {
  high: {
    name: 'high',
    dprCap: 2,
    snowMax: 9000,
    steamMax: 520,
    sparkle: 1.0,
    sparkleEvery: 1,     // 闪烁高光每帧都算
    groundSegX: 150,
    groundSegZ: 78,
    coneMesh: true,      // 头灯体积光锥
    lampGlow: true,
    treeline: true,
    propDetail: true,    // 站台灯/水塔等细件
    antialias: true,
    smokeLife: 3.4,
  },
  mid: {
    name: 'mid',
    /* 2x 而不是 1.5x：3x 屏手机上 1.5 等于只渲染 1/4 像素，肉眼就是糊。
       真·低端机靠 1s 滑窗连续 2 窗口 <45fps 自动降一档兜底。 */
    dprCap: 2,
    snowMax: 5000,
    steamMax: 300,
    sparkle: 0.7,
    sparkleEvery: 1,
    groundSegX: 110,
    groundSegZ: 58,
    coneMesh: true,
    lampGlow: true,
    treeline: true,
    propDetail: true,
    antialias: true,
    smokeLife: 3.1,
  },
  low: {
    name: 'low',
    dprCap: 1,
    snowMax: 2200,
    steamMax: 140,
    sparkle: 0.0,
    sparkleEvery: 2,
    groundSegX: 76,
    groundSegZ: 40,
    coneMesh: false,
    lampGlow: true,
    treeline: true,
    propDetail: false,
    antialias: false,
    smokeLife: 2.8,
  },
};

const ORDER = ['high', 'mid', 'low'];

export function tierOf(name) { return TIERS[name] || TIERS.high; }
export function nextLower(name) {
  const i = ORDER.indexOf(name);
  return i < 0 || i >= ORDER.length - 1 ? null : ORDER[i + 1];
}

/* ------------------------------------------------------- 启动时的一次判定 */
export function detectQuality() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'high';

  const nav = navigator;
  const dpr = window.devicePixelRatio || 1;
  const hc = nav.hardwareConcurrency || 4;
  const mem = nav.deviceMemory || nav.deviceMemory === 0 ? nav.deviceMemory : (nav.deviceMemory || 0);

  /* 粗指针 / 小屏 / 触屏 → 视作移动端 */
  let coarse = false;
  try {
    coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  } catch (e) { coarse = false; }

  const ua = (nav.userAgent || '').toLowerCase();
  const uaMobile = /android|iphone|ipad|ipod|mobile|silk|kindle/.test(ua);
  const isMac = /macintosh|mac os x/.test(ua);

  /* Safari 的 hardwareConcurrency 常常虚高，另算一个「弱机」信号。
     阈值必须 <360：390/412/430 宽的手机是主流尺寸，原来 <520 会把
     每一台手机都判成小屏，然后一路扣分打到 low/mid，3x 屏只能拿 cap 1.5（糊）。 */
  const smallViewport = Math.min(window.innerWidth || 1200, window.innerHeight || 800) < 360;

  const mobile = coarse || uaMobile;

  /* 打一个分：越高越强 */
  let score = 0;
  if (hc >= 8) score += 2; else if (hc >= 4) score += 1; else score -= 1;
  if (mobile) score -= 1;
  /* 高分屏移动端（dpr>=2.5 基本是现代中高端机）不该被打到 low */
  if (mobile && dpr >= 2.5) score += 1;
  if (smallViewport) score -= 1;
  /* 注意：不要因为 dpr>=3 就扣分。高分屏是"更清楚"，不是"更弱"；
     3x 屏落到 mid → cap 1.5 → canvas 只有 585×1266，实际是糊的。
     真正的弱机会在运行期被滑窗 FPS 降档兜住。 */
  if (mem && mem > 0 && mem <= 2) score -= 1;
  /* iPad / 高端移动端：粗指针但分辨率高、核心多，别一刀切到 low */
  if (mobile && hc >= 8 && dpr <= 2 && !smallViewport) score += 2;
  /* Mac 上的 Safari/Chrome 一般都不差 */
  if (isMac && !mobile) score += 1;

  if (score >= 2) return 'high';
  if (score >= -1) return 'mid';
  return 'low';
}

/* --------------------------------------------------------------- 滑窗采样 */
export function createQualityMonitor(initialTier, onDowngrade) {
  const WINDOW_MS = 1000;
  const FPS_FLOOR = 45;
  const STRIKES = 2;

  let tier = initialTier;
  let frames = 0;
  let winStart = 0;
  let strikes = 0;
  let running = false;
  let lastFps = 0;

  return {
    get tier() { return tier; },
    get fps() { return lastFps; },
    get strikes() { return strikes; },

    start(now) { running = true; frames = 0; winStart = now; strikes = 0; },
    stop() { running = false; },

    /** 每帧调用一次；now 单位 ms。返回是否需要外部应用新档位。 */
    tick(now, reducedMotion) {
      if (!running) return false;
      frames++;
      const dt = now - winStart;
      if (dt < WINDOW_MS) return false;

      const fps = (frames * 1000) / dt;
      lastFps = fps;
      frames = 0;
      winStart = now;

      /* reduced-motion 下不去猜测性能：用户本来就要求少动效，帧数没意义 */
      if (reducedMotion) { strikes = 0; return false; }

      /* 窗口太碎（切标签页回来）不算数 */
      if (dt > WINDOW_MS * 2.2) { strikes = 0; return false; }

      if (fps < FPS_FLOOR) {
        strikes++;
      } else {
        strikes = Math.max(0, strikes - 1);
      }

      if (strikes >= STRIKES) {
        const lower = nextLower(tier);
        if (!lower) { strikes = STRIKES; return false; }
        tier = lower;
        strikes = 0;
        if (onDowngrade) onDowngrade(lower, fps);
        return true;
      }
      return false;
    },

    /** 外部强制设档（ui 调 WinterTrain.setQuality） */
    force(name) {
      if (!TIERS[name]) return false;
      tier = name;
      strikes = 0;
      frames = 0;
      return true;
    },
  };
}

/* -------------------------------------------------------------- DPR 计算 */
export function dprFor(tierName) {
  const cap = tierOf(tierName).dprCap;
  const raw = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  return clamp(raw, 1, cap);
}
