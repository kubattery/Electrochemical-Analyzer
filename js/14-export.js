/* ============================================================================
 * HC-Analyzer  ·  14-export.js
 * 역할: 이미지(PNG)·Excel/CSV 내보내기
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 14/15  (이전: js/13-charts.js → 다음: js/15-profile-cycles.js)
 * ============================================================================ */
/* ==========================================
   6. Exporting Utilities
   ========================================== */
function initExportFeatures() {
    // 1차 사이클 프로파일 다운로드
    btnDownloadProfile.addEventListener('click', () => {
        if (!hasActiveDataset()) return;
        downloadChartImage(chartProfileInstance, 'voltage_profile_cycle_' + targetCycleSelect.value);
    });

    // 1차 사이클 프로파일 엑셀 내보내기
    if (btnDownloadProfileExcel) {
        btnDownloadProfileExcel.addEventListener('click', () => {
            exportVoltageProfileDataToExcel();
        });
    }

    // Slope/Plateau 하이라이트 차트 다운로드
    btnDownloadSlopeChart.addEventListener('click', () => {
        if (!hasActiveDataset()) return;
        downloadChartImage(chartSlopePlateauInstance, 'slope_plateau_analysis');
    });

    // 정제된 C-rate 율속 요약 데이터를 엑셀로 내보내기
    btnDownloadRateData.addEventListener('click', () => {
        if (rateCapabilitySummary.length === 0) return;
        
        // 데이터 배열 생성
        const data = [
            ["C-rate", "Cycle Range", "Avg Charge Capacity (mAh/g)", "Retention (%)", "Avg Coulombic Efficiency (%)"]
        ];
        
        rateCapabilitySummary.forEach(row => {
            data.push([
                row.rate,
                row.cycleRange,
                parseFloat(row.avgCharge.toFixed(2)),
                parseFloat(row.retention.toFixed(2)),
                parseFloat(row.avgCE.toFixed(2))
            ]);
        });

        // 엑셀 워크시트 및 워크북 생성
        const worksheet = XLSX.utils.aoa_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Rate Capability Summary");

        // 엑셀 바이너리 파일 데이터 생성
        const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        
        // 응답 콘텐츠 타입에 상응하는 엑셀 바이너리 Blob 객체 생성
        const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        
        // 오늘 날짜 포맷 (YYYYMMDD) 생성
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        const formattedDate = `${yyyy}${mm}${dd}`;

        // a 태그를 생성하여 download 속성을 명시한 후 강제 클릭 유도 (한글명 인코딩 유지)
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `율속요약_분석결과_${formattedDate}.xlsx`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    });

    // 상세 사이클별 피팅 용량 데이터를 엑셀로 내보내기
    if (btnDownloadRateDetailData) {
        btnDownloadRateDetailData.addEventListener('click', () => {
            const cycleNumbers = Object.keys(processedCycles).map(Number).sort((a, b) => a - b);
            if (cycleNumbers.length === 0) {
                alert("내보낼 데이터가 없습니다.");
                return;
            }
            
            // 데이터 배열 생성
            const data = [
                ["Cycle", "Charge Capacity (mAh/g)", "Discharge Capacity (mAh/g)"]
            ];
            
            cycleNumbers.forEach(cNum => {
                const cyc = processedCycles[cNum];
                const chargeCap = cyc ? parseFloat(cyc.totalChargeCap.toFixed(2)) : 0;
                const dischargeCap = cyc ? parseFloat(cyc.totalDischargeCap.toFixed(2)) : 0;
                data.push([cNum, chargeCap, dischargeCap]);
            });

            // 엑셀 워크시트 및 워크북 생성
            const worksheet = XLSX.utils.aoa_to_sheet(data);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Rate Capability Detail");

            // 엑셀 바이너리 파일 데이터 생성
            const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
            
            // 응답 콘텐츠 타입에 상응하는 엑셀 바이너리 Blob 객체 생성
            const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            
            // 오늘 날짜 포맷 (YYYYMMDD) 생성
            const today = new Date();
            const yyyy = today.getFullYear();
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            const dd = String(today.getDate()).padStart(2, '0');
            const formattedDate = `${yyyy}${mm}${dd}`;

            // a 태그를 생성하여 download 속성을 명시한 후 강제 클릭 유도 (한글명 인코딩 유지)
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `상세용량_분석결과_${formattedDate}.xlsx`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        });
    }
}

function downloadChartImage(chartInstance, filename) {
    if (!chartInstance) return;
    const link = document.createElement('a');
    link.download = `${filename}.png`;
    link.href = chartInstance.toBase64Image();
    link.click();
}

/**
 * 방향 조건에 따른 엑셀 열 헤더 배열을 반환합니다.
 */
function getProfileExportHeaders(direction) {
    if (direction === 'all') {
        return [
            "Dataset", 
            "Cycle", 
            "Point Index", 
            "Discharge Capacity (mAh/g)", 
            "Discharge Voltage (V vs. Na/Na+)", 
            "Charge Capacity (mAh/g)", 
            "Charge Voltage (V vs. Na/Na+)"
        ];
    } else if (direction === 'discharge') {
        return [
            "Dataset", 
            "Cycle", 
            "Point Index", 
            "Discharge Capacity (mAh/g)", 
            "Discharge Voltage (V vs. Na/Na+)"
        ];
    } else {
        return [
            "Dataset", 
            "Cycle", 
            "Point Index", 
            "Charge Capacity (mAh/g)", 
            "Charge Voltage (V vs. Na/Na+)"
        ];
    }
}

/**
 * 모든 대상 데이터셋들의 사이클 리스트의 Union(합집합)을 정렬된 배열로 반환합니다.
 */
function getProfileExportTargetCyclesUnion(displayDS, targetCycleVal) {
    if (targetCycleVal === 'all') {
        const union = new Set();
        displayDS.forEach(ds => {
            if (ds.processedCycles) {
                Object.keys(ds.processedCycles).forEach(k => union.add(Number(k)));
            }
        });
        return Array.from(union).sort((a, b) => a - b);
    } else {
        return [parseInt(targetCycleVal)];
    }
}

/**
 * 특정 데이터셋의 한 사이클에 해당하는 충방전 와이드 포맷 행 데이터(2차원 배열, 헤더 제외)를 조립합니다.
 */
function buildProfileExportRowsForCycle(ds, cNum, direction, targetCycleVal) {
    if (!ds.processedCycles) return [];

    let actualCycleNum = cNum;

    if (targetCycleVal === 'all') {
        // 전체 사이클 다운로드 시에는 해당 데이터셋에 해당 사이클이 없으면 fallback 없이 skip
        if (!ds.processedCycles[cNum]) return [];
    } else {
        // 특정 단일 사이클 선택 시에 데이터셋에 없으면 가장 가까운 사이클 번호로 fallback
        const dsCycles = Object.keys(ds.processedCycles).map(Number).sort((a, b) => a - b);
        if (dsCycles.length === 0) return [];
        if (!dsCycles.includes(cNum)) {
            actualCycleNum = dsCycles.reduce((prev, curr) => Math.abs(curr - cNum) < Math.abs(prev - cNum) ? curr : prev);
        }
    }

    const cycleData = ds.processedCycles[actualCycleNum];
    if (!cycleData) return [];

    const sodiation = cycleData.sodiation || [];
    const desodiation = cycleData.desodiation || [];
    const dsName = ds.customName || ds.filename || "Unknown Dataset";
    const rows = [];

    if (direction === 'all') {
        const maxLen = Math.max(sodiation.length, desodiation.length);
        for (let i = 0; i < maxLen; i++) {
            const sodPt = sodiation[i];
            const desodPt = desodiation[i];
            rows.push([
                dsName,
                actualCycleNum,
                i + 1,
                sodPt ? sodPt.capacity : "",
                sodPt ? sodPt.voltage : "",
                desodPt ? desodPt.capacity : "",
                desodPt ? desodPt.voltage : ""
            ]);
        }
    } else if (direction === 'discharge') {
        sodiation.forEach((pt, idx) => {
            rows.push([
                dsName,
                actualCycleNum,
                idx + 1,
                pt.capacity,
                pt.voltage
            ]);
        });
    } else if (direction === 'charge') {
        desodiation.forEach((pt, idx) => {
            rows.push([
                dsName,
                actualCycleNum,
                idx + 1,
                pt.capacity,
                pt.voltage
            ]);
        });
    }
    return rows;
}

/**
 * 전압 프로파일의 현재 표시 조건 그대로 XLSX 데이터로 빌드하고 내보냅니다.
 * (전체 사이클 선택 시 각 사이클별로 분할된 탭 시트를 동적으로 빌드합니다)
 */
async function exportVoltageProfileDataToExcel() {
    if (!hasActiveDataset()) return;

    const checkedDS = getCheckedDatasets();
    const isCompareMode = checkedDS.length >= 2;
    
    const displayDS = isCompareMode ? checkedDS : datasetLibrary.filter(d => d.id === activeDatasetId);
    if (displayDS.length === 0) {
        alert("내보낼 데이터가 없습니다.");
        return;
    }

    const direction = targetDirectionProfile ? targetDirectionProfile.value : 'all';

    // 버튼 UI 상태 로딩으로 변경 및 비활성화
    const originalContent = btnDownloadProfileExcel.innerHTML;
    btnDownloadProfileExcel.disabled = true;
    btnDownloadProfileExcel.innerHTML = '<span class="material-icons-round">hourglass_empty</span> 생성 중...';

    try {
        const headers = getProfileExportHeaders(direction);
        
        let targetCycles = [];
        if (isProfileCycleAll) {
            targetCycles = getProfileExportTargetCyclesUnion(displayDS, 'all');
        } else {
            targetCycles = [...selectedProfileCycles];
        }

        const workbook = XLSX.utils.book_new();
        let hasAnyData = false;

        // 사이클 루프 돌며 각각 독립된 시트 추가
        for (const cNum of targetCycles) {
            const sheetData = [headers];
            let sheetRowsCount = 0;

            displayDS.forEach(ds => {
                // isProfileCycleAll 이 true이면 'all'을 넘겨서 fallback 미적용, 아니면 'multi'를 넘겨서 fallback 미적용 (다중 선택 상태이므로)
                // selectedProfileCycles의 길이가 1일 때만 fallback을 허용하도록 buildProfileExportRowsForCycle 내부 조건 변경 예정
                const fallbackMode = (selectedProfileCycles.length === 1 && !isProfileCycleAll) ? 'single' : 'multi';
                const rows = buildProfileExportRowsForCycle(ds, cNum, direction, fallbackMode === 'single' ? cNum.toString() : 'all');
                if (rows.length > 0) {
                    rows.forEach(r => sheetData.push(r));
                    sheetRowsCount += rows.length;
                }
            });

            if (sheetRowsCount > 0) {
                hasAnyData = true;
                const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
                
                // 시트 이름 결정 (Excel 31자 제한 및 특수 문자 필터링)
                let sheetName = `Cycle_${cNum}`;
                sheetName = sheetName.replace(/[\/\\?*\[\]:]/g, '_').substring(0, 31);
                
                XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
            }

            // 대용량 양보 비동기 yield
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (!hasAnyData) {
            alert("내보낼 데이터가 없습니다.");
            return;
        }

        // 용량 절감 및 원활한 전송을 위해 compression: true 적용
        const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true });
        const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

        // 시간 포맷 (YYYYMMDD_HHMMSS)
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const formattedTime = `${yyyy}${mm}${dd}_${hh}${min}${ss}`;

        const cycleStr = isProfileCycleAll ? 'all' : `cycles_${selectedProfileCycles.join('_')}`;
        const filename = `전압프로파일_${cycleStr}_${direction}_${formattedTime}.xlsx`;

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

    } catch (err) {
        console.error("전압 프로파일 엑셀 내보내기 에러:", err);
        alert("엑셀 파일 내보내기 중 오류가 발생했습니다.");
    } finally {
        // 버튼 원래 형태대로 복구
        btnDownloadProfileExcel.disabled = false;
        btnDownloadProfileExcel.innerHTML = originalContent;
    }
}



