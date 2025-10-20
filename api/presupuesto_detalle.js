// Serverless Function para Vercel
// GET /api/presupuesto_detalle?from=YYYY-MM-DD&to=YYYY-MM-DD
// Opcionales: ?maxPages=10&pageSize=2000
export default async function handler(req, res) {
  try {
    const { from, to, maxPages, pageSize } = req.query;

    if (!from) {
      res.status(400).json({ ok: false, error: 'Falta parámetro "from" (YYYY-MM-DD).' });
      return;
    }
    const fechaDesde = from.trim();
    const fechaHasta = (to || from).trim();

    const MAX_PAGES = Number(maxPages || 10);
    const PAGE_SIZE = Number(pageSize || 2000);
    const BASE = 'http://janune.bgs.com.ar/s/ws';

    const allRows = [];
    const seen = new Set();            // dedupe por (id-item)
    const seenPageLastIds = new Set(); // detectar páginas repetidas
    let cursor = null;
    let totalRecibidas = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      // 1) lectura principal
      let params = {
        servicio: 'presupuesto_detalle',
        fecha_desde: fechaDesde,
        fecha_hasta: fechaHasta,
        cantidad: PAGE_SIZE
      };
      if (cursor !== null) params.desde = cursor;

      let url = `${BASE}?${toQuery(params)}`;
      const json = await fetchJson(url);
      const rowsRaw = Array.isArray(json.data) ? json.data : [];
      totalRecibidas += rowsRaw.length;

      // filtro defensivo por fecha
      const rows = rowsRaw.filter(r => {
        const f = String(r.fecha || '').trim();
        return f >= fechaDesde && f <= fechaHasta;
      });

      // dedupe + push
      for (const r of rows) {
        const key = `${String(r.id || '')}-${String(r.item || '')}`;
        if (!seen.has(key)) {
          seen.add(key);
          allRows.push(r);
        }
      }

      if (rowsRaw.length < PAGE_SIZE) break;

      // determinar lastId
      const lastObj = rowsRaw[rowsRaw.length - 1] || null;
      const lastId = lastObj ? String(lastObj.id || '') : '';
      if (!lastId) break;

      if (seenPageLastIds.has(lastId)) {
        // si repite, probamos estrategia alternativa luego
      } else {
        seenPageLastIds.add(lastId);
      }

      // test de avance
      let nextCursor = lastId;
      let testParams = { ...params, desde: nextCursor };
      let testUrl = `${BASE}?${toQuery(testParams)}`;
      const testJson = await fetchJson(testUrl);
      const testRowsRaw = Array.isArray(testJson.data) ? testJson.data : [];

      const noAvanza = !testRowsRaw.length ||
        (String((testRowsRaw[0] && testRowsRaw[0].id) || '') === lastId);

      if (noAvanza) {
        const bumped = bumpTrailingNumber(lastId);
        if (bumped !== lastId) {
          nextCursor = bumped;
        }
      }

      cursor = nextCursor;

      // pequeña pausa para no saturar (200ms)
      await new Promise(r => setTimeout(r, 200));
    }

    // Normalización mínima de campos (para front)
    const normalized = allRows.map(r => ({
      id: safe(r.id),
      fecha: safe(r.fecha),
      comprobante: safe(r.comprobante),
      estado: safe(r.estado),
      cliente_id: safe(r.cliente_id),
      cliente_descripcion: safe(r.cliente_descripcion),
      vendedor_id: safe(r.vendedor_id),
      vendedor_descripcion: safe(r.vendedor_descripcion),
      stock_origen_id: safe(r.stock_origen_id),
      stock_origen_descripcion: safe(r.stock_origen_descripcion),
      observaciones: safe(r.observaciones),
      importe_total: toNumber(r.importe_total),
      descuento_porcentaje: toNumber(r.descuento_porcentaje),
      item: safe(r.item),
      articulo_id: safe(r.articulo_id),
      articulo_descripcion: safe(r.articulo_descripcion),
      cantidad: toNumber(r.cantidad),
      precio: toNumber(r.precio),
      descuento_item: toNumber(r.descuento_item),
      importe_item: toNumber(r.importe_item),
      costo: toNumber(r.costo)
    }));

    // CORS (por si lo probás desde otro origen)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    res.status(200).json({
      ok: true,
      from: fechaDesde,
      to: fechaHasta,
      received: totalRecibidas,
      returned: normalized.length,
      data: normalized
    });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}

/* ===================== Helpers ===================== */
function toQuery(obj) {
  return Object.keys(obj)
    .filter(k => obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k])))
    .join('&');
}
async function fetchJson(url) {
  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) throw new Error(`HTTP ${r.status} al llamar al servicio`);
  const j = await r.json();
  if (!j || typeof j !== 'object') throw new Error('Respuesta inválida del servicio');
  return j;
}
function bumpTrailingNumber(id) {
  const m = String(id).match(/^(.*?)(\d+)$/);
  if (!m) return id;
  const head = m[1], num = m[2];
  const next = String(Number(num) + 1).padStart(num.length, '0');
  return head + next;
}
function safe(v) {
  return (v === null || v === undefined) ? '' : String(v);
}
function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
