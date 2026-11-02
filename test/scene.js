// 테스트용 과일 장면: 정답을 아는 카메라 사진을 계산으로 그린다(계산식과 독립적으로)
// detect.test.js(인식·크기)와 app-flow.test.js(화면 흐름)가 함께 쓴다
const { cameraDirToWorld, normalize, pixelToRay } = require("../measure.js");

// 아래를 pitchDeg만큼 내려다보는 카메라(카메라 → 세계 행렬, 열 우선)
function cameraPose(position, pitchDeg) {
  const t = (pitchDeg * Math.PI) / 180;
  const up = [0, Math.cos(t), -Math.sin(t)];
  const back = [0, Math.sin(t), Math.cos(t)]; // 카메라 +z(앞의 반대)
  return [1, 0, 0, 0, up[0], up[1], up[2], 0, back[0], back[1], back[2], 0, position[0], position[1], position[2], 1];
}

// 장면: 테이블(y=0) 위 반지름 r 구. 옵션으로 그림자, 반사광, 경계에 붙은 과일색 물체(윤곽 끊김), 꼭지, 잡음
function render(opt) {
  const { width, height, k, pose, center, r } = opt;
  const cam = [pose[12], pose[13], pose[14]];
  const table = opt.table || [120, 118, 112];
  const fruit = opt.fruit || [235, 140, 25];
  const light = normalize([0.4, 1, 0.3]);
  let noiseSeed = 7;
  const noise = () => {
    noiseSeed = (noiseSeed * 1103515245 + 12345) % 2147483648;
    return (noiseSeed / 2147483648 - 0.5) * 2 * (opt.noise || 0);
  };
  const data = new Uint8ClampedArray(width * height * 4);
  const SS = 2; // 경계가 매끄럽도록 한 픽셀을 2x2로 나눠 그린다
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = { x: x + (sx + 0.5) / SS, y: y + (sy + 0.5) / SS };
          const c = shade(normalize(cameraDirToWorld(pose, pixelToRay(p, k))));
          for (let i = 0; i < 3; i++) sum[i] += c[i];
        }
      }
      const o = (y * width + x) * 4;
      for (let i = 0; i < 3; i++) data[o + i] = sum[i] / (SS * SS) + noise();
      data[o + 3] = 255;
    }
  }
  return { width, height, data };

  function shade(u) {
    // 옆에 놓인 다른 과일(옵션 other: { center, r, color }). 시험 장면에서는 서로 가리지 않게 떨어뜨려 둔다
    if (opt.other) {
      const o = opt.other;
      const oc2 = [cam[0] - o.center[0], cam[1] - o.center[1], cam[2] - o.center[2]];
      const b2 = oc2[0] * u[0] + oc2[1] * u[1] + oc2[2] * u[2];
      if (b2 < 0 && b2 * b2 - (oc2[0] ** 2 + oc2[1] ** 2 + oc2[2] ** 2 - o.r * o.r) >= 0) return o.color;
    }
    // 과일(가로 반지름 r, 세로 반지름 rc인 회전타원체)과 만나는지: 세로를 r/rc배 늘려 구로 바꿔 푼다
    const rc = opt.rc || r;
    const q = r / rc;
    const oc = [cam[0] - center[0], (cam[1] - center[1]) * q, cam[2] - center[2]];
    const v = [u[0], u[1] * q, u[2]];
    const vv = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
    const b = oc[0] * v[0] + oc[1] * v[1] + oc[2] * v[2];
    const disc = b * b - vv * (oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - r * r);
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / vv;
      const hit = [cam[0] + u[0] * t, cam[1] + u[1] * t, cam[2] + u[2] * t];
      const n = normalize([(hit[0] - center[0]) / r ** 2, (hit[1] - center[1]) / rc ** 2, (hit[2] - center[2]) / r ** 2]);
      // 꼭지: stem이 숫자면 꼭지 크기(위쪽 법선의 cos 문턱값, 작을수록 큰 꼭지). true면 작은 꼭지(0.985)
      if (opt.stem && n[1] > (typeof opt.stem === "number" ? opt.stem : 0.985)) return [90, 70, 30];
      // 카메라 쪽을 향한 꼭지(위에서 내려다볼 때처럼 사진 속 과일 가운데에 보이는 꼭지). 값은 cos 문턱값
      if (opt.facingStem && -(n[0] * u[0] + n[1] * u[1] + n[2] * u[2]) > opt.facingStem) return [90, 70, 30];
      const lambert = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
      const view = -(n[0] * u[0] + n[1] * u[1] + n[2] * u[2]);
      if (opt.highlight && lambert > 0.97 && view > 0.5) return [255, 245, 225];
      const f = 0.45 + 0.55 * lambert;
      return fruit.map((v) => v * f);
    }
    // 테이블
    if (u[1] >= 0) return [200, 200, 200];
    const t = -cam[1] / u[1];
    const p = [cam[0] + u[0] * t, 0, cam[2] + u[2] * t];
    // 과일 밑에 깐 밝은 접시(반지름 m): 과일을 감싸는 더 큰 윤곽
    if (opt.plate && Math.hypot(p[0] - center[0], p[2] - center[2]) < opt.plate) return [235, 235, 228];
    if (opt.blob) {
      // 과일 옆에 붙은 과일색 물체: 이쪽 윤곽이 끊긴다
      const bx = center[0] + r * 1.15, bz = center[2];
      if (Math.hypot(p[0] - bx, p[2] - bz) < r * 0.45) return fruit.map((v) => v * 0.9);
    }
    if (opt.shadow) {
      const sx = center[0] - r * 0.5, sz = center[2] - r * 0.4;
      if (Math.hypot(p[0] - sx, p[2] - sz) < r * 1.25) return table.map((v) => v * 0.45);
    }
    return table;
  }
}

// 구 중심이 사진에 찍히는 위치를 가리킨 지점으로 쓴다
function seedFor(opt) {
  const cam = [opt.pose[12], opt.pose[13], opt.pose[14]];
  const m = opt.pose;
  const w = [opt.center[0] - cam[0], opt.center[1] - cam[1], opt.center[2] - cam[2]];
  // 세계 → 카메라: 회전의 전치
  const c = [
    m[0] * w[0] + m[1] * w[1] + m[2] * w[2],
    m[4] * w[0] + m[5] * w[1] + m[6] * w[2],
    m[8] * w[0] + m[9] * w[1] + m[10] * w[2],
  ];
  const img = [c[0], -c[1], -c[2]];
  return {
    x: opt.k.cx + opt.k.fx * img[0] / img[2] + (opt.seedShift || [0, 0])[0],
    y: opt.k.cy + opt.k.fy * img[1] / img[2] + (opt.seedShift || [0, 0])[1],
  };
}

// 기울기 tiltDeg 방향에서 from → to(m)까지 n장. 카메라는 늘 과일 쪽을 내려다보고, 걸음마다 조금씩 흔들린다
function approachFrames(r, tiltDeg, from, to, n, extra) {
  const center = [0.01, r, -0.015];
  const k = { fx: 480, fy: 480, cx: 240, cy: 320, width: 480, height: 640 };
  return Array.from({ length: n }, (_, i) => {
    const dist = from + ((to - from) * i) / (n - 1);
    const pitch = 90 - tiltDeg + Math.sin(i * 1.7) * 3; // 손떨림으로 각도가 조금씩 바뀜
    const t = (pitch * Math.PI) / 180;
    const pos = [center[0] + Math.sin(i * 1.1) * 0.01, center[1] + dist * Math.sin(t), center[2] + dist * Math.cos(t)];
    return { width: 480, height: 640, k, pose: cameraPose(pos, pitch), center, r, ...extra };
  });
}


module.exports = { cameraPose, render, seedFor, approachFrames };
