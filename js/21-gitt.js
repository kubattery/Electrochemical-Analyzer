/* ============================================================================
 * HC-Analyzer  ·  js/21-gitt.js   (GITT 분석 · 독립 모듈 · v1.0.0)
 *
 * 역할: GITT 파일(시간/전압)을 GITT 탭에서 업로드 → 전압-시간 곡선에서
 *       펄스·완화 구간을 "자동 감지" → 펄스별 확산계수 D 계산(Weppner–Huggins).
 *       왼쪽 차트: 시간(x) - 전압(y) 프로파일
 *       오른쪽 차트: 전압 E_eq(x) - log₁₀ D_Li⁺(y)
 *
 * [자동 감지 원리 — 특정 파일 형식에 하드코딩하지 않음]
 *  1. 시간·전압 컬럼을 헤더에서 자동 탐색 (시간/time, 전압/voltage/potential)
 *  2. 시간 문자열("일:시:분:초.ms" / "시:분:초" / 숫자 초)을 자동 판별해 초로 변환
 *  3. 연속 점 사이 |ΔV| 분포에서 적응 임계값을 구해 IR 점프(구간 경계) 검출
 *  4. 구간 지속시간을 클러스터링 → 최다 빈도 2개 클러스터 중
 *     짧은 쪽 = 펄스, 긴 쪽 = 완화(rest) 로 자동 판정 (τ는 펄스별 실측값 사용)
 *  5. "완화 구간 바로 앞의 비(非)완화 구간" = GITT 펄스로 채택.
 *     formation 등 장시간 CC 구간과 그 부속 휴지는 자동 제외.
 *
 * 기존 충방전/CV/AI 해석 코드는 건드리지 않음. 엑셀 파싱은 js/xlsx-worker.js 재사용.
 * ============================================================================ */
(function () {
    'use strict';

    var gittPoints = [];        // [{t(초), v(V)}]
    var gittSegments = [];      // 감지된 구간 목록
    var gittPulses = [];        // 유효 펄스 결과
    var gittTrimT = null;       // formation 제외: 이 시각(초) 이전 데이터는 표시하지 않음
    var gittViewMin = null;     // 프로파일 x축 구간 보기 시작 (h, formation 제외 후 기준)
    var gittViewMax = null;     // 프로파일 x축 구간 보기 끝 (h)
    var gittFilename = '';
    var gittWorker = null, gittJob = 0;
    var chartProfile = null, chartDiffusion = null;

    function $(id) { return document.getElementById(id); }
    function setStatus(msg) { var el = $('gittStatus'); if (el) el.textContent = msg; }

    // ==================================================================
    // 탭 활성화 (CV 탭과 동일한 방식: data-tab 없이 자체 처리)
    // ==================================================================
    function activateGittTab() {
        var i, els;
        els = document.querySelectorAll('.tab-btn'); for (i = 0; i < els.length; i++) els[i].classList.remove('active');
        els = document.querySelectorAll('.tab-panel'); for (i = 0; i < els.length; i++) els[i].classList.remove('active');
        var btn = $('btnTabGitt'), panel = $('tab-gitt');
        if (btn) btn.classList.add('active');
        if (panel) panel.classList.add('active');
        setTimeout(function () {
            if (chartProfile) chartProfile.resize();
            if (chartDiffusion) chartDiffusion.resize();
        }, 60);
    }

    // ==================================================================
    // 1. 파일 로드 & 파싱
    // ==================================================================
    function onGittFile(file) {
        if (!file) return;
        setStatus('불러오는 중... (' + file.name + ') — 대용량 파일은 수십 초 걸릴 수 있습니다.');
        var ext = (file.name.split('.').pop() || '').toLowerCase();
        var reader = new FileReader();
        if (ext === 'xlsx' || ext === 'xls') {
            reader.onload = function (e) { parseXlsxInWorker(e.target.result, file.name); };
            reader.onerror = function () { setStatus('파일 읽기 실패'); };
            reader.readAsArrayBuffer(file);
        } else {
            reader.onload = function (e) { parseDelimitedText(e.target.result, file.name); };
            reader.onerror = function () { setStatus('파일 읽기 실패'); };
            reader.readAsText(file);
        }
    }

    function parseXlsxInWorker(buf, filename) {
        try { if (!gittWorker) gittWorker = new Worker('js/xlsx-worker.js?v=4.3.0'); }
        catch (err) { setStatus('워커 생성 실패: ' + err); return; }
        var id = ++gittJob;
        var onMsg = function (ev) {
            if (!ev.data || ev.data.id !== id) return;
            gittWorker.removeEventListener('message', onMsg);
            if (ev.data.ok && ev.data.jsonData) ingestGittRows(ev.data.jsonData, filename);
            else setStatus('엑셀 파싱 실패: ' + (ev.data.error || ''));
        };
        gittWorker.addEventListener('message', onMsg);
        gittWorker.onerror = function (er) { setStatus('워커 오류: ' + ((er && er.message) || '')); };
        try { gittWorker.postMessage({ id: id, data: buf, filename: filename }, [buf]); }
        catch (e) { gittWorker.postMessage({ id: id, data: buf, filename: filename }); }
    }

    function parseDelimitedText(text, filename) {
        var lines = text.split(/\r?\n/), rows = [];
        for (var k = 0; k < lines.length; k++) {
            var line = lines[k];
            if (line == null || line.trim() === '') continue;
            var delim = line.indexOf('\t') >= 0 ? '\t' : (line.indexOf(';') >= 0 ? ';' : ',');
            rows.push(line.split(delim));
        }
        ingestGittRows(rows, filename);
    }

    // 시간 값 자동 판별: 숫자(초) / "일:시:분:초(.ms)" / "시:분:초(.ms)"
    function parseTimeValue(val) {
        if (typeof val === 'number') return val;
        var s = String(val == null ? '' : val).trim();
        if (s === '') return NaN;
        var parts = s.split(':');
        if (parts.length === 4) {
            return (+parts[0]) * 86400 + (+parts[1]) * 3600 + (+parts[2]) * 60 + parseFloat(parts[3]);
        }
        if (parts.length === 3) {
            return (+parts[0]) * 3600 + (+parts[1]) * 60 + parseFloat(parts[2]);
        }
        var f = parseFloat(s);
        return isNaN(f) ? NaN : f;
    }

    function ingestGittRows(rows, filename) {
        if (!rows || rows.length < 10) { setStatus('데이터가 비어 있거나 너무 짧습니다.'); return; }

        // 헤더 행에서 시간/전압 컬럼 자동 탐색
        var headerIdx = -1, tCol = -1, vCol = -1;
        for (var r = 0; r < Math.min(30, rows.length); r++) {
            var row = rows[r]; if (!row) continue;
            var tc = -1, vc = -1;
            for (var c = 0; c < row.length; c++) {
                var s = String(row[c] == null ? '' : row[c]).toLowerCase().trim();
                if (s === '') continue;
                if (tc < 0 && (s.indexOf('시간') >= 0 || s.indexOf('time') >= 0)) tc = c;
                if (vc < 0 && s.indexOf('aux') < 0 &&
                    (s.indexOf('전압') >= 0 || s.indexOf('voltage') >= 0 || s.indexOf('potential') >= 0 || s === 'v')) vc = c;
            }
            if (tc >= 0 && vc >= 0) { headerIdx = r; tCol = tc; vCol = vc; break; }
        }
        if (tCol < 0 || vCol < 0) {
            setStatus('시간/전압 컬럼을 찾지 못했습니다. 헤더에 "시간(time)"과 "전압(voltage)" 컬럼이 필요합니다.');
            return;
        }

        var pts = [];
        for (var i = headerIdx + 1; i < rows.length; i++) {
            var row2 = rows[i]; if (!row2) continue;
            var t = parseTimeValue(row2[tCol]);
            var v = parseFloat(row2[vCol]);
            if (isNaN(t) || isNaN(v)) continue;
            pts.push({ t: t, v: v });
        }
        if (pts.length < 100) { setStatus('유효한 데이터 행이 부족합니다. (' + pts.length + '행)'); return; }
        pts.sort(function (a, b) { return a.t - b.t; });

        gittPoints = pts;
        gittFilename = filename;
        setStatus('구간 감지 중... (' + pts.length.toLocaleString() + ' 포인트)');

        // 파싱 직후 UI가 멈추지 않도록 감지는 다음 틱에서 수행
        setTimeout(function () { detectAndAnalyze(); }, 30);
    }

    // ==================================================================
    // 2. 구간(세그먼트) 자동 감지
    // ==================================================================
    function segmentWithThreshold(pts, TH) {
        var n = pts.length, i;
        var segs = [];
        var start = 0;
        for (i = 1; i < n; i++) {
            if (Math.abs(pts[i].v - pts[i - 1].v) > TH) {
                if (i - 1 > start) segs.push(makeSeg(pts, start, i - 1));
                start = i;
            }
        }
        segs.push(makeSeg(pts, start, n - 1));
        // 전이 구간의 계단형 잔여 조각(30초 미만)은 제거
        return segs.filter(function (s) { return s.dur >= 30; });
    }

    function detectSegments(pts) {
        var n = pts.length, i;

        // 연속 점 |ΔV| 의 중앙값(노이즈 수준) 산출
        var dvs = new Float64Array(n - 1);
        for (i = 1; i < n; i++) dvs[i - 1] = Math.abs(pts[i].v - pts[i - 1].v);
        var sorted = Float64Array.from(dvs).sort();
        var median = sorted[Math.floor(sorted.length * 0.5)];
        var noiseFloor = Math.max(median, 1e-5);

        // 임계값 후보를 시험하여 "규칙 패턴 점수"(상위 2개 지속시간 클러스터의
        // 구간 수 합)가 최대가 되는 임계값을 자동 선택.
        // → 파일마다 노이즈·IR 점프 크기가 달라도 스스로 최적화 (하드코딩 없음)
        var factors = [4, 6, 8, 12, 16, 24, 32, 48, 64];
        var best = null;
        for (var f = 0; f < factors.length; f++) {
            var TH = Math.max(noiseFloor * factors[f], 0.0008);
            if (best && Math.abs(TH - best.TH) < 1e-9) continue;
            var segs = segmentWithThreshold(pts, TH);
            if (segs.length < 5) continue;
            var clusters = clusterDurations(segs);
            var score = (clusters[0] ? clusters[0].count : 0) + (clusters[1] ? clusters[1].count : 0);
            // 동점이면 임계값이 큰 쪽(노이즈 오검출이 적은 쪽)을 선호
            if (!best || score >= best.score) best = { TH: TH, segs: segs, score: score };
        }
        if (!best) {
            var fallback = segmentWithThreshold(pts, Math.max(noiseFloor * 8, 0.001));
            fallback.threshold = Math.max(noiseFloor * 8, 0.001);
            return fallback;
        }
        best.segs.threshold = best.TH;
        return best.segs;
    }

    function makeSeg(pts, i0, i1) {
        return {
            i0: i0, i1: i1,
            t0: pts[i0].t, t1: pts[i1].t,
            dur: pts[i1].t - pts[i0].t,
            v0: pts[i0].v, v1: pts[i1].v,
            dv: pts[i1].v - pts[i0].v
        };
    }

    // 지속시간 클러스터링 → 최빈 클러스터 목록 (빈도 내림차순)
    function clusterDurations(segs) {
        var clusters = [];
        var durs = segs.map(function (s) { return s.dur; }).sort(function (a, b) { return a - b; });
        durs.forEach(function (d) {
            var c = null;
            for (var k = 0; k < clusters.length; k++) {
                if (Math.abs(d - clusters[k].center) <= Math.max(30, 0.2 * clusters[k].center)) { c = clusters[k]; break; }
            }
            if (c) { c.center = (c.center * c.count + d) / (c.count + 1); c.count++; }
            else clusters.push({ center: d, count: 1 });
        });
        return clusters.sort(function (a, b) { return b.count - a.count; });
    }

    // ==================================================================
    // 3. 펄스/완화 판정 및 펄스 목록 구성
    // ==================================================================
    function detectAndAnalyze() {
        gittSegments = detectSegments(gittPoints);
        var segs = gittSegments;

        var clusters = clusterDurations(segs);
        if (clusters.length < 2 || clusters[1].count < 3) {
            setStatus('규칙적인 펄스/완화 패턴을 찾지 못했습니다. GITT 데이터가 맞는지 확인해 주세요.');
            gittPulses = [];
            renderAll();
            return;
        }
        var modeA = clusters[0].center, modeB = clusters[1].center;
        var pulseMode = Math.min(modeA, modeB);
        var restMode = Math.max(modeA, modeB);

        var isRest = function (s) { return Math.abs(s.dur - restMode) <= 0.25 * restMode; };
        var isLong = function (s) { return s.dur > 1.6 * restMode; };

        // 펄스 채택 규칙: 완화(rest) 바로 앞의 비(非)완화·비(非)장기 구간
        //  - E0  : 직전 구간의 마지막 전압 (직전 구간이 평형 상태여야 유효)
        //  - E_τ : 펄스 구간의 마지막 전압
        //  - E_eq: 직후 완화 구간의 마지막 전압
        //  - τ   : 펄스 구간의 실측 지속시간 (하드코딩 없음)
        var pulses = [];
        for (var k = 1; k < segs.length - 1; k++) {
            var seg = segs[k], prev = segs[k - 1], next = segs[k + 1];
            if (isRest(seg) || isLong(seg)) continue;
            if (!isRest(next)) continue;
            // 직전 구간이 대전류 CC(전압 변화 큼)면 평형 시작점이 아니므로 제외
            var prevIsEquilibrium = isRest(prev) || Math.abs(prev.dv) < 0.15;
            if (!prevIsEquilibrium) continue;

            var E0 = prev.v1, E_tau = seg.v1, E_eq = next.v1;
            var dEt = E_tau - E0, dEs = E_eq - E0;
            if (Math.abs(dEt) < 1e-6) continue;

            pulses.push({
                mode: dEt > 0 ? 'Charge' : 'Discharge',
                segIdx: k,
                tau: seg.dur,
                tStart: seg.t0,
                E0: E0, E_tau: E_tau, E_eq: E_eq,
                dEt: dEt, dEs: dEs,
                dScaled: (4 / (Math.PI * seg.dur)) * Math.pow(dEs / dEt, 2)
            });
        }

        // 회차(run) 번호: 모드가 바뀔 때마다 새 회차, 펄스 번호는 회차 내 순번
        var runNo = 0, lastMode = null, pulseNo = 0;
        pulses.forEach(function (p) {
            if (p.mode !== lastMode) { runNo++; pulseNo = 0; lastMode = p.mode; }
            p.run = runNo;
            p.pulseNo = ++pulseNo;
        });

        gittPulses = pulses;
        gittPulses.pulseMode = pulseMode;
        gittPulses.restMode = restMode;

        // [Formation 제외] formation은 펄스·완화 반복 없이 전압이 연속으로
        // 오르내리는 구간 → 첫 유효 펄스 직전의 평형(완화) 구간부터만 표시한다.
        // 사이클 수를 가정하지 않으므로 formation이 몇 사이클이든 동일하게 동작.
        gittTrimT = null;
        if (pulses.length) {
            var firstSeg = segs[pulses[0].segIdx];
            var prevSeg = segs[pulses[0].segIdx - 1];
            gittTrimT = prevSeg ? prevSeg.t0 : firstSeg.t0;
        }

        calcDiffusion();
        renderAll();

        var nCh = pulses.filter(function (p) { return p.mode === 'Charge'; }).length;
        var nDis = pulses.length - nCh;
        setStatus('감지 완료: 펄스 ' + pulses.length + '개 (충전 ' + nCh + ' · 방전 ' + nDis + ') — 펄스 ≈ ' +
            fmtDur(pulseMode) + ', 완화 ≈ ' + fmtDur(restMode) + ' · 파일: ' + gittFilename);

        registerGittDataset(pulses.length, nCh, nDis);
    }

    // ==================================================================
    // 데이터 라이브러리 등록: 분석에 성공한 GITT 파일을 "GITT" 배지로 표시.
    //   - rate/cycle 전환 대상이 아님(독립 분석) — 표시·관리(이름/삭제)용.
    //   - 클릭 시 일반 분석으로 전환되지 않고 GITT 탭만 열린다 (09번 가드).
    //   - 라이브러리 전역이 없는 환경에서도 GITT 분석 자체는 동작하도록 전부 가드.
    // ==================================================================
    function registerGittDataset(nPulse, nCh, nDis) {
        if (typeof datasetLibrary === 'undefined' || typeof normalizeDataset !== 'function') return;
        try {
            var metric = '펄스 ' + nPulse + '개 (충 ' + nCh + ' · 방 ' + nDis + ')';
            var now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
            var existing = null;
            for (var i = 0; i < datasetLibrary.length; i++) {
                if (datasetLibrary[i].experimentType === 'gitt' && datasetLibrary[i].filename === gittFilename) {
                    existing = datasetLibrary[i];
                    break;
                }
            }
            if (existing) {
                // 같은 파일 재업로드 → 새 항목을 만들지 않고 기존 항목 갱신
                existing.keyMetric = metric;
                existing.lastConvertedAt = now;
                existing.conversionStatus = 'converted';
                if (typeof updateDatasetInDB === 'function') {
                    Promise.resolve(updateDatasetInDB(existing)).catch(function (e) { console.warn('GITT DB 갱신 실패:', e); });
                }
            } else {
                var base = gittFilename ? gittFilename.replace(/\.[^.]+$/, '') : 'GITT';
                var ds = {
                    id: Date.now().toString(),
                    projectName: (typeof activeProjectId !== 'undefined' && activeProjectId) ? activeProjectId : 'Default Project',
                    experimentType: 'gitt',
                    isGitt: true,               // 01-core 초기 로드 시 자동 활성화 제외 플래그
                    dataName: base,
                    customName: base,
                    sampleName: '',
                    filename: gittFilename,
                    uploadedAt: now,
                    lastConvertedAt: now,
                    conversionStatus: 'converted',
                    keyMetric: metric,
                    processedCycles: {},        // 일반 분석 사이클 없음 (독립 분석)
                    totalCycles: 0,
                    ice: '-',
                    compareEnabled: false       // 비교 오버레이 대상 아님
                };
                normalizeDataset(ds);
                datasetLibrary.push(ds);
                if (typeof saveDatasetToDB === 'function') {
                    Promise.resolve(saveDatasetToDB(ds)).catch(function (e) { console.warn('GITT DB 저장 실패:', e); });
                }
            }
            if (typeof renderDatasetLibraryUI === 'function') renderDatasetLibraryUI();
            if (typeof renderLibraryTable === 'function') renderLibraryTable();
        } catch (e) {
            console.warn('GITT 라이브러리 등록 실패:', e);
        }
    }

    function fmtDur(sec) {
        if (sec >= 3600) return (sec / 3600).toFixed(1) + 'h';
        if (sec >= 60) return Math.round(sec / 60) + '분';
        return Math.round(sec) + '초';
    }

    // ==================================================================
    // 4. 확산계수 계산 (Weppner–Huggins 단순화식)
    //    D = (4/πτ) · (Loading·V_M / M_B)² · (ΔEs/ΔEt)²   [cm²/s]
    //    Loading = 활물질 로딩 (mg/cm², 사용자 입력) → m_B/A 에 해당
    //    V_M     = 활물질 몰부피 (cm³/mol, 사용자 입력)
    //    M_B     = 활물질 몰질량 (g/mol, 사용자 입력)
    //    → Loading·V_M/M_B = 활물질 유효 두께 L (cm)
    // ==================================================================
    function calcDiffusion() {
        var Ld = parseFloat($('gittLoading') && $('gittLoading').value);   // mg/cm²
        var V_M = parseFloat($('gittVol') && $('gittVol').value);          // cm³/mol
        var M_B = parseFloat($('gittMolarMass') && $('gittMolarMass').value); // g/mol
        var hint = $('gittParamHint');
        if (!(Ld > 0) || !(V_M > 0) || !(M_B > 0)) {
            gittPulses.forEach(function (p) { p.D = null; p.logD = null; });
            if (hint) hint.textContent = 'Loading · V_M · M_B 를 입력하면 D가 계산되어 표시됩니다.';
            return;
        }
        var factor = ((Ld / 1000.0) * V_M) / M_B; // mg→g 환산, factor = 유효 두께 L (cm)
        var factorSq = factor * factor;
        gittPulses.forEach(function (p) {
            p.D = p.dScaled * factorSq;
            p.logD = p.D > 0 ? Math.log10(p.D) : null;
        });
        if (hint) hint.textContent = 'D = (4/πτ)·(L·V_M/M_B)²·(ΔEs/ΔEt)² · 유효 두께 L = ' + (factor * 1e4).toFixed(2) + ' µm';
    }

    // ==================================================================
    // 5. 렌더링
    // ==================================================================
    function currentShowMode() {
        var sel = $('gittShowMode');
        return sel ? sel.value : 'both';
    }

    function filteredPulses() {
        var m = currentShowMode();
        if (m === 'charge') return gittPulses.filter(function (p) { return p.mode === 'Charge'; });
        if (m === 'discharge') return gittPulses.filter(function (p) { return p.mode === 'Discharge'; });
        return gittPulses;
    }

    function renderAll() {
        renderDetectCard();
        renderProfileChart();
        renderDiffusionChart();
        renderSummaryTable();
    }

    function renderDetectCard() {
        var card = $('gittDetectCard');
        if (!card) return;
        if (!gittPoints.length) { card.style.display = 'none'; return; }
        card.style.display = 'flex';
        // formation 제외 구간 기준 지표
        var trimT = (gittTrimT != null) ? gittTrimT : gittPoints[0].t;
        var nShow = 0;
        for (var i = gittPoints.length - 1; i >= 0 && gittPoints[i].t >= trimT; i--) nShow++;
        var totalH = (gittPoints[gittPoints.length - 1].t - trimT) / 3600;
        var trimmedH = (trimT - gittPoints[0].t) / 3600;
        var nCh = gittPulses.filter(function (p) { return p.mode === 'Charge'; }).length;
        var html =
            metricBox('데이터 포인트', nShow.toLocaleString(), '') +
            metricBox('분석 구간', totalH.toFixed(1) + ' h', trimmedH > 0.1 ? '(앞 ' + trimmedH.toFixed(1) + 'h formation 제외)' : '') +
            metricBox('감지된 펄스', String(gittPulses.length), '개') +
            metricBox('충전 / 방전', nCh + ' / ' + (gittPulses.length - nCh), '') +
            metricBox('펄스 시간 (자동)', gittPulses.pulseMode ? fmtDur(gittPulses.pulseMode) : '-', '') +
            metricBox('완화 시간 (자동)', gittPulses.restMode ? fmtDur(gittPulses.restMode) : '-', '');
        card.innerHTML = html;
    }

    function metricBox(label, value, unit) {
        return '<div style="flex:1; min-width:110px; background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:8px; padding:10px 12px;">' +
            '<div style="font-size:10px; color:var(--text-muted); margin-bottom:4px;">' + label + '</div>' +
            '<div style="font-size:16px; font-weight:700; color:#fff;">' + value +
            (unit ? ' <span style="font-size:11px; font-weight:400; color:var(--text-muted);">' + unit + '</span>' : '') +
            '</div></div>';
    }

    function renderProfileChart() {
        var canvas = $('chartGittProfile');
        if (!canvas) return;
        if (chartProfile) { chartProfile.destroy(); chartProfile = null; }
        if (!gittPoints.length) return;

        // formation 제외: gittTrimT 이후 구간만 표시 (시간축은 0부터 재시작)
        var startIdx = 0;
        var trimT = gittPoints[0].t;
        if (gittTrimT != null) {
            trimT = gittTrimT;
            while (startIdx < gittPoints.length && gittPoints[startIdx].t < gittTrimT) startIdx++;
        }
        var nShow = gittPoints.length - startIdx;
        if (nShow < 2) { startIdx = 0; trimT = gittPoints[0].t; nShow = gittPoints.length; }

        // 사용자 지정 x축 구간(h) 적용: 해당 구간만 잘라서 상세 표시
        var endIdx = gittPoints.length - 1;
        if (gittViewMin != null || gittViewMax != null) {
            var tMin = trimT + (gittViewMin != null ? gittViewMin : 0) * 3600;
            var tMax = (gittViewMax != null) ? trimT + gittViewMax * 3600 : gittPoints[endIdx].t;
            while (startIdx < gittPoints.length && gittPoints[startIdx].t < tMin) startIdx++;
            while (endIdx > startIdx && gittPoints[endIdx].t > tMax) endIdx--;
            nShow = endIdx - startIdx + 1;
            if (nShow < 2) { return; } // 구간에 데이터 없음 → 빈 차트 유지
        }

        // 대용량 대비 다운샘플링 (~4000 포인트, 표시 구간 기준이라 좁힐수록 상세해짐)
        var stride = Math.max(1, Math.floor(nShow / 4000));
        var data = [];
        for (var i = startIdx; i <= endIdx; i += stride) {
            data.push({ x: (gittPoints[i].t - trimT) / 3600, y: gittPoints[i].v });
        }
        var last = gittPoints[endIdx];
        var lastX = (last.t - trimT) / 3600;
        if (!data.length || data[data.length - 1].x !== lastX) data.push({ x: lastX, y: last.v });

        chartProfile = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Voltage',
                    data: data,
                    borderColor: '#60a5fa',
                    backgroundColor: 'transparent',
                    borderWidth: 1.2,
                    pointRadius: 0,
                    tension: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                parsing: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function (ctx) { return ctx.parsed.y.toFixed(4) + ' V @ ' + ctx.parsed.x.toFixed(2) + ' h'; }
                        }
                    },
                    zoom: {
                        pan: { enabled: true, mode: 'x' },
                        zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        min: (gittViewMin != null) ? gittViewMin : undefined,
                        max: (gittViewMax != null) ? gittViewMax : undefined,
                        title: { display: true, text: 'Time (h)', color: '#fff' },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#9ca3af' }
                    },
                    y: {
                        title: { display: true, text: 'Voltage (V)', color: '#fff' },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#9ca3af' }
                    }
                }
            }
        });

        // 더블클릭 시 확대/이동 원래대로
        canvas.ondblclick = function () { if (chartProfile) chartProfile.resetZoom(); };
    }

    function renderDiffusionChart() {
        var canvas = $('chartGittDiffusion');
        if (!canvas) return;
        if (chartDiffusion) { chartDiffusion.destroy(); chartDiffusion = null; }

        var pulses = filteredPulses().filter(function (p) { return p.logD != null; });
        var mk = function (mode, color) {
            var pts = pulses.filter(function (p) { return p.mode === mode; })
                .map(function (p) { return { x: p.E_eq, y: p.logD }; })
                .sort(function (a, b) { return a.x - b.x; });
            return {
                label: mode === 'Charge' ? 'Charge' : 'Discharge',
                data: pts,
                borderColor: color,
                backgroundColor: color,
                borderWidth: 1.5,
                pointRadius: 3.5,
                pointHoverRadius: 6,
                showLine: true,
                fill: false,
                tension: 0
            };
        };
        var datasets = [];
        if (pulses.some(function (p) { return p.mode === 'Discharge'; })) datasets.push(mk('Discharge', '#06b6d4'));
        if (pulses.some(function (p) { return p.mode === 'Charge'; })) datasets.push(mk('Charge', '#ec4899'));

        chartDiffusion = new Chart(canvas.getContext('2d'), {
            type: 'scatter',
            data: { datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: { display: true, labels: { color: '#fff', boxWidth: 14, padding: 10 } },
                    tooltip: {
                        callbacks: {
                            label: function (ctx) {
                                var d = Math.pow(10, ctx.parsed.y);
                                return ctx.dataset.label + ' — E_eq ' + ctx.parsed.x.toFixed(4) + ' V, D ' + d.toExponential(2) + ' cm²/s';
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        title: { display: true, text: 'Voltage (V)', color: '#fff' },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#9ca3af' }
                    },
                    y: {
                        title: { display: true, text: 'log D (Li⁺) / cm² s⁻¹', color: '#fff' },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#9ca3af' }
                    }
                }
            }
        });
    }

    function renderSummaryTable() {
        var tbody = document.querySelector('#tableGittSummary tbody');
        if (!tbody) return;
        var pulses = filteredPulses();
        if (!pulses.length) {
            tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:var(--text-muted); padding:40px 0;">GITT 파일을 업로드하면 펄스별 분석 결과가 표시됩니다.</td></tr>';
            return;
        }
        var html = '';
        pulses.forEach(function (p) {
            var badge = p.mode === 'Discharge'
                ? '<span style="color:#06b6d4; font-weight:600;">방전</span>'
                : '<span style="color:#ec4899; font-weight:600;">충전</span>';
            html += '<tr>' +
                '<td style="padding:5px 8px;">' + badge + '</td>' +
                '<td style="padding:5px 8px;">' + p.run + '</td>' +
                '<td style="padding:5px 8px; font-weight:600;">' + p.pulseNo + '</td>' +
                '<td style="padding:5px 8px;">' + Math.round(p.tau) + '</td>' +
                '<td style="padding:5px 8px;">' + p.E0.toFixed(4) + '</td>' +
                '<td style="padding:5px 8px;">' + p.E_tau.toFixed(4) + '</td>' +
                '<td style="padding:5px 8px;">' + p.E_eq.toFixed(4) + '</td>' +
                '<td style="padding:5px 8px;">' + p.dEt.toFixed(4) + '</td>' +
                '<td style="padding:5px 8px;">' + p.dEs.toFixed(4) + '</td>' +
                '<td style="padding:5px 8px; font-family:monospace;">' + (p.D != null ? p.D.toExponential(3) : '-') + '</td>' +
                '</tr>';
        });
        tbody.innerHTML = html;
    }

    // ==================================================================
    // 6. 내보내기 (xlsx)
    // ==================================================================
    function exportGittXlsx() {
        if (!gittPulses.length) { alert('내보낼 GITT 분석 결과가 없습니다.'); return; }
        var data = [['Mode', 'Run', 'PulseNo', 'tau_s', 'E0_V', 'E_tau_V', 'E_eq_V', 'dEt_V', 'dEs_V', 'D_cm2_s', 'log10D']];
        gittPulses.forEach(function (p) {
            data.push([p.mode, p.run, p.pulseNo, p.tau, p.E0, p.E_tau, p.E_eq, p.dEt, p.dEs,
                p.D != null ? p.D : '', p.logD != null ? p.logD : '']);
        });
        var ws = XLSX.utils.aoa_to_sheet(data);
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'GITT Results');
        var base = gittFilename ? gittFilename.replace(/\.[^.]+$/, '') : 'GITT';
        var d = new Date();
        var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        XLSX.writeFile(wb, 'GITT결과_' + base + '_' + stamp + '.xlsx');
    }

    // ==================================================================
    // 7. 초기화
    // ==================================================================
    function initGittTab() {
        var btn = $('btnTabGitt');
        if (btn) btn.addEventListener('click', function (e) { e.preventDefault(); activateGittTab(); });

        var drop = $('gittDropZone'), input = $('gittFileInput');
        if (drop && input) {
            drop.addEventListener('click', function () { input.click(); });
            input.addEventListener('change', function (e) {
                if (e.target.files && e.target.files[0]) onGittFile(e.target.files[0]);
                input.value = '';
            });
            drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.style.borderColor = 'var(--color-primary)'; });
            drop.addEventListener('dragleave', function () { drop.style.borderColor = 'rgba(255,255,255,0.18)'; });
            drop.addEventListener('drop', function (e) {
                e.preventDefault();
                drop.style.borderColor = 'rgba(255,255,255,0.18)';
                if (e.dataTransfer.files && e.dataTransfer.files[0]) onGittFile(e.dataTransfer.files[0]);
            });
        }

        // 파라미터 변경 시 D 실시간 재계산
        ['gittLoading', 'gittVol', 'gittMolarMass'].forEach(function (id) {
            var el = $(id);
            if (el) el.addEventListener('input', function () {
                if (gittPulses.length) { calcDiffusion(); renderDiffusionChart(); renderSummaryTable(); }
            });
        });

        var showSel = $('gittShowMode');
        if (showSel) showSel.addEventListener('change', function () {
            renderDiffusionChart();
            renderSummaryTable();
        });

        // 프로파일 x축 구간 보기: 시작/끝(h) 입력 시 해당 구간만 상세 표시
        var applyRange = function () {
            var s = parseFloat($('gittRangeStart') && $('gittRangeStart').value);
            var e = parseFloat($('gittRangeEnd') && $('gittRangeEnd').value);
            gittViewMin = isNaN(s) ? null : Math.max(0, s);
            gittViewMax = isNaN(e) ? null : e;
            // 시작 ≥ 끝처럼 뒤집힌 입력이면 구간 지정을 무시하고 전체 표시
            if (gittViewMin != null && gittViewMax != null && gittViewMin >= gittViewMax) {
                gittViewMin = null; gittViewMax = null;
            }
            if (gittPoints.length) renderProfileChart();
        };
        ['gittRangeStart', 'gittRangeEnd'].forEach(function (id) {
            var el = $(id);
            if (el) el.addEventListener('change', applyRange);
        });
        var btnRangeReset = $('gittRangeReset');
        if (btnRangeReset) btnRangeReset.addEventListener('click', function () {
            if ($('gittRangeStart')) $('gittRangeStart').value = '';
            if ($('gittRangeEnd')) $('gittRangeEnd').value = '';
            gittViewMin = null; gittViewMax = null;
            if (gittPoints.length) renderProfileChart();
        });

        var btnExport = $('btnExportGittXlsx');
        if (btnExport) btnExport.addEventListener('click', exportGittXlsx);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGittTab);
    else initGittTab();

    // 테스트/디버깅용 전역 노출
    window.GittAnalyzer = {
        ingestRows: ingestGittRows,
        getPulses: function () { return gittPulses; },
        getSegments: function () { return gittSegments; },
        activateTab: activateGittTab
    };
})();
