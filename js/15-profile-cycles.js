/* ============================================================================
 * HC-Analyzer  ·  15-profile-cycles.js
 * 역할: 분석 모드 설정 · 전압 프로파일 사이클 다중 선택 UI
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 15/15  (이전: js/14-export.js → 다음: (없음))
 * ============================================================================ */
/* ============================================================
   GITT 분석 연산, 이벤트 바인딩 및 시각화 엔진
   ============================================================ */
/* ============================================================
   메인 분석 모드 (일반 성능 분석 전용 stub) 제어
   ============================================================ */
function setAnalysisMode(mode = 'general') {
    currentAnalysisMode = 'general';
    isGittMode = false;
    
    if (rateConfigPanel) rateConfigPanel.style.display = 'block';
    
    const gittConfigPanel = document.getElementById('gittConfigPanel');
    if (gittConfigPanel) gittConfigPanel.style.display = 'none';
    
    renderDatasetLibraryUI();
}

// 전압 프로파일 사이클 칩 드래그 및 범위 선택 상태 제어 변수
let lastClickedProfileCycleIdx = -1;
let isProfileDragSelecting = false;
let profileDragMode = 'select';

// 드래그 해제 글로벌 리스너 등록
document.addEventListener('pointerup', () => {
    if (isProfileDragSelecting) {
        isProfileDragSelecting = false;
        document.body.classList.remove('drag-select-active');
        // 마우스 드래그가 끝난 시점에 한 번에 드로잉 렌더링을 적용하여 대단히 쾌적하게 렉을 방지함
        updateProfileCycleSummary();
        updateProfileView();
    }
});

/**
 * 전압 프로파일 탭 내 다중 사이클 선택 칩 목록을 렌더링하고 이벤트를 바인딩합니다.
 * (드래그 연속 선택 및 Shift 범위 토글 선택 인터랙션을 완벽하게 구현합니다)
 */
function renderProfileCycleChipsUI() {
    if (!profileCycleChipsContainer) return;
    profileCycleChipsContainer.innerHTML = '';

    const cycles = getProfileAvailableCycles();
    if (cycles.length === 0) {
        profileCycleChipsContainer.innerHTML = '<span style="font-size:11px; color:var(--text-muted);">사이클 데이터가 없습니다.</span>';
        updateProfileCycleSummary();
        return;
    }

    // 상태 유효성 보정
    selectedProfileCycles = selectedProfileCycles.filter(c => cycles.includes(c));
    if (selectedProfileCycles.length === 0 && !isProfileCycleAll) {
        selectedProfileCycles = [cycles[0]];
    }

    // "전체" 퀵 버튼 상태 클래스 업데이트
    if (btnProfileCycleAll) {
        if (isProfileCycleAll) {
            btnProfileCycleAll.classList.add('active');
        } else {
            btnProfileCycleAll.classList.remove('active');
        }
    }

    cycles.forEach((cNum, idx) => {
        const chip = document.createElement('div');
        const isActive = !isProfileCycleAll && selectedProfileCycles.includes(cNum);
        chip.className = `cycle-chip${isActive ? ' active' : ''}`;
        chip.textContent = `${cNum}C`;
        chip.title = `${cNum} Cycle`;

        // 드래그 중 텍스트 선택 파란 블록 방지
        chip.style.userSelect = 'none';

        // 1. Pointer Down (드래그 시작 및 Shift 키 분기)
        chip.addEventListener('pointerdown', (e) => {
            chip.releasePointerCapture(e.pointerId); // 브라우저 자체 드래그 캡처 버그 우회
            isProfileCycleAll = false;

            // Shift+클릭 범위 일괄 선택 구현
            if (e.shiftKey && lastClickedProfileCycleIdx !== -1) {
                const startIdx = Math.min(lastClickedProfileCycleIdx, idx);
                const endIdx = Math.max(lastClickedProfileCycleIdx, idx);
                
                for (let i = startIdx; i <= endIdx; i++) {
                    const targetCNum = cycles[i];
                    if (!selectedProfileCycles.includes(targetCNum)) {
                        selectedProfileCycles.push(targetCNum);
                    }
                }
                selectedProfileCycles.sort((a, b) => a - b);
                lastClickedProfileCycleIdx = idx;

                renderProfileCycleChipsUI();
                updateProfileCycleSummary();
                updateProfileView();
                return;
            }

            // 일반 드래그 선택 모드 결정
            isProfileDragSelecting = true;
            profileDragMode = isActive ? 'deselect' : 'select';
            document.body.classList.add('drag-select-active');

            // 토글 선택 기동
            toggleCycleSelection(cNum, cycles);
            lastClickedProfileCycleIdx = idx;

            renderProfileCycleChipsUI();
            updateProfileCycleSummary();
            // 단일 클릭에서도 즉시 차트 갱신 (pointerup에만 의존하면 누락 가능)
            updateProfileView();
        });

        // 2. Pointer Enter (마우스 드래그 중인 상태로 다른 칩에 진입 시 연속 조작)
        chip.addEventListener('pointerenter', (e) => {
            // 마우스 버튼 미누름 상태이면 드래그가 아님 (단순 호버) → 즉시 종료
            if (e.buttons !== 1) return;
            if (!isProfileDragSelecting) return;

            if (profileDragMode === 'select') {
                if (!selectedProfileCycles.includes(cNum)) {
                    selectedProfileCycles.push(cNum);
                    selectedProfileCycles.sort((a, b) => a - b);
                }
            } else {
                // deselect 모드: 단 하나 남았을 때는 완전히 지워지는 것 방어
                if (selectedProfileCycles.length > 1) {
                    const index = selectedProfileCycles.indexOf(cNum);
                    if (index > -1) {
                        selectedProfileCycles.splice(index, 1);
                    }
                }
            }

            renderProfileCycleChipsUI();
            updateProfileCycleSummary();
        });

        profileCycleChipsContainer.appendChild(chip);
    });

    // 상단 캡션 텍스트 갱신
    updateProfileCycleSummary();
}

/**
 * 칩 단위 토글 선택 유틸리티 (최소 1개 선택 보호막 작동)
 */
function toggleCycleSelection(cNum, cycles) {
    const index = selectedProfileCycles.indexOf(cNum);
    if (index > -1) {
        if (selectedProfileCycles.length > 1) {
            selectedProfileCycles.splice(index, 1);
        }
    } else {
        selectedProfileCycles.push(cNum);
        selectedProfileCycles.sort((a, b) => a - b);
    }
}

/**
 * 사이클 요약 버튼/텍스트 라벨을 선택 상태에 맞게 실시간 갱신합니다.
 */
function updateProfileCycleSummary() {
    const summarySpan = document.getElementById('profileCycleSummary');
    if (!summarySpan) return;

    if (isProfileCycleAll) {
        summarySpan.textContent = "전체 사이클";
        return;
    }

    const len = selectedProfileCycles.length;
    if (len === 0) {
        summarySpan.textContent = "선택 없음";
        return;
    }

    if (len === 1) {
        summarySpan.textContent = `${selectedProfileCycles[0]} Cycle`;
    } else if (len <= 3) {
        summarySpan.textContent = `${selectedProfileCycles.join(', ')} Cycle (${len}개)`;
    } else {
        summarySpan.textContent = `${selectedProfileCycles.slice(0, 3).join(', ')} 외 ${len - 3}개`;
    }
}

/**
 * 전압 프로파일용 가용 사이클 리스트 합집합 추출 헬퍼 함수
 */
function getProfileAvailableCycles() {
    const checkedDS = getCheckedDatasets();
    const isCompareMode = checkedDS.length >= 2;
    const displayDS = isCompareMode ? checkedDS : datasetLibrary.filter(d => d.id === activeDatasetId);
    
    const union = new Set();
    displayDS.forEach(ds => {
        if (ds.processedCycles) {
            Object.keys(ds.processedCycles).forEach(k => union.add(Number(k)));
        }
    });
    return Array.from(union).sort((a, b) => a - b);
}

/**
 * 전압 프로파일용 뷰/차트 갱신 트리거
 */
function updateProfileView() {
    if (hasActiveDataset()) {
        runAnalysis();
    }
}

/**
 * 전압 프로파일 퀵 버튼 액션 필터 바인딩
 */
function initProfileCycleQuickActions() {
    // 1. 드롭다운 토글 버튼 클릭 처리 (ID 기반으로 확실하게 탐색)
    const toggleBtn = document.getElementById('btnProfileCycleDropdown');
    const panel = document.getElementById('profileCycleDropdownPanel');
    const container = toggleBtn ? toggleBtn.closest('.profile-dropdown-container') : null;
    
    if (toggleBtn && container) {
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = container.classList.contains('open');
            container.classList.toggle('open', !isOpen);
        });
    }

    // 2. 바깥 영역 클릭 시 드롭다운 닫기 (Outside Click)
    document.addEventListener('click', (e) => {
        if (container && container.classList.contains('open')) {
            if (!container.contains(e.target)) {
                container.classList.remove('open');
            }
        }
    });

    if (btnProfileCycleAll) {
        btnProfileCycleAll.onclick = () => {
            isProfileCycleAll = true;
            selectedProfileCycles = [];
            
            if (targetCycleSelect) {
                targetCycleSelect.value = 'all';
            }
            
            renderProfileCycleChipsUI();
            updateProfileView();
        };
    }

    if (btnProfileCycleClear) {
        btnProfileCycleClear.onclick = () => {
            isProfileCycleAll = false;
            const cycles = getProfileAvailableCycles();
            if (cycles.length > 0) {
                selectedProfileCycles = [cycles[0]];
                
                if (targetCycleSelect) {
                    targetCycleSelect.value = cycles[0].toString();
                }
            }
            renderProfileCycleChipsUI();
            updateProfileView();
        };
    }

    if (btnProfileCycleOdd) {
        btnProfileCycleOdd.onclick = () => {
            isProfileCycleAll = false;
            const cycles = getProfileAvailableCycles();
            selectedProfileCycles = cycles.filter(c => c % 2 !== 0);
            if (selectedProfileCycles.length === 0 && cycles.length > 0) {
                selectedProfileCycles = [cycles[0]];
            }
            
            if (targetCycleSelect && selectedProfileCycles.length > 0) {
                targetCycleSelect.value = selectedProfileCycles[0].toString();
            }
            
            renderProfileCycleChipsUI();
            updateProfileView();
        };
    }

    if (btnProfileCycleEven) {
        btnProfileCycleEven.onclick = () => {
            isProfileCycleAll = false;
            const cycles = getProfileAvailableCycles();
            selectedProfileCycles = cycles.filter(c => c % 2 === 0);
            if (selectedProfileCycles.length === 0 && cycles.length > 0) {
                selectedProfileCycles = [cycles[0]];
            }
            
            if (targetCycleSelect && selectedProfileCycles.length > 0) {
                targetCycleSelect.value = selectedProfileCycles[0].toString();
            }
            
            renderProfileCycleChipsUI();
            updateProfileView();
        };
    }
}