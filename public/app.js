const state = {
  rawRows: [],
  filteredRows: [],
  filterOptions: {
    vendedores: [],
    clientes: [],
    articulos: []
  },
  config: {
    baseUrl: '-',
    maxPages: '-'
  },
  resumenTexto: '',
  charts: {}
};

const form = document.getElementById('filters-form');
const localFilters = document.getElementById('local-filters');
const resetButton = document.getElementById('reset-button');
const exportButton = document.getElementById('export-button');
const resumenContainer = document.getElementById('resumen');
const logsContainer = document.getElementById('logs');
const tableHead = document.querySelector('#tabla-detalle thead');
const tableBody = document.querySelector('#tabla-detalle tbody');
const apiBaseLabel = document.getElementById('api-base');
const maxPagesLabel = document.getElementById('max-pages');

init();

function init() {
  const today = new Date();
  const lastWeek = new Date();
  lastWeek.setDate(today.getDate() - 7);
  document.getElementById('fecha-desde').value = toInputDate(lastWeek);
  document.getElementById('fecha-hasta').value = toInputDate(today);

  form.addEventListener('submit', onSubmit);
  resetButton.addEventListener('click', resetLocalFilters);
  exportButton.addEventListener('click', exportCsv);

  localFilters.querySelectorAll('select, input').forEach(el => {
    el.addEventListener('input', applyLocalFilters);
    el.addEventListener('change', applyLocalFilters);
  });

  // Primera carga automática
  form.dispatchEvent(new Event('submit'));
}

async function onSubmit(event) {
  event.preventDefault();
  setLoading(true);
  try {
    const params = new URLSearchParams(new FormData(form));
    const response = await fetch(`/api/presupuesto-detalle?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Error ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    state.rawRows = data.rows || [];
    state.filterOptions = data.filterOptions || state.filterOptions;
    state.config = data.config || state.config;
    state.resumenTexto = data.resumen || '';

    updateFilterOptions();
    updateFooter();
    renderLogs(data.log || []);

    applyLocalFilters();
  } catch (err) {
    console.error(err);
    showError(err.message || 'Error inesperado.');
  } finally {
    setLoading(false);
  }
}

function setLoading(isLoading) {
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? 'Buscando...' : 'Consultar';
}

function applyLocalFilters() {
  const values = new FormData(localFilters);
  const filtros = {
    vendedor: values.get('filtro_vendedor') || '',
    cliente: values.get('filtro_cliente') || '',
    articulo: values.get('filtro_articulo') || '',
    texto: values.get('buscar') || ''
  };

  state.filteredRows = state.rawRows.filter(row => {
    if (filtros.vendedor && String(row.vendedor_id || '') !== filtros.vendedor) return false;
    if (filtros.cliente && String(row.cliente_id || '') !== filtros.cliente) return false;
    if (filtros.articulo && String(row.articulo_id || '') !== filtros.articulo) return false;
    if (filtros.texto) {
      const text = filtros.texto.toLowerCase();
      const combined = [
        row.comprobante,
        row.cliente_descripcion,
        row.articulo_descripcion,
        row.vendedor_descripcion,
        row.estado
      ]
        .map(v => (v || '').toString().toLowerCase())
        .join(' ');
      if (!combined.includes(text)) return false;
    }
    return true;
  });

  renderAll();
}

function renderAll() {
  renderResumen();
  renderTable();
  updateCharts();
}

function renderResumen() {
  const rows = state.filteredRows;
  if (!rows.length) {
    resumenContainer.innerHTML = '<p class="empty">No hay datos para mostrar. Ajustá los filtros.</p>';
    return;
  }

  const metrics = computeMetrics(rows);
  const items = [
    { label: 'Filas visibles', value: formatNumber(rows.length) },
    { label: 'Importe (items)', value: formatCurrency(metrics.totalImporteItems) },
    { label: 'Cantidad total', value: formatNumber(metrics.totalCantidad) },
    { label: 'Promedio importe', value: formatCurrency(metrics.promedioImporte) }
  ];

  resumenContainer.innerHTML = `
    <div class="resume-item">
      <span>Resumen ejecución</span>
      <strong>${escapeHtml(state.resumenTexto || 'Sin ejecución previa')}</strong>
    </div>
    ${items
      .map(
        item => `
        <div class="resume-item">
          <span>${item.label}</span>
          <strong>${item.value}</strong>
        </div>
      `
      )
      .join('')}
  `;
}

function renderTable() {
  const rows = state.filteredRows;
  if (!rows.length) {
    tableHead.innerHTML = '';
    tableBody.innerHTML = '';
    return;
  }

  const headers = [
    'id',
    'fecha',
    'comprobante',
    'estado',
    'cliente_id',
    'cliente_descripcion',
    'vendedor_id',
    'vendedor_descripcion',
    'articulo_id',
    'articulo_descripcion',
    'cantidad',
    'precio',
    'descuento_item',
    'importe_item',
    'importe_total'
  ];

  tableHead.innerHTML = `<tr>${headers.map(h => `<th>${escapeHtml(h.replace(/_/g, ' '))}</th>`).join('')}</tr>`;
  tableBody.innerHTML = rows
    .map(row => {
      return `<tr>${headers
        .map(key => `<td>${escapeHtml(formatCell(row[key]))}</td>`)
        .join('')}</tr>`;
    })
    .join('');
}

function updateCharts() {
  const rows = state.filteredRows;
  const ctxEstado = document.getElementById('chart-estado').getContext('2d');
  const ctxVendedor = document.getElementById('chart-vendedor').getContext('2d');
  const ctxArticulos = document.getElementById('chart-articulos').getContext('2d');

  const porEstado = aggregateBy(rows, 'estado');
  const porVendedor = aggregateBy(rows, 'vendedor_descripcion');
  const porArticulo = aggregateBy(rows, 'articulo_descripcion').slice(0, 10);

  state.charts.estado = updateChart(state.charts.estado, ctxEstado, porEstado, 'Importe por estado');
  state.charts.vendedor = updateChart(state.charts.vendedor, ctxVendedor, porVendedor, 'Importe por vendedor');
  state.charts.articulos = updateChart(state.charts.articulos, ctxArticulos, porArticulo, 'Top artículos');
}

function updateChart(chart, ctx, data, label) {
  if (typeof Chart === 'undefined') {
    return chart || null;
  }
  const labels = data.map(item => item.label);
  const values = data.map(item => item.total);
  if (!chart) {
    return new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label,
            data: values,
            backgroundColor: '#2c6bed'
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: { ticks: { color: '#5e6778' } },
          y: { ticks: { color: '#5e6778' } }
        }
      }
    });
  }

  chart.data.labels = labels;
  chart.data.datasets[0].data = values;
  chart.update();
  return chart;
}

function updateFilterOptions() {
  populateSelect('filtro-vendedor', state.filterOptions.vendedores);
  populateSelect('filtro-cliente', state.filterOptions.clientes);
  populateSelect('filtro-articulo', state.filterOptions.articulos);
}

function populateSelect(id, options) {
  const select = document.getElementById(id);
  const current = select.value;
  select.innerHTML = '<option value="">Todos</option>' + options.map(opt => `<option value="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</option>`).join('');
  if (options.some(opt => opt.id === current)) {
    select.value = current;
  }
}

function renderLogs(entries) {
  if (!entries.length) {
    logsContainer.textContent = 'Sin datos todavía.';
    return;
  }
  logsContainer.textContent = entries
    .map(entry => `[${entry.timestamp}] ${entry.level}: ${entry.message}`)
    .join('\n');
}

function updateFooter() {
  apiBaseLabel.textContent = state.config.baseUrl || '-';
  maxPagesLabel.textContent = state.config.maxPages || '-';
}

function resetLocalFilters() {
  localFilters.reset();
  applyLocalFilters();
}

function exportCsv() {
  if (!state.filteredRows.length) {
    alert('No hay datos para exportar.');
    return;
  }
  const headers = Object.keys(state.filteredRows[0]);
  const csv = [headers.join(',')]
    .concat(
      state.filteredRows.map(row =>
        headers
          .map(key => `"${String(row[key] ?? '').replace(/"/g, '""')}"`)
          .join(',')
      )
    )
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `presupuestos_${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function computeMetrics(rows) {
  const totalImporteItems = rows.reduce((acc, row) => acc + toNumber(row.importe_item), 0);
  const totalCantidad = rows.reduce((acc, row) => acc + toNumber(row.cantidad), 0);
  const promedioImporte = rows.length ? totalImporteItems / rows.length : 0;
  return { totalImporteItems, totalCantidad, promedioImporte };
}

function aggregateBy(rows, field) {
  const map = new Map();
  rows.forEach(row => {
    const key = (row[field] || 'Sin dato').toString();
    const total = map.get(key) || 0;
    map.set(key, total + toNumber(row.importe_item));
  });
  return Array.from(map.entries())
    .map(([label, total]) => ({ label, total }))
    .sort((a, b) => b.total - a.total);
}

function formatNumber(value) {
  return new Intl.NumberFormat('es-AR').format(value);
}

function formatCurrency(value) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value);
}

function toNumber(value) {
  const normalized = parseFloat(String(value || '0').replace(',', '.'));
  return Number.isFinite(normalized) ? normalized : 0;
}

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value.toString();
  return String(value);
}

function escapeHtml(value) {
  const str = String(value ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function toInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function showError(message) {
  state.rawRows = [];
  state.filteredRows = [];
  state.resumenTexto = '';
  resumenContainer.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
  tableHead.innerHTML = '';
  tableBody.innerHTML = '';
  logsContainer.textContent = '';
  updateCharts();
}
