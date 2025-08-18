const term = new Terminal({ theme:{background:"#181a20"}, fontSize:15 });
const socket = io();
let cwd = "";
let activeFilePath = null;
let monacoEditor = null;

function toast(msg) {
  const t=document.getElementById("toast");
  t.textContent=msg;t.style.display="block";
  setTimeout(()=>{t.style.display="none";},2500);
}

// init layout elements
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

// terminal
term.open(document.createElement('div')); // temp
function mountTerminal(){
  termContainer.innerHTML = '';
  const node = document.createElement('div');
  node.id = 'terminal';
  termContainer.appendChild(node);
  term.open(node);
}
mountTerminal();

// Terminal IO
socket.on('terminal_output', d => term.write(d));
term.onData(d => socket.emit('terminal_input', d));
term.focus();

// Shortcuts
document.addEventListener('keydown', e=>{
  if(e.ctrlKey && e.key==="l"){ socket.emit('terminal_clear'); e.preventDefault(); }
  if(e.key==="Escape"){
    fileExplorer.classList.add("collapsed");
    document.getElementById("preview-modal").style.display="none";
  }
  if(e.ctrlKey && (e.key==="s" || e.key==="S")){
    e.preventDefault();
    saveActiveFile();
  }
});

// Monaco loader
window.require && window.require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.51.0/min/vs' } });
window.require && window.require(['vs/editor/editor.main'], function(){
  monacoEditor = monaco.editor.create(editorContainer, {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    automaticLayout: true,
    fontFamily: 'Fira Code, Fira Mono, monospace',
    fontSize: 14,
    minimap: { enabled: false },
    renderWhitespace: 'selection',
    wordWrap: 'on'
  });
});

function setEditorLanguageByExt(path){
  if(!window.monaco || !monacoEditor) return;
  const ext = (path.split('.').pop()||'').toLowerCase();
  const map = { js:'javascript', ts:'typescript', py:'python', json:'json', md:'markdown', html:'html', css:'css', sh:'shell', yml:'yaml', yaml:'yaml' };
  const lang = map[ext] || 'plaintext';
  monaco.editor.setModelLanguage(monacoEditor.getModel(), lang);
}

function renderBreadcrumbs(path) {
  breadcrumb.innerHTML = '';
  const parts = path.split('/').filter(p => p);
  let currentPath = '';
  const home = document.createElement('a');
  home.href = '#'; home.textContent = '🏠';
  home.onclick = (e) => { e.preventDefault(); listDir('/'); };
  breadcrumb.appendChild(home);
  for (const part of parts) {
    currentPath += `/${part}`;
    const sep = document.createElement('span');
    sep.textContent = ' > ';
    breadcrumb.appendChild(sep);
    const link = document.createElement('a');
    link.href = '#'; link.textContent = part;
    ((p) => { link.onclick = (e) => { e.preventDefault(); listDir(p); }; })(currentPath);
    breadcrumb.appendChild(link);
  }
}

function listDir(path){
  const url = path ? `/api/list?path=${encodeURIComponent(path)}` : '/api/list';
  fetch(url).then(r=>r.json()).then(res=>{
    if(res.error){ toast(res.error); return; }
    cwd = res.cwd;
    renderBreadcrumbs(cwd);
    fileListBody.innerHTML = "";
    if(cwd!=="/"){
      const up = cwd.replace(/\/+$/,'').replace(/\/[^\/]+$/,'')||"/";
      const row = fileListBody.insertRow();
      row.className = 'fe-folder';
      const cell = row.insertCell(); cell.colSpan = 4; cell.innerHTML = "⬅️ .."; cell.onclick = ()=>listDir(up);
    }
    res.items.forEach(f=>{
      const row = fileListBody.insertRow();
      row.className = f.is_dir ? "fe-folder" : "fe-file";
      const fullPath = cwd.replace(/\/+$/,"")+"/"+f.name;
      const nameCell = row.insertCell();
      nameCell.textContent = (f.is_dir ? "📁 " : "📄 ") + f.name;
      nameCell.onclick = f.is_dir ? ()=>listDir(fullPath) : ()=>openFile(fullPath, f);
      row.insertCell().textContent = f.size;
      row.insertCell().textContent = f.modified;
      const menuBtn = document.createElement("button");
      menuBtn.textContent = "…"; menuBtn.className = "ctx-menu-btn";
      menuBtn.onclick = e => {
        e.stopPropagation();
        contextTarget = { path: fullPath, is_dir: f.is_dir, is_txt: f.is_txt, name: f.name };
        contextMenu.style.display="flex";
        const rect = e.target.getBoundingClientRect();
        contextMenu.style.top = `${rect.bottom}px`;
        contextMenu.style.left = `${rect.left - contextMenu.offsetWidth + rect.width}px`;
        document.querySelector('[data-action="run"]').style.display = (contextTarget.is_txt && (contextTarget.name.endsWith(".py") || contextTarget.name.endsWith(".sh"))) ? 'block' : 'none';
        document.querySelector('[data-action="download"]').style.display = contextTarget.is_dir ? 'none' : 'block';
      };
      row.insertCell().appendChild(menuBtn);
    });
  });
}

function openFile(path, meta){
  activeFilePath = path;
  topbarTitle.textContent = path;
  if(meta && meta.is_img){
    previewFile(path, meta);
    return;
  }
  fetch(`/api/read-file?path=${encodeURIComponent(path)}`).then(r=>r.json()).then(res=>{
    if(!res.ok){ toast(res.error||'Gagal membuka file'); return; }
    if(monacoEditor){ monacoEditor.setValue(res.data||''); setEditorLanguageByExt(path); }
  });
}

function saveActiveFile(){
  if(!activeFilePath){ toast('Tidak ada file aktif'); return; }
  const data = monacoEditor ? monacoEditor.getValue() : '';
  fetch('/api/save-file',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: activeFilePath, data })})
    .then(r=>r.json()).then(res=>{
      if(res.ok){ toast('Tersimpan'); listDir(cwd); }
      else toast(res.error||'Gagal menyimpan');
    });
}

// Context menu actions
let contextTarget = null;
contextMenu.addEventListener('click', e => {
  if(!contextTarget || !e.target.matches('[data-action]')) return;
  const action = e.target.dataset.action;
  const { path } = contextTarget;
  switch(action){
    case 'delete':
      if(!confirm(`Are you sure you want to delete ${path}?`)) return;
      fetch('/api/delete',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:path})})
        .then(r=>r.json()).then(res=>{ if(res.ok) listDir(cwd); else toast(res.error||"Gagal menghapus"); });
      break;
    case 'rename':
      const newName = prompt(`Enter new name for ${path}:`, path.split('/').pop());
      if(!newName) return;
      fetch('/api/rename',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({old_path:path, new_name:newName})})
        .then(r=>r.json()).then(res=>{ if(res.ok) listDir(cwd); else toast(res.error||"Gagal rename"); });
      break;
    case 'download':
      window.open(`/api/download?path=${encodeURIComponent(path)}`);
      break;
    case 'run':
      const cmd = path.endsWith('.py') ? 'python' : 'bash';
      socket.emit('terminal_input', `${cmd} "${path}"\n`);
      break;
  }
});

document.addEventListener('click', ()=>contextMenu.style.display="none");
feToggle.onclick = ()=> fileExplorer.classList.toggle("collapsed");
refreshBtn.onclick = ()=> listDir(cwd);
saveBtn.onclick = saveActiveFile;

// Preview modal
function previewFile(path, meta){
  fetch(`/api/preview?path=${encodeURIComponent(path)}`).then(r=>r.json()).then(res=>{
    const modal = document.getElementById("preview-modal");
    const pc = document.getElementById("preview-content");
    if(res.type==="img"){
      pc.innerHTML = `<img src="${res.data}" style="max-width:70vw;max-height:70vh;">`;
    }else if(res.type==="txt"){
      pc.innerHTML = `<pre style="max-width:70vw;max-height:70vh;overflow:auto;">${escapeHtml(res.data)}</pre>`;
    }else{
      pc.textContent = res.data;
    }
    modal.style.display="flex";
  });
}
document.getElementById("preview-close").onclick = ()=>document.getElementById("preview-modal").style.display="none";

// Upload
document.getElementById("fe-upload-btn").onclick = ()=>document.getElementById("fe-upload").click();
document.getElementById("fe-upload").onchange = function(){
  const files = this.files; if(!files.length) return;
  const fd = new FormData(); for(let f of files) fd.append('file', f);
  fetch(`/api/upload?path=${encodeURIComponent(cwd)}`,{method:"POST",body:fd}).then(r=>r.json()).then(res=>{
    if(res.ok){ toast("Upload berhasil"); listDir(cwd);} else toast(res.error||"Gagal upload");
  });
};
if (fileListContainer) {
  fileListContainer.ondragover = e => {e.preventDefault();};
  fileListContainer.ondrop = e => {
    e.preventDefault(); const files = e.dataTransfer.files; if(!files.length) return;
    const fd = new FormData(); for (let f of files) fd.append('file', f);
    fetch(`/api/upload?path=${encodeURIComponent(cwd)}`,{method:"POST",body:fd}).then(r=>r.json()).then(res=>{
      if(res.ok){ toast("Upload berhasil"); listDir(cwd);} else toast(res.error||"Gagal upload");
    });
  };
}

// Custom path
document.getElementById("fe-goto").onclick = ()=>{
  const p = document.getElementById("custom-path").value; if(!p) return;
  fetch('/api/setcwd',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})}).then(r=>r.json()).then(res=>{
    if(res.ok){ listDir(p); toast("Pindah directory!"); }
    else toast("Path tidak valid");
  });
};

document.getElementById("fe-new-file").onclick = ()=>{
  const name = prompt("Enter new file name:"); if(!name) return;
  fetch('/api/create-file',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:cwd, name:name})}).then(r=>r.json()).then(res=>{
    if(res.ok) listDir(cwd); else toast(res.error || "Gagal membuat file");
  });
};
document.getElementById("fe-new-dir").onclick = ()=>{
  const name = prompt("Enter new folder name:"); if(!name) return;
  fetch('/api/create-dir',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:cwd, name:name})}).then(r=>r.json()).then(res=>{
    if(res.ok) listDir(cwd); else toast(res.error || "Gagal membuat folder");
  });
};

function escapeHtml(str){
  return str.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
}

// splitter
(function(){
  const split = document.getElementById('h-split');
  let dragging = false; let startY=0; let startTopHeight=0; let startBottomHeight=0;
  split.addEventListener('mousedown', (e)=>{
    dragging = true; startY = e.clientY;
    startTopHeight = editorContainer.getBoundingClientRect().height;
    startBottomHeight = termContainer.getBoundingClientRect().height;
    document.body.style.cursor='row-resize';
  });
  window.addEventListener('mousemove', (e)=>{
    if(!dragging) return;
    const dy = e.clientY - startY;
    const newTop = Math.max(120, startTopHeight + dy);
    const newBottom = Math.max(120, startBottomHeight - dy);
    editorContainer.style.flexBasis = newTop + 'px';
    termContainer.style.flexBasis = newBottom + 'px';
  });
  window.addEventListener('mouseup', ()=>{ if(dragging){ dragging=false; document.body.style.cursor=''; } });
})();

// Responsive
window.onresize = ()=> term && term._core ? null : null;
if(window.innerWidth<700) fileExplorer.classList.add("collapsed");

document.addEventListener('keydown', e=>{ if(e.ctrlKey && e.key==="b"){ fileExplorer.classList.toggle("collapsed"); } });

document.addEventListener('click', ()=>contextMenu.style.display="none");

// init
listDir();
