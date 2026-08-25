/* ============================================================================
 * HC-Analyzer  ·  js/17-cv.js   (CV = Cyclic Voltammetry 분석 · 독립 모듈)
 * CV 파일(전압/전류)을 CV 탭에서 업로드 → 사이클 분리 → I-V 곡선 → 사이클 드롭다운
 * → 산화/환원 피크 전압 자동 검출. 기존 충방전 코드는 건드리지 않음. 엑셀은 js/xlsx-worker.js 재사용.
 *
 * [사이클 분리 방식]
 *  - 파일에 'Cycle No.'(사이클 번호) 컬럼이 있으면 → 그 번호를 그대로 사용(측정기 기록과 100% 일치).
 *  - 없으면 → 전압 스윕 정점(vertex) 기반 자동 검출로 폴백(구형 Index/Voltage/Current 폼 호환).
 * ============================================================================ */
(function () {
  'use strict';
  var cvCycles = [], cvChart = null, cvWorker = null, cvJob = 0;
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

  function onCVFile(file) {
    if (!file) return;
    setStatus('불러오는 중... (' + file.name + ')');
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var reader = new FileReader();
    if (ext === 'xlsx' || ext === 'xls') {
      reader.onload = function (e) { cvParseXlsx(e.target.result, file.name); };
      reader.onerror = function () { setStatus('파일 읽기 실패'); };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = function (e) { cvParseText(e.target.result, file.name); };
      reader.onerror = function () { setStatus('파일 읽기 실패'); };
      reader.readAsText(file);
    }
  }

  function cvParseXlsx(buf, filename) {
    try { if (!cvWorker) cvWorker = new Worker('js/xlsx-worker.js?v=4.0.0'); }
    catch (err) { setStatus('워커 생성 실패: ' + err); return; }
    var id = ++cvJob;
    var onMsg = function (ev) {
      if (!ev.data || ev.data.id !== id) return;
      cvWorker.removeEventListener('message', onMsg);
      if (ev.data.ok && ev.data.jsonData) ingestRows(ev.data.jsonData, filename);
      else setStatus('엑셀 파싱 실패: ' + (ev.data.error || ''));
    };
    cvWorker.addEventListener('message', onMsg);
    cvWorker.onerror = function (er) { setStatus('워커 오류: ' + (er && er.message || '')); };
    try { cvWorker.postMessage({ id: id, data: buf, filename: filename }, [buf]); }
    catch (e) { cvWorker.postMessage({ id: id, data: buf, filename: filename }); }
  }

  function cvParseText(text, filename) {
    var lines = text.split(/\r?\n/), rows = [];
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k];
      if (line == null || line.trim() === '') continue;
      var delim = line.indexOf('\t') >= 0 ? '\t' : (line.indexOf(';') >= 0 ? ';' : ',');
      rows.push(line.split(delim));
    }
    ingestRows(rows, filename);
  }

  function ingestRows(rows, filename) {
    if (!rows || rows.length < 3) { setStatus('데이터가 비어 있습니다.'); return; }
    var headerIdx = -1, vCol = -1, iCol = -1, cCol = -1;
    for (var r = 0; r < Math.min(20, rows.length); r++) {
      var row = rows[r]; if (!row) continue;
      var vc = -1, ic = -1, cyc = -1;
      for (var c = 0; c < row.length; c++) {
        var s = String(row[c] == null ? '' : row[c]).toLowerCase().trim();
        if (vc < 0 && (s.indexOf('voltage') >= 0 || s.indexOf('전압') >= 0 || s.indexOf('v vs') >= 0 || s === 'v' || s.indexOf('potential') >= 0)) vc = c;
        if (ic < 0 && (s.indexOf('current') >= 0 || s.indexOf('전류') >= 0 || s === 'i' || s.indexOf('(a)') >= 0 || s.indexOf('(ma)') >= 0 || s.indexOf('i(') >= 0)) ic = c;
        // 'Cycle No.'(사이클 번호) 컬럼만 인식 — 'Cycle Time' 은 제외
        if (cyc < 0 && s.indexOf('cycle') >= 0 && (s.indexOf('no') >= 0 || s.indexOf('num') >= 0 || s.indexOf('번호') >= 0 || s.indexOf('index') >= 0)) cyc = c;
      }
      if (vc >= 0 && ic >= 0) { headerIdx = r; vCol = vc; iCol = ic; cCol = cyc; break; }
    }
    if (vCol < 0 || iCol < 0) { setStatus('전압/전류 컬럼을 찾지 못했습니다. 헤더를 확인해 주세요.'); return; }
    var V = [], I = [], C = [];
    for (var r2 = headerIdx + 1; r2 < rows.length; r2++) {
      var row2 = rows[r2]; if (!row2) continue;
      var v = parseFloat(row2[vCol]), i = parseFloat(row2[iCol]);
      if (isNaN(v) || isNaN(i)) continue;
      V.push(v); I.push(i);
      if (cCol >= 0) { var cn = parseFloat(row2[cCol]); C.push(isNaN(cn) ? null : cn); }
    }
    if (V.length < 20) { setStatus('유효한 데이터 행이 부족합니다.'); return; }
    // 파일에 'Cycle No.' 컬럼이 있으면 그 번호를 그대로 사용, 없으면 자동 검출로 폴백
    if (cCol >= 0) buildCyclesFromColumn(V, I, C, filename);
    else buildCycles(V, I, filename);
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

  // 드롭다운을 현재 cvCycles(사이클 목록)로 채운다
  function fillCycleSelect() {
    var sel = $('cvCycleSelect'); if (!sel) return;
    sel.innerHTML = '';
    cvCycles.forEach(function (cc) {
      var o = document.createElement('option');
      o.value = cc.num; o.textContent = cc.num + ' 사이클';
      sel.appendChild(o);
    });
  }

  // [신규] 파일에 기록된 'Cycle No.' 값을 그대로 사용해 사이클을 분리한다.
  //  - 같은 번호의 행을 등장 순서대로 묶어 하나의 사이클(닫힌 I-V 루프)로 만든다.
  //  - 자동 검출 로직을 쓰지 않으므로, 측정기가 저장한 사이클 번호와 100% 일치한다.
  function buildCyclesFromColumn(V, I, C, filename) {
    cvCycles = [];
    var groups = {}, order = [], k;
    for (k = 0; k < V.length; k++) {
      var num = C[k];
      if (num == null) continue;
      if (!Object.prototype.hasOwnProperty.call(groups, num)) { groups[num] = { v: [], i: [] }; order.push(num); }
      groups[num].v.push(V[k]); groups[num].i.push(I[k]);
    }
    order.sort(function (a, b) { return a - b; }); // 사이클 번호 오름차순
    var globalSpan = 0;
    order.forEach(function (num) {
      var g = groups[num], mn = Infinity, mx = -Infinity;
      for (var j = 0; j < g.v.length; j++) { if (g.v[j] < mn) mn = g.v[j]; if (g.v[j] > mx) mx = g.v[j]; }
      g.span = (mx - mn) || 0; if (g.span > globalSpan) globalSpan = g.span;
    });
    order.forEach(function (num) {
      var g = groups[num];
      var d = downsample(g.v, g.i, 0, g.v.length, 6000);
      cvCycles.push({ num: num, V: d.v, I: d.i, span: g.span, npts: g.v.length });
    });
    if (!cvCycles.length) { setStatus('사이클 번호(Cycle No.)를 읽지 못했습니다.'); return; }
    fillCycleSelect();
    setStatus(filename + ' · 파일 기록 사이클 ' + cvCycles.length + '개 (' + order.join(', ') + ')');
    // 기본 표시: 전압 구간이 충분히 넓은(정상 루프) 첫 사이클 — 부분/형성 구간을 피함
    var startNum = cvCycles[0].num;
    for (k = 0; k < cvCycles.length; k++) { if (cvCycles[k].span >= globalSpan * 0.7) { startNum = cvCycles[k].num; break; } }
    var sel = $('cvCycleSelect'); if (sel) sel.value = startNum;
    renderCycle(startNum);
  }

  // [폴백] 파일에 사이클 번호가 없을 때: 전압 스윕 정점으로 자동 검출
  function buildCycles(V, I, filename) {
    var cyc = detectCVCycles(V, I);
    cvCycles = [];
    cyc.forEach(function (c) {
      var d = downsample(V, I, c.a, c.end, 6000);
      cvCycles.push({ num: c.num, V: d.v, I: d.i, span: 0, npts: c.end - c.a });
    });
    if (!cvCycles.length) { setStatus('사이클을 검출하지 못했습니다.'); return; }
    fillCycleSelect();
    setStatus(filename + ' · 총 ' + cvCycles.length + ' 사이클 (자동 검출)');
    // 1번 사이클은 형성(formation) 단계라 이상해 보일 수 있어, 기본값은 중간 사이클로 표시
    var startNum = cvCycles[Math.floor(cvCycles.length / 2)].num;
    var sel = $('cvCycleSelect'); if (sel) sel.value = startNum;
    renderCycle(startNum);
  }

  function renderCycle(num) {
    var cc = null, k;
    for (k = 0; k < cvCycles.length; k++) { if (cvCycles[k].num == num) { cc = cvCycles[k]; break; } }
    if (!cc) return;
    var data = [], j;
    for (j = 0; j < cc.V.length; j++) data.push({ x: cc.V[j], y: cc.I[j] * 1000 });
    renderCVChart(data, num);
    renderPeakTable(detectPeaks(cc, getSensitivity()));
  }

  function renderCVChart(data, num) {
    var el = $('chartCV'); if (!el || typeof Chart === 'undefined') return;
    var ctx = el.getContext('2d');
    if (cvChart) cvChart.destroy();
    // 데이터 기준 x축(전압) 범위를 명시 → CV 루프(시작·끝 전압이 동일)에서 축이 붕괴되는 문제 방지
    var xmin = Infinity, xmax = -Infinity;
    for (var d = 0; d < data.length; d++) { var px = data[d].x; if (px < xmin) xmin = px; if (px > xmax) xmax = px; }
    if (!isFinite(xmin)) { xmin = 0; xmax = 1; }
    cvChart = new Chart(ctx, {
      type: 'line',
      data: { datasets: [{ label: num + ' 사이클', data: data, borderColor: '#f59e0b', borderWidth: 1.3, pointRadius: 0, showLine: true, fill: false, tension: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: {
          x: { type: 'linear', min: xmin, max: xmax, title: { display: true, text: 'Voltage (V)', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.06)' } },
          y: { title: { display: true, text: 'Current (mA)', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.06)' } }
        },
        plugins: { legend: { display: false }, tooltip: { enabled: true } }
      }
    });
  }
  // 피크 검출 민감도(고정값). UI 입력은 제거했고, 내부 자동 검출은 이 값으로 동작한다.
  function getSensitivity() { return 0.08; }

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

  function detectPeaks(cc, sens) {
    // 산화(anodic)=양(+)전류 구간, 환원(cathodic)=음(-)전류 구간으로 나눠 피크 검출
    var aV = [], aI = [], cV = [], cI = [], k;
    for (k = 0; k < cc.V.length; k++) {
      if (cc.I[k] > 0) { aV.push(cc.V[k]); aI.push(cc.I[k]); }
      else if (cc.I[k] < 0) { cV.push(cc.V[k]); cI.push(cc.I[k]); }
    }
    return { anodic: findPeaks(aV, aI, true, sens), cathodic: findPeaks(cV, cI, false, sens) };
  }

  function renderPeakTable(peaks) {
    var el = $('cvPeakTable'); if (!el) return;
    function rowsFor(list, label, color) {
      if (!list.length) return '<tr><td style="padding:4px 6px;color:' + color + ';font-weight:600;">' + label + '</td><td style="padding:4px 6px;color:#6b7280;" colspan="2">검출된 피크 없음 (민감도를 낮춰보세요)</td></tr>';
      return list.map(function (p) {
        return '<tr><td style="padding:4px 6px;color:' + color + ';font-weight:600;">' + label + '</td><td style="padding:4px 6px;">' + p.v.toFixed(3) + ' V</td><td style="padding:4px 6px;color:#9ca3af;">' + (p.i * 1000).toFixed(3) + ' mA</td></tr>';
      }).join('');
    }
    el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="color:#9ca3af;text-align:left;border-bottom:1px solid rgba(255,255,255,0.12);"><th style="padding:4px 6px;">구분</th><th style="padding:4px 6px;">Voltage</th><th style="padding:4px 6px;">Peak Current</th></tr></thead><tbody>' + rowsFor(peaks.anodic, '산화 (Anodic)', '#f59e0b') + rowsFor(peaks.cathodic, '환원 (Cathodic)', '#60a5fa') + '</tbody></table>';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('btnTabCV'); if (btn) btn.addEventListener('click', activateCVTab);
    var fileInput = $('cvFileInput');
    if (fileInput) fileInput.addEventListener('change', function (e) { if (e.target.files && e.target.files[0]) onCVFile(e.target.files[0]); e.target.value = ''; });
    var drop = $('cvDropZone');
    if (drop) {
      drop.addEventListener('click', function () { if (fileInput) fileInput.click(); });
      drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('drag-active'); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('drag-active'); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('drag-active'); if (e.dataTransfer.files && e.dataTransfer.files[0]) onCVFile(e.dataTransfer.files[0]); });
    }
    var sel = $('cvCycleSelect'); if (sel) sel.addEventListener('change', function () { if (this.value) renderCycle(this.value); });
  });
})();
