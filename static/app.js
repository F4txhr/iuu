// Socket
const socket = io();

socket.on('connect', ()=>{ try{ toast('Connected'); }catch{} socket.emit('terminal_new'); if(!cwd) listDir(); });
socket.on('disconnect', ()=>{ try{ toast('Disconnected'); }catch{} });
socket.on('connect_error', (err)=>{ console.error('Socket connect_error', err); try{ toast('Socket error'); }catch{} });

// State
let cwd = localStorage.getItem('cwd') || "";
let activeFilePath = null;
let monacoEditor = null;
let terminals = {}; // tid -> {term, fitAddon, searchAddon}
let activeTid = null;
let theme = localStorage.getItem('theme') || 'dark';
if(theme==='light') document.body.setAttribute('data-theme','light');

function toast(msg) { const t=document.getElementById("toast"); if(!t) return; t.textContent=msg;t.style.display="block"; setTimeout(()=>{t.style.display="none";},2500); }

// Elements
const fileExplorer = document.getElementById("file-explorer");
const fileListBody = document.getElementById("file-list-body");
const breadcrumb = document.getElementById("cwd-breadcrumb");
const contextMenu = document.getElementById("context-menu");
const fileListContainer = document.getElementById("file-list-container");
const feToggle = document.getElementById("fe-toggle");
const termContainer = document.getElementById("terminal-container");
const editorContainer = document.getElementById("editor");
const topbarTitle = document.getElementById("active-file");
const saveBtn = document.getElementById("save-btn");
const refreshBtn = document.getElementById("fe-refresh");
const themeToggle = document.getElementById("theme-toggle");

// Terminal tabs bar
const tabsBar = document.createElement('div');
tabsBar.style.height='32px'; tabsBar.style.display='flex'; tabsBar.style.alignItems='center'; tabsBar.style.background='var(--panel2)'; tabsBar.style.borderBottom='1px solid var(--border)';
const newTabBtn = document.createElement('button'); newTabBtn.textContent = '+'; newTabBtn.style.margin='0 6px';
tabsBar.appendChild(newTabBtn);
if(termContainer) termContainer.prepend(tabsBar);

function createXterm(){
  const t = new Terminal({ theme:{background:getComputedStyle(document.body).getPropertyValue('--bg').trim()||"#181a20"}, fontSize:14, scrollback: 5000 });
  try{
    const fitAddon = new FitAddon.FitAddon();
    const webLinks = new WebLinksAddon.WebLinksAddon();
    const searchAddon = new SearchAddon.SearchAddon();
    t.loadAddon(fitAddon); t.loadAddon(webLinks); t.loadAddon(searchAddon);
    return { t, fitAddon, searchAddon };
  }catch{ return { t, fitAddon:null, searchAddon:null }; }
}

function renderTabs(){
  if(!tabsBar) return;
  [...tabsBar.querySelectorAll('.ttab')].forEach(n=>n.remove());
  Object.keys(terminals).forEach(tid=>{
    const b = document.createElement('button'); b.className='ttab'; b.textContent = `sh ${tid}`;
    b.style.margin='0 4px'; b.style.padding='3px 6px'; b.style.background = (tid===activeTid?'#23272e':'#1b1e23'); b.style.color='var(--fg)'; b.onclick=()=>activateTid(tid);
    const close = document.createElement('span'); close.textContent=' ×'; close.style.cursor='pointer'; close.onclick=(e)=>{ e.stopPropagation(); closeTid(tid); };
    b.appendChild(close);
    tabsBar.insertBefore(b, newTabBtn);
  });
}

function mountTerminal(tid){
  if(!termContainer) return;
  termContainer.querySelector('#terminal')?.remove();
  const node = document.createElement('div'); node.id='terminal'; node.style.position='absolute'; node.style.left=0; node.style.right=0; node.style.top='32px'; node.style.bottom=0;
  termContainer.appendChild(node);
  const ent = terminals[tid]; if(!ent) return; const t = ent.term;
  t.open(node);
  setTimeout(()=>{ try{ ent.fitAddon && ent.fitAddon.fit(); }catch{} }, 0);
  t.focus();
}

function activateTid(tid){ activeTid = tid; renderTabs(); mountTerminal(tid); localStorage.setItem('activeTid', tid); }

function closeTid(tid){
  socket.emit('terminal_close', { tid });
  const wasActive = (tid===activeTid);
  try { terminals[tid].term.dispose(); } catch {}
  delete terminals[tid];
  if(wasActive){ const first = Object.keys(terminals)[0]; if(first){ activateTid(first); } else { termContainer?.querySelector('#terminal')?.remove(); activeTid=null; localStorage.removeItem('activeTid'); } }
  renderTabs();
}

newTabBtn.onclick = ()=> socket.emit('terminal_new');

// Socket handlers
socket.on('terminal_started', ({tid})=>{
  const { t, fitAddon, searchAddon } = createXterm();
  t.onData(d => socket.emit('terminal_input', { tid, data: d }));
  terminals[tid] = { term: t, fitAddon, searchAddon };
  if(!activeTid){ activeTid = tid; }
  renderTabs();
  if(activeTid===tid){ mountTerminal(tid); }
});

socket.on('terminal_output', ({tid, data})=>{ const ent = terminals[tid]; if(ent){ ent.term.write(data); } });

// Shortcuts
document.addEventListener('keydown', e=>{
  if(e.ctrlKey && e.key==="l"){ if(activeTid) socket.emit('terminal_clear', { tid: activeTid }); e.preventDefault(); }
  if(e.key==="Escape"){ fileExplorer?.classList.add("collapsed"); const pm=document.getElementById("preview-modal"); if(pm) pm.style.display="none"; }
  if(e.ctrlKey && (e.key==="s" || e.key==="S")){ e.preventDefault(); saveActiveFile(); }
  if(e.ctrlKey && (e.key==="p" || e.key==="P")){ e.preventDefault(); openQuickOpen(); }
  if(e.ctrlKey && (e.key==="f" || e.key==="F")){ const ent=terminals[activeTid]; if(ent&&ent.searchAddon){ const q=prompt('Find in terminal:'); if(q){ try{ ent.searchAddon.findNext(q); }catch{} } } }
});

// Theme toggle
themeToggle && (themeToggle.onclick = ()=>{ theme = (theme==='dark'?'light':'dark'); if(theme==='light') document.body.setAttribute('data-theme','light'); else document.body.removeAttribute('data-theme'); localStorage.setItem('theme', theme); Object.values(terminals).forEach(ent=>{ try{ ent.fitAddon && ent.fitAddon.fit(); }catch{} }); });

// Monaco
window.require && window.require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.51.0/min/vs' } });
window.require && window.require(['vs/editor/editor.main'], function(){ monacoEditor = monaco.editor.create(editorContainer, { value: '', language: 'plaintext', theme: theme==='light'?'vs':'vs-dark', automaticLayout: true, fontFamily: 'Fira Code, Fira Mono, monospace', fontSize: 14, minimap: { enabled: false }, renderWhitespace: 'selection', wordWrap: 'on' }); });

function setEditorLanguageByExt(path){ if(!window.monaco || !monacoEditor) return; const ext = (path.split('.').pop()||'').toLowerCase(); const map = { js:'javascript', ts:'typescript', py:'python', json:'json', md:'markdown', html:'html', css:'css', sh:'shell', yml:'yaml', yaml:'yaml' }; monaco.editor.setModelLanguage(monacoEditor.getModel(), map[ext] || 'plaintext'); }

// Breadcrumbs
function renderBreadcrumbs(path) { if(!breadcrumb) return; breadcrumb.innerHTML = ''; const parts = path.split('/').filter(p => p); let currentPath = ''; const home = document.createElement('a'); home.href = '#'; home.textContent = '🏠'; home.onclick = (e) => { e.preventDefault(); listDir('/'); }; breadcrumb.appendChild(home); for (const part of parts) { currentPath += `/${part}`; const sep = document.createElement('span'); sep.textContent = ' > '; breadcrumb.appendChild(sep); const link = document.createElement('a'); link.href = '#'; link.textContent = part; ((p) => { link.onclick = (e) => { e.preventDefault(); listDir(p); }; })(currentPath); breadcrumb.appendChild(link); } }

// Directory list with simple virtualization
function listDir(path){ const url = path ? `/api/list?path=${encodeURIComponent(path)}` : '/api/list'; fetch(url).then(r=>r.json()).then(res=>{ if(res.error){ toast(res.error); return; } cwd = res.cwd; localStorage.setItem('cwd', cwd); renderBreadcrumbs(cwd); renderFilesVirtual(res.items || []); }).catch(err=>{ console.error('list error', err); toast('Gagal load list'); }); }

function renderFilesVirtual(items){ if(!fileListBody||!fileListContainer) return; fileListBody.innerHTML=''; const rowHeight=28; const container = fileListContainer; const total=items.length; const viewport=()=>{ const visible = Math.ceil(container.clientHeight/rowHeight)+10; const scrollTop = container.scrollTop; const start = Math.max(0, Math.floor(scrollTop/rowHeight)-5); const end = Math.min(total, start+visible); fileListBody.innerHTML=''; const topH = start*rowHeight; const bottomH = (total-end)*rowHeight; const topTr=document.createElement('tr'); topTr.style.height=topH+'px'; fileListBody.appendChild(topTr); for(let i=start;i<end;i++){ const f=items[i]; const row = fileListBody.insertRow(); row.className = f.is_dir ? 'fe-folder' : 'fe-file'; const fullPath = cwd.replace(/\/+$/,"")+"/"+f.name; const nameCell=row.insertCell(); nameCell.textContent=(f.is_dir?"📁 ":"📄 ")+f.name; nameCell.onclick = f.is_dir ? ()=>listDir(fullPath) : ()=>openFile(fullPath, f); row.insertCell().textContent=f.size; row.insertCell().textContent=f.modified; const menuBtn=document.createElement('button'); menuBtn.textContent='…'; menuBtn.className='ctx-menu-btn'; menuBtn.onclick=e=>{ e.stopPropagation(); contextTarget={ path: fullPath, is_dir: f.is_dir, is_txt: f.is_txt, name: f.name }; contextMenu.style.display='flex'; const rect=e.target.getBoundingClientRect(); contextMenu.style.top=`${rect.bottom}px`; contextMenu.style.left=`${rect.left - contextMenu.offsetWidth + rect.width}px`; document.querySelector('[data-action="run"]').style.display = (contextTarget.is_txt && (contextTarget.name.endsWith('.py') || contextTarget.name.endsWith('.sh'))) ? 'block' : 'none'; document.querySelector('[data-action="download"]').style.display = contextTarget.is_dir ? 'none' : 'block'; }; row.insertCell().appendChild(menuBtn); } const bottomTr=document.createElement('tr'); bottomTr.style.height=bottomH+'px'; fileListBody.appendChild(bottomTr); }; container.onscroll=viewport; viewport(); }

// File open/save
function openFile(path, meta){ activeFilePath = path; if(topbarTitle) topbarTitle.textContent = path; if(meta && meta.is_img){ previewFile(path, meta); return; } fetch(`/api/read-file?path=${encodeURIComponent(path)}`).then(r=>r.json()).then(res=>{ if(!res.ok){ toast(res.error||'Gagal membuka file'); return; } if(monacoEditor){ monacoEditor.setValue(res.data||''); setEditorLanguageByExt(path); } }).catch(err=>{ console.error('read error', err); toast('Gagal membuka file'); }); }
function saveActiveFile(){ if(!activeFilePath){ toast('Tidak ada file aktif'); return; } const data = monacoEditor ? monacoEditor.getValue() : ''; fetch('/api/save-file',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: activeFilePath, data })}).then(r=>r.json()).then(res=>{ if(res.ok){ toast('Tersimpan'); listDir(cwd); } else toast(res.error||'Gagal menyimpan'); }).catch(err=>{ console.error('save error', err); toast('Gagal menyimpan'); }); }

// Context menu
let contextTarget = null;
contextMenu && contextMenu.addEventListener('click', e => { if(!contextTarget || !e.target.matches('[data-action]')) return; const action = e.target.dataset.action; const { path } = contextTarget; switch(action){ case 'delete': if(!confirm(`Are you sure you want to delete ${path}?`)) return; fetch('/api/delete',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:path})}).then(r=>r.json()).then(res=>{ if(res.ok) listDir(cwd); else toast(res.error||"Gagal menghapus"); }).catch(()=>toast('Gagal menghapus')); break; case 'rename': const newName = prompt(`Enter new name for ${path}:`, path.split('/').pop()); if(!newName) return; fetch('/api/rename',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({old_path:path, new_name:newName})}).then(r=>r.json()).then(res=>{ if(res.ok) listDir(cwd); else toast(res.error||"Gagal rename"); }).catch(()=>toast('Gagal rename')); break; case 'download': window.open(`/api/download?path=${encodeURIComponent(path)}`); break; case 'run': const cmd = path.endsWith('.py') ? 'python' : 'bash'; if(activeTid) socket.emit('terminal_input', { tid: activeTid, data: `${cmd} "${path}"\n` }); break; } });

document.addEventListener('click', ()=>contextMenu && (contextMenu.style.display="none"));
feToggle && (feToggle.onclick = ()=> fileExplorer && fileExplorer.classList.toggle("collapsed"));
refreshBtn && (refreshBtn.onclick = ()=> listDir(cwd));
saveBtn && (saveBtn.onclick = saveActiveFile);

// Preview
function previewFile(path, meta){ fetch(`/api/preview?path=${encodeURIComponent(path)}`).then(r=>r.json()).then(res=>{ const modal = document.getElementById("preview-modal"); const pc = document.getElementById("preview-content"); if(!modal||!pc) return; if(res.type==="img"){ pc.innerHTML = `<img src="${res.data}" style="max-width:70vw;max-height:70vh;">`; }else if(res.type==="txt"){ pc.innerHTML = `<pre style="max-width:70vw;max-height:70vh;overflow:auto;">${escapeHtml(res.data)}</pre>`; }else{ pc.textContent = res.data; } modal.style.display="flex"; }).catch(()=>toast('Gagal preview')); }
document.getElementById("preview-close")?.addEventListener('click', ()=>{ const m=document.getElementById("preview-modal"); if(m) m.style.display='none'; });

// Upload
document.getElementById("fe-upload-btn")?.addEventListener('click', ()=>document.getElementById("fe-upload")?.click());
document.getElementById("fe-upload")?.addEventListener('change', function(){ const files = this.files; if(!files||!files.length) return; const fd = new FormData(); for(let f of files) fd.append('file', f); fetch(`/api/upload?path=${encodeURIComponent(cwd)}`,{method:"POST",body:fd}).then(r=>r.json()).then(res=>{ if(res.ok){ toast("Upload berhasil"); listDir(cwd);} else toast(res.error||"Gagal upload"); }).catch(()=>toast('Gagal upload')); });
if (fileListContainer) { fileListContainer.ondragover = e => {e.preventDefault();}; fileListContainer.ondrop = e => { e.preventDefault(); const files = e.dataTransfer.files; if(!files.length) return; const fd = new FormData(); for (let f of files) fd.append('file', f); fetch(`/api/upload?path=${encodeURIComponent(cwd)}`,{method:"POST",body:fd}).then(r=>r.json()).then(res=>{ if(res.ok){ toast("Upload berhasil"); listDir(cwd);} else toast(res.error||"Gagal upload"); }).catch(()=>toast('Gagal upload')); }; }

// Custom path
document.getElementById("fe-goto")?.addEventListener('click', ()=>{ const input=document.getElementById("custom-path"); const p = input && input.value; if(!p) return; fetch('/api/setcwd',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})}).then(r=>r.json()).then(res=>{ if(res.ok){ listDir(p); toast("Pindah directory!"); } else toast("Path tidak valid"); }).catch(()=>toast('Gagal pindah')); });

document.getElementById("fe-new-file")?.addEventListener('click', ()=>{ const name = prompt("Enter new file name:"); if(!name) return; fetch('/api/create-file',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:cwd, name:name})}).then(r=>r.json()).then(res=>{ if(res.ok) listDir(cwd); else toast(res.error || "Gagal membuat file"); }).catch(()=>toast('Gagal membuat file')); });
document.getElementById("fe-new-dir")?.addEventListener('click', ()=>{ const name = prompt("Enter new folder name:"); if(!name) return; fetch('/api/create-dir',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:cwd, name:name})}).then(r=>r.json()).then(res=>{ if(res.ok) listDir(cwd); else toast(res.error || "Gagal membuat folder"); }).catch(()=>toast('Gagal membuat folder')); });

function escapeHtml(str){ return str.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]); }

// Splitter
(function(){ const split = document.getElementById('h-split'); if(!split) return; let dragging=false,startY=0,startTop=0,startBottom=0; split.addEventListener('mousedown',(e)=>{ dragging=true; startY=e.clientY; startTop=editorContainer?.getBoundingClientRect().height||0; startBottom=termContainer?.getBoundingClientRect().height||0; document.body.style.cursor='row-resize'; }); window.addEventListener('mousemove',(e)=>{ if(!dragging) return; const dy=e.clientY-startY; const newTop=Math.max(120,startTop+dy); const newBottom=Math.max(120,startBottom-dy); if(editorContainer) editorContainer.style.flexBasis=newTop+'px'; if(termContainer) termContainer.style.flexBasis=newBottom+'px'; Object.values(terminals).forEach(ent=>{ try{ ent.fitAddon && ent.fitAddon.fit(); }catch{} }); }); window.addEventListener('mouseup',()=>{ if(dragging){ dragging=false; document.body.style.cursor=''; } }); })();

// Quick Open
const qo = document.createElement('div'); qo.style.position='fixed'; qo.style.left='50%'; qo.style.top='20%'; qo.style.transform='translateX(-50%)'; qo.style.background='#222'; qo.style.border='1px solid #444'; qo.style.padding='8px'; qo.style.display='none'; qo.style.zIndex=2000; qo.style.width='600px';
const qoInput = document.createElement('input'); qoInput.type='text'; qoInput.placeholder='Quick Open (type to search)'; qoInput.style.width='100%'; qoInput.style.padding='6px'; qoInput.style.background='#111'; qoInput.style.color='#fff'; qoInput.style.border='1px solid #333';
const qoList = document.createElement('div'); qoList.style.maxHeight='50vh'; qoList.style.overflow='auto'; qoList.style.marginTop='6px';
qo.appendChild(qoInput); qo.appendChild(qoList); document.body.appendChild(qo);

function openQuickOpen(){ qo.style.display='block'; qoInput.value=''; qoList.innerHTML=''; qoInput.focus(); selectedIdx=-1; }
function closeQuickOpen(){ qo.style.display='none'; }

let selectedIdx=-1; let lastResults=[]; function renderQO(){ qoList.innerHTML=''; lastResults.forEach((r,i)=>{ const div=document.createElement('div'); div.className='qo-item'; div.dataset.path=r.path; div.textContent=r.path; div.style.padding='4px 6px'; div.style.cursor='pointer'; if(i===selectedIdx) div.style.background='#2a2f3a'; div.onmouseenter=()=>{ selectedIdx=i; renderQO(); }; div.onclick=()=>{ openQOItem(r); }; qoList.appendChild(div); }); }
function openQOItem(r){ closeQuickOpen(); if(r.is_dir) listDir(r.path); else openFile(r.path,{is_img:false}); }

(function(){ let timer=null; qoInput.addEventListener('keydown',(e)=>{ if(e.key==='Escape'){ closeQuickOpen(); } else if(e.key==='ArrowDown'){ selectedIdx=Math.min((selectedIdx+1),(lastResults.length-1)); renderQO(); e.preventDefault(); } else if(e.key==='ArrowUp'){ selectedIdx=Math.max((selectedIdx-1),0); renderQO(); e.preventDefault(); } else if(e.key==='Enter'){ if(selectedIdx>=0&&lastResults[selectedIdx]) openQOItem(lastResults[selectedIdx]); else { const item=qoList.querySelector('.qo-item'); if(item){ openQOItem({ path:item.dataset.path, is_dir:false }); } } } }); qoInput.addEventListener('input', ()=>{ clearTimeout(timer); const q=qoInput.value.trim(); if(!q){ qoList.innerHTML=''; lastResults=[]; return; } timer=setTimeout(()=>{ fetch('/api/search?q='+encodeURIComponent(q)).then(r=>r.json()).then(res=>{ lastResults=res.results||[]; selectedIdx=lastResults.length?0:-1; renderQO(); }).catch(()=>{ lastResults=[]; qoList.innerHTML=''; }); }, 200); }); })();

// Window resize -> fit terminal
window.addEventListener('resize', ()=>{ Object.values(terminals).forEach(ent=>{ try{ ent.fitAddon && ent.fitAddon.fit(); }catch{} }); });

// Init
listDir(cwd);
