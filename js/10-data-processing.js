
    const REST_THRESHOLD = 0.05;

    // ACTIVE 영역을 찾기 위한 인덱스 그룹들 생성
    const segments = [];
    let currentSeg = [];

    for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const c = row.capacity;

        if (c <= REST_THRESHOLD) {
            // REST 상태
            if (currentSeg.length > 0) {
                // 활성 구간 마감 시, REST 포인트를 끝에 붙이지 않고 마감합니다.
                // (끝에 붙이면 마지막 원소 용량이 0이 되어 용량 연산이 왜곡됩니다.)
                if (currentSeg.length >= 5) {
                    segments.push(currentSeg);
                }
                currentSeg = [];
            }
            continue;
        }

        // ACTIVE 상태 시작
        if (currentSeg.length === 0) {
            // 활성 구간 시작 시, 직전 REST 포인트(경계점, 용량 0인 시점)를 처음에 붙여주어 시작 전압 유실 방지
            if (i > 0) {
                currentSeg.push(dataRows[i - 1]);
            }
        }

        // 충방전 도중 급격한 용량 감소(단계 리셋 등)가 있는 경우 세그먼트 마감
        if (currentSeg.length > 0) {
            const prevRow = currentSeg[currentSeg.length - 1];
            // REST에서 땡겨온 직전 행이 아닌 진짜 활성 데이터끼리 비교하기 위해 인덱스 체크
            if (prevRow.capacity > REST_THRESHOLD && c < prevRow.capacity - 5.0) {
                if (currentSeg.length >= 5) {
                    segments.push(currentSeg);
                }
                // 새로운 세그먼트 시작 시 이전 마지막 포인트(경계점)를 앞에 붙임
                currentSeg = [prevRow, row];
                continue;
            }
        }

        currentSeg.push(row);
    }

    // 루프가 끝났을 때 마감되지 않은 세그먼트 처리
    if (currentSeg.length >= 5) {
        segments.push(currentSeg);
    }

    console.log(`자동 분리된 유효 충방전 세그먼트 개수: ${segments.length}`);

    // (C) 각 세그먼트별 순서에 따른 충/방전 판정 및 가상 사이클 번호 할당
    // 프로토콜 규칙: 방전 -> 충전 -> 방전 -> 충전이 순차적으로 반복됨
    let cycleCounter = 0;
    segments.forEach((seg, idx) => {
        // 홀수 번째 활성 세그먼트(idx = 0, 2, 4...)는 방전(Sodiation)
        // 짝수 번째 활성 세그먼트(idx = 1, 3, 5...)는 충전(Desodiation)
        const isSodiation = (idx % 2 === 0);

        if (isSodiation) {
            cycleCounter++; // 새로운 방전이 시작될 때마다 사이클 번호 증가
        }

        const virtualCurrent = isSodiation ? -1.0 : 1.0;

        seg.forEach(row => {
            rawData.push([
                cycleCounter,
                row.voltage,
                row.capacity,
                virtualCurrent
            ]);
        });
    });

    // 만약 세그먼트가 아예 없거나 너무 작아 검출되지 않은 경우, 전체 데이터를 1사이클로 폴백
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
 * Excel 데이터를 파싱하여 정규화 구조로 변환합니다.
 */
/**
 * 일반 분석 페이지(index.html)에서 GITT 파일이 업로드되는 것을 감지하고 차단합니다.
 * 사용자에게 gitt.html로 이동할지 물어본 후, 이동을 확인하면 gitt.html로 보내고,
 * 거절하면 업로드를 중단하고 업로드 대기열 큐를 비웁니다.
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
    
    // 업로드 대기열 비우기 및 상태 초기화
    _fileQueue = [];
    _parsedQueue = [];
    _currentQueueFile = '';
    
    // 파일 입력 초기화
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
    
    // 드롭존 효과 해제
    const dropZone = document.getElementById('dropZone');
    if (dropZone) dropZone.classList.remove('drag-active');
    
    return true; // 차단됨
}

/**
 * Excel 데이터를 파싱하여 정규화 구조로 변환합니다.
 */
function parseExcelData(jsonData, filename) {
    if (!jsonData || jsonData.length < 2) {
        alert("엑셀 데이터가 올바르지 않거나 비어 있습니다.");
        return false;
    }

    // GITT 데이터 판정
    const isGittFile = filename.toLowerCase().includes('gitt') || 
                       jsonData.some(row => row && row.some(cell => typeof cell === 'string' && (cell.toLowerCase().includes('step no') || cell.toLowerCase().includes('test time'))));
    
    if (isGittFile) {
        blockGittOnGeneralPage();
        return false;
    }

    if (currentAnalysisMode !== 'general') {
        setAnalysisMode('general');
    }

    // 헤더 컬럼 자동 감지 (상위 20줄 내 검색)
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

    // 공통 함수를 사용한 정규화 및 사이클 자동 검출
    const parsedData = normalizeAndSplitCycles(dataRows, isAhUnit);
    
    // 루프 돌기 전 이미 다운샘플링하여 적재했으므로 메모리 카피만 수행
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



    processData(); // processedCycles 배열 구성
    // 큐 파싱 중이면 모달 호출을 건너뜁니다 (onQueueFileParsed에서 일괄 처리)
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
        return PARSE_BLOCKED_GITT; // 일반 파싱 실패(false)와 명확히 구분
    }

    if (currentAnalysisMode !== 'general') {
        setAnalysisMode('general');
    }

    activeFilename.textContent = filename;
    document.querySelector('.header-info .badge').textContent = "LOADED";
    document.querySelector('.header-info .badge').className = "badge badge-info";

    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return false;

    // 헤더 행 위치 자동 감색 (상위 30줄 검색하여 키워드 매칭)
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
        delimiter = /\s+/; // 연속된 공백 구분자 지원
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

    // 전압 또는 용량 컬럼을 찾지 못한 경우 (한글 깨짐 등의 사유일 수 있음)
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

    // 공통 함수를 사용한 정규화 및 사이클 자동 검출
    const parsedData = normalizeAndSplitCycles(dataRows, isAhUnit);
    
    // 루프 돌기 전 이미 다운샘플링하여 적재했으므로 메모리 카피만 수행
    rawBatteryData = parsedData;

    headerColumns = ["Cycle", "Voltage(V)", "Capacity(mAh/g)", "Current(mA)"];
    mappedColumns = {
        cycle: 0,
        voltage: 1,
        capacity: 2,
        current: 3
    };



    processData(); // processedCycles 배열 구성
    // 큐 파싱 중이면 모달 호출을 건너뜁니다 (onQueueFileParsed에서 일괄 처리)
    if (!_currentQueueFile) {
        showDatasetNameModal(filename);
    }
    return true;
}





/**
 * Organizes raw data points into cycles and splits them into Charge (Desodiation) / Discharge (Sodiation)
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
                sodiation: [],  // Discharge (Voltage going down, Na insertion)
                desodiation: [], // Charge (Voltage going up, Na extraction)
                rawSodiation: [],
                rawDesodiation: []
            };
        }
        
        processedCycles[cycleNum].all.push({ voltage, capacity, current });
    });

    // Splitting Logic based on actual current direction (derived from capacity 0 rest states)
    for (const [cycleNum, cycleData] of Object.entries(processedCycles)) {
        const points = cycleData.all;
        if (points.length < 2) continue;

        // current < 0 이면 Sodiation(방전), current > 0 이면 Desodiation(충전)으로 분류
        const rawSod = points.filter(p => p.current < 0);
        const rawDesod = points.filter(p => p.current > 0);

        // 방전/충전 각 구간의 capacity를 0에서 시작하도록 정규화합니다.
        // (장비에 따라 방전 시작 시 capacity가 0이 아닌 값일 수 있으므로 시작점을 빼줍니다)
        if (rawSod.length > 0) {
            const sodStartCap = rawSod[0].capacity;
            cycleData.sodiation = rawSod.map((p) => ({
                voltage: p.voltage,
                capacity: p.capacity - sodStartCap, // 0부터 시작하도록 정규화
                current: p.current
            }));
            // 마지막 포인트의 정규화된 capacity = 실제 방전 용량
            cycleData.totalDischargeCap = cycleData.sodiation[cycleData.sodiation.length - 1].capacity;
        }

        if (rawDesod.length > 0) {
            const desodStartCap = rawDesod[0].capacity;
            cycleData.desodiation = rawDesod.map((p) => ({
                voltage: p.voltage,
                capacity: p.capacity - desodStartCap, // 0부터 시작하도록 정규화
                current: p.current
            }));
            // 마지막 포인트의 정규화된 capacity = 실제 충전 용량
            cycleData.totalChargeCap = cycleData.desodiation[cycleData.desodiation.length - 1].capacity;
        }

        // [메모리 최적화] 저장용 곡선 포인트 상한 적용.
        //  - ICE / 방전·충전 용량(totalDischargeCap, totalChargeCap)은 위에서 '원본 전체' 기준으로
        //    이미 계산되었으므로 이 축소는 저장/렌더용 곡선에만 영향을 주며 수치 결과는 바뀌지 않습니다.
        //  - 수십만 포인트짜리 대용량 파일을 여러 개 로드할 때의 Out-of-memory(브라우저 메모리 부족)를 방지합니다.
        const STORE_MAX_POINTS = 1000;
        if (cycleData.sodiation.length > STORE_MAX_POINTS) {
            cycleData.sodiation = downsamplePoints(cycleData.sodiation, STORE_MAX_POINTS);
        }
        if (cycleData.desodiation.length > STORE_MAX_POINTS) {
            cycleData.desodiation = downsamplePoints(cycleData.desodiation, STORE_MAX_POINTS);
        }
        // 분할이 끝나면 더 이상 사용하지 않는 원본 배열을 즉시 비워 메모리를 추가로 절감합니다.
        // (기존에도 데이터셋 저장 스냅샷 단계에서 삭제되던 항목이라 다운스트림 영향 없음)
        cycleData.all = [];
        cycleData.rawSodiation = [];
        cycleData.rawDesodiation = [];
    }

    // Populate Target Cycle selectors
    const currentSelected = targetCycleSelect.value;
    
    targetCycleSelect.innerHTML = '';
    if (targetCycleSelectSP) targetCycleSelectSP.innerHTML = '';
    if (targetCycleDqDv) targetCycleDqDv.innerHTML = '';
    
    const cycleNumbers = Object.keys(processedCycles).map(Number).sort((a, b) => a - b);
    
    const fragment1 = document.createDocumentFragment();
    const fragment2 = document.createDocumentFragment();
    const fragment3 = document.createDocumentFragment();
    
    // 개요 및 ICE 탭용 전체 사이클 선택지 추가
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = '전체 사이클 (All)';
    fragment1.appendChild(optAll);
    
    cycleNumbers.forEach(cycleNum => {
        // 개요 및 ICE 탭용
        const opt1 = document.createElement('option');
        opt1.value = cycleNum;
        opt1.textContent = `${cycleNum} Cycle`;
        fragment1.appendChild(opt1);
        
        // Slope / Plateau 탭용
        if (targetCycleSelectSP) {
            const opt2 = document.createElement('option');
            opt2.value = cycleNum;
            opt2.textContent = `${cycleNum} Cycle`;
            fragment2.appendChild(opt2);
        }

        // dQ/dV 탭용
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
