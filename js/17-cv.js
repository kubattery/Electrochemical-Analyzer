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
    setTimeout(function () { if (cvChart) cvChart.resize(); }, 60);
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

  // ---- 그래프 + 피크표 렌더 (모든 파일 오버레이) ----
  function renderAll() {
    var datasets = [], xmin = Infinity, xmax = -Infinity;
    cvFiles.forEach(function (f) {
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
  }

  function renderCVChart(datasets, xmin, xmax) {
    var el = $('chartCV'); if (!el || typeof Chart === 'undefined') return;
    var ctx = el.getContext('2d');
    if (cvChart) { cvChart.destroy(); cvChart = null; }
    if (!datasets.length) return;
    // 데이터 기준 x축(전압) 범위를 명시 → CV 루프(시작·끝 전압 동일)에서 축 붕괴 방지
    if (!isFinite(xmin)) { xmin = 0; xmax = 1; }
    cvChart = new Chart(ctx, {
      type: 'line',
      data: { datasets: datasets },
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
    // 산화(anodic)=양(+)전류 구간, 환원(cathodic)=음(-)전류 구간으로 나눠 피크 검출
    var aV = [], aI = [], cV = [], cI = [], k, SENS = 0.08;
    for (k = 0; k < cc.V.length; k++) {
      if (cc.I[k] > 0) { aV.push(cc.V[k]); aI.push(cc.I[k]); }
      else if (cc.I[k] < 0) { cV.push(cc.V[k]); cI.push(cc.I[k]); }
    }
    return { anodic: findPeaks(aV, aI, true, SENS), cathodic: findPeaks(cV, cI, false, SENS) };
  }

  function renderPeakTable() {
    var el = $('cvPeakTable'); if (!el) return;
    if (!cvFiles.length) { el.innerHTML = '<span style="color:#6b7280; font-size:12px;">파일을 로드하면 산화·환원 피크가 표시됩니다.</span>'; return; }
    function rowsFor(list, label, color) {
      if (!list.length) return '<tr><td style="padding:3px 6px;color:' + color + ';font-weight:600;">' + label + '</td><td style="padding:3px 6px;color:#6b7280;" colspan="2">검출된 피크 없음</td></tr>';
      return list.map(function (p) {
        return '<tr><td style="padding:3px 6px;color:' + color + ';font-weight:600;">' + label + '</td><td style="padding:3px 6px;">' + p.v.toFixed(3) + ' V</td><td style="padding:3px 6px;color:#9ca3af;">' + (p.i * 1000).toFixed(3) + ' mA</td></tr>';
      }).join('');
    }
    var html = '';
    cvFiles.forEach(function (f) {
      var cc = getCycle(f, f.selNum);
      var pk = cc ? detectPeaks(cc) : { anodic: [], cathodic: [] };
      html += '<div style="margin-bottom:12px;">'
        + '<div style="font-size:12px; font-weight:600; margin-bottom:4px; color:' + f.color + ';">● ' + f.name + ' · ' + f.selNum + '사이클</div>'
        + '<table style="width:100%; border-collapse:collapse; font-size:12px;">'
        + '<thead><tr style="color:#9ca3af; text-align:left; border-bottom:1px solid rgba(255,255,255,0.12);"><th style="padding:3px 6px;">구분</th><th style="padding:3px 6px;">Voltage</th><th style="padding:3px 6px;">Peak Current</th></tr></thead>'
        + '<tbody>' + rowsFor(pk.anodic, '산화 (Anodic)', '#f59e0b') + rowsFor(pk.cathodic, '환원 (Cathodic)', '#60a5fa') + '</tbody></table></div>';
    });
    el.innerHTML = html;
  }

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
        existing.cvPayload = { cycles: f.cycles, selNum: f.selNum, color: f.color };
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
          compareEnabled: false
        };
        normalizeDataset(ds);                      // ds.lineColor(라이브러리 색) 계산
        if (ds.lineColor) f.color = ds.lineColor;  // 그래프 색을 라이브러리 색으로 통일
        ds.cvPayload = { cycles: f.cycles, selNum: f.selNum, color: f.color };
        datasetLibrary.push(ds);
        if (typeof saveDatasetToDB === 'function') { try { Promise.resolve(saveDatasetToDB(ds)).catch(function (e) { console.warn('CV DB 저장 실패:', e); }); } catch (e) {} }
      }
      if (typeof renderDatasetLibraryUI === 'function') renderDatasetLibraryUI();
      if (typeof renderLibraryTable === 'function') renderLibraryTable();
    } catch (e) { console.warn('CV 라이브러리 등록 실패:', e); }
  }

  // 라이브러리에서 CV 항목 클릭 시(09번) 호출. 필요하면 저장된 데이터로 복원 후 CV 탭을 연다.
  function showDataset(id) {
    var present = null, i;
    for (i = 0; i < cvFiles.length; i++) { if (cvFiles[i].id === id) { present = cvFiles[i]; break; } }
    if (!present && typeof datasetLibrary !== 'undefined') {
      var ds = null;
      for (i = 0; i < datasetLibrary.length; i++) { if (datasetLibrary[i].id === id) { ds = datasetLibrary[i]; break; } }
      if (ds && ds.cvPayload && ds.cvPayload.cycles && ds.cvPayload.cycles.length) {
        var color = ds.lineColor || ds.cvPayload.color || CV_COLORS[cvFiles.length % CV_COLORS.length];  // 라이브러리 색 우선
        var selNum = (ds.cvPayload.selNum != null) ? ds.cvPayload.selNum : ds.cvPayload.cycles[0].num;
        cvFiles.push({ id: id, name: ds.filename || ds.dataName, color: color, cycles: ds.cvPayload.cycles, selNum: selNum });
        refreshFileList();
        renderAll();
      }
    }
    activateCVTab();
  }

  // 라이브러리에서 CV 항목 삭제 시(09번) 호출. 그래프에서도 제거.
  function removeDatasetFromChart(id) {
    var before = cvFiles.length;
    cvFiles = cvFiles.filter(function (f) { return f.id !== id; });
    if (cvFiles.length !== before) { refreshFileList(); renderAll(); }
  }

  // 외부(09-dataset-library.js)에서 호출할 공개 API
  window.CVAnalyzer = { activateTab: activateCVTab, showDataset: showDataset, removeDataset: removeDatasetFromChart };

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('btnTabCV'); if (btn) btn.addEventListener('click', activateCVTab);
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
