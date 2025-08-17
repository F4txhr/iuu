const term = new Terminal({ theme:{background:"#181a20"}, fontSize:15 });
term.open(document.getElementById("terminal"));
const socket = io();
let cwd = "";

function toast(msg) {
  const t=document.getElementById("toast");
  t.textContent=msg;t.style.display="block";
  setTimeout(()=>{t.style.display="none";},2500);
}

// Terminal output
socket.on('terminal_output', d => term.write(d));
term.onData(d => socket.emit('terminal_input', d));
term.focus();

// Shortcuts
document.addEventListener('keydown', e=>{
  if(e.ctrlKey && e.key==="l"){ socket.emit('terminal_clear'); e.preventDefault(); }
  if(e.key==="Escape"){
    document.getElementById("file-explorer").classList.add("collapsed");
    document.getElementById("preview-modal").style.display="none";
  }
});

// File explorer
const fileExplorer = document.getElementById("file-explorer");
const fileList = document.getElementById("file-list");
const cwdDiv = document.getElementById("cwd");
const contextMenu = document.getElementById("context-menu");
let contextTarget = null; // will store path for context menu
// FE toggle button (floating, di luar explorer)
const feToggle = document.getElementById("fe-toggle");
feToggle.onclick = ()=> fileExplorer.classList.toggle("collapsed");

// Hide context menu on global click
document.addEventListener('click', ()=>contextMenu.style.display="none");

// Context menu actions
contextMenu.addEventListener('click', e => {
  if(!contextTarget || !e.target.matches('[data-action]')) return;
  const action = e.target.dataset.action;
  const { path } = contextTarget;

  switch(action){
    case 'delete':
      if(!confirm(`Are you sure you want to delete ${path}?`)) return;
      fetch('/api/delete',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:path})})
        .then(r=>r.json()).then(res=>{
          if(res.ok) listDir(cwd); else toast(res.error||"Gagal menghapus");
        });
      break;
    case 'rename':
      const newName = prompt(`Enter new name for ${path}:`, path.split('/').pop());
      if(!newName) return;
      fetch('/api/rename',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({old_path:path, new_name:newName})})
        .then(r=>r.json()).then(res=>{
          if(res.ok) listDir(cwd); else toast(res.error||"Gagal rename");
        });
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

// List directory
function listDir(path){
  const url = path ? `/api/list?path=${encodeURIComponent(path)}` : '/api/list';
  fetch(url)
    .then(r=>r.json())
    .then(res=>{
      if(res.error){ toast(res.error); return; }
      cwd = res.cwd;
      cwdDiv.textContent = cwd;
      fileList.innerHTML = "";
      // Parent/back icon
      if(cwd!=="/"){
        const up = cwd.replace(/\/+$/,'').replace(/\/[^\/]+$/,'')||"/";
        const back = document.createElement("div");
        back.className = "fe-folder";
        back.innerHTML = "⬅️ ..";
        back.onclick = ()=>listDir(up);
        fileList.appendChild(back);
      }
      res.items.forEach(f=>{
        const el = document.createElement("div");
        el.className = f.is_dir ? "fe-folder" : "fe-file";
        const fullPath = cwd.replace(/\/+$/,"")+"/"+f.name;

        const text = document.createElement('span');
        text.textContent = f.is_dir ? "📁 "+f.name : "📄 "+f.name;
        text.onclick = f.is_dir ? ()=>listDir(fullPath) : ()=>previewFile(fullPath, f);
        el.appendChild(text);

        const menuBtn = document.createElement("button");
        menuBtn.textContent = "…";
        menuBtn.className = "ctx-menu-btn";
        menuBtn.onclick = e => {
          e.stopPropagation();
          contextTarget = { path: fullPath, is_dir: f.is_dir, is_txt: f.is_txt };
          contextMenu.style.display="flex";
          contextMenu.style.top = `${e.target.offsetTop + 20}px`;
          contextMenu.style.left = `${e.target.offsetLeft - 50}px`;
          // Hide/show run button
          document.querySelector('[data-action="run"]').style.display = (f.is_txt && (f.name.endsWith(".py") || f.name.endsWith(".sh"))) ? 'block' : 'none';
          document.querySelector('[data-action="download"]').style.display = f.is_dir ? 'none' : 'block';
        };
        el.appendChild(menuBtn);

        fileList.appendChild(el);
      });
    });
}
listDir(); // Load home

// Preview file
function previewFile(path, meta){
  fetch(`/api/preview?path=${encodeURIComponent(path)}`)
    .then(r=>r.json())
    .then(res=>{
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
  const files = this.files;
  if(!files.length) return;
  const fd = new FormData();
  for(let f of files) fd.append('file', f);
  fetch(`/api/upload?path=${encodeURIComponent(cwd)}`,{method:"POST",body:fd})
    .then(r=>r.json())
    .then(res=>{
      if(res.ok){ toast("Upload berhasil"); listDir(cwd);}
      else toast("Gagal upload");
    });
};
// Drag & drop
fileList.ondragover = e => {e.preventDefault();};
fileList.ondrop = e => {
  e.preventDefault();
  const files = e.dataTransfer.files; if(!files.length) return;
  const fd = new FormData();
  fd.append('file', files[0]); // multi bisa diubah sesuai backend
  fetch(`/api/upload?path=${encodeURIComponent(cwd)}`,{method:"POST",body:fd})
    .then(r=>r.json())
    .then(res=>{
      if(res.ok){ toast("Upload berhasil"); listDir(cwd);}
      else toast("Gagal upload");
    });
};

// Custom path
document.getElementById("fe-goto").onclick = ()=>{
  const p = document.getElementById("custom-path").value;
  if(!p) return;
  fetch('/api/setcwd',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})})
    .then(r=>r.json())
    .then(res=>{
      if(res.ok){ listDir(p); toast("Pindah directory!"); }
      else toast("Path tidak valid");
    });
};

// New File/Folder
document.getElementById("fe-new-file").onclick = ()=>{
  const name = prompt("Enter new file name:");
  if(!name) return;
  fetch('/api/create-file',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:cwd, name:name})})
    .then(r=>r.json())
    .then(res=>{
      if(res.ok) listDir(cwd);
      else toast(res.error || "Gagal membuat file");
    });
};
document.getElementById("fe-new-dir").onclick = ()=>{
  const name = prompt("Enter new folder name:");
  if(!name) return;
  fetch('/api/create-dir',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:cwd, name:name})})
    .then(r=>r.json())
    .then(res=>{
      if(res.ok) listDir(cwd);
      else toast(res.error || "Gagal membuat folder");
    });
};

// Escape HTML helper
function escapeHtml(str){
  return str.replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[c]);
}

// Responsive
window.onresize = ()=>term.fit && term.fit();
// Auto show FE on mobile
if(window.innerWidth<700) fileExplorer.classList.add("collapsed");

// Toggle explorer shortcut
document.addEventListener('keydown', e=>{
  if(e.ctrlKey && e.key==="b"){ fileExplorer.classList.toggle("collapsed"); }
});
