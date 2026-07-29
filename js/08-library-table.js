/* ============================================================================
 * HC-Analyzer  ·  08-library-table.js
 * 역할: 라이브러리 테이블 렌더링 · 컨텍스트 메뉴 · 필터 칩
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 08/15  (이전: js/07-projects.js → 다음: js/09-dataset-library.js)
 * ============================================================================ */
/**
 * 상태값 라벨 헬퍼
 */
function getStatusLabel(status) {
    switch (status) {
        case 'pending': return '대기 중';
        case 'converting': return '변환 중';
        case 'converted': return '완료';
        case 'failed': return '실패';
        case 'updated': return '업데이트됨';
        default: return status;
    }
}

/**
 * 더보기 팝오버 메뉴 빌드
 */
function createContextMenu(ds) {
    const menu = document.createElement('div');
    menu.className = "ds-context-menu";
    
    // 메뉴 내부 클릭 시 전파 차단
    menu.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    
    const btnOpen = document.createElement('button');
    btnOpen.className = "ds-context-menu-item";
    btnOpen.innerHTML = `<span class="material-icons-round" style="font-size:14px;">open_in_new</span>분석 열기`;
    btnOpen.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        switchActiveDataset(ds.id);
        const overviewTabBtn = document.querySelector('.tab-btn[data-tab="tab-overview"]');
        if (overviewTabBtn) overviewTabBtn.click();
    });
    
    const btnEditName = document.createElement('button');
    btnEditName.className = "ds-context-menu-item";
    btnEditName.innerHTML = `<span class="material-icons-round" style="font-size:14px;">edit</span>데이터명 수정`;
    btnEditName.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        renameDatasetDataName(ds.id);
    });
    
    const btnEditSample = document.createElement('button');
    btnEditSample.className = "ds-context-menu-item";
    btnEditSample.innerHTML = `<span class="material-icons-round" style="font-size:14px;">science</span>샘플명 수정`;
    btnEditSample.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        renameDatasetSampleName(ds.id);
    });
 
    const btnReconvert = document.createElement('button');
    btnReconvert.className = "ds-context-menu-item";
    btnReconvert.innerHTML = `<span class="material-icons-round" style="font-size:14px;">autorenew</span>재변환`;
    btnReconvert.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        alert(`${ds.dataName} 데이터셋의 재변환을 시뮬레이션합니다.`);
    });
 
    const btnDownload = document.createElement('button');
    btnDownload.className = "ds-context-menu-item";
    btnDownload.innerHTML = `<span class="material-icons-round" style="font-size:14px;">download</span>Excel 다운로드`;
    btnDownload.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        const prevActive = activeDatasetId;
        switchActiveDataset(ds.id);
        exportVoltageProfileDataToExcel().then(() => {
            if (prevActive && prevActive !== ds.id) switchActiveDataset(prevActive);
        });
    });
 
    const btnViewLog = document.createElement('button');
    btnViewLog.className = "ds-context-menu-item";
    btnViewLog.innerHTML = `<span class="material-icons-round" style="font-size:14px;">history</span>로그 보기`;
    btnViewLog.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        alert(`=== ${ds.dataName} 변환 로그 ===\n[INFO] 파일 파싱 완료\n[INFO] 데이터 분석 완료\n[SUCCESS] 변환 완료 (ICE: ${ds.ice}%)`);
    });
 
    const btnDelete = document.createElement('button');
    btnDelete.className = "ds-context-menu-item danger";
    btnDelete.style.color = "var(--color-danger)";
    btnDelete.innerHTML = `<span class="material-icons-round" style="font-size:14px; color:var(--color-danger);">delete</span>삭제`;
    btnDelete.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        if (confirm("정말로 이 데이터셋을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) {
            removeDataset(ds.id);
        }
    });
    
    menu.appendChild(btnOpen);
    menu.appendChild(btnEditName);
    menu.appendChild(btnEditSample);
    menu.appendChild(btnReconvert);
    menu.appendChild(btnDownload);
    menu.appendChild(btnViewLog);
    menu.appendChild(btnDelete);
    
    return menu;
}

/**
 * 메인 탭 라이브러리 테이블 렌더링
 */
function renderLibraryTable() {
    const libTableBody = document.getElementById('libTableBody');
    const libTabSearch = document.getElementById('libTabSearch');
    const libTabProjectFilter = document.getElementById('libTabProjectFilter');
    const libTabTypeFilter = document.getElementById('libTabTypeFilter');
    const libTabStatusFilter = document.getElementById('libTabStatusFilter');
    const libTabSort = document.getElementById('libTabSort');

    if (!libTableBody) return;
    
    const searchVal = libTabSearch ? libTabSearch.value.toLowerCase().trim() : "";
    const projectFilter = libTabProjectFilter ? libTabProjectFilter.value : "all";
    const typeFilter = libTabTypeFilter ? libTabTypeFilter.value : "all";
    const statusFilter = libTabStatusFilter ? libTabStatusFilter.value : "all";
    const sortVal = libTabSort ? libTabSort.value : "newest";
    
    let list = [...datasetLibrary];
    
    // 필터링 적용
    if (searchVal) {
        list = list.filter(ds => 
            ds.dataName.toLowerCase().includes(searchVal) || 
            ds.sampleName.toLowerCase().includes(searchVal) || 
            ds.filename.toLowerCase().includes(searchVal)
        );
    }
    
    if (projectFilter !== 'all') {
        list = list.filter(ds => ds.projectName === projectFilter);
    }
    
    if (typeFilter !== 'all') {
        list = list.filter(ds => ds.experimentType === typeFilter);
    }
    
    if (statusFilter !== 'all') {
        list = list.filter(ds => ds.conversionStatus === statusFilter);
    }
    
    // 정렬 적용
    if (sortVal === 'newest') {
        list.sort((a, b) => b.id.localeCompare(a.id));
    } else if (sortVal === 'name') {
        list.sort((a, b) => a.dataName.localeCompare(b.dataName));
    } else if (sortVal === 'type') {
        list.sort((a, b) => a.experimentType.localeCompare(b.experimentType));
    }
    
    libTableBody.innerHTML = "";
    
    if (list.length === 0) {
        libTableBody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 24px;">조건에 맞는 데이터가 존재하지 않습니다.</td></tr>`;
        return;
    }
    
    list.forEach(ds => {
        const tr = document.createElement('tr');
        tr.style.cursor = "pointer";
        if (ds.id === activeDatasetId) {
            tr.style.backgroundColor = "rgba(255,255,255,0.06)";
        }
        
        // 1. 표시 (Checkbox)
        const tdCheck = document.createElement('td');
        tdCheck.style.padding = "12px 16px";
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!ds.compareEnabled;
        cb.style.cursor = 'pointer';
        cb.addEventListener('click', async (e) => {
            e.stopPropagation(); // 행 클릭 이벤트 전파 차단
            ds.compareEnabled = cb.checked;
            await updateDatasetInDB(ds);
            renderDatasetLibraryUI();
            renderLibraryTable();
            if (hasActiveDataset()) runAnalysis();
        });
        tdCheck.appendChild(cb);
        
        // 2. Data Name (lineColor dot + dataName)
        const tdName = document.createElement('td');
        tdName.style.padding = "12px 16px";
        tdName.style.fontWeight = "600";
        tdName.style.color = "#fff";
        
        const lineDot = document.createElement('span');
        lineDot.style.display = "inline-block";
        lineDot.style.width = "8px";
        lineDot.style.height = "8px";
        lineDot.style.borderRadius = "50%";
        lineDot.style.backgroundColor = ds.lineColor;
        lineDot.style.marginRight = "8px";
        
        const textSpan = document.createElement('span');
        textSpan.textContent = ds.dataName;
        
        tdName.appendChild(lineDot);
        tdName.appendChild(textSpan);
        
        // 데이터명 셀 더블클릭 → 인라인 편집
        tdName.style.position = 'relative';
        tdName.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            startInlineDataNameEdit(tdName, ds);
        });
        
        // 3. Sample (groupColor dot + sampleName)
        const tdSample = document.createElement('td');
        tdSample.style.padding = "12px 16px";
        
        const groupDot = document.createElement('span');
        groupDot.style.display = "inline-block";
        groupDot.style.width = "8px";
        groupDot.style.height = "8px";
        groupDot.style.borderRadius = "50%";
        groupDot.style.backgroundColor = ds.groupColor;
        groupDot.style.marginRight = "8px";
        
        const sampleText = document.createElement('span');
        sampleText.textContent = ds.sampleName || "(미지정)";
        sampleText.style.color = "#fff";
        
        tdSample.appendChild(groupDot);
        tdSample.appendChild(sampleText);
        
        // 샘플명 셀 더블클릭 → 인라인 편집
        tdSample.style.position = 'relative';
        tdSample.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            startInlineSampleEdit(tdSample, ds);
        });
        
        // 4. Project (더블클릭 → 인라인 편집)
        const tdProject = document.createElement('td');
        tdProject.style.padding = "12px 16px";
        tdProject.style.position = 'relative';
        tdProject.textContent = ds.projectName;
        tdProject.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            startInlineProjectEdit(tdProject, ds);
        });
        
        // 5. Experiment Type
        const tdType = document.createElement('td');
        tdType.style.padding = "12px 16px";
        tdType.textContent = (EXPERIMENT_TYPES.find(t => t.key === ds.experimentType) || {label: ds.experimentType}).label;
        
        // 6. Status
        const tdStatus = document.createElement('td');
        tdStatus.style.padding = "12px 16px";
        const badge = document.createElement('span');
        badge.className = `status-badge status-${ds.conversionStatus}`;
        badge.textContent = getStatusLabel(ds.conversionStatus);
        tdStatus.appendChild(badge);
        
        // 7. Key Metric
        const tdMetric = document.createElement('td');
        tdMetric.style.padding = "12px 16px";
        tdMetric.textContent = ds.keyMetric;
        
        // 8. Updated
        const tdUpdated = document.createElement('td');
        tdUpdated.style.padding = "12px 16px";
        tdUpdated.textContent = ds.lastConvertedAt;
        
        // 9. Actions
        const tdActions = document.createElement('td');
        tdActions.style.padding = "12px 16px";
        tdActions.style.textAlign = "right";
        
        // 분석 열기
        const btnOpen = document.createElement('button');
        btnOpen.className = "btn-table-action";
        btnOpen.innerHTML = `<span class="material-icons-round" style="font-size:14px;">open_in_new</span>`;
        btnOpen.title = "분석 열기";
        btnOpen.addEventListener('click', (e) => {
            e.stopPropagation();
            switchActiveDataset(ds.id);
            const overviewTabBtn = document.querySelector('.tab-btn[data-tab="tab-overview"]');
            if (overviewTabBtn) overviewTabBtn.click();
        });
        
        // 데이터명 수정 → 인라인
        const btnEditName = document.createElement('button');
        btnEditName.className = "btn-table-action";
        btnEditName.innerHTML = `<span class="material-icons-round" style="font-size:14px; color:var(--text-muted);">edit</span>`;
        btnEditName.title = "데이터명 수정";
        btnEditName.addEventListener('click', (e) => {
            e.stopPropagation();
            startInlineDataNameEdit(tdName, ds);
        });
        
        // 샘플명 수정 → 인라인
        const btnEditSample = document.createElement('button');
        btnEditSample.className = "btn-table-action";
        btnEditSample.innerHTML = `<span class="material-icons-round" style="font-size:14px; color:var(--text-muted);">science</span>`;
        btnEditSample.title = "샘플명 수정";
        btnEditSample.addEventListener('click', (e) => {
            e.stopPropagation();
            startInlineSampleEdit(tdSample, ds);
        });
        
        // 삭제
        const btnDel = document.createElement('button');
        btnDel.className = "btn-table-action";
        btnDel.innerHTML = `<span class="material-icons-round" style="font-size:14px; color:var(--color-danger);">delete</span>`;
        btnDel.title = "삭제";
        btnDel.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm("정말로 이 데이터셋을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) {
                removeDataset(ds.id);
            }
        });
        
        tdActions.appendChild(btnOpen);
        tdActions.appendChild(btnEditName);
        tdActions.appendChild(btnEditSample);
        // Project 수정 버튼 (Actions 컬럼)
        const btnEditProject = document.createElement('button');
        btnEditProject.className = "btn-table-action";
        btnEditProject.innerHTML = `<span class="material-icons-round" style="font-size:14px; color:var(--text-muted);">folder</span>`;
        btnEditProject.title = "프로젝트 수정";
        btnEditProject.addEventListener('click', (e) => {
            e.stopPropagation();
            startInlineProjectEdit(tdProject, ds);
        });
        tdActions.appendChild(btnEditProject);
        tdActions.appendChild(btnDel);
        
        tr.appendChild(tdCheck);
        tr.appendChild(tdName);
        tr.appendChild(tdSample);
        tr.appendChild(tdProject);
        tr.appendChild(tdType);
        tr.appendChild(tdStatus);
        tr.appendChild(tdMetric);
        tr.appendChild(tdUpdated);
        tr.appendChild(tdActions);
        
        // 행 클릭 시 활성화로 설정 (각 버튼 및 더블클릭 수정과 간섭 방지)
        let clickTimeout = null;
        tr.addEventListener('click', (e) => {
            if (e.target.closest('input[type="checkbox"]') || e.target.closest('.btn-table-action')) return;
            
            // 데이터명 셀 또는 샘플명 셀 클릭 시에는 더블클릭 판정을 위해 대기
            if (e.target.closest('td') === tdName || e.target.closest('td') === tdSample) {
                if (clickTimeout) {
                    clearTimeout(clickTimeout);
                    clickTimeout = null;
                    return; // 더블클릭이 진행되므로 싱글클릭 탭 튕김 방지
                }
                
                clickTimeout = setTimeout(() => {
                    switchActiveDataset(ds.id);
                    clickTimeout = null;
                }, 200);
            } else {
                if (clickTimeout) {
                    clearTimeout(clickTimeout);
                    clickTimeout = null;
                }
                switchActiveDataset(ds.id);
            }
        });
        
        libTableBody.appendChild(tr);
    });
}

/**
 * 사이드바 라이브러리 필터 칩 바인딩
 */
function initLibraryFilterChips() {
    const chips = document.querySelectorAll('.library-filter-chips .chip');
    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            chips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            currentLibraryFilter = chip.getAttribute('data-filter');
            renderDatasetLibraryUI();
        });
    });
}


window.addEventListener('click', () => {
    document.querySelectorAll('.ds-context-menu').forEach(menu => {
        menu.remove();
    });
});

