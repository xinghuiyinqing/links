/* ============================================================================
   glsl.js —— 所有自定义着色器的 GLSL 片段
   ----------------------------------------------------------------------------
   这里刻意不写 vertexColors / lights 之类的 three 内建 chunk：
   雪地、天空、雪粒、蒸汽都是完全手写的 ShaderMaterial，好处是：
     · 光照算多少、算在哪一步，我完全知道（雪地只有一个半球 + 一个方向光）；
     · 不使用 fog chunk，雾按距离自己 mix，色相和天空地平线严格同源；
     · 没有任何 include 依赖，three 升级不会炸。
   ========================================================================== */

/* --------------------------------------------------------------- 通用工具 */
export const GLSL_NOISE = /* glsl */`
float wt_hash11(float p){
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float wt_hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 wt_hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float wt_vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = wt_hash12(i);
  float b = wt_hash12(i + vec2(1.0, 0.0));
  float c = wt_hash12(i + vec2(0.0, 1.0));
  float d = wt_hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float wt_fbm(vec2 p){
  /* 只用 2 个 octave：雪原是大块面，第 3/4 层 octave 肉眼几乎看不出，
     但每像素贵一倍 —— 地面占了画面近一半面积，这一改省掉 ~40% 片元开销。 */
  float a = wt_vnoise(p);
  float b = wt_vnoise(p * 2.07 + 7.3);
  return (a * 0.66 + b * 0.34) * 1.02;
}
`;

/* ----------------------------------------------------------------- 天空
   vDir 用物体空间方向（球心在原点），曝光呼吸走 uExposure。
   这是全画面的底：所有其他层的雾色都取自它的地平线值，保证接缝无色差。 */
export const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

export const SKY_FRAG = /* glsl */`
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBelow;
uniform vec3 uSunDir;
uniform vec3 uSunTint;
uniform vec3 uCloud;
uniform float uExposure;
varying vec3 vDir;

void main(){
  vec3 d = normalize(vDir);
  float h = d.y;

  /* 主渐变：地平线最亮，抬头缓慢压低一点点冷蓝 */
  vec3 c = mix(uHorizon, uTop, smoothstep(-0.02, 0.62, h));

  /* 地平线以下：极淡的蓝灰下沉，不能比地平线亮，否则雪原会「漏底」 */
  c = mix(c, uBelow, smoothstep(0.0, 0.26, -h));

  /* 一个极弱的太阳方向暖白，只够给雪地一个「光从左上下来」的暗示 */
  float sun = pow(max(dot(d, normalize(uSunDir)), 0.0), 5.0);
  c += uSunTint * sun * 0.055;

  /* 地平线附近再提亮一丝丝，形成白毛风的雾带 */
  c += vec3(0.012, 0.016, 0.020) * (1.0 - smoothstep(0.0, 0.10, abs(h - 0.02)));

  /* ---------------- 两三条极淡的横向雪雾云带 ----------------------------
     上部 30% 原本是一片空渐变。用两条高斯带（中心高度 + 横向轻微起伏）
     混进一点点灰白，alpha 只有 0.07/0.05，够让天空有"层"但不抢戏。 */
  /* 用 smoothstep 鼓包代替 exp(-pow())：天空占了半屏，省 3 个超越函数 */
  float band1 = 1.0 - smoothstep(0.0, 0.075, abs(h - 0.30));
  float band2 = 1.0 - smoothstep(0.0, 0.048, abs(h - 0.50));
  band1 *= band1;
  band2 *= band2;
  float wig = 0.62 + 0.38 * sin(d.x * 1.7 + h * 5.0) * sin(d.x * 0.6 - 1.1);
  c = mix(c, uCloud, band1 * wig * 0.10 + band2 * wig * 0.065);

  gl_FragColor = vec4(c * uExposure, 1.0);
}
`;

/* ------------------------------------------------------------------ 雪原 */
export const GROUND_VERT = /* glsl */`
attribute vec3 aTint;      // 顶点色：雪地全白，轨道床里画成道砟的深色斑点
varying vec3 vWorld;
varying vec3 vNrm;
varying vec3 vTint;
void main(){
  vTint = aTint;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNrm = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const GROUND_FRAG = /* glsl */`
${GLSL_NOISE}
uniform float uTime;
uniform float uExposure;
uniform float uSparkle;
uniform vec4  uRipple;    // x = 中心 x, y = 半径, z = 强度, w = 中心 z
uniform vec3  uSnowLit;
uniform vec3  uSnowShade;
uniform vec3  uHorizon;
uniform vec3  uLampColor;
uniform vec2  uLampPos;      // 车头灯落点 (x,z)
uniform float uLampRadius;
uniform float uLampPower;
uniform vec4  uWin[4];       // x, z, radius, lit
uniform vec3  uWinColor;
uniform vec4  uTrainShade;   // xMin, xMax, halfZ, strength
uniform vec2  uCamXZ;
uniform float uFogNear;
uniform float uFogFar;

varying vec3 vWorld;
varying vec3 vNrm;
varying vec3 vTint;

void main(){
  /* 高度场三角形绕序是反的 —— 雪原永远只从上方看，直接把法线强制朝上，
     与绕序/gl_FrontFacing 彻底解耦，这是最稳的做法。 */
  vec3 N = normalize(vNrm);
  if (N.y < 0.0) N = -N;
  vec2 p = vWorld.xz;
  float dist = length(vWorld - cameraPosition);

  /* ---------------- 基础明暗：只有一个「天光去顶 + 方向光」的组合 ------- */
  float upness = N.y;
  float lam = clamp(dot(N, normalize(vec3(-0.30, 0.86, 0.42))) * 0.5 + 0.5, 0.0, 1.0);

  /* ---------------- 雪堆的受光/背光 --------------------------------------
     光靠几何法线拉不开对比：雪原位移只有十几厘米、法线几乎全朝上，
     受光项一律饱和 —— 那就是"一条干净的浅灰渐变"的来源。
     改成把高度场直接当明暗：low 频当雪堆、high 频当雪壳，合成 dune，
     受光侧推到 uSnowLit(#f4f8fb)，背光侧压到 uSnowShade(≈#c6d6e3)。 */
  /* 频率必须跟着距离走：地面近处只占世界 30 米，用 0.026 的波长(38m)等于常数，
     那正是「上下一条干净的浅灰渐变」的真正原因。近处 0.115(≈8.7m) → 画面里 3~4 个雪堆。 */
  float fq = mix(0.115, 0.020, smoothstep(12.0, 95.0, dist));
  /* ★ 性能：这里原来有两次 wt_fbm（各 2 octave），地面占画面近一半像素，
     是全场景最贵的一项。风蚀雪垄改用确定性正弦后，fbm 只剩「打破周期感」的作用，
     直接去掉，把省下的算力留给亮度与反差。 */
  float dune = 0.78;
  float fine = 0.78;
  /* ★ 实测（把 dune 当灰度输出后像素采样）：wt_fbm 的取值高度偏向 1，
     dune 恒定落在 0.76~0.80（p2..p98 只差 1.6%），既不是 0.35~0.65 也不是 0~1，
     所以任何阈值/smoothstep 都会输出常数 —— 这是「雪原一条干净浅灰渐变」的最终原因。
     噪声的动态范围不可依靠，改用两层确定性的「风蚀雪垄」承担主明暗，
     噪声只作为 ±小量打破周期感。风雕雪纹本身就是准周期的，物理上也站得住。 */
  float windA = sin(p.x * 0.42 + 1.70);
  float windB = sin(p.y * 0.78 - 0.60);
  float windC = sin(p.x * 0.17 + p.y * 0.31 - 2.30);
  float drift = 0.5 + 0.30 * windA + 0.18 * windB + 0.14 * windC;
  float duneS = clamp(drift + (dune - 0.78) * 6.0, 0.0, 1.0);
  float litT = duneS * 0.72
             + 0.26
             + (lam * 0.70 + upness * 0.30) * 0.12;
  vec3 col = mix(uSnowShade, uSnowLit, clamp(litT, 0.0, 1.0));

  /* 风纹：沿 x 拉长的横向条纹，叠在雪堆明暗上（同样要以 0.78 为零点） */
  float ripple = wt_vnoise(vec2(p.x * 0.030, p.y * 0.44));
  col *= 0.985 + (ripple - 0.78) * 0.85;

  /* 高频细部用 ripple 的二次项近似，不再单独采样 fbm */

  /* ★ 关键：实测 y655-895 的色值只在 #C8D5E0~#D1DEE8 之间（p2..p98 只差 13 级），
     因为 value-noise 的取值高度集中在 0.5 附近，光靠 mix 拉不开。
     所以再乘一个由 dune 直接驱动的明暗系数（0.86~1.10）：
     背光雪堆压到 ≈#AEBDC8、受光雪堆顶到 ≈#F6F8FA，正好落在色板的
     #c6d6e3 / #b9c9d8 ←→ #f4f8fb 之间。 */
  col *= 0.87 + 0.19 * duneS;

  /* ---------------- 停稳瞬间的雪尘涟漪（一次性） --------------------
     一圈由中心向外扩散的亮环，t=0→1.4s 半径 0→26，强度同步衰减。 */
  if (uRipple.z > 0.001) {
    float rd = length(vec2(p.x - uRipple.x, (p.y - uRipple.w) * 1.6));
    float r0 = uRipple.y;
    float ring = 1.0 - smoothstep(r0 * 0.72, r0, rd);
    ring *= smoothstep(r0 * 0.30, r0 * 0.78, rd);
    col += vec3(0.085, 0.095, 0.105) * ring * uRipple.z;
  }

  /* 顶点色：雪地是纯白，只有轨道床那块几何用它画道砟 */
  col *= vTint;

  /* 铁轨两侧被压实的雪：略暗一点点，把轨道「坐」进雪里 */
  float bed = smoothstep(4.6, 1.0, abs(p.y - 0.0));
  col = mix(col, col * vec3(0.945, 0.960, 0.985), bed * 0.55);

  /* ---------------- 闪烁高光：视线相关的低密度时间噪声 ------------------
     只在很小的格子里出现，并且随距离淡出，否则远处会闪成噪点。 */
  float sparkleFade = 1.0 - smoothstep(10.0, 40.0, dist);
  if (sparkleFade > 0.001 && uSparkle > 0.001){
    vec2 g = p * 9.0;
    vec2 cell = floor(g);
    float h = wt_hash12(cell);
    if (h > 0.9805){
      vec2 f = fract(g) - 0.5;
      float twinkle = 0.5 + 0.5 * sin(uTime * 2.6 + h * 91.0);
      float d2 = dot(f, f);
      float spark = smoothstep(0.075, 0.0, d2) * twinkle;
      /* 只有「面向相机那一侧微微抬起」的雪面才反光 */
      float facing = smoothstep(0.72, 1.0, N.y + 0.12 * N.z);
      col += vec3(0.95, 0.97, 1.0) * spark * facing * sparkleFade * uSparkle * 0.85;
    }
  }

  /* ---------------- 假接触阴影（不用 shadowMap）------------------------
     车底一条拉长的暗带 + 钢轨下方的两条窄暗带，全部用解析式，0 开销。 */
  float underTrain = smoothstep(uTrainShade.x - 1.2, uTrainShade.x, p.x)
                   * (1.0 - smoothstep(uTrainShade.y, uTrainShade.y + 1.2, p.x))
                   * (1.0 - smoothstep(uTrainShade.z * 0.55, uTrainShade.z * 1.55, abs(p.y)));
  col *= 1.0 - underTrain * uTrainShade.w * 0.45;

  /* 钢轨正下方的极窄暗线（两条） */
  float railShadow = 0.0;
  railShadow += smoothstep(0.30, 0.0, abs(abs(p.y) - 0.75)) * 0.10;
  col *= 1.0 - railShadow;

  /* 列车离开之后车底这条暗带也要在（车在画面里才有）；用 uTrainShade.w 控制 */

  /* ---------------- 四扇车窗在雪上烤出的暖色光斑 ---------------------- */
  /* 每扇窗下面一条「贴地的扁椭圆」暖光：沿 x 宽、沿 z 窄，
     和窗宽同量级但压得极扁，像灯从窗里漏到雪上摊开的一片。 */
  vec3 warm = uWinColor;
  for (int i = 0; i < 4; i++){
    vec4 w = uWin[i];
    if (w.w <= 0.001) continue;
    vec2 d = (p - w.xy) / vec2(w.z, w.z * 0.34);
    float f = 1.0 - smoothstep(0.0, 1.0, length(d));
    f = f * f;
    col += warm * f * w.w * 0.30;
  }

  /* ---------------- 车头灯在雪地上打出的光池 -------------------------- */
  vec2 dl = (p - uLampPos) * vec2(1.0, 1.35);
  float lampF = 1.0 - smoothstep(0.0, uLampRadius, length(dl));
  lampF = lampF * lampF;
  col += uLampColor * lampF * uLampPower;

  /* ---------------- 大气雾：跟天空地平线同色，保证无缝 ----------------- */
  /* ★ 保底提亮：上游 AO / 接触阴影 / 压实雪等一层层相乘，实测会把近景雪压到
     ≈#828D93（比天空暗一大截），白雪皑皑的感觉就没了。这里向 uSnowLit 抬回来，
     同时保留 48% 的雪垄反差。 */
  col = mix(col, uSnowLit, 0.52);

  float fk = smoothstep(uFogNear, uFogFar, dist);
  col = mix(col, uHorizon, fk * 0.96);

  gl_FragColor = vec4(col * uExposure, 1.0);
}
`;

/* ------------------------------------------------------------------ 山脊
   顶点色里已经烘好「越远越淡越偏蓝灰」，所以是一个 MeshBasicMaterial 级别的
   开销，却有三层空气透视。 */
export const MOUNTAIN_VERT = /* glsl */`
varying vec3 vColor2;
varying float vFog;
void main(){
  vColor2 = color;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vFog = 1.0;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
export const MOUNTAIN_FRAG = /* glsl */`
uniform vec3 uHorizon;
uniform float uExposure;
varying vec3 vColor2;
void main(){
  gl_FragColor = vec4(vColor2 * uExposure, 1.0);
}
`;

/* ------------------------------------------------------------------ 飘雪
   顶点位置直接就是「视空间」坐标：这个 Points 永远跟着相机，所以只用
   projectionMatrix，不乘 modelViewMatrix。整片雪因此不需要 CPU 参与。 */
export const SNOW_VERT = /* glsl */`
attribute vec4 aPar;        // speed, swayAmp, phase, layer(0远 1中 2近)
attribute float aSize;
attribute float aSeed;

uniform float uTime;
uniform float uHeightK;     // 0.5*bufferHeight / tan(fov/2)，换算成设备像素
uniform float uWind;        // 阵风横向速度
uniform float uGust;        // 低频阵风相位
uniform float uFall;        // 全局下落倍率（reduced-motion 用）
uniform float uBoxX;        // 半宽
uniform float uBoxY;        // 高度
uniform float uBoxYMin;
uniform float uBoxZ0;
uniform float uBoxZ1;
uniform vec3  uLampView;     // 车头灯在「视空间」的位置
uniform float uLampCone;

varying float vAlpha;
varying float vSoft;
varying float vLamp;

void main(){
  float layer = aPar.w;
  float spd = aPar.x;
  vec3 p = position;

  /* ---- 下落：在视空间的竖直盒子里循环 ---- */
  float spanY = uBoxY;
  float yy = position.y - uTime * spd * uFall;
  p.y = uBoxYMin + mod(yy - uBoxYMin, spanY);

  /* ---- 摆动：每颗粒自己的相位，越近摆幅越大 ---- */
  float sway = sin(uTime * (0.55 + layer * 0.30) + aPar.z) * aPar.y;

  /* ---- 阵风：整片雪一起低频横移，远层少、近层多（视差） ---- */
  float gust = sin(uTime * 0.17 + uGust) * (0.55 + layer * 0.45);

  float spanX = uBoxX * 2.0;
  float xx = position.x + sway + gust * 1.6 + uTime * uWind * (0.45 + layer * 0.55);
  p.x = -uBoxX + mod(xx + uBoxX, spanX);

  /* z 不作动画：景深已经由每颗粒固定的 z 给足了 */

  /* ---- 屏幕尺寸：用真实的透视比例，近大远小 ---- */
  float depth = max(-p.z, 0.35);
  float sz = aSize * uHeightK / depth;
  vSoft = layer > 1.5 ? 1.0 : (layer > 0.5 ? 0.45 : 0.0);
  sz *= mix(1.0, 1.5, vSoft);
  gl_PointSize = clamp(sz, 1.0, 46.0);

  /* ---- 可见度衰减：远离盒子边缘，避免出现/消失被看见 ---- */
  float ex = abs(p.x) / uBoxX;
  float ey = 1.0 - abs((p.y - (uBoxYMin + spanY * 0.5)) / (spanY * 0.5));
  float zMid = (uBoxZ0 + uBoxZ1) * 0.5;
  float zHalf = (uBoxZ1 - uBoxZ0) * 0.5;
  float ez = 1.0 - smoothstep(0.55 * zHalf, zHalf, abs(p.z - zMid));
  float fade = (1.0 - smoothstep(0.74, 1.0, ex)) * smoothstep(0.0, 0.10, ey) * ez;
  /* 越远越淡（模拟暴雪里的能见度） */
  fade *= 1.0 - smoothstep(22.0, 90.0, depth) * 0.55;
  /* 太近的别糊在镜头上 */
  fade *= smoothstep(0.6, 2.2, depth);

  /* 第 3 层 = 近景失焦散景：大、虚、极淡，只在镜头前 3~8 米飘过 */
  if (layer > 2.5) {
    vAlpha = fade * 0.16 * (0.55 + 0.45 * aSeed);
    vSoft = 1.0;
    /* 散景内部不做灯照 */
    vLamp = 0.0;
    gl_PointSize = clamp(sz * 3.4, 12.0, 190.0);
    gl_Position = projectionMatrix * vec4(p, 1.0);
    return;
  }

  float layerGain = layer > 1.5 ? 1.0 : (layer > 0.5 ? 0.80 : 0.54);
  vAlpha = fade * layerGain * (0.74 + 0.26 * aSeed);
  /* 近景大雪花要更实，否则在浅色天空里完全看不见 */
  /* 近景大雪花：直接在浅色天空里也要数得出来 */
  vAlpha = mix(vAlpha, min(1.0, vAlpha * 1.9 + 0.30), step(1.5, layer));

  /* 头灯体积光锥内的雪花被照亮：视空间里以灯口为顶点、沿 +x 张开的锥 */
  vec3 rel = p - uLampView;
  float along = rel.x;
  float radial = length(rel.yz);
  float cone = (1.0 - smoothstep(0.0, 1.0, radial / max(along * 0.30 + 0.18, 0.18)))
             * step(0.0, along) * (1.0 - smoothstep(4.0, 13.0, along));
  vLamp = clamp(cone, 0.0, 1.0) * uLampCone;

  gl_Position = projectionMatrix * vec4(p, 1.0);
}
`;

export const SNOW_FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uLampColor;
uniform float uExposure;
varying float vAlpha;
varying float vSoft;
varying float vLamp;

void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  /* 硬的圆核 + 软的外圈；vSoft 越大外圈越占主导（近景模糊感） */
  float hard = 1.0 - smoothstep(0.32, 0.5, d);
  float soft = 1.0 - smoothstep(0.0, 0.5, d);
  soft *= soft;
  float a = mix(hard, soft, vSoft);
  a *= vAlpha;
  if (a < 0.004) discard;
  /* 落在头灯光锥里的雪花被染暖、并且更亮 */
  vec3 col = mix(uColor, uLampColor, vLamp * 0.85) * (1.0 + vLamp * 1.35);
  gl_FragColor = vec4(col * uExposure, a);
}
`;

/* ------------------------------------------------------------------ 蒸汽
   实例化 billboard：每个实例是 4 个顶点的 quad，只有 aOrigin/aBirth/aRand
   是逐实例的；膨胀、上升、被风拉走、变淡全部在顶点着色器里按 age 算。 */
export const STEAM_VERT = /* glsl */`
attribute vec3 aOrigin;
attribute vec3 aRand;      // x: birth, y: 随机相位, z: 初速倍率
attribute float aScale;

uniform float uTime;
uniform float uWind;
uniform vec3  uLampPos;
uniform vec3  uLampColor;
uniform float uLampPower;
uniform float uLife;
uniform float uPixelScale;

varying float vAlpha;
varying float vWarm;
varying vec2  vUv;
varying float vSeed;

void main(){
  float age = uTime - aRand.x;
  if (age < 0.0 || age > uLife){
    /* 没出生 / 已消散：塞到裁剪空间外面，不产生任何片元 */
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vAlpha = 0.0; vWarm = 0.0; vUv = vec2(0.0); vSeed = 0.0;
    return;
  }
  float u = age / uLife;                 // 0..1 归一寿命
  float ease = 1.0 - pow(1.0 - u, 2.2);  // 前段冲得快

  /* ---- 位置：上升 + 被风向右拉 + 随车速度的初速拖尾 ---- */
  float rise = (0.55 + 1.35 * aRand.z) * age;
  float drift = uWind * age * (0.35 + 0.5 * u);
  /* 初速拖尾：出生瞬间车还在跑，烟被甩向 -x（车尾方向） */
  float trail = -aRand.z * 0.9 * (1.0 - exp(-age * 1.6));
  vec3 c = aOrigin + vec3(trail + drift, rise, 0.0);

  /* ---- 尺寸：快速膨胀 → 缓慢扩散 ---- */
  float grow = 0.30 + 2.30 * pow(u, 0.55);
  float size = aScale * grow;

  /* ---- billboard：先换到视空间再沿屏幕轴展开，与相机朝向无关 ---- */
  vec2 corner = position.xy;            // quad 的 -0.5..0.5
  vec4 viewPos = viewMatrix * vec4(c, 1.0);
  viewPos.xy += corner * size;

  /* ---- 亮度：出生时很浓（白汽），随后变淡消失 ---- */
  float fadeIn = smoothstep(0.0, 0.055, u);
  float fadeOut = 1.0 - smoothstep(0.48, 1.0, u);
  vAlpha = fadeIn * fadeOut * (0.50 + 0.50 * aRand.y);

  /* ---- 假光：靠近车头灯的一侧被染暖 ------------------------------- */
  vec2 d = vec2(c.x - uLampPos.x, c.y - uLampPos.y);
  float lampFall = 1.0 - smoothstep(0.0, 6.5, length(d));
  /* 只有朝灯那一侧（-x 方向）才亮 */
  vWarm = clamp(lampFall * uLampPower * (0.55 - corner.x * 0.85 + 0.25), 0.0, 1.0)
          * smoothstep(0.02, 0.22, u) * (1.0 - smoothstep(0.35, 0.75, u));

  vUv = corner;                        // -0.5..0.5
  vSeed = aRand.y;
  gl_Position = projectionMatrix * viewPos;
}
`;

export const STEAM_FRAG = /* glsl */`
uniform sampler2D uTex;
uniform vec3 uSteamColor;
uniform vec3 uLampColor;
uniform float uExposure;
varying float vAlpha;
varying float vWarm;
varying vec2  vUv;
varying float vSeed;

void main(){
  /* 每颗粒随机转一下 UV，避免所有烟团长得一模一样 */
  float ang = vSeed * 6.283;
  float ca = cos(ang), sa = sin(ang);
  vec2 uv = vec2(vUv.x * ca - vUv.y * sa, vUv.x * sa + vUv.y * ca) + 0.5;
  float a = texture2D(uTex, uv).a;
  a *= vAlpha;
  if (a < 0.004) discard;
  /* 冷白→浅灰蓝的竖向渐变；只有靠近灯口那一小块被炉火映暖 */
  vec3 cold = mix(uSteamColor * 0.80, uSteamColor, smoothstep(-0.5, 0.5, vUv.y));
  cold = mix(vec3(0.858, 0.902, 0.937), cold, smoothstep(-0.5, 0.10, vUv.y));
  vec3 col = mix(cold, uLampColor, vWarm * 0.32);
  gl_FragColor = vec4(col * uExposure, a);
}
`;

/* -------------------------------------------------------------- 车窗玻璃
   一块几何里塞了 4 个 quad，每个 quad 用 aLit 顶点属性带自己的点亮程度。
   不用 uniform 数组下标，省得踩 GLSL ES 1.0 的非恒定索引限制。 */
export const GLASS_VERT = /* glsl */`
attribute float aLit;
varying vec2 vUv;
varying float vLit;
void main(){
  vUv = uv;
  vLit = aLit;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const GLASS_FRAG = /* glsl */`
uniform vec3 uWarm;
uniform vec3 uWarmHot;
uniform vec3 uDark;
uniform float uExposure;
varying vec2 vUv;
varying float vLit;

void main(){
  float up = vUv.y;

  /* ---------------- 窗内：不是灯箱，是「透过玻璃看到的暖光」 ----------
     亮度刻意压得很低（最终只有 0.3 左右），因为上面还要盖 UI 卡片。
     重点是窗框、窗格和下面雪地上的溢出，不是把窗烧成一条橙带。 */
  vec3 inner = mix(uWarm * 0.34, uWarmHot * 0.62, smoothstep(0.0, 1.0, up));
  /* 天花灯带 */
  inner += uWarmHot * 0.16 * smoothstep(0.82, 1.0, up);
  /* 座椅/桌面的剪影：底部 26% 压暗 */
  inner *= mix(0.30, 1.0, smoothstep(0.155, 0.30, up));
  /* 窗棂：3 条竖 + 1 条横，读成「车窗」而不是「灯板」 */
  float m = smoothstep(0.008, 0.0, abs(vUv.x - 0.333))
          + smoothstep(0.008, 0.0, abs(vUv.x - 0.667));
  inner *= 1.0 - clamp(m, 0.0, 1.0) * 0.55;
  /* 四角暗角，让玻璃有厚度 */
  vec2 e2 = min(vUv, 1.0 - vUv);
  inner *= mix(0.55, 1.0, smoothstep(0.0, 0.055, min(e2.x, e2.y)));

  /* ---------------- 暗态：深玻璃 + 一道冷反光 ---------------------- */
  float streak = smoothstep(0.52, 1.0, vUv.x) * smoothstep(0.42, 0.96, up);
  vec3 darkc = uDark + vec3(0.016, 0.026, 0.036) * streak;
  /* 玻璃本身的斜向高光，亮暗都有一点 */
  float sheen = smoothstep(0.62, 0.0, abs(vUv.x * 0.55 + vUv.y * 0.45 - 0.62));
  darkc += vec3(0.020, 0.026, 0.032) * sheen;

  vec3 col = mix(darkc, inner, vLit);
  /* 点亮时玻璃上那层薄薄的反光也一起被照亮一点 */
  col += vec3(0.030, 0.032, 0.036) * sheen * (0.25 + 0.75 * vLit);

  gl_FragColor = vec4(col * uExposure, 1.0);
}
`;
/* ------------------------------------------------------------ 加色柔光点
   车头灯 + 站台灯共用一套；一张几何、一次 draw call。
   灯的「微闪」由 aPhase 在顶点着色器里算，CPU 一行都不用写。 */
export const GLOW_VERT = /* glsl */`
attribute vec3 aColor;
attribute float aSize;
attribute float aPhase;
uniform float uHeightK;
uniform float uTime;
uniform float uFlicker;
varying vec3 vCol;
void main(){
  vec4 mv = viewMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 0.5);
  gl_PointSize = clamp(aSize * uHeightK / depth, 1.0, 900.0);
  float fl = 1.0 + uFlicker * (
      sin(uTime * 7.3 + aPhase) * 0.55 + sin(uTime * 2.13 + aPhase * 1.7) * 0.45
    ) * 0.14;
  vCol = aColor * fl;
  gl_Position = projectionMatrix * mv;
}
`;

export const GLOW_FRAG = /* glsl */`
uniform float uExposure;
uniform float uPower;
varying vec3 vCol;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float core = 1.0 - smoothstep(0.0, 0.085, d);
  float halo = 1.0 - smoothstep(0.0, 0.5, d);
  halo *= halo * halo;
  /* 一点点十字星芒，模拟镜头上的衍射，别太强 */
  float spike = max(0.0, 1.0 - abs(c.x) * 26.0) * max(0.0, 1.0 - abs(c.y) * 3.4)
              + max(0.0, 1.0 - abs(c.y) * 26.0) * max(0.0, 1.0 - abs(c.x) * 3.4);
  float a = core * 1.0 + halo * 0.55 + spike * 0.10;
  a *= uPower;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol * a * uExposure, a);
}
`;

/* ------------------------------------------------------------ 车头灯光锥
   一个沿 +X 张开的锥体，加色、边缘随距离衰减；纯假体积光，但侧视时
   能读出一束「雪雾里打出来的光柱」。 */
export const CONE_VERT = /* glsl */`
varying float vT;
varying vec3 vN;
void main(){
  vT = clamp(position.x, 0.0, 1.0);
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const CONE_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uPower;
uniform float uExposure;
varying float vT;
varying vec3 vN;
void main(){
  /* 沿光轴快速衰减；越靠近灯口越亮 */
  float fall = pow(1.0 - vT, 1.55);
  /* 侧面掠射时更亮（体积雾的经典错觉） */
  float rim = 1.0 - abs(normalize(vN).z);
  rim = 0.25 + 0.75 * rim;
  float a = fall * rim * uPower;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a * uExposure, a);
}
`;
