/* ============================================================================
 * HC-Analyzer  ·  16-combined-view.js
 * 역할: "데이터 한눈에 보기" 통합 뷰 — 체크박스로 선택한 여러 그래프
 *       (Voltage Profile / Slope-Plateau / Rate Capability / dQ/dV)를
 *       하나의 화면에서 동시에 렌더링합니다.
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 16/16  (이전: js/15-profile-cycles.js → 다음: (없음))
 *
 * [설계] 기존 탭의 차트 인스턴스(chartProfileInstance 등)와 충돌하지 않도록,
 *        13-charts.js / 12-dqdv.js 의 렌더 함수에 추가된 opts(canvasId·인스턴스
 *        get/set 콜백)를 사용해 통합 뷰 전용 캔버스에 독립적으로 그립니다.
 *        따라서 개별 탭과 통합 뷰를 오가도 서로의 차트를 파괴하지 않습니다.
 * ============================================================================ */

// 통합 뷰 전용 Chart.js 인스턴스 저장소 (기존 전역 인스턴스와 분리)
const combinedChartInstances = {
    profile: null,
    slope: null,
    rateCycles: null,
    rateSummary: null,
    dqdv: null
};

/**
 * 지정한 통합 뷰 차트 인스턴스를 안전하게 파괴합니다.
 */
function destroyCombinedChart(key) {
    if (combinedChartInstances[key]) {
        try { combinedChartInstances[key].destroy(); } catch (e) { /* 이미 파괴됨 */ }
        combinedChartInstances[key] = null;
    }
}

/**
 * 통합 뷰 탭이 현재 활성화되어 있는지 확인합니다.
 */
function isCombinedTabActive() {
    const panel = document.getElementById('tab-combined');
    return !!(panel && panel.classList.contains('active'));
}

/**
 * 체크박스 상태를 { profile, slope, rate, dqdv } 형태로 반환합니다.
 */
function getCombinedSelectedCharts() {
    const selection = { profile: false, slope: false, rate: false, dqdv: false };
    document.querySelectorAll('.combined-chart-toggle').forEach(cb => {
        const key = cb.getAttribute('data-chart');
        if (key in selection) selection[key] = cb.checked;
    });
    return selection;
}

/**
 * 통합 뷰를 렌더링합니다.
 * - 체크된 그래프의 카드만 표시하고 해당 캔버스에 렌더링합니다.
 * - 체크 해제된 그래프는 카드를 숨기고 인스턴스를 파괴합니다.
 * - 각 그래프는 개별 try/catch 로 보호되어, 하나가 실패해도 나머지는 정상 표시됩니다.
 */
function renderCombinedView() {
    const grid = document.getElementById('combinedChartGrid');
    const emptyMsg = document.getElementById('combinedEmptyMsg');
    if (!grid) return;

    const selection = getCombinedSelectedCharts();
    const cards = grid.querySelectorAll('.combined-card');

    // 1) 활성 데이터가 없는 경우: 모든 카드 숨김 + 안내 메시지
    if (typeof hasActiveDataset === 'function' && !hasActiveDataset()) {
        ['profile', 'slope', 'rateCycles', 'rateSummary', 'dqdv'].forEach(destroyCombinedChart);
        cards.forEach(card => { card.style.display = 'none'; });
        if (emptyMsg) {
            emptyMsg.textContent = '분석할 데이터가 없습니다. 데이터를 업로드하거나 라이브러리에서 데이터셋을 활성화해 주세요.';
            emptyMsg.style.display = 'block';
        }
        return;
    }

    // 2) 선택된 그래프가 하나도 없는 경우: 안내 메시지
    const anySelected = selection.profile || selection.slope || selection.rate || selection.dqdv;
    if (!anySelected) {
        ['profile', 'slope', 'rateCycles', 'rateSummary', 'dqdv'].forEach(destroyCombinedChart);
        cards.forEach(card => { card.style.display = 'none'; });
        if (emptyMsg) {
            emptyMsg.textContent = '위에서 표시할 그래프를 하나 이상 선택하세요.';
            emptyMsg.style.display = 'block';
        }
        return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    // 3) 카드 표시/숨김 갱신 (렌더 전에 표시해야 캔버스 크기가 확정됨)
    cards.forEach(card => {
        const key = card.getAttribute('data-chart');
        card.style.display = selection[key] ? 'flex' : 'none';
    });

    // 4) Voltage Profile
    if (selection.profile) {
        try {
            renderOverviewChart(null, false, {
                canvasId: 'combinedChartProfile',
                getInstance: () => combinedChartInstances.profile,
                setInstance: (inst) => { combinedChartInstances.profile = inst; }
            });
        } catch (e) {
            console.error('[통합 뷰] 전압 프로파일 렌더 오류:', e);
        }
    } else {
        destroyCombinedChart('profile');
    }

    // 5) Slope / Plateau
    if (selection.slope) {
        try {
            const spCycleNum = parseInt((targetCycleSP && targetCycleSP.value) || '1') || 1;
            const spCycleData = (typeof processedCycles !== 'undefined') ? processedCycles[spCycleNum] : null;
            const cutoffV = (cutoffVoltageInput && !isNaN(parseFloat(cutoffVoltageInput.value)))
                ? parseFloat(cutoffVoltageInput.value)
                : 0.10;
            renderSlopePlateauChart(spCycleData, cutoffV, {
                canvasId: 'combinedChartSlope',
                getInstance: () => combinedChartInstances.slope,
                setInstance: (inst) => { combinedChartInstances.slope = inst; }
            });
        } catch (e) {
            console.error('[통합 뷰] Slope/Plateau 렌더 오류:', e);
        }
    } else {
        destroyCombinedChart('slope');
    }

    // 6) Rate Capability (사이클 추이 + 단계별 요약 두 차트)
    if (selection.rate) {
        try {
            renderRateCapabilityCharts({
                cyclesCanvasId: 'combinedChartRateCycles',
                summaryCanvasId: 'combinedChartRateSummary',
                getCyclesInstance: () => combinedChartInstances.rateCycles,
                setCyclesInstance: (inst) => { combinedChartInstances.rateCycles = inst; },
                getSummaryInstance: () => combinedChartInstances.rateSummary,
                setSummaryInstance: (inst) => { combinedChartInstances.rateSummary = inst; }
            });
        } catch (e) {
            console.error('[통합 뷰] Rate Capability 렌더 오류:', e);
        }
    } else {
        destroyCombinedChart('rateCycles');
        destroyCombinedChart('rateSummary');
    }

    // 7) dQ/dV (통합 뷰에서는 차트만, 피크 요약 테이블 갱신은 생략)
    if (selection.dqdv) {
        try {
            renderDqDvChart({
                canvasId: 'combinedChartDqDv',
                getInstance: () => combinedChartInstances.dqdv,
                setInstance: (inst) => { combinedChartInstances.dqdv = inst; },
                skipTable: true
            });
        } catch (e) {
            console.error('[통합 뷰] dQ/dV 렌더 오류:', e);
        }
    } else {
        destroyCombinedChart('dqdv');
    }
}

/**
 * 통합 뷰 탭이 현재 활성 상태일 때만 다시 렌더링합니다.
 * (runAnalysis 등 데이터 갱신 후 호출되어 통합 뷰를 최신 상태로 유지)
 */
function refreshCombinedIfActive() {
    if (isCombinedTabActive()) {
        renderCombinedView();
    }
}

/**
 * 통합 뷰 이벤트 초기화.
 */
function initCombinedView() {
    // 체크박스 토글 시 즉시 재렌더링
    document.querySelectorAll('.combined-chart-toggle').forEach(cb => {
        cb.addEventListener('change', renderCombinedView);
    });

    // 통합 뷰 탭 진입 시 렌더링.
    // 01-core.js 의 initTabs 핸들러가 먼저 active 클래스를 부여하므로,
    // 레이아웃이 확정된 뒤(setTimeout) 캔버스 크기를 올바르게 잡아 렌더링합니다.
    const tabBtn = document.querySelector('.tab-btn[data-tab="tab-combined"]');
    if (tabBtn) {
        tabBtn.addEventListener('click', () => {
            setTimeout(() => {
                if (isCombinedTabActive()) renderCombinedView();
            }, 130);
        });
    }
}

// 통합 뷰 자체 초기화 (01-core.js 의 DOMContentLoaded 와 별개로 등록되어도 안전)
document.addEventListener('DOMContentLoaded', () => {
    initCombinedView();
});
