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
const AI_REPORT_PAGE_VERSION = '1.1.0';

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

/** 충방전 분석이 가능한 데이터셋 전부 (GITT 등 CC/CV가 아닌 것은 제외) */
function aiAllAnalyzableDatasets() {
    return datasetLibrary.filter(ds =>
        ds && !ds.isGitt && ds.processedCycles && Object.keys(ds.processedCycles).length > 0);
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

/** 1st 사이클 기준 초기 용량 및 ICE — updateOverviewMetricsTable() 과 동일 */
function aiComputeInitial(pc) {
    const first = pc[1] || Object.values(pc)[0];
    if (!first) return null;

    const initDischarge = first.totalDischargeCap || 0;
    const initCharge = first.totalChargeCap || 0;
    const ice = initDischarge > 0 ? (initCharge / initDischarge) * 100 : null;

    return {
        initialDischargeCapacity_mAh_g: +initDischarge.toFixed(2),
        initialChargeCapacity_mAh_g: +initCharge.toFixed(2),
        ICE_percent: ice === null ? null : +ice.toFixed(2)
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
            slopeCapacity = sodPoints[cutoffIndex].capacity;
            plateauCapacity = (cycleData.totalDischargeCap || 0) - slopeCapacity;
        }
    }

    const totalCap = slopeCapacity + plateauCapacity;

    return {
        cycle: cNum,
        cutoffVoltage_V: cutoffV,
        slopeCapacity_mAh_g: +slopeCapacity.toFixed(2),
        plateauCapacity_mAh_g: +plateauCapacity.toFixed(2),
        totalCapacity_mAh_g: +totalCap.toFixed(2),
        slopeRatio_percent: totalCap > 0 ? +((slopeCapacity / totalCap) * 100).toFixed(2) : null,
        plateauRatio_percent: totalCap > 0 ? +((plateauCapacity / totalCap) * 100).toFixed(2) : null
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
        firstCapacity_mAh_g: +first.y.toFixed(2),
        lastCycle: last.x,
        lastCapacity_mAh_g: +last.y.toFixed(2),
        capacityRetention_percent: first.y > 0 ? +((last.y / first.y) * 100).toFixed(2) : null,
        averageCoulombicEfficiency_percent: avgCE === null ? null : +avgCE.toFixed(2)
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

    const datasets = targets.map(ds => {
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

        const rateSteps = (typeof buildRateSummaryForDataset === 'function')
            ? buildRateSummaryForDataset(pc).map(s => ({
                rate: s.rate,
                cycleRange: s.cycleRange,
                averageCapacity_mAh_g: +s.avgCharge.toFixed(2),
                retention_percent: +s.retention.toFixed(2),
                averageCoulombicEfficiency_percent: +s.avgCE.toFixed(2)
            }))
            : [];

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
            representativeCurve: curveData ? {
                cycle: curveCycleNum,
                note: '[capacity_mAh_g, voltage_V] 쌍. 원본에서 최대 40점으로 축약됨.',
                sodiation: aiDownsampleCurve(curveData.sodiation, 40),
                desodiation: aiDownsampleCurve(curveData.desodiation, 40)
            } : null
        };
    });

    return {
        generatedAt: new Date().toISOString(),
        source: 'HC-Analyzer (ESMPL-Analyzer)',
        analysisSettings: settings,
        datasets: datasets,
        onScreenTables: {
            overviewAndICE: aiScrapeTable('#tableOverviewMetrics'),
            slopePlateau: aiScrapeTable('#tableSlopePlateauMetrics'),
            rateSummary: aiScrapeTable('#tableRateSummary'),
            dqdvPeaks: aiScrapeTable('#tableDqDvPeaks')
        }
    };
}

/* ==========================================
   6. 팝업 창 열기 / 메시지 핸드셰이크
   ========================================== */
function openAiReportWindow() {
    if (!hasActiveDataset()) {
        alert('먼저 분석할 데이터를 불러와 주세요.\nAI 해석은 계산된 분석 결과를 바탕으로 작성됩니다.');
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

    _aiReportWin = window.open(
        'ai-report.html?v=' + AI_REPORT_PAGE_VERSION,
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
