"""만감류 당도(Brix) 추정 모델: 값 다듬기 → PLS 회귀 → 과일 단위 교차검증, 그리고 접촉/비접촉 신호 비교.

사용법 (python -X utf8 model/brix.py ...):
  train   데이터.csv [--mode noncontact] [--channels nir|all] [--out model.json]
  predict model.json 데이터.csv
  compare 데이터.csv

데이터 형식은 README의 「측정 데이터 형식」 참고.
"""
import argparse
import json
import sys

import numpy as np
import pandas as pd
from sklearn.cross_decomposition import PLSRegression
from sklearn.model_selection import GroupKFold

# AS7265x 18채널(nm), 파장 순서. SparkFun 라이브러리 글자: A410 B435 C460 D485 E510 F535 G560 H585
# R610 I645 S680 J705 T730 U760 V810 W860 K900 L940
CHANNELS = [410, 435, 460, 485, 510, 535, 560, 585, 610, 645, 680, 705, 730, 760, 810, 860, 900, 940]
NIR = [730, 760, 810, 860, 900, 940]
EXTRA = ["distance_mm", "diameter_mm"]  # 보정 변수(측정 앱 값)
MIN_REFLECTANCE = 1e-4  # 신호가 0 이하로 나와도 log가 터지지 않게


def channel_list(name):
    return NIR if name == "nir" else CHANNELS


# ---------- 값 다듬기 ----------

def reflectance(df, channels=CHANNELS):
    """과일 행마다 반사율 = (켠 값 − 끈 값) / (같은 세션·방식 기준판의 켠 값 − 끈 값).

    반환: 과일 행만 남긴 DataFrame(원래 열 + r_<파장> 열).
    """
    on = [f"on_{c}" for c in channels]
    off = [f"off_{c}" for c in channels]
    white = df[df["kind"] == "white"]
    fruit = df[df["kind"] == "fruit"].copy()
    if fruit.empty:
        raise ValueError("kind=fruit 행이 없습니다")

    white_net = {}
    for key, g in white.groupby(["session", "mode"]):
        net = (g[on].to_numpy(float) - g[off].to_numpy(float)).mean(axis=0)
        if np.any(net <= 0):
            raise ValueError(f"기준판 신호가 0 이하인 채널이 있습니다: 세션 {key}")
        white_net[key] = net

    rows = []
    for key in zip(fruit["session"], fruit["mode"]):
        if key not in white_net:
            raise ValueError(f"기준판 측정이 없습니다: 세션 {key[0]}, 방식 {key[1]}")
        rows.append(white_net[key])
    fruit_net = fruit[on].to_numpy(float) - fruit[off].to_numpy(float)
    r = fruit_net / np.array(rows)
    for i, c in enumerate(channels):
        fruit[f"r_{c}"] = r[:, i]
    return fruit


def features(fruit, channels):
    """모델 입력: 채널별 흡광도 log10(1/반사율) + log10(거리) + 지름.

    거리는 빛을 곱셈으로 줄이므로(대략 1/거리²) 흡광도에서는 log10(거리)에 비례하는 덧셈이 된다.
    거리를 그대로 넣으면 가짜 데이터에서 비접촉 오차가 1.5배로 커졌다. 접촉(거리 0)은 1mm로 잘라 상수가 된다.
    """
    r = fruit[[f"r_{c}" for c in channels]].to_numpy(float)
    a = -np.log10(np.clip(r, MIN_REFLECTANCE, None))
    extra = []
    for col in EXTRA:
        v = fruit[col].to_numpy(float)
        extra.append(np.log10(np.clip(v, 1.0, None)) if col == "distance_mm" else v)
    return np.column_stack([a] + extra) if extra else a


def feature_names(channels):
    return [f"a_{c}" for c in channels] + ["log10_distance_mm" if c == "distance_mm" else c for c in EXTRA]


# ---------- 학습·평가 ----------

def _folds(groups, k):
    n_groups = len(np.unique(groups))
    return GroupKFold(n_splits=min(k, n_groups))


def _max_components(n_rows, n_features):
    return max(1, min(10, n_features, n_rows - 2))


def _fit(X, y, n_comp):
    m = PLSRegression(n_components=n_comp, scale=True)
    m.fit(X, y)
    return m


def choose_components(X, y, groups, k=5):
    """과일 단위 교차검증 오차가 가장 작은 성분 수. 반환: (성분 수, 성분 수별 RMSE 목록)."""
    folds = list(_folds(groups, k).split(X, y, groups))
    top = _max_components(min(len(tr) for tr, _ in folds), X.shape[1])
    rmses = []
    for n in range(1, top + 1):
        pred = np.empty_like(y)
        for tr, te in folds:
            pred[te] = _fit(X[tr], y[tr], n).predict(X[te]).ravel()
        rmses.append(float(np.sqrt(np.mean((pred - y) ** 2))))
    return int(np.argmin(rmses)) + 1, rmses


def nested_cv_predictions(X, y, groups, k=5):
    """바깥 겹마다 안쪽 교차검증으로 성분 수를 고른 예측값. 같은 과일은 학습·평가에 동시에 들어가지 않는다."""
    pred = np.empty_like(y)
    chosen = []
    for tr, te in _folds(groups, k).split(X, y, groups):
        n, _ = choose_components(X[tr], y[tr], groups[tr], k)
        chosen.append(n)
        pred[te] = _fit(X[tr], y[tr], n).predict(X[te]).ravel()
    return pred, chosen


def scores(y, pred):
    err = pred - y
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    return {
        "rmse": float(np.sqrt(np.mean(err ** 2))),
        "bias": float(np.mean(err)),
        "r2": float(1 - np.sum(err ** 2) / ss_tot) if ss_tot > 0 else float("nan"),
    }


def linear_model(m, n_features):
    """학습된 PLS를 「Brix = 절편 + Σ 계수·입력」으로 바꾼다(PLS 예측은 입력에 대해 선형)."""
    zero = np.zeros((1, n_features))
    intercept = float(m.predict(zero).ravel()[0])
    coef = m.predict(np.eye(n_features)).ravel() - intercept
    return intercept, coef


def fruit_level(fruit, X):
    """같은 과일의 반복 측정을 평균해 과일 하나 = 한 행으로."""
    ids = fruit["fruit_id"].astype(str).to_numpy()
    uniq = list(dict.fromkeys(ids))
    Xf = np.array([X[ids == u].mean(axis=0) for u in uniq])
    yf = np.array([fruit["brix"].to_numpy(float)[ids == u].mean() for u in uniq])
    return np.array(uniq), Xf, yf


def train(df, mode, channels_name="nir", k=5):
    channels = channel_list(channels_name)
    fruit = reflectance(df[df["mode"] == mode], channels)
    fruit = fruit[fruit["brix"].notna()]
    X = features(fruit, channels)
    ids, Xf, yf = fruit_level(fruit, X)
    if len(ids) < 4:
        raise ValueError(f"Brix가 있는 과일이 {len(ids)}개뿐입니다(최소 4개)")

    pred, chosen = nested_cv_predictions(Xf, yf, ids, k)
    n_comp, curve = choose_components(Xf, yf, ids, k)
    m = _fit(Xf, yf, n_comp)
    intercept, coef = linear_model(m, Xf.shape[1])
    report = {
        "fruits": int(len(ids)),
        "brix_range": [float(yf.min()), float(yf.max())],
        "cv": scores(yf, pred),
        "cv_components": chosen,
        "components": n_comp,
        "rmse_by_components": curve,
    }
    model = {
        "mode": mode,
        "channels": channels,
        "inputs": feature_names(channels),
        "preprocess": "reflectance=(on-off)/(white_on-white_off); a=-log10(max(reflectance,1e-4)); log10_distance_mm=log10(max(distance_mm,1))",
        "intercept": intercept,
        "coef": coef.tolist(),
        "report": report,
    }
    return model, pred, ids, yf


def predict(model, df):
    channels = model["channels"]
    fruit = reflectance(df[df["mode"] == model["mode"]], channels)
    X = features(fruit, channels)
    fruit["brix_pred"] = model["intercept"] + X @ np.array(model["coef"])
    return fruit


# ---------- 접촉 / 비접촉 비교 ----------

def compare(df, channels=CHANNELS):
    """방식별·채널별 신호 품질. 과일이 몇 개뿐일 때 당도 모델 대신 보는 값.

    흡광도 a = log10(1/반사율)에서 거리 영향(같은 과일 안에서 a와 log10 거리의 기울기)을 빼고 계산한다.
    모델이 거리로 보정하는 부분까지 흔들림으로 세면 비접촉이 무조건 불리해지기 때문.

    signal          켠 값 − 끈 값 중앙값(신호 세기)
    ambient         끈 값 / 켠 값 중앙값(주변광 비율, 낮을수록 좋음)
    distance_slope  a가 log10 거리 1당 늘어나는 정도(1/거리²이면 2, 접촉은 0)
    repeat_pct      같은 과일 반복 측정의 흔들림, 반사율 %로 환산(낮을수록 좋음)
    separation      과일 사이 차이 / 반복 흔들림(높을수록 과일끼리 구분됨, 1 이하면 구분 못 함)
    brix_r          과일 평균 흡광도와 Brix의 상관(과일 5개 이상일 때만)
    """
    out = {}
    for mode, g in df.groupby("mode"):
        fruit = reflectance(g, channels)
        ids = fruit["fruit_id"].astype(str).to_numpy()
        uniq = list(dict.fromkeys(ids))
        logd = np.log10(np.clip(fruit["distance_mm"].fillna(0).to_numpy(float), 1.0, None))
        dl = logd - np.array([logd[ids == u].mean() for u in ids])  # 같은 과일 안에서의 거리 차이
        has_reps = any((ids == u).sum() > 1 for u in uniq)
        res = {"fruits": len(uniq), "rows": int(len(fruit)), "channels": {}}
        brix = fruit["brix"].groupby(ids).mean().dropna()
        for c in channels:
            on, off = fruit[f"on_{c}"].astype(float), fruit[f"off_{c}"].astype(float)
            a = -np.log10(np.clip(fruit[f"r_{c}"].to_numpy(float), MIN_REFLECTANCE, None))
            da = a - np.array([a[ids == u].mean() for u in ids])
            slope = float(np.sum(da * dl) / np.sum(dl ** 2)) if np.sum(dl ** 2) > 1e-12 else 0.0
            ac = a - slope * (logd - logd.mean())  # 모두 같은 거리에서 잰 것처럼
            means = np.array([ac[ids == u].mean() for u in uniq])
            resid = ac - np.array([ac[ids == u].mean() for u in ids])
            dof = len(ac) - len(uniq) - (1 if slope else 0)
            within = float(np.sqrt(np.sum(resid ** 2) / dof)) if has_reps and dof > 0 else float("nan")
            item = {
                "signal": float(np.median(on - off)),
                "ambient": float(np.median(off / on.where(on > 0))),
                "distance_slope": slope,
                "repeat_pct": within * np.log(10) * 100,
                "separation": float(means.std(ddof=1) / within) if len(uniq) > 1 and within > 0 else float("nan"),
                "brix_r": float("nan"),
            }
            if len(brix) >= 5:
                m = dict(zip(uniq, means))
                item["brix_r"] = float(np.corrcoef([m[u] for u in brix.index], brix.to_numpy())[0, 1])
            res["channels"][c] = item
        out[mode] = res
    return out


# ---------- 명령줄 ----------

def load(path):
    df = pd.read_csv(path)
    for col in ["kind", "session", "mode", "fruit_id"]:
        if col not in df:
            raise ValueError(f"열이 없습니다: {col}")
    for col in EXTRA + ["brix"]:
        if col not in df:
            df[col] = np.nan
    if "rep" not in df:
        df["rep"] = 1
    df["session"] = df["session"].astype(str)
    return df


def _print_train(model):
    r = model["report"]
    print(f"방식 {model['mode']}, 채널 {len(model['channels'])}개, 과일 {r['fruits']}개, "
          f"Brix {r['brix_range'][0]:.1f}–{r['brix_range'][1]:.1f}")
    cv = r["cv"]
    print(f"교차검증(과일 단위, 성분 수도 안쪽에서 고름): 오차 RMSE {cv['rmse']:.2f} °Brix, "
          f"치우침 {cv['bias']:+.2f}, R² {cv['r2']:.2f}")
    print(f"최종 모델 성분 수 {r['components']} (겹별 선택 {r['cv_components']})")
    if r["fruits"] < 30:
        print("주의: 과일이 30개 미만이라 이 오차는 믿기 어렵습니다. 신호 비교(compare)를 보세요.")


def _print_compare(res, channels):
    for mode, m in res.items():
        print(f"\n[{mode}] 과일 {m['fruits']}개, 측정 {m['rows']}회")
        print(" 파장   신호      주변광  거리기울기  반복흔들림  과일구분  Brix상관")
        for c in channels:
            x = m["channels"][c]
            print(f" {c:>4} {x['signal']:>9.1f} {x['ambient']:>8.1%} {x['distance_slope']:>9.2f} "
                  f"{x['repeat_pct']:>9.2f}% {x['separation']:>8.2f} {x['brix_r']:>8.2f}")
        nir = [m["channels"][c] for c in NIR if c in m["channels"]]
        if nir:
            print(f" 근적외선 평균: 신호 {np.mean([x['signal'] for x in nir]):.1f}, "
                  f"주변광 {np.mean([x['ambient'] for x in nir]):.1%}, "
                  f"반복흔들림 {np.nanmean([x['repeat_pct'] for x in nir]):.2f}%, "
                  f"과일구분 {np.nanmean([x['separation'] for x in nir]):.2f}")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("csv")
    t.add_argument("--mode", default="noncontact")
    t.add_argument("--channels", choices=["nir", "all"], default="nir")
    t.add_argument("--out", default="model.json")
    pr = sub.add_parser("predict")
    pr.add_argument("model")
    pr.add_argument("csv")
    c = sub.add_parser("compare")
    c.add_argument("csv")
    a = p.parse_args(argv)

    if a.cmd == "train":
        model, _, _, _ = train(load(a.csv), a.mode, a.channels)
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(model, f, ensure_ascii=False, indent=1)
        _print_train(model)
        print(f"저장: {a.out}")
    elif a.cmd == "predict":
        with open(a.model, encoding="utf-8") as f:
            model = json.load(f)
        out = predict(model, load(a.csv))
        out[["fruit_id", "rep", "brix_pred", "brix"]].to_csv(sys.stdout, index=False, float_format="%.2f")
    else:
        _print_compare(compare(load(a.csv)), CHANNELS)


if __name__ == "__main__":
    main()
