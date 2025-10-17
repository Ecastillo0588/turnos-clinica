const form = document.querySelector('#range-form');
const fechaDesdeInput = document.querySelector('#fecha-desde');
const fechaHastaInput = document.querySelector('#fecha-hasta');
const fetchBtn = document.querySelector('#fetch-btn');
const statusCard = document.querySelector('#status-card');
const logList = document.querySelector('#log-list');
const summaryCard = document.querySelector('#summary-card');
const summaryGrid = document.querySelector('#summary-grid');
const resumenText = document.querySelector('#resumen-text');
const tableCard = document.querySelector('#table-card');
const dataTableHead = document.querySelector('#data-table thead');
const dataTableBody = document.querySelector('#data-table tbody');
const searchInput = document.querySelector('#search');
const downloadBtn = document.querySelector('#download-csv');
const groupingCard = document.querySelector('#grouping-card');
const groupBySelect = document.querySelector('#group-by');
const groupTableWrapper = document.querySelector('#group-table-wrapper');

let currentRows = [];
let currentLog = [];
const TABLE_HEADERS = [
  'id','fecha','comprobante','estado','cliente_id','cliente_descripcion',
  'vendedor_id','vendedor_descripcion','stock_origen_id','stock_origen_descripcion',
  'observaciones','importe_total','descuento_porcentaje','item','articulo_id',
  'articulo_descripcion','cantidad','precio','descuento_item','importe_item','costo'
];

init();

function init() {
  const today = new Date();
  fechaHastaInput.value = toInputDate(today);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  fechaDesdeInput.value = toInputDate(weekAgo);

  form.addEventListener('submit', onSubmit);
  searchInput.addEventListener('input', onFilterChange);
  downloadBtn.addEventListener('click', downloadCsv);
  groupBySelect.addEventListener('change', () => renderGrouping(currentRows, groupBySelect.value));
}

async function onSubmit(evt) {
  evt.preventDefault();
  const fechaDesde = fechaDesdeInput.value;
  const fechaHasta = fechaHastaInput.value;

  if (!fechaDesde || !fechaHasta) {
    alert('Debés indicar ambas fechas.');
    return;
  }

  if (fechaDesde > fechaHasta) {
    alert('La fecha desde no puede ser mayor a la fecha hasta.');
    return;
  }

  toggleLoading(true);
  resetUI();

  try {
    const params = new URLSearchParams({ fecha_desde: fechaDesde, fecha_hasta: fechaHasta });
    const response = await fetch(`/api/presupuesto-detalle?${params.toString()}`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'No se pudo obtener la información.');
    }

    const payload = await response.json();
    currentRows = Array.isArray(payload.rows) ? payload.rows : [];
    currentLog = Array.isArray(payload.log) ? payload.log : [];

    renderLogs(currentLog);
    renderSummary(payload);
    renderTable(currentRows);
    renderGrouping(currentRows, groupBySelect.value);

    statusCard.classList.remove('hidden');
    summaryCard.classList.remove('hidden');
    tableCard.classList.remove('hidden');
    groupingCard.classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  } finally {
    toggleLoading(false);
  }
}

function renderLogs(logEntries) {
  logList.innerHTML = '';
  if (!logEntries.length) {
    const li = document.createElement('li');
    li.textContent = 'Sin registros';
    logList.appendChild(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of logEntries) {
    const li = document.createElement('li');
    const ts = document.createElement('span');
    ts.className = 'timestamp';
    ts.textContent = formatDateTime(entry.timestamp);
    const level = document.createElement('span');
    level.className = 'level';
    level.textContent = entry.level;
    const message = document.createElement('span');
    message.className = 'message';
    message.textContent = entry.message;
    li.append(level, ts, message);
    fragment.appendChild(li);
  }
  logList.appendChild(fragment);
}

function renderSummary(payload) {
  const metrics = payload.metrics ?? {};
  const resumen = payload.resumen ?? '';
  summaryGrid.innerHTML = '';

  const cards = [
    { label: 'Presupuestos únicos', value: metrics.presupuestos ?? 0 },
    { label: 'Ítems recibidos', value: metrics.items ?? 0 },
    { label: 'Importe total (1 por presupuesto)', value: metrics.totalImporteTotal ?? 0, format: 'currency' },
    { label: 'Importe de ítems', value: metrics.totalImporteItem ?? 0, format: 'currency' },
    { label: 'Cantidad de ítems', value: metrics.totalCantidad ?? 0, format: 'decimal' }
  ];

  const fragment = document.createDocumentFragment();
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = 'summary-card';
    const h3 = document.createElement('h3');
    h3.textContent = card.label;
    const strong = document.createElement('strong');
    if (card.format === 'currency') {
      strong.textContent = formatCurrency(card.value);
    } else if (card.format === 'decimal') {
      strong.textContent = formatDecimal(card.value);
    } else {
      strong.textContent = formatNumber(card.value);
    }
    div.append(h3, strong);
    fragment.appendChild(div);
  }

  summaryGrid.appendChild(fragment);
  resumenText.textContent = resumen;
}

function renderTable(rows) {
  dataTableHead.innerHTML = '';
  dataTableBody.innerHTML = '';

  const headRow = document.createElement('tr');
  TABLE_HEADERS.forEach(header => {
    const th = document.createElement('th');
    th.textContent = header.replace(/_/g, ' ');
    headRow.appendChild(th);
  });
  dataTableHead.appendChild(headRow);

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    TABLE_HEADERS.forEach(header => {
      const td = document.createElement('td');
      const value = row?.[header] ?? '';
      td.textContent = formatCell(header, value);
      tr.appendChild(td);
    });
    fragment.appendChild(tr);
  }
  dataTableBody.appendChild(fragment);

  downloadBtn.disabled = !rows.length;
}

function renderGrouping(rows, column) {
  groupTableWrapper.innerHTML = '';
  if (!column) {
    return;
  }

  const groups = new Map();
  for (const row of rows) {
    const key = (row?.[column] ?? '').toString().trim() || '(sin dato)';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        items: 0,
        presupuestos: new Set(),
        importeItem: 0,
        cantidad: 0
      });
    }
    const entry = groups.get(key);
    entry.items += 1;
    entry.presupuestos.add(row?.id ?? '');
    entry.importeItem += toNumber(row?.importe_item);
    entry.cantidad += toNumber(row?.cantidad);
  }

  const sorted = Array.from(groups.values()).map(group => ({
    grupo: group.key,
    items: group.items,
    presupuestos: group.presupuestos.size,
    importeItem: group.importeItem,
    cantidad: group.cantidad
  })).sort((a, b) => b.importeItem - a.importeItem);

  const table = document.createElement('table');
  table.className = 'group-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['Grupo', 'Presupuestos', 'Ítems', 'Importe ítems', 'Cantidad total'].forEach(text => {
    const th = document.createElement('th');
    th.textContent = text;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  const tbody = document.createElement('tbody');

  for (const group of sorted) {
    const tr = document.createElement('tr');
    const groupCell = document.createElement('td');
    groupCell.textContent = group.grupo;
    const presupCell = document.createElement('td');
    presupCell.innerHTML = `<span class="badge">${formatNumber(group.presupuestos)}</span>`;
    const itemsCell = document.createElement('td');
    itemsCell.textContent = formatNumber(group.items);
    const importeCell = document.createElement('td');
    importeCell.textContent = formatCurrency(group.importeItem);
    const cantidadCell = document.createElement('td');
    cantidadCell.textContent = formatDecimal(group.cantidad);
    tr.append(groupCell, presupCell, itemsCell, importeCell, cantidadCell);
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  groupTableWrapper.appendChild(table);
}

function onFilterChange() {
  const filter = searchInput.value.trim().toLowerCase();
  if (!filter) {
    Array.from(dataTableBody.rows).forEach(row => {
      row.style.display = '';
    });
    return;
  }

  Array.from(dataTableBody.rows).forEach(row => {
    const matches = Array.from(row.cells).some(cell => cell.textContent.toLowerCase().includes(filter));
    row.style.display = matches ? '' : 'none';
  });
}

function downloadCsv() {
  if (!currentRows.length) return;
  const headers = TABLE_HEADERS;
  const lines = [headers.join(',')];
  for (const row of currentRows) {
    const values = headers.map(header => escapeCsv(row?.[header] ?? ''));
    lines.push(values.join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `presupuestos_${fechaDesdeInput.value}_${fechaHastaInput.value}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function resetUI() {
  currentRows = [];
  currentLog = [];
  logList.innerHTML = '';
  summaryGrid.innerHTML = '';
  resumenText.textContent = '';
  dataTableHead.innerHTML = '';
  dataTableBody.innerHTML = '';
  groupTableWrapper.innerHTML = '';
  downloadBtn.disabled = true;
}

function toggleLoading(isLoading) {
  fetchBtn.disabled = isLoading;
  fetchBtn.textContent = isLoading ? 'Consultando…' : 'Consultar';
}

function formatNumber(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat('es-AR').format(number);
}

function formatCurrency(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 }).format(number);
}

function formatDecimal(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number);
}

function formatCell(header, value) {
  const currencyFields = ['importe_total', 'precio', 'importe_item', 'costo'];
  const integerFields = ['cantidad', 'item'];
  const decimalFields = ['descuento_porcentaje', 'descuento_item'];

  if (currencyFields.includes(header)) {
    return formatCurrency(value || 0);
  }
  if (integerFields.includes(header)) {
    return formatNumber(value || 0);
  }
  if (decimalFields.includes(header)) {
    return formatDecimal(value || 0);
  }
  return value ?? '';
}

function formatDateTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return new Intl.DateTimeFormat('es-AR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

function toInputDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function escapeCsv(value) {
  const stringValue = value === null || value === undefined ? '' : String(value);
  if (stringValue.includes('"') || stringValue.includes(',') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}
