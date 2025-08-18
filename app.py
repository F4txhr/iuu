from flask import Flask, request, jsonify, send_from_directory, send_file
from flask_socketio import SocketIO, emit
from werkzeug.utils import secure_filename
import os, pty, select, threading, base64, shutil, signal, subprocess
from datetime import datetime

app = Flask(__name__, static_url_path='/static')
socketio = SocketIO(app, cors_allowed_origins=os.environ.get("CORS_ALLOWED_ORIGINS", "*"), async_mode="threading")

# Start at home or custom path
START_PATH = os.environ.get("START_PATH", os.path.expanduser("~"))
# Restrict all filesystem operations to this root
ROOT_PATH = os.environ.get("ROOT_PATH", START_PATH)
ROOT_REAL = os.path.realpath(ROOT_PATH)

cwd = [ROOT_PATH]  # mutable for threading (global cwd for listing)

# PTY sessions: { sid: { 'counter': int, 'terms': { tid: {'fd':int,'pid':int,'thread':Thread,'buffer':list[str],'lock':Lock} } } }
PTY_SESSIONS = {}
SESSIONS_LOCK = threading.Lock()


def _detect_shell_path() -> list:
    sh = os.environ.get('SHELL')
    if sh and os.path.exists(sh):
        return [sh, sh]
    candidates = [
        '/data/data/com.termux/files/usr/bin/zsh',
        '/data/data/com.termux/files/usr/bin/bash',
        '/data/data/com.termux/files/usr/bin/sh',
        '/system/bin/sh',
        '/bin/bash',
        '/bin/sh',
    ]
    for c in candidates:
        if os.path.exists(c):
            return [c, c]
    return ['sh', 'sh']


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


# API: search files (Quick Open)
@app.route('/api/search')
def search_files():
    q = (request.args.get('q') or '').strip().lower()
    limit = int(request.args.get('limit', 200))
    if not q:
        return jsonify({"results": []})
    results = []
    try:
        for root, dirs, files in os.walk(ROOT_PATH):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for name in files + dirs:
                if q in name.lower():
                    full = os.path.join(root, name)
                    try:
                        full = _safe_path(full)
                    except Exception:
                        continue
                    results.append({
                        "path": full,
                        "is_dir": os.path.isdir(full)
                    })
                    if len(results) >= limit:
                        raise StopIteration
    except StopIteration:
        pass
    return jsonify({"results": results})


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


# API: read file (full, limited size)
@app.route('/api/read-file')
def read_file_full():
    path = request.args.get('path')
    try:
        path = _safe_path(path)
    except Exception:
        return jsonify({"error": "Invalid path"}), 400
    if not path or not os.path.isfile(path):
        return jsonify({"error": "Not found"}), 404
    try:
        max_bytes = 2 * 1024 * 1024
        with open(path, 'rb') as f:
            data = f.read(max_bytes)
        text = data.decode('utf-8', errors='ignore')
        return jsonify({"ok": True, "data": text})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# API: save file
@app.route('/api/save-file', methods=['POST'])
def save_file():
    data = request.json or {}
    path = data.get('path')
    content = data.get('data', '')
    try:
        path = _safe_path(path)
    except Exception:
        return jsonify({"error": "Invalid path"}), 400
    try:
        parent = os.path.dirname(path)
        if not _is_within_root(parent):
            return jsonify({"error": "Parent path invalid"}), 400
        with open(path, 'w', encoding='utf-8', errors='ignore') as f:
            f.write(content)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


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


# --- Multi-PTY Support with buffer ---

def _get_term(sid: str, tid: str):
    with SESSIONS_LOCK:
        return PTY_SESSIONS.get(sid, {}).get('terms', {}).get(tid)


def _reader_loop(sid: str, tid: str, master_fd: int):
    while True:
        try:
            r, _, _ = select.select([master_fd], [], [], 0.1)
            if r:
                out = os.read(master_fd, 1024 * 20)
                if out:
                    # emit via socket
                    try:
                        socketio.emit('terminal_output', { 'tid': tid, 'data': out.decode(errors='ignore') }, to=sid)
                    except Exception:
                        pass
                    # append to buffer for HTTP polling
                    term = _get_term(sid, tid)
                    if term:
                        with term['lock']:
                            term['buffer'].append(out.decode(errors='ignore'))
        except Exception:
            break
        socketio.sleep(0.01)


def _start_pty_fork(sid: str, tid: str):
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(ROOT_PATH)
        except Exception:
            os.chdir(START_PATH)
        shell_path, shell_name = _detect_shell_path()
        os.environ.setdefault('TERM', 'xterm-256color')
        os.environ.setdefault('HOME', ROOT_PATH)
        os.execv(shell_path, [shell_name])
    else:
        return pid, fd


def _start_pty_openpty(sid: str, tid: str):
    master_fd, slave_fd = os.openpty()
    try:
        try:
            os.chdir(ROOT_PATH)
        except Exception:
            os.chdir(START_PATH)
        shell_path, shell_name = _detect_shell_path()
        env = os.environ.copy()
        env.setdefault('TERM', 'xterm-256color')
        env.setdefault('HOME', ROOT_PATH)
        p = subprocess.Popen(
            [shell_path],
            preexec_fn=os.setsid,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
            env=env
        )
        os.close(slave_fd)
        return p.pid, master_fd
    except Exception:
        try:
            os.close(master_fd)
        except Exception:
            pass
        try:
            os.close(slave_fd)
        except Exception:
            pass
        raise


def _start_terminal(sid: str) -> str:
    with SESSIONS_LOCK:
        if sid not in PTY_SESSIONS:
            PTY_SESSIONS[sid] = { 'counter': 0, 'terms': {} }
        sess = PTY_SESSIONS[sid]
        sess['counter'] += 1
        tid = str(sess['counter'])
    # Try fork, fallback to openpty
    try:
        pid, fd = _start_pty_fork(sid, tid)
    except Exception:
        pid, fd = _start_pty_openpty(sid, tid)
    t = threading.Thread(target=_reader_loop, args=(sid, tid, fd), daemon=True)
    t.start()
    with SESSIONS_LOCK:
        PTY_SESSIONS[sid]['terms'][tid] = { 'fd': fd, 'pid': pid, 'thread': t, 'buffer': [], 'lock': threading.Lock() }
    return tid


def _stop_terminal(sid: str, tid: str):
    with SESSIONS_LOCK:
        term = PTY_SESSIONS.get(sid, {}).get('terms', {}).pop(tid, None)
    if term:
        try:
            os.close(term['fd'])
        except Exception:
            pass
        try:
            os.kill(term['pid'], signal.SIGKILL)
        except Exception:
            pass


def _cleanup_sid(sid: str):
    with SESSIONS_LOCK:
        sess = PTY_SESSIONS.pop(sid, None)
    if not sess:
        return
    for tid, term in sess['terms'].items():
        try:
            os.close(term['fd'])
        except Exception:
            pass
        try:
            os.kill(term['pid'], signal.SIGKILL)
        except Exception:
            pass


# Socket.IO events
@socketio.on('connect')
def on_connect():
    sid = request.sid
    tid = _start_terminal(sid)
    socketio.emit('terminal_started', { 'tid': tid }, to=sid)


@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    _cleanup_sid(sid)


@socketio.on('terminal_new')
def terminal_new():
    sid = request.sid
    tid = _start_terminal(sid)
    socketio.emit('terminal_started', { 'tid': tid }, to=sid)


@socketio.on('terminal_input')
def terminal_input(payload):
    sid = request.sid
    if not isinstance(payload, dict):
        return
    tid = payload.get('tid')
    data = payload.get('data', '')
    term = _get_term(sid, tid)
    if term:
        os.write(term['fd'], data.encode())


@socketio.on('terminal_clear')
def terminal_clear(payload):
    sid = request.sid
    tid = None
    if isinstance(payload, dict):
        tid = payload.get('tid')
    term = _get_term(sid, tid)
    if term:
        os.write(term['fd'], b'\033c')


@socketio.on('terminal_close')
def terminal_close(payload):
    sid = request.sid
    if not isinstance(payload, dict):
        return
    tid = payload.get('tid')
    if tid:
        _stop_terminal(sid, tid)


# HTTP fallback endpoints for terminal
@app.route('/api/term/new', methods=['POST'])
def http_term_new():
    cid = request.args.get('cid', 'http')
    try:
        tid = _start_terminal(cid)
        return jsonify({ 'tid': tid })
    except Exception as e:
        return jsonify({ 'error': f'Failed to start terminal: {e}' }), 500


@app.route('/api/term/input', methods=['POST'])
def http_term_input():
    data = request.json or {}
    cid = request.args.get('cid', 'http')
    tid = data.get('tid')
    inp = data.get('data', '')
    term = _get_term(cid, tid)
    if not term:
        return jsonify({ 'error': 'No such terminal' }), 404
    os.write(term['fd'], inp.encode())
    return jsonify({ 'ok': True })


@app.route('/api/term/clear', methods=['POST'])
def http_term_clear():
    data = request.json or {}
    cid = request.args.get('cid', 'http')
    tid = data.get('tid')
    term = _get_term(cid, tid)
    if not term:
        return jsonify({ 'error': 'No such terminal' }), 404
    os.write(term['fd'], b'\033c')
    return jsonify({ 'ok': True })


@app.route('/api/term/close', methods=['POST'])
def http_term_close():
    data = request.json or {}
    cid = request.args.get('cid', 'http')
    tid = data.get('tid')
    _stop_terminal(cid, tid)
    return jsonify({ 'ok': True })


@app.route('/api/term/poll')
def http_term_poll():
    cid = request.args.get('cid', 'http')
    tid = request.args.get('tid')
    term = _get_term(cid, tid)
    if not term:
        return jsonify({ 'error': 'No such terminal' }), 404
    out = ''
    with term['lock']:
        if term['buffer']:
            out = ''.join(term['buffer'])
            term['buffer'].clear()
    return jsonify({ 'data': out })


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=8080, allow_unsafe_werkzeug=True)