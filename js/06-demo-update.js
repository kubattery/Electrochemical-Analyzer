/* ============================================================================
 * HC-Analyzer  ·  06-demo-update.js
 * 역할: 데모 데이터 생성 · 데이터 업데이트/실패 시뮬레이션
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 06/15  (이전: js/05-dataset-helpers.js → 다음: js/07-projects.js)
 * ============================================================================ */
/**
 * 데모용 Mock 데이터 생성기
 */
function generateDemoDatasets() {
    const demoDatasets = [];
    const baseTime = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    
    // 1. Rate 데이터셋
    const dsRate = {
        id: "demo_rate_" + Date.now(),
        projectName: activeProjectId,
        experimentType: "rate",
        dataName: "Demo_Rate_Test",
        customName: "Demo_Rate_Test",
        sampleName: "Demo_Anode_A",
        filename: "demo_rate.csv",
        uploadedAt: baseTime,
        lastConvertedAt: baseTime,
        conversionStatus: "converted",
        keyMetric: "ICE: 82.5%",
        totalCycles: 40,
        ice: "82.5",
        compareEnabled: true,
        isDemo: true,
        mass: 2.5,
        processedCycles: {
            1: {
                sodiation: [
                    { voltage: 1.2, capacity: 0, current: -0.1 },
                    { voltage: 0.5, capacity: 150, current: -0.1 },
                    { voltage: 0.01, capacity: 300, current: -0.1 }
                ],
                desodiation: [
                    { voltage: 0.01, capacity: 0, current: 0.1 },
                    { voltage: 0.2, capacity: 120, current: 0.1 },
                    { voltage: 1.5, capacity: 250, current: 0.1 }
                ],
                totalDischargeCap: 300,
                totalChargeCap: 250
            }
        }
    };
    normalizeDataset(dsRate);
    demoDatasets.push(dsRate);

    // 2. Cycle performance 데이터셋
    const dsCycle = {
        id: "demo_cycle_" + (Date.now() + 1),
        projectName: activeProjectId,
        experimentType: "cycle_performance",
        dataName: "Demo_Long_Cycle",
        customName: "Demo_Long_Cycle",
        sampleName: "Demo_Anode_A",
        filename: "demo_cycle.xlsx",
        uploadedAt: baseTime,
        lastConvertedAt: baseTime,
        conversionStatus: "converted",
        keyMetric: "Retention: 92%",
        totalCycles: 100,
        ice: "80.1",
        compareEnabled: true,
        isDemo: true,
        mass: 2.5,
        processedCycles: {
            1: {
                sodiation: [
                    { voltage: 1.2, capacity: 0, current: -0.1 },
                    { voltage: 0.01, capacity: 280, current: -0.1 }
                ],
                desodiation: [
                    { voltage: 0.01, capacity: 0, current: 0.1 },
                    { voltage: 1.5, capacity: 220, current: 0.1 }
                ],
                totalDischargeCap: 280,
                totalChargeCap: 220
            }
        }
    };
    normalizeDataset(dsCycle);
    demoDatasets.push(dsCycle);

    // 3. GITT 데이터셋
    const dsGitt = {
        id: "demo_gitt_" + (Date.now() + 2),
        projectName: activeProjectId,
        experimentType: "gitt",
        dataName: "Demo_GITT_Diffusion",
        customName: "Demo_GITT_Diffusion",
        sampleName: "Demo_Anode_A",
        filename: "demo_gitt.txt",
        uploadedAt: baseTime,
        lastConvertedAt: baseTime,
        conversionStatus: "converted",
        keyMetric: "D_Na: ~10^-11 cm^2/s",
        totalCycles: 1,
        ice: "-",
        compareEnabled: true,
        isDemo: true,
        mass: 2.5,
        processedCycles: {
            1: {
                sodiation: [
                    { voltage: 1.0, capacity: 50, current: -0.05 },
                    { voltage: 0.1, capacity: 150, current: -0.05 }
                ],
                desodiation: [
                    { voltage: 0.1, capacity: 50, current: 0.05 },
                    { voltage: 1.0, capacity: 140, current: 0.05 }
                ],
                totalDischargeCap: 150,
                totalChargeCap: 140
            }
        }
    };
    normalizeDataset(dsGitt);
    demoDatasets.push(dsGitt);

    // 4. CV 데이터셋
    const dsCv = {
        id: "demo_cv_" + (Date.now() + 3),
        projectName: activeProjectId,
        experimentType: "cv",
        dataName: "Demo_CV_Scan",
        customName: "Demo_CV_Scan",
        sampleName: "Demo_Anode_A_CV",
        filename: "demo_cv.csv",
        uploadedAt: baseTime,
        lastConvertedAt: baseTime,
        conversionStatus: "converted",
        keyMetric: "Peak Curr: 1.2mA",
        totalCycles: 5,
        ice: "-",
        compareEnabled: true,
        isDemo: true,
        mass: 2.5,
        processedCycles: {
            1: {
                sodiation: [
                    { voltage: 1.5, capacity: 10, current: -0.2 },
                    { voltage: 0.01, capacity: 80, current: -0.2 }
                ],
                desodiation: [
                    { voltage: 0.01, capacity: 10, current: 0.2 },
                    { voltage: 1.5, capacity: 75, current: 0.2 }
                ],
                totalDischargeCap: 80,
                totalChargeCap: 75
            }
        }
    };
    normalizeDataset(dsCv);
    demoDatasets.push(dsCv);

    return demoDatasets;
}

/**
 * 데모 모드 주입
 */
function initDemoMode() {
    const btn = document.getElementById('btnEnableDemoMode');
    if (!btn) return;
    
    btn.addEventListener('click', async () => {
        const demos = generateDemoDatasets();
        for (const ds of demos) {
            datasetLibrary.push(ds);
            await saveDatasetToDB(ds);
        }
        
        renderDatasetLibraryUI();
        renderLibraryTable();
        
        // 첫 번째 데모 데이터를 활성화
        switchActiveDataset(demos[0].id);
        alert("데모 데이터셋 4개가 주입되었습니다 (isDemo: true).");
    });
}

