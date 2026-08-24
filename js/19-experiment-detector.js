/* ============================================================================
 * HC-Analyzer  ·  19-experiment-detector.js   (v2.8.0)
 * 역할: 실험 종류(rate / cycle) 자동 판별 + 수동 지정 전담 모듈
 *
 * [주의] 클래식 스크립트 방식입니다. index.html 에서 반드시 13-charts.js 와
 *        18-cyclability.js 보다 먼저 로드되어야 합니다.
 *
 * [설계 원칙]
 *  1. 판별은 "피팅(분석·차트 렌더) 전에" 수행된다.
 *     → runAnalysis() 맨 앞에서 classifyDisplayDatasets() 를 호출해
 *       표시 대상 데이터셋 전부를 일괄 판별·캐시한 뒤 피팅이 시작된다.
 *  2. 데이터가 몇 개든 데이터셋 단위로 각각 판별한다.
 *     - rate  로 판별 → Rate Capability 차트 전용
 *     - cycle 로 판별 → Cyclability 차트 전용
 *  3. 판별 기준 (v2.8.0 — 전류 기반 + 용량 "저점 반등" 보조 판별):
 *     [수동 지정 최우선] 데이터셋에 kindManual 플래그가 있으면 experimentType
 *           ("rate" / "cycle_performance") 를 그대로 따른다.
 *           (사이드바 라이브러리의 RATE/CYCLE 선택박스 — 09-dataset-library.js)
 *     [1차 자동] 사이클별 대표 전류(|전류| 중앙값)를 묶어 "전류 레벨" 개수를 센다.
 *           rate 시험은 사이클 그룹마다 전류를 계단식으로 바꾸고,
 *           cycle 시험은 전 구간 동일 전류이므로 사이클 수와 무관하게 구분된다.
 *           - 레벨 ≥ 3  → rate  (다단계 율속 시험)
 *           - 레벨 ≤ 2  → cycle (단일 율속, 또는 형성 사이클 + 본 사이클.
 *                         형성 구간 길이는 데이터마다 달라 레벨 2개까지 cycle 로 본다)
 *     [2차 자동] 전류 정보가 없거나 신뢰 불가할 때(원본 파일에 전류 컬럼이
 *           없는 경우 등) → 용량 곡선의 "저점 반등" 패턴을 보조 신호로 사용한다
 *           (detectRateRecoveryPattern). rate capability 시험은 마지막에
 *           저율속으로 되돌아가 "열화되지 않았는지" 확인하는 구성이 표준이며,
 *           이는 cycle 수명 데이터에서는 물리적으로 나올 수 없는 신호다 —
 *           진짜 열화는 스스로 되돌아오지 않는다. "초반 대비 몇 %까지
 *           돌아왔는가" 같은 절대 기준 대신 "저점에서 이 데이터의 노이즈
 *           수준을 훨씬 웃도는 확실한 반등이 있었는가"라는 상대적 기준을
 *           쓴다 — 시료에 따라 저점에서 초반 수준까지 다 돌아오지 않고
 *           50~60% 선에서 반등이 끝나는 rate 데이터도 있기 때문이다. 다음
 *           세 조건을 모두 만족해야만 rate 로 판정한다:
 *             ① 초반(중앙값)보다 중간에 20% 이상 뚜렷하게 낮아진 지점이 있음
 *             ② 그 최저점 대비 후반(중앙값)이 "노이즈 중앙값의 8배(최소 15%)"
 *                를 넘는 폭으로 반등함 — 노이즈가 큰 데이터는 문턱도 자동으로
 *                커지므로, cycle 데이터의 말미 미세한 uptick(노이즈 수준의
 *                변동)은 이 문턱을 넘지 못하고, 반등 폭이 크기만 하면 반등
 *                후 수준이 초반보다 한참 낮아도 rate 로 잡힌다
 *             ③ 그 후반 반등 구간 자체가 안정적임(구간 내 변동폭 15% 이하 —
 *                자동 사이클 분리 과정에서 생기는 1회성 이상치에 속지 않기 위함)
 *           초반·최저·후반 대표값은 평균이 아닌 "중앙값"으로 계산해, 자동
 *           사이클 분리 알고리즘이 만들어내는 이상치(글리치) 1~2개에 흔들리지
 *           않도록 한다. 세 조건 중 하나라도 애매하면 rate 로 넘기지 않고
 *           3차 폴백에 맡긴다 — "cycle 을 rate 로 오판"하는 쪽보다 "판단을
 *           보류"하는 쪽이 항상 안전하다는 원칙. (참고: 최종 반등 구간 없이
 *           율속만 계속 올리는 편도 rate 시험은 이 보조 신호로 못 잡아내며
 *           3차 폴백에 맡겨진다 — 전류 컬럼이 있는 파일이면 1차에서 이미
 *           정확히 잡힌다.)
 *     [3차 폴백] 위 두 판별이 모두 불확실하면 기존 규칙 사용:
 *           총 사이클 수 > 50 → cycle, 50 이하 → rate. (CYCLE_THRESHOLD)
 *           전류 신뢰 불가 조건: 전류 결측 사이클이 20% 초과, 유효 사이클 < 4,
 *           또는 전 사이클 대표 전류가 정확히 1.0 (= 파서가 사이클 자동 분리
 *           시 채워 넣는 가상 전류 ±1.0 → 실제 전류가 아님).
 *  4. 자동 판별 결과는 ds.experimentType 에 동기화한다 ("rate"/"cycle_performance").
 *     → 라이브러리 테이블 Type 컬럼·사이드바 필터 칩(Rate/Cycle)과 자동 연동.
 *     수동 지정(kindManual)된 데이터셋은 동기화하지 않는다.
 *
 * [전역 API]  window.ExperimentDetector
 *  - seriesFromProcessed(pc)      : processedCycles → [{x,y,ce,i}] 시계열
 *  - detect(pc, cacheKey)         : 자동 판별 실행 → {kind:'rate'|'cycle', reason, main, ...}
 *  - getEffectiveKind(ds)         : 수동 지정 반영한 최종 종류 → 'rate'|'cycle'|null
 *  - getDisplayDatasets()         : 표시 대상 데이터셋 (비교 체크 ≥2개면 체크된 것, 아니면 활성 1개)
 *  - classifyDisplayDatasets()    : 표시 대상 전부 일괄 판별 → [{ds, det}] (수동 지정 반영)
 *  - isCycleKind(ds) / isRateKind(ds) : 데이터셋 1개의 종류 질의 (수동 지정 반영)
 *  (하위 호환: window.isCycleKindDataset, window.classifyDisplayDatasets 도 노출)
 * ============================================================================ */

(function () {
    "use strict";

    const _cache = {};   // 데이터셋 id → { n: 유효 사이클 수, det: 자동 판정 결과 }

    // ==================================================================
    // 사이클 1개의 대표 전류 = 충·방전 포인트 |전류| 의 중앙값
    //   탈소듐화(충전) 구간 우선, 없으면 소듐화 구간 사용.
    //   CC-CV 등으로 사이클 내 전류가 변해도 중앙값이면 CC 구간 값이 잡힌다.
    // ==================================================================
    function medianAbsCurrent(cycle) {
        const pts = (cycle.desodiation && cycle.desodiation.length) ? cycle.desodiation
                  : (cycle.sodiation && cycle.sodiation.length) ? cycle.sodiation : null;
        if (!pts) return null;
        const abs = [];
        for (let k = 0; k < pts.length; k++) {
            const v = Math.abs(pts[k].current);
            if (isFinite(v) && v > 0) abs.push(v);
        }
        if (!abs.length) return null;
        abs.sort((a, b) => a - b);
        return abs[Math.floor(abs.length / 2)];
    }

    // ==================================================================
    // 데이터 추출: processedCycles 객체 → [{x: 사이클번호, y: 용량, ce: 쿨롱효율, i: 대표전류}]
    //   y = 탈소듐화(desodiation, 충전) 용량 = 가역 용량.
    //   음극 반쪽전지 수명 그래프의 표준이며, 측정 SW(스마트인터페이스)가
    //   내보내는 사이클별 용량 값과 일치한다. (소듐화 용량은 CE만큼 커서
    //   실제 값과 ~0.1% 어긋났음.) 탈소듐화가 없는 사이클만 소듐화로 대체.
    //   i = 사이클 대표 전류(mA). 전류 정보가 없으면 null.
    // ==================================================================
    function seriesFromProcessed(pc) {
        if (!pc) return [];
        const nums = Object.keys(pc).map(Number).sort((a, b) => a - b);
        const pts = [];
        nums.forEach(cn => {
            const c = pc[cn];
            if (!c) return;
            const dis = (typeof c.totalDischargeCap === "number" && c.totalDischargeCap > 0) ? c.totalDischargeCap : null;
            const cha = (typeof c.totalChargeCap === "number" && c.totalChargeCap > 0) ? c.totalChargeCap : null;
            const y = (cha != null) ? cha : dis;
            if (y == null) return;
            const ce = (cha != null && dis != null) ? (cha / dis) * 100 : null;
            pts.push({ x: cn, y: y, ce: ce, i: medianAbsCurrent(c) });
        });
        return pts;
    }

    // ==================================================================
    // 구간 분석: 율속이 바뀌면 용량이 계단처럼 급변한다는 성질 이용
    //   - segments   : 같은 율속으로 묶인 구간들
    //   - main       : 가장 긴 단일 구간
    //   - recoveries : 용량이 "다시 올라간" 횟수 (= 초기 율속 복귀 = rate 시험의 강한 신호)
    // ==================================================================
    function analyzeSeries(points) {
        const n = points.length;
        if (n < 4) {
            return { segments: [{ start: 0, end: n - 1 }], main: { start: 0, end: n - 1 }, recoveries: 0 };
        }

        const rel = [];   // 부호를 유지한 상대 변화율
        for (let i = 1; i < n; i++) {
            const prev = Math.abs(points[i - 1].y) || 1e-9;
            rel.push((points[i].y - points[i - 1].y) / prev);
        }

        // 임계값: 노이즈 중앙값의 4배, 최소 4%
        //   (8%로 하면 0.1C→0.2C 같은 작은 단차를 놓쳐 rate 시험을 cycle 로 오판)
        const absSorted = rel.map(Math.abs).sort((a, b) => a - b);
        const median = absSorted[Math.floor(absSorted.length / 2)] || 0;
        const threshold = Math.max(0.04, median * 4);

        const starts = [0];
        let recoveries = 0;
        for (let i = 1; i < n; i++) {
            const d = rel[i - 1];
            if (Math.abs(d) > threshold) {
                starts.push(i);
                if (d > threshold) recoveries++;   // 상승 = 낮은 율속으로 복귀
            }
        }
        starts.push(n);

        const segments = [];
        for (let k = 0; k < starts.length - 1; k++) {
            segments.push({ start: starts[k], end: starts[k + 1] - 1 });
        }
        let main = segments[0];
        segments.forEach(s => {
            if ((s.end - s.start) > (main.end - main.start)) main = s;
        });

        return { segments, main, recoveries };
    }

    // ==================================================================
    // 전류 기반 판별
    //   같은 율속이면 사이클 간 대표 전류가 거의 같고(<수 %), 율속이 바뀌면
    //   최소 1.5~2배 차이가 나므로 상대 오차 25% 이내를 "같은 레벨"로 본다.
    // ==================================================================
    const LEVEL_TOL = 0.25;          // 같은 전류 레벨로 볼 상대 오차
    const MIN_VALID_RATIO = 0.8;     // 전류가 있는 사이클 비율 하한
    const MIN_VALID_CYCLES = 4;      // 전류가 있는 사이클 수 하한
    const MIN_RUN_LEN = 2;           // 율속 구간으로 인정할 최소 사이클 수 (1사이클 스파이크 = 노이즈)

    function sameLevel(a, b) {
        return Math.abs(a - b) <= Math.max(a, b) * LEVEL_TOL;
    }

    function fmtCurrent(v) {
        if (v >= 10) return v.toFixed(1);
        if (v >= 1) return v.toFixed(2);
        return v.toFixed(3);
    }

    // 사이클 대표 전류 수열 → {kind, reason, levelValues} / 신뢰 불가 시 null
    function analyzeCurrents(points) {
        const n = points.length;
        const seq = [];
        for (let k = 0; k < n; k++) {
            if (points[k].i != null) seq.push(points[k].i);
        }
        if (seq.length < MIN_VALID_CYCLES || seq.length < n * MIN_VALID_RATIO) return null;

        // 파서의 가상 전류(±1.0) 감지: 전 사이클 대표 전류가 정확히 1.0 이면
        // 실측 전류가 아니므로 판별에 쓰지 않는다.
        if (seq.every(v => v === 1)) return null;

        // 1) 사이클 순서대로 "같은 레벨 연속 구간(run)" 으로 묶는다
        const runs = [];
        seq.forEach(v => {
            const last = runs[runs.length - 1];
            if (last && sameLevel(last.level, v)) {
                last.sum += v;
                last.count++;
                last.level = last.sum / last.count;
            } else {
                runs.push({ level: v, sum: v, count: 1 });
            }
        });

        // 2) 1사이클짜리 스파이크 run 제거 후, 인접한 같은 레벨 run 병합
        const merged = [];
        runs.filter(r => r.count >= MIN_RUN_LEN).forEach(r => {
            const last = merged[merged.length - 1];
            if (last && sameLevel(last.level, r.level)) {
                last.sum += r.sum;
                last.count += r.count;
                last.level = last.sum / last.count;
            } else {
                merged.push({ level: r.level, sum: r.sum, count: r.count });
            }
        });
        if (!merged.length) return null;   // 전류가 지나치게 널뛰면 신뢰 불가

        // 3) run 들을 값 기준으로 묶어 "서로 다른 전류 레벨" 목록을 만든다
        const levels = [];
        merged.forEach(r => {
            const hit = levels.find(L => sameLevel(L.value, r.level));
            if (hit) {
                hit.value = (hit.value * hit.count + r.level * r.count) / (hit.count + r.count);
                hit.count += r.count;
            } else {
                levels.push({ value: r.level, count: r.count });
            }
        });
        const L = levels.length;
        const levelValues = levels.map(l => l.value).sort((a, b) => a - b);
        const lvlStr = levelValues.map(fmtCurrent).join(" / ");

        // [판별 규칙] 레벨 ≥ 3 → rate / 레벨 ≤ 2 → cycle
        //   형성(formation) 구간 길이는 데이터마다 달라(3·5·10사이클 등) 레벨 2개까지는
        //   "형성 + 본 사이클" 구성의 cycle 데이터로 본다.
        if (L >= 3) {
            return { kind: "rate", reason: `전류 레벨 ${L}개 감지(${lvlStr} mA) → Rate Capability`, levelValues };
        }
        if (L === 2) {
            return { kind: "cycle", reason: `전류 레벨 2개(${lvlStr} mA) — 형성+본 사이클로 판단 → Cyclability`, levelValues };
        }
        return { kind: "cycle", reason: `단일 전류 레벨(${lvlStr} mA) → Cyclability`, levelValues };
    }

    // ==================================================================
    // 용량 "저점 반등" 패턴 기반 보조 판별 — 전류 정보가 없을 때만 사용
    //
    //   [핵심 원칙] "확실한 반등 패턴"일 때만 rate 를 반환하고, 조금이라도
    //   애매하면 null 을 반환해 3차 폴백(사이클 수 기준)에 넘긴다 — cycle 을
    //   rate 로 오판하는 쪽보다 "판단을 보류"하는 쪽이 항상 안전하다.
    //
    //   [왜 "초반의 몇 %" 같은 절대 기준을 쓰지 않는가]
    //   rate capability 시험은 마지막에 저율속으로 되돌아가 "셀이 손상되지
    //   않았는지" 확인하는 구성이 표준이지만, 복귀 후 용량이 반드시 초반
    //   수준(예: 85%)까지 올라온다는 보장은 없다 — 시료에 따라 저점에서
    //   50~60% 정도만 반등하고 끝나는 경우도 흔하다. "초반 대비 X%"라는
    //   절대 기준은 그런 데이터를 rate 로 못 잡으므로, 대신 "저점에서 확실히
    //   반등해 안정됐는가"라는 상대적 구조를 본다 — 반등 폭이 이 데이터
    //   자체의 사이클간 노이즈 수준보다 훨씬 커야만 "진짜 반등"으로 인정한다
    //   (노이즈가 큰 데이터는 문턱도 자동으로 커지고, 깨끗한 데이터는 작은
    //   반등도 놓치지 않는다). 이러면 cycle 수명 데이터의 말미 미세한 uptick
    //   (노이즈 수준의 변동)은 절대 이 문턱을 못 넘고, 저점 대비 확실한
    //   반등만 rate 로 잡힌다.
    //
    //   [자동 사이클 분리 글리치 대응]
    //   원본 파일에 사이클/전류 컬럼이 없어 자동으로 사이클을 나눌 때, 파형
    //   경계에서 이상치(예: 값이 순간적으로 0 근처로 튀었다가 반동으로 크게
    //   튀는 1~2개 사이클)가 섞여 들어올 수 있다. 초반·최저·후반 대표값을
    //   평균이 아닌 "중앙값"으로 계산해 이런 1회성 이상치 한두 개에 흔들리지
    //   않게 한다.
    //
    //   [판정 조건 — 셋 다 만족해야 rate]
    //     ① dropRatio ≥20% : 초반 대비 중간에 뚜렷하게 낮아진 지점이 있었다
    //        (반등을 논하려면 먼저 진짜 하락이 있어야 한다)
    //     ② stepRatio ≥ max(15%, 노이즈 중앙값×8배) : 그 최저점에서 후반까지
    //        노이즈 수준을 훨씬 웃도는 확실한 반등이 있었다 (절대 수치가 아닌
    //        "이 데이터의 노이즈 대비 상대적으로 큰 반등"을 요구 → 미세한
    //        uptick은 걸러지고, 저점에서 어느 수준까지 반등하든 잡아낸다)
    //     ③ lateSpread ≤15% : 그 후반 구간 자체가 안정적으로 유지된다
    //        (반등한 값이 1회성 튐이 아니라 진짜 정착된 평탄 구간인지 확인)
    //
    //   [한계] 마지막에 저율속으로 복귀하지 않고 계속 율속만 올리다 끝나는
    //   rate 시험은 이 신호로 못 잡는다 — 그런 경우는 3차 폴백(사이클 수 기준)
    //   또는 사이드바의 수동 지정으로 처리한다.
    // ==================================================================
    const RECOVERY_MIN_N = 10;          // 이보다 짧으면 판단 보류
    const RECOVERY_WIN_MIN = 3;         // 초반/후반 대표 구간 최소 길이
    const RECOVERY_WIN_MAX = 5;         // 초반/후반 대표 구간 최대 길이
    const RECOVERY_DROP_RATIO = 0.2;    // ① 최소 하락폭 (초반 대비 최저점)
    const RECOVERY_STEP_MIN = 0.15;     // ② 최저점 대비 최소 반등폭 (절대 하한)
    const RECOVERY_STEP_NOISE_MULT = 8; // ② 노이즈 중앙값 대비 배수 (데이터별 노이즈에 자동 적응)
    const RECOVERY_LATE_SPREAD_MAX = 0.15; // ③ 후반 구간 최대 변동폭
    const RECOVERY_MIN_LOW_FRACTION = 0.15; // 중간 구간에서 "최저 대표값" 계산에 쓸 하위 비율

    function median(arr) {
        const s = arr.slice().sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
    }

    function detectRateRecoveryPattern(points) {
        const n = points.length;
        if (n < RECOVERY_MIN_N) return null;

        const winSize = Math.max(RECOVERY_WIN_MIN, Math.min(RECOVERY_WIN_MAX, Math.floor(n * 0.1)));
        const earlyVals = points.slice(0, winSize).map(p => p.y);
        const lateVals = points.slice(n - winSize).map(p => p.y);
        const early = median(earlyVals);
        const late = median(lateVals);

        const middle = points.slice(winSize, n - winSize);
        if (middle.length < 3) return null;

        // 중간 구간 하위 15%의 중앙값 = 이상치 하나에 흔들리지 않는 "최저 대표 용량"
        const midSorted = middle.map(p => p.y).slice().sort((a, b) => a - b);
        const lowCount = Math.max(1, Math.ceil(midSorted.length * RECOVERY_MIN_LOW_FRACTION));
        const minLevel = median(midSorted.slice(0, lowCount));

        const earlyAbs = Math.abs(early) || 1e-9;
        const dropRatio = (early - minLevel) / earlyAbs;
        if (dropRatio < RECOVERY_DROP_RATIO) return null;   // ① 뚜렷한 하락이 없으면 보류

        // 데이터 자체의 사이클간 노이즈 수준(중앙값) — 반등 문턱을 여기에 맞춰 자동 조정
        const rel = [];
        for (let i = 1; i < n; i++) {
            const prev = Math.abs(points[i - 1].y) || 1e-9;
            rel.push(Math.abs((points[i].y - points[i - 1].y) / prev));
        }
        const noiseMedian = median(rel) || 0;
        const stepThreshold = Math.max(RECOVERY_STEP_MIN, noiseMedian * RECOVERY_STEP_NOISE_MULT);

        const minAbs = Math.abs(minLevel) || 1e-9;
        const stepRatio = (late - minLevel) / minAbs;
        if (stepRatio < stepThreshold) return null;   // ② 노이즈 대비 확실한 반등이 아니면 보류

        const lateAbs = Math.abs(late) || 1e-9;
        const lateSpread = (Math.max(...lateVals) - Math.min(...lateVals)) / lateAbs;
        if (lateSpread > RECOVERY_LATE_SPREAD_MAX) return null;   // ③ 반등 구간이 불안정하면(글리치) 보류

        return {
            kind: "rate",
            reason: `전류 정보 없음 · 초반 ${early.toFixed(1)} → 중반 최저 ${minLevel.toFixed(1)}` +
                    `(${(dropRatio * 100).toFixed(0)}%↓) → 후반 ${late.toFixed(1)}` +
                    `(저점 대비 +${(stepRatio * 100).toFixed(0)}% 반등 후 안정) 패턴 감지 → Rate Capability`
        };
    }

    // ==================================================================
    // 실험 종류 자동 판별  →  { kind: 'rate'|'cycle', reason, main, segments, ... }
    // ==================================================================
    // [폴백 기준] 전류 정보와 용량 복귀 패턴이 모두 불확실할 때만 사용:
    //   총 사이클 수가 50을 넘으면 cycle(Cyclability), 50 이하면 rate(Rate Capability)
    const CYCLE_THRESHOLD = 50;

    // ==================================================================
    // 형성(formation)·비정상 초반 사이클 감지
    //   - 가장 긴 안정 구간(main)이 데이터 초반(최대 15사이클, 전체의 20% 이내)
    //     에서 시작하고, 그 앞의 사이클들이 "전부" 안정 구간 초입 평균보다
    //     유의미하게(5% 이상) 높을 때만 → 그 앞부분(형성 + 스파이크)을 제외
    //   - 반환값: 본 데이터가 시작되는 인덱스 (제외할 것 없으면 0)
    //   ※ 여기서 자른 뒤로는 "끝까지 전부" 표시한다. 중간 노이즈로 뒷부분이
    //     잘리지 않도록 최장 구간의 끝(end)은 사용하지 않는다.
    // ==================================================================
    function detectFormationCut(points, analysis) {
        const n = points.length;
        const main = analysis.main;
        if (!main || main.start === 0) return 0;

        const limit = Math.min(15, Math.floor(n * 0.2));
        if (main.start > limit) return 0;

        // 안정 구간 초입(최대 10사이클)의 평균 = 본 사이클 기준 용량
        const refEnd = Math.min(main.start + 9, main.end);
        let sum = 0, cnt = 0;
        for (let i = main.start; i <= refEnd; i++) { sum += points[i].y; cnt++; }
        const ref = sum / cnt;

        // 앞쪽 사이클(형성/스파이크)이 전부 기준보다 높아야만 제외 (애매하면 안 자름)
        for (let i = 0; i < main.start; i++) {
            if (points[i].y <= ref * 1.05) return 0;
        }

        // 형성 직후의 "전이 사이클"까지 흡수: 뒤따르는 10사이클 중앙값보다
        // 3% 이상 높은 동안 잘라나간다 (정상 감쇠는 사이클당 <1%라 안 걸림)
        let cut = main.start;
        while (cut < Math.min(limit, n - 10)) {
            const win = [];
            for (let k = cut + 1; k <= Math.min(cut + 10, n - 1); k++) win.push(points[k].y);
            win.sort((a, b) => a - b);
            const med = win[Math.floor(win.length / 2)];
            if (points[cut].y > med * 1.03) cut++; else break;
        }
        return cut;
    }

    function detectExperimentKind(points) {
        const n = points.length;
        const a = analyzeSeries(points);
        const mainLen = a.main.end - a.main.start + 1;
        const ratio = mainLen / n;
        const segCount = a.segments.length;
        const formationCut = detectFormationCut(points, a);
        // 형성 사이클 이후는 마지막 사이클까지 전부 표시한다 (말기 제외 없음)
        const base = { main: a.main, segments: a.segments, mainLen, segCount, ratio, formationCut, trailingCut: 0 };

        // [1차] 전류 기반 판별: C-rate 레벨이 명확히 구분되면 사이클 수와 무관하게 확정
        const cur = analyzeCurrents(points);
        if (cur) {
            return Object.assign({ kind: cur.kind, reason: cur.reason, currentLevels: cur.levelValues }, base);
        }

        // [2차] 전류 정보가 없거나 신뢰 불가 → 용량 "초반 복귀" 패턴을 보조 신호로 확인.
        //   확실한 복귀 패턴(rate)일 때만 반환되고, 애매하면 null → 3차 폴백으로.
        const recovery = detectRateRecoveryPattern(points);
        if (recovery) {
            return Object.assign({ kind: recovery.kind, reason: recovery.reason }, base);
        }

        // [3차 폴백] 전류·용량 복귀 판별 모두 불확실 → 기존 사이클 수 기준
        if (n > CYCLE_THRESHOLD) {
            return Object.assign({ kind: "cycle", reason: `전류 정보 불충분 · 총 ${n}사이클 > ${CYCLE_THRESHOLD}사이클 → Cyclability` }, base);
        }
        return Object.assign({ kind: "rate", reason: `전류 정보 불충분 · 총 ${n}사이클 ≤ ${CYCLE_THRESHOLD}사이클 → Rate Capability` }, base);
    }

    // 자동 판별 실행 (cacheKey 가 있으면 유효 사이클 수 기준으로 캐시 재사용)
    function detect(pc, cacheKey) {
        const series = seriesFromProcessed(pc);
        if (!series.length) return null;
        if (cacheKey && _cache[cacheKey] && _cache[cacheKey].n === series.length) {
            return _cache[cacheKey].det;
        }
        const det = detectExperimentKind(series);
        if (cacheKey) _cache[cacheKey] = { n: series.length, det };
        return det;
    }

    // ==================================================================
    // 수동 지정(사이드바 RATE/CYCLE 선택박스) 지원
    // ==================================================================

    // 13-charts.js 단일 모드 래퍼처럼 id 없는 임시 객체가 넘어와도
    // 라이브러리의 실제 데이터셋을 찾아 kindManual/experimentType 을 읽는다.
    function resolveLibraryDs(ds) {
        if (typeof datasetLibrary === "undefined" || !Array.isArray(datasetLibrary)) return ds;
        if (ds && ds.id) return datasetLibrary.find(d => d.id === ds.id) || ds;
        if (typeof activeDatasetId !== "undefined" && activeDatasetId) {
            return datasetLibrary.find(d => d.id === activeDatasetId) || ds;
        }
        return ds;
    }

    // 수동 지정이 있으면 'rate'|'cycle' 반환, 없으면 null
    function manualKindOf(ds) {
        if (!ds || !ds.kindManual) return null;
        if (ds.experimentType === "cycle_performance") return "cycle";
        if (ds.experimentType === "rate") return "rate";
        return null;
    }

    // 자동 판별 결과를 experimentType 에 동기화 (수동 지정·GITT·CV 는 건드리지 않음)
    function syncExperimentType(ds, kind) {
        if (!ds || ds.kindManual) return;
        if (ds.experimentType === "gitt" || ds.experimentType === "cv") return;
        if (typeof datasetLibrary === "undefined" || !Array.isArray(datasetLibrary) || !datasetLibrary.includes(ds)) return;
        const t = (kind === "cycle") ? "cycle_performance" : "rate";
        if (ds.experimentType !== t) {
            ds.experimentType = t;
            if (typeof updateDatasetInDB === "function") {
                Promise.resolve(updateDatasetInDB(ds)).catch(() => { /* DB 저장 실패는 무시 (다음 저장 때 반영) */ });
            }
        }
    }

    // 수동 지정을 반영한 최종 종류 → 'rate' | 'cycle' | null
    function getEffectiveKind(ds) {
        if (!ds) return null;
        const lib = resolveLibraryDs(ds);
        const manual = manualKindOf(lib);
        if (manual) return manual;
        const pc = ds.processedCycles || (lib && lib.processedCycles);
        if (!pc) return null;
        const det = detect(pc, (ds.id || (lib && lib.id)) || null);
        return det ? det.kind : null;
    }

    // ==================================================================
    // 표시 대상 데이터셋: rate 차트(13-charts.js)와 동일한 규칙
    //   비교 체크 ≥2개 → 체크된 것들 / 아니면 활성 데이터셋 1개
    // ==================================================================
    function getDisplayDatasets() {
        const checked = (typeof getCheckedDatasets === "function") ? getCheckedDatasets() : [];
        if (checked.length >= 2) return checked.filter(ds => ds && ds.processedCycles);

        if (typeof processedCycles !== "undefined" && processedCycles && Object.keys(processedCycles).length) {
            const activeDs = (typeof datasetLibrary !== "undefined" && typeof activeDatasetId !== "undefined" && activeDatasetId)
                ? datasetLibrary.find(d => d.id === activeDatasetId) : null;
            return [{
                id: activeDs ? activeDs.id : "_active",
                customName: activeDs ? (activeDs.customName || activeDs.dataName) : "Active",
                lineColor: (activeDs && activeDs.lineColor) ? activeDs.lineColor : "#60a5fa",
                processedCycles: processedCycles
            }];
        }
        return [];
    }

    // ==================================================================
    // 일괄 판별: 피팅(분석·차트 렌더) 전에 호출 — runAnalysis() 맨 앞
    //   표시 대상 데이터셋 전부를 판별해 캐시를 채우고 결과 목록을 반환.
    //   수동 지정(kindManual)이 있으면 kind/reason 을 그것으로 덮어쓰고,
    //   자동 모드면 experimentType 을 판별 결과로 동기화한다.
    // ==================================================================
    function classifyDisplayDatasets() {
        return getDisplayDatasets()
            .map(ds => {
                const auto = detect(ds.processedCycles, ds.id);
                if (!auto) return null;
                const lib = resolveLibraryDs(ds);
                const manual = manualKindOf(lib);
                let det = auto;
                if (manual && manual !== auto.kind) {
                    det = Object.assign({}, auto, {
                        kind: manual,
                        reason: `수동 지정 → ${manual === "cycle" ? "Cyclability" : "Rate Capability"} (자동 판별: ${auto.reason})`
                    });
                } else if (manual) {
                    det = Object.assign({}, auto, { reason: `수동 지정 · ${auto.reason}` });
                }
                syncExperimentType(lib, det.kind);
                return { ds, det };
            })
            .filter(Boolean);
    }

    function isCycleKind(ds) {
        if (!ds || !ds.processedCycles) return false;
        return getEffectiveKind(ds) === "cycle";
    }

    function isRateKind(ds) {
        if (!ds || !ds.processedCycles) return false;
        return getEffectiveKind(ds) === "rate";
    }

    // 전역 API 노출
    window.ExperimentDetector = {
        seriesFromProcessed,
        detect,
        getEffectiveKind,
        getDisplayDatasets,
        classifyDisplayDatasets,
        isCycleKind,
        isRateKind
    };

    // 하위 호환 별칭 (13-charts.js 필터, 11-analysis-metrics.js 선행 판별에서 사용)
    window.isCycleKindDataset = isCycleKind;
    window.classifyDisplayDatasets = classifyDisplayDatasets;
})();
