const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const STATIC_ROOT = path.join(__dirname, 'public');
const DEFAULT_REMOTE = 'http://janune.bgs.com.ar/s/ws';
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 2000);
const MAX_PAGES = Number(process.env.MAX_PAGES || 10);
const REMOTE_URL = process.env.REMOTE_URL || DEFAULT_REMOTE;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/presupuesto-detalle') {
      await handleApi(url, res);
      return;
    }

    await handleStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    const statusCode = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
    const body = JSON.stringify({ error: err.message || 'Error inesperado' });
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Servidor disponible en http://localhost:${process.env.PORT || 3000}`);
});

async function handleApi(url, res) {
  if (url.searchParams.get('fecha_desde') === null) {
    throw httpError(400, 'El parámetro fecha_desde es obligatorio.');
  }

  const fechaDesde = parseDate(url.searchParams.get('fecha_desde'), 'fecha_desde');
  const fechaHasta = parseDate(url.searchParams.get('fecha_hasta'), 'fecha_hasta', today());
  if (fechaDesde > fechaHasta) {
    throw httpError(400, 'fecha_desde no puede ser mayor a fecha_hasta.');
  }

  const extraParams = {
    vendedor: cleanParam(url.searchParams.get('vendedor')),
    estado: cleanParam(url.searchParams.get('estado'))
  };

  const filters = {
    vendedor: cleanParam(url.searchParams.get('filtro_vendedor')),
    cliente: cleanParam(url.searchParams.get('filtro_cliente')),
    articulo: cleanParam(url.searchParams.get('filtro_articulo')),
    texto: cleanParam(url.searchParams.get('buscar'))
  };

  const fetchResult = await downloadPresupuestos(fechaDesde, fechaHasta, extraParams);
  const filteredRows = applyFilters(fetchResult.rows, filters);
  const metrics = buildMetrics(filteredRows);
  const overall = buildMetrics(fetchResult.rows);
  const filterOptions = buildFilterOptions(fetchResult.rows);

  const response = {
    fechaDesde,
    fechaHasta,
    resumen: `DETALLE sin IDs | ${fechaDesde} → ${fechaHasta} | páginas≤${MAX_PAGES} | recibidas=${fetchResult.totalRecibidas} | pegadas=${fetchResult.rows.length} | t=${fetchResult.elapsed}s`,
    rows: filteredRows,
    log: fetchResult.log,
    metrics,
    totals: overall,
    filterOptions,
    filters,
    config: {
      baseUrl: REMOTE_URL,
      maxPages: MAX_PAGES
    }
  };

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(response));
}

async function downloadPresupuestos(fechaDesde, fechaHasta, extraParams) {
  const allRows = [];
  const seenRows = new Set();
  const seenPageBreaks = new Set();
  const log = [];
  let cursor = null;
  let totalRecibidas = 0;
  const started = Date.now();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = {
      servicio: 'presupuesto_detalle',
      fecha_desde: fechaDesde,
      fecha_hasta: fechaHasta,
      cantidad: PAGE_SIZE
    };
    if (cursor !== null) params.desde = cursor;
    if (extraParams.vendedor) params.vendedor = extraParams.vendedor;
    if (extraParams.estado) params.estado = extraParams.estado;

    const pageUrl = `${REMOTE_URL}?${toQuery(params)}`;
    pushLog(log, 'URL', `P${page}/1 -> ${pageUrl}`);

    const payload = await fetchJson(pageUrl);
    const rowsRaw = Array.isArray(payload.data) ? payload.data : [];
    totalRecibidas += rowsRaw.length;
    pushLog(log, 'INFO', `P${page}/1 recibidas=${rowsRaw.length}`);

    const rows = rowsRaw.filter(row => {
      const fecha = (row && row.fecha ? String(row.fecha).trim() : '');
      return fecha && fecha >= fechaDesde && fecha <= fechaHasta;
    });

    let nuevas = 0;
    for (const row of rows) {
      const key = `${row.id || ''}-${row.item || ''}`;
      if (!seenRows.has(key)) {
        seenRows.add(key);
        allRows.push(row);
        nuevas++;
      }
    }
    pushLog(log, 'INFO', `P${page}/1 válidas=${rows.length} nuevas=${nuevas} acumuladas=${allRows.length}`);

    if (rowsRaw.length < PAGE_SIZE) {
      pushLog(log, 'PAGE', `P${page}/1 < ${PAGE_SIZE} -> fin paginación`);
      break;
    }

    const last = rowsRaw[rowsRaw.length - 1];
    const lastId = last && last.id ? String(last.id) : '';
    if (!lastId) {
      pushLog(log, 'PAGE', `P${page}/1 sin lastId -> fin paginación`);
      break;
    }

    if (seenPageBreaks.has(lastId)) {
      pushLog(log, 'PAGE', `P${page}/1 lastId repetido=${lastId} -> intento alternativa`);
    } else {
      seenPageBreaks.add(lastId);
    }

    let nextCursor = lastId;

    const testParams = { ...params, desde: nextCursor };
    const testUrl = `${REMOTE_URL}?${toQuery(testParams)}`;
    pushLog(log, 'URL', `P${page}/2-test -> ${testUrl}`);
    const testPayload = await fetchJson(testUrl);
    const testRows = Array.isArray(testPayload.data) ? testPayload.data : [];
    pushLog(log, 'INFO', `P${page}/2-test recibidas=${testRows.length}`);

    const noAdvance = !testRows.length || String((testRows[0] && testRows[0].id) || '') === lastId;
    if (noAdvance) {
      const bumped = bumpTrailingNumber(lastId);
      if (bumped !== lastId) {
        pushLog(log, 'PAGE', `P${page} cursor incrementado: ${lastId} -> ${bumped}`);
        nextCursor = bumped;
      } else {
        pushLog(log, 'PAGE', `P${page} no se pudo incrementar ${lastId}, continúo con el mismo cursor.`);
      }
    }

    cursor = nextCursor;
    await sleep(120);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  return { rows: allRows, totalRecibidas, elapsed, log };
}

function applyFilters(rows, filters) {
  if (!filters.vendedor && !filters.cliente && !filters.articulo && !filters.texto) {
    return rows;
  }
  const text = filters.texto ? filters.texto.toLowerCase() : null;
  return rows.filter(row => {
    if (filters.vendedor && String(row.vendedor_id || '') !== filters.vendedor) return false;
    if (filters.cliente && String(row.cliente_id || '') !== filters.cliente) return false;
    if (filters.articulo && String(row.articulo_id || '') !== filters.articulo) return false;
    if (text) {
      const joined = [row.comprobante, row.cliente_descripcion, row.articulo_descripcion, row.vendedor_descripcion]
        .map(v => (v || '').toString().toLowerCase())
        .join(' ');
      if (!joined.includes(text)) return false;
    }
    return true;
  });
}

function buildMetrics(rows) {
  const totalImporte = sumColumn(rows, 'importe_total');
  const totalItems = sumColumn(rows, 'importe_item');
  const totalCantidad = sumColumn(rows, 'cantidad');
  const porEstado = groupBy(rows, 'estado', 'importe_item');
  const porVendedor = groupBy(rows, 'vendedor_descripcion', 'importe_item');
  const topArticulos = topN(groupBy(rows, 'articulo_descripcion', 'importe_item'), 10);

  return {
    totalImporte,
    totalItems,
    totalCantidad,
    porEstado,
    porVendedor,
    topArticulos,
    cantidadRegistros: rows.length
  };
}

function buildFilterOptions(rows) {
  return {
    vendedores: uniquePairs(rows, 'vendedor_id', 'vendedor_descripcion'),
    clientes: uniquePairs(rows, 'cliente_id', 'cliente_descripcion'),
    articulos: uniquePairs(rows, 'articulo_id', 'articulo_descripcion')
  };
}

async function handleStatic(requestPath, res) {
  let target = requestPath === '/' ? '/index.html' : requestPath;
  target = path.normalize(target).replace(/^\.\.(?:[\\/]|$)/, '');
  const absolute = path.join(STATIC_ROOT, target);

  try {
    const stats = await fs.promises.stat(absolute);
    if (stats.isDirectory()) {
      return handleStatic(path.join(target, 'index.html'), res);
    }

    const ext = path.extname(absolute).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(absolute).pipe(res);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Recurso no encontrado');
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(httpError(res.statusCode, `HTTP ${res.statusCode} al llamar al servicio remoto.`));
          return;
        }
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          resolve(json);
        } catch (err) {
          reject(httpError(500, 'Respuesta inválida del servicio remoto.', err.message));
        }
      });
    });
    req.on('error', err => reject(httpError(500, 'No se pudo contactar al servicio remoto.', err.message)));
  });
}

function toQuery(params) {
  return Object.keys(params)
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join('&');
}

function parseDate(raw, name, fallback) {
  if (!raw && fallback) return fallback;
  if (!raw) throw httpError(400, `El parámetro ${name} es obligatorio.`);
  const trimmed = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const m = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const d = Number(m[1]);
    const month = Number(m[2]) - 1;
    const year = Number(m[3]);
    const date = new Date(year, month, d);
    return formatDate(date);
  }
  throw httpError(400, `Formato de fecha inválido para ${name}. Usa YYYY-MM-DD.`);
}

function today() {
  return formatDate(new Date());
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function cleanParam(value) {
  if (value === null || value === undefined) return '';
  const trimmed = String(value).trim();
  return trimmed === '' ? '' : trimmed;
}

function pushLog(list, level, message) {
  const timestamp = new Date().toISOString();
  list.push({ timestamp, level, message });
}

function bumpTrailingNumber(id) {
  const match = String(id).match(/^(.*?)(\d+)$/);
  if (!match) return id;
  const [, head, num] = match;
  const next = String(Number(num) + 1).padStart(num.length, '0');
  return `${head}${next}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sumColumn(rows, field) {
  return rows.reduce((acc, row) => {
    const value = parseFloat(String(row[field] || '0').replace(',', '.'));
    return acc + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function groupBy(rows, field, valueField) {
  const map = new Map();
  for (const row of rows) {
    const key = (row[field] || 'Sin dato').toString();
    const value = parseFloat(String(row[valueField] || '0').replace(',', '.'));
    const current = map.get(key) || 0;
    map.set(key, current + (Number.isFinite(value) ? value : 0));
  }
  return Array.from(map.entries()).map(([label, total]) => ({ label, total }));
}

function topN(list, n) {
  return [...list].sort((a, b) => b.total - a.total).slice(0, n);
}

function uniquePairs(rows, idField, labelField) {
  const map = new Map();
  for (const row of rows) {
    const id = row[idField];
    if (!id) continue;
    if (!map.has(id)) {
      map.set(id, { id: String(id), label: (row[labelField] || '').toString() || String(id) });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, 'es'));
}

function httpError(statusCode, message, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (details) err.details = details;
  return err;
}
