/* ============================================================================
 * HC-Analyzer  ·  20-ai-report.js
 * 역할: 현재 분석 결과 스냅샷 수집 → 독립 팝업 창(ai-report.html)으로 전달
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 20/20  (이전: js/18-cyclability.js → 다음: (없음))
 *
 * [설계 원칙]
 *  1. 이 모듈은 AI를 직접 호출하지 않는다. API 호출은 전적으로 팝업 창
 *     (ai-report.html)이 담당한다. 이 파일은 "무엇을 보낼지"만 책임진다.
 *  2. 원본 측정 데이터를 통째로 보내지 않는다. 이미 계산된 지표 + 화면에
 *     떠 있는 요약 테이블 + 대표 사이클 곡선(최대 40점으로 축약)만 전달한다.
 *     → 수만~수십만 행의 원시 전압/용량 로그는 브라우저 밖으로 나가지 않는다.
 *  3. 스냅샷은 팝업이 요청(HCAI_REQUEST_PAYLOAD)하는 시점에 즉석에서 만든다.
 *     → 팝업의 "분석 결과 다시 불러오기"가 항상 최신 상태를 집어온다.
 *  4. 계산식은 11-analysis-metrics.js / 13-charts.js 와 동일한 것을 재사용한다.
 *     화면에 보이는 수치와 AI에게 보내는 수치가 어긋나면 안 된다.
 * ============================================================================ */

const AI_REPORT_WINDOW_NAME = 'hc-ai-report';
let _aiReportWin = null;

/**
 * 팝업 페이지 캐시 버전.
 * [중요] ai-report.html 을 수정하면 이 값을 반드시 올려야 한다.
 * 팝업은 메인 페이지와 별개 문서이므로, 메인 창에서 Ctrl+Shift+R 을 눌러도
 * 팝업의 캐시는 갱신되지 않는다. 이 쿼리 문자열이 유일한 갱신 수단이다.
 */
const AI_REPORT_PAGE_VERSION = '1.9.0';

/**
 * postMessage 대상 오리진.
 * file:// 로 직접 열면 location.origin 이 문자열 "null" 이 되어 오리진 지정이
 * 불가능하므로 그 경우에만 '*' 로 완화한다. (GitHub Pages 배포 시엔 정상 오리진)
 */
function aiTargetOrigin() {
    return (location.origin && location.origin !== 'null') ? location.origin : '*';
}

function aiOriginAllowed(origin) {
    const target = aiTargetOrigin();
    return target === '*' || origin === target;
}

/* ==========================================
   1. 대상 데이터셋 선정
   팝업에서 직접 고를 수 있도록 "분석 가능한 데이터셋 전부"를 담아 보낸다.
   어떤 것을 기본 선택할지는 defaultSelected 로 표시만 하고, 최종 선택은 팝업이 결정한다.
   ========================================== */

/** 데이터셋에 분석 가능한 사이클 데이터가 들어 있는지 */
function aiHasCycles(ds) {
    return !!(ds && ds.processedCycles && Object.keys(ds.processedCycles).length > 0);
}

/**
 * 충방전 분석이 가능한 데이터셋 전부.
 * 라이브러리에 저장된 것 + 아직 저장 전인 현재 분석 데이터까지 모두 포함한다.
 * (활성 데이터셋이 없어도 라이브러리 것만으로 해석할 수 있어야 한다)
 */
function aiAllAnalyzableDatasets() {
    const list = datasetLibrary.filter(ds => ds && !ds.isGitt && aiHasCycles(ds));

    // 파일을 막 파싱했지만 아직 라이브러리에 저장하지 않은 상태 대응.
    // 전역 processedCycles 에는 데이터가 있는데 라이브러리에는 없는 경우 합성 항목을 추가한다.
    const inLibrary = activeDatasetId && list.some(ds => ds.id === activeDatasetId);
    if (!inLibrary && typeof processedCycles !== 'undefined' &&
        processedCycles && Object.keys(processedCycles).length > 0) {
        list.push({
            id: '__current__',
            dataName: (activeFilename && activeFilename.textContent)
                ? activeFilename.textContent + ' (저장 전)'
                : '현재 분석 중인 데이터 (저장 전)',
            sampleName: null,
            projectName: null,
            experimentType: null,
            lineColor: '#60a5fa',
            processedCycles: processedCycles
        });
    }
    return list;
}

/**
 * 목록에는 띄우되 해석할 수 없는 데이터셋 (사이클 데이터 없음 / GITT).
 * 조용히 숨기면 "왜 내 데이터가 안 보이지"가 되므로 이유를 함께 보낸다.
 */
function aiUnavailableDatasets() {
    return datasetLibrary
        .filter(ds => ds && (ds.isGitt || !aiHasCycles(ds)))
        .map(ds => ({
            name: ds.dataName || ds.customName || '(이름 없음)',
            reason: ds.isGitt
                ? 'GITT 데이터는 충방전 해석 대상이 아닙니다'
                : (ds.conversionStatus === 'failed'
                    ? '변환 실패 상태입니다 — 파일을 다시 업로드해 주세요'
                    : '사이클 데이터가 비어 있습니다 — 파일을 다시 업로드해 주세요')
        }));
}

/**
 * 기본 선택 대상 id 집합.
 * 13-charts.js / 19-experiment-detector.js 와 동일 규칙을 기본값으로 삼는다:
 * 비교 체크가 있으면 체크된 것들, 없으면 활성 데이터셋 1개.
 */
function aiDefaultSelectedIds() {
    const checked = (typeof getCheckedDatasets === 'function') ? getCheckedDatasets() : [];
    if (checked.length > 0) {
        return checked.filter(ds => ds && ds.processedCycles).map(ds => ds.id);
    }
    return datasetLibrary.filter(ds => ds.id === activeDatasetId && ds.processedCycles).map(ds => ds.id);
}

/* ==========================================
   2. 지표 계산 (화면 테이블과 동일한 식)
   ========================================== */

/**
 * 숫자를 소수 digits 자리로 반올림해 돌려준다. 숫자가 아니면 null.
 *
 * [주의] 값이 없을 때 곧바로 .toFixed() 를 부르면 전체 스냅샷 생성이 예외로
 *   중단되고, 팝업은 아무 데이터도 못 받는다. 실제로 그런 사고가 있었다.
 *   (13-charts.js 의 buildRateSummaryForDataset 은 avgCE 를 반환하지 않는데
 *    11-analysis-metrics.js 의 calculateRateCapability 와 같은 모양이라고
 *    잘못 가정해 s.avgCE.toFixed() 를 호출했다.)
 *   따라서 외부 함수에서 받은 값은 전부 이 헬퍼를 거친다.
 */
function aiNum(v, digits) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return null;
    return +n.toFixed(typeof digits === 'number' ? digits : 2);
}

/** 1st 사이클 기준 초기 용량 및 ICE — updateOverviewMetricsTable() 과 동일 */
function aiComputeInitial(pc) {
    const first = pc[1] || Object.values(pc)[0];
    if (!first) return null;

    const initDischarge = first.totalDischargeCap || 0;
    const initCharge = first.totalChargeCap || 0;
    const ice = initDischarge > 0 ? (initCharge / initDischarge) * 100 : null;

    return {
        initialDischargeCapacity_mAh_g: aiNum(initDischarge),
        initialChargeCapacity_mAh_g: aiNum(initCharge),
        ICE_percent: aiNum(ice)
    };
}

/** Slope / Plateau 분리 — updateSlopePlateauMetricsTable() 과 동일 */
function aiComputeSlopePlateau(pc, cutoffV, targetCycleNum) {
    const nums = Object.keys(pc).map(Number).sort((a, b) => a - b);
    if (nums.length === 0) return null;

    // 요청한 사이클이 없으면 가장 가까운 사이클로 폴백 (화면 테이블과 동일 동작)
    let cNum = targetCycleNum;
    if (!nums.includes(cNum)) {
        cNum = nums.reduce((prev, curr) =>
            Math.abs(curr - targetCycleNum) < Math.abs(prev - targetCycleNum) ? curr : prev);
    }

    const cycleData = pc[cNum];
    if (!cycleData) return null;

    const sodPoints = cycleData.sodiation || [];
    let slopeCapacity = 0;
    let plateauCapacity = 0;

    if (sodPoints.length > 0) {
        const cutoffIndex = sodPoints.findIndex(p => p.voltage <= cutoffV);
        if (cutoffIndex === -1) {
            slopeCapacity = cycleData.totalDischargeCap || 0;
            plateauCapacity = 0;
        } else {
            // 곡선 포인트에 capacity 가 없을 수 있으므로 숫자로 강제한다
            const cap = parseFloat(sodPoints[cutoffIndex].capacity);
            slopeCapacity = isFinite(cap) ? cap : 0;
            plateauCapacity = (cycleData.totalDischargeCap || 0) - slopeCapacity;
        }
    }

    const totalCap = slopeCapacity + plateauCapacity;

    return {
        cycle: cNum,
        cutoffVoltage_V: cutoffV,
        slopeCapacity_mAh_g: aiNum(slopeCapacity),
        plateauCapacity_mAh_g: aiNum(plateauCapacity),
        totalCapacity_mAh_g: aiNum(totalCap),
        slopeRatio_percent: totalCap > 0 ? aiNum((slopeCapacity / totalCap) * 100) : null,
        plateauRatio_percent: totalCap > 0 ? aiNum((plateauCapacity / totalCap) * 100) : null
    };
}

/** 사이클 수명 요약 — 19-experiment-detector.js 의 시계열(가역 용량 기준) 재사용 */
function aiComputeCycleLife(pc) {
    let series = [];
    if (window.ExperimentDetector && typeof ExperimentDetector.seriesFromProcessed === 'function') {
        series = ExperimentDetector.seriesFromProcessed(pc);
    }
    if (series.length === 0) return null;

    const first = series[0];
    const last = series[series.length - 1];
    const ceVals = series.map(p => p.ce).filter(v => typeof v === 'number' && isFinite(v));
    const avgCE = ceVals.length ? ceVals.reduce((a, b) => a + b, 0) / ceVals.length : null;

    return {
        firstCycle: first.x,
        firstCapacity_mAh_g: aiNum(first.y),
        lastCycle: last.x,
        lastCapacity_mAh_g: aiNum(last.y),
        capacityRetention_percent: first.y > 0 ? aiNum((last.y / first.y) * 100) : null,
        averageCoulombicEfficiency_percent: aiNum(avgCE)
    };
}

/**
 * 율속 단계별 요약.
 *
 * 용량·유지율은 13-charts.js 의 buildRateSummaryForDataset() 결과를 그대로 쓴다
 * (차트와 같은 값을 보장하기 위해). 다만 그 함수는 {rate, avgCharge, retention}
 * 세 가지만 돌려주므로, 사이클 구간과 평균 쿨롱 효율은 여기서 따로 계산해 채운다.
 */
function aiRateSteps(pc) {
    if (typeof buildRateSummaryForDataset !== 'function') return [];

    let base = [];
    try {
        base = buildRateSummaryForDataset(pc) || [];
    } catch (err) {
        console.warn('율속 요약 계산 실패:', err);
        return [];
    }
    if (base.length === 0) return [];

    // buildRateSummaryForDataset 과 동일한 단계 크기로 사이클을 묶는다
    const stepSizeSel = document.getElementById('rateStepSize');
    const stepSize = stepSizeSel ? (parseInt(stepSizeSel.value) || 5) : 5;
    const cycles = Object.keys(pc).map(Number).sort((a, b) => a - b);

    // 유효 사이클이 없는 단계는 buildRateSummaryForDataset 이 건너뛰므로,
    // 같은 규칙으로 걸러 인덱스를 맞춘다.
    const groups = [];
    for (let i = 0; i < cycles.length; i += stepSize) {
        const stepCycles = cycles.slice(i, i + stepSize);
        if (stepCycles.length === 0) break;

        let ceSum = 0, ceCount = 0, valid = 0;
        stepCycles.forEach(cNum => {
            const cyc = pc[cNum];
            if (!cyc) return;
            const capVal = currentRateMode === 'charge' ? cyc.totalChargeCap : cyc.totalDischargeCap;
            if (!(capVal > 0)) return;
            valid++;
            if (cyc.totalDischargeCap > 0 && typeof cyc.totalChargeCap === 'number') {
                ceSum += (cyc.totalChargeCap / cyc.totalDischargeCap) * 100;
                ceCount++;
            }
        });
        if (valid === 0) continue;

        groups.push({
            cycleRange: `${stepCycles[0]} - ${stepCycles[stepCycles.length - 1]}`,
            avgCE: ceCount ? ceSum / ceCount : null
        });
    }

    return base.map((s, i) => ({
        rate: s.rate,
        cycleRange: groups[i] ? groups[i].cycleRange : null,
        averageCapacity_mAh_g: aiNum(s.avgCharge),
        retention_percent: aiNum(s.retention),
        averageCoulombicEfficiency_percent: groups[i] ? aiNum(groups[i].avgCE) : null
    }));
}


/* ==========================================
   2-B. 전압 기반 지표 (평균 전압 · 에너지 · 분극)

   용량만으로는 양극 열화를 진단할 수 없다. 용량이 유지되어도 평균 방전 전압이
   내려가면 에너지 밀도는 이미 감소하고 있고(Li-rich 계열의 핵심 논점), 충방전
   전압 차(분극)가 벌어지면 계면 저항 증가나 상전이 가역성 저하를 뜻한다.
   화면 어디에도 표시되지 않는 값이므로 여기서 직접 계산해 AI 에게 넘긴다.
   ========================================== */

/**
 * 곡선 한 가닥의 사다리꼴 적분.
 * points 는 [{voltage, capacity}] 이고 capacity 는 곡선을 따라 단조 증가한다.
 * 반환: { capacity_mAh_g, energy_Wh_kg, avgVoltage_V }
 *   에너지 = ∫V dQ. mAh/g × V = mWh/g = Wh/kg 이므로 단위 환산이 필요 없다.
 *   평균 전압 = 에너지 / 용량 (용량 가중 평균. 단순 산술평균과 다르다)
 */
function aiCurveEnergy(points) {
    if (!Array.isArray(points) || points.length < 2) return null;

    let energy = 0;
    let capSpan = 0;
    let prevV = null;
    let prevQ = null;

    for (const p of points) {
        const v = parseFloat(p.voltage);
        const q = parseFloat(p.capacity);
        if (!isFinite(v) || !isFinite(q)) continue;
        if (prevV !== null) {
            const dq = q - prevQ;
            if (dq > 0) {
                energy += ((v + prevV) / 2) * dq;
                capSpan += dq;
            }
        }
        prevV = v;
        prevQ = q;
    }
    if (!(capSpan > 0)) return null;

    return {
        capacity_mAh_g: aiNum(capSpan),
        energy_Wh_kg: aiNum(energy),
        avgVoltage_V: aiNum(energy / capSpan, 4)
    };
}

/** 최소제곱 직선의 기울기 (x 단위당 y 변화). 점이 2개 미만이면 null */
function aiSlope(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        den += (xs[i] - mx) * (xs[i] - mx);
    }
    return den === 0 ? null : num / den;
}

/**
 * 사이클별 전압·에너지·효율 시계열과 그 요약.
 * 시계열이 길면 균등 간격으로 최대 maxPoints 개까지 솎아낸다(전송량 억제).
 */
function aiCycleMetricsSeries(pc, maxPoints) {
    const cap = (typeof maxPoints === 'number') ? maxPoints : 40;
    const nums = Object.keys(pc).map(Number).sort((a, b) => a - b);
    if (nums.length === 0) return null;

    const rows = [];
    nums.forEach(n => {
        const c = pc[n];
        if (!c) return;
        const dis = aiCurveEnergy(c.sodiation);      // 방전(소듐화/리튬화) 가닥
        const chg = aiCurveEnergy(c.desodiation);    // 충전(탈소듐화/탈리튬화) 가닥
        const dCap = aiNum(c.totalDischargeCap);
        const cCap = aiNum(c.totalChargeCap);

        rows.push({
            cycle: n,
            dischargeCapacity_mAh_g: dCap,
            chargeCapacity_mAh_g: cCap,
            coulombicEfficiency_percent:
                (dCap > 0 && cCap != null) ? aiNum((cCap / dCap) * 100) : null,
            avgDischargeVoltage_V: dis ? dis.avgVoltage_V : null,
            avgChargeVoltage_V: chg ? chg.avgVoltage_V : null,
            polarization_V: (dis && chg) ? aiNum(chg.avgVoltage_V - dis.avgVoltage_V, 4) : null,
            dischargeEnergy_Wh_kg: dis ? dis.energy_Wh_kg : null
        });
    });
    if (rows.length === 0) return null;

    // 요약은 솎아내기 전 전체 데이터로 계산한다
    const withV = rows.filter(r => r.avgDischargeVoltage_V != null);
    const withE = rows.filter(r => r.dischargeEnergy_Wh_kg != null);
    const withP = rows.filter(r => r.polarization_V != null);

    const decay = withV.length > 2
        ? aiSlope(withV.map(r => r.cycle), withV.map(r => r.avgDischargeVoltage_V))
        : null;

    const summary = {
        firstCycle: rows[0].cycle,
        lastCycle: rows[rows.length - 1].cycle,
        avgDischargeVoltage_first_V: withV.length ? withV[0].avgDischargeVoltage_V : null,
        avgDischargeVoltage_last_V: withV.length ? withV[withV.length - 1].avgDischargeVoltage_V : null,
        voltageDecay_mV_per_cycle: decay === null ? null : aiNum(decay * 1000, 3),
        dischargeEnergy_first_Wh_kg: withE.length ? withE[0].dischargeEnergy_Wh_kg : null,
        dischargeEnergy_last_Wh_kg: withE.length ? withE[withE.length - 1].dischargeEnergy_Wh_kg : null,
        energyRetention_percent: (withE.length > 1 && withE[0].dischargeEnergy_Wh_kg > 0)
            ? aiNum((withE[withE.length - 1].dischargeEnergy_Wh_kg / withE[0].dischargeEnergy_Wh_kg) * 100)
            : null,
        polarization_first_V: withP.length ? withP[0].polarization_V : null,
        polarization_last_V: withP.length ? withP[withP.length - 1].polarization_V : null,
        polarizationIncrease_V: withP.length > 1
            ? aiNum(withP[withP.length - 1].polarization_V - withP[0].polarization_V, 4) : null
    };

    // 시계열 솎아내기 (첫 사이클과 마지막 사이클은 반드시 남긴다)
    let series = rows;
    if (rows.length > cap) {
        const step = (rows.length - 1) / (cap - 1);
        const picked = [];
        for (let i = 0; i < cap; i++) picked.push(rows[Math.round(i * step)]);
        series = picked.filter((r, i, arr) => i === 0 || r.cycle !== arr[i - 1].cycle);
    }

    // 키 이름을 40번 반복하면 전송량이 몇 배로 불어난다.
    // 열 이름을 한 번만 적고 값은 행 배열로 싣는다 (LLM 이 읽는 데 지장 없음).
    const columns = ['cycle', 'dischargeCapacity_mAh_g', 'chargeCapacity_mAh_g',
        'coulombicEfficiency_percent', 'avgDischargeVoltage_V', 'avgChargeVoltage_V',
        'polarization_V', 'dischargeEnergy_Wh_kg'];

    return {
        note: '평균 전압은 용량 가중 평균(∫V dQ / ∫dQ)이다. 분극 = 평균 충전 전압 − 평균 방전 전압. ' +
              '에너지는 방전 곡선의 ∫V dQ (mAh/g·V = Wh/kg). 아래 rows 는 columns 순서를 따르는 값 배열이다.',
        efficiencyConvention: 'coulombicEfficiency_percent = 충전용량 / 방전용량 × 100 (음극 기준 정의). ' +
              '양극 반쪽전지처럼 충전부터 시작하는 셀에서는 방전/충전으로 다시 계산해야 하므로 원시 용량을 함께 실었다.',
        summary: summary,
        columns: columns,
        rows: series.map(r => columns.map(k => r[k]))
    };
}

/* ==========================================
   2-C. dQ/dV 피크 (직접 계산)

   기존에는 화면의 dQ/dV 표를 DOM 에서 긁어 왔다. 그 탭을 한 번도 열지 않으면
   표가 비어 있어 아무것도 전달되지 않았다. 상전이 진단은 양극 해석의 핵심이므로
   화면 상태와 무관하게 곡선 데이터에서 직접 계산한다.
   ========================================== */

const AI_DQDV_MIN_DV = 0.005;   // 이보다 작은 전압 간격은 잡음이 증폭되므로 건너뛴다
const AI_DQDV_SMOOTH = 5;       // 이동평균 창 크기
const AI_DQDV_REL_THRESHOLD = 0.15;  // 최대 피크 대비 이 비율 미만은 무시

// 봉우리의 상대 돌출도 임계. 봉우리가 양옆 골짜기보다 얼마나 솟아 있는지를
// 봉우리 높이로 나눈 값이다. 잡음으로 생긴 가짜 봉우리는 0 에 가깝다.
// 근거: 합성 곡선 실측에서 진짜 특징은 0.15~0.99(LFP 0.99, 스피넬 0.98,
// 층상 산화물 0.35~0.89)인 반면 특징 없는 곡선은 0.00~0.21 이었다.
// 처음에는 최대/중앙값 대비도를 썼으나 층상 산화물에서 진짜와 가짜의 간격이
// 1.5 대 1.2 수준으로 좁아 실제 NCM 피크를 버리는 문제가 있어 교체했다.
const AI_DQDV_MIN_PROMINENCE = 0.30;

/** [{voltage, capacity}] → [{v, d}] (d = |dQ/dV|, v = 구간 중앙 전압) */
function aiDqDvCurve(points) {
    if (!Array.isArray(points) || points.length < 3) return [];

    const clean = [];
    for (const p of points) {
        const v = parseFloat(p.voltage);
        const q = parseFloat(p.capacity);
        if (isFinite(v) && isFinite(q)) clean.push({ v: v, q: q });
    }
    if (clean.length < 3) return [];

    const raw = [];
    let i = 0;
    while (i < clean.length - 1) {
        let j = i + 1;
        while (j < clean.length && Math.abs(clean[j].v - clean[i].v) < AI_DQDV_MIN_DV) j++;
        if (j >= clean.length) break;

        const dv = clean[j].v - clean[i].v;
        const dq = clean[j].q - clean[i].q;
        if (dv !== 0) {
            raw.push({ v: (clean[i].v + clean[j].v) / 2, d: Math.abs(dq / dv) });
        }
        i = j;
    }
    if (raw.length < 3) return raw;

    // 이동평균 평활
    const half = Math.floor(AI_DQDV_SMOOTH / 2);
    const out = [];
    for (let k = 0; k < raw.length; k++) {
        let sum = 0, cnt = 0;
        for (let m = k - half; m <= k + half; m++) {
            if (m >= 0 && m < raw.length) { sum += raw[m].d; cnt++; }
        }
        out.push({ v: raw[k].v, d: sum / cnt });
    }
    return out;
}

/**
 * 봉우리의 돌출도. 양옆으로 자기보다 높은 지점을 만날 때까지 내려가며
 * 만난 골짜기 중 높은 쪽을 기준으로 삼는다(표준 prominence 정의).
 */
function aiPeakProminence(curve, k) {
    const h = curve[k].d;
    let i = k - 1, minL = h;
    while (i >= 0 && curve[i].d <= h) { if (curve[i].d < minL) minL = curve[i].d; i--; }
    let j = k + 1, minR = h;
    while (j < curve.length && curve[j].d <= h) { if (curve[j].d < minR) minR = curve[j].d; j++; }
    return h - Math.max(minL, minR);
}

/** dQ/dV 국소 최대값을 크기 순으로 골라 전압 순으로 정렬해 반환 */
function aiDqDvPeaks(points, maxPeaks) {
    const curve = aiDqDvCurve(points);
    if (curve.length < 3) return [];

    const peak = curve.reduce((a, b) => (b.d > a.d ? b : a), curve[0]).d;
    if (!(peak > 0)) return [];
    const floor = peak * AI_DQDV_REL_THRESHOLD;

    const found = [];
    for (let k = 1; k < curve.length - 1; k++) {
        if (!(curve[k].d >= floor && curve[k].d > curve[k - 1].d && curve[k].d >= curve[k + 1].d)) continue;
        // 잡음 봉우리를 걸러낸다
        const prom = aiPeakProminence(curve, k) / curve[k].d;
        if (prom < AI_DQDV_MIN_PROMINENCE) continue;
        found.push({ voltage_V: aiNum(curve[k].v, 3), dQdV: aiNum(curve[k].d, 1), prominence: aiNum(prom, 2) });
    }
    found.sort((a, b) => b.dQdV - a.dQdV);
    const top = found.slice(0, (typeof maxPeaks === 'number') ? maxPeaks : 5);
    top.sort((a, b) => a.voltage_V - b.voltage_V);
    return top;
}

/**
 * 대표 사이클의 충전·방전 dQ/dV 피크.
 * 첫 사이클과 마지막 사이클을 함께 주면 피크의 이동·감쇠를 비교할 수 있다.
 */
function aiDqDvSummary(pc) {
    const nums = Object.keys(pc).map(Number).sort((a, b) => a - b);
    if (nums.length === 0) return null;

    const pickCycle = (n) => {
        const c = pc[n];
        if (!c) return null;
        const dis = aiDqDvPeaks(c.sodiation, 5);
        const chg = aiDqDvPeaks(c.desodiation, 5);
        if (dis.length === 0 && chg.length === 0) return null;
        return { cycle: n, dischargePeaks: dis, chargePeaks: chg };
    };

    const first = pickCycle(nums[0]);
    const last = nums.length > 1 ? pickCycle(nums[nums.length - 1]) : null;

    // 피크가 잡히지 않았다면 "없음"을 이유와 함께 알린다.
    // 조용히 비워 보내면 AI 가 이 항목을 무시하거나 지어낼 수 있다.
    if (!first && !last) {
        return {
            note: '곡선에서 뚜렷한 dQ/dV 피크가 검출되지 않았다. 전압 곡선이 매끄러워 상전이에 해당하는 특징이 두드러지지 않는다는 뜻이다(고용체형 거동이거나 데이터 해상도가 낮은 경우). 이 항목을 근거로 상전이를 논하지 말 것.',
            first: null,
            last: null
        };
    }

    return {
        note: '곡선에서 직접 계산한 dQ/dV 국소 최대값이다(전압 간격 5 mV 미만 구간은 잡음으로 보아 제외, ' +
              '이동평균 5점 평활, 최대 피크의 15% 미만은 무시). 부호는 제거하고 크기만 싣는다. ' +
              '첫 사이클과 마지막 사이클의 피크 위치 이동과 크기 감소를 상전이 가역성의 지표로 삼을 것.',
        first: first,
        last: last
    };
}

/** 대표 사이클 충방전 곡선을 최대 maxPoints 개로 축약 ([용량, 전압] 쌍) */
function aiDownsampleCurve(points, maxPoints) {
    if (!points || points.length === 0) return [];

    const step = Math.max(1, Math.ceil(points.length / maxPoints));
    const out = [];
    for (let i = 0; i < points.length; i += step) {
        const p = points[i];
        if (!p) continue;
        out.push([+Number(p.capacity).toFixed(1), +Number(p.voltage).toFixed(4)]);
    }

    // 끝점은 곡선의 종단 용량을 나타내므로 반드시 포함
    const last = points[points.length - 1];
    if (last) {
        const lastPair = [+Number(last.capacity).toFixed(1), +Number(last.voltage).toFixed(4)];
        const tail = out[out.length - 1];
        if (!tail || tail[0] !== lastPair[0] || tail[1] !== lastPair[1]) out.push(lastPair);
    }
    return out;
}

/* ==========================================
   3. 화면에 렌더된 요약 테이블 스크랩
   (사용자가 실제로 보고 있는 표를 그대로 전달 → 설명이 화면과 어긋나지 않음)
   ========================================== */
function aiScrapeTable(selector) {
    const table = document.querySelector(selector);
    if (!table) return null;

    const rows = Array.from(table.querySelectorAll('tr')).map(tr =>
        Array.from(tr.querySelectorAll('th, td'))
            .map(cell => (cell.innerText || '').replace(/\s+/g, ' ').trim())
    );

    const cleaned = rows.filter(r => r.length > 0 && r.some(c => c !== ''));
    return cleaned.length > 0 ? cleaned : null;
}

/* ==========================================
   4. 분석 설정값 수집
   ========================================== */
function aiCollectSettings() {
    const unitBtn = document.querySelector('.rate-unit-btn.active');
    const stepSizeSel = document.getElementById('rateStepSize');
    const stepsInput = document.getElementById('rateStepsInput');

    return {
        plateauCutoffVoltage_V: cutoffVoltageInput ? parseFloat(cutoffVoltageInput.value) : null,
        slopePlateauTargetCycle: targetCycleSP ? (parseInt(targetCycleSP.value) || 1) : 1,
        rateStepSize_cyclesPerStep: stepSizeSel ? (parseInt(stepSizeSel.value) || 5) : 5,
        rateStepLabels: stepsInput ? stepsInput.value.trim() : '',
        rateUnit: unitBtn ? unitBtn.dataset.unit : 'crate',
        rateCapacityBasis: currentRateMode
    };
}

/* ==========================================
   5. 스냅샷 조립
   ========================================== */
function buildAiAnalysisSnapshot() {
    const settings = aiCollectSettings();
    const targets = aiAllAnalyzableDatasets();
    const defaultIds = aiDefaultSelectedIds();

    // 데이터셋 하나에서 예외가 나도 나머지는 살린다.
    // 예전에는 map 안에서 예외가 나면 스냅샷 전체가 실패해 팝업이 아무것도 못 받았다.
    const datasets = [];
    const failed = [];

    targets.forEach(ds => {
        try {
            datasets.push(aiBuildDatasetEntry(ds, settings, defaultIds));
        } catch (err) {
            console.error('데이터셋 지표 계산 실패:', ds && ds.dataName, err);
            failed.push({
                name: (ds && (ds.dataName || ds.customName)) || '(이름 없음)',
                reason: '지표 계산 중 오류: ' + (err && err.message ? err.message : String(err))
            });
        }
    });

    return {
        generatedAt: new Date().toISOString(),
        source: 'HC-Analyzer (ESMPL-Analyzer)',
        analysisSettings: settings,
        datasets: datasets,
        unavailableDatasets: aiUnavailableDatasets().concat(failed),
        libraryTotal: datasetLibrary.length,
        // 팝업이 자기 버전과 비교해 옛 문서인지 스스로 알아채기 위한 값
        expectedPopupVersion: AI_REPORT_PAGE_VERSION,
        onScreenTables: {
            overviewAndICE: aiScrapeTable('#tableOverviewMetrics'),
            slopePlateau: aiScrapeTable('#tableSlopePlateauMetrics'),
            rateSummary: aiScrapeTable('#tableRateSummary'),
            dqdvPeaks: aiScrapeTable('#tableDqDvPeaks')
        }
    };
}

/** 데이터셋 1개의 지표 묶음 생성 (실패 시 예외를 던져 호출부가 격리한다) */
function aiBuildDatasetEntry(ds, settings, defaultIds) {
    {
        const pc = ds.processedCycles;
        const nums = Object.keys(pc).map(Number).sort((a, b) => a - b);

        const det = (window.ExperimentDetector && typeof ExperimentDetector.detect === 'function')
            ? ExperimentDetector.detect(pc, ds.id)
            : null;

        const sp = aiComputeSlopePlateau(
            pc,
            settings.plateauCutoffVoltage_V,
            settings.slopePlateauTargetCycle
        );

        const rateSteps = aiRateSteps(pc);

        // 대표 곡선: Slope/Plateau 분석에 쓰인 사이클과 동일한 사이클을 사용
        const curveCycleNum = sp ? sp.cycle : (nums[0] || null);
        const curveData = curveCycleNum !== null ? pc[curveCycleNum] : null;

        return {
            id: ds.id,
            // 팝업의 체크박스 기본값. 최종 선택은 팝업에서 사용자가 정한다.
            defaultSelected: defaultIds.indexOf(ds.id) !== -1,
            isActiveInMainWindow: ds.id === activeDatasetId,
            lineColor: ds.lineColor || ds.color || null,
            name: ds.dataName || ds.customName || '(이름 없음)',
            sample: ds.sampleName || null,
            project: ds.projectName || null,
            experimentTypeSetByUser: ds.experimentType || null,
            experimentKindAutoDetected: det ? det.kind : null,
            autoDetectionReason: det ? det.reason : null,
            totalCycles: nums.length,
            cycleRange: nums.length ? [nums[0], nums[nums.length - 1]] : null,
            initialPerformance: aiComputeInitial(pc),
            slopePlateau: sp,
            rateCapability: rateSteps,
            cycleLife: aiComputeCycleLife(pc),
            cycleMetrics: aiCycleMetricsSeries(pc),
            dqdvPeaks: aiDqDvSummary(pc),
            representativeCurve: curveData ? {
                cycle: curveCycleNum,
                note: '[capacity_mAh_g, voltage_V] 쌍. 원본에서 최대 40점으로 축약됨.',
                sodiation: aiDownsampleCurve(curveData.sodiation, 40),
                desodiation: aiDownsampleCurve(curveData.desodiation, 40)
            } : null
        };
    }
}

/* ==========================================
   6. 팝업 창 열기 / 메시지 핸드셰이크
   ========================================== */
function openAiReportWindow() {
    // 활성 데이터셋이 없어도 라이브러리에 해석 가능한 것이 있으면 열어 준다.
    // (데이터 라이브러리에만 저장해 둔 상태에서도 바로 해석할 수 있어야 한다)
    if (aiAllAnalyzableDatasets().length === 0) {
        const unavailable = aiUnavailableDatasets();
        if (datasetLibrary.length === 0) {
            alert('데이터 라이브러리가 비어 있습니다.\n먼저 측정 파일을 업로드해 주세요.');
        } else if (unavailable.length > 0) {
            alert('라이브러리에 데이터셋은 있지만 충방전 해석이 가능한 것이 없습니다.\n\n' +
                  unavailable.slice(0, 5).map(u => `· ${u.name} — ${u.reason}`).join('\n'));
        } else {
            alert('해석할 수 있는 충방전 데이터가 없습니다.');
        }
        return;
    }

    // 이미 열려 있으면 새로 띄우지 않고 그 창을 앞으로 가져온다
    if (_aiReportWin && !_aiReportWin.closed) {
        _aiReportWin.focus();
        _aiReportWin.postMessage(
            { type: 'HCAI_PAYLOAD', payload: buildAiAnalysisSnapshot() },
            aiTargetOrigin()
        );
        return;
    }

    // [캐시] 버전 쿼리만으로는 부족하다. 버전을 올리기 전에 팝업을 한 번이라도 연
    // 브라우저는 그 URL을 캐시해 두고, 이후 같은 URL이면 옛 문서를 그대로 꺼내 쓴다.
    // 팝업 HTML은 60KB 남짓이라 매번 새로 받아도 부담이 없으므로, 매 호출마다
    // 고유 토큰을 붙여 캐시가 원천적으로 불가능하게 만든다.
    const popupUrl = 'ai-report.html?v=' + AI_REPORT_PAGE_VERSION + '&t=' + Date.now();

    _aiReportWin = window.open(
        popupUrl,
        AI_REPORT_WINDOW_NAME,
        'width=1040,height=920,menubar=no,toolbar=no,location=no,status=no'
    );

    if (!_aiReportWin) {
        alert('팝업이 차단되었습니다.\n브라우저 주소창의 팝업 차단 아이콘에서 이 사이트의 팝업을 허용해 주세요.');
    }
}

/**
 * 팝업이 보내오는 요청 처리.
 * 팝업은 로드 완료 시점과 "다시 불러오기" 클릭 시점에 HCAI_REQUEST_PAYLOAD 를 보낸다.
 */
function onAiReportMessage(event) {
    if (!aiOriginAllowed(event.origin)) return;
    if (!event.data || event.data.type !== 'HCAI_REQUEST_PAYLOAD') return;
    if (!event.source) return;

    let payload = null;
    try {
        payload = buildAiAnalysisSnapshot();
    } catch (err) {
        console.error('AI 스냅샷 생성 실패:', err);
        event.source.postMessage(
            { type: 'HCAI_ERROR', message: String(err && err.message ? err.message : err) },
            aiTargetOrigin()
        );
        return;
    }

    event.source.postMessage({ type: 'HCAI_PAYLOAD', payload: payload }, aiTargetOrigin());
}

function initAiReport() {
    const btn = document.getElementById('btnAiReport');
    if (btn) {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            openAiReportWindow();
        });
    }
    window.addEventListener('message', onAiReportMessage);
}

// 이 스크립트는 </body> 직전에 로드되므로 DOMContentLoaded 이전이지만,
// 캐시·확장 프로그램 등으로 늦게 실행될 경우를 대비해 상태를 확인한다.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAiReport);
} else {
    initAiReport();
}
