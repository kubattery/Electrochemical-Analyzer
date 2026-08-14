/* ============================================================================
 * HC-Analyzer  ·  02-file-upload.js
 * 역할: 파일 업로드(드래그&드롭/선택) · 다중 파일 큐 파싱 헬퍼
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
            fileInput.value = '';
        });
    }
}

/**
 * 여러 파일을 일괄 처리하는 진입점.
 */
function handleMultipleFiles(files) {
    // 단일 파일 업로드 시 Rate/Cycle 자동 판별 후 알맞은 분석으로 라우팅
    if (files && files.length === 1 && window.Cyc && typeof window.Cyc.detectFile === 'function') {
        window.Cyc.detectFile(files[0], (kind) => {
            if (kind === 'cycle') {
                // 사이클 요약 데이터 → Cyclability 표시 + Rate 잠금
                window.Cyc.loadCycleFile(files[0]);
            } else {
                // 원시(전압-용량) 데이터 → 기존 Rate 파이프라인 + Cycle 잠금
                _rateUploadQueue(files);
                window.Cyc.setKind('rate');
            }
        });
        return;
    }
    _rateUploadQueue(files);
    if (window.Cyc && typeof window.Cyc.setKind === 'function') window.Cyc.setKind('rate');
}

// 기존 다중 파일 Rate 파이프라인 (진입점만 분리)
function _rateUploadQueue(files) {
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
        _currentQueueFile = '';
        if (_parsedQueue.length > 0) {
            showMultiFileNameModal();
        }
        return;
    }
    const file = _fileQueue.shift();
    const ext = file.name.split('.').pop().toLowerCase();
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
    const savedCycles = JSON.parse(JSON.stringify(processedCycles));
    for (const cycleNum in savedCycles) {
        const cyc = savedCycles[cycleNum];
        if (cyc) { delete cyc.all; delete cyc.rawSodiation; delete cyc.rawDesodiation; }
    }
    _parsedQueue.push({ filename, processedCycles: savedCycles });
    parseNextFileInQueue();
}

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
        if (hasTime && hasStep && hasVoltage) {
            return true;
        }
        if (hasVoltage && hasCapacity) {
            return true;
        }
    }
    return false;
}

// ============================================================================
// 큐 파싱용 Excel 파서 (Web Worker 우선 · 실패 시 메인 스레드 폴백)
// ============================================================================
let _xlsxWorker = null;
let _xlsxWorkerBroken = false;
let _xlsxJobId = 0;
let _xlsxActiveJob = null;

function _onXlsxWorkerFailure(reason) {
    console.warn('xlsx-worker 실패 → 이후 메인 스레드 파싱으로 폴백:', reason);
    _xlsxWorkerBroken = true;
    const job = _xlsxActiveJob;
    _xlsxActiveJob = null;
    try { if (_xlsxWorker) _xlsxWorker.terminate(); } catch (e) {}
    _xlsxWorker = null;
    if (job && !job.done) {
        job.done = true;
        parseExcelFileQueuedMainThread(job.file);
    }
}

function getXlsxWorker() {
    if (_xlsxWorkerBroken) return null;
    if (_xlsxWorker) return _xlsxWorker;
    try {
        _xlsxWorker = new Worker('js/xlsx-worker.js?v=4.0.0');
        _xlsxWorker.onmessage = (ev) => {
            const res = ev.data;
            const job = _xlsxActiveJob;
            if (!job || !res || res.id !== job.id || job.done) return;
            job.done = true;
            _xlsxActiveJob = null;
            try {
                if (!res.ok || !res.jsonData) {
                    console.error('xlsx-worker 파싱 실패:', res.error);
                    parseNextFileInQueue();
                    return;
                }
                const parsedOk = parseExcelData(res.jsonData, job.file.name);
                if (parsedOk === false) { parseNextFileInQueue(); return; }
                onQueueFileParsed(job.file.name);
            } catch (err) {
                console.error('큐 Excel 후처리 오류:', err);
                parseNextFileInQueue();
            }
        };
        _xlsxWorker.onerror = (err) => {
            _onXlsxWorkerFailure((err && err.message) || 'worker onerror');
        };
    } catch (err) {
        _xlsxWorkerBroken = true;
        _xlsxWorker = null;
        console.warn('Web Worker 생성 실패 → 메인 스레드 파싱:', err);
    }
    return _xlsxWorker;
}

function parseExcelFileQueued(file) {
    const worker = getXlsxWorker();
    if (!worker) { parseExcelFileQueuedMainThread(file); return; }

    const reader = new FileReader();
    reader.onload = (e) => {
        const buf = e.target.result;
        const id = ++_xlsxJobId;
        _xlsxActiveJob = { id, file, done: false };
        try {
            worker.postMessage({ id, data: buf, filename: file.name }, [buf]);
        } catch (postErr) {
            try {
                worker.postMessage({ id, data: buf, filename: file.name });
            } catch (err2) {
                _onXlsxWorkerFailure('postMessage 실패');
            }
        }
    };
    reader.onerror = () => { parseNextFileInQueue(); };
    reader.readAsArrayBuffer(file);
}

// ---- (폴백) 메인 스레드 Excel 파서 : 워커를 못 쓰는 환경 대비 ----
function parseExcelFileQueuedMainThread(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = e.target.result;
            const workbook = XLSX.read(data, {
                type: 'array', dense: true,
                cellStyles: false, cellNF: false, cellDates: false,
                cellFormula: false, cellHTML: false, cellText: false, bookVBA: false
            });
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
            const parsedOk = parseExcelData(targetJsonData, file.name);
            if (parsedOk === false) { parseNextFileInQueue(); return; }
            onQueueFileParsed(file.name);
        } catch (err) {
            console.error('큐 Excel 파싱 오류(메인 스레드):', err);
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
