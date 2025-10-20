const $ = sel => document.querySelector(sel);
const statusEl = $('#status');
const btnFetch = $('#btn-fetch');
const btnCsv = $('#btn-csv');
const inputDesde = $('#f-desde');
const inputHasta = $('#f-hasta');

const chartVendedoresEl = $('#chartVendedores');
const chartClientesEl = $('#chartClientes');
const topVendInput = $('#top-vendedores');
const topCliInput = $('#top-clientes');

const tblVendParetoBody = $('#tbl-pareto-articulos tbody');
const tblCliParetoBody = $('#tbl-pareto-clientes tbody');

const tblHeadsBody = $('#tbl-heads tbody');
const paginacionHeads = $('#paginacion-heads');

const tblDetBody = $('#tbl-detalle tbody');
const paginacion = $('#paginacion');

const drawer = $('#drawer');
const drawerClose = $('#drawer-close');
const drawerTitle = $('#drawer-title');
const drawerMeta = $('#drawer-meta');
const drawerTableBody = $('#drawer-table tbody');

let rows = [];           // ítems crudos
let heads = [];          // cabeceras agrupadas
let page = 1;            // paginado detalle
let pageHeads = 1;
const pageSize = 50;
const pageSizeHeads = 30;

let chartVend = null;
let chartCli = null;

/* =================== INIT =================== */
init();
function init() {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  inputDesde.value = localStorage.getItem('from') || `${y}-${m}-${d}`;
  inputHasta.value = localStorage.getItem('to') || `${y}-${m}-${d}`;

  btnFetch.addEventListener('click', fetchData);
  btnCsv.addEventListener('click', exportCSV);
  drawerClose.addEventListener('click', () => drawer.classList.remove('open'));
  topVendInput.addEventListener('change', () => drawCharts());
  topCliInput.addEventListener('change', () => drawCharts());

  setStatus('Listo.');
}

/* =================== FETCH =================== */
async function fetchData() {
  const from = inputDesde.value;
  const to = inputHasta.value || from;
  if (!from) { alert('Elegí al menos la fecha "Desde".'); return; }
  if (to < from) { alert('La fecha Hasta no puede ser menor que Desde.'); return; }

  localStorage.setItem('from', from);
  localStorage.setItem('to', to);

  disableUI(true);
  setStatus('Consultando servicio…');

  try {
    const url = `/api/presupuesto_detalle?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(json.error || 'Error de API');

    rows = (json.data || []).map(normalizeRow);
    page = 1;

    // AGREGADOS
    const aggVend = aggregateByKey(rows, r => r.vendedor_descripcion || r.vendedor_id || 'SIN VENDEDOR');
    const aggCli  = aggregateByKey(rows, r => r.cliente_descripcion || r.cliente_id || 'SIN CLIENTE');
    const aggArt  = aggregateByKey(rows, r => r.articulo_descripcion || r.articulo_id || 'SIN ARTÍCULO');

    // HEADS
    heads = buildHeads(rows);

    // KPI generales
    const kpi = kpis(rows);
    $('#m-rows').textContent = fmtInt(rows.length);
    $('#m-vendedores').textContent = fmtInt(Object.keys(aggVend).length);
    $('#m-importe').textContent = fmtMoney(kpi.ingresos);
    $('#m-margen').textContent = `${fmtPct(kpi.margenPct)}`;
    $('#m-margen-detalle').textContent = `Ingresos: ${fmtMoney(kpi.ingresos)} · Costos: ${fmtMoney(kpi.costos)}`;

    // CHARTS
    drawCharts(aggVend, aggCli);

    // PARETOS
    renderPareto(tblVendParetoBody, aggArt);
    renderPareto(tblCliParetoBody, aggCli);

    // HEADS + DETALLE
    renderHeads();
    renderDetalle();

    btnCsv.disabled = rows.length === 0;
    setStatus(`OK. Ítems=${rows.length}. Rango ${json.from} → ${json.to}`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
    alert(err.message);
  } finally {
    disableUI(false);
  }
}

/* =================== AGG / HEADS =================== */
function normalizeRow(r) {
  // margen por ítem
  const cant = Number(r.cantidad)||0;
  const ingreso = Number(r.importe_item)||0;
  const costo = (Number(r.costo)||0) * cant;
  const margen = ingreso - costo;
  const pct = ingreso > 0 ? margen/ingreso : 0;
  return { ...r, _cant:cant, _ingreso:ingreso, _costo:costo, _margen:margen, _pct:pct };
}

function aggregateByKey(data, keyFn) {
  const map = new Map();
  for (const r of data) {
    const k = keyFn(r);
    const cur = map.get(k) || { key:k, items:0, cantidad:0, ingreso:0, costo:0, margen:0 };
    cur.items += 1;
    cur.cantidad += r._cant;
    cur.ingreso += r._ingreso;
    cur.costo += r._costo;
    cur.margen += r._margen;
    map.set(k, cur);
  }
  // devolver ordenado por ingreso desc
  return Object.fromEntries(
    Array.from(map.values()).sort((a,b)=>b.ingreso-a.ingreso).map(v => [v.key, v])
  );
}

function buildHeads(data) {
  const byId = new Map();
  for (const r of data) {
    const id = r.id || '(sin id)';
    const h = byId.get(id) || {
      id, fecha: r.fecha, comprobante: r.comprobante, estado: r.estado,
      cliente: r.cliente_descripcion || r.cliente_id,
      vendedor: r.vendedor_descripcion || r.vendedor_id,
      items: 0, ingreso: 0, costo: 0, margen: 0, pct: 0, rows: []
    };
    h.items += 1;
    h.ingreso += r._ingreso;
    h.costo += r._costo;
    h.margen += r._margen;
    h.rows.push(r);
    byId.set(id, h);
  }
  for (const h of byId.values()) h.pct = h.ingreso > 0 ? h.margen / h.ingreso : 0;
  return Array.from(byId.values()).sort((a,b)=> (a.fecha===b.fecha ? b.ingreso-a.ingreso : (a.fecha<b.fecha?1:-1)));
}

function kpis(data) {
  const ingresos = data.reduce((s,r)=>s+r._ingreso,0);
  const costos   = data.reduce((s,r)=>s+r._costo,0);
  const margen   = ingresos - costos;
  return { ingresos, costos, margen, margenPct: ingresos>0 ? margen/ingresos : 0 };
}

/* =================== CHARTS =================== */
function drawCharts(aggVendOpt, aggCliOpt) {
  const topVend = clamp(Number(topVendInput.value)||10,3,50);
  const topCli  = clamp(Number(topCliInput.value)||10,3,50);

  const aggVend = aggVendOpt || aggregateByKey(rows, r => r.vendedor_descripcion || r.vendedor_id || 'SIN VENDEDOR');
  const aggCli  = aggCliOpt  || aggregateByKey(rows, r => r.cliente_descripcion || r.cliente_id || 'SIN CLIENTE');

  const vendArr = Object.values(aggVend).slice(0, topVend);
  const cliArr  = Object.values(aggCli).slice(0, topCli);

  const vendLabels = vendArr.map(v=>v.key);
  const vendData = vendArr.map(v=>round2(v.ingreso));

  const cliLabels = cliArr.map(v=>v.key);
  const cliData = cliArr.map(v=>round2(v.ingreso));

  if (chartVend) chartVend.destroy();
  chartVend = new Chart(chartVendedoresEl, {
    type: 'bar',
    data: { labels: vendLabels, datasets: [{ label: 'Ingreso', data: vendData }] },
    options: { responsive: true, plugins: { legend: { display:false }, tooltip: { callbacks:{ label:(ctx)=>fmtMoney(ctx.parsed.y) } } },
      scales:{ y:{ ticks:{ callback:v=>fmtMoney(v)} } } }
  });

  if (chartCli) chartCli.destroy();
  chartCli = new Chart(chartClientesEl, {
    type: 'bar',
    data: { labels: cliLabels, datasets: [{ label: 'Ingreso', data: cliData }] },
    options: { responsive: true, plugins: { legend: { display:false }, tooltip: { callbacks:{ label:(ctx)=>fmtMoney(ctx.parsed.y) } } },
      scales:{ y:{ ticks:{ callback:v=>fmtMoney(v)} } } }
  });
}

/* =================== PARETO =================== */
function renderPareto(tbody, agg) {
  const arr = Object.values(agg);
  const total = arr.reduce((s,v)=>s+v.ingreso,0) || 1;
  let acum = 0;
  tbody.innerHTML = '';
  arr.forEach((v, i) => {
    const pct = v.ingreso/total;
    acum += pct;
    const tr = document.createElement('tr');
    const badge = acum <= 0.8 ? 'badge ok' : (acum <= 0.95 ? 'badge warn' : 'badge danger');
    tr.innerHTML = `
      <td>${i+1}</td>
      <td>${esc(v.key)} <span class="${badge}">${(acum*100).toFixed(1)}%</span></td>
      <td>${fmtMoney(v.ingreso)}</td>
      <td>${(pct*100).toFixed(1)}%</td>
      <td>${(acum*100).toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  });
}

/* =================== RENDER HEADS =================== */
function renderHeads() {
  const totalPages = Math.max(1, Math.ceil(heads.length / pageSizeHeads));
  pageHeads = Math.min(pageHeads, totalPages);
  const start = (pageHeads - 1) * pageSizeHeads;
  const slice = heads.slice(start, start + pageSizeHeads);

  tblHeadsBody.innerHTML = '';
  for (const h of slice) {
    const tr = document.createElement('tr');
    tr.classList.add('clickable');
    tr.addEventListener('click', () => openDrawer(h));
    tr.innerHTML = `
      <td>${esc(fmtDate(h.fecha))}</td>
      <td>${esc(h.id)}</td>
      <td>${esc(h.comprobante)}</td>
      <td>${esc(h.cliente)}</td>
      <td>${esc(h.vendedor)}</td>
      <td>${fmtInt(h.items)}</td>
      <td>${fmtMoney(h.ingreso)}</td>
      <td>${fmtMoney(h.costo)}</td>
      <td>${fmtMoney(h.margen)}</td>
      <td>${fmtPct(h.pct)}</td>
    `;
    tblHeadsBody.appendChild(tr);
  }

  paginacionHeads.innerHTML = '';
  for (let i = 1; i <= totalPages; i++) {
    const b = document.createElement('button');
    b.textContent = i;
    if (i === pageHeads) b.classList.add('active');
    b.addEventListener('click', () => { pageHeads = i; renderHeads(); });
    paginacionHeads.appendChild(b);
  }
}

function openDrawer(h) {
  drawerTitle.textContent = `Presupuesto ${h.id} · ${fmtDate(h.fecha)}`;
  drawerMeta.innerHTML = `
    <div><b>Cliente:</b> ${esc(h.cliente)}</div>
    <div><b>Vendedor:</b> ${esc(h.vendedor)}</div>
    <div><b>Ingreso:</b> ${fmtMoney(h.ingreso)} · <b>Costo:</b> ${fmtMoney(h.costo)} · <b>Margen:</b> ${fmtMoney(h.margen)} (${fmtPct(h.pct)})</div>
  `;
  drawerTableBody.innerHTML = '';
  for (const r of h.rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(r.articulo_descripcion || r.articulo_id)}</td>
      <td>${fmtInt(r._cant)}</td>
      <td>${fmtMoney(r.precio)}</td>
      <td>${fmtMoney(r._ingreso)}</td>
      <td>${fmtMoney(r._costo)}</td>
      <td>${fmtMoney(r._margen)}</td>
      <td>${fmtPct(r._pct)}</td>
    `;
    drawerTableBody.appendChild(tr);
  }
  drawer.classList.add('open');
}

/* =================== RENDER DETALLE =================== */
function renderDetalle() {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  page = Math.min(page, totalPages);
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);

  tblDetBody.innerHTML = '';
  for (const r of slice) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(fmtDate(r.fecha))}</td>
      <td>${esc(r.comprobante)}</td>
      <td>${esc(r.estado)}</td>
      <td>${esc(r.cliente_descripcion)}</td>
      <td>${esc(r.vendedor_descripcion || r.vendedor_id)}</td>
      <td>${esc(r.articulo_descripcion || r.articulo_id)}</td>
      <td>${fmtInt(r._cant)}</td>
      <td>${fmtMoney(r.precio)}</td>
      <td>${fmtMoney(r._ingreso)}</td>
      <td>${fmtMoney(r._costo)}</td>
      <td>${fmtMoney(r._margen)}</td>
      <td>${fmtPct(r._pct)}</td>
    `;
    tblDetBody.appendChild(tr);
  }

  paginacion.innerHTML = '';
  for (let i = 1; i <= totalPages; i++) {
    const b = document.createElement('button');
    b.textContent = i;
    if (i === page) b.classList.add('active');
    b.addEventListener('click', () => { page = i; renderDetalle(); });
    paginacion.appendChild(b);
  }
}

/* =================== EXPORT =================== */
function exportCSV() {
  if (!rows.length) return;
  const headers = [
    'id','fecha','comprobante','estado','cliente_id','cliente_descripcion',
    'vendedor_id','vendedor_descripcion','stock_origen_id','stock_origen_descripcion',
    'observaciones','importe_total','descuento_porcentaje','item','articulo_id',
    'articulo_descripcion','cantidad','precio','descuento_item','importe_item','costo',
    '_cant','_ingreso','_costo','_margen','_pct'
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const row = headers.map(h => csvCell(r[h]));
    lines.push(row.join(','));
  }
  downloadCSV(lines.join('\n'), `presupuestos_${Date.now()}.csv`);
}

/* =================== UTILS =================== */
function setStatus(msg) { statusEl.textContent = msg; }
function disableUI(disabled) {
  btnFetch.disabled = disabled;
  btnCsv.disabled = disabled || rows.length === 0;
  inputDesde.disabled = disabled;
  inputHasta.disabled = disabled;
  [topVendInput, topCliInput].forEach(e=>e.disabled = disabled);
}
function fmtMoney(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('es-AR');
}
function fmtPct(p) { return (Number(p||0)*100).toFixed(1) + '%'; }
function fmtDate(ymd) {
  if (!ymd) return '';
  const [Y,M,D] = String(ymd).split('-');
  return `${D}/${M}/${Y}`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function csvCell(v) { if (v===null || v===undefined) return ''; const s=String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; }
function downloadCSV(text, name) { const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function round2(x){ return Math.round((Number(x)||0)*100)/100; }
