/* ==========================================================================
   GLASS COASTER —— 透明玻璃过山车（canvas 2D 手工 3D，零依赖）
   --------------------------------------------------------------------------
   性能策略（这一版的核心，之前卡就卡在这里）：
     1) 路径批量化：不再"每段 4 次 stroke"（旧版 380 段 × 2 轨 × 4 ≈ 3000+ 次调用），
        改成按深度分 BAND 层，每层把同一种描边合并成一个 Path2D 只 stroke 一次。
        整条轨道 ≈ BAND × 4 + 枕木 + 支撑 ≈ 70 次 stroke。
     2) 分层缓存：天空/地面/支撑/轨道都是"相机 + 尺寸"的函数，缓存进离屏画布，
        最高 30Hz 重建（相机只是极慢漂移，肉眼看不出来）；主画布每帧只贴图 + 动态层。
     3) 动态层只留便宜的东西：车厢、流动高光、尘埃。

   玻璃的读法：浅色背景上纯白描边等于隐形。必须靠【偏深的蓝轮廓边】立住轮廓，
   中间填淡蓝透光体，再补一条偏上的白色高光 —— 四条线才有"管子"的体积。
   ========================================================================== */
(function () {
  'use strict';

  var cvs = document.getElementById('coaster');
  if (!cvs || !cvs.getContext) return;
  var ctx = cvs.getContext('2d');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var W = 0, H = 0, DPR = 1;

  // ══════════════════════════════════════════════════════════════════════════
  //  ★ 背景里那四个"会动的东西"的总开关。
  //    用户要求删掉：车厢 / 流动高光 / 尘埃 / 相机漂移。
  //    全部 false -> 背景是一张完全静止的玻璃过山车（也顺带最省电）。
  //    想恢复哪一个，把对应项改成 true 即可，代码都还在。
  // ══════════════════════════════════════════════════════════════════════════
  var FX = {
    train: false,        // 沿轨道跑的车厢
    pulse: false,        // 沿轨道跑的高光
    motes: false,        // 漂浮尘埃
    cameraDrift: false   // 相机缓慢环绕
  };
  var ANY_FX = FX.train || FX.pulse || FX.motes || FX.cameraDrift;

  /* ---------------------------------------------------------------- 三维工具 */
  function v3(x, y, z) { return { x: x, y: y, z: z }; }
  function sub(a, b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
  function add(a, b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
  function mul(a, s) { return v3(a.x * s, a.y * s, a.z * s); }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function cross(a, b) {
    return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
  function norm(a) { var l = Math.sqrt(dot(a, a)) || 1; return v3(a.x / l, a.y / l, a.z / l); }

  /* ---------------------------------------------------------------- 轨道
     一条真过山车的走法：提升坡 -> 俯冲 -> 谷底 -> 驼峰 -> 最高点 -> 侧倾弯 -> 回环 */
  var CTRL = [
    [ 0.00, 3.55, -3.55],
    [ 2.55, 1.05, -3.10],
    [ 3.90, 0.62, -0.15],
    [ 2.95, 2.25,  2.45],
    [ 0.35, 3.90,  3.35],
    [-2.55, 1.35,  2.80],
    [-3.85, 2.55, -0.35],
    [-2.20, 0.55, -2.95]
  ];

  function catmullRom(pts, samples) {
    var n = pts.length, out = [], i, u, seg, t, t2, t3, p0, p1, p2, p3;
    for (i = 0; i < samples; i++) {
      u = i / samples * n;
      seg = Math.floor(u) % n;
      t = u - Math.floor(u);
      t2 = t * t; t3 = t2 * t;
      p0 = pts[(seg - 1 + n) % n]; p1 = pts[seg];
      p2 = pts[(seg + 1) % n];     p3 = pts[(seg + 2) % n];
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

  var N = 900;
  var CURVE = catmullRom(CTRL, N);

  // 标架：切线 / 侧向 / 上向，带倾角（banking）
  var FR = [];
  for (var i = 0; i < N; i++) {
    var pv = CURVE[(i - 1 + N) % N], nx = CURVE[(i + 1) % N];
    var tg = norm(sub(nx, pv));
    var up0 = v3(0, 1, 0);
    var sd0 = norm(cross(tg, up0));
    var tg2 = norm(sub(CURVE[(i + 3) % N], CURVE[i]));
    var bend = cross(tg, tg2).y;
    var bank = Math.max(-0.62, Math.min(0.62, bend * 7.2));
    var up = norm(add(mul(up0, Math.cos(bank)), mul(sd0, Math.sin(bank))));
    FR.push({ t: tg, s: norm(cross(tg, up)), u: up });
  }

  /* ---------------------------------------------------------------- 相机 */
  var cam = { yaw: 0.55, pitch: -0.16, dist: 9.6, hy: 3.1, focal: 1, horizon: 0.40 };

  function project(p) {
    var dx = p.x, dy = p.y - cam.hy, dz = p.z;
    var cy = Math.cos(-cam.yaw), sy = Math.sin(-cam.yaw);
    var x1 = dx * cy - dz * sy, z1 = dx * sy + dz * cy;
    var cp = Math.cos(-cam.pitch), sp = Math.sin(-cam.pitch);
    var y2 = dy * cp - z1 * sp, z2 = dy * sp + z1 * cp;
    var zc = z2 + cam.dist;
    if (zc < 0.4) return null;
    var f = cam.focal / zc;
    return { x: W * 0.5 + x1 * f, y: H * cam.horizon - y2 * f, z: zc, s: f };
  }

  function fog(z) {
    var k = Math.max(0, Math.min(1, (z - 5.5) / 15));
    return 1 - k * 0.58;
  }

  /* ---------------------------------------------------------------- 缓存画布 */
  var skyCv = document.createElement('canvas'), skyCtx = skyCv.getContext('2d');
  var layerCv = document.createElement('canvas'), layerCtx = layerCv.getContext('2d');

  var BAND = 6;
  var RAIL_GAP = 0.20;
  var ZR = [0, 1];

  // 按深度分带批量描边：一个 Path2D 一次 stroke 画完一整层
  function strokeBanded(lc, segs, offFn, widthFn, styleFn) {
    var lo = ZR[0], hi = ZR[1], span = Math.max(1e-6, hi - lo);
    for (var b = 0; b < BAND; b++) {              // b=0 最远 -> 先画
      var z0 = lo + span * (b / BAND);
      var z1 = lo + span * ((b + 1) / BAND);
      var pth = new Path2D(), any = false;
      for (var k = 0; k < segs.length; k++) {
        var s = segs[k];
        if (s.z < z0 || s.z >= z1) continue;
        var o = offFn(s);
        pth.moveTo(o[0], o[1]); pth.lineTo(o[2], o[3]);
        any = true;
      }
      if (!any) continue;
      var zc = lo + (z0 + z1) * 0.5 - lo + (lo ? 0 : 0);
      var zm = (z0 + z1) * 0.5;
      lc.strokeStyle = styleFn(zm);
      lc.lineWidth = widthFn(zm);
      lc.lineCap = 'round';
      lc.stroke(pth);
    }
  }

  function straight(s) { return [s.a.x, s.a.y, s.b.x, s.b.y]; }

  function rimOff(sign) {
    return function (s) {
      var dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
      var L = Math.sqrt(dx * dx + dy * dy) || 1;
      var w = 0.058 * s.m.s;
      var ox = -dy / L * w * sign, oy = dx / L * w * sign;
      return [s.a.x + ox, s.a.y + oy, s.b.x + ox, s.b.y + oy];
    };
  }
  function hlOff(s) {
    var dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
    var L = Math.sqrt(dx * dx + dy * dy) || 1;
    var w = 0.058 * s.m.s;
    var ox = -dy / L * w * 0.34, oy = dx / L * w * 0.34 - w * 0.26;
    return [s.a.x + ox, s.a.y + oy, s.b.x + ox, s.b.y + oy];
  }

  /* ---------------------------------------------------------------- 静态层 */
  function buildLayer() {
    var lc = layerCtx;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, layerCv.width, layerCv.height);
    lc.drawImage(skyCv, 0, 0, W, H);

    var horizonY = H * cam.horizon;

    // ---- 地面：冷色带 + 透视网格 ----
    var gg = lc.createLinearGradient(0, horizonY, 0, H);
    gg.addColorStop(0, 'rgba(214,232,250,0)');
    gg.addColorStop(0.35, 'rgba(226,234,241,.5)');
    gg.addColorStop(1, 'rgba(210,221,231,.85)');
    lc.fillStyle = gg;
    lc.fillRect(0, horizonY, W, H - horizonY);

    var gp = new Path2D();
    for (var gz = 1; gz <= 9; gz++) {
      var pz = project(v3(0, 0, -gz));
      if (!pz) continue;
      gp.moveTo(0, pz.y); gp.lineTo(W, pz.y);
    }
    for (var gx = -8; gx <= 8; gx++) {
      var a0 = project(v3(gx * 0.9, 0, -9.5)), a1 = project(v3(gx * 0.9, 0, 1.5));
      if (!a0 || !a1) continue;
      gp.moveTo(a0.x, a0.y); gp.lineTo(a1.x, a1.y);
    }
    lc.strokeStyle = 'rgba(140,162,186,.16)';
    lc.lineWidth = 1;
    lc.stroke(gp);

    // ---- 投影 ----
    var pc = [], pl = [], pr = [];
    for (var i = 0; i < N; i++) {
      var p = CURVE[i], fr = FR[i];
      pc.push(project(p));
      pl.push(project(add(p, mul(fr.s, RAIL_GAP))));
      pr.push(project(add(p, mul(fr.s, -RAIL_GAP))));
    }

    var segL = [], segR = [], ties = [];
    var zmin = 1e9, zmax = -1e9;
    for (var i2 = 0; i2 < N; i2++) {
      var j = (i2 + 1) % N;
      var A = pl[i2], B = pl[j], C = pr[i2], D = pr[j], M = pc[i2];
      if (!A || !B || !C || !D || !M) continue;
      var z = (A.z + B.z + C.z + D.z) * 0.25;
      if (z < zmin) zmin = z;
      if (z > zmax) zmax = z;
      segL.push({ a: A, b: B, m: M, z: z });
      segR.push({ a: C, b: D, m: M, z: z });
      ties.push({ i: i2, a: A, c: C, m: M, z: z });
    }
    ZR[0] = zmin; ZR[1] = zmax;

    // ---- 支撑柱 ----
    var sup = new Path2D(), supIn = new Path2D();
    for (var si = 0; si < N; si += 26) {
      var spc = pc[si];
      if (!spc) continue;
      var sp = CURVE[si];
      var foot = project(v3(sp.x, 0, sp.z));
      if (!foot) continue;
      sup.moveTo(spc.x, spc.y); sup.lineTo(foot.x, foot.y);
      supIn.moveTo(spc.x, spc.y); supIn.lineTo(foot.x, foot.y);
    }
    lc.lineCap = 'round';
    lc.strokeStyle = 'rgba(150,192,232,.34)';
    lc.lineWidth = 3.0; lc.stroke(sup);
    lc.strokeStyle = 'rgba(74,130,192,.42)';
    lc.lineWidth = 1.3; lc.stroke(supIn);

    // ---- 轨道四条描边 × 分层批量 ----
    var wOf = function (m) { return 0.058 * m; };
    // ① 外晕
    [segL, segR].forEach(function (set) {
      strokeBanded(lc, set, straight,
        function (z) { return Math.max(1.6, wOf(cam.focal / z) * 3.4); },
        function (z) { return 'rgba(120,176,236,' + (0.07 * fog(z)) + ')'; });
    });
    // ② 透光体
    [segL, segR].forEach(function (set) {
      strokeBanded(lc, set, straight,
        function (z) { return Math.max(1.2, wOf(cam.focal / z) * 1.55); },
        function (z) { return 'rgba(176,214,250,' + (0.62 * fog(z)) + ')'; });
    });
    // ③ 两条深蓝轮廓边 —— 玻璃的轮廓
    [segL, segR].forEach(function (set) {
      [1, -1].forEach(function (sg) {
        strokeBanded(lc, set, rimOff(sg),
          function (z) { return Math.max(0.9, wOf(cam.focal / z) * 0.95); },
          function (z) { return 'rgba(44,102,178,' + (0.74 * fog(z)) + ')'; });
      });
    });
    // ④ 白色高光（偏上）
    [segL, segR].forEach(function (set) {
      strokeBanded(lc, set, hlOff,
        function (z) { return Math.max(0.7, wOf(cam.focal / z) * 0.55); },
        function (z) { return 'rgba(255,255,255,' + (0.95 * fog(z)) + ')'; });
    });

    // ⑤ 枕木
    var tieP = new Path2D();
    for (var ti = 0; ti < ties.length; ti++) {
      var T = ties[ti];
      if (T.i % 9 !== 0) continue;
      tieP.moveTo(T.a.x, T.a.y); tieP.lineTo(T.c.x, T.c.y);
    }
    lc.strokeStyle = 'rgba(92,146,204,.40)';
    lc.lineWidth = 1.9; lc.stroke(tieP);
    lc.strokeStyle = 'rgba(255,255,255,.5)';
    lc.lineWidth = 0.8; lc.stroke(tieP);

    // ⑥ 提升坡链条：沿轨道每隔几段加一根小横线
    var chain = new Path2D();
    for (var ci = 0; ci < N; ci += 5) {
      var q1 = pl[ci], q2 = pr[ci];
      if (!q1 || !q2) continue;
      var mx = (q1.x + q2.x) * 0.5, my = (q1.y + q2.y) * 0.5;
      var ddx = (q1.x - q2.x) * 0.22, ddy = (q1.y - q2.y) * 0.22;
      chain.moveTo(mx - ddy * 0.2 - ddx, my + ddx * 0.2 - ddy);
      chain.lineTo(mx + ddy * 0.2 + ddx, my - ddx * 0.2 + ddy);
    }
    lc.strokeStyle = 'rgba(70,124,186,.20)';
    lc.lineWidth = 1.0; lc.stroke(chain);
  }

  /* ---------------------------------------------------------------- 动态层 */
  function drawTrain(tSec) {
    var head = (tSec * 0.042) % 1;
    var CARS = 5, GAPU = 0.016;
    var list = [];
    for (var c = 0; c < CARS; c++) {
      var u = (head - c * GAPU + 1) % 1;
      var idx = Math.floor(u * N) % N;
      var pp = project(CURVE[idx]);
      if (!pp) continue;
      list.push({ p: pp, i: idx, n: c });
    }
    list.sort(function (a, b) { return b.p.z - a.p.z; });

    for (var k = 0; k < list.length; k++) {
      var car = list[k], p = car.p, f = fog(p.z);
      var sc = p.s, w = Math.max(4, 0.42 * sc), h = Math.max(3, 0.26 * sc);

      ctx.save();
      ctx.translate(p.x, p.y);
      var fr = FR[car.i];
      ctx.rotate(Math.atan2(fr.s.y, fr.s.x) * 0.16);

      var bg = ctx.createLinearGradient(0, -h * 0.6, 0, h * 0.6);
      bg.addColorStop(0, 'rgba(255,255,255,' + (0.97 * f) + ')');
      bg.addColorStop(0.5, 'rgba(186,220,252,' + (0.80 * f) + ')');
      bg.addColorStop(1, 'rgba(124,172,232,' + (0.68 * f) + ')');
      roundRect(-w * 0.5, -h * 0.5, w, h, h * 0.48);
      ctx.fillStyle = bg; ctx.fill();
      ctx.strokeStyle = 'rgba(44,102,178,' + (0.62 * f) + ')';
      ctx.lineWidth = Math.max(0.6, sc * 0.85); ctx.stroke();

      ctx.strokeStyle = 'rgba(255,255,255,' + (0.98 * f) + ')';
      ctx.lineWidth = Math.max(0.4, sc * 0.34);
      ctx.beginPath();
      ctx.moveTo(-w * 0.30, -h * 0.22); ctx.lineTo(w * 0.22, -h * 0.30);
      ctx.stroke();

      if (car.n === 0) {
        var lg = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 1.8);
        lg.addColorStop(0, 'rgba(255,238,200,' + (0.5 * f) + ')');
        lg.addColorStop(1, 'rgba(255,238,200,0)');
        ctx.fillStyle = lg;
        ctx.beginPath(); ctx.arc(0, 0, w * 1.8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  // 流动高光：一束光沿轨道跑，告诉眼睛"这条线是通的"
  function drawPulse(tSec) {
    var u = (tSec * 0.11) % 1;
    for (var k = 0; k < 22; k++) {
      var idx = Math.floor(((u - k * 0.0024 + 1) % 1) * N) % N;
      var p = project(CURVE[idx]);
      if (!p) continue;
      var a = (1 - k / 22) * 0.5 * fog(p.z);
      var r = Math.max(1.4, 0.15 * p.s) * (1 - k / 26);
      var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.4);
      g.addColorStop(0, 'rgba(140,200,255,' + a + ')');
      g.addColorStop(1, 'rgba(140,200,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2); ctx.fill();
    }
  }

  var MOTES = null;
  function initMotes() {
    MOTES = [];
    for (var i = 0; i < 40; i++) {
      MOTES.push({ x: Math.random(), y: Math.random(),
                   r: 0.6 + Math.random() * 1.6,
                   sp: 0.004 + Math.random() * 0.011,
                   ph: Math.random() * 6.28 });
    }
  }
  function drawMotes(tSec) {
    if (!MOTES) initMotes();
    for (var i = 0; i < MOTES.length; i++) {
      var m = MOTES[i];
      var y = (m.y - tSec * m.sp) % 1; if (y < 0) y += 1;
      var x = m.x + Math.sin(tSec * 0.5 + m.ph) * 0.012;
      var px = x * W, py = y * H;
      var g = ctx.createRadialGradient(px, py, 0, px, py, m.r * 4);
      g.addColorStop(0, 'rgba(255,255,255,.7)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, m.r * 4, 0, Math.PI * 2); ctx.fill();
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /* ---------------------------------------------------------------- 主循环 */
  var lastLayerT = -1, layerBudget = 1 / 30;

  function draw(tSec) {
    if (FX.cameraDrift) {
      cam.yaw = 0.55 + Math.sin(tSec * 0.05) * 0.30;
      cam.pitch = -0.16 + Math.sin(tSec * 0.037 + 1.1) * 0.030;
    } else {
      cam.yaw = 0.55;            // 固定机位
      cam.pitch = -0.16;
    }
    cam.focal = Math.min(W, H) * 1.55;

    if (lastLayerT < 0 || tSec - lastLayerT >= layerBudget) {
      buildLayer();
      lastLayerT = tSec;
    }

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(layerCv, 0, 0, W, H);

    if (FX.pulse) drawPulse(tSec);
    if (FX.train) drawTrain(tSec);
    if (FX.motes) drawMotes(tSec);
  }

  /* ---------------------------------------------------------------- 尺寸 */
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = cvs.clientWidth || window.innerWidth;
    H = cvs.clientHeight || window.innerHeight;
    cvs.width = Math.round(W * DPR);
    cvs.height = Math.round(H * DPR);
    layerCv.width = Math.round(W * DPR);
    layerCv.height = Math.round(H * DPR);
    layerCtx.setTransform(DPR, 0, 0, DPR, 0, 0);

    skyCv.width = Math.max(1, Math.round(W));
    skyCv.height = Math.max(1, Math.round(H));
    var g = skyCtx.createLinearGradient(0, 0, 0, skyCv.height);
    // 底色改中性冷灰白：蓝色只留给玻璃轨道和 UI，不再给整片背景上蓝滤镜
    g.addColorStop(0, '#f8fafc');
    g.addColorStop(0.45, '#eff4f8');
    g.addColorStop(1, '#e4ebf1');
    skyCtx.fillStyle = g;
    skyCtx.fillRect(0, 0, skyCv.width, skyCv.height);

    lastLayerT = -1;
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
    // 关了动效 / 系统要求减少动态 / 四个东西全关 -> 只画一帧，不进循环
    if (reduce || !ANY_FX) { draw(12.0); return; }
    raf = window.requestAnimationFrame(loop);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { running = false; window.cancelAnimationFrame(raf); }
    else if (!reduce && ANY_FX) { running = true; t0 = 0; raf = window.requestAnimationFrame(loop); }
  });

  var rt = 0;
  window.addEventListener('resize', function () {
    window.clearTimeout(rt);
    rt = window.setTimeout(function () { resize(); if (reduce || !ANY_FX) draw(12.0); }, 180);
  }, { passive: true });

  start();
})();
