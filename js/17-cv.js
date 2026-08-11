/* ============================================================================
 * HC-Analyzer  ·  js/16-cv.js   (CV = Cyclic Voltammetry 분석 · 독립 모듈)
 * CV 파일(전압/전류)을 CV 탭에서 업로드 → 사이클 분리 → I-V 곡선 → 사이클 드롭다운
 * → 산화/환원 피크 전압 자동 검출. 기존 충방전 코드는 건드리지 않음. 엑셀은 js/xlsx-worker.js 재사용.
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
    var headerIdx = -1, vCol = -1, iCol = -1;
    for (var r = 0; r < Math.min(20, rows.length); r++) {
      var row = rows[r]; if (!row) continue;
      var vc = -1, ic = -1;
      for (var c = 0; c < row.length; c++) {
        var s = String(row[c] == null ? '' : row[c]).toLowerCase().trim();
        if (vc < 0 && (s.indexOf('voltage') >= 0 || s.indexOf('전압') >= 0 || s.indexOf('v vs') >= 0 || s === 'v' || s.indexOf('potential') >= 0)) vc = c;
        if (ic < 0 && (s.indexOf('current') >= 0 || s.indexOf('전류') >= 0 || s === 'i' || s.indexOf('(a)') >= 0 || s.indexOf('(ma)') >= 0 || s.indexOf('i(') >= 0)) ic = c;
      }
      if (vc >= 0 && ic >= 0) { headerIdx = r; vCol = vc; iCol = ic; break; }
    }
    if (vCol < 0 || iCol < 0) { setStatus('전압/전류 컬럼을 찾지 못했습니다. 헤더를 확인해 주세요.'); return; }
    var V = [], I = [];
    for (var r2 = headerIdx + 1; r2 < rows.length; r2++) {
      var row2 = rows[r2]; if (!row2) continue;
      var v = parseFloat(row2[vCol]), i = parseFloat(row2[iCol]);
      if (isNaN(v) || isNaN(i)) continue;
      V.push(v); I.push(i);
    }
    if (V.length < 20) { setStatus('유효한 데이터 행이 부족합니다.'); return; }
    buildCycles(V, I, filename);
  }

  function detectCVCycles(V, I) {
    var n = V.length, k, vmin = Infinity, vmax = -Infinity;
    for (k = 0; k < n; k++) { if (V[k] < vmin) vmin = V[k]; if (V[k] > vmax) vmax = V[k]; }
    var thr = (vmax - vmin) * 0.03, turns = [], dir = 0, ext = V[0];
    for (k = 1; k < n; k++) {
      var dv = V[k] - ext;
      if (dir === 0) { if (Math.abs(dv) > thr) { dir = dv > 0 ? 1 : -1; ext = V[k]; } }
      else {
        if ((dir > 0 && V[k] > ext) || (dir < 0 && V[k] < ext)) ext = V[k];
        else if (Math.abs(V[k] - ext) > thr) { turns.push(k); dir = -dir; ext = V[k]; }
      }
    }
    var bounds = [0].concat(turns).concat([n]), sweeps = [];
    for (var s = 0; s < bounds.length - 1; s++) {
      var a = bounds[s], b = bounds[s + 1];
      if (b - a >= 10) sweeps.push({ a: a, b: b, up: V[b - 1] > V[a] });
    }
    var cycles = [], i = 0, num = 0;
    while (i < sweeps.length) {
      var sw = sweeps[i];
      if (sw.up && i + 1 < sweeps.length && !sweeps[i + 1].up) { num++; cycles.push({ num: num, a: sw.a, mid: sw.b, end: sweeps[i + 1].b }); i += 2; }
      else i++;
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

  function buildCycles(V, I, filename) {
    var cyc = detectCVCycles(V, I);
    cvCycles = [];
    cyc.forEach(function (c) {
      var an = downsample(V, I, c.a, c.mid, 1500), ca = downsample(V, I, c.mid, c.end, 1500);
      cvCycles.push({ num: c.num, anodicV: an.v, anodicI: an.i, cathodicV: ca.v, cathodicI: ca.i });
    });
    var sel = $('cvCycleSelect');
    if (sel) {
      sel.innerHTML = '';
      cvCycles.forEach(function (cc) { var o = document.createElement('option'); o.value = cc.num; o.textContent = cc.num + ' 사이클'; sel.appendChild(o); });
    }
    if (!cvCycles.length) { setStatus('사이클을 검출하지 못했습니다.'); return; }
    setStatus(filename + ' · 총 ' + cvCycles.length + ' 사이클');
    if (sel) sel.value = cvCycles[0].num;
    renderCycle(cvCycles[0].num);
  }

  function renderCycle(num) {
    var cc = null, k;
    for (k = 0; k < cvCycles.length; k++) { if (cvCycles[k].num == num) { cc = cvCycles[k]; break; } }
    if (!cc) return;
    var data = [], j;
    for (j = 0; j < cc.anodicV.length; j++) data.push({ x: cc.anodicV[j], y: cc.anodicI[j] * 1000 });
    for (j = 0; j < cc.cathodicV.length; j++) data.push({ x: cc.cathodicV[j], y: cc.cathodicI[j] * 1000 });
    renderCVChart(data, num);
    renderPeakTable(detectPeaks(cc, getSensitivity()));
  }

  function renderCVChart(data, num) {
    var el = $('chartCV'); if (!el || typeof Chart === 'undefined') return;
    var ctx = el.getContext('2d');
    if (cvChart) cvChart.destroy();
    cvChart = new Chart(ctx, {
      type: 'line',
      data: { datasets: [{ label: num + ' 사이클', data: data, parsing: false, borderColor: '#f59e0b', borderWidth: 1.3, pointRadius: 0, showLine: true, fill: false, tension: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Voltage (V)', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.06)' } },
          y: { title: { display: true, text: 'Current (mA)', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.06)' } }
        },
        plugins: { legend: { display: false }, tooltip: { enabled: true } }
      }
    });
  }

  function getSensitivity() {
    var el = $('cvSensitivity'), v = el ? parseFloat(el.value) : 0.08;
    if (isNaN(v) || v <= 0) v = 0.08;
    return v;
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

  function detectPeaks(cc, sens) {
    return { anodic: findPeaks(cc.anodicV, cc.anodicI, true, sens), cathodic: findPeaks(cc.cathodicV, cc.cathodicI, false, sens) };
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
    var sens = $('cvSensitivity'); if (sens) sens.addEventListener('change', function () { var s = $('cvCycleSelect'); if (s && s.value) renderCycle(s.value); });
  });
})();
