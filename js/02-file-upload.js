/* ============================================================================
 * HC-Analyzer  ·  02-file-upload.js
 * 역할: 파일 업로드(드래그&드롭/선택) · 다중 파일 큐 파싱 헬퍼
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 02/15  (이전: js/01-core.js → 다음: js/03-analysis-controls.js)
 * ============================================================================ */
// File Upload Drag & Drop & Input (다중 파일 지원)
function initFileUpload() {
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('drag-active');
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('drag-active');
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-active');
            const files = Array.from(e.dataTransfer.files).filter(f =>
                /\.(csv|txt|xlsx|xls)$/i.test(f.name)
            );
            if (files.length > 0) handleMultipleFiles(files);
        });
        dropZone.addEventListener('click', () => {
            if (fileInput) fileInput.click();
        });
    }
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) handleMultipleFiles(files);
            // 같은 파일 재선택 가능하도록 초기화
            fileInput.value = '';
        });
    }
}

/**
 * 여러 파일을 일괄 처리하는 진입점.
 * 모든 파일을 파싱한 후 이름 입력 모달을 한번에 띄웁니다.
 */
function handleMultipleFiles(files) {
    _fileQueue = [...files];
    _parsedQueue = [];
    activeFilename.textContent = `파일 ${files.length}개 처리 중...`;
    if (welcomeView) welcomeView.style.display = 'none';
    parseNextFileInQueue();
}

/**
 * 큐에서 다음 파일을 꺼내 파싱합니다. 모두 완료되면 이름 모달을 엽니다.
 */
function parseNextFileInQueue() {
    if (_fileQueue.length === 0) {
        // 모든 파일 파싱 완료 → 큐 파일명 초기화 후 이름 설정 모달 표시
        _currentQueueFile = '';
        if (_parsedQueue.length > 0) {
            showMultiFileNameModal();
        }
        return;
    }
    const file = _fileQueue.shift();
    const ext = file.name.split('.').pop().toLowerCase();
    // 파싱 완료 콜백을 받기 위해 전역 플래그 설정
    _currentQueueFile = file.name;
    if (ext === 'xlsx' || ext === 'xls') {
        parseExcelFileQueued(file);
    } else {
        readTextFileQueued(file);
    }
}

// 큐 파싱용 현재 파일명 임시 보관
let _currentQueueFile = '';

/**
 * 큐 파싱 완료 시 호출되는 콜백. processedCycles 스냅샷을 _parsedQueue에 저장합니다.
 */
function onQueueFileParsed(filename) {
    // processData() 호출 후 processedCycles가 채워진 상태에서 호출됨
    const savedCycles = JSON.parse(JSON.stringify(processedCycles));
    for (const cycleNum in savedCycles) {
        const cyc = savedCycles[cycleNum];
        if (cyc) { delete cyc.all; delete cyc.rawSodiation; delete cyc.rawDesodiation; }
    }
    _parsedQueue.push({ filename, processedCycles: savedCycles });
    // 다음 파일 처리
    parseNextFileInQueue();
}

// Reads raw file data (Supports XLSX / CSV / TXT)

// 엑셀 시트 내 데이터 필수 컬럼 존재 여부 체크
function checkHasHeaders(jsonData) {
    for (let i = 0; i < Math.min(20, jsonData.length); i++) {
        const row = jsonData[i];
        if (!row || !Array.isArray(row)) continue;
        
        let hasTime = false;
        let hasStep = false;
        let hasVoltage = false;
        let hasCapacity = false;
        
        row.forEach(cell => {
            if (cell !== undefined && cell !== null) {
                const lowerCell = String(cell).toLowerCase().trim();
                if (lowerCell.includes('time') && (lowerCell.includes('(s)') || lowerCell.includes('test'))) hasTime = true;
                if (lowerCell.includes('step') && lowerCell.includes('no')) hasStep = true;
                if (lowerCell.includes('voltage') || lowerCell.includes('potential') || lowerCell.includes('전압') || lowerCell === 'v') hasVoltage = true;
                if (lowerCell.includes('capacity') || lowerCell.includes('용량') || lowerCell.includes('cap') || lowerCell.includes('|q|')) hasCapacity = true;
            }
        });
        
        // GITT를 위한 조건 (시간, 스텝, 전압 필수)
        if (hasTime && hasStep && hasVoltage) {
            return true;
        }
        // 일반 충방전을 위한 조건 (전압, 용량 필수)
        if (hasVoltage && hasCapacity) {
            return true;
        }
    }
    return false;
}



// ---- 큐 파싱용 Excel 파서 (onQueueFileParsed 콜백 연결) ----
function parseExcelFileQueued(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = e.target.result;
            const workbook = XLSX.read(data, { type: 'array' });
            const preferredSheets = workbook.SheetNames.filter(name => {
                const lower = name.toLowerCase();
                return lower.includes('data') || lower.includes('raw') || lower.includes('sheet1');
            });
            const searchOrder = [...preferredSheets, ...workbook.SheetNames.filter(n => !preferredSheets.includes(n))];
            let targetJsonData = null;
            for (const sheetName of searchOrder) {
                const ws = workbook.Sheets[sheetName];
                if (!ws) continue;
                const json = XLSX.utils.sheet_to_json(ws, { header: 1 });
                if (json && json.length >= 2 && checkHasHeaders(json)) {
                    targetJsonData = json; break;
                }
            }
            if (!targetJsonData) {
                targetJsonData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
            }
            // 파싱 (processedCycles 채워짐)
            const parsedOk = parseExcelData(targetJsonData, file.name);
            if (parsedOk === false) {
                // GITT 파일 차단 등으로 실패한 경우 콜백 호출하지 않고 다음 큐 처리
                parseNextFileInQueue();
                return;
            }
            // 파싱 완료 후 큐 콜백 호출
            onQueueFileParsed(file.name);
        } catch (err) {
            console.error('큐 Excel 파싱 오류:', err);
            // 오류가 나도 다음 파일로 계속 진행
            parseNextFileInQueue();
        }
    };
    reader.readAsArrayBuffer(file);
}

// ---- 큐 파싱용 텍스트 파서 ----
function readTextFileQueued(file, encoding = 'UTF-8') {
    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target.result;
        const result = parseRawText(text, file.name, encoding);
        // GITT 차단은 인코딩 실패와 구별하여 재시도하지 않음
        if (result === PARSE_BLOCKED_GITT) return;
        if (!result && encoding === 'UTF-8') {
            readTextFileQueued(file, 'EUC-KR');
            return;
        }
        if (result) {
            onQueueFileParsed(file.name);
        } else {
            console.warn('큐 텍스트 파싱 실패:', file.name);
            parseNextFileInQueue();
        }
    };
    reader.readAsText(file, encoding);
}

