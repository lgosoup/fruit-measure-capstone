// 윤곽 자동 인식 테스트: 실행 `node test/detect.test.js`
// 테이블 위 구를 카메라로 찍은 사진을 계산으로 그려, 인식한 윤곽에서 거리·크기가 다시 나오는지 확인한다
const assert = require("node:assert");
const {
  cameraDirToWorld, normalize, distanceFromCone, measureFruitCone, pixelToRay, measureSpheroidCone, fitSphereViews,
} = require("../measure.js");
const { detectFruit, detectFruitSpheroid, acquireFruit, trackFruit, findInPhoto } = require("../detect.js");
const { cameraPose, render, seedFor, approachFrames } = require("./scene.js");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("ok  ", name);
  } catch (error) {
    failed++;
    console.log("FAIL", name, "\n     ", error.message);
  }
}

function trueDistanceMm(opt) {
  const cam = [opt.pose[12], opt.pose[13], opt.pose[14]];
  return (Math.hypot(cam[0] - opt.center[0], cam[1] - opt.center[1], cam[2] - opt.center[2]) - opt.r) * 1000;
}

function relErr(a, b) {
  return Math.abs(a - b) / b;
}

// 근거리 사진(약 10cm): 거리 확인
const photoK = { fx: 520, fy: 520, cx: 240, cy: 320, width: 480, height: 640 };
const R = 0.035;
function photoScene(extra) {
  // 카메라는 과일 위쪽 비스듬히, 표면에서 약 10cm
  const center = [0, R, 0];
  const pitch = 50;
  const dist = 0.135;
  const t = (pitch * Math.PI) / 180;
  const pos = [center[0], center[1] + dist * Math.sin(t), center[2] + dist * Math.cos(t)];
  return { width: 480, height: 640, k: photoK, pose: cameraPose(pos, pitch), center, r: R, ...extra };
}

function checkPhoto(opt, tol) {
  const image = render(opt);
  const result = detectFruit(image, seedFor(opt), opt.k);
  assert.ok(result.cone, "인식 실패: " + result.error);
  const d = distanceFromCone(result.cone, 2 * R * 1000).distanceMm;
  const truth = trueDistanceMm(opt);
  assert.ok(relErr(d, truth) < tol, `거리 ${d.toFixed(1)}mm, 실제 ${truth.toFixed(1)}mm`);
  return { d, truth, inliers: result.inliers.length, edges: result.edges.length };
}

test("사진 가운데 과일: 거리 1% 이내", () => {
  checkPhoto(photoScene({}), 0.01);
});

test("과일이 사진 가장자리 쪽(비스듬한 윤곽): 거리 1% 이내", () => {
  const opt = photoScene({});
  opt.center = [0.025, R, -0.015];
  checkPhoto(opt, 0.01);
});

test("잡음 + 그림자 + 반사광: 거리 2% 이내", () => {
  checkPhoto(photoScene({ noise: 14, shadow: true, highlight: true }), 0.02);
});

test("윤곽 일부가 끊김(옆에 붙은 과일색 물체) + 꼭지: 거리 2% 이내, 튄 점은 버려짐", () => {
  const r = checkPhoto(photoScene({ blob: true, stem: true, noise: 8 }), 0.02);
  assert.ok(r.inliers < r.edges, "버려진 점이 있어야 함");
});

test("가리킨 지점이 과일 가운데가 아니어도 인식", () => {
  checkPhoto(photoScene({ seedShift: [35, -40], noise: 8 }), 0.015);
});

test("나무색 테이블에서도 인식", () => {
  checkPhoto(photoScene({ table: [165, 120, 80], noise: 8, shadow: true }), 0.02);
});

test("테이블을 가리키면 실패", () => {
  const opt = photoScene({ noise: 8 });
  const result = detectFruit(render(opt), { x: 20, y: 600 }, opt.k);
  assert.strictEqual(result.cone, undefined);
});

test("과일이 사진 밖으로 잘리면 실패(cut)", () => {
  const opt = photoScene({});
  opt.center = [0.07, R, 0];
  const image = render(opt);
  const seed = seedFor(opt);
  seed.x = Math.min(seed.x, opt.width - 30);
  const result = detectFruit(image, seed, opt.k);
  assert.strictEqual(result.error, "cut");
});

// AR(30cm 이상): 원뿔과 카메라 높이로 크기 확인
function arScene(pitch, extra) {
  const center = [0.03, R, -0.02];
  const dist = 0.42;
  const t = (pitch * Math.PI) / 180;
  const pos = [0, center[1] + dist * Math.sin(t), center[2] + dist * Math.cos(t)];
  const k = { fx: 480, fy: 480, cx: 240, cy: 320, width: 480, height: 640 };
  return { width: 480, height: 640, k, pose: cameraPose(pos, pitch), center, r: R, ...extra };
}

function checkAr(opt, tol) {
  const image = render(opt);
  const result = detectFruit(image, seedFor(opt), opt.k);
  assert.ok(result.cone, "인식 실패: " + result.error);
  const dWorld = normalize(cameraDirToWorld(opt.pose, result.cone.d));
  const cam = [opt.pose[12], opt.pose[13], opt.pose[14]];
  const m = measureFruitCone(dWorld, result.cone.sinA, cam, 0);
  assert.ok(m, "크기 계산 실패");
  assert.ok(relErr(m.sizeMm, 2 * R * 1000) < tol, `크기 ${m.sizeMm.toFixed(1)}mm, 실제 ${(2 * R * 1000).toFixed(1)}mm`);
  assert.ok(relErr(m.distanceMm, trueDistanceMm(opt)) < tol,
    `거리 ${m.distanceMm.toFixed(1)}mm, 실제 ${trueDistanceMm(opt).toFixed(1)}mm`);
}

test("AR 바로 위에서 내려다봄: 크기·거리 2% 이내", () => {
  checkAr(arScene(88, { noise: 8 }), 0.02);
});

test("AR 비스듬히(55도) + 그림자 + 반사광: 크기·거리 3% 이내", () => {
  checkAr(arScene(55, { noise: 10, shadow: true, highlight: true }), 0.03);
});

// ---------- 14단계: 회전타원체(가로·세로) AR 인식 ----------
// 과일(가로 반지름 a, 세로 반지름 c)을 수직에서 tiltDeg만큼 기운 방향에서 본다
function spheroidArScene(a, c, tiltDeg, extra) {
  const center = [0.03, c, -0.02];
  const dist = 0.42;
  const pitch = 90 - tiltDeg;
  const t = (pitch * Math.PI) / 180;
  const pos = [0, center[1] + dist * Math.sin(t), center[2] + dist * Math.cos(t)];
  const k = { fx: 480, fy: 480, cx: 240, cy: 320, width: 480, height: 640 };
  return { width: 480, height: 640, k, pose: cameraPose(pos, pitch), center, r: a, rc: c, ...extra };
}

// 카메라에서 과일 중심을 향한 선이 표면과 만나는 점까지의 실제 거리(mm)
function trueSpheroidDistanceMm(opt) {
  const cam = [opt.pose[12], opt.pose[13], opt.pose[14]];
  const v = [opt.center[0] - cam[0], opt.center[1] - cam[1], opt.center[2] - cam[2]];
  const d = Math.hypot(...v);
  const w = v.map((x) => x / d);
  return (d - 1 / Math.sqrt((w[0] ** 2 + w[2] ** 2) / opt.r ** 2 + w[1] ** 2 / opt.rc ** 2)) * 1000;
}

function checkSpheroid(opt, tol) {
  const result = detectFruitSpheroid(render(opt), seedFor(opt), opt.k, opt.pose);
  assert.ok(result.cone, "인식 실패: " + result.error);
  const cam = [opt.pose[12], opt.pose[13], opt.pose[14]];
  const m = measureSpheroidCone(result.cone, result.s, cam, 0);
  assert.ok(m, "크기 계산 실패");
  const w = 2 * opt.r * 1000, v = 2 * opt.rc * 1000, d = trueSpheroidDistanceMm(opt);
  assert.ok(relErr(m.widthMm, w) < tol, `가로 ${m.widthMm.toFixed(1)}mm, 실제 ${w.toFixed(1)}mm`);
  assert.ok(relErr(m.verticalMm, v) < tol, `세로 ${m.verticalMm.toFixed(1)}mm, 실제 ${v.toFixed(1)}mm`);
  assert.ok(relErr(m.distanceMm, d) < tol, `거리 ${m.distanceMm.toFixed(1)}mm, 실제 ${d.toFixed(1)}mm`);
  return { m, result };
}

test("AR 납작한 과일(가로 80, 세로 64mm)을 45도로 봄: 가로·세로·거리 3% 이내", () => {
  checkSpheroid(spheroidArScene(0.04, 0.032, 45, { noise: 8 }), 0.03);
});

test("AR 납작한 과일 + 그림자 + 반사광 + 꼭지(55도): 가로·세로·거리 3% 이내", () => {
  checkSpheroid(spheroidArScene(0.04, 0.034, 55, { noise: 10, shadow: true, highlight: true, stem: true }), 0.03);
});

test("AR 세로가 긴 과일(가로 70, 세로 82mm)을 40도로 봄: 3% 이내", () => {
  checkSpheroid(spheroidArScene(0.035, 0.041, 40, { noise: 8 }), 0.03);
});

test("AR 구(가로=세로)는 가로·세로가 같게 나옴: 3% 이내", () => {
  checkSpheroid(spheroidArScene(R, R, 45, { noise: 8 }), 0.03);
});

test("AR 윤곽 일부가 끊겨도(옆에 붙은 과일색 물체): 3% 이내", () => {
  checkSpheroid(spheroidArScene(0.04, 0.033, 50, { noise: 8, blob: true }), 0.03);
});

test("AR 거의 바로 위에서 보면 기운 각도가 작게 나옴(세로를 쓰지 않도록)", () => {
  const opt = spheroidArScene(0.04, 0.032, 5, { noise: 8 });
  const result = detectFruitSpheroid(render(opt), seedFor(opt), opt.k, opt.pose);
  assert.ok(result.cone, "인식 실패: " + result.error);
  assert.ok(result.tiltDeg < 10, `기운 각도 ${result.tiltDeg}`);
});

// ---------- 14단계: 다가가며 찍힌 사진 여러 장으로 크기 정하기 ----------
function sizeFromFrames(frames) {
  const views = [];
  for (const opt of frames) {
    const found = detectFruit(render(opt), seedFor(opt), opt.k);
    if (!found.cone) continue;
    views.push({ origin: [opt.pose[12], opt.pose[13], opt.pose[14]], d: normalize(cameraDirToWorld(opt.pose, found.cone.d)), sinA: found.cone.sinA });
  }
  return { fit: fitSphereViews(views), used: views.length };
}

test("다가가며 찍은 8장(40 → 20cm, 45도, 잡음): 지름 2% 이내", () => {
  const { fit } = sizeFromFrames(approachFrames(R, 45, 0.4, 0.2, 8, { noise: 8 }));
  assert.ok(fit, "크기를 정하지 못함");
  assert.ok(relErr(fit.sizeMm, 2 * R * 1000) < 0.02, `지름 ${fit.sizeMm.toFixed(1)}mm, 실제 ${(2 * R * 1000).toFixed(1)}mm`);
});

test("다가가며 찍은 8장 + 그림자 + 반사광 + 꼭지(30도): 지름 3% 이내", () => {
  const { fit } = sizeFromFrames(approachFrames(R, 30, 0.38, 0.2, 8, { noise: 10, shadow: true, highlight: true, stem: true }));
  assert.ok(fit, "크기를 정하지 못함");
  assert.ok(relErr(fit.sizeMm, 2 * R * 1000) < 0.03, `지름 ${fit.sizeMm.toFixed(1)}mm, 실제 ${(2 * R * 1000).toFixed(1)}mm`);
});

test("거의 바로 위에서 다가가도(5도) 지름 2% 이내", () => {
  const { fit } = sizeFromFrames(approachFrames(R, 5, 0.4, 0.22, 8, { noise: 8 }));
  assert.ok(fit, "크기를 정하지 못함");
  assert.ok(relErr(fit.sizeMm, 2 * R * 1000) < 0.02, `지름 ${fit.sizeMm.toFixed(1)}mm, 실제 ${(2 * R * 1000).toFixed(1)}mm`);
});

// ---------- 14단계: 대상 찾기와 따라가기 ----------
// 과일 중심이 사진에 찍히는 위치(정답)
function truthCenterPx(opt) {
  return seedFor({ ...opt, seedShift: [0, 0] });
}

test("과일이 화면 가운데에서 조금 비켜 있어도(가운데 점이 과일 밖) 찾음", () => {
  const opt = arScene(50, { noise: 8 });
  // 사진 가운데가 과일 밖에 오도록 과일을 옆으로 옮긴 장면
  opt.center = [opt.center[0] + 0.06, opt.center[1], opt.center[2]];
  const moved = truthCenterPx(opt);
  assert.ok(Math.hypot(moved.x - opt.width / 2, moved.y - opt.height / 2) > 40, "과일 중심이 가운데에서 충분히 비켜야 함");
  const found = acquireFruit(render(opt), opt.k);
  assert.ok(found.cone, "못 찾음: " + found.error);
  assert.ok(Math.hypot(found.center.x - moved.x, found.center.y - moved.y) < 4, `찾은 중심 ${found.center.x.toFixed(0)},${found.center.y.toFixed(0)}`);
});

test("과일이 두 개면 화면 가운데에 가까운 과일을 고름", () => {
  const opt = arScene(50, { noise: 8 });
  // 가운데 근처의 측정 과일 + 화면 왼쪽에 같은 색의 다른 과일
  opt.other = { center: [opt.center[0] - 0.12, R, opt.center[2] + 0.02], r: R, color: [230, 120, 30] };
  const found = acquireFruit(render(opt), opt.k);
  assert.ok(found.cone, "못 찾음: " + found.error);
  const t = truthCenterPx(opt);
  assert.ok(Math.hypot(found.center.x - t.x, found.center.y - t.y) < 4, "가운데에 가까운 과일이 아님");
});

test("과일이 없으면(테이블만) 못 찾음으로 끝남", () => {
  const opt = arScene(50, { noise: 8 });
  opt.center = [5, R, 5]; // 화면 밖 멀리
  const found = acquireFruit(render(opt), opt.k);
  assert.strictEqual(found.cone, undefined);
});

test("다가가는 8장 동안 따라가기: 매 장 과일 중심을 놓치지 않음", () => {
  const frames = approachFrames(R, 40, 0.4, 0.2, 8, { noise: 8, shadow: true });
  let prev = acquireFruit(render(frames[0]), frames[0].k);
  assert.ok(prev.cone, "처음에 못 찾음");
  for (const opt of frames.slice(1)) {
    const found = trackFruit(render(opt), opt.k, prev);
    assert.ok(found.cone, "놓침: " + found.error);
    const t = truthCenterPx(opt);
    assert.ok(Math.hypot(found.center.x - t.x, found.center.y - t.y) < 5, "엉뚱한 곳을 따라감");
    prev = found;
  }
});

test("과일이 화면에서 옆으로 움직여도 따라감(폰을 옆으로 돌림)", () => {
  const base = arScene(50, { noise: 8 });
  let prev = acquireFruit(render(base), base.k);
  assert.ok(prev.cone, "처음에 못 찾음");
  for (let i = 1; i <= 6; i++) {
    const opt = { ...base, center: [base.center[0] + i * 0.008, base.center[1], base.center[2]] }; // 한 장에 약 1cm씩
    const found = trackFruit(render(opt), opt.k, prev);
    assert.ok(found.cone, `${i}번째에서 놓침: ${found.error}`);
    prev = found;
  }
});

test("따라가던 과일이 갑자기 사라지면 놓침으로 끝남", () => {
  const opt = arScene(50, { noise: 8 });
  const prev = acquireFruit(render(opt), opt.k);
  const gone = { ...opt, center: [5, R, 5] };
  const found = trackFruit(render(gone), gone.k, prev);
  assert.strictEqual(found.cone, undefined);
});


// ---------- 17단계: 촬영 사진에서 꼭지를 과일로 잡는 문제 ----------
// 위에서 10cm로 찍은 사진: 사진 가운데에 큰 꼭지가 있다. AR에서 따라가던 원뿔(정답 근처)을 주면 과일 윤곽을 골라야 한다
function topStemPhoto() {
  const opt = approachFrames(R, 0, 0.135, 0.135, 2, { noise: 8, stem: 0.95 })[0];
  const cam = [opt.pose[12], opt.pose[13], opt.pose[14]];
  const D = Math.hypot(cam[0] - opt.center[0], cam[1] - opt.center[1], cam[2] - opt.center[2]);
  const s = seedFor(opt);
  const d = normalize([(s.x - opt.k.cx) / opt.k.fx, (s.y - opt.k.cy) / opt.k.fy, 1]);
  const alpha = Math.asin(R / D);
  return { opt, image: render(opt), truth: (D - R) * 1000, cone: { d, alpha, sinA: Math.sin(alpha) } };
}

test("꼭지(재현): 위에서 찍은 사진의 가운데에서 찾으면 꼭지를 과일로 잡아 거리가 크게 틀림", () => {
  const { opt, image, truth } = topStemPhoto();
  const found = detectFruit(image, { x: opt.k.cx, y: opt.k.cy }, opt.k);
  assert.ok(found.cone, "인식 실패");
  const d = distanceFromCone(found.cone, 2 * R * 1000).distanceMm;
  assert.ok(d > truth * 2, `꼭지가 아니라 과일을 잡음(${d.toFixed(0)}mm / ${truth.toFixed(0)}mm) → 이 재현 장면이 더는 꼭지 문제를 만들지 못함`);
});

test("꼭지: 따라가던 원(크기 ±10%)을 주면 꼭지가 아닌 과일 윤곽을 골라 거리 2% 이내", () => {
  const { opt, image, truth } = topStemPhoto();
  for (const scale of [0.9, 1, 1.1]) {
    const { cone } = topStemPhoto();
    const alpha = Math.atan(Math.tan(cone.alpha) * scale);
    const found = findInPhoto(image, opt.k, { ...cone, alpha, sinA: Math.sin(alpha) });
    assert.ok(found.cone, `원 크기 ×${scale}: 인식 실패 ${found.error}`);
    const d = distanceFromCone(found.cone, 2 * R * 1000).distanceMm;
    assert.ok(relErr(d, truth) < 0.02, `원 크기 ×${scale}: 거리 ${d.toFixed(1)}mm, 실제 ${truth.toFixed(1)}mm`);
  }
});

test("꼭지: 위에서 내려다보며 처음 찾을 때도 꼭지가 아니라 과일을 잡음(30·42cm, 큰·작은 꼭지)", () => {
  for (const [d, stem] of [[0.3, 0.95], [0.42, 0.95], [0.3, 0.985], [0.42, 0.985]]) {
    const opt = approachFrames(R, 0, d, d, 2, { noise: 8, stem })[0];
    const image = render(opt);
    assert.ok(detectFruit(image, seedFor(opt), opt.k).cone === undefined ||
      distanceFromCone(detectFruit(image, seedFor(opt), opt.k).cone, 70).distanceMm > (d - R) * 2000,
      `${d * 100}cm: 가운데에서 꼭지를 잡지 않아 재현이 안 됨`);
    const found = acquireFruit(image, opt.k);
    assert.ok(found.cone, `${d * 100}cm 꼭지 ${stem}: 인식 실패 ${found.error}`);
    const dist = distanceFromCone(found.cone, 70).distanceMm;
    assert.ok(relErr(dist, (d - R) * 1000) < 0.02, `${d * 100}cm 꼭지 ${stem}: 거리 ${dist.toFixed(0)}mm`);
  }
});

test("꼭지: 따라가던 과일의 가운데가 꼭지여도 놓치지 않고 과일을 따라감", () => {
  const { opt, image, truth, cone } = topStemPhoto();
  const prev = { cone, center: seedFor(opt) };
  const found = trackFruit(image, opt.k, prev);
  assert.ok(found.cone, `놓침 ${found.error}`);
  assert.ok(relErr(distanceFromCone(found.cone, 70).distanceMm, truth) < 0.02);
});

test("밝은 접시 위 과일: 접시를 과일로 고르지 않음", () => {
  for (const d of [0.3, 0.42]) {
    const opt = approachFrames(R, 0, d, d, 2, { noise: 8, plate: R * 2.2 })[0];
    const found = acquireFruit(render(opt), opt.k);
    assert.ok(found.cone, `${d * 100}cm: 인식 실패 ${found.error}`);
    const dist = distanceFromCone(found.cone, 70).distanceMm;
    assert.ok(relErr(dist, (d - R) * 1000) < 0.03, `${d * 100}cm: 거리 ${dist.toFixed(0)}mm(접시를 잡으면 짧게 나옴)`);
  }
});

test("꼭지: 사진에 과일이 없으면 다른 것을 잡지 않고 실패", () => {
  const { opt, cone } = topStemPhoto();
  const empty = render({ ...opt, center: [5, R, 5] });
  assert.ok(!findInPhoto(empty, opt.k, cone).cone);
});

console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exit(failed ? 1 : 0);
