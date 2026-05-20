// ─── 상태 ───────────────────────────────────────────────
const GS_URL    = 'https://script.google.com/macros/s/AKfycbzTbofbljbiXTIDM3cdnpPydGYjR-pw-W3dsDlYDisyIAKntTBNhwULZUZ4X4zuuySu0Q/exec';
const GS_TOKEN  = 'TEAM_SECRET_2024';
const ADMIN_PIN = '5552';
let settings  = null;
let records   = [];
let stockData = [];
let currentType        = 'in';
let currentStockFilter = 'ALL';
let lastSyncTime = null;
let stockChart = null;
let currentSerial = null;
let detailItem = null;
let detailTypeFilter = 'ALL';
let hiddenItems = new Set(JSON.parse(localStorage.getItem('hiddenItems') || '[]'));
let showHidden = false;

// ─── 초기화 ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  renderClock();
  setInterval(renderClock, 1000);
  await loadData();
  setInterval(loadData, 5 * 60 * 1000);
});

// ─── 데이터 로드 (Sheets) ────────────────────────────────
async function loadData() {
  if (!GS_URL) return;
  setSyncStatus('syncing');
  try {
    const res  = await fetch(GS_URL + '?action=all&token=' + GS_TOKEN, { cache: 'no-cache' });
    const data = await res.json();

    if (data.status !== 'ok') throw new Error(data.msg || 'API 오류');

    settings  = data.settings  || getDefaultSettings();
    records   = (data.records || []).map(normalizeRecord);
    stockData = data.stock     || [];

    lastSyncTime = new Date();
    setSyncStatus('ok');

    loadSettingsUI(settings);
    renderStock();
    updateCurrentStock();
    if (detailItem) renderItemHistory();

  } catch(e) {
    setSyncStatus('error');
    showToast('데이터 로드 실패: ' + e.message, 'error');
    if (!settings) { settings = getDefaultSettings(); loadSettingsUI(settings); }
  }
}

function setSyncStatus(state) {
  const dot = document.getElementById('sync-dot');
  dot.className = 'sync-indicator ' + state;
}

// ─── 설정 UI 반영 ────────────────────────────────────────
function loadSettingsUI(s) {
  document.getElementById('operators-input').value = (s.operators||[]).join(', ');
  document.getElementById('mcu-models').value      = (s.models?.MCU||[]).join(', ');
  document.getElementById('minipc-models').value   = (s.models?.MINI_PC||[]).join(', ');
  document.getElementById('smps-models').value     = (s.models?.SMPS||[]).join(', ');
  document.getElementById('pcb-models').value      = (s.models?.PCB||[]).join(', ');
  document.getElementById('harness-models').value  = (s.models?.HARNESS||[]).join(', ');
  populateOperators(s.operators || []);
  renderMinStockSettings(s);
}

function populateOperators(ops) {
  const sel = document.getElementById('operator');
  const cur = sel.value;
  sel.innerHTML = '<option value="">-- 선택 --</option>';
  ops.forEach(o => sel.innerHTML += `<option value="${o}">${o}</option>`);
  if (cur) sel.value = cur;
}

// ─── 최소 재고 UI ────────────────────────────────────────
function renderMinStockSettings(s) {
  const container = document.getElementById('minstock-container');
  const models    = s.models   || {};
  const minStock  = s.minStock || {};
  const cats = ['MCU', 'MINI_PC', 'SMPS', 'PCB', 'HARNESS'];
  const catLabel = {MCU:'MCU', MINI_PC:'MINI PC', SMPS:'SMPS', PCB:'PCB & 전자부품', HARNESS:'케이블'};

  let html = '';
  cats.forEach(cat => {
    const mList = models[cat] || [];
    if (!mList.length) return;
    html += `<div style="font-family:var(--mono);font-size:10px;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;margin:14px 0 8px">${catLabel[cat]}</div>`;
    html += '<div class="minstock-grid">';
    mList.forEach(m => {
      const val = minStock[m] !== undefined ? minStock[m] : '';
      html += `<div class="minstock-item">
        <label title="${m}">${m}</label>
        <input type="number" class="minstock-input" data-model="${escapeAttr(m)}" value="${val}" min="0" placeholder="0">
      </div>`;
    });
    html += '</div>';
  });

  container.innerHTML = html || '<p class="minstock-empty">모델을 먼저 등록하고 설정을 저장하면 입력 필드가 나타납니다.</p>';
}

function escapeAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;');
}

// ─── 설정 저장 (Sheets) ──────────────────────────────────
async function saveSettings() {
  const minStock = {};
  document.querySelectorAll('.minstock-input').forEach(inp => {
    const val = parseInt(inp.value);
    if (!isNaN(val) && val >= 0) minStock[inp.dataset.model] = val;
  });

  const newSettings = {
    operators: splitCSV('operators-input'),
    models: {
      MCU:     splitCSV('mcu-models'),
      MINI_PC: splitCSV('minipc-models'),
      SMPS:    splitCSV('smps-models'),
      PCB:     splitCSV('pcb-models'),
      HARNESS: splitCSV('harness-models'),
    },
    minStock
  };
  setLoading(true);
  try {
    await fetchPost({ action: 'saveSettings', settings: newSettings });
    settings = newSettings;
    loadSettingsUI(settings);
    showToast('설정이 Sheets에 저장되었습니다', 'success');
    setSyncStatus('ok');
  } catch(e) {
    showToast('저장 실패: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

function splitCSV(id) {
  return document.getElementById(id).value.split(',').map(s=>s.trim()).filter(Boolean);
}

// ─── 레코드 정규화 (시트 직접 입력 호환) ─────────────────
function normalizeRecord(r) {
  return { ...r, type: normalizeType(r.type), ts: normalizeTs(r.ts) };
}
function normalizeType(t) {
  if (!t) return 'in';
  if (t === '입고') return 'in';
  if (t === '출고') return 'out';
  return String(t).toLowerCase();
}
function normalizeTs(ts) {
  if (!ts) return new Date().toISOString();
  const s = String(ts).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) return s.replace(' ', 'T') + '+09:00';
  return s;
}

// ─── 입출고 타입 ─────────────────────────────────────────
function setType(t) {
  currentType = t;
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.type-btn.' + t).classList.add('active');
  const btn = document.getElementById('submit-btn');
  btn.className = 'submit-btn ' + (t==='in' ? 'in-mode' : 'out-mode');
  btn.textContent = t==='in' ? '▲ 입고 기록' : '▼ 출고 기록';
}

// ─── 모델 업데이트 ───────────────────────────────────────
function updateModels() {
  const cat     = document.getElementById('category').value;
  const modelSel= document.getElementById('model');
  const models  = settings?.models || getDefaultSettings().models;

  modelSel.innerHTML = '<option value="">-- 선택 --</option>';
  if (cat && models[cat]) {
    models[cat].forEach(m => modelSel.innerHTML += `<option value="${m}">${m}</option>`);
  }
  updateCurrentStock();
}

// ─── 현재 재고 표시 ──────────────────────────────────────
function updateCurrentStock() {
  const category = document.getElementById('category').value;
  const model    = document.getElementById('model').value;
  const el       = document.getElementById('current-stock');

  if (!category || !model) {
    el.textContent = '—';
    el.className = 'current-num';
    updateSerialUI();
    return;
  }

  const found = stockData.find(s => s.category === category && s.model === model);
  if (!found) {
    el.textContent = '0';
    el.className = 'current-num ok';
  } else {
    const isLow = found.minQty > 0 && found.qty <= found.minQty;
    el.textContent = found.qty;
    el.className = 'current-num ' + (isLow ? 'low' : 'ok');
  }
  updateSerialUI();
}

function resetSerial() {
  currentSerial = null;
  updateSerialUI();
}

function updateSerialUI() {
  const cat = document.getElementById('category').value;
  const isSerialCat = cat === 'MCU' || cat === 'MINI_PC';
  const serialRow = document.getElementById('serial-row');
  const qtyInput  = document.getElementById('qty-input');
  const qtyBtns   = document.querySelectorAll('.qty-controls button');

  if (currentSerial && isSerialCat) {
    serialRow.style.display = 'block';
    document.getElementById('serial-value').textContent = currentSerial;
    qtyInput.value = 1;
    qtyInput.disabled = true;
    qtyBtns.forEach(b => b.disabled = true);
  } else {
    serialRow.style.display = 'none';
    qtyInput.disabled = false;
    qtyBtns.forEach(b => b.disabled = false);
  }
}

// ─── 수량 ───────────────────────────────────────────────
function changeQty(d) {
  if (currentSerial) return;
  const inp=document.getElementById('qty-input');
  inp.value=Math.max(1,parseInt(inp.value||1)+d);
}
function sanitizeQty(inp) {
  const v = parseInt(inp.value);
  inp.value = isNaN(v) || v < 1 ? 1 : v;
}

// ─── 기록 제출 ───────────────────────────────────────────
async function submitRecord() {
  const operator = document.getElementById('operator').value;
  const category = document.getElementById('category').value;
  const model    = document.getElementById('model').value;
  const qty      = parseInt(document.getElementById('qty-input').value);
  const memo     = document.getElementById('memo').value.trim();

  if (!operator) { showToast('담당자를 선택하세요', 'error'); return; }
  if (!category) { showToast('카테고리를 선택하세요', 'error'); return; }
  if (!model)    { showToast('모델을 선택하세요', 'error'); return; }
  if (!qty||qty<1) { showToast('수량을 확인하세요', 'error'); return; }

  const serial = currentSerial || '';
  const record = {
    id: Date.now(), ts: new Date().toISOString(),
    type: currentType, operator, category, model, qty, memo, serial
  };

  setLoading(true);
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;

  try {
    await fetchPost(record);
    const label = (currentType==='in'?'▲ 입고':'▼ 출고')+' 기록 완료';
    showToast(serial ? label + ' · ' + serial : label + ' ('+qty+'개)', 'success');
    document.getElementById('qty-input').value = 1;
    document.getElementById('memo').value = '';
    const wasSerial = !!serial;
    currentSerial = null;
    await loadData();
    if (wasSerial) {
      setTimeout(() => startScan(), 600);
    }
  } catch(e) {
    showToast('기록 실패: ' + e.message, 'error');
  } finally {
    setLoading(false);
    btn.disabled = false;
  }
}

// ─── fetch POST ──────────────────────────────────────────
async function fetchPost(body) {
  const res = await fetch(GS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ ...body, token: GS_TOKEN })
  });
  try {
    const data = await res.json();
    if (data.status === 'error') throw new Error(data.msg);
    return data;
  } catch(e) {
    return { status: 'ok' };
  }
}

// ─── 재고 차트 ───────────────────────────────────────────
const CAT_COLORS = {
  MCU: '#4f8cff', MINI_PC: '#00e0a1', SMPS: '#ffb347', PCB: '#a78bfa', HARNESS: '#fb923c'
};
const CAT_LABEL = {MCU:'MCU', MINI_PC:'MINI PC', SMPS:'SMPS', PCB:'PCB', HARNESS:'케이블'};

function buildChartData() {
  if (currentStockFilter === 'ALL') {
    const cats = ['MCU', 'MINI_PC', 'SMPS', 'PCB', 'HARNESS'];
    return {
      labels: cats.map(c => CAT_LABEL[c]),
      values: cats.map(c => stockData.filter(s => s.category === c).reduce((sum, s) => sum + (s.qty || 0), 0)),
      colors: cats.map(c => CAT_COLORS[c]),
    };
  }
  const data = stockData.filter(s => s.category === currentStockFilter);
  return {
    labels: data.map(s => s.model),
    values: data.map(s => s.qty || 0),
    colors: data.map(s => (s.minQty > 0 && s.qty <= s.minQty) ? '#ff5c5c' : CAT_COLORS[currentStockFilter] || '#4f8cff'),
  };
}

function renderChart() {
  const canvas = document.getElementById('stock-chart');
  if (!canvas) return;

  const { labels, values, colors } = buildChartData();
  const chartOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#1a1d27',
        borderColor: '#2e3347',
        borderWidth: 1,
        titleColor: '#e8eaf0',
        bodyColor: '#7b82a0',
        callbacks: { label: ctx => ' ' + ctx.parsed.y + ' 개' }
      }
    },
    scales: {
      x: {
        grid: { color: '#2e3347' },
        ticks: { color: '#7b82a0', font: { family: 'IBM Plex Mono', size: 10 } }
      },
      y: {
        grid: { color: '#2e3347' },
        ticks: { color: '#7b82a0', font: { family: 'IBM Plex Mono', size: 10 }, precision: 0 },
        beginAtZero: true
      }
    }
  };

  if (stockChart) {
    stockChart.data.labels = labels;
    stockChart.data.datasets[0].data = values;
    stockChart.data.datasets[0].backgroundColor = colors;
    stockChart.update('none');
  } else {
    stockChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderRadius: 4,
          borderSkipped: false,
        }]
      },
      options: chartOpts
    });
  }
}

// ─── 재고현황 ────────────────────────────────────────────
function filterStock(cat, el) {
  currentStockFilter = cat;
  document.querySelectorAll('.filter-chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  renderStock();
}

function renderStock() {
  const list   = document.getElementById('stock-list');
  const syncEl = document.getElementById('last-sync-text');
  if (lastSyncTime) syncEl.textContent = '최근 동기화: ' + lastSyncTime.toLocaleTimeString('ko-KR');

  renderChart();

  let data = stockData;
  if (currentStockFilter !== 'ALL') data = data.filter(s=>s.category===currentStockFilter);

  const hiddenInView = data.filter(s => hiddenItems.has(s.category+':'+s.model));
  if (!showHidden) data = data.filter(s => !hiddenItems.has(s.category+':'+s.model));

  if (!data.length && !hiddenInView.length) {
    list.innerHTML='<div class="empty-state"><div class="icon">📦</div>기록된 재고가 없습니다</div>';
    return;
  }
  list.innerHTML = data.map(s => {
    const isLow = s.minQty > 0 && s.qty <= s.minQty;
    const lastRec = records
      .filter(r => r.category === s.category && r.model === s.model)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
    const lastStr = lastRec
      ? new Date(lastRec.ts).toLocaleDateString('ko-KR', {month:'2-digit', day:'2-digit'})
        + ' ' + (lastRec.type === 'in' ? '▲' : '▼')
      : null;
    return `<div class="stock-card ${isLow?'low':''}" onclick="openItemDetail('${escapeAttr(s.category)}','${escapeAttr(s.model)}')">
      <span class="stock-cat">${CAT_LABEL[s.category]||s.category}</span>
      <div class="stock-info">
        <div class="stock-model">${s.model}</div>
        ${lastStr ? `<div class="stock-last">${lastStr}</div>` : ''}
      </div>
      <div class="stock-qty">
        <div class="num ${isLow?'low':'ok'}">${s.qty}</div>
        <small>${isLow?'⚠ 부족':'정상'}</small>
      </div>
      <span class="stock-chevron">›</span>
    </div>`;
  }).join('');

  if (hiddenInView.length) {
    list.innerHTML += `<button onclick="toggleShowHidden()" style="width:100%;margin-top:10px;padding:11px;border-radius:8px;border:1px dashed var(--border);background:none;color:var(--muted);font-family:var(--mono);font-size:12px;cursor:pointer;">
      ${showHidden ? '▲ 숨긴 항목 접기' : `⊙ 숨긴 항목 ${hiddenInView.length}개 보기`}
    </button>`;
    if (showHidden) {
      list.innerHTML += hiddenInView.map(s => {
        const lastRec = records.filter(r => r.category===s.category && r.model===s.model).sort((a,b)=>new Date(b.ts)-new Date(a.ts))[0];
        const lastStr = lastRec ? new Date(lastRec.ts).toLocaleDateString('ko-KR',{month:'2-digit',day:'2-digit'})+' '+(lastRec.type==='in'?'▲':'▼') : null;
        return `<div class="stock-card" onclick="openItemDetail('${escapeAttr(s.category)}','${escapeAttr(s.model)}')" style="opacity:0.45;border-style:dashed">
          <span class="stock-cat">${CAT_LABEL[s.category]||s.category}</span>
          <div class="stock-info">
            <div class="stock-model">${s.model}</div>
            ${lastStr?`<div class="stock-last">${lastStr}</div>`:''}
          </div>
          <div class="stock-qty">
            <div class="num ok">${s.qty}</div>
            <small>숨김</small>
          </div>
          <span class="stock-chevron">›</span>
        </div>`;
      }).join('');
    }
  }
}

function toggleShowHidden() {
  showHidden = !showHidden;
  renderStock();
}

// ─── 아이템 상세 드로어 ──────────────────────────────────
function openItemDetail(category, model) {
  detailItem = { category, model };
  detailTypeFilter = 'ALL';

  document.getElementById('detail-title').textContent = model;
  document.getElementById('detail-cat').textContent = (CAT_LABEL[category] || category).toUpperCase();

  const found = stockData.find(s => s.category === category && s.model === model);
  const currentQty = found ? (found.qty || 0) : 0;
  const isLow = found && found.minQty > 0 && currentQty <= found.minQty;
  const itemRecs = records.filter(r => r.category === category && r.model === model);
  const totalIn  = itemRecs.filter(r => r.type === 'in').reduce((s, r) => s + (r.qty || 0), 0);
  const totalOut = itemRecs.filter(r => r.type === 'out').reduce((s, r) => s + (r.qty || 0), 0);

  document.getElementById('detail-stats').innerHTML = `
    <div class="detail-stat">
      <div class="stat-val ${isLow ? 'low' : 'ok'}">${currentQty}</div>
      <div class="stat-lbl">현재고</div>
    </div>
    <div class="detail-stat">
      <div class="stat-val in">${totalIn}</div>
      <div class="stat-lbl">총 입고</div>
    </div>
    <div class="detail-stat">
      <div class="stat-val out">${totalOut}</div>
      <div class="stat-lbl">총 출고</div>
    </div>`;

  document.querySelectorAll('.detail-filter .filter-chip').forEach(c => c.classList.remove('active'));
  document.querySelector('.detail-filter .filter-chip').classList.add('active');

  renderItemHistory();

  const key = category + ':' + model;
  const isHidden = hiddenItems.has(key);
  const hideBtn = document.getElementById('hide-toggle-btn');
  hideBtn.textContent = isHidden ? '⊕ 숨김 해제' : '⊖ 이 항목 숨기기';
  hideBtn.style.color = isHidden ? 'var(--accent2)' : 'var(--muted)';
  hideBtn.style.borderColor = isHidden ? 'rgba(0,224,161,0.3)' : 'var(--border)';

  document.getElementById('detail-overlay').classList.add('visible');
  document.getElementById('detail-drawer').classList.add('visible');
}

function toggleHideItem() {
  if (!detailItem) return;
  const key = detailItem.category + ':' + detailItem.model;
  if (hiddenItems.has(key)) {
    hiddenItems.delete(key);
  } else {
    hiddenItems.add(key);
  }
  localStorage.setItem('hiddenItems', JSON.stringify([...hiddenItems]));
  renderStock();
  closeItemDetail();
  showToast(hiddenItems.has(key) ? '항목이 숨겨졌습니다' : '숨김이 해제되었습니다', 'success');
}

function closeItemDetail() {
  document.getElementById('detail-overlay').classList.remove('visible');
  document.getElementById('detail-drawer').classList.remove('visible');
  detailItem = null;
}

function filterItemHistory(type, el) {
  detailTypeFilter = type;
  document.querySelectorAll('.detail-filter .filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderItemHistory();
}

function renderItemHistory() {
  if (!detailItem) return;
  const list = document.getElementById('detail-history-list');
  let data = records.filter(r => r.category === detailItem.category && r.model === detailItem.model);
  if (detailTypeFilter !== 'ALL') data = data.filter(r => r.type === detailTypeFilter);

  if (!data.length) {
    list.innerHTML = '<div class="empty-state"><div class="icon">📋</div>기록이 없습니다</div>';
    return;
  }
  list.innerHTML = data.map(r => {
    const d = new Date(r.ts);
    const dateStr = d.toLocaleDateString('ko-KR') + ' ' + d.toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'});
    return `<div class="hist-item">
      <span class="hist-badge ${r.type}">${r.type === 'in' ? '▲ 입고' : '▼ 출고'}</span>
      <div class="hist-info">
        <div class="hist-meta">${r.operator || '—'}</div>
        <div class="hist-meta">${dateStr}${r.memo ? ' · ' + r.memo : ''}${r.serial ? ' · SN:' + r.serial : ''}</div>
      </div>
      <div class="hist-qty">${r.qty ?? '—'}개</div>
    </div>`;
  }).join('');
}

function goRecord(type) {
  if (!detailItem) return;
  closeItemDetail();
  setType(type);
  const catSel = document.getElementById('category');
  catSel.value = detailItem.category;
  updateModels();
  document.getElementById('model').value = detailItem.model;
  updateCurrentStock();
  const navBtn = document.querySelector('nav button');
  switchTab('record', navBtn);
}

// ─── Data Matrix / QR 스캔 (zxing-wasm) ─────────────────
let scanStream  = null;
let scanTimer   = null;
let zxingRead   = null;
let isDecoding  = false;

async function loadZxingWasm() {
  if (zxingRead) return zxingRead;
  const { readBarcodesFromImageData } = await import(
    'https://esm.sh/zxing-wasm@2/reader'
  );
  zxingRead = readBarcodesFromImageData;
  return zxingRead;
}

async function startScan() {
  document.getElementById('scan-manual').value = '';
  document.getElementById('scan-overlay').classList.add('visible');

  try {
    const readBarcodes = await loadZxingWasm();

    const allDevices  = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = allDevices.filter(d => d.kind === 'videoinput');
    const back = videoDevices.find(d => /back|rear|후면/i.test(d.label));
    const deviceId = (back || videoDevices[videoDevices.length - 1])?.deviceId;

    scanStream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }
    });

    const video = document.getElementById('scan-video');
    video.srcObject = scanStream;
    await video.play();

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d', { willReadFrequently: true });

    scanTimer = setInterval(async () => {
      if (isDecoding || !scanStream) return;
      if (video.readyState < video.HAVE_ENOUGH_DATA) return;

      isDecoding = true;
      try {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const results   = await readBarcodes(imageData, {
          formats:   ['DataMatrix', 'QRCode'],
          tryHarder: true,
        });
        if (results.length > 0) {
          const code = results[0].text.trim();
          closeScan();
          applyScannedCode(code);
        }
      } finally {
        isDecoding = false;
      }
    }, 150);

  } catch(e) {
    showToast('카메라 접근 실패: ' + (e.message || e), 'error');
    closeScan();
  }
}

function closeScan() {
  document.getElementById('scan-overlay').classList.remove('visible');
  if (scanTimer)  { clearInterval(scanTimer); scanTimer = null; }
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  isDecoding = false;
}

function applyScannedCode(code) {
  if (!code) return;
  const models = settings?.models || {};

  let modelCode = code;
  let serial = null;
  if (code.length > 10 && /^\d{10}$/.test(code.slice(-10))) {
    modelCode = code.slice(0, -10);
    serial = code;
  }

  for (const [cat, mList] of Object.entries(models)) {
    const match = mList.find(m => m === modelCode || m.toLowerCase() === modelCode.toLowerCase());
    if (match) {
      document.getElementById('category').value = cat;
      updateModels();
      document.getElementById('model').value = match;
      currentSerial = serial;
      updateCurrentStock();
      const msg = serial ? `모델: ${match} · SN: ${serial}` : `모델 인식: ${match}`;
      showToast(msg, 'success');
      switchTab('record', document.querySelector('nav button'));
      return;
    }
  }
  showToast('일치하는 모델 없음 — 직접 선택하세요: ' + code, 'warn');
}

// ─── 탭 전환 ─────────────────────────────────────────────
function switchTab(name, btn) {
  if (name === 'settings') {
    const pin = prompt('관리자 PIN을 입력하세요');
    if (pin === null) return;
    if (pin !== ADMIN_PIN) { showToast('PIN이 올바르지 않습니다', 'error'); return; }
  }
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  btn.classList.add('active');
  if (name === 'stock') renderChart();
}

// ─── 유틸 ────────────────────────────────────────────────
function renderClock() {
  document.getElementById('clock').textContent=new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function setLoading(v) {
  document.getElementById('loading-overlay').classList.toggle('visible', v);
}
function showToast(msg,type='success') {
  const t=document.getElementById('toast');
  t.textContent=msg; t.className='toast '+type; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2800);
}
function getDefaultSettings() {
  return {
    operators:['창고지기'],
    models:{MCU:['STM32F4','ATmega328','ESP32'],MINI_PC:['Raspberry Pi 4','Jetson Nano'],SMPS:['24V 5A','12V 10A'],PCB:['메인보드 Rev1','센서보드 Rev2'],HARNESS:['전원 하네스 A','CAN 케이블']},
    minStock:{}
  };
}
