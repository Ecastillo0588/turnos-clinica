const $ = sel => document.querySelector(sel);
const statusEl = $('#status');
const btnFetch = $('#btn-fetch');
const btnCsv = $('#btn-csv');
const inputDesde = $('#f-desde');
const inputHasta = $('#f-hasta');

const tblVendBody = $('#tbl-vendedores tbody');
const tblDetBody = $('#tbl-detalle tbody');
const paginacion = $('#paginacion');

let rows = [];
let page = 1;
const pageSize = 50;

init();

function init() {
  // default: hoy
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  inputDesde.value = `${y}-${m}-${d}`;
  inputHasta.value = `${y}-${m}-${d}`;

  btnFetch.addEventListener('click', fetchData);
  btnCsv.addEventListener('click', exportCSV);

  setStatus('Listo.');
}

async function fetchData() {
  const from = inputDesde.value;
  const to = inputHasta.value || from;
  if (!from) {
    alert('Elegí al menos la fecha "Desde".');
    return;
  }

  disableUI(true);
  setStatus('Consultando servicio…');

  try {
    // Llamamos a la API serverless del proyecto
    const url = `/api/presupuesto_detalle?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(json.error || 'Error de API');

    rows = json.data || [];
    page = 1;

    // Agregados por vendedor
    const agg = aggregateBySeller(rows);

    // Métricas arriba
    $('#m-rows').textContent = fmtInt(rows.length);
    $('#m-vendedores').textContent = fmtInt(Object.keys(agg).length);
    $('#m-importe').textContent = fmtMoney(Object.values(agg).reduce((s, v) => s + v.importe, 0));

    // Render top vendedores
    renderVendedores(agg);

    // Render detalle paginado
    renderDetalle();

    btnCsv.disabled = rows.length === 0;
    setStatus(`OK. Filas=${rows.length}. Rango ${json.from} → ${json.to}`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
    alert(err.message);
  } finally {
    disableUI(false);
  }
}

function aggregateBySeller(data) {
  const map = new Map();
  for (const r of data) {
    const key = r.vendedor_descripcion || r.vendedor_id || 'SIN VENDEDOR';
    const cur = map.get(key) || { vendedor: key, items: 0, cantidad: 0, importe: 0, precioAcum: 0 };
    cur.items += 1;
    cur.cantidad += Number(r.cantidad || 0);
    cur.importe += Number(r.importe_item || 0);
    cur.precioAcum += Number(r.precio || 0);
    map.set(key, cur);
  }
  // array ordenado desc por importe
  const arr = Array.from(map.values())
    .map(v => ({ ...v, precioProm: v.items ? v.precioAcum / v.items : 0, ticketProm: v.items ? v.importe / v.items : 0 }))
    .sort((a, b) => b.importe - a.importe);

  // de vuelta a objeto { vendedor: stats }
  const out = {};
  for (const v of arr) out[v.vendedor] = v;
  return out;
}

function renderVendedores(agg) {
  const arr = Object.values(agg).sort((a,b)=>b.importe-a.importe);
  tblVendBody.innerHTML = '';
  for (const v of arr) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(v.vendedor)}</td>
      <td>${fmtInt(v.items)}</td>
      <td>${fmtInt(v.cantidad)}</td>
      <td>${fmtMoney(v.importe)}</td>
      <td>${fmtMoney(v.precioProm)}</td>
      <td>${fmtMoney(v.ticketProm)}</td>
    `;
    tblVendBody.appendChild(tr);
  }
}

function renderDetalle() {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  page = Math.min(page, totalPages);
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);

  tblDetBody.innerHTML = '';
  for (const r of slice) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(r.fecha)}</td>
      <td>${esc(r.comprobante)}</td>
      <td>${esc(r.estado)}</td>
      <td>${esc(r.cliente_descripcion)}</td>
      <td>${esc(r.vendedor_descripcion || r.vendedor_id)}</td>
      <td>${esc(r.articulo_descripcion || r.articulo_id)}</td>
      <td>${fmtInt(r.cantidad)}</td>
      <td>${fmtMoney(r.precio)}</td>
      <td>${fmtMoney(r.importe_item)}</td>
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

function exportCSV() {
  if (!rows.length) return;
  const headers = [
    'id','fecha','comprobante','estado','cliente_id','cliente_descripcion',
    'vendedor_id','vendedor_descripcion','stock_origen_id','stock_origen_descripcion',
    'observaciones','importe_total','descuento_porcentaje','item','articulo_id',
    'articulo_descripcion','cantidad','precio','descuento_item','importe_item','costo'
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const row = headers.map(h => csvCell(r[h]));
    lines.push(row.join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `presupuestos_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ============ utils UI ============ */
function setStatus(msg) { statusEl.textContent = msg; }
function disableUI(disabled) {
  btnFetch.disabled = disabled;
  btnCsv.disabled = disabled || rows.length === 0;
  inputDesde.disabled = disabled;
  inputHasta.disabled = disabled;
}
function fmtMoney(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('es-AR');
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
