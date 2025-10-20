/* ======== Helpers DOM ======== */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const statusEl = $('#status');

/* ======== Estado global de filtros ======== */
const state = {
  from: '', to: '',
  vendedores: new Set(),
  clientes: new Set(),
  sucursales: new Set(),
  estados: new Set(['VIGENTE','CERRADO','ANULADO']),
  presuId: '',
  topN: 10
};

/* ======== Elementos ======== */
const fDesde = $('#f-desde'), fHasta = $('#f-hasta');
const fVend = $('#f-vendedor'), fCli = $('#f-cliente'), fSuc = $('#f-sucursal');
const stVig = $('#st-vigente'), stCer = $('#st-cerrado'), stAnu = $('#st-anulado');
const fId = $('#f-id'), btnApply = $('#btn-apply'), btnClear = $('#btn-clear'), btnCsv = $('#btn-csv');
const activeFilters = $('#active-filters');
const topN = $('#topN');

const qId = $('#q-id');

const tblVend = $('#tbl-vend tbody'), tblCli = $('#tbl-cli tbody'), tblSuc = $('#tbl-suc tbody');
const tblHeads = $('#tbl-heads tbody'), pgHeads = $('#pg-heads');
const tblItems = $('#tbl-items tbody'), pgItems = $('#pg-items');

const drawer = $('#drawer'), dwClose = $('#dw-close');
const dwTitle = $('#dw-title'), dwMeta = $('#dw-meta'), dwBody = $('#dw-table tbody'), dwResBody = $('#dw-res-table tbody');

/* ======== Datos en memoria ======== */
let rows = [];       // ítems normalizados (_ingreso/_costo/_margen/_pct)
let heads = [];      // cabeceras agregadas por id (con rows)

/* ======== Charts ======== */
let chVend=null, chCli=null, chSuc=null;

/* ======== Init ======== */
init();
async function init(){
  // fechas por defecto
  const t = new Date(), y=t.getFullYear(), m=String(t.getMonth()+1).padStart(2,'0'), d=String(t.getDate()).padStart(2,'0');
  fDesde.value = localStorage.getItem('from') || `${y}-${m}-${d}`;
  fHasta.value = localStorage.getItem('to') || `${y}-${m}-${d}`;

  restoreState();
  bindUI();
  await fetchAndRender(); // primera carga
}

function bindUI(){
  btnApply.addEventListener('click', fetchAndRender);
  btnClear.addEventListener('click', () => { clearFilters(); fetchAndRender(); });
  btnCsv.addEventListener('click', exportCSV);
  topN.addEventListener('change', ()=>{ state.topN = Number(topN.value)||10; drawCharts(); });

  // Estados
  [stVig, stCer, stAnu].forEach(ch => ch.addEventListener('change', () => {
    const map = new Map([[stVig,'VIGENTE'],[stCer,'CERRADO'],[stAnu,'ANULADO']]);
    state.estados = new Set([...map].filter(([el])=>el.checked).map(([el,val])=>val));
    render(); // no refetch
  }));

  // Tabs
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

  // Drawer
  dwClose.addEventListener('click', ()=> drawer.classList.remove('open'));
  document.addEventListener('keydown', e=>{ if (e.key==='Escape') drawer.classList.remove('open'); });

  // Buscar ID en tabla presupuestos (debounce)
  let tId = 0;
  qId.addEventListener('input', () => {
    clearTimeout(tId); tId = setTimeout(()=> renderHeads(qId.value.trim()), 250);
  });
}

/* ======== Fetch + render ======== */
async function fetchAndRender(){
  // validar fechas
  const from = fDesde.value, to = fHasta.value || from;
  if (!from) return alert('Elegí "Desde"'); if (to<from) return alert('"Hasta" < "Desde"');
  state.from = from; state.to = to;
  localStorage.setItem('from', from); localStorage.setItem('to', to);

  disableUI(true); setStatus('Consultando servicio…');
  try {
    const resp = await fetch(`/api/presupuesto_detalle?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(json.error || 'Error de API');

    rows = (json.data||[]).map(normaRow);
    heads = buildHeads(rows);

    // poblar selects (listas del conjunto)
    hydrateSelect(fVend, unique(rows.map(r=>r.vendedor_descripcion||r.vendedor_id||'SIN VENDEDOR')));
    hydrateSelect(fCli,  unique(rows.map(r=>r.cliente_descripcion||r.cliente_id||'SIN CLIENTE')));
    hydrateSelect(fSuc,  unique(rows.map(r=>r.stock_origen_descripcion||r.stock_origen_id||'SIN SUCURSAL')));

    // restaurar selección previa
    reapplySelect(fVend, state.vendedores); reapplySelect(fCli, state.clientes); reapplySelect(fSuc, state.sucursales);

    render();
    btnCsv.disabled = rows.length===0;
    setStatus(`OK. Ítems=${rows.length}. Rango ${json.from} → ${json.to}`);
  } catch(e){
    console.error(e); setStatus('Error: '+e.message); alert(e.message);
  } finally {
    disableUI(false);
  }
}

/* ======== Render global según filtros ======== */
function render(){
  captureFiltersFromUI();
  paintActiveFilters();

  const filtered = applyFilters(rows);
  const k = kpis(filtered);
  $('#k-ingresos').textContent = money(k.ingresos);
  $('#k-costos').textContent   = money(k.costos);
  $('#k-margen').textContent   = money(k.margen);
  $('#k-margen-pct').textContent = pct(k.margenPct);
  $('#k-presu').textContent = int(countHeads(filtered));
  $('#k-ticket').textContent = money(ticketProm(filtered));

  drawChartsFrom(filtered);
  renderAggTables(filtered);
  renderHeads(qId.value.trim(), filtered);
  renderItems(filtered);
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
  const est = state.estados;
  const vend = state.vendedores, cli = state.clientes, suc = state.sucursales;
  const id = state.presuId;
  return data.filter(r=>{
    if (id && String(r.id)!==id) return false;
    if (vend.size && !vend.has(r.vendedor)) return false;
    if (cli.size && !cli.has(r.cliente)) return false;
    if (suc.size && !suc.has(r.sucursal)) return false;
    if (!est.has((r.estado||'').toUpperCase())) return false;
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
function drawCharts(aggVend, aggCli, aggSuc){
  const n = state.topN;
  const vendArr = topBy(aggVend,'ingreso',n), cliArr = topBy(aggCli,'ingreso',n), sucArr = topBy(aggSuc,'ingreso',n);

  chVend && chVend.destroy();
  chVend = miniBar($('#chartVend'), vendArr.map(x=>x.key), vendArr.map(x=>round2(x.ingreso)), (label)=>toggleFilter('vendedores',label));
  chCli && chCli.destroy();
  chCli = miniBar($('#chartCli'), cliArr.map(x=>x.key), cliArr.map(x=>round2(x.ingreso)), (label)=>toggleFilter('clientes',label));
  chSuc && chSuc.destroy();
  chSuc = miniBar($('#chartSuc'), sucArr.map(x=>x.key), sucArr.map(x=>round2(x.ingreso)), (label)=>toggleFilter('sucursales',label));
}
function miniBar(canvas, labels, data, onClick){
  return new Chart(canvas, {
    type:'bar',
    data:{labels, datasets:[{label:'Ingreso', data}]},
    options:{
      responsive:true,
      plugins:{legend:{display:false}, tooltip:{callbacks:{label:(c)=>money(c.parsed.y)}}},
      indexAxis:'y',
      onClick:(_, els)=>{ if(els?.length){ const i=els[0].index; onClick(labels[i]); } },
      scales:{ x:{ ticks:{ callback:v=>money(v)} } }
    }
  });
}
function paintAggTable(tbody, aggObj, kind){
  const arr = topBy(aggObj,'ingreso',Infinity);
  tbody.innerHTML='';
  let i=0;
  for (const v of arr){
    i++;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(v.key)}</td>
      <td>${int(v.presu)}</td>
      <td>${int(v.items)}</td>
      <td>${money(v.ingreso)}</td>
      <td>${money(v.margen)}</td>
      <td class="${mclass(v.pct)}">${pct(v.pct)}</td>`;
    tr.addEventListener('click', ()=>toggleFilter(kind==='vendedor'?'vendedores':kind==='cliente'?'clientes':'sucursales', v.key));
    tbody.appendChild(tr);
  }
}

/* ======== Heads & Drawer ======== */
function renderHeads(searchExact='', filteredRows=null){
  const FR = filteredRows || applyFilters(rows);
  const set = buildHeads(FR);
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
      <td>${int(h.items)}</td>
      <td>${money(h.ingreso)}</td>
      <td>${money(h.costo)}</td>
      <td>${money(h.margen)}</td>
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
      <td>${int(r._cant)}</td>
      <td>${money(r.precio)}</td>
      <td>${money(r._ingreso)}</td>
      <td>${money(r._costo)}</td>
      <td>${money(r._margen)}</td>
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
        <td>${int(v.items)}</td><td>${money(v.ingreso)}</td><td>${money(v.costo)}</td>
        <td>${money(v.margen)}</td><td class="${mclass(v.pct)}">${pct(v.pct)}</td>`;
      dwResBody.appendChild(tr);
    }
  }
  drawer.classList.add('open');
}

/* ======== Items (detalle global) ======== */
function renderItems(FR){
  const set = FR || applyFilters(rows);
  // orden fecha desc
  set.sort((a,b)=> (a.fecha<b.fecha?1:-1));
  const rowsPerPage = 50;
  const pages = Math.max(1, Math.ceil(set.length/rowsPerPage));
  let page = Number(pgItems.dataset.page||1); if (page>pages) page=pages;
  const slice = set.slice((page-1)*rowsPerPage, (page-1)*rowsPerPage+rowsPerPage);

  tblItems.innerHTML='';
  for (const r of slice){
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td>${fmtDate(r.fecha)}</td><td>${esc(r.id)}</td><td>${esc(r.comprobante)}</td><td>${esc(r.estado)}</td>
      <td>${esc(r.cliente)}</td><td>${esc(r.vendedor)}</td><td>${esc(r.sucursal)}</td>
      <td>${esc(r.articulo)}</td><td>${int(r._cant)}</td><td>${money(r.precio)}</td>
      <td>${money(r._ingreso)}</td><td>${money(r._costo)}</td><td>${money(r._margen)}</td><td class="${mclass(r._pct)}">${pct(r._pct)}</td>`;
    tblItems.appendChild(tr);
  }

  pgItems.innerHTML='';
  for (let i=1;i<=pages;i++){
    const b=document.createElement('button'); b.textContent=i; if (i===page) b.classList.add('active');
    b.addEventListener('click', ()=>{ pgItems.dataset.page=i; renderItems(set); });
    pgItems.appendChild(b);
  }
}

/* ======== Export ======== */
function exportCSV(){
  const filtered = applyFilters(rows);
  // dos archivos: cabeceras e ítems
  const headsSet = buildHeads(filtered);
  downloadCSV('presupuestos.csv', toCSV(['fecha','id','comprobante','cliente','vendedor','sucursal','items','ingreso','costo','margen','pct'], headsSet));
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
  for (const v of m.values()) v.presu = v._set.size, v.pct = v.ingreso>0 ? v.margen/v.ingreso : 0;
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
  sel.innerHTML = ''; list.sort().forEach(v=>{ const o=document.createElement('option'); o.value=o.textContent=v; if(prev.has(v)) o.selected=true; sel.appendChild(o); });
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
      const x=document.createElement('button'); x.textContent='×'; x.addEventListener('click', ()=>{ set.delete(v); reapplySelect(group==='Vend'?fVend:group==='Cli'?fCli:fSuc, set); render(); });
      el.appendChild(x); activeFilters.appendChild(el);
    });
  };
  push('Vend', state.vendedores, 'Vend');
  push('Cli',  state.clientes,   'Cli');
  push('Suc',  state.sucursales, 'Suc');
}

function disableUI(b){ [fDesde,fHasta,fVend,fCli,fSuc,fId,btnApply,btnClear,btnCsv,topN].forEach(el=>el.disabled=b); }
function setStatus(msg){ statusEl.textContent=msg; }

function money(n){ const v=Number(n)||0; return v.toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function int(n){ const v=Number(n)||0; return v.toLocaleString('es-AR'); }
function pct(p){ return ((Number(p)||0)*100).toFixed(1)+'%'; }
function round2(x){ return Math.round((Number(x)||0)*100)/100; }
function esc(s){ return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function fmtDate(ymd){ if(!ymd) return ''; const [Y,M,D]=String(ymd).split('-'); return `${D}/${M}/${Y}`; }
function mclass(p){
  const v=(Number(p)||0)*100;
  if (v<10) return 'bad';
  if (v<15) return 'warn2';
  if (v<20) return 'warn';
  if (v<30) return 'ok2';
  return 'ok';
}
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

/* ======== Persistencia simple ======== */
function restoreState(){
  const s = JSON.parse(localStorage.getItem('panel_state')||'{}');
  if (s.vendedores) state.vendedores=new Set(s.vendedores);
  if (s.clientes) state.clientes=new Set(s.clientes);
  if (s.sucursales) state.sucursales=new Set(s.sucursales);
  if (s.estados) state.estados=new Set(s.estados);
  if (s.topN) state.topN=s.topN;
  topN.value = state.topN;
}
window.addEventListener('beforeunload', ()=>{
  localStorage.setItem('panel_state', JSON.stringify({
    vendedores:[...state.vendedores], clientes:[...state.clientes], sucursales:[...state.sucursales],
    estados:[...state.estados], topN:state.topN
  }));
});
