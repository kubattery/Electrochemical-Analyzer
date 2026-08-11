/* ============================================================================
 * HC-Analyzer  ·  js/xlsx-worker.js  (Web Worker)
 * 역할: 엑셀 파싱(XLSX.read + sheet_to_json)을 백그라운드 스레드에서 수행.
 *  - 초대용량 파일(수십만 행)을 읽어도 화면이 멈추지 않고,
 *    "Script terminated by timeout"(응답없음 강제 종료)이 발생하지 않습니다.
 * 이 파일은 index.html의 <script>로 로드하지 않습니다. 02-file-upload.js가 new Worker로 로딩합니다.
 * ============================================================================ */
importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');

function checkHasHeaders(jsonData) {
    for (let i = 0; i < Math.min(20, jsonData.length); i++) {
        const row = jsonData[i];
        if (!row || !Array.isArray(row)) continue;
        let hasTime = false, hasStep = false, hasVoltage = false, hasCapacity = false, hasCurrent = false;
        for (const cell of row) {
            if (cell !== undefined && cell !== null) {
                const c = String(cell).toLowerCase().trim();
                if (c.includes('time') && (c.includes('(s)') || c.includes('test'))) hasTime = true;
                if (c.includes('step') && c.includes('no')) hasStep = true;
                if (c.includes('voltage') || c.includes('potential') || c.includes('전압') || c === 'v') hasVoltage = true;
                if (c.includes('capacity') || c.includes('용량') || c.includes('cap') || c.includes('|q|')) hasCapacity = true;
                if (c.includes('current') || c.includes('전류') || c === 'i' || c.includes('(a)') || c.includes('(ma)')) hasCurrent = true;
            }
        }
        if (hasTime && hasStep && hasVoltage) return true;
        if (hasVoltage && hasCapacity) return true;
        if (hasVoltage && hasCurrent) return true;
    }
    return false;
}

self.onmessage = function (e) {
    const msg = e.data || {};
    const id = msg.id;
    const filename = msg.filename;
    try {
        const workbook = XLSX.read(msg.data, {
            type: 'array', dense: true,
            cellStyles: false, cellNF: false, cellDates: false,
            cellFormula: false, cellHTML: false, cellText: false, bookVBA: false
        });
        const preferred = workbook.SheetNames.filter(function (n) {
            const l = n.toLowerCase();
            return l.includes('data') || l.includes('raw') || l.includes('sheet1');
        });
        const order = preferred.concat(workbook.SheetNames.filter(function (n) {
            return preferred.indexOf(n) === -1;
        }));
        let jsonData = null;
        for (let i = 0; i < order.length; i++) {
            const ws = workbook.Sheets[order[i]];
            if (!ws) continue;
            const json = XLSX.utils.sheet_to_json(ws, { header: 1 });
            if (json && json.length >= 2 && checkHasHeaders(json)) { jsonData = json; break; }
        }
        if (!jsonData) {
            jsonData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
        }
        self.postMessage({ id: id, ok: true, filename: filename, jsonData: jsonData });
    } catch (err) {
        self.postMessage({ id: id, ok: false, filename: filename, error: String((err && err.message) || err) });
    }
};
