/* ============================================================================
 * HC-Analyzer  ·  13-charts.js
 * 역할: 차트 렌더링(전압 프로파일 / Slope-Plateau / Rate)
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 13/15  (이전: js/12-dqdv.js → 다음: js/14-export.js)
 * ============================================================================ */
/* ==========================================
   4. Chart.js Visualization Rendering
   ========================================== */
/**
 * 대용량 데이터 렌더링 시 브라우저 렉(응답없음)을 방지하기 위한 최대 포인트 다운샘플링 함수
 */
function downsamplePoints(points, maxPoints = 1500) {
    if (!points || points.length <= maxPoints) return points || [];
    const step = Math.ceil(points.length / maxPoints);
    const sampled = [];
    for (let i = 0; i < points.length; i += step) {
        sampled.push(points[i]);
    }
    if (sampled.length > 0 && points.length > 0 && sampled[sampled.length - 1] !== points[points.length - 1]) {
        sampled.push(points[points.length - 1]);
    }
    return sampled;
}

/**
 * 전압 프로파일 라인 색상 결정 함수
 */
function getProfileLineColor(ds, cycleIndex, totalCycles, selectedDatasetCount) {
    if (selectedDatasetCount >= 2) {
        // 비교 모드: 같은 dataset은 동일 색상 계열에서 opacity만 다르게 함
        const opacity = 0.25 + (cycleIndex * 0.75 / Math.max(1, totalCycles - 1));
        return hexToRgba(ds.lineColor || ds.color, opacity);
    } else {
        // 단일 모드: 각 cycle마다 HSLA 팔레트 색상 부여
        const hue = cycleIndex * 280 / Math.max(1, totalCycles - 1);
        return `hsla(${hue}, 85%, 55%, 0.85)`;
    }
}

function renderOverviewChart(cycleData, isAll = false) {
    const ctx = document.getElementById('chartProfile').getContext('2d');
    
    if (chartProfileInstance) {
        chartProfileInstance.destroy();
    }

    const datasets = [];
    const checkedDS = getCheckedDatasets();
    const direction = targetDirectionProfile ? targetDirectionProfile.value : 'all';

    // 1. 그릴 대상 데이터셋 결정 (요구사항 1번 룰 준수)
    let displayDS = [];
    if (checkedDS.length >= 1) {
        displayDS = checkedDS;
    } else {
        const activeDs = datasetLibrary.find(d => d.id === activeDatasetId);
        displayDS = activeDs ? [activeDs] : [];
    }
    if (displayDS.length === 0) return;

    const selectedDatasetCount = displayDS.length;

    if (isProfileCycleAll) {
        // ===== 전체 사이클 모드 =====
        displayDS.forEach(ds => {
            const dsCycles = Object.keys(ds.processedCycles).map(Number).sort((a, b) => a - b);
            const totalCycles = dsCycles.length;
            if (totalCycles === 0) return;

            dsCycles.forEach((cNum, idx) => {
                const cyc = ds.processedCycles[cNum];
                if (!cyc) return;

                const sodData = downsamplePoints((cyc.sodiation || []).map(p => ({ x: p.capacity, y: p.voltage })), 300);
                const desodData = downsamplePoints((cyc.desodiation || []).map(p => ({ x: p.capacity, y: p.voltage })), 300);

                const color = getProfileLineColor(ds, idx, totalCycles, selectedDatasetCount);
                
                let drawSod = (direction === 'all' || direction === 'discharge');
                let drawDesod = (direction === 'all' || direction === 'charge');

                // 2. 단일 데이터셋 모드는 범례가 숨겨지므로 label은 undefined 처리.
                // 3. 다중 데이터셋 모드는 첫 번째 사이클(idx === 0)에만 데이터명 라벨 부여.
                let labelName = undefined;
                if (selectedDatasetCount >= 2) {
                    labelName = (idx === 0 && drawSod) ? (ds.dataName || ds.customName || ds.filename) : undefined;
                }

                // sodiation (discharge)
                if (drawSod && sodData.length > 0) {
                    datasets.push({
                        label: labelName,
                        data: sodData,
                        borderColor: color,
                        borderDash: [],
                        backgroundColor: 'transparent',
                        showLine: true,
                        pointRadius: 0,
                        fill: false,
                        borderWidth: 1.5,
                        tension: 0.1
                    });
                }

                // desodiation (charge)
                // 만약 방전이 켜져있었다면 방전에 이미 라벨을 줬으므로 충전은 무조건 undefined 처리.
                // 방전이 꺼져있고 충전만 그리는 경우에만 충전에 라벨 부여.
                let labelForDesod = undefined;
                if (selectedDatasetCount >= 2) {
                    labelForDesod = (idx === 0 && drawDesod && !drawSod) ? (ds.dataName || ds.customName || ds.filename) : undefined;
                }

                if (drawDesod && desodData.length > 0) {
                    datasets.push({
                        label: labelForDesod,
                        data: desodData,
                        borderColor: color,
                        borderDash: [],
                        backgroundColor: 'transparent',
                        showLine: true,
                        pointRadius: 0,
                        fill: false,
                        borderWidth: 1.5,
                        tension: 0.1
                    });
                }
            });
        });
    } else {
        // ===== 특정 사이클 선택 모드 =====
        displayDS.forEach(ds => {
            const dsCycles = Object.keys(ds.processedCycles).map(Number).sort((a, b) => a - b);
            if (dsCycles.length === 0) return;

            const targetCyclesToDraw = [];
            selectedProfileCycles.forEach(targetCNum => {
                if (dsCycles.includes(targetCNum)) {
                    targetCyclesToDraw.push(targetCNum);
                } else if (selectedProfileCycles.length === 1) {
                    const fallbackCNum = dsCycles.reduce((prev, curr) => Math.abs(curr - targetCNum) < Math.abs(prev - targetCNum) ? curr : prev);
                    targetCyclesToDraw.push(fallbackCNum);
                }
            });

            const totalCycles = targetCyclesToDraw.length;

            targetCyclesToDraw.forEach((cNum, idx) => {
                const cyc = ds.processedCycles[cNum];
                if (!cyc) return;

                const maxPts = (selectedDatasetCount === 1 && totalCycles === 1) ? 1500 : 600;
                const sodData = downsamplePoints((cyc.sodiation || []).map(p => ({ x: p.capacity, y: p.voltage })), maxPts);
                const desodData = downsamplePoints((cyc.desodiation || []).map(p => ({ x: p.capacity, y: p.voltage })), maxPts);

                const color = getProfileLineColor(ds, idx, totalCycles, selectedDatasetCount);
                
                let drawSod = (direction === 'all' || direction === 'discharge');
                let drawDesod = (direction === 'all' || direction === 'charge');

                let labelName = undefined;
                if (selectedDatasetCount >= 2) {
                    labelName = (idx === 0 && drawSod) ? (ds.dataName || ds.customName || ds.filename) : undefined;
                }

                // sodiation
                if (drawSod && sodData.length > 0) {
                    datasets.push({
                        label: labelName,
                        data: sodData,
                        borderColor: color,
                        borderDash: [],
                        backgroundColor: 'transparent',
                        showLine: true,
                        borderWidth: 2.5,
                        pointRadius: 0,
                        fill: false,
                        tension: 0.1
                    });
                }

                // desodiation
                let labelForDesod = undefined;
                if (selectedDatasetCount >= 2) {
                    labelForDesod = (idx === 0 && drawDesod && !drawSod) ? (ds.dataName || ds.customName || ds.filename) : undefined;
                }

                if (drawDesod && desodData.length > 0) {
                    datasets.push({
                        label: labelForDesod,
                        data: desodData,
                        borderColor: color,
                        borderDash: [],
                        backgroundColor: 'transparent',
                        showLine: true,
                        borderWidth: 2.5,
                        pointRadius: 0,
                        fill: false,
                        tension: 0.1
                    });
                }
            });
        });
    }

    // 2개 이상의 데이터셋 비교 상태일 때만 legend 노출 (selectedDatasetCount >= 2)
    const showLegend = selectedDatasetCount >= 2;
    const seenDatasetLabels = new Set();

    chartProfileInstance = new Chart(ctx, {
        type: 'scatter',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: (isProfileCycleAll && selectedDatasetCount === 1) ? 0 : 400 },
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Specific Capacity (mAh/g)', color: '#fff', font: { size: 12, weight: '600' } },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af' }
                },
                y: {
                    type: 'linear',
                    title: { display: true, text: 'Voltage (V vs. Na/Na+)', color: '#fff', font: { size: 12, weight: '600' } },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af' }
                }
            },
            plugins: {
                legend: {
                    display: showLegend,
                    labels: {
                        color: '#fff',
                        filter: function(item, chart) {
                            // 5. 빈 라벨, undefined 라벨 거름
                            if (!item.text || item.text === 'undefined') return false;
                            
                            // 중복 데이터셋 이름 단일화
                            const cleanText = item.text.split(' (')[0];
                            if (seenDatasetLabels.has(cleanText)) {
                                return false;
                            }
                            seenDatasetLabels.add(cleanText);
                            return true;
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `Cap: ${context.parsed.x.toFixed(2)} mAh/g, Volt: ${context.parsed.y.toFixed(4)} V`;
                        }
                    }
                }
            }
        }
    });
}

function renderSlopePlateauChart(cycleData, cutoffV) {
    const ctx = document.getElementById('chartSlopePlateau').getContext('2d');
    if (chartSlopePlateauInstance) chartSlopePlateauInstance.destroy();
 
    const checkedDS = getCheckedDatasets();
    const isCompareMode = checkedDS.length >= 2;
 
    let chartDatasets = [];
 
    if (isCompareMode) {
        // ===== 비교 모드: 체크된 데이터셋마다 전압 프로파일 창에서 선택된 사이클 기준으로 방전(Sodiation) 코스 오버레이 =====
        const targetCycleNum = parseInt(targetCycleSP.value) || 1;
 
        checkedDS.forEach(ds => {
            if (!ds || !ds.processedCycles) return; // 안전장치: GITT 데이터셋 등 CC/CV가 아닌 것은 스킵
            const dsCycles = Object.keys(ds.processedCycles).map(Number).sort((a, b) => a - b);
            if (dsCycles.length === 0) return;
 
            let cNum = targetCycleNum;
            if (!dsCycles.includes(cNum)) {
                // 선택된 사이클이 없을 경우 가장 가까운 사이클로 폴백
                cNum = dsCycles.reduce((prev, curr) => Math.abs(curr - targetCycleNum) < Math.abs(prev - targetCycleNum) ? curr : prev);
            }
 
            const cyc = ds.processedCycles[cNum];
            if (!cyc || !cyc.sodiation) return;
 
            // 개요 창과 동일하게 전체 방전 데이터를 먼저 다운샘플링하여 끊김을 방지합니다.
            const allData = downsamplePoints(
                cyc.sodiation.map(p => ({ x: p.capacity, y: p.voltage })), 1500
            );
 
            chartDatasets.push({
                label: `${ds.customName} (Cycle ${cNum})`,
                data: allData,
                borderColor: ds.lineColor,
                backgroundColor: 'transparent',
                showLine: true,
                borderWidth: 2.5,
                pointRadius: 0,
                fill: false,
                tension: 0.1
            });
        });
 
        // Cut-off 선 추가 (다중 데이터셋 중 해당 사이클의 가장 큰 방전 용량 기준)
        const maxCap = Math.max(...checkedDS.map(ds => {
            const dsCycles = Object.keys(ds.processedCycles).map(Number).sort((a, b) => a - b);
            if (dsCycles.length === 0) return 0;
 
            let cNum = targetCycleNum;
            if (!dsCycles.includes(cNum)) {
                cNum = dsCycles.reduce((prev, curr) => Math.abs(curr - targetCycleNum) < Math.abs(prev - targetCycleNum) ? curr : prev);
            }
            const cyc = ds.processedCycles[cNum];
            return cyc ? (cyc.totalDischargeCap || 0) : 0;
        }));
        chartDatasets.push({
            label: `Cut-off (${cutoffV.toFixed(2)} V)`,
            data: [{ x: 0, y: cutoffV }, { x: maxCap * 1.05, y: cutoffV }],
            borderColor: 'rgba(239, 68, 68, 0.65)',
            borderWidth: 1.5,
            borderDash: [5, 5],
            showLine: true,
            pointRadius: 0,
            fill: false
        });
    } else {
        // ===== 단일 데이터셋: Slope/Plateau 영역 하이라이트 (lineColor 톤 유지) =====
        if (!cycleData) { chartSlopePlateauInstance = null; return; }
        
        const activeDs = datasetLibrary.find(d => d.id === activeDatasetId);
        const baseColor = activeDs ? activeDs.lineColor : '#60a5fa';
 
        // 개요 창과 동일하게 전체 방전 데이터를 먼저 다운샘플링합니다.
        const allSodData = downsamplePoints(
            cycleData.sodiation.map(p => ({ x: p.capacity, y: p.voltage })), 1500
        );
 
        let slopeData = [];
        let plateauData = [];
 
        // 다운샘플링된 전체 데이터에서 cutoffV 이하로 떨어지는 첫 번째 지점을 찾습니다.
        const transitionIdx = allSodData.findIndex(p => p.y <= cutoffV);
        if (transitionIdx === -1) {
            slopeData = allSodData;
        } else {
            // Slope와 Plateau 영역이 매끄럽게 이어지도록 경계 포인트(transitionIdx)를 둘 다에 포함합니다.
            slopeData = allSodData.slice(0, transitionIdx + 1);
            plateauData = allSodData.slice(transitionIdx);
        }
 
        chartDatasets = [
            {
                label: `Slope Region (> ${cutoffV.toFixed(2)} V)`,
                data: slopeData,
                borderColor: baseColor,
                backgroundColor: hexToRgba(baseColor, 0.12),
                showLine: true, borderWidth: 3, pointRadius: 0, fill: true, tension: 0.1
            },
            {
                label: `Plateau Region (≤ ${cutoffV.toFixed(2)} V)`,
                data: plateauData,
                borderColor: hexToRgba(baseColor, 0.6),
                borderDash: [5, 5],
                backgroundColor: hexToRgba(baseColor, 0.04),
                showLine: true, borderWidth: 3, pointRadius: 0, fill: true, tension: 0.1
            },
            {
                label: 'Cut-off Voltage',
                data: [{ x: 0, y: cutoffV }, { x: cycleData.totalDischargeCap * 1.05, y: cutoffV }],
                borderColor: 'rgba(239, 68, 68, 0.65)',
                borderWidth: 1.5, borderDash: [5, 5], showLine: true, pointRadius: 0, fill: false
            }
        ];
    }
 
    chartSlopePlateauInstance = new Chart(ctx, {
        type: 'scatter',
        data: { datasets: chartDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Discharge Capacity (mAh/g)', color: '#fff', font: { size: 12, weight: '600' } },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af' }
                },
                y: {
                    type: 'linear',
                    title: { display: true, text: 'Voltage (V vs. Na/Na+)', color: '#fff', font: { size: 12, weight: '600' } },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af' },
                    suggestedMin: -0.05,
                    suggestedMax: 2.1
                }
            },
            plugins: {
                legend: { labels: { color: '#fff', boxWidth: 14, padding: 10 } }
            }
        }
    });
}
/**
 * Hex 색상의 밝기를 조정합니다.
 * factor > 0 : 흰색 방향으로 밝게 / factor < 0 : 검은색 방향으로 어둡게 (범위 -1 ~ 1)
 * hex 형식이 아니면 원본 문자열을 그대로 반환합니다(안전장치).
 */
function shadeHexColor(color, factor) {
    if (typeof color !== 'string' || color.charAt(0) !== '#') return color;
    let hex = color.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length !== 6) return color;
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    if (factor >= 0) {
        r = Math.round(r + (255 - r) * factor);
        g = Math.round(g + (255 - g) * factor);
        b = Math.round(b + (255 - b) * factor);
    } else {
        const f = 1 + factor;
        r = Math.round(r * f); g = Math.round(g * f); b = Math.round(b * f);
    }
    return `rgb(${r}, ${g}, ${b})`;
}
function renderRateCapabilityCharts() {
    const ctxCycles  = document.getElementById('chartRateCycles').getContext('2d');
    const ctxSummary = document.getElementById('chartRateSummary').getContext('2d');
 
    const checkedDS = getCheckedDatasets();
    const isCompareMode = checkedDS.length >= 2;
 
    let stepSize = 5;
    const rateStepSizeSelect = document.getElementById('rateStepSize');
    if (rateStepSizeSelect) stepSize = parseInt(rateStepSizeSelect.value) || 5;
 
    const activeDsObj = activeDatasetId ? datasetLibrary.find(d => d.id === activeDatasetId) : null;
    const baseColor = activeDsObj ? activeDsObj.lineColor : '#60a5fa';
 
    const rateBaseColors = [
        'rgba(59, 130, 246, 0.85)',
        'rgba(6, 182, 212, 0.85)',
        'rgba(16, 185, 129, 0.85)',
        'rgba(245, 158, 11, 0.85)',
        'rgba(139, 92, 246, 0.85)',
        'rgba(236, 72, 153, 0.85)'
    ];
 
    if (chartRateCyclesInstance) chartRateCyclesInstance.destroy();
    if (chartRateSummaryInstance) chartRateSummaryInstance.destroy();
 
    // ========================
    // 1. Cycle-by-Cycle 용량 추이 선 차트
    // ========================
    const cycleLineDatasets = [];
 
    const datasetsForCycles = isCompareMode ? checkedDS : [
        // 싱글 모드: 현재 활성 데이터셋만 구성
        {
            customName: activeDsObj ? activeDsObj.dataName : 'Active',
            color: baseColor,
            lineColor: baseColor,
            processedCycles,
            compareEnabled: true
        }
    ];
 
  datasetsForCycles.forEach(ds => {
        const cycleNumbers = Object.keys(ds.processedCycles).map(Number).sort((a, b) => a - b);
        const trace = [];
        const pointColors = [];

        // C-rate(단계) 총 개수 — 비교 모드에서 단계별 밝기 계산에 사용
        const totalSteps = Math.max(1, Math.ceil(cycleNumbers.length / stepSize));
        const borderClr = ds.lineColor || ds.color || baseColor;

        cycleNumbers.forEach((cNum, idx) => {
            const data = ds.processedCycles[cNum];
            const capVal = currentRateMode === 'charge' ? data.totalChargeCap : data.totalDischargeCap;
            trace.push(capVal);
            const stepIdx = Math.floor(idx / stepSize);

            if (isCompareMode) {
                // 비교 모드: 데이터셋 고유 색은 유지하되 C-rate 단계별로 밝기를 달리해 구분
                const factor = totalSteps > 1 ? stepIdx * (0.65 / (totalSteps - 1)) : 0;
                pointColors.push(shadeHexColor(borderClr, factor));
            } else {
                // 싱글 모드: 기존 팔레트 색상으로 단계 구분
                pointColors.push(rateBaseColors[stepIdx] || 'rgba(255,255,255,0.5)');
            }
        });

        const bgColors = pointColors;

        cycleLineDatasets.push({
            label: ds.customName,
            data: trace,
            labels: cycleNumbers, // 사용자지정 툴팁
            borderColor: borderClr,        // 선(line) 색은 원본 그대로 유지
            backgroundColor: bgColors,
            pointBackgroundColor: bgColors,
            pointBorderColor: bgColors,
            pointRadius: 5,
            pointHoverRadius: 7,
            borderWidth: isCompareMode ? 2 : 1.5,
            tension: 0.1,
            segment: isCompareMode ? {} : undefined
        });
    });
 
    // 사이클 레이블: 모든 데이터셋의 합집합 (중복 제거)
    const allCycleNums = [...new Set(
        datasetsForCycles.flatMap(ds => Object.keys(ds.processedCycles).map(Number))
    )].sort((a, b) => a - b);
 
    chartRateCyclesInstance = new Chart(ctxCycles, {
        type: 'line',
        data: { labels: allCycleNums, datasets: cycleLineDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    title: { display: true, text: 'Cycle Number', color: '#fff' },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#9ca3af' }
                },
                y: {
                    title: { display: true, text: 'Specific Capacity (mAh/g)', color: '#fff' },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#9ca3af' }
                }
            },
            plugins: {
                legend: {
                    display: isCompareMode,
                    labels: { color: '#fff', boxWidth: 14, padding: 10 }
                }
            }
        }
    });
 
    // ========================
    // 2. Rate Summary 바 차트 (단계별 평균 용량)
    // ========================
    const summaryLabels = rateCapabilitySummary.map(s => s.rate);
 
    let summaryDatasets;
    if (isCompareMode) {
        // 데이터셋마다 하나씩 구동바 (grouped bar)
        summaryDatasets = checkedDS.map(ds => {
            if (!ds || !ds.processedCycles) return { label: (ds ? ds.customName : ''), data: [] };
            const summary = buildRateSummaryForDataset(ds.processedCycles);
            return {
                label: ds.customName,
                data: summary.map(s => s.avgCharge),
                backgroundColor: ds.lineColor,
                borderRadius: 5,
                borderWidth: 0
            };
        });
    } else {
        const numSteps = summaryLabels.length;
        const singleBarColors = Array(numSteps).fill(0).map((_, i) => hexToRgba(baseColor, 0.4 + 0.6 * (i / numSteps)));
        
        summaryDatasets = [{
            label: 'Avg. Capacity (mAh/g)',
            data: rateCapabilitySummary.map(s => s.avgCharge),
            backgroundColor: singleBarColors,
            borderRadius: 6,
            borderWidth: 0
        }];
    }
 
    chartRateSummaryInstance = new Chart(ctxSummary, {
        type: 'bar',
        data: { labels: summaryLabels, datasets: summaryDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false }, ticks: { color: '#9ca3af' } },
                y: {
                    title: { display: true, text: 'Capacity (mAh/g)', color: '#fff' },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#9ca3af' }
                }
            },
            plugins: {
                legend: {
                    display: isCompareMode,
                    labels: { color: '#fff', boxWidth: 14, padding: 10 }
                }
            }
        }
    });
}

/**
 * 특정 processedCycles 데이터를 기반으로 율속 요약을 빌드하는 보조 함수
 * (비교 모드에서 각 데이터셋의 바 차트 데이터 생성 시 사용)
 */
function buildRateSummaryForDataset(targetProcessedCycles) {
    const summary = [];
    const cycles = Object.keys(targetProcessedCycles).map(Number).sort((a, b) => a - b);
    if (cycles.length < 2) return summary;

    let stepSize = 5;
    const sel = document.getElementById('rateStepSize');
    if (sel) stepSize = parseInt(sel.value) || 5;

    const activeUnitBtn = document.querySelector('.rate-unit-btn.active');
    const unitSuffix = (activeUnitBtn && activeUnitBtn.dataset.unit === 'mag') ? ' mA/g' : ' C';

    const rateStepsInput = document.getElementById('rateStepsInput');
    let userStepValues = [];
    if (rateStepsInput && rateStepsInput.value.trim()) {
        userStepValues = rateStepsInput.value.split(',').map(s => s.trim()).filter(s => s !== '' && !isNaN(parseFloat(s)));
    }

    let baseCap = 0;
    let stepIndex = 0;

    for (let i = 0; i < cycles.length; i += stepSize) {
        const stepCycles = cycles.slice(i, i + stepSize);
        if (!stepCycles.length) break;

        let sumCap = 0, validCount = 0;
        stepCycles.forEach(cNum => {
            const cyc = targetProcessedCycles[cNum];
            const capVal = currentRateMode === 'charge'
                ? (cyc ? cyc.totalChargeCap : 0)
                : (cyc ? cyc.totalDischargeCap : 0);
            if (cyc && capVal > 0) { sumCap += capVal; validCount++; }
        });
        if (!validCount) { stepIndex++; continue; }

        const avgCharge = sumCap / validCount;
        if (stepIndex === 0) baseCap = avgCharge;
        const retention = baseCap > 0 ? (avgCharge / baseCap) * 100 : 0;

        let rateName = `Step ${stepIndex + 1}`;
        if (userStepValues.length > 0 && stepIndex < userStepValues.length) {
            rateName = `${parseFloat(userStepValues[stepIndex])}${unitSuffix}`;
        }

        summary.push({ rate: rateName, avgCharge, retention });
        stepIndex++;
    }
    return summary;
}


