"""당도 모델 테스트: python -X utf8 test/test_brix.py

정답은 model/sample_data.py가 모델 코드와 따로 계산한 값이다.
"""
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "model"))
import brix  # noqa: E402
import sample_data  # noqa: E402

passed = 0


def check(name, cond, detail=""):
    global passed
    if not cond:
        print(f"실패: {name} {detail}")
        sys.exit(1)
    passed += 1
    print(f"통과: {name} {detail}")


# 1. 잡음 없으면 반사율이 정답(거리 영향 포함한 겉보기 반사율)과 같다
df, truth = sample_data.make(20, noiseless=True)
for mode in ["noncontact", "contact"]:
    got = brix.reflectance(df[df["mode"] == mode]).sort_values(["fruit_id", "rep"])
    want = truth[truth["mode"] == mode].sort_values(["fruit_id", "rep"])
    cols = [f"r_{c}" for c in brix.CHANNELS]
    err = np.max(np.abs(got[cols].to_numpy() / want[cols].to_numpy() - 1))
    check(f"반사율 복원({mode})", err < 1e-9, f"최대 상대오차 {err:.1e}")

# 2. 주변광이 있어도 켠−끈 차감으로 사라진다(잡음만 끄고 주변광은 켠 데이터를 직접 만듦)
amb = df.copy()
on_cols = [f"on_{c}" for c in brix.CHANNELS]
off_cols = [f"off_{c}" for c in brix.CHANNELS]
amb[on_cols] = amb[on_cols].to_numpy() + 500.0
amb[off_cols] = amb[off_cols].to_numpy() + 500.0
a = brix.reflectance(amb[amb["mode"] == "contact"])[[f"r_{c}" for c in brix.CHANNELS]].to_numpy()
b = brix.reflectance(df[df["mode"] == "contact"])[[f"r_{c}" for c in brix.CHANNELS]].to_numpy()
check("주변광 차감", np.max(np.abs(a / b - 1)) < 1e-9)

# 3. 기준판이 없는 세션이면 멈춘다
try:
    brix.reflectance(df[(df["mode"] == "contact") & ~((df["kind"] == "white") & (df["session"] == "s1"))])
    check("기준판 없음 오류", False)
except ValueError as e:
    check("기준판 없음 오류", "s1" in str(e), str(e))

# 4. 교차검증 겹에서 같은 과일이 학습·평가에 동시에 들어가지 않는다
groups = np.repeat(np.arange(30), 3)
leak = any(set(groups[tr]) & set(groups[te]) for tr, te in brix._folds(groups, 5).split(groups, groups, groups))
check("과일 단위로 겹 나누기", not leak)

# 5. 내보낸 선형식 = PLS 예측
rng = np.random.default_rng(1)
X, y = rng.normal(size=(40, 8)), rng.normal(size=40)
m = brix._fit(X, y, 3)
icpt, coef = brix.linear_model(m, 8)
Xt = rng.normal(size=(10, 8)) * 5
check("선형식 내보내기", np.allclose(icpt + Xt @ coef, m.predict(Xt).ravel(), atol=1e-9))

# 6a. 잡음·껍질 차이가 없으면 정답을 거의 그대로 맞힌다(거리 50–120mm로 바뀌어도)
clean, _ = sample_data.make(200, seed=2, noiseless=True, skin_sd=0.0)
for mode in ["noncontact", "contact"]:
    model, _, _, _ = brix.train(clean, mode, "nir")
    cv = model["report"]["cv"]
    check(f"구조 검증({mode})", cv["rmse"] < 0.05, f"RMSE {cv['rmse']:.3f}")

# 6b. 잡음·껍질 차이가 있는 데이터: 당도를 의미 있게 맞히고, 비접촉도 거리 보정으로 접촉에 가깝다
df, _ = sample_data.make(200, seed=2)
spread = df[df["kind"] == "fruit"].groupby("fruit_id")["brix"].first().std()
res = {}
for mode in ["noncontact", "contact"]:
    model, pred, ids, yf = brix.train(df, mode, "nir")
    res[mode] = model["report"]["cv"]
    check(f"당도 추정({mode})", res[mode]["r2"] > 0.6,
          f"RMSE {res[mode]['rmse']:.2f} (Brix 표준편차 {spread:.2f}), R² {res[mode]['r2']:.2f}, 성분 {model['report']['components']}")
check("비접촉이 접촉의 1.15배 안", res["noncontact"]["rmse"] < 1.15 * res["contact"]["rmse"],
      f"{res['noncontact']['rmse']:.2f} / {res['contact']['rmse']:.2f}")

# 6c. 수집 계획(과일마다 5·8·11cm에서 한 번씩)으로 학습해도, 실제 사용처럼 한 번만 잰 값이
#     어느 거리에서든 치우치지 않는다. 반복을 평균해 학습하면 과일마다 평균 거리가 같아져 거리 영향을 못 배운다.
plan, _ = sample_data.make(400, seed=5, distances=sample_data.PLAN_DISTANCES)
field, _ = sample_data.make(200, seed=6, distances=sample_data.PLAN_DISTANCES)  # 학습에 없던 과일
single = {}
for mode in ["noncontact", "contact"]:
    m, _, _, _ = brix.train(plan, mode, "nir")
    out = brix.predict(m, field)
    single[mode] = out.assign(err=out["brix_pred"] - out["brix"])
nc_single = single["noncontact"]
# 평가용 과일 묶음 자체의 치우침(모든 거리에 똑같이 생김)은 빼고, 거리에 따라 달라지는지만 본다.
# 반복 평균 학습에서는 5·8·11cm 치우침이 +0.09 / −0.22 / −0.45로 0.54 벌어졌다.
bias_d = [nc_single.loc[nc_single["rep"] == rep, "err"].mean() for rep in [1, 2, 3]]
check("한 번 측정 치우침이 거리에 따라 같음(5·8·11cm)", max(bias_d) - min(bias_d) < 0.1,
      " / ".join(f"{b:+.2f}" for b in bias_d))
rmse1 = {k: float(np.sqrt(np.mean(v["err"] ** 2))) for k, v in single.items()}
check("한 번 측정 오차: 비접촉이 접촉의 1.1배 안", rmse1["noncontact"] < 1.1 * rmse1["contact"],
      f"{rmse1['noncontact']:.2f} / {rmse1['contact']:.2f}")

# 7. 거리·지름을 빼면 비접촉 오차가 커진다(보정 변수가 실제로 쓰인다)
orig = brix.EXTRA
brix.EXTRA = []
try:
    no_extra, _, _, _ = brix.train(df, "noncontact", "nir")
finally:
    brix.EXTRA = orig
check("거리·지름 보정 효과", no_extra["report"]["cv"]["rmse"] > res["noncontact"]["rmse"] * 1.2,
      f"빼면 {no_extra['report']['cv']['rmse']:.2f}, 넣으면 {res['noncontact']['rmse']:.2f}")

# 8. 스펙트럼이 당도와 무관하면 좋은 척하지 않는다(과적합·누수 검사)
null, _ = sample_data.make(200, seed=3, sugar_scale=0.0)
nm, _, _, _ = brix.train(null, "contact", "nir")
check("당도 정보 없으면 R²≈0", nm["report"]["cv"]["r2"] < 0.15, f"R² {nm['report']['cv']['r2']:.2f}")

# 9. 저장한 모델로 예측(JSON 왕복)
import json  # noqa: E402
model, _, _, _ = brix.train(df, "contact", "nir")
with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "m.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(model, f)
    with open(path, encoding="utf-8") as f:
        loaded = json.load(f)
out = brix.predict(loaded, df)
err = np.sqrt(np.mean((out["brix_pred"] - out["brix"]) ** 2))
check("저장 모델 예측", err < 0.6 * spread, f"RMSE {err:.2f}")

# 10. 과일 몇 개로 접촉/비접촉 비교: 접촉 조건이 좋으면 숫자로 드러난다
few, _ = sample_data.make(6, reps=5, seed=4)
cmp = brix.compare(few)
nc = cmp["noncontact"]["channels"]
ct = cmp["contact"]["channels"]
mean = lambda d, k: np.nanmean([d[c][k] for c in brix.NIR])  # noqa: E731
check("비교: 주변광 비율", mean(ct, "ambient") < mean(nc, "ambient"),
      f"접촉 {mean(ct, 'ambient'):.1%} / 비접촉 {mean(nc, 'ambient'):.1%}")
check("비교: 반복 흔들림", mean(ct, "repeat_pct") < mean(nc, "repeat_pct"),
      f"접촉 {mean(ct, 'repeat_pct'):.2f}% / 비접촉 {mean(nc, 'repeat_pct'):.2f}%")
check("비교: 과일 구분", mean(ct, "separation") > mean(nc, "separation"),
      f"접촉 {mean(ct, 'separation'):.1f} / 비접촉 {mean(nc, 'separation'):.1f}")

# 11. 비교는 거리 영향을 빼고 한다: 잡음 없는 비접촉은 반복할 때마다 거리가 50–120mm로 달라도 흔들림 ≈ 0
#     (모델이 거리로 보정하는 부분까지 흔들림으로 세면 비접촉이 무조건 진다)
calm, _ = sample_data.make(6, reps=5, seed=4, noiseless=True, modes=("noncontact",))
nc0 = brix.compare(calm)["noncontact"]["channels"]
check("비교: 거리 보정 후 흔들림(거리 0.1mm 반올림 기록 → 약 0.06%)", mean(nc0, "repeat_pct") < 0.1, f"{mean(nc0, 'repeat_pct'):.3f}%")
check("비교: 거리 보정 후 과일 구분", mean(nc0, "separation") > 100, f"{mean(nc0, 'separation'):.0f}")
check("비교: 거리 기울기(1/거리²이면 2)", abs(mean(nc0, "distance_slope") - 2) < 0.01, f"{mean(nc0, 'distance_slope'):.3f}")

print(f"\n모두 통과 ({passed}개)")
