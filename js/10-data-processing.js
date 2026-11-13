/* ============================================================================
 * HC-Analyzer  ·  10-data-processing.js
 * 역할: 원시 데이터 파싱(Excel/텍스트) · 사이클 분리 · processData
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 10/15  (이전: js/09-dataset-library.js → 다음: js/11-analysis-metrics.js)
 * ============================================================================ */
/* ==========================================
   2. Parser & Data Processing
   ========================================== */

/**
 * 구간의 전압 추세로 충전/방전 방향을 판정합니다.
 * 앞쪽 1/3 평균 전압보다 뒤쪽 1/3 평균 전압이 높으면 충전(+1), 낮으면 방전(-1),
 * 판정할 수 없으면(포인트 부족·전압 변화 없음) 0 을 반환합니다.
 * 음극(방전 먼저)·양극(충전 먼저) 어느 쪽 데이터든 같은 규칙으로 판정됩니다.
 */
function detectSegmentDirection(points) {
    const n = points.length;
    if (n < 2) return 0;

    const span = Math.max(1, Math.floor(n / 3));
    let headSum = 0;
    let tailSum = 0;
    for (let k = 0; k < span; k++) {
        headSum += points[k].voltage;
        tailSum += points[n - 1 - k].voltage;
    }

    if (tailSum > headSum) return 1;
    if (tailSum < headSum) return -1;
    return 0;
}

/**
 * 전류 부호가 일반 규칙(충전 +, 방전 -)과 반대로 기록된 파일인지 판별합니다.
 * 사이클마다 +전류/-전류 가닥의 전압 추세를 확인해, 부호와 어긋나는 가닥이 더 많으면 true.
 */
function isCurrentSignInverted(cycles) {
    const MIN_STRAND_POINTS = 5;
    let agree = 0;
    let disagree = 0;

    Object.values(cycles).forEach(cycleData => {
        [1, -1].forEach(sign => {
            const strand = cycleData.all.filter(p => (sign > 0 ? p.current > 0 : p.current < 0));
            if (strand.length < MIN_STRAND_POINTS) return;
            const dir = detectSegmentDirection(strand);
            if (dir === 0) return;
            if (dir === sign) agree++;
            else disagree++;
        });
    });

    return disagree > agree;
}

/**
 * 사이클이 충전부터 시작하는지(양극 반쪽전지·풀셀) 방전부터 시작하는지(음극 반쪽전지)를
 * 사이클별 다수결로 판별합니다. 판별 근거가 없으면 null 을 반환합니다.
 * chargeSign: 충전에 해당하는 전류 부호(+1 또는 -1)
 */
function detectChargeFirst(cycles, chargeSign) {
    let chargeFirstVotes = 0;
    let dischargeFirstVotes = 0;

    Object.values(cycles).forEach(cycleData => {
        const points = cycleData.all;
        const firstCharge = points.findIndex(p => p.current * chargeSign > 0);
        const firstDischarge = points.findIndex(p => p.current * chargeSign < 0);
        if (firstCharge === -1 || firstDischarge === -1) return;
        if (firstCharge < firstDischarge) chargeFirstVotes++;
        else dischargeFirstVotes++;
    });

    if (chargeFirstVotes === 0 && dischargeFirstVotes === 0) return null;
    return chargeFirstVotes > dischargeFirstVotes;
}

/**
 * 쿨롱 효율(%)을 셀 종류에 맞춰 계산합니다. 계산할 수 없으면 null.
 *  - 방전 먼저(음극 반쪽전지): 충전 용량 / 방전 용량
 *  - 충전 먼저(양극 반쪽전지·풀셀, chargeFirst === true): 방전 용량 / 충전 용량
 * chargeFirst 정보가 없는 기존 저장 데이터는 종전과 같이 음극 기준으로 계산합니다.
 */
function calcCoulombicEfficiency(cycleData) {
    if (!cycleData) return null;
    const charge = cycleData.totalChargeCap;
    const discharge = cycleData.totalDischargeCap;
    if (typeof charge !== 'number' || typeof discharge !== 'number') return null;

    const numerator = cycleData.chargeFirst === true ? discharge : charge;
    const denominator = cycleData.chargeFirst === true ? charge : discharge;
    return denominator > 0 ? (numerator / denominator) * 100 : null;
}

/**
 * 엑셀 또는 텍스트 파일에서 파싱된 행 데이터를 정규화하고,
 * 사이클 컬럼이 없거나 불명확한 경우 Rest 구간을 자동 감지하여 스킵하고 사이클을 쪼갭니다.
 */
function normalizeAndSplitCycles(dataRows, isAhUnit) {
    const rawData = [];

    // 1. Ah/g 단위를 mAh/g 단위로 변환
    dataRows.forEach(row => {
        if (isAhUnit) {
            row.capacity = row.capacity * 1000.0;
        }
    });

   // [메모리 최적화 · 핵심] 초대용량 파일을 '읽는 즉시' 축소 (Rest/경계 포인트는 보존 → 사이클·용량 정확도 유지)
    const MAX_RAW_POINTS = 50000;
    if (dataRows.length > MAX_RAW_POINTS) {
        const _REST = 0.05;
        const _stride = Math.ceil(dataRows.length / MAX_RAW_POINTS);
        const _reduced = [];
        for (let _i = 0; _i < dataRows.length; _i++) {
            const _cap = dataRows[_i].capacity;
            const _isRest = _cap <= _REST;
            const _prevRest = _i > 0 && dataRows[_i - 1].capacity <= _REST;
            const _nextRest = _i < dataRows.length - 1 && dataRows[_i + 1].capacity <= _REST;
            if (_isRest || _prevRest || _nextRest || (_i % _stride === 0)) {
                _reduced.push(dataRows[_i]);
            }
        }
        console.log(`[메모리 최적화] 원시 포인트 ${dataRows.length} → ${_reduced.length} 로 조기 축소`);
        dataRows = _reduced;
    }
   
    // 2. 파일에 유효한 사이클 정보가 있으면 우선 사용 (인덱스 열 오인 방지: 사이클당 최소 20포인트)
    const uniqueCycles = new Set(dataRows.map(r => r.excelCycle).filter(c => c > 0));
    const avgPointsPerCycle = uniqueCycles.size > 0 ? (dataRows.length / uniqueCycles.size) : 0;
    const hasValidCycle = dataRows.some(r => r.excelCycle > 0) &&
                         uniqueCycles.size > 1 &&
                         avgPointsPerCycle >= 20;

    if (hasValidCycle) {
        console.log("기존 파일의 사이클 정보를 그대로 활용하여 로드합니다.");
        dataRows.forEach(row => {
            rawData.push([
                row.excelCycle > 0 ? row.excelCycle : 1,
                row.voltage,
                row.capacity,
                row.excelCurrent
            ]);
        });
        return rawData;
    }

    // 3. 사이클 정보가 없거나 불명확한 경우: 자동 사이클 및 Rest 감지 알고리즘 가동
    console.log("사이클 정보 미감지 -> 자동 사이클 분리 및 Rest 구간 필터링을 실행합니다.");

    const REST_THRESHOLD = 0.05;
    const segments = [];
    let currentSeg = [];

    for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const c = row.capacity;

        if (c <= REST_THRESHOLD) {
            if (currentSeg.length > 0) {
                if (currentSeg.length >= 5) {
                    segments.push(currentSeg);
                }
                currentSeg = [];
            }
            continue;
        }

        if (currentSeg.length === 0) {
            if (i > 0) {
                currentSeg.push(dataRows[i - 1]);
            }
        }

        if (currentSeg.length > 0) {
            const prevRow = currentSeg[currentSeg.length - 1];
            if (prevRow.capacity > REST_THRESHOLD && c < prevRow.capacity - 5.0) {
                if (currentSeg.length >= 5) {
                    segments.push(currentSeg);
                }
                currentSeg = [prevRow, row];
                continue;
            }
        }

        currentSeg.push(row);
    }

    if (currentSeg.length >= 5) {
        segments.push(currentSeg);
    }

    console.log(`자동 분리된 유효 충방전 세그먼트 개수: ${segments.length}`);

    // 구간 방향은 순서(첫 구간 = 방전)로 가정하지 않고 전압 추세로 판정한다.
    // → 충전부터 시작하는 양극 데이터도 충전/방전이 뒤바뀌지 않는다.
    let cycleCounter = 0;
    let firstDir = 0;
    let prevDir = 0;
    segments.forEach((seg, idx) => {
        let dir = detectSegmentDirection(seg);
        if (dir === 0) {
            // 전압 추세로 판정 불가: 직전 구간의 반대 방향, 첫 구간이면 종전 규칙(방전)으로 처리
            dir = prevDir !== 0 ? -prevDir : -1;
            console.warn(`세그먼트 ${idx + 1}: 전압 추세로 방향을 판정할 수 없어 ${dir > 0 ? '충전' : '방전'}으로 간주합니다.`);
        }
        if (firstDir === 0) firstDir = dir;

        // 첫 구간과 같은 방향이 다시 나오거나, 같은 방향이 연달아 나오면 새 사이클
        if (dir === firstDir || dir === prevDir) {
            cycleCounter++;
        }
        prevDir = dir;

        const virtualCurrent = dir > 0 ? 1.0 : -1.0;
        seg.forEach(row => {
            rawData.push([
                cycleCounter,
                row.voltage,
                row.capacity,
                virtualCurrent
            ]);
        });
    });

    if (rawData.length === 0) {
        console.warn("충방전 세그먼트 자동 검출에 실패하여 전체 데이터를 1 사이클로 구성합니다.");
        dataRows.forEach(row => {
            rawData.push([
                1,
                row.voltage,
                row.capacity,
                row.excelCurrent || (row.voltage > 1.5 ? 1.0 : -1.0)
            ]);
        });
    }

    return rawData;
}

/**
 * 일반 분석 페이지에서 GITT 파일 업로드를 감지/차단합니다.
 */
function blockGittOnGeneralPage() {
    const confirmMove = confirm(
        "이 파일은 GITT 분석용 데이터로 감지되었습니다.\n" +
        "일반 분석 페이지에서는 GITT 데이터를 분석할 수 없습니다.\n" +
        "GITT 분석 페이지(gitt.html)로 이동하시겠습니까?"
    );
    if (confirmMove) {
        window.location.href = "gitt.html";
    }

    _fileQueue = [];
    _parsedQueue = [];
    _currentQueueFile = '';

    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';

    const dropZone = document.getElementById('dropZone');
    if (dropZone) dropZone.classList.remove('drag-active');

    return true;
}

/**
 * Excel 데이터를 파싱하여 정규화 구조로 변환합니다.
 */
function parseExcelData(jsonData, filename) {
    if (!jsonData || jsonData.length < 2) {
        alert("엑셀 데이터가 올바르지 않거나 비어 있습니다.");
        return false;
    }

    const isGittFile = filename.toLowerCase().includes('gitt') ||
                       jsonData.some(row => row && row.some(cell => typeof cell === 'string' && (cell.toLowerCase().includes('step no') || cell.toLowerCase().includes('test time'))));

    if (isGittFile) {
        blockGittOnGeneralPage();
        return false;
    }

    if (currentAnalysisMode !== 'general') {
        setAnalysisMode('general');
    }

    let headerRowIndex = 0;
    for (let i = 0; i < Math.min(20, jsonData.length); i++) {
        const row = jsonData[i];
        if (row && row.some(cell => typeof cell === 'string' && (cell.includes('전압') || cell.includes('용량') || cell.includes('voltage') || cell.includes('capacity') || cell.includes('v vs') || cell.includes('|용량_s|')))) {
            headerRowIndex = i;
            break;
        }
    }

    const headers = jsonData[headerRowIndex].map(h => String(h || '').trim());
    console.log("엑셀 헤더 감지됨:", headers);

    let voltColIdx = -1;
    let capColIdx = -1;
    let cycleColIdx = -1;
    let currColIdx = -1;
    let isAhUnit = false;

    headers.forEach((h, idx) => {
        const lowerH = h.toLowerCase();
        if (lowerH.includes('전압') || lowerH.includes('voltage') || lowerH.includes('v vs')) {
            voltColIdx = idx;
        } else if (lowerH.includes('용량') || lowerH.includes('capacity') || lowerH.includes('cap') || lowerH.includes('|용량_s|')) {
            capColIdx = idx;
            if (lowerH.includes('ah/g') && !lowerH.includes('mah/g')) {
                isAhUnit = true;
            }
        } else if (lowerH.includes('사이클') || lowerH.includes('cycle')) {
            cycleColIdx = idx;
        } else if (lowerH.includes('전류') || lowerH.includes('current')) {
            currColIdx = idx;
        }
    });

    if (voltColIdx === -1 || capColIdx === -1) {
        alert("엑셀 시트에서 '전압' 및 '용량' 컬럼을 찾을 수 없습니다. 헤더 이름을 확인해 주십시오.");
        return false;
    }

    const dataRows = [];
    for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
        const row = jsonData[i];
        if (!row || row.length === 0) continue;

        const voltVal = parseFloat(row[voltColIdx]);
        const capVal = parseFloat(row[capColIdx]);

        if (isNaN(voltVal) || isNaN(capVal)) continue;

        const cycleVal = cycleColIdx !== -1 ? Math.round(parseFloat(row[cycleColIdx])) : -1;
        const currVal = currColIdx !== -1 ? parseFloat(row[currColIdx]) : 0;

        dataRows.push({
            voltage: voltVal,
            capacity: capVal,
            excelCycle: cycleVal,
            excelCurrent: currVal,
            rawIndex: i
        });
    }

    if (dataRows.length === 0) {
        alert("유효한 데이터 행이 존재하지 않습니다.");
        return false;
    }

    const parsedData = normalizeAndSplitCycles(dataRows, isAhUnit);
    rawBatteryData = parsedData;

    headerColumns = ["Cycle", "Voltage(V)", "Capacity(mAh/g)", "Current(mA)"];
    mappedColumns = {
        cycle: 0,
        voltage: 1,
        capacity: 2,
        current: 3
    };

    activeFilename.textContent = filename;
    document.querySelector('.header-info .badge').textContent = "LOADED";
    document.querySelector('.header-info .badge').className = "badge badge-info";

    processData();
    if (!_currentQueueFile) {
        showDatasetNameModal(filename);
    }
    return true;
}

/**
 * 텍스트 데이터(CSV, TSV, TXT 등)를 파싱하여 정규화 구조로 변환합니다.
 */
function parseRawText(text, filename, encoding = 'UTF-8') {
    const isGittText = filename.toLowerCase().includes('gitt') || text.toLowerCase().includes('step no') || text.toLowerCase().includes('test time');
    if (isGittText) {
        blockGittOnGeneralPage();
        return PARSE_BLOCKED_GITT;
    }

    if (currentAnalysisMode !== 'general') {
        setAnalysisMode('general');
    }

    activeFilename.textContent = filename;
    document.querySelector('.header-info .badge').textContent = "LOADED";
    document.querySelector('.header-info .badge').className = "badge badge-info";

    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return false;

    let headerIndex = -1;
    for (let i = 0; i < Math.min(30, lines.length); i++) {
        const line = lines[i].trim();
        if (line === '') continue;
        const lowerLine = line.toLowerCase();
        if (lowerLine.includes('전압') || lowerLine.includes('voltage') || lowerLine.includes('v vs') ||
            lowerLine.includes('capacity') || lowerLine.includes('용량') || lowerLine.includes('cap') ||
            lowerLine.includes('|용량_s|') || lowerLine.includes('인덱스')) {
            headerIndex = i;
            break;
        }
    }
    if (headerIndex === -1) {
        headerIndex = 0;
        while (headerIndex < lines.length && lines[headerIndex].trim() === '') {
            headerIndex++;
        }
    }

    const headerLine = lines[headerIndex];
    let delimiter = ',';
    if (headerLine.includes('\t')) {
        delimiter = '\t';
    } else if (headerLine.includes(';')) {
        delimiter = ';';
    } else if (headerLine.includes(',')) {
        delimiter = ',';
    } else {
        delimiter = /\s+/;
    }

    const headers = headerLine.split(delimiter).map(h => h.replace(/"/g, '').trim()).filter(h => h !== '');
    console.log(`텍스트 헤더 감지됨 (${encoding}):`, headers);

    let voltColIdx = -1;
    let capColIdx = -1;
    let cycleColIdx = -1;
    let currColIdx = -1;
    let isAhUnit = false;

    headers.forEach((h, idx) => {
        const lowerH = h.toLowerCase().trim();
        if (lowerH.includes('전압') || lowerH.includes('voltage') || lowerH.includes('v vs') || lowerH.includes('potential') || lowerH.includes('volt') || lowerH.includes('전압(v)')) {
            voltColIdx = idx;
        } else if (lowerH.includes('용량') || lowerH.includes('capacity') || lowerH.includes('cap') || lowerH.includes('|용량_s|') || lowerH.includes('ah/g') || lowerH.includes('비용량')) {
            capColIdx = idx;
            if (lowerH.includes('ah/g') && !lowerH.includes('mah/g')) {
                isAhUnit = true;
            }
        } else if (lowerH.includes('사이클') || lowerH.includes('cycle') || lowerH.includes('인덱스') || lowerH.includes('index') || lowerH.includes('step')) {
            cycleColIdx = idx;
        } else if (lowerH.includes('전류') || lowerH.includes('current') || lowerH.includes('curr') || lowerH.includes('i (')) {
            currColIdx = idx;
        }
    });

    if (voltColIdx === -1 || capColIdx === -1) {
        console.warn(`컬럼 감지 실패 -> 전압: ${voltColIdx}, 용량: ${capColIdx} (${encoding})`);
        return false;
    }

    const dataRows = [];
    for (let i = headerIndex + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '') continue;

        const parts = line.split(delimiter).map(p => parseFloat(p.trim()));
        if (parts.length <= Math.max(voltColIdx, capColIdx)) continue;

        const voltVal = parts[voltColIdx];
        const capVal = parts[capColIdx];
        if (isNaN(voltVal) || isNaN(capVal)) continue;

        const cycleVal = cycleColIdx !== -1 ? Math.round(parts[cycleColIdx]) : -1;
        const currVal = currColIdx !== -1 ? parts[currColIdx] : 0;

        dataRows.push({
            voltage: voltVal,
            capacity: capVal,
            excelCycle: cycleVal,
            excelCurrent: currVal,
            rawIndex: i
        });
    }

    if (dataRows.length === 0) {
        return false;
    }

    const parsedData = normalizeAndSplitCycles(dataRows, isAhUnit);
    rawBatteryData = parsedData;

    headerColumns = ["Cycle", "Voltage(V)", "Capacity(mAh/g)", "Current(mA)"];
    mappedColumns = {
        cycle: 0,
        voltage: 1,
        capacity: 2,
        current: 3
    };

    processData();
    if (!_currentQueueFile) {
        showDatasetNameModal(filename);
    }
    return true;
}

/**
 * 원시 데이터를 사이클별로 정리하고 충전(Desodiation)/방전(Sodiation)으로 분리합니다.
 * 변수명은 음극 기준(sodiation = 방전, desodiation = 충전)이지만,
 * 양극 데이터에서도 방전 가닥은 sodiation, 충전 가닥은 desodiation 에 담깁니다.
 */
function processData() {
    processedCycles = {};

    const cycleIdx = mappedColumns.cycle;
    const voltIdx = mappedColumns.voltage;
    const capIdx = mappedColumns.capacity;
    const currIdx = mappedColumns.current;

    rawBatteryData.forEach(row => {
        const cycleNum = Math.round(row[cycleIdx]);
        const voltage = row[voltIdx];
        const capacity = row[capIdx];
        const current = row[currIdx];

        if (!processedCycles[cycleNum]) {
            processedCycles[cycleNum] = {
                all: [],
                sodiation: [],
                desodiation: [],
                rawSodiation: [],
                rawDesodiation: []
            };
        }

        processedCycles[cycleNum].all.push({ voltage, capacity, current });
    });

    // 전류 부호가 반대로 기록된 파일이면 부호를 뒤집어 해석 (전압 추세로 검증)
    const chargeSign = isCurrentSignInverted(processedCycles) ? -1 : 1;
    if (chargeSign < 0) {
        console.log("전류 부호가 전압 추세와 반대로 기록되어 있어, 부호를 뒤집어 충전/방전을 분류합니다.");
    }

    // 충전 먼저(양극·풀셀) / 방전 먼저(음극) 자동 판별 → 쿨롱 효율 계산 기준으로 사용
    const chargeFirst = detectChargeFirst(processedCycles, chargeSign);
    if (chargeFirst !== null) {
        console.log(`셀 종류 자동 판별: ${chargeFirst ? '충전 먼저(양극 반쪽전지·풀셀)' : '방전 먼저(음극 반쪽전지)'}`);
        Object.values(processedCycles).forEach(cycleData => { cycleData.chargeFirst = chargeFirst; });
    }

    for (const [cycleNum, cycleData] of Object.entries(processedCycles)) {
        const points = cycleData.all;
        if (points.length < 2) continue;

        const rawSod = points.filter(p => p.current * chargeSign < 0);
        const rawDesod = points.filter(p => p.current * chargeSign > 0);

        if (rawSod.length > 0) {
            const sodStartCap = rawSod[0].capacity;
            cycleData.sodiation = rawSod.map((p) => ({
                voltage: p.voltage,
                capacity: p.capacity - sodStartCap,
                current: p.current
            }));
            cycleData.totalDischargeCap = cycleData.sodiation[cycleData.sodiation.length - 1].capacity;
        }

        if (rawDesod.length > 0) {
            const desodStartCap = rawDesod[0].capacity;
            cycleData.desodiation = rawDesod.map((p) => ({
                voltage: p.voltage,
                capacity: p.capacity - desodStartCap,
                current: p.current
            }));
            cycleData.totalChargeCap = cycleData.desodiation[cycleData.desodiation.length - 1].capacity;
        }

        // [메모리 최적화] 저장용 곡선 포인트 상한 적용.
        //  - ICE / 방전·충전 용량은 위에서 '원본 전체' 기준으로 이미 계산되어 수치 결과는 바뀌지 않습니다.
        //  - 수십만 포인트짜리 대용량 파일을 여러 개 로드할 때의 Out-of-memory 방지.
        const STORE_MAX_POINTS = 1000;
        if (cycleData.sodiation.length > STORE_MAX_POINTS) {
            cycleData.sodiation = downsamplePoints(cycleData.sodiation, STORE_MAX_POINTS);
        }
        if (cycleData.desodiation.length > STORE_MAX_POINTS) {
            cycleData.desodiation = downsamplePoints(cycleData.desodiation, STORE_MAX_POINTS);
        }
        cycleData.all = [];
        cycleData.rawSodiation = [];
        cycleData.rawDesodiation = [];
    }

    const currentSelected = targetCycleSelect.value;

    targetCycleSelect.innerHTML = '';
    if (targetCycleSelectSP) targetCycleSelectSP.innerHTML = '';
    if (targetCycleDqDv) targetCycleDqDv.innerHTML = '';

    const cycleNumbers = Object.keys(processedCycles).map(Number).sort((a, b) => a - b);

    const fragment1 = document.createDocumentFragment();
    const fragment2 = document.createDocumentFragment();
    const fragment3 = document.createDocumentFragment();

    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = '전체 사이클 (All)';
    fragment1.appendChild(optAll);

    cycleNumbers.forEach(cycleNum => {
        const opt1 = document.createElement('option');
        opt1.value = cycleNum;
        opt1.textContent = `${cycleNum} Cycle`;
        fragment1.appendChild(opt1);

        if (targetCycleSelectSP) {
            const opt2 = document.createElement('option');
            opt2.value = cycleNum;
            opt2.textContent = `${cycleNum} Cycle`;
            fragment2.appendChild(opt2);
        }

        if (targetCycleDqDv) {
            const opt3 = document.createElement('option');
            opt3.value = cycleNum;
            opt3.textContent = `${cycleNum} Cycle`;
            fragment3.appendChild(opt3);
        }
    });

    targetCycleSelect.appendChild(fragment1);
    if (targetCycleSelectSP) targetCycleSelectSP.appendChild(fragment2);
    if (targetCycleDqDv) targetCycleDqDv.appendChild(fragment3);

    const finalSelected = (currentSelected === 'all' || cycleNumbers.includes(parseInt(currentSelected))) ? currentSelected : 'all';
    targetCycleSelect.value = finalSelected;
    if (targetCycleSelectSP) {
        targetCycleSelectSP.value = (currentSelected === 'all' || !cycleNumbers.includes(parseInt(currentSelected))) ? (cycleNumbers[0] || '1') : currentSelected;
    }
    if (targetCycleDqDv) {
        const prevVal = targetCycleDqDv.value;
        const prevCyc = parseInt(prevVal);
        if (prevCyc > 0 && cycleNumbers.includes(prevCyc)) {
            targetCycleDqDv.value = prevVal;
            if (!selectedDqDvCycles.includes(prevCyc)) {
                selectedDqDvCycles = [prevCyc];
            }
        } else {
            const dVal = (currentSelected === 'all' || !cycleNumbers.includes(parseInt(currentSelected))) ? (cycleNumbers[0] || '1').toString() : currentSelected;
            targetCycleDqDv.value = dVal;
            const cNum = parseInt(dVal);
            if (!isNaN(cNum)) {
                selectedDqDvCycles = [cNum];
            }
        }
        renderCycleChipsUI();
    }
    renderProfileCycleChipsUI();
}
