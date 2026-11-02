// AR 화면 흐름 테스트: 실행 `node test/app-flow.test.js`
// 폰 없이 앱(app.js)을 불러, 가짜 AR 프레임(계산으로 그린 카메라 사진 + 폰 위치)을 넣어 흐름을 확인한다
// 과일 찾기 → 따라가기 → 다가가며 크기 확정 → 완료 표시, 다시 선택하기, 과일을 놓쳤을 때
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { render, approachFrames } = require("./scene.js");

let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------- 화면 요소 흉내 ----------
function loadApp() {
  const elements = {};
  const el = (id) => {
    if (!elements[id]) {
      const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
      elements[id] = {
        id, hidden: false, disabled: false, textContent: "", style: {}, width: 0, height: 0, listeners: {},
        classes: new Set(),
        classList: {
          toggle(c, on) { const set = elements[id].classes; (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); },
          add(c) { elements[id].classes.add(c); }, remove(c) { elements[id].classes.delete(c); },
          contains(c) { return elements[id].classes.has(c); },
        },
        addEventListener(type, fn) { this.listeners[type] = fn; },
        click() { this.listeners.click && this.listeners.click(); },
        getContext: () => ctx2d, appendChild() {}, querySelector: () => el(`${id}-q`),
        insertRow: () => ({ insertCell: () => el("cell"), dataset: {} }),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 360, height: 780 }),
      };
    }
    return elements[id];
  };
  const store = {};
  const context = {
    console, Math, JSON, Date, Number, Array, Object, Float32Array, Uint8Array, Uint8ClampedArray, Promise, Infinity, NaN, isFinite,
    document: { getElementById: el, createElement: () => el(`tmp-${Math.random()}`), body: el("body"), querySelectorAll: () => [] },
    window: { innerWidth: 360, innerHeight: 780, devicePixelRatio: 1, addEventListener() {} },
    navigator: {},
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = v), removeItem: (k) => delete store[k] },
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0, setTimeout: () => 0,
    ResizeObserver: class { observe() {} },
    createImageBitmap: async (image) => ({ width: image.width, height: image.height, close() {} }),
    ImageData: class { constructor(w, h) { Object.assign(this, { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }); } },
  };
  vm.createContext(context);
  for (const file of ["measure.js", "detect.js", "app.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });
  }
  return { context, el, run: (code) => vm.runInContext(code, context) };
}

// ---------- 가짜 AR ----------
// 사진 크기 480x640, 초점거리 480px인 카메라의 투영 행렬(사진 가운데가 화면 가운데)
const W = 480, H = 640;
const PROJECTION = [2 * 480 / W, 0, 0, 0, 0, 2 * 480 / H, 0, 0, 0, 0, -1, -1, 0, 0, -0.02, 0];

function inverseRigid(m) {
  const p = [m[12], m[13], m[14]];
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0];
  return [...r, -(r[0] * p[0] + r[4] * p[1] + r[8] * p[2]), -(r[1] * p[0] + r[5] * p[1] + r[9] * p[2]), -(r[2] * p[0] + r[6] * p[1] + r[10] * p[2]), 1];
}

// scene: render()에 넣을 장면. emulated: AR이 폰 위치를 놓친 상태
function fakeFrame(scene, emulated = false) {
  const m = scene.pose;
  const view = {
    camera: { width: W, height: H, scene },
    transform: { position: { x: m[12], y: m[13], z: m[14] }, matrix: Float32Array.from(m), inverse: { matrix: inverseRigid(m) } },
    projectionMatrix: PROJECTION,
  };
  return { getViewerPose: () => ({ views: [view], emulatedPosition: emulated, transform: view.transform }) };
}

// 앱을 AR 중 상태로 만들고, 카메라 이미지는 장면을 그려 돌려주도록 바꾼다
function startFakeAr(app) {
  app.run(`
    xr = { session: { requestAnimationFrame() {}, renderState: { baseLayer: { framebuffer: null } }, end() {} },
           gl: { bindFramebuffer() {}, clearColor() {}, clear() {}, FRAMEBUFFER: 0, COLOR_BUFFER_BIT: 0 }, refSpace: {} };
    readCameraImage = (camera) => __render(camera.scene);
    homeScreen.hidden = true; arRoot.hidden = false; showArUi();
    arDone.hidden = true; btnCapture.hidden = true; // index.html에서 처음에 숨겨 둔 요소
  `);
  app.context.__render = render;
}

// 프레임을 n번 보낸다(과일 찾기는 TRACK_EVERY 프레임마다 돈다)
function feed(app, scene, n, emulated = false) {
  for (let i = 0; i < n; i++) app.context.onXrFrame(i * 16, fakeFrame(scene, emulated));
}

const R = 0.035;

test("시작하면 버튼 없이 바로 과일을 찾고, 다가가면 크기가 정해져 완료 표시가 뜸", () => {
  const app = loadApp();
  startFakeAr(app);
  assert.ok(!app.el("btn-detect").listeners.click && !app.el("btn-point").listeners.click, "과일 인식·점 찍기 버튼이 남아 있음");
  const frames = approachFrames(R, 40, 0.42, 0.22, 14, { noise: 8 });
  let doneAt = -1;
  frames.forEach((scene, i) => {
    feed(app, scene, 3);
    if (doneAt < 0 && !app.el("ar-done").hidden) doneAt = i;
  });
  assert.ok(doneAt >= 0, `완료 표시가 뜨지 않음. 안내: ${app.el("ar-guide").textContent}`);
  const size = app.run("arResult.sizeMm");
  assert.ok(Math.abs(size - 70) / 70 < 0.03, `크기 ${size.toFixed(1)}mm`);
  assert.match(app.el("ar-done-size").textContent, /mm/);
  assert.match(app.el("ar-done-sub").textContent, /지름/);
  assert.strictEqual(app.el("btn-capture").hidden, false, "촬영 버튼이 보여야 함");
});

test("크기가 정해지기 전에는 과일을 찾았다는 안내와 측정 진행이 보임", () => {
  const app = loadApp();
  startFakeAr(app);
  const frames = approachFrames(R, 40, 0.42, 0.22, 14, { noise: 8 });
  feed(app, frames[0], 3);
  feed(app, frames[1], 3);
  assert.match(app.el("ar-guide").textContent, /찾았습니다/);
  assert.strictEqual(app.el("ar-done").hidden, true);
  assert.strictEqual(app.el("btn-reselect").disabled, false, "과일을 잡으면 다시 선택하기를 쓸 수 있어야 함");
});

test("폰이 거의 움직이지 않으면 크기를 정하지 않음", () => {
  const app = loadApp();
  startFakeAr(app);
  const frames = approachFrames(R, 40, 0.42, 0.40, 10, { noise: 8 });
  frames.forEach((scene) => feed(app, scene, 3));
  assert.strictEqual(app.el("ar-done").hidden, true, "2cm만 움직였는데 크기가 정해짐");
});

test("AR이 폰 위치를 놓친 프레임은 크기 계산에 넣지 않음", () => {
  const app = loadApp();
  startFakeAr(app);
  const frames = approachFrames(R, 40, 0.42, 0.22, 14, { noise: 8 });
  feed(app, frames[0], 1); // AR이 한 번 위치를 잡은 뒤(과일 찾기는 아직 돌지 않음)
  frames.forEach((scene) => feed(app, scene, 3, true));
  assert.strictEqual(app.run("views.length"), 0);
  assert.match(app.el("ar-guide").textContent, /위치를 놓쳤습니다/);
});

test("다시 선택하기: 안내가 뜨고 과일을 처음부터 다시 찾음", () => {
  const app = loadApp();
  startFakeAr(app);
  const frames = approachFrames(R, 40, 0.42, 0.22, 14, { noise: 8 });
  frames.slice(0, 4).forEach((scene) => feed(app, scene, 3));
  assert.ok(app.run("target !== null"));
  app.el("btn-reselect").click();
  feed(app, frames[4], 1);
  assert.match(app.el("ar-guide").textContent, /화면 가운데에 가깝게/);
  assert.strictEqual(app.run("views.length"), 0, "모은 측정이 지워져야 함");
});

test("과일이 화면에서 사라지면 몇 번 뒤 놓쳤다고 안내하고 다시 찾기 시작함", () => {
  const app = loadApp();
  startFakeAr(app);
  const frames = approachFrames(R, 40, 0.42, 0.22, 14, { noise: 8 });
  frames.slice(0, 3).forEach((scene) => feed(app, scene, 3));
  const empty = { ...frames[3], center: [5, R, 5] };
  feed(app, empty, 15);
  assert.ok(app.run("target === null"), "놓친 뒤에도 과일을 잡고 있음");
  assert.match(app.el("ar-guide").textContent, /놓쳤습니다|가운데에 두세요/);
});

test("과일이 화면에 없으면 가운데에 두라는 안내", () => {
  const app = loadApp();
  startFakeAr(app);
  const scene = { ...approachFrames(R, 40, 0.42, 0.22, 2, { noise: 8 })[0], center: [5, R, 5] };
  feed(app, scene, 6);
  assert.match(app.el("ar-guide").textContent, /가운데에 두세요/);
});

test("시작 직후 AR이 아직 위치를 못 잡았을 때는 「놓쳤습니다」가 아니라 「찾는 중」", () => {
  const app = loadApp();
  startFakeAr(app);
  app.context.onXrFrame(0, { getViewerPose: () => null });
  assert.match(app.el("ar-guide").textContent, /찾는 중/);
  const frames = approachFrames(R, 40, 0.42, 0.22, 14, { noise: 8 });
  feed(app, frames[0], 6, true);
  assert.match(app.el("ar-guide").textContent, /찾는 중/);
  assert.doesNotMatch(app.el("ar-guide").textContent, /놓쳤/);
});

test("과일을 잠깐만 잡았다 놓치면 「놓쳤습니다」 없이 다시 찾음", () => {
  const app = loadApp();
  startFakeAr(app);
  const frames = approachFrames(R, 40, 0.42, 0.22, 14, { noise: 8 });
  feed(app, frames[0], 3); // 한 번 잡음
  const empty = { ...frames[1], center: [5, R, 5] };
  feed(app, empty, 15);
  assert.ok(app.run("target === null"));
  assert.doesNotMatch(app.el("ar-guide").textContent, /놓쳤/);
  assert.match(app.el("ar-guide").textContent, /찾는 중/);
});

test("충분히 따라가던 과일을 놓치면 「놓쳤습니다」", () => {
  const app = loadApp();
  startFakeAr(app);
  const frames = approachFrames(R, 40, 0.42, 0.22, 14, { noise: 8 });
  frames.slice(0, 6).forEach((scene) => feed(app, scene, 3)); // 6번 따라감
  const empty = { ...frames[6], center: [5, R, 5] };
  feed(app, empty, 15);
  assert.match(app.el("ar-guide").textContent, /놓쳤습니다/);
});

// ---------- 16단계: 12cm 안내 ----------
// 크기를 잴 때까지 다가간 뒤, 표면까지 surfaceM(m) 떨어진 장면
function measuredApp() {
  const app = loadApp();
  startFakeAr(app);
  approachFrames(R, 40, 0.42, 0.22, 14, { noise: 8 }).forEach((scene) => feed(app, scene, 3));
  assert.ok(app.run("arResult !== null"), "크기가 정해지지 않음");
  return app;
}
const sceneAt = (surfaceM) => approachFrames(R, 40, surfaceM + R, surfaceM + R, 2, { noise: 8 })[0];
// 표면까지 from → to(m)로 1cm씩 다가가며 장면마다 3프레임
function approach(app, from, to, emulated = false) {
  const n = Math.max(2, Math.round(Math.abs(from - to) * 100) + 1);
  for (let i = 0; i < n; i++) feed(app, sceneAt(from + ((to - from) * i) / (n - 1)), 3, emulated);
}

test("크기를 잰 뒤 25cm에서는 거리가 보이고 「더 가까이」 안내", () => {
  const app = measuredApp();
  feed(app, sceneAt(0.25), 6);
  const d = app.run("liveDistance.distanceMm");
  assert.ok(Math.abs(d - 250) / 250 < 0.03, `거리 ${d.toFixed(1)}mm`);
  assert.match(app.el("ar-guide").textContent, /더 가까이/);
  assert.strictEqual(app.el("ar-distance").hidden, false);
  assert.match(app.el("ar-distance").textContent, /표면까지 2\d\.\d cm/);
  assert.strictEqual(app.el("ar-distance").classList.contains("ar-distance-inside"), false);
});

test("12cm 안(10cm)에 들어오면 완료 안내와 초록 표시", () => {
  const app = measuredApp();
  approach(app, 0.2, 0.1);
  const d = app.run("liveDistance.distanceMm");
  assert.ok(Math.abs(d - 100) / 100 < 0.03, `거리 ${d.toFixed(1)}mm`);
  assert.match(app.el("ar-guide").textContent, /12cm 안에 들어왔습니다/);
  assert.strictEqual(app.el("ar-distance").classList.contains("ar-distance-inside"), true);
});

test("너무 가까워 과일이 화면에 다 안 들어오면 「조금 멀리」, 잰 크기와 과일은 그대로", () => {
  const app = measuredApp();
  approach(app, 0.2, 0.02);
  assert.match(app.el("ar-guide").textContent, /조금 멀리/);
  assert.ok(app.run("arResult !== null && target !== null"));
  assert.strictEqual(app.el("ar-distance").hidden, true);
  approach(app, 0.03, 0.1); // 다시 떨어지면 거리가 돌아옴
  assert.match(app.el("ar-guide").textContent, /12cm 안/);
});

test("크기를 잰 뒤 AR이 폰 위치를 놓쳐도 거리는 계속 나옴", () => {
  const app = measuredApp();
  approach(app, 0.2, 0.11, true);
  const d = app.run("liveDistance.distanceMm");
  assert.ok(Math.abs(d - 110) / 110 < 0.03, `거리 ${d.toFixed(1)}mm`);
  assert.match(app.el("ar-guide").textContent, /12cm 안/);
});

test("크기를 잰 뒤 과일을 놓쳐도 잰 크기는 남고 과일만 다시 찾음", () => {
  const app = measuredApp();
  const size = app.run("arResult.sizeMm");
  feed(app, sceneAt(0.2), 3);
  feed(app, { ...sceneAt(0.2), center: [5, R, 5] }, 15);
  assert.ok(app.run("target === null"));
  assert.strictEqual(app.run("arResult && arResult.sizeMm"), size);
  app.run("arNote = null"); // 「놓쳤습니다」 안내가 지나간 뒤
  feed(app, { ...sceneAt(0.2), center: [5, R, 5] }, 1);
  assert.match(app.el("ar-guide").textContent, /다시 찾는 중/);
  feed(app, sceneAt(0.18), 6);
  assert.ok(app.run("target !== null"), "과일을 다시 찾아야 함");
  assert.match(app.el("ar-guide").textContent, /더 가까이/);
});

// ---------- 17단계: 안정 판정과 자동 촬영 ----------
const tick = () => new Promise((resolve) => setImmediate(resolve));
const photoOpen = (app) => app.el("screen-photo").hidden === false && app.el("ar-ui").hidden === true;

test("12cm 안에서 잠시 멈추면 자동으로 찍히고, 사진에서 그 순간의 거리가 나와 저장됨", async () => {
  const app = measuredApp();
  app.el("screen-photo").hidden = true; // index.html에서 처음에 숨겨 둔 사진 화면
  approach(app, 0.2, 0.1);
  feed(app, sceneAt(0.1), 30); // 멈춤
  await tick();
  assert.ok(photoOpen(app), "자동 촬영되지 않음");
  const d = app.run("photoResult && photoResult.distanceMm");
  assert.ok(d && Math.abs(d - 100) / 100 < 0.03, `사진 거리 ${d}mm`);
  app.el("btn-save").click();
  const records = JSON.parse(app.context.localStorage.getItem("fruit-measure-records"));
  assert.ok(records.length === 1 && Math.abs(records[0].distanceMm - 100) < 3, JSON.stringify(records));
});

test("12cm 안이라도 흔들리면 찍지 않고 「잠시 멈춰」, 거리 옆에 「흔들림」", async () => {
  const app = measuredApp();
  app.el("screen-photo").hidden = true;
  approach(app, 0.2, 0.11);
  for (let i = 0; i < 8; i++) feed(app, sceneAt(i % 2 ? 0.11 : 0.1), 3); // 1cm씩 왔다 갔다
  await tick();
  assert.ok(!photoOpen(app), "흔들리는데 찍힘");
  assert.match(app.el("ar-guide").textContent, /잠시 멈춰/);
  assert.match(app.el("ar-distance").textContent, /흔들림/);
});

test("폰 확인 버그: 천천히 다가와 12cm 안에 들어오자마자 찍히지 않고, 들어온 뒤 멈춰야 찍힘", async () => {
  const app = measuredApp();
  app.el("screen-photo").hidden = true;
  approach(app, 0.2, 0.13);
  // 1mm씩 천천히 다가오며 12cm 선을 넘는다(예전에는 넘자마자 찍혔다)
  for (let mm = 130; mm >= 117; mm--) feed(app, sceneAt(mm / 1000), 3);
  await tick();
  assert.ok(!photoOpen(app), "들어오자마자 찍힘");
  assert.match(app.el("ar-guide").textContent, /잠시 멈춰/);
  feed(app, sceneAt(0.117), 30); // 멈춤
  await tick();
  assert.ok(photoOpen(app), "멈췄는데 찍히지 않음");
});

test("과일을 찾은 뒤 크기를 재는 동안 촬영 거리(12cm)까지 다가오라는 안내", () => {
  const app = loadApp();
  startFakeAr(app);
  approachFrames(R, 40, 0.42, 0.22, 14, { noise: 8 }).slice(0, 3).forEach((scene) => feed(app, scene, 3));
  assert.match(app.el("ar-guide").textContent, /촬영 거리\(12cm\)까지/);
});

test("폰 확인 버그: 사진 가운데에 꼭지가 있어도 꼭지가 아니라 따라가던 과일로 거리를 잼", async () => {
  const app = measuredApp();
  app.el("screen-photo").hidden = true;
  app.el("btn-auto").click(); // 직접 촬영으로 꼭지가 보이는 순간을 찍는다
  approach(app, 0.2, 0.1);
  feed(app, sceneAt(0.1), 6);
  app.el("btn-capture").click();
  feed(app, { ...sceneAt(0.1), facingStem: 0.9 }, 1); // 카메라 쪽(사진 가운데)에 큰 꼭지
  await tick();
  assert.ok(photoOpen(app), "사진 화면이 열리지 않음");
  const d = app.run("photoResult && photoResult.distanceMm");
  assert.ok(d && Math.abs(d - 100) / 100 < 0.03, `사진 거리 ${d}mm (실제 100mm)`);
});

test("폰 확인 버그: 위에서 내려다보며 다가가도 꼭지가 아니라 과일 크기를 재고, 자동 촬영 거리도 맞음", async () => {
  const app = loadApp();
  startFakeAr(app);
  app.el("screen-photo").hidden = true;
  const top = (from, to, n) => approachFrames(R, 0, from, to, n, { noise: 8, stem: 0.95 });
  top(0.42, 0.22, 14).forEach((scene) => feed(app, scene, 3));
  const size = app.run("arResult && arResult.sizeMm");
  assert.ok(size && Math.abs(size - 70) / 70 < 0.03, `크기 ${size}mm (실제 70mm)`);
  for (let cm = 18; cm >= 10; cm--) feed(app, top((cm / 100) + R, (cm / 100) + R, 2)[0], 3);
  feed(app, top(0.1 + R, 0.1 + R, 2)[0], 40); // 멈춤 → 자동 촬영
  await tick();
  assert.ok(photoOpen(app), "자동 촬영되지 않음");
  const d = app.run("photoResult && photoResult.distanceMm");
  assert.ok(d && Math.abs(d - 100) / 100 < 0.03, `사진 거리 ${d}mm (실제 100mm)`);
});

test("12cm 밖에서는 멈춰 있어도 찍지 않음", async () => {
  const app = measuredApp();
  app.el("screen-photo").hidden = true;
  approach(app, 0.2, 0.16);
  feed(app, sceneAt(0.16), 30);
  await tick();
  assert.ok(!photoOpen(app), "12cm 밖에서 찍힘");
  assert.match(app.el("ar-distance").textContent, /안정됨/);
});

test("자동 촬영을 끄면 멈춰도 찍지 않고 「촬영하세요」, 직접 촬영은 됨", async () => {
  const app = measuredApp();
  app.el("screen-photo").hidden = true;
  app.el("btn-auto").click();
  assert.match(app.el("btn-auto").textContent, /끔/);
  approach(app, 0.2, 0.1);
  feed(app, sceneAt(0.1), 30);
  await tick();
  assert.ok(!photoOpen(app), "꺼져 있는데 찍힘");
  assert.match(app.el("ar-guide").textContent, /촬영하세요/);
  app.el("btn-capture").click();
  feed(app, sceneAt(0.1), 1);
  await tick();
  assert.ok(photoOpen(app), "직접 촬영이 안 됨");
});

test("다시 찍기로 돌아오면 바로 또 찍히지 않고, 잠시 뒤 다시 멈추면 찍힘", async () => {
  const app = measuredApp();
  app.el("screen-photo").hidden = true;
  approach(app, 0.2, 0.1);
  feed(app, sceneAt(0.1), 30);
  await tick();
  assert.ok(photoOpen(app), "처음 자동 촬영이 안 됨");
  app.el("btn-retake").click();
  feed(app, sceneAt(0.1), 30); // 약 0.5초
  await tick();
  assert.ok(!photoOpen(app), "돌아오자마자 또 찍힘");
  feed(app, sceneAt(0.1), 90); // 1.5초 뒤
  await tick();
  assert.ok(photoOpen(app), "기다린 뒤에도 찍히지 않음");
});

test("회귀: 크기를 잰 뒤 가까이서 촬영하면 사진에서 거리가 나오고, 저장하면 기록이 남고 다음 과일 찾기로 돌아감", async () => {
  const app = loadApp();
  startFakeAr(app);
  approachFrames(R, 40, 0.42, 0.22, 14, { noise: 8 }).forEach((scene) => feed(app, scene, 3));
  assert.strictEqual(app.el("ar-done").hidden, false, "크기가 정해지지 않음");
  const near = approachFrames(R, 40, 0.135, 0.135, 2, { noise: 8 })[0]; // 표면까지 약 10cm
  feed(app, near, 3);
  app.el("btn-capture").click();
  feed(app, near, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(app.el("screen-photo").hidden, false, "사진 화면이 열리지 않음");
  const m = near.pose;
  const truth = (Math.hypot(m[12] - near.center[0], m[13] - near.center[1], m[14] - near.center[2]) - R) * 1000;
  const d = app.run("photoResult && photoResult.distanceMm");
  assert.ok(d && Math.abs(d - truth) / truth < 0.03, `거리 ${d}mm, 실제 ${truth.toFixed(1)}mm`);
  app.el("btn-save").click();
  const records = JSON.parse(app.context.localStorage.getItem("fruit-measure-records"));
  assert.strictEqual(records.length, 1);
  assert.ok(Math.abs(records[0].sizeMm - 70) < 2 && Math.abs(records[0].distanceMm - truth) / truth < 0.03, JSON.stringify(records[0]));
  assert.ok(app.run("target === null && arResult === null"), "다음 과일을 처음부터 찾아야 함");
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log("ok  ", name);
    } catch (error) {
      failed++;
      console.log("FAIL", name, "\n     ", error.message);
    }
  }
  console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
  process.exit(failed ? 1 : 0);
})();
