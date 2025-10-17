import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const BASE_URL = 'http://janune.bgs.com.ar/s/ws';
const MAX_PAGES = 10;
const PAGE_SIZE = 2000;

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

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/presupuesto-detalle') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Método no permitido' }));
        return;
      }

      const fechaDesde = parseDateParam(url.searchParams.get('fecha_desde'), 'fecha_desde');
      const fechaHasta = parseDateParam(url.searchParams.get('fecha_hasta')) ?? todayYMD();
      const vendedorParam = sanitizeParam(url.searchParams.get('vendedor'));
      const estadoParam = sanitizeParam(url.searchParams.get('estado'));
      const clienteParam = sanitizeParam(url.searchParams.get('cliente'));
      const articuloParam = sanitizeParam(url.searchParams.get('articulo'));

      if (fechaDesde > fechaHasta) {
        throw new Error('fecha_desde no puede ser mayor a fecha_hasta.');
      }

      const {
        rows,
        log,
        totalRecibidas,
        elapsed
      } = await fetchPresupuestoDetalle(fechaDesde, fechaHasta, {
        vendedor: vendedorParam,
        estado: estadoParam
      });

      const filterOptions = buildFilterOptions(rows);
      const filteredRows = applyRowFilters(rows, {
        vendedor: vendedorParam,
        cliente: clienteParam,
        articulo: articuloParam
      });

      const metrics = buildMetrics(filteredRows);
      const totals = buildMetrics(rows);
      const resumen = `DETALLE sin IDs | ${fechaDesde} → ${fechaHasta} | páginas≤${MAX_PAGES} | recibidas=${totalRecibidas} | pegadas=${rows.length} | t=${elapsed}s`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        fechaDesde,
        fechaHasta,
        resumen,
        metrics,
        totals,
        rows: filteredRows,
        log,
        totalRecibidas,
        elapsed,
        filters: {
          vendedor: vendedorParam,
          estado: estadoParam,
          cliente: clienteParam,
          articulo: articuloParam
        },
        filterOptions
      }));
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    const status = err.statusCode || 400;
    const body = { error: err.message || 'Error interno' };
    if (err.details) {
      body.details = String(err.details).slice(0, 800);
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}).listen(process.env.PORT || 3000, () => {
  console.log(`Servidor escuchando en http://localhost:${process.env.PORT || 3000}`);
});

async function serveStatic(requestPath, res) {
  let filePath = requestPath;
  if (filePath === '/' || !filePath) {
    filePath = '/index.html';
  }

  filePath = path.normalize(filePath).replace(/^\.\.(\/|\\|$)/, '');
  const absolute = path.join(PUBLIC_DIR, filePath);

  let stats;
  try {
    stats = await stat(absolute);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Recurso no encontrado');
    return;
  }

  if (stats.isDirectory()) {
    await serveStatic(path.join(filePath, 'index.html'), res);
    return;
  }

  const ext = path.extname(absolute).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  createReadStream(absolute).pipe(res);
}

async function fetchPresupuestoDetalle(fechaDesde, fechaHasta, extraParams = {}) {
  const logEntries = [];
  const allRows = [];
  const seen = new Set();
  const seenPageLastIds = new Set();
  let cursor = null;
  let totalRecibidas = 0;
  const t0 = Date.now();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = {
      servicio: 'presupuesto_detalle',
      fecha_desde: fechaDesde,
      fecha_hasta: fechaHasta,
      cantidad: PAGE_SIZE
    };
    if (extraParams?.vendedor) params.vendedor = extraParams.vendedor;
    if (extraParams?.estado) params.estado = extraParams.estado;
    if (cursor !== null) params.desde = cursor;

    const url = `${BASE_URL}?${toQuery(params)}`;
    pushLog(logEntries, 'URL', `P${page}/1 -> ${url}`);

    const json = await fetchJson(url);
    const rowsRaw = Array.isArray(json.data) ? json.data : [];
    totalRecibidas += rowsRaw.length;
    pushLog(logEntries, 'INFO', `P${page}/1 recibidas=${rowsRaw.length}`);

    const rows = rowsRaw.filter(r => {
      const f = String(r?.fecha ?? '').trim();
      return f && f >= fechaDesde && f <= fechaHasta;
    });

    let nuevas = 0;
    for (const r of rows) {
      const key = `${String(r?.id ?? '')}-${String(r?.item ?? '')}`;
      if (!seen.has(key)) {
        seen.add(key);
        allRows.push(r);
        nuevas++;
      }
    }
    pushLog(logEntries, 'INFO', `P${page}/1 válidas=${rows.length} nuevas=${nuevas} acumuladas=${allRows.length}`);

    if (rowsRaw.length < PAGE_SIZE) {
      pushLog(logEntries, 'PAGE', `P${page}/1 < ${PAGE_SIZE} -> fin paginación`);
      break;
    }

    const lastObj = rowsRaw.at(-1) ?? null;
    const lastId = lastObj ? String(lastObj.id ?? '') : '';
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
    if (extraParams?.vendedor) testParams.vendedor = extraParams.vendedor;
    if (extraParams?.estado) testParams.estado = extraParams.estado;
    const testUrl = `${BASE_URL}?${toQuery(testParams)}`;
    pushLog(logEntries, 'URL', `P${page}/2-test -> ${testUrl}`);
    const testJson = await fetchJson(testUrl);
    const testRowsRaw = Array.isArray(testJson.data) ? testJson.data : [];
    pushLog(logEntries, 'INFO', `P${page}/2-test recibidas=${testRowsRaw.length}`);

    const noAvanza = testRowsRaw.length === 0 || String(testRowsRaw[0]?.id ?? '') === lastId;
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

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  return { rows: allRows, log: logEntries, totalRecibidas, elapsed };
}

async function fetchJson(url) {
  const res = await fetch(url, { method: 'GET', redirect: 'follow' });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`HTTP ${res.status} al llamar al servicio.`);
    err.statusCode = 502;
    err.details = text;
    throw err;
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Respuesta inválida del servicio.');
  }
}

function toQuery(obj) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}

function pushLog(logEntries, level, message) {
  logEntries.push({
    timestamp: new Date().toISOString(),
    level,
    message
  });
}

function bumpTrailingNumber(id) {
  const match = String(id).match(/^(.*?)(\d+)$/);
  if (!match) return id;
  const [, head, num] = match;
  const next = String(Number(num) + 1).padStart(num.length, '0');
  return head + next;
}

function parseDateParam(value, fieldName) {
  if (!value) {
    if (fieldName) {
      throw new Error(`Falta el parámetro obligatorio ${fieldName}.`);
    }
    return null;
  }
  const trimmed = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`${fieldName ?? 'fecha'} debe tener formato YYYY-MM-DD.`);
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

function applyRowFilters(rows, filters = {}) {
  const vendedor = filters?.vendedor;
  const cliente = filters?.cliente;
  const articulo = filters?.articulo;

  if (!vendedor && !cliente && !articulo) {
    return rows;
  }

  const vendedorLower = vendedor ? vendedor.toLowerCase() : null;
  const clienteLower = cliente ? cliente.toLowerCase() : null;
  const articuloLower = articulo ? articulo.toLowerCase() : null;

  return rows.filter(row => {
    if (vendedor) {
      if (vendedor === '__empty__') {
        const vendorId = String(row?.vendedor_id ?? '').trim();
        const vendorDesc = String(row?.vendedor_descripcion ?? '').trim();
        if (vendorId || vendorDesc) return false;
      } else {
        const vendorId = String(row?.vendedor_id ?? '').trim();
        const vendorDesc = String(row?.vendedor_descripcion ?? '').toLowerCase();
        if (vendorId !== vendedor && !vendorDesc.includes(vendedorLower)) return false;
      }
    }

    if (cliente) {
      if (cliente === '__empty__') {
        const clienteId = String(row?.cliente_id ?? '').trim();
        const clienteDesc = String(row?.cliente_descripcion ?? '').trim();
        if (clienteId || clienteDesc) return false;
      } else {
        const clienteId = String(row?.cliente_id ?? '').trim();
        const clienteDesc = String(row?.cliente_descripcion ?? '').toLowerCase();
        if (clienteId !== cliente && !clienteDesc.includes(clienteLower)) return false;
      }
    }

    if (articulo) {
      if (articulo === '__empty__') {
        const articuloId = String(row?.articulo_id ?? '').trim();
        const articuloDesc = String(row?.articulo_descripcion ?? '').trim();
        if (articuloId || articuloDesc) return false;
      } else {
        const articuloId = String(row?.articulo_id ?? '').toLowerCase();
        const articuloDesc = String(row?.articulo_descripcion ?? '').toLowerCase();
        if (!articuloId.includes(articuloLower) && !articuloDesc.includes(articuloLower)) return false;
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
    const vendedorId = String(row?.vendedor_id ?? '').trim();
    const vendedorDesc = String(row?.vendedor_descripcion ?? '').trim();
    if (vendedorId) {
      const label = vendedorDesc ? `${vendedorDesc} (#${vendedorId})` : `Vendedor #${vendedorId}`;
      if (!vendedores.has(vendedorId)) vendedores.set(vendedorId, { value: vendedorId, label });
    } else if (vendedorDesc) {
      const key = `desc:${vendedorDesc.toLowerCase()}`;
      if (!vendedores.has(key)) vendedores.set(key, { value: vendedorDesc, label: vendedorDesc });
    } else {
      hasEmptyVendor = true;
    }

    const clienteId = String(row?.cliente_id ?? '').trim();
    const clienteDesc = String(row?.cliente_descripcion ?? '').trim();
    if (clienteId) {
      const label = clienteDesc ? `${clienteDesc} (#${clienteId})` : `Cliente #${clienteId}`;
      if (!clientes.has(clienteId)) clientes.set(clienteId, { value: clienteId, label });
    } else if (clienteDesc) {
      const key = `desc:${clienteDesc.toLowerCase()}`;
      if (!clientes.has(key)) clientes.set(key, { value: clienteDesc, label: clienteDesc });
    } else {
      hasEmptyCliente = true;
    }

    const articuloId = String(row?.articulo_id ?? '').trim();
    const articuloDesc = String(row?.articulo_descripcion ?? '').trim();
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
