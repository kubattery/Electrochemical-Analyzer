/* ============================================================================
 * HC-Analyzer  ·  05-dataset-helpers.js
 * 역할: 데이터셋 이름·색상·정규화 헬퍼 · 인라인 편집/이름변경
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 05/15  (이전: js/04-database.js → 다음: js/06-demo-update.js)
 * ============================================================================ */
/* ============================================================
   데이터셋 라이브러리 관리 함수들 (자동 변환 데이터 관리 구조 개편)
   ============================================================ */

/**
 * 데이터명 중복 검사 함수 (lowerCase, trim 기준)
 */
function isDuplicateDataName(name, excludeDatasetId = null) {
    const normalized = String(name || '').trim().toLowerCase();
    if (!normalized) return false;

    return datasetLibrary.some(ds => {
        if (excludeDatasetId && ds.id === excludeDatasetId) return false;
        return String(ds.dataName || '').trim().toLowerCase() === normalized;
    });
}

/**
 * 중복되지 않는 유니크한 데이터명 자동 생성
 */
function generateUniqueDataName(baseName) {
    const cleanBase = String(baseName || 'Untitled Dataset').trim();
    let candidate = cleanBase;
    let idx = 2;

    while (isDuplicateDataName(candidate)) {
        candidate = `${cleanBase}_${idx}`;
        idx++;
    }
    return candidate;
}

/**
 * 데이터 모델 보정 및 마이그레이션 함수
 */
function normalizeDataset(ds) {
    ds.projectName = ds.projectName || "Default Project";
    ds.experimentType = ds.experimentType || "rate";
    ds.dataName = ds.dataName || ds.customName || (ds.filename ? ds.filename.replace(/\.[^.]+$/, '') : "Unknown Data");
    ds.customName = ds.dataName; // 호환성 유지
    ds.sampleName = ds.sampleName || "(샘플 미지정)";
    ds.conversionStatus = ds.conversionStatus || "converted";
    ds.keyMetric = ds.keyMetric || (ds.ice && ds.ice !== "-" ? `ICE: ${ds.ice}%` : `Cycles: ${ds.totalCycles}`);
    ds.lastConvertedAt = ds.lastConvertedAt || ds.uploadedAt || new Date().toLocaleTimeString('ko-KR');
    
    // 색상 이원화 적용
    ds.groupColor = getSampleGroupColor(ds.sampleName);
    ds.lineColor = getDatasetLineColor(ds.id || ds.dataName);
    ds.color = ds.lineColor; // 기존 차트 호환성 유지
    
    return ds;
}

/**
 * sampleName 기준으로 groupColor 가져오기 (localStorage 연동)
 */
function getSampleGroupColor(sampleName) {
    let groupColors = JSON.parse(localStorage.getItem('hc_sample_group_colors')) || {};
    const key = sampleName && sampleName.trim() !== "" ? sampleName.trim() : "(샘플 미지정)";
    
    if (groupColors[key]) {
        return groupColors[key];
    }
    
    const usedColors = Object.values(groupColors);
    const availableColor = DATASET_COLORS.find(c => !usedColors.includes(c)) || DATASET_COLORS[usedColors.length % DATASET_COLORS.length];
    
    groupColors[key] = availableColor;
    localStorage.setItem('hc_sample_group_colors', JSON.stringify(groupColors));
    return availableColor;
}

/**
 * dataset id 기준으로 lineColor 가져오기 (localStorage 연동)
 */
function getDatasetLineColor(idOrDataName) {
    let lineColors = JSON.parse(localStorage.getItem('hc_dataset_line_colors')) || {};
    const key = idOrDataName || "Unknown";
    
    if (lineColors[key]) {
        return lineColors[key];
    }
    
    const usedColors = Object.values(lineColors);
    const availableColor = DATASET_COLORS.find(c => !usedColors.includes(c)) || DATASET_COLORS[usedColors.length % DATASET_COLORS.length];
    
    lineColors[key] = availableColor;
    localStorage.setItem('hc_dataset_line_colors', JSON.stringify(lineColors));
    return availableColor;
}

/**
 * 데이터셋 데이터명 수정 공통 함수
 */
/* ==========================================
   인라인 편집 함수 (데이터 라이브러리 테이블)
   ponytail: prompt() 대체, 최소 DOM 조작
   ========================================== */

/** 현재 열린 인라인 편집 패널 모두 닫기 */
function closeInlineEditors() {
    document.querySelectorAll('.inline-edit-wrap, .inline-select-panel').forEach(el => el.remove());
}

/** Data Name 저장 (검증 공통 — renameDatasetDataName과 동일 로직) */
async function saveDatasetDataName(ds, newName) {
    const trimmed = newName.trim();
    if (!trimmed) { alert('데이터명은 빈 칸일 수 없습니다.'); return false; }
    if (trimmed === ds.dataName) return true; // 변경 없음
    if (isDuplicateDataName(trimmed, ds.id)) {
        alert('이미 같은 데이터명이 존재합니다. 다른 이름을 입력해 주세요.');
        return false;
    }
    ds.dataName = trimmed;
    ds.customName = trimmed;
    if (ds.id === activeDatasetId) {
        const el = document.getElementById('activeFilename');
        if (el) el.textContent = trimmed;
    }
    await updateDatasetInDB(ds);
    renderDatasetLibraryUI();
    renderLibraryTable();
    if (hasActiveDataset()) runAnalysis();
    return true;
}

/** Sample Name 저장 */
async function saveDatasetSampleName(ds, newSample) {
    const trimmed = newSample.trim() || '(샘플 미지정)';
    ds.sampleName = trimmed;
    normalizeDataset(ds);
    await updateDatasetInDB(ds);
    renderDatasetLibraryUI();
    renderLibraryTable();
    if (hasActiveDataset()) runAnalysis();
}

/** Project Name 저장 */
async function saveDatasetProjectName(ds, newProject) {
    const trimmed = newProject.trim();
    if (!trimmed) return;
    if (!projects.includes(trimmed)) {
        projects.push(trimmed);
        localStorage.setItem('hc_projects', JSON.stringify(projects));
    }
    ds.projectName = trimmed;
    await updateDatasetInDB(ds);
    renderDatasetLibraryUI();
    renderLibraryTable();
    if (hasActiveDataset()) runAnalysis();
}

/** Data Name 인라인 수정 패널 열기 */
function startInlineDataNameEdit(td, ds) {
    closeInlineEditors();
    const orig = td.innerHTML;
    const wrap = document.createElement('div');
    wrap.className = 'inline-edit-wrap';

    const input = document.createElement('input');
    input.value = ds.dataName;
    input.style.maxWidth = '180px';

    const btnSave = document.createElement('button');
    btnSave.className = 'btn-table-action';
    btnSave.title = '저장';
    btnSave.innerHTML = '<span class="material-icons-round" style="font-size:14px;color:#4ade80">check</span>';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn-table-action';
    btnCancel.title = '취소';
    btnCancel.innerHTML = '<span class="material-icons-round" style="font-size:14px">close</span>';

    wrap.append(input, btnSave, btnCancel);
    td.innerHTML = '';
    td.appendChild(wrap);
    input.focus();
    input.select();

    const doSave = async () => {
        const ok = await saveDatasetDataName(ds, input.value);
        if (!ok) { input.focus(); }
    };
    btnSave.addEventListener('click', e => { e.stopPropagation(); doSave(); });
    btnCancel.addEventListener('click', e => { e.stopPropagation(); td.innerHTML = orig; });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doSave(); }
        if (e.key === 'Escape') { td.innerHTML = orig; }
    });
    input.addEventListener('click', e => e.stopPropagation());
}

/** Sample Name 인라인 수정 패널 열기 */
/** Sample Name 인라인 수정 패널 열기 (fixed 팝오버 방식) */
function startInlineSampleEdit(td, ds) {
    closeInlineEditors();

    const names = [...new Set(datasetLibrary.map(d => d.sampleName || '(샘플 미지정)'))];
    const rect = td.getBoundingClientRect();

    const panel = document.createElement('div');
    panel.className = 'inline-select-panel ds-context-menu'; // ds-context-menu로 전역 닫기 재사용
    panel.style.cssText = `position:fixed;top:${Math.min(rect.bottom + 4, window.innerHeight - 260)}px;left:${rect.left}px;z-index:9999;`;

    names.forEach(name => {
        const item = document.createElement('div');
        item.className = 'isp-item' + (name === ds.sampleName ? ' active' : '');
        item.textContent = name;
        item.addEventListener('click', e => { e.stopPropagation(); saveDatasetSampleName(ds, name); });
        panel.appendChild(item);
    });

    // + 새 샘플 행
    const newWrap = document.createElement('div');
    newWrap.className = 'isp-new-wrap';
    const newInput = document.createElement('input');
    newInput.placeholder = '새 샘플 이름...';
    const newBtn = document.createElement('button');
    newBtn.className = 'btn-table-action';
    newBtn.innerHTML = '<span class="material-icons-round" style="font-size:13px;color:#4ade80">add</span>';
    newBtn.addEventListener('click', e => { e.stopPropagation(); saveDatasetSampleName(ds, newInput.value); });
    newInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); saveDatasetSampleName(ds, newInput.value); }
        if (e.key === 'Escape') { panel.remove(); }
        e.stopPropagation();
    });
    newInput.addEventListener('click', e => e.stopPropagation());
    newWrap.append(newInput, newBtn);
    panel.appendChild(newWrap);

    panel.addEventListener('click', e => e.stopPropagation());
    document.querySelectorAll('.ds-context-menu').forEach(el => el.remove());
    document.body.appendChild(panel);
}


/** Project Name 인라인 수정 패널 열기 (fixed 팝오버 방식) */
function startInlineProjectEdit(td, ds) {
    closeInlineEditors();

    const rect = td.getBoundingClientRect();
    const panel = document.createElement('div');
    panel.className = 'inline-select-panel ds-context-menu';
    panel.style.cssText = `position:fixed;top:${Math.min(rect.bottom + 4, window.innerHeight - 260)}px;left:${rect.left}px;z-index:9999;`;

    projects.forEach(pName => {
        const item = document.createElement('div');
        item.className = 'isp-item' + (pName === ds.projectName ? ' active' : '');
        item.textContent = pName;
        item.addEventListener('click', e => { e.stopPropagation(); saveDatasetProjectName(ds, pName); });
        panel.appendChild(item);
    });

    // + 새 프로젝트 행
    const newWrap = document.createElement('div');
    newWrap.className = 'isp-new-wrap';
    const newInput = document.createElement('input');
    newInput.placeholder = '새 프로젝트명...';
    const newBtn = document.createElement('button');
    newBtn.className = 'btn-table-action';
    newBtn.innerHTML = '<span class="material-icons-round" style="font-size:13px;color:#4ade80">add</span>';
    newBtn.addEventListener('click', e => { e.stopPropagation(); saveDatasetProjectName(ds, newInput.value); });
    newInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); saveDatasetProjectName(ds, newInput.value); }
        if (e.key === 'Escape') { panel.remove(); }
        e.stopPropagation();
    });
    newInput.addEventListener('click', e => e.stopPropagation());
    newWrap.append(newInput, newBtn);
    panel.appendChild(newWrap);

    panel.addEventListener('click', e => e.stopPropagation());
    document.querySelectorAll('.ds-context-menu').forEach(el => el.remove());
    document.body.appendChild(panel);
}


async function renameDatasetDataName(datasetId) {
    const ds = datasetLibrary.find(d => d.id === datasetId);
    if (!ds) return;

    const newName = prompt("변경할 데이터명을 입력하세요:", ds.dataName);
    if (newName === null) return; // 취소 버튼

    const trimmedName = newName.trim();
    if (!trimmedName) {
        alert("데이터명은 빈 칸일 수 없습니다.");
        return;
    }

    if (trimmedName === ds.dataName) {
        return; // 변경사항 없음
    }

    // 중복 검사
    if (isDuplicateDataName(trimmedName, datasetId)) {
        alert("이미 같은 데이터명이 존재합니다. 다른 이름을 입력해 주세요.");
        return;
    }

    // 명칭 업데이트 및 동기화
    ds.dataName = trimmedName;
    ds.customName = trimmedName;

    if (ds.id === activeDatasetId) {
        const activeFilenameEl = document.getElementById('activeFilename');
        if (activeFilenameEl) {
            activeFilenameEl.textContent = trimmedName;
        }
    }

    await updateDatasetInDB(ds);
    renderDatasetLibraryUI();
    renderLibraryTable();
    if (hasActiveDataset()) runAnalysis();
}

/**
 * 데이터셋 샘플명 수정 공통 함수
 */
async function renameDatasetSampleName(datasetId) {
    const ds = datasetLibrary.find(d => d.id === datasetId);
    if (!ds) return;

    const newSample = prompt("변경할 샘플명을 입력하세요 (비워두면 샘플 미지정):", ds.sampleName === "(샘플 미지정)" ? "" : ds.sampleName);
    if (newSample === null) return; // 취소

    const trimmedSample = newSample.trim() || "(샘플 미지정)";

    ds.sampleName = trimmedSample;
    normalizeDataset(ds); // groupColor 및 color 자동 재계산

    await updateDatasetInDB(ds);
    renderDatasetLibraryUI();
    renderLibraryTable();
    if (hasActiveDataset()) runAnalysis();
}

/**
 * 샘플 그룹 이름 일괄 수정 공통 함수
 */
async function renameSampleGroup(oldSampleName) {
    const cleanOldSample = oldSampleName && oldSampleName.trim() !== "" ? oldSampleName.trim() : "(샘플 미지정)";
    
    const newSampleName = prompt(`'${cleanOldSample}' 그룹의 새 이름을 입력하세요 (비워두면 샘플 미지정):`, cleanOldSample === "(샘플 미지정)" ? "" : cleanOldSample);
    if (newSampleName === null) return; // 취소

    const cleanNewSample = newSampleName.trim() || "(샘플 미지정)";
    if (cleanNewSample === cleanOldSample) return;

    // 해당 그룹에 속한 모든 데이터셋의 sampleName을 일괄 갱신
    for (const ds of datasetLibrary) {
        const currentSample = ds.sampleName || "(샘플 미지정)";
        if (currentSample === cleanOldSample) {
            ds.sampleName = cleanNewSample;
            normalizeDataset(ds); // groupColor 재계산
            await updateDatasetInDB(ds);
        }
    }

    renderDatasetLibraryUI();
    renderLibraryTable();
    if (hasActiveDataset()) runAnalysis();
}

