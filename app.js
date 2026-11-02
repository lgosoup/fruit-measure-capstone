// ---------- 화면 요소 ----------
const homeScreen = document.getElementById("screen-home");
const homeMessage = document.getElementById("home-message");
const btnStart = document.getElementById("btn-start");
const arRoot = document.getElementById("ar-root");
const arUi = document.getElementById("ar-ui");
const arCanvas = document.getElementById("ar-canvas");
const arCtx = arCanvas.getContext("2d");
const arGuide = document.getElementById("ar-guide");
const btnCapture = document.getElementById("btn-capture");
const photoScreen = document.getElementById("screen-photo");
const photoInfo = document.getElementById("photo-info");
const photoStatus = document.getElementById("photo-status");
const canvas = document.getElementById("photo-canvas");
const ctx = canvas.getContext("2d");

const RETICLE_COLOR = "#22d3ee"; // 기준선 색
const FRUIT_COLOR = "#e879f9";   // 과일선 색. 주황·초록 과일 위에서도 잘 보인다
const TRACK_EVERY = 3;            // 몇 프레임마다 과일을 찾을지(화면이 끊기지 않게)
const TRACK_IMAGE_SHORT = 480;    // 과일을 찾을 때 쓰는 카메라 이미지의 짧은 변(px)
const LOST_LIMIT = 4;             // 이만큼 연달아 놓치면 처음부터 다시 찾는다
const SIZE_STABLE_COUNT = 5;      // 크기를 정하려면 이만큼 연달아 계산한 값이
const SIZE_STABLE_RATIO = 0.02;   // 이 비율(최대-최소 / 평균) 안쪽으로 모여야 한다
const btnReselect = document.getElementById("btn-reselect");
const arDistance = document.getElementById("ar-distance");
const btnAuto = document.getElementById("btn-auto");
const AUTO_HOLD_FRAMES = 90;      // 사진 화면에서 돌아온 뒤 이만큼(약 1.5초)은 자동 촬영하지 않는다
const arDone = document.getElementById("ar-done");

// ---------- AR 지원 확인 ----------
// 크롬(안드로이드)에서 ARCore를 쓸 수 있을 때만 측정을 시작할 수 있다
async function checkArSupport() {
  let supported = false;
  try {
    supported = !!navigator.xr && await navigator.xr.isSessionSupported("immersive-ar");
  } catch (error) {
    console.error(error);
  }
  btnStart.disabled = !supported;
  if (supported) {
    setHomeMessage("과일을 테이블 위에 놓고 측정 시작을 누르세요.", false);
  } else {
    setHomeMessage("이 브라우저에서는 AR을 쓸 수 없습니다. 갤럭시 Z 플립6의 크롬에서 열어 주세요.", true);
  }
}

function setHomeMessage(text, warn) {
  homeMessage.textContent = text;
  homeMessage.classList.toggle("guide-warn", warn);
}

checkArSupport();

// ---------- AR 세션 ----------
// xr: 실행 중인 AR 세션과 WebGL 자원. AR이 아닐 때는 null
let xr = null;
let captureRequested = false;
let reselectRequested = false;
// target: 따라가고 있는 과일(cone, center, outline과 그때의 카메라 값 k·matrix·position). 못 찾았으면 null
// views: 크기 계산에 모은 위치별 원뿔, sizeHistory: 모을 때마다 계산한 크기(mm), arResult: 정해진 크기
let target = null;
let lostCount = 0;
let searchError = "none";
let views = [];
let sizeHistory = [];
let arResult = null;
let frameCount = 0;
let arReady = false;      // AR이 한 번이라도 폰 위치를 잡았는가. 그 전에는 놓쳤다는 안내 대신 찾는 중이라고 한다
let trackedCount = 0;     // 지금 과일을 연달아 따라간 횟수. 충분히 따라간 과일을 놓쳤을 때만 놓쳤다고 알린다
// 크기가 정해진 뒤 따라가는 과일의 화면 속 크기로 구한 거리 { distanceMm, cut }. wasInside: 직전에 12cm 안이었는가
let liveDistance = null;
let wasInside = false;
// distanceHistory: 크기를 잰 뒤 따라가며 구한 거리(mm). 안정 판정에 쓴다
// autoCapture: 12cm 안에서 안정되면 알아서 찍을지, autoHold: 남은 자동 촬영 대기 프레임
let distanceHistory = [];
let autoCapture = true;
let autoHold = 0;
const TRACK_ESTABLISHED = 5;
let arNote = null;        // 잠깐 보여줄 안내 { text, until }. 매 프레임 안내에 덮이지 않게 한다

function showArNote(text) {
  arNote = { text, until: performance.now() + 3000 };
}

btnStart.addEventListener("click", startAr);
document.getElementById("btn-ar-close").addEventListener("click", () => xr && xr.session.end());
btnCapture.addEventListener("click", () => {
  captureRequested = true;
});
btnReselect.addEventListener("click", () => {
  reselectRequested = true;
});
btnAuto.addEventListener("click", () => {
  autoCapture = !autoCapture;
  btnAuto.textContent = autoCapture ? "자동 촬영: 켬" : "자동 촬영: 끔";
});
document.getElementById("btn-remeasure").addEventListener("click", resetArMeasure);

// AR 화면 위 버튼을 누를 때 AR 쪽 터치(select)로 처리되지 않게 한다
arRoot.addEventListener("beforexrselect", (event) => event.preventDefault());

async function startAr() {
  if (xr) return;
  btnStart.disabled = true;
  let session = null;
  try {
    session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["dom-overlay", "camera-access"],
      domOverlay: { root: arRoot },
    });
    const glCanvas = document.createElement("canvas");
    const gl = glCanvas.getContext("webgl2", { xrCompatible: true });
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
    const refSpace = await session.requestReferenceSpace("local");
    xr = { session, gl, refSpace, binding: new XRWebGLBinding(session, gl), blit: null };
  } catch (error) {
    console.error(error);
    if (session) session.end().catch(() => {});
    btnStart.disabled = false;
    setHomeMessage(
      "AR을 시작하지 못했습니다. 카메라 권한을 허용했는지, 'AR용 Google Play 서비스'가 설치·업데이트되어 있는지 확인해 주세요.",
      true);
    return;
  }
  session.addEventListener("end", onArEnd);
  homeScreen.hidden = true;
  arRoot.hidden = false;
  showArUi();
  resizeArCanvas();
  session.requestAnimationFrame(onXrFrame);
}

function onArEnd() {
  xr = null;
  arReady = false;
  captureRequested = false;
  reselectRequested = false;
  arNote = null;
  resetTarget();
  arRoot.hidden = true;
  photoScreen.hidden = true;
  homeScreen.hidden = false;
  btnStart.disabled = false;
  setHomeMessage("과일을 테이블 위에 놓고 측정 시작을 누르세요.", false);
}

function showArUi() {
  photoScreen.hidden = true;
  arUi.hidden = false;
  arCanvas.hidden = false;
  // 다시 찍으러 돌아오자마자 같은 자리에서 또 찍히지 않게 잠시 기다리고, 흔들림 기록도 새로 모은다
  autoHold = AUTO_HOLD_FRAMES;
  distanceHistory = [];
}

function resizeArCanvas() {
  const dpr = window.devicePixelRatio || 1;
  arCanvas.width = Math.round(window.innerWidth * dpr);
  arCanvas.height = Math.round(window.innerHeight * dpr);
}
window.addEventListener("resize", () => {
  if (xr) resizeArCanvas();
});

function onXrFrame(time, frame) {
  if (!xr) return;
  const { session, gl, refSpace } = xr;
  session.requestAnimationFrame(onXrFrame);

  // 3D는 그리지 않는다. 카메라 화면이 보이도록 투명하게 비운다
  const layer = session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const pose = frame.getViewerPose(refSpace);
  if (!pose) {
    // 위치를 잃으면 카메라 이미지도 받을 수 없다. 촬영 요청은 남겨두지 않는다
    if (captureRequested) {
      captureRequested = false;
      showArNote("위치를 잃어 촬영하지 못했습니다. 조금 떨어져 다시 촬영해 주세요");
    }
    setArGuide(time, arReady ? "위치를 잃었습니다. 폰을 천천히 움직여 주세요" : SEARCHING);
    drawArOverlay(null);
    return;
  }
  const view = pose.views[0];
  if (!pose.emulatedPosition) arReady = true;

  if (reselectRequested) {
    reselectRequested = false;
    resetTarget();
    showArNote("과일을 화면 가운데에 가깝게 해 주세요");
  }
  frameCount++;
  if (autoHold > 0) autoHold--;
  if (frameCount % TRACK_EVERY === 0) updateTarget(view, layer, pose.emulatedPosition);

  // 크기가 정해지면 촬영 버튼이 보인다. 다시 선택하기는 과일을 잡은 뒤에만 쓸 수 있다
  const measured = arResult !== null;
  btnCapture.hidden = !measured;
  btnCapture.disabled = !measured;
  btnReselect.disabled = !target;
  showDistance();

  setArGuide(time, arGuideText(pose.emulatedPosition));

  if (captureRequested) {
    captureRequested = false;
    capture(view, layer);
  }
  drawArOverlay(view);
}

const SEARCHING = "과일을 찾는 중입니다. 30cm쯤 떨어져 과일을 화면 가운데에 두세요";

function arGuideText(emulated) {
  if (arResult) {
    // 거리는 카메라 이미지와 정해진 크기로만 구하므로 AR이 폰 위치를 놓쳐도 이어진다
    if (!target) return "과일을 다시 찾는 중입니다. 과일을 화면 가운데에 두세요(잰 크기는 그대로)";
    const guide = distanceGuide(liveDistance && liveDistance.distanceMm, liveDistance && liveDistance.cut);
    if (!guide.inside) return guide.text;
    if (!autoCapture) return `${guide.text}. 촬영하세요`;
    return distanceStability(distanceHistory).stable ? `${guide.text}. 촬영합니다` : `${guide.text}. 폰을 잠시 멈춰 주세요`;
  }
  if (!target) {
    if (searchError === "cut") return "과일이 화면에 다 들어오게 조금 떨어져 주세요";
    return SEARCHING;
  }
  if (emulated) return arReady ? "AR이 폰 위치를 놓쳤습니다. 조금 떨어져 천천히 움직여 주세요" : SEARCHING;
  const moved = views.length > 1 ? Math.round(maxBaselineCm(views)) : 0;
  return `과일을 찾았습니다. 크기를 재면서 촬영 거리(12cm)까지 천천히 다가오세요 (${views.length}곳 측정 · ${moved}cm 이동)`;
}

// 과일이 화면의 짧은 변 절반 넘게 차지하는가(사진 속 지름 기준)
function fillsScreen(fruit, image) {
  const radiusPx = fruit.k.fx * Math.tan(fruit.cone.alpha);
  return 2 * radiusPx > 0.5 * Math.min(image.width, image.height);
}

// 크기를 잰 뒤 화면 아래쪽에 표면까지 거리를 크게 보여 준다. 12cm 안이면 초록색
function showDistance() {
  const show = arResult !== null && target !== null && liveDistance !== null && !liveDistance.cut;
  arDistance.hidden = !show;
  if (!show) return;
  const stability = distanceStability(distanceHistory);
  const state = stability.rangeMm === null ? "" : stability.stable ? " · 안정됨" : " · 흔들림";
  const text = `표면까지 ${(liveDistance.distanceMm / 10).toFixed(1)} cm${state}`;
  if (arDistance.textContent !== text) arDistance.textContent = text;
  arDistance.classList.toggle("ar-distance-inside", distanceGuide(liveDistance.distanceMm).inside);
}

function maxBaselineCm(list) {
  let max = 0;
  for (const a of list) {
    for (const b of list) {
      max = Math.max(max, Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]));
    }
  }
  return max * 100;
}

function setArGuide(time, text) {
  if (arNote && time < arNote.until) text = arNote.text;
  else arNote = null;
  if (arGuide.textContent !== text) arGuide.textContent = text;
}

// ---------- AR 크기 측정: 과일을 찾아 따라가며 여러 위치에서 본 윤곽으로 크기를 정한다 ----------
// 과일을 처음부터 다시 찾는다(다시 선택하기, 저장 후 다음 과일, AR 종료)
function resetTarget() {
  loseTarget();
  searchError = "none";
  resetArMeasure();
}

// 따라가던 과일만 놓는다(잰 크기는 그대로)
function loseTarget() {
  target = null;
  lostCount = 0;
  trackedCount = 0;
  liveDistance = null;
  wasInside = false;
  distanceHistory = [];
}

// 따라가는 과일은 그대로 두고 크기만 다시 잰다
function resetArMeasure() {
  arNote = null;
  liveDistance = null;
  wasInside = false;
  distanceHistory = [];
  views = [];
  sizeHistory = [];
  arResult = null;
  arDone.hidden = true;
  btnCapture.disabled = true;
}

// 카메라 이미지에서 과일을 찾거나 따라가고, AR이 폰 위치를 알면 그 위치의 원뿔을 모아 크기를 계산한다
function updateTarget(view, layer, emulated) {
  if (!view.camera) return;
  let image;
  try {
    image = readCameraImage(view.camera, TRACK_IMAGE_SHORT);
  } catch (error) {
    console.error(error);
    return;
  } finally {
    xr.gl.bindFramebuffer(xr.gl.FRAMEBUFFER, layer.framebuffer);
  }
  const k = intrinsicsFromProjection(view.projectionMatrix, image.width, image.height);
  const found = target ? trackFruit(image, k, target) : acquireFruit(image, k);
  if (!found.cone) {
    // 크기를 잰 뒤 너무 가까워 과일이 화면에 다 들어오지 않으면, 놓친 것이 아니라 조금 멀리 가라고 안내한다.
    // 화면을 꽉 채우면 윤곽 자체를 못 찾으므로, 직전에 과일이 화면을 크게 차지하고 있었어도 너무 가까운 것으로 본다
    if (arResult && (found.error === "cut" || (target && fillsScreen(target, image)))) {
      liveDistance = { cut: true };
      wasInside = false;
      distanceHistory = [];
      return;
    }
    if (!target) searchError = found.error;
    else if (++lostCount >= LOST_LIMIT) {
      // 잠깐 잡았다 놓친 것이면 조용히 다시 찾고, 충분히 따라가던 과일을 놓쳤을 때만 알린다
      const established = trackedCount >= TRACK_ESTABLISHED;
      if (arResult) loseTarget(); // 잰 크기는 남기고 과일만 다시 찾는다
      else resetTarget();
      if (established) showArNote("과일을 놓쳤습니다. 과일을 화면 가운데에 두세요");
    }
    return;
  }
  lostCount = 0;
  trackedCount++;
  const p = view.transform.position;
  const position = [p.x, p.y, p.z];
  const matrix = Array.from(view.transform.matrix);
  target = { ...found, k, matrix, position };

  // 크기가 정해진 뒤에는 화면 속 크기로 거리를 구한다. 12cm 안에 들어오는 순간 진동으로도 알린다
  if (arResult) {
    liveDistance = { distanceMm: distanceFromCone(found.cone, arResult.sizeMm).distanceMm, cut: false };
    const inside = distanceGuide(liveDistance.distanceMm).inside;
    if (inside && !wasInside) {
      if (navigator.vibrate) navigator.vibrate(80);
      // 다가오다 멈칫한 값까지 안정으로 치지 않게, 12cm 안에 들어온 뒤의 값으로만 안정을 판정한다
      distanceHistory = [];
    }
    wasInside = inside;
    distanceHistory.push(liveDistance.distanceMm);
    if (distanceHistory.length > 30) distanceHistory.shift();
    // 12cm 안에서 잠시 멈추면(안정) 그 순간을 찍는다. 이 순간이 근적외선을 비추고 재는 순간이다
    if (inside && autoCapture && autoHold === 0 && distanceStability(distanceHistory).stable) captureRequested = true;
    return;
  }
  // AR이 폰 위치를 모르면(추정 위치) 크기 계산에 모으지 않는다
  if (emulated) return;
  views.push({ origin: position, d: normalize(cameraDirToWorld(matrix, found.cone.d)), sinA: found.cone.sinA });
  const fit = fitSphereViews(views);
  if (!fit) return;
  sizeHistory.push(fit.sizeMm);
  if (isSizeStable(sizeHistory, SIZE_STABLE_COUNT, SIZE_STABLE_RATIO)) setArResult(fit);
}

function setArResult(fit) {
  arResult = fit;
  arNote = null; // 앞선 안내는 지운다
  document.getElementById("ar-done-size").textContent = `${fit.sizeMm.toFixed(1)} mm`;
  document.getElementById("ar-done-sub").textContent =
    `과일을 공으로 보고 잰 지름 · ${views.length}곳에서 측정, ${Math.round(fit.baselineM * 100)}cm 이동`;
  arDone.hidden = false;
}

// ---------- AR 화면 위 표시(과일 둘레) ----------
// 크기가 정해지기 전에는 찾은 윤곽을, 정해진 뒤에는 그 크기의 구를 지금 카메라 위치에서 본 둘레를 그린다.
// 화면 가운데 기준점은 보이지 않는다(사용자는 과일을 화면 가운데에 둘 뿐이다)
function drawArOverlay(view) {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  arCtx.setTransform(1, 0, 0, 1, 0, 0);
  arCtx.clearRect(0, 0, arCanvas.width, arCanvas.height);
  arCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!view) return;
  const toScreen = (q) => projectToScreen(q, view.transform.inverse.matrix, view.projectionMatrix, w, h);

  if (target) {
    // 따라가는 과일의 윤곽(사진 좌표)을 그때의 카메라에서 1m 앞 세계 점으로 바꿔 지금 화면에 그린다.
    // 크기를 재기 전에는 청록, 잰 뒤에는 자주
    const outline = target.outline.map((px) => {
      const dir = normalize(cameraDirToWorld(target.matrix, pixelToRay(px, target.k)));
      return toScreen([0, 1, 2].map((i) => target.position[i] + dir[i]));
    });
    if (outline.length > 0 && outline.every(Boolean)) drawOutline(arCtx, outline, arResult ? FRUIT_COLOR : RETICLE_COLOR);
  } else if (arResult) {
    // 과일을 다시 찾는 동안에는 잰 크기의 구를 지금 카메라 위치에서 본 둘레로 그린다
    const p = view.transform.position;
    const outline = sphereOutline(arResult.center, arResult.radiusM, [p.x, p.y, p.z]).map(toScreen);
    if (outline.length > 0 && outline.every(Boolean)) drawOutline(arCtx, outline, FRUIT_COLOR);
  }
}

// 카메라에서 본 구의 윤곽(세계 좌표 점들). 카메라가 구 안에 있으면 빈 배열
function sphereOutline(center, r, camera, n = 48) {
  const v = [center[0] - camera[0], center[1] - camera[1], center[2] - camera[2]];
  const dist = Math.hypot(v[0], v[1], v[2]);
  if (!(dist > r)) return [];
  const d = [v[0] / dist, v[1] / dist, v[2] / dist];
  const sinA = r / dist;
  const cosA = Math.sqrt(1 - sinA * sinA);
  const length = dist * cosA; // 카메라에서 접점까지
  const t = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = normalize(cross(d, t));
  const e2 = cross(d, e1);
  const points = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    points.push([0, 1, 2].map((j) =>
      camera[j] + length * (cosA * d[j] + sinA * (Math.cos(a) * e1[j] + Math.sin(a) * e2[j]))));
  }
  return points;
}

// 닫힌 둘레선. points: 화면 좌표
function drawOutline(context, points, color) {
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  points.forEach((p, i) => (i === 0 ? context.moveTo(p.x, p.y) : context.lineTo(p.x, p.y)));
  context.closePath();
  context.stroke();
}

// 점과 선. points: 화면 좌표
function drawPoints(context, points, color) {
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 2;
  if (points.length === 2) {
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    context.lineTo(points[1].x, points[1].y);
    context.stroke();
  }
  for (const p of points) {
    context.beginPath();
    context.arc(p.x, p.y, 6, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(p.x, p.y, 2, 0, Math.PI * 2);
    context.fill();
  }
}

// ---------- 촬영: AR 화면과 같은 카메라 이미지를 가져온다 ----------
function capture(view, layer) {
  if (!view.camera) {
    showArNote("카메라 이미지를 가져오지 못했습니다. 다시 촬영해 주세요");
    return;
  }
  let image;
  try {
    image = readCameraImage(view.camera);
  } catch (error) {
    console.error(error);
    showArNote("카메라 이미지를 가져오지 못했습니다. 다시 촬영해 주세요");
    return;
  } finally {
    xr.gl.bindFramebuffer(xr.gl.FRAMEBUFFER, layer.framebuffer);
  }
  const intrinsics = intrinsicsFromProjection(view.projectionMatrix, image.width, image.height);
  // 따라가던 과일의 원뿔(방향·각도)은 사진 해상도와 상관없으므로 그대로 사진에 넘긴다
  showPhoto(image, intrinsics, target ? target.cone : null);
}

// 카메라 텍스처를 복사해 읽는다(셰이더로 그린 뒤 readPixels). maxShort를 주면 짧은 변이 그 크기가 되도록 줄여 읽는다
function readCameraImage(camera, maxShort) {
  const gl = xr.gl;
  const scale = maxShort ? Math.min(1, maxShort / Math.min(camera.width, camera.height)) : 1;
  const width = Math.round(camera.width * scale);
  const height = Math.round(camera.height * scale);
  const texture = xr.binding.getCameraImage(camera);
  if (!xr.blit) xr.blit = createBlit(gl);
  const { program, buffer } = xr.blit;

  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);

  gl.viewport(0, 0, width, height);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const loc = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(gl.getUniformLocation(program, "uTex"), 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(target);

  // WebGL은 아래쪽부터 읽으므로 위아래를 뒤집는다
  const image = new ImageData(width, height);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  }
  return image;
}

function createBlit(gl) {
  const vs = `#version 300 es
    in vec2 aPos;
    out vec2 vUv;
    void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const fs = `#version 300 es
    precision mediump float;
    uniform sampler2D uTex;
    in vec2 vUv;
    out vec4 color;
    void main() { color = texture(uTex, vUv); }`;
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  return { program, buffer };
}

// ---------- 찍은 사진 화면 ----------
// photo: 찍은 사진(카메라 이미지 픽셀 크기 유지), intrinsics: 그 사진의 초점거리·중심(px)
// view: 화면 좌표 = 사진 좌표 * scale + (offsetX, offsetY), 단위는 CSS 픽셀
let photo = null;
let intrinsics = null;
const view = { scale: 1, minScale: 1, maxScale: 1, offsetX: 0, offsetY: 0 };
const MAX_ZOOM = 10;
// photoPoints: 사진에서 지정한 과일 양 끝(사진 픽셀 좌표), photoResult: 거리 계산 결과
let photoPoints = [];
let photoResult = null;
// 사진에서 과일 지정 방식: auto는 과일 터치 → 윤곽 자동 인식, manual은 양 끝 직접 터치
let photoMode = "auto";
let photoImage = null;   // 인식에 쓰는 사진 픽셀(ImageData)
let photoDetect = null;  // 인식 결과 { cone, outline, inliers } 또는 { error }
const btnPhotoMode = document.getElementById("btn-photo-mode");

document.getElementById("btn-retake").addEventListener("click", showArUi);
document.getElementById("btn-reset-fruit").addEventListener("click", () => {
  resetPhotoFruit();
  draw();
});
btnPhotoMode.addEventListener("click", () => {
  setPhotoMode(photoMode === "auto" ? "manual" : "auto");
  draw();
});

function setPhotoMode(mode) {
  photoMode = mode;
  btnPhotoMode.textContent = mode === "auto" ? "직접 지정" : "자동 인식";
  resetPhotoFruit();
}

async function showPhoto(image, cameraIntrinsics, trackedCone = null) {
  const bitmap = await createImageBitmap(image);
  if (photo) photo.close();
  photo = bitmap;
  photoImage = image;
  intrinsics = cameraIntrinsics;
  arUi.hidden = true;
  arCanvas.hidden = true;
  photoScreen.hidden = false;
  photoInfo.textContent = `${photo.width}×${photo.height}px · 초점거리 ${intrinsics.fx.toFixed(0)}px`;
  setPhotoMode("auto");
  resizeCanvas();
  fitToScreen();
  // AR에서 따라가던 과일이 있으면 그 위치·크기에 맞는 윤곽을 찾는다. 없으면 사진 가운데에서 찾아 본다
  if (trackedCone) findTrackedFruit(trackedCone);
  else detectPhotoFruit({ x: photo.width / 2, y: photo.height / 2 });
  draw();
}

function resetPhotoFruit() {
  photoPoints = [];
  photoResult = null;
  photoDetect = null;
  updatePhotoStatus();
}

// p(사진 좌표)에서 과일 윤곽을 찾고, 구의 원뿔 각도와 AR 크기로 표면까지 거리를 구한다
function detectPhotoFruit(p) {
  photoDetect = detectFruit(photoImage, p, intrinsics);
  photoResult = photoDetect.cone && arResult ? distanceFromCone(photoDetect.cone, arResult.sizeMm) : null;
  updatePhotoStatus();
}

// 사진 정가운데만 보면 위에서 찍었을 때 꼭지를 과일로 잡는다. 따라가던 원 안쪽 여러 곳에서 크기가 맞는 윤곽을 고르고,
// 사진에서 못 찾으면 따라가던 원을 그대로 쓴다(촬영 순간에 AR이 본 과일)
function findTrackedFruit(trackedCone) {
  photoDetect = findInPhoto(photoImage, intrinsics, trackedCone);
  if (!photoDetect.cone) photoDetect = { cone: trackedCone, outline: coneOutline(trackedCone, intrinsics), inliers: [] };
  photoResult = arResult ? distanceFromCone(photoDetect.cone, arResult.sizeMm) : null;
  updatePhotoStatus();
}

function addPhotoPoint(p) {
  if (photoPoints.length === 2) photoPoints = [];
  photoResult = null;
  photoPoints.push(p);
  if (photoPoints.length === 2 && arResult) {
    photoResult = distanceFromPhoto(photoPoints[0], photoPoints[1], intrinsics, arResult.sizeMm);
  }
  updatePhotoStatus();
}

function updatePhotoStatus() {
  const sizeNote = arResult
    ? `<span class="status-sub">과일 크기 ${arResult.sizeMm.toFixed(1)}mm(AR) 기준</span>`
    : "";
  let line;
  if (photoResult) {
    line = `카메라~과일 표면 거리 <strong class="status-fruit">${photoResult.distanceMm.toFixed(1)} mm</strong>`;
  } else if (photoMode === "auto") {
    if (!photoDetect) line = "과일을 터치하면 윤곽을 찾습니다";
    else if (photoDetect.error === "cut") line = "과일이 사진에 다 들어오지 않았습니다. 다시 찍어 주세요";
    else line = "과일을 찾지 못했습니다. 과일을 터치하거나 「직접 지정」으로 양 끝을 터치하세요";
  } else if (photoPoints.length === 2) {
    line = "두 점이 같은 위치입니다. 과일 양 끝을 다시 터치하세요";
  } else {
    line = `흐리면 다시 찍기, 선명하면 과일 양 끝을 터치하세요 (${photoPoints.length}/2)`;
  }
  photoStatus.innerHTML = `${line}<br>${sizeNote}`;
  document.getElementById("btn-save").disabled = !photoResult;
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
}

// 사진 전체가 잘리지 않고 화면 가운데에 보이도록 배율과 위치를 정한다
function fitToScreen() {
  const rect = canvas.getBoundingClientRect();
  const fit = Math.min(rect.width / photo.width, rect.height / photo.height);
  view.minScale = fit;
  view.maxScale = fit * MAX_ZOOM;
  view.scale = fit;
  view.offsetX = (rect.width - photo.width * fit) / 2;
  view.offsetY = (rect.height - photo.height * fit) / 2;
}

function draw() {
  if (!photo) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.offsetX, dpr * view.offsetY);
  ctx.drawImage(photo, 0, 0);
  // 점과 선은 확대 배율과 상관없이 같은 크기로 보이도록 화면 좌표로 그린다
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (photoMode === "auto") {
    if (photoDetect && photoDetect.cone) {
      // 찾은 경계점(원형에 맞은 점)과 맞춘 둘레선
      ctx.fillStyle = RETICLE_COLOR;
      for (const q of photoDetect.inliers) {
        const p = photoToScreen(q);
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      }
      drawOutline(ctx, photoDetect.outline.map(photoToScreen), FRUIT_COLOR);
    }
  } else {
    drawPoints(ctx, photoPoints.map(photoToScreen), FRUIT_COLOR);
  }
}

function screenToPhoto(p) {
  return { x: (p.x - view.offsetX) / view.scale, y: (p.y - view.offsetY) / view.scale };
}

function photoToScreen(p) {
  return { x: p.x * view.scale + view.offsetX, y: p.y * view.scale + view.offsetY };
}

// 창 크기뿐 아니라 아래 안내 문구 길이가 바뀌어 사진 영역 크기가 달라져도 다시 맞춘다(그대로 두면 사진이 찌그러짐)
new ResizeObserver(() => {
  if (photoScreen.hidden || !photo) return;
  const wasFit = view.scale <= view.minScale * 1.0001;
  resizeCanvas();
  if (wasFit) {
    fitToScreen();
  } else {
    const rect = canvas.getBoundingClientRect();
    view.minScale = Math.min(rect.width / photo.width, rect.height / photo.height);
    view.maxScale = view.minScale * MAX_ZOOM;
    view.scale = clamp(view.scale, view.minScale, view.maxScale);
    keepPhotoInView();
  }
  draw();
}).observe(canvas);

// ---------- 터치: 짧은 터치는 점 찍기, 한 손가락 끌기는 이동, 두 손가락은 확대·이동 ----------
// 마우스(PC 확인용)도 같은 규칙: 클릭은 점 찍기, 드래그는 이동, 휠은 확대
const TAP_TOLERANCE = 8; // CSS 픽셀. 손가락은 마우스보다 흔들린다
const pointers = new Map(); // 누르고 있는 손가락 id → 위치
let pressStart = null;
let dragging = false;
let tapCancelled = false;   // 두 손가락을 댔던 동작은 점 찍기로 보지 않는다
let pinchFrom = null;       // 직전 두 손가락 거리와 가운데 { dist, mid }

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function pinchState() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

canvas.addEventListener("pointerdown", (event) => {
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch (error) {
    // 무시(실패해도 동작에는 지장 없음)
  }
  pointers.set(event.pointerId, canvasPoint(event));
  if (pointers.size === 1) {
    pressStart = canvasPoint(event);
    dragging = false;
    tapCancelled = false;
  } else if (pointers.size === 2) {
    tapCancelled = true;
    pinchFrom = pinchState();
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!pointers.has(event.pointerId) || !photo) return;
  const prev = pointers.get(event.pointerId);
  const curr = canvasPoint(event);
  pointers.set(event.pointerId, curr);

  if (pointers.size >= 2) {
    const now = pinchState();
    if (pinchFrom) {
      if (pinchFrom.dist > 0) zoomAt(now.mid, now.dist / pinchFrom.dist);
      view.offsetX += now.mid.x - pinchFrom.mid.x;
      view.offsetY += now.mid.y - pinchFrom.mid.y;
    }
    pinchFrom = now;
  } else {
    if (!dragging && Math.hypot(curr.x - pressStart.x, curr.y - pressStart.y) > TAP_TOLERANCE) dragging = true;
    if (!dragging) return;
    view.offsetX += curr.x - prev.x;
    view.offsetY += curr.y - prev.y;
  }
  keepPhotoInView();
  draw();
});

canvas.addEventListener("pointerup", (event) => {
  if (!pointers.has(event.pointerId)) return;
  if (pointers.size === 1 && !dragging && !tapCancelled && photo) {
    const p = screenToPhoto(canvasPoint(event));
    // 사진 바깥을 터치한 경우는 무시한다
    if (p.x >= 0 && p.y >= 0 && p.x <= photo.width && p.y <= photo.height) {
      if (photoMode === "auto") detectPhotoFruit(p);
      else addPhotoPoint(p);
      draw();
    }
  }
  endPointer(event);
});
canvas.addEventListener("pointercancel", endPointer);

function endPointer(event) {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinchFrom = null;
  if (pointers.size === 1) {
    // 두 손가락 중 하나를 떼면 남은 손가락으로 이어서 이동한다
    dragging = true;
  }
  if (pointers.size === 0) {
    pressStart = null;
    dragging = false;
  }
}

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (!photo) return;
  const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
  zoomAt(canvasPoint(event), Math.exp(-delta * 0.0018));
  keepPhotoInView();
  draw();
}, { passive: false });

// p(화면 좌표)를 기준으로 ratio배 확대한다
function zoomAt(p, ratio) {
  const newScale = clamp(view.scale * ratio, view.minScale, view.maxScale);
  const r = newScale / view.scale;
  view.offsetX = p.x - (p.x - view.offsetX) * r;
  view.offsetY = p.y - (p.y - view.offsetY) * r;
  view.scale = newScale;
}

// 사진이 화면 밖으로 완전히 벗어나지 않게 한다
function keepPhotoInView() {
  const rect = canvas.getBoundingClientRect();
  const w = photo.width * view.scale;
  const h = photo.height * view.scale;
  view.offsetX = w <= rect.width ? (rect.width - w) / 2 : clamp(view.offsetX, rect.width - w, 0);
  view.offsetY = h <= rect.height ? (rect.height - h) / 2 : clamp(view.offsetY, rect.height - h, 0);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ---------- 기록 저장과 목록 ----------
// 카드 기준으로 재던 때의 기록도 같은 저장 공간에 있다(거리 없음)
// records: [{ no: 측정 번호, sizeMm: 크기, distanceMm: 표면까지 거리(카드 기준 기록에는 없음), at: 측정 시각(ISO) }]
const STORAGE_KEY = "fruit-measure-records";
const recordsScreen = document.getElementById("screen-records");
const btnSave = document.getElementById("btn-save");

btnSave.addEventListener("click", saveRecord);
document.getElementById("btn-records").addEventListener("click", showRecords);
document.getElementById("btn-records-back").addEventListener("click", () => {
  recordsScreen.hidden = true;
  homeScreen.hidden = false;
});

function loadRecords() {
  try {
    const records = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!Array.isArray(records)) return [];
    // 저장된 값이 손상되어도 앱이 멈추지 않도록 형식이 맞는 기록만 쓴다
    return records.filter((r) =>
      r && Number.isFinite(r.no) && Number.isFinite(r.sizeMm) && !Number.isNaN(new Date(r.at).getTime()));
  } catch (error) {
    return [];
  }
}

function saveRecord() {
  if (!photoResult || !arResult) return;
  const records = loadRecords();
  const record = {
    // 지운 번호가 있어도 겹치지 않도록 가장 큰 번호 다음으로 매긴다
    no: records.reduce((max, r) => Math.max(max, r.no), 0) + 1,
    sizeMm: Math.round(arResult.sizeMm * 10) / 10,
    distanceMm: Math.round(photoResult.distanceMm * 10) / 10,
    at: new Date().toISOString(),
  };
  records.push(record);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch (error) {
    console.error(error);
    photoStatus.textContent = "브라우저에 저장하지 못했습니다. 저장 공간 설정을 확인해 주세요.";
    return;
  }
  // 다음 과일을 바로 잴 수 있도록 AR 화면으로 돌아가 과일 찾기부터 다시 한다
  resetTarget();
  showArUi();
  showArNote(`${record.no}번 기록 저장됨 · 크기 ${record.sizeMm.toFixed(1)}mm · 거리 ${record.distanceMm.toFixed(1)}mm. 다음 과일을 재세요`);
}

let pendingDeleteNo = null; // 「정말 삭제」 확인을 기다리는 기록 번호

function showRecords() {
  pendingDeleteNo = null;
  renderRecords();
  homeScreen.hidden = true;
  recordsScreen.hidden = false;
}

function renderRecords() {
  const records = loadRecords();
  const body = document.getElementById("records-body");
  body.textContent = "";
  for (const r of records) {
    const row = body.insertRow();
    row.insertCell().textContent = r.no;
    row.insertCell().textContent = r.sizeMm.toFixed(1);
    // 카드 기준으로 잰 기록은 거리가 없다
    row.insertCell().textContent = Number.isFinite(r.distanceMm) ? r.distanceMm.toFixed(1) : "–";
    row.insertCell().textContent = new Date(r.at).toLocaleString("ko-KR");
    const button = document.createElement("button");
    button.type = "button";
    button.className = r.no === pendingDeleteNo ? "btn-delete btn-delete-confirm" : "btn-delete";
    button.textContent = r.no === pendingDeleteNo ? "정말 삭제" : "삭제";
    button.addEventListener("click", () => onDeleteClick(r.no));
    row.insertCell().appendChild(button);
  }
  document.getElementById("records-empty").hidden = records.length > 0;
  document.getElementById("records-table").hidden = records.length === 0;
}

// 처음 누르면 확인 상태로 바뀌고, 같은 줄을 한 번 더 누르면 삭제한다
function onDeleteClick(no) {
  if (pendingDeleteNo !== no) {
    pendingDeleteNo = no;
    renderRecords();
    return;
  }
  pendingDeleteNo = null;
  const records = loadRecords().filter((r) => r.no !== no);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch (error) {
    console.error(error);
  }
  renderRecords();
}
