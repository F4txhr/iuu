from flask import Flask, request, jsonify, send_from_directory, send_file
from flask_socketio import SocketIO, emit
from werkzeug.utils import secure_filename
import os, pty, select, threading, base64, shutil
from datetime import datetime

app = Flask(__name__, static_url_path='/static')
socketio = SocketIO(app, cors_allowed_origins=os.environ.get("CORS_ALLOWED_ORIGINS", "*"), async_mode="threading")

# Start at home or custom path
START_PATH = os.environ.get("START_PATH", os.path.expanduser("~"))
# Restrict all filesystem operations to this root
ROOT_PATH = os.environ.get("ROOT_PATH", START_PATH)
ROOT_REAL = os.path.realpath(ROOT_PATH)

cwd = [ROOT_PATH]  # mutable for threading


def _is_within_root(path: str) -> bool:
    real = os.path.realpath(path)
    return real == ROOT_REAL or real.startswith(ROOT_REAL + os.sep)


def _safe_path(*parts: str) -> str:
    candidate = os.path.realpath(os.path.join(*parts))
    if not _is_within_root(candidate):
        raise ValueError("Path out of allowed root")
    return candidate


def _is_safe_name(name: str) -> bool:
    if not name:
        return False
    if name in (".", ".."):
        return False
    if "/" in name or "\x00" in name or "\\" in name:
        return False
    return True


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/static/<path:filename>')
def static_files(filename):
    return send_from_directory('static', filename)


def format_size(size):
    if size < 1024:
        return f"{size} B"
    for unit in ['KB', 'MB', 'GB', 'TB']:
        size /= 1024
        if size < 1024:
            return f"{size:.1f} {unit}"
    return f"{size:.1f} PB"


# API: list directory
@app.route('/api/list')
def list_dir():
    path = request.args.get('path', cwd[0])
    if not path:
        path = cwd[0] if cwd[0] else ROOT_PATH
    try:
        path = _safe_path(path)
    except Exception:
        path = ROOT_PATH
    try:
        items = []
        with os.scandir(path) as it:
            for entry in it:
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    stat = entry.stat(follow_symlinks=False)
                    name = entry.name
                    items.append({
                        "name": name,
                        "is_dir": is_dir,
                        "is_img": not is_dir and name.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp')),
                        "is_txt": not is_dir and name.lower().endswith(('.txt', '.md', '.py', '.js', '.json', '.html', '.css', '.sh', '.log', '.csv')),
                        "size": format_size(stat.st_size) if not is_dir else "",
                        "modified": datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M:%S')
                    })
                except Exception:
                    continue
        cwd[0] = path
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
    try:
        path = _safe_path(path)
    except Exception:
        return "File not found", 404
    if not path or not os.path.isfile(path):
        return "File not found", 404
    return send_file(path, as_attachment=True)


# API: preview file
@app.route('/api/preview')
def preview_file():
    path = request.args.get('path')
    try:
        path = _safe_path(path)
    except Exception:
        return jsonify({"error": "Not found"}), 404
    if not path or not os.path.isfile(path):
        return jsonify({"error": "Not found"}), 404
    ext = os.path.splitext(path)[1].lower()
    try:
        # Limit preview to reasonable file sizes (e.g., 5 MB)
        try:
            size_bytes = os.path.getsize(path)
        except OSError:
            size_bytes = 0
        if size_bytes > 5 * 1024 * 1024:
            return jsonify({"type": "err", "data": "File terlalu besar untuk dipreview"})

        if ext in [".jpg", ".png", ".jpeg", ".gif", ".webp", ".svg"]:
            with open(path, "rb") as f:
                encoded = base64.b64encode(f.read()).decode()
            mime = "image/" + ("svg+xml" if ext == ".svg" else ext.lstrip("."))
            return jsonify({"type": "img", "data": f"data:{mime};base64,{encoded}"})
        elif ext in [".txt", ".md", ".py", ".js", ".json", ".html", ".css", ".sh", ".log", ".csv"]:
            with open(path, encoding="utf-8", errors="ignore") as f:
                return jsonify({"type": "txt", "data": f.read()[:20000]})
        else:
            return jsonify({"type": "bin", "data": "Tidak bisa dipreview"})
    except Exception as e:
        return jsonify({"type": "err", "data": str(e)})


# API: upload
@app.route('/api/upload', methods=['POST'])
def upload_file():
    try:
        base_path = _safe_path(request.args.get('path', cwd[0]))
    except Exception:
        return jsonify({"error": "Invalid path"}), 400
    files = request.files.getlist('file')
    if not files:
        return jsonify({"error": "No files provided"}), 400
    saved = []
    for f in files:
        filename = secure_filename(f.filename)
        if not _is_safe_name(filename):
            continue
        try:
            save_path = _safe_path(base_path, filename)
            f.save(save_path)
            saved.append(filename)
        except Exception as e:
            return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "files": saved})


# API: custom start path
@app.route('/api/setcwd', methods=['POST'])
def set_cwd():
    path = request.json.get('path')
    try:
        path = _safe_path(path)
    except Exception:
        return jsonify({"ok": False})
    if path and os.path.isdir(path):
        cwd[0] = path
        return jsonify({"ok": True, "cwd": cwd[0]})
    return jsonify({"ok": False})


# API: create directory
@app.route('/api/create-dir', methods=['POST'])
def create_dir():
    data = request.json
    path = data.get('path')
    name = data.get('name')
    if not path or not name:
        return jsonify({"error": "Path and name are required"}), 400
    try:
        base = _safe_path(path)
        if not _is_safe_name(name):
            return jsonify({"error": "Invalid name"}), 400
        target = _safe_path(base, name)
        os.mkdir(target)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# API: create file
@app.route('/api/create-file', methods=['POST'])
def create_file():
    data = request.json
    path = data.get('path')
    name = data.get('name')
    if not path or not name:
        return jsonify({"error": "Path and name are required"}), 400
    try:
        base = _safe_path(path)
        if not _is_safe_name(name):
            return jsonify({"error": "Invalid name"}), 400
        target = _safe_path(base, name)
        if os.path.exists(target):
            return jsonify({"error": "File already exists"}), 400
        open(target, 'a').close()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# API: rename
@app.route('/api/rename', methods=['POST'])
def rename_item():
    data = request.json
    old_path = data.get('old_path')
    new_name = data.get('new_name')
    if not old_path or not new_name:
        return jsonify({"error": "Old path and new name are required"}), 400
    try:
        old_path = _safe_path(old_path)
        if not _is_safe_name(new_name):
            return jsonify({"error": "Invalid name"}), 400
        dir_path = os.path.dirname(old_path)
        new_path = _safe_path(dir_path, new_name)
        if os.path.exists(new_path):
            return jsonify({"error": "Target already exists"}), 400
        os.rename(old_path, new_path)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# API: delete
@app.route('/api/delete', methods=['POST'])
def delete_item():
    data = request.json
    path = data.get('path')
    if not path:
        return jsonify({"error": "Path is required"}), 400
    try:
        target = _safe_path(path)
        if os.path.isdir(target):
            shutil.rmtree(target)
        else:
            os.remove(target)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# --- Terminal PTY ---
master_fd = None
child_pid = None


def setup_terminal():
    global master_fd, child_pid
    if child_pid:
        return  # Already started

    (pid, fd) = pty.fork()
    if pid == 0:  # Child
        # Start a new shell session
        try:
            os.chdir(ROOT_PATH)
        except Exception:
            os.chdir(START_PATH)
        os.execv('/bin/bash', ['/bin/bash'])
    else:  # Parent
        child_pid = pid
        master_fd = fd
        # Optional: set an initial command or welcome message
        # os.write(master_fd, b"echo 'Welcome to the web terminal!'\n")


def read_and_forward_pty_output():
    global master_fd
    while True:
        if master_fd:
            try:
                r, _, _ = select.select([master_fd], [], [], 0.1)
                if r:
                    output = os.read(master_fd, 1024 * 20)
                    if output:
                        socketio.emit('terminal_output', output.decode(errors='ignore'))
            except Exception:
                # Process might have died
                socketio.emit('terminal_output', '\n--- Shell exited ---\n')
                break
        socketio.sleep(0.01)


@socketio.on('connect')
def connect():
    if child_pid is None:
        setup_terminal()


@socketio.on('terminal_input')
def terminal_input(data):
    if master_fd:
        os.write(master_fd, data.encode())


@socketio.on('terminal_clear')
def terminal_clear():
    if master_fd:
        os.write(master_fd, b'\033c')


if __name__ == '__main__':
    # Start the PTY reader thread
    threading.Thread(target=read_and_forward_pty_output, daemon=True).start()
    # Start the Flask-SocketIO server
    socketio.run(app, host='0.0.0.0', port=8080, allow_unsafe_werkzeug=True)