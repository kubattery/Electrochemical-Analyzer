/* ============================================================================
 * HC-Analyzer  ·  18-cyclability.js   (v4.2.0)
 * 역할: "Cyclability" 독립 탭 — cycle 로 판별된 데이터셋들의 수명 차트 + 지표
 *
 * [주의] 판별 로직은 19-experiment-detector.js 전담입니다. 이 파일은
 *        판별 결과(ExperimentDetector)를 소비만 합니다.
 *        index.html 로드 순서: 19-experiment-detector.js → 18-cyclability.js
 *
 * [설계 원칙]
 *  1. Rate Capability / Cyclability 는 상단 탭에서 각각 독립적으로 진입한다.
 *  2. 표시 대상 데이터셋을 각각 판별(19번)하여:
 *     - rate  로 판별된 셋 → Rate Capability 차트에만 (13-charts.js 가 cycle 셋 제외)
 *     - cycle 로 판별된 셋 → 이 탭의 Cyclability 차트에만
 *     표시 대상이 전부 한쪽 종류면 반대쪽 탭은 잠금 메시지를 표시한다.
 *  3. 차트 형식은 Rate Capability 의 사이클 라인 차트와 동일:
 *     X=Cycle Number, Y=Specific Capacity (mAh/g), 데이터셋 고유 색·이름 사용.
 *     초반 형성(formation) 사이클만 제외하고 "끝까지 전부" Cycle 1부터 재번호.
 *     (데이터마다 총 사이클 수가 달라도 각자 길이에 맞게 유동 표시)
 * ============================================================================ */

(function () {
    "use strict";

    let chartInstance = null;

    const COLOR_CAP = "#60a5fa";
    const COLOR_CE  = "#34d399";

    let canvasEl, metricsEl, detectNoteEl, emptyEl;
    let rateContentEl, cycleContentEl, rateLockedEl, cycleLockedEl, btnPng, btnCsv;

    function grabDom() {
        canvasEl       = document.getElementById("cycChart");
        metricsEl      = document.getElementById("cycMetrics");
        detectNoteEl   = document.getElementById("cycDetectNote");
        emptyEl        = document.getElementById("cycEmpty");
        btnPng         = document.getElementById("cycBtnPng");
        btnCsv         = document.getElementById("cycBtnCsv");
        rateContentEl  = document.getElementById("rateContent");
        cycleContentEl = document.getElementById("cycleContent");
        rateLockedEl   = document.getElementById("rateLockedMsg");
        cycleLockedEl  = document.getElementById("cycleLockedMsg");
    }

    function detector() {
        return (typeof window.ExperimentDetector !== "undefined") ? window.ExperimentDetector : null;
    }

    // ==================================================================
    // 탭별 잠금 라우팅: 표시 대상이 전부 한쪽 종류면 반대쪽 탭 잠금
    // ==================================================================
    function applyRouting(rateCount, cycleCount, total) {
        // Rate Capability 탭: 전부 cycle 데이터면 잠금
        if (rateContentEl && rateLockedEl) {
            if (total > 0 && rateCount === 0) {
                rateContentEl.style.display = "none";
                rateLockedEl.innerHTML =
                    `표시 중인 데이터가 모두 <strong>장기 사이클(Cyclability)</strong> 데이터로 감지되었습니다.<br>` +
                    `상단의 <strong>Cyclability</strong> 탭에서 분석 결과를 확인하세요.`;
                rateLockedEl.style.display = "";
            } else {
                rateContentEl.style.display = "";
                rateLockedEl.style.display = "none";
            }
        }

        // Cyclability 탭: 전부 rate 데이터면 잠금
        if (cycleContentEl && cycleLockedEl) {
            if (total > 0 && cycleCount === 0) {
                cycleContentEl.style.display = "none";
                cycleLockedEl.innerHTML =
                    `표시 중인 데이터가 모두 <strong>율속(Rate capability)</strong> 데이터로 감지되었습니다.<br>` +
                    `상단의 <strong>Rate Capability</strong> 탭에서 분석 결과를 확인하세요.`;
                cycleLockedEl.style.display = "";
            } else {
                cycleContentEl.style.display = "";
                cycleLockedEl.style.display = "none";
            }
        }
    }

    // runAnalysis / 탭 진입 시 진입점: 판별 결과 조회 → 라우팅 → 렌더
    function applyExperimentKind() {
        const d = detector();
        if (!d) return;

        const entries = d.classifyDisplayDatasets();
        const cycleEntries = entries.filter(e => e.det.kind === "cycle");
        const rateEntries  = entries.filter(e => e.det.kind === "rate");

        // 활성 데이터셋 기준 판정 결과를 전역으로 노출 (다른 모듈 참고용)
        const activeDet = (typeof processedCycles !== "undefined") ? d.detect(processedCycles, null) : null;
        window.experimentKind = activeDet ? activeDet.kind : null;

        applyRouting(rateEntries.length, cycleEntries.length, entries.length);
        renderCyclability(cycleEntries);
    }

    // ==================================================================
    // Cyclability 렌더링 — Rate Capability 사이클 라인 차트와 같은 형식
    //   (labels = Cycle Number, 데이터셋별 trace, 고유 색·이름)
    // ==================================================================
    function renderCyclability(cycleEntries) {
        if (!canvasEl) return;
        const d = detector();

        if (!d || !cycleEntries || !cycleEntries.length) {
            if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
            if (emptyEl) emptyEl.style.display = "block";
            if (metricsEl) metricsEl.innerHTML = "";
            if (detectNoteEl) detectNoteEl.style.display = "none";
            return;
        }
        if (emptyEl) emptyEl.style.display = "none";

        const isCompareMode = cycleEntries.length >= 2;
        const showCE = cycleEntries.length === 1;   // CE 축은 단일 데이터셋일 때만 (겹침 방지)

        const chartDatasets = [];
        const noteLines = [];
        const metricRows = [];
        let maxLen = 0;

        cycleEntries.forEach(entry => {
            const all = d.seriesFromProcessed(entry.ds.processedCycles);
            const det = entry.det;
            // 초반 형성(formation)·스파이크와 말기 미완료 사이클만 제외하고 전부 표시
            // — 데이터마다 길이 유동적
            const cut = det.formationCut || 0;
            const tail = det.trailingCut || 0;
            const mainRaw = all.slice(cut, all.length - tail);
            const color = entry.ds.lineColor || entry.ds.color || COLOR_CAP;
            const name = entry.ds.customName || entry.ds.dataName || "Dataset";
            maxLen = Math.max(maxLen, mainRaw.length);

            // rate 차트(13-charts.js)와 동일한 trace 방식: labels 인덱스에 값 배열
            chartDatasets.push({
                label: name,
                data: mainRaw.map(p => p.y),
                origCycles: mainRaw.map(p => p.x),   // 툴팁용 원본 사이클 번호
                yAxisID: "y",
                borderColor: color,
                backgroundColor: color,
                pointBackgroundColor: color,
                pointBorderColor: color,
                pointRadius: 3,
                pointHoverRadius: 6,
                borderWidth: isCompareMode ? 2 : 1.5,
                tension: 0.1
            });

            if (showCE) {
                const ceTrace = mainRaw.map(p => (p.ce != null ? p.ce : null));
                if (ceTrace.some(v => v != null)) {
                    chartDatasets.push({
                        label: "Coulombic Efficiency (%)",
                        data: ceTrace, yAxisID: "y1",
                        borderColor: COLOR_CE, backgroundColor: COLOR_CE, pointBackgroundColor: COLOR_CE,
                        pointStyle: "triangle", pointRadius: 3, pointHoverRadius: 6,
                        borderWidth: 1, tension: 0
                    });
                }
            }

            // 감지 안내 라인
            let line = `<strong style="color:${color};">${name}</strong> — ${det.reason}`;
            if (cut > 0 || tail > 0) {
                const parts = [];
                if (cut > 0) parts.push(`초반 형성/비정상 ${cut}개`);
                if (tail > 0) parts.push(`말기 미완료 ${tail}개`);
                line += ` · ${parts.join("·")} 제외, ${mainRaw.length}사이클(원본 Cycle ${mainRaw[0].x}–${mainRaw[mainRaw.length - 1].x})을 Cycle 1부터 재번호해 표시`;
            } else {
                line += ` · 전체 ${mainRaw.length}사이클 표시`;
            }
            noteLines.push(line);

            // 지표 계산
            const n = mainRaw.length, first = mainRaw[0], last = mainRaw[n - 1];
            const retention = first.y > 0 ? (last.y / first.y) * 100 : null;
            const ceVals = mainRaw.map(p => p.ce).filter(v => v != null);
            const avgCE = ceVals.length ? ceVals.reduce((s, v) => s + v, 0) / ceVals.length : null;
            const fade = (retention != null && n > 1) ? (100 - retention) / (n - 1) : null;
            metricRows.push({ name, color, n, first: first.y, last: last.y, retention, fade, avgCE });
        });

        if (detectNoteEl) {
            detectNoteEl.innerHTML = `판정: <strong style="color:#34d399;">Cyclability 데이터 ${cycleEntries.length}개</strong><br>` + noteLines.join("<br>");
            detectNoteEl.style.display = "block";
        }

        // labels: Cycle 1 ~ 최장 데이터셋 길이 (rate 차트의 합집합 라벨과 같은 개념)
        const labels = Array.from({ length: maxLen }, (_, i) => i + 1);
        const hasCE = showCE && chartDatasets.some(ds => ds.yAxisID === "y1");

        if (chartInstance) chartInstance.destroy();
        chartInstance = new Chart(canvasEl.getContext("2d"), {
            type: "line",
            data: { labels, datasets: chartDatasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 300 },
                interaction: { mode: "nearest", intersect: false },
                scales: {
                    x: {
                        title: { display: true, text: "Cycle Number", color: "#fff" },
                        grid: { color: "rgba(255,255,255,0.05)" },
                        ticks: { color: "#9ca3af" }
                    },
                    y: {
                        title: { display: true, text: "Specific Capacity (mAh/g)", color: "#fff" },
                        grid: { color: "rgba(255,255,255,0.05)" },
                        ticks: { color: "#9ca3af" }
                    },
                    y1: {
                        position: "right", min: 0, max: 105, display: hasCE,
                        title: { display: true, text: "Coulombic Efficiency (%)", color: "#fff" },
                        grid: { drawOnChartArea: false }, ticks: { color: "#9ca3af" }
                    }
                },
                plugins: {
                    legend: {
                        display: isCompareMode || hasCE,
                        labels: { color: "#fff", boxWidth: 14, padding: 10 }
                    },
                    tooltip: {
                        backgroundColor: "rgba(15, 20, 35, 0.95)", borderColor: COLOR_CAP, borderWidth: 1,
                        titleColor: "#fff", bodyColor: "#e5e7eb", padding: 10,
                        callbacks: {
                            title: (items) => `Cycle ${items[0].label}`,
                            label: (item) => item.dataset.yAxisID === "y1"
                                ? `CE ${item.parsed.y.toFixed(2)} %`
                                : `${item.dataset.label}: ${item.parsed.y.toFixed(2)} mAh/g`,
                            afterLabel: (item) => {
                                const oc = item.dataset.origCycles;
                                return (oc && oc[item.dataIndex] != null && item.dataset.yAxisID !== "y1")
                                    ? `원본 Cycle ${oc[item.dataIndex]}` : "";
                            }
                        }
                    }
                }
            }
        });

        renderMetrics(metricRows);
    }

    // 지표 표시: 데이터셋 1개면 카드 6장, 여러 개면 비교 테이블
    function renderMetrics(rows) {
        if (!metricsEl) return;
        if (!rows.length) { metricsEl.innerHTML = ""; return; }

        if (rows.length === 1) {
            const r = rows[0];
            const cards = [
                { label: "사이클 수", value: `${r.n}`, unit: "cycles" },
                { label: "초기 용량 (Cyc 1)", value: r.first.toFixed(1), unit: "mAh/g" },
                { label: `최종 용량 (Cyc ${r.n})`, value: r.last.toFixed(1), unit: "mAh/g" },
                { label: "용량 유지율", value: r.retention != null ? r.retention.toFixed(1) : "-", unit: "%" },
                { label: "사이클당 감쇠율", value: r.fade != null ? r.fade.toFixed(3) : "-", unit: "%/cyc" },
                { label: "평균 쿨롱효율", value: r.avgCE != null ? r.avgCE.toFixed(2) : "-", unit: "%" }
            ];
            metricsEl.style.display = "grid";
            metricsEl.innerHTML = cards.map(c => `
                <div class="cyc-metric-card">
                    <div class="cyc-metric-label">${c.label}</div>
                    <div class="cyc-metric-value">${c.value}<span class="cyc-metric-unit">${c.unit}</span></div>
                </div>`).join("");
            return;
        }

        // 여러 데이터셋: 비교 테이블
        metricsEl.style.display = "block";
        metricsEl.innerHTML = `
            <div class="table-container">
                <table class="academic-table">
                    <thead>
                        <tr>
                            <th>데이터셋</th><th>사이클 수</th><th>초기 용량<br>(mAh/g)</th>
                            <th>최종 용량<br>(mAh/g)</th><th>용량 유지율<br>(%)</th>
                            <th>감쇠율<br>(%/cyc)</th><th>평균 CE<br>(%)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(r => `
                        <tr>
                            <td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${r.color};margin-right:6px;vertical-align:middle;"></span>${r.name}</td>
                            <td>${r.n}</td>
                            <td>${r.first.toFixed(1)}</td>
                            <td>${r.last.toFixed(1)}</td>
                            <td>${r.retention != null ? r.retention.toFixed(1) : "-"}</td>
                            <td>${r.fade != null ? r.fade.toFixed(3) : "-"}</td>
                            <td>${r.avgCE != null ? r.avgCE.toFixed(2) : "-"}</td>
                        </tr>`).join("")}
                    </tbody>
                </table>
            </div>`;
    }

    // ==================================================================
    // 내보내기
    // ==================================================================
    function downloadPng() {
        if (!chartInstance) return;
        const a = document.createElement("a");
        a.href = chartInstance.toBase64Image("image/png", 1);
        a.download = "cyclability_cycle.png";
        a.click();
    }

    function downloadCsv() {
        const d = detector();
        if (!d) return;
        const cycleEntries = d.classifyDisplayDatasets().filter(e => e.det.kind === "cycle");
        if (!cycleEntries.length) return;

        let csv = "Dataset,Cycle Number,Original Cycle,Specific Capacity (mAh/g),Coulombic Efficiency (%)\n";
        cycleEntries.forEach(entry => {
            const all = d.seriesFromProcessed(entry.ds.processedCycles);
            const cut = entry.det.formationCut || 0;
            const tail = entry.det.trailingCut || 0;
            const pts = all.slice(cut, all.length - tail);   // 차트와 동일한 구간
            const name = (entry.ds.customName || "Dataset").replace(/,/g, " ");
            pts.forEach((p, i) => { csv += `${name},${i + 1},${p.x},${p.y},${p.ce != null ? p.ce : ""}\n`; });
        });

        const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "cyclability_cycle.csv";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function init() {
        grabDom();
        if (btnPng) btnPng.addEventListener("click", downloadPng);
        if (btnCsv) btnCsv.addEventListener("click", downloadCsv);
    }

    window.refreshCyclabilityIfActive = function () {
        applyExperimentKind();
    };

    // Cyclability 탭 진입 시 차트 리사이즈 (탭이 숨겨진 상태에서 렌더된 경우 대비)
    window.resizeCyclabilityChart = function () {
        if (chartInstance) chartInstance.resize();
    };

    document.addEventListener("DOMContentLoaded", init);
})();
