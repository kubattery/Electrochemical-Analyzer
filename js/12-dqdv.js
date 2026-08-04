/* ============================================================================
 * HC-Analyzer  ·  12-dqdv.js
 * 역할: dQ/dV 미분용량 분석 · 차트 · 사이클 선택
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 12/15  (이전: js/11-analysis-metrics.js → 다음: js/13-charts.js)
 * ============================================================================ */
/**
 * dQ/dV 분석 탭 관련 비즈니스 로직
 */
// 전압 격자 선형 보간 + 중앙 차분 기반의 고정밀 dQ/dV 연산 함수
function calculateDqDv(points, stepV = 0.010, postAvg = 1) {
    const result = [];
    if (points.length < 5) return result;

    // 1. 전압 기준으로 정렬
    const sorted = [...points].sort((a, b) => a.voltage - b.voltage);
    
    const vMin = sorted[0].voltage;
    const vMax = sorted[sorted.length - 1].voltage;
    
    // 격자 스텝 간격 dV가 너무 작으면 미분 잡음이 튀므로 최소 0.001V 이상으로 보장
    const dV = Math.max(0.001, stepV);
    
    // 일정한 전압 간격 dV로 격자 데이터(Grid) 생성
    // 양 끝단의 데이터 튐 현상(끝단에서 dV가 너무 작아 미분이 발산하는 현상)을 방지하고 WonATech 장비와 매칭을 위해
    // 격자의 범위를 양 끝에서 1.0 * dV 만큼 마진을 두고 좁혀서 생성합니다.
    const grid = [];
    const gridMin = vMin + dV;
    const gridMax = vMax - dV;
    
    let sortedIdx = 0;
    for (let v = gridMin; v <= gridMax + 1e-9; v += dV) {
        // v보다 크거나 같은 첫 번째 원소의 인덱스를 투포인터로 탐색
        while (sortedIdx < sorted.length && sorted[sortedIdx].voltage < v) {
            sortedIdx++;
        }
        
        if (sortedIdx <= 0 || sortedIdx >= sorted.length) {
            continue;
        }
        
        const p0 = sorted[sortedIdx - 1];
        const p1 = sorted[sortedIdx];
        
        const dvSpan = p1.voltage - p0.voltage;
        let q = p0.capacity;
        if (dvSpan > 1e-6) {
            q = p0.capacity + (p1.capacity - p0.capacity) * (v - p0.voltage) / dvSpan;
        }
        
        grid.push({ voltage: v, capacity: q });
    }
    
    if (grid.length < 3) return result;
    
    // 2. 중앙 차분(Central Difference)으로 dQ/dV 계산 (양 끝단 1차 차분 시 튀는 값 배제 및 안정적 미분 보장)
    for (let i = 1; i < grid.length - 1; i++) {
        const prev = grid[i - 1];
        const next = grid[i + 1];
        
        const deltaV = next.voltage - prev.voltage; 
        const deltaQ = next.capacity - prev.capacity;
        
        if (Math.abs(deltaV) < 1e-6) continue;
        
        const val = deltaQ / deltaV;
        
        result.push({
            voltage: grid[i].voltage,
            dqdv: val
        });
    }
    
    if (result.length < 3) return result;
    if (postAvg <= 1) return result;

    // 3. Post-smoothing (지정한 Post-Avg. Factor 크기만큼의 이동 평균 필터 적용)
    const smoothedResult = [];
    const windowSize = parseInt(postAvg) || 1;
    const half = Math.floor(windowSize / 2);
    for (let i = 0; i < result.length; i++) {
        let sum = 0;
        let count = 0;
        for (let w = -half; w <= half; w++) {
            const idx = i + w;
            if (idx >= 0 && idx < result.length) {
                sum += result[idx].dqdv;
                count++;
            }
        }
        smoothedResult.push({
            voltage: result[i].voltage,
            dqdv: sum / count
        });
    }
    
    return smoothedResult;
}

// dQ/dV 탭 뷰 갱신
function updateDqDvView() {
    if (hasActiveDataset()) {
        renderDqDvChart();
    }
}

// dQ/dV 차트 렌더링
// opts.canvasId / opts.getInstance / opts.setInstance 로 다른 캔버스에 독립 렌더링 지원(통합 뷰 재사용).
// opts.skipTable 이 true 이면 dQ/dV 피크 요약 테이블 갱신을 생략합니다.
function renderDqDvChart(opts = {}) {
    const canvas = document.getElementById(opts.canvasId || 'chartDqDv');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const prevInstance = opts.getInstance ? opts.getInstance() : chartDqDvInstance;
    if (prevInstance) {
        prevInstance.destroy();
    }

    const checkedDS = getCheckedDatasets();
    const displayDS = checkedDS.length > 0 ? checkedDS : datasetLibrary.filter(d => d.id === activeDatasetId);

    if (displayDS.length === 0) {
        if (opts.setInstance) opts.setInstance(null);
        else chartDqDvInstance = null;
        if (!opts.skipTable) {
            const tbody = document.querySelector('#tableDqDvPeaks tbody');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">로드된 데이터가 없습니다.</td></tr>`;
            }
        }
        return;
    }

    // WonATech 상용 기준 파라미터 획득
    const stepVVal = dqdvStepV ? parseFloat(dqdvStepV.value) : 0.010;
    const qoVal = dqdvQo ? parseFloat(dqdvQo.value) || 1000 : 1000;
    const postAvgVal = dqdvPostAvg ? parseInt(dqdvPostAvg.value) || 1 : 1;
    
    const mode = selectDqDvMode ? selectDqDvMode.value : 'both'; // 'both', 'charge', 'discharge'

    const chartDatasets = [];
    const isCompareMode = displayDS.length >= 2;
    const computedDqDvCache = {}; // dQ/dV 중복 계산 방지를 위한 로컬 캐시 구조

    displayDS.forEach(ds => {
        if (!ds || !ds.processedCycles) return; // 안전장치: GITT 데이터셋 등 CC/CV 구조가 아닌 것은 스킵
        const dsCycles = Object.keys(ds.processedCycles).map(Number).sort((a, b) => a - b);
        if (dsCycles.length === 0) return;

        if (!computedDqDvCache[ds.id]) {
            computedDqDvCache[ds.id] = {};
        }

        // 선택된 모든 다중 사이클을 돌며 플로팅 수행
        selectedDqDvCycles.forEach(cycNum => {
            // 사이클 폴백
            let targetCyc = cycNum;
            if (!dsCycles.includes(targetCyc)) {
                targetCyc = dsCycles.reduce((prev, curr) => 
                    Math.abs(curr - cycNum) < Math.abs(prev - cycNum) ? curr : prev
                );
            }

            const cycleData = ds.processedCycles[targetCyc];
            if (!cycleData) return;

            // 충전 dQ/dV 계산 (Desodiation)
            let chargePoints = [];
            if (mode === 'both' || mode === 'charge') {
                if (cycleData.desodiation && cycleData.desodiation.length > 0) {
                    chargePoints = calculateDqDv(cycleData.desodiation, stepVVal, postAvgVal);
                }
            }

            // 방전 dQ/dV 계산 (Sodiation)
            let dischargePoints = [];
            if (mode === 'both' || mode === 'discharge') {
                if (cycleData.sodiation && cycleData.sodiation.length > 0) {
                    dischargePoints = calculateDqDv(cycleData.sodiation, stepVVal, postAvgVal);
                }
            }

            // 캐시 기록
            computedDqDvCache[ds.id][targetCyc] = {
                chargePoints: chargePoints,
                dischargePoints: dischargePoints
            };

            // 개별 데이터셋의 질량(Mass) 값 적용
            const dsMass = ds.mass !== undefined ? ds.mass : 2.58;
            const scaleFactor = (dsMass / 1000.0) / qoVal;

            let cBorderColor, dBorderColor;
            let cDash = undefined;
            let dDash = isCompareMode ? [5, 4] : undefined;
            let labelSuffix = ` (Cyc ${cycNum})`;

            const cycIdx = selectedDqDvCycles.indexOf(cycNum);
            const totalCycCount = selectedDqDvCycles.length;

            if (isCompareMode) {
                // 다중 데이터셋 상태: 데이터셋 고유색 유지하되 사이클별로 투명도 및 대시 패턴 조절
                const opacity = totalCycCount <= 1 ? 1.0 : 0.45 + (cycIdx * 0.55 / (totalCycCount - 1));
                cBorderColor = hexToRgba(ds.lineColor, opacity);
                dBorderColor = hexToRgba(ds.lineColor, opacity);
                
                if (cycIdx > 0) {
                    cDash = [2 * cycIdx, 2];
                    dDash = [5, 4, 2 * cycIdx, 2];
                }
            } else {
                // 단일 데이터셋 상태: 고유 lineColor 기반으로 충방전 선 색상과 대시선 처리
                const opacity = totalCycCount <= 1 ? 1.0 : 0.45 + (cycIdx * 0.55 / (totalCycCount - 1));
                cBorderColor = hexToRgba(ds.lineColor, opacity);
                dBorderColor = hexToRgba(ds.lineColor, opacity * 0.75); // 방전은 약간 투명하게
                dDash = [5, 5]; // 방전은 항상 대시 스타일로 분리
                
                if (cycIdx > 0) {
                    cDash = [2 * cycIdx, 2];
                    dDash = [5, 5, 2 * cycIdx, 2];
                }
            }

            // 충전 곡선 데이터셋 추가
            if (chargePoints.length > 0) {
                chartDatasets.push({
                    label: `${ds.customName}${labelSuffix} (Charge)`,
                    data: chargePoints.map(p => ({ x: p.voltage, y: p.dqdv * scaleFactor })),
                    borderColor: cBorderColor,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    borderDash: cDash,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    tension: 0.15,
                    fill: false
                });
            }

            // 방전 곡선 데이터셋 추가
            if (dischargePoints.length > 0) {
                chartDatasets.push({
                    label: `${ds.customName}${labelSuffix} (Discharge)`,
                    data: dischargePoints.map(p => ({ x: p.voltage, y: p.dqdv * scaleFactor })),
                    borderColor: dBorderColor,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    borderDash: dDash,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    tension: 0.15,
                    fill: false
                });
            }
        });
    });

    const dqdvInstance = new Chart(ctx, {
        type: 'line',
        data: { datasets: chartDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Voltage [V]', color: '#fff' },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af' }
                },
                y: {
                    title: { display: true, text: '1/Qo * dQ / dv [1/V]', color: '#fff' },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af' }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: '#fff',
                        boxWidth: 14,
                        padding: 10,
                        filter: function(item, chartData) {
                            if (isCompareMode) {
                                // 다중 데이터셋 오버레이 상태
                                if (item.text.includes('(Discharge)')) {
                                    return false;
                                }
                                // Charge 단어를 떼고 데이터셋명과 사이클명만 노출
                                item.text = item.text.replace(' (Charge)', '');
                                return true;
                            }
                            // 단일 데이터셋 오버레이 상태: 충/방전 및 사이클명이 범례에 다 구별되어 나오도록 그대로 유지
                            return true;
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            if (context.parsed.y !== null) {
                                label += `${context.parsed.y.toFixed(5)} 1/V at ${context.parsed.x.toFixed(3)} V`;
                            }
                            return label;
                        }
                    }
                }
            }
        }
    });

    if (opts.setInstance) opts.setInstance(dqdvInstance);
    else chartDqDvInstance = dqdvInstance;

    // 테이블 정보 업데이트 (다중 사이클 선택을 적용하므로 targetCycleNum 매개변수는 무시됨, 캐시 데이터 전달)
    if (!opts.skipTable) {
        updateDqDvTable(displayDS, null, stepVVal, qoVal, postAvgVal, computedDqDvCache);
    }
}

// dQ/dV 주요 산화환원 피크 요약 테이블 갱신
function updateDqDvTable(displayDS, targetCycleNum, stepVVal, qoVal, postAvgVal, computedDqDvCache = null) {
    const tbody = document.querySelector('#tableDqDvPeaks tbody');
    if (!tbody) return;
    
    let html = "";
    
    displayDS.forEach(ds => {
        if (!ds || !ds.processedCycles) return; // 안전장치: GITT 데이터셋 등 CC/CV가 아닌 것은 스킵
        const dsCycles = Object.keys(ds.processedCycles).map(Number).sort((a, b) => a - b);
        if (dsCycles.length === 0) return;
        
        // 선택된 모든 다중 사이클을 돌며 행 추가
        selectedDqDvCycles.forEach(cycNum => {
            if (!dsCycles.includes(cycNum)) return; // 해당 데이터셋에 사이클이 없으면 생략
            
            const cycleData = ds.processedCycles[cycNum];
            if (!cycleData) return;

            // 개별 데이터셋의 질량(Mass) 값 적용 (없을 시 폴백 2.58)
            const dsMass = ds.mass !== undefined ? ds.mass : 2.58;
            const scaleFactor = (dsMass / 1000.0) / qoVal;
            
            let chargeDqDv = [];
            let dischargeDqDv = [];

            // 캐시가 존재하고 현재 사이클에 대한 데이터가 있으면 재사용
            if (computedDqDvCache && computedDqDvCache[ds.id] && computedDqDvCache[ds.id][cycNum]) {
                chargeDqDv = computedDqDvCache[ds.id][cycNum].chargePoints || [];
                dischargeDqDv = computedDqDvCache[ds.id][cycNum].dischargePoints || [];
            } else {
                if (cycleData.desodiation && cycleData.desodiation.length > 0) {
                    chargeDqDv = calculateDqDv(cycleData.desodiation, stepVVal, postAvgVal);
                }
                if (cycleData.sodiation && cycleData.sodiation.length > 0) {
                    dischargeDqDv = calculateDqDv(cycleData.sodiation, stepVVal, postAvgVal);
                }
            }
            
            // 환원 피크(방전 최솟값) 검출
            let minDqDv = 0;
            let minVolt = 0;
            if (dischargeDqDv.length > 0) {
                let minItem = dischargeDqDv[0];
                dischargeDqDv.forEach(item => {
                    if (item.dqdv < minItem.dqdv) {
                        minItem = item;
                    }
                });
                minDqDv = minItem.dqdv * scaleFactor;
                minVolt = minItem.voltage;
            }
            
            // 산화 피크(충전 최댓값) 검출
            let maxDqDv = 0;
            let maxVolt = 0;
            if (chargeDqDv.length > 0) {
                let maxItem = chargeDqDv[0];
                chargeDqDv.forEach(item => {
                    if (item.dqdv > maxItem.dqdv) {
                        maxItem = item;
                    }
                });
                maxDqDv = maxItem.dqdv * scaleFactor;
                maxVolt = maxItem.voltage;
            }
            
            const safeName = escapeHtml(ds.customName);
            
            html += `
                <tr>
                    <td>
                        <span class="ds-color-dot" style="background:${ds.lineColor}; display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; box-shadow:0 0 6px ${ds.lineColor};"></span>
                        <strong style="vertical-align:middle; color:#fff;">${safeName}</strong>
                    </td>
                    <td style="font-weight: 500;">${cycNum} Cycle</td>
                    <td style="font-weight: 500; color: #3b82f6;">${minVolt !== 0 ? minVolt.toFixed(3) + ' V' : '-'}</td>
                    <td style="font-weight: 500; color: #60a5fa;">${minDqDv !== 0 ? minDqDv.toFixed(5) + ' 1/V' : '-'}</td>
                    <td style="font-weight: 500; color: #ec4899;">${maxVolt !== 0 ? maxVolt.toFixed(3) + ' V' : '-'}</td>
                    <td style="font-weight: 500; color: #f472b6;">${maxDqDv !== 0 ? maxDqDv.toFixed(5) + ' 1/V' : '-'}</td>
                </tr>
            `;
        });
    });
    
    tbody.innerHTML = html || `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">선택된 사이클의 데이터가 없습니다.</td></tr>`;
}

/**
 * dQ/dV 분석 탭 내 다중 사이클 선택 칩 목록을 렌더링하고 이벤트를 바인딩합니다.
 */
function renderCycleChipsUI() {
    const container = document.getElementById('cycleChipsContainer');
    if (!container) return;

    container.innerHTML = '';

    const cycleNumbers = Object.keys(processedCycles).map(Number).sort((a, b) => a - b);
    if (cycleNumbers.length === 0) {
        container.innerHTML = '<span style="font-size:11px; color:var(--text-muted);">사이클 데이터가 없습니다.</span>';
        return;
    }

    // 전역 배열 유효하지 않은 사이클 제거 방어
    selectedDqDvCycles = selectedDqDvCycles.filter(c => cycleNumbers.includes(c));
    if (selectedDqDvCycles.length === 0 && cycleNumbers.length > 0) {
        selectedDqDvCycles = [cycleNumbers[0]];
    }

    cycleNumbers.forEach(cNum => {
        const chip = document.createElement('div');
        const isActive = selectedDqDvCycles.includes(cNum);
        chip.className = `cycle-chip${isActive ? ' active' : ''}`;
        chip.textContent = `${cNum}C`;
        chip.title = `${cNum} Cycle`;

        chip.addEventListener('click', () => {
            const index = selectedDqDvCycles.indexOf(cNum);
            if (index > -1) {
                // 활성화된 칩 클릭 -> 1개 이상 활성화 보장
                if (selectedDqDvCycles.length > 1) {
                    selectedDqDvCycles.splice(index, 1);
                } else {
                    return; // 1개만 있을 땐 해제 불가
                }
            } else {
                // 비활성 칩 클릭 -> 활성화 및 정렬
                selectedDqDvCycles.push(cNum);
                selectedDqDvCycles.sort((a, b) => a - b);
            }
            
            // 호환성을 위해 숨겨진 targetCycleDqDv 셀렉터의 값도 동기화
            if (targetCycleDqDv) {
                targetCycleDqDv.value = selectedDqDvCycles[0].toString();
            }

            renderCycleChipsUI();
            updateDqDvView();
        });

        container.appendChild(chip);
    });

    updateDqDvCycleSummary();
}

/**
 * dQ/dV 드롭다운 토글 버튼 요약 텍스트 갱신
 */
function updateDqDvCycleSummary() {
    const el = document.getElementById('dqdvCycleSummary');
    if (!el) return;
    const cycleNumbers = Object.keys(processedCycles).map(Number).sort((a, b) => a - b);
    const sel = selectedDqDvCycles;
    if (sel.length === 0 || cycleNumbers.length === 0) {
        el.textContent = '-';
    } else if (sel.length === cycleNumbers.length) {
        el.textContent = '전체 사이클';
    } else if (sel.length <= 3) {
        el.textContent = sel.join(', ') + ' Cycle';
    } else {
        el.textContent = `${sel[0]}C 외 ${sel.length - 1}개`;
    }
}

/**
 * dQ/dV 사이클 드롭다운 토글 초기화
 */
function initDqDvCycleDropdown() {
    const btn = document.getElementById('btnDqDvCycleDropdown');
    const panel = document.getElementById('dqdvCycleDropdownPanel');
    if (!btn || !panel) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.toggle('show');
    });

    // 패널 내부 클릭은 닫히지 않게
    panel.addEventListener('click', (e) => e.stopPropagation());

    // 외부 클릭 시 닫기
    document.addEventListener('click', () => panel.classList.remove('show'));
}


/**
 * 퀵 액션 필터 버튼 이벤트 바인딩
 */
function initCycleQuickActions() {
    const btnAll = document.getElementById('btnCycleAll');
    const btnClear = document.getElementById('btnCycleClear');
    const btnOdd = document.getElementById('btnCycleOdd');
    const btnEven = document.getElementById('btnCycleEven');

    const getCycles = () => Object.keys(processedCycles).map(Number).sort((a, b) => a - b);

    if (btnAll) {
        btnAll.onclick = () => {
            const cycles = getCycles();
            if (cycles.length > 0) {
                selectedDqDvCycles = [...cycles];
                renderCycleChipsUI();
                updateDqDvView();
            }
        };
    }

    if (btnClear) {
        btnClear.onclick = () => {
            const cycles = getCycles();
            if (cycles.length > 0) {
                selectedDqDvCycles = [cycles[0]];
                renderCycleChipsUI();
                updateDqDvView();
            }
        };
    }

    if (btnOdd) {
        btnOdd.onclick = () => {
            const cycles = getCycles();
            selectedDqDvCycles = cycles.filter(c => c % 2 !== 0);
            if (selectedDqDvCycles.length === 0 && cycles.length > 0) {
                selectedDqDvCycles = [cycles[0]];
            }
            renderCycleChipsUI();
            updateDqDvView();
        };
    }

    if (btnEven) {
        btnEven.onclick = () => {
            const cycles = getCycles();
            selectedDqDvCycles = cycles.filter(c => c % 2 === 0);
            if (selectedDqDvCycles.length === 0 && cycles.length > 0) {
                selectedDqDvCycles = [cycles[0]];
            }
            renderCycleChipsUI();
            updateDqDvView();
        };
    }
}

