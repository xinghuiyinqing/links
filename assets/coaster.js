/* ==========================================================================
   Glasskinetics —— 透明玻璃过山车（纯 canvas 2D 手写软件 3D，零依赖）
   --------------------------------------------------------------------------
   哲学: 轨道是一条闭合的三维样条, 玻璃质感靠「三层描边」叠出体积:
         外层柔光晕(体积感) -> 中层半透光体 -> 内核高光(厚度)。远处按景深
         向天空色雾化, 近处补一条锐利高光 —— 玻璃的"薄"和"厚"都靠这三层说。
   每帧是 (时间, 相机) 的纯函数, 所以不会抖; prefers-reduced-motion 下只画一帧。
   ========================================================================== */
(function () {
  'use strict';

  var cvs = document.getElementById('coaster');
  if (!cvs || !cvs.getContext) return;
  var ctx = cvs.getContext('2d');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var W = 0, H = 0, DPR = 1;

  // 天空渐变是静态的, 每帧重建一遍全屏渐变很贵 -> 缓存成离屏画布
  var skyCv = document.createElement('canvas'), skyCtx = skyCv.getContext('2d');
  // 云要漂移, 但没必要按全分辨率算 -> 1/4 分辨率画完再放大
  var clCv = document.createElement('canvas'), clCtx = clCv.getContext('2d');

  /* ---------------------------------------------------------------- 三维工具 */
  function v3(x, y, z) { return { x: x, y: y, z: z }; }
  function sub(a, b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
  function add(a, b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
  function mul(a, s) { return v3(a.x * s, a.y * s, a.z * s); }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function cross(a, b) {
    return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
  function norm(a) {
    var l = Math.sqrt(dot(a, a)) || 1;
    return v3(a.x / l, a.y / l, a.z / l);
  }
  function lerp(a, b, k) { return a + (b - a) * k; }

  /* ---------------------------------------------------------------- 轨道控制点
     闭合回路: 两个高坡 + 一个下沉弯 + 一段外圈。坐标单位随意, 相机距离按它调。 */
  var CTRL = [
    [ 0.0, 2.55, -3.30],
    [ 2.35, 0.85, -2.85],
    [ 3.55, 2.90, -0.55],
    [ 2.15, 0.35,  2.35],
    [ 0.15, 3.15,  3.35],
    [-2.30, 0.55,  2.10],
    [-3.50, 2.60, -0.75],
    [-2.05, 0.30, -2.95]
  ];

  // 闭合 Catmull-Rom: 均匀采样成折线
  function catmullRom(pts, samples) {
    var n = pts.length, out = [], i, j, t;
    for (i = 0; i < samples; i++) {
      var u = i / samples * n;
      var seg = Math.floor(u) % n;
      t = u - Math.floor(u);
      var p0 = pts[(seg - 1 + n) % n], p1 = pts[seg],
          p2 = pts[(seg + 1) % n], p3 = pts[(seg + 2) % n];
      var t2 = t * t, t3 = t2 * t;
      out.push(v3(
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
               (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
               (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
               (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
               (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        0.5 * ((2 * p1[2]) + (-p0[2] + p2[2]) * t +
               (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 +
               (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3)
      ));
    }
    return out;
  }

  var N = 380;                                  // 采样数（够顺滑又不吃性能）
  var CURVE = catmullRom(CTRL, N);

  // 每个采样点的局部标架: 切线 / 侧向(右) / 上向，并带一点倾角(banking)更像过山车
  var FRAME = [];
  for (var i = 0; i < N; i++) {
    var prev = CURVE[(i - 1 + N) % N], next = CURVE[(i + 1) % N];
    var tang = norm(sub(next, prev));
    var up0 = v3(0, 1, 0);
    var side0 = norm(cross(tang, up0));
    // 曲率近似: 用前后切线的夹角决定倾角
    var tang2 = norm(sub(CURVE[(i + 2) % N], CURVE[i]));
    var bend = cross(tang, tang2).y;            // 水平转弯量
    var bank = Math.max(-0.55, Math.min(0.55, bend * 6.5));
    var up = norm(add(mul(up0, Math.cos(bank)), mul(side0, Math.sin(bank))));
    var side = norm(cross(tang, up));
    FRAME.push({ t: tang, s: side, u: up });
  }

  /* ---------------------------------------------------------------- 相机 */
  var cam = { yaw: 0.6, pitch: -0.1, dist: 9.4, hy: 3.2, focal: 1 };

  function project(p) {
    // 先平移到相机逆变换: 绕 Y 转 -yaw, 再绕 X 转 -pitch
    var dx = p.x, dy = p.y - cam.hy, dz = p.z;
    var cy = Math.cos(-cam.yaw), sy = Math.sin(-cam.yaw);
    var x1 = dx * cy - dz * sy, z1 = dx * sy + dz * cy;
    var cp = Math.cos(-cam.pitch), sp = Math.sin(-cam.pitch);
    var y2 = dy * cp - z1 * sp, z2 = dy * sp + z1 * cp;
    var zc = z2 + cam.dist;                     // 相机在 +dist 处看向原点
    if (zc < 0.35) return null;                 // 在相机后面
    var f = cam.focal / zc;
    return { x: W * 0.5 + x1 * f, y: H * 0.34 - y2 * f, z: zc, s: f };
  }

  /* ---------------------------------------------------------------- 玻璃笔触 */
  var SKY = [232, 244, 255];
  function fog(z) {                            // 越远越淡、越接近天空色
    var k = Math.max(0, Math.min(1, (z - 6) / 16));
    return 1 - k * 0.60;
  }
  function skyMix(a, k) {
    return 'rgba(' +
      Math.round(lerp(255, SKY[0], 1 - k)) + ',' +
      Math.round(lerp(255, SKY[1], 1 - k)) + ',' +
      Math.round(lerp(255, SKY[2], 1 - k)) + ',' + a + ')';
  }

  // 一条玻璃管 —— 真管子的画法：
  //   1) 沿线段法线在【两侧各画一条深蓝边】 —— 这才是轮廓, 单条描边叠层会被上层盖掉
  //   2) 中心填淡蓝的透光体
  //   3) 再补一条偏上的白色高光(光源在上方)
  //   4) 外面罩一层很淡的蓝晕当体积
  function seg(x1, y1, x2, y2) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  function glassRail(x1, y1, x2, y2, w, f) {
    if (!(w > 0.15)) return;
    var dx = x2 - x1, dy = y2 - y1;
    var L = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / L, ny = dx / L;
    var off = w * 1.02;
    ctx.lineCap = 'round';

    // ① 外晕
    ctx.strokeStyle = 'rgba(118,176,236,' + (0.075 * f) + ')';
    ctx.lineWidth = w * 3.4;
    seg(x1, y1, x2, y2);

    // ② 两条深蓝轮廓边
    ctx.strokeStyle = 'rgba(44,102,178,' + (0.74 * f) + ')';
    ctx.lineWidth = Math.max(0.9, w * 0.95);
    seg(x1 + nx * off, y1 + ny * off, x2 + nx * off, y2 + ny * off);
    seg(x1 - nx * off, y1 - ny * off, x2 - nx * off, y2 - ny * off);

    // ③ 中间透光体
    ctx.strokeStyle = 'rgba(172,212,250,' + (0.55 * f) + ')';
    ctx.lineWidth = Math.max(0.7, w * 1.45);
    seg(x1, y1, x2, y2);

    // ④ 偏上的白色高光
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.96 * f) + ')';
    ctx.lineWidth = Math.max(0.6, w * 0.52);
    var hx = nx * off * 0.34, hy = ny * off * 0.34 - w * 0.26;
    seg(x1 + hx, y1 + hy, x2 + hx, y2 + hy);
  }

  /* ---------------------------------------------------------------- 画一帧 */
  var RAIL_GAP = 0.20;      // 双轨间距
  var TRAIN_CARS = 5;
  var TRAIN_LEN = 0.052;    // 车长占总弧长比例

  function draw(tSec) {
    // --- 天空（缓存） ---
    ctx.drawImage(skyCv, 0, 0, W, H);

    // --- 云气（1/4 分辨率离屏 -> 放大） ---
    var q = 4, qw = Math.max(1, Math.round(W / q)), qh = Math.max(1, Math.round(H / q));
    if (clCv.width !== qw || clCv.height !== qh) { clCv.width = qw; clCv.height = qh; }
    clCtx.clearRect(0, 0, qw, qh);
    var drift = tSec * 6;
    for (var c = 0; c < 3; c++) {
      var cxp = ((c * 0.41 + 0.12) * qw + drift * (0.4 + c * 0.2) / q) % (qw * 1.4) - qw * 0.2;
      var cyp = qh * (0.16 + c * 0.09);
      var rr = Math.max(qw, qh) * (0.30 + c * 0.11);
      var rg = clCtx.createRadialGradient(cxp, cyp, 0, cxp, cyp, rr);
      rg.addColorStop(0, 'rgba(255,255,255,' + (0.55 - c * 0.12) + ')');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      clCtx.fillStyle = rg;
      clCtx.fillRect(0, 0, qw, qh);
    }
    ctx.drawImage(clCv, 0, 0, qw, qh, 0, 0, W, H);

    // --- 相机: 极慢环绕 + 轻微呼吸 ---
    cam.yaw = 0.6 + Math.sin(tSec * 0.055) * 0.42;
    cam.pitch = -0.085 + Math.sin(tSec * 0.041 + 1.1) * 0.035;
    cam.focal = Math.min(W, H) * 1.55;

    // --- 投影所有采样点 ---
    var projL = [], projR = [], projC = [];
    for (var i = 0; i < N; i++) {
      var p = CURVE[i], fr = FRAME[i];
      var pl = add(p, mul(fr.s, RAIL_GAP));
      var pr = add(p, mul(fr.s, -RAIL_GAP));
      projC.push(project(p));
      projL.push(project(pl));
      projR.push(project(pr));
    }

    // --- 组装绘制段, 按深度从远到近 ---
    var segs = [];
    for (var i = 0; i < N; i++) {
      var j = (i + 1) % N;
      var a = projL[i], b = projL[j], c2 = projR[i], d2 = projR[j], m = projC[i];
      if (!a || !b || !c2 || !d2 || !m) continue;
      segs.push({ i: i, z: (a.z + b.z + c2.z + d2.z) * 0.25,
                  a: a, b: b, c: c2, d: d2, m: m });
    }
    segs.sort(function (p, q) { return q.z - p.z; });

    // --- 玻璃轨道 ---
    for (var k = 0; k < segs.length; k++) {
      var s0 = segs[k];
      var f = fog(s0.z);
      // 线宽 = 透视比例 x 世界厚度。
      // 原来这里多乘了个 12，轨道被画粗 12 倍，外晕层到 117px
      // —— 那不是线，是一层淡蓝雾，所以怎么调都看不清。
      var w = 0.058 * s0.m.s;
      glassRail(s0.a.x, s0.a.y, s0.b.x, s0.b.y, w, f);
      glassRail(s0.c.x, s0.c.y, s0.d.x, s0.d.y, w, f);

      // 枕木: 每 7 段一根
      if (s0.i % 7 === 0) {
        ctx.strokeStyle = 'rgba(74,134,204,' + (0.5 * f) + ')';
        ctx.lineWidth = Math.max(0.6, w * 0.55);
        ctx.beginPath();
        ctx.moveTo(s0.a.x, s0.a.y);
        ctx.lineTo(s0.c.x, s0.c.y);
        ctx.stroke();
      }
    }

    // --- 车厢 (沿弧长前进) ---
    var head = (tSec * 0.045) % 1;              // 每秒走 4.5% 全程
    var cars = [];
    for (var n2 = 0; n2 < TRAIN_CARS; n2++) {
      var u = (head - n2 * TRAIN_LEN + 1) % 1;
      var idx = Math.floor(u * N) % N;
      var pc = projC[idx];
      if (!pc) continue;
      cars.push({ p: pc, idx: idx, n: n2 });
    }
    cars.sort(function (p, q) { return q.p.z - p.p.z; });

    for (var ci = 0; ci < cars.length; ci++) {
      var car = cars[ci], pt = car.p, fz = fog(pt.z);
      var sc = pt.s * 0.9;
      var cw = Math.max(4, 0.42 * sc);
      var ch = Math.max(3, 0.28 * sc);

      ctx.save();
      ctx.translate(pt.x, pt.y);
      // 车身: 玻璃质感的圆角胶囊
      var bodyG = ctx.createLinearGradient(0, -ch * 0.5, 0, ch * 0.5);
      bodyG.addColorStop(0, 'rgba(255,255,255,' + (0.95 * fz) + ')');
      bodyG.addColorStop(0.55, 'rgba(178,215,255,' + (0.72 * fz) + ')');
      bodyG.addColorStop(1, 'rgba(120,170,235,' + (0.55 * fz) + ')');
      roundRect(-cw * 0.5, -ch * 0.5, cw, ch, ch * 0.5);
      ctx.fillStyle = bodyG;
      ctx.fill();
      // 边缘高光
      ctx.strokeStyle = 'rgba(64,124,196,' + (0.55 * fz) + ')';
      ctx.lineWidth = Math.max(0.6, sc * 0.85);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.95 * fz) + ')';
      ctx.lineWidth = Math.max(0.4, sc * 0.35);
      ctx.stroke();
      // 顶部一条锐利反光
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.95 * fz) + ')';
      ctx.lineWidth = Math.max(0.4, sc * 0.35);
      ctx.beginPath();
      ctx.moveTo(-cw * 0.32, -ch * 0.22);
      ctx.lineTo(cw * 0.20, -ch * 0.30);
      ctx.stroke();
      // 头车给一点暖光, 像是车灯
      if (car.n === 0) {
        var lg = ctx.createRadialGradient(0, 0, 0, 0, 0, cw * 1.5);
        lg.addColorStop(0, 'rgba(255,236,196,' + (0.55 * fz) + ')');
        lg.addColorStop(1, 'rgba(255,236,196,0)');
        ctx.fillStyle = lg;
        ctx.beginPath(); ctx.arc(0, 0, cw * 1.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /* ---------------------------------------------------------------- 尺寸 / 循环 */
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = cvs.clientWidth || window.innerWidth;
    H = cvs.clientHeight || window.innerHeight;
    cvs.width = Math.round(W * DPR);
    cvs.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    // 重建天空缓存（按 CSS 像素尺寸）
    skyCv.width = Math.max(1, Math.round(W));
    skyCv.height = Math.max(1, Math.round(H));
    var g = skyCtx.createLinearGradient(0, 0, 0, skyCv.height);
    g.addColorStop(0, '#f2f9ff');
    g.addColorStop(0.45, '#e4f1ff');
    g.addColorStop(1, '#d3e8ff');
    skyCtx.fillStyle = g;
    skyCtx.fillRect(0, 0, skyCv.width, skyCv.height);
  }

  var raf = 0, t0 = 0, running = true;

  function loop(ms) {
    if (!running) return;
    if (!t0) t0 = ms;
    draw((ms - t0) / 1000);
    raf = window.requestAnimationFrame(loop);
  }

  function start() {
    resize();
    if (reduce) { draw(12.0); return; }        // 关动画时画一帧静态的
    raf = window.requestAnimationFrame(loop);
  }

  // 页面进后台就停, 省电
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      running = false;
      window.cancelAnimationFrame(raf);
    } else if (!reduce) {
      running = true;
      t0 = 0;
      raf = window.requestAnimationFrame(loop);
    }
  });

  var rt = 0;
  window.addEventListener('resize', function () {
    window.clearTimeout(rt);
    rt = window.setTimeout(function () { resize(); if (reduce) draw(12.0); }, 180);
  }, { passive: true });

  start();
})();
