/* ============================================================================
 * HC-Analyzer  ·  js/17-cv.js   (CV = Cyclic Voltammetry 분석 · 독립 모듈)
 * CV 파일(전압/전류)을 CV 탭에서 업로드 → 사이클 분리 → I-V 곡선 → 사이클 드롭다운
 * → 산화/환원 피크 전압 자동 검출. 기존 충방전 코드는 건드리지 않음. 엑셀은 js/xlsx-worker.js 재사용.
 * ============================================================================ */
(function () {
  'use strict';
  var cvFiles = [], cvChart = null, cvWorker = null, cvJob = 0, _fid = 0;
  var cvWindows = [];
  var _queue = [], _parsing = false;
  // 전류 표시 단위: 'mA' 또는 'A/g'(질량당). 파일별 질량 f.massMg(mg) 로 환산.
  var cvUnit = 'mA';
  function toUnit(iA, f) {
    if (cvUnit === 'A/g') { var m = f ? parseFloat(f.massMg) : NaN; if (isNaN(m) || m <= 0) return null; return iA / (m / 1000); }
    return iA * 1000; // mA
  }
  function unitSuffix() { return cvUnit === 'A/g' ? ' A/g' : ' mA'; }
  function unitAxis() { return cvUnit === 'A/g' ? 'Current (A g⁻¹)' : 'Current (mA)'; }
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

  function onRows(rows, filename) {
    var res = computeCycles(rows);
    if (!res) { setStatus(filename + ': 전압/전류 컬럼을 찾지 못했거나 데이터가 부족합니다.'); parseNext(); return; }
    var color = CV_COLORS[cvFiles.length % CV_COLORS.length];
    var entry = { id: 'cv' + Date.now() + '_' + (++_fid), name: filename, color: color, cycles: res.cycles, selNum: res.defaultNum };
    entry.rateData = buildRateData(rows);
    cvFiles.push(entry);
    registerCvDataset(entry);
    refreshFileList();
    renderAll();
    setStatus('로드됨: ' + cvFiles.length + '개 파일');
    parseNext();
  }

  // ---- 사이클 계산 ----
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

  // ---- 파일 목록 UI ----
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
      // 질량(mg) 입력 — A/g 환산용(파일별)
      var mlab = document.createElement('span');
      mlab.textContent = '질량(mg)'; mlab.style.cssText = 'font-size:11px; color:var(--text-muted);';
      var mass = document.createElement('input');
      mass.type = 'number'; mass.step = '0.01'; mass.min = '0'; mass.placeholder = 'mg';
      mass.className = 'select-field'; mass.style.cssText = 'margin-bottom:0; height:30px; width:72px;';
      if (f.massMg != null && !isNaN(f.massMg)) mass.value = f.massMg;
      mass.addEventListener('input', function () { var v = parseFloat(this.value); f.massMg = isNaN(v) ? null : v; persistMass(f); renderAll(); });
      var rm = document.createElement('button');
      rm.textContent = '✕'; rm.title = '이 파일 제거';
      rm.style.cssText = 'background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:14px; line-height:1; padding:2px 4px;';
      rm.addEventListener('click', function () { removeFile(f.id); });
      row.appendChild(sw); row.appendChild(nm); row.appendChild(lab); row.appendChild(sel);
      row.appendChild(mlab); row.appendChild(mass); row.appendChild(rm);
      el.appendChild(row);
    });
  }

  // 질량 변경을 라이브러리 저장본(cvPayload)에도 반영
  function persistMass(f) {
    if (typeof datasetLibrary === 'undefined') return;
    for (var i = 0; i < datasetLibrary.length; i++) {
      if (datasetLibrary[i].id === f.id) {
        if (datasetLibrary[i].cvPayload) datasetLibrary[i].cvPayload.massMg = f.massMg;
        if (typeof updateDatasetInDB === 'function') { try { Promise.resolve(updateDatasetInDB(datasetLibrary[i])).catch(function () {}); } catch (e) {} }
        break;
      }
    }
  }

  function removeFile(id) {
    cvFiles = cvFiles.filter(function (f) { return f.id !== id; });
    refreshFileList();
    renderAll();
    setStatus(cvFiles.length ? (cvFiles.length + '개 파일') : 'CV 파일을 업로드하세요.');
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

  function isEnabled(f) {
    if (typeof datasetLibrary === 'undefined') return true;
    for (var i = 0; i < datasetLibrary.length; i++) {
      if (datasetLibrary[i].id === f.id) return datasetLibrary[i].compareEnabled !== false;
    }
    return true;
  }

  // ---- 그래프 + 피크표 렌더 ----
  function renderAll() {
    var datasets = [], xmin = Infinity, xmax = -Infinity, needMass = 0;
    cvFiles.forEach(function (f) {
      if (!isEnabled(f)) return;
      var cc = getCycle(f, f.selNum); if (!cc) return;
      if (cvUnit === 'A/g' && (f.massMg == null || isNaN(parseFloat(f.massMg)) || parseFloat(f.massMg) <= 0)) { needMass++; return; }
      var pts = [], j;
      for (j = 0; j < cc.V.length; j++) {
        var y = toUnit(cc.I[j], f); if (y === null) continue;
        pts.push({ x: cc.V[j], y: y });
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
    if (cvUnit === 'A/g' && needMass > 0) setStatus('A/g 표시: 질량 미입력 파일 ' + needMass + '개는 그래프에서 숨김(질량 입력 시 표시)');
  }

  function renderCVChart(datasets, xmin, xmax) {
    var el = $('chartCV'); if (!el || typeof Chart === 'undefined') return;
    var ctx = el.getContext('2d');
    if (cvChart) { cvChart.destroy(); cvChart = null; }
    if (!datasets.length) return;
    if (!isFinite(xmin)) { xmin = 0; xmax = 1; }
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
          y: { title: { display: true, text: unitAxis(), color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.06)' } }
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
    var aV = [], aI = [], cV = [], cI = [], k, SENS = 0.08;
    for (k = 0; k < cc.V.length; k++) {
      if (cc.I[k] > 0) { aV.push(cc.V[k]); aI.push(cc.I[k]); }
      else if (cc.I[k] < 0) { cV.push(cc.V[k]); cI.push(cc.I[k]); }
    }
    return { anodic: findPeaks(aV, aI, true, SENS), cathodic: findPeaks(cV, cI, false, SENS) };
  }

  function validWindows() {
    return cvWindows.filter(function (w) {
      return w && w.min != null && w.max != null && !isNaN(w.min) && !isNaN(w.max) && w.min !== w.max;
    }).map(function (w) { return { min: Math.min(w.min, w.max), max: Math.max(w.min, w.max), type: w.type || 'both' }; })
      .sort(function (a, b) { return a.min - b.min; });
  }

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

  // 구간 × '스캔레이트별' 피크 검출. rateData 사용.
  function peaksInWindowsByRate(f, wins) {
    var rd = f.rateData && f.rateData[f.selNum]; if (!rd) return null;
    function byRateOf(arr) { var m = {}; (arr || []).forEach(function (s) { if (!m[s.rate]) m[s.rate] = s; }); return m; }
    var A = byRateOf(rd.anodic), Cx = byRateOf(rd.cathodic);
    var set = {};
    Object.keys(A).forEach(function (r) { set[r] = 1; });
    Object.keys(Cx).forEach(function (r) { set[r] = 1; });
    var rates = Object.keys(set).map(parseFloat).sort(function (a, b) { return a - b; });
    if (!rates.length) return null;
    function peakIn(sg, lo, hi, wantMax) {
      if (!sg) return null; var best = null, p;
      for (p = 0; p < sg.V.length; p++) {
        var v = sg.V[p], i = sg.I[p]; if (v < lo || v > hi) continue;
        if (wantMax) { if (i > 0 && (!best || i > best.i)) best = { v: v, i: i }; }
        else { if (i < 0 && (!best || i < best.i)) best = { v: v, i: i }; }
      }
      return best;
    }
    return wins.map(function (w) {
      var wantA = (w.type !== 'cathodic'), wantC = (w.type !== 'anodic');
      var perRate = rates.map(function (r) {
        return {
          rate: r,
          anodic: wantA ? peakIn(A[r], w.min, w.max, true) : null,
          cathodic: wantC ? peakIn(Cx[r], w.min, w.max, false) : null
        };
      });
      return { min: w.min, max: w.max, type: w.type, rates: perRate };
    });
  }

  function fmtPeak(p, f) {
    if (!p) return '<span style="color:#6b7280;">-</span>';
    var y = toUnit(p.i, f);
    if (y === null) return p.v.toFixed(3) + ' V <span style="color:#6b7280;">(질량 입력 필요)</span>';
    return p.v.toFixed(3) + ' V <span style="color:#9ca3af;">(' + y.toFixed(3) + unitSuffix() + ')</span>';
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
        var byRate = peaksInWindowsByRate(f, wins);
        if (byRate) {
          html += '<table style="width:100%; border-collapse:collapse; font-size:12px;">'
            + '<thead><tr style="color:#9ca3af; text-align:left; border-bottom:1px solid rgba(255,255,255,0.12);"><th style="padding:3px 6px;">Scan rate</th><th style="padding:3px 6px;color:#f59e0b;">산화 (Anodic)</th><th style="padding:3px 6px;color:#60a5fa;">환원 (Cathodic)</th></tr></thead><tbody>';
          byRate.forEach(function (wrow) {
            var typeLabel = wrow.type === 'anodic' ? '산화' : (wrow.type === 'cathodic' ? '환원' : '산화·환원');
            html += '<tr><td colspan="3" style="padding:4px 6px;font-weight:600;background:rgba(255,255,255,0.04);">'
              + wrow.min.toFixed(2) + ' ~ ' + wrow.max.toFixed(2) + ' V <span style="color:#9ca3af;font-weight:400;">· ' + typeLabel + '</span></td></tr>';
            wrow.rates.forEach(function (rr) {
              html += '<tr><td style="padding:3px 6px;">' + rr.rate + ' mV/s</td>'
                + '<td style="padding:3px 6px;">' + (wrow.type !== 'cathodic' ? fmtPeak(rr.anodic, f) : '<span style="color:#6b7280;">-</span>') + '</td>'
                + '<td style="padding:3px 6px;">' + (wrow.type !== 'anodic' ? fmtPeak(rr.cathodic, f) : '<span style="color:#6b7280;">-</span>') + '</td></tr>';
            });
          });
          html += '</tbody></table>';
        } else {
          var rows = cc ? peaksInWindows(cc, wins) : [];
          html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">※ 이 파일은 스캔레이트 분리 불가(Time 컬럼 없음) → 구간당 대표 피크만 표시</div>';
          html += '<table style="width:100%; border-collapse:collapse; font-size:12px;">'
            + '<thead><tr style="color:#9ca3af; text-align:left; border-bottom:1px solid rgba(255,255,255,0.12);"><th style="padding:3px 6px;">전압 구간</th><th style="padding:3px 6px;">종류</th><th style="padding:3px 6px;">Peak Voltage (Current)</th></tr></thead><tbody>';
          rows.forEach(function (r) {
            var range = r.min.toFixed(2) + ' ~ ' + r.max.toFixed(2) + ' V';
            if (r.type !== 'cathodic') {
              html += '<tr><td style="padding:3px 6px;">' + range + '</td><td style="padding:3px 6px;color:#f59e0b;font-weight:600;">산화 (Anodic)</td><td style="padding:3px 6px;">' + fmtPeak(r.anodic, f) + '</td></tr>';
            }
            if (r.type !== 'anodic') {
              html += '<tr><td style="padding:3px 6px;">' + range + '</td><td style="padding:3px 6px;color:#60a5fa;font-weight:600;">환원 (Cathodic)</td><td style="padding:3px 6px;">' + fmtPeak(r.cathodic, f) + '</td></tr>';
            }
          });
          html += '</tbody></table>';
        }
      } else {
        var pk = cc ? detectPeaks(cc) : { anodic: [], cathodic: [] };
        function rowsFor(list, label, color) {
          if (!list.length) return '<tr><td style="padding:3px 6px;color:' + color + ';font-weight:600;">' + label + '</td><td style="padding:3px 6px;color:#6b7280;" colspan="2">검출된 피크 없음</td></tr>';
          return list.map(function (p) {
            var y = toUnit(p.i, f), cur = (y === null) ? '질량 입력 필요' : (y.toFixed(3) + unitSuffix());
            return '<tr><td style="padding:3px 6px;color:' + color + ';font-weight:600;">' + label + '</td><td style="padding:3px 6px;">' + p.v.toFixed(3) + ' V</td><td style="padding:3px 6px;color:#9ca3af;">' + cur + '</td></tr>';
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
  // k1/k2 (Dunn) 분석
  // ==========================================================================
  var _k1k2 = { fileId: null, branch: 'anodic', excluded: {} };
  var k1k2Chart = null;

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
    if (tCol < 0 || vCol < 0 || iCol < 0) return null;
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
    var byCyc = {}, order = [], k;
    for (k = 0; k < V.length; k++) {
      var cn = isNaN(C[k]) ? 0 : C[k];
      if (!Object.prototype.hasOwnProperty.call(byCyc, cn)) { byCyc[cn] = []; order.push(cn); }
      byCyc[cn].push(k);
    }
    var out = {};
    order.forEach(function (cn) {
      var idx = byCyc[cn];
      var vmn = Infinity, vmx = -Infinity, j;
      for (j = 0; j < idx.length; j++) { var vv = V[idx[j]]; if (vv < vmn) vmn = vv; if (vv > vmx) vmx = vv; }
      var cycSpan = vmx - vmn; if (cycSpan <= 0) return;
      var hasStep = false;
      for (j = 1; j < idx.length; j++) { if (S[idx[j]] !== S[idx[0]]) { hasStep = true; break; } }
      var segs = [], segStart = 0;
      if (hasStep) {
        for (j = 1; j < idx.length; j++) {
          if (S[idx[j]] !== S[idx[j - 1]]) { segs.push([segStart, j - 1]); segStart = j; }
        }
      } else {
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
        if (svmx - svmn < 0.7 * cycSpan) return;
        var dt = T[idx[b]] - T[idx[a]]; if (dt <= 0) return;
        var rate = Math.round((svmx - svmn) / dt * 1000 * 100) / 100;
        if (rate <= 0) return;
        var up = V[idx[b]] > V[idx[a]];
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

  function computeK1K2(f) {
    if (!f || !f.rateData) return null;
    var rd = f.rateData[f.selNum]; if (!rd) return null;
    var branchArr = (_k1k2.branch === 'cathodic') ? rd.cathodic : rd.anodic;
    if (!branchArr || !branchArr.length) return null;
    var byRate = {};
    branchArr.forEach(function (sg) { if (!byRate[sg.rate]) byRate[sg.rate] = sg; });
    var rates = Object.keys(byRate).map(parseFloat).sort(function (a, b) { return a - b; });
    rates = rates.filter(function (r) { return !_k1k2.excluded[r]; });
    if (rates.length < 2) return { rates: rates, tooFew: true };
    var lo = -Infinity, hi = Infinity;
    rates.forEach(function (r) { var V = byRate[r].V; if (V[0] > lo) lo = V[0]; if (V[V.length - 1] < hi) hi = V[V.length - 1]; });
    lo += 0.02; hi -= 0.02; if (hi <= lo) return null;
    var N = 260, grid = [], g;
    for (g = 0; g < N; g++) grid.push(lo + (hi - lo) * g / (N - 1));
    var varr = rates.map(function (r) { return r / 1000; }), sq = varr.map(Math.sqrt);
    var imat = rates.map(function (r) { var sg = byRate[r]; return grid.map(function (x) { return _interp(x, sg.V, sg.I); }); });
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
    function trapzAbs(arr) { var s = 0; for (var i = 1; i < N; i++) s += (Math.abs(arr[i]) + Math.abs(arr[i - 1])) / 2 * (grid[i] - grid[i - 1]); return s; }
    var contribution = rates.map(function (r, ri) {
      var v = r / 1000, cap = grid.map(function (_, gg) { return k1[gg] * v; });
      var pct = trapzAbs(cap) / trapzAbs(imat[ri]) * 100;
      return { rate: r, pct: pct };
    });
    var ipeak = rates.map(function (r) { var I = byRate[r].I, mx = -Infinity, mn = Infinity, p; for (p = 0; p < I.length; p++) { if (I[p] > mx) mx = I[p]; if (I[p] < mn) mn = I[p]; } return _k1k2.branch === 'cathodic' ? Math.abs(mn) : mx; });
    var bVal = null;
    if (rates.length >= 2) {
      var lx = rates.map(function (r) { return Math.log(r); }), ly = ipeak.map(function (x) { return Math.log(Math.abs(x) || 1e-12); });
      var n = rates.length, mx2 = 0, my = 0, i2; for (i2 = 0; i2 < n; i2++) { mx2 += lx[i2]; my += ly[i2]; } mx2 /= n; my /= n;
      var num = 0, den = 0; for (i2 = 0; i2 < n; i2++) { num += (lx[i2] - mx2) * (ly[i2] - my); den += (lx[i2] - mx2) * (lx[i2] - mx2); }
      bVal = den ? num / den : null;
    }
    var dispRate = rates[rates.length - 1];
    var dispV = dispRate / 1000;
    var capCurve = grid.map(function (_, gg) { return k1[gg] * dispV * 1000; });
    var totCurve = imat[rates.length - 1].map(function (x) { return x * 1000; });
    return {
      rates: rates, allRates: Object.keys(byRate).map(parseFloat).sort(function (a, b) { return a - b; }),
      grid: grid, contribution: contribution, bVal: bVal,
      dispRate: dispRate, capCurve: capCurve, totCurve: totCurve
    };
  }

  // 사용자가 설정한 전압 구간마다 b-value 산출.
  function computeBValues(f) {
    if (!f || !f.rateData) return null;
    var rd = f.rateData[f.selNum]; if (!rd) return null;
    var wins = validWindows(); if (!wins.length) return null;
    function byRateOf(arr) { var m = {}; (arr || []).forEach(function (s) { if (!m[s.rate]) m[s.rate] = s; }); return m; }
    var A = byRateOf(rd.anodic), Cx = byRateOf(rd.cathodic);
    function ratesOf(m) { return Object.keys(m).map(parseFloat).filter(function (r) { return !_k1k2.excluded[r]; }).sort(function (a, b) { return a - b; }); }
    function peakInWin(sg, lo, hi, wantMax) {
      var best = null, p;
      for (p = 0; p < sg.V.length; p++) {
        var v = sg.V[p], i = sg.I[p]; if (v < lo || v > hi) continue;
        if (wantMax) { if (i > 0 && (best === null || i > best)) best = i; }
        else { if (i < 0 && (best === null || i < best)) best = i; }
      }
      return best;
    }
    function fitB(m, lo, hi, wantMax) {
      var rs = ratesOf(m), xs = [], ys = [], pts = [];
      rs.forEach(function (r) { var ip = peakInWin(m[r], lo, hi, wantMax); if (ip !== null && ip !== 0) { xs.push(Math.log(r)); ys.push(Math.log(Math.abs(ip))); pts.push({ v: r, ip: ip }); } });
      if (xs.length < 2) return null;
      var n = xs.length, mx = 0, my = 0, i; for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; } mx /= n; my /= n;
      var num = 0, den = 0, sst = 0; for (i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); sst += (ys[i] - my) * (ys[i] - my); }
      if (!den) return null;
      var b = num / den, inter = my - b * mx, ssr = 0; for (i = 0; i < n; i++) { var pred = b * xs[i] + inter; ssr += (ys[i] - pred) * (ys[i] - pred); }
      var r2 = sst > 0 ? 1 - ssr / sst : 1;
      return { b: b, r2: r2, n: n, points: pts };
    }
    return wins.map(function (w) {
      return {
        min: w.min, max: w.max, type: w.type,
        anodic: (w.type !== 'cathodic') ? fitB(A, w.min, w.max, true) : null,
        cathodic: (w.type !== 'anodic') ? fitB(Cx, w.min, w.max, false) : null
      };
    });
  }

  function currentK1K2File() {
    var i;
    if (_k1k2.fileId) { for (i = 0; i < cvFiles.length; i++) if (cvFiles[i].id === _k1k2.fileId) return cvFiles[i]; }
    for (i = 0; i < cvFiles.length; i++) if (cvFiles[i].rateData) return cvFiles[i];
    return cvFiles[0] || null;
  }

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
    var ctrl = $('cvK1K2Controls');
    if (ctrl) {
      var html = '';
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

    var warn = '';
    var over = out.contribution.some(function (x) { return x.pct > 100 || x.pct < 0; });
    if (over || (out.bVal != null && out.bVal > 1.1)) {
      warn = '<div style="margin-top:8px;font-size:11px;color:#fbbf24;line-height:1.5;">⚠ 기여도가 0~100% 범위를 벗어나거나 b>1 이면, redox 피크가 스캔레이트에 따라 크게 이동해 고정-전압 k1/k2 방법의 전제가 약해진 경우입니다(날카로운 배터리 피크에서 흔함). b-value(피크 전류 기반)와 함께 해석하세요.</div>';
    }
    var rowsHtml = out.contribution.map(function (x) {
      return '<tr><td style="padding:3px 6px;">' + x.rate + ' mV/s</td><td style="padding:3px 6px;">' + x.pct.toFixed(1) + ' %</td><td style="padding:3px 6px;color:#9ca3af;">' + (100 - x.pct).toFixed(1) + ' %</td></tr>';
    }).join('');

    var bWins = computeBValues(f);
    var bHtml;
    if (bWins && bWins.length) {
      function bCell(res2) {
        if (!res2) return '<span style="color:#6b7280;">값 부족(점 2개 이상 필요)</span>';
        return '<b>' + res2.b.toFixed(3) + '</b> <span style="color:#9ca3af;">(R²=' + res2.r2.toFixed(3) + ', n=' + res2.n + ')</span>';
      }
      var bRows = '';
      bWins.forEach(function (r) {
        var range = r.min.toFixed(2) + ' ~ ' + r.max.toFixed(2) + ' V';
        if (r.type !== 'cathodic') bRows += '<tr><td style="padding:3px 6px;">' + range + '</td><td style="padding:3px 6px;color:#f59e0b;font-weight:600;">산화 (Anodic)</td><td style="padding:3px 6px;">' + bCell(r.anodic) + '</td></tr>';
        if (r.type !== 'anodic') bRows += '<tr><td style="padding:3px 6px;">' + range + '</td><td style="padding:3px 6px;color:#60a5fa;font-weight:600;">환원 (Cathodic)</td><td style="padding:3px 6px;">' + bCell(r.cathodic) + '</td></tr>';
      });
      bHtml = '<div style="font-size:12px;margin-bottom:4px;font-weight:600;">구간별 b-value <span style="color:#9ca3af;font-weight:400;">(log Ipeak vs log v 기울기 · 0.5≈확산 · 1.0≈표면/용량성)</span></div>'
        + '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px;"><thead><tr style="color:#9ca3af;text-align:left;border-bottom:1px solid rgba(255,255,255,0.12);">'
        + '<th style="padding:3px 6px;">전압 구간</th><th style="padding:3px 6px;">종류</th><th style="padding:3px 6px;">b-value</th></tr></thead><tbody>'
        + bRows + '</tbody></table>';
    } else {
      bHtml = '<div style="font-size:12px;margin-bottom:6px;">b-value (peak, ' + (_k1k2.branch === 'cathodic' ? '환원' : '산화') + '): <b>' + (out.bVal != null ? out.bVal.toFixed(3) : '-') + '</b> <span style="color:#9ca3af;">(0.5≈확산지배 · 1.0≈표면/용량성) · 피크 검출 전압 구간을 설정하면 구간별 b-value가 표시됩니다.</span></div>';
    }

    res.innerHTML = chips
      + bHtml
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
        f.id = existing.id;
        if (existing.lineColor) f.color = existing.lineColor;
        existing.keyMetric = metric;
        existing.lastConvertedAt = now;
        existing.conversionStatus = 'converted';
        existing.compareEnabled = true;
        existing.cvPayload = { cycles: f.cycles, selNum: f.selNum, color: f.color, rateData: f.rateData || null, massMg: f.massMg != null ? f.massMg : null };
        if (typeof updateDatasetInDB === 'function') { try { Promise.resolve(updateDatasetInDB(existing)).catch(function (e) { console.warn('CV DB 갱신 실패:', e); }); } catch (e) {} }
      } else {
        var base = f.name ? f.name.replace(/\.[^.]+$/, '') : 'CV';
        var ds = {
          id: f.id,
          projectName: (typeof activeProjectId !== 'undefined' && activeProjectId) ? activeProjectId : 'Default Project',
          experimentType: 'cv',
          isCv: true,
          dataName: base, customName: base, sampleName: '',
          filename: f.name, uploadedAt: now, lastConvertedAt: now,
          conversionStatus: 'converted', keyMetric: metric,
          processedCycles: {}, totalCycles: 0, ice: '-',
          compareEnabled: true
        };
        normalizeDataset(ds);
        if (ds.lineColor) f.color = ds.lineColor;
        ds.cvPayload = { cycles: f.cycles, selNum: f.selNum, color: f.color, rateData: f.rateData || null, massMg: f.massMg != null ? f.massMg : null };
        datasetLibrary.push(ds);
        if (typeof saveDatasetToDB === 'function') { try { Promise.resolve(saveDatasetToDB(ds)).catch(function (e) { console.warn('CV DB 저장 실패:', e); }); } catch (e) {} }
      }
      if (typeof renderDatasetLibraryUI === 'function') renderDatasetLibraryUI();
      if (typeof renderLibraryTable === 'function') renderLibraryTable();
    } catch (e) { console.warn('CV 라이브러리 등록 실패:', e); }
  }

  function showDataset(id) {
    var present = null, i, dsRef = null;
    for (i = 0; i < cvFiles.length; i++) { if (cvFiles[i].id === id) { present = cvFiles[i]; break; } }
    if (typeof datasetLibrary !== 'undefined') {
      for (i = 0; i < datasetLibrary.length; i++) { if (datasetLibrary[i].id === id) { dsRef = datasetLibrary[i]; break; } }
    }
    if (!present && dsRef && dsRef.cvPayload && dsRef.cvPayload.cycles && dsRef.cvPayload.cycles.length) {
      var color = dsRef.lineColor || dsRef.cvPayload.color || CV_COLORS[cvFiles.length % CV_COLORS.length];
      var selNum = (dsRef.cvPayload.selNum != null) ? dsRef.cvPayload.selNum : dsRef.cvPayload.cycles[0].num;
      cvFiles.push({ id: id, name: dsRef.filename || dsRef.dataName, color: color, cycles: dsRef.cvPayload.cycles, selNum: selNum, rateData: dsRef.cvPayload.rateData || null, massMg: (dsRef.cvPayload.massMg != null ? dsRef.cvPayload.massMg : null) });
      refreshFileList();
    }
    if (dsRef && dsRef.compareEnabled === false) {
      dsRef.compareEnabled = true;
      if (typeof updateDatasetInDB === 'function') { try { Promise.resolve(updateDatasetInDB(dsRef)).catch(function () {}); } catch (e) {} }
      if (typeof renderDatasetLibraryUI === 'function') renderDatasetLibraryUI();
    }
    renderAll();
    activateCVTab();
  }

  function removeDatasetFromChart(id) {
    var before = cvFiles.length;
    cvFiles = cvFiles.filter(function (f) { return f.id !== id; });
    if (cvFiles.length !== before) { refreshFileList(); renderAll(); }
  }

  window.CVAnalyzer = { activateTab: activateCVTab, showDataset: showDataset, removeDataset: removeDatasetFromChart, refresh: renderAll };

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('btnTabCV'); if (btn) btn.addEventListener('click', activateCVTab);
    var addWin = $('cvAddWindow'); if (addWin) addWin.addEventListener('click', addWindow);
    var usel = $('cvUnitSel'); if (usel) usel.addEventListener('change', function () { cvUnit = this.value; renderAll(); });
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
