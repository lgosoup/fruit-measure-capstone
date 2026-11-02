// 배포 페이지(브라우저)에서 실행하는 가짜 AR. 페이지 안에서 이 파일 내용을 그대로 실행한다
// 배포된 test/scene.js로 정답을 아는 과일 사진을 그려, 앱의 onXrFrame에 가짜 AR 프레임으로 넣는다
// 실행 뒤 window.fakeAr로 장면을 넣고 화면 상태를 읽는다:
//   await fakeAr.start()                         AR 화면을 띄우고 장면 함수를 불러온다
//   fakeAr.approach(0.42, 0.22, 14)              카메라~과일 중심 0.42m → 0.22m로 14장 다가간다(크기 확정용)
//   fakeAr.surface(10)                           표면까지 10cm 장면을 넣는다(거리 안내 확인용)
//   fakeAr.state()                               안내 문구, 거리 표시, 크기, 버튼 상태
(() => {
  const R = 0.035;      // 가짜 과일 반지름(m), 지름 70mm
  const TILT = 40;      // 수직에서 기운 각도(도)
  const FX = 480;       // 가짜 카메라 초점거리(px)
  let scene = null;

  // 가짜 카메라 사진은 이 브라우저 화면과 같은 비율로 만든다(다르면 둘레가 늘어나 보인다)
  const W = 480;
  const H = Math.round((480 * innerHeight) / innerWidth);
  const k = { fx: FX, fy: FX, cx: W / 2, cy: H / 2, width: W, height: H };
  const PROJECTION = [(2 * FX) / W, 0, 0, 0, 0, (2 * FX) / H, 0, 0, 0, 0, -1, -1, 0, 0, -0.02, 0];

  function inverseRigid(m) {
    const p = [m[12], m[13], m[14]];
    const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0];
    return [...r, -(r[0] * p[0] + r[4] * p[1] + r[8] * p[2]), -(r[1] * p[0] + r[5] * p[1] + r[9] * p[2]), -(r[2] * p[0] + r[6] * p[1] + r[10] * p[2]), 1];
  }

  function frame(opt, emulated) {
    const m = opt.pose;
    const view = {
      camera: { width: W, height: H, opt },
      transform: { position: { x: m[12], y: m[13], z: m[14] }, matrix: Float32Array.from(m), inverse: { matrix: inverseRigid(m) } },
      projectionMatrix: PROJECTION,
    };
    return { getViewerPose: () => ({ views: [view], emulatedPosition: emulated, transform: view.transform }) };
  }

  // 장면 하나를 n프레임 넣는다(앱은 3프레임마다 과일을 찾는다)
  function feed(opt, n = 3, emulated = false) {
    const fixed = { ...opt, width: W, height: H, k };
    for (let i = 0; i < n; i++) onXrFrame(i * 16, frame(fixed, emulated));
  }

  window.fakeAr = {
    async start() {
      const src = await (await fetch(`test/scene.js?x=${Math.random()}`)).text();
      const mod = { exports: {} };
      new Function("module", "require", src)(mod, () => ({ cameraDirToWorld, normalize, pixelToRay }));
      scene = mod.exports;
      xr = {
        session: { requestAnimationFrame() {}, renderState: { baseLayer: { framebuffer: null } }, end() {} },
        gl: { bindFramebuffer() {}, clearColor() {}, clear() {}, FRAMEBUFFER: 0, COLOR_BUFFER_BIT: 0 },
        refSpace: {},
      };
      // 앱은 카메라 이미지를 브라우저 ImageData로 받는다(사진 화면의 createImageBitmap이 이 형식만 받음)
      readCameraImage = (camera) => {
        const img = scene.render(camera.opt);
        return new ImageData(img.data, img.width, img.height);
      };
      homeScreen.hidden = true;
      arRoot.hidden = false;
      showArUi();
      resizeArCanvas();
      return this.state();
    },
    approach(from, to, n, extra = { noise: 8 }) {
      scene.approachFrames(R, TILT, from, to, n, extra).forEach((opt) => feed(opt));
      return this.state();
    },
    surface(cm, emulated = false, extra = { noise: 8 }) {
      const d = cm / 100 + R;
      feed(scene.approachFrames(R, TILT, d, d, 2, extra)[0], 3, emulated);
      return this.state();
    },
    state() {
      const text = (id) => document.getElementById(id) && document.getElementById(id).textContent;
      return {
        guide: text("ar-guide"),
        distance: arDistance && !arDistance.hidden ? text("ar-distance") : null,
        inside: arDistance ? arDistance.classList.contains("ar-distance-inside") : false,
        size: typeof arResult !== "undefined" && arResult ? arResult.sizeMm.toFixed(1) : null,
        done: !document.getElementById("ar-done").hidden,
        capture: !document.getElementById("btn-capture").hidden,
      };
    },
  };
})();
