from flask import Flask, request, jsonify, send_from_directory, send_file
from flask_socketio import SocketIO, emit
import os, pty, select, threading, base64

app = Flask(__name__, static_url_path='/static')
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Start at home or custom path
START_PATH = os.environ.get("START_PATH", os.path.expanduser("~"))
cwd = [START_PATH]  # mutable for threading

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/static/<path:filename>')
def static_files(filename):
    return send_from_directory('static', filename)

# API: list directory
@app.route('/api/list')
def list_dir():
    path = request.args.get('path', cwd[0])
    if not path:
        # Default ke home jika kosong (atau START_PATH)
        path = cwd[0] if cwd[0] else START_PATH
    try:
        items = []
        for name in os.listdir(path):
            full = os.path.join(path, name)
            items.append({
                "name": name,
                "is_dir": os.path.isdir(full),
                "is_img": name.lower().endswith(('.png','.jpg','.jpeg','.gif','.svg','.webp')),
                "is_txt": name.lower().endswith(('.txt','.md','.py','.js','.json','.html','.css','.sh','.log','.csv'))
            })
        return jsonify({
            "cwd": os.path.abspath(path),
            "items": sorted(items, key=lambda x: (not x["is_dir"], x["name"].lower()))
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400

# API: download
@app.route('/api/download')
def download_file():
    path = request.args.get('path')
    if not path or not os.path.isfile(path):
        return "File not found", 404
    return send_file(path, as_attachment=True)

# API: preview file
@app.route('/api/preview')
def preview_file():
    path = request.args.get('path')
    if not path or not os.path.isfile(path):
        return jsonify({"error":"Not found"}),404
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in [".jpg",".png",".jpeg",".gif",".webp",".svg"]:
            with open(path, "rb") as f:
                encoded = base64.b64encode(f.read()).decode()
            mime = "image/"+("svg+xml" if ext==".svg" else ext.lstrip("."))
            return jsonify({"type":"img","data":f"data:{mime};base64,{encoded}"})
        elif ext in [".txt",".md",".py",".js",".json",".html",".css",".sh",".log",".csv"]:
            with open(path, encoding="utf-8", errors="ignore") as f:
                return jsonify({"type":"txt","data":f.read()[:20000]})
        else:
            return jsonify({"type":"bin","data":"Tidak bisa dipreview"})
    except Exception as e:
        return jsonify({"type":"err","data":str(e)})

# API: upload
@app.route('/api/upload', methods=['POST'])
def upload_file():
    path = request.args.get('path', cwd[0])
    f = request.files['file']
    save_path = os.path.join(path, f.filename)
    f.save(save_path)
    return jsonify({"ok":True})

# API: custom start path
@app.route('/api/setcwd', methods=['POST'])
def set_cwd():
    path = request.json.get('path')
    if path and os.path.isdir(path):
        cwd[0] = path
        return jsonify({"ok":True,"cwd":cwd[0]})
    return jsonify({"ok":False})

# Terminal PTY
master, slave = pty.openpty()
os.write(master, f"cd '{cwd[0]}'\n".encode())

def read_pty():
    while True:
        rl, _, _ = select.select([master], [], [], 0.1)
        if master in rl:
            output = os.read(master, 1024).decode(errors='ignore')
            socketio.emit('terminal_output', output)

@socketio.on('terminal_input')
def terminal_input(data):
    os.write(master, data.encode())

# For shortcut: clear terminal
@socketio.on('terminal_clear')
def terminal_clear():
    socketio.emit('terminal_output', '\033c')

if __name__ == '__main__':
    threading.Thread(target=read_pty, daemon=True).start()
    socketio.run(app, host='0.0.0.0', port=8080)