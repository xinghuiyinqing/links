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
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ s += a * wt_vnoise(p); p *= 2.07; a *= 0.5; }
  return s * 1.0666;
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
  vec3 N = normalize(vNrm);
  vec2 p = vWorld.xz;
  float dist = length(vWorld - cameraPosition);

  /* ---------------- 基础明暗：只有一个「天光去顶 + 方向光」的组合 ------- */
  float upness = N.y;
  float lam = clamp(dot(N, normalize(vec3(-0.30, 0.86, 0.42))) * 0.5 + 0.5, 0.0, 1.0);
  /* 雪面在受光侧近白，背光侧是很淡的蓝灰（--snow-2） */
  vec3 col = mix(uSnowShade, uSnowLit, smoothstep(0.10, 0.98, lam * 0.62 + upness * 0.55));

  /* ---------------- 大尺度斑驳：雪壳、车辙、被风压出的横向纹 ----------- */
  float big = wt_fbm(p * 0.055);
  float ridged = wt_fbm(vec2(p.x * 0.02, p.y * 0.16));
  col *= 0.955 + big * 0.09 + (ridged - 0.5) * 0.045;

  /* 顶点色：雪地是纯白，只有轨道床那块几何用它画道砟 */
  col *= vTint;

  /* 铁轨两侧被压实的雪：略暗一点点，把轨道「坐」进雪里 */
  float bed = smoothstep(4.6, 1.0, abs(p.y - 0.0));
  col = mix(col, col * vec3(0.945, 0.960, 0.985), bed * 0.55);

  /* ---------------- 闪烁高光：视线相关的低密度时间噪声 ------------------
     只在很小的格子里出现，并且随距离淡出，否则远处会闪成噪点。 */
  float sparkleFade = 1.0 - smoothstep(14.0, 62.0, dist);
  if (sparkleFade > 0.001 && uSparkle > 0.001){
    vec2 g = p * 9.0;
    vec2 cell = floor(g);
    float h = wt_hash12(cell);
    if (h > 0.9725){
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
  col *= 1.0 - underTrain * uTrainShade.w;

  /* 钢轨正下方的极窄暗线（两条） */
  float railShadow = 0.0;
  railShadow += smoothstep(0.30, 0.0, abs(abs(p.y) - 0.75)) * 0.10;
  col *= 1.0 - railShadow;

  /* 列车离开之后车底这条暗带也要在（车在画面里才有）；用 uTrainShade.w 控制 */

  /* ---------------- 四扇车窗在雪上烤出的暖色光斑 ---------------------- */
  vec3 warm = uWinColor;
  for (int i = 0; i < 4; i++){
    vec4 w = uWin[i];
    if (w.w <= 0.001) continue;
    vec2 d = (p - w.xy);
    /* 椭圆：比正圆更贴合侧向投下来的窗光 */
    d.y *= 1.45;
    float r = w.z;
    float f = 1.0 - smoothstep(0.0, r, length(d));
    f = f * f * (0.55 + 0.45 * f);
    col += warm * f * w.w;
  }

  /* ---------------- 车头灯在雪地上打出的光池 -------------------------- */
  vec2 dl = (p - uLampPos) * vec2(1.0, 1.35);
  float lampF = 1.0 - smoothstep(0.0, uLampRadius, length(dl));
  lampF = lampF * lampF;
  col += uLampColor * lampF * uLampPower;

  /* ---------------- 大气雾：跟天空地平线同色，保证无缝 ----------------- */
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

varying float vAlpha;
varying float vSoft;

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
  gl_PointSize = clamp(sz, 1.0, 34.0);

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

  float layerGain = layer > 1.5 ? 0.95 : (layer > 0.5 ? 0.72 : 0.46);
  vAlpha = fade * layerGain * (0.62 + 0.38 * aSeed);

  gl_Position = projectionMatrix * vec4(p, 1.0);
}
`;

export const SNOW_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uExposure;
varying float vAlpha;
varying float vSoft;

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
  gl_FragColor = vec4(uColor * uExposure, a);
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
  float grow = 0.42 + 2.35 * pow(u, 0.62);
  float size = aScale * grow;

  /* ---- billboard：先换到视空间再沿屏幕轴展开，与相机朝向无关 ---- */
  vec2 corner = position.xy;            // quad 的 -0.5..0.5
  vec4 viewPos = viewMatrix * vec4(c, 1.0);
  viewPos.xy += corner * size;

  /* ---- 亮度：出生时很浓（白汽），随后变淡消失 ---- */
  float fadeIn = smoothstep(0.0, 0.055, u);
  float fadeOut = 1.0 - smoothstep(0.42, 1.0, u);
  vAlpha = fadeIn * fadeOut * (0.50 + 0.50 * aRand.y);

  /* ---- 假光：靠近车头灯的一侧被染暖 ------------------------------- */
  vec2 d = vec2(c.x - uLampPos.x, c.y - uLampPos.y);
  float lampFall = 1.0 - smoothstep(0.0, 6.5, length(d));
  /* 只有朝灯那一侧（-x 方向）才亮 */
  vWarm = clamp(lampFall * uLampPower * (0.55 - corner.x * 0.85 + 0.25), 0.0, 1.0)
          * smoothstep(0.02, 0.30, u);

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
  vec3 col = mix(uSteamColor, uLampColor, vWarm * 0.85);
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
  /* 窗内：下暗上亮的暖色，再加一条横向暗带（座椅/窗棂的剪影） */
  float up = vUv.y;
  vec3 inner = mix(uWarm, uWarmHot, smoothstep(0.15, 0.95, up) * 0.85);
  /* 垂直方向两端的暗角，让窗户有厚度 */
  inner *= 0.72 + 0.28 * smoothstep(0.0, 0.22, up) * smoothstep(1.0, 0.78, up);
  /* 座椅剪影 */
  float seat = smoothstep(0.30, 0.27, up);
  inner *= 1.0 - seat * 0.42;
  /* 窗棂：一根极细的竖线，给大窗一点结构 */
  float mullion = smoothstep(0.006, 0.0, abs(vUv.x - 0.5));
  inner *= 1.0 - mullion * 0.35;

  /* 暗态：近黑蓝，只留一条冷反光 */
  float streak = smoothstep(0.62, 1.0, vUv.x) * smoothstep(0.55, 0.95, vUv.y);
  vec3 darkc = uDark + vec3(0.020, 0.030, 0.040) * streak;

  vec3 col = mix(darkc, inner, vLit);

  /* 灯管本身的高光溢出：点亮后在窗顶压一条更亮的线 */
  col += uWarmHot * vLit * smoothstep(0.86, 1.0, up) * 0.28;

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
