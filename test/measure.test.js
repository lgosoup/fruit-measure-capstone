// 계산식 단위 테스트. 실행: node test/measure.test.js
const assert = require("node:assert/strict");
const m = require("../measure.js");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`통과  ${name}`);
  } catch (error) {
    failed++;
    console.log(`실패  ${name}\n      ${error.message}`);
  }
}
const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} (기대 ${expected} ± ${tol})`);

// 지름 d(m) 과일을 center(테이블 위 x, z)에 두고, 카메라에서 가장자리(높이 r)를 겨눈 시선이 테이블에 닿는 두 점을 만든다
function tableHits(camera, cx, cz, d, dirX, dirZ) {
  const r = d / 2;
  const H = camera[1];
  const len = Math.hypot(dirX, dirZ);
  const ux = dirX / len, uz = dirZ / len;
  return [1, -1].map((s) => {
    const ex = cx + s * r * ux, ez = cz + s * r * uz;  // 가장자리(높이 r)
    const k = H / (H - r);                              // 시선을 테이블(높이 0)까지 연장
    return [camera[0] + (ex - camera[0]) * k, 0, camera[2] + (ez - camera[2]) * k];
  });
}

// ---------- 3단계: AR 크기 측정 ----------
test("카드 기준 보정식과 같은 결과 (높이 400mm, 측정 75mm)", () => {
  const camera = [0, 0.4, 0];
  const r = m.measureFruitAr([-0.0375, 0, 0], [0.0375, 0, 0], camera);
  near(r.sizeMm, m.correctRoundFruit(75, 400), 1e-9, "크기");
  near(r.rawMm, 75, 1e-9, "보정 전");
  near(r.heightMm, 400, 1e-9, "높이");
});

test("카메라 바로 아래 지름 70mm 과일: 크기 70mm, 표면까지 거리 = 높이 - 지름", () => {
  const camera = [0, 0.4, 0];
  const [a, b] = tableHits(camera, 0, 0, 0.07, 1, 0);
  const r = m.measureFruitAr(a, b, camera);
  near(r.sizeMm, 70, 1e-6, "크기");
  near(r.distanceMm, 400 - 70, 1e-6, "거리");
});

test("옆으로 비켜 있는 과일(가로 50mm, 세로 20mm 떨어짐): 크기와 거리", () => {
  const camera = [0, 0.35, 0];
  const [a, b] = tableHits(camera, 0.05, 0.02, 0.065, 0.05, 0.02);
  const r = m.measureFruitAr(a, b, camera);
  near(r.sizeMm, 65, 1e-6, "크기");
  const expected = (Math.hypot(0.05, 0.35 - 0.0325, 0.02) - 0.0325) * 1000;
  near(r.distanceMm, expected, 1e-6, "거리");
});

test("같은 위치 두 점은 계산하지 않음", () => {
  assert.equal(m.measureFruitAr([0.1, 0, 0.1], [0.1, 0, 0.1], [0, 0.4, 0]), null);
});

test("카메라가 테이블이나 과일 꼭대기보다 낮으면 계산하지 않음", () => {
  assert.equal(m.measureFruitAr([0, 0, 0], [0.07, 0, 0], [0, -0.1, 0]), null);
  assert.equal(m.measureFruitAr([0, 0, 0], [0.07, 0, 0], [0, 0.03, 0]), null);
});

// ---------- 카메라 값 ----------
test("투영 행렬에서 초점거리와 중심", () => {
  const p = new Float32Array(16);
  p[0] = 2 * 300 / 360; p[5] = 2 * 300 / 780; p[8] = 0.1; p[9] = -0.05;
  const k = m.intrinsicsFromProjection(p, 360, 780);
  near(k.fx, 300, 1e-4, "fx");
  near(k.fy, 300, 1e-4, "fy");
  near(k.cx, 162, 1e-4, "cx");
  near(k.cy, 370.5, 1e-4, "cy");
});

test("세계 좌표를 화면 좌표로: 정면 점은 화면 가운데", () => {
  const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const p = new Float32Array(16);
  p[0] = 1.5; p[5] = 0.7; p[10] = -1; p[11] = -1; p[14] = -0.02;
  const s = m.projectToScreen([0, 0, -1], ident, p, 400, 800);
  near(s.x, 200, 1e-6, "x");
  near(s.y, 400, 1e-6, "y");
  assert.equal(m.projectToScreen([0, 0, 1], ident, p, 400, 800), null);
});

// ---------- 4단계: 사진으로 거리 계산 ----------
// 카메라 좌표(z가 앞쪽, y가 아래쪽)에서 중심 c, 반지름 r인 구의 양 끝(접하는 시선)을 사진 좌표로 만든다
function sphereEdges(c, r, k, side) {
  const d = Math.hypot(...c);
  const u = c.map((v) => v / d);
  // u에 수직이고 side 방향 성분이 있는 단위 벡터
  const dot = side[0] * u[0] + side[1] * u[1] + side[2] * u[2];
  let w = side.map((v, i) => v - dot * u[i]);
  const wl = Math.hypot(...w);
  w = w.map((v) => v / wl);
  const alpha = Math.asin(r / d);
  return [1, -1].map((s) => {
    const ray = u.map((v, i) => Math.cos(alpha) * v + s * Math.sin(alpha) * w[i]);
    return { x: k.fx * ray[0] / ray[2] + k.cx, y: k.fy * ray[1] / ray[2] + k.cy };
  });
}
const K = { fx: 1500, fy: 1500, cx: 540, cy: 1200 };

test("사진 가운데 지름 70mm 과일, 표면까지 100mm", () => {
  const [p1, p2] = sphereEdges([0, 0, 135], 35, K, [1, 0, 0]);
  const r = m.distanceFromPhoto(p1, p2, K, 70);
  near(r.distanceMm, 100, 1e-6, "거리");
  near(r.centerMm, 135, 1e-6, "중심");
});

test("사진 가장자리 쪽(옆·아래로 비킨) 과일도 같은 거리", () => {
  const c = [60, 80, 100];
  const d = Math.hypot(...c);
  const [p1, p2] = sphereEdges(c, 32.5, K, [0.3, 1, 0]);
  const r = m.distanceFromPhoto(p1, p2, K, 65);
  near(r.distanceMm, d - 32.5, 1e-6, "거리");
});

test("단순 비례식(초점거리 x 지름 / 사진 속 지름)은 근거리에서 짧게 나옴", () => {
  const [p1, p2] = sphereEdges([0, 0, 135], 35, K, [1, 0, 0]);
  const naiveCenter = K.fx * 70 / Math.hypot(p1.x - p2.x, p1.y - p2.y);
  assert.ok(naiveCenter < 135 * 0.97, `단순식 ${naiveCenter}`);
});

test("같은 위치 두 점, 크기 없음은 계산하지 않음", () => {
  assert.equal(m.distanceFromPhoto({ x: 10, y: 10 }, { x: 10, y: 10 }, K, 70), null);
  assert.equal(m.distanceFromPhoto({ x: 0, y: 10 }, { x: 100, y: 10 }, K, 0), null);
});

// ---------- 14단계: 회전타원체(가로·세로) ----------
// 테이블(y=0) 위 회전타원체(가로 반지름 a, 세로 반지름 c)를 카메라에서 본 윤곽 시선을 직접 찾는다.
// 시선이 과일에 닿는지를 이차방정식으로 판정하고, 닿음/안 닿음이 바뀌는 각도를 이분법으로 찾는다(계산식과 독립)
function hitsSpheroid(camera, center, a, c, u) {
  const k = a / c;
  const p = [camera[0] - center[0], (camera[1] - center[1]) * k, camera[2] - center[2]];
  const v = [u[0], u[1] * k, u[2]];
  const pv = p[0] * v[0] + p[1] * v[1] + p[2] * v[2];
  const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const pp = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
  return pv * pv - vv * (pp - a * a) >= 0 && pv < 0;
}

function spheroidSilhouette(camera, center, a, c, angles) {
  const w = m.normalize([center[0] - camera[0], center[1] - camera[1], center[2] - camera[2]]);
  // e1: 수평 방향(가로), e2: 그에 수직(세로 쪽)
  const e1 = m.normalize([w[2], 0, -w[0]]);
  const e2 = [w[1] * e1[2] - w[2] * e1[1], w[2] * e1[0] - w[0] * e1[2], w[0] * e1[1] - w[1] * e1[0]];
  return angles.map((t) => {
    const side = [0, 1, 2].map((i) => Math.cos(t) * e1[i] + Math.sin(t) * e2[i]);
    const dir = (phi) => [0, 1, 2].map((i) => Math.cos(phi) * w[i] + Math.sin(phi) * side[i]);
    let lo = 0, hi = Math.PI / 2;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (hitsSpheroid(camera, center, a, c, dir(mid))) lo = mid;
      else hi = mid;
    }
    return dir((lo + hi) / 2);
  });
}

// 카메라에서 과일 중심을 향한 선이 표면과 만나는 점까지의 실제 거리(mm)
function trueSpheroidDistanceMm(camera, center, a, c) {
  const v = [center[0] - camera[0], center[1] - camera[1], center[2] - camera[2]];
  const d = Math.hypot(...v);
  const w = v.map((x) => x / d);
  return (d - 1 / Math.sqrt((w[0] ** 2 + w[2] ** 2) / a ** 2 + w[1] ** 2 / c ** 2)) * 1000;
}

// 과일에서 tiltDeg만큼 기운 방향으로 dist(m) 떨어진 카메라
function cameraAt(center, tiltDeg, dist, azimuthDeg = 30) {
  const t = (tiltDeg * Math.PI) / 180, az = (azimuthDeg * Math.PI) / 180;
  return [center[0] + dist * Math.sin(t) * Math.sin(az), center[1] + dist * Math.cos(t), center[2] + dist * Math.sin(t) * Math.cos(az)];
}

const ALL_ANGLES = Array.from({ length: 48 }, (_, i) => (i / 48) * Math.PI * 2);

test("늘리기와 되돌리기: 원래 점으로 돌아옴", () => {
  const p = [0.1, 0.07, -0.2];
  const back = m.stretchPoint(m.stretchPoint(p, 1.25, 0.02), 1 / 1.25, 0.02);
  p.forEach((v, i) => near(back[i], v, 1e-12, `좌표 ${i}`));
});

test("가로=세로(구)이면 기존 구 계산과 같은 결과", () => {
  const center = [0.02, 0.035, -0.01];
  const camera = cameraAt(center, 45, 0.4);
  const rays = spheroidSilhouette(camera, center, 0.035, 0.035, ALL_ANGLES);
  const sphere = m.fitCone(rays);
  const old = m.measureFruitCone(sphere.d, sphere.sinA, camera, 0);
  const now = m.measureSpheroidCone(m.fitConeStretched(rays, 1).cone, 1, camera, 0);
  near(now.widthMm, old.sizeMm, 1e-6, "가로");
  near(now.verticalMm, old.sizeMm, 1e-6, "세로");
  near(now.distanceMm, old.distanceMm, 1e-6, "거리");
});

test("납작한 과일(가로 80, 세로 64mm)을 45도로 봄: 비율을 찾아 가로·세로·거리 0.5% 이내", () => {
  const a = 0.04, c = 0.032;
  const center = [0.03, c, -0.02];
  const camera = cameraAt(center, 45, 0.42);
  const r = m.measureSpheroidRays(spheroidSilhouette(camera, center, a, c, ALL_ANGLES), camera, 0);
  near(r.widthMm, 80, 0.4, "가로");
  near(r.verticalMm, 64, 0.32, "세로");
  const truth = trueSpheroidDistanceMm(camera, center, a, c);
  near(r.distanceMm, truth, truth * 0.005, "거리");
  near(r.tiltDeg, 45, 0.5, "기운 각도");
});

test("세로가 긴 과일(가로 70, 세로 84mm)을 60도로 봄: 가로·세로 0.5% 이내", () => {
  const a = 0.035, c = 0.042;
  const center = [-0.01, c, 0.02];
  const camera = cameraAt(center, 60, 0.38, -40);
  const r = m.measureSpheroidRays(spheroidSilhouette(camera, center, a, c, ALL_ANGLES), camera, 0);
  near(r.widthMm, 70, 0.35, "가로");
  near(r.verticalMm, 84, 0.42, "세로");
});

test("점 4개(가로 양 끝, 세로 위·아래 끝)만으로도 가로·세로 1% 이내", () => {
  const a = 0.04, c = 0.033;
  const center = [0, c, 0];
  const camera = cameraAt(center, 50, 0.4);
  const four = spheroidSilhouette(camera, center, a, c, [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
  const r = m.measureSpheroidRays(four, camera, 0);
  near(r.widthMm, 80, 0.8, "가로");
  near(r.verticalMm, 66, 0.66, "세로");
});

test("거의 바로 위에서 보면 기운 각도가 작게 나옴(세로를 믿을 수 없음을 알 수 있음)", () => {
  const center = [0, 0.032, 0];
  const camera = cameraAt(center, 8, 0.4);
  const r = m.measureSpheroidRays(spheroidSilhouette(camera, center, 0.04, 0.032, ALL_ANGLES), camera, 0);
  assert.ok(r.tiltDeg < 10, `기운 각도 ${r.tiltDeg}`);
});

test("시선이 4개보다 적으면 계산하지 않음", () => {
  assert.equal(m.measureSpheroidRays([[0, -1, 0], [0.1, -1, 0], [0, -1, 0.1]], [0, 0.4, 0], 0), null);
});

// ---------- 14단계: 다가가며 여러 위치에서 크기 정하기 ----------
// 카메라가 path의 위치들을 지나며 과일을 본다. 위치마다 윤곽 시선(정답과 독립적으로 이분법으로 찾음)을 원뿔로 맞춰 넣는다
function viewsAlong(path, center, a, c) {
  return path.map((origin) => {
    const cone = m.fitCone(spheroidSilhouette(origin, center, a, c, ALL_ANGLES));
    return { origin, d: cone.d, sinA: cone.sinA };
  });
}

// 과일 중심에서 tiltDeg만큼 기운 방향으로 from → to(m)까지 n걸음 곧장 다가가는 경로. side(m)만큼 옆으로 흔들 수 있다
function approachPath(center, tiltDeg, from, to, n, side = 0) {
  return Array.from({ length: n }, (_, i) => {
    const dist = from + ((to - from) * i) / (n - 1);
    const p = cameraAt(center, tiltDeg, dist);
    return [p[0] + side * Math.sin(i * 1.3), p[1], p[2] + side * Math.cos(i * 0.7)];
  });
}

test("곧장 다가감(40 → 20cm, 기울기 45도): 지름 70mm와 중심 0.5% 이내", () => {
  const center = [0.02, 0.035, -0.01];
  const r = m.fitSphereViews(viewsAlong(approachPath(center, 45, 0.4, 0.2, 8), center, 0.035, 0.035));
  near(r.sizeMm, 70, 0.35, "지름");
  near(Math.hypot(r.center[0] - center[0], r.center[1] - center[1], r.center[2] - center[2]) * 1000, 0, 0.5, "중심 어긋남(mm)");
});

test("옆으로 흔들며 다가감(바로 위에 가까운 10도): 지름 0.5% 이내", () => {
  const center = [0, 0.04, 0];
  const r = m.fitSphereViews(viewsAlong(approachPath(center, 10, 0.38, 0.18, 10, 0.03), center, 0.04, 0.04));
  near(r.sizeMm, 80, 0.4, "지름");
});

// 구로 보므로 납작한 과일은 비스듬히 볼수록 세로가 섞여 조금 작게 나온다(납작 15%면 10~60도에서 80 → 75mm).
// 크기는 보정 값이라 이 정도는 받아들이고, 세로와 가로 사이에서 각도에 따라 6% 안쪽으로 달라지는지만 본다
test("조금 납작한 과일(가로 80, 세로 68mm): 보는 각도가 달라도 지름 차이 6% 이내, 세로와 가로 사이", () => {
  const center = [0, 0.034, 0];
  const a = m.fitSphereViews(viewsAlong(approachPath(center, 20, 0.4, 0.2, 8), center, 0.04, 0.034));
  const b = m.fitSphereViews(viewsAlong(approachPath(center, 55, 0.4, 0.2, 8, 0.02), center, 0.04, 0.034));
  assert.ok(Math.abs(a.sizeMm - b.sizeMm) / b.sizeMm < 0.06, `경로1 ${a.sizeMm.toFixed(1)}mm, 경로2 ${b.sizeMm.toFixed(1)}mm`);
  for (const x of [a, b]) assert.ok(x.sizeMm > 68 && x.sizeMm < 80.1, `지름 ${x.sizeMm.toFixed(1)}mm는 세로와 가로 사이`);
});

test("폰이 거의 움직이지 않으면(5cm 미만) 크기를 정하지 않음", () => {
  const center = [0, 0.035, 0];
  const views = viewsAlong(approachPath(center, 45, 0.35, 0.32, 5), center, 0.035, 0.035);
  assert.equal(m.fitSphereViews(views), null);
});

test("위치가 3개보다 적으면 크기를 정하지 않음", () => {
  const center = [0, 0.035, 0];
  assert.equal(m.fitSphereViews(viewsAlong(approachPath(center, 45, 0.4, 0.2, 2), center, 0.035, 0.035)), null);
});

test("크기 확정: 마지막 5번이 2% 안쪽으로 모여야 정함", () => {
  assert.equal(m.isSizeStable([70, 71, 70.5, 70.2]), false, "4번뿐");
  assert.equal(m.isSizeStable([60, 75, 70.1, 70.4, 69.9, 70.3, 70.0]), true, "앞에서 흔들려도 마지막 5번이 모이면 정함");
  assert.equal(m.isSizeStable([70, 72, 69, 71.5, 70.2]), false, "4% 흔들림");
});

// ---------- 16단계: 12cm 안내 ----------
test("거리 안내: 12cm 밖이면 몇 cm 더 가까이, 안이면 완료, 너무 가까우면 조금 멀리", () => {
  assert.match(m.distanceGuide(250).text, /13cm 더 가까이/);
  assert.match(m.distanceGuide(121).text, /1cm 더 가까이/);
  assert.equal(m.distanceGuide(121).inside, false);
  assert.equal(m.distanceGuide(120).inside, true, "딱 12cm는 안");
  assert.equal(m.distanceGuide(60).inside, true, "가까운 쪽 한도는 없음");
  assert.match(m.distanceGuide(40, true).text, /조금 멀리/);
  assert.equal(m.distanceGuide(40, true).inside, false);
  assert.equal(m.distanceGuide(NaN).inside, false);
});

// ---------- 17단계: 안정 판정 ----------
test("안정 판정: 최근 10개가 5mm 안쪽으로 모이면 안정, 흔들리거나 천천히 다가오거나 모자라면 아님", () => {
  assert.equal(m.distanceStability([100, 101, 99]).stable, false, "3개뿐");
  assert.equal(m.distanceStability([100, 101, 99, 100, 101, 100]).stable, false, "6개뿐(0.5초 미만)");
  const still = m.distanceStability([130, 115, 101, 102, 100, 101, 103, 102, 101, 100, 102, 101]);
  assert.equal(still.stable, true, "다가오다 멈춤");
  near(still.meanMm, 101.3, 1e-9, "평균");
  near(still.rangeMm, 3, 1e-9, "흔들림");
  assert.equal(m.distanceStability([100, 104, 98, 103, 99, 105, 100, 104, 98, 103]).stable, false, "7mm 흔들림");
  assert.equal(m.distanceStability([127, 126, 125, 124, 123, 122, 121, 120, 119, 118]).stable, false, "천천히 다가오는 중(1mm씩)");
  assert.equal(m.distanceStability([100, 105, 100, 105, 100, 105, 100, 105, 100, 105]).stable, true, "딱 5mm는 안정");
});

if (failed) {
  console.log(`\n${failed}개 실패`);
  process.exit(1);
}
console.log("\n모두 통과");
