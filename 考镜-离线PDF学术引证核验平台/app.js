/* ============================================================
   本地 PDF 核验台 · 应用逻辑
   PDF.js + Tesseract.js + IndexedDB · 全本地，无网络上传
   ============================================================ */

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ---- IndexedDB helpers ----
// 数据隔离：每个使用者档案拥有独立的数据库（DB_PREFIX + profileId），
// 另有独立的档案注册表库 PROFILES_DB 仅保存档案元信息（名称/颜色/密码哈希/时间），不含任何 PDF 内容。
const DB_PREFIX = 'pdf-verify-db::';
const DB_VER = 3;
const PROFILES_DB = 'pdf-verify-profiles';
const PROFILES_VER = 1;
let db = null;          // 当前使用者档案的数据库
let profilesDb = null;  // 使用者档案注册表

function openProfileDB(profileId){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_PREFIX + profileId, DB_VER);
    req.onupgradeneeded = (e)=>{
      const d = e.target.result;
      if(!d.objectStoreNames.contains('docs')) d.createObjectStore('docs',{keyPath:'id'});
      if(!d.objectStoreNames.contains('pages')) d.createObjectStore('pages',{keyPath:'id'});
      if(!d.objectStoreNames.contains('citations')) d.createObjectStore('citations',{keyPath:'id'});
      if(!d.objectStoreNames.contains('trash')) d.createObjectStore('trash',{keyPath:'docId'});
      if(!d.objectStoreNames.contains('settings')) d.createObjectStore('settings',{keyPath:'k'});
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}
function openProfilesDB(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(PROFILES_DB, PROFILES_VER);
    req.onupgradeneeded = (e)=>{
      const d = e.target.result;
      if(!d.objectStoreNames.contains('profiles')) d.createObjectStore('profiles',{keyPath:'id'});
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}
function deleteProfileDB(profileId){
  return new Promise((resolve)=>{
    try{
      const req = indexedDB.deleteDatabase(DB_PREFIX + profileId);
      req.onsuccess = ()=>resolve(true);
      req.onerror = ()=>resolve(false);
      req.onblocked = ()=>resolve(false);
    }catch(e){ resolve(false); }
  });
}
// 档案注册表操作
const ptx = (m='readonly')=> profilesDb.transaction('profiles', m).objectStore('profiles');
const profAll = ()=> new Promise((r,j)=>{const q=ptx().getAll();q.onsuccess=()=>r(q.result||[]);q.onerror=()=>j(q.error);});
const profPut = (v)=> new Promise((r,j)=>{const q=ptx('readwrite').put(v);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
const profDel = (k)=> new Promise((r,j)=>{const q=ptx('readwrite').delete(k);q.onsuccess=()=>r();q.onerror=()=>j(q.error);});

// 当前档案数据操作
const tx = (s,m='readonly')=> db.transaction(s,m).objectStore(s);
const idbPut = (s,v)=> new Promise((r,j)=>{const q=tx(s,'readwrite').put(v);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
const idbGet = (s,k)=> new Promise((r,j)=>{const q=tx(s).get(k);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
const idbAll = (s)=> new Promise((r,j)=>{const q=tx(s).getAll();q.onsuccess=()=>r(q.result||[]);q.onerror=()=>j(q.error);});
const idbDel = (s,k)=> new Promise((r,j)=>{const q=tx(s,'readwrite').delete(k);q.onsuccess=()=>r();q.onerror=()=>j(q.error);});
const idbClear = (s)=> new Promise((r,j)=>{const q=tx(s,'readwrite').clear();q.onsuccess=()=>r();q.onerror=()=>j(q.error);});

// ---- State ----
const state = {
  docs: [], pages: [], citations: [], trash: [],
  currentView:'library', currentDoc:null, currentQuery:'',
  currentResults:[], currentHitIdx:0,
  searchMode:'phrase', searchScope:'all', typeFilter:'all',
  verifyOriginal:'', verifyOriginalMeta:null, verifyQuote:'',
  pdfDoc:null, pdfScale:1.2, ocrLang:'chi_sim+eng',
  renderedPages:new Map(),
  selected:new Set(),
  settings:{ trashRetentionDays: 30 }, // 0 = 永久保留，不自动清理
  profiles: [], currentProfile: null,
};

// ---- Utils ----
const $ = (s,el=document)=>el.querySelector(s);
const $$ = (s,el=document)=>Array.from(el.querySelectorAll(s));
const fmtBytes = (n)=>{ n=n||0; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KB'; if(n<1073741824) return (n/1048576).toFixed(1)+' MB'; return (n/1073741824).toFixed(2)+' GB'; };
const fmtDate = (t)=> new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const uid = ()=> 'id-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
const escapeHTML = (s)=> String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const escapeReg = (s)=> s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const debounce = (fn,ms)=>{ let t; return function(...a){ clearTimeout(t); t=setTimeout(()=>fn.apply(this,a),ms); }; };

function toast(msg,type='info',ms=2600){
  const el = document.createElement('div');
  el.className = 'toast '+type;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(()=>{ el.style.transition='opacity .2s,transform .2s'; el.style.opacity='0'; el.style.transform='translateY(6px)'; setTimeout(()=>el.remove(),220); }, ms);
}

// ---- View switching ----
function switchView(name){
  state.currentView = name;
  $$('.view').forEach(v=>v.classList.toggle('active', v.id==='view-'+name));
  $$('#mainNav .nav-item').forEach(b=>b.classList.toggle('active', b.dataset.view===name));
  if(name==='library') renderLibrary();
  if(name==='search') renderSearch();
  if(name==='ocr') renderOCR();
  if(name==='trash') renderTrash();
  if(name==='storage') renderStorage();
  if(name==='verify') renderVerify();
}
$$('#mainNav .nav-item').forEach(b=> b.addEventListener('click', ()=> switchView(b.dataset.view)));

// ---- Type labels ----
const docTypeLabel = (t)=> ({text:'文字版',scanned:'扫描版',image:'图片版',mixed:'混合'}[t]||'未知');
const docStatusLabel = (s)=> ({queued:'排队中',processing:'解析中',ocr:'OCR中',indexed:'已索引',failed:'失败'}[s]||s);

// ---- Library render ----
function renderLibrary(){
  const grid = $('#docGrid'), empty = $('#libraryEmpty');
  const docs = state.docs.filter(d=> state.typeFilter==='all' || d.type===state.typeFilter);
  $('#docCountLabel').textContent = docs.length+' 份';
  $('#navDocCount').textContent = state.docs.length;
  $('#cntAll').textContent = state.docs.length;
  $('#cntText').textContent = state.docs.filter(d=>d.type==='text').length;
  $('#cntScanned').textContent = state.docs.filter(d=>d.type==='scanned').length;
  $('#cntImage').textContent = state.docs.filter(d=>d.type==='image').length;
  const totalPages = state.docs.reduce((a,d)=>a+(d.pages||0),0);
  const totalChars = state.pages.reduce((a,p)=>a+(p.text?p.text.length:0),0);
  $('#librarySub').textContent = `共 ${state.docs.length} 份文档 · ${totalPages} 页 · ${totalChars.toLocaleString('zh-CN')} 字`;

  if(docs.length===0){ grid.innerHTML=''; empty.classList.remove('hidden'); updateSelectionUI(docs); return; }
  empty.classList.add('hidden');
  grid.innerHTML = docs.map(d=>`
    <div class="doc-card ${state.currentDoc&&state.currentDoc.id===d.id?'active':''} ${state.selected.has(d.id)?'selected':''}" data-id="${d.id}" data-selectable="1" tabindex="0" role="button" aria-label="打开 ${escapeHTML(d.name)}">
      <div class="doc-thumb">
        ${d.thumb?`<img src="${d.thumb}" alt=""/>`:`<div class="doc-thumb-placeholder"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/></svg><span>无预览</span></div>`}
        <span class="doc-type-tag" data-type="${d.type}">${docTypeLabel(d.type)}</span>
        <span class="doc-status" data-status="${d.status}" title="${docStatusLabel(d.status)}"></span>
        <input type="checkbox" class="doc-check" data-check="${d.id}" ${state.selected.has(d.id)?'checked':''} aria-label="选择 ${escapeHTML(d.name)}" title="选择此文档" />
      </div>
      <div class="doc-info">
        <div class="doc-name" title="${escapeHTML(d.name)}">${escapeHTML(d.name)}</div>
        <div class="doc-meta"><span>${d.pages||0} 页</span><span class="doc-meta-dot"></span><span>${fmtBytes(d.size)}</span><span class="doc-meta-dot"></span><span>${fmtDate(d.addedAt)}</span></div>
        ${(d.status==='ocr'||d.status==='processing')?`<div class="doc-progress"><div class="doc-progress-fill" style="width:${d.progress||0}%"></div></div><div class="doc-meta" style="font-size:10.5px;color:var(--warning)">${docStatusLabel(d.status)} · ${Math.round(d.progress||0)}%</div>`:''}
        ${d.status==='failed'?`<div class="doc-meta" style="font-size:10.5px;color:var(--danger)">${escapeHTML(d.error||'解析失败')}</div>`:''}
        ${d.status==='indexed'?`<div class="doc-meta" style="font-size:10.5px;color:var(--success)">已索引 · ${(d.charCount||0).toLocaleString('zh-CN')} 字${d.confidence?` · 置信度 ${Math.round(d.confidence)}%`:''}</div>`:''}
      </div>
    </div>`).join('');
  $$('.doc-card',grid).forEach(card=>{
    card.addEventListener('click', e=>{
      if(e.target.closest('.doc-check')) return; // 勾选框点击不触发打开
      openDoc(card.dataset.id);
    });
    card.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openDoc(card.dataset.id);} });
  });
  $$('.doc-check',grid).forEach(chk=>{
    chk.addEventListener('click', e=> e.stopPropagation());
    chk.addEventListener('change', e=>{
      e.stopPropagation();
      const id = chk.dataset.check;
      if(chk.checked) state.selected.add(id); else state.selected.delete(id);
      const card = chk.closest('.doc-card');
      if(card) card.classList.toggle('selected', chk.checked);
      updateSelectionUI(docs);
    });
  });
  updateSelectionUI(docs);
}

// 当前筛选下可见的文档（用于全选范围）
function visibleDocs(){
  return state.docs.filter(d=> state.typeFilter==='all' || d.type===state.typeFilter);
}
function updateSelectionUI(docs){
  const list = docs || visibleDocs();
  const ids = list.map(d=>d.id);
  const selInView = ids.filter(id=> state.selected.has(id));
  const n = state.selected.size;
  const cnt = $('#selCountLabel');
  if(cnt){ cnt.textContent = `已选 ${n}`; cnt.classList.toggle('has', n>0); }
  const del = $('#btnDeleteSelected');
  if(del) del.disabled = n===0;
  const all = $('#chkSelectAll');
  if(all){
    all.checked = ids.length>0 && selInView.length===ids.length;
    all.indeterminate = selInView.length>0 && selInView.length<ids.length;
    all.disabled = ids.length===0;
  }
}

$$('#typeFilters .filter-chip').forEach(c=>{
  c.addEventListener('click', ()=>{
    $$('#typeFilters .filter-chip').forEach(x=>x.classList.remove('active'));
    c.classList.add('active');
    state.typeFilter = c.dataset.type;
    renderLibrary();
  });
});

// ---- Upload ----
$('#dropzone').addEventListener('click', ()=> $('#fileInput').click());
$('#dropzone').addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); $('#fileInput').click(); }});
$('#btnBrowse').addEventListener('click', e=>{ e.stopPropagation(); $('#fileInput').click(); });
$('#btnUploadTop').addEventListener('click', ()=> $('#fileInput').click());
$('#btnUploadSide').addEventListener('click', ()=> $('#fileInput').click());
$('#qaUpload').addEventListener('click', ()=> $('#fileInput').click());
['dragenter','dragover'].forEach(ev=> $('#dropzone').addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); $('#dropzone').classList.add('dragover'); }));
['dragleave','drop'].forEach(ev=> $('#dropzone').addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); $('#dropzone').classList.remove('dragover'); }));
$('#dropzone').addEventListener('drop', e=>{
  const files = Array.from(e.dataTransfer.files||[]).filter(f=> /\.pdf$/i.test(f.name) || f.type==='application/pdf');
  if(!files.length){ toast('请拖入 PDF 文件','warn'); return; }
  handleFiles(files);
});
$('#fileInput').addEventListener('change', e=>{
  const files = Array.from(e.target.files||[]);
  if(files.length) handleFiles(files);
  e.target.value='';
});

async function handleFiles(files){
  toast(`已加入 ${files.length} 个文件到处理队列`,'info');
  for(const f of files){
    if(f.size > 600*1024*1024){ toast(`${f.name} 超过 600 MB，已跳过`,'warn'); continue; }
    const buf = await f.arrayBuffer();
    const doc = {
      id: uid(), name: f.name, size: f.size, type:'text',
      status:'processing', progress:0, addedAt: Date.now(),
      ocrLang: state.ocrLang, pages:0, charCount:0, confidence:null,
      blob: buf,
    };
    await idbPut('docs', doc);
    state.docs.unshift(doc);
    renderLibrary(); updateStatusBar();
    processDoc(doc);
  }
}

async function processDoc(doc){
  try{
    const pdf = await pdfjsLib.getDocument({data: doc.blob.slice(0)}).promise;
    doc.pages = pdf.numPages;

    // 探测是否有文本层
    let sampleText = '';
    for(let i=1;i<=Math.min(3,pdf.numPages);i++){
      const p = await pdf.getPage(i);
      const tc = await p.getTextContent();
      sampleText += tc.items.map(it=>it.str).join(' ');
    }
    const hasText = sampleText.replace(/\s/g,'').length > 40;
    doc.type = hasText ? 'text' : 'scanned';
    doc.status = hasText ? 'processing' : 'ocr';
    doc.progress = 0;
    await idbPut('docs', doc);
    renderLibrary(); renderOCR();

    // 生成缩略图
    try{
      const p1 = await pdf.getPage(1);
      const vp1 = p1.getViewport({scale:0.4});
      const c = document.createElement('canvas');
      c.width=vp1.width; c.height=vp1.height;
      await p1.render({canvasContext:c.getContext('2d'),viewport:vp1}).promise;
      doc.thumb = c.toDataURL('image/jpeg',0.72);
      await idbPut('docs', doc); renderLibrary();
    }catch(e){ console.warn('thumb fail',e); }

    let totalChars = 0, confSum = 0, confCnt = 0, donePages = 0;
    // 扫描/图片版：初始化并发 OCR 引擎池；文字版：并发抽取文本层
    const pool = hasText ? null : await getOCRPool(doc.ocrLang);
    const concurrency = hasText ? Math.min(4, OCR_POOL_SIZE+2) : OCR_POOL_SIZE;
    const pageNumbers = [];
    for(let pn=1; pn<=pdf.numPages; pn++) pageNumbers.push(pn);

    await mapLimit(pageNumbers, concurrency, async (pn)=>{
      const page = await pdf.getPage(pn);
      let text='', words=[], conf=null;
      if(hasText){
        const tc = await page.getTextContent();
        const vp = page.getViewport({scale:1});
        text = tc.items.map(it=>it.str).join(' ');
        words = tc.items.map(it=>{
          const tr = pdfjsLib.Util.transform(vp.transform, it.transform);
          const w = Math.abs(it.width * vp.scale) || 8;
          const h = Math.abs(it.height * vp.scale) || 10;
          return { t: it.str, x: tr[4], y: tr[5]-h, w, h };
        }).filter(w=> w.t && w.t.trim());
      } else {
        const { canvas, scale } = await renderPageForOCR(page);
        const data = await ocrCanvas(pool, canvas);
        text = data.text||'';
        // 词框从渲染像素换算回 scale=1 的 PDF 坐标，与文本层保持一致，保证高亮精准定位
        words = (data.words||[]).map(w=>({
          t: w.text, x: w.bbox.x0/scale, y: w.bbox.y0/scale,
          w: (w.bbox.x1-w.bbox.x0)/scale, h: (w.bbox.y1-w.bbox.y0)/scale,
          conf: w.confidence,
        })).filter(w=> w.t && w.t.trim());
        conf = data.confidence||0;
        canvas.width = 0; canvas.height = 0; // 及时释放显存
      }
      const pageRec = { id: doc.id+'-p'+pn, docId: doc.id, pageNo: pn, text, words, source: hasText?'textlayer':'ocr' };
      await idbPut('pages', pageRec);
      state.pages.push(pageRec);
      totalChars += text.length;
      if(conf!=null){ confSum += conf; confCnt++; }
      donePages++;
      doc.progress = donePages/pdf.numPages*100;
      throttleUI(()=>{ idbPut('docs',doc); renderLibrary(); renderOCR(); updateStatusBar(); });
    });

    doc.status='indexed'; doc.progress=100; doc.charCount=totalChars;
    if(confCnt) doc.confidence = confSum/confCnt;
    await idbPut('docs', doc);
    renderLibrary(); renderOCR(); updateStatusBar();
    toast(`${doc.name} 解析完成 · ${pdf.numPages} 页 · ${totalChars.toLocaleString('zh-CN')} 字`,'success');
  } catch(err){
    console.error(err);
    doc.status='failed';
    doc.error = (err && err.message) ? err.message : '解析失败';
    await idbPut('docs', doc);
    renderLibrary(); renderOCR();
    toast(`${doc.name} 解析失败：${doc.error}`,'error',4200);
  }
}

// ---- OCR（多 worker 并发 + 图像预处理）----
const OCR_POOL_SIZE = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency||4)/2)));
let ocrPool = null; // {lang, workers, free, waiting}

async function createOneWorker(lang){
  const w = await Tesseract.createWorker(lang, 1, {
    logger: m=>{
      if(m.status==='loading language traineddata'){
        setEngineStatus(`加载语言包 ${Math.round((m.progress||0)*100)}%`,'warn');
      }
    }
  });
  // 提升识别质量与词框精度的参数
  try{
    await w.setParameters({
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: (Tesseract.PSM && Tesseract.PSM.AUTO) || '3',
    });
  }catch(e){ /* 某些语言包不支持时忽略 */ }
  return w;
}

async function getOCRPool(lang){
  if(ocrPool && ocrPool.lang===lang && ocrPool.workers.length) return ocrPool;
  if(ocrPool){ for(const w of ocrPool.workers){ try{ await w.terminate(); }catch(e){} } ocrPool=null; }
  setEngineStatus(`初始化 OCR 引擎（${OCR_POOL_SIZE} 路并发）…`,'warn');
  const workers = [];
  // 顺序创建，避免同时重复下载语言包
  for(let i=0;i<OCR_POOL_SIZE;i++) workers.push(await createOneWorker(lang));
  ocrPool = { lang, workers, free: workers.slice(), waiting: [] };
  setEngineStatus(`就绪 · ${lang} · ${OCR_POOL_SIZE} 路并发`,'ok');
  return ocrPool;
}
function acquireWorker(pool){
  return new Promise(res=>{
    if(pool.free.length) return res(pool.free.pop());
    pool.waiting.push(res);
  });
}
function releaseWorker(pool, w){
  if(pool.waiting.length) pool.waiting.shift()(w);
  else pool.free.push(w);
}

// 自适应分辨率渲染 + 灰度对比度拉伸，改善扫描件识别率；返回 scale 用于把词框换算回 PDF 坐标
async function renderPageForOCR(page){
  const base = page.getViewport({scale:1});
  const longEdge = Math.max(base.width, base.height) || 842;
  const targetLong = 2000; // 目标长边像素，兼顾精度与速度
  let s = targetLong / longEdge;
  s = Math.max(1.5, Math.min(3.5, s));
  const vp = page.getViewport({scale:s});
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(vp.width));
  c.height = Math.max(1, Math.floor(vp.height));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  await page.render({canvasContext:ctx, viewport:vp}).promise;
  try{
    const img = ctx.getImageData(0,0,c.width,c.height);
    const d = img.data;
    const hist = new Array(256).fill(0);
    for(let i=0;i<d.length;i+=4){
      const g = (d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114)|0;
      d[i]=d[i+1]=d[i+2]=g; hist[g]++;
    }
    const total = c.width*c.height;
    const lowCut = total*0.02, highCut = total*0.98;
    let lo=0, hi=255, acc=0;
    for(let v=0;v<256;v++){ acc+=hist[v]; if(acc>=lowCut){ lo=v; break; } }
    acc=0; for(let v=0;v<256;v++){ acc+=hist[v]; if(acc>=highCut){ hi=v; break; } }
    const range = Math.max(1, hi-lo);
    for(let i=0;i<d.length;i+=4){
      let g = ((d[i]-lo)*255/range)|0;
      g = g<0?0:(g>255?255:g);
      d[i]=d[i+1]=d[i+2]=g;
    }
    ctx.putImageData(img,0,0);
  }catch(e){ /* 增强失败时退回原始渲染 */ }
  return { canvas:c, scale:s };
}

// 直接把 canvas 交给引擎，避免 PNG 编解码开销
async function ocrCanvas(pool, canvas){
  const w = await acquireWorker(pool);
  try{
    const { data } = await w.recognize(canvas);
    return data;
  } finally {
    releaseWorker(pool, w);
  }
}

// 并发受限的 map，用于并行解析多页
async function mapLimit(items, limit, fn){
  const ret = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async ()=>{
    while(cursor < items.length){
      const idx = cursor++;
      ret[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return ret;
}

// 进度 UI 节流，避免高并发下频繁重排
let _lastUIAt = 0;
function throttleUI(fn, force){
  const now = Date.now();
  if(force || now - _lastUIAt > 140){ _lastUIAt = now; fn(); }
}
function setEngineStatus(text,kind){
  $('#engineStatus').textContent = text;
  $('#engineLang').textContent = state.ocrLang;
  $('#engineDot').className = 'status-dot '+(kind==='ok'?'ok':kind==='warn'?'warn':kind==='err'?'err':'');
  $('#statusEngine').textContent = text;
  $('#statusEngineDot').className = 'status-dot '+(kind==='ok'?'ok':kind==='warn'?'warn':kind==='err'?'err':'');
}
$('#ocrLangSelect').addEventListener('change', e=>{
  state.ocrLang = e.target.value;
  // 语言变更后让引擎池在下次 OCR 时按新语言重建
  if(ocrPool && ocrPool.lang!==state.ocrLang){
    const old = ocrPool; ocrPool = null;
    for(const w of old.workers){ try{ w.terminate(); }catch(_){} }
  }
  setEngineStatus(`就绪 · ${state.ocrLang} · ${OCR_POOL_SIZE} 路并发`,'ok');
  toast(`OCR 语言已切换为 ${state.ocrLang}（${OCR_POOL_SIZE} 路并发）`,'info');
});

// ---- Search ----
const normalize = (s)=> String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
function tokenize(s){
  const norm = normalize(s), out = [];
  const en = norm.match(/[a-z0-9]+/g)||[];
  out.push(...en);
  const cjk = norm.replace(/[a-z0-9\s]/g,'');
  for(let i=0;i<cjk.length;i++){
    out.push(cjk[i]);
    if(i<cjk.length-1) out.push(cjk[i]+cjk[i+1]);
  }
  return out;
}

function searchDocs(query, mode, scope){
  const q = normalize(query);
  if(!q) return [];
  const docsInScope = state.docs.filter(d=>{
    if(d.status!=='indexed') return false;
    if(scope==='text') return d.type==='text';
    if(scope==='scanned') return d.type==='scanned'||d.type==='image';
    return true;
  });
  let re;
  try{
    if(mode==='regex') re = new RegExp(query,'gi');
    else if(mode==='phrase') re = new RegExp(escapeReg(q),'gi');
    else {
      const toks=[...new Set(tokenize(q))].filter(Boolean);
      if(!toks.length) return [];
      re = new RegExp(toks.map(escapeReg).join('|'),'gi');
    }
  }catch(e){ toast('正则无效','error'); return []; }

  const results = [];
  // 大文件（多页）优化：先按 docId 预分组，避免每份文档都全量过滤 pages
  const pagesByDoc = new Map();
  for(const p of state.pages){
    if(!pagesByDoc.has(p.docId)) pagesByDoc.set(p.docId, []);
    pagesByDoc.get(p.docId).push(p);
  }
  for(const doc of docsInScope){
    const pages = (pagesByDoc.get(doc.id)||[]).slice().sort((a,b)=>a.pageNo-b.pageNo);
    for(const pg of pages){
      const text = pg.text||'';
      if(!text) continue;
      re.lastIndex = 0;
      let m, guard = 0;
      // 精准命中：不再对每页命中数做低截断，大文件逐处收录（上限提高到 5000 页内命中）
      while((m = re.exec(text))!==null && guard++<5000){
        if(m[0].length===0){ re.lastIndex++; continue; }
        const idx = m.index, len = m[0].length;
        const ctxStart = Math.max(0, idx-60), ctxEnd = Math.min(text.length, idx+len+60);
        // 精准定位：收集命中覆盖的每个词框，并按“同一行”聚合成多个紧致矩形，
        // 避免跨行命中被合并成一个巨大的高亮框，确保高亮严格贴合原文位置。
        const boxes = [];
        if(pg.words && pg.words.length){
          let cum = 0;
          const matched = [];
          for(let wi=0; wi<pg.words.length; wi++){
            const w = pg.words[wi];
            const wEnd = cum + w.t.length;
            if(wEnd > idx && cum < idx+len) matched.push(w);
            cum = wEnd + 1;
            if(cum >= idx+len) break;
          }
          // 按行聚合（y 中心相近视为同一行）
          for(const w of matched){
            const b = { x:w.x, y:w.y, w:w.w, h:w.h };
            const cy = b.y + b.h/2;
            const line = boxes.find(bb => Math.abs((bb.y+bb.h/2) - cy) < Math.max(4, b.h*0.6));
            if(!line){ boxes.push(b); }
            else {
              const nx = Math.min(line.x, b.x);
              const ny = Math.min(line.y, b.y);
              line.w = Math.max(line.x+line.w, b.x+b.w) - nx;
              line.h = Math.max(line.y+line.h, b.y+b.h) - ny;
              line.x = nx; line.y = ny;
            }
          }
        }
        const bbox = boxes.length ? boxes[0] : null;
        results.push({
          id: uid(), docId: doc.id, docName: doc.name, docType: doc.type,
          pageNo: pg.pageNo, match: m[0],
          before: text.slice(ctxStart, idx),
          after: text.slice(idx+len, ctxEnd),
          idx, len, bbox, boxes,
          confidence: doc.confidence!=null ? doc.confidence : (pg.source==='textlayer'?99:null),
          source: pg.source,
        });
      }
    }
  }
  results.sort((a,b)=> (b.confidence||0)-(a.confidence||0));
  return results;
}

function highlightSnippet(text, query, mode){
  const esc = escapeHTML(text);
  if(!query) return esc;
  let re;
  try{
    if(mode==='regex') re = new RegExp(query,'gi');
    else if(mode==='phrase') re = new RegExp(escapeReg(query),'gi');
    else {
      const toks=[...new Set(tokenize(query))].filter(Boolean);
      re = new RegExp(toks.map(escapeReg).join('|'),'gi');
    }
  }catch(e){ return esc; }
  return esc.replace(re, m=> `<mark>${m}</mark>`);
}

function renderSearch(){
  const list = $('#resultsList'), q = state.currentQuery;
  $('#navHitCount').textContent = state.currentResults.length;
  if(!q){
    $('#searchSummaryText').innerHTML = '输入关键词开始检索。支持精确短语、分词模糊、正则三种模式。';
    list.innerHTML = `<div class="empty-state">
      <svg class="empty-illo" viewBox="0 0 120 96" fill="none">
        <circle cx="52" cy="44" r="26" fill="var(--illus-bg)" stroke="var(--illus-stroke)" stroke-width="1.5"/>
        <path d="M70 62l20 20" stroke="var(--primary)" stroke-width="4" stroke-linecap="round"/>
        <path d="M40 44h24M40 36h24M40 52h16" stroke="var(--illus-line)" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <div class="empty-title">开始你的第一次检索</div>
      <div class="empty-desc">在顶部搜索框输入关键词或整句，系统会在本地索引中查找，并展示命中位置、上下文与 OCR 置信度。</div>
    </div>`;
    return;
  }
  const rs = state.currentResults;
  const modeLabel = {phrase:'精确短语',fuzzy:'分词模糊',regex:'正则'}[state.searchMode];
  $('#searchSummaryText').innerHTML = rs.length>0
    ? `在 <strong>${new Set(rs.map(r=>r.docId)).size}</strong> 份文档中找到 <strong>${rs.length}</strong> 处命中 · 查询 <span class="q">${escapeHTML(q)}</span> · 模式：${modeLabel}`
    : `未找到 <span class="q">${escapeHTML(q)}</span> 的命中。可尝试切换为「分词模糊」或缩短查询。`;

  if(!rs.length){
    list.innerHTML = `<div class="empty-state">
      <svg class="empty-illo" viewBox="0 0 120 96" fill="none">
        <circle cx="52" cy="44" r="26" fill="var(--danger-soft)" stroke="var(--border-danger)" stroke-width="1.5"/>
        <path d="M42 34l20 20M62 34L42 54" stroke="var(--danger)" stroke-width="3" stroke-linecap="round"/>
        <path d="M70 62l20 20" stroke="var(--illus-muted)" stroke-width="4" stroke-linecap="round"/>
      </svg>
      <div class="empty-title">没有找到匹配内容</div>
      <div class="empty-desc">建议：① 切换为「分词模糊」模式；② 缩短查询词；③ 检查文档是否已完成索引（在 OCR 队列中查看）。</div>
    </div>`;
    return;
  }

  const RENDER_CAP = 1000;
  const shown = rs.slice(0, RENDER_CAP);
  const truncNote = rs.length > RENDER_CAP
    ? `<div style="padding:8px 12px;margin-bottom:10px;border-radius:6px;background:var(--warning-soft);border:1px solid var(--border-warning);color:var(--fg-warning-strong);font-size:11.5px">命中较多，已显示前 ${RENDER_CAP} 条（共 ${rs.length} 条）。可缩小文档范围或用更精确的短语以精准定位。</div>`
    : '';
  list.innerHTML = truncNote + shown.map((r,i)=>`
    <div class="result-card ${i===state.currentHitIdx?'active':''}" data-i="${i}">
      <div class="result-head">
        <div class="result-doc">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2h6l3 3v9H4z"/><path d="M10 2v3h3"/></svg>
          <span class="result-doc-name" title="${escapeHTML(r.docName)}">${escapeHTML(r.docName)}</span>
        </div>
        <span class="result-page">第 ${r.pageNo} 页</span>
        <span class="result-tag">${docTypeLabel(r.docType)}</span>
        <span class="result-tag">${r.source==='ocr'?'OCR':'文本层'}</span>
        <div class="result-score">
          ${r.confidence!=null?`<span>置信度</span>
            <div class="confidence-bar"><div class="confidence-fill" style="width:${Math.min(100,r.confidence)}%;background:${r.confidence>=85?'var(--success)':r.confidence>=60?'var(--warning)':'var(--danger)'}"></div></div>
            <strong style="color:var(--fg);font-variant-numeric:tabular-nums">${Math.round(r.confidence)}%</strong>`:'<span>无置信度</span>'}
        </div>
      </div>
      <div class="result-snippet">${highlightSnippet(r.before + r.match + r.after, q, state.searchMode)}</div>
      <div class="result-context">位置：字符 ${r.idx}–${r.idx+r.len} · 命中 ${r.len} 字${r.bbox?'':' · 无精确坐标（将按页面定位）'}</div>
      <div class="result-actions">
        <button class="btn btn-sm primary" data-act="jump">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8h10M9 4l4 4-4 4"/></svg>跳转并高亮
        </button>
        <button class="btn btn-sm" data-act="verify">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 8.5l3 3 8-8"/></svg>加入核验
        </button>
        <button class="btn btn-sm ghost" data-act="copy">复制片段</button>
      </div>
    </div>`).join('');

  $$('.result-card',list).forEach(card=>{
    const i = +card.dataset.i, r = rs[i];
    card.addEventListener('click', e=>{
      const btn = e.target.closest('[data-act]');
      const act = btn ? btn.dataset.act : 'jump';
      if(act==='verify'){ addToVerify(r); return; }
      if(act==='copy'){
        navigator.clipboard.writeText(r.before+r.match+r.after).then(()=> toast('已复制片段','success'));
        return;
      }
      state.currentHitIdx = i;
      jumpToHit(r);
    });
  });
}

$('#globalSearch').addEventListener('input', debounce(e=>{
  state.currentQuery = e.target.value.trim();
  if(state.currentQuery){
    state.currentResults = searchDocs(state.currentQuery, state.searchMode, state.searchScope);
    state.currentHitIdx = 0;
    if(state.currentView!=='search') switchView('search'); else renderSearch();
  } else { state.currentResults=[]; renderSearch(); }
},260));
$('#globalSearch').addEventListener('keydown', e=>{
  if(e.key==='Enter'){
    state.currentQuery = e.target.value.trim();
    state.currentResults = searchDocs(state.currentQuery, state.searchMode, state.searchScope);
    state.currentHitIdx = 0;
    switchView('search');
  }
});
document.addEventListener('keydown', e=>{
  if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); $('#globalSearch').focus(); $('#globalSearch').select(); }
});
$('#searchModeBtn').addEventListener('click', ()=>{
  const modes=['phrase','fuzzy','regex'], labels={phrase:'精确短语',fuzzy:'分词模糊',regex:'正则'};
  state.searchMode = modes[(modes.indexOf(state.searchMode)+1)%modes.length];
  $('#searchModeLabel').textContent = labels[state.searchMode];
  if(state.currentQuery){ state.currentResults = searchDocs(state.currentQuery,state.searchMode,state.searchScope); renderSearch(); }
});
$$('#searchFilters .chip').forEach(c=> c.addEventListener('click', ()=>{
  $$('#searchFilters .chip').forEach(x=>x.classList.remove('active'));
  c.classList.add('active');
  state.searchScope = c.dataset.scope;
  if(state.currentQuery){ state.currentResults = searchDocs(state.currentQuery,state.searchMode,state.searchScope); renderSearch(); }
}));
$('#btnClearSearch').addEventListener('click', ()=>{ $('#globalSearch').value=''; state.currentQuery=''; state.currentResults=[]; renderSearch(); });

// ---- Viewer ----
async function openDoc(docId, hit=null){
  const doc = state.docs.find(d=>d.id===docId);
  if(!doc) return;
  if(doc.status!=='indexed'){ toast('该文档尚未完成解析','warn'); return; }
  state.currentDoc = doc;
  $('#viewerDocName').textContent = doc.name;
  switchView('viewer');
  await renderPDF(doc, hit);
  renderRightPanel(doc, hit);
}
async function jumpToHit(r){
  const doc = state.docs.find(d=>d.id===r.docId);
  if(!doc) return;
  state.currentDoc = doc;
  $('#viewerDocName').textContent = doc.name;
  switchView('viewer');
  await renderPDF(doc, r);
  renderRightPanel(doc, r);
}

async function renderPDF(doc, hit){
  const scroll = $('#viewerScroll');
  scroll.innerHTML = '<div style="padding:40px;color:var(--muted);text-align:center"><div class="spinner" style="margin:0 auto 12px"></div><div style="font-size:12px">正在加载 PDF…</div></div>';
  try{
    const pdf = await pdfjsLib.getDocument({data: doc.blob.slice(0)}).promise;
    state.pdfDoc = pdf;
    $('#pageTotal').textContent = pdf.numPages;
    scroll.innerHTML = '';
    state.renderedPages.clear();

    const docHits = state.currentResults.filter(r=>r.docId===doc.id);
    const hitByPage = {};
    docHits.forEach(r=>{ (hitByPage[r.pageNo]=hitByPage[r.pageNo]||[]).push(r); });

    for(let pn=1; pn<=pdf.numPages; pn++){
      const page = await pdf.getPage(pn);
      const vp = page.getViewport({scale: state.pdfScale});
      const wrap = document.createElement('div');
      wrap.className='pdf-page-wrap';
      wrap.style.width = vp.width+'px'; wrap.style.height = vp.height+'px';
      wrap.dataset.page = pn;
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      wrap.appendChild(canvas);
      await page.render({canvasContext:canvas.getContext('2d'), viewport:vp}).promise;

      const overlay = document.createElement('div');
      overlay.className='hit-overlay';
      const pageHits = hitByPage[pn]||[];
      pageHits.forEach((r,i)=>{
        const rBoxes = (r.boxes && r.boxes.length) ? r.boxes : (r.bbox ? [r.bbox] : []);
        if(!rBoxes.length) return;
        const s = state.pdfScale;
        rBoxes.forEach((bb, bi)=>{
          const box = document.createElement('div');
          box.className='hit-box';
          box.style.left = (bb.x*s)+'px';
          box.style.top = (bb.y*s)+'px';
          box.style.width = Math.max(4, bb.w*s)+'px';
          box.style.height = Math.max(4, bb.h*s)+'px';
          box.dataset.rid = r.id;
          if(bi===0) box.dataset.primary = '1';
          box.title = `命中 ${i+1}/${pageHits.length}：${r.match}`;
          if(hit && hit.id===r.id) box.classList.add('current');
          box.addEventListener('click', ()=>{
            const idx = state.currentResults.findIndex(x=>x.id===r.id);
            if(idx>=0) state.currentHitIdx = idx;
            $$('.hit-box',scroll).forEach(b=>b.classList.remove('current'));
            $$('.hit-box[data-rid="'+r.id+'"]',scroll).forEach(b=>b.classList.add('current'));
            updateHitNav();
            renderRightPanel(doc, r);
          });
          overlay.appendChild(box);
        });
      });
      wrap.appendChild(overlay);
      const label = document.createElement('div');
      label.className='page-label';
      label.textContent = `第 ${pn} 页 / 共 ${pdf.numPages} 页`;
      wrap.appendChild(label);
      scroll.appendChild(wrap);
      state.renderedPages.set(pn, {wrap, vp});
    }
    updateHitNav();
    if(hit){
      $('#pageInput').value = hit.pageNo;
      setTimeout(()=>{
        const box = scroll.querySelector(`.hit-box[data-rid="${hit.id}"]`);
        if(box) box.closest('.pdf-page-wrap').scrollIntoView({behavior:'smooth',block:'center'});
        else {
          const w = state.renderedPages.get(hit.pageNo);
          if(w) w.wrap.scrollIntoView({behavior:'smooth',block:'start'});
        }
      },100);
    } else {
      $('#pageInput').value = 1;
    }
    $('#zoomLabel').textContent = Math.round(state.pdfScale/1.2*100)+'%';
  } catch(err){
    console.error(err);
    scroll.innerHTML = `<div class="empty-state"><div class="empty-title">PDF 渲染失败</div><div class="empty-desc">${escapeHTML(err.message||'未知错误')}</div></div>`;
  }
}

function updateHitNav(){
  const docHits = state.currentResults.filter(r=> state.currentDoc && r.docId===state.currentDoc.id);
  if(!docHits.length){ $('#hitNavText').textContent='无命中'; return; }
  const cur = docHits[state.currentHitIdx] || docHits[0];
  const i = docHits.findIndex(r=>r.id===cur.id);
  $('#hitNavText').textContent = `第 ${i+1} / ${docHits.length} 处命中 · 第 ${cur.pageNo} 页`;
}

$('#btnViewerBack').addEventListener('click', ()=> switchView(state.currentQuery?'search':'library'));
$('#btnPrevPage').addEventListener('click', ()=>{ const v=Math.max(1,+$('#pageInput').value-1); gotoPage(v); });
$('#btnNextPage').addEventListener('click', ()=>{ const v=Math.min(+(state.pdfDoc?state.pdfDoc.numPages:1),+$('#pageInput').value+1); gotoPage(v); });
$('#pageInput').addEventListener('change', ()=> gotoPage(+$('#pageInput').value));
function gotoPage(p){
  const w = state.renderedPages.get(p);
  if(w){ w.wrap.scrollIntoView({behavior:'smooth',block:'start'}); $('#pageInput').value=p; }
}
$('#btnZoomIn').addEventListener('click', ()=>{ state.pdfScale=Math.min(3, state.pdfScale+0.2); if(state.currentDoc) renderPDF(state.currentDoc, state.currentResults[state.currentHitIdx]); });
$('#btnZoomOut').addEventListener('click', ()=>{ state.pdfScale=Math.max(0.5, state.pdfScale-0.2); if(state.currentDoc) renderPDF(state.currentDoc, state.currentResults[state.currentHitIdx]); });
$('#btnZoomFit').addEventListener('click', ()=>{ state.pdfScale=1.2; if(state.currentDoc) renderPDF(state.currentDoc, state.currentResults[state.currentHitIdx]); });
$('#btnPrevHit').addEventListener('click', ()=>{
  const docHits = state.currentResults.filter(r=> state.currentDoc && r.docId===state.currentDoc.id);
  if(!docHits.length) return;
  state.currentHitIdx = (state.currentHitIdx-1+docHits.length)%docHits.length;
  jumpToHit(docHits[state.currentHitIdx]);
});
$('#btnNextHit').addEventListener('click', ()=>{
  const docHits = state.currentResults.filter(r=> state.currentDoc && r.docId===state.currentDoc.id);
  if(!docHits.length) return;
  state.currentHitIdx = (state.currentHitIdx+1)%docHits.length;
  jumpToHit(docHits[state.currentHitIdx]);
});
$('#btnAddToVerify').addEventListener('click', ()=>{
  const r = state.currentResults[state.currentHitIdx];
  if(!r){ toast('请先在搜索结果中选择一处命中','warn'); return; }
  addToVerify(r);
});

// ---- Verify ----
function addToVerify(r){
  state.verifyOriginal = r.before + r.match + r.after;
  state.verifyOriginalMeta = { docId:r.docId, docName:r.docName, pageNo:r.pageNo, match:r.match, rid:r.id };
  state.verifyQuote = r.match;
  switchView('verify');
  renderVerify();
  toast('已加入核验，右侧可编辑引用文本','success');
}

function diffChars(a, b){
  // LCS-based char diff. a=original, b=quote
  const n=a.length, m=b.length;
  if(n*m > 400000){
    // fallback for very long strings
    return { ops:[{t:'=',v:a}], match:n, ins:0, del:0, sim: a===b?1:0 };
  }
  const dp = Array.from({length:n+1},()=> new Uint16Array(m+1));
  for(let i=n-1;i>=0;i--) for(let j=m-1;j>=0;j--){
    dp[i][j] = a[i]===b[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
  }
  const ops=[]; let i=0,j=0,match=0,ins=0,del=0;
  while(i<n && j<m){
    if(a[i]===b[j]){ ops.push({t:'=',v:a[i]}); i++;j++;match++; }
    else if(dp[i+1][j] >= dp[i][j+1]){ ops.push({t:'-',v:a[i]}); i++; del++; }
    else { ops.push({t:'+',v:b[j]}); j++; ins++; }
  }
  while(i<n){ ops.push({t:'-',v:a[i]}); i++; del++; }
  while(j<m){ ops.push({t:'+',v:b[j]}); j++; ins++; }
  // merge consecutive same-type ops
  const merged=[];
  for(const op of ops){
    const last = merged[merged.length-1];
    if(last && last.t===op.t) last.v += op.v;
    else merged.push({t:op.t, v:op.v});
  }
  const sim = (n+m) ? (2*match)/(n+m) : 1;
  return { ops: merged, match, ins, del, sim };
}

function renderVerify(){
  $('#navVerifyCount').textContent = state.citations.length;
  $('#citationsCount').textContent = state.citations.length+' 条';
  // Original panel
  const origEl = $('#verifyOriginal');
  if(state.verifyOriginal){
    const meta = state.verifyOriginalMeta;
    $('#originalMeta').textContent = meta ? `${meta.docName} · 第 ${meta.pageNo} 页` : '原文';
    const m = state.verifyOriginalMeta?.match || '';
    if(m && state.verifyOriginal.includes(m)){
      const idx = state.verifyOriginal.indexOf(m);
      origEl.innerHTML = escapeHTML(state.verifyOriginal.slice(0,idx)) +
        '<mark>' + escapeHTML(m) + '</mark>' +
        escapeHTML(state.verifyOriginal.slice(idx+m.length));
    } else {
      origEl.textContent = state.verifyOriginal;
    }
  } else {
    $('#originalMeta').textContent = '未选择';
    origEl.textContent = '在搜索结果中点击「加入核验」，或先在文档库选择一份文档、在查看器中选一段命中，系统会自动带上命中前后各 60 字作为上下文。';
  }
  $('#verifyQuote').value = state.verifyQuote || '';

  // Citations list
  const list = $('#citationsList');
  if(!state.citations.length){
    list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted);font-size:12px">还没有核验记录。在搜索结果中点击「加入核验」开始第一次比对。</div>';
  } else {
    list.innerHTML = state.citations.slice().reverse().map(c=>`
      <div class="citation-row" data-id="${c.id}">
        <span class="citation-verdict" data-v="${c.verdict}"></span>
        <div class="citation-main">
          <div class="citation-quote">“${escapeHTML(c.quote.length>90?c.quote.slice(0,90)+'…':c.quote)}”</div>
          <div class="citation-meta">
            <span>${escapeHTML(c.docName||'')}</span>·<span>第 ${c.pageNo} 页</span>·<span>相似度 ${Math.round(c.sim*100)}%</span>·<span>${fmtDate(c.createdAt)}</span>
          </div>
        </div>
        <button class="btn btn-sm ghost" data-act="del">删除</button>
      </div>`).join('');
    $$('.citation-row',list).forEach(row=>{
      row.addEventListener('click', e=>{
        const id = row.dataset.id;
        if(e.target.closest('[data-act="del"]')){
          idbDel('citations', id);
          state.citations = state.citations.filter(c=>c.id!==id);
          renderVerify(); updateStatusBar(); toast('已删除记录','info'); return;
        }
        const c = state.citations.find(x=>x.id===id);
        if(c){ state.verifyOriginal = c.original; state.verifyQuote = c.quote; state.verifyOriginalMeta = {docId:c.docId,docName:c.docName,pageNo:c.pageNo,match:''}; renderVerify(); runVerify(false); }
      });
    });
  }
}

function runVerify(save=true){
  const orig = state.verifyOriginal || '';
  const quote = $('#verifyQuote').value || '';
  state.verifyQuote = quote;
  if(!orig.trim() || !quote.trim()){
    $('#verifyVerdict').dataset.verdict = 'idle';
    $('#verifyVerdictText').textContent = '等待核验';
    $('#statMatch').textContent='—'; $('#statDel').textContent='—'; $('#statIns').textContent='—'; $('#statSim').textContent='—';
    return;
  }
  const d = diffChars(orig, quote);
  // Render original with del highlights
  let origHTML='', quoteHTML='';
  for(const op of d.ops){
    const v = escapeHTML(op.v);
    if(op.t==='='){ origHTML += `<mark>${v}</mark>`; quoteHTML += `<mark>${v}</mark>`; }
    else if(op.t==='-'){ origHTML += `<span class="diff-del">${v}</span>`; }
    else { quoteHTML += `<span class="diff-ins">${v}</span>`; }
  }
  $('#verifyOriginal').innerHTML = origHTML;
  // Replace textarea with rendered preview overlay? Keep textarea but show quote diff below.
  // We render quote diff into a sibling overlay: simpler—put it into original panel's counterpart via a temporary div
  const qPanel = $('#verifyQuote').parentElement;
  let qPreview = qPanel.querySelector('.verify-content');
  if(!qPreview){
    qPreview = document.createElement('div');
    qPreview.className = 'verify-content';
    qPreview.style.borderTop = '1px dashed var(--border)';
    qPreview.style.minHeight = '80px';
    qPanel.appendChild(qPreview);
  }
  qPreview.innerHTML = '<div style="font-size:10.5px;color:var(--muted);margin-bottom:6px;letter-spacing:.04em;text-transform:uppercase;font-weight:600">逐字对照预览</div>' + quoteHTML;

  const sim = d.sim;
  const verdict = sim>=0.98 ? 'match' : sim>=0.6 ? 'partial' : 'mismatch';
  const verdictText = {match:'引用与原文一致',partial:'部分一致，存在差异',mismatch:'与原文不一致'}[verdict];
  $('#verifyVerdict').dataset.verdict = verdict;
  $('#verifyVerdictText').textContent = verdictText;
  $('#statMatch').textContent = d.match;
  $('#statDel').textContent = d.del;
  $('#statIns').textContent = d.ins;
  $('#statSim').textContent = Math.round(sim*100)+'%';

  if(save){
    const meta = state.verifyOriginalMeta || {};
    const rec = {
      id: uid(), docId: meta.docId||'', docName: meta.docName||'', pageNo: meta.pageNo||0,
      original: orig, quote, verdict, sim, match:d.match, ins:d.ins, del:d.del,
      createdAt: Date.now(),
    };
    idbPut('citations', rec);
    state.citations.push(rec);
    renderVerify(); updateStatusBar();
    toast(`核验完成：${verdictText}`,'success');
  }
}

$('#btnVerifyRun').addEventListener('click', ()=> runVerify(true));
$('#btnVerifyClear').addEventListener('click', ()=>{
  state.verifyOriginal=''; state.verifyQuote=''; state.verifyOriginalMeta=null;
  const qPanel = $('#verifyQuote').parentElement;
  const prev = qPanel.querySelector('.verify-content'); if(prev) prev.remove();
  $('#verifyVerdict').dataset.verdict='idle'; $('#verifyVerdictText').textContent='等待核验';
  $('#statMatch').textContent='—'; $('#statDel').textContent='—'; $('#statIns').textContent='—'; $('#statSim').textContent='—';
  renderVerify();
});
$('#btnVerifySwap').addEventListener('click', ()=>{
  const a = state.verifyOriginal, b = $('#verifyQuote').value;
  state.verifyOriginal = b; $('#verifyQuote').value = a; state.verifyQuote = a;
  runVerify(false);
});
$('#verifyQuote').addEventListener('input', debounce(()=> runVerify(false), 320));
$('#btnExportCitations').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(state.citations,null,2)],{type:'application/json'});
  downloadBlob(blob, `citations-${Date.now()}.json`);
});

// ---- Right panel ----
function renderRightPanel(doc, hit){
  const sel = $('#rightSelection');
  if(!doc){ sel.innerHTML = '<div style="padding:14px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--muted);line-height:1.6;text-align:center">在文档库或搜索结果中选择一项，这里会显示元数据、命中详情与相关命中。</div>'; return; }
  $('#rightTitle').textContent = doc.name.length>24 ? doc.name.slice(0,24)+'…' : doc.name;
  const relatedHits = hit ? state.currentResults.filter(r=> r.docId===doc.id && r.id!==hit.id).slice(0,6) : [];
  sel.innerHTML = `
    <div class="kv-list" style="margin-bottom:14px">
      <div class="kv"><span class="kv-key">类型</span><span class="kv-val">${docTypeLabel(doc.type)}</span></div>
      <div class="kv"><span class="kv-key">页数</span><span class="kv-val">${doc.pages||0}</span></div>
      <div class="kv"><span class="kv-key">大小</span><span class="kv-val">${fmtBytes(doc.size)}</span></div>
      <div class="kv"><span class="kv-key">字数</span><span class="kv-val">${(doc.charCount||0).toLocaleString('zh-CN')}</span></div>
      <div class="kv"><span class="kv-key">状态</span><span class="kv-val">${docStatusLabel(doc.status)}</span></div>
      ${doc.confidence?`<div class="kv"><span class="kv-key">OCR置信度</span><span class="kv-val">${Math.round(doc.confidence)}%</span></div>`:''}
      <div class="kv"><span class="kv-key">上传于</span><span class="kv-val">${fmtDate(doc.addedAt)}</span></div>
      <div class="kv"><span class="kv-key">ID</span><span class="kv-val mono">${doc.id}</span></div>
    </div>
    ${hit?`
      <div class="right-section-title" style="margin-top:16px">当前命中</div>
      <div style="padding:10px 12px;background:var(--warning-soft);border:1px solid #FDE68A;border-radius:6px;font-size:12px;color:#78350F;line-height:1.6;margin-bottom:10px">
        <strong>第 ${hit.pageNo} 页</strong> · 字符 ${hit.idx}–${hit.idx+hit.len}<br/>
        <span style="font-family:var(--font-mono);font-size:11.5px">${escapeHTML(hit.match)}</span>
      </div>
    `:''}
    ${relatedHits.length?`
      <div class="right-section-title" style="margin-top:14px">同文档相关命中</div>
      ${relatedHits.map(r=>`
        <div class="related-hit" data-rid="${r.id}">
          ${escapeHTML((r.before.slice(-30)||''))}<mark>${escapeHTML(r.match)}</mark>${escapeHTML(r.after.slice(0,30)||'')}
          <div class="related-hit-meta">第 ${r.pageNo} 页 · ${r.source==='ocr'?'OCR':'文本层'}</div>
        </div>`).join('')}
    `:''}
    <div style="display:flex;gap:6px;margin-top:14px">
      <button class="btn btn-sm" id="rpOpen" style="flex:1">打开文档</button>
      <button class="btn btn-sm danger" id="rpDelete">删除</button>
    </div>
  `;
  $$('.related-hit',sel).forEach(el=> el.addEventListener('click', ()=>{
    const r = state.currentResults.find(x=>x.id===el.dataset.rid);
    if(r){ state.currentHitIdx = state.currentResults.indexOf(r); jumpToHit(r); }
  }));
  const rpOpen = $('#rpOpen',sel); if(rpOpen) rpOpen.addEventListener('click', ()=> openDoc(doc.id));
  const rpDel = $('#rpDelete',sel); if(rpDel) rpDel.addEventListener('click', ()=>{
    openModal({
      title:'将此文档移到回收站？',
      body:`「${doc.name}」及其页面文本、OCR 结果与索引会被移到回收站，可随时恢复。`,
      onConfirm: async ()=>{
        await moveToTrash([doc.id]);
        state.selected.delete(doc.id);
        renderLibrary(); renderSearch(); renderOCR(); renderTrash(); renderStorage(); updateStatusBar();
        switchView('library');
        toast('已移到回收站','info');
      }
    });
  });
}

$('#btnToggleRight').addEventListener('click', ()=>{
  const cur = $('#app').dataset.rightCollapsed==='true';
  $('#app').dataset.rightCollapsed = cur?'false':'true';
});
$('#btnCloseRight').addEventListener('click', ()=>{ $('#app').dataset.rightCollapsed='true'; });
$('#qaSample').addEventListener('click', ()=> loadSample());
$('#qaStorage').addEventListener('click', ()=> switchView('storage'));

// ---- OCR view ----
function renderOCR(){
  const jobs = state.docs.filter(d=> d.status==='ocr' || d.status==='processing' || d.status==='indexed' || d.status==='failed');
  const active = state.docs.filter(d=> d.status==='ocr'||d.status==='processing');
  const done = state.docs.filter(d=> d.status==='indexed');
  const failed = state.docs.filter(d=> d.status==='failed');
  const confs = done.map(d=>d.confidence).filter(Boolean);
  const avgConf = confs.length ? confs.reduce((a,b)=>a+b,0)/confs.length : null;

  $('#ocrStatActive').textContent = active.length;
  $('#ocrStatDone').textContent = done.length;
  $('#ocrStatFailed').textContent = failed.length;
  $('#ocrStatConf').textContent = avgConf!=null ? Math.round(avgConf)+'%' : '—';
  $('#navOcrCount').textContent = active.length;
  $('#ocrListCount').textContent = jobs.length+' 个任务';

  const wrap = $('#ocrJobs');
  if(!jobs.length){ wrap.innerHTML=''; $('#ocrEmpty').classList.remove('hidden'); return; }
  $('#ocrEmpty').classList.add('hidden');
  wrap.innerHTML = jobs.map(d=>`
    <div class="ocr-job" data-status="${d.status}">
      <div class="ocr-job-icon">
        ${d.status==='indexed'?'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2.5 8.5l3 3 8-8"/></svg>':
          d.status==='failed'?'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>':
          '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7h6M5 10h4"/></svg>'}
      </div>
      <div class="ocr-job-main">
        <div class="ocr-job-head">
          <span class="ocr-job-name" title="${escapeHTML(d.name)}">${escapeHTML(d.name)}</span>
          <span class="ocr-job-status">${docStatusLabel(d.status)}</span>
          <span class="result-tag" style="margin-left:auto">${docTypeLabel(d.type)}</span>
        </div>
        <div class="ocr-progress"><div class="ocr-progress-fill" style="width:${d.progress||0}%"></div></div>
        <div class="ocr-job-meta">
          <span>${d.pages||0} 页</span>·
          <span>${Math.round(d.progress||0)}%</span>·
          <span>${d.source==='ocr'?'OCR':'文本层'}</span>
          ${d.confidence?`· <span>置信度 ${Math.round(d.confidence)}%</span>`:''}
          ${d.error?`· <span style="color:var(--danger)">${escapeHTML(d.error)}</span>`:''}
        </div>
      </div>
      ${d.status==='failed'?`<button class="btn btn-sm" data-retry="${d.id}">重试</button>`:''}
      ${d.status==='indexed'?`<button class="btn btn-sm primary" data-open="${d.id}">打开</button>`:''}
    </div>`).join('');
  $$('[data-retry]',wrap).forEach(b=> b.addEventListener('click', ()=>{
    const d = state.docs.find(x=>x.id===b.dataset.retry);
    if(d){ d.status='processing'; d.progress=0; d.error=null; idbPut('docs',d); processDoc(d); }
  }));
  $$('[data-open]',wrap).forEach(b=> b.addEventListener('click', ()=> openDoc(b.dataset.open)));
}
$('#btnRetryFailed').addEventListener('click', ()=>{
  const failed = state.docs.filter(d=>d.status==='failed');
  if(!failed.length){ toast('没有失败任务','info'); return; }
  failed.forEach(d=>{ d.status='processing'; d.progress=0; d.error=null; idbPut('docs',d); processDoc(d); });
  toast(`已重试 ${failed.length} 个任务`,'info');
});

// ---- Storage view ----
function computeStorage(){
  const filesBytes = state.docs.reduce((a,d)=> a+(d.size||0), 0);
  const ocrChars = state.pages.filter(p=>p.source==='ocr').reduce((a,p)=> a+(p.text?p.text.length:0), 0);
  const idxChars = state.pages.reduce((a,p)=> a+(p.words?p.words.length:0), 0);
  const citeBytes = JSON.stringify(state.citations).length;
  const ocrBytes = ocrChars*2; // utf-16 approx
  const idxBytes = idxChars*24;
  // 回收站仍占用本地空间（文档原文件 + 页面文本/索引）
  const trashFiles = state.trash.reduce((a,t)=> a+(t.doc&&t.doc.size||0), 0);
  const trashPages = state.trash.reduce((a,t)=> a+(t.pages?t.pages.length:0), 0);
  const trashIdx = state.trash.reduce((a,t)=> a+(t.pages?t.pages.reduce((x,p)=>x+(p.words?p.words.length:0),0):0), 0);
  const trashBytes = trashFiles + trashIdx*24;
  return { filesBytes, ocrBytes, idxBytes, citeBytes, trashBytes, trashCount: state.trash.length, trashPages,
    total: filesBytes+ocrBytes+idxBytes+citeBytes+trashBytes };
}
function renderStorage(){
  const s = computeStorage();
  const total = Math.max(1, s.total);
  $('#heroStorage').textContent = fmtBytes(s.total);
  const segs = [
    {id:'segFiles', lg:'lgFiles', k:'files', v:s.filesBytes, label:'PDF 原文件'},
    {id:'segOcr', lg:'lgOcr', k:'ocr', v:s.ocrBytes, label:'OCR 文本'},
    {id:'segIndex', lg:'lgIndex', k:'index', v:s.idxBytes, label:'索引'},
    {id:'segCite', lg:'lgCite', k:'cite', v:s.citeBytes, label:'核验记录'},
  ];
  segs.forEach(sg=>{
    const el = $('#'+sg.id), lg = $('#'+sg.lg);
    const pct = (sg.v/total*100);
    el.style.width = pct+'%';
    el.dataset.value = String(sg.v);
    el.title = `${sg.label} ${fmtBytes(sg.v)} · ${pct.toFixed(1)}%`;
    lg.textContent = fmtBytes(sg.v);
    lg.dataset.value = String(sg.v);
  });
  $('#stDocs').textContent = state.docs.length;
  $('#stPages').textContent = state.pages.length;
  $('#stTokens').textContent = state.pages.reduce((a,p)=>a+(p.words?p.words.length:0),0).toLocaleString('zh-CN');
  $('#stCites').textContent = state.citations.length;
  const stTrash = $('#stTrash');
  if(stTrash) stTrash.textContent = state.trash.length ? `${state.trash.length} 份 · ${fmtBytes(s.trashBytes)}` : '空';
}
function updateStatusBar(){
  const s = computeStorage();
  $('#statusStorage').textContent = fmtBytes(s.total);
  $('#topStorageText').textContent = fmtBytes(s.total);
  // Assume 2GB soft quota for bar visualization
  const quota = 2*1024*1024*1024;
  $('#topStorageFill').style.width = Math.min(100, s.total/quota*100)+'%';
  $('#statusDocs').textContent = state.docs.length;
  $('#statusPages').textContent = state.pages.length;
  $('#statusTokens').textContent = state.pages.reduce((a,p)=>a+(p.words?p.words.length:0),0).toLocaleString('zh-CN');
  $('#navDocCount').textContent = state.docs.length;
  $('#navVerifyCount').textContent = state.citations.length;
}

$('#btnExportAll').addEventListener('click', ()=>{
  const payload = {
    version:1, exportedAt: new Date().toISOString(),
    docs: state.docs.map(({blob,thumb,...rest})=> rest),
    pages: state.pages, citations: state.citations,
  };
  const blob = new Blob([JSON.stringify(payload)],{type:'application/json'});
  downloadBlob(blob, `pdf-verify-export-${Date.now()}.json`);
  toast('已导出索引（不含 PDF 原文件）','success');
});
$('#btnImportIndex').addEventListener('click', ()=> $('#importInput').click());
$('#importInput').addEventListener('change', async e=>{
  const f = e.target.files[0]; if(!f) return;
  try{
    const text = await f.text();
    const data = JSON.parse(text);
    if(data.pages) for(const p of data.pages){ await idbPut('pages',p); if(!state.pages.find(x=>x.id===p.id)) state.pages.push(p); }
    if(data.citations) for(const c of data.citations){ await idbPut('citations',c); if(!state.citations.find(x=>x.id===c.id)) state.citations.push(c); }
    toast('索引导入成功','success');
    renderStorage(); renderVerify(); updateStatusBar();
  }catch(err){ toast('导入失败：'+err.message,'error'); }
  e.target.value='';
});
$('#btnClearAll').addEventListener('click', ()=> openModal());
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href=url; a.download=filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); },200);
}

// ---- Modal ----
let modalAction = null;
const MODAL_DEFAULT_TITLE = '确认清空全部本地数据？';
const MODAL_DEFAULT_BODY = '此操作会删除 IndexedDB 中所有 PDF 文件、OCR 文本、检索索引与核验记录，且不可撤销。建议先导出 JSON 备份。';
function openModal(opts){
  const o = (typeof opts === 'function') ? { onConfirm: opts } : (opts || {});
  $('#modalTitle').textContent = o.title || MODAL_DEFAULT_TITLE;
  $('#modalBody').textContent = o.body || MODAL_DEFAULT_BODY;
  modalAction = o.onConfirm || (async ()=>{
    await idbClear('docs'); await idbClear('pages'); await idbClear('citations'); await idbClear('trash');
    state.docs=[]; state.pages=[]; state.citations=[]; state.trash=[]; state.currentDoc=null;
    state.selected.clear();
    state.currentResults=[]; state.currentQuery=''; $('#globalSearch').value='';
    renderLibrary(); renderSearch(); renderOCR(); renderTrash(); renderStorage(); renderVerify(); updateStatusBar();
    switchView('library');
    toast('已清空全部本地数据','success');
  });
  $('#modalBackdrop').classList.add('open');
}
$('#modalCancel').addEventListener('click', ()=> $('#modalBackdrop').classList.remove('open'));
$('#modalBackdrop').addEventListener('click', e=>{ if(e.target.id==='modalBackdrop') $('#modalBackdrop').classList.remove('open'); });
$('#modalConfirm').addEventListener('click', async ()=>{
  $('#modalBackdrop').classList.remove('open');
  if(modalAction) await modalAction();
});

// ---- Sample PDF (via jsPDF) ----
async function loadSample(){
  if(!window.jspdf){ toast('示例生成需要 jsPDF（CDN 未加载）','warn'); return; }
  toast('正在生成示例 PDF…','info');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({unit:'pt', format:'a4'});
  const W = doc.internal.pageSize.getWidth();
  const lines1 = [
    'Sample Contract for Local Verification',
    '',
    'Article 1  Purpose and Scope',
    'This Agreement is entered into on the 15th day of September, 2026,',
    'by and between Party A (the "Client") and Party B (the "Provider"),',
    'collectively referred to as the "Parties".',
    '',
    'Article 2  Payment Terms',
    'The Client shall pay the Provider the total fee of USD 120,000',
    'within thirty (30) days after the effective date of this Agreement.',
    'Late payment shall incur interest at 0.05% per day.',
    '',
    'Article 3  Confidentiality',
    'Both Parties agree to keep all non-public information confidential',
    'for a period of five (5) years from the date of disclosure.',
  ];
  doc.setFont('helvetica','bold'); doc.setFontSize(16);
  doc.text(lines1[0], 60, 70);
  doc.setFont('helvetica','normal'); doc.setFontSize(11);
  let y = 110;
  for(let i=1;i<lines1.length;i++){
    if(lines1[i].startsWith('Article')){ doc.setFont('helvetica','bold'); doc.setFontSize(12); }
    else { doc.setFont('helvetica','normal'); doc.setFontSize(11); }
    doc.text(lines1[i], 60, y); y += 20;
  }
  doc.addPage();
  doc.setFont('helvetica','bold'); doc.setFontSize(14);
  doc.text('Article 4  Term and Termination', 60, 70);
  doc.setFont('helvetica','normal'); doc.setFontSize(11);
  const lines2 = [
    'This Agreement shall commence on the effective date and continue',
    'for twelve (12) months unless terminated earlier by either Party',
    'with thirty (30) days written notice.',
    '',
    'Article 5  Governing Law',
    'This Agreement shall be governed by the laws of the place of',
    'signing. Any dispute shall be submitted to the competent court.',
    '',
    'Signed by:',
    '_________________________     _________________________',
    'Party A (Client)              Party B (Provider)',
  ];
  y = 100;
  for(const L of lines2){ doc.text(L, 60, y); y += 20; }

  const blob = doc.output('blob');
  blob.name = '示例合同-Sample-Contract.pdf';
  await handleFiles([blob]);
  // Also seed a demo citation
  setTimeout(()=>{
    if(!state.citations.length){
      const demo = {
        id: uid(), docId:'', docName:'示例合同-Sample-Contract.pdf', pageNo:1,
        original:'The Client shall pay the Provider the total fee of USD 120,000 within thirty (30) days after the effective date of this Agreement.',
        quote:'The Client shall pay the Provider the total fee of USD 120,000 within thirty days after the effective date of this Agreement.',
        verdict:'partial', sim:0.97, match:120, ins:0, del:4, createdAt: Date.now(),
      };
      idbPut('citations',demo); state.citations.push(demo); renderVerify(); updateStatusBar();
    }
  }, 6000);
}
$('#btnLoadSample').addEventListener('click', loadSample);
$('#btnEmptyLoad').addEventListener('click', loadSample);

// ---- Sort buttons ----
$('#btnSortRecent').addEventListener('click', ()=>{ state.docs.sort((a,b)=>b.addedAt-a.addedAt); renderLibrary(); });
$('#btnSortName').addEventListener('click', ()=>{ state.docs.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')); renderLibrary(); });

// ---- 勾选与批量删除 ----
$('#chkSelectAll').addEventListener('change', e=>{
  const list = visibleDocs();
  if(e.target.checked) list.forEach(d=> state.selected.add(d.id));
  else list.forEach(d=> state.selected.delete(d.id));
  renderLibrary();
});
$('#btnDeleteSelected').addEventListener('click', ()=>{
  const ids = [...state.selected];
  if(!ids.length){ toast('请先勾选要删除的文档','warn'); return; }
  const names = ids.map(id=> (state.docs.find(d=>d.id===id)||{}).name ).filter(Boolean);
  const preview = names.slice(0,3).map(n=>`「${n}」`).join('、') + (names.length>3?` 等 ${names.length} 份文档`:'');
  openModal({
    title: `将选中的 ${ids.length} 份文档移到回收站？`,
    body: `${preview} 及其页面文本、OCR 结果与索引会被移到回收站，可随时恢复。相关的核验记录会保留。`,
    onConfirm: async ()=>{
      const n = await moveToTrash(ids);
      state.selected.clear();
      renderLibrary(); renderSearch(); renderOCR(); renderTrash(); renderStorage(); updateStatusBar();
      toast(`已将 ${n} 份文档移到回收站`,'success');
    }
  });
});

// ---- 回收站：移入 / 恢复 / 彻底删除 / 清空 ----
async function moveToTrash(ids){
  let moved = 0;
  for(const id of ids){
    const doc = state.docs.find(d=>d.id===id);
    if(!doc) continue;
    const pages = state.pages.filter(p=>p.docId===id);
    try{
      // 写入回收站（含文档与其全部页面），再从 docs/pages 移除
      await idbPut('trash', { docId:id, doc, pages, deletedAt: Date.now() });
      await idbDel('docs', id);
      for(const p of pages) await idbDel('pages', p.id);
      state.trash.unshift({ docId:id, doc, pages, deletedAt: Date.now() });
      state.pages = state.pages.filter(p=>p.docId!==id);
      moved++;
    }catch(err){ console.error('移入回收站失败', id, err); }
  }
  state.docs = state.docs.filter(d=> !ids.includes(d.id));
  if(state.currentDoc && ids.includes(state.currentDoc.id)) state.currentDoc = null;
  state.currentResults = state.currentResults.filter(r=> !ids.includes(r.docId));
  return moved;
}

async function restoreFromTrash(docId){
  const item = state.trash.find(t=>t.docId===docId);
  if(!item) return false;
  try{
    await idbPut('docs', item.doc);
    for(const p of item.pages) await idbPut('pages', p);
    await idbDel('trash', docId);
    state.docs.unshift(item.doc);
    state.pages.push(...item.pages);
    state.trash = state.trash.filter(t=>t.docId!==docId);
    return true;
  }catch(err){ console.error('恢复失败', docId, err); return false; }
}

async function permanentDelete(docId){
  try{
    await idbDel('trash', docId);
    state.trash = state.trash.filter(t=>t.docId!==docId);
    return true;
  }catch(err){ console.error('彻底删除失败', docId, err); return false; }
}

function renderTrash(){
  const list = $('#trashList'), empty = $('#trashEmpty');
  $('#navTrashCount').textContent = state.trash.length;
  const totalBytes = state.trash.reduce((a,t)=> a+(t.doc&&t.doc.size||0), 0);
  const days = state.settings.trashRetentionDays;
  const retText = days ? `保留 ${days} 天` : '永久保留';
  $('#trashSub').textContent = state.trash.length
    ? `${state.trash.length} 份文档 · 占用 ${fmtBytes(totalBytes)} · ${retText} · 可恢复或彻底删除`
    : `已删除的文档会保留在这里（${retText}），可恢复或彻底删除`;
  $('#btnEmptyTrash').disabled = state.trash.length===0;
  const expiredCount = days ? state.trash.filter(t=> (t.deletedAt||0) < Date.now()-days*DAY_MS).length : 0;
  const purgeBtn = $('#btnPurgeNow');
  if(purgeBtn){
    purgeBtn.disabled = !days || expiredCount===0;
    purgeBtn.lastChild && (purgeBtn.title = days ? (expiredCount?`清理 ${expiredCount} 份已过期文档`:'暂无过期文档') : '当前为永久保留，不会自动清理');
  }
  if(!state.trash.length){ list.innerHTML=''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  list.innerHTML = state.trash.map(t=>{
    const d = t.doc||{};
    const exp = trashExpiryInfo(t);
    const expColor = exp.expired ? 'var(--danger)' : (exp.auto ? 'var(--muted)' : 'var(--muted)');
    return `
    <div class="ocr-job" data-status="indexed" style="margin-bottom:10px">
      <div class="ocr-job-icon" style="background:var(--surface-2);color:var(--muted)">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2h6l3 3v9H4z"/><path d="M10 2v3h3"/></svg>
      </div>
      <div class="ocr-job-main">
        <div class="ocr-job-head">
          <span class="ocr-job-name" title="${escapeHTML(d.name||'')}">${escapeHTML(d.name||'未知文档')}</span>
          <span class="result-tag">${docTypeLabel(d.type)}</span>
          <span class="result-tag" style="margin-left:auto">删除于 ${fmtDate(t.deletedAt)}</span>
        </div>
        <div class="ocr-job-meta">
          <span>${d.pages||0} 页</span>·<span>${fmtBytes(d.size||0)}</span>·<span>${(d.charCount||0).toLocaleString('zh-CN')} 字</span>·
          <span style="color:${expColor}">${exp.text}</span>
        </div>
      </div>
      <button class="btn btn-sm primary" data-restore="${t.docId}">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2.5 8a5.5 5.5 0 105.5-5.5M2.5 3v3h3"/></svg>恢复
      </button>
      <button class="btn btn-sm danger" data-permdel="${t.docId}">彻底删除</button>
    </div>`;
  }).join('');
  $$('[data-restore]',list).forEach(b=> b.addEventListener('click', async ()=>{
    const ok = await restoreFromTrash(b.dataset.restore);
    if(ok){ renderTrash(); renderLibrary(); renderSearch(); renderOCR(); renderStorage(); updateStatusBar(); toast('已恢复到文档库','success'); }
    else toast('恢复失败','error');
  }));
  $$('[data-permdel]',list).forEach(b=> b.addEventListener('click', ()=>{
    const t = state.trash.find(x=>x.docId===b.dataset.permdel);
    const nm = t&&t.doc?t.doc.name:'该文档';
    openModal({
      title:'彻底删除此文档？',
      body:`「${nm}」将从本地 IndexedDB 永久移除，无法恢复。`,
      onConfirm: async ()=>{
        await permanentDelete(b.dataset.permdel);
        renderTrash(); renderStorage(); updateStatusBar();
        toast('已彻底删除','info');
      }
    });
  }));
}

$('#btnEmptyTrash').addEventListener('click', ()=>{
  if(!state.trash.length) return;
  openModal({
    title:`清空回收站（${state.trash.length} 份文档）？`,
    body:'回收站内所有文档将从本地 IndexedDB 永久移除，无法恢复。',
    onConfirm: async ()=>{
      await idbClear('trash');
      state.trash = [];
      renderTrash(); renderStorage(); updateStatusBar();
      toast('回收站已清空','success');
    }
  });
});

// ---- 回收站保留天数设置 + 自动清理 ----
const DAY_MS = 86400000;
async function loadSettings(){
  try{
    const rec = await idbGet('settings','app');
    if(rec && typeof rec.trashRetentionDays === 'number') state.settings.trashRetentionDays = rec.trashRetentionDays;
  }catch(e){ /* 首次无记录时用默认值 */ }
  syncRetentionSelects();
}
async function saveSettings(){
  try{ await idbPut('settings', { k:'app', trashRetentionDays: state.settings.trashRetentionDays }); }catch(e){ console.warn('保存设置失败',e); }
}
function syncRetentionSelects(){
  const v = String(state.settings.trashRetentionDays);
  const a = $('#trashRetentionSelect'), b = $('#storageRetentionSelect');
  if(a) a.value = v;
  if(b) b.value = v;
}
function trashExpiryInfo(t){
  const days = state.settings.trashRetentionDays;
  if(!days) return { auto:false, text:'永久保留' };
  const left = Math.ceil(((t.deletedAt + days*DAY_MS) - Date.now())/DAY_MS);
  if(left <= 0) return { auto:true, expired:true, text:'已过期，待自动清理' };
  return { auto:true, expired:false, left, text:`${left} 天后自动删除` };
}
// 彻底删除超过保留天数的回收站项；返回清理数量
async function purgeExpiredTrash(silent){
  const days = state.settings.trashRetentionDays;
  if(!days) return 0;
  const cutoff = Date.now() - days*DAY_MS;
  const expired = state.trash.filter(t=> (t.deletedAt||0) < cutoff);
  for(const t of expired){
    try{ await idbDel('trash', t.docId); }catch(e){ console.warn('清理失败',e); }
  }
  if(expired.length){
    state.trash = state.trash.filter(t=> (t.deletedAt||0) >= cutoff);
    if(!silent) toast(`已自动清理 ${expired.length} 份过期文档`,'info');
  }
  return expired.length;
}
async function applyRetention(days){
  state.settings.trashRetentionDays = days;
  await saveSettings();
  syncRetentionSelects();
  await purgeExpiredTrash(false);
  renderTrash(); renderStorage(); updateStatusBar();
}
$('#trashRetentionSelect').addEventListener('change', e=> applyRetention(+e.target.value));
$('#storageRetentionSelect').addEventListener('change', e=> applyRetention(+e.target.value));
$('#btnPurgeNow').addEventListener('click', async ()=>{
  const n = await purgeExpiredTrash(false);
  if(!n) toast('当前没有超过保留天数的文档','info');
  renderTrash(); renderStorage(); updateStatusBar();
});

// ---- 使用者档案：隔离每个用户的数据 ----
const AVATAR_COLORS = ['#5E6AD2','#0D9488','#D97706','#2563EB','#059669','#DB2777','#0891B2','#65A30D','#EA580C','#0E7490'];
function avatarColor(id){
  let h = 0; const s = String(id||'');
  for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initialOf(name){
  const n = String(name||'').trim();
  if(!n) return '?';
  // 中文取首字，英文取首字母大写
  return /[\u4e00-\u9fa5]/.test(n[0]) ? n[0] : n[0].toUpperCase();
}
// 轻量本地密码哈希（FNV-1a），用于防止同机他人随意打开；非强加密
function hashPin(pin){
  const s = 'pdfverify::' + pin;
  let h = 0x811c9dc5;
  for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return 'fnv1a-' + h.toString(36) + '-' + s.length;
}

function renderGate(){
  const wrap = $('#gateProfiles');
  const listSection = $('#gateListSection');
  const createSection = $('#gateCreateSection');
  const unlockSection = $('#gateUnlockSection');
  unlockSection.classList.add('hidden');
  $('#unlockError').style.display='none';
  $('#gateUnlockPin').value='';

  if(!state.profiles.length){
    listSection.classList.add('hidden');
    $('#gateCreateLabel').textContent = '创建你的第一个使用者档案';
    createSection.classList.remove('hidden');
    return;
  }
  listSection.classList.remove('hidden');
  $('#gateCreateLabel').textContent = '或新建其他使用者';
  createSection.classList.remove('hidden');

  const sorted = state.profiles.slice().sort((a,b)=>(b.lastUsed||b.createdAt||0)-(a.lastUsed||a.createdAt||0));
  wrap.innerHTML = sorted.map(p=>`
    <div class="gate-profile" data-pid="${p.id}" role="button" tabindex="0">
      <span class="gate-profile-avatar" style="background:${p.color||avatarColor(p.id)}">${escapeHTML(initialOf(p.name))}</span>
      <span class="gate-profile-main">
        <span class="gate-profile-name">${escapeHTML(p.name)}</span>
        <span class="gate-profile-meta">
          ${p.pinHash?`<span class="gate-profile-lock"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>已设密码</span><span>·</span>`:''}
          <span>上次使用 ${fmtDate(p.lastUsed||p.createdAt)}</span>
        </span>
      </span>
      <span class="gate-profile-del" data-del="${p.id}" role="button" tabindex="0" title="删除此使用者及其全部本地数据">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4"/></svg>
      </span>
    </div>`).join('');

  $$('.gate-profile', wrap).forEach(el=>{
    const pid = el.dataset.pid;
    const choose = (e)=>{
      if(e.target.closest('[data-del]')) return;
      const p = state.profiles.find(x=>x.id===pid);
      if(!p) return;
      if(p.pinHash){ showUnlock(p); } else { enterProfile(p); }
    };
    el.addEventListener('click', choose);
    el.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); choose(e); } });
    const del = el.querySelector('[data-del]');
    if(del){
      const doDel = async (e)=>{
        e.stopPropagation();
        const p = state.profiles.find(x=>x.id===pid);
        if(!p) return;
        if(!confirm(`确认删除使用者「${p.name}」？\n该使用者的全部本地数据（PDF、OCR 文本、索引、核验记录、回收站）将被永久删除，且无法恢复。`)) return;
        if(pid === (state.currentProfile&&state.currentProfile.id)){ db=null; state.currentProfile=null; }
        await deleteProfileDB(pid);
        await profDel(pid);
        state.profiles = state.profiles.filter(x=>x.id!==pid);
        renderGate();
      };
      del.addEventListener('click', doDel);
      del.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); doDel(e); } });
    }
  });
}

let pendingUnlockProfile = null;
function showUnlock(p){
  pendingUnlockProfile = p;
  $('#gateCreateSection').classList.add('hidden');
  $('#gateListSection').classList.add('hidden');
  $('#gateUnlockSection').classList.remove('hidden');
  $('#unlockName').textContent = p.name;
  $('#unlockError').style.display='none';
  $('#gateUnlockPin').value='';
  setTimeout(()=> $('#gateUnlockPin').focus(), 60);
}
function hideUnlock(){
  pendingUnlockProfile = null;
  $('#gateUnlockSection').classList.add('hidden');
  $('#gateCreateSection').classList.remove('hidden');
  $('#gateListSection').classList.remove('hidden');
  renderGate();
}

async function enterProfile(p){
  try{
    db = await openProfileDB(p.id);
    state.currentProfile = p;
    // 重置上一使用者的内存状态，确保不残留
    state.selected.clear();
    state.currentDoc=null; state.currentResults=[]; state.currentQuery=''; state.currentHitIdx=0;
    state.verifyOriginal=''; state.verifyQuote=''; state.verifyOriginalMeta=null;
    const gs = $('#globalSearch'); if(gs) gs.value='';

    const [docs, pages, citations, trash] = await Promise.all([idbAll('docs'), idbAll('pages'), idbAll('citations'), idbAll('trash')]);
    state.docs = docs.sort((a,b)=>b.addedAt-a.addedAt);
    state.pages = pages;
    state.citations = citations;
    state.trash = (trash||[]).sort((a,b)=>b.deletedAt-a.deletedAt);
    state.settings = { trashRetentionDays: 30 };
    await loadSettings();
    const purged = await purgeExpiredTrash(true);

    // 更新上次使用时间
    p.lastUsed = Date.now();
    await profPut(p);

    updateUserChip();
    switchView('library');
    renderSearch(); renderOCR(); renderTrash(); renderStorage(); renderVerify(); updateStatusBar();
    setEngineStatus(`就绪 · ${state.ocrLang} · ${OCR_POOL_SIZE} 路并发`,'ok');
    $('#profileGate').classList.add('hidden');
    if(purged) toast(`已自动清理 ${purged} 份超过保留天数的文档`,'info');
    if(!state.docs.length){
      setTimeout(()=> toast(`欢迎，${p.name}。点击「载入示例」可零上传体验完整流程`,'info',4200), 500);
    } else {
      setTimeout(()=> toast(`已进入「${p.name}」的独立空间`,'success',2200), 300);
    }
  }catch(err){
    console.error(err);
    toast('打开使用者空间失败：'+err.message,'error',5000);
  }
}

function updateUserChip(){
  const p = state.currentProfile;
  if(!p) return;
  const av = $('#userAvatar');
  av.textContent = initialOf(p.name);
  av.style.background = p.color || avatarColor(p.id);
  $('#userName').textContent = p.name;
  $('#userChip').title = `当前使用者：${p.name}（数据独立存储于本机）`;
}

function switchUser(){
  $('#profileGate').classList.remove('hidden');
  hideUnlock();
}

async function createProfile(){
  const name = ($('#gateName').value||'').trim();
  const pin = ($('#gatePin').value||'');
  if(!name){ toast('请填写使用者名称','warn'); $('#gateName').focus(); return; }
  if(state.profiles.some(p=> p.name.toLowerCase()===name.toLowerCase())){
    toast('已存在同名使用者，请换一个名称或直接选择它','warn'); return;
  }
  const p = {
    id: uid(), name, color: avatarColor(name+Date.now()),
    pinHash: pin ? hashPin(pin) : null,
    createdAt: Date.now(), lastUsed: Date.now(),
  };
  await profPut(p);
  state.profiles.push(p);
  $('#gateName').value=''; $('#gatePin').value='';
  await enterProfile(p);
}

// 门控事件绑定
$('#gateCreateBtn').addEventListener('click', createProfile);
$('#gateName').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); createProfile(); } });
$('#gatePin').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); createProfile(); } });
$('#gateUnlockBtn').addEventListener('click', ()=>{
  const p = pendingUnlockProfile;
  if(!p) return;
  const input = $('#gateUnlockPin').value||'';
  if(p.pinHash && hashPin(input) === p.pinHash){
    $('#gateUnlockPin').value='';
    enterProfile(p);
  } else {
    $('#unlockError').style.display='block';
    $('#gateUnlockPin').value=''; $('#gateUnlockPin').focus();
  }
});
$('#gateUnlockPin').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#gateUnlockBtn').click(); } });
$('#gateUnlockCancel').addEventListener('click', hideUnlock);
$('#btnSwitchUser').addEventListener('click', switchUser);

// ---- Boot：先加载档案注册表并显示门控，选定使用者后才打开其独立数据库 ----
(async function boot(){
  try{
    profilesDb = await openProfilesDB();
    state.profiles = await profAll();
    renderGate();
    // 默认聚焦到名称输入或第一个档案
    if(!state.profiles.length) setTimeout(()=> $('#gateName').focus(), 80);
  } catch(err){
    console.error(err);
    const gate = $('#profileGate');
    if(gate) gate.innerHTML = `<div class="gate-card"><div class="gate-title">初始化失败</div><div class="gate-sub" style="margin-top:8px">无法访问浏览器 IndexedDB：${escapeHTML(err.message||'')}。请确认浏览器未禁用本地存储，或使用 Chrome / Edge 打开。</div></div>`;
  }
})();
