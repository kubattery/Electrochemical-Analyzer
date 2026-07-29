/* ============================================================================
 * HC-Analyzer  ·  03-analysis-controls.js
 * 역할: 분석 컨트롤 패널 이벤트 바인딩 · C-rate 모드 토글
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 03/15  (이전: js/02-file-upload.js → 다음: js/04-database.js)
 * ============================================================================ */
// Analysis UI control updates
function initAnalysisControls() {
    cutoffVoltageInput.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value).toFixed(2);
        cutoffValDisplay.textContent = `${val} V`;
        if (hasActiveDataset()) {
            runAnalysis();
        }
    });

    targetCycleSelect.addEventListener('change', () => {
        if (hasActiveDataset()) {
            const val = targetCycleSelect.value;
            if (val === 'all') {
                isProfileCycleAll = true;
                selectedProfileCycles = [];
            } else {
                isProfileCycleAll = false;
                const cNum = parseInt(val);
                if (!isNaN(cNum)) {
                    selectedProfileCycles = [cNum];
                }
            }
            renderProfileCycleChipsUI();
            runAnalysis();
        }
    });

    if (targetDirectionProfile) {
        targetDirectionProfile.addEventListener('change', () => {
            if (hasActiveDataset()) {
                renderOverviewChart(null, false);
            }
        });
    }

    // 전압 프로파일 퀵 버튼 액션 바인딩
    initProfileCycleQuickActions();

    if (targetCycleSelectSP) {
        targetCycleSelectSP.addEventListener('change', () => {
            if (hasActiveDataset()) {
                runAnalysis();
            }
        });
    }

    if (targetCycleDqDv) {
        targetCycleDqDv.addEventListener('change', () => {
            const val = targetCycleDqDv.value;
            const cNum = parseInt(val);
            if (!isNaN(cNum) && !selectedDqDvCycles.includes(cNum)) {
                selectedDqDvCycles = [cNum];
                renderCycleChipsUI();
            }
            if (hasActiveDataset()) {
                updateDqDvView();
            }
        });
    }

    // 다중 사이클 퀵 필터 바인딩
    initCycleQuickActions();
    initDqDvCycleDropdown();


    if (selectDqDvMode) {
        selectDqDvMode.addEventListener('change', () => {
            if (hasActiveDataset()) {
                updateDqDvView();
            }
        });
    }

    if (dqdvStepV) {
        dqdvStepV.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (dqdvStepVVal) {
                dqdvStepVVal.textContent = `${Math.round(val * 1000)} mV`;
            }
            if (hasActiveDataset()) {
                updateDqDvView();
            }
        });
    }

    if (dqdvQo) {
        dqdvQo.addEventListener('input', () => {
            if (hasActiveDataset()) {
                updateDqDvView();
            }
        });
    }

    if (dqdvMass) {
        dqdvMass.addEventListener('input', async () => {
            const val = parseFloat(dqdvMass.value);
            if (!isNaN(val) && val > 0 && activeDatasetId) {
                const ds = datasetLibrary.find(d => d.id === activeDatasetId);
                if (ds) {
                    ds.mass = val;
                    // 사이드바 UI의 질량 인풋값도 실시간 동기화하기 위해 라이브러리 UI 재렌더링
                    renderDatasetLibraryUI();
                    await updateDatasetInDB(ds);
                }
            }
            if (hasActiveDataset()) {
                updateDqDvView();
            }
        });
    }

    if (dqdvPostAvg) {
        dqdvPostAvg.addEventListener('input', () => {
            if (hasActiveDataset()) {
                updateDqDvView();
            }
        });
    }


    // C-rate 분석 단위 설정 변경 리스너
    const rateStepSizeSelect = document.getElementById('rateStepSize');
    if (rateStepSizeSelect) {
        rateStepSizeSelect.addEventListener('change', () => {
            if (hasActiveDataset()) {
                runAnalysis();
            }
        });
    }

    // 율속 단계 라벨 직접 입력 변경 리스너
    const rateStepsInput = document.getElementById('rateStepsInput');
    if (rateStepsInput) {
        rateStepsInput.addEventListener('change', () => {
            if (hasActiveDataset()) {
                runAnalysis();
            }
        });
    }

    // 측정 단위 토글 (C-rate / mA/g) 이벤트 바인딩
    const rateUnitToggle = document.getElementById('rateUnitToggle');
    if (rateUnitToggle) {
        rateUnitToggle.addEventListener('click', (e) => {
            const btn = e.target.closest('.rate-unit-btn');
            if (!btn) return;

            // 버튼 active 상태 전환
            rateUnitToggle.querySelectorAll('.rate-unit-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // 입력 필드 플레이스홀더 및 라벨 업데이트
            const unit = btn.dataset.unit;
            const labelEl = document.getElementById('rateStepsLabel');
            const inputEl = document.getElementById('rateStepsInput');

            if (unit === 'mag') {
                if (labelEl) labelEl.textContent = '단계별 mA/g 값';
                if (inputEl) {
                    inputEl.placeholder = '예: 25, 50, 100, 200...';
                    // 기본값이 C-rate 형식이면 mA/g 기본값으로 교체 안내
                    if (inputEl.value.trim() === '0.1, 0.2, 0.5, 1, 2, 5, 10, 0.1') {
                        inputEl.value = '25, 50, 100, 200, 500, 1000, 2500, 25';
                    }
                }
            } else {
                if (labelEl) labelEl.textContent = '단계별 C-rate 값';
                if (inputEl) {
                    inputEl.placeholder = '예: 0.1, 0.2, 0.5, 1, 2...';
                    if (inputEl.value.trim() === '25, 50, 100, 200, 500, 1000, 2500, 25') {
                        inputEl.value = '0.1, 0.2, 0.5, 1, 2, 5, 10, 0.1';
                    }
                }
            }

            if (hasActiveDataset()) {
                runAnalysis();
            }
        });
    }
}

// C-rate 충방전 용량 모드 전환 초기화
function initRateToggle() {
    const selectRateMode = document.getElementById('selectRateMode');
    if (selectRateMode) {
        selectRateMode.addEventListener('change', (e) => {
            currentRateMode = e.target.value;
            updateRateCapabilityView();
        });
    }
}

// C-rate 탭 뷰 텍스트 및 그래프 모드 갱신
function updateRateCapabilityView() {
    const cycleTitle = document.getElementById('rateCyclesChartTitle');
    const selectRateMode = document.getElementById('selectRateMode');
    
    if (selectRateMode) {
        selectRateMode.value = currentRateMode;
    }
    
    if (currentRateMode === 'charge') {
        if (cycleTitle) cycleTitle.textContent = "사이클 경과에 따른 C-rate별 충전 용량";
    } else {
        if (cycleTitle) cycleTitle.textContent = "사이클 경과에 따른 C-rate별 방전 용량";
    }
    
    if (hasActiveDataset()) {
        calculateRateCapability();
        renderRateCapabilityCharts();
    }
}

