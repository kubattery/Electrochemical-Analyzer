/* ============================================================================
 * HC-Analyzer  ·  07-projects.js
 * 역할: 프로젝트 관리(추가/수정/전환)
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 07/15  (이전: js/06-demo-update.js → 다음: js/08-library-table.js)
 * ============================================================================ */
/**
 * 프로젝트 관리 select 옵션 동적 구성 및 관리
 */
function initProjectManagement() {
    const select = document.getElementById('projectSelect');
    const filterSelect = document.getElementById('libTabProjectFilter');
    const btnAdd = document.getElementById('btnAddProject');
    const btnRename = document.getElementById('btnRenameProject');
    
    function populateProjectSelects() {
        if (!select) return;
        select.innerHTML = "";
        projects.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            select.appendChild(opt);
        });
        select.value = activeProjectId;
        
        if (filterSelect) {
            filterSelect.innerHTML = '<option value="all">모든 프로젝트</option>';
            projects.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p;
                opt.textContent = p;
                filterSelect.appendChild(opt);
            });
        }
    }
    
    populateProjectSelects();
    
    if (select) {
        select.addEventListener('change', () => {
            activeProjectId = select.value;
            localStorage.setItem('hc_active_project_id', activeProjectId);
            renderDatasetLibraryUI();
            renderLibraryTable();
        });
    }
    
    if (btnAdd) {
        btnAdd.addEventListener('click', () => {
            const name = prompt("새 프로젝트 명을 입력하세요:");
            if (name && name.trim()) {
                const cleanName = name.trim();
                if (!projects.includes(cleanName)) {
                    projects.push(cleanName);
                    localStorage.setItem('hc_projects', JSON.stringify(projects));
                    activeProjectId = cleanName;
                    localStorage.setItem('hc_active_project_id', activeProjectId);
                    populateProjectSelects();
                    renderDatasetLibraryUI();
                    renderLibraryTable();
                } else {
                    alert("이미 존재하는 프로젝트입니다.");
                }
            }
        });
    }
    
    if (btnRename) {
        btnRename.addEventListener('click', () => {
            const name = prompt("현재 프로젝트 명을 수정합니다:", activeProjectId);
            if (name && name.trim()) {
                const cleanName = name.trim();
                if (cleanName === activeProjectId) return;
                
                const idx = projects.indexOf(activeProjectId);
                if (idx !== -1) {
                    projects[idx] = cleanName;
                    localStorage.setItem('hc_projects', JSON.stringify(projects));
                    
                    datasetLibrary.forEach(async ds => {
                        if (ds.projectName === activeProjectId) {
                            ds.projectName = cleanName;
                            await updateDatasetInDB(ds);
                        }
                    });
                    
                    activeProjectId = cleanName;
                    localStorage.setItem('hc_active_project_id', activeProjectId);
                    populateProjectSelects();
                    renderDatasetLibraryUI();
                    renderLibraryTable();
                }
            }
        });
    }
}

