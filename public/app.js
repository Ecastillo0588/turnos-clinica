const form = document.querySelector('#range-form');
const fechaDesdeInput = document.querySelector('#fecha-desde');
const fechaHastaInput = document.querySelector('#fecha-hasta');
const fetchBtn = document.querySelector('#fetch-btn');
const statusCard = document.querySelector('#status-card');
const logList = document.querySelector('#log-list');
const summaryCard = document.querySelector('#summary-card');
const summaryGrid = document.querySelector('#summary-grid');
const resumenText = document.querySelector('#resumen-text');
const filtersCard = document.querySelector('#filters-card');
const vendedorSelect = document.querySelector('#filter-vendedor');
const clienteSelect = document.querySelector('#filter-cliente');
const articuloInput = document.querySelector('#filter-articulo');
const articulosDatalist = document.querySelector('#articulos-sugeridos');
const clearFiltersBtn = document.querySelector('#clear-filters');
const chartsCard = document.querySelector('#charts-card');
const tableCard = document.querySelector('#table-card');
const dataTableHead = document.querySelector('#data-table thead');
const dataTableBody = document.querySelector('#data-table tbody');
const searchInput = document.querySelector('#search');
const downloadBtn = document.querySelector('#download-csv');
const groupingCard = document.querySelector('#grouping-card');
const groupBySelect = document.querySelector('#group-by');
const groupTableWrapper = document.querySelector('#group-table-wrapper');

const chartElements = {
  vendedores: document.querySelector('#chart-vendedores'),
  clientes: document.querySelector('#chart-clientes'),
  articulos: document.querySelector('#chart-articulos')
};

let originalRows = [];
let filteredRows = [];
let currentLog = [];
let baseResumen = '';
let originalMetrics = null;
const chartInstances = {};

const activeFilters = {
  search: '',
  vendedor: '',
  cliente: '',
  articulo: ''
};

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
  searchInput.addEventListener('input', () => {
    activeFilters.search = searchInput.value.trim().toLowerCase();
    applyFilters();
  });
  vendedorSelect.addEventListener('change', () => {
    activeFilters.vendedor = vendedorSelect.value;
    applyFilters();
  });
  clienteSelect.addEventListener('change', () => {
    activeFilters.cliente = clienteSelect.value;
    applyFilters();
  });
  articuloInput.addEventListener('input', () => {
    activeFilters.articulo = articuloInput.value.trim().toLowerCase();
    applyFilters();
  });
  clearFiltersBtn.addEventListener('click', () => {
    vendedorSelect.value = '';
    clienteSelect.value = '';
    articuloInput.value = '';
    searchInput.value = '';
    activeFilters.vendedor = '';
    activeFilters.cliente = '';
    activeFilters.articulo = '';
    activeFilters.search = '';
    applyFilters();
  });
  downloadBtn.addEventListener('click', downloadCsv);
  groupBySelect.addEventListener('change', () => renderGrouping(filteredRows, groupBySelect.value));
  clearFiltersBtn.disabled = true;
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
      const message = [errorData.error, errorData.details].filter(Boolean).join('\n');
      throw new Error(message || 'No se pudo obtener la información.');
    }

    const payload = await response.json();
    originalRows = Array.isArray(payload.rows) ? payload.rows : [];
    filteredRows = originalRows;
    currentLog = Array.isArray(payload.log) ? payload.log : [];
    baseResumen = payload.resumen ?? '';
    originalMetrics = payload.totals ?? calculateMetrics(originalRows);

    populateFilters(payload.filterOptions ?? {});
    renderLogs(currentLog);

    statusCard.classList.remove('hidden');
    applyFilters();
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

function applyFilters() {
  if (!originalRows.length) {
    renderSummaryFromRows([]);
    renderTable([]);
    renderGrouping([], groupBySelect.value);
    renderCharts([]);
    summaryCard.classList.remove('hidden');
    filtersCard.classList.add('hidden');
    tableCard.classList.add('hidden');
    groupingCard.classList.add('hidden');
    downloadBtn.disabled = true;
    updateClearButtonState();
    return;
  }

  const vendorFilter = activeFilters.vendedor;
  const clientFilter = activeFilters.cliente;
  const articleFilter = activeFilters.articulo;
  const searchFilter = activeFilters.search;

  const vendorLower = vendorFilter ? vendorFilter.toLowerCase() : null;
  const clientLower = clientFilter ? clientFilter.toLowerCase() : null;
  const articleLower = articleFilter ? articleFilter.toLowerCase() : null;

  filteredRows = originalRows.filter(row => {
    if (vendorFilter) {
      if (vendorFilter === '__empty__') {
        const vendorId = String(row?.vendedor_id ?? '').trim();
        const vendorDesc = String(row?.vendedor_descripcion ?? '').trim();
        if (vendorId || vendorDesc) return false;
      } else {
        const vendorId = String(row?.vendedor_id ?? '').trim();
        const vendorDesc = String(row?.vendedor_descripcion ?? '').toLowerCase();
        if (vendorId !== vendorFilter && !vendorDesc.includes(vendorLower)) return false;
      }
    }

    if (clientFilter) {
      if (clientFilter === '__empty__') {
        const clientId = String(row?.cliente_id ?? '').trim();
        const clientDesc = String(row?.cliente_descripcion ?? '').trim();
        if (clientId || clientDesc) return false;
      } else {
        const clientId = String(row?.cliente_id ?? '').trim();
        const clientDesc = String(row?.cliente_descripcion ?? '').toLowerCase();
        if (clientId !== clientFilter && !clientDesc.includes(clientLower)) return false;
      }
    }

    if (articleFilter) {
      if (articleFilter === '__empty__') {
        const articleId = String(row?.articulo_id ?? '').trim();
        const articleDesc = String(row?.articulo_descripcion ?? '').trim();
        if (articleId || articleDesc) return false;
      } else {
        const articleId = String(row?.articulo_id ?? '').toLowerCase();
        const articleDesc = String(row?.articulo_descripcion ?? '').toLowerCase();
        if (!articleId.includes(articleLower) && !articleDesc.includes(articleLower)) return false;
      }
    }

    if (searchFilter) {
      const matches = TABLE_HEADERS.some(header => {
        const value = row?.[header];
        return value !== undefined && value !== null && String(value).toLowerCase().includes(searchFilter);
      });
      if (!matches) return false;
    }

    return true;
  });

  summaryCard.classList.remove('hidden');
  filtersCard.classList.remove('hidden');
  tableCard.classList.remove('hidden');
  groupingCard.classList.remove('hidden');

  renderSummaryFromRows(filteredRows);
  renderTable(filteredRows);
  renderGrouping(filteredRows, groupBySelect.value);
  renderCharts(filteredRows);

  downloadBtn.disabled = !filteredRows.length;
  updateClearButtonState();
}

function renderSummaryFromRows(rows) {
  const metrics = calculateMetrics(rows);
  summaryGrid.innerHTML = '';

  const cards = [
    { label: 'Presupuestos únicos', value: metrics.presupuestos ?? 0 },
    { label: 'Ítems visibles', value: metrics.items ?? 0 },
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
  updateResumenText(rows.length);
}

function updateResumenText(filteredCount) {
  const totalItems = originalMetrics?.items ?? originalRows.length ?? 0;
  const messageParts = [];
  if (baseResumen) messageParts.push(baseResumen);

  if (!totalItems) {
    messageParts.push('No se recibieron filas para el rango consultado.');
  } else if (filteredCount === totalItems) {
    messageParts.push(`Mostrando todos los ${formatNumber(filteredCount)} ítems disponibles.`);
  } else {
    messageParts.push(`Mostrando ${formatNumber(filteredCount)} de ${formatNumber(totalItems)} ítems disponibles.`);
  }

  resumenText.textContent = messageParts.join(' · ');
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

  if (!rows.length) {
    return;
  }

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
}

function renderGrouping(rows, column) {
  groupTableWrapper.innerHTML = '';
  if (!column || !rows.length) {
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

function renderCharts(rows) {
  if (!rows.length) {
    chartsCard.classList.add('hidden');
    destroyCharts();
    return;
  }

  const vendedores = aggregateForChart(rows, 'vendedor_id', 'vendedor_descripcion', 'Sin vendedor');
  const clientes = aggregateForChart(rows, 'cliente_id', 'cliente_descripcion', 'Sin cliente');
  const articulos = aggregateForChart(rows, 'articulo_id', 'articulo_descripcion', 'Sin artículo');

  if (!vendedores.length && !clientes.length && !articulos.length) {
    chartsCard.classList.add('hidden');
    destroyCharts();
    return;
  }

  chartsCard.classList.remove('hidden');

  updateChart('vendedores', chartElements.vendedores, vendedores, 'Importe de ítems');
  updateChart('clientes', chartElements.clientes, clientes, 'Importe de ítems');
  updateChart('articulos', chartElements.articulos, articulos, 'Importe de ítems');
}

function updateChart(key, canvas, dataset, datasetLabel) {
  if (!canvas) return;
  if (chartInstances[key]) {
    chartInstances[key].destroy();
    chartInstances[key] = null;
  }

  if (!dataset.length) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  chartInstances[key] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: dataset.map(item => item.label),
      datasets: [{
        label: datasetLabel,
        data: dataset.map(item => Number(item.total.toFixed(2))),
        backgroundColor: 'rgba(14, 116, 144, 0.55)',
        borderColor: 'rgba(14, 116, 144, 0.85)',
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const value = context.raw ?? 0;
              return `${formatCurrency(value)}`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            autoSkip: false,
            maxRotation: 45,
            minRotation: 0
          }
        },
        y: {
          beginAtZero: true,
          ticks: {
            callback(value) {
              return formatCurrency(value);
            }
          }
        }
      }
    }
  });
}

function aggregateForChart(rows, idKey, labelKey, fallbackLabel) {
  const map = new Map();
  for (const row of rows) {
    const idRaw = String(row?.[idKey] ?? '').trim();
    const labelRaw = String(row?.[labelKey] ?? '').trim();
    const hasId = Boolean(idRaw);
    const hasLabel = Boolean(labelRaw);
    const key = hasId ? idRaw : (hasLabel ? labelRaw.toLowerCase() : '__empty__');
    const displayLabel = buildDisplayLabel(labelRaw, idRaw, fallbackLabel);

    if (!map.has(key)) {
      map.set(key, { label: displayLabel, total: 0 });
    }
    const entry = map.get(key);
    entry.total += toNumber(row?.importe_item);
  }

  return Array.from(map.values())
    .filter(entry => entry.total !== 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
}

function buildDisplayLabel(description, id, fallback) {
  const desc = description?.trim();
  const identifier = id?.trim();
  if (desc && identifier) return `${desc} (#${identifier})`;
  if (desc) return desc;
  if (identifier) return `#${identifier}`;
  return fallback;
}

function populateFilters(options) {
  populateSelect(vendedorSelect, options.vendedores ?? []);
  populateSelect(clienteSelect, options.clientes ?? []);
  populateDatalist(articulosDatalist, options.articulos ?? []);
  clearFiltersBtn.disabled = true;
}

function populateSelect(select, options) {
  const previous = select.value;
  select.innerHTML = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Todos';
  select.appendChild(defaultOption);

  for (const option of options) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    select.appendChild(opt);
  }

  if (options.some(option => option.value === previous)) {
    select.value = previous;
  } else {
    select.value = '';
  }
}

function populateDatalist(datalist, options) {
  datalist.innerHTML = '';
  const fragment = document.createDocumentFragment();
  options.slice(0, 100).forEach(option => {
    const opt = document.createElement('option');
    opt.value = option.label;
    fragment.appendChild(opt);
  });
  datalist.appendChild(fragment);
}

function downloadCsv() {
  if (!filteredRows.length) return;
  const headers = TABLE_HEADERS;
  const lines = [headers.join(',')];
  for (const row of filteredRows) {
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
  originalRows = [];
  filteredRows = [];
  currentLog = [];
  baseResumen = '';
  originalMetrics = null;
  activeFilters.search = '';
  activeFilters.vendedor = '';
  activeFilters.cliente = '';
  activeFilters.articulo = '';

  statusCard.classList.add('hidden');
  summaryCard.classList.add('hidden');
  filtersCard.classList.add('hidden');
  chartsCard.classList.add('hidden');
  tableCard.classList.add('hidden');
  groupingCard.classList.add('hidden');

  logList.innerHTML = '';
  summaryGrid.innerHTML = '';
  resumenText.textContent = '';
  dataTableHead.innerHTML = '';
  dataTableBody.innerHTML = '';
  groupTableWrapper.innerHTML = '';
  vendedorSelect.innerHTML = '<option value="">Todos</option>';
  clienteSelect.innerHTML = '<option value="">Todos</option>';
  articuloInput.value = '';
  articulosDatalist.innerHTML = '';
  searchInput.value = '';
  clearFiltersBtn.disabled = true;
  downloadBtn.disabled = true;
  destroyCharts();
  groupBySelect.value = '';
}

function destroyCharts() {
  for (const key of Object.keys(chartInstances)) {
    if (chartInstances[key]) {
      chartInstances[key].destroy();
      chartInstances[key] = null;
    }
  }
}

function toggleLoading(isLoading) {
  fetchBtn.disabled = isLoading;
  fetchBtn.textContent = isLoading ? 'Consultando…' : 'Consultar';
}

function updateClearButtonState() {
  const hasFilters = Boolean(
    activeFilters.search ||
    activeFilters.vendedor ||
    activeFilters.cliente ||
    activeFilters.articulo
  );
  clearFiltersBtn.disabled = !hasFilters;
}

function calculateMetrics(rows) {
  const seenPresupuestos = new Set();
  let totalImporteTotal = 0;
  let totalImporteItem = 0;
  let totalCantidad = 0;

  for (const row of rows) {
    const id = String(row?.id ?? '').trim();
    if (id && !seenPresupuestos.has(id)) {
      seenPresupuestos.add(id);
      totalImporteTotal += toNumber(row?.importe_total);
    }
    totalImporteItem += toNumber(row?.importe_item);
    totalCantidad += toNumber(row?.cantidad);
  }

  return {
    presupuestos: seenPresupuestos.size,
    items: rows.length,
    totalImporteTotal,
    totalImporteItem,
    totalCantidad
  };
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
