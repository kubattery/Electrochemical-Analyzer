/* ============================================================================
 * HC-Analyzer  ·  19-experiment-detector.js   (v2.2.0)
 * 역할: 실험 종류(rate / cycle) 자동 판별 전담 모듈
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
 *  3. 판별 기준(사용자 지정): 총 사이클 수 > 50 → cycle(Cyclability),
 *     50 이하 → rate(Rate Capability). 임계값은 CYCLE_THRESHOLD 상수로 조정.
 *
 * [전역 API]  window.ExperimentDetector
 *  - seriesFromProcessed(pc)      : processedCycles → [{x,y,ce}] 시계열
 *  - detect(pc, cacheKey)         : 판별 실행 → {kind:'rate'|'cycle', reason, main, ...}
 *  - getDisplayDatasets()         : 표시 대상 데이터셋 (비교 체크 ≥2개면 체크된 것, 아니면 활성 1개)
 *  - classifyDisplayDatasets()    : 표시 대상 전부 일괄 판별 → [{ds, det}]
 *  - isCycleKind(ds) / isRateKind(ds) : 데이터셋 1개의 종류 질의
 *  (하위 호환: window.isCycleKindDataset, window.classifyDisplayDatasets 도 노출)
 * ============================================================================ */

(function () {
    "use strict";

    const _cache = {};   // 데이터셋 id → { n: 유효 사이클 수, det: 판정 결과 }

    // ==================================================================
    // 데이터 추출: processedCycles 객체 → [{x: 사이클번호, y: 방전용량, ce: 쿨롱효율}]
    // ==================================================================
    function seriesFromProcessed(pc) {
        if (!pc) return [];
        const nums = Object.keys(pc).map(Number).sort((a, b) => a - b);
        const pts = [];
        nums.forEach(cn => {
            const c = pc[cn];
            if (!c) return;
            const dis = c.totalDischargeCap;
            if (typeof dis !== "number" || !(dis > 0)) return;
            const cha = c.totalChargeCap;
            const ce = (typeof cha === "number" && cha > 0) ? (cha / dis) * 100 : null;
            pts.push({ x: cn, y: dis, ce: ce });
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
    // 실험 종류 판별  →  { kind: 'rate'|'cycle', reason, main, segments, ... }
    // ==================================================================
    // [판별 기준 — 사용자 지정 규칙]
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
        return main.start;
    }

    // ==================================================================
    // 말기 미완료 사이클 감지: 측정이 도중에 중단되면 마지막 1~2 사이클의
    // 용량이 직전 대비 급락한다. 직전 5사이클 중앙값의 60% 미만인 끝점만
    // (최대 3개까지) 제외. 점진적 용량 감쇠는 절대 걸리지 않는 조건이다.
    //   - 반환값: 제외할 말기 포인트 개수
    // ==================================================================
    function detectTrailingCut(points) {
        const n = points.length;
        let end = n - 1, dropped = 0;
        while (end > 5 && dropped < 3) {
            const win = [];
            for (let k = Math.max(0, end - 5); k < end; k++) win.push(points[k].y);
            win.sort((a, b) => a - b);
            const med = win[Math.floor(win.length / 2)];
            if (points[end].y < med * 0.6) { end--; dropped++; } else break;
        }
        return n - 1 - end;
    }

    function detectExperimentKind(points) {
        const n = points.length;
        const a = analyzeSeries(points);
        const mainLen = a.main.end - a.main.start + 1;
        const ratio = mainLen / n;
        const segCount = a.segments.length;
        const formationCut = detectFormationCut(points, a);
        const trailingCut = detectTrailingCut(points);
        const base = { main: a.main, segments: a.segments, mainLen, segCount, ratio, formationCut, trailingCut };

        if (n > CYCLE_THRESHOLD) {
            return Object.assign({ kind: "cycle", reason: `총 ${n}사이클 > ${CYCLE_THRESHOLD}사이클 → Cyclability` }, base);
        }
        return Object.assign({ kind: "rate", reason: `총 ${n}사이클 ≤ ${CYCLE_THRESHOLD}사이클 → Rate Capability` }, base);
    }

    // 판별 실행 (cacheKey 가 있으면 유효 사이클 수 기준으로 캐시 재사용)
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
    //   표시 대상 데이터셋 전부를 판별해 캐시를 채우고 결과 목록을 반환
    // ==================================================================
    function classifyDisplayDatasets() {
        return getDisplayDatasets()
            .map(ds => ({ ds, det: detect(ds.processedCycles, ds.id) }))
            .filter(e => e.det);
    }

    function isCycleKind(ds) {
        if (!ds || !ds.processedCycles) return false;
        const det = detect(ds.processedCycles, ds.id);
        return !!det && det.kind === "cycle";
    }

    function isRateKind(ds) {
        if (!ds || !ds.processedCycles) return false;
        const det = detect(ds.processedCycles, ds.id);
        return !!det && det.kind === "rate";
    }

    // 전역 API 노출
    window.ExperimentDetector = {
        seriesFromProcessed,
        detect,
        getDisplayDatasets,
        classifyDisplayDatasets,
        isCycleKind,
        isRateKind
    };

    // 하위 호환 별칭 (13-charts.js 필터, 11-analysis-metrics.js 선행 판별에서 사용)
    window.isCycleKindDataset = isCycleKind;
    window.classifyDisplayDatasets = classifyDisplayDatasets;
})();
