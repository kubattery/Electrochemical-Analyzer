/* ============================================================================
 * HC-Analyzer  ·  11-analysis-metrics.js
 * 역할: 핵심 분석 연산 · ICE·Slope/Plateau·Rate 지표 테이블
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 11/15  (이전: js/10-data-processing.js → 다음: js/12-dqdv.js)
 * ============================================================================ */
/* ==========================================
   3. Electrochemical Analysis Calculations
   ========================================== */
function runAnalysis() {
    // 항상 targetCycleSP 기준의 cycleData를 획득하여 Slope/Plateau 차트에 전달
    const spCycleNum = parseInt(targetCycleSP.value) || 1;
    const spCycleData = processedCycles[spCycleNum];
    
    // 대표 수치 갱신용 사이클 번호 산출
    let displayCNum = 1;
    const cycleNumbers = Object.keys(processedCycles).map(Number).sort((a, b) => a - b);
    if (isProfileCycleAll) {
        displayCNum = cycleNumbers[cycleNumbers.length - 1] || 1;
    } else if (selectedProfileCycles.length > 0) {
        displayCNum = selectedProfileCycles[selectedProfileCycles.length - 1];
    } else {
        displayCNum = cycleNumbers[0] || 1;
    }

    const cycleData = processedCycles[displayCNum];
    if (cycleData) {
        updateAnalysisNumbers(cycleData, displayCNum);
    }

    // 전압 프로파일 차트 렌더링 (인자는 더 이상 직접 타지 않고 전역 변수에서 처리됨)
    renderOverviewChart(null, false);

    // Slope/Plateau 차트 렌더링
    if (spCycleData) {
        renderSlopePlateauChart(spCycleData, parseFloat(cutoffVoltageInput.value));
    }
    
    calculateRateCapability();
    renderRateCapabilityCharts();
    updateDqDvView();
}

/**
 * 선택된(체크박스 체크된) 모든 데이터셋의 초기 탈소듐/소듐화 용량 및 가역 효율(ICE) 수치를
 * 하단 테이블에 정량적으로 비교 렌더링합니다.
 */
function updateOverviewMetricsTable() {
    const tbody = document.querySelector('#tableOverviewMetrics tbody');
    if (!tbody) return;

    const checkedDS = getCheckedDatasets();
    // 체크된 것이 없으면 현재 활성 데이터셋만이라도 표에 노출
    const displayDS = checkedDS.length > 0 ? checkedDS : datasetLibrary.filter(d => d.id === activeDatasetId);

    if (displayDS.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">로드된 데이터가 없습니다.</td></tr>`;
        return;
    }

    let html = "";
    displayDS.forEach(ds => {
        if (!ds || !ds.processedCycles) return; // 안전장치: GITT 데이터셋 등 CC/CV가 아닌 것은 스킵
        // 각 데이터셋의 1번 사이클 또는 최초의 사이클 데이터 획득
        const firstCycle = ds.processedCycles[1] || Object.values(ds.processedCycles)[0];
        if (!firstCycle) return;

        const initDischarge = firstCycle.totalDischargeCap || 0;
        const initCharge = firstCycle.totalChargeCap || 0;
        const ice = initDischarge > 0 ? (initCharge / initDischarge) * 100 : 0;

        let iceDesc = "";
        let iceColor = "";
        if (ice >= 85) {
            iceDesc = "우수한 초기 효율 (Top-tier SIB 수준)";
            iceColor = "var(--color-success)";
        } else if (ice >= 75) {
            iceDesc = "보통 효율 (SEI 제어 보완 필요)";
            iceColor = "var(--color-orange)";
        } else {
            iceDesc = "낮은 효율 (SEI 손실 발생 의심)";
            iceColor = "var(--color-danger)";
        }

        const safeName = escapeHtml(ds.customName);

        html += `
            <tr>
                <td>
                    <span class="ds-color-dot" style="background:${ds.lineColor}; display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; box-shadow:0 0 6px ${ds.lineColor};"></span>
                    <strong style="vertical-align:middle; color:#fff;">${safeName}</strong>
                </td>
                <td style="font-weight: 500;">${initDischarge.toFixed(1)} mAh/g</td>
                <td style="font-weight: 500;">${initCharge.toFixed(1)} mAh/g</td>
                <td><span style="color:${iceColor}; font-weight:700;">${ice.toFixed(1)}%</span></td>
                <td style="font-size:11px; color:var(--text-muted); font-style:italic;">${iceDesc}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

/**
 * 선택된(체크박스 체크된) 모든 데이터셋의 Slope 및 Plateau 가역 용량, 분율을
 * 하단 통합 테이블에 정량적으로 비교 렌더링하고 디스커션 가이드를 제공합니다.
 */
function updateSlopePlateauMetricsTable() {
    const tbody = document.querySelector('#tableSlopePlateauMetrics tbody');
    if (!tbody) return;

    const checkedDS = getCheckedDatasets();
    // 체크된 것이 없으면 현재 활성 데이터셋만이라도 표에 노출
    const displayDS = checkedDS.length > 0 ? checkedDS : datasetLibrary.filter(d => d.id === activeDatasetId);

    if (displayDS.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">로드된 데이터가 없습니다.</td></tr>`;
        return;
    }

    const cutoffV = parseFloat(cutoffVoltageInput.value);
    const targetCycleNum = parseInt(targetCycleSP.value) || 1;

    let html = "";
    displayDS.forEach(ds => {
        if (!ds || !ds.processedCycles) return; // 안전장치: GITT 데이터셋 등 CC/CV가 아닌 것은 스킵
        const dsCycles = Object.keys(ds.processedCycles).map(Number).sort((a, b) => a - b);
        if (dsCycles.length === 0) return;

        // 선택된 분석 사이클이 없으면 가장 가까운 사이클 번호로 폴백
        let cNum = targetCycleNum;
        if (!dsCycles.includes(cNum)) {
            cNum = dsCycles.reduce((prev, curr) => Math.abs(curr - targetCycleNum) < Math.abs(prev - targetCycleNum) ? curr : prev);
        }

        const cycleData = ds.processedCycles[cNum];
        if (!cycleData) return;

        const sodPoints = cycleData.sodiation || [];
        let slopeCapacity = 0;
        let plateauCapacity = 0;
        
        if (sodPoints.length > 0) {
            let cutoffIndex = sodPoints.findIndex(p => p.voltage <= cutoffV);
            if (cutoffIndex === -1) {
                slopeCapacity = cycleData.totalDischargeCap || 0;
                plateauCapacity = 0;
            } else {
                slopeCapacity = sodPoints[cutoffIndex].capacity;
                plateauCapacity = (cycleData.totalDischargeCap || 0) - slopeCapacity;
            }
        }

        const totalCap = slopeCapacity + plateauCapacity;
        const slopeRatio = totalCap > 0 ? (slopeCapacity / totalCap) * 100 : 0;
        const plateauRatio = totalCap > 0 ? (plateauCapacity / totalCap) * 100 : 0;

        // 학술적 교수 디스커션 가이드 요약 생성
        let comment = "";
        if (plateauRatio > 55) {
            comment = `<strong>Plateau 우세형 (${plateauRatio.toFixed(1)}%)</strong>: 나노기공 내 Na 클러스터링 거동 지배적. 저전압 고밀도 에너지 밀도용 탄소입니다.`;
        } else if (slopeRatio > 55) {
            comment = `<strong>Slope 우세형 (${slopeRatio.toFixed(1)}%)</strong>: 표면 흡착 및 무질서 층간 거동 지배적. 고출력/속속성(High-rate) 소재에 유리합니다.`;
        } else {
            comment = `<strong>하이브리드형 (${slopeRatio.toFixed(0)}:${plateauRatio.toFixed(0)})</strong>: 삽입과 기공 적층 저장 메커니즘이 고르게 발달한 탄소 거동을 지시합니다.`;
        }

        const safeName = escapeHtml(ds.customName);

        html += `
            <tr>
                <td>
                    <span class="ds-color-dot" style="background:${ds.lineColor}; display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; box-shadow:0 0 6px ${ds.lineColor};"></span>
                    <strong style="vertical-align:middle; color:#fff;">${safeName}</strong>
                </td>
                <td>Cycle ${cNum}</td>
                <td style="font-weight: 500; color: var(--color-slope);">${slopeCapacity.toFixed(1)} mAh/g</td>
                <td>${slopeRatio.toFixed(1)}%</td>
                <td style="font-weight: 500; color: var(--color-plateau);">${plateauCapacity.toFixed(1)} mAh/g</td>
                <td>${plateauRatio.toFixed(1)}%</td>
                <td style="font-weight: 600; color: var(--color-success);">${totalCap.toFixed(1)} mAh/g</td>
                <td style="font-size:11px; color:var(--text-main); line-height:1.4;">${comment}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

// 개별 수치 카드 및 분석 요약 테이블 텍스트 갱신 함수
function updateAnalysisNumbers(cycleData, targetCycleNum) {
    // 3.1. ICE and Capacity Overview Table Update
    updateOverviewMetricsTable();
    
    // 3.2. Slope vs Plateau Capacity Summary Table Update
    updateSlopePlateauMetricsTable();
}

/**
 * C-rate / mA/g 율속 분석 함수
 * 사이드바의 사용자 입력값(단계 라벨, 단계당 사이클 수, 단위)을 읽어 동적으로 라벨 생성
 */
function calculateRateCapability() {
    rateCapabilitySummary = [];
    const cycles = Object.keys(processedCycles).map(Number).sort((a, b) => a - b);
    
    // 1. 기존의 rateCapabilitySummary 배열 빌드 (차트 및 CSV 내보내기 호환용)
    if (cycles.length >= 2) {
        let stepSize = 5;
        const rateStepSizeSelect = document.getElementById('rateStepSize');
        if (rateStepSizeSelect) {
            stepSize = parseInt(rateStepSizeSelect.value) || 5;
        }

        // 현재 선택된 측정 단위 확인 (C-rate / mA/g)
        const activeUnitBtn = document.querySelector('.rate-unit-btn.active');
        const currentUnit = activeUnitBtn ? activeUnitBtn.dataset.unit : 'crate';
        const unitSuffix = currentUnit === 'mag' ? ' mA/g' : ' C';

        // 사용자가 입력한 단계 값 파싱 (숫자만 추출, 쉼표 구분)
        const rateStepsInput = document.getElementById('rateStepsInput');
        let userStepValues = [];
        if (rateStepsInput && rateStepsInput.value.trim() !== '') {
            userStepValues = rateStepsInput.value
                .split(',')
                .map(s => s.trim())
                .filter(s => s !== '' && !isNaN(parseFloat(s)));
        }

        // 단계 인덱스 -> 라벨 변환 함수
        function getStepLabel(stepIndex) {
            if (userStepValues.length > 0 && stepIndex < userStepValues.length) {
                const val = parseFloat(userStepValues[stepIndex]);
                return `${val}${unitSuffix}`;
            }
            return `Step ${stepIndex + 1}`;
        }

        let baseCap = 0;
        let stepIndex = 0;

        for (let i = 0; i < cycles.length; i += stepSize) {
            const stepCycles = cycles.slice(i, i + stepSize);
            if (stepCycles.length === 0) break;

            let sumCap = 0;
            let sumCE = 0;
            let validCount = 0;

            stepCycles.forEach(cNum => {
                const cyc = processedCycles[cNum];
                const capVal = currentRateMode === 'charge'
                    ? (cyc ? cyc.totalChargeCap : 0)
                    : (cyc ? cyc.totalDischargeCap : 0);
                if (cyc && capVal > 0) {
                    sumCap += capVal;
                    const ce = (cyc.totalDischargeCap > 0)
                        ? (cyc.totalChargeCap / cyc.totalDischargeCap) * 100
                        : 0;
                    sumCE += ce;
                    validCount++;
                }
            });

            if (validCount === 0) { stepIndex++; continue; }

            const avgCap = sumCap / validCount;
            const avgCE = sumCE / validCount;
            const rateName = getStepLabel(stepIndex);

            if (stepIndex === 0) {
                baseCap = avgCap; // 첫 번째 단계를 기준 용량으로 설정
            }

            const retention = baseCap > 0 ? (avgCap / baseCap) * 100 : 0;

            rateCapabilitySummary.push({
                rate: rateName,
                cycleRange: `${stepCycles[0]} - ${stepCycles[stepCycles.length - 1]}`,
                avgCharge: avgCap, // 차트 및 파일 내보내기 호환을 위해 필드명 avgCharge 유지
                retention,
                avgCE
            });

            stepIndex++;
        }
    }

    // 2. 가로 대조용 2차원 비교 테이블 업데이트
    const thead = tableRateSummary.querySelector('thead');
    const tbody = tableRateSummary.querySelector('tbody');
    if (!thead || !tbody) return;

    const checkedDS = getCheckedDatasets();
    const displayDS = checkedDS.length > 0 ? checkedDS : datasetLibrary.filter(d => d.id === activeDatasetId);

    if (displayDS.length === 0) {
        thead.innerHTML = "";
        tbody.innerHTML = `<tr><td style="text-align: center; color: var(--text-muted);">로드된 데이터가 없습니다.</td></tr>`;
        return;
    }

    // 각 데이터셋별 요약 정보 빌드
    const datasetSummaries = displayDS.map(ds => {
        if (!ds || !ds.processedCycles) {
            return { ds: ds, summary: [] };
        }
        return {
            ds: ds,
            summary: buildRateSummaryForDataset(ds.processedCycles)
        };
    });

    // 최대 단계 수 구하기
    const maxSteps = Math.max(...datasetSummaries.map(item => item.summary.length), 0);

    if (maxSteps === 0) {
        thead.innerHTML = "";
        tbody.innerHTML = `<tr><td style="text-align: center; color: var(--text-muted);">율속 데이터가 부족합니다.</td></tr>`;
        return;
    }

    // (A) 헤더 생성
    const modeText = currentRateMode === 'charge' ? '충전 용량' : '방전 용량';
    let headerHTML = `<tr><th style="min-width: 180px;">데이터셋</th>`;
    for (let sIdx = 0; sIdx < maxSteps; sIdx++) {
        let stepName = "";
        for (let item of datasetSummaries) {
            if (item.summary[sIdx]) {
                stepName = item.summary[sIdx].rate;
                break;
            }
        }
        if (!stepName) {
            stepName = `Step ${sIdx + 1}`;
        }
        headerHTML += `<th>${stepName}<br><span style="font-size:10px; font-weight:normal; opacity:0.7;">Avg. ${modeText}</span></th>`;
    }
    headerHTML += `<th>최종 용량 유지율 (%)<br><span style="font-size:10px; font-weight:normal; opacity:0.7;">Final Retention</span></th></tr>`;
    thead.innerHTML = headerHTML;

    // (B) 바디 생성
    let bodyHTML = "";
    datasetSummaries.forEach(item => {
        const ds = item.ds;
        const summary = item.summary;
        const safeName = escapeHtml(ds.customName);

        bodyHTML += `<tr>`;
        bodyHTML += `
            <td>
                <span class="ds-color-dot" style="background:${ds.color}; display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; box-shadow:0 0 6px ${ds.color};"></span>
                <strong style="vertical-align:middle; color:#fff;">${safeName}</strong>
            </td>
        `;

        for (let sIdx = 0; sIdx < maxSteps; sIdx++) {
            if (summary[sIdx]) {
                bodyHTML += `<td style="font-weight: 500;">${summary[sIdx].avgCharge.toFixed(1)} <span style="font-size:11px; opacity:0.7;">mAh/g</span></td>`;
            } else {
                bodyHTML += `<td style="color: var(--text-muted);">-</td>`;
            }
        }

        if (summary.length > 0) {
            const finalRetention = summary[summary.length - 1].retention;
            bodyHTML += `<td><span style="color: ${finalRetention >= 80 ? 'var(--color-success)' : 'var(--color-orange)'}; font-weight: 600;">${finalRetention.toFixed(1)}%</span></td>`;
        } else {
            bodyHTML += `<td style="color: var(--text-muted);">-</td>`;
        }

        bodyHTML += `</tr>`;
    });

    tbody.innerHTML = bodyHTML;
}

