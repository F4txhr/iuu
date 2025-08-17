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

// Input form
const inputForm = document.getElementById('input-form');
const input = document.getElementById('terminal-input');
inputForm.onsubmit = e => {
  e.preventDefault();
  if(input.value.trim()==="") return;
  socket.emit('terminal_input', input.value+'\n');
  input.value="";
};

// Shortcuts
document.addEventListener('keydown', e=>{
  if(e.ctrlKey && e.key==="e"){ input.focus(); e.preventDefault(); }
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
// FE toggle button (floating, di luar explorer)
const feToggle = document.getElementById("fe-toggle");
feToggle.onclick = ()=> fileExplorer.classList.toggle("collapsed");

// List directory
function listDir(path){
  fetch(`/api/list?path=${encodeURIComponent(path)}`)
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
        el.innerHTML = f.is_dir ? "📁 "+f.name : "📄 "+f.name;
        if(f.is_dir){
          el.onclick = ()=>listDir(cwd.replace(/\/+$/,"")+"/"+f.name);
        }else{
          el.onclick = ()=>previewFile(cwd.replace(/\/+$/,"")+"/"+f.name, f);
          // Download icon
          const dl = document.createElement("button");
          dl.textContent = "⬇️"; dl.title="Download";
          dl.style.marginLeft="auto";
          dl.onclick = ev => {
            ev.stopPropagation();
            window.open(`/api/download?path=${encodeURIComponent(cwd.replace(/\/+$/,"")+"/"+f.name)}`);
          };
          el.appendChild(dl);
        }
        fileList.appendChild(el);
      });
    });
}
listDir("/data/data/com.termux/files/home"); // Load home

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
