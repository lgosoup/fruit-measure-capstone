# 캡스톤: 스마트폰 카메라 결합형 저비용 비파괴 당도 추정 기반 만감류 수확 적기 판정 보조기

만감류(한라봉·천혜향 등)에 근적외선을 비추고 과일 속을 거쳐 돌아온 빛을 멀티스펙트럼 센서로 재서, 자르지 않고 당도를 추정해 수확 시기를 판단하는 프로젝트입니다.

## 지금 있는 것

- **측정 거리·과일 크기 앱(fruit-measure)**: 폰 AR로 과일 크기(지름)를 재고, 카메라~과일 표면 거리를 실시간으로 안내해 12cm 안에서 자동 촬영합니다. 촬영 순간이 근적외선 측정 순간에 해당합니다.
  - 코드: `index.html`, `app.js`, `measure.js`, `detect.js`, `style.css`
  - 테스트: `node test/measure.test.js`, `node test/detect.test.js`, `node test/app-flow.test.js`
  - 개발용 스킬: `.claude/skills/fruit-test-scene`(계산식 테스트), `.claude/skills/pages-preview`(배포 페이지 검토)
