/* ======== Helpers DOM ======== */
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const statusEl = $('#status');

/* ======== Estado global de filtros (solo en memoria) ======== */
const state = {
  from: '', to: '',
  vendedores: new Set(),
  clientes: new Set(),
  sucursales: new Set(),
  presuId: '',
  topN: 10
};

/* ======== Elementos ======== */
const fDesde = $('#f-desde'), fHasta = $('#f-hasta');
const fVend  = $('#f-vendedor'), fCli = $('#f-cliente'), fSuc = $('#f-sucursal');
const fId    = $('#f-id'), btnApply = $('#btn-apply'), btnClear = $('#btn-clear'), btnCsv = $('#btn-csv');
const activeFilters = $('#active-filters');
const topN = $('#topN');

const qId = $('#q-id');

const tblVend = $('#tbl-vend tbody'), tblCli = $('#tbl-cli tbody'), tblSuc = $('#tbl-suc tbody');
const tblHeads = $('#tbl-heads tbody'), pgHeads = $('#pg-heads');

const drawer = $('#drawer'), dwClose = $('#dw-close');
const dwTitle = $('#dw-title'), dwMeta = $('#dw-meta'), dwBody = $('#dw-table tbody'), dwResBody = $('#dw-res-table tbody');
const overlay = $('#overlay');

const topArt = $('#top-art');
const tblArt = $('#tbl-art tbody');

/* ======== Datos en memoria ======== */
let rows = [];         // ítems normalizados (_ingreso/_costo/_margen/_pct)
let headsAll = [];     // cabeceras agregadas por id (dataset completo)

/* ======== Charts ======== */
let chVend=null, chCli=null, chSuc=null;

/* ======== Init ======== */
init();
async function init(){
  // Fechas por defecto: hoy, sin persistir en localStorage
  const t = new Date(), y=t.getFullYear(), m=String(t.getMonth()+1).padStart(2,'0'), d=String(t.getDate()).padStart(2,'0');
  // Si llegan por querystring, las usamos; si no, hoy
  const url = new URL(location.href);
  fDesde.value = url.searchParams.get('from') || `${y}-${m}-${d}`;
  fHasta.value = url.searchParams.get('to')   || `${y}-${m}-${d}`;

  bindUI();
  await fetchAndRender(); // primera carga
}

function bindUI(){
  btnApply.addEventListener('click', fetchAndRender);
  btnClear.addEventListener('click', () => { clearFilters(); render(); });
  btnCsv.addEventListener('click', exportCSV);

  topN.addEventListener('change', ()=>{
    state.topN = Number(topN.value)||10;
    // Al cambiar TopN, solo re-dibujar derivados de "filtered"
    const filtered = applyFilters(rows);
    drawChartsFrom(filtered);
    renderAggTables(filtered);
  });

  topArt?.addEventListener('change', ()=> renderTopArt(applyFilters(rows)));

  // Tabs (generales y del drawer)
  $$('.tab').forEach(b=>{
    b.addEventListener('click', ()=>{
      const group = b.closest('.tabs');
      group.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      const pane = b.dataset.tab;
      group.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
      const t = document.querySelector(`#pane-${pane}`) || document.querySelector(`#pane-${b.dataset.tab}`);
      if (t) t.classList.add('active');
    });
  });

  // Drawer (botón, Esc y overlay)
  dwClose.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e=>{ if (e.key==='Escape') closeDrawer(); });
  overlay.addEventListener('click', closeDrawer);

  // Buscar ID en tabla presupuestos (debounce)
  let tId = 0;
  qId.addEventListener('input', () => {
    clearTimeout(tId); tId = setTimeout(()=> {
      // usar el dataset filtrado actual
      const filtered = applyFilters(rows);
      renderHeads(qId.value.trim(), filtered);
    }, 250);
  });
}

/* ======== Fetch + render ======== */
async function fetchAndRender(){
  // validar fechas
  const from = fDesde.value, to = fHasta.value || from;
  if (!from) return alert('Elegí "Desde"'); 
  if (to<from) return alert('"Hasta" < "Desde"');
  state.from = from; state.to = to;

  disableUI(true); setStatus('Consultando servicio…');
  try {
    const resp = await fetch(`/api/presupuesto_detalle?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(json.error || 'Error de API');

    rows = (json.data||[]).map(normaRow);
    headsAll = buildHeads(rows);

    // poblar selects (listas del conjunto)
    hydrateSelect(fVend, unique(rows.map(r=>r.vendedor)));
    hydrateSelect(fCli,  unique(rows.map(r=>r.cliente)));
    hydrateSelect(fSuc,  unique(rows.map(r=>r.sucursal)));

    render();
    btnCsv.disabled = rows.length===0;
    setStatus(`OK. Ítems=${rows.length.toLocaleString('es-AR')}. Rango ${json.from} → ${json.to}`);
  } catch(e){
    console.error(e); setStatus('Error: '+e.message); alert(e.message);
  } finally {
    disableUI(false);
  }
}

/* ======== Render global según filtros ======== */
function render() {
  // 1) Capturar filtros de la UI y pintar chips
  captureFiltersFromUI();
  paintActiveFilters();

  // 2) Aplicar filtros al dataset
  const filtered = applyFilters(rows);

  // 3) KPIs (formato compacto para que no rompa el layout)
  const k = kpis(filtered);
  $('#k-ingresos').textContent   = moneyCompact(k.ingresos);
  $('#k-costos').textContent     = moneyCompact(k.costos);
  $('#k-margen').textContent     = moneyCompact(k.margen);
  $('#k-margen-pct').textContent = pct(k.margenPct);
  $('#k-presu').textContent      = int(countHeads(filtered));
  $('#k-ticket').textContent     = moneyCompact(ticketProm(filtered));

  // 4) Gráficos + tablas agregadas (Top-N) con cross-filter
  drawChartsFrom(filtered);
  renderAggTables(filtered);

  // 5) Presupuestos (master) con paginación y buscador de ID
  renderHeads(qId.value.trim(), filtered);

  // 6) Artículos destacados (Top-N por ingreso)
  renderTopArt(filtered);

  // 7) Habilitar/Deshabilitar export según haya datos
  btnCsv.disabled = filtered.length === 0;

  // 8) Estado en el footer
  setStatus(`Vista: ${filtered.length.toLocaleString('es-AR')} ítems · ${countHeads(filtered)} presupuestos`);
}


/* ======== Top Artículos ======== */
function renderTopArt(data){
  const n = Number(topArt?.value) || 10;
  const agg = new Map();
  for (const r of data){
    const k = r.articulo;
    const a = agg.get(k) || { key:k, items:0, cant:0, ingreso:0, costo:0, margen:0 };
    a.items += 1;
    a.cant  += r._cant;
    a.ingreso += r._ingreso;
    a.costo   += r._costo;
    a.margen  += r._margen;
    agg.set(k, a);
  }
  const arr = Array.from(agg.values())
    .map(v => ({ ...v, pct: v.ingreso>0 ? v.margen/v.ingreso : 0, precioProm: v.cant>0 ? v.ingreso/v.cant : 0 }))
    .sort((a,b)=> b.ingreso - a.ingreso)
    .slice(0, n);

  tblArt.innerHTML = '';
  for (const v of arr){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(v.key)}</td>
      <td class="num">${int(v.items)}</td>
      <td class="num">${int(v.cant)}</td>
      <td class="num">${money(v.ingreso)}</td>
      <td class="num">${money(v.precioProm)}</td>
      <td class="num">${money(v.margen)}</td>
      <td class="${mclass(v.pct)}">${pct(v.pct)}</td>
    `;
    tblArt.appendChild(tr);
  }
}

/* ======== Filtros ======== */
function captureFiltersFromUI(){
  state.vendedores = new Set(Array.from(fVend.selectedOptions).map(o=>o.value));
  state.clientes   = new Set(Array.from(fCli.selectedOptions).map(o=>o.value));
  state.sucursales = new Set(Array.from(fSuc.selectedOptions).map(o=>o.value));
  state.presuId    = fId.value.trim();
  state.topN       = Number(topN.value)||10;
}
function applyFilters(data){
  const vend = state.vendedores, cli = state.clientes, suc = state.sucursales;
  const id = state.presuId;
  return data.filter(r=>{
    if (id && String(r.id)!==id) return false; // match exacto by design
    if (vend.size && !vend.has(r.vendedor)) return false;
    if (cli.size && !cli.has(r.cliente)) return false;
    if (suc.size && !suc.has(r.sucursal)) return false;
    return true;
  });
}

/* ======== Charts y tablas agregadas ======== */
function drawChartsFrom(filtered){
  const aggVend = aggregate(filtered, r=>r.vendedor);
  const aggCli  = aggregate(filtered, r=>r.cliente);
  const aggSuc  = aggregate(filtered, r=>r.sucursal);

  drawCharts(aggVend, aggCli, aggSuc);
}
function renderAggTables(filtered){
  paintAggTable(tblVend, aggregate(filtered, r=>r.vendedor), 'vendedor');
  paintAggTable(tblCli,  aggregate(filtered, r=>r.cliente),  'cliente');
  paintAggTable(tblSuc,  aggregate(filtered, r=>r.sucursal), 'sucursal');
}

/* === FIX layout de barras horizontales ===
   - Labels compactos para ticks grandes
   - maintainAspectRatio:false para respetar el contenedor
   - Altura dinámica según cantidad de barras
   - Limitar cantidad de ticks en eje X
   - Canvas 100% del contenedor (no empuja el grid)
*/
function drawCharts(aggVend, aggCli, aggSuc){
  const n = state.topN;
  const vendArr = topBy(aggVend,'ingreso',n), cliArr = topBy(aggCli,'ingreso',n), sucArr = topBy(aggSuc,'ingreso',n);

  // Altura sugerida: ~28px por barra (mínimo 160)
  const heightFor = (len)=> Math.max(160, 28*len + 24);

  chVend && chVend.destroy();
  const cv = $('#chartVend');
  cv.height = heightFor(vendArr.length);
  chVend = miniBar(cv, vendArr.map(x=>x.key), vendArr.map(x=>round2(x.ingreso)), (label)=>toggleFilter('vendedores',label));

  chCli && chCli.destroy();
  const cc = $('#chartCli');
  cc.height = heightFor(cliArr.length);
  chCli = miniBar(cc, cliArr.map(x=>x.key), cliArr.map(x=>round2(x.ingreso)), (label)=>toggleFilter('clientes',label));

  chSuc && chSuc.destroy();
  const cs = $('#chartSuc');
  cs.height = heightFor(sucArr.length);
  chSuc = miniBar(cs, sucArr.map(x=>x.key), sucArr.map(x=>round2(x.ingreso)), (label)=>toggleFilter('sucursales',label));
}

function miniBar(canvas, labels, data, onClick){
  // Contenedor del canvas mantiene el ancho del grid; el chart nunca lo expande
  canvas.style.width = '100%';

  return new Chart(canvas, {
    type:'bar',
    data:{labels, datasets:[{label:'Ingreso', data, borderWidth:0}]},
    options:{
      responsive:true,
      maintainAspectRatio:false,        // clave para no “ensanchar” el grid
      animation:false,
      layout:{ padding:{right:8, left:8} },
      plugins:{
        legend:{display:false},
        tooltip:{
          callbacks:{ label:(c)=>money(c.parsed.x ?? c.parsed.y ?? c.parsed) }
        }
      },
      indexAxis:'y',
      onClick:(_, els)=>{ if(els?.length){ const i=els[0].index; onClick(labels[i]); } },
      scales:{
        x:{
          ticks:{
            // Labels compactas: evitan números larguísimos que empujan layout
            callback:v => moneyCompact(v),
            maxTicksLimit: 6
          },
          grid:{ display:false }
        },
        y:{
          ticks:{ autoSkip:true, maxTicksLimit: 12 },
          grid:{ display:false }
        }
      }
    }
  });
}

function paintAggTable(tbody, aggObj, kind){
  const arr = topBy(aggObj,'ingreso',Infinity);
  tbody.innerHTML='';
  for (const v of arr){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(v.key)}</td>
      <td class="num">${int(v.presu)}</td>
      <td class="num">${int(v.items)}</td>
      <td class="num">${money(v.ingreso)}</td>
      <td class="num">${money(v.margen)}</td>
      <td class="${mclass(v.pct)}">${pct(v.pct)}</td>`;
    tr.addEventListener('click', ()=>toggleFilter(kind==='vendedor'?'vendedores':kind==='cliente'?'clientes':'sucursales', v.key));
    tbody.appendChild(tr);
  }
}

/* ======== Heads & Drawer ======== */
function renderHeads(searchExact='', filteredRows=null){
  const FR = filteredRows || applyFilters(rows);
  const set = buildHeads(FR);   // se recalcula SOLO para el subconjunto filtrado

  // orden por Ingreso desc, tie-break fecha desc
  set.sort((a,b)=> b.ingreso - a.ingreso || (a.fecha<b.fecha?1:-1));

  const rowsPerPage = 10;
  const pages = Math.max(1, Math.ceil(set.length/rowsPerPage));
  let page = Number(pgHeads.dataset.page||1); if (page>pages) page=pages;
  const slice = set.slice((page-1)*rowsPerPage, (page-1)*rowsPerPage+rowsPerPage);

  tblHeads.innerHTML='';
  for (const h of slice){
    if (searchExact && String(h.id)!==searchExact) continue;
    const tr = document.createElement('tr');
    tr.className='clickable';
    tr.innerHTML = `
      <td>${fmtDate(h.fecha)}</td>
      <td>${esc(h.id)}</td>
      <td>${esc(h.comprobante)}</td>
      <td>${esc(h.cliente)}</td>
      <td>${esc(h.vendedor)}</td>
      <td>${esc(h.sucursal)}</td>
      <td class="num">${int(h.items)}</td>
      <td class="num">${money(h.ingreso)}</td>
      <td class="num">${money(h.costo)}</td>
      <td class="num">${money(h.margen)}</td>
      <td class="${mclass(h.pct)}">${pct(h.pct)}</td>`;
    tr.addEventListener('click', ()=>openDrawer(h));
    tblHeads.appendChild(tr);
  }

  // paginación
  pgHeads.innerHTML='';
  for (let i=1;i<=pages;i++){
    const b=document.createElement('button'); b.textContent=i; if (i===page) b.classList.add('active');
    b.addEventListener('click', ()=>{ pgHeads.dataset.page=i; renderHeads(searchExact, FR); });
    pgHeads.appendChild(b);
  }
}

function openDrawer(h){
  dwTitle.textContent = `Presupuesto ${h.id} · ${fmtDate(h.fecha)}`;
  dwMeta.innerHTML = `
    <div><b>Cliente:</b> ${esc(h.cliente)}</div>
    <div><b>Vendedor:</b> ${esc(h.vendedor)}</div>
    <div><b>Sucursal:</b> ${esc(h.sucursal)}</div>
    <div><b>Ingreso:</b> ${money(h.ingreso)} · <b>Costo:</b> ${money(h.costo)} · <b>Margen:</b> ${money(h.margen)} <span class="${mclass(h.pct)}">(${pct(h.pct)})</span></div>`;
  // Ítems
  dwBody.innerHTML='';
  for (const r of h.rows){
    const tr=document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(r.articulo)}</td>
      <td class="num">${int(r._cant)}</td>
      <td class="num">${money(r.precio)}</td>
      <td class="num">${money(r._ingreso)}</td>
      <td class="num">${money(r._costo)}</td>
      <td class="num">${money(r._margen)}</td>
      <td class="${mclass(r._pct)}">${pct(r._pct)}</td>`;
    dwBody.appendChild(tr);
  }
  // Resumen sucursal / artículo
  const bySuc = aggregate(h.rows, r=>r.sucursal), byArt = aggregate(h.rows, r=>r.articulo);
  dwResBody.innerHTML='';
  for (const g of [['Sucursal',bySuc],['Artículo',byArt]]){
    for (const v of topBy(g[1],'ingreso',Infinity)){
      const tr=document.createElement('tr');
      tr.innerHTML = `
        <td>${g[0]}</td><td>${esc(v.key)}</td>
        <td class="num">${int(v.items)}</td><td class="num">${money(v.ingreso)}</td><td class="num">${money(v.costo)}</td>
        <td class="num">${money(v.margen)}</td><td class="${mclass(v.pct)}">${pct(v.pct)}</td>`;
      dwResBody.appendChild(tr);
    }
  }
  drawer.classList.add('open');
  overlay.classList.add('open');
}

function closeDrawer(){
  drawer.classList.remove('open');
  overlay.classList.remove('open');
}

/* ======== Export ======== */
function exportCSV(){
  const filtered = applyFilters(rows);
  const headsSet = buildHeads(filtered);
  downloadCSV('presupuestos.csv', toCSV(
    ['fecha','id','comprobante','cliente','vendedor','sucursal','items','ingreso','costo','margen','pct'],
    headsSet
  ));
  // Export de ítems
  downloadCSV('items.csv', toCSV(
    ['fecha','id','comprobante','estado','cliente','vendedor','sucursal','articulo','_cant','precio','_ingreso','_costo','_margen','_pct'],
    filtered
  ));
}

/* ======== Utils de datos ======== */
function normaRow(r){
  const cant = Number(r.cantidad)||0;
  const ingreso = Number(r.importe_item)||0;
  const costo = (Number(r.costo)||0) * cant;
  const margen = ingreso - costo;
  const pctv = ingreso>0 ? margen/ingreso : 0;
  return {
    ...r,
    vendedor: r.vendedor_descripcion || r.vendedor_id || 'SIN VENDEDOR',
    cliente:  r.cliente_descripcion  || r.cliente_id  || 'SIN CLIENTE',
    sucursal: r.stock_origen_descripcion || r.stock_origen_id || 'SIN SUCURSAL',
    articulo: r.articulo_descripcion || r.articulo_id || 'SIN ARTÍCULO',
    _cant: cant, _ingreso: ingreso, _costo: costo, _margen: margen, _pct: pctv
  };
}
function buildHeads(data){
  const map = new Map();
  for (const r of data){
    const id = r.id || '(sin id)';
    const h = map.get(id) || { id, fecha:r.fecha, comprobante:r.comprobante, estado:r.estado,
      cliente:r.cliente, vendedor:r.vendedor, sucursal:r.sucursal,
      items:0, ingreso:0, costo:0, margen:0, pct:0, rows:[] };
    h.items++; h.ingreso+=r._ingreso; h.costo+=r._costo; h.margen+=r._margen; h.rows.push(r);
    map.set(id, h);
  }
  for (const h of map.values()) h.pct = h.ingreso>0 ? h.margen/h.ingreso : 0;
  return Array.from(map.values());
}
function aggregate(data, keyFn){
  const m=new Map();
  for (const r of data){
    const k = typeof keyFn==='function' ? keyFn(r) : r[keyFn];
    const a = m.get(k) || { key:k, presu:0, items:0, ingreso:0, costo:0, margen:0, pct:0, _set:new Set() };
    a.items++; a.ingreso+=r._ingreso; a.costo+=r._costo; a.margen+=r._margen; a._set.add(r.id);
    m.set(k,a);
  }
  for (const v of m.values()){
    v.presu = v._set.size;
    v.pct = v.ingreso>0 ? v.margen/v.ingreso : 0;
    delete v._set; // evitar “filtrarse” en export o UI
  }
  return Object.fromEntries(Array.from(m.values()).map(v=>[v.key,v]));
}
function topBy(obj, field, n){
  return Object.values(obj).sort((a,b)=>b[field]-a[field]).slice(0,n);
}
function kpis(data){
  const ingresos = sum(data,r=>r._ingreso), costos = sum(data,r=>r._costo);
  const margen = ingresos - costos;
  return { ingresos, costos, margen, margenPct: ingresos>0 ? margen/ingresos : 0 };
}
function countHeads(data){ return new Set(data.map(r=>r.id)).size; }
function ticketProm(data){ const presu=countHeads(data)||1; return sum(data,r=>r._ingreso)/presu; }
const sum=(arr,fn)=>arr.reduce((s,x)=>s+(fn?fn(x):x),0);

/* ======== UI helpers ======== */
function hydrateSelect(sel, list){
  const prev = new Set(Array.from(sel.selectedOptions).map(o=>o.value));
  sel.innerHTML = '';
  list.sort().forEach(v=>{
    const o=document.createElement('option'); 
    o.value=o.textContent=v; 
    if(prev.has(v)) o.selected=true; 
    sel.appendChild(o);
  });
}
function reapplySelect(sel, set){ Array.from(sel.options).forEach(o=>{ o.selected = set.has(o.value); }); }
function unique(arr){ return Array.from(new Set(arr)); }
function toggleFilter(group, value){
  const set = state[group];
  if (set.has(value)) set.delete(value); else set.add(value);
  reapplySelect(group==='vendedores'?fVend:group==='clientes'?fCli:fSuc, set);
  render();
}
function paintActiveFilters(){
  activeFilters.innerHTML='';
  const push = (label,set,group)=>{
    set.forEach(v=>{
      const el=document.createElement('span');
      el.className='af'; el.textContent=`${label}: ${v}`;
      const x=document.createElement('button'); x.textContent='×'; x.addEventListener('click', ()=>{
        set.delete(v);
        reapplySelect(group==='Vend'?fVend:group==='Cli'?fCli:fSuc, set); 
        render();
      });
      el.appendChild(x); activeFilters.appendChild(el);
    });
  };
  push('Vend', state.vendedores, 'Vend');
  push('Cli',  state.clientes,   'Cli');
  push('Suc',  state.sucursales, 'Suc');
}

function disableUI(b){ [fDesde,fHasta,fVend,fCli,fSuc,fId,btnApply,btnClear,btnCsv,topN,topArt].forEach(el=>el && (el.disabled=b)); }
function setStatus(msg){ statusEl.textContent=msg; }

/* ======== Formatos ======== */
function money(n){ const v=Number(n)||0; return v.toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function int(n){ const v=Number(n)||0; return v.toLocaleString('es-AR'); }
function pct(p){ return ((Number(p)||0)*100).toFixed(1)+'%'; }
function round2(x){ return Math.round((Number(x)||0)*100)/100; }

// FIX de escapado correcto (antes '>' mapeaba a &quot;)
function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[m]));
}

function fmtDate(ymd){ if(!ymd) return ''; const [Y,M,D]=String(ymd).split('-'); return `${D}/${M}/${Y}`; }
function mclass(p){
  const v=(Number(p)||0)*100;
  if (v<10) return 'bad';
  if (v<15) return 'warn2';
  if (v<20) return 'warn';
  if (v<30) return 'ok2';
  return 'ok';
}

function moneyCompact(n){
  try {
    return new Intl.NumberFormat('es-AR', {
      notation: 'compact', compactDisplay: 'short',
      maximumFractionDigits: 2
    }).format(Number(n)||0);
  } catch { return money(n); }
}

/* ======== CSV ======== */
function toCSV(headers, arr){
  const lines=[headers.join(',')];
  for (const o of arr){
    const row=headers.map(h=>csvCell(o[h]));
    lines.push(row.join(','));
  }
  return lines.join('\n');
}
function csvCell(v){ if(v===null||v===undefined) return ''; const s=String(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; }
function downloadCSV(name,text){ const blob=new Blob([text],{type:'text/csv;charset=utf-8;'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url); }

/* ======== Limpiar filtros ======== */
function clearFilters(){
  state.vendedores.clear();
  state.clientes.clear();
  state.sucursales.clear();
  state.presuId = '';
  reapplySelect(fVend, state.vendedores);
  reapplySelect(fCli, state.clientes);
  reapplySelect(fSuc, state.sucursales);
  fId.value = '';
  qId.value = '';
  topN.value = String(state.topN || 10);
}
