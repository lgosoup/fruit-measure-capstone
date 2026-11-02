---
name: pages-preview
description: fruit-measure를 push한 뒤 GitHub Pages 배포 페이지가 새 코드로 바뀌었는지 확인하고, PC 크롬에서 배포 페이지를 열어 가짜 AR 프레임(계산으로 그린 과일 사진)을 넣어 화면을 직접 검토한다. 「배포 페이지 확인」, 폰 없이 AR 화면 흐름을 눈으로 확인할 때 사용한다.
metadata:
  project: fruit-measure
---

# 배포 페이지 검토

이 앱은 폰의 AR(WebXR)이 있어야 측정 화면이 뜬다. PC에서는 첫 화면에 「AR 미지원」만 보이므로, 배포 페이지에 가짜 AR 프레임을 넣어 측정 화면을 띄우고 확인한다. 실제 카메라·AR 동작(초점, 위치 추적, 손떨림)은 확인할 수 없으니 [폰] 항목으로 사용자에게 맡긴다.

## 순서

1. **배포 반영 기다리기**: push 뒤 GitHub Pages가 바뀌는 데 1~2분 걸린다. 이번에 새로 넣은 함수 이름이 배포 파일에 보일 때까지 10초 간격으로 확인한다.
   ```
   for i in $(seq 1 15); do n=$(curl -s "https://lgosoup.github.io/fruit-measure/app.js?x=$RANDOM" | grep -c 새함수이름); [ "$n" -gt 0 ] && break; sleep 10; done
   ```
2. **배포 파일과 커밋 비교**: `index.html`, `app.js`, `measure.js`, `detect.js`, `style.css`를 받아 `git show HEAD:파일`과 같은지 본다(줄바꿈 `\r`은 지우고 비교). 다르면 배포가 아직이거나 캐시다.
3. **크롬으로 열기**: 브라우저 도구로 새 탭에 `https://lgosoup.github.io/fruit-measure/?r=단계번호`를 연다. 처음 화면이 「AR 미지원」이고 콘솔 오류가 없는지 본다.
   - 주소 뒤 쿼리는 페이지에만 붙어 **스크립트 캐시는 피하지 못한다.** 이번에 넣은 함수가 페이지에 있는지(`typeof 새함수이름`) 먼저 보고, 없으면 아래를 실행한 뒤 다시 확인한다(그냥 새로고침으로는 안 바뀐다).
     ```js
     await Promise.all(["measure.js", "detect.js", "app.js", "style.css", "index.html"].map((f) => fetch(f, { cache: "reload" })));
     location.reload();
     ```
4. **가짜 AR 넣기**: `scripts/fake-ar.js` 내용을 페이지에서 그대로 실행한 뒤, `window.fakeAr`로 장면을 넣는다.
   ```js
   await fakeAr.start();
   fakeAr.approach(0.42, 0.22, 14);   // 다가가며 크기 확정
   fakeAr.surface(16);                // 표면까지 16cm
   fakeAr.state();                    // 안내·거리·크기·버튼 상태
   ```
5. **캡처와 숫자 확인**: 확인할 상태마다 화면을 캡처하고(디스크에 저장), `state()` 숫자를 정답과 비교한다. 가짜 과일은 지름 70mm, `surface(cm)`의 정답 거리는 그 cm다.
6. **콘솔 오류 확인**: 오류만 골라 읽는다. 없으면 「콘솔 오류 없음」으로 보고한다.
7. **보고**: 확인한 상태와 숫자, 캡처 경로를 사용자에게 알린다. 탭은 닫는다.

## 예시

[예시] 16단계(12cm 안내) 검토

```js
await fakeAr.start();
fakeAr.approach(0.42, 0.22, 14);   // → { size: "69.1", done: true, ... }
for (let cm = 20; cm >= 16; cm--) fakeAr.surface(cm);
fakeAr.state();                    // → { distance: "표면까지 15.9 cm", guide: "촬영하려면 4cm 더 가까이 다가가 주세요", inside: false }
for (let cm = 15; cm >= 10; cm--) fakeAr.surface(cm);
fakeAr.state();                    // → { distance: "표면까지 9.9 cm", guide: "12cm 안에 들어왔습니다. 촬영하세요", inside: true }
```

보고 예: 「16cm에서 15.9cm와 『4cm 더 가까이』, 10cm에서 초록 9.9cm와 『12cm 안』. 콘솔 오류 없음」

## 자주 나오는 경우

- **브라우저 도구가 연결되지 않음**: 1~2번(배포 반영, 파일 비교)만 하고, 화면 확인은 못 했다고 보고한다. [AI 검토] 항목은 체크하지 않는다. 사용자에게 확장 연결을 부탁한다.
- **둘레가 옆으로 늘어난 타원으로 보임**: 가짜 카메라 비율이 화면과 다를 때 생긴다. `fake-ar.js`는 화면 비율에 맞춰 만든다. 직접 프레임을 만들었다면 비율을 맞춘다.
- **장면을 한 번에 크게 바꾸면 놓침으로 나옴**: 앱은 크기·위치가 갑자기 바뀌면 다른 물체로 본다. 거리는 1cm씩 단계적으로 바꾼다(`surface`를 반복 호출).
- **자동 촬영 뒤 사진 화면에서 `createImageBitmap` 오류**: 가짜 카메라 이미지가 브라우저 `ImageData`가 아니면 생긴다. `fake-ar.js`는 `ImageData`로 감싸 돌려준다.
- **안내 문구가 바뀌지 않음**: 「놓쳤습니다」 같은 잠깐 안내는 3초 동안 다른 안내를 덮는다. 이어서 확인하려면 `arNote = null`로 지운 뒤 다시 본다.
- **사용자 폰에서 예전 화면이 보임**: GitHub Pages는 파일을 10분 캐시한다. 배포 파일이 커밋과 같으면 폰에서 새로고침하거나 잠시 뒤 다시 열어 달라고 안내한다.
