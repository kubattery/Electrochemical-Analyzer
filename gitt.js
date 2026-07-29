/**
 * Hard Carbon Electrochemical Analyzer - GITT Analysis Engine
 * (보관용 분리 모듈 - Coming Soon 상태)
 */

// GITT State & Charts
let isGittMode = false;
let gittRawData = [];
let gittResults = [];
let gittDischargeRuns = []; // [{ runIndex: 1, rawData: [...], results: [...] }]
let gittChargeRuns = [];    // [{ runIndex: 1, rawData: [...], results: [...] }]
let activeGittDischargeRunIdx = 0;
let activeGittChargeRunIdx = 0;

let chartGittProfileInstance = null;
let chartGittProfileCapacityInstance = null;
let chartGittDiffusionInstance = null;

// GITT DOM Elements
const gittConfigPanel = document.getElementById('gittConfigPanel');
const gittMassInput = document.getElementById('gittMass');
const gittAreaInput = document.getElementById('gittArea');
const gittVolInput = document.getElementById('gittVol');
const gittMolarMassInput = document.getElementById('gittMolarMass');
const gittShowModeSelect = document.getElementById('gittShowMode');
const tableGittSummaryBody = document.querySelector('#tableGittSummary tbody');
const btnExportGittCsv = document.getElementById('btnExportGittCsv');
const btnCalculateGittDiffusion = document.getElementById('btnCalculateGittDiffusion');
const gittCalcResultsArea = document.getElementById('gittCalcResultsArea');
const gittDischargeCycleSelect = document.getElementById('gittDischargeCycle');
const gittChargeCycleSelect = document.getElementById('gittChargeCycle');

// GITT Events
function initGittEvents() {
    if (gittMassInput) {
        gittMassInput.addEventListener('input', () => {
            if (isGittMode && gittRawData.length > 0) {
                renderGittProfileCapacityChart();
            }
        });
    }

    if (gittDischargeCycleSelect) {
        gittDischargeCycleSelect.addEventListener('change', (e) => {
            activeGittDischargeRunIdx = parseInt(e.target.value) || 0;
            runGittAnalysis();
            if (gittCalcResultsArea && gittCalcResultsArea.style.display !== 'none') {
                if (btnCalculateGittDiffusion) btnCalculateGittDiffusion.click();
            }
        });
    }

    if (gittChargeCycleSelect) {
        gittChargeCycleSelect.addEventListener('change', (e) => {
            activeGittChargeRunIdx = parseInt(e.target.value) || 0;
            runGittAnalysis();
            if (gittCalcResultsArea && gittCalcResultsArea.style.display !== 'none') {
                if (btnCalculateGittDiffusion) btnCalculateGittDiffusion.click();
            }
        });
    }

    if (btnCalculateGittDiffusion) {
        btnCalculateGittDiffusion.addEventListener('click', () => {
            if (!isGittMode || gittRawData.length === 0) {
                alert("GITT 데이터가 로드되지 않았습니다. 파일을 먼저 업로드하거나 데모 데이터를 로드해 주세요.");
                return;
            }
            
            const activeDischarge = gittDischargeRuns[activeGittDischargeRunIdx];
            const activeCharge = gittChargeRuns[activeGittChargeRunIdx];
            const activeDischargeResults = activeDischarge ? activeDischarge.results : [];
            const activeChargeResults = activeCharge ? activeCharge.results : [];
            
            gittResults = [];
            let pulseIdx = 1;
            activeDischargeResults.forEach(r => {
                gittResults.push({ ...r, pulseNo: pulseIdx++ });
            });
            activeChargeResults.forEach(r => {
                gittResults.push({ ...r, pulseNo: pulseIdx++ });
            });
            
            calculateFinalGittDiffusion();
            renderGittDiffusionChart();
            updateGittSummaryTable();
            
            if (gittCalcResultsArea) {
                gittCalcResultsArea.style.display = 'grid';
                setTimeout(() => {
                    if (chartGittDiffusionInstance) chartGittDiffusionInstance.resize();
                }, 100);
            }
        });
    }

    if (gittShowModeSelect) {
        gittShowModeSelect.addEventListener('change', () => {
            if (isGittMode && gittCalcResultsArea && gittCalcResultsArea.style.display !== 'none') {
                renderGittDiffusionChart();
                updateGittSummaryTable();
            }
        });
    }

    if (btnExportGittCsv) btnExportGittCsv.addEventListener('click', exportGittCsv);
}

function runGittAnalysis() {
    renderGittProfileChart();
    renderGittProfileCapacityChart();

    if (gittCalcResultsArea) {
        gittCalcResultsArea.style.display = 'none';
    }
    if (tableGittSummaryBody) {
        tableGittSummaryBody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 50px 0;">이온 확산 계수 계산 버튼을 클릭해 주십시오.</td></tr>`;
    }
}

function calculateFinalGittDiffusion() {
    const mB = parseFloat(gittMassInput.value) || 1.033; // mg
    const A = parseFloat(gittAreaInput.value) || 1.54;   // cm^2
    const V_M = parseFloat(gittVolInput.value) || 9.38;  // cm^3/mol
    const M_B = parseFloat(gittMolarMassInput.value) || 12.011; // g/mol

    const massG = mB / 1000.0;
    const factor = (massG * V_M) / (M_B * A);
    const factorSquared = Math.pow(factor, 2);

    gittResults.forEach(item => {
        item.D = item.dScaled * factorSquared;
        item.logD = item.D > 0 ? Math.log10(item.D) : -20;
    });
}

function renderGittProfileChart() {
    const canvas = document.getElementById('chartGittProfile');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (chartGittProfileInstance) {
        chartGittProfileInstance.destroy();
    }

    const stepSize = Math.max(1, Math.floor(gittRawData.length / 2000));
    const sampledData = [];
    for (let i = 0; i < gittRawData.length; i += stepSize) {
        sampledData.push(gittRawData[i]);
    }
    if (sampledData.length === 0 || sampledData[sampledData.length - 1] !== gittRawData[gittRawData.length - 1]) {
        if (gittRawData.length > 0) {
            sampledData.push(gittRawData[gittRawData.length - 1]);
        }
    }

    const timesHours = sampledData.map(d => d.time / 3600.0);
    const voltages = sampledData.map(d => d.voltage);

    const gradient = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
    gradient.addColorStop(0, '#06b6d4');
    gradient.addColorStop(0.5, '#6366f1');
    gradient.addColorStop(1, '#ec4899');

    chartGittProfileInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: timesHours,
            datasets: [
                makeChartDataset(
                    'Voltage vs. Time',
                    voltages,
                    gradient,
                    'transparent',
                    { borderWidth: 1.5 }
                )
            ]
        },
        options: createChartOptions({
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: function(context) {
                            return `Voltage: ${context.parsed.y.toFixed(4)} V`;
                        },
                        title: function(context) {
                            return `Time: ${parseFloat(context[0].label).toFixed(2)} h`;
                        }
                    }
                }
            },
            scales: {
                x: createLinearScale('Cumulative Time (h)', {
                    titleColor: 'rgba(255,255,255,0.7)',
                    titleFont: { size: 12, weight: 500 },
                    ticks: {
                        color: 'rgba(255,255,255,0.5)',
                        callback: function(value) { return value.toFixed(1); }
                    }
                }),
                y: createLinearScale('Voltage (V vs. Na/Na+)', {
                    titleColor: 'rgba(255,255,255,0.7)',
                    titleFont: { size: 12, weight: 500 },
                    ticks: { color: 'rgba(255,255,255,0.5)' }
                })
            }
        })
    });
}

function renderGittProfileCapacityChart() {
    const canvas = document.getElementById('chartGittProfileCapacity');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (chartGittProfileCapacityInstance) {
        chartGittProfileCapacityInstance.destroy();
    }

    const mB = parseFloat(gittMassInput.value) || 1.033; // mg
    const activeDischarge = gittDischargeRuns[activeGittDischargeRunIdx];
    const activeCharge = gittChargeRuns[activeGittChargeRunIdx];
    
    const datasets = [];

    if (activeDischarge && activeDischarge.rawData.length > 0) {
        const qStart = activeDischarge.rawData[0].capacity;
        const stepSize = Math.max(1, Math.floor(activeDischarge.rawData.length / 1000));
        const sampled = [];
        for (let i = 0; i < activeDischarge.rawData.length; i += stepSize) {
            sampled.push(activeDischarge.rawData[i]);
        }
        if (sampled[sampled.length - 1] !== activeDischarge.rawData[activeDischarge.rawData.length - 1]) {
            sampled.push(activeDischarge.rawData[activeDischarge.rawData.length - 1]);
        }

        const dataPoints = sampled.map(d => ({
            x: Math.abs(d.capacity - qStart) * 1000000.0 / mB,
            y: d.voltage
        }));

        datasets.push(makeChartDataset(
            'Discharge (Sodiation)',
            dataPoints,
            '#06b6d4',
            'transparent',
            { borderWidth: 1.5 }
        ));
    }

    if (activeCharge && activeCharge.rawData.length > 0) {
        const qStart = activeCharge.rawData[0].capacity;
        const stepSize = Math.max(1, Math.floor(activeCharge.rawData.length / 1000));
        const sampled = [];
        for (let i = 0; i < activeCharge.rawData.length; i += stepSize) {
            sampled.push(activeCharge.rawData[i]);
        }
        if (sampled[sampled.length - 1] !== activeCharge.rawData[activeCharge.rawData.length - 1]) {
            sampled.push(activeCharge.rawData[activeCharge.rawData.length - 1]);
        }

        const dataPoints = sampled.map(d => ({
            x: Math.abs(d.capacity - qStart) * 1000000.0 / mB,
            y: d.voltage
        }));

        datasets.push(makeChartDataset(
            'Charge (Desodiation)',
            dataPoints,
            '#ec4899',
            'transparent',
            { borderWidth: 1.5 }
        ));
    }

    chartGittProfileCapacityInstance = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: datasets
        },
        options: createChartOptions({
            plugins: {
                legend: {
                    display: true,
                    labels: { color: 'rgba(255,255,255,0.7)', font: { size: 10 } }
                },
                tooltip: {
                    mode: 'nearest',
                    intersect: false,
                    callbacks: {
                        label: function(context) {
                            return `${context.dataset.label}: ${context.parsed.y.toFixed(4)} V at ${context.parsed.x.toFixed(1)} mAh/g`;
                        }
                    }
                }
            },
            scales: {
                x: createLinearScale('Specific Capacity (mAh/g)', {
                    titleColor: 'rgba(255,255,255,0.7)',
                    titleFont: { size: 12, weight: 500 },
                    ticks: {
                        color: 'rgba(255,255,255,0.5)',
                        callback: function(value) { return value.toFixed(1); }
                    }
                }),
                y: createLinearScale('Voltage (V vs. Na/Na+)', {
                    titleColor: 'rgba(255,255,255,0.7)',
                    titleFont: { size: 12, weight: 500 },
                    ticks: { color: 'rgba(255,255,255,0.5)' }
                })
            }
        })
    });
}

function renderGittDiffusionChart() {
    const canvas = document.getElementById('chartGittDiffusion');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (chartGittDiffusionInstance) {
        chartGittDiffusionInstance.destroy();
    }

    const showMode = gittShowModeSelect.value;
    
    let dischargePoints = gittResults.filter(r => r.mode === 'Discharge').map(r => ({ x: r.E_eq, y: r.logD }));
    let chargePoints = gittResults.filter(r => r.mode === 'Charge').map(r => ({ x: r.E_eq, y: r.logD }));

    dischargePoints.sort((a, b) => a.x - b.x);
    chargePoints.sort((a, b) => a.x - b.x);

    const datasets = [];

    if (showMode === 'both' || showMode === 'discharge') {
        datasets.push(makeChartDataset(
            'Discharge (Sodiation)',
            dischargePoints,
            '#06b6d4',
            '#06b6d4',
            { borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, fill: false }
        ));
    }

    if (showMode === 'both' || showMode === 'charge') {
        datasets.push(makeChartDataset(
            'Charge (Desodiation)',
            chargePoints,
            '#ec4899',
            '#ec4899',
            { borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, fill: false }
        ));
    }

    chartGittDiffusionInstance = new Chart(ctx, {
        type: 'scatter',
        data: { datasets: datasets },
        options: createChartOptions({
            plugins: {
                legend: {
                    display: true,
                    labels: { color: 'rgba(255,255,255,0.7)', font: { size: 11 } }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const dVal = Math.pow(10, context.parsed.y);
                            return `OCV: ${context.parsed.x.toFixed(4)} V, log₁₀D: ${context.parsed.y.toFixed(2)} (D: ${dVal.toExponential(2)} cm²/s)`;
                        }
                    }
                }
            },
            scales: {
                x: createLinearScale('Equilibrium Voltage E_eq (V vs. Na/Na+)', {
                    titleColor: 'rgba(255,255,255,0.7)',
                    titleFont: { size: 12, weight: 500 },
                    ticks: { color: 'rgba(255,255,255,0.5)' }
                }),
                y: createLinearScale('Diffusion Coefficient log₁₀(D / cm² s⁻¹)', {
                    titleColor: 'rgba(255,255,255,0.7)',
                    titleFont: { size: 12, weight: 500 },
                    ticks: { color: 'rgba(255,255,255,0.5)' }
                })
            }
        })
    });
}

function updateGittSummaryTable() {
    if (!tableGittSummaryBody) return;

    if (gittResults.length === 0) {
        tableGittSummaryBody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">GITT 분석 결과가 비어 있습니다.</td></tr>`;
        return;
    }

    const showMode = gittShowModeSelect.value;
    let filteredResults = gittResults;
    if (showMode === 'discharge') {
        filteredResults = gittResults.filter(r => r.mode === 'Discharge');
    } else if (showMode === 'charge') {
        filteredResults = gittResults.filter(r => r.mode === 'Charge');
    }

    let html = '';
    filteredResults.forEach(r => {
        const modeBadge = r.mode === 'Discharge' 
            ? `<span class="badge badge-info">방전</span>` 
            : `<span class="badge badge-success">충전</span>`;

        html += `
            <tr>
                <td>${modeBadge}</td>
                <td style="font-weight:600;">Pulse ${r.pulseNo}</td>
                <td>${r.E0.toFixed(4)}</td>
                <td>${r.E_tau.toFixed(4)}</td>
                <td>${r.E_eq.toFixed(4)}</td>
                <td>${r.dEt.toFixed(4)}</td>
                <td>${r.dEs.toFixed(4)}</td>
                <td style="font-family: monospace; font-weight:500;">${r.D.toExponential(3)}</td>
                <td style="font-weight:600; color:${r.mode === 'Discharge' ? '#06b6d4' : '#ec4899'};">${r.logD.toFixed(2)}</td>
            </tr>
        `;
    });

    tableGittSummaryBody.innerHTML = html;
}

function exportGittCsv() {
    if (gittResults.length === 0) {
        alert("내보낼 GITT 분석 결과가 없습니다.");
        return;
    }

    const data = [
        ["Mode", "PulseNo", "E0_V", "E_tau_V", "E_eq_OCV_V", "dEt_V", "dEs_V", "D_cm2_s", "log10D"]
    ];

    gittResults.forEach(r => {
        data.push([
            r.mode,
            r.pulseNo,
            r.E0,
            r.E_tau,
            r.E_eq,
            r.dEt,
            r.dEs,
            r.D,
            r.logD
        ]);
    });

    const worksheet = XLSX.utils.aoa_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "GITT Results");

    const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const formattedDate = `${yyyy}${mm}${dd}`;

    const cleanFilename = activeFilename ? activeFilename.textContent.replace(/\.[^.]+$/, '').trim() : 'GITT';
    const downloadName = `GITT결과_${cleanFilename}_${formattedDate}.xlsx`;

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function parseGittExcelData(jsonData, filename) {
    if (!jsonData || jsonData.length < 2) {
        alert("엑셀 데이터가 올바르지 않거나 비어 있습니다.");
        return;
    }

    let headerRowIndex = 0;
    for (let i = 0; i < Math.min(20, jsonData.length); i++) {
        const row = jsonData[i];
        if (row && row.some(cell => typeof cell === 'string' && (cell.toLowerCase().includes('time') || cell.toLowerCase().includes('step no')))) {
            headerRowIndex = i;
            break;
        }
    }

    const headers = jsonData[headerRowIndex].map(h => String(h || '').trim());
    console.log("GITT 엑셀 헤더 감지됨:", headers);

    let timeColIdx = -1;
    let stepColIdx = -1;
    let voltColIdx = -1;
    let currColIdx = -1;
    let capColIdx = -1;

    headers.forEach((h, idx) => {
        const lowerH = h.toLowerCase().trim();
        if (lowerH.includes('time') && (lowerH.includes('test') || lowerH.includes('cum') || lowerH.includes('total') || lowerH.includes('누적'))) {
            timeColIdx = idx;
        } else if (lowerH.includes('time') && (lowerH.includes('(s)') || lowerH.includes('test')) && timeColIdx === -1) {
            timeColIdx = idx;
        }
        
        if (lowerH.includes('step') && lowerH.includes('no') && stepColIdx === -1) {
            stepColIdx = idx;
        }
        
        if ((lowerH.includes('voltage') || lowerH.includes('potential') || lowerH.includes('전압') || lowerH === 'v') && !lowerH.includes('aux') && !lowerH.includes('-') && voltColIdx === -1) {
            voltColIdx = idx;
        } else if ((lowerH.includes('voltage') || lowerH.includes('potential') || lowerH.includes('전압') || lowerH === 'v') && voltColIdx === -1) {
            voltColIdx = idx;
        }
        
        if ((lowerH.includes('current') || lowerH.includes('전류') || lowerH === 'i') && currColIdx === -1) {
            currColIdx = idx;
        }
        
        if ((lowerH.includes('acc.q') || lowerH.includes('|q|') || lowerH.includes('cumulative capacity') || lowerH.includes('누적용량')) && capColIdx === -1) {
            capColIdx = idx;
        } else if ((lowerH.includes('capacity') || lowerH.includes('용량')) && capColIdx === -1) {
            capColIdx = idx;
        }
    });

    if (timeColIdx === -1 || stepColIdx === -1 || voltColIdx === -1) {
        alert("GITT 데이터 분석에 필요한 'Test Time(s)', 'Step No.', 'Voltage(V)' 컬럼을 찾을 수 없습니다.");
        return;
    }

    const dataRows = [];
    for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
        const row = jsonData[i];
        if (!row || row.length === 0) continue;

        const timeVal = parseFloat(row[timeColIdx]);
        const stepVal = Math.round(parseFloat(row[stepColIdx]));
        const voltVal = parseFloat(row[voltColIdx]);
        const currVal = currColIdx !== -1 ? parseFloat(row[currColIdx]) : 0;
        let capVal = 0;
        if (capColIdx !== -1 && row[capColIdx] !== undefined) {
            capVal = parseFloat(row[capColIdx]) || 0;
        }

        if (isNaN(timeVal) || isNaN(stepVal) || isNaN(voltVal)) continue;

        dataRows.push({
            time: timeVal,
            step: stepVal,
            voltage: voltVal,
            current: currVal,
            capacity: capVal
        });
    }

    if (dataRows.length === 0) {
        alert("유효한 GITT 데이터 행이 존재하지 않습니다.");
        return;
    }

    dataRows.sort((a, b) => a.time - b.time);
    gittRawData = dataRows;

    splitGittRuns(dataRows);

    isGittMode = true;

    if (gittConfigPanel) gittConfigPanel.style.display = 'block';
    if (configCard) configCard.style.display = 'none';

    const gittTabBtn = document.querySelector('.tab-btn[data-tab="tab-gitt"]');
    if (gittTabBtn) {
        tabButtons.forEach(b => b.classList.remove('active'));
        tabPanels.forEach(p => p.classList.remove('active'));
        gittTabBtn.classList.add('active');
        const pnl = document.getElementById('tab-gitt');
        if (pnl) pnl.classList.add('active');
    }

    if (activeFilename) activeFilename.textContent = filename;
    const badge = document.querySelector('.header-info .badge');
    if (badge) {
        badge.textContent = "LOADED";
        badge.className = "badge badge-info";
    }

    showDatasetNameModal(filename);
}

function splitGittRuns(dataRows) {
    gittDischargeRuns = [];
    gittChargeRuns = [];
    
    let currentRun = null;
    let lastMode = null;
    
    dataRows.forEach(d => {
        const isDischargeStep = (d.step === 2 || d.step === 3);
        const isChargeStep = (d.step === 4 || d.step === 5);
        
        if (isDischargeStep) {
            if (lastMode !== 'discharge') {
                currentRun = {
                    runIndex: gittDischargeRuns.length + 1,
                    rawData: [],
                    results: []
                };
                gittDischargeRuns.push(currentRun);
                lastMode = 'discharge';
            }
            currentRun.rawData.push(d);
        } else if (isChargeStep) {
            if (lastMode !== 'charge') {
                currentRun = {
                    runIndex: gittChargeRuns.length + 1,
                    rawData: [],
                    results: []
                };
                gittChargeRuns.push(currentRun);
                lastMode = 'charge';
            }
            currentRun.rawData.push(d);
        }
    });
    
    if (gittDischargeRuns.length === 0 && gittRawData.length > 0) {
        gittDischargeRuns.push({
            runIndex: 1,
            rawData: gittRawData.filter(d => d.step === 2 || d.step === 3),
            results: []
        });
    }
    if (gittChargeRuns.length === 0 && gittRawData.length > 0) {
        gittChargeRuns.push({
            runIndex: 1,
            rawData: gittRawData.filter(d => d.step === 4 || d.step === 5),
            results: []
        });
    }
    
    gittDischargeRuns.forEach(run => {
        run.results = calculateGittPulsesForData(run.rawData, 'Discharge');
    });
    gittChargeRuns.forEach(run => {
        run.results = calculateGittPulsesForData(run.rawData, 'Charge');
    });
    
    updateGittCycleSelectors();
}

function calculateGittPulsesForData(rawData, mode) {
    if (!rawData || rawData.length === 0) return [];
    
    let segments = [];
    let currentSegment = {
        stepNo: rawData[0].step,
        data: [rawData[0]]
    };

    for (let i = 1; i < rawData.length; i++) {
        const row = rawData[i];
        if (row.step !== currentSegment.stepNo) {
            segments.push(currentSegment);
            currentSegment = {
                stepNo: row.step,
                data: [row]
            };
        } else {
            currentSegment.data.push(row);
        }
    }
    segments.push(currentSegment);

    let results = [];
    let pulseCount = 0;

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const stepNo = seg.stepNo;

        if ((mode === 'Discharge' && stepNo === 2) || (mode === 'Charge' && stepNo === 4)) {
            const pulseData = seg.data;
            const pulseDuration = pulseData[pulseData.length - 1].time - pulseData[0].time;

            if (pulseDuration < 300 || pulseDuration > 900) {
                continue;
            }

            const prevSeg = i - 1 >= 0 ? segments[i - 1] : null;
            const nextSeg = i + 1 < segments.length ? segments[i + 1] : null;

            if (prevSeg && nextSeg) {
                const prevRestData = prevSeg.data;
                const nextRestData = nextSeg.data;

                const E0 = prevRestData[prevRestData.length - 1].voltage;
                const E_tau = pulseData[pulseData.length - 1].voltage;
                const E_eq = nextRestData[nextRestData.length - 1].voltage;

                const dEt = Math.abs(E_tau - E0);
                const dEs = Math.abs(E_eq - E0);
                const capacity = pulseData[pulseData.length - 1].capacity;

                results.push({
                    mode: mode,
                    pulseNo: ++pulseCount,
                    E0: E0,
                    E_tau: E_tau,
                    E_eq: E_eq,
                    dEt: dEt,
                    dEs: dEs,
                    dScaled: dEt > 0 ? (4 / (Math.PI * 600)) * Math.pow(dEs / dEt, 2) : 0,
                    capacity: capacity
                });
            }
        }
    }
    return results;
}

function updateGittCycleSelectors() {
    if (!gittDischargeCycleSelect || !gittChargeCycleSelect) return;
    
    gittDischargeCycleSelect.innerHTML = gittDischargeRuns.map((r, i) => 
        `<option value="${i}">방전 회차 ${r.runIndex} (${r.results.length} 펄스)</option>`
    ).join('');
    
    gittChargeCycleSelect.innerHTML = gittChargeRuns.map((r, i) => 
        `<option value="${i}">충전 회차 ${r.runIndex} (${r.results.length} 펄스)</option>`
    ).join('');
    
    activeGittDischargeRunIdx = 0;
    activeGittChargeRunIdx = 0;
}
