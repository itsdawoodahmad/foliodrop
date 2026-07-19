// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PDF.js worker
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STATE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var S = {
  merge:      { files:[] },
  split:      { files:[], mode:'all', selPages:new Set() },
  // FIX: csv2excel state initialised with proper defaults
  csv2excel:  { files:[], delimiter:'auto', header:'yes' },
  rotate:     { files:[], degrees:90, pages:'all' },
  toimage:    { files:[], quality:2 },
  img2pdf:    { files:[], images:[], pageSize:'fit' },
  // FIX: pdf2word and word2pdf are separate, consistent state objects
  pdf2word:   { files:[], mode:'layout' },
  word2pdf:   { files:[] },
  pagenum:    { files:[], pos:'bottom-right', fmt:'num' },
  deletepages:{ files:[], toDelete:new Set() },
  compare:    { fileA:null, fileB:null, pages:[], currentPage:0, view:'diff' },
  compress:   { files:[], level:'medium' },
  watermark:  { files:[], style:'diagonal', opacity:0.25 },
  reorder:    { files:[], order:[] },
  summarize:  { files:[] }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FILE SIZE GUARDRAILS
// FIX: large files are processed entirely in-browser (no server), so a
//      very large PDF/image set can eat memory or freeze the tab with no
//      warning. This doesn't block anything — it just gives the user a
//      heads-up so a slow moment doesn't look like the app has crashed.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var SIZE_WARN_SINGLE = 75 * 1024 * 1024;   // 75MB — a single file this big
var SIZE_WARN_TOTAL  = 150 * 1024 * 1024;  // 150MB — combined selection this big
function warnIfLarge(files) {
  var list = Array.isArray(files) ? files : [files];
  var total = 0, biggest = null;
  list.forEach(function(f) {
    if (!f) return;
    total += f.size || 0;
    if (!biggest || f.size > biggest.size) biggest = f;
  });
  if (biggest && biggest.size > SIZE_WARN_SINGLE) {
    toast('⚠️ "' + biggest.name + '" is ' + fmtBytes(biggest.size) + ' — large files can take a while and use a lot of memory since everything runs in your browser.');
  } else if (total > SIZE_WARN_TOTAL) {
    toast('⚠️ That\u2019s ' + fmtBytes(total) + ' total — large batches can take a while since everything runs in your browser.');
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FILE PICKING
// FIX: each call creates a fresh dedicated <input> that is properly
//      cleaned up after use, preventing orphaned DOM nodes and race
//      conditions when two tools are opened in quick succession.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function pickFiles(tool, multi, accept) {
  var inp = document.createElement('input');
  inp.type     = 'file';
  inp.multiple = !!multi;
  inp.accept   = accept || '.pdf';
  inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;width:1px;height:1px;pointer-events:none';
  document.body.appendChild(inp);
  inp.onchange = function() {
    var files = Array.from(this.files);
    // Always remove the input after use
    if (document.body.contains(inp)) document.body.removeChild(inp);
    if (!files.length) return;
    if (tool === 'img2pdf')       addImages(files);
    else if (tool === 'word2pdf') addWordFile(files[0]);
    else                          addFiles(tool, files, multi);
  };
  // FIX: handle cancel — remove orphaned input after a delay
  setTimeout(function() {
    if (document.body.contains(inp)) document.body.removeChild(inp);
  }, 60000);
  inp.click();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DRAG & DROP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function onDragOver(e)  { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }

function onDrop(e, tool) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  var files = Array.from(e.dataTransfer.files)
    .filter(function(f){ return f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'); });
  if (!files.length) { toast('⚠️ Please drop PDF files only'); return; }
  addFiles(tool, files, tool === 'merge');
}

function onDropImages(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  var files = Array.from(e.dataTransfer.files).filter(function(f){ return f.type.startsWith('image/'); });
  if (!files.length) { toast('⚠️ Please drop image files (JPG, PNG, etc.)'); return; }
  addImages(files);
}

function onDropWord(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  var wordExts = ['.docx','.doc','.odt','.rtf','.dot','.dotx'];
  var files = Array.from(e.dataTransfer.files).filter(function(f){
    var n = f.name.toLowerCase();
    return wordExts.some(function(ext){ return n.endsWith(ext); });
  });
  if (!files.length) { toast('⚠️ Please drop a Word file (.docx, .doc, .odt, .rtf)'); return; }
  addWordFile(files[0]);
}

function onDropCSV(e) {
  e.preventDefault();
  document.getElementById('dz-csv2excel').classList.remove('drag-over');
  var files = Array.from(e.dataTransfer.files).filter(function(f){
    return /\.(csv|tsv|txt)$/i.test(f.name);
  });
  if (!files.length) { toast('⚠️ Please drop CSV/TSV files'); return; }
  addFiles('csv2excel', files, true);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADD FILES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function addFiles(tool, files, multi) {
  warnIfLarge(files);
  if (multi) S[tool].files.push.apply(S[tool].files, files);
  else       S[tool].files = [files[0]];
  renderList(tool);
  document.getElementById('btn-' + tool).disabled = false;
  var opts = document.getElementById(tool + '-opts');
  if (opts) opts.style.display = '';
  clearResult(tool);
  if (tool === 'split')       loadPagePreview(files[0], 'split-pages-grid', 'split-sel');
  if (tool === 'deletepages') loadPagePreview(files[0], 'delete-pages-grid', 'delete-sel');
  if (tool === 'reorder')     loadReorderPreview(files[0]);
  toast('📄 ' + S[tool].files.length + ' file(s) loaded');
}

function renderList(tool) {
  var el = document.getElementById('fl-' + tool);
  if (!el) return;
  el.innerHTML = '';
  S[tool].files.forEach(function(f, i) {
    var d = document.createElement('div');
    d.className = 'fitem';
    d.innerHTML = '<span class="fitem-icon">📄</span>'
      + '<div class="fitem-info"><div class="fitem-name" title="'+esc(f.name)+'">'+esc(f.name)+'</div>'
      + '<div class="fitem-size">'+fmtBytes(f.size)+'</div></div>'
      + '<button class="fitem-rm" type="button">✕</button>';
    d.querySelector('.fitem-rm').addEventListener('click', (function(idx){ return function(){ rmFile(tool,idx); }; })(i));
    el.appendChild(d);
  });
}

function rmFile(tool, i) {
  S[tool].files.splice(i, 1);
  renderList(tool);
  if (!S[tool].files.length) {
    document.getElementById('btn-' + tool).disabled = true;
    var opts = document.getElementById(tool + '-opts');
    if (opts) opts.style.display = 'none';
  }
}

function clearResult(tool) {
  var res = document.getElementById('res-' + tool);
  if (res) { res.classList.remove('on'); res.style.display = ''; }
  var pw = document.getElementById('pw-' + tool);
  if (pw) { pw.classList.remove('on'); setBar(tool, 0); }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// IMAGES TOOL
// FIX: also updates the file list so users can see selected images
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function addImages(files) {
  warnIfLarge(files);
  files.forEach(function(file) {
    // Use object URLs instead of full base64 to save memory
    var objectUrl = URL.createObjectURL(file);
    S.img2pdf.images.push({ file: file, dataUrl: objectUrl, _isObjectUrl: true });
    renderImgGrid();
    renderImgFileList();
  });
  document.getElementById('btn-img2pdf').disabled = false;
  clearResult('img2pdf');
}

// FIX: separate image grid renderer (thumbnails)
function renderImgGrid() {
  var grid = document.getElementById('img2pdf-grid');
  grid.innerHTML = '';
  S.img2pdf.images.forEach(function(img, i) {
    var d = document.createElement('div');
    d.className = 'img-thumb';
    d.innerHTML = '<img src="'+img.dataUrl+'" alt=""><button class="img-rm" type="button" title="Remove">✕</button>';
    d.querySelector('.img-rm').addEventListener('click', (function(idx){ return function(){
      var removed = S.img2pdf.images.splice(idx, 1);
      if (removed[0] && removed[0]._isObjectUrl) URL.revokeObjectURL(removed[0].dataUrl);
      renderImgGrid();
      renderImgFileList();
      if (!S.img2pdf.images.length) document.getElementById('btn-img2pdf').disabled = true;
    }; })(i));
    grid.appendChild(d);
  });
}

// FIX: new function — shows file names and sizes in the file list
function renderImgFileList() {
  var el = document.getElementById('fl-img2pdf');
  if (!el) return;
  el.innerHTML = '';
  S.img2pdf.images.forEach(function(img, i) {
    var d = document.createElement('div');
    d.className = 'fitem';
    d.innerHTML = '<span class="fitem-icon">🖼️</span>'
      + '<div class="fitem-info"><div class="fitem-name" title="'+esc(img.file.name)+'">'+esc(img.file.name)+'</div>'
      + '<div class="fitem-size">'+fmtBytes(img.file.size)+'</div></div>';
    el.appendChild(d);
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WORD FILE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function addWordFile(file) {
  warnIfLarge(file);
  S.word2pdf.files = [file];
  var el = document.getElementById('fl-word2pdf');
  el.innerHTML = '';
  var d = document.createElement('div');
  d.className = 'fitem';
  d.innerHTML = '<span class="fitem-icon">📝</span>'
    + '<div class="fitem-info"><div class="fitem-name">'+esc(file.name)+'</div>'
    + '<div class="fitem-size">'+fmtBytes(file.size)+'</div></div>'
    + '<button class="fitem-rm" type="button" title="Remove file">✕</button>';
  d.querySelector('.fitem-rm').addEventListener('click', function(){
    S.word2pdf.files = [];
    el.innerHTML = '';
    document.getElementById('btn-word2pdf').disabled = true;
    clearResult('word2pdf');
  });
  el.appendChild(d);
  document.getElementById('btn-word2pdf').disabled = false;
  clearResult('word2pdf');
  toast('📝 Word file loaded');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PAGE PREVIEW (shared for split / delete)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function loadPagePreview(file, gridId, mode) {
  if (typeof pdfjsLib === 'undefined') return;
  try {
    var ab  = await readAB(file);
    var pdf = await pdfjsLib.getDocument({ data: ab }).promise;
    var grid = document.getElementById(gridId);
    grid.innerHTML = '';
    var total = Math.min(pdf.numPages, 30);
    for (var i = 1; i <= total; i++) {
      var page = await pdf.getPage(i);
      var vp   = page.getViewport({ scale: 0.26 });
      var c    = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      page.cleanup();
      var thumb = document.createElement('div');
      // FIX: split "all" mode shows thumbs without sel class by default (mode drives selection)
      thumb.className = 'pthumb';
      thumb.dataset.page = i;
      thumb.appendChild(c);
      var lbl = document.createElement('div');
      lbl.className = 'pnum'; lbl.textContent = 'Page ' + i;
      thumb.appendChild(lbl);
      var pageNum = i;
      if (mode === 'split-sel') {
        thumb.addEventListener('click', function() {
          if (S.split.mode !== 'range') return;
          this.classList.toggle('sel');
          var pn = parseInt(this.dataset.page);
          if (this.classList.contains('sel')) S.split.selPages.add(pn);
          else S.split.selPages.delete(pn);
        });
      } else if (mode === 'delete-sel') {
        thumb.addEventListener('click', function() {
          this.classList.toggle('del');
          var pn = parseInt(this.dataset.page);
          if (this.classList.contains('del')) S.deletepages.toDelete.add(pn);
          else S.deletepages.toDelete.delete(pn);
          updateDelCount(pdf.numPages);
        });
      }
      grid.appendChild(thumb);
    }
  } catch(e) { console.warn('Preview error:', e); }
}

function updateDelCount(total) {
  var cnt = S.deletepages.toDelete.size;
  var el  = document.getElementById('del-count');
  if (el) el.textContent = cnt === 0
    ? 'No pages selected for deletion.'
    : cnt + ' page(s) marked for deletion. ' + (total - cnt) + ' page(s) will be kept.';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NAVIGATION
// FIX: showHome no longer pushes a new history entry every call
//      (previously caused infinite history buildup on Android back).
//      _fromPopstate guard prevents re-pushing during popstate handling.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var _fromPopstate = false;

function showHome() {
  document.getElementById('home').style.display = '';
  document.querySelectorAll('.panel').forEach(function(p){ p.classList.remove('on'); });
  window.scrollTo(0, 0);
  if (!_fromPopstate) {
    try { history.replaceState({ view: 'home' }, '', location.pathname + location.search); } catch(e){}
  }
}

function openTool(name) {
  document.getElementById('home').style.display = 'none';
  document.querySelectorAll('.panel').forEach(function(p){ p.classList.remove('on'); });
  var panel = document.getElementById('tool-' + name);
  if (!panel) { showHome(); return; }
  panel.classList.add('on');

  // Reset state
  S[name] && (S[name].files = []);
  if (name === 'split')       { S.split.selPages = new Set(); }
  if (name === 'deletepages') { S.deletepages.toDelete = new Set(); }
  if (name === 'img2pdf')     {
    S.img2pdf.images.forEach(function(img){ if(img._isObjectUrl) URL.revokeObjectURL(img.dataUrl); });
    S.img2pdf.images = [];
    var g = document.getElementById('img2pdf-grid'); if(g) g.innerHTML = '';
    var fl = document.getElementById('fl-img2pdf');  if(fl) fl.innerHTML = '';
  }

  var flEl = document.getElementById('fl-' + name);
  if (flEl) flEl.innerHTML = '';
  var btnEl = document.getElementById('btn-' + name);
  if (btnEl) btnEl.disabled = true;
  clearResult(name);
  var opts = document.getElementById(name + '-opts');
  if (opts) opts.style.display = 'none';
  if (name === 'split') {
    var spg = document.getElementById('split-pages-grid'); if(spg) spg.innerHTML = '';
    var ass = document.getElementById('ai-split-status'); if (ass) { ass.style.display = 'none'; ass.textContent = ''; }
  }
  if (name === 'deletepages') {
    var dpg = document.getElementById('delete-pages-grid'); if(dpg) dpg.innerHTML = '';
    var dc  = document.getElementById('del-count'); if(dc) dc.textContent = 'No pages selected for deletion.';
  }
  if (name === 'watermark') {
    var wt = document.getElementById('watermark-text'); if (wt) wt.value = '';
  }
  if (name === 'reorder') {
    S.reorder.order = [];
    var rg = document.getElementById('reorder-grid'); if (rg) rg.innerHTML = '';
  }
  if (name === 'summarize') {
    var sb = document.getElementById('summarize-bullets'); if (sb) sb.innerHTML = '';
  }
  if (name === 'compare') {
    S.compare.fileA = null; S.compare.fileB = null;
    S.compare.pages = []; S.compare.currentPage = 0;
    document.getElementById('cdb-fname-a').textContent = '—';
    document.getElementById('cdb-fname-b').textContent = '—';
    document.getElementById('cdb-a').classList.remove('has-file');
    document.getElementById('cdb-b').classList.remove('has-file');
    document.getElementById('compare-canvas-area').innerHTML = '';
    document.getElementById('compare-stats').innerHTML = '';
    document.getElementById('res-compare').style.display = 'none';
  }

  window.scrollTo(0, 0);

  if (!_fromPopstate) {
    try { history.pushState({ view: 'tool', tool: name }, '', '#' + name); } catch(e){}
  }
}

function setOpt(tool, key, val, btn) {
  S[tool][key] = val;
  var row = btn.parentElement;
  if (row) row.querySelectorAll('.opt-btn').forEach(function(b){ b.classList.remove('on'); });
  btn.classList.add('on');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function fmtBytes(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(t._t);
  t._t = setTimeout(function(){ t.classList.remove('on'); }, 3200);
}
function setBar(tool, pct, lbl) {
  var pw  = document.getElementById('pw-' + tool);
  if (pw) pw.classList.add('on');
  var bar = document.getElementById('pb-' + tool);
  if (bar) bar.style.width = pct + '%';
  var pp  = document.getElementById('pp-' + tool);
  if (pp) pp.textContent = pct + '%';
  if (lbl) { var pl = document.getElementById('pl-' + tool); if (pl) pl.textContent = lbl; }
}
function hideBar(tool) {
  var pw = document.getElementById('pw-' + tool);
  if (pw) pw.classList.remove('on');
}
function readAB(file) {
  return new Promise(function(res, rej) {
    var r = new FileReader();
    r.onload  = function(){ res(r.result); };
    r.onerror = function(){ rej(new Error('Cannot read file: ' + file.name)); };
    r.readAsArrayBuffer(file);
  });
}

// FIX: dlDataUrl — use atob directly instead of fetch(dataUrl) which can
//      fail in older Android WebViews that don't support fetch of data: URLs
function dlDataUrl(dataUrl, fname) {
  var b64    = dataUrl.split(',')[1];
  var mime   = dataUrl.split(',')[0].split(':')[1].split(';')[0];
  var bytes  = Uint8Array.from(atob(b64), function(c){ return c.charCodeAt(0); });
  var blob   = new Blob([bytes], { type: mime });
  saveAndShareFile(blob, fname);
}

async function blobToBase64(blob) {
  return new Promise(function(resolve) {
    var reader = new FileReader();
    reader.onloadend = function(){ resolve(reader.result); };
    reader.readAsDataURL(blob);
  });
}

async function saveAndShareFile(blob, fname) {
  var base64Full   = await blobToBase64(blob);
  var base64String = base64Full.split(',')[1];

  var hasFS    = !!(window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Filesystem);
  var hasShare = !!(window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Share);

  if (hasFS && hasShare) {
    try {
      var result = await Capacitor.Plugins.Filesystem.writeFile({
        path: fname, data: base64String, directory: 'CACHE', recursive: true
      });
      await Capacitor.Plugins.Share.share({ title: fname, url: result.uri, dialogTitle: 'Save or open ' + fname });
      return;
    } catch(e) {
      if (e.message && e.message.toLowerCase().includes('cancel')) return;
      toast('⚠️ ' + e.message);
      return;
    }
  }

  // Browser fallback
  var a      = document.createElement('a');
  a.href     = base64Full;
  a.download = fname;
  a.target   = '_blank';
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ if(document.body.contains(a)) document.body.removeChild(a); }, 1000);
}

function dlBlob(bytes, fname) {
  var blob = new Blob([bytes], { type: 'application/pdf' });
  saveAndShareFile(blob, fname);
}
function dlBytes(bytes, fname, mime) {
  var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  saveAndShareFile(blob, fname);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MERGE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function mergePDFs() {
  if (S.merge.files.length < 2) { toast('⚠️ Add at least 2 PDF files'); return; }
  document.getElementById('btn-merge').disabled = true;
  try {
    var out = await PDFLib.PDFDocument.create();
    for (var i = 0; i < S.merge.files.length; i++) {
      setBar('merge', Math.round(5 + (i/S.merge.files.length)*85), 'Merging file ' + (i+1) + ' of ' + S.merge.files.length + '…');
      var ab  = await readAB(S.merge.files[i]);
      var doc = await PDFLib.PDFDocument.load(ab);
      var pgs = await out.copyPages(doc, doc.getPageIndices());
      pgs.forEach(function(p){ out.addPage(p); });
    }
    setBar('merge', 95, 'Saving…');
    var bytes = await out.save();
    setBar('merge', 100, 'Done!');
    document.getElementById('ri-merge').textContent = S.merge.files.length + ' PDFs merged → ' + fmtBytes(bytes.length);
    document.getElementById('dl-merge').onclick = function(){ dlBlob(bytes, 'merged.pdf'); };
    document.getElementById('res-merge').classList.add('on');
    toast('✅ Merge complete!');
  } catch(e) { hideBar('merge'); toast('❌ ' + e.message); }
  document.getElementById('btn-merge').disabled = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SPLIT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function setSplitMode(mode) {
  S.split.mode = mode;
  document.getElementById('sm-all').classList.toggle('on',   mode === 'all');
  document.getElementById('sm-range').classList.toggle('on', mode === 'range');
  document.getElementById('split-range-ui').style.display = mode === 'range' ? '' : 'none';
  // FIX: visual feedback — highlight thumbs only in range mode (user taps to select)
  document.querySelectorAll('#split-pages-grid .pthumb').forEach(function(t){
    t.classList.toggle('sel', false);
  });
  S.split.selPages.clear();
}

async function splitPDF() {
  if (!S.split.files.length) { toast('⚠️ Please select a PDF'); return; }
  document.getElementById('btn-split').disabled = true;
  try {
    var ab    = await readAB(S.split.files[0]);
    var src   = await PDFLib.PDFDocument.load(ab);
    var total = src.getPageCount();
    var indices = [];

    if (S.split.mode === 'all') {
      indices = src.getPageIndices();
    } else {
      var rv = document.getElementById('split-range-val').value.trim();
      if (rv) {
        rv.split(',').forEach(function(part){
          part = part.trim();
          if (part.includes('-')) {
            var pts = part.split('-');
            var a2 = parseInt(pts[0])-1, b2 = parseInt(pts[1])-1;
            for (var i = a2; i <= b2 && i < total; i++) if(i>=0) indices.push(i);
          } else {
            var n = parseInt(part)-1;
            if (n >= 0 && n < total) indices.push(n);
          }
        });
      } else {
        indices = Array.from(S.split.selPages).map(function(p){ return p-1; }).filter(function(p){ return p>=0&&p<total; });
      }
    }

    if (!indices.length) { toast('⚠️ No pages selected'); document.getElementById('btn-split').disabled = false; return; }

    var dlWrap = document.getElementById('dl-split');
    dlWrap.innerHTML = '';
    setBar('split', 10);

    if (S.split.mode === 'all') {
      var blobs = [];
      for (var i = 0; i < indices.length; i++) {
        setBar('split', Math.round(10+(i/indices.length)*85), 'Extracting page '+(i+1)+' of '+indices.length+'…');
        var nd = await PDFLib.PDFDocument.create();
        var cp = await nd.copyPages(src, [indices[i]]);
        nd.addPage(cp[0]);
        blobs.push({ bytes: await nd.save(), name: 'page_'+(i+1)+'.pdf' });
      }
      setBar('split', 100, 'Done!');
      if (blobs.length > 1) {
        var splitZipBtn = document.createElement('button');
        splitZipBtn.className = 'dl-btn'; splitZipBtn.type = 'button';
        splitZipBtn.style.cssText = 'margin:4px;background:var(--accent2);';
        splitZipBtn.textContent = '📦 Download All as ZIP';
        splitZipBtn.addEventListener('click', async function(){
          try {
            splitZipBtn.disabled = true; splitZipBtn.textContent = '⏳ Zipping…';
            var z = new JSZip();
            blobs.forEach(function(b2){ z.file(b2.name, b2.bytes); });
            var zBlob = await z.generateAsync({type:'blob'});
            saveAndShareFile(zBlob, 'split_pages.zip');
            splitZipBtn.disabled = false; splitZipBtn.textContent = '📦 Download All as ZIP';
          } catch(ze){ toast('❌ '+ze.message); splitZipBtn.disabled=false; splitZipBtn.textContent='📦 Download All as ZIP'; }
        });
        dlWrap.appendChild(splitZipBtn);
      }
      blobs.forEach(function(b, i){
        var btn2 = document.createElement('button');
        btn2.className = 'dl-btn'; btn2.type = 'button'; btn2.textContent = '⬇️ Page '+(i+1);
        btn2.addEventListener('click', (function(bdata){ return function(){ dlBlob(bdata.bytes, bdata.name); }; })(b));
        dlWrap.appendChild(btn2);
      });
      document.getElementById('ri-split').textContent = indices.length + ' pages extracted as individual files';
    } else {
      var nd2 = await PDFLib.PDFDocument.create();
      var cp2 = await nd2.copyPages(src, indices);
      cp2.forEach(function(p){ nd2.addPage(p); });
      var bytes2 = await nd2.save();
      setBar('split', 100, 'Done!');
      var btn3 = document.createElement('button');
      btn3.className = 'dl-btn'; btn3.type = 'button'; btn3.textContent = '⬇️ Download Split PDF';
      btn3.addEventListener('click', function(){ dlBlob(bytes2, 'split.pdf'); });
      dlWrap.appendChild(btn3);
      document.getElementById('ri-split').textContent = indices.length + ' pages → ' + fmtBytes(bytes2.length);
    }
    document.getElementById('res-split').classList.add('on');
    toast('✅ Split complete!');
  } catch(e) { hideBar('split'); toast('❌ ' + e.message); }
  document.getElementById('btn-split').disabled = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CSV TO EXCEL
// FIX: button is always re-enabled in finally block so errors can't
//      leave it permanently disabled.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseCSV(text, delimiter) {
  if (delimiter === 'auto') {
    var counts = { ',':0, '\t':0, ';':0, '|':0 };
    var sample = text.slice(0, 2000);
    Object.keys(counts).forEach(function(d){
      counts[d] = (sample.match(new RegExp(d === '\t' ? '\\t' : '\\' + d, 'g')) || []).length;
    });
    delimiter = Object.keys(counts).reduce(function(a,b){ return counts[a]>=counts[b]?a:b; });
  }
  var rows  = [];
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.trim() === '' && i === lines.length - 1) continue;
    var row = [], cur = '', inQ = false;
    for (var c = 0; c < line.length; c++) {
      var ch = line[c];
      if (ch === '"') {
        if (inQ && line[c+1] === '"') { cur += '"'; c++; } else inQ = !inQ;
      } else if (ch === delimiter && !inQ) {
        row.push(cur); cur = '';
      } else { cur += ch; }
    }
    row.push(cur);
    rows.push(row);
  }
  return { rows: rows, delimiter: delimiter };
}

async function csvToExcel() {
  if (!S.csv2excel.files.length) { toast('⚠️ Please select a CSV file'); return; }
  document.getElementById('btn-csv2excel').disabled = true;
  setBar('csv2excel', 5, 'Reading files…');
  try {
    if (typeof XLSX === 'undefined') {
      setBar('csv2excel', 10, 'Loading library…');
      await new Promise(function(resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    var wb = XLSX.utils.book_new();
    var totalRows = 0;

    for (var fi = 0; fi < S.csv2excel.files.length; fi++) {
      var file   = S.csv2excel.files[fi];
      var pct    = Math.round(15 + (fi / S.csv2excel.files.length) * 75);
      setBar('csv2excel', pct, 'Processing ' + file.name + '…');
      var text   = await file.text();
      var parsed = parseCSV(text, S.csv2excel.delimiter);
      var rows   = parsed.rows;
      if (!rows.length) continue;

      var ws = XLSX.utils.aoa_to_sheet(rows);
      if (S.csv2excel.header === 'yes' && rows[0]) {
        var range = XLSX.utils.decode_range(ws['!ref']);
        for (var col = range.s.c; col <= range.e.c; col++) {
          var cellAddr = XLSX.utils.encode_cell({ r: 0, c: col });
          if (!ws[cellAddr]) continue;
          ws[cellAddr].s = { font: { bold: true }, fill: { fgColor: { rgb: 'F5A623' } } };
        }
      }
      var colWidths = rows[0].map(function(_, ci){
        return { wch: Math.min(50, Math.max(10, rows.reduce(function(mx,r){ return Math.max(mx,(r[ci]||'').toString().length); }, 0)+2)) };
      });
      ws['!cols'] = colWidths;
      var sheetName = file.name.replace(/\.[^.]+$/, '').slice(0, 31) || ('Sheet' + (fi + 1));
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      totalRows += rows.length;
    }

    setBar('csv2excel', 92, 'Building Excel file…');
    var wbOut    = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    var outBytes = new Uint8Array(wbOut);
    setBar('csv2excel', 100, 'Done!');

    var fname   = S.csv2excel.files.length === 1
      ? S.csv2excel.files[0].name.replace(/\.[^.]+$/, '') + '.xlsx'
      : 'converted.xlsx';
    var sheets  = wb.SheetNames.length;
    var summary = S.csv2excel.files.length + ' file' + (S.csv2excel.files.length > 1 ? 's' : '')
      + ' → ' + sheets + ' sheet' + (sheets > 1 ? 's' : '')
      + ', ' + totalRows.toLocaleString() + ' rows total ✅';

    document.getElementById('ri-csv2excel').textContent = summary;
    document.getElementById('dl-csv2excel').onclick = function(){ dlBytes(outBytes, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); };
    document.getElementById('res-csv2excel').classList.add('on');
    toast('✅ Excel ready — ' + totalRows.toLocaleString() + ' rows');
  } catch(e) {
    console.error('CSV→Excel error:', e);
    toast('❌ ' + e.message);
    setBar('csv2excel', 0);
  } finally {
    // FIX: always re-enable button regardless of success or failure
    document.getElementById('btn-csv2excel').disabled = false;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ROTATE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function rotatePDF() {
  if (!S.rotate.files.length) { toast('⚠️ Please select a PDF'); return; }
  document.getElementById('btn-rotate').disabled = true;
  setBar('rotate', 20);
  try {
    var ab  = await readAB(S.rotate.files[0]);
    var doc = await PDFLib.PDFDocument.load(ab);
    setBar('rotate', 55, 'Rotating…');
    doc.getPages().forEach(function(page, i){
      var n      = i + 1;
      var apply  = S.rotate.pages === 'all'
        || (S.rotate.pages === 'odd'  && n % 2 !== 0)
        || (S.rotate.pages === 'even' && n % 2 === 0);
      if (apply) page.setRotation(PDFLib.degrees((page.getRotation().angle + S.rotate.degrees) % 360));
    });
    setBar('rotate', 85, 'Saving…');
    var bytes = await doc.save();
    setBar('rotate', 100, 'Done!');
    document.getElementById('ri-rotate').textContent = doc.getPageCount() + ' pages rotated ' + S.rotate.degrees + '° (' + fmtBytes(bytes.length) + ')';
    document.getElementById('dl-rotate').onclick = function(){ dlBlob(bytes, 'rotated.pdf'); };
    document.getElementById('res-rotate').classList.add('on');
    toast('✅ Rotation complete!');
  } catch(e) { hideBar('rotate'); toast('❌ ' + e.message); }
  document.getElementById('btn-rotate').disabled = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COMPRESS PDF
// Re-renders each page to a canvas and re-embeds it as a JPEG at a
// chosen quality/scale — the same rasterize-and-embed technique already
// used by the PDF-to-Image and Images-to-PDF tools above. This shrinks
// image-heavy/scanned PDFs well; it will NOT keep text selectable
// afterward, which is disclosed in the tool's info card.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var COMPRESS_LEVELS = {
  low:    { scale: 1.1, jpegQuality: 0.45 },
  medium: { scale: 1.5, jpegQuality: 0.68 },
  high:   { scale: 2.0, jpegQuality: 0.82 }
};
async function compressPDF() {
  if (typeof pdfjsLib === 'undefined') { toast('❌ PDF.js not loaded'); return; }
  if (!S.compress.files.length) { toast('⚠️ Please select a PDF'); return; }
  var srcFile = S.compress.files[0];
  document.getElementById('btn-compress').disabled = true;
  setBar('compress', 5);
  try {
    var originalSize = srcFile.size;
    var ab = await readAB(srcFile);

    // Original page sizes (in PDF points) so the output keeps the same dimensions
    var srcDoc = await PDFLib.PDFDocument.load(ab);
    var sizes  = srcDoc.getPages().map(function(p){ return p.getSize(); });

    var pdfjsDoc = await pdfjsLib.getDocument({ data: ab.slice(0) }).promise;
    var total    = pdfjsDoc.numPages;
    var cfg      = COMPRESS_LEVELS[S.compress.level] || COMPRESS_LEVELS.medium;

    var outDoc = await PDFLib.PDFDocument.create();
    for (var i = 1; i <= total; i++) {
      setBar('compress', Math.round(5 + ((i-1)/total)*85), 'Compressing page ' + i + ' of ' + total + '…');
      var page = await pdfjsDoc.getPage(i);
      var vp   = page.getViewport({ scale: cfg.scale });
      var c    = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      page.cleanup();
      var jpgUrl   = c.toDataURL('image/jpeg', cfg.jpegQuality);
      var jpgB64   = jpgUrl.split(',')[1];
      var jpgBytes = Uint8Array.from(atob(jpgB64), function(ch){ return ch.charCodeAt(0); });
      var embedded = await outDoc.embedJpg(jpgBytes);
      var pageSize = sizes[i-1] || { width: vp.width, height: vp.height };
      var newPage  = outDoc.addPage([pageSize.width, pageSize.height]);
      newPage.drawImage(embedded, { x: 0, y: 0, width: pageSize.width, height: pageSize.height });
    }
    setBar('compress', 95, 'Saving…');
    var bytes = await outDoc.save();
    setBar('compress', 100, 'Done!');

    var newSize = bytes.length;
    var pct = originalSize > 0 ? Math.round((1 - newSize / originalSize) * 100) : 0;
    var summary = pct > 0
      ? fmtBytes(originalSize) + ' → ' + fmtBytes(newSize) + ' (' + pct + '% smaller)'
      : fmtBytes(originalSize) + ' → ' + fmtBytes(newSize) + ' (already well-optimized — this PDF may already be compressed)';
    document.getElementById('ri-compress').textContent = summary;
    document.getElementById('dl-compress').onclick = function(){ dlBlob(bytes, 'compressed.pdf'); };
    document.getElementById('res-compress').classList.add('on');
    toast('✅ Compression complete!');
  } catch(e) { hideBar('compress'); toast('❌ ' + e.message); }
  document.getElementById('btn-compress').disabled = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PDF TO IMAGE
// FIX: uses dlDataUrl (atob-based) instead of fetch(dataUrl)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function pdfToImages() {
  if (typeof pdfjsLib === 'undefined') { toast('❌ PDF.js not loaded'); return; }
  if (!S.toimage.files.length) { toast('⚠️ Please select a PDF'); return; }
  document.getElementById('btn-toimage').disabled = true;
  try {
    var ab    = await readAB(S.toimage.files[0]);
    var pdf   = await pdfjsLib.getDocument({ data: ab }).promise;
    var total = pdf.numPages;
    var dlWrap = document.getElementById('dl-toimage');
    dlWrap.innerHTML = '';
    for (var i = 1; i <= total; i++) {
      setBar('toimage', Math.round(((i-1)/total)*95), 'Converting page ' + i + ' of ' + total + '…');
      var page    = await pdf.getPage(i);
      var vp      = page.getViewport({ scale: S.toimage.quality });
      var c       = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      page.cleanup();
      var dataUrl = c.toDataURL('image/png');
      var idx     = i;
      var btn2    = document.createElement('button');
      btn2.className = 'dl-btn'; btn2.type = 'button'; btn2.style.margin = '4px';
      btn2.textContent = '⬇️ Page ' + idx;
      btn2.addEventListener('click', (function(url, n){ return function(){ dlDataUrl(url, 'page_'+n+'.png'); }; })(dataUrl, idx));
      btn2._dataUrl = dataUrl;
      dlWrap.appendChild(btn2);
    }
    setBar('toimage', 100, 'Done!');
    // Add "Download All as ZIP" button when multiple pages
    if (total > 1) {
      var zipBtn = document.createElement('button');
      zipBtn.className = 'dl-btn'; zipBtn.type = 'button'; zipBtn.style.cssText = 'margin:4px;background:var(--accent2);';
      zipBtn.textContent = '📦 Download All as ZIP';
      // Capture all dataUrls for zip
      var allDataUrls = Array.from(dlWrap.querySelectorAll('button')).map(function(b,i){ return b._dataUrl; });
      // Store dataUrls on buttons for zip access
      dlWrap.querySelectorAll('button').forEach(function(b,i){ b._idx = i+1; });
      zipBtn.addEventListener('click', async function(){
        try {
          zipBtn.disabled = true; zipBtn.textContent = '⏳ Zipping…';
          var z = new JSZip();
          var btns = dlWrap.querySelectorAll('button:not([data-zip])');
          for (var bi = 0; bi < btns.length; bi++) {
            var url = btns[bi]._dataUrl;
            if (!url) continue;
            var b64z = url.split(',')[1];
            z.file('page_'+(bi+1)+'.png', b64z, {base64:true});
          }
          var zBlob = await z.generateAsync({type:'blob'});
          saveAndShareFile(zBlob, 'pages.zip');
          zipBtn.disabled = false; zipBtn.textContent = '📦 Download All as ZIP';
        } catch(ze){ toast('❌ ZIP error: '+ze.message); zipBtn.disabled=false; zipBtn.textContent='📦 Download All as ZIP'; }
      });
      zipBtn.dataset.zip = '1';
      dlWrap.insertBefore(zipBtn, dlWrap.firstChild);
    }
    document.getElementById('ri-toimage').textContent = total + ' page' + (total>1?'s':'') + ' converted to PNG';
    document.getElementById('res-toimage').classList.add('on');
    toast('✅ ' + total + ' image' + (total>1?'s':'') + ' ready!');
  } catch(e) { hideBar('toimage'); toast('❌ ' + e.message); }
  document.getElementById('btn-toimage').disabled = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// IMAGES TO PDF
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function imagesToPDF() {
  if (!S.img2pdf.images.length) { toast('⚠️ Please select images'); return; }
  document.getElementById('btn-img2pdf').disabled = true;
  setBar('img2pdf', 5);
  try {
    var doc  = await PDFLib.PDFDocument.create();
    var imgs = S.img2pdf.images;
    for (var i = 0; i < imgs.length; i++) {
      setBar('img2pdf', Math.round(5+(i/imgs.length)*90), 'Adding image '+(i+1)+' of '+imgs.length+'…');
      var mime = imgs[i].file.type;
      var embedded;
      // Re-encode unsupported formats (WEBP, GIF, BMP, etc.) to JPEG via canvas
      if (mime !== 'image/png' && mime !== 'image/jpeg') {
        var imgEl = await new Promise(function(res, rej) {
          var el = new Image();
          el.onload = function(){ res(el); };
          el.onerror = function(){ rej(new Error('Cannot load image: ' + imgs[i].file.name)); };
          el.src = imgs[i].dataUrl;
        });
        var cv = document.createElement('canvas');
        cv.width = imgEl.naturalWidth; cv.height = imgEl.naturalHeight;
        cv.getContext('2d').drawImage(imgEl, 0, 0);
        var jpgUrl = cv.toDataURL('image/jpeg', 0.93);
        var jpgB64 = jpgUrl.split(',')[1];
        var jpgBytes = Uint8Array.from(atob(jpgB64), function(c){ return c.charCodeAt(0); });
        embedded = await doc.embedJpg(jpgBytes);
      } else {
        var ab   = await readAB(imgs[i].file);
        if (mime === 'image/png') embedded = await doc.embedPng(ab);
        else embedded = await doc.embedJpg(ab);
      }
      var iW = embedded.width, iH = embedded.height;
      var pw = iW, ph = iH;
      if (S.img2pdf.pageSize === 'a4')     { pw = 595.28; ph = 841.89; }
      if (S.img2pdf.pageSize === 'letter') { pw = 612;    ph = 792; }
      var page  = doc.addPage([pw, ph]);
      var scale = Math.min(pw/iW, ph/iH);
      var dw = iW*scale, dh = iH*scale;
      page.drawImage(embedded, { x:(pw-dw)/2, y:(ph-dh)/2, width:dw, height:dh });
    }
    setBar('img2pdf', 97, 'Saving…');
    var bytes = await doc.save();
    setBar('img2pdf', 100, 'Done!');
    document.getElementById('ri-img2pdf').textContent = imgs.length + ' image' + (imgs.length>1?'s':'') + ' → PDF (' + fmtBytes(bytes.length) + ')';
    document.getElementById('dl-img2pdf').onclick = function(){ dlBlob(bytes, 'images.pdf'); };
    document.getElementById('res-img2pdf').classList.add('on');
    toast('✅ PDF created from images!');
  } catch(e) { hideBar('img2pdf'); toast('❌ ' + e.message); }
  document.getElementById('btn-img2pdf').disabled = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PDF TO WORD — Dual-Mode Engine
// FIX: S.pdf2word.mode used consistently (no longer a detached object)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function p2w_setMode(mode, btn) {
  S.pdf2word.mode = mode;
  document.querySelectorAll('#p2w-mode-layout, #p2w-mode-text').forEach(function(b){ b.classList.remove('on'); });
  btn.classList.add('on');
  var info = document.getElementById('p2w-info');
  if (mode === 'layout') {
    info.innerHTML = '🖼️ <b>Layout Preserved (Recommended):</b> Every page is rendered pixel-perfect and embedded in the .docx — fonts, images, tables, columns, and direction all look exactly like the original PDF.';
  } else {
    info.innerHTML = '✏️ <b>Editable Text:</b> Text is extracted with per-run font size, bold, italic and colour. Best for simple text-heavy PDFs where you need to edit the content.';
  }
}

async function pdfToWord() {
  if (typeof pdfjsLib === 'undefined') { toast('❌ PDF.js not loaded'); return; }
  if (!S.pdf2word.files.length)         { toast('⚠️ Please select a PDF'); return; }
  document.getElementById('btn-pdf2word').disabled = true;
  // FIX: read mode from S.pdf2word.mode (was reading from a detached local object)
  var mode = S.pdf2word.mode || 'layout';
  setBar('pdf2word', 3, 'Loading PDF…');
  try {
    var ab  = await readAB(S.pdf2word.files[0]);
    var pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(ab),
      cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
      cMapPacked: true,
      disableFontFace: false
    }).promise;
    var total = pdf.numPages;
    var docxBytes;
    if (mode === 'layout') {
      docxBytes = await p2w_layoutMode(pdf, total);
    } else {
      docxBytes = await p2w_textMode(pdf, total);
    }
    setBar('pdf2word', 100, 'Done!');
    var outName = S.pdf2word.files[0].name.replace(/\.pdf$/i, '') + '.docx';
    document.getElementById('ri-pdf2word').textContent = total + ' page' + (total>1?'s':'') + ' converted (' + mode + ' mode)';
    document.getElementById('dl-pdf2word').onclick = function(){
      dlBytes(docxBytes, outName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    };
    document.getElementById('res-pdf2word').classList.add('on');
    toast('✅ Word document ready!');
  } catch(e) {
    console.error('pdfToWord:', e);
    hideBar('pdf2word');
    toast('❌ ' + e.message);
  }
  document.getElementById('btn-pdf2word').disabled = false;
}

// ── Layout mode (page-as-image) ───────────────────────────────────────
async function p2w_layoutMode(pdf, total) {
  var zip = new JSZip(), mediaList = [], imgRels = [], ridCtr = 1, imgIdCtr = 1;
  var bodyXml = '', sectParts = [];
  for (var i = 1; i <= total; i++) {
    setBar('pdf2word', Math.round(3+(i/total)*80), 'Rendering page '+i+' of '+total+'…');
    var page  = await pdf.getPage(i);
    var vp1   = page.getViewport({ scale: 1 });
    var pdW   = vp1.width, pdH = vp1.height;
    var twW   = Math.round(pdW*20), twH = Math.round(pdH*20);
    var emuW  = Math.round(pdW*12700), emuH = Math.round(pdH*12700);
    var SCALE = 2.0;
    var vpR   = page.getViewport({ scale: SCALE });
    var canvas = document.createElement('canvas');
    canvas.width  = Math.floor(vpR.width);
    canvas.height = Math.floor(vpR.height);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
    await page.render({ canvasContext: ctx, viewport: vpR }).promise;
    page.cleanup();
    var jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    var b64 = jpegDataUrl.split(',')[1];
    var mName = 'page'+i+'.jpg';
    mediaList.push({ name: mName, b64: b64 });
    var rid = 'rId'+(ridCtr++);
    imgRels.push({ rid: rid, name: mName });
    var iid = imgIdCtr++;
    var content   = await page.getTextContent({ normalizeWhitespace: true });
    var textRuns  = p2w_hiddenTextRuns(content.items);
    var imgParaXml = p2w_fullPageImgPara(rid, emuW, emuH, iid, 'p'+i);
    var hiddenParaXml = '';
    if (textRuns.length) {
      hiddenParaXml = '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>'
        + textRuns.map(function(run){
            return '<w:r><w:rPr><w:vanish/><w:sz w:val="1"/></w:rPr>'
              + '<w:t xml:space="preserve">'+p2w_esc(run)+'</w:t></w:r>';
          }).join('') + '</w:p>';
    }
    var thisSectPr = '<w:sectPr><w:pgSz w:w="'+twW+'" w:h="'+twH+'"/>'
      + '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
    if (i < total) {
      bodyXml += imgParaXml + hiddenParaXml + '<w:p><w:pPr>'+thisSectPr+'</w:pPr></w:p>';
    } else {
      bodyXml += imgParaXml + hiddenParaXml;
      sectParts.push(thisSectPr);
    }
  }
  var lastSect = sectParts.length ? sectParts[sectParts.length-1] : '<w:sectPr/>';
  var docXml = p2w_docXmlWrap(bodyXml, lastSect);
  var wordRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + imgRels.map(function(r){
        return '<Relationship Id="'+r.rid+'"'
          + ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"'
          + ' Target="media/'+r.name+'"/>';
      }).join('') + '</Relationships>';
  return p2w_packZip(zip, docXml, wordRelsXml, mediaList, p2w_minimalStylesXml());
}

function p2w_hiddenTextRuns(items) {
  var runs = [], cur = '';
  items.forEach(function(it){
    if (!it.str) return;
    cur += it.str;
    if (cur.length > 200) { runs.push(cur); cur = ''; }
  });
  if (cur.trim()) runs.push(cur);
  return runs;
}

function p2w_fullPageImgPara(rid, wEMU, hEMU, iid, name) {
  return '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
    + '<w:r><w:rPr/><w:drawing>'
    + '<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
    + '<wp:extent cx="'+wEMU+'" cy="'+hEMU+'"/>'
    + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
    + '<wp:docPr id="'+iid+'" name="'+p2w_esc(name)+'"/>'
    + '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>'
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:nvPicPr><pic:cNvPr id="'+iid+'" name="'+p2w_esc(name)+'"/>'
    + '<pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr>'
    + '<pic:blipFill><a:blip r:embed="'+rid+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<a:extLst><a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}">'
    + '<a14:useLocalDpi xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" val="0"/>'
    + '</a:ext></a:extLst></a:blip><a:srcRect/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + '<pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="'+wEMU+'" cy="'+hEMU+'"/></a:xfrm>'
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}

// ── Text mode ─────────────────────────────────────────────────────────
async function p2w_textMode(pdf, total) {
  var zip = new JSZip(), bodyXml = '';
  for (var i = 1; i <= total; i++) {
    setBar('pdf2word', Math.round(3+(i/total)*80), 'Extracting page '+i+' of '+total+'…');
    var page    = await pdf.getPage(i);
    var vp      = page.getViewport({ scale: 1 });
    var content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
    if (!content.items.length) {
      bodyXml += '<w:p><w:r><w:rPr><w:i/><w:color w:val="888888"/><w:sz w:val="18"/></w:rPr>'
        + '<w:t>[Page '+i+' — image/scanned content]</w:t></w:r></w:p>';
    } else {
      bodyXml += p2w_pageToXml(content.items, vp);
    }
    if (i < total) bodyXml += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }
  var lastSect = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
    + '<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>';
  var docXml = p2w_docXmlWrap(bodyXml, lastSect);
  var wordRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  return p2w_packZip(zip, docXml, wordRelsXml, [], p2w_fullStylesXml());
}

function p2w_pageToXml(items, vp) {
  if (!items.length) return '';
  var pageH = vp.height, pageW = vp.width, LEFT_MARGIN = pageW * 0.08;
  var tokens = [];
  items.forEach(function(it) {
    if (it.str === undefined || it.str === null) return;
    var tx = it.transform;
    var x  = tx[4], y = tx[5];
    var fs = Math.round(Math.sqrt(tx[0]*tx[0]+tx[1]*tx[1])*10)/10 || 10;
    var fontName = (it.fontName||'').toLowerCase();
    var bold = /bold|black|heavy|semibold/i.test(fontName);
    var italic = /italic|oblique/i.test(fontName);
    var family = p2w_cleanFontFamily(it.fontName||'');
    var color  = it.color ? p2w_rgbToHex(it.color) : '000000';
    var rtl    = (it.width<0)||(it.dir==='rtl');
    tokens.push({ x:x, y:y, fs:fs, str:it.str, bold:bold, italic:italic, family:family, color:color, rtl:rtl, width:Math.abs(it.width||0) });
  });
  var LINE_TOL = 2.5, lines = [];
  tokens.forEach(function(tk){
    var ln = null;
    for (var j=0;j<lines.length;j++) { if(Math.abs(lines[j].baseY-tk.y)<=LINE_TOL){ln=lines[j];break;} }
    if(!ln){ln={baseY:tk.y,tokens:[],maxFs:0,minX:Infinity};lines.push(ln);}
    ln.tokens.push(tk);
    if(tk.fs>ln.maxFs)ln.maxFs=tk.fs;
    if(tk.x<ln.minX)ln.minX=tk.x;
  });
  lines.sort(function(a,b){return b.baseY-a.baseY;});
  lines.forEach(function(ln){ln.tokens.sort(function(a,b){return a.x-b.x;});});
  var fsFreq={};
  tokens.forEach(function(tk){var k=Math.round(tk.fs);fsFreq[k]=(fsFreq[k]||0)+1;});
  var bodyFs=10,maxCnt=0;
  Object.keys(fsFreq).forEach(function(k){if(fsFreq[k]>maxCnt){maxCnt=fsFreq[k];bodyFs=+k;}});
  var avgLineH=lines.length>1?(lines[0].baseY-lines[lines.length-1].baseY)/(lines.length-1):bodyFs*1.2;
  var PARA_GAP=avgLineH*1.4, paragraphs=[], curPara=null;
  lines.forEach(function(ln,idx){
    var prevY=idx>0?lines[idx-1].baseY:ln.baseY, gap=prevY-ln.baseY, isNew=!curPara||gap>PARA_GAP;
    if(isNew){curPara={lines:[ln],maxFs:ln.maxFs,minX:ln.minX};paragraphs.push(curPara);}
    else{curPara.lines.push(ln);if(ln.maxFs>curPara.maxFs)curPara.maxFs=ln.maxFs;if(ln.minX<curPara.minX)curPara.minX=ln.minX;}
  });
  var out='';
  paragraphs.forEach(function(para){
    var fs=para.maxFs, ratio=fs/bodyFs;
    var hlvl=ratio>2.0?1:ratio>1.35?2:ratio>1.15?3:0;
    var indentTw=Math.max(0,Math.round(para.minX-LEFT_MARGIN))>5?Math.round(para.minX*20*0.6):0;
    var rtlCount=0,totCount=0;
    para.lines.forEach(function(ln){ln.tokens.forEach(function(tk){totCount++;if(tk.rtl)rtlCount++;});});
    var isRtl=rtlCount>totCount*0.5;
    var jc=isRtl?'right':'left';
    var spAfter=hlvl===1?240:hlvl===2?160:hlvl===3?120:100;
    var spBefore=hlvl===1?320:hlvl===2?200:hlvl===3?140:0;
    var pPrXml='<w:pPr>'+(hlvl?'<w:outlineLvl w:val="'+(hlvl-1)+'"/>' : '')
      +'<w:jc w:val="'+jc+'"/>'+(isRtl?'<w:bidi/>':'')
      +(indentTw>0?'<w:ind w:left="'+indentTw+'"/>' : '')
      +'<w:spacing w:before="'+spBefore+'" w:after="'+spAfter+'" w:line="276" w:lineRule="auto"/>'
      +'</w:pPr>';
    var runsXml='', prevEndX=-1;
    para.lines.forEach(function(ln,li){
      if(li>0&&runsXml) runsXml+='<w:r><w:rPr><w:sz w:val="'+Math.round(bodyFs*2)+'"/></w:rPr><w:t xml:space="preserve"> </w:t></w:r>';
      var runGroups=[],curGroup=null;
      ln.tokens.forEach(function(tk){
        var key=tk.bold+'|'+tk.italic+'|'+Math.round(tk.fs)+'|'+tk.color+'|'+tk.family+'|'+tk.rtl;
        if(!curGroup||curGroup.key!==key){curGroup={key:key,tks:[tk],tk:tk};runGroups.push(curGroup);}
        else curGroup.tks.push(tk);
      });
      runGroups.forEach(function(grp){
        var tk=grp.tk, text=grp.tks.map(function(t){return t.str;}).join('');
        if(!text)return;
        if(prevEndX>=0){var gap2=grp.tks[0].x-prevEndX;if(gap2>tk.fs*0.3&&text[0]!==' ')runsXml+='<w:r><w:rPr><w:sz w:val="'+Math.round(tk.fs*2)+'"/></w:rPr><w:t xml:space="preserve"> </w:t></w:r>';}
        var lastTk=grp.tks[grp.tks.length-1]; prevEndX=lastTk.x+lastTk.width;
        var szVal=Math.round(Math.max(12,Math.min(144,tk.fs*2)));
        var rPrXml='<w:rPr>'+(tk.bold?'<w:b/><w:bCs/>':'')+(tk.italic?'<w:i/><w:iCs/>':'')+(tk.rtl?'<w:rtl/>':'')
          +(tk.color!=='000000'?'<w:color w:val="'+tk.color+'"/>':'')
          +'<w:sz w:val="'+szVal+'"/><w:szCs w:val="'+szVal+'"/>'
          +(tk.family?'<w:rFonts w:ascii="'+p2w_esc(tk.family)+'" w:hAnsi="'+p2w_esc(tk.family)+'" w:cs="'+p2w_esc(tk.family)+'"/>' :'')
          +'</w:rPr>';
        runsXml+='<w:r>'+rPrXml+'<w:t xml:space="preserve">'+p2w_esc(text)+'</w:t></w:r>';
      });
    });
    if(!runsXml)return;
    if(hlvl){
      var hStyle='Heading'+hlvl;
      out+='<w:p><w:pPr><w:pStyle w:val="'+hStyle+'"/>'+pPrXml.slice(6);
    } else {
      out+='<w:p>'+pPrXml;
    }
    out+=runsXml+'</w:p>';
  });
  return out;
}

function p2w_esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
function p2w_cleanFontFamily(name){
  if(!name)return'';
  name=name.replace(/^[A-Z]{6}\+/,'');
  name=name.replace(/[,\-_](Bold|Italic|Oblique|Regular|Light|Medium|Black|Heavy|Semibold|BoldItalic|ItalicBold).*$/i,'');
  var map={'TimesNewRoman':'Times New Roman','Times':'Times New Roman','Arial':'Arial','Helvetica':'Arial','CourierNew':'Courier New','Courier':'Courier New','Georgia':'Georgia','Verdana':'Verdana','Calibri':'Calibri'};
  return map[name]||name||'';
}
function p2w_rgbToHex(rgb){
  if(!rgb||!Array.isArray(rgb))return'000000';
  var r=Math.round((rgb[0]||0)*255),g=Math.round((rgb[1]||0)*255),b=Math.round((rgb[2]||0)*255);
  return ('0'+r.toString(16)).slice(-2)+('0'+g.toString(16)).slice(-2)+('0'+b.toString(16)).slice(-2);
}
function p2w_docXmlWrap(bodyXml,sectPr){
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    +' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
    +' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    +' xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"'
    +' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
    +' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    +'<w:body>'+bodyXml+sectPr+'</w:body></w:document>';
}
async function p2w_packZip(zip,docXml,wordRelsXml,mediaList,stylesXml){
  var relsXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    +'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    +'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="word/styles.xml"/>'
    +'</Relationships>';
  var hasJpg=mediaList.some(function(m){return m.name.endsWith('.jpg');});
  var hasPng=mediaList.some(function(m){return m.name.endsWith('.png');});
  var ctXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    +'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    +'<Default Extension="xml" ContentType="application/xml"/>'
    +(hasJpg?'<Default Extension="jpg" ContentType="image/jpeg"/>':'')
    +(hasPng?'<Default Extension="png" ContentType="image/png"/>':'')
    +'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    +'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    +'</Types>';
  zip.file('[Content_Types].xml',ctXml);
  zip.file('_rels/.rels',relsXml);
  zip.file('word/document.xml',docXml);
  zip.file('word/_rels/document.xml.rels',wordRelsXml);
  zip.file('word/styles.xml',stylesXml);
  mediaList.forEach(function(mf){ zip.file('word/media/'+mf.name,mf.b64,{base64:true}); });
  return zip.generateAsync({type:'arraybuffer'});
}
function p2w_minimalStylesXml(){
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    +'<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>'
    +'<w:sz w:val="1"/><w:szCs w:val="1"/></w:rPr></w:rPrDefault></w:docDefaults>'
    +'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>'
    +'<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>'
    +'</w:styles>';
}
function p2w_fullStylesXml(){
  var base='<w:docDefaults><w:rPrDefault><w:rPr>'
    +'<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>'
    +'<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>';
  function sty(id,name,sz,bold,col,before,after,outline){
    return '<w:style w:type="paragraph" w:styleId="'+id+'">'
      +'<w:name w:val="'+name+'"/><w:basedOn w:val="Normal"/>'
      +'<w:pPr>'+(outline!==undefined?'<w:outlineLvl w:val="'+outline+'"/>' :'')
      +'<w:spacing w:before="'+before+'" w:after="'+after+'"/></w:pPr>'
      +'<w:rPr>'+(bold?'<w:b/><w:bCs/>':'')+'<w:color w:val="'+col+'"/>'
      +'<w:sz w:val="'+sz+'"/><w:szCs w:val="'+sz+'"/></w:rPr></w:style>';
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'+base
    +'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>'
    +'<w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr>'
    +'<w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>'
    +sty('Heading1','heading 1',36,true,'1F3864',320,160,0)
    +sty('Heading2','heading 2',28,true,'2F5496',240,120,1)
    +sty('Heading3','heading 3',24,true,'404040',200,80,2)
    +'</w:styles>';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WORD TO PDF
// FIX: render container uses position:fixed+visibility:hidden rather
//      than absolute+top:-9999px, which is more reliable in Android
//      WebViews that clip absolutely positioned off-screen content.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function wordToPDF() {
  if (!S.word2pdf.files.length) { toast('⚠️ Please select a Word file'); return; }
  if (typeof mammoth === 'undefined') { toast('❌ Mammoth.js not loaded'); return; }
  if (typeof html2canvas === 'undefined') { toast('❌ html2canvas not loaded'); return; }
  var file = S.word2pdf.files[0];
  document.getElementById('btn-word2pdf').disabled = true;
  document.getElementById('pl-word2pdf').textContent = 'Reading document…';
  setBar('word2pdf', 10);
  try {
    var ab = await readAB(file);
    setBar('word2pdf', 25);
    document.getElementById('pl-word2pdf').textContent = 'Converting to HTML…';
    var htmlContent = '';
    try {
      var result = await mammoth.convertToHtml({ arrayBuffer: ab });
      htmlContent = result.value;
    } catch(convErr) {
      console.warn('Mammoth failed, plain text fallback:', convErr);
      toast('⚠️ Full formatting unavailable — converting as plain text');
      var decoder = new TextDecoder('utf-8', { fatal: false });
      var raw = decoder.decode(ab);
      var cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,' ').replace(/ {3,}/g,'  ').trim();
      htmlContent = '<pre style="white-space:pre-wrap;font-family:Georgia,serif;font-size:11pt">'
        + cleaned.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
    }
    if (!htmlContent.trim()) throw new Error('No content could be extracted from the document.');
    setBar('word2pdf', 45);
    document.getElementById('pl-word2pdf').textContent = 'Rendering pages…';
    var pdfBytes = await htmlToPdfBytes(htmlContent, function(pct, msg){
      setBar('word2pdf', 45 + Math.round(pct * 0.5));
      if (msg) document.getElementById('pl-word2pdf').textContent = msg;
    });
    setBar('word2pdf', 100);
    document.getElementById('pl-word2pdf').textContent = 'Done!';
    var outName = file.name.replace(/\.[^.]+$/, '') + '.pdf';
    document.getElementById('ri-word2pdf').textContent = 'Converted successfully · ' + fmtBytes(pdfBytes.length);
    document.getElementById('dl-word2pdf').onclick = function(){ dlBlob(pdfBytes, outName); };
    document.getElementById('res-word2pdf').classList.add('on');
    toast('✅ PDF ready!');
  } catch(e) {
    console.error('wordToPDF error:', e);
    hideBar('word2pdf');
    toast('❌ ' + e.message);
  }
  document.getElementById('btn-word2pdf').disabled = false;
}

async function htmlToPdfBytes(htmlContent, onProgress) {
  onProgress = onProgress || function(){};
  var RENDER_W = 816, PAGE_H = 1056, SCALE = 2;

  var wrap = document.createElement('div');
  wrap.id  = '__w2pdf_wrap__';
  // FIX: use fixed positioning + visibility:hidden instead of absolute+top:-9999px
  //      Absolute off-screen is clipped by some Android WebView viewport implementations,
  //      causing html2canvas to capture a blank/truncated canvas.
  wrap.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:'+RENDER_W+'px',
    'visibility:hidden',
    'pointer-events:none',
    'background:#fff',
    'color:#000',
    'font-family:Georgia,"Times New Roman",serif',
    'font-size:12pt',
    'line-height:1.65',
    'padding:60px 72px',
    'z-index:99999',
    'overflow:visible',
    'word-wrap:break-word',
    'box-sizing:border-box'
  ].join(';');

  wrap.innerHTML = '<style>'
    + '#__w2pdf_wrap__ *{box-sizing:border-box;max-width:100%;}'
    + '#__w2pdf_wrap__ h1{font-size:22pt;font-weight:bold;margin:0.7em 0 0.3em;}'
    + '#__w2pdf_wrap__ h2{font-size:17pt;font-weight:bold;margin:0.7em 0 0.3em;}'
    + '#__w2pdf_wrap__ h3{font-size:14pt;font-weight:bold;margin:0.6em 0 0.25em;}'
    + '#__w2pdf_wrap__ h4,#__w2pdf_wrap__ h5,#__w2pdf_wrap__ h6{font-size:12pt;font-weight:bold;margin:0.5em 0 0.2em;}'
    + '#__w2pdf_wrap__ p{margin:0.35em 0;}'
    + '#__w2pdf_wrap__ ul,#__w2pdf_wrap__ ol{margin:0.3em 0;padding-left:2em;}'
    + '#__w2pdf_wrap__ li{margin:0.15em 0;}'
    + '#__w2pdf_wrap__ table{border-collapse:collapse;width:100%;margin:0.5em 0;}'
    + '#__w2pdf_wrap__ td,#__w2pdf_wrap__ th{border:1px solid #aaa;padding:4px 8px;font-size:10.5pt;}'
    + '#__w2pdf_wrap__ th{background:#f0f0f0;font-weight:bold;}'
    + '#__w2pdf_wrap__ blockquote{border-left:3px solid #999;margin:0.5em 0;padding:0.2em 0 0.2em 1em;color:#333;}'
    + '#__w2pdf_wrap__ strong,#__w2pdf_wrap__ b{font-weight:bold;}'
    + '#__w2pdf_wrap__ em,#__w2pdf_wrap__ i{font-style:italic;}'
    + '#__w2pdf_wrap__ hr{border:none;border-top:1px solid #ccc;margin:0.8em 0;}'
    + '#__w2pdf_wrap__ img{max-width:100%;height:auto;}'
    + '</style>'
    + htmlContent;

  document.body.appendChild(wrap);
  await new Promise(function(r){ setTimeout(r, 300); });
  var totalH = wrap.scrollHeight;
  onProgress(0.05, 'Rendering pages…');

  var fullCanvas;
  try {
    fullCanvas = await html2canvas(wrap, {
      scale: SCALE, width: RENDER_W, height: totalH,
      windowWidth: RENDER_W, backgroundColor: '#ffffff',
      useCORS: true, allowTaint: true, logging: false
    });
  } finally {
    if (document.body.contains(wrap)) document.body.removeChild(wrap);
  }

  onProgress(0.6, 'Building PDF…');
  var pdfDoc = await PDFLib.PDFDocument.create();
  var PDF_W = 595.28, PDF_H = 841.89;
  var scaledPageH  = PAGE_H * SCALE;
  var scaledTotalH = fullCanvas.height;
  var numPages = Math.max(1, Math.ceil(scaledTotalH / scaledPageH));

  for (var p = 0; p < numPages; p++) {
    onProgress(0.6 + 0.38*(p/numPages), 'Page '+(p+1)+' of '+numPages+'…');
    var srcY = p * scaledPageH;
    var srcH = Math.min(scaledPageH, scaledTotalH - srcY);
    if (srcH <= 0) break;
    var slice = document.createElement('canvas');
    slice.width  = fullCanvas.width;
    slice.height = scaledPageH;
    var ctx = slice.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,slice.width,slice.height);
    ctx.drawImage(fullCanvas, 0, srcY, fullCanvas.width, srcH, 0, 0, fullCanvas.width, srcH);
    var imgData  = slice.toDataURL('image/jpeg', 0.93);
    var b64      = imgData.split(',')[1];
    var imgBytes = Uint8Array.from(atob(b64), function(c){ return c.charCodeAt(0); });
    var embImg   = await pdfDoc.embedJpg(imgBytes);
    var page2    = pdfDoc.addPage([PDF_W, PDF_H]);
    page2.drawImage(embImg, { x:0, y:0, width:PDF_W, height:PDF_H });
  }
  onProgress(1, 'Saving…');
  return await pdfDoc.save();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADD PAGE NUMBERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function addPageNumbers() {
  if (!S.pagenum.files.length) { toast('⚠️ Please select a PDF'); return; }
  document.getElementById('btn-pagenum').disabled = true;
  var startNum = parseInt(document.getElementById('pagenum-start').value) || 1;
  setBar('pagenum', 20);
  try {
    var ab   = await readAB(S.pagenum.files[0]);
    var doc  = await PDFLib.PDFDocument.load(ab);
    var font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    setBar('pagenum', 55, 'Adding numbers…');
    var pages = doc.getPages(), total = pages.length;
    pages.forEach(function(page, i){
      var sz = page.getSize(), n = startNum + i, fs = 11, label = '';
      if      (S.pagenum.fmt === 'num')   label = String(n);
      else if (S.pagenum.fmt === 'page')  label = 'Page ' + n;
      else if (S.pagenum.fmt === 'total') label = n + '/' + (startNum + total - 1);
      var tw = font.widthOfTextAtSize(label, fs);
      var x, y, pos = S.pagenum.pos;
      if      (pos==='bottom-center'){x=sz.width/2-tw/2;y=24;}
      else if (pos==='bottom-right') {x=sz.width-tw-28;y=24;}
      else if (pos==='top-center')   {x=sz.width/2-tw/2;y=sz.height-36;}
      else if (pos==='top-right')    {x=sz.width-tw-28;y=sz.height-36;}
      page.drawText(label, { x:x, y:y, size:fs, font:font, color:PDFLib.rgb(0.3,0.3,0.3) });
    });
    setBar('pagenum', 88, 'Saving…');
    var bytes = await doc.save();
    setBar('pagenum', 100, 'Done!');
    document.getElementById('ri-pagenum').textContent = 'Page numbers added to ' + total + ' pages';
    document.getElementById('dl-pagenum').onclick = function(){ dlBlob(bytes, 'numbered.pdf'); };
    document.getElementById('res-pagenum').classList.add('on');
    toast('✅ Page numbers added!');
  } catch(e) { hideBar('pagenum'); toast('❌ ' + e.message); }
  document.getElementById('btn-pagenum').disabled = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADD WATERMARK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function watermarkPDF() {
  if (!S.watermark.files.length) { toast('⚠️ Please select a PDF'); return; }
  var text = (document.getElementById('watermark-text').value || '').trim();
  if (!text) { toast('⚠️ Please enter watermark text'); return; }
  document.getElementById('btn-watermark').disabled = true;
  setBar('watermark', 20);
  try {
    var ab   = await readAB(S.watermark.files[0]);
    var doc  = await PDFLib.PDFDocument.load(ab);
    var font = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    setBar('watermark', 55, 'Stamping…');
    var style   = S.watermark.style;
    var opacity = S.watermark.opacity;
    doc.getPages().forEach(function(page) {
      var sz = page.getSize();
      var fontSize, x, y, rotateDeg;
      if (style === 'stamp') {
        fontSize = 11;
        var tw = font.widthOfTextAtSize(text, fontSize);
        x = sz.width - tw - 20; y = 16; rotateDeg = 0;
      } else {
        fontSize = Math.max(18, Math.min(60, sz.width / (text.length * 0.62 || 1)));
        var tw2 = font.widthOfTextAtSize(text, fontSize);
        rotateDeg = style === 'diagonal' ? 45 : 0;
        var rad = rotateDeg * Math.PI / 180;
        x = (sz.width  - tw2 * Math.cos(rad)) / 2;
        y = (sz.height - tw2 * Math.sin(rad)) / 2;
      }
      page.drawText(text, {
        x: x, y: y, size: fontSize, font: font,
        color: PDFLib.rgb(0.45, 0.45, 0.45),
        opacity: opacity,
        rotate: PDFLib.degrees(rotateDeg)
      });
    });
    setBar('watermark', 88, 'Saving…');
    var bytes = await doc.save();
    setBar('watermark', 100, 'Done!');
    document.getElementById('ri-watermark').textContent = 'Watermark added to ' + doc.getPageCount() + ' page(s) (' + fmtBytes(bytes.length) + ')';
    document.getElementById('dl-watermark').onclick = function(){ dlBlob(bytes, 'watermarked.pdf'); };
    document.getElementById('res-watermark').classList.add('on');
    toast('✅ Watermark added!');
  } catch(e) { hideBar('watermark'); toast('❌ ' + e.message); }
  document.getElementById('btn-watermark').disabled = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DELETE PAGES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function deletePages() {
  if (!S.deletepages.files.length) { toast('⚠️ Please select a PDF'); return; }
  if (!S.deletepages.toDelete.size) { toast('⚠️ Please click on pages to mark them for deletion'); return; }
  document.getElementById('btn-deletepages').disabled = true;
  setBar('deletepages', 20);
  try {
    var ab    = await readAB(S.deletepages.files[0]);
    var doc   = await PDFLib.PDFDocument.load(ab);
    var total = doc.getPageCount();
    var toKeep = [];
    for (var i = 0; i < total; i++) { if (!S.deletepages.toDelete.has(i+1)) toKeep.push(i); }
    if (!toKeep.length) { toast('⚠️ Cannot delete all pages'); document.getElementById('btn-deletepages').disabled = false; return; }
    setBar('deletepages', 50, 'Building new PDF…');
    var newDoc = await PDFLib.PDFDocument.create();
    var copied = await newDoc.copyPages(doc, toKeep);
    copied.forEach(function(p){ newDoc.addPage(p); });
    setBar('deletepages', 85, 'Saving…');
    var bytes = await newDoc.save();
    setBar('deletepages', 100, 'Done!');
    document.getElementById('ri-deletepages').textContent = S.deletepages.toDelete.size + ' page(s) deleted. ' + toKeep.length + ' pages remain (' + fmtBytes(bytes.length) + ')';
    document.getElementById('dl-deletepages').onclick = function(){ dlBlob(bytes, 'pages-deleted.pdf'); };
    document.getElementById('res-deletepages').classList.add('on');
    toast('✅ Pages deleted!');
  } catch(e) { hideBar('deletepages'); toast('❌ ' + e.message); }
  document.getElementById('btn-deletepages').disabled = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REORDER PAGES
// order[] holds the current display order as 0-based original page
// indices. Moving a page just swaps its neighbor in that array — no
// drag-and-drop needed, so this works the same with mouse or touch.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function loadReorderPreview(file) {
  if (typeof pdfjsLib === 'undefined') return;
  try {
    var ab  = await readAB(file);
    var pdf = await pdfjsLib.getDocument({ data: ab }).promise;
    var total = Math.min(pdf.numPages, 60);
    S.reorder._pdf = pdf; // kept only for thumbnail rendering, not for processing
    S.reorder._thumbs = [];
    for (var i = 1; i <= total; i++) {
      var page = await pdf.getPage(i);
      var vp   = page.getViewport({ scale: 0.26 });
      var c    = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      page.cleanup();
      S.reorder._thumbs.push(c.toDataURL('image/png'));
    }
    S.reorder.order = [];
    for (var j = 0; j < total; j++) S.reorder.order.push(j);
    renderReorderGrid();
  } catch(e) { console.warn('Reorder preview error:', e); }
}

function renderReorderGrid() {
  var grid = document.getElementById('reorder-grid');
  if (!grid) return;
  grid.innerHTML = '';
  var order = S.reorder.order;
  order.forEach(function(pageIdx, pos) {
    var thumb = document.createElement('div');
    thumb.className = 'pthumb';
    var img = document.createElement('img');
    img.src = S.reorder._thumbs[pageIdx];
    img.style.cssText = 'width:100%;display:block;';
    thumb.appendChild(img);

    var posBadge = document.createElement('div');
    posBadge.className = 'pthumb-pos';
    posBadge.textContent = pos + 1;
    thumb.appendChild(posBadge);

    var leftBtn = document.createElement('button');
    leftBtn.type = 'button'; leftBtn.className = 'pthumb-move left'; leftBtn.textContent = '◀';
    leftBtn.disabled = pos === 0;
    leftBtn.addEventListener('click', (function(p){ return function(ev){ ev.stopPropagation(); moveReorderPage(p, -1); }; })(pos));
    thumb.appendChild(leftBtn);

    var rightBtn = document.createElement('button');
    rightBtn.type = 'button'; rightBtn.className = 'pthumb-move right'; rightBtn.textContent = '▶';
    rightBtn.disabled = pos === order.length - 1;
    rightBtn.addEventListener('click', (function(p){ return function(ev){ ev.stopPropagation(); moveReorderPage(p, 1); }; })(pos));
    thumb.appendChild(rightBtn);

    var lbl = document.createElement('div');
    lbl.className = 'pnum'; lbl.textContent = 'Was page ' + (pageIdx + 1);
    thumb.appendChild(lbl);

    grid.appendChild(thumb);
  });
}

function moveReorderPage(pos, dir) {
  var order = S.reorder.order;
  var target = pos + dir;
  if (target < 0 || target >= order.length) return;
  var tmp = order[pos];
  order[pos] = order[target];
  order[target] = tmp;
  renderReorderGrid();
}

function resetReorder() {
  var total = S.reorder._thumbs ? S.reorder._thumbs.length : 0;
  S.reorder.order = [];
  for (var i = 0; i < total; i++) S.reorder.order.push(i);
  renderReorderGrid();
  toast('↺ Order reset');
}

async function reorderPDF() {
  if (!S.reorder.files.length) { toast('⚠️ Please select a PDF'); return; }
  if (!S.reorder.order.length) { toast('⚠️ Nothing to reorder'); return; }
  document.getElementById('btn-reorder').disabled = true;
  setBar('reorder', 20);
  try {
    var ab  = await readAB(S.reorder.files[0]);
    var doc = await PDFLib.PDFDocument.load(ab);
    setBar('reorder', 50, 'Rebuilding PDF…');
    var newDoc = await PDFLib.PDFDocument.create();
    var copied = await newDoc.copyPages(doc, S.reorder.order);
    copied.forEach(function(p){ newDoc.addPage(p); });
    setBar('reorder', 85, 'Saving…');
    var bytes = await newDoc.save();
    setBar('reorder', 100, 'Done!');
    document.getElementById('ri-reorder').textContent = copied.length + ' pages saved in the new order (' + fmtBytes(bytes.length) + ')';
    document.getElementById('dl-reorder').onclick = function(){ dlBlob(bytes, 'reordered.pdf'); };
    document.getElementById('res-reorder').classList.add('on');
    toast('✅ Pages reordered!');
  } catch(e) { hideBar('reorder'); toast('❌ ' + e.message); }
  document.getElementById('btn-reorder').disabled = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COMPARE PDFs
// FIX: pickCompareFile uses a fresh input per call (no shared state
//      between sides) but correctly cleans up after itself.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function pickCompareFile(side) {
  var inp = document.createElement('input');
  inp.type   = 'file';
  inp.accept = '.pdf';
  inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;width:1px;height:1px;pointer-events:none';
  document.body.appendChild(inp);
  inp.onchange = function() {
    if (this.files.length) setCompareFile(side, this.files[0]);
    if (document.body.contains(inp)) document.body.removeChild(inp);
  };
  setTimeout(function(){ if(document.body.contains(inp)) document.body.removeChild(inp); }, 60000);
  inp.click();
}

function onCompareDrop(e, side) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  var files = Array.from(e.dataTransfer.files).filter(function(f){ return f.name.toLowerCase().endsWith('.pdf'); });
  if (!files.length) { toast('⚠️ Please drop a PDF file'); return; }
  setCompareFile(side, files[0]);
}

function setCompareFile(side, file) {
  if (side === 'a') {
    S.compare.fileA = file;
    document.getElementById('cdb-fname-a').textContent = file.name;
    document.getElementById('cdb-a').classList.add('has-file');
  } else {
    S.compare.fileB = file;
    document.getElementById('cdb-fname-b').textContent = file.name;
    document.getElementById('cdb-b').classList.add('has-file');
  }
  document.getElementById('btn-compare').disabled = !(S.compare.fileA && S.compare.fileB);
}

function setCompareView(view, btn) {
  S.compare.view = view;
  document.querySelectorAll('.ctab').forEach(function(b){ b.classList.remove('on'); });
  btn.classList.add('on');
  renderComparePage(S.compare.currentPage);
}

function compareNavPage(dir) {
  var np = S.compare.currentPage + dir;
  if (np < 0 || np >= S.compare.pages.length) return;
  S.compare.currentPage = np;
  renderComparePage(np);
  document.getElementById('cpn-info').textContent = 'Page '+(np+1)+' of '+S.compare.pages.length;
  document.getElementById('cpn-prev').disabled = np === 0;
  document.getElementById('cpn-next').disabled = np === S.compare.pages.length - 1;
}

async function comparePDFs() {
  if (!S.compare.fileA || !S.compare.fileB) { toast('⚠️ Please select both PDFs'); return; }
  if (typeof pdfjsLib === 'undefined') { toast('❌ PDF.js not loaded'); return; }
  document.getElementById('btn-compare').disabled = true;
  document.getElementById('res-compare').style.display = 'none';
  setBar('compare', 3, 'Loading PDFs…');
  try {
    var abA = await readAB(S.compare.fileA);
    var abB = await readAB(S.compare.fileB);
    var pdfA = await pdfjsLib.getDocument({ data: new Uint8Array(abA) }).promise;
    var pdfB = await pdfjsLib.getDocument({ data: new Uint8Array(abB) }).promise;
    var totalA = pdfA.numPages, totalB = pdfB.numPages;
    var total  = Math.max(totalA, totalB);
    S.compare.pages = [];
    var totalDiffPixels = 0, totalPixels = 0, changedPages = 0;
    var SCALE = 1.5;
    var compareLimit = Math.min(total, 20);
    if (total > 20) toast('⚠️ Large PDF — comparing first 20 pages only');
    for (var i = 0; i < compareLimit; i++) {
      setBar('compare', Math.round(3+(i/total)*88), 'Comparing page '+(i+1)+' of '+total+'…');
      var canvasA = document.createElement('canvas');
      var canvasB = document.createElement('canvas');
      if (i < totalA) {
        var pageA = await pdfA.getPage(i+1);
        var vpA   = pageA.getViewport({ scale: SCALE });
        canvasA.width=Math.ceil(vpA.width); canvasA.height=Math.ceil(vpA.height);
        var ctxA=canvasA.getContext('2d'); ctxA.fillStyle='#ffffff'; ctxA.fillRect(0,0,canvasA.width,canvasA.height);
        await pageA.render({ canvasContext: ctxA, viewport: vpA }).promise;
        pageA.cleanup();
      }
      if (i < totalB) {
        var pageB = await pdfB.getPage(i+1);
        var vpB   = pageB.getViewport({ scale: SCALE });
        canvasB.width=Math.ceil(vpB.width); canvasB.height=Math.ceil(vpB.height);
        var ctxB=canvasB.getContext('2d'); ctxB.fillStyle='#ffffff'; ctxB.fillRect(0,0,canvasB.width,canvasB.height);
        await pageB.render({ canvasContext: ctxB, viewport: vpB }).promise;
        pageB.cleanup();
      }
      var W=Math.max(canvasA.width||0,canvasB.width||10), H=Math.max(canvasA.height||0,canvasB.height||10);
      var canvasDiff=document.createElement('canvas'); canvasDiff.width=W; canvasDiff.height=H;
      var ctxD=canvasDiff.getContext('2d');
      if(canvasA.width>0){ctxD.globalAlpha=1;ctxD.drawImage(canvasA,0,0,W,H);}
      else{ctxD.fillStyle='#ffffff';ctxD.fillRect(0,0,W,H);}
      var tmpA=document.createElement('canvas'); tmpA.width=W; tmpA.height=H;
      var tctxA=tmpA.getContext('2d'); tctxA.fillStyle='#ffffff'; tctxA.fillRect(0,0,W,H);
      if(canvasA.width>0) tctxA.drawImage(canvasA,0,0,W,H);
      var imgDataA=tctxA.getImageData(0,0,W,H);
      var tmpB=document.createElement('canvas'); tmpB.width=W; tmpB.height=H;
      var tctxB=tmpB.getContext('2d'); tctxB.fillStyle='#ffffff'; tctxB.fillRect(0,0,W,H);
      if(canvasB.width>0) tctxB.drawImage(canvasB,0,0,W,H);
      var imgDataB=tctxB.getImageData(0,0,W,H);
      var diffData=ctxD.createImageData(W,H);
      var dA=imgDataA.data,dB=imgDataB.data,dOut=diffData.data,pageDiff=0;
      for(var px=0;px<dA.length;px+=4){
        var dr=Math.abs(dA[px]-dB[px]),dg=Math.abs(dA[px+1]-dB[px+1]),db=Math.abs(dA[px+2]-dB[px+2]);
        var diff=(dr+dg+db)/3;
        if(diff>15){
          pageDiff++;
          if(dB[px]<dA[px]||dB[px+1]<dA[px+1]){dOut[px]=0;dOut[px+1]=184;dOut[px+2]=148;dOut[px+3]=200;}
          else{dOut[px]=231;dOut[px+1]=76;dOut[px+2]=60;dOut[px+3]=200;}
        } else {
          dOut[px]=Math.round(dA[px]*0.35+255*0.65);
          dOut[px+1]=Math.round(dA[px+1]*0.35+255*0.65);
          dOut[px+2]=Math.round(dA[px+2]*0.35+255*0.65);
          dOut[px+3]=255;
        }
      }
      ctxD.putImageData(diffData,0,0);
      var pagePixels=W*H, diffPct=((pageDiff/pagePixels)*100).toFixed(1);
      totalDiffPixels+=pageDiff; totalPixels+=pagePixels;
      if(pageDiff>pagePixels*0.001) changedPages++;
      S.compare.pages.push({ canvasA:canvasA, canvasB:canvasB, canvasDiff:canvasDiff, W:W, H:H, diffPct:diffPct, hasDiff:pageDiff>pagePixels*0.001 });
    }
    setBar('compare', 98, 'Building report…');
    S.compare.currentPage = 0;
    S.compare.view = 'diff';
    document.querySelectorAll('.ctab').forEach(function(b,i){ b.classList.toggle('on', i===0); });
    var overallDiff=((totalDiffPixels/totalPixels)*100).toFixed(1);
    var statsEl=document.getElementById('compare-stats');
    statsEl.innerHTML='<div class="cstat"><div class="cstat-val">'+changedPages+'/'+compareLimit+'</div><div class="cstat-lbl">Pages Changed</div></div>'
      +'<div class="cstat"><div class="cstat-val">'+overallDiff+'%</div><div class="cstat-lbl">Content Diff</div></div>'
      +'<div class="cstat"><div class="cstat-val">'+(total-changedPages)+'</div><div class="cstat-lbl">Identical Pages</div></div>';
    setBar('compare', 100, 'Done!');
    document.getElementById('res-compare').style.display = 'block';
    document.getElementById('cpn-prev').disabled = true;
    document.getElementById('cpn-next').disabled = compareLimit <= 1;
    document.getElementById('cpn-info').textContent = 'Page 1 of ' + compareLimit;
    renderComparePage(0);
    document.getElementById('dl-compare').onclick = function(){ downloadDiffReport(); };
    var suffix = compareLimit < total ? ' (first '+compareLimit+' pages)' : '';
    toast(changedPages===0 ? '✅ PDFs are identical'+suffix+'!' : '🔍 Found differences on '+changedPages+' page(s)'+suffix);
  } catch(e) { console.error(e); hideBar('compare'); toast('❌ ' + e.message); }
  document.getElementById('btn-compare').disabled = false;
}

function renderComparePage(idx) {
  var pg = S.compare.pages[idx], view = S.compare.view;
  var area = document.getElementById('compare-canvas-area');
  area.innerHTML = '';
  if (!pg) return;
  if (view === 'diff') {
    var wrap = document.createElement('div'); wrap.className = 'compare-canvas-wrap';
    var c = document.createElement('canvas'); c.width=pg.canvasDiff.width; c.height=pg.canvasDiff.height;
    c.getContext('2d').drawImage(pg.canvasDiff,0,0);
    var badge=document.createElement('div');
    badge.style.cssText='position:absolute;top:8px;right:8px;background:'+(pg.hasDiff?'#e74c3c':'#00b894')+';color:#fff;font-size:.7rem;font-weight:700;padding:3px 10px;border-radius:100px;font-family:Syne,sans-serif;';
    badge.textContent=pg.hasDiff?pg.diffPct+'% different':'Identical';
    wrap.appendChild(c); wrap.appendChild(badge); area.appendChild(wrap);
  } else if (view === 'side') {
    var sbs=document.createElement('div'); sbs.className='compare-side-by-side';
    ['A','B'].forEach(function(s){
      var col=document.createElement('div');
      var lbl=document.createElement('div'); lbl.className='compare-side-label'; lbl.textContent=s==='A'?'Original':'Modified';
      var wrap2=document.createElement('div'); wrap2.className='compare-canvas-wrap';
      var src=s==='A'?pg.canvasA:pg.canvasB;
      var c2=document.createElement('canvas');
      if(src&&src.width>0){c2.width=src.width;c2.height=src.height;c2.getContext('2d').drawImage(src,0,0);}
      else{c2.width=100;c2.height=141;var cx2=c2.getContext('2d');cx2.fillStyle='#fff';cx2.fillRect(0,0,100,141);cx2.fillStyle='#ccc';cx2.font='12px sans-serif';cx2.fillText('No page',20,75);}
      wrap2.appendChild(c2); col.appendChild(lbl); col.appendChild(wrap2); sbs.appendChild(col);
    });
    area.appendChild(sbs);
  } else {
    var src3=view==='original'?pg.canvasA:pg.canvasB;
    var wrap3=document.createElement('div'); wrap3.className='compare-canvas-wrap';
    var c3=document.createElement('canvas');
    if(src3&&src3.width>0){c3.width=src3.width;c3.height=src3.height;c3.getContext('2d').drawImage(src3,0,0);}
    else{c3.width=400;c3.height=565;var cx3=c3.getContext('2d');cx3.fillStyle='#fff';cx3.fillRect(0,0,400,565);cx3.fillStyle='#ccc';cx3.font='20px sans-serif';cx3.fillText('Page not in this PDF',80,290);}
    wrap3.appendChild(c3); area.appendChild(wrap3);
  }
}

async function downloadDiffReport() {
  if (!S.compare.pages.length) return;
  try {
    toast('⏳ Building PDF report…');
    var newDoc = await PDFLib.PDFDocument.create();
    for (var i = 0; i < S.compare.pages.length; i++) {
      var pg2 = S.compare.pages[i], W2=pg2.W, H2=pg2.H;
      var rc2=document.createElement('canvas'); rc2.width=W2*2+20; rc2.height=H2+60;
      var rctx=rc2.getContext('2d');
      rctx.fillStyle='#1a1916'; rctx.fillRect(0,0,rc2.width,rc2.height);
      rctx.fillStyle='#f5a623'; rctx.fillRect(0,0,rc2.width,40);
      rctx.fillStyle='#000'; rctx.font='bold 16px sans-serif';
      rctx.fillText('Folio Drop — Comparison Report   Page '+(i+1)+' of '+S.compare.pages.length,12,26);
      if(pg2.canvasA&&pg2.canvasA.width>0) rctx.drawImage(pg2.canvasA,0,46,W2,H2);
      rctx.drawImage(pg2.canvasDiff,W2+20,46,W2,H2);
      rctx.fillStyle='rgba(0,0,0,0.6)'; rctx.fillRect(0,46,80,22); rctx.fillRect(W2+20,46,60,22);
      rctx.fillStyle='#fff'; rctx.font='11px sans-serif'; rctx.fillText('Original',8,62); rctx.fillText('Diff',W2+28,62);
      rctx.fillStyle=pg2.hasDiff?'#e74c3c':'#00b894'; rctx.fillRect(rc2.width-120,46,120,22);
      rctx.fillStyle='#fff'; rctx.font='bold 11px sans-serif';
      rctx.fillText(pg2.hasDiff?pg2.diffPct+'% different':'Identical',rc2.width-112,62);
      var jpegUrl2=rc2.toDataURL('image/jpeg',0.88);
      var b642=jpegUrl2.slice(jpegUrl2.indexOf(',')+1);
      var jpegBytes2=Uint8Array.from(atob(b642),function(c){ return c.charCodeAt(0); });
      var img2=await newDoc.embedJpg(jpegBytes2);
      var page3=newDoc.addPage([rc2.width*0.75,rc2.height*0.75]);
      page3.drawImage(img2,{x:0,y:0,width:rc2.width*0.75,height:rc2.height*0.75});
    }
    var bytes2=await newDoc.save();
    dlBlob(bytes2,'comparison-report.pdf');
    toast('✅ Report downloaded!');
  } catch(e){ toast('❌ Report error: '+e.message); }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AI FEATURES
// Calls this app's own /api/* serverless functions (see /api and
// README-AI.md) — the browser never sees a Groq/Gemini key. These only
// work once deployed on Vercel with the env vars configured; opening
// index.html via file:// will hit the catch block below with a clear
// explanation rather than a confusing network error.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function extractPdfPageTexts(file, maxPages) {
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js not loaded');
  var ab  = await readAB(file);
  var pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  var total = maxPages ? Math.min(pdf.numPages, maxPages) : pdf.numPages;
  var pages = [];
  for (var i = 1; i <= total; i++) {
    var page    = await pdf.getPage(i);
    var content = await page.getTextContent();
    var text    = content.items.map(function(it){ return it.str; }).join(' ');
    page.cleanup();
    pages.push({ page: i, text: text });
  }
  return { pages: pages, totalPages: pdf.numPages };
}

async function callAiEndpoint(path, body) {
  var r;
  try {
    r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error('Could not reach the AI proxy. This feature only works when the app is deployed on Vercel (see README-AI.md) — it won\u2019t work opened directly as a file.');
  }
  var data = null;
  try { data = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok) {
    throw new Error((data && data.error) || ('AI request failed (HTTP ' + r.status + ')'));
  }
  return data;
}

// ── AI Summarize ────────────────────────────────────────────────────
async function summarizeWithAI() {
  if (!S.summarize.files.length) { toast('⚠️ Please select a PDF'); return; }
  var file = S.summarize.files[0];
  document.getElementById('btn-summarize').disabled = true;
  setBar('summarize', 15, 'Reading PDF…');
  try {
    var extracted = await extractPdfPageTexts(file, 40); // cap pages read for speed/cost
    var fullText  = extracted.pages.map(function(p){ return p.text; }).join('\n\n');
    if (!fullText.trim()) {
      throw new Error('No extractable text found — this may be a scanned/image-only PDF (OCR isn\u2019t available yet).');
    }
    setBar('summarize', 45, 'Asking the AI…');
    var result = await callAiEndpoint('/api/summarize', { text: fullText });
    setBar('summarize', 100, 'Done!');

    var list = document.getElementById('summarize-bullets');
    list.innerHTML = '';
    result.summary.forEach(function(point) {
      var li = document.createElement('li');
      li.textContent = point;
      list.appendChild(li);
    });
    document.getElementById('summarize-filename').textContent = result.filename + '.pdf';
    document.getElementById('summarize-source').textContent = 'Answered by: ' + (result.source === 'groq' ? 'Groq' : 'Gemini');
    document.getElementById('dl-summarize').onclick = function() {
      var blob = new Blob([file], { type: 'application/pdf' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = result.filename + '.pdf';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
    };
    document.getElementById('res-summarize').classList.add('on');
    toast('✅ Summary ready!');
  } catch (e) { hideBar('summarize'); toast('❌ ' + e.message); }
  document.getElementById('btn-summarize').disabled = false;
}

// ── AI: Suggest Split Points (used inside the Split tool) ──────────
async function suggestSplitPoints() {
  if (!S.split.files.length) { toast('⚠️ Please select a PDF first'); return; }
  var btn = document.getElementById('ai-split-btn');
  var statusEl = document.getElementById('ai-split-status');
  btn.disabled = true;
  statusEl.textContent = '🧠 Reading pages…';
  statusEl.style.display = '';
  try {
    var extracted = await extractPdfPageTexts(S.split.files[0], 60); // cap pages read for speed/cost
    statusEl.textContent = '🧠 Asking the AI…';
    var result = await callAiEndpoint('/api/smart-split', { pages: extracted.pages });
    if (!result.splits.length) {
      statusEl.textContent = 'ℹ️ ' + (result.reason || 'No clear split points found — this looks like one continuous document.');
      toast('ℹ️ No split points suggested');
    } else {
      var breakpoints = [1].concat(result.splits).concat([extracted.totalPages + 1]);
      var ranges = [];
      for (var i = 0; i < breakpoints.length - 1; i++) {
        var start = breakpoints[i], end = breakpoints[i+1] - 1;
        ranges.push(start === end ? ('' + start) : (start + '-' + end));
      }
      setSplitMode('range');
      document.getElementById('split-range-val').value = ranges.join(', ');
      statusEl.textContent = '✅ ' + (result.reason || ('Suggested ' + ranges.length + ' sections')) + ' — review the ranges above before splitting.';
      toast('✅ Split points suggested — review before running');
    }
  } catch (e) { statusEl.textContent = '❌ ' + e.message; toast('❌ ' + e.message); }
  btn.disabled = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MOBILE NAV DRAWER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function openNavDrawer() {
  document.getElementById('nav-drawer-overlay').classList.add('on');
  document.body.style.overflow = 'hidden';
}
function closeNavDrawer() {
  document.getElementById('nav-drawer-overlay').classList.remove('on');
  document.body.style.overflow = '';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ANDROID BACK GESTURE — History API
// FIX: showHome now uses replaceState (not pushState) so back-button
//      navigation converges cleanly without building infinite history.
//      Seed only one extra "buffer" entry instead of two to avoid
//      double-back required to leave the app on some Android versions.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
window.addEventListener('popstate', function(e) {
  var state = e.state;
  _fromPopstate = true;
  try {
    if (state && state.view === 'tool') {
      openTool(state.tool);
    } else {
      showHome();
    }
  } finally {
    _fromPopstate = false;
  }
});

// Seed one buffer home entry so back from home stays in-app
(function() {
  try {
    history.replaceState({ view: 'home' }, '', location.pathname + location.search);
    history.pushState({ view: 'home' }, '', location.pathname + location.search);
  } catch(e){}
})();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SERVICE WORKER — app-shell caching so the toolkit still opens offline.
// Silently no-ops when unsupported (e.g. opened via file:// or an
// unsecured origin), so this never breaks the app.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline support unavailable; app still works online */ });
  });
}
