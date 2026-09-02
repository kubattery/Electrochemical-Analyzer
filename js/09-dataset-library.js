/* ============================================================================
 * HC-Analyzer  ·  09-dataset-library.js
 * 역할: 데이터셋 라이브러리(이름모달/활성 전환/삭제/사이드바 렌더)
 *       + 사이드바 RATE/CYCLE 선택박스 (실험 종류 수동 지정 — 19번 판별과 연동)
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 09/15  (이전: js/08-library-table.js → 다음: js/10-data-processing.js)
 * ============================================================================ */
/**
 * 데이터셋 라이브러리 이벤트 초기화
 */
function initDatasetLibrary() {
    const btnSave = document.getElementById('btnModalSave');
    const btnSkip = document.getElementById('btnModalSkip');
    const modal   = document.getElementById('datasetNameModal');

    if (btnSave) {
        btnSave.addEventListener('click', () => {
            finalizeMultiDatasetSave(false);
        });
    }
    if (btnSkip) {
        btnSkip.addEventListener('click', () => {
            finalizeMultiDatasetSave(true);
        });
    }
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) finalizeMultiDatasetSave(true);
        });
    }
}

/**
 * 다중 파일 이름 입력 모달 표시
 */
function showMultiFileNameModal() {
    const modal = document.getElementById('datasetNameModal');
    const list  = document.getElementById('multiFileNameList');
    const titleEl = document.getElementById('modalTitle');
    const descEl  = document.getElementById('modalDesc');
    if (!modal || !list) return;

    const count = _parsedQueue.length;
    if (titleEl) titleEl.textContent = count > 1 ? `데이터셋 ${count}개 저장` : '데이터셋 저장';
    if (descEl) descEl.textContent = count > 1
        ? `${count}개 파일을 라이브러리에 저장합니다. 각 파일의 이름을 설정하세요.`
        : '업로드된 파일을 라이브러리에 저장합니다. 이름을 입력하세요.';

    list.innerHTML = '';
    _parsedQueue.forEach((item, idx) => {
        const defaultName = item.filename.replace(/\.[^.]+$/, '');
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; flex-direction:column; gap:5px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px 12px;';
        
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:10px; color:var(--text-muted);';
        
        const iconSpan = document.createElement('span');
        iconSpan.className = 'material-icons-round';
        iconSpan.style.fontSize = '13px';
        iconSpan.textContent = 'description';
        
        const nameSpan = document.createElement('span');
        nameSpan.textContent = item.filename;
        
        infoDiv.appendChild(iconSpan);
        infoDiv.appendChild(nameSpan);
        
        const inputEl = document.createElement('input');
        inputEl.type = 'text';
        inputEl.id = `multiNameInput_${idx}`;
        inputEl.className = 'modal-input';
        inputEl.value = defaultName;
        inputEl.placeholder = '데이터셋 이름 (예: HC-Glu-1500°C)';
        inputEl.style.margin = '0';
        
        row.appendChild(infoDiv);
        row.appendChild(inputEl);
        list.appendChild(row);
    });

    setTimeout(() => {
        const first = document.getElementById('multiNameInput_0');
        if (first) { first.select(); first.focus(); }
    }, 100);

    modal.style.display = 'flex';
}

/**
 * 수동 업로드 최종 저장
 */
async function finalizeMultiDatasetSave(useFilenames) {
    const modal = document.getElementById('datasetNameModal');
    
    // 1. 임시 후보 데이터명 수집 및 비어있음 유효성 검사
    const nameCandidates = [];
    for (let idx = 0; idx < _parsedQueue.length; idx++) {
        const item = _parsedQueue[idx];
        const inputEl = document.getElementById(`multiNameInput_${idx}`);
        const customName = useFilenames
            ? item.filename.replace(/\.[^.]+$/, '')
            : (inputEl ? inputEl.value.trim() : '') || item.filename.replace(/\.[^.]+$/, '');
            
        const trimmedName = customName.trim();
        if (!trimmedName) {
            alert(`[오류] ${idx + 1}번째 데이터셋의 이름이 비어 있습니다.`);
            return;
        }
        
        nameCandidates.push({
            index: idx,
            name: trimmedName,
            filename: item.filename
        });
    }

    // 2. 전체 라이브러리 및 배치 내부 데이터명 중복 검사
    const uniqueNamesInBatch = new Set();
    for (const cand of nameCandidates) {
        // 기존 라이브러리 중복 검사
        if (isDuplicateDataName(cand.name)) {
            alert(`이미 같은 데이터명이 존재합니다. 다른 이름을 입력해 주세요.\n중복된 데이터명: [${cand.name}]`);
            return; // 모달 닫지 않고 즉시 리턴
        }
        // 이번 배치 내부 중복 검사
        const lowerName = cand.name.toLowerCase();
        if (uniqueNamesInBatch.has(lowerName)) {
            alert(`업로드하려는 파일들 사이에 중복된 데이터명이 존재합니다. 서로 다른 이름을 입력해 주세요.\n중복된 데이터명: [${cand.name}]`);
            return; // 모달 닫지 않고 즉시 리턴
        }
        uniqueNamesInBatch.add(lowerName);
    }

    // 3. 모든 데이터명이 유효할 때만 모달 닫기 및 데이터 저장 진행
    if (modal) modal.style.display = 'none';

    const savedAt = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    let lastDataset = null;

    for (let idx = 0; idx < _parsedQueue.length; idx++) {
        const item = _parsedQueue[idx];
        const customName = nameCandidates[idx].name; // 검증 완료된 고유명
        const id = (Date.now() + idx).toString();

        const savedCycles = item.processedCycles;
        const totalCycles = Object.keys(savedCycles).length;
        const firstCyc = savedCycles[1];
        const ice = firstCyc && firstCyc.totalDischargeCap > 0
            ? ((firstCyc.totalChargeCap / firstCyc.totalDischargeCap) * 100).toFixed(1)
            : '-';

        const dataset = {
            id,
            projectName: activeProjectId,
            experimentType: "rate", // 수동 업로드 기본 율속 분석 타입 지정
            dataName: customName,
            customName, // 호환 필드
            sampleName: "",
            filename: item.filename,
            uploadedAt: savedAt,
            lastConvertedAt: savedAt,
            conversionStatus: "converted",
            keyMetric: ice !== "-" ? `ICE: ${ice}%` : `Cycles: ${totalCycles}`,
            processedCycles: savedCycles,
            totalCycles,
            ice,
            compareEnabled: true,
            selectedCycle: 1,
            mass: dqdvMass ? parseFloat(dqdvMass.value) || 2.58 : 2.58
        };

        normalizeDataset(dataset);
        datasetLibrary.push(dataset);
        lastDataset = dataset;

        try { await saveDatasetToDB(dataset); }
        catch (e) { console.warn('DB 저장 실패:', e); }
    }

    _parsedQueue = [];

    if (!lastDataset) return;

    activeDatasetId = lastDataset.id;
    processedCycles = JSON.parse(JSON.stringify(lastDataset.processedCycles));
    rawBatteryData = [1];
    activeFilename.textContent = lastDataset.dataName;
    document.querySelector('.header-info .badge').textContent = 'LOADED';
    document.querySelector('.header-info .badge').className = 'badge badge-info';

    renderDatasetLibraryUI();
    renderLibraryTable();

    const cycleNumbers = Object.keys(processedCycles).map(Number).sort((a, b) => a - b);
    targetCycleSelect.innerHTML = '';
    if (targetCycleSelectSP) targetCycleSelectSP.innerHTML = '';
    if (targetCycleDqDv) targetCycleDqDv.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'all'; optAll.textContent = '전체 사이클 (All)';
    targetCycleSelect.appendChild(optAll);
    cycleNumbers.forEach(cNum => {
        const o1 = document.createElement('option'); o1.value = cNum; o1.textContent = `${cNum} Cycle`;
        targetCycleSelect.appendChild(o1);
        if (targetCycleSelectSP) { const o2 = o1.cloneNode(true); targetCycleSelectSP.appendChild(o2); }
        if (targetCycleDqDv) { const o3 = o1.cloneNode(true); targetCycleDqDv.appendChild(o3); }
    });
    targetCycleSelect.value = 'all';
    if (targetCycleSelectSP) targetCycleSelectSP.value = cycleNumbers[0] || 1;
    if (targetCycleDqDv) targetCycleDqDv.value = cycleNumbers[0] || 1;
    if (cycleNumbers.length > 0) selectedDqDvCycles = [cycleNumbers[0]];
    isProfileCycleAll = true;
    selectedProfileCycles = [];
    renderCycleChipsUI();
    renderProfileCycleChipsUI();

    runAnalysis();
}

/**
 * 단일 파일 파싱 완료 후 모달 표시 (기존 호환성 유지용)
 */
function showDatasetNameModal(filename) {
    const savedCycles = JSON.parse(JSON.stringify(processedCycles));
    for (const cycleNum in savedCycles) {
        const cyc = savedCycles[cycleNum];
        if (cyc) { delete cyc.all; delete cyc.rawSodiation; delete cyc.rawDesodiation; }
    }
    _parsedQueue = [{ filename, processedCycles: savedCycles }];
    showMultiFileNameModal();
}

/**
 * 특정 데이터셋을 현재 단일 분석 대상으로 전환
 */
function switchActiveDataset(id) {
    const ds = datasetLibrary.find(d => d.id === id);
    if (!ds) return;

    // GITT 데이터셋은 독립 분석(21-gitt.js 전용)이라 일반 분석으로 전환하지 않는다.
    // 클릭 시 저장된 분석 결과(gittPayload)가 있으면 복원한 뒤 GITT 탭을 열고,
    // 활성 데이터셋(일반 분석 상태)은 그대로 유지.
    if (ds.experimentType === 'gitt') {
        if (window.GittAnalyzer && typeof GittAnalyzer.showDataset === 'function') {
            GittAnalyzer.showDataset(ds.id);
        } else if (window.GittAnalyzer && typeof GittAnalyzer.activateTab === 'function') {
            GittAnalyzer.activateTab();
        }
        return;
    }
    // CV 데이터셋도 독립 분석(17-cv.js 전용) — 클릭 시 CV 탭을 열고 해당 데이터를 표시.
    if (ds.experimentType === 'cv') {
        if (window.CVAnalyzer && typeof CVAnalyzer.showDataset === 'function') {
            CVAnalyzer.showDataset(ds.id);
        }
        return;
    }
    
    activeDatasetId = id;
    isGittMode = false;

    processedCycles = JSON.parse(JSON.stringify(ds.processedCycles));
    rawBatteryData = [1];

    activeFilename.textContent = ds.dataName;
    document.querySelector('.header-info .badge').textContent = "LOADED";
    document.querySelector('.header-info .badge').className = "badge badge-info";

    const cycleNumbers = Object.keys(processedCycles).map(Number).sort((a, b) => a - b);
    targetCycleSelect.innerHTML = '';
    if (targetCycleSelectSP) targetCycleSelectSP.innerHTML = '';
    if (targetCycleDqDv) targetCycleDqDv.innerHTML = '';

    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = '전체 사이클 (All)';
    targetCycleSelect.appendChild(optAll);

    cycleNumbers.forEach(cNum => {
        const o1 = document.createElement('option');
        o1.value = cNum; o1.textContent = `${cNum} Cycle`;
        targetCycleSelect.appendChild(o1);

        if (targetCycleSelectSP) {
            const o2 = document.createElement('option');
            o2.value = cNum; o2.textContent = `${cNum} Cycle`;
            targetCycleSelectSP.appendChild(o2);
        }

        if (targetCycleDqDv) {
            const o3 = document.createElement('option');
            o3.value = cNum; o3.textContent = `${cNum} Cycle`;
            targetCycleDqDv.appendChild(o3);
        }
    });

    targetCycleSelect.value = 'all';
    if (targetCycleSelectSP) targetCycleSelectSP.value = cycleNumbers[0] || 1;
    if (targetCycleDqDv) targetCycleDqDv.value = cycleNumbers[0] || 1;

    if (dqdvMass && ds.mass !== undefined) {
        dqdvMass.value = ds.mass;
    }

    if (cycleNumbers.length > 0) {
        selectedDqDvCycles = [cycleNumbers[0]];
    }
    isProfileCycleAll = true;
    selectedProfileCycles = [];
    renderCycleChipsUI();
    renderProfileCycleChipsUI();

    const targetMode = 'general';
    if (currentAnalysisMode !== targetMode) {
        setAnalysisMode(targetMode);
    } else {
        const activeTabBtn = document.querySelector('.tab-btn.active');
        const allowedTabs = ['tab-overview', 'tab-slope-plateau', 'tab-rate', 'tab-dqdv'];
        if (!activeTabBtn || !allowedTabs.includes(activeTabBtn.getAttribute('data-tab'))) {
            const fallbackBtn = document.querySelector('.tab-btn[data-tab="tab-overview"]');
            if (fallbackBtn) {
                tabButtons.forEach(b => b.classList.remove('active'));
                tabPanels.forEach(p => p.classList.remove('active'));
                fallbackBtn.classList.add('active');
                const fallbackPanel = document.getElementById('tab-overview');
                if (fallbackPanel) fallbackPanel.classList.add('active');
            }
        }
        runAnalysis();
    }
    
    // 테이블과 카드 UI 포커스 업데이트를 위해 갱신
    renderDatasetLibraryUI();
    renderLibraryTable();
}

/**
 * 데이터셋 라이브러리 삭제
 */
async function removeDataset(id) {
    const removedDs = datasetLibrary.find(d => d.id === id);
    datasetLibrary = datasetLibrary.filter(d => d.id !== id);

    // CV 데이터셋이면 CV 그래프(오버레이)에서도 제거하여 동기화
    if (removedDs && removedDs.experimentType === 'cv' && window.CVAnalyzer && typeof CVAnalyzer.removeDataset === 'function') {
        CVAnalyzer.removeDataset(id);
    }

    // GITT 데이터셋이면 GITT 탭 그래프에서도 제거하여 동기화
    if (removedDs && removedDs.experimentType === 'gitt' && window.GittAnalyzer && typeof GittAnalyzer.removeDataset === 'function') {
        GittAnalyzer.removeDataset(id);
    }

    if (activeDatasetId === id) {
        // GITT·CV 데이터셋은 활성 전환 대상이 아니므로 일반 분석 데이터셋 중에서 대체를 찾는다
        const fallbackDs = [...datasetLibrary].reverse().find(d => d.experimentType !== 'gitt' && d.experimentType !== 'cv');
        if (fallbackDs) {
            switchActiveDataset(fallbackDs.id);
        } else {
            activeDatasetId = null;
            processedCycles = {};
            rawBatteryData = [];
            isGittMode = false;

            const gittConfigPanel = document.getElementById('gittConfigPanel');
            if (gittConfigPanel) gittConfigPanel.style.display = 'none';
        }
    }

    renderDatasetLibraryUI();
    renderLibraryTable();
    
    await deleteDatasetFromDB(id);
    
    if (hasActiveDataset()) runAnalysis();
}

/**
 * 비교 오버레이용 체크된 목록 반환
 */
function getCheckedDatasets() {
    return datasetLibrary.filter(d => d.compareEnabled);
}

/**
 * 사이드바 데이터 라이브러리 UI 렌더링 (아코디언 그룹화 적용)
 */
function renderDatasetLibraryUI() {
    const listEl = document.getElementById('datasetList');
    const countEl = document.getElementById('libraryCountBadge');
    
    const summaryTotal = document.getElementById('summaryTotal');
    const summaryCompleted = document.getElementById('summaryCompleted');
    const summaryFailed = document.getElementById('summaryFailed');
    const summaryNeedUpdate = document.getElementById('summaryNeedUpdate');
    
    if (!listEl) return;
    
    // 요약 정보 갱신 (전체 데이터셋 기준)
    if (summaryTotal) summaryTotal.textContent = datasetLibrary.length;
    
    const completedCount = datasetLibrary.filter(ds => ds.conversionStatus === 'converted' || ds.conversionStatus === 'updated').length;
    const failedCount = datasetLibrary.filter(ds => ds.conversionStatus === 'failed').length;
    const pendingCount = datasetLibrary.filter(ds => ds.conversionStatus === 'pending' || ds.conversionStatus === 'converting').length;
    
    if (summaryCompleted) summaryCompleted.textContent = completedCount;
    if (summaryFailed) summaryFailed.textContent = failedCount;
    if (summaryNeedUpdate) summaryNeedUpdate.textContent = pendingCount;
    
    if (countEl) countEl.textContent = datasetLibrary.length;
    
    listEl.innerHTML = '';
    
    let displayList = [...datasetLibrary];
    
    // 1. 사이드바 필터 칩 적용
    if (currentLibraryFilter !== 'all') {
        if (currentLibraryFilter === 'failed') {
            displayList = displayList.filter(ds => ds.conversionStatus === 'failed');
        } else {
            displayList = displayList.filter(ds => ds.experimentType === currentLibraryFilter);
        }
    }
    
    if (displayList.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'library-empty-msg';
        emptyMsg.textContent = '조건에 맞는 데이터셋이 없습니다.';
        emptyMsg.style.padding = '15px';
        emptyMsg.style.textAlign = 'center';
        emptyMsg.style.color = 'rgba(255,255,255,0.4)';
        emptyMsg.style.fontSize = '11px';
        listEl.appendChild(emptyMsg);
        return;
    }
    
    // 2. sampleName 기준으로 groupBy
    const groupsMap = {};
    displayList.forEach(ds => {
        const sName = ds.sampleName || "(샘플 미지정)";
        if (!groupsMap[sName]) {
            groupsMap[sName] = {
                sampleName: sName,
                groupColor: ds.groupColor || getSampleGroupColor(sName),
                datasets: []
            };
        }
        groupsMap[sName].datasets.push(ds);
    });
    
    const groups = Object.values(groupsMap);
    
    // 각 그룹 내부 데이터셋 최신순 정렬 (ID 기준 내림차순)
    groups.forEach(g => {
        g.datasets.sort((a, b) => b.id.localeCompare(a.id));
    });
    
    // 그룹 정렬: 각 그룹 내에서 가장 최근 데이터셋(datasets[0].id)을 가진 그룹이 위로 오도록 정렬
    groups.sort((a, b) => b.datasets[0].id.localeCompare(a.datasets[0].id));
    
    // 3. localStorage에 저장된 펼침 그룹 목록 로드
    // 만약 로컬스토리지에 데이터가 없으면, 모든 그룹을 펼침 목록으로 기본 지정
    let expandedGroups = localStorage.getItem('hc_expanded_sample_groups');
    if (expandedGroups === null) {
        expandedGroups = groups.map(g => g.sampleName);
        localStorage.setItem('hc_expanded_sample_groups', JSON.stringify(expandedGroups));
    } else {
        expandedGroups = JSON.parse(expandedGroups);
    }
    
    // 4. DOM 렌더링
    groups.forEach(group => {
        const sName = group.sampleName;
        const isExpanded = expandedGroups.includes(sName);
        
        const groupContainer = document.createElement('div');
        groupContainer.className = 'sample-group-container';
        
        // 그룹 헤더 빌드
        const header = document.createElement('div');
        header.className = `sample-group-header${isExpanded ? '' : ' collapsed'}`;
        
        const dot = document.createElement('span');
        dot.className = 'group-color-dot';
        dot.style.backgroundColor = group.groupColor;
        
        const nameText = document.createElement('span');
        nameText.className = 'sample-name-text';
        nameText.textContent = sName;
        nameText.title = sName;
        
        // 샘플 그룹명 수정 인라인 아이콘
        const groupEditIcon = document.createElement('span');
        groupEditIcon.className = 'ds-inline-edit-icon material-icons-round';
        groupEditIcon.textContent = 'edit';
        groupEditIcon.title = '샘플 그룹 이름 수정';
        groupEditIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            renameSampleGroup(sName);
        });
        
        // 선택된 개수 및 전체 개수 정보
        const totalCount = group.datasets.length;
        const checkedCount = group.datasets.filter(ds => ds.compareEnabled).length;
        const countBadge = document.createElement('span');
        countBadge.className = 'sample-count-badge';
        countBadge.textContent = `${checkedCount}/${totalCount}`;
        
        const expandIcon = document.createElement('span');
        expandIcon.className = 'expand-icon material-icons-round';
        expandIcon.textContent = isExpanded ? 'expand_less' : 'expand_more';
        
        header.appendChild(dot);
        header.appendChild(nameText);
        header.appendChild(groupEditIcon);
        header.appendChild(countBadge);
        header.appendChild(expandIcon);
        
        // 헤더 클릭 이벤트 (아코디언 토글)
        header.addEventListener('click', (e) => {
            if (e.target.closest('.ds-inline-edit-icon')) return; // 수정 아이콘 클릭 시 아코디언 토글 방지
            let list = JSON.parse(localStorage.getItem('hc_expanded_sample_groups')) || [];
            if (list.includes(sName)) {
                list = list.filter(name => name !== sName);
            } else {
                list.push(sName);
            }
            localStorage.setItem('hc_expanded_sample_groups', JSON.stringify(list));
            renderDatasetLibraryUI();
        });
        
        // 그룹 하위 콘텐츠 컨테이너
        const content = document.createElement('div');
        content.className = `sample-group-content${isExpanded ? '' : ' collapsed'}`;
        
        // 하위 아이템 빌드
        group.datasets.forEach(ds => {
            const item = document.createElement('div');
            const isActive = (ds.id === activeDatasetId);
            item.className = `dataset-item${isActive ? ' is-active' : ''}`;
            item.style.borderLeft = `3px solid ${ds.lineColor}`;
            item.style.padding = "6px 8px";
            item.style.marginBottom = "0";
            item.style.background = isActive ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.02)";
            item.style.borderRadius = "4px";
            item.style.position = "relative";
            item.style.display = "flex";
            item.style.flexDirection = "column";
            item.style.gap = "2px";
            item.style.cursor = "pointer";
            
            // 상단 행: 체크박스 + 색상닷 + 타입 + 이름 + 팝오버
            const topRow = document.createElement('div');
            topRow.style.display = "flex";
            topRow.style.alignItems = "center";
            topRow.style.width = "100%";
            topRow.style.gap = "4px";
            
            // compareEnabled 체크박스
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!ds.compareEnabled;
            cb.style.cursor = 'pointer';
            cb.style.margin = '0 2px 0 0';
            cb.addEventListener('click', async (e) => {
                e.stopPropagation(); // 부모 item 클릭 이벤트로의 전파 차단
                ds.compareEnabled = cb.checked;
                await updateDatasetInDB(ds);
                renderDatasetLibraryUI();
                renderLibraryTable();
                // GITT 데이터셋: 체크박스가 GITT 탭 그래프 표시/숨김을 제어 (21-gitt.js)
                if (ds.experimentType === 'gitt') {
                    if (window.GittAnalyzer && typeof GittAnalyzer.setCompare === 'function') {
                        GittAnalyzer.setCompare(ds.id, cb.checked);
                    }
                    return; // 일반 분석(runAnalysis) 대상 아님
                }
                if (hasActiveDataset()) runAnalysis();
            });
            
            // lineColor dot
            const lineDot = document.createElement('span');
            lineDot.style.display = "inline-block";
            lineDot.style.width = "6px";
            lineDot.style.height = "6px";
            lineDot.style.borderRadius = "50%";
            lineDot.style.backgroundColor = ds.lineColor;
            lineDot.style.flexShrink = "0";
            
            // experimentType 표시: RATE/CYCLE 선택박스 (GITT·CV 는 기존 배지 유지)
            //   - 자동 판별(19-experiment-detector.js) 결과를 초기값으로 표시
            //   - 잘못 판별된 경우 사용자가 직접 변경 → 즉시 반대쪽 차트로 이동
            let expBadge;
            if (ds.experimentType === 'gitt' || ds.experimentType === 'cv') {
                expBadge = document.createElement('span');
                expBadge.className = 'status-badge';
                expBadge.style.fontSize = '8px';
                expBadge.style.padding = '1px 3px';
                expBadge.style.background = 'rgba(255,255,255,0.08)';
                expBadge.style.color = 'var(--text-muted)';
                expBadge.style.border = 'none';
                expBadge.textContent = ds.experimentType.toUpperCase();
            } else {
                expBadge = document.createElement('select');
                expBadge.className = 'ds-kind-select';
                expBadge.title = '실험 종류 (RATE = Rate Capability / CYCLE = Cyclability)\n잘못 판별된 경우 직접 변경하면 해당 차트로 이동합니다.';
                expBadge.style.fontSize = '8px';
                expBadge.style.padding = '1px 2px';
                expBadge.style.background = 'rgba(255,255,255,0.08)';
                expBadge.style.color = 'var(--text-muted)';
                expBadge.style.border = '1px solid rgba(255,255,255,0.15)';
                expBadge.style.borderRadius = '3px';
                expBadge.style.cursor = 'pointer';
                expBadge.style.flexShrink = '0';
                expBadge.style.colorScheme = 'dark';

                [['rate', 'RATE'], ['cycle_performance', 'CYCLE']].forEach(([val, label]) => {
                    const opt = document.createElement('option');
                    opt.value = val;
                    opt.textContent = label;
                    expBadge.appendChild(opt);
                });

                // 현재 유효 종류(수동 지정 > 자동 판별)를 초기값으로 표시
                let kind = null;
                if (window.ExperimentDetector && typeof ExperimentDetector.getEffectiveKind === 'function') {
                    kind = ExperimentDetector.getEffectiveKind(ds);
                }
                if (kind === 'cycle') expBadge.value = 'cycle_performance';
                else if (kind === 'rate') expBadge.value = 'rate';
                else expBadge.value = (ds.experimentType === 'cycle_performance') ? 'cycle_performance' : 'rate';

                // 클릭이 부모 카드(활성 전환)로 전파되지 않도록 차단
                expBadge.addEventListener('click', (e) => e.stopPropagation());

                expBadge.addEventListener('change', async (e) => {
                    e.stopPropagation();
                    ds.experimentType = expBadge.value;   // 'rate' | 'cycle_performance'
                    ds.kindManual = true;                 // 수동 지정 플래그 (자동 판별보다 우선)
                    try { await updateDatasetInDB(ds); }
                    catch (err) { console.warn('실험 종류 저장 실패:', err); }
                    renderDatasetLibraryUI();
                    renderLibraryTable();
                    if (hasActiveDataset()) runAnalysis();  // 차트/탭 라우팅 즉시 갱신
                });
            }
            
            // dataName text
            const nameSpan = document.createElement('span');
            nameSpan.style.fontWeight = "600";
            nameSpan.style.fontSize = "11px";
            nameSpan.style.color = "#fff";
            nameSpan.style.overflow = "hidden";
            nameSpan.style.textOverflow = "ellipsis";
            nameSpan.style.whiteSpace = "nowrap";
            nameSpan.style.flexGrow = "1";
            nameSpan.textContent = ds.dataName;
            nameSpan.title = ds.dataName;
            
            // 데이터명 수정 인라인 아이콘
            const editIcon = document.createElement('span');
            editIcon.className = 'ds-inline-edit-icon material-icons-round';
            editIcon.textContent = 'edit';
            editIcon.title = '데이터명 수정';
            editIcon.addEventListener('click', (e) => {
                e.stopPropagation();
                renameDatasetDataName(ds.id);
            });
            
            // 분석중 badge
            let activeLabel = null;
            if (isActive) {
                activeLabel = document.createElement('span');
                activeLabel.style.fontSize = '8px';
                activeLabel.style.padding = '1px 3px';
                activeLabel.style.borderRadius = '2px';
                activeLabel.style.background = 'rgba(96,165,250,0.15)';
                activeLabel.style.color = 'var(--color-primary)';
                activeLabel.textContent = '분석중';
            }
            
            // status badge
            const statusBadge = document.createElement('span');
            statusBadge.className = `status-badge status-${ds.conversionStatus}`;
            statusBadge.style.fontSize = '8px';
            statusBadge.style.padding = '1px 3px';
            statusBadge.textContent = getStatusLabel(ds.conversionStatus);
            
            // X 삭제 버튼
            const deleteBtn = document.createElement('button');
            deleteBtn.className = "ds-delete-btn";
            deleteBtn.title = "삭제";
            deleteBtn.innerHTML = `<span class="material-icons-round" style="font-size:14px;">close</span>`;
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 부모 카드 active 활성화 전파 차단
                if (confirm("정말로 이 데이터셋을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) {
                    removeDataset(ds.id);
                }
            });
            
            // 더보기 메뉴 버튼
            const moreBtn = document.createElement('button');
            moreBtn.className = "ds-more-menu-btn";
            moreBtn.style.background = "transparent";
            moreBtn.style.border = "none";
            moreBtn.style.color = "var(--text-muted)";
            moreBtn.style.cursor = "pointer";
            moreBtn.style.fontSize = "14px";
            moreBtn.style.padding = "0 2px";
            moreBtn.innerHTML = "&#8942;";
            
            topRow.appendChild(cb);
            topRow.appendChild(lineDot);
            topRow.appendChild(expBadge);
            topRow.appendChild(nameSpan);
            topRow.appendChild(editIcon);
            if (activeLabel) topRow.appendChild(activeLabel);
            topRow.appendChild(statusBadge);
            topRow.appendChild(deleteBtn);
            topRow.appendChild(moreBtn);
            
            // 하단 행: keyMetric + lastConvertedAt
            const metaRow = document.createElement('div');
            metaRow.style.fontSize = "9px";
            metaRow.style.color = "var(--text-muted)";
            metaRow.style.paddingLeft = "18px"; // 체크박스와 정렬 맞추기
            metaRow.textContent = `${ds.keyMetric} · ${ds.lastConvertedAt}`;
            
            item.appendChild(topRow);
            item.appendChild(metaRow);
            
            // 더보기 클릭 시 fixed 기반 팝오버를 동적으로 body에 생성 및 배치
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                
                // 기존 활성화된 모든 context menu 제거
                document.querySelectorAll('.ds-context-menu').forEach(m => m.remove());
                
                const menu = createContextMenu(ds);
                document.body.appendChild(menu);
                menu.style.display = 'flex';
                
                const rect = moreBtn.getBoundingClientRect();
                const menuWidth = 150;
                let leftPos = rect.right - menuWidth;
                if (leftPos < 10) leftPos = 10;
                
                let topPos = rect.bottom;
                const menuHeight = 240;
                if (topPos + menuHeight > window.innerHeight) {
                    topPos = rect.top - menuHeight;
                    if (topPos < 10) topPos = 10;
                }
                
                menu.style.top = `${topPos}px`;
                menu.style.left = `${leftPos}px`;
            });
            
            item.addEventListener('click', (e) => {
                if (e.target.closest('.ds-more-menu-btn') || e.target.closest('.ds-inline-edit-icon') || e.target.closest('.ds-delete-btn') || e.target.closest('.ds-context-menu')) return;
                switchActiveDataset(ds.id);
            });
            
            content.appendChild(item);
        });
        
        groupContainer.appendChild(header);
        groupContainer.appendChild(content);
        listEl.appendChild(groupContainer);
    });
}
