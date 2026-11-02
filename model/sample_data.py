"""정답을 아는 가짜 측정 데이터. 모델 코드와 따로, 빛 → 과일 → 센서 과정을 계산해 센서 켠/끈 값을 만든다.

python -X utf8 model/sample_data.py 출력.csv [--fruits 200] [--seed 0]

가정(정답):
- 과일 흡광도 a(파장) = 기본값 + 당 계수·Brix + 크기 계수·지름 + 과일마다 다른 껍질 차이
- 비접촉: 기준판은 기준 거리(60mm)에서 재고, 과일은 거리 d에서 잼 → 돌아오는 빛 × (60/d)²
  주변광이 센서에 들어옴, 흔들림 큼
- 접촉: 거리 0(빛이 거리로 줄지 않음), 차광돼 주변광 거의 없음, 흔들림 작음
"""
import argparse

import numpy as np
import pandas as pd

CHANNELS = [410, 435, 460, 485, 510, 535, 560, 585, 610, 645, 680, 705, 730, 760, 810, 860, 900, 940]
REF_DISTANCE = 60.0  # 비접촉 기준판 거리(mm)

# 모드별 측정 조건
MODES = {
    "noncontact": {"ambient": 300.0, "noise_pct": 0.8, "dark_noise": 3.0, "distance": (50.0, 120.0)},
    "contact": {"ambient": 2.0, "noise_pct": 0.3, "dark_noise": 1.0, "distance": None},
}


def truth_absorbance(brix, diameter, skin, sugar_scale=1.0):
    """과일 하나의 실제 흡광도(채널별). sugar_scale=0이면 스펙트럼이 당도와 무관."""
    wl = np.array(CHANNELS, float)
    base = 0.4 + 0.3 * np.exp(-(wl - 410) / 120)            # 가시광 쪽은 껍질 색으로 많이 흡수
    sugar = sugar_scale * np.where(wl >= 730, 0.004 + 0.006 * (wl - 730) / 210, 0.001)  # 근적외선 쪽에서 당 영향
    size = 0.002 * (wl >= 730)                                # 클수록 빛이 더 줄어듦
    return base + sugar * brix + size * diameter + skin


def make(n_fruits=200, reps=3, seed=0, modes=("noncontact", "contact"), sugar_scale=1.0, noiseless=False, skin_sd=0.02):
    """반환: (측정 DataFrame, 정답 DataFrame[fruit_id, mode, rep, r_<파장>=실제 겉보기 반사율])."""
    rng = np.random.default_rng(seed)
    white = 20000.0 * (0.6 + 0.4 * np.sin(np.linspace(0.3, 2.8, len(CHANNELS))))  # 기준판 신호(광원×센서 응답)
    brix = rng.uniform(9.0, 16.0, n_fruits)
    diameter = rng.uniform(65.0, 95.0, n_fruits)
    skin = rng.normal(0, skin_sd, (n_fruits, len(CHANNELS)))      # 과일마다 껍질 차이(당도와 무관)

    rows, truth = [], []
    n_sessions = 4

    def noisy(x, cond):
        if noiseless:
            return x
        return x * (1 + rng.normal(0, cond["noise_pct"] / 100, x.shape)) + rng.normal(0, cond["dark_noise"], x.shape)

    for mode in modes:
        cond = MODES[mode]
        amb_scale = 0.0 if noiseless else 1.0
        for s in range(n_sessions):
            ambient = cond["ambient"] * amb_scale * (0.5 + 0.1 * s) * np.ones(len(CHANNELS))
            on = noisy(ambient + white, cond)
            off = noisy(ambient, cond)
            rows.append({"kind": "white", "session": f"s{s}", "mode": mode, "fruit_id": "", "rep": 0,
                         **{f"on_{c}": on[i] for i, c in enumerate(CHANNELS)},
                         **{f"off_{c}": off[i] for i, c in enumerate(CHANNELS)}})
        for f in range(n_fruits):
            s = f % n_sessions
            ambient = cond["ambient"] * amb_scale * (0.5 + 0.1 * s) * rng.uniform(0.8, 1.2) * np.ones(len(CHANNELS))
            a = truth_absorbance(brix[f], diameter[f], skin[f], sugar_scale)
            for r in range(reps):
                if cond["distance"]:
                    d = rng.uniform(*cond["distance"])
                    geom = (REF_DISTANCE / d) ** 2
                else:
                    d, geom = 0.0, 1.0
                r_app = 10 ** (-a) * geom
                on = noisy(ambient + white * r_app, cond)
                off = noisy(ambient, cond)
                rows.append({"kind": "fruit", "session": f"s{s}", "mode": mode, "fruit_id": f"F{f:03d}", "rep": r + 1,
                             "distance_mm": round(d, 1), "diameter_mm": round(diameter[f], 1), "brix": round(brix[f], 2),
                             **{f"on_{c}": on[i] for i, c in enumerate(CHANNELS)},
                             **{f"off_{c}": off[i] for i, c in enumerate(CHANNELS)}})
                truth.append({"fruit_id": f"F{f:03d}", "mode": mode, "rep": r + 1,
                              **{f"r_{c}": r_app[i] for i, c in enumerate(CHANNELS)}})
    return pd.DataFrame(rows), pd.DataFrame(truth)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("out")
    p.add_argument("--fruits", type=int, default=200)
    p.add_argument("--seed", type=int, default=0)
    a = p.parse_args()
    df, _ = make(a.fruits, seed=a.seed)
    df.to_csv(a.out, index=False, float_format="%.3f")
    print(f"저장: {a.out} ({len(df)}행)")
