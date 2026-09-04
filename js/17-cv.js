/* ============================================================================
 * HC-Analyzer  ·  js/17-cv.js   (CV = Cyclic Voltammetry 분석 · 독립 모듈)
 * CV 파일(전압/전류)을 CV 탭에서 업로드 → 사이클 분리 → I-V 곡선 → 사이클 드롭다운
 * → 산화/환원 피크 전압 자동 검출. 기존 충방전 코드는 건드리지 않음. 엑셀은 js/xlsx-worker.js 재사용.
 *
 * [사이클 분리 방식]
 *  - 파일에 'Cycle No.'(사이클 번호) 컬럼이 있으면 → 그 번호를 그대로 사용(측정기 기록과 100% 일치).
 *  - 없으면 → 전압 스윕 정점(vertex) 기반 자동 검출로 폴백(구형 Index/Voltage/Current 폼 호환).
 *
 * [다중 파일 비교]
 *  - 여러 CV 파일을 올려 한 그래프에 겹쳐 볼 수 있다. 파일마다 색이 다르게 표시된다.
 *  - 사이클은 '파일마다 개별 선택'한다(각 파일 행의 드롭다운). 피크 표도 파일별로 나온다.
 * ============================================================================ */
(function () {
  'use strict';
  // 파일별 상태: { id, name, color, cycles:[{num,V,I,span,npts}], selNum }
  var cvFiles = [], cvChart = null, cvWorker = null, cvJob = 0, _fid = 0;
  var cvWindows = [];   // 사용자 지정 피크 검출 전압 구간 목록 [{min, max}]
  var _queue = [], _parsing = false;
  // 파일별 구분 색상 팔레트 (어두운 배경에서 잘 구분되는 색)
  var CV_COLORS = ['#f59e0b', '#60a5fa', '#34d399', '#f472b6', '#a78bfa', '#fbbf24', '#22d3ee', '#fb7185', '#4ade80', '#c084fc'];

  function $(id) { return document.getElementById(id); }
  function setStatus(msg) { var el = $('cvStatus'); if (el) el.textContent = msg; }

  function activateCVTab() {
    var i, els;
    els = document.querySelectorAll('.tab-btn'); for (i = 0; i < els.length; i++) els[i].classList.remove('active');
    els = document.querySelectorAll('.tab-panel'); for (i = 0; i < els.length; i++) els[i].classList.remove('active');
    var btn = $('btnTabCV'), panel = $('tab-cv');
    if (btn) btn.classList.add('active');
    if (panel) panel.classList.add('active');
    setTimeout(function () { if (cvChart) cvChart.resize(); if (k1k2Chart) k1k2Chart.resize(); }, 60);
  }

  // ---- 업로드/파싱 (여러 파일을 순차 처리) ----
  function addFiles(fileList) {
    if (!fileList || !fileList.length) return;
    for (var i = 0; i < fileList.length; i++) _queue.push(fileList[i]);
    if (!_parsing) parseNext();
  }

  function parseNext() {
    if (!_queue.length) { _parsing = false; return; }
    _parsing = true;
    var file = _queue.shift();
    setStatus('불러오는 중... (' + file.name + ')' + (_queue.length ? ' · 대기 ' + _queue.length + '개' : ''));
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var reader = new FileReader();
    if (ext === 'xlsx' || ext === 'xls') {
      reader.onload = function (e) { parseXlsxBuf(e.target.result, file.name); };
      reader.onerror = function () { setStatus('파일 읽기 실패: ' + file.name); parseNext(); };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = function (e) { onRows(splitText(e.target.result), file.name); };
      reader.onerror = function () { setStatus('파일 읽기 실패: ' + file.name); parseNext(); };
      reader.readAsText(file);
    }
  }

  function parseXlsxBuf(buf, filename) {
    try { if (!cvWorker) cvWorker = new Worker('js/xlsx-worker.js?v=4.0.0'); }
    catch (err) { setStatus('워커 생성 실패: ' + err); parseNext(); return; }
    var id = ++cvJob;
    var onMsg = function (ev) {
      if (!ev.data || ev.data.id !== id) return;
      cvWorker.removeEventListener('message', onMsg);
      if (ev.data.ok && ev.data.jsonData) onRows(ev.data.jsonData, filename);
      else { setStatus('엑셀 파싱 실패: ' + (ev.data.error || '')); parseNext(); }
    };
    cvWorker.addEventListener('message', onMsg);
    cvWorker.onerror = function (er) { setStatus('워커 오류: ' + (er && er.message || '')); };
    try { cvWorker.postMessage({ id: id, data: buf, filename: filename }, [buf]); }
    catch (e) { cvWorker.postMessage({ id: id, data: buf, filename: filename }); }
  }

  function splitText(text) {
    var lines = text.split(/\r?\n/), rows = [];
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k];
      if (line == null || line.trim() === '') continue;
      var delim = line.indexOf('\t') >= 0 ? '\t' : (line.indexOf(';') >= 0 ? ';' : ',');
      rows.push(line.split(delim));
    }
    return rows;
  }

  // 파싱 결과(2차원 배열)를 받아 파일 항목을 만든다
  function onRows(rows, filename) {
    var res = computeCycles(rows);
    if (!res) { setStatus(filename + ': 전압/전류 컬럼을 찾지 못했거나 데이터가 부족합니다.'); parseNext(); return; }
    var color = CV_COLORS[cvFiles.length % CV_COLORS.length];
    var entry = { id: 'cv' + Date.now() + '_' + (++_fid), name: filename, color: color, cycles: res.cycles, selNum: res.defaultNum };
    entry.rateData = buildRateData(rows);   // k1/k2 분석용: Time·Voltage로 스캔레이트 구간 자동 분리
    cvFiles.push(entry);
    registerCvDataset(entry);   // 데이터 라이브러리(사이드바)에 등록
    refreshFileList();
    renderAll();
    setStatus('로드됨: ' + cvFiles.length + '개 파일');
    parseNext();
  }

  // ---- 사이클 계산 (DOM/상태 건드리지 않는 순수 함수) ----
  function computeCycles(rows) {
    if (!rows || rows.length < 3) return null;
    var headerIdx = -1, vCol = -1, iCol = -1, cCol = -1, r, c;
    for (r = 0; r < Math.min(20, rows.length); r++) {
      var row = rows[r]; if (!row) continue;
      var vc = -1, ic = -1, cyc = -1;
      for (c = 0; c < row.length; c++) {
        var s = String(row[c] == null ? '' : row[c]).toLowerCase().trim();
        if (vc < 0 && (s.indexOf('voltage') >= 0 || s.indexOf('전압') >= 0 || s.indexOf('v vs') >= 0 || s === 'v' || s.indexOf('potential') >= 0)) vc = c;
        if (ic < 0 && (s.indexOf('current') >= 0 || s.indexOf('전류') >= 0 || s === 'i' || s.indexOf('(a)') >= 0 || s.indexOf('(ma)') >= 0 || s.indexOf('i(') >= 0)) ic = c;
        // 'Cycle No.'(사이클 번호) 컬럼만 인식 — 'Cycle Time' 은 제외
        if (cyc < 0 && s.indexOf('cycle') >= 0 && (s.indexOf('no') >= 0 || s.indexOf('num') >= 0 || s.indexOf('번호') >= 0 || s.indexOf('index') >= 0)) cyc = c;
      }
      if (vc >= 0 && ic >= 0) { headerIdx = r; vCol = vc; iCol = ic; cCol = cyc; break; }
    }
    if (vCol < 0 || iCol < 0) return null;
    var V = [], I = [], C = [], hasC = (cCol >= 0);
    for (var r2 = headerIdx + 1; r2 < rows.length; r2++) {
      var row2 = rows[r2]; if (!row2) continue;
      var v = parseFloat(row2[vCol]), i = parseFloat(row2[iCol]);
      if (isNaN(v) || isNaN(i)) continue;
      V.push(v); I.push(i);
      if (hasC) { var cn = parseFloat(row2[cCol]); C.push(isNaN(cn) ? null : cn); }
    }
    if (V.length < 20) return null;
    return hasC ? cyclesFromColumn(V, I, C) : cyclesAuto(V, I);
  }

  // [신규] 파일에 기록된 'Cycle No.' 값을 그대로 사용
  function cyclesFromColumn(V, I, C) {
    var groups = {}, order = [], k;
    for (k = 0; k < V.length; k++) {
      var num = C[k]; if (num == null) continue;
      if (!Object.prototype.hasOwnProperty.call(groups, num)) { groups[num] = { v: [], i: [] }; order.push(num); }
      groups[num].v.push(V[k]); groups[num].i.push(I[k]);
    }
    order.sort(function (a, b) { return a - b; });
    if (!order.length) return null;
    var globalSpan = 0;
    order.forEach(function (num) {
      var g = groups[num], mn = Infinity, mx = -Infinity;
      for (var j = 0; j < g.v.length; j++) { if (g.v[j] < mn) mn = g.v[j]; if (g.v[j] > mx) mx = g.v[j]; }
      g.span = (mx - mn) || 0; if (g.span > globalSpan) globalSpan = g.span;
    });
    var cycles = [];
    order.forEach(function (num) {
      var g = groups[num];
      var d = downsample(g.v, g.i, 0, g.v.length, 6000);
      cycles.push({ num: num, V: d.v, I: d.i, span: g.span, npts: g.v.length });
    });
    var defaultNum = cycles[0].num;
    for (k = 0; k < cycles.length; k++) { if (cycles[k].span >= globalSpan * 0.7) { defaultNum = cycles[k].num; break; } }
    return { cycles: cycles, defaultNum: defaultNum };
  }

  // [폴백] 사이클 번호가 없을 때: 전압 스윕 정점으로 자동 검출
  function cyclesAuto(V, I) {
    var cyc = detectCVCycles(V, I), cycles = [];
    cyc.forEach(function (c) {
      var d = downsample(V, I, c.a, c.end, 6000);
      cycles.push({ num: c.num, V: d.v, I: d.i, span: 0, npts: c.end - c.a });
    });
    if (!cycles.length) return null;
    return { cycles: cycles, defaultNum: cycles[Math.floor(cycles.length / 2)].num };
  }

  function detectCVCycles(V, I) {
    // 정점(vertex) 기반 검출: 전압이 상단/하단 정점 부근에 도달하는 지점을 정점으로 잡고,
    // 하단정점 → 상단정점 → 하단정점 을 한 사이클(닫힌 루프)로 묶는다. (노이즈에 견고)
    var n = V.length, k;
    var vmin = Infinity, vmax = -Infinity;
    for (k = 0; k < n; k++) { if (V[k] < vmin) vmin = V[k]; if (V[k] > vmax) vmax = V[k]; }
    var span = vmax - vmin;
    if (span <= 0) return [];
    var hiThr = vmax - span * 0.15, loThr = vmin + span * 0.15;
    var verts = [], zone = 0, extIdx = -1, extVal = 0;
    for (k = 0; k < n; k++) {
      if (V[k] >= hiThr) {
        if (zone !== 1) {
          if (zone === -1 && extIdx >= 0) verts.push({ idx: extIdx, type: 'lo' });
          zone = 1; extIdx = k; extVal = V[k];
        } else if (V[k] > extVal) { extVal = V[k]; extIdx = k; }
      } else if (V[k] <= loThr) {
        if (zone !== -1) {
          if (zone === 1 && extIdx >= 0) verts.push({ idx: extIdx, type: 'hi' });
          zone = -1; extIdx = k; extVal = V[k];
        } else if (V[k] < extVal) { extVal = V[k]; extIdx = k; }
      }
    }
    if (zone === 1 && extIdx >= 0) verts.push({ idx: extIdx, type: 'hi' });
    else if (zone === -1 && extIdx >= 0) verts.push({ idx: extIdx, type: 'lo' });
    var loV = [], hiV = [];
    for (k = 0; k < verts.length; k++) { if (verts[k].type === 'lo') loV.push(verts[k].idx); else hiV.push(verts[k].idx); }
    var cycles = [], num = 0;
    for (var j = 0; j < loV.length - 1; j++) {
      var a = loV[j], end = loV[j + 1], mid = -1;
      for (var h = 0; h < hiV.length; h++) { if (hiV[h] > a && hiV[h] < end) { mid = hiV[h]; break; } }
      if (mid < 0) continue;
      num++;
      cycles.push({ num: num, a: a, mid: mid, end: end });
    }
    return cycles;
  }

  function downsample(V, I, a, b, maxN) {
    var len = b - a, v = [], ii = [], k;
    if (len <= maxN) { for (k = a; k < b; k++) { v.push(V[k]); ii.push(I[k]); } return { v: v, i: ii }; }
    var step = Math.ceil(len / maxN);
    for (k = a; k < b; k += step) { v.push(V[k]); ii.push(I[k]); }
    if (v.length === 0 || v[v.length - 1] !== V[b - 1]) { v.push(V[b - 1]); ii.push(I[b - 1]); }
    return { v: v, i: ii };
  }

  // ---- 파일 목록 UI (색상 · 사이클 개별 선택 · 제거) ----
  function refreshFileList() {
    var el = $('cvFileList'); if (!el) return;
    el.innerHTML = '';
    cvFiles.forEach(function (f) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:10px; background:var(--bg-card); border:1px solid var(--border-color); border-radius:8px; padding:8px 12px; flex-wrap:wrap;';
      var sw = document.createElement('span');
      sw.style.cssText = 'width:14px; height:14px; border-radius:3px; flex:none; background:' + f.color + ';';
      var nm = document.createElement('span');
      nm.textContent = f.name;
      nm.title = f.name;
      nm.style.cssText = 'font-size:12px; color:var(--text); flex:1; min-width:140px; word-break:break-all;';
      var lab = document.createElement('span');
      lab.textContent = '사이클'; lab.style.cssText = 'font-size:11px; color:var(--text-muted);';
      var sel = document.createElement('select');
      sel.className = 'select-field'; sel.style.cssText = 'margin-bottom:0; height:30px; width:110px;';
      f.cycles.forEach(function (cc) { var o = document.createElement('option'); o.value = cc.num; o.textContent = cc.num + ' 사이클'; sel.appendChild(o); });
      sel.value = f.selNum;
      sel.addEventListener('change', function () { f.selNum = parseFloat(this.value); renderAll(); });
      var rm = document.createElement('button');
      rm.textContent = '✕'; rm.title = '이 파일 제거';
      rm.style.cssText = 'background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:14px; line-height:1; padding:2px 4px;';
      rm.addEventListener('click', function () { removeFile(f.id); });
      row.appendChild(sw); row.appendChild(nm); row.appendChild(lab); row.appendChild(sel); row.appendChild(rm);
      el.appendChild(row);
    });
  }

  function removeFile(id) {
    cvFiles = cvFiles.filter(function (f) { return f.id !== id; });
    refreshFileList();
    renderAll();
    setStatus(cvFiles.length ? (cvFiles.length + '개 파일') : 'CV 파일을 업로드하세요.');
    // 데이터 라이브러리 항목도 함께 제거(동기화)
    if (typeof datasetLibrary !== 'undefined') {
      var idx = -1, i;
      for (i = 0; i < datasetLibrary.length; i++) { if (datasetLibrary[i].id === id) { idx = i; break; } }
      if (idx >= 0) {
        datasetLibrary.splice(idx, 1);
        if (typeof deleteDatasetFromDB === 'function') { try { Promise.resolve(deleteDatasetFromDB(id)).catch(function () {}); } catch (e) {} }
        if (typeof renderDatasetLibraryUI === 'function') renderDatasetLibraryUI();
        if (typeof renderLibraryTable === 'function') renderLibraryTable();
      }
    }
  }

  function getCycle(f, num) {
    for (var k = 0; k < f.cycles.length; k++) { if (f.cycles[k].num == num) return f.cycles[k]; }
    return null;
  }

  // 라이브러리 체크박스(compareEnabled)로 표시 여부 판단. 라이브러리에 없으면 기본 표시.
  function isEnabled(f) {
    if (typeof datasetLibrary === 'undefined') return true;
    for (var i = 0; i < datasetLibrary.length; i++) {
      if (datasetLibrary[i].id === f.id) return datasetLibrary[i].compareEnabled !== false;
    }
    return true;
  }

  // ---- 그래프 + 피크표 렌더 (체크된 파일만 오버레이) ----
  function renderAll() {
    var datasets = [], xmin = Infinity, xmax = -Infinity;
    cvFiles.forEach(function (f) {
      if (!isEnabled(f)) return;                 // 라이브러리 체크 해제 → 그래프에서 숨김
      var cc = getCycle(f, f.selNum); if (!cc) return;
      var pts = [], j;
      for (j = 0; j < cc.V.length; j++) {
        pts.push({ x: cc.V[j], y: cc.I[j] * 1000 });
        if (cc.V[j] < xmin) xmin = cc.V[j];
        if (cc.V[j] > xmax) xmax = cc.V[j];
      }
      datasets.push({
        label: f.name + ' · ' + f.selNum + '사이클',
        data: pts, borderColor: f.color, backgroundColor: f.color,
        borderWidth: 1.3, pointRadius: 0, showLine: true, fill: false, tension: 0
      });
    });
    renderCVChart(datasets, xmin, xmax);
    renderPeakTable();
    renderK1K2();
  }

  function renderCVChart(datasets, xmin, xmax) {
    var el = $('chartCV'); if (!el || typeof Chart === 'undefined') return;
    var ctx = el.getContext('2d');
    if (cvChart) { cvChart.destroy(); cvChart = null; }
    if (!datasets.length) return;
    // 데이터 기준 x축(전압) 범위를 명시 → CV 루프(시작·끝 전압 동일)에서 축 붕괴 방지
    if (!isFinite(xmin)) { xmin = 0; xmax = 1; }
    // 설정한 전압 구간을 그래프에 반투명 밴드로 표시
    var bandPlugin = {
      id: 'cvWindowBands',
      beforeDatasetsDraw: function (chart) {
        if (!cvWindows.length) return;
        var xs = chart.scales.x, area = chart.chartArea, c = chart.ctx;
        c.save(); c.fillStyle = 'rgba(148,163,184,0.12)';
        cvWindows.forEach(function (w) {
          if (w.min == null || w.max == null || isNaN(w.min) || isNaN(w.max)) return;
          var x1 = xs.getPixelForValue(Math.min(w.min, w.max));
          var x2 = xs.getPixelForValue(Math.max(w.min, w.max));
          c.fillRect(x1, area.top, x2 - x1, area.bottom - area.top);
        });
        c.restore();
      }
    };
    cvChart = new Chart(ctx, {
      type: 'line',
      data: { datasets: datasets },
      plugins: [bandPlugin],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: { type: 'linear', min: xmin, max: xmax, title: { display: true, text: 'Voltage (V)', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.06)' } },
          y: { title: { display: true, text: 'Current (mA)', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.06)' } }
        },
        plugins: {
          legend: { display: true, labels: { color: '#cbd5e1', boxWidth: 14, font: { size: 11 } } },
          tooltip: { enabled: true }
        }
      }
    });
  }

  function smooth(arr, w) {
    var n = arr.length; if (n < w || w < 3) return arr.slice();
    var ps = new Array(n + 1); ps[0] = 0;
    for (var k = 0; k < n; k++) ps[k + 1] = ps[k] + arr[k];
    var out = new Array(n), half = (w / 2) | 0;
    for (k = 0; k < n; k++) { var lo = Math.max(0, k - half), hi = Math.min(n, k + half + 1); out[k] = (ps[hi] - ps[lo]) / (hi - lo); }
    return out;
  }

  function findPeaks(Vseg, Iseg, wantMax, sens) {
    var n = Iseg.length, k; if (n < 20) return [];
    var w = Math.max(9, Math.round(n / 80)); if (w % 2 === 0) w++;
    var sm = smooth(Iseg, w);
    var ys = wantMax ? sm : sm.map(function (x) { return -x; });
    var vmin = Infinity, vmax = -Infinity;
    for (k = 0; k < n; k++) { if (Vseg[k] < vmin) vmin = Vseg[k]; if (Vseg[k] > vmax) vmax = Vseg[k]; }
    var vspan = vmax - vmin, vmargin = vspan * 0.06;
    var iyMin = Infinity, iyMax = -Infinity;
    for (k = 0; k < n; k++) { if (Vseg[k] - vmin > vmargin && vmax - Vseg[k] > vmargin) { if (ys[k] < iyMin) iyMin = ys[k]; if (ys[k] > iyMax) iyMax = ys[k]; } }
    if (!isFinite(iyMin)) return [];
    var amp = iyMax - iyMin; if (amp <= 0) return [];
    var thr = amp * sens, ptsPerV = n / Math.max(1e-9, vspan), pw = Math.max(5, Math.round(ptsPerV * 0.15));
    var cands = [];
    for (k = 2; k < n - 2; k++) {
      if (Vseg[k] - vmin <= vmargin || vmax - Vseg[k] <= vmargin) continue;
      if (ys[k] > ys[k - 1] && ys[k] >= ys[k + 1] && ys[k] > ys[k - 2] && ys[k] >= ys[k + 2]) {
        var lo = Math.max(0, k - pw), hi = Math.min(n, k + pw + 1), j, leftMin = Infinity, rightMin = Infinity;
        for (j = k; j >= lo; j--) if (ys[j] < leftMin) leftMin = ys[j];
        for (j = k; j < hi; j++) if (ys[j] < rightMin) rightMin = ys[j];
        var prom = ys[k] - Math.max(leftMin, rightMin);
        if (prom >= thr) cands.push({ idx: k, prom: prom });
      }
    }
    cands.sort(function (a, b) { return b.prom - a.prom; });
    var picked = [];
    cands.forEach(function (cd) {
      var vv = Vseg[cd.idx], ok = true;
      for (var p = 0; p < picked.length; p++) { if (Math.abs(Vseg[picked[p].idx] - vv) < 0.08) { ok = false; break; } }
      if (ok && picked.length < 4) picked.push(cd);
    });
    picked.sort(function (a, b) { return Vseg[a.idx] - Vseg[b.idx]; });
    return picked.map(function (cd) { return { v: Vseg[cd.idx], i: Iseg[cd.idx] }; });
  }

  function detectPeaks(cc) {
    // 산화(anodic)=양(+)전류 구간, 환원(cathodic)=음(-)전류 구간으로 나눠 자동 검출
    var aV = [], aI = [], cV = [], cI = [], k, SENS = 0.08;
    for (k = 0; k < cc.V.length; k++) {
      if (cc.I[k] > 0) { aV.push(cc.V[k]); aI.push(cc.I[k]); }
      else if (cc.I[k] < 0) { cV.push(cc.V[k]); cI.push(cc.I[k]); }
    }
    return { anodic: findPeaks(aV, aI, true, SENS), cathodic: findPeaks(cV, cI, false, SENS) };
  }

  // 유효한(숫자 min/max) 전압 구간만 추림. type: 'anodic'|'cathodic'|'both'(기본)
  function validWindows() {
    return cvWindows.filter(function (w) {
      return w && w.min != null && w.max != null && !isNaN(w.min) && !isNaN(w.max) && w.min !== w.max;
    }).map(function (w) { return { min: Math.min(w.min, w.max), max: Math.max(w.min, w.max), type: w.type || 'both' }; })
      .sort(function (a, b) { return a.min - b.min; });
  }

  // [신규] 사용자 지정 전압 구간마다 선택한 종류의 피크를 찾는다.
  //   type='anodic' → 산화(+I 최대)만, 'cathodic' → 환원(-I 최소)만, 'both' → 둘 다.
  function peaksInWindows(cc, wins) {
    return wins.map(function (w) {
      var aBest = null, cBest = null, k;
      var wantA = (w.type !== 'cathodic'), wantC = (w.type !== 'anodic');
      for (k = 0; k < cc.V.length; k++) {
        var v = cc.V[k], i = cc.I[k];
        if (v < w.min || v > w.max) continue;
        if (wantA && i > 0) { if (!aBest || i > aBest.i) aBest = { v: v, i: i }; }
        else if (wantC && i < 0) { if (!cBest || i < cBest.i) cBest = { v: v, i: i }; }
      }
      return { min: w.min, max: w.max, type: w.type, anodic: aBest, cathodic: cBest };
    });
  }

  function fmtPeak(p) {
    if (!p) return '<span style="color:#6b7280;">-</span>';
    return p.v.toFixed(3) + ' V <span style="color:#9ca3af;">(' + (p.i * 1000).toFixed(3) + ' mA)</span>';
  }

  function renderPeakTable() {
    var el = $('cvPeakTable'); if (!el) return;
    var files = cvFiles.filter(isEnabled);
    if (!files.length) { el.innerHTML = '<span style="color:#6b7280; font-size:12px;">파일을 로드하면 산화·환원 피크가 표시됩니다.</span>'; return; }
    var wins = validWindows();
    var html = '';
    files.forEach(function (f) {
      var cc = getCycle(f, f.selNum);
      html += '<div style="margin-bottom:12px;">'
        + '<div style="font-size:12px; font-weight:600; margin-bottom:4px; color:' + f.color + ';">● ' + f.name + ' · ' + f.selNum + '사이클</div>';
      if (wins.length) {
        // 구간 모드: 각 전압 구간에서 '선택한 종류'의 피크만 표시
        var rows = cc ? peaksInWindows(cc, wins) : [];
        html += '<table style="width:100%; border-collapse:collapse; font-size:12px;">'
          + '<thead><tr style="color:#9ca3af; text-align:left; border-bottom:1px solid rgba(255,255,255,0.12);"><th style="padding:3px 6px;">전압 구간</th><th style="padding:3px 6px;">종류</th><th style="padding:3px 6px;">Peak Voltage (Current)</th></tr></thead><tbody>';
        rows.forEach(function (r) {
          var range = r.min.toFixed(2) + ' ~ ' + r.max.toFixed(2) + ' V';
          if (r.type !== 'cathodic') {
            html += '<tr><td style="padding:3px 6px;">' + range + '</td><td style="padding:3px 6px;color:#f59e0b;font-weight:600;">산화 (Anodic)</td><td style="padding:3px 6px;">' + fmtPeak(r.anodic) + '</td></tr>';
          }
          if (r.type !== 'anodic') {
            html += '<tr><td style="padding:3px 6px;">' + range + '</td><td style="padding:3px 6px;color:#60a5fa;font-weight:600;">환원 (Cathodic)</td><td style="padding:3px 6px;">' + fmtPeak(r.cathodic) + '</td></tr>';
          }
        });
        html += '</tbody></table>';
      } else {
        // 구간 미설정: 기존 자동 검출
        var pk = cc ? detectPeaks(cc) : { anodic: [], cathodic: [] };
        function rowsFor(list, label, color) {
          if (!list.length) return '<tr><td style="padding:3px 6px;color:' + color + ';font-weight:600;">' + label + '</td><td style="padding:3px 6px;color:#6b7280;" colspan="2">검출된 피크 없음</td></tr>';
          return list.map(function (p) {
            return '<tr><td style="padding:3px 6px;color:' + color + ';font-weight:600;">' + label + '</td><td style="padding:3px 6px;">' + p.v.toFixed(3) + ' V</td><td style="padding:3px 6px;color:#9ca3af;">' + (p.i * 1000).toFixed(3) + ' mA</td></tr>';
          }).join('');
        }
        html += '<table style="width:100%; border-collapse:collapse; font-size:12px;">'
          + '<thead><tr style="color:#9ca3af; text-align:left; border-bottom:1px solid rgba(255,255,255,0.12);"><th style="padding:3px 6px;">구분</th><th style="padding:3px 6px;">Voltage</th><th style="padding:3px 6px;">Peak Current</th></tr></thead>'
          + '<tbody>' + rowsFor(pk.anodic, '산화 (Anodic)', '#f59e0b') + rowsFor(pk.cathodic, '환원 (Cathodic)', '#60a5fa') + '</tbody></table>';
      }
      html += '</div>';
    });
    el.innerHTML = html;
  }

  // ---- 피크 검출 전압 구간 편집 UI ----
  function renderWindowList() {
    var el = $('cvWindowList'); if (!el) return;
    el.innerHTML = '';
    if (!cvWindows.length) {
      el.innerHTML = '<div style="font-size:11px; color:var(--text-muted);">설정한 구간이 없습니다. 구간을 추가하면 각 구간의 피크를, 없으면 자동 검출 결과를 표시합니다.</div>';
      return;
    }
    cvWindows.forEach(function (w, idx) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap;';
      var mn = document.createElement('input');
      mn.type = 'number'; mn.step = '0.01'; mn.placeholder = '최소 V';
      mn.className = 'select-field'; mn.style.cssText = 'margin-bottom:0; height:30px; width:90px;';
      if (w.min != null && !isNaN(w.min)) mn.value = w.min;
      mn.addEventListener('input', function () { var v = parseFloat(this.value); cvWindows[idx].min = isNaN(v) ? null : v; renderAll(); });
      var tilde = document.createElement('span'); tilde.textContent = '~'; tilde.style.color = 'var(--text-muted)';
      var mx = document.createElement('input');
      mx.type = 'number'; mx.step = '0.01'; mx.placeholder = '최대 V';
      mx.className = 'select-field'; mx.style.cssText = 'margin-bottom:0; height:30px; width:90px;';
      if (w.max != null && !isNaN(w.max)) mx.value = w.max;
      mx.addEventListener('input', function () { var v = parseFloat(this.value); cvWindows[idx].max = isNaN(v) ? null : v; renderAll(); });
      // 피크 종류 선택: 산화 / 환원 / 둘 다
      var kind = document.createElement('select');
      kind.className = 'select-field'; kind.style.cssText = 'margin-bottom:0; height:30px; width:90px;';
      [['anodic', '산화'], ['cathodic', '환원'], ['both', '둘 다']].forEach(function (o) {
        var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; kind.appendChild(op);
      });
      kind.value = w.type || 'both';
      kind.addEventListener('change', function () { cvWindows[idx].type = this.value; renderAll(); });
      var rm = document.createElement('button');
      rm.textContent = '✕'; rm.title = '구간 삭제';
      rm.style.cssText = 'background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:14px; line-height:1; padding:2px 4px;';
      rm.addEventListener('click', function () { cvWindows.splice(idx, 1); renderWindowList(); renderAll(); });
      row.appendChild(document.createTextNode('구간 ' + (idx + 1) + '  '));
      row.appendChild(mn); row.appendChild(tilde); row.appendChild(mx); row.appendChild(kind); row.appendChild(rm);
      el.appendChild(row);
    });
  }

  function addWindow() {
    cvWindows.push({ min: null, max: null, type: 'anodic' });
    renderWindowList();
  }

  // ==========================================================================
  // k1/k2 (Dunn) 분석 — capacitive vs diffusion 기여도 정량 분리
  //   i(V) = k1(V)·v + k2(V)·v^1/2   (v = scan rate)
  //   → i/v^1/2 = k1·v^1/2 + k2  의 전압별 선형 회귀로 k1, k2 산출.
  //   스캔레이트는 파일의 Time·Voltage 로 자동 계산(ΔV/Δt), 한 사이클에 섞인 여러 rate를 분리.
  // ==========================================================================
  var _k1k2 = { fileId: null, branch: 'anodic', excluded: {} };  // excluded: {rate:true}
  var k1k2Chart = null;

  // 파일 원본 행에서 스캔레이트 구간을 만든다.
  //  반환: { cycleNum: { anodic:[{rate,V[],I[]}], cathodic:[...] } }  (Time 컬럼 없으면 null)
  function buildRateData(rows) {
    if (!rows || rows.length < 3) return null;
    var headerIdx = -1, tCol = -1, vCol = -1, iCol = -1, cCol = -1, sCol = -1, r, c;
    for (r = 0; r < Math.min(20, rows.length); r++) {
      var row = rows[r]; if (!row) continue;
      var tc = -1, vc = -1, ic = -1, cyc = -1, stp = -1;
      for (c = 0; c < row.length; c++) {
        var s = String(row[c] == null ? '' : row[c]).toLowerCase().trim();
        if (tc < 0 && (s.indexOf('test time') >= 0 || s === 'time' || (s.indexOf('time') >= 0 && s.indexOf('(s)') >= 0) || s.indexOf('시험 시간') >= 0 || (s.indexOf('시간') >= 0 && s.indexOf('스텝') < 0))) tc = c;
        if (vc < 0 && (s.indexOf('voltage') >= 0 || s.indexOf('전압') >= 0 || s === 'v' || s.indexOf('potential') >= 0)) vc = c;
        if (ic < 0 && (s.indexOf('current') >= 0 || s.indexOf('전류') >= 0 || s === 'i' || s.indexOf('(a)') >= 0 || s.indexOf('(ma)') >= 0)) ic = c;
        if (cyc < 0 && s.indexOf('cycle') >= 0 && (s.indexOf('no') >= 0 || s.indexOf('num') >= 0 || s.indexOf('번호') >= 0)) cyc = c;
        if (stp < 0 && s.indexOf('step') >= 0 && s.indexOf('no') >= 0) stp = c;
      }
      if (vc >= 0 && ic >= 0 && tc >= 0) { headerIdx = r; tCol = tc; vCol = vc; iCol = ic; cCol = cyc; sCol = stp; break; }
    }
    if (tCol < 0 || vCol < 0 || iCol < 0) return null;   // Time 없으면 스캔레이트 자동계산 불가

    // 행 수집
    var T = [], V = [], I = [], C = [], S = [];
    for (var r2 = headerIdx + 1; r2 < rows.length; r2++) {
      var row2 = rows[r2]; if (!row2) continue;
      var t = parseFloat(row2[tCol]), v = parseFloat(row2[vCol]), i = parseFloat(row2[iCol]);
      if (isNaN(t) || isNaN(v) || isNaN(i)) continue;
      T.push(t); V.push(v); I.push(i);
      C.push(cCol >= 0 ? parseFloat(row2[cCol]) : 0);
      S.push(sCol >= 0 ? row2[sCol] : 0);
    }
    if (V.length < 20) return null;

    // 사이클별 처리
    var byCyc = {}, order = [], k;
    for (k = 0; k < V.length; k++) {
      var cn = isNaN(C[k]) ? 0 : C[k];
      if (!Object.prototype.hasOwnProperty.call(byCyc, cn)) { byCyc[cn] = []; order.push(cn); }
      byCyc[cn].push(k);
    }
    var out = {};
    order.forEach(function (cn) {
      var idx = byCyc[cn];
      // 사이클 전압 범위
      var vmn = Infinity, vmx = -Infinity, j;
      for (j = 0; j < idx.length; j++) { var vv = V[idx[j]]; if (vv < vmn) vmn = vv; if (vv > vmx) vmx = vv; }
      var cycSpan = vmx - vmn; if (cycSpan <= 0) return;
      // 이 사이클에 Step 정보가 있으면 스텝 변화로만 분할(가장 견고),
      // 없으면 전압 스윕 방향 반전(정점)으로 분할.
      var hasStep = false;
      for (j = 1; j < idx.length; j++) { if (S[idx[j]] !== S[idx[0]]) { hasStep = true; break; } }
      var segs = [], segStart = 0;
      if (hasStep) {
        for (j = 1; j < idx.length; j++) {
          if (S[idx[j]] !== S[idx[j - 1]]) { segs.push([segStart, j - 1]); segStart = j; }
        }
      } else {
        // 정점 기반: 전압이 상단/하단 임계에 도달할 때마다 방향 전환점을 경계로
        var hiThr = vmx - cycSpan * 0.1, loThr = vmn + cycSpan * 0.1, zone = 0;
        for (j = 0; j < idx.length; j++) {
          var vv2 = V[idx[j]];
          if (vv2 >= hiThr) { if (zone === -1) { segs.push([segStart, j - 1]); segStart = j; } zone = 1; }
          else if (vv2 <= loThr) { if (zone === 1) { segs.push([segStart, j - 1]); segStart = j; } zone = -1; }
        }
      }
      segs.push([segStart, idx.length - 1]);
      var anodic = [], cathodic = [];
      segs.forEach(function (sg) {
        var a = sg[0], b = sg[1]; if (b - a < 10) return;
        var svmn = Infinity, svmx = -Infinity, p;
        for (p = a; p <= b; p++) { var x = V[idx[p]]; if (x < svmn) svmn = x; if (x > svmx) svmx = x; }
        if (svmx - svmn < 0.7 * cycSpan) return;               // 전 구간 스윕만 사용(formation 조각 제외)
        var dt = T[idx[b]] - T[idx[a]]; if (dt <= 0) return;
        var rate = Math.round((svmx - svmn) / dt * 1000 * 100) / 100;   // mV/s, 소수 2자리
        if (rate <= 0) return;
        var up = V[idx[b]] > V[idx[a]];
        // V 기준 정렬 + 다운샘플
        var pts = [];
        for (p = a; p <= b; p++) pts.push([V[idx[p]], I[idx[p]]]);
        pts.sort(function (m, n) { return m[0] - n[0]; });
        var maxN = 500, Vs = [], Is = [], step = pts.length > maxN ? Math.ceil(pts.length / maxN) : 1;
        for (p = 0; p < pts.length; p += step) { Vs.push(pts[p][0]); Is.push(pts[p][1]); }
        (up ? anodic : cathodic).push({ rate: rate, V: Vs, I: Is });
      });
      if (anodic.length || cathodic.length) out[cn] = { anodic: anodic, cathodic: cathodic };
    });
    return Object.keys(out).length ? out : null;
  }

  function _interp(x, xs, ys) {
    var n = xs.length; if (x <= xs[0]) return ys[0]; if (x >= xs[n - 1]) return ys[n - 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    var t = (x - xs[lo]) / (xs[hi] - xs[lo]); return ys[lo] + t * (ys[hi] - ys[lo]);
  }

  // k1/k2 계산. 반환 null 또는 결과객체.
  function computeK1K2(f) {
    if (!f || !f.rateData) return null;
    var rd = f.rateData[f.selNum]; if (!rd) return null;
    var branchArr = (_k1k2.branch === 'cathodic') ? rd.cathodic : rd.anodic;
    if (!branchArr || !branchArr.length) return null;
    // rate별 대표 스윕(같은 rate 여러개면 첫 번째) + 제외 적용
    var byRate = {};
    branchArr.forEach(function (sg) { if (!byRate[sg.rate]) byRate[sg.rate] = sg; });
    var rates = Object.keys(byRate).map(parseFloat).sort(function (a, b) { return a - b; });
    rates = rates.filter(function (r) { return !_k1k2.excluded[r]; });
    if (rates.length < 2) return { rates: rates, tooFew: true };
    // 공통 전압 그리드
    var lo = -Infinity, hi = Infinity;
    rates.forEach(function (r) { var V = byRate[r].V; if (V[0] > lo) lo = V[0]; if (V[V.length - 1] < hi) hi = V[V.length - 1]; });
    lo += 0.02; hi -= 0.02; if (hi <= lo) return null;
    var N = 260, grid = [], g;
    for (g = 0; g < N; g++) grid.push(lo + (hi - lo) * g / (N - 1));
    var varr = rates.map(function (r) { return r / 1000; }), sq = varr.map(Math.sqrt);
    var imat = rates.map(function (r) { var sg = byRate[r]; return grid.map(function (x) { return _interp(x, sg.V, sg.I); }); });
    // 전압별 최소제곱: 설계행렬 [v, sqrt(v)]
    var k1 = new Array(N), k2 = new Array(N);
    var Sxx = 0, Sxz = 0, Szz = 0;
    for (var j = 0; j < rates.length; j++) { Sxx += varr[j] * varr[j]; Sxz += varr[j] * sq[j]; Szz += sq[j] * sq[j]; }
    var det = Sxx * Szz - Sxz * Sxz;
    for (g = 0; g < N; g++) {
      var Sxy = 0, Szy = 0;
      for (j = 0; j < rates.length; j++) { Sxy += varr[j] * imat[j][g]; Szy += sq[j] * imat[j][g]; }
      k1[g] = (Sxy * Szz - Szy * Sxz) / det;
      k2[g] = (Sxx * Szy - Sxz * Sxy) / det;
    }
    // 기여도(%) — 전하 적분 기준
    function trapzAbs(arr) { var s = 0; for (var i = 1; i < N; i++) s += (Math.abs(arr[i]) + Math.abs(arr[i - 1])) / 2 * (grid[i] - grid[i - 1]); return s; }
    var contribution = rates.map(function (r, ri) {
      var v = r / 1000, cap = grid.map(function (_, gg) { return k1[gg] * v; });
      var pct = trapzAbs(cap) / trapzAbs(imat[ri]) * 100;
      return { rate: r, pct: pct };
    });
    // b-value (log Ipeak vs log v) — 피크 전류 기반(안정적)
    var ipeak = rates.map(function (r) { var I = byRate[r].I, mx = -Infinity, mn = Infinity, p; for (p = 0; p < I.length; p++) { if (I[p] > mx) mx = I[p]; if (I[p] < mn) mn = I[p]; } return _k1k2.branch === 'cathodic' ? Math.abs(mn) : mx; });
    var bVal = null;
    if (rates.length >= 2) {
      var lx = rates.map(function (r) { return Math.log(r); }), ly = ipeak.map(function (x) { return Math.log(Math.abs(x) || 1e-12); });
      var n = rates.length, mx2 = 0, my = 0, i2; for (i2 = 0; i2 < n; i2++) { mx2 += lx[i2]; my += ly[i2]; } mx2 /= n; my /= n;
      var num = 0, den = 0; for (i2 = 0; i2 < n; i2++) { num += (lx[i2] - mx2) * (ly[i2] - my); den += (lx[i2] - mx2) * (lx[i2] - mx2); }
      bVal = den ? num / den : null;
    }
    var dispRate = rates[rates.length - 1];  // 그래프 표시용: 가장 빠른 rate
    var dispV = dispRate / 1000;
    var capCurve = grid.map(function (_, gg) { return k1[gg] * dispV * 1000; });   // mA
    var totCurve = imat[rates.length - 1].map(function (x) { return x * 1000; });   // mA
    return {
      rates: rates, allRates: Object.keys(byRate).map(parseFloat).sort(function (a, b) { return a - b; }),
      grid: grid, contribution: contribution, bVal: bVal,
      dispRate: dispRate, capCurve: capCurve, totCurve: totCurve
    };
  }

  function currentK1K2File() {
    var i;
    if (_k1k2.fileId) { for (i = 0; i < cvFiles.length; i++) if (cvFiles[i].id === _k1k2.fileId) return cvFiles[i]; }
    // 기본: rateData 가 있는 첫 파일
    for (i = 0; i < cvFiles.length; i++) if (cvFiles[i].rateData) return cvFiles[i];
    return cvFiles[0] || null;
  }

  // 파일/사이클/스윕이 바뀔 때 1회: formation 등 이상치(가장 느린 rate가 다음의 0.5배 미만)를 기본 제외
  function autoInitExclude(f) {
    var key = f.id + '|' + f.selNum + '|' + _k1k2.branch;
    if (_k1k2.initKey === key) return;
    _k1k2.initKey = key; _k1k2.excluded = {};
    var rd = f.rateData && f.rateData[f.selNum]; if (!rd) return;
    var arr = (_k1k2.branch === 'cathodic' ? rd.cathodic : rd.anodic) || [];
    var rs = {}; arr.forEach(function (s) { rs[s.rate] = 1; });
    var rates = Object.keys(rs).map(parseFloat).sort(function (a, b) { return a - b; });
    while (rates.length >= 3 && rates[0] < 0.5 * rates[1]) { _k1k2.excluded[rates[0]] = true; rates.shift(); }
  }

  function renderK1K2() {
    var host = $('cvK1K2'); if (!host) return;
    var f = currentK1K2File();
    if (f) autoInitExclude(f);
    // 컨트롤 영역
    var ctrl = $('cvK1K2Controls');
    if (ctrl) {
      var html = '';
      // 파일 선택
      html += '<label style="font-size:11px;color:var(--text-muted);">파일</label> ';
      html += '<select id="k1k2File" class="select-field" style="margin-bottom:0;height:30px;min-width:180px;">';
      cvFiles.forEach(function (cf) { html += '<option value="' + cf.id + '"' + (f && cf.id === f.id ? ' selected' : '') + '>' + cf.name + '</option>'; });
      html += '</select> ';
      html += '<label style="font-size:11px;color:var(--text-muted);margin-left:8px;">스윕</label> ';
      html += '<select id="k1k2Branch" class="select-field" style="margin-bottom:0;height:30px;width:90px;">'
        + '<option value="anodic"' + (_k1k2.branch === 'anodic' ? ' selected' : '') + '>산화</option>'
        + '<option value="cathodic"' + (_k1k2.branch === 'cathodic' ? ' selected' : '') + '>환원</option></select>';
      ctrl.innerHTML = html;
      var fsel = $('k1k2File'); if (fsel) fsel.addEventListener('change', function () { _k1k2.fileId = this.value; _k1k2.excluded = {}; renderK1K2(); });
      var bsel = $('k1k2Branch'); if (bsel) bsel.addEventListener('change', function () { _k1k2.branch = this.value; renderK1K2(); });
    }

    var res = $('cvK1K2Result');
    if (!f) { if (res) res.innerHTML = '<span style="color:#6b7280;font-size:12px;">CV 파일을 업로드하면 k1/k2 분석이 표시됩니다.</span>'; drawK1K2(null); return; }
    if (!f.rateData || !f.rateData[f.selNum]) {
      if (res) res.innerHTML = '<span style="color:#6b7280;font-size:12px;">이 파일/사이클에서는 스캔레이트를 계산할 수 없습니다. (Time 컬럼과 한 사이클 내 여러 스캔레이트가 필요합니다)</span>';
      drawK1K2(null); return;
    }
    var out = computeK1K2(f);
    if (!out) { if (res) res.innerHTML = '<span style="color:#6b7280;font-size:12px;">스캔레이트 구간을 찾지 못했습니다.</span>'; drawK1K2(null); return; }

    // 검출된 rate 체크박스 (제외/포함)
    var chips = '<div style="margin:2px 0 8px;font-size:11px;color:var(--text-muted);">검출된 스캔레이트(체크 해제 시 fitting 제외):</div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">';
    (out.allRates || out.rates).forEach(function (r) {
      var on = !_k1k2.excluded[r];
      chips += '<label style="font-size:12px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" data-rate="' + r + '"' + (on ? ' checked' : '') + '> ' + r + ' mV/s</label>';
    });
    chips += '</div>';

    if (out.tooFew) {
      res.innerHTML = chips + '<span style="color:#fbbf24;font-size:12px;">fitting에는 스캔레이트가 최소 2개 필요합니다.</span>';
      bindRateChecks(); drawK1K2(null); return;
    }

    // 결과 표
    var warn = '';
    var over = out.contribution.some(function (x) { return x.pct > 100 || x.pct < 0; });
    if (over || (out.bVal != null && out.bVal > 1.1)) {
      warn = '<div style="margin-top:8px;font-size:11px;color:#fbbf24;line-height:1.5;">⚠ 기여도가 0~100% 범위를 벗어나거나 b>1 이면, redox 피크가 스캔레이트에 따라 크게 이동해 고정-전압 k1/k2 방법의 전제가 약해진 경우입니다(날카로운 배터리 피크에서 흔함). b-value(피크 전류 기반)와 함께 해석하세요.</div>';
    }
    var rowsHtml = out.contribution.map(function (x) {
      return '<tr><td style="padding:3px 6px;">' + x.rate + ' mV/s</td><td style="padding:3px 6px;">' + x.pct.toFixed(1) + ' %</td><td style="padding:3px 6px;color:#9ca3af;">' + (100 - x.pct).toFixed(1) + ' %</td></tr>';
    }).join('');
    res.innerHTML = chips
      + '<div style="font-size:12px;margin-bottom:6px;">b-value (peak, ' + (_k1k2.branch === 'cathodic' ? '환원' : '산화') + '): <b>' + (out.bVal != null ? out.bVal.toFixed(3) : '-') + '</b> <span style="color:#9ca3af;">(0.5≈확산지배 · 1.0≈표면/용량성)</span></div>'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="color:#9ca3af;text-align:left;border-bottom:1px solid rgba(255,255,255,0.12);">'
      + '<th style="padding:3px 6px;">Scan rate</th><th style="padding:3px 6px;color:#f59e0b;">Capacitive</th><th style="padding:3px 6px;color:#60a5fa;">Diffusion</th></tr></thead><tbody>'
      + rowsHtml + '</tbody></table>' + warn;
    bindRateChecks();
    drawK1K2(out);
  }

  function bindRateChecks() {
    var res = $('cvK1K2Result'); if (!res) return;
    var boxes = res.querySelectorAll('input[type=checkbox][data-rate]');
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].addEventListener('change', function () {
        var r = this.getAttribute('data-rate');
        if (this.checked) delete _k1k2.excluded[r]; else _k1k2.excluded[r] = true;
        renderK1K2();
      });
    }
  }

  // k1/k2 그래프는 제외됨 (표·b-value만 표시). 호출부 호환을 위해 no-op 로 유지.
  function drawK1K2() { /* 그래프 미사용 */ }

  // ==========================================================================
  // 데이터 라이브러리 연동
  //  - CV 파일을 사이드바 '데이터 라이브러리'에 등록한다(GITT와 동일한 방식).
  //  - experimentType:'cv' 라서 일반 분석(rate/cycle)으로 전환되지 않고, 클릭하면
  //    09-dataset-library.js 의 가드가 CVAnalyzer.showDataset(id) 를 호출해 CV 탭을 연다.
  //  - cvPayload 에 사이클 데이터를 저장해 새로고침(IndexedDB 복원) 후에도 다시 볼 수 있다.
  // ==========================================================================
  function registerCvDataset(f) {
    if (typeof datasetLibrary === 'undefined' || typeof normalizeDataset !== 'function') return;
    try {
      var now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      var metric = 'CV · 사이클 ' + f.cycles.length + '개';
      var existing = null, i;
      for (i = 0; i < datasetLibrary.length; i++) {
        if (datasetLibrary[i].experimentType === 'cv' && datasetLibrary[i].filename === f.name) { existing = datasetLibrary[i]; break; }
      }
      if (existing) {
        f.id = existing.id;                        // 같은 파일 재업로드: CV 파일 id 를 기존 항목 id 로 맞춤
        if (existing.lineColor) f.color = existing.lineColor;   // 그래프 색을 라이브러리 색으로 통일
        existing.keyMetric = metric;
        existing.lastConvertedAt = now;
        existing.conversionStatus = 'converted';
        existing.compareEnabled = true;            // 업로드 직후 그래프에 보이도록 체크 상태로
        existing.cvPayload = { cycles: f.cycles, selNum: f.selNum, color: f.color, rateData: f.rateData || null };
        if (typeof updateDatasetInDB === 'function') { try { Promise.resolve(updateDatasetInDB(existing)).catch(function (e) { console.warn('CV DB 갱신 실패:', e); }); } catch (e) {} }
      } else {
        var base = f.name ? f.name.replace(/\.[^.]+$/, '') : 'CV';
        var ds = {
          id: f.id,
          projectName: (typeof activeProjectId !== 'undefined' && activeProjectId) ? activeProjectId : 'Default Project',
          experimentType: 'cv',
          isCv: true,                       // 01-core 초기 자동 활성화에서 제외하기 위한 플래그
          dataName: base, customName: base, sampleName: '',
          filename: f.name, uploadedAt: now, lastConvertedAt: now,
          conversionStatus: 'converted', keyMetric: metric,
          processedCycles: {}, totalCycles: 0, ice: '-',
          compareEnabled: true                     // 업로드 직후 그래프에 보이도록 체크 상태로
        };
        normalizeDataset(ds);                      // ds.lineColor(라이브러리 색) 계산
        if (ds.lineColor) f.color = ds.lineColor;  // 그래프 색을 라이브러리 색으로 통일
        ds.cvPayload = { cycles: f.cycles, selNum: f.selNum, color: f.color, rateData: f.rateData || null };
        datasetLibrary.push(ds);
        if (typeof saveDatasetToDB === 'function') { try { Promise.resolve(saveDatasetToDB(ds)).catch(function (e) { console.warn('CV DB 저장 실패:', e); }); } catch (e) {} }
      }
      if (typeof renderDatasetLibraryUI === 'function') renderDatasetLibraryUI();
      if (typeof renderLibraryTable === 'function') renderLibraryTable();
    } catch (e) { console.warn('CV 라이브러리 등록 실패:', e); }
  }

  // 라이브러리에서 CV 항목 클릭 시(09번) 호출. 필요하면 저장된 데이터로 복원하고, 체크(표시) 상태로 만든 뒤 CV 탭을 연다.
  function showDataset(id) {
    var present = null, i, dsRef = null;
    for (i = 0; i < cvFiles.length; i++) { if (cvFiles[i].id === id) { present = cvFiles[i]; break; } }
    if (typeof datasetLibrary !== 'undefined') {
      for (i = 0; i < datasetLibrary.length; i++) { if (datasetLibrary[i].id === id) { dsRef = datasetLibrary[i]; break; } }
    }
    if (!present && dsRef && dsRef.cvPayload && dsRef.cvPayload.cycles && dsRef.cvPayload.cycles.length) {
      var color = dsRef.lineColor || dsRef.cvPayload.color || CV_COLORS[cvFiles.length % CV_COLORS.length];  // 라이브러리 색 우선
      var selNum = (dsRef.cvPayload.selNum != null) ? dsRef.cvPayload.selNum : dsRef.cvPayload.cycles[0].num;
      cvFiles.push({ id: id, name: dsRef.filename || dsRef.dataName, color: color, cycles: dsRef.cvPayload.cycles, selNum: selNum, rateData: dsRef.cvPayload.rateData || null });
      refreshFileList();
    }
    // 클릭 = 보기 → 체크(표시) 상태로 만든다
    if (dsRef && dsRef.compareEnabled === false) {
      dsRef.compareEnabled = true;
      if (typeof updateDatasetInDB === 'function') { try { Promise.resolve(updateDatasetInDB(dsRef)).catch(function () {}); } catch (e) {} }
      if (typeof renderDatasetLibraryUI === 'function') renderDatasetLibraryUI();
    }
    renderAll();
    activateCVTab();
  }

  // 라이브러리에서 CV 항목 삭제 시(09번) 호출. 그래프에서도 제거.
  function removeDatasetFromChart(id) {
    var before = cvFiles.length;
    cvFiles = cvFiles.filter(function (f) { return f.id !== id; });
    if (cvFiles.length !== before) { refreshFileList(); renderAll(); }
  }

  // 외부(09-dataset-library.js)에서 호출할 공개 API
  //  - refresh: 체크박스(compareEnabled) 변경 시 CV 그래프/피크표를 다시 그림
  window.CVAnalyzer = { activateTab: activateCVTab, showDataset: showDataset, removeDataset: removeDatasetFromChart, refresh: renderAll };

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('btnTabCV'); if (btn) btn.addEventListener('click', activateCVTab);
    var addWin = $('cvAddWindow'); if (addWin) addWin.addEventListener('click', addWindow);
    renderWindowList();
    var fileInput = $('cvFileInput');
    if (fileInput) fileInput.addEventListener('change', function (e) { if (e.target.files && e.target.files.length) addFiles(e.target.files); e.target.value = ''; });
    var drop = $('cvDropZone');
    if (drop) {
      drop.addEventListener('click', function () { if (fileInput) fileInput.click(); });
      drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('drag-active'); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('drag-active'); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('drag-active'); if (e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
    }
  });
})();
