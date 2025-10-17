const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');

const BASE_URL = process.env.PRESUPUESTOS_BASE_URL || 'http://janune.bgs.com.ar/s/ws';
const MAX_PAGES = Number(process.env.PRESUPUESTOS_MAX_PAGES || 10);
const PAGE_SIZE = Number(process.env.PRESUPUESTOS_PAGE_SIZE || 2000);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    if (parsedUrl.pathname === '/api/presupuesto-detalle') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Método no permitido' });
        return;
      }

      const fechaDesde = parseDateParam(parsedUrl.searchParams.get('fecha_desde'), 'fecha_desde');
      const fechaHasta = parseDateParam(parsedUrl.searchParams.get('fecha_hasta')) || todayYMD();
      const vendedorParam = sanitizeParam(parsedUrl.searchParams.get('vendedor'));
      const estadoParam = sanitizeParam(parsedUrl.searchParams.get('estado'));
      const clienteParam = sanitizeParam(parsedUrl.searchParams.get('cliente'));
      const articuloParam = sanitizeParam(parsedUrl.searchParams.get('articulo'));

      if (fechaDesde > fechaHasta) {
        throw httpError(400, 'fecha_desde no puede ser mayor a fecha_hasta.');
      }

      const fetchResult = await fetchPresupuestoDetalle(fechaDesde, fechaHasta, {
        vendedor: vendedorParam,
        estado: estadoParam
      });

      const filterOptions = buildFilterOptions(fetchResult.rows);
      const filteredRows = applyRowFilters(fetchResult.rows, {
        vendedor: vendedorParam,
        cliente: clienteParam,
        articulo: articuloParam
      });

      const metrics = buildMetrics(filteredRows);
      const totals = buildMetrics(fetchResult.rows);
      const resumen = `DETALLE sin IDs | ${fechaDesde} → ${fechaHasta} | páginas≤${MAX_PAGES} | recibidas=${fetchResult.totalRecibidas} | pegadas=${fetchResult.rows.length} | t=${fetchResult.elapsed}s`;

      sendJson(res, 200, {
        fechaDesde,
        fechaHasta,
        resumen,
        metrics,
        totals,
        rows: filteredRows,
        log: fetchResult.log,
        totalRecibidas: fetchResult.totalRecibidas,
        elapsed: fetchResult.elapsed,
        filters: {
          vendedor: vendedorParam,
          estado: estadoParam,
          cliente: clienteParam,
          articulo: articuloParam
        },
        filterOptions
      });
      return;
    }

    await serveStatic(parsedUrl.pathname, res);
  } catch (err) {
    console.error(err);
    const status = err.statusCode || 400;
    const body = { error: err.message || 'Error interno' };
    if (err.details) {
      body.details = String(err.details).slice(0, 800);
    }
    sendJson(res, status, body);
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});

async function serveStatic(requestPath, res) {
  let relativePath = requestPath;
  if (relativePath === '/' || !relativePath) {
    relativePath = '/index.html';
  }

  relativePath = path.normalize(relativePath).replace(/^\.\.(?:[\/\\]|$)/, '');
  const absolutePath = path.join(PUBLIC_DIR, relativePath);

  let stats;
  try {
    stats = await fsp.stat(absolutePath);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Recurso no encontrado');
    return;
  }

  if (stats.isDirectory()) {
    await serveStatic(path.join(relativePath, 'index.html'), res);
    return;
  }

  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(absolutePath).pipe(res);
}

async function fetchPresupuestoDetalle(fechaDesde, fechaHasta, extraParams) {
  const logEntries = [];
  const allRows = [];
  const seen = new Set();
  const seenPageLastIds = new Set();
  let cursor = null;
  let totalRecibidas = 0;
  const startedAt = Date.now();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = {
      servicio: 'presupuesto_detalle',
      fecha_desde: fechaDesde,
      fecha_hasta: fechaHasta,
      cantidad: PAGE_SIZE
    };
    if (extraParams && extraParams.vendedor) params.vendedor = extraParams.vendedor;
    if (extraParams && extraParams.estado) params.estado = extraParams.estado;
    if (cursor !== null) params.desde = cursor;

    const pageUrl = `${BASE_URL}?${toQuery(params)}`;
    pushLog(logEntries, 'URL', `P${page}/1 -> ${pageUrl}`);

    const json = await fetchJson(pageUrl);
    const rowsRaw = Array.isArray(json.data) ? json.data : [];
    totalRecibidas += rowsRaw.length;
    pushLog(logEntries, 'INFO', `P${page}/1 recibidas=${rowsRaw.length}`);

    const rows = rowsRaw.filter(row => {
      const fecha = String(row && row.fecha ? row.fecha : '').trim();
      return fecha && fecha >= fechaDesde && fecha <= fechaHasta;
    });

    let nuevas = 0;
    for (const row of rows) {
      const key = `${String(row && row.id ? row.id : '')}-${String(row && row.item ? row.item : '')}`;
      if (!seen.has(key)) {
        seen.add(key);
        allRows.push(row);
        nuevas++;
      }
    }
    pushLog(logEntries, 'INFO', `P${page}/1 válidas=${rows.length} nuevas=${nuevas} acumuladas=${allRows.length}`);

    if (rowsRaw.length < PAGE_SIZE) {
      pushLog(logEntries, 'PAGE', `P${page}/1 < ${PAGE_SIZE} -> fin paginación`);
      break;
    }

    const lastObj = rowsRaw[rowsRaw.length - 1] || null;
    const lastId = lastObj && lastObj.id ? String(lastObj.id) : '';
    if (!lastId) {
      pushLog(logEntries, 'PAGE', `P${page}/1 sin lastId -> fin paginación`);
      break;
    }

    if (seenPageLastIds.has(lastId)) {
      pushLog(logEntries, 'PAGE', `P${page}/1 lastId repetido=${lastId} -> intento alternativa`);
    } else {
      seenPageLastIds.add(lastId);
    }

    let nextCursor = lastId;
    const testParams = {
      servicio: 'presupuesto_detalle',
      fecha_desde: fechaDesde,
      fecha_hasta: fechaHasta,
      cantidad: PAGE_SIZE,
      desde: nextCursor
    };
    if (extraParams && extraParams.vendedor) testParams.vendedor = extraParams.vendedor;
    if (extraParams && extraParams.estado) testParams.estado = extraParams.estado;

    const testUrl = `${BASE_URL}?${toQuery(testParams)}`;
    pushLog(logEntries, 'URL', `P${page}/2-test -> ${testUrl}`);

    const testJson = await fetchJson(testUrl);
    const testRowsRaw = Array.isArray(testJson.data) ? testJson.data : [];
    pushLog(logEntries, 'INFO', `P${page}/2-test recibidas=${testRowsRaw.length}`);

    const noAvanza = testRowsRaw.length === 0 || String(testRowsRaw[0] && testRowsRaw[0].id ? testRowsRaw[0].id : '') === lastId;
    if (noAvanza) {
      const bumped = bumpTrailingNumber(lastId);
      if (bumped !== lastId) {
        nextCursor = bumped;
        pushLog(logEntries, 'PAGE', `P${page} cursor incrementado: ${lastId} -> ${nextCursor}`);
      } else {
        pushLog(logEntries, 'PAGE', `P${page} no se pudo incrementar ${lastId}, continúo con el mismo cursor (podría repetir).`);
      }
    }

    cursor = nextCursor;
    await sleep(120);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  return { rows: allRows, log: logEntries, totalRecibidas, elapsed };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(parsed, { method: 'GET' }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch (err) {
            reject(httpError(502, 'Respuesta inválida del servicio.'));
          }
        } else {
          const error = httpError(502, `HTTP ${res.statusCode} al llamar al servicio.`);
          error.details = body;
          reject(error);
        }
      });
    });

    req.on('error', err => {
      reject(httpError(502, `No se pudo contactar al servicio: ${err.message}`));
    });

    req.end();
  });
}

function toQuery(obj) {
  const params = new URLSearchParams();
  Object.keys(obj).forEach(key => {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  });
  return params.toString();
}

function pushLog(list, level, message) {
  list.push({
    timestamp: new Date().toISOString(),
    level,
    message
  });
}

function bumpTrailingNumber(id) {
  const match = String(id).match(/^(.*?)(\d+)$/);
  if (!match) return id;
  const head = match[1];
  const num = match[2];
  const next = String(Number(num) + 1).padStart(num.length, '0');
  return head + next;
}

function parseDateParam(value, fieldName) {
  if (!value) {
    if (fieldName) {
      throw httpError(400, `Falta el parámetro obligatorio ${fieldName}.`);
    }
    return null;
  }

  const trimmed = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw httpError(400, `${fieldName || 'fecha'} debe tener formato YYYY-MM-DD.`);
  }

  return trimmed;
}

function todayYMD() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildMetrics(rows) {
  const seenPresupuestos = new Set();
  let totalImporteTotal = 0;
  let totalImporteItem = 0;
  let totalCantidad = 0;

  for (const row of rows) {
    const id = String(row && row.id ? row.id : '').trim();
    if (id && !seenPresupuestos.has(id)) {
      seenPresupuestos.add(id);
      totalImporteTotal += toNumber(row && row.importe_total);
    }
    totalImporteItem += toNumber(row && row.importe_item);
    totalCantidad += toNumber(row && row.cantidad);
  }

  return {
    presupuestos: seenPresupuestos.size,
    items: rows.length,
    totalImporteTotal,
    totalImporteItem,
    totalCantidad
  };
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function sanitizeParam(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function applyRowFilters(rows, filters) {
  const vendedor = filters && filters.vendedor;
  const cliente = filters && filters.cliente;
  const articulo = filters && filters.articulo;

  if (!vendedor && !cliente && !articulo) {
    return rows;
  }

  const vendedorLower = vendedor ? vendedor.toLowerCase() : null;
  const clienteLower = cliente ? cliente.toLowerCase() : null;
  const articuloLower = articulo ? articulo.toLowerCase() : null;

  return rows.filter(row => {
    if (vendedor) {
      if (vendedor === '__empty__') {
        const vendorId = String(row && row.vendedor_id ? row.vendedor_id : '').trim();
        const vendorDesc = String(row && row.vendedor_descripcion ? row.vendedor_descripcion : '').trim();
        if (vendorId || vendorDesc) return false;
      } else {
        const vendorId = String(row && row.vendedor_id ? row.vendedor_id : '').trim();
        const vendorDesc = String(row && row.vendedor_descripcion ? row.vendedor_descripcion : '').toLowerCase();
        if (vendorId !== vendedor && vendorDesc.indexOf(vendedorLower) === -1) return false;
      }
    }

    if (cliente) {
      if (cliente === '__empty__') {
        const clienteId = String(row && row.cliente_id ? row.cliente_id : '').trim();
        const clienteDesc = String(row && row.cliente_descripcion ? row.cliente_descripcion : '').trim();
        if (clienteId || clienteDesc) return false;
      } else {
        const clienteId = String(row && row.cliente_id ? row.cliente_id : '').trim();
        const clienteDesc = String(row && row.cliente_descripcion ? row.cliente_descripcion : '').toLowerCase();
        if (clienteId !== cliente && clienteDesc.indexOf(clienteLower) === -1) return false;
      }
    }

    if (articulo) {
      if (articulo === '__empty__') {
        const articuloId = String(row && row.articulo_id ? row.articulo_id : '').trim();
        const articuloDesc = String(row && row.articulo_descripcion ? row.articulo_descripcion : '').trim();
        if (articuloId || articuloDesc) return false;
      } else {
        const articuloId = String(row && row.articulo_id ? row.articulo_id : '').toLowerCase();
        const articuloDesc = String(row && row.articulo_descripcion ? row.articulo_descripcion : '').toLowerCase();
        if (articuloId.indexOf(articuloLower) === -1 && articuloDesc.indexOf(articuloLower) === -1) return false;
      }
    }

    return true;
  });
}

function buildFilterOptions(rows) {
  const vendedores = new Map();
  const clientes = new Map();
  const articulos = new Map();
  let hasEmptyVendor = false;
  let hasEmptyCliente = false;
  let hasEmptyArticulo = false;

  for (const row of rows) {
    const vendedorId = String(row && row.vendedor_id ? row.vendedor_id : '').trim();
    const vendedorDesc = String(row && row.vendedor_descripcion ? row.vendedor_descripcion : '').trim();
    if (vendedorId) {
      const label = vendedorDesc ? `${vendedorDesc} (#${vendedorId})` : `Vendedor #${vendedorId}`;
      if (!vendedores.has(vendedorId)) vendedores.set(vendedorId, { value: vendedorId, label });
    } else if (vendedorDesc) {
      const key = `desc:${vendedorDesc.toLowerCase()}`;
      if (!vendedores.has(key)) vendedores.set(key, { value: vendedorDesc, label: vendedorDesc });
    } else {
      hasEmptyVendor = true;
    }

    const clienteId = String(row && row.cliente_id ? row.cliente_id : '').trim();
    const clienteDesc = String(row && row.cliente_descripcion ? row.cliente_descripcion : '').trim();
    if (clienteId) {
      const label = clienteDesc ? `${clienteDesc} (#${clienteId})` : `Cliente #${clienteId}`;
      if (!clientes.has(clienteId)) clientes.set(clienteId, { value: clienteId, label });
    } else if (clienteDesc) {
      const key = `desc:${clienteDesc.toLowerCase()}`;
      if (!clientes.has(key)) clientes.set(key, { value: clienteDesc, label: clienteDesc });
    } else {
      hasEmptyCliente = true;
    }

    const articuloId = String(row && row.articulo_id ? row.articulo_id : '').trim();
    const articuloDesc = String(row && row.articulo_descripcion ? row.articulo_descripcion : '').trim();
    if (articuloId) {
      const label = articuloDesc ? `${articuloDesc} (#${articuloId})` : `Artículo #${articuloId}`;
      if (!articulos.has(articuloId)) articulos.set(articuloId, { value: articuloId, label });
    }
    if (articuloDesc) {
      const key = `desc:${articuloDesc.toLowerCase()}`;
      if (!articulos.has(key)) articulos.set(key, { value: articuloDesc, label: articuloDesc });
    }
    if (!articuloId && !articuloDesc) {
      hasEmptyArticulo = true;
    }
  }

  if (hasEmptyVendor) vendedores.set('__empty__', { value: '__empty__', label: 'Sin vendedor' });
  if (hasEmptyCliente) clientes.set('__empty__', { value: '__empty__', label: 'Sin cliente' });
  if (hasEmptyArticulo) articulos.set('__empty__', { value: '__empty__', label: 'Sin artículo' });

  return {
    vendedores: sortOptions(vendedores),
    clientes: sortOptions(clientes),
    articulos: sortOptions(articulos)
  };
}

function sortOptions(map) {
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

module.exports = {
  server
};
