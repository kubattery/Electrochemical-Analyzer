/* ============================================================================
 * HC-Analyzer  ·  js/21-gitt.js   (GITT 분석 · 독립 모듈 · v1.4.0)
 *
 * [v1.4.0] 종합 데이터 모드:
 *          페이저 왼쪽의 <종합 데이터> 버튼으로 진입. 체크박스 목록(데이터1,
 *          데이터2, …)에서 원하는 데이터만 골라 전압 프로파일·이온 확산계수
 *          두 차트에 겹쳐 비교한다(파일별 색·범례, 확산 차트는 방전=점선).
 *          종합 모드에서는 지표 카드·펄스별 분석 결과 테이블을 숨기고,
 *          D 파라미터 입력은 비활성화(각 데이터 페이지에서 파일별 입력).
 *          ◀ ▶ 를 누르거나 버튼을 다시 누르면 개별 페이지 모드로 복귀.
 *
 * [v1.3.0] 데이터 페이지 넘김 + 파일별 D 파라미터:
 *          업로드 존 바로 아래에 페이저(◀ 데이터 n / N · 파일명 ▶)를 표시하고,
 *          체크된 GITT 파일들을 한 페이지에 하나씩 넘겨 보며 각각의 그래프를
 *          확인한다(파일마다 Loading·V_M·M_B가 달라 오버레이 대신 페이지 방식).
 *          Loading·V_M·M_B 입력은 현재 페이지 파일에만 적용되고 파일별로
 *          IndexedDB(ds.gittParams)에 저장되어 새로고침 후에도 유지된다.
 *          파일이 없어도 페이저와 빈 그래프(축 프레임)가 표시된다.
 *
 * [v1.2.0] 사이드바 체크박스 연동:
 *          rate/cycle과 동일하게 라이브러리 체크박스(compareEnabled)가 GITT 탭
 *          표시 여부를 제어한다(체크 = 페이저에 포함, 해제 = 제외). 09번
 *          체크박스 핸들러가 GittAnalyzer.setCompare(id, on)을 호출한다.
 *
 * [v1.1.0] 분석 결과 영속화: 분석 성공 시 전압 프로파일(formation 제외 구간)과
 *          펄스 결과를 gittPayload로 IndexedDB 데이터셋 레코드에 저장(CV 탭의
 *          cvPayload와 동일한 패턴). 새로고침 후 GITT 탭 진입 또는 라이브러리
 *          항목 클릭 시 파일 재업로드 없이 그래프·테이블이 즉시 복원된다.
 *
 * [v1.0.1] τ 측정 보정: 펄스 세그먼트 자체 길이(seg.dur) 대신
 *          "직전 평형 구간 마지막 점 ~ 펄스 마지막 점"(seg.t1 - prev.t1)으로 측정.
 *          경계 IR 점프 샘플·방전 말기 다단 IR 계단(30초 미만 조각 제거분)으로 인한
 *          τ 과소 측정(예: 실제 600s → 598s, 컷오프 펄스 276s → 256s)과
 *          그에 따른 D 과대 계산을 수정.
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

    // ---- 분석 작업용 상태 (파일 하나를 파싱·감지하는 동안 사용) ----
    var gittPoints = [];        // [{t(초), v(V)}]
    var gittSegments = [];      // 감지된 구간 목록
    var gittPulses = [];        // 유효 펄스 결과
    var gittTrimT = null;       // formation 제외: 이 시각(초) 이전 데이터는 표시하지 않음
    var gittOrigT0 = null;      // 원본 데이터 시작 시각(초) — 복원 시 formation 제외량 표시용

    // ---- 표시용 상태: 로드된 GITT 파일 목록 ----
    // 항목: { id, name, color, points, trimT, origT0, pulses, pulseMode, restMode,
    //         visible, params }
    //   visible = 사이드바 라이브러리 체크박스(compareEnabled)와 동기화.
    //   params  = 파일별 D 계산 파라미터 { Ld, Vm, Mb } (없으면 null).
    var gittFiles = [];
    var gittPage = 0;          // 현재 페이지 인덱스 (체크된 파일 목록 기준)
    var gittCombined = false;  // 종합 데이터 모드 여부
    var gittCombinedSel = {};  // 종합 모드 선택 상태 (id → false만 기록, 기본 선택)

    function findGittFile(id) {
        for (var i = 0; i < gittFiles.length; i++) if (gittFiles[i].id === id) return gittFiles[i];
        return null;
    }
    function visibleGittFiles() {
        return gittFiles.filter(function (f) { return f.visible && f.points && f.points.length; });
    }
    // 현재 페이지에 표시할 파일 1개 (없으면 null). 페이지 인덱스는 자동 보정.
    function displayedGittFile() {
        var vis = visibleGittFiles();
        if (!vis.length) { gittPage = 0; return null; }
        if (gittPage >= vis.length) gittPage = vis.length - 1;
        if (gittPage < 0) gittPage = 0;
        return vis[gittPage];
    }
    // 특정 파일이 보이는 페이지로 이동
    function jumpToFile(id) {
        var vis = visibleGittFiles();
        for (var i = 0; i < vis.length; i++) if (vis[i].id === id) { gittPage = i; return; }
    }
    // 종합 모드에서 겹쳐 그릴 파일들 (체크된 파일 중 종합 목록에서 선택된 것)
    function combinedFiles() {
        return visibleGittFiles().filter(function (f) { return gittCombinedSel[f.id] !== false; });
    }
    function libraryColorOf(id, fallback) {
        if (typeof datasetLibrary !== 'undefined') {
            for (var i = 0; i < datasetLibrary.length; i++) {
                if (datasetLibrary[i].id === id) return datasetLibrary[i].lineColor || fallback;
            }
        }
        return fallback;
    }
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
        // 새로고침 후 진입 시 저장된 분석 결과를 자동 복원 (이미 복원된 항목은 건너뜀)
        try { restoreAllFromLibrary(); } catch (e) { console.warn('GITT 자동 복원 실패:', e); }
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
        gittOrigT0 = pts[0].t;
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

            // τ = 전류 인가 시간. seg.dur는 경계 IR 점프에 걸린 샘플과
            // 계단형 IR 조각(30초 미만 제거분)이 빠져 실제보다 짧게 측정된다
            // (방전 말기 다단 IR 계단에서는 수십 초까지 과소 → D 과대).
            // 직전 평형 구간 마지막 점(prev.t1) ~ 펄스 마지막 점(seg.t1)으로
            // 측정하면 IR 계단이 어떻게 쪼개져도 정확한 인가 시간이 된다.
            var tau = seg.t1 - prev.t1;

            pulses.push({
                mode: dEt > 0 ? 'Charge' : 'Discharge',
                segIdx: k,
                tau: tau,
                tStart: seg.t0,
                E0: E0, E_tau: E_tau, E_eq: E_eq,
                dEt: dEt, dEs: dEs,
                dScaled: (4 / (Math.PI * tau)) * Math.pow(dEs / dEt, 2)
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

        var nCh = pulses.filter(function (p) { return p.mode === 'Charge'; }).length;
        var nDis = pulses.length - nCh;

        // 라이브러리 등록(체크박스와 연동될 id 확보) 후 표시 목록에 커밋.
        // 새로 분석한 파일은 체크된 상태(visible)로 바로 표시된다.
        var dsId = registerGittDataset(pulses.length, nCh, nDis);
        commitGittFile(dsId != null ? dsId : ('local:' + gittFilename));

        calcDiffusion();
        renderAll();

        setStatus('감지 완료: 펄스 ' + pulses.length + '개 (충전 ' + nCh + ' · 방전 ' + nDis + ') — 펄스 ≈ ' +
            fmtDur(pulseMode) + ', 완화 ≈ ' + fmtDur(restMode) + ' · 파일: ' + gittFilename);
    }

    // 분석 작업용 상태(gittPoints/gittPulses 등)를 표시 목록(gittFiles)에 반영
    function commitGittFile(id) {
        var entry = findGittFile(id);
        if (!entry) { entry = { id: id, params: null }; gittFiles.push(entry); }
        entry.name = gittFilename;
        entry.color = libraryColorOf(id, '#60a5fa');
        entry.points = gittPoints;
        entry.trimT = gittTrimT;
        entry.origT0 = gittOrigT0;
        entry.pulses = gittPulses;
        entry.pulseMode = gittPulses.pulseMode || null;
        entry.restMode = gittPulses.restMode || null;
        entry.visible = true;
        gittCombined = false; // 새로 분석한 파일은 개별 페이지로 보여준다
        jumpToFile(id); // 방금 분석한 파일의 페이지로 이동
        return entry;
    }

    // ==================================================================
    // 분석 결과 영속화 (gittPayload)
    //   - IndexedDB 구조적 복제는 TypedArray를 그대로 저장하므로
    //     시간=Float64Array, 전압=Float32Array로 압축 저장 (CSV 재파싱 불필요).
    //   - formation 제외(trim) 이후 구간만 저장 — 표시·분석에 쓰이는 구간.
    //   - D/logD는 저장하지 않음: 복원 후 calcDiffusion()이 입력값으로 재계산.
    // ==================================================================
    function buildGittPayload() {
        var trimT = (gittTrimT != null) ? gittTrimT : (gittPoints.length ? gittPoints[0].t : 0);
        var startIdx = 0;
        while (startIdx < gittPoints.length && gittPoints[startIdx].t < trimT) startIdx++;
        var n = gittPoints.length - startIdx;
        var t = new Float64Array(n), v = new Float32Array(n);
        for (var i = 0; i < n; i++) {
            t[i] = gittPoints[startIdx + i].t;
            v[i] = gittPoints[startIdx + i].v;
        }
        var pulses = gittPulses.map(function (p) {
            return {
                mode: p.mode, run: p.run, pulseNo: p.pulseNo,
                tau: p.tau, tStart: p.tStart,
                E0: p.E0, E_tau: p.E_tau, E_eq: p.E_eq,
                dEt: p.dEt, dEs: p.dEs, dScaled: p.dScaled
            };
        });
        return {
            version: 1,
            t: t, v: v,
            origT0: (gittOrigT0 != null) ? gittOrigT0 : (gittPoints.length ? gittPoints[0].t : null),
            trimT: gittTrimT,
            pulses: pulses,
            pulseMode: gittPulses.pulseMode || null,
            restMode: gittPulses.restMode || null
        };
    }

    // 저장된 gittPayload로 표시 목록 항목을 만든다 (이미 있으면 그대로 반환).
    // visible 초기값은 라이브러리 체크박스(compareEnabled)를 따른다.
    function restoreEntryFromDataset(ds) {
        var entry = findGittFile(ds.id);
        if (entry) return entry;
        var pl = ds.gittPayload;
        if (!pl || !pl.t || !pl.t.length) return null;
        var n = pl.t.length;
        var pts = new Array(n);
        for (var i = 0; i < n; i++) pts[i] = { t: pl.t[i], v: pl.v[i] };
        var pulses = (pl.pulses || []).map(function (p) {
            return {
                mode: p.mode, run: p.run, pulseNo: p.pulseNo,
                tau: p.tau, tStart: p.tStart,
                E0: p.E0, E_tau: p.E_tau, E_eq: p.E_eq,
                dEt: p.dEt, dEs: p.dEs, dScaled: p.dScaled
            };
        });
        var params = null;
        if (ds.gittParams && (ds.gittParams.Ld > 0 || ds.gittParams.Vm > 0 || ds.gittParams.Mb > 0)) {
            params = { Ld: ds.gittParams.Ld, Vm: ds.gittParams.Vm, Mb: ds.gittParams.Mb };
        }
        entry = {
            id: ds.id,
            name: ds.filename || ds.dataName || 'GITT',
            color: ds.lineColor || '#60a5fa',
            points: pts,
            trimT: (pl.trimT != null) ? pl.trimT : null,
            origT0: (pl.origT0 != null) ? pl.origT0 : (n ? pts[0].t : null),
            pulses: pulses,
            pulseMode: pl.pulseMode || null,
            restMode: pl.restMode || null,
            visible: !!ds.compareEnabled,
            params: params
        };
        gittFiles.push(entry);
        return entry;
    }

    // 새로고침 후 GITT 탭 진입 시: 저장된 GITT 데이터셋 전부를 표시 목록에
    // 복원한다(체크된 것만 화면에 그려짐). 이미 복원된 항목은 건너뛰므로
    // 매 진입마다 호출해도 안전하다.
    function restoreAllFromLibrary() {
        if (typeof datasetLibrary === 'undefined') return;
        var added = 0;
        for (var i = 0; i < datasetLibrary.length; i++) {
            var ds = datasetLibrary[i];
            if (ds && ds.experimentType === 'gitt' && !findGittFile(ds.id) && restoreEntryFromDataset(ds)) added++;
        }
        if (added > 0) {
            calcDiffusion();
            renderAll();
            var vis = visibleGittFiles();
            if (vis.length) {
                setStatus('저장된 분석 복원: 파일 ' + vis.length + '개 표시 중 — 사이드바 체크박스로 표시/숨김을 바꿀 수 있습니다.');
            } else {
                setStatus('저장된 GITT 파일 ' + added + '개 복원됨 — 사이드바 라이브러리에서 체크박스를 선택하면 그래프가 표시됩니다.');
            }
        }
    }

    // 라이브러리에서 GITT 항목 클릭 시(09번 가드) 호출: 해당 데이터셋을
    // 복원·체크(표시) 상태로 만들고 GITT 탭을 연다.
    function showGittDataset(id) {
        var ds = null;
        if (typeof datasetLibrary !== 'undefined') {
            for (var i = 0; i < datasetLibrary.length; i++) {
                if (datasetLibrary[i].id === id) { ds = datasetLibrary[i]; break; }
            }
        }
        if (ds) {
            var entry = findGittFile(id) || restoreEntryFromDataset(ds);
            if (entry && !entry.visible) {
                entry.visible = true;
                if (!ds.compareEnabled) {
                    ds.compareEnabled = true;
                    if (typeof updateDatasetInDB === 'function') {
                        try { Promise.resolve(updateDatasetInDB(ds)).catch(function () {}); } catch (e) {}
                    }
                    if (typeof renderDatasetLibraryUI === 'function') renderDatasetLibraryUI();
                }
            }
            if (entry) { gittCombined = false; jumpToFile(id); calcDiffusion(); renderAll(); }
        }
        activateGittTab();
    }

    // 사이드바 체크박스 토글(09번) → GITT 탭 표시/숨김.
    // compareEnabled 저장·사이드바 갱신은 09번 체크박스 핸들러가 담당한다.
    function setGittCompare(id, on) {
        var entry = findGittFile(id);
        if (!entry && on && typeof datasetLibrary !== 'undefined') {
            for (var i = 0; i < datasetLibrary.length; i++) {
                if (datasetLibrary[i].id === id) { entry = restoreEntryFromDataset(datasetLibrary[i]); break; }
            }
        }
        if (!entry) return;
        entry.visible = !!on;
        calcDiffusion();
        renderAll();
        var vis = visibleGittFiles();
        if (!vis.length && gittFiles.length) {
            setStatus('표시 중인 GITT 파일이 없습니다 — 사이드바 라이브러리에서 체크박스를 선택하세요.');
        } else if (vis.length) {
            setStatus('표시 중: GITT 파일 ' + vis.length + '개 — 업로드 존 아래 ◀ ▶ 로 데이터를 넘겨 보세요.');
        }
    }

    // 라이브러리에서 GITT 항목 삭제 시(09번) 호출: 표시 목록에서도 제거.
    function removeGittDataset(id) {
        var before = gittFiles.length;
        gittFiles = gittFiles.filter(function (f) { return f.id !== id; });
        if (gittFiles.length !== before) { calcDiffusion(); renderAll(); }
    }

    // ==================================================================
    // 데이터 라이브러리 등록: 분석에 성공한 GITT 파일을 "GITT" 배지로 표시.
    //   - rate/cycle 전환 대상이 아님(독립 분석) — 표시·관리(이름/삭제)용.
    //   - 클릭 시 일반 분석으로 전환되지 않고 GITT 탭만 열린다 (09번 가드).
    //   - 라이브러리 전역이 없는 환경에서도 GITT 분석 자체는 동작하도록 전부 가드.
    // ==================================================================
    function registerGittDataset(nPulse, nCh, nDis) {
        if (typeof datasetLibrary === 'undefined' || typeof normalizeDataset !== 'function') return null;
        try {
            var metric = '펄스 ' + nPulse + '개 (충 ' + nCh + ' · 방 ' + nDis + ')';
            var now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
            var payload = buildGittPayload(); // 새로고침 후 복원용 분석 결과 (IndexedDB 저장)
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
                existing.gittPayload = payload;
                existing.compareEnabled = true; // 재분석한 파일은 체크(표시) 상태로
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
                    compareEnabled: true,       // 체크박스 = GITT 탭 표시 여부 (신규 파일은 표시)
                    gittPayload: payload        // 새로고침 후 복원용 분석 결과
                };
                normalizeDataset(ds);
                datasetLibrary.push(ds);
                if (typeof saveDatasetToDB === 'function') {
                    Promise.resolve(saveDatasetToDB(ds)).catch(function (e) { console.warn('GITT DB 저장 실패:', e); });
                }
            }
            if (typeof renderDatasetLibraryUI === 'function') renderDatasetLibraryUI();
            if (typeof renderLibraryTable === 'function') renderLibraryTable();
            return existing ? existing.id : ds.id;
        } catch (e) {
            console.warn('GITT 라이브러리 등록 실패:', e);
            return null;
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
    function validParams(p) { return !!(p && p.Ld > 0 && p.Vm > 0 && p.Mb > 0); }

    function calcDiffusion() {
        // 파일마다 자기 파라미터로 D 계산 (파라미터 없는 파일은 D 미계산)
        gittFiles.forEach(function (f) {
            if (!f.pulses) return;
            if (validParams(f.params)) {
                var factor = ((f.params.Ld / 1000.0) * f.params.Vm) / f.params.Mb; // mg→g 환산, factor = 유효 두께 L (cm)
                var factorSq = factor * factor;
                f.pulses.forEach(function (p) {
                    p.D = p.dScaled * factorSq;
                    p.logD = p.D > 0 ? Math.log10(p.D) : null;
                });
            } else {
                f.pulses.forEach(function (p) { p.D = null; p.logD = null; });
            }
        });
        var hint = $('gittParamHint');
        if (hint) {
            if (gittCombined) {
                hint.textContent = '종합 데이터 모드 — Loading · V_M · M_B 는 각 데이터 페이지에서 파일별로 입력·저장됩니다.';
                return;
            }
            var f2 = displayedGittFile();
            if (f2 && validParams(f2.params)) {
                var L = ((f2.params.Ld / 1000.0) * f2.params.Vm) / f2.params.Mb;
                hint.textContent = 'D = (4/πτ)·(L·V_M/M_B)²·(ΔEs/ΔEt)² · ' + shortName(f2.name) +
                    ' 유효 두께 L = ' + (L * 1e4).toFixed(2) + ' µm';
            } else {
                hint.textContent = 'Loading · V_M · M_B 는 파일별로 저장됩니다 — 현재 페이지 파일의 값을 입력하면 D가 계산됩니다.';
            }
        }
    }

    // ==================================================================
    // 5. 렌더링
    // ==================================================================
    function currentShowMode() {
        var sel = $('gittShowMode');
        return sel ? sel.value : 'both';
    }

    function filterByMode(pulses) {
        var m = currentShowMode();
        if (m === 'charge') return pulses.filter(function (p) { return p.mode === 'Charge'; });
        if (m === 'discharge') return pulses.filter(function (p) { return p.mode === 'Discharge'; });
        return pulses;
    }

    function shortName(n) { return String(n || '').replace(/\.[^.]+$/, ''); }
    function safeName(n) { return (typeof escapeHtml === 'function') ? escapeHtml(n) : String(n); }

    // 색 밝기 조절: t > 0 → 흰색 쪽(옅게), t < 0 → 검은색 쪽(짙게). t는 -1~1.
    function shadeColor(hex, t) {
        var h = String(hex || '').replace('#', '');
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (h.length !== 6) return hex;
        var target = t > 0 ? 255 : 0, a = Math.abs(t);
        var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
        r = Math.round(r + (target - r) * a);
        g = Math.round(g + (target - g) * a);
        b = Math.round(b + (target - b) * a);
        return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    // ==================================================================
    // 데이터 페이저: 업로드 존 바로 아래에 "◀ 데이터 n / N · 파일명 ▶" 표시.
    // 체크된 GITT 파일들을 한 페이지에 하나씩 순환하며 본다.
    // index.html 수정 없이 JS로 삽입한다.
    // ==================================================================
    function buildPagerUI() {
        if ($('gittPager')) return;
        var drop = $('gittDropZone');
        if (!drop || !drop.parentNode || !drop.parentNode.parentNode) return;
        var uploadCard = drop.parentNode; // 업로드 + 표시모드 카드
        var bar = document.createElement('div');
        bar.id = 'gittPager';
        bar.style.cssText = 'display:flex; align-items:center; gap:10px;' +
            ' background:var(--bg-card); border:1px solid var(--border-color); border-radius:8px; padding:6px 12px;';
        var btnStyle = 'background:rgba(255,255,255,0.06); border:1px solid var(--border-color);' +
            ' border-radius:6px; color:#fff; cursor:pointer; padding:2px 14px; font-size:13px; line-height:20px;';
        // 왼쪽 <종합 데이터> 버튼 + 가운데 "◀ 데이터 n/N ▶" + 오른쪽 파일명(flex:1)
        bar.innerHTML =
            '<div style="flex:1; display:flex; align-items:center;">' +
                '<button id="gittCombinedBtn" type="button" title="선택한 데이터들을 한 그래프에 겹쳐 비교"' +
                ' style="' + btnStyle + ' padding:2px 10px; font-size:11px;">종합 데이터</button>' +
            '</div>' +
            '<div style="display:flex; align-items:center; gap:10px;">' +
                '<button id="gittPagePrev" type="button" title="이전 데이터" style="' + btnStyle + '">&#9664;</button>' +
                '<span id="gittPageLabel" style="font-size:12px; color:#fff; font-weight:600; min-width:80px; text-align:center;"></span>' +
                '<button id="gittPageNext" type="button" title="다음 데이터" style="' + btnStyle + '">&#9654;</button>' +
            '</div>' +
            '<div id="gittPageFile" style="flex:1; text-align:right; font-size:11px; color:var(--text-muted);' +
                ' overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></div>';
        uploadCard.parentNode.insertBefore(bar, uploadCard.nextSibling);

        // 종합 모드 데이터 선택 패널 (페이저 바로 아래, 종합 모드일 때만 표시)
        var panel = document.createElement('div');
        panel.id = 'gittCombinedPanel';
        panel.style.cssText = 'display:none; align-items:center; gap:14px; flex-wrap:wrap;' +
            ' background:var(--bg-card); border:1px solid var(--border-color); border-radius:8px;' +
            ' padding:8px 12px; font-size:12px; color:var(--text-muted);';
        bar.parentNode.insertBefore(panel, bar.nextSibling);

        $('gittPagePrev').addEventListener('click', function () { moveGittPage(-1); });
        $('gittPageNext').addEventListener('click', function () { moveGittPage(1); });
        $('gittCombinedBtn').addEventListener('click', function () {
            gittCombined = !gittCombined;
            calcDiffusion();
            renderAll();
        });
        updatePagerUI();
    }

    function moveGittPage(dir) {
        var wasCombined = gittCombined;
        gittCombined = false; // ◀ ▶ 를 누르면 개별 페이지 모드로 복귀
        var n = visibleGittFiles().length;
        if (n < 1) { updatePagerUI(); if (wasCombined) renderAll(); return; }
        if (!wasCombined) gittPage = ((gittPage + dir) % n + n) % n; // 순환 이동 (종합→복귀 시는 현재 페이지 유지)
        calcDiffusion(); // 파라미터 힌트(현재 파일의 유효 두께 L) 갱신 포함
        renderAll();
    }

    function updatePagerUI() {
        var label = $('gittPageLabel');
        if (!label) return;
        var f = displayedGittFile();       // 페이지 인덱스 보정 포함
        var vis = visibleGittFiles();
        var fileEl = $('gittPageFile');
        if (gittCombined) {
            label.textContent = '종합 데이터';
            if (fileEl) fileEl.textContent = combinedFiles().length + '개 데이터 겹쳐 보기';
        } else if (!vis.length) {
            label.textContent = '데이터 0/0';
            if (fileEl) fileEl.textContent = '표시할 GITT 파일이 없습니다';
        } else {
            label.textContent = '데이터 ' + (gittPage + 1) + '/' + vis.length;
            if (fileEl) fileEl.textContent = shortName(f.name);
        }
        var dim = !gittCombined && vis.length < 2;
        ['gittPagePrev', 'gittPageNext'].forEach(function (id) {
            var b = $(id);
            if (b) b.style.opacity = dim ? '0.35' : '1';
        });
        // 종합 버튼 활성 표시
        var cbtn = $('gittCombinedBtn');
        if (cbtn) {
            cbtn.style.background = gittCombined ? 'var(--color-primary, #3b82f6)' : 'rgba(255,255,255,0.06)';
            cbtn.style.borderColor = gittCombined ? 'transparent' : 'var(--border-color)';
        }
        updateCombinedPanel();
    }

    // 종합 모드 데이터 선택 목록: 데이터1, 데이터2, … 체크박스
    function updateCombinedPanel() {
        var panel = $('gittCombinedPanel');
        if (!panel) return;
        if (!gittCombined) { panel.style.display = 'none'; return; }
        panel.style.display = 'flex';
        var vis = visibleGittFiles();
        if (!vis.length) {
            panel.innerHTML = '<span>겹쳐 볼 GITT 파일이 없습니다 — 파일을 업로드하거나 사이드바에서 체크하세요.</span>';
            return;
        }
        var html = '<span style="font-weight:600; color:#fff;">비교할 데이터:</span>';
        vis.forEach(function (f, i) {
            var on = gittCombinedSel[f.id] !== false;
            html += '<label style="display:inline-flex; align-items:center; gap:5px; cursor:pointer; white-space:nowrap;">' +
                '<input type="checkbox" data-gitt-id="' + f.id + '"' + (on ? ' checked' : '') + ' style="cursor:pointer;">' +
                '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:' + f.color + ';"></span>' +
                '데이터' + (i + 1) + ' · ' + shortName(f.name) +
                '</label>';
        });
        panel.innerHTML = html;
        var boxes = panel.querySelectorAll('input[type="checkbox"]');
        for (var k = 0; k < boxes.length; k++) {
            boxes[k].addEventListener('change', function () {
                gittCombinedSel[this.getAttribute('data-gitt-id')] = this.checked;
                renderAll();
            });
        }
    }

    // ==================================================================
    // 파일별 D 파라미터 입력 동기화·저장
    // ==================================================================
    // 현재 페이지 파일의 파라미터를 입력칸에 반영 (입력 중인 칸은 건드리지 않음).
    // 종합 모드에서는 파일마다 값이 달라 입력칸 대신 안내 메시지를 표시한다.
    function syncParamInputs() {
        var f = displayedGittFile();
        var loadingEl = $('gittLoading');
        var box = loadingEl && loadingEl.parentElement ? loadingEl.parentElement.parentElement : null;
        var sel = $('gittShowMode');
        var selWrap = sel ? sel.parentElement : null;
        if (box) {
            // 안내 메시지 요소를 입력칸 컨테이너에 한 번만 생성
            var msg = $('gittParamMsg');
            if (!msg) {
                msg = document.createElement('div');
                msg.id = 'gittParamMsg';
                msg.style.cssText = 'display:none; font-size:11px; color:var(--text-muted); align-self:center; padding:4px 2px;';
                msg.textContent = 'Loading, V_M, M_B 값들은 개별 데이터 창에서 입력 및 수정해주세요';
                box.appendChild(msg);
            }
            msg.style.display = gittCombined ? '' : 'none';
            // 표시 모드 박스: 종합 모드에서는 확산계수 카드 쪽으로 이동, 개별 모드에서는 원위치
            if (selWrap) {
                if (gittCombined) {
                    if (!selWrap._gittHome) selWrap._gittHome = { parent: selWrap.parentElement, next: selWrap.nextSibling };
                    if (selWrap.parentElement !== box) box.appendChild(selWrap);
                } else if (selWrap._gittHome && selWrap.parentElement !== selWrap._gittHome.parent) {
                    selWrap._gittHome.parent.insertBefore(selWrap, selWrap._gittHome.next);
                }
            }
            // 종합 모드: 입력칸 3개(라벨 포함) 숨김, 개별 모드: 복원
            for (var i = 0; i < box.children.length; i++) {
                var ch = box.children[i];
                if (ch.id === 'gittParamMsg' || ch === selWrap) continue;
                ch.style.display = gittCombined ? 'none' : '';
            }
        }
        if (gittCombined) return;
        [['gittLoading', 'Ld'], ['gittVol', 'Vm'], ['gittMolarMass', 'Mb']].forEach(function (pair) {
            var el = $(pair[0]);
            if (!el || document.activeElement === el) return;
            el.value = (f && f.params && f.params[pair[1]] > 0) ? f.params[pair[1]] : '';
        });
    }

    function readParamInputs() {
        var Ld = parseFloat($('gittLoading') && $('gittLoading').value);
        var Vm = parseFloat($('gittVol') && $('gittVol').value);
        var Mb = parseFloat($('gittMolarMass') && $('gittMolarMass').value);
        return { Ld: Ld > 0 ? Ld : null, Vm: Vm > 0 ? Vm : null, Mb: Mb > 0 ? Mb : null };
    }

    // 파일별 파라미터를 데이터셋 레코드(ds.gittParams)에 저장 — 새로고침 후 유지
    function persistParams(f) {
        if (!f || typeof datasetLibrary === 'undefined') return;
        for (var i = 0; i < datasetLibrary.length; i++) {
            if (datasetLibrary[i].id === f.id) {
                datasetLibrary[i].gittParams = f.params
                    ? { Ld: f.params.Ld, Vm: f.params.Vm, Mb: f.params.Mb } : null;
                if (typeof updateDatasetInDB === 'function') {
                    try { Promise.resolve(updateDatasetInDB(datasetLibrary[i])).catch(function () {}); } catch (e) {}
                }
                return;
            }
        }
    }

    function renderAll() {
        updatePagerUI();
        syncParamInputs();
        renderDetectCard();
        renderProfileChart();
        renderDiffusionChart();
        renderSummaryTable();
    }

    function renderDetectCard() {
        var card = $('gittDetectCard');
        if (!card) return;
        if (gittCombined) { card.style.display = 'none'; return; } // 종합 모드: 지표 카드 숨김
        var f = displayedGittFile();
        if (!f) { card.style.display = 'none'; return; }
        card.style.display = 'flex';

        // 현재 페이지 파일의 formation 제외 구간 기준 지표
        var trimT = (f.trimT != null) ? f.trimT : f.points[0].t;
        var nShow = 0;
        for (var i = f.points.length - 1; i >= 0 && f.points[i].t >= trimT; i--) nShow++;
        var totalH = (f.points[f.points.length - 1].t - trimT) / 3600;
        var origT0 = (f.origT0 != null) ? f.origT0 : f.points[0].t;
        var trimmedH = (trimT - origT0) / 3600;
        var nCh = f.pulses.filter(function (p) { return p.mode === 'Charge'; }).length;
        card.innerHTML =
            metricBox('데이터 포인트', nShow.toLocaleString(), '') +
            metricBox('분석 구간', totalH.toFixed(1) + ' h', trimmedH > 0.1 ? '(앞 ' + trimmedH.toFixed(1) + 'h formation 제외)' : '') +
            metricBox('감지된 펄스', String(f.pulses.length), '개') +
            metricBox('충전 / 방전', nCh + ' / ' + (f.pulses.length - nCh), '') +
            metricBox('펄스 시간 (자동)', f.pulseMode ? fmtDur(f.pulseMode) : '-', '') +
            metricBox('완화 시간 (자동)', f.restMode ? fmtDur(f.restMode) : '-', '');
    }

    function metricBox(label, value, unit) {
        return '<div style="flex:1; min-width:110px; background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:8px; padding:10px 12px;">' +
            '<div style="font-size:10px; color:var(--text-muted); margin-bottom:4px;">' + label + '</div>' +
            '<div style="font-size:16px; font-weight:700; color:#fff;">' + value +
            (unit ? ' <span style="font-size:11px; font-weight:400; color:var(--text-muted);">' + unit + '</span>' : '') +
            '</div></div>';
    }

    // 파일 하나의 표시용 라인 데이터 생성 (formation 제외 + 구간 보기 + 다운샘플링)
    // 각 파일의 시간축은 자기 trim 시점부터 0으로 정렬되어 여러 파일을 겹쳐 비교할 수 있다.
    function buildProfileData(f) {
        var pts = f.points;
        var startIdx = 0;
        var trimT = pts[0].t;
        if (f.trimT != null) {
            trimT = f.trimT;
            while (startIdx < pts.length && pts[startIdx].t < f.trimT) startIdx++;
        }
        if (pts.length - startIdx < 2) { startIdx = 0; trimT = pts[0].t; }

        // 사용자 지정 x축 구간(h) 적용: 해당 구간만 잘라서 상세 표시
        var endIdx = pts.length - 1;
        if (gittViewMin != null || gittViewMax != null) {
            var tMin = trimT + (gittViewMin != null ? gittViewMin : 0) * 3600;
            var tMax = (gittViewMax != null) ? trimT + gittViewMax * 3600 : pts[endIdx].t;
            while (startIdx < pts.length && pts[startIdx].t < tMin) startIdx++;
            while (endIdx > startIdx && pts[endIdx].t > tMax) endIdx--;
        }
        var nShow = endIdx - startIdx + 1;
        if (nShow < 2) return null; // 구간에 데이터 없음

        // 대용량 대비 다운샘플링 (~4000 포인트, 표시 구간 기준이라 좁힐수록 상세해짐)
        var stride = Math.max(1, Math.floor(nShow / 4000));
        var data = [];
        for (var i = startIdx; i <= endIdx; i += stride) {
            data.push({ x: (pts[i].t - trimT) / 3600, y: pts[i].v });
        }
        var last = pts[endIdx];
        var lastX = (last.t - trimT) / 3600;
        if (!data.length || data[data.length - 1].x !== lastX) data.push({ x: lastX, y: last.v });
        return data;
    }

    function renderProfileChart() {
        var canvas = $('chartGittProfile');
        if (!canvas) return;
        if (chartProfile) { chartProfile.destroy(); chartProfile = null; }

        // 개별 모드: 현재 페이지 파일 1개. 종합 모드: 선택한 파일들을 겹쳐 표시.
        // 파일이 없으면 빈 축 프레임을 그린다.
        var showFiles = gittCombined ? combinedFiles() : (displayedGittFile() ? [displayedGittFile()] : []);
        var datasets = [];
        showFiles.forEach(function (f) {
            var data = buildProfileData(f);
            if (!data) return;
            datasets.push({
                label: shortName(f.name),
                data: data,
                borderColor: gittCombined ? f.color : '#60a5fa',
                backgroundColor: 'transparent',
                borderWidth: 1.2,
                pointRadius: 0,
                tension: 0
            });
        });

        chartProfile = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                parsing: false,
                plugins: {
                    legend: { display: gittCombined && datasets.length > 0, labels: { color: '#fff', boxWidth: 14, padding: 10 } },
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

        // 개별 모드: 현재 페이지 파일 (모드별 색). 종합 모드: 선택한 파일들을
        // 파일 색으로 겹쳐 표시(방전 = 빈 점 + 점선). 파일이 없으면 빈 축 프레임.
        var showFiles = gittCombined ? combinedFiles() : (displayedGittFile() ? [displayedGittFile()] : []);
        var datasets = [];
        showFiles.forEach(function (f) {
            var pulses = filterByMode(f.pulses).filter(function (p) { return p.logD != null; });
            [['Discharge', '#06b6d4'], ['Charge', '#ec4899']].forEach(function (mc) {
                var mode = mc[0];
                var pts = pulses.filter(function (p) { return p.mode === mode; })
                    .map(function (p) { return { x: p.E_eq, y: p.logD }; })
                    .sort(function (a, b) { return a.x - b.x; });
                if (!pts.length) return;
                // 종합 모드: 같은 파일 색을 밝기만 달리해 구분 —
                // 충전 = 적당히 짙게, 방전 = 적당히 옅게 (과한 대비는 피함)
                var color = gittCombined
                    ? (mode === 'Charge' ? shadeColor(f.color, -0.18) : shadeColor(f.color, 0.38))
                    : mc[1];
                datasets.push({
                    label: gittCombined ? (shortName(f.name) + ' · ' + mode) : mode,
                    data: pts,
                    borderColor: color,
                    backgroundColor: color,
                    borderWidth: 1.5,
                    pointRadius: 3.5,
                    pointHoverRadius: 6,
                    showLine: true,
                    fill: false,
                    tension: 0
                });
            });
        });

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
        // 종합 모드: 펄스별 분석 결과 카드 전체를 숨긴다 (개별 모드에서 복원)
        var tbl = $('tableGittSummary');
        var tableCard = tbl && tbl.parentElement ? tbl.parentElement.parentElement : null;
        if (tableCard) tableCard.style.display = gittCombined ? 'none' : '';
        if (gittCombined) return;
        var f = displayedGittFile();
        if (!f) {
            tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:var(--text-muted); padding:40px 0;">GITT 파일을 업로드하거나 사이드바 라이브러리에서 GITT 체크박스를 선택하면 펄스별 분석 결과가 표시됩니다.</td></tr>';
            return;
        }
        var html = '';
        filterByMode(f.pulses).forEach(function (p) {
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
        // 개별 모드: 현재 페이지 파일. 종합 모드: 선택한 파일들(File 컬럼 추가).
        var files = gittCombined ? combinedFiles() : (displayedGittFile() ? [displayedGittFile()] : []);
        if (!files.length) { alert('내보낼 GITT 분석 결과가 없습니다.'); return; }
        var header = ['Mode', 'Run', 'PulseNo', 'tau_s', 'E0_V', 'E_tau_V', 'E_eq_V', 'dEt_V', 'dEs_V', 'D_cm2_s', 'log10D'];
        if (gittCombined) header.unshift('File');
        var data = [header];
        files.forEach(function (f) {
            f.pulses.forEach(function (p) {
                var row = [p.mode, p.run, p.pulseNo, p.tau, p.E0, p.E_tau, p.E_eq, p.dEt, p.dEs,
                    p.D != null ? p.D : '', p.logD != null ? p.logD : ''];
                if (gittCombined) row.unshift(f.name);
                data.push(row);
            });
        });
        var ws = XLSX.utils.aoa_to_sheet(data);
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'GITT Results');
        var base = (files.length === 1) ? shortName(files[0].name) : ('GITT_종합_' + files.length + '개');
        if (!base) base = 'GITT';
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

        // 데이터 페이저 삽입 (업로드 카드 바로 아래)
        buildPagerUI();

        // 파라미터 입력: 현재 페이지 파일에만 적용해 D 실시간 재계산(input),
        // 입력을 마치면(change) 파일별로 IndexedDB에 저장
        ['gittLoading', 'gittVol', 'gittMolarMass'].forEach(function (id) {
            var el = $(id);
            if (!el) return;
            el.addEventListener('input', function () {
                var f = displayedGittFile();
                if (!f) return;
                f.params = readParamInputs();
                calcDiffusion();
                renderDiffusionChart();
                renderSummaryTable();
            });
            el.addEventListener('change', function () {
                persistParams(displayedGittFile());
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
            if (gittFiles.length) renderProfileChart();
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
            if (gittFiles.length) renderProfileChart();
        });

        var btnExport = $('btnExportGittXlsx');
        if (btnExport) btnExport.addEventListener('click', exportGittXlsx);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGittTab);
    else initGittTab();

    // 테스트/디버깅용 전역 노출
    window.GittAnalyzer = {
        ingestRows: ingestGittRows,
        getPulses: function () {
            var all = [];
            visibleGittFiles().forEach(function (f) { all = all.concat(f.pulses); });
            return all.length ? all : gittPulses;
        },
        getFiles: function () { return gittFiles; },
        getSegments: function () { return gittSegments; },
        activateTab: activateGittTab,
        showDataset: showGittDataset,
        setCompare: setGittCompare,
        removeDataset: removeGittDataset
    };
})();
