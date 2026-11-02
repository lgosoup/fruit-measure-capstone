// 과일 윤곽 자동 인식(외부 라이브러리 없음). 브라우저와 Node 테스트에서 함께 쓴다
// 1) 가리킨 지점에서 여러 방향으로 선을 뻗어, 과일 색과 달라지는 첫 지점(경계점)을 찾는다
// 2) 경계점들을 과일 윤곽(원뿔)에 맞춘다. 끊긴 경계로 새어 나간 점, 그림자·반사광에서 멈춘 점은 윤곽에 맞지 않아 버려진다
// 회전타원체 과일은 세로 방향을 늘려 구로 바꾼 공간(맞추는 공간)에서 원뿔에 맞춘다

if (typeof module !== "undefined") {
  // Node 테스트에서는 계산 함수를 불러온다(브라우저에서는 measure.js가 먼저 실린다)
  // eslint-disable-next-line no-global-assign
  ({
    pixelToRay, normalize, fitCone, coneError, coneRays, raysToPixels, cameraDirToWorld, worldDirToCamera,
    stretchDir, fitConeStretched, searchSpheroidRatio, viewTiltDeg,
  } = require("./measure.js"));
}

const DETECT_RAYS = 120;
const SAME_SPACE = { toFit: (u) => u, fromFit: (v) => v };

// image: { width, height, data(RGBA) }, seed: 과일 안쪽 한 점(px), k: 사진의 초점거리·중심(px)
// space: 사진 방향 ↔ 맞추는 공간 방향 바꾸기 { toFit, fromFit }. 없으면 사진 방향 그대로(구)
// 반환: { cone, outline, edges, inliers } 또는 { error: "none" | "cut" | "small" }
function detectFruit(image, seed, k, space = SAME_SPACE) {
  const edges = findEdgePoints(image, seed).filter(Boolean);
  return fitEdges(edges, image, seed, k, space);
}

function fitEdges(edges, image, seed, k, space) {
  if (edges.length < DETECT_RAYS * 0.3) return { error: "none" };

  const rays = edges.map((p) => space.toFit(normalize(pixelToRay(p, k))));
  const fit = fitConeRobust(rays, k);
  if (!fit || fit.inliers.length < Math.max(12, DETECT_RAYS * 0.35)) return { error: "none" };
  const { cone } = fit;

  // 가리킨 지점이 찾은 윤곽 안에 있어야 한다
  const seedRay = space.toFit(normalize(pixelToRay(seed, k)));
  if (dot(seedRay, cone.d) < cone.cosA) return { error: "none" };

  const outline = raysToPixels(coneRays(cone, 72).map(space.fromFit), k);
  const margin = 2;
  const outside = outline.filter((p) =>
    p.x < -margin || p.y < -margin || p.x > image.width + margin || p.y > image.height + margin).length;
  if (outline.length < 72 || outside > 72 * 0.05) return { error: "cut" };
  const radiusPx = k.fx * Math.tan(cone.alpha);
  if (radiusPx < 8) return { error: "small" };

  return { cone, outline, edges, inliers: fit.inliers.map((i) => edges[i]) };
}

// 늘린 공간 바꾸기. cameraMatrix: 카메라 → 세계 행렬, s: 가로/세로 비율
function stretchedSpace(cameraMatrix, s) {
  return {
    toFit: (u) => stretchDir(normalize(cameraDirToWorld(cameraMatrix, u)), s),
    fromFit: (v) => worldDirToCamera(cameraMatrix, stretchDir(v, 1 / s)),
  };
}

// AR: 비스듬히 본 과일의 윤곽에서 가로/세로 비율 s까지 함께 찾는다
// 1) 구로 보고 넉넉하게 맞춰, 크게 튄 경계점(끊김으로 새어 나간 점 등)을 버린다
// 2) 남은 점으로 비율 s를 찾는다  3) 그 비율로 늘린 공간에서 다시 인식해 맞는 점을 고른 뒤, 비율을 한 번 더 다듬는다
// 반환: { cone(늘린 세계 공간), s, tiltDeg, outline, edges, inliers } 또는 { error }
function detectFruitSpheroid(image, seed, k, cameraMatrix) {
  const edges = findEdgePoints(image, seed).filter(Boolean);
  const first = fitEdges(edges, image, seed, k, stretchedSpace(cameraMatrix, 1));
  if (!first.cone) return first;
  const toWorld = (p) => normalize(cameraDirToWorld(cameraMatrix, normalize(pixelToRay(p, k))));
  const tiltDeg = viewTiltDeg(first.cone.d);

  const roughRays = edges.map(toWorld).filter((u) => coneError(first.cone, u) < first.cone.alpha * 0.15);
  let s = bestRatio(roughRays);
  let found = fitEdges(edges, image, seed, k, stretchedSpace(cameraMatrix, s));
  if (!found.cone) return found;
  s = bestRatio(found.inliers.map(toWorld));
  found = fitEdges(edges, image, seed, k, stretchedSpace(cameraMatrix, s));
  if (!found.cone) return found;
  return { ...found, s, tiltDeg };
}

// ---------- 대상 찾기와 따라가기 ----------
// 원뿔 축이 사진에 찍히는 위치(과일 중심, px)와 사진 속 반지름(px)
function coneCenterPx(cone, k) {
  return { x: k.cx + (k.fx * cone.d[0]) / cone.d[2], y: k.cy + (k.fy * cone.d[1]) / cone.d[2] };
}

function coneRadiusPx(cone, k) {
  return k.fx * Math.tan(cone.alpha);
}

// 사용자는 잴 과일을 화면 가운데에 둔다. 가운데와 그 둘레 몇 곳에서 인식해 보고, 찾은 과일 중
// 중심이 사진 가운데에 가장 가까운 것을 고른다(사용자에게 보이지 않는 기준점)
// 반환: detectFruit 결과(+ center) 또는 { error }
function acquireFruit(image, k) {
  const cx = image.width / 2;
  const cy = image.height / 2;
  const step = Math.min(image.width, image.height) * 0.15;
  // 가운데, 가까운 둘레(멀리서 작게 보이는 과일의 가운데가 꼭지일 때), 먼 둘레 순서로 찾는다
  const seeds = [{ x: cx, y: cy }];
  for (const ring of [0.4, 1]) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      seeds.push({ x: cx + Math.cos(a) * step * ring, y: cy + Math.sin(a) * step * ring });
    }
  }
  let best = null;
  let lastError = "none";
  for (const seed of seeds) {
    const found = detectFruit(image, seed, k);
    if (!found.cone) {
      lastError = found.error === "cut" || lastError === "cut" ? "cut" : found.error;
      continue;
    }
    const center = coneCenterPx(found.cone, k);
    const dist = Math.hypot(center.x - cx, center.y - cy);
    if (!best || dist < best.dist) best = { ...found, center, dist };
    if (dist < coneRadiusPx(found.cone, k)) break; // 가운데가 과일 안에 있으면 더 찾지 않는다
  }
  if (!best) return { error: lastError };
  return enclosingFruit(image, k, best) || best;
}

// 위에서 내려다보면 화면 가운데가 꼭지라, 꼭지 테두리를 과일로 잡을 수 있다.
// 찾은 윤곽 바로 바깥 둘레에서 한 번 더 찾아, 그것을 감싸는 더 큰 윤곽이 있고 안쪽이 바깥보다 뚜렷하게 어두우면
// (꼭지는 과일보다 어둡다) 바깥을 과일로 고른다. 접시처럼 과일보다 밝은 것이 감싸면 고르지 않는다. 없으면 null
const ENCLOSE_MIN_RATIO = 1.5;    // 바깥 윤곽이 안쪽보다 이만큼 이상 커야 한다
const ENCLOSE_DARKER = 0.8;       // 안쪽 밝기가 바깥의 이 비율보다 어두워야 꼭지로 본다
function enclosingFruit(image, k, inner) {
  const r = coneRadiusPx(inner.cone, k);
  const c = inner.center;
  const patch = Math.max(2, Math.round(r * 0.3));
  const brightness = (p) => seedColor(image, p, patch).reduce((sum, v) => sum + v, 0);
  const innerBright = brightness(c);
  let best = null;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const seed = { x: c.x + Math.cos(a) * r * 1.4, y: c.y + Math.sin(a) * r * 1.4 };
    if (seed.x < 0 || seed.y < 0 || seed.x >= image.width || seed.y >= image.height) continue;
    const found = detectFruit(image, seed, k);
    if (!found.cone) continue;
    const center = coneCenterPx(found.cone, k);
    const outerR = coneRadiusPx(found.cone, k);
    const encloses = outerR >= r * ENCLOSE_MIN_RATIO && Math.hypot(center.x - c.x, center.y - c.y) + r <= outerR;
    if (!encloses || innerBright >= brightness(seed) * ENCLOSE_DARKER) continue;
    if (!best || outerR < best.outerR) best = { ...found, center, outerR };
  }
  if (!best) return null;
  const { outerR, ...fruit } = best;
  return fruit;
}

// hintCone과 위치·크기가 맞는 윤곽을 찾는다. 원의 가운데와 그 안쪽 둘레 8곳에서 찾아 보고(가운데가 꼭지여도 껍질에서 찾도록),
// 크기 비율이 [ratioMin, ratioMax] 안이고 중심이 반지름의 jumpRatio배 넘게 벗어나지 않은 것 중 크기가 가장 비슷한 것을 고른다.
// firstOk가 true면 가운데에서 맞는 것을 찾는 즉시 돌려준다(따라가기: 매 프레임 빠르게)
function findMatching(image, k, hintCone, ratioMin, ratioMax, jumpRatio, firstOk) {
  const c = coneCenterPx(hintCone, k);
  const r = coneRadiusPx(hintCone, k);
  const seeds = [c];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    seeds.push({ x: c.x + Math.cos(a) * r * 0.5, y: c.y + Math.sin(a) * r * 0.5 });
  }
  let best = null;
  let cut = false;
  for (const seed of seeds) {
    const found = detectFruit(image, seed, k);
    if (!found.cone) {
      cut = cut || found.error === "cut";
      continue;
    }
    const center = coneCenterPx(found.cone, k);
    const ratio = coneRadiusPx(found.cone, k) / r;
    if (ratio < ratioMin || ratio > ratioMax || Math.hypot(center.x - c.x, center.y - c.y) > r * jumpRatio) continue;
    const score = Math.abs(Math.log(ratio));
    if (!best || score < best.score) best = { ...found, center, score };
    if (firstOk) break;
  }
  if (!best) return { error: cut ? "cut" : "lost" };
  const { score, ...fruit } = best;
  return fruit;
}

// 직전에 찾은 과일에서 다시 인식한다. 크기나 위치가 갑자기 크게 바뀌면 다른 물체로 보고 놓친 것으로 한다
// prev: 직전 결과(cone, center). 반환: detectFruit 결과(+ center) 또는 { error: "lost" | "cut" | ... }
function trackFruit(image, k, prev) {
  return findMatching(image, k, prev.cone, 0.6, 1.7, 1.5, true);
}

// 촬영한 사진에서 AR로 따라가던 과일(hintCone: 촬영 순간의 원뿔)과 위치·크기가 맞는 윤곽을 찾는다.
// 사진 정가운데가 꼭지처럼 과일과 색이 다른 곳이면 그 테두리를 과일로 잡으므로, 따라가던 원 안쪽 여러 곳에서
// 찾아 보고 따라가던 원과 크기가 가장 비슷한 것을 고른다. 맞는 것이 없으면 { error }
function findInPhoto(image, k, hintCone) {
  return findMatching(image, k, hintCone, 0.75, 1.33, 0.5, false);
}

function bestRatio(raysWorld) {
  return searchSpheroidRatio((s) => {
    const fit = fitConeStretched(raysWorld, s);
    return fit ? fit.error : Infinity;
  });
}

// ---------- 경계점 찾기 ----------
// 각 방향으로 과일 색과의 차이를 재고, 차이가 문턱값을 넘어 계속되는 첫 지점을 경계로 본다
// 문턱값은 모든 선에서 잰 차이를 두 무리(과일/바깥)로 가장 잘 나누는 값(오츠 방법)
function findEdgePoints(image, seed) {
  const { width, height } = image;
  const step = Math.max(1, Math.min(width, height) / 500);
  const ref = seedColor(image, seed, Math.max(2, Math.round(Math.min(width, height) / 120)));

  const profiles = [];
  const all = [];
  for (let i = 0; i < DETECT_RAYS; i++) {
    const a = (i / DETECT_RAYS) * Math.PI * 2;
    const dx = Math.cos(a) * step;
    const dy = Math.sin(a) * step;
    const values = [];
    for (let t = 1; ; t++) {
      const x = seed.x + dx * t;
      const y = seed.y + dy * t;
      if (x < 1 || y < 1 || x > width - 2 || y > height - 2) break;
      const v = colorDistance(sampleColor(image, x, y), ref);
      values.push(v);
      all.push(v);
    }
    profiles.push({ dx, dy, values });
  }
  const threshold = Math.max(25, otsu(all));

  const RUN = 3; // 잡음 한 점에서 멈추지 않도록 문턱값을 연달아 넘어야 경계로 본다
  return profiles.map(({ dx, dy, values }) => {
    for (let t = 0; t + RUN <= values.length; t++) {
      let run = true;
      for (let j = 0; j < RUN; j++) if (values[t + j] <= threshold) run = false;
      if (!run) continue;
      // 문턱값을 지나는 위치를 바로 앞 점과 이어 더 정확히 잡는다
      const prev = t > 0 ? values[t - 1] : 0;
      const frac = values[t] > prev ? (threshold - prev) / (values[t] - prev) : 0;
      const s = t + Math.min(1, Math.max(0, frac)); // values[t]는 seed에서 (t + 1) 걸음
      return { x: seed.x + dx * s, y: seed.y + dy * s };
    }
    return null; // 경계를 못 찾고 사진 끝에 닿음
  });
}

// 가리킨 지점 주변 색(채널별 가운데값). 반사광 몇 점에 끌려가지 않게 한다
function seedColor(image, seed, radius) {
  const rs = [], gs = [], bs = [];
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const px = Math.round(seed.x + x);
      const py = Math.round(seed.y + y);
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const i = (py * image.width + px) * 4;
      rs.push(image.data[i]);
      gs.push(image.data[i + 1]);
      bs.push(image.data[i + 2]);
    }
  }
  const median = (arr) => arr.sort((a, b) => a - b)[arr.length >> 1];
  return [median(rs), median(gs), median(bs)];
}

// 3x3 평균 색(잡음 완화)
function sampleColor(image, x, y) {
  const cx = Math.round(x);
  const cy = Math.round(y);
  const { width, data } = image;
  let r = 0, g = 0, b = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const o = ((cy + j) * width + (cx + i)) * 4;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
    }
  }
  return [r / 9, g / 9, b / 9];
}

// 색 차이: 색의 비율(밝기와 무관한 색감) 차이를 주로 보고, 밝기 차이는 약하게 본다
// 과일의 어두운 쪽 면은 같은 색감이라 과일로, 회색·흰색 테이블은 색감이 달라 바깥으로 본다
function colorDistance(c, ref) {
  const sc = c[0] + c[1] + c[2] + 30;
  const sr = ref[0] + ref[1] + ref[2] + 30;
  let chroma = 0;
  for (let i = 0; i < 3; i++) {
    const d = (c[i] + 10) / sc - (ref[i] + 10) / sr;
    chroma += d * d;
  }
  const light = Math.log(sc / sr);
  return Math.sqrt(chroma * 300 * 300 + light * light * 40 * 40);
}

function otsu(values) {
  const BINS = 256;
  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (!(max > 0)) return 0;
  const hist = new Array(BINS).fill(0);
  for (const v of values) hist[Math.min(BINS - 1, Math.floor((v / max) * BINS))]++;
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < BINS; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let i = 0; i < BINS; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = i;
    }
  }
  return ((best + 1) / BINS) * max;
}

// ---------- 원뿔 맞추기(튀는 점 버리기) ----------
// 경계점 3개로 원뿔을 만들어 보고, 가장 많은 점이 들어맞는 원뿔을 고른 뒤 맞는 점들로 다시 맞춘다
function fitConeRobust(rays, k) {
  const pixelAngle = 1 / Math.max(k.fx, k.fy);
  let seed = 12345; // 결과가 매번 같도록 정해진 순서의 난수
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const inliersOf = (cone) => {
    const tol = Math.max(2 * pixelAngle, cone.alpha * 0.03);
    const list = [];
    rays.forEach((u, i) => {
      if (coneError(cone, u) < tol) list.push(i);
    });
    return list;
  };

  let best = null;
  for (let iter = 0; iter < 300; iter++) {
    const a = Math.floor(random() * rays.length);
    const b = Math.floor(random() * rays.length);
    const c = Math.floor(random() * rays.length);
    if (a === b || b === c || a === c) continue;
    const cone = fitCone([rays[a], rays[b], rays[c]]);
    if (!cone) continue;
    const inliers = inliersOf(cone);
    if (!best || inliers.length > best.inliers.length) best = { cone, inliers };
  }
  if (!best) return null;
  // 맞는 점 전부로 두 번 다시 맞춘다
  for (let n = 0; n < 2; n++) {
    const cone = fitCone(best.inliers.map((i) => rays[i]));
    if (!cone) break;
    best = { cone, inliers: inliersOf(cone) };
  }
  return best;
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

if (typeof module !== "undefined") {
  module.exports = { detectFruit, detectFruitSpheroid, acquireFruit, trackFruit, findInPhoto, coneCenterPx, findEdgePoints, colorDistance, otsu };
}
