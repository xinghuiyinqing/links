/* ============================================================================
   world.js —— 天空 / 雪原 / 远山 / 站台 / 车头灯光晕
   ----------------------------------------------------------------------------
   draw call 清单（全部是静态物体，一次建好不再动）：
     1  sky          渐变穹顶
     2  ground       雪原（自定义 shader，闪烁高光 + 假接触阴影 + 窗光 + 灯池）
     3  bed          道砟雪床（复用 ground 材质，多 1 个 draw call 换掉贴图）
     4  mountains    四层山脊幕布合并
     5  treeline     远景针叶林
     6  rails        双轨
     7  sleepers     枕木（InstancedMesh）
     8  stationDark  站台 / 雨棚 / 灯柱 / 水塔 / 信号机 / 电线杆
     9  stationSnow  站台上的积雪
    10  stationBrass 站台黄铜小件
    11  glows        车头灯 + 站台灯 + 信号灯的加色柔光（单次 draw call）
   合计 11。加上列车 13 + 雪 1 + 蒸汽 1 + 光锥 1 = 27。
   ========================================================================== */
import * as THREE from 'three';
import {
  PAL, srgb, srgbColor, clamp, lerp, smoothstep, TAU, makeRng, mergeAll, Batch,
  trackZ, TRACK, disposeTree,
} from './util.js';
import { buildGround, buildMountains, buildTreeline, groundHeight } from './terrain.js';
import { buildTrack, buildStationProps } from './rails.js';
import { SKY_VERT, SKY_FRAG, GROUND_VERT, GROUND_FRAG, GLOW_VERT, GLOW_FRAG } from './glsl.js';

const NOTE = 0; void NOTE;

export function createWorld(renderer, scene, tierName, tier) {
  const group = new THREE.Group();
  group.name = 'world';
  scene.add(group);

  /* ------------------------------------------------------------- 雾 ----
     雾色 = 天空地平线色，保证远山/铁轨/站台都能无缝融进天里。 */
  const fogColor = srgbColor(PAL.snow1);
  scene.fog = new THREE.Fog(fogColor, 62, 215);

  /* ============================================================== 天空 */
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: srgb(PAL.snow0) },
      uHorizon: { value: srgb(PAL.snow1) },
      uBelow: { value: srgb(0xdfe8f0) },
      uSunDir: { value: new THREE.Vector3(-0.34, 0.42, 0.84) },
      uSunTint: { value: srgb(0xfff2e0) },
      uCloud: { value: srgb(0xdae5ef) },
      uExposure: { value: 1 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const skyGeo = new THREE.SphereGeometry(520, 24, 16);
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  sky.name = 'sky';
  group.add(sky);

  /* ---- 用同一套天空烤一张 PMREM 环境，钢和铜才有东西可反 ---- */
  let envRT = null;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(
      new THREE.SphereGeometry(40, 20, 12),
      skyMat,
    );
    envScene.add(envSky);
    /* 下半球补一层雪地色的亮面，否则金属的下半部会反出一片黑 */
    const envGround = new THREE.Mesh(
      new THREE.SphereGeometry(39, 16, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
      new THREE.MeshBasicMaterial({ color: srgbColor(PAL.snow0), side: THREE.BackSide }),
    );
    envScene.add(envGround);
    envRT = pmrem.fromScene(envScene, 0, 1, 200);
    /* 环境贴图只留给需要金属反光的少数材质：全局 scene.environment 会让
     所有 MeshStandardMaterial 都走 IBL 分支（每像素贵一大截），而车体/客车
     占了画面三分之一以上的像素 —— 本机 Intel UHD 核显在这里直接掉帧。
     改成不挂全局环境，靠 3 盏灯 + 高光把金属感做出来。 */
  scene.environment = null;
    scene.environmentIntensity = 0.9;
    envSky.geometry.dispose();
    envGround.geometry.dispose();
    envGround.material.dispose();
    pmrem.dispose();
  } catch (e) {
    /* 环境贴图失败不影响主画面，金属会稍微平一点 */
    if (typeof console !== 'undefined') console.warn('[wintertrain] env map skipped:', e && e.message);
  }

  /* ============================================================== 雪原 */
  const groundUniforms = {
    uTime: { value: 0 },
    uExposure: { value: 1 },
    uSparkle: { value: tier.sparkle },
    uSnowLit: { value: srgb(PAL.snow0) },
    uSnowShade: { value: srgb(0xc0d3e1) },
    uHorizon: { value: srgb(PAL.snow1) },
    uLampColor: { value: srgb(PAL.lampDeep) },
    uLampPos: { value: new THREE.Vector2(0, 3.2) },
    uLampRadius: { value: 8.5 },
    uLampPower: { value: 0.0 },
    uWin: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uWinColor: { value: srgb(0xff9b3a) },
    uTrainShade: { value: new THREE.Vector4(0, 0, 2.4, 0.40) },
    uCamXZ: { value: new THREE.Vector2() },
    uFogNear: { value: 58 },
    uFogFar: { value: 205 },
  };
  const groundMat = new THREE.ShaderMaterial({
    uniforms: groundUniforms,
    vertexShader: GROUND_VERT,
    fragmentShader: GROUND_FRAG,
    fog: false,
    /* 高度场是手工按行/列生成的，三角形绕序不可靠 —— 双面渲染保证从上方一定看得见。
       雪原永远只从上方看，多画一遍背面的代价可以忽略。 */
    side: THREE.DoubleSide,
  });

  const groundGeo = buildGround(tier);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.name = 'ground';
  ground.frustumCulled = false;
  group.add(ground);

  /* ============================================================== 轨道 */
  const track = buildTrack();

  const bedMesh = new THREE.Mesh(track.bedGeo, groundMat);
  bedMesh.name = 'trackbed';
  bedMesh.frustumCulled = false;
  group.add(bedMesh);

  const railMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x394b59),
    metalness: 0.88,
    roughness: 0.33,
    envMapIntensity: 1.0,
  });
  const rails = new THREE.Mesh(track.railGeo, railMat);
  rails.name = 'rails';
  rails.frustumCulled = false;
  group.add(rails);

  const sleeperMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x2a2019),
    metalness: 0.05,
    roughness: 0.95,
    vertexColors: true,
    envMapIntensity: 0.25,
  });
  const sleepers = new THREE.InstancedMesh(track.sleeperGeo, sleeperMat, track.sleeperCount);
  sleepers.name = 'sleepers';
  sleepers.frustumCulled = false;
  for (let i = 0; i < track.sleeperCount; i++) {
    sleepers.setMatrixAt(i, track.sleeperMatrices[i]);
  }
  sleepers.instanceMatrix.needsUpdate = true;
  group.add(sleepers);

  /* ============================================================== 远山 */
  const mountainGeo = buildMountains();
  const mountainMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const mountains = new THREE.Mesh(mountainGeo, mountainMat);
  mountains.name = 'mountains';
  mountains.frustumCulled = false;
  mountains.renderOrder = -900;
  group.add(mountains);

  const treelineGeo = buildTreeline();
  const treeline = new THREE.Mesh(treelineGeo, mountainMat);
  treeline.name = 'treeline';
  treeline.frustumCulled = false;
  treeline.renderOrder = -800;
  group.add(treeline);

  /* ============================================================== 站台 */
  const props = buildStationProps();
  const propMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x1a232c),
    metalness: 0.55,
    roughness: 0.58,
    vertexColors: true,
    envMapIntensity: 0.7,
  });
  let stationDark = null, stationBrass = null;
  if (props.darkGeo) {
    stationDark = new THREE.Mesh(props.darkGeo, propMat);
    stationDark.name = 'stationDark';
    stationDark.frustumCulled = false;
    group.add(stationDark);
  }
  if (props.brassGeo) {
    stationBrass = new THREE.Mesh(props.brassGeo, new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xa8843c),
      metalness: 1.0,
      roughness: 0.30,
      vertexColors: true,
      envMapIntensity: 1.2,
    }));
    stationBrass.name = 'stationBrass';
    stationBrass.frustumCulled = false;
    group.add(stationBrass);
  }

  /* 站台上的积雪：几条压扁的板子，便宜但立刻有「雪停了一夜」的感觉 */
  let stationSnow = null;
  {
    const b = new Batch(2.0);
    const snowShade = function (x, y, z, col, o) {
      const n = 0.94 + 0.06 * ((x * 3.1 + z * 1.7) % 1 < 0 ? -1 : 1) * 0.5;
      col[o] = n; col[o + 1] = n; col[o + 2] = n * 1.01;
    };
    /* 站台面 */
    b.box(45.8, 0.07, 3.0, -8, props.platTop + 0.055, props.platZ, snowShade);
    /* 雨棚顶 */
    b.box(45.8, 0.10, 3.36, -8, props.platTop + 3.66, props.platZ - 0.55, snowShade);
    /* 站台边缘挂下来的一条雪檐 */
    b.box(45.8, 0.16, 0.30, -8, props.platTop - 0.02, props.platZ + 1.56, snowShade);
    /* 灯柱顶上的雪帽 */
    for (let i = 0; i < 4; i++) {
      const px = -28 + i * 12.5;
      b.cyl(0.34, 0.18, 0.10, 10, px, props.platTop + 4.32, props.platZ + 0.9, snowShade);
    }
    /* 水塔顶 */
    b.cyl(1.30, 1.12, 0.14, 14, 34, 7.92, -16, snowShade);
    const g = b.build();
    if (g) {
      stationSnow = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: new THREE.Color(0xf2f7fb),
        metalness: 0.06,
        roughness: 0.88,
        vertexColors: true,
        envMapIntensity: 0.5,
      }));
      stationSnow.name = 'stationSnow';
      stationSnow.frustumCulled = false;
      group.add(stationSnow);
    }
  }

  /* ========================================================== 加色柔光点 */
  const GLOW_N = 7;
  const glowPos = new Float32Array(GLOW_N * 3);
  const glowCol = new Float32Array(GLOW_N * 3);
  const glowSize = new Float32Array(GLOW_N);
  const glowPhase = new Float32Array(GLOW_N);

  /* 0 = 车头灯（每帧跟着机车走） */
  glowPos[0] = 0; glowPos[1] = 2.94; glowPos[2] = 0.2;
  const lampC = srgb(0xffd9a0);
  glowCol[0] = lampC.x; glowCol[1] = lampC.y; glowCol[2] = lampC.z;
  glowSize[0] = 1.55;
  glowPhase[0] = 1.7;

  /* 1..4 = 站台灯 */
  const pl = props.lampPos;
  const platC = srgb(0xffb257);
  for (let i = 0; i < 4; i++) {
    const o = (i + 1) * 3;
    glowPos[o] = pl[i * 3];
    glowPos[o + 1] = pl[i * 3 + 1];
    glowPos[o + 2] = pl[i * 3 + 2] + 0.02;
    glowCol[o] = platC.x; glowCol[o + 1] = platC.y; glowCol[o + 2] = platC.z;
    glowSize[i + 1] = 0.62;
    glowPhase[i + 1] = 3.1 + i * 1.7;
  }
  /* 5 = 信号机的红点（全画面唯一的第二个非暖色，警示用）
     6 = 信号机绿灯（暗） */
  const sigC = srgb(0xff5a4a);
  glowPos[15] = 20; glowPos[16] = 3.2; glowPos[17] = -3.44;
  glowCol[15] = sigC.x; glowCol[16] = sigC.y; glowCol[17] = sigC.z;
  glowSize[5] = 0.30; glowPhase[5] = 0.4;
  const sigC2 = srgb(0x79cfe6);
  glowPos[18] = 34; glowPos[19] = 7.2; glowPos[20] = -16.1;
  glowCol[18] = sigC2.x; glowCol[19] = sigC2.y; glowCol[20] = sigC2.z;
  glowSize[6] = 0.22; glowPhase[6] = 2.6;

  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPos, 3));
  glowGeo.setAttribute('aColor', new THREE.BufferAttribute(glowCol, 3));
  glowGeo.setAttribute('aSize', new THREE.BufferAttribute(glowSize, 1));
  glowGeo.setAttribute('aPhase', new THREE.BufferAttribute(glowPhase, 1));
  glowGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 6, 0), 300);

  const glowMat = new THREE.ShaderMaterial({
    uniforms: {
      uHeightK: { value: 900 },
      uTime: { value: 0 },
      uFlicker: { value: 1 },
      uPower: { value: 1.0 },
      uExposure: { value: 1 },
    },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const glows = new THREE.Points(glowGeo, glowMat);
  glows.name = 'glows';
  glows.frustumCulled = false;
  glows.renderOrder = 24;
  group.add(glows);

  /* ============================================================ 更新接口 */
  const U = groundUniforms;
  let sparkleOn = tier.sparkle > 0;

  function update(S, camera, viewHeightDevice, fovRad) {
    const t = S.tSec;
    U.uTime.value = t;
    U.uExposure.value = S.exposure;
    skyMat.uniforms.uExposure.value = S.exposure;
    groundMat.uniforms.uSparkle.value = sparkleOn ? tier.sparkle : 0;

    /* ---- 车头灯在雪上的那个光池 ---- */
    const lampX = S.lampX;
    U.uLampPos.value.set(lampX + 3.2, 3.0);
    U.uLampPower.value = (0.30 + 0.20 * S.exposure) * (S.state === 'settled' ? 1 : 0.95);
    U.uLampRadius.value = 8.4;

    /* ---- 四扇窗在雪上烤出的暖斑 ---- */
    const wv = U.uWin.value;
    for (let i = 0; i < 4; i++) {
      const v = wv[i];
      /* x = 窗中心，z 略前于车身，半径 3.4（≈ 窗宽的 1.6 倍），强度 = lit */
      v.x = S.winX[i];
      v.y = 2.15;
      v.z = 3.40;
      v.w = S.lit[i];
    }

    /* ---- 车底那条拉长的假接触阴影 ---- */
    U.uTrainShade.value.x = S.trainX - 26.7;
    U.uTrainShade.value.y = S.trainX + 26.7;
    U.uTrainShade.value.z = 2.5;
    U.uTrainShade.value.w = 0.42;

    /* ---- 光晕点 ---- */
    glowMat.uniforms.uTime.value = t;
    glowMat.uniforms.uExposure.value = S.exposure;
    glowMat.uniforms.uFlicker.value = S.reduced ? 0 : 1;
    /* 车头灯的位置跟着机车走（只写一个顶点，成本可以忽略） */
    glowGeo.attributes.position.array[0] = lampX;
    glowGeo.attributes.position.needsUpdate = true;
    /* 亮度随「点灯进度」一起上来：停稳前灯是暗的 */
    glowMat.uniforms.uPower.value = 0.55 + 0.45 * S.ignite;

    /* 车头灯在视空间的位置：给雪花算「是否落在灯锥里」用 */
    if (S.lampView) {
      S.lampView.x = lampX; S.lampView.y = S.lampY || 2.94; S.lampView.z = 0.4;
      S.lampView.applyMatrix4(camera.matrixWorldInverse);
      if (S.snowCone) S.snowCone(S.lampView.x, S.lampView.y, S.lampView.z, 0.55 + 0.35 * S.exposure);
    }
    void viewHeightDevice; void fovRad;
  }

  function setPixelRatio(heightDevicePx, fovRad) {
    glowMat.uniforms.uHeightK.value = (heightDevicePx * 0.5) / Math.tan(fovRad * 0.5);
  }

  return {
    group,
    groundMat,
    skyMat,
    glowMat,
    update,
    setPixelRatio,
    setSparkle(on) { sparkleOn = !!on; },
    dispose() {
      if (envRT) envRT.dispose();
      disposeTree(group);
      if (scene.fog) scene.fog = null;
      scene.environment = null;
      void makeRng; void mergeAll; void trackZ; void TRACK; void groundHeight;
      void clamp; void lerp; void smoothstep; void TAU; void stationDark;
      void stationBrass; void stationSnow; void sleepers; void rails; void mountains;
      void treeline;
    },
  };
}
