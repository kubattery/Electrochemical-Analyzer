/* ============================================================================
 * HC-Analyzer  ·  01-core.js
 * 역할: 전역 상태·유틸리티·DOM 참조 · 앱 부트스트랩(DOMContentLoaded) · 탭 전환
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 01/15  (이전: (없음) → 다음: js/02-file-upload.js)
 * ============================================================================ */
/**
 * Hard Carbon Electrochemical Analyzer - Core Application Logic
 * 작성자: 20년차 배터리 소재 전공 교수 관점의 분석 엔진
 */

// Global State
let rawBatteryData = [];
let headerColumns = [];
let mappedColumns = {
    cycle: -1,
    voltage: -1,
    capacity: -1,
    current: -1
};
let processedCycles = {}; // cycleNum -> { sodiation: [], desodiation: [], totalDischargeCap: 0, totalChargeCap: 0 }
let rateCapabilitySummary = []; // Array of C-rate summaries
let currentRateMode = 'charge'; // 'charge' or 'discharge' 용량 기준 모드
let selectedDqDvCycles = [1]; // dQ/dV 분석 탭용 선택된 다중 사이클 번호 배열
let selectedProfileCycles = [1]; // 전압 프로파일 탭용 선택된 다중 사이클 번호 배열
let isProfileCycleAll = true; // 개요 전압 프로파일 전체 사이클 선택 상태 기본 활성화 여부

// ============================================================
// 멀티 데이터셋 라이브러리 전역 상태 (자동 변환 데이터 관리 구조 개편)
// ============================================================
let datasetLibrary = []; // 저장된 데이터셋 목록
let activeDatasetId = null; // 현재 단일 분석 중인 데이터셋 ID

const EXPERIMENT_TYPES = [
    { key: "rate", label: "Rate" },
    { key: "cycle_performance", label: "Cycle performance" },
    { key: "gitt", label: "GITT" },
    { key: "cv", label: "CV" }
];

let projects = JSON.parse(localStorage.getItem('hc_projects')) || ["Default Project"];
let activeProjectId = localStorage.getItem('hc_active_project_id') || "Default Project";
let sampleColors = JSON.parse(localStorage.getItem('hc_sample_colors')) || {};
let currentLibraryFilter = "all"; // 사이드바 필터 칩 상태

// ============================================================
// 다중 파일 업로드용 큐 상태
// ============================================================
let _fileQueue = [];           // 업로드 대기 중인 File 객체 배열
let _parsedQueue = [];         // 파싱 완료된 { filename, processedCycles, rawData } 배열

// GITT 차단과 일반 파싱 실패를 구분하기 위한 센티넬 상수
const PARSE_BLOCKED_GITT = 'GITT_BLOCKED';

// 데이터셋 색상 팔레트 (최대 8개 데이터셋 지원)
const DATASET_COLORS = [
    '#60a5fa', // 파란색
    '#f472b6', // 핑크
    '#34d399', // 초록
    '#fbbf24', // 노랑
    '#a78bfa', // 보라
    '#fb923c', // 주황
    '#22d3ee', // 시안
    '#f87171', // 빨강
];

/**
 * Hex 색상 문자열을 투명도가 적용된 RGBA 문자열로 변환합니다.
 */
function hexToRgba(hex, alpha) {
    hex = hex.replace('#', '');
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * HTML 특수문자를 이스케이프하여 XSS를 방지합니다.
 */
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * 현재 활성화되어 분석 중인 데이터셋이 존재하는지 확인합니다.
 */
function hasActiveDataset() {
    return activeDatasetId !== null && Object.keys(processedCycles).length > 0;
}

// Charts Instances
let chartProfileInstance = null;
let chartSlopePlateauInstance = null;
let chartRateCyclesInstance = null;
let chartRateSummaryInstance = null;
let chartDqDvInstance = null;

// DOM Elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const welcomeView = document.getElementById('welcomeView');
const activeFilename = document.getElementById('activeFilename');
const targetDirectionProfile = document.getElementById('targetDirectionProfile');
const btnDownloadProfileExcel = document.getElementById('btnDownloadProfileExcel');

// Profile Multi-Cycle Controls
const profileCycleChipsContainer = document.getElementById('profileCycleChipsContainer');
const btnProfileCycleAll = document.getElementById('btnProfileCycleAll');
const btnProfileCycleClear = document.getElementById('btnProfileCycleClear');
const btnProfileCycleOdd = document.getElementById('btnProfileCycleOdd');
const btnProfileCycleEven = document.getElementById('btnProfileCycleEven');

// Analysis Inputs
const cutoffVoltageInput = document.getElementById('cutoffVoltage');
const cutoffValDisplay = document.getElementById('cutoffValDisplay');
const targetCycleSelect = document.getElementById('targetCycle');
const targetCycleSelectSP = document.getElementById('targetCycleSP');
const targetCycleDqDv = document.getElementById('targetCycleDqDv');
const selectDqDvMode = document.getElementById('selectDqDvMode');
const dqdvStepV = document.getElementById('dqdvStepV');
const dqdvStepVVal = document.getElementById('dqdvStepVVal');
const dqdvQo = document.getElementById('dqdvQo');
const dqdvMass = document.getElementById('dqdvMass');
const dqdvPostAvg = document.getElementById('dqdvPostAvg');
// Metric Displays

// GITT State & Charts (Stub & 가드용 상태 유지)
let isGittMode = false;

// 메인 모드 상태 및 DOM 엘리먼트 정의
let currentAnalysisMode = 'general'; // 'general' 고정
const rateConfigPanel = document.getElementById('rateConfigPanel');




// Export Buttons
const btnDownloadProfile = document.getElementById('btnDownloadProfile');
const btnDownloadSlopeChart = document.getElementById('btnDownloadSlopeChart');
const btnDownloadRateData = document.getElementById('btnDownloadRateData');
const btnDownloadRateDetailData = document.getElementById('btnDownloadRateDetailData');

// Tables
const tableRateSummary = document.getElementById('tableRateSummary');
const tableDqDvPeaks = document.getElementById('tableDqDvPeaks');

// Tab Selection
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

/* ==========================================
   1. Event Listeners & Initialization
   ========================================== */
document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    initFileUpload();
    initAnalysisControls();
    initExportFeatures();
    initRateToggle(); // C-rate 모드 전환 이벤트 초기화
    initDatasetLibrary(); // 데이터셋 라이브러리 이벤트 초기화
    // GITT 분석 버튼 클릭 시 gitt.html 새 탭으로 열기 리스너
    const btnGittComingSoon = document.getElementById('btnGittComingSoon');
    if (btnGittComingSoon) {
        btnGittComingSoon.addEventListener('click', (e) => {
            e.preventDefault();
            window.open('gitt.html', '_blank');
        });
    }

    // 최초 로드 시 기본 분석 모드 UI 정렬 수행 (탭 숨김, 사이드바 정렬 등)
    setAnalysisMode('general');

    // 데이터셋 초기 로드 완료 후 칩 UI 생성
    renderCycleChipsUI();

    // 프로젝트, 업데이트, 데모 모드, 필터 초기화
    initProjectManagement();
    initDataUpdate();
    initDemoMode();
    initLibraryFilterChips();

    // 탭 검색 및 필터 이벤트 바인딩
    const libTabSearch = document.getElementById('libTabSearch');
    const libTabProjectFilter = document.getElementById('libTabProjectFilter');
    const libTabTypeFilter = document.getElementById('libTabTypeFilter');
    const libTabStatusFilter = document.getElementById('libTabStatusFilter');
    const libTabSort = document.getElementById('libTabSort');

    if (libTabSearch) libTabSearch.addEventListener('input', renderLibraryTable);
    if (libTabProjectFilter) libTabProjectFilter.addEventListener('change', renderLibraryTable);
    if (libTabTypeFilter) libTabTypeFilter.addEventListener('change', renderLibraryTable);
    if (libTabStatusFilter) libTabStatusFilter.addEventListener('change', renderLibraryTable);
    if (libTabSort) libTabSort.addEventListener('change', renderLibraryTable);

    // DB에서 기존 저장된 데이터셋 비동기 로드 및 복원
    try {
        const savedDS = await loadDatasetsFromDB();
        if (savedDS && savedDS.length > 0) {
            datasetLibrary = savedDS.map(normalizeDataset);
            renderDatasetLibraryUI();
            renderLibraryTable();
            
            // 처음 웹사이트 진입 시에는 무조건 일반 분석 창만 띄우도록 제어합니다.
            // 일반 분석 데이터셋 중 가장 최신 것(가장 마지막에 추가된 것)을 찾아서 활성화합니다.
            const lastGeneralDs = [...datasetLibrary].reverse().find(ds => !ds.isGitt);
            if (lastGeneralDs) {
                switchActiveDataset(lastGeneralDs.id);
            } else {
                // 일반 분석 데이터셋이 아예 존재하지 않는 경우, 빈 일반 분석 창을 유지합니다.
                activeDatasetId = null;
                setAnalysisMode('general');
            }
            if (welcomeView) welcomeView.style.display = 'none';
        } else {
            // 저장된 기존 데이터가 없을 때는 웰컴 화면을 정상 노출하여 데모 시작이 가능하도록 함
            if (welcomeView) welcomeView.style.display = 'flex';
            renderDatasetLibraryUI();
            renderLibraryTable();
        }
    } catch (err) {
        console.error("초기 데이터셋 로드 오류:", err);
        if (welcomeView) welcomeView.style.display = 'flex';
        renderDatasetLibraryUI();
        renderLibraryTable();
    }
});

// Tab Switching Logic
function initTabs() {
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            if (!tabId) return;

            // 데이터 라이브러리 탭(tab-library)은 활성 데이터셋이 없어도 언제나 진입을 허용합니다.
            // Rate/Cycle 탭(tab-rate)은 Cyclability 하위 뷰가 자체 파일 업로드를 쓰므로 데이터 없이도 진입 허용합니다.
            if (tabId !== 'tab-library' && tabId !== 'tab-rate' && !hasActiveDataset()) return; // No data loaded

            const tabPanel = document.getElementById(tabId);
            if (!tabPanel) return; // 해당 패널이 DOM에 없으면 스킵

            tabButtons.forEach(b => b.classList.remove('active'));
            tabPanels.forEach(p => p.classList.remove('active'));
            
            btn.classList.add('active');
            tabPanel.classList.add('active');
            
            // Re-render chart on tab display to fix sizing issues
            setTimeout(() => {
                triggerChartResize();
                if (tabId === 'tab-dqdv') {
                    updateDqDvView();
                }
            }, 100);
        });
    });
}

function triggerChartResize() {
    if (chartProfileInstance) chartProfileInstance.resize();
    if (chartSlopePlateauInstance) chartSlopePlateauInstance.resize();
    if (chartRateCyclesInstance) chartRateCyclesInstance.resize();
    if (chartRateSummaryInstance) chartRateSummaryInstance.resize();
    if (chartDqDvInstance) chartDqDvInstance.resize();
}
