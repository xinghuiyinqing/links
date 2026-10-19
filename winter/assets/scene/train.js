/* ============================================================================
   train.js —— 蒸汽机车 + 煤水车 + 四节客车
   ----------------------------------------------------------------------------
   坐标约定（全部是「车体局部坐标」，X 向车头为正，Y 向上，Z 是横向）：
     · 轮子与钢轨接触面 y = TRACK.railTop = 0.44
     · 动轮 r = 0.72，轴心 y = 1.16；导轮 r = 0.33，轴心 y = 0.77
     · 锅炉轴心 y = 2.52，半径 0.62；烟囱顶 y = 4.34（全车最高点）
     · 客车体 y = 1.10..3.60，拱顶到 4.02；车窗中心 y = 2.515
   一列车最终被整体居中到 x = 0，长度 49.18。

   draw call 规划（整列车）：
     locoSteel / locoBrass / locoSnow / lens  …  4
     carSteel / carBrass / carSnow / glass    …  4
     tenderCoal                               …  1
     wheels（InstancedMesh ×32）              …  1
     couplingRod / mainRod / piston           …  3
                                             = 13

   运动学（严格同步，一眼假就是指这里）：
     · 位移 D(t) 由预计算的缓动表给出；
     · 车轮转角 θ = -D / r（纯滚动，绝不另开一个「车轮动画」）；
     · 曲柄销 = 轴心 + rc(cosθ, sinθ)；联动杆跟随销做圆周平移；
     · 主连杆另一端由滑块-曲柄的解析解求出（见 sliderX）；
     · 活塞行程因此天然等于 2rc，和轮子不会脱节。
   ========================================================================== */
import * as THREE from 'three';
import { Batch, SHADE, PAL, TRACK, clamp, lerp, smoothstep, noise2, makeRng } from './util.js';
import { makeSteelSet, makeCoalMap } from './textures.js';
import { GLASS_VERT, GLASS_FRAG, CONE_VERT, CONE_FRAG } from './glsl.js';

/* ============================================================ 布局常量 */
export const LAYOUT = {
  /* 机车 */
  LOCO_REAR: -3.90,
  LOCO_FRONT: 5.06,
  CAB_X0: -3.90, CAB_X1: -1.88,
  BOILER_Y: 2.52, BOILER_R: 0.62,
  BOILER_X0: -0.72, BOILER_X1: 3.62,
  SMOKEBOX_X0: 3.62, SMOKEBOX_X1: 4.66, SMOKEBOX_R: 0.66,
  CHIMNEY_X: 3.95, CHIMNEY_TOP: 4.34,
  DOME_X: 0.80, SAND_X: 2.20,
  DRIVER_R: 0.72,
  DRIVER_AXLES: [1.15, -0.70, -2.55],
  LEAD_R: 0.33,
  LEAD_AXLES: [3.88, 4.60],
  CRANK_R: 0.30,
  MAIN_ROD: 1.20,
  CROSS_Y: 1.22,
  WHEEL_Z: 0.755,
  ROD_Z: 0.90,
  /* 煤水车 */
  TENDER_X: -5.35,
  TENDER_LEN: 2.20,
  TENDER_W: 2.50,
  TENDER_TOP: 3.05,
  TENDER_R: 0.46,
  TENDER_AXLES: [-0.62, 0.62],
  /* 客车 */
  CAR_LEN: 10.77,
  CAR_W: 2.52,
  CAR_FLOOR: 1.16,
  CAR_TOP: 3.86,
  CAR_ROOF: 4.26,
  CAR_R: 0.34,
  CAR_BOGIE: [-2.85, 2.85],
  CAR_BOGIE_AXLES: [-0.42, 0.42],
  CAR_GAP: 0.085,
  WIN_Y0: 1.72, WIN_Y1: 3.62,
  WIN_HALF_X: 2.13,
  WIN_DX: 2.72,          // 窗中心距车厢中心的横向偏移
  WIN_Z: 1.12,
  /* 整体居中：整列车 [-48.32, 5.06] -> 平移到以 0 为中心 */
  CENTER_SHIFT: 10.3825,
};

/* 派生：四节客车中心 / 车窗世界基准位置 */
const CAR0_CENTER = -9.585 + LAYOUT.CENTER_SHIFT;
const CAR_PITCH = LAYOUT.CAR_LEN + LAYOUT.CAR_GAP;
/* 只有两节客车（屏幕上才有可信的细长比例），每节两扇窗 = 四张卡片 */
export const CAR_X = [CAR0_CENTER, CAR0_CENTER - CAR_PITCH];

/* 四扇窗在「车体局部坐标」里的 x，已经按屏幕 x 升序排好：
   slot 0 = 最左（尾部车厢的后窗）… slot 3 = 最右（首节车厢的前窗） */
export const WIN_SLOT_X = [
  CAR_X[1] - LAYOUT.WIN_DX,
  CAR_X[1] + LAYOUT.WIN_DX,
  CAR_X[0] - LAYOUT.WIN_DX,
  CAR_X[0] + LAYOUT.WIN_DX,
];
export const WINDOW_LOCAL = {
  y: (LAYOUT.WIN_Y0 + LAYOUT.WIN_Y1) * 0.5,
  halfW: LAYOUT.WIN_HALF_X,
  halfH: (LAYOUT.WIN_Y1 - LAYOUT.WIN_Y0) * 0.5,
  z: LAYOUT.WIN_Z,
};
export const TRAIN_LEN = 30.885;
export const TRAIN_TALL = 4.34;
export const LOCO_FRONT_LOCAL = 15.4425;   // 机车车头在世界 x 的落位（settled）
export const CARS_LEFT_LOCAL = -15.4425;   // 最后一节车厢左端
export const TRAIN_PITCH = 5.44;   // 同一列车里相邻两扇窗的世界间距
/* 纵向比例：机车与客车都按「画面里的目标高度」反解出来，不是拍脑袋。
   客车：车身要 230px、窗洞要 138px → 车体 y 拉伸 1.58 倍再下移 0.54。
   机车：烟囱顶要高出车顶 → 整体 y 拉伸 1.45 倍，轮径/曲柄/连杆同步缩放，
        连杆仍是合法的四连杆几何（整体相似变换）。 */
export const LOCO_YS = 1.45;
export const LOCO_YO = -0.198;
export const CARS_YS = 1.58;
export const CARS_YO = -0.54;         // 车厢中心间距
export const CHIMNEY_LOCAL_X = LAYOUT.CENTER_SHIFT + LAYOUT.CHIMNEY_X;
export const LOCO_GROUP_X = LAYOUT.CENTER_SHIFT;
export const TENDER_GROUP_X = LAYOUT.TENDER_X + LAYOUT.CENTER_SHIFT;

/* 车轮清单：[x, y, r]，按位置打平成数组（热循环里直接读） */
function buildWheelList() {
  const L = LAYOUT, out = [];
  const LS = LOCO_YS;
  for (let i = 0; i < L.DRIVER_AXLES.length; i++) {
    out.push(L.CENTER_SHIFT + L.DRIVER_AXLES[i], TRACK.railTop + L.DRIVER_R * LS, L.DRIVER_R * LS);
  }
  for (let i = 0; i < L.LEAD_AXLES.length; i++) {
    out.push(L.CENTER_SHIFT + L.LEAD_AXLES[i], TRACK.railTop + L.LEAD_R * LS, L.LEAD_R * LS);
  }
  const cy = TRACK.railTop + L.CAR_R;
  for (let c = 0; c < 4; c++) {
    for (let b = 0; b < L.CAR_BOGIE.length; b++) {
      for (let a = 0; a < L.CAR_BOGIE_AXLES.length; a++) {
        out.push(CAR_X[c] + L.CAR_BOGIE[b] + L.CAR_BOGIE_AXLES[a], cy, L.CAR_R);
      }
    }
  }
  return out;
}

/* ============================================================ 车轮几何
   单位半径（r = 1）的轮子，轴线沿 Z。实例化时按 r 缩放即可，
   所以一套几何同时给动轮/导轮/煤水车轮/客车轮用 —— 一次 draw call。 */
function buildWheelUnit() {
  const b = new Batch(1.0);
  const shade = SHADE.steel(0.9, 0);

  /* 轮箍外圈（一圈环面当作踏面） */
  b.add(new THREE.CylinderGeometry(1.0, 1.0, 0.30, 22, 1, true).rotateX(Math.PI * 0.5), null, shade);
  /* 踏面的厚边 */
  b.add(new THREE.TorusGeometry(0.985, 0.055, 5, 22), null, shade);
  /* 轮心盘 */
  b.add(new THREE.CylinderGeometry(0.17, 0.17, 0.34, 12, 1, false).rotateX(Math.PI * 0.5), null, shade);
  /* 10 根轮辐 */
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const g = new THREE.BoxGeometry(0.10, 0.80, 0.125);
    g.translate(0, 0.52, 0);
    g.rotateZ(a);
    b.add(g, null, shade);
  }
  /* 配重块：一块 76° 的实心扇形（pac-man），和曲柄销正好反相 */
  const cw = new THREE.CylinderGeometry(0.94, 0.94, 0.26, 9, 1, false, Math.PI - 0.66, 1.32);
  cw.rotateX(Math.PI * 0.5);
  b.add(cw, null, shade);
  /* 配重边缘的一道亮线 */
  b.add(new THREE.TorusGeometry(0.90, 0.028, 4, 10, 1.32).rotateZ(Math.PI - 0.66), null, shade);

  return b.build();
}

/* ============================================================ 机车 · 钢件 */
function buildLocoSteel(b) {
  const L = LAYOUT;
  const steel = SHADE.steel(1.0, 0.7);

  /* ---- 锅炉：主筒 ---- */
  const boLen = L.BOILER_X1 - L.BOILER_X0;
  b.add(
    new THREE.CylinderGeometry(L.BOILER_R, L.BOILER_R, boLen, 22, 1, false)
      .rotateZ(-Math.PI * 0.5),
    mat4((L.BOILER_X0 + L.BOILER_X1) * 0.5, L.BOILER_Y, 0), steel,
  );
  /* 锅炉箍环（5 道）：铆接钢板的分段，侧视时是最醒目的一排竖线 */
  for (let i = 0; i < 5; i++) {
    const x = L.BOILER_X0 + 0.42 + i * (boLen - 0.84) / 4;
    b.add(new THREE.TorusGeometry(L.BOILER_R + 0.012, 0.028, 5, 20)
      .rotateY(Math.PI * 0.5), mat4(x, L.BOILER_Y, 0), steel);
  }
  /* 锅炉前端与烟箱之间的过渡环 */
  b.add(new THREE.TorusGeometry(L.BOILER_R + 0.03, 0.042, 5, 20)
    .rotateY(Math.PI * 0.5), mat4(L.BOILER_X1, L.BOILER_Y, 0), steel);

  /* ---- 烟箱 ---- */
  const sbLen = L.SMOKEBOX_X1 - L.SMOKEBOX_X0;
  b.add(
    new THREE.CylinderGeometry(L.SMOKEBOX_R, L.SMOKEBOX_R, sbLen, 22, 1, false)
      .rotateZ(-Math.PI * 0.5),
    mat4((L.SMOKEBOX_X0 + L.SMOKEBOX_X1) * 0.5, L.BOILER_Y, 0), steel,
  );
  /* 烟箱两道箍环（r 比锅炉大 2%，侧视时能看出烟箱是一个更粗的独立圆筒） */
  for (let i = 0; i < 2; i++) {
    b.add(new THREE.TorusGeometry(L.SMOKEBOX_R + 0.014, 0.026, 5, 24)
      .rotateY(Math.PI * 0.5), mat4(L.SMOKEBOX_X0 + 0.16 + i * 0.60, L.BOILER_Y, 0), steel);
  }
  /* 烟箱顶部的一道纵向加强板（不是整块的方板，只有 12cm 宽） */
  b.add(new THREE.BoxGeometry(1.02, 0.05, 0.12), mat4(4.14, L.BOILER_Y + L.SMOKEBOX_R - 0.02, 0), steel);

  /* ---- 烟囱：下粗上略外扩 ---- */
  const chTop = L.CHIMNEY_TOP;
  const chBase = L.BOILER_Y + 0.50;
  b.add(new THREE.CylinderGeometry(0.235, 0.255, chTop - chBase - 0.16, 16, 1, true),
    mat4(L.CHIMNEY_X, (chBase + chTop - 0.16) * 0.5, 0), steel);
  /* 顶部外扩的喇叭口 */
  b.add(new THREE.CylinderGeometry(0.315, 0.235, 0.20, 16, 1, true),
    mat4(L.CHIMNEY_X, chTop - 0.10, 0), steel);
  /* 喇叭口的上唇 */
  b.add(new THREE.TorusGeometry(0.313, 0.030, 5, 16), mat4(L.CHIMNEY_X, chTop, 0), steel);
  /* 烟囱根部的一圈加固 */
  b.add(new THREE.TorusGeometry(0.27, 0.035, 5, 14), mat4(L.CHIMNEY_X, chBase + 0.06, 0), steel);

  /* ---- 蒸汽汽包（沙箱前那个大圆顶） ---- */
  b.add(new THREE.CylinderGeometry(0.33, 0.34, 0.35, 16, 1, true),
    mat4(L.DOME_X, L.BOILER_Y + 0.55, 0), steel);
  b.add(new THREE.SphereGeometry(0.33, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
    mat4(L.DOME_X, L.BOILER_Y + 0.72, 0), steel);
  /* 汽包顶上的安全阀 */
  b.add(new THREE.CylinderGeometry(0.075, 0.09, 0.16, 10, 1, true),
    mat4(L.DOME_X, L.BOILER_Y + 1.10, 0), steel);

  /* ---- 沙箱 ---- */
  b.add(new THREE.CylinderGeometry(0.24, 0.25, 0.28, 14, 1, true),
    mat4(L.SAND_X, L.BOILER_Y + 0.52, 0), steel);
  b.add(new THREE.SphereGeometry(0.24, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.5),
    mat4(L.SAND_X, L.BOILER_Y + 0.66, 0), steel);
  /* 加沙口 */
  b.add(new THREE.CylinderGeometry(0.055, 0.055, 0.10, 8),
    mat4(L.SAND_X, L.BOILER_Y + 0.88, 0), steel);
  /* 从沙箱通到动轮的两根撒砂管 */
  for (let s = -1; s <= 1; s += 2) {
    b.add(new THREE.CylinderGeometry(0.022, 0.022, 0.95, 6),
      mat4(L.SAND_X - 0.30, L.BOILER_Y + 0.10, s * 0.84, 0, 0, 0.22), steel);
  }

  /* ---- 火箱（锅炉与驾驶室之间的方箱） ---- */
  b.add(new THREE.BoxGeometry(1.16, 1.40, 1.44), mat4(-1.30, 2.60, 0), steel);
  /* 火箱外壳的铆接边 */
  b.add(new THREE.BoxGeometry(1.20, 0.08, 1.50), mat4(-1.30, 3.28, 0), steel);

  /* ---- 挡烟板：原来是 1.62x1.44 的方板，正好把整个圆烟箱挡住 ——
     侧视时读成"锅炉前面接了一个方盒"，这就是用户说的两个长方体之一。
     俄系支线小机车多数本来就没有挡烟板，直接去掉，露出圆烟箱。
     （想加回来的话：应该是 0.03 厚的弧形薄板，与烟箱留 0.1 的缝。） */
  /* ---- 烟箱前端：圆形门 + 铰链耳 + 中心横把手 + 门周一圈螺栓 ---- */
  {
    const doorX = L.SMOKEBOX_X1 + 0.045;
    const R = L.SMOKEBOX_R;
    /* 门盘：略微外凸（用两段圆台做出锅底感，而不是一块平板） */
    b.add(new THREE.CylinderGeometry(R * 0.965, R * 0.995, 0.075, 24)
      .rotateZ(-Math.PI * 0.5), mat4(doorX, L.BOILER_Y, 0), steel);
    b.add(new THREE.CylinderGeometry(R * 0.80, R * 0.965, 0.055, 24)
      .rotateZ(-Math.PI * 0.5), mat4(doorX + 0.062, L.BOILER_Y, 0), steel);
    /* 门外的压圈 */
    b.add(new THREE.TorusGeometry(R * 1.005, 0.030, 6, 26)
      .rotateY(Math.PI * 0.5), mat4(doorX - 0.02, L.BOILER_Y, 0), steel);
    /* 一圈螺栓：14 颗小圆台，全部塞进同一块合并几何 */
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      const by = L.BOILER_Y + Math.cos(a) * R * 0.90;
      const bz = Math.sin(a) * R * 0.90;
      b.add(new THREE.CylinderGeometry(0.028, 0.034, 0.035, 6)
        .rotateZ(-Math.PI * 0.5), mat4(doorX + 0.098, by, bz), steel);
    }
    /* 中心横把手（两根短杆 + 一根横杆） */
    b.add(new THREE.CylinderGeometry(0.024, 0.024, 0.10, 6)
      .rotateZ(-Math.PI * 0.5), mat4(doorX + 0.13, L.BOILER_Y, 0), steel);
    b.add(new THREE.BoxGeometry(0.035, 0.075, 0.44), mat4(doorX + 0.175, L.BOILER_Y, 0), steel);
    for (let s = -1; s <= 1; s += 2) {
      b.add(new THREE.BoxGeometry(0.03, 0.10, 0.05), mat4(doorX + 0.175, L.BOILER_Y, s * 0.20), steel);
      /* 铰链耳：门盘两侧各一个 */
      b.add(new THREE.BoxGeometry(0.055, 0.16, 0.07), mat4(doorX - 0.02, L.BOILER_Y + R * 0.72, s * 0.20), steel);
    }
    /* 门上方的一个小吊环（起吊用） */
    b.add(new THREE.TorusGeometry(0.05, 0.014, 5, 10), mat4(doorX + 0.05, L.BOILER_Y + R * 0.94, 0), steel);
  }

  /* ---- 走台（running board）与围裙 ---- */
  for (let s = -1; s <= 1; s += 2) {
    const z = s * 0.94;
    b.add(new THREE.BoxGeometry(6.55, 0.075, 0.30), mat4(1.28, 1.99, z), steel);
    /* 走台外侧的裙板 */
    b.add(new THREE.BoxGeometry(6.55, 0.13, 0.045), mat4(1.28, 1.92, z + s * 0.15), steel);
    /* 走台上的支撑托架 */
    for (let i = 0; i < 5; i++) {
      b.add(new THREE.BoxGeometry(0.07, 0.16, 0.28), mat4(-1.6 + i * 1.5, 1.88, z), steel);
    }
  }

  /* ---- 汽缸 + 滑板 + 十字头（滑板/十字头是动的，单独在 piston 里） ---- */
  for (let s = -1; s <= 1; s += 2) {
    const z = s * 0.96;
    /* 汽缸本体：前端带一个凸盖 */
    b.add(new THREE.CylinderGeometry(0.345, 0.345, 0.78, 20, 1, false)
      .rotateZ(-Math.PI * 0.5), mat4(3.16, L.CROSS_Y, z), steel);
    b.add(new THREE.CylinderGeometry(0.362, 0.372, 0.085, 20)
      .rotateZ(-Math.PI * 0.5), mat4(3.53, L.CROSS_Y, z), steel);
    /* 汽缸盖的螺栓圈 */
    b.add(new THREE.TorusGeometry(0.352, 0.026, 5, 20).rotateY(Math.PI * 0.5),
      mat4(3.59, L.CROSS_Y, z), steel);
    /* 汽缸与车架之间的连接块 */
    /* 鞍座：贴合缸体下缘的一段弧壳（原来这里是一块 0.72x0.44x0.30 的方盒，
       侧视合成「带雪顶的矩形盒」的主因之一） */
    b.add(new THREE.CylinderGeometry(0.352, 0.352, 0.36, 18, 1, true, Math.PI * 0.54, Math.PI * 0.92)
      .rotateZ(-Math.PI * 0.5), mat4(3.06, L.CROSS_Y, z), steel);
    b.add(new THREE.BoxGeometry(0.28, 0.17, 0.10), mat4(3.02, L.CROSS_Y - 0.42, z), steel);
    /* 排水阀：两个朝下的直角弯头 */
    for (let k = 0; k < 2; k++) {
      const px = 2.92 + k * 0.30;
      b.add(new THREE.CylinderGeometry(0.032, 0.032, 0.17, 6), mat4(px, L.CROSS_Y - 0.40, z), steel);
      b.add(new THREE.CylinderGeometry(0.030, 0.030, 0.10, 6).rotateZ(Math.PI * 0.5),
        mat4(px + 0.05, L.CROSS_Y - 0.48, z), steel);
    }
    /* 滑板（两根导杆） */
    for (let k = -1; k <= 1; k += 2) {
      b.add(new THREE.BoxGeometry(0.98, 0.045, 0.075), mat4(2.36, L.CROSS_Y + k * 0.105, z), steel);
    }
    /* 滑板前端与汽缸相接的座 */
    b.add(new THREE.BoxGeometry(0.10, 0.30, 0.16), mat4(2.84, L.CROSS_Y, z), steel);
    /* 滑板后端的托架 */
    b.add(new THREE.BoxGeometry(0.10, 0.30, 0.16), mat4(1.90, L.CROSS_Y, z), steel);
    /* 汽缸排水小旋塞 */
    b.add(new THREE.CylinderGeometry(0.035, 0.035, 0.10, 6), mat4(3.30, L.CROSS_Y - 0.28, z), steel);
  }

  /* ---- 闸瓦 / 闸瓦托：贴在每只动轮踏面的后上方 ---- */
  for (let d = 0; d < L.DRIVER_AXLES.length; d++) {
    const ax = L.DRIVER_AXLES[d];
    const ay = TRACK.railTop + L.DRIVER_R;
    for (let s = -1; s <= 1; s += 2) {
      /* 闸瓦本体：一段包住轮缘的弧形块（用圆柱的一段近似） */
      b.add(new THREE.CylinderGeometry(L.DRIVER_R + 0.055, L.DRIVER_R + 0.055, 0.20, 14, 1, true, -0.52, 1.04)
        .rotateX(Math.PI * 0.5), mat4(ax, ay, s * L.WHEEL_Z), steel);
      /* 闸瓦托 + 吊杆 */
      b.add(new THREE.BoxGeometry(0.14, 0.20, 0.10), mat4(ax - 0.30, ay + 0.60, s * (L.WHEEL_Z + 0.10)), steel);
      b.add(new THREE.BoxGeometry(0.07, 0.66, 0.06), mat4(ax - 0.34, ay + 0.92, s * (L.WHEEL_Z + 0.10)), steel);
    }
  }
  /* ---- 车架侧梁 ---- */
  for (let s = -1; s <= 1; s += 2) {
    b.add(new THREE.BoxGeometry(8.2, 0.32, 0.11), mat4(0.60, 1.58, s * 0.80), steel);
  }
  /* 前后端梁 */
  b.add(new THREE.BoxGeometry(0.30, 0.55, 2.10), mat4(4.72, 1.13, 0), steel);
  b.add(new THREE.BoxGeometry(0.26, 0.50, 1.95), mat4(-3.86, 1.20, 0), steel);

  /* ---- 缓冲梁 + 缓冲器 + 车钩 ---- */
  b.add(new THREE.BoxGeometry(0.16, 0.68, 2.20), mat4(4.62, 0.98, 0), steel);
  for (let s = -1; s <= 1; s += 2) {
    b.add(new THREE.CylinderGeometry(0.155, 0.155, 0.30, 12)
      .rotateZ(-Math.PI * 0.5), mat4(4.82, 0.98, s * 0.82), steel);
    b.add(new THREE.CylinderGeometry(0.185, 0.185, 0.05, 12)
      .rotateZ(-Math.PI * 0.5), mat4(4.98, 0.98, s * 0.82), steel);
  }
  /* 排障器（斜栅）：一块斜面 + 5 根竖栅 */
  const pcx = 4.905, pcy = 0.775;
  b.add(new THREE.BoxGeometry(0.99, 0.055, 1.86), mat4(pcx, pcy, 0, 0, 0, -1.293), steel);
  for (let i = -2; i <= 2; i++) {
    b.add(new THREE.BoxGeometry(0.055, 0.86, 0.075),
      mat4(pcx + i * 0.0, pcy + 0.06, i * 0.44, 0, 0, -1.293), steel);
  }
  /* 排障器上沿的横梁 */
  b.add(new THREE.BoxGeometry(0.14, 0.10, 1.86), mat4(4.76, 1.30, 0), steel);
  /* 车钩 */
  b.add(new THREE.BoxGeometry(0.55, 0.16, 0.16), mat4(4.95, 0.78, 0), steel);
  b.add(new THREE.TorusGeometry(0.13, 0.045, 5, 10), mat4(5.16, 0.72, 0), steel);

  /* ---- 驾驶室：地板 / 立柱 / 前后围板 ---- */
  const cx0 = L.CAB_X0, cx1 = L.CAB_X1;
  const cabY0 = 1.92, cabY1 = 3.78, cabW = 0.98;
  b.add(new THREE.BoxGeometry(cx1 - cx0, 0.09, cabW * 2), mat4((cx0 + cx1) * 0.5, cabY0, 0), steel);
  /* 四根角柱 */
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sz = -1; sz <= 1; sz += 2) {
      b.add(new THREE.BoxGeometry(0.10, cabY1 - cabY0, 0.10),
        mat4(sx > 0 ? cx1 - 0.06 : cx0 + 0.06, (cabY0 + cabY1) * 0.5, sz * cabW), steel);
    }
  }
  /* 后围板（朝煤水车）：下半实心，上半开一个窗 */
  b.add(new THREE.BoxGeometry(0.08, 0.62, cabW * 2), mat4(cx0 + 0.04, cabY0 + 0.31, 0), steel);
  b.add(new THREE.BoxGeometry(0.08, 0.24, cabW * 2), mat4(cx0 + 0.04, cabY1 - 0.12, 0), steel);
  for (let s = -1; s <= 1; s += 2) {
    b.add(new THREE.BoxGeometry(0.08, 1.10, 0.34), mat4(cx0 + 0.04, 2.86, s * (cabW - 0.17)), steel);
  }
  /* 前围板（朝火箱）：留一个投煤口 */
  b.add(new THREE.BoxGeometry(0.08, cabY1 - cabY0, cabW * 2), mat4(cx1 - 0.04, (cabY0 + cabY1) * 0.5, 0), steel);
  /* 近侧墙：上下两块 + 门窗柱，中间挖出侧窗 */
  const winX0 = cx0 + 0.58, winX1 = cx1 - 0.30;
  const winY0 = 2.56, winY1 = 3.42;
  for (let s = -1; s <= 1; s += 2) {
    const z = s * cabW;
    if (s > 0) {
      /* 近侧（相机看得到）：真的挖窗 */
      b.add(new THREE.BoxGeometry(cabW * 2 - 0.12, winY0 - cabY0, 0.075), mat4((cx0 + cx1) * 0.5, (cabY0 + winY0) * 0.5, z), steel);
      b.add(new THREE.BoxGeometry(cabW * 2 - 0.12, cabY1 - winY1, 0.075), mat4((cx0 + cx1) * 0.5, (winY1 + cabY1) * 0.5, z), steel);
      b.add(new THREE.BoxGeometry(winX0 - cx0, winY1 - winY0, 0.075), mat4((cx0 + winX0) * 0.5, (winY0 + winY1) * 0.5, z), steel);
      b.add(new THREE.BoxGeometry(cx1 - winX1, winY1 - winY0, 0.075), mat4((winX1 + cx1) * 0.5, (winY0 + winY1) * 0.5, z), steel);
    } else {
      /* 远侧：一整块，省面 */
      b.add(new THREE.BoxGeometry(cabW * 2 - 0.12, cabY1 - cabY0, 0.06), mat4((cx0 + cx1) * 0.5, (cabY0 + cabY1) * 0.5, z), steel);
    }
  }
  /* 驾驶室车顶：平顶 + 一圈雨檐 */
  b.add(new THREE.BoxGeometry(cabW * 2 + 0.20, 0.09, cabW * 2 + 0.22), mat4((cx0 + cx1) * 0.5, cabY1 + 0.05, 0), steel);
  b.add(new THREE.BoxGeometry(cabW * 2 + 0.30, 0.055, cabW * 2 + 0.34), mat4((cx0 + cx1) * 0.5, cabY1 + 0.10, 0), steel);
  /* 侧窗上方的雨檐（往前斜挑出去一条） */
  for (let s = -1; s <= 1; s += 2) {
    b.add(new THREE.BoxGeometry(winX1 - winX0 + 0.24, 0.045, 0.20),
      mat4((winX0 + winX1) * 0.5, winY1 + 0.10, s * (cabW + 0.07), 0, 0, 0.10), steel);
  }
  /* 踏梯：两级台阶 + 一根扶手 */
  for (let s = -1; s <= 1; s += 2) {
    b.add(new THREE.BoxGeometry(0.44, 0.055, 0.30), mat4(cx0 + 0.30, 1.62, s * (cabW + 0.10)), steel);
    b.add(new THREE.BoxGeometry(0.44, 0.055, 0.30), mat4(cx0 + 0.30, 1.20, s * (cabW + 0.10)), steel);
    b.add(new THREE.CylinderGeometry(0.022, 0.022, 1.05, 6), mat4(cx0 + 0.10, 2.05, s * (cabW + 0.14)), steel);
  }

  /* ---- 车头灯：灯箱 + 抛物面反光碗 ---- */
  /* ================= 驾驶室精修（在原有底板/立柱/端板之上补细节） ======== */
  {
    const cxm = (cx0 + cx1) * 0.5;
    const len = cx1 - cx0;
    /* 车顶外挑檐：比侧墙宽 0.06，下面一道暗缝（用一条薄板压出阴影线） */
    b.add(new THREE.BoxGeometry(len + 0.26, 0.055, cabW * 2 + 0.30),
      mat4(cxm, cabY1 + 0.135, 0), steel);
    b.add(new THREE.BoxGeometry(len + 0.10, 0.030, cabW * 2 + 0.10),
      mat4(cxm, cabY1 + 0.098, 0), steel);
    /* 侧窗中竖棂（把大窗分成两格）+ 下窗台 */
    for (let s = -1; s <= 1; s += 2) {
      const z = s * (cabW + 0.045);
      b.add(new THREE.BoxGeometry(0.048, winY1 - winY0, 0.05),
        mat4((winX0 + winX1) * 0.5, (winY0 + winY1) * 0.5, z), steel);
      b.add(new THREE.BoxGeometry(winX1 - winX0 + 0.10, 0.045, 0.075),
        mat4((winX0 + winX1) * 0.5, winY0 - 0.03, z), steel);
    }
    /* 侧门：带门框、把手、两个折页（做在近侧 s>0） */
    const dz = cabW + 0.05;
    const dxp = cx0 + 0.34;
    b.add(new THREE.BoxGeometry(0.44, 1.34, 0.055), mat4(dxp, 2.62, dz), steel);
    b.add(new THREE.BoxGeometry(0.50, 0.055, 0.075), mat4(dxp, 3.31, dz), steel);
    b.add(new THREE.BoxGeometry(0.50, 0.055, 0.075), mat4(dxp, 1.94, dz), steel);
    b.add(new THREE.BoxGeometry(0.055, 1.30, 0.075), mat4(dxp - 0.24, 2.62, dz), steel);
    b.add(new THREE.BoxGeometry(0.055, 1.30, 0.075), mat4(dxp + 0.24, 2.62, dz), steel);
    b.add(new THREE.CylinderGeometry(0.020, 0.020, 0.16, 6),
      mat4(dxp + 0.14, 2.52, dz + 0.055), steel);
    for (let k = 0; k < 2; k++) {
      b.add(new THREE.BoxGeometry(0.09, 0.07, 0.045), mat4(dxp - 0.21, 2.10 + k * 1.02, dz + 0.05), steel);
    }
    /* 踏梯补第三级 + 两根立杆 */
    for (let s = -1; s <= 1; s += 2) {
      b.add(new THREE.BoxGeometry(0.44, 0.055, 0.30), mat4(cx0 + 0.30, 0.80, s * (cabW + 0.10)), steel);
      b.add(new THREE.CylinderGeometry(0.020, 0.020, 1.45, 6),
        mat4(cx0 + 0.10, 1.52, s * (cabW + 0.14)), steel);
    }
    /* 后部煤斗（水柜式机车）：一圈加强筋 + 一个不规则煤堆顶面 */
    b.add(new THREE.BoxGeometry(0.10, 0.78, cabW * 1.86), mat4(cx0 + 0.16, cabY0 + 0.55, 0), steel);
    b.add(new THREE.BoxGeometry(0.52, 0.10, cabW * 1.70), mat4(cx0 + 0.34, cabY0 + 0.96, 0), steel);
    for (let k = 0; k < 3; k++) {
      b.add(new THREE.BoxGeometry(0.055, 0.66, cabW * 1.70),
        mat4(cx0 + 0.12 + k * 0.17, cabY0 + 0.55, 0), steel);
    }
    /* 驾驶室顶的通风帽 */
    b.add(new THREE.CylinderGeometry(0.10, 0.13, 0.14, 10), mat4(cxm + 0.24, cabY1 + 0.22, 0), steel);
    b.add(new THREE.CylinderGeometry(0.16, 0.10, 0.06, 10), mat4(cxm + 0.24, cabY1 + 0.32, 0), steel);
  }

  const lampX = 4.72, lampY = 2.94;
  b.add(new THREE.CylinderGeometry(0.215, 0.215, 0.42, 16, 1, true)
    .rotateZ(-Math.PI * 0.5), mat4(lampX, lampY, 0), steel);
  b.add(new THREE.CylinderGeometry(0.235, 0.235, 0.05, 16)
    .rotateZ(-Math.PI * 0.5), mat4(lampX - 0.21, lampY, 0), steel);
  /* 抛物面反光碗：一个 LatheGeometry 的开口锥壳 */
  b.add(lathe([
    [0.02, 0.00], [0.06, 0.05], [0.11, 0.11], [0.155, 0.185], [0.19, 0.255],
  ], 16), mat4(lampX + 0.16, lampY, 0, 0, 0, -Math.PI * 0.5), SHADE.brass());
  /* 灯箱与烟箱之间的支架 */
  b.add(new THREE.BoxGeometry(0.10, 0.10, 0.42), mat4(lampX - 0.24, lampY, 0), steel);
  b.add(new THREE.BoxGeometry(0.10, 0.16, 0.10), mat4(lampX - 0.30, lampY - 0.14, 0), steel);
  /* 汽笛：底座环 + 细长笛管 + 顶口外扩 */
  b.add(new THREE.CylinderGeometry(0.095, 0.11, 0.055, 12), mat4(3.30, 3.235, 0), steel);
  b.add(new THREE.CylinderGeometry(0.055, 0.075, 0.36, 10), mat4(3.30, 3.44, 0), steel);
  b.add(new THREE.CylinderGeometry(0.092, 0.055, 0.09, 10), mat4(3.30, 3.665, 0), steel);
  /* 汽包上方的双弹簧安全阀（两根小杆 + 顶帽） */
  for (let s = -1; s <= 1; s += 2) {
    b.add(new THREE.CylinderGeometry(0.030, 0.030, 0.24, 6), mat4(L.DOME_X + s * 0.075, L.BOILER_Y + 1.16, 0), steel);
    b.add(new THREE.CylinderGeometry(0.048, 0.030, 0.055, 8), mat4(L.DOME_X + s * 0.075, L.BOILER_Y + 1.30, 0), steel);
  }
  b.add(new THREE.BoxGeometry(0.20, 0.045, 0.045), mat4(L.DOME_X, L.BOILER_Y + 1.10, 0), steel);
}

/* ============================================================ 机车 · 黄铜 */
function buildLocoBrass(b) {
  const L = LAYOUT;
  const brass = SHADE.brass();
  /* 锅炉两侧的手扶杆（含 6 个立柱座） */
  for (let s = -1; s <= 1; s += 2) {
    /* 手扶栏杆：0.026 太细（2 倍放大下只有 2px），加到 0.034 并抬高到
       锅炉最大直径处，去掉挡烟板之后它才真的露出来。 */
    b.add(new THREE.CylinderGeometry(0.034, 0.034, 5.2, 8)
      .rotateZ(Math.PI * 0.5), mat4(1.20, L.BOILER_Y + 0.44, s * 0.655), brass);
    for (let i = 0; i < 5; i++) {
      b.add(new THREE.CylinderGeometry(0.024, 0.024, 0.16, 6)
        .rotateX(Math.PI * 0.5), mat4(-0.72 + i * 1.16, L.BOILER_Y + 0.44, s * 0.70), brass);
    }
  }
  /* 汽包与沙箱上的铜箍 */
  b.add(new THREE.TorusGeometry(0.335, 0.022, 4, 16).rotateX(Math.PI * 0.5),
    mat4(L.DOME_X, L.BOILER_Y + 0.62, 0), brass);
  b.add(new THREE.TorusGeometry(0.245, 0.018, 4, 14).rotateX(Math.PI * 0.5),
    mat4(L.SAND_X, L.BOILER_Y + 0.60, 0), brass);
  /* 车头灯的铜环 + 前圈 */
  b.add(new THREE.TorusGeometry(0.222, 0.024, 5, 18).rotateY(Math.PI * 0.5), mat4(4.93, 2.94, 0), brass);
  b.add(new THREE.TorusGeometry(0.212, 0.030, 5, 18).rotateY(Math.PI * 0.5), mat4(4.52, 2.94, 0), brass);
  /* 驾驶室侧窗的铜窗框 */
  const winX0 = -3.32, winX1 = -2.18, wy0 = 2.56, wy1 = 3.42;
  for (let s = -1; s <= 1; s += 2) {
    const z = s * 1.005;
    b.add(new THREE.BoxGeometry(winX1 - winX0 + 0.10, 0.045, 0.05), mat4((winX0 + winX1) * 0.5, wy1 + 0.02, z), brass);
    b.add(new THREE.BoxGeometry(winX1 - winX0 + 0.10, 0.045, 0.05), mat4((winX0 + winX1) * 0.5, wy0 - 0.02, z), brass);
    b.add(new THREE.BoxGeometry(0.045, wy1 - wy0 + 0.09, 0.05), mat4(winX0 - 0.02, (wy0 + wy1) * 0.5, z), brass);
    b.add(new THREE.BoxGeometry(0.045, wy1 - wy0 + 0.09, 0.05), mat4(winX1 + 0.02, (wy0 + wy1) * 0.5, z), brass);
  }
  /* 车号的圆牌 */
  b.add(new THREE.CylinderGeometry(0.15, 0.15, 0.03, 14).rotateX(Math.PI * 0.5),
    mat4(-2.60, 3.62, 0.99), brass);
  /* 汽缸盖上的铜压圈 */
  for (let s = -1; s <= 1; s += 2) {
    b.add(new THREE.TorusGeometry(0.255, 0.020, 4, 16).rotateY(Math.PI * 0.5),
      mat4(3.60, 1.22, s * 0.96), brass);
  }
  /* 撒砂管上的一点铜 */
  for (let s = -1; s <= 1; s += 2) {
    b.add(new THREE.TorusGeometry(0.048, 0.014, 4, 8).rotateX(Math.PI * 0.5),
      mat4(L.SAND_X - 0.62, 2.10, s * 0.84), brass);
  }
}

/* ============================================================ 机车 · 积雪 */
function buildLocoSnow(b) {
  const L = LAYOUT;
  const snow = SHADE.flat();
  /* 锅炉顶上的一层雪：一条包住上半圆的薄壳 */
  const boLen = L.BOILER_X1 - L.BOILER_X0 - 0.4;
  b.add(new THREE.CylinderGeometry(L.BOILER_R + 0.038, L.BOILER_R + 0.038, boLen, 18, 1, true, -Math.PI * 0.5 - 0.72, 1.44)
    .rotateZ(-Math.PI * 0.5), mat4((L.BOILER_X0 + L.BOILER_X1) * 0.5, L.BOILER_Y, 0), snow);
  /* 烟箱顶上的雪 */
  b.add(new THREE.CylinderGeometry(L.SMOKEBOX_R + 0.038, L.SMOKEBOX_R + 0.038, 0.95, 16, 1, true, -Math.PI * 0.5 - 0.62, 1.24)
    .rotateZ(-Math.PI * 0.5), mat4(4.12, L.BOILER_Y, 0), snow);
  /* 汽包 / 沙箱 / 烟囱口上的雪帽 */
  b.add(new THREE.SphereGeometry(0.30, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.42),
    mat4(L.DOME_X, L.BOILER_Y + 0.80, 0), snow);
  b.add(new THREE.SphereGeometry(0.215, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.42),
    mat4(L.SAND_X, L.BOILER_Y + 0.72, 0), snow);
  b.add(new THREE.TorusGeometry(0.30, 0.055, 5, 16, Math.PI * 1.1).rotateZ(0.10),
    mat4(L.CHIMNEY_X, L.CHIMNEY_TOP, 0, Math.PI * 0.5, 0, 0), snow);
  /* 走台上的雪条 */
  for (let s = -1; s <= 1; s += 2) {
    b.add(new THREE.BoxGeometry(6.40, 0.045, 0.26), mat4(1.28, 2.03, s * 0.94), snow);
  }
  /* 驾驶室顶的雪 */
  b.add(new THREE.BoxGeometry(2.34, 0.05, 2.30), mat4(-2.89, 3.86, 0), snow);
  /* 缓冲梁上的雪 */
  b.add(new THREE.BoxGeometry(0.18, 0.05, 2.10), mat4(4.62, 1.33, 0), snow);
  /* 汽缸顶的一点雪 */
  for (let s = -1; s <= 1; s += 2) {
    b.add(new THREE.CylinderGeometry(0.288, 0.288, 0.72, 12, 1, true, -Math.PI * 0.5 - 0.45, 0.90)
      .rotateZ(-Math.PI * 0.5), mat4(3.16, 1.22, s * 0.96), snow);
  }
}

/* ============================================================ 煤水车 */
function buildTender(bSteel, bCoal, bSnow, bBrass) {
  const L = LAYOUT;
  const steel = SHADE.steel(1.0, 0.6);
  const half = L.TENDER_LEN * 0.5;
  const hw = L.TENDER_W * 0.5;
  const y0 = 1.02, y1 = L.TENDER_TOP;

  /* 底架 */
  bSteel.add(new THREE.BoxGeometry(L.TENDER_LEN + 0.16, 0.24, L.TENDER_W + 0.06), mat4(0, y0 - 0.10, 0), steel);
  /* 水柜本体 */
  bSteel.add(new THREE.BoxGeometry(L.TENDER_LEN, y1 - y0, L.TENDER_W), mat4(0, (y0 + y1) * 0.5, 0), steel);
  /* 水柜顶沿的一圈凸边 */
  bSteel.add(new THREE.BoxGeometry(L.TENDER_LEN + 0.10, 0.10, L.TENDER_W + 0.10), mat4(0, y1 + 0.02, 0), steel);
  /* 侧面的加强竖肋 */
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < 4; i++) {
      bSteel.add(new THREE.BoxGeometry(0.09, y1 - y0 - 0.10, 0.05),
        mat4(-half + 0.55 + i * 1.03, (y0 + y1) * 0.5, s * (hw + 0.02)), steel);
    }
  }
  /* 煤斗：前半段一圈围板，煤堆从里面冒出来 */
  const bunkX0 = 0.10, bunkX1 = half - 0.14;
  for (let s = -1; s <= 1; s += 2) {
    bSteel.add(new THREE.BoxGeometry(bunkX1 - bunkX0, 0.62, 0.09),
      mat4((bunkX0 + bunkX1) * 0.5, y1 + 0.31, s * (hw - 0.08)), steel);
  }
  bSteel.add(new THREE.BoxGeometry(0.09, 0.62, L.TENDER_W - 0.12), mat4(bunkX1, y1 + 0.31, 0), steel);
  /* 水柜后部的人孔盖 */
  bSteel.add(new THREE.CylinderGeometry(0.28, 0.28, 0.09, 14), mat4(-1.30, y1 + 0.08, 0), steel);
  /* 后部的小平台与梯子 */
  bSteel.add(new THREE.BoxGeometry(0.55, 0.06, L.TENDER_W - 0.10), mat4(-half - 0.24, 1.30, 0), steel);
  for (let s = -1; s <= 1; s += 2) {
    bSteel.add(new THREE.BoxGeometry(0.05, 1.35, 0.05), mat4(-half - 0.06, 1.98, s * (hw - 0.16)), steel);
  }
  /* 车钩 + 缓冲器（后端朝客车） */
  bSteel.add(new THREE.BoxGeometry(0.16, 0.66, 2.16), mat4(-half - 0.10, 0.96, 0), steel);
  for (let s = -1; s <= 1; s += 2) {
    bSteel.add(new THREE.CylinderGeometry(0.15, 0.15, 0.26, 10)
      .rotateZ(-Math.PI * 0.5), mat4(-half - 0.30, 0.96, s * 0.80), steel);
  }
  bSteel.add(new THREE.BoxGeometry(0.50, 0.15, 0.15), mat4(-half - 0.36, 0.76, 0), steel);

  /* 煤堆：几层噪声起伏的多面体，压得很低（被雪盖住一部分） */
  const rnd = makeRng(9182);
  const heapN = 26;
  for (let i = 0; i < heapN; i++) {
    const t = i / heapN;
    const px = lerp(bunkX0 + 0.16, bunkX1 - 0.16, t);
    const pz = (rnd() - 0.5) * (L.TENDER_W - 0.42);
    const r = 0.16 + rnd() * 0.16;
    const py = y1 + 0.20 + Math.sin(t * Math.PI) * 0.30 + rnd() * 0.10;
    const g = new THREE.IcosahedronGeometry(r, 0);
    bCoal.add(g, mat4(px, py, pz, rnd() * 3, rnd() * 3, rnd() * 3), null);
  }
  /* 煤堆的底座（保证不露空） */
  bCoal.add(new THREE.BoxGeometry(bunkX1 - bunkX0 - 0.1, 0.22, L.TENDER_W - 0.22),
    mat4((bunkX0 + bunkX1) * 0.5, y1 + 0.14, 0), null);

  /* 煤上的薄雪 + 顶沿的雪 */
  const snow = SHADE.flat();
  bSnow.add(new THREE.BoxGeometry(L.TENDER_LEN + 0.10, 0.045, L.TENDER_W + 0.08), mat4(0, y1 + 0.08, 0.0), snow);
  bSnow.add(new THREE.CylinderGeometry(0.30, 0.30, 0.05, 12), mat4(-1.30, y1 + 0.14, 0), snow);
  /* 煤堆上的雪：几片薄板 */
  for (let i = 0; i < 6; i++) {
    const px = lerp(bunkX0 + 0.3, bunkX1 - 0.3, i / 5);
    bSnow.add(new THREE.BoxGeometry(0.5, 0.035, L.TENDER_W - 0.5), mat4(px, y1 + 0.50, 0, 0, 0, (rnd() - 0.5) * 0.12), snow);
  }

  /* 一点黄铜：水柜侧面的铭牌和梯子扶手 */
  bBrass.add(new THREE.BoxGeometry(0.52, 0.20, 0.03), mat4(-1.55, 2.30, hw + 0.03), SHADE.brass());
  bBrass.add(new THREE.CylinderGeometry(0.022, 0.022, 1.40, 6), mat4(-half - 0.06, 1.98, hw - 0.10), SHADE.brass());
}

/* ============================================================ 四节客车 */
function buildCars(bSteel, bBrass, bSnow) {
  const L = LAYOUT;
  const steel = SHADE.steel(0.85, 0.5);
  const half = L.CAR_LEN * 0.5;          // 4.65
  const hw = L.CAR_W * 0.5;              // 1.26
  const yFloor = L.CAR_FLOOR;            // 1.16  底架下缘
  const ySill = 1.34;                    // 地板上缘
  const yTop = L.CAR_TOP;                // 3.86  檐口
  const yRoof = L.CAR_ROOF;              // 4.26  拱顶
  const hx = L.WIN_HALF_X;               // 1.70  窗半宽
  const dx = L.WIN_DX;                   // 2.40  窗中心偏移
  const wy0 = L.WIN_Y0, wy1 = L.WIN_Y1;  // 1.72 .. 3.62
  const wallZ = hw - 0.04;               // 1.22
  const bodyZ = 1.05;

  for (let c = 0; c < 2; c++) {
    const ox = CAR_X[c];

    /* ---------- 底架 + 实心车体 ---------- */
    bSteel.add(new THREE.BoxGeometry(L.CAR_LEN + 0.06, ySill - yFloor, L.CAR_W - 0.24),
      mat4(ox, (yFloor + ySill) * 0.5, -0.06), steel);
    bSteel.add(new THREE.BoxGeometry(L.CAR_LEN, yTop - ySill, bodyZ + hw),
      mat4(ox, (ySill + yTop) * 0.5, (bodyZ - hw) * 0.5), steel);

    /* ---------- 近侧墙：两扇窗 → 底/顶两条通长板 + 三根立柱 ---------- */
    bSteel.add(new THREE.BoxGeometry(L.CAR_LEN, wy0 - ySill, 0.12),
      mat4(ox, (ySill + wy0) * 0.5, wallZ), steel);
    bSteel.add(new THREE.BoxGeometry(L.CAR_LEN, yTop - wy1, 0.12),
      mat4(ox, (wy1 + yTop) * 0.5, wallZ), steel);
    const endW = half - dx - hx;                       // 0.55 端柱
    bSteel.add(new THREE.BoxGeometry(endW, wy1 - wy0, 0.12),
      mat4(ox + half - endW * 0.5, (wy0 + wy1) * 0.5, wallZ), steel);
    bSteel.add(new THREE.BoxGeometry(endW, wy1 - wy0, 0.12),
      mat4(ox - half + endW * 0.5, (wy0 + wy1) * 0.5, wallZ), steel);
    const midW = dx * 2 - hx * 2;                      // 1.40 中间立柱
    bSteel.add(new THREE.BoxGeometry(midW, wy1 - wy0, 0.12),
      mat4(ox, (wy0 + wy1) * 0.5, wallZ), steel);
    /* 中间立柱上的竖向压肋，让立柱读得出来 */
    bSteel.add(new THREE.BoxGeometry(0.10, wy1 - wy0 + 0.10, 0.05), mat4(ox, (wy0 + wy1) * 0.5, wallZ + 0.08), steel);
    /* 腰线压条 */
    bSteel.add(new THREE.BoxGeometry(L.CAR_LEN - 0.10, 0.085, 0.10), mat4(ox, wy0 - 0.24, wallZ + 0.05), steel);
    /* 檐口硬边 */
    bSteel.add(new THREE.BoxGeometry(L.CAR_LEN + 0.08, 0.085, L.CAR_W + 0.12), mat4(ox, yTop + 0.02, 0), steel);

    /* ---------- 拱顶 ---------- */
    const archH = yRoof - yTop;
    const roofGeo = new THREE.CylinderGeometry(hw, hw, L.CAR_LEN, 18, 1, true, 0, Math.PI)
      .rotateZ(Math.PI * 0.5);
    roofGeo.scale(1, archH / hw, 1);
    bSteel.add(roofGeo, mat4(ox, yTop + 0.05, 0), steel);
    for (let s = -1; s <= 1; s += 2) {
      const capGeo = new THREE.CylinderGeometry(hw * 0.995, hw * 0.995, 0.06, 18, 1, true, 0, Math.PI)
        .rotateZ(Math.PI * 0.5);
      capGeo.scale(1, archH / hw, 1);
      bSteel.add(capGeo, mat4(ox + s * half, yTop + 0.05, 0), steel);
    }
    /* 车顶两个通风帽 */
    for (let v = -1; v <= 1; v += 2) {
      bSteel.add(new THREE.BoxGeometry(0.54, 0.14, 0.40), mat4(ox + v * 2.0, yRoof - 0.02, 0), steel);
    }

    /* ---------- 端门（每节一端一扇） ---------- */
    const doorX = ox + half - 0.30;
    bSteel.add(new THREE.BoxGeometry(0.46, yTop - ySill - 0.10, 0.055),
      mat4(doorX, (ySill + yTop) * 0.5, wallZ + 0.04), steel);
    bBrass.add(new THREE.BoxGeometry(0.26, 0.56, 0.030), mat4(doorX, 2.86, wallZ + 0.075), SHADE.brass());
    bSteel.add(new THREE.BoxGeometry(0.38, 0.055, 0.05), mat4(doorX, 1.38, wallZ + 0.05), steel);

    /* ---------- 两端山墙 + 车钩 + 风挡 ---------- */
    for (let s = -1; s <= 1; s += 2) {
      const ex = ox + s * half;
      bSteel.add(new THREE.BoxGeometry(0.06, yTop - ySill, 0.09), mat4(ex - s * 0.02, (ySill + yTop) * 0.5, 0.78), steel);
      bSteel.add(new THREE.BoxGeometry(0.06, yTop - ySill, 0.09), mat4(ex - s * 0.02, (ySill + yTop) * 0.5, -0.78), steel);
      bSteel.add(new THREE.BoxGeometry(0.30, 0.12, 0.12), mat4(ex + s * 0.17, 0.94, 0), steel);
      bSteel.add(new THREE.BoxGeometry(0.09, 0.32, 0.46), mat4(ex + s * 0.08, 0.94, 0), steel);
      /* 折棚风挡：让两节车厢之间那道缝里有东西 */
      bSteel.add(new THREE.BoxGeometry(0.10, 1.30, 1.32), mat4(ex + s * 0.13, 2.20, 0), steel);
    }

    /* ---------- 转向架：两组，轮对从下面露出来 ---------- */
    for (let bg = 0; bg < L.CAR_BOGIE.length; bg++) {
      const bx = ox + L.CAR_BOGIE[bg];
      bSteel.add(new THREE.BoxGeometry(1.20, 0.19, 1.72), mat4(bx, 0.96, 0), steel);
      for (let s = -1; s <= 1; s += 2) {
        bSteel.add(new THREE.BoxGeometry(1.30, 0.12, 0.10), mat4(bx, 0.78, s * 0.86), steel);
        for (let k = -1; k <= 1; k++) {
          bSteel.add(new THREE.BoxGeometry(0.19, 0.16, 0.12), mat4(bx + k * 0.36, 1.08, s * 0.86), steel);
        }
        for (let a = 0; a < L.CAR_BOGIE_AXLES.length; a++) {
          bSteel.add(new THREE.BoxGeometry(0.24, 0.22, 0.15),
            mat4(bx + L.CAR_BOGIE_AXLES[a], 0.78, s * 0.86), steel);
        }
      }
      bSteel.add(new THREE.BoxGeometry(0.32, 0.20, 1.22), mat4(bx, 1.08, 0), steel);
      bSteel.add(new THREE.CylinderGeometry(0.15, 0.15, 0.09, 10), mat4(bx, 1.19, 0), steel);
    }

    /* ---------- 黄铜：两扇窗各一圈细框（洞口 +8px 处） + 窗台 ---------- */
    const zf = wallZ + 0.02;
    const bw = 0.085;
    for (let w = -1; w <= 1; w += 2) {
      const wx = ox + w * dx;
      bBrass.add(new THREE.BoxGeometry(hx * 2 + bw * 2.2, bw, 0.10), mat4(wx, wy1 + bw * 0.6, zf), SHADE.brass());
      bBrass.add(new THREE.BoxGeometry(hx * 2 + bw * 2.2, bw, 0.10), mat4(wx, wy0 - bw * 0.6, zf), SHADE.brass());
      bBrass.add(new THREE.BoxGeometry(bw, wy1 - wy0 + bw * 2.2, 0.10), mat4(wx - hx - bw * 0.6, (wy0 + wy1) * 0.5, zf), SHADE.brass());
      bBrass.add(new THREE.BoxGeometry(bw, wy1 - wy0 + bw * 2.2, 0.10), mat4(wx + hx + bw * 0.6, (wy0 + wy1) * 0.5, zf), SHADE.brass());
      /* 窗台：卡片下沿压在这里 */
      bBrass.add(new THREE.BoxGeometry(hx * 2 + 0.46, 0.055, 0.16), mat4(wx, wy0 - 0.19, zf + 0.02), SHADE.brass());
    }
    bBrass.add(new THREE.CylinderGeometry(0.020, 0.020, 0.18, 6), mat4(doorX + 0.14, 2.36, wallZ + 0.09), SHADE.brass());
    for (let s = -1; s <= 1; s += 2) {
      bBrass.add(new THREE.BoxGeometry(L.CAR_LEN - 0.30, 0.030, 0.030), mat4(ox, yTop + archH * 0.58, s * 0.54), SHADE.brass());
    }

    /* ---------- 积雪：拱顶薄壳 + 檐口雪檐 + 底架薄雪 ---------- */
    const snowGeo = new THREE.CylinderGeometry(hw + 0.02, hw + 0.02, L.CAR_LEN - 0.24, 18, 1, true, 0.28, Math.PI - 0.56)
      .rotateZ(Math.PI * 0.5);
    snowGeo.scale(1, (archH + 0.035) / (hw + 0.02), 1);
    bSnow.add(snowGeo, mat4(ox, yTop + 0.055, 0), SHADE.flat());
    bSnow.add(new THREE.BoxGeometry(L.CAR_LEN - 0.16, 0.055, 0.11), mat4(ox, yTop + 0.065, hw + 0.03), SHADE.flat());
    for (let k = 0; k < 3; k++) {
      bSnow.add(new THREE.BoxGeometry(0.60, 0.045, 0.55), mat4(ox - 2.0 + k * 2.0, yRoof + 0.012, (k % 2 ? 0.42 : -0.36)), SHADE.flat());
    }
    bSnow.add(new THREE.BoxGeometry(L.CAR_LEN - 0.08, 0.035, L.CAR_W - 0.30), mat4(ox, ySill + 0.02, 0), SHADE.flat());
  }
}
/* ============================================================ 车窗玻璃几何
   4 个 quad 合并成一块几何，每个顶点带 aLit 属性（每帧按时间轴写）。
   这样一次 draw call 就能让四扇窗各自处于不同的点亮进度。 */
function buildGlass() {
  const L = LAYOUT;
  const n = 4;
  const pos = new Float32Array(n * 4 * 3);
  const nrm = new Float32Array(n * 4 * 3);
  const uv = new Float32Array(n * 4 * 2);
  const lit = new Float32Array(n * 4);
  const idx = new Uint16Array(n * 6);

  const hx = L.WIN_HALF_X, y0 = L.WIN_Y0, y1 = L.WIN_Y1, z = L.WIN_Z;
  for (let i = 0; i < n; i++) {
    const cx = WIN_SLOT_X[i];
    const o = i * 12;
    const xs = [cx - hx, cx + hx, cx + hx, cx - hx];
    const ys = [y0, y0, y1, y1];
    const su = [0, 1, 1, 0], sv = [0, 0, 1, 1];
    for (let k = 0; k < 4; k++) {
      pos[o + k * 3] = xs[k];
      pos[o + k * 3 + 1] = ys[k];
      pos[o + k * 3 + 2] = z;
      nrm[o + k * 3] = 0; nrm[o + k * 3 + 1] = 0; nrm[o + k * 3 + 2] = 1;
      uv[(i * 4 + k) * 2] = su[k];
      uv[(i * 4 + k) * 2 + 1] = sv[k];
    }
    const b = i * 4;
    idx[i * 6] = b; idx[i * 6 + 1] = b + 1; idx[i * 6 + 2] = b + 2;
    idx[i * 6 + 3] = b; idx[i * 6 + 4] = b + 2; idx[i * 6 + 5] = b + 3;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aLit', new THREE.BufferAttribute(lit, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}
/* ============================================================ 连杆几何
   三种杆各自在「起点」的姿态下建模，运行时只改 position / rotation.z：
     · 联动杆：平移（不转），沿 X 从最后动轮到最前动轮
     · 主连杆：绕曲柄销转，长度固定 MAIN_ROD
     · 活塞组：沿 X 平移 */
function buildRods() {
  const L = LAYOUT;
  const steel = SHADE.steel(0.5, 0);
  const brass = SHADE.brass();

  /* ---------- 联动杆（coupling rod）：一根带三个销座的扁杆 ---------- */
  const cb = new Batch(1.0);
  const ax = L.DRIVER_AXLES;
  const span = ax[0] - ax[2];              // 3.70
  const midX = (ax[0] + ax[2]) * 0.5;      // -0.70
  for (let s = -1; s <= 1; s += 2) {
    const z = s * L.ROD_Z;
    cb.add(new THREE.BoxGeometry(span + 0.56, 0.155, 0.075), mat4(midX, 0, z), steel);
    /* 两端的圆头 */
    cb.add(new THREE.CylinderGeometry(0.115, 0.115, 0.075, 12).rotateX(Math.PI * 0.5),
      mat4(ax[0] + 0.14, 0, z), steel);
    cb.add(new THREE.CylinderGeometry(0.115, 0.115, 0.075, 12).rotateX(Math.PI * 0.5),
      mat4(ax[2] - 0.14, 0, z), steel);
    /* 三个曲柄销（视觉上把杆「钉」在轮子上） */
    for (let i = 0; i < 3; i++) {
      cb.add(new THREE.CylinderGeometry(0.075, 0.075, 0.19, 10).rotateX(Math.PI * 0.5),
        mat4(ax[i], 0, z + s * 0.06), brass);
    }
    /* 杆中央的一道凸肋 */
    cb.add(new THREE.BoxGeometry(span - 0.4, 0.045, 0.045), mat4(midX, 0.085, z), steel);
  }
  const couplingGeo = cb.build(); couplingGeo.scale(1, LOCO_YS, 1);

  /* ---------- 主连杆（main rod）：从曲柄销到十字头 ---------- */
  const mb = new Batch(1.0);
  for (let s = -1; s <= 1; s += 2) {
    const z = s * (L.ROD_Z + 0.10);
    mb.add(new THREE.BoxGeometry(L.MAIN_ROD, 0.135, 0.070), mat4(L.MAIN_ROD * 0.5, 0, z), steel);
    /* 两端的大端 / 小端 */
    mb.add(new THREE.CylinderGeometry(0.125, 0.125, 0.075, 12).rotateX(Math.PI * 0.5), mat4(0.02, 0, z), steel);
    mb.add(new THREE.CylinderGeometry(0.092, 0.092, 0.070, 10).rotateX(Math.PI * 0.5), mat4(L.MAIN_ROD - 0.05, 0, z), steel);
    /* 杆身中间的开槽感（一条暗肋） */
    mb.add(new THREE.BoxGeometry(L.MAIN_ROD - 0.34, 0.048, 0.030), mat4(L.MAIN_ROD * 0.5, 0.075, z), steel);
  }
  const mainGeo = mb.build(); mainGeo.scale(LOCO_YS, LOCO_YS, 1);

  /* ---------- 活塞组：十字头 + 活塞杆 ---------- */
  const pb = new Batch(1.0);
  for (let s = -1; s <= 1; s += 2) {
    const z = s * L.ROD_Z;
    /* 十字头（沿滑板滑动的滑块） */
    pb.add(new THREE.BoxGeometry(0.22, 0.20, 0.20), mat4(0, 0, z), steel);
    pb.add(new THREE.BoxGeometry(0.10, 0.26, 0.24), mat4(-0.06, 0, z), steel);
    /* 活塞杆：向前插进汽缸 */
    pb.add(new THREE.CylinderGeometry(0.048, 0.048, 0.72, 8).rotateZ(-Math.PI * 0.5),
      mat4(0.40, 0, z), steel);
    /* 十字头销 */
    pb.add(new THREE.CylinderGeometry(0.055, 0.055, 0.26, 8).rotateX(Math.PI * 0.5),
      mat4(0.0, 0, z), brass);
  }
  const pistonGeo = pb.build(); pistonGeo.scale(LOCO_YS, LOCO_YS, 1);

  return { couplingGeo, mainGeo, pistonGeo };
}

/* ============================================================ 小工具 */
const _tmpE = new THREE.Euler();

function mat4(x, y, z, rx, ry, rz) {
  const m = new THREE.Matrix4();
  _tmpE.set(rx || 0, ry || 0, rz || 0);
  m.makeRotationFromEuler(_tmpE);
  m.setPosition(x || 0, y || 0, z || 0);
  return m;
}

function lathe(pts, seg) {
  const v = [];
  for (let i = 0; i < pts.length; i++) v.push(new THREE.Vector2(pts[i][0], pts[i][1]));
  return new THREE.LatheGeometry(v, seg);
}

/* ============================================================ 工厂 */
/**
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 */
export function createTrain(scene, renderer, tierName) {
  const L = LAYOUT;
  const root = new THREE.Group();
  root.name = 'trainRoot';
  const nod = new THREE.Group();
  nod.name = 'trainNod';
  root.add(nod);

  const locoGroup = new THREE.Group();
  locoGroup.position.x = LOCO_GROUP_X;
  locoGroup.position.y = LOCO_YO;
  locoGroup.scale.y = LOCO_YS;
  nod.add(locoGroup);

  const carsGroup = new THREE.Group();
  carsGroup.position.y = CARS_YO;
  carsGroup.scale.y = CARS_YS;
  nod.add(carsGroup);

  /* ---------------- 贴图与材质 ---------------- */
  const steelSet = makeSteelSet(512);
  const coalMap = makeCoalMap(128);
  steelSet.map.repeat.set(1, 1);

  const matSteel = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x2f4052),
    metalness: 0.22,
    roughness: 0.55,
    map: steelSet.map,
    normalMap: steelSet.normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    vertexColors: true,
    envMapIntensity: 0.9,
  });
  const matBrass = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xba9046),
    metalness: 0.42,
    roughness: 0.34,
    map: steelSet.map,
    normalMap: steelSet.normalMap,
    normalScale: new THREE.Vector2(0.5, 0.5),
    vertexColors: true,
    envMapIntensity: 1.25,
  });
  const matSnow = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xf2f7fb),
    metalness: 0.06,
    roughness: 0.86,
    vertexColors: true,
    envMapIntensity: 0.55,
  });
  const matCoal = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x1b2027),
    metalness: 0.30,
    roughness: 0.94,
    map: coalMap,
    vertexColors: false,
    envMapIntensity: 0.35,
  });
  const matWood = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x231a15),
    metalness: 0.10,
    roughness: 0.92,
    envMapIntensity: 0.30,
  });
  const matWheel = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x2a3a46),
    metalness: 0.24,
    roughness: 0.52,
    vertexColors: true,
    envMapIntensity: 1.1,
  });

  /* ---------------- 建几何 ---------------- */
  const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);

  const lbSteel = new Batch(1.5);
  buildLocoSteel(lbSteel);
  const locoSteelGeo = lbSteel.build();

  const lbBrass = new Batch(2.6);
  buildLocoBrass(lbBrass);
  const locoBrassGeo = lbBrass.build();

  const lbSnow = new Batch(2.0);
  buildLocoSnow(lbSnow);
  const locoSnowGeo = lbSnow.build();


  const cbS = new Batch(1.5), cbB = new Batch(2.6), cbN = new Batch(2.0);
  buildCars(cbS, cbB, cbN);
  const carSteelGeo = cbS.build();
  const carBrassGeo = cbB.build();
  const carSnowGeo = cbN.build();

  /* 机车的钢件和煤水车/客车的钢件共用材质，但分两个父节点（机车要点头）
     —— 其实点头给的是整列车，所以这里可以把它们合并进同一个组。
     保留两个组是为了以后机车单独做悬挂时不至于重构。 */
  const mk = function (geo, mat, parent) {
    const m = new THREE.Mesh(geo, mat);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    parent.add(m);
    return m;
  };

  const meshLocoSteel = mk(locoSteelGeo, matSteel, locoGroup); meshLocoSteel.name = 'locoSteel';
  const meshLocoBrass = mk(locoBrassGeo, matBrass, locoGroup); meshLocoBrass.name = 'locoBrass';
  const meshLocoSnow = mk(locoSnowGeo, matSnow, locoGroup); meshLocoSnow.name = 'locoSnow';
  const meshCarSteel = mk(carSteelGeo, matSteel, carsGroup); meshCarSteel.name = 'carSteel';
  const meshCarBrass = mk(carBrassGeo, matBrass, carsGroup); meshCarBrass.name = 'carBrass';
  const meshCarSnow = mk(carSnowGeo, matSnow, carsGroup); meshCarSnow.name = 'carSnow';

  /* ---------------- 车窗玻璃 ---------------- */
  const glassGeo = buildGlass();
  const glassMat = new THREE.ShaderMaterial({
    uniforms: {
      uWarm: { value: new THREE.Color(PAL.lamp) },
      uWarmHot: { value: new THREE.Color(PAL.lampHot) },
      uDark: { value: new THREE.Color(0x070d13) },
      uExposure: { value: 1 },
    },
    vertexShader: GLASS_VERT,
    fragmentShader: GLASS_FRAG,
  });
  const glassMesh = new THREE.Mesh(glassGeo, glassMat);
  glassMesh.matrixAutoUpdate = false;
  glassMesh.name = 'glass';
  carsGroup.add(glassMesh);
  const litAttr = glassGeo.attributes.aLit;
  const litArr = litAttr.array;
  let litStamp = -1;

  /* ---------------- 车轮（InstancedMesh，32 个） ---------------- */
  const wheelGeo = buildWheelUnit();
  const wheelList = buildWheelList();
  const wheelCount = wheelList.length / 3;
  const wheels = new THREE.InstancedMesh(wheelGeo, matWheel, wheelCount * 2);
  wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  wheels.frustumCulled = false;
  nod.add(wheels);
  const wheelMatArr = wheels.instanceMatrix.array;
  /* 热循环里直接写矩阵，不需要 Matrix4 对象 */
  const wheelCountAll = wheelCount * 2;

  /* ---------------- 连杆 ---------------- */
  const rods = buildRods();
  const couplingMesh = new THREE.Mesh(rods.couplingGeo, matSteel);
  const mainMesh = new THREE.Mesh(rods.mainGeo, matSteel);
  const pistonMesh = new THREE.Mesh(rods.pistonGeo, matSteel);
  couplingMesh.frustumCulled = false;
  mainMesh.frustumCulled = false;
  pistonMesh.frustumCulled = false;
  nod.add(couplingMesh);
  nod.add(mainMesh);
  nod.add(pistonMesh);

  /* ---------------- 车头灯（灯片 + 光锥 + 点光） ---------------- */
  const lensGeo = new THREE.CircleGeometry(0.195, 18);
  const lensMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PAL.lampHot) });
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.position.set(4.945, 2.94, 0);
  lens.rotation.y = Math.PI * 0.5;
  locoGroup.add(lens);

  /* 点光：唯一那个「暖」的实体光源 */
  const headLight = new THREE.PointLight(0xffb257, 7.0, 26, 2.0);
  headLight.position.set(5.4, 2.94, 0);
  locoGroup.add(headLight);

  /* 体积光锥：一个沿 +X 张开的锥体，加色混合。
     vT 在着色器里按 position.x 归一化，所以这里把 x 压到 0..1，
     再用 mesh.scale.x 把长度还原成 9.5 —— 这样片元里能拿到干净的 0..1 参数。 */
  const CONE_LEN = 6.4;
  const coneGeo = new THREE.ConeGeometry(1.70, CONE_LEN, 12, 1, true);
  coneGeo.translate(0, -CONE_LEN * 0.5, 0);
  coneGeo.rotateZ(Math.PI * 0.5);
  coneGeo.scale(1 / CONE_LEN, 1, 1);
  const coneMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffc176) },
      uPower: { value: 0.22 },
      uExposure: { value: 1 },
    },
    vertexShader: CONE_VERT,
    fragmentShader: CONE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.position.set(5.0, 2.94, 0);
  cone.scale.set(CONE_LEN, 1, 1);
  cone.frustumCulled = false;
  locoGroup.add(cone);

  scene.add(root);

  /* ---------------- ANSI 状态 ---------------- */
  const chimneyWorld = new THREE.Vector3();
  const winWorld = [];
  const winWorldEdgeX = [];
  const winWorldEdgeY = [];
  for (let i = 0; i < 4; i++) {
    winWorld.push(new THREE.Vector3());
    winWorldEdgeX.push(new THREE.Vector3());
    winWorldEdgeY.push(new THREE.Vector3());
  }

  const headLightBase = headLight.intensity;
  const lensBase = lensMat.color.clone();
  let coneEnabled = true;

  const buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;

  /* ============================================================ 每帧更新 */

  /**
   * @param {object} S 共享状态（见 index.js）：S.trainX / S.wheelAngle / S.lit[]
   * @param {number} tSec
   */
  function update(S, tSec) {
    root.position.x = S.trainX;
    /* 点头：整列车一个极小的 pitch，收尾的「点头」就靠它 */
    nod.rotation.z = S.nodPitch;

    /* ---- 车轮：θ 由位移唯一决定，绝不另开相机 ---- */
    const theta = S.wheelAngle;
    const c = Math.cos(theta), s = Math.sin(theta);
    let e = 0;
    for (let i = 0; i < wheelCount; i++) {
      const wx = wheelList[i * 3], wy = wheelList[i * 3 + 1], wr = wheelList[i * 3 + 2];
      for (let side = -1; side <= 1; side += 2) {
        const o = e * 16;
        const rr = wr;
        wheelMatArr[o] = c * rr;
        wheelMatArr[o + 1] = s * rr;
        wheelMatArr[o + 2] = 0;
        wheelMatArr[o + 3] = 0;
        wheelMatArr[o + 4] = -s * rr;
        wheelMatArr[o + 5] = c * rr;
        wheelMatArr[o + 6] = 0;
        wheelMatArr[o + 7] = 0;
        wheelMatArr[o + 8] = 0;
        wheelMatArr[o + 9] = 0;
        wheelMatArr[o + 10] = rr;
        wheelMatArr[o + 11] = 0;
        wheelMatArr[o + 12] = wx;
        wheelMatArr[o + 13] = wy;
        wheelMatArr[o + 14] = side * L.WHEEL_Z;
        wheelMatArr[o + 15] = 1;
        e++;
      }
    }
    wheels.instanceMatrix.needsUpdate = true;

    /* ---- 联动杆：跟着曲柄销做圆周平移 ---- */
    const LS = LOCO_YS, LO = LOCO_YO;
    const rc = L.CRANK_R;
    const axleY = TRACK.railTop + L.DRIVER_R * LS + LO;
    const meanAx = (L.DRIVER_AXLES[0] + L.DRIVER_AXLES[2]) * 0.5;
    couplingMesh.position.set(
      LOCO_GROUP_X + meanAx + rc * c,
      axleY + rc * LS * s,
      0,
    );

    /* ---- 主连杆：销 → 十字头 ---- */
    const pinAx = L.DRIVER_AXLES[0];
    const pinX = LOCO_GROUP_X + pinAx + rc * c;
    const pinY = axleY + rc * LS * s;
    const crossY = L.CROSS_Y * LS + LO;
    /* 滑块-曲柄解析解：杆长固定，十字头只能沿水平中线滑 */
    let dyv = crossY - pinY;
    let inner = (L.MAIN_ROD * LS) * (L.MAIN_ROD * LS) - dyv * dyv;
    if (inner < 0.0001) inner = 0.0001;
    const crossX = pinX + Math.sqrt(inner);
    const dx = crossX - pinX;
    const ang = Math.atan2(crossY - pinY, dx);
    mainMesh.position.set(pinX, pinY, 0);
    mainMesh.rotation.z = ang;
    /* 主连杆几何是从原点沿 +X 建的，长度 MAIN_ROD，正好对上 */
    pistonMesh.position.set(LOCO_GROUP_X + crossX, crossY, 0);

    /* ---- 车窗点亮 ---- */
    const lit0 = S.lit[0], lit1 = S.lit[1], lit2 = S.lit[2], lit3 = S.lit[3];
    if (
      lit0 !== S._lastLit0 || lit1 !== S._lastLit1 ||
      lit2 !== S._lastLit2 || lit3 !== S._lastLit3 ||
      litStamp < 0
    ) {
      S._lastLit0 = lit0; S._lastLit1 = lit1;
      S._lastLit2 = lit2; S._lastLit3 = lit3;
      litStamp = 0;
      for (let i = 0; i < 4; i++) {
        const v = S.lit[i];
        for (let k = 0; k < 4; k++) litArr[i * 4 + k] = v;
      }
      litAttr.needsUpdate = true;
    }

    /* ---- 车头灯强度（随点亮程度和曝光呼吸一起抖） ---- */
    const flick = 1 + 0.035 * Math.sin(tSec * 11.3) * Math.sin(tSec * 3.1);
    headLight.intensity = headLightBase * S.exposure * flick;
    lensMat.color.copy(lensBase).multiplyScalar(0.85 + 0.25 * S.exposure);
    coneMat.uniforms.uPower.value = (coneEnabled ? 0.22 : 0) * S.exposure;

    /* ---- 供蒸汽/雪地用的世界坐标 ---- */
    /* chimney / lamp 都是 locoGroup 的子物，locoGroup 相对 nod 只差一个平移，
       nod 只绕 Z 转一个极小角，用解析位置足够（误差 < 1e-3）。 */
    S.chimneyX = S.trainX + LOCO_GROUP_X + LAYOUT.CHIMNEY_X;
    S.chimneyY = (LAYOUT.CHIMNEY_TOP - 0.22) * LOCO_YS + LOCO_YO;
    S.domeX = S.trainX + LOCO_GROUP_X + LAYOUT.DOME_X;
    S.domeY = 3.66 * LOCO_YS + LOCO_YO;
    headLightWorldX = S.trainX + LOCO_GROUP_X + 4.95;
    S.lampY = 2.94 * LOCO_YS + LOCO_YO;

    /* ---- 车窗世界坐标（锚点投影用） ---- */
    for (let i = 0; i < 4; i++) {
      const cx = WIN_SLOT_X[i] + S.trainX;
      const wy = WINDOW_LOCAL.y * CARS_YS + CARS_YO;
      winWorld[i].set(cx, wy, WINDOW_LOCAL.z);
      winWorldEdgeX[i].set(cx + WINDOW_LOCAL.halfW, wy, WINDOW_LOCAL.z);
      winWorldEdgeY[i].set(cx, wy + WINDOW_LOCAL.halfH * CARS_YS, WINDOW_LOCAL.z);
    }
  }
  let headLightWorldX = 0;

  return {
    root,
    update,
    winWorld,
    winWorldEdgeX,
    winWorldEdgeY,
    get chimney() { return chimneyWorld; },
    get headLightX() { return headLightWorldX; },
    headLight,
    cone,
    lens,
    glassMat,
    buildMs,
    setConeEnabled(v) { coneEnabled = !!v; cone.visible = coneEnabled; },
    setExposure(e) { glassMat.uniforms.uExposure.value = e; },
    dispose() {
      scene.remove(root);
      steelSet.dispose();
      coalMap.dispose();
      const mats = [matSteel, matBrass, matSnow, matCoal, matWood, matWheel, glassMat, lensMat, coneMat];
      for (let i = 0; i < mats.length; i++) mats[i].dispose();
      const geos = [
        locoSteelGeo, locoBrassGeo, locoSnowGeo, carSteelGeo, carBrassGeo, carSnowGeo,
        glassGeo, wheelGeo, rods.couplingGeo, rods.mainGeo, rods.pistonGeo,
        lensGeo, coneGeo,
      ];
      for (let i = 0; i < geos.length; i++) if (geos[i]) geos[i].dispose();
      void renderer;
      void wheelCountAll;
    },
  };
}

