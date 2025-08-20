from flask import Flask, request, jsonify, send_from_directory
import os, pty, select, threading, subprocess, signal, socket, getpass, psutil, time

app = Flask(__name__, static_url_path='/static')

SESSIONS = {}
SESS_LOCK = threading.Lock()


def detect_shell():
    sh = os.environ.get('SHELL')
    if sh and os.path.exists(sh):
        return [sh, '-i']
    for c in [
        '/data/data/com.termux/files/usr/bin/zsh',
        '/data/data/com.termux/files/usr/bin/bash',
        '/data/data/com.termux/files/usr/bin/sh',
        '/system/bin/sh',
        '/bin/bash',
        '/bin/sh',
    ]:
        if os.path.exists(c):
            return [c, '-i']
    return ['sh', '-i']


def reader_loop(tid):
    while True:
        term = SESSIONS.get(tid)
        if not term:
            break
        try:
            r, _, _ = select.select([term['fd']], [], [], 0.1)
            if r:
                out = os.read(term['fd'], 1024 * 16)
                if out:
                    with term['lock']:
                        term['buf'].append(out.decode('utf-8', errors='ignore'))
        except Exception:
            break


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/api/term/new', methods=['GET', 'POST'])
def t_new():
    tid = None
    with SESS_LOCK:
        tid = str(len(SESSIONS) + 1)
    try:
        master_fd, slave_fd = os.openpty()
        env = os.environ.copy()
        env.setdefault('TERM', 'xterm-256color')
        home = env.get('HOME') or os.path.expanduser('~')
        env.setdefault('HOME', home)
        cmd = detect_shell()
        p = subprocess.Popen(
            cmd,
            preexec_fn=os.setsid,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
            env=env,
            cwd=home
        )
        os.close(slave_fd)
        SESSIONS[tid] = { 'pid': p.pid, 'fd': master_fd, 'buf': [], 'lock': threading.Lock(), 'home': home }
        threading.Thread(target=reader_loop, args=(tid,), daemon=True).start()
        return jsonify({ 'tid': tid, 'home': home })
    except Exception as e:
        return jsonify({ 'error': f'{type(e).__name__}: {e}' }), 500


@app.route('/api/term/input', methods=['GET', 'POST'])
def t_input():
    data = request.json if request.is_json else None
    tid = request.args.get('tid') or (data.get('tid') if data else None)
    inp = request.args.get('data') or (data.get('data') if data else '')
    term = SESSIONS.get(tid)
    if not term:
        return jsonify({ 'error': 'no session' }), 404
    os.write(term['fd'], inp.encode())
    return jsonify({ 'ok': True })


@app.route('/api/term/poll')
def t_poll():
    tid = request.args.get('tid')
    term = SESSIONS.get(tid)
    if not term:
        return jsonify({ 'error': 'no session' }), 404
    out = ''
    with term['lock']:
        if term['buf']:
            out = ''.join(term['buf'])
            term['buf'].clear()
    return jsonify({ 'data': out })


@app.route('/api/term/clear', methods=['GET', 'POST'])
def t_clear():
    data = request.json if request.is_json else None
    tid = request.args.get('tid') or (data.get('tid') if data else None)
    term = SESSIONS.get(tid)
    if not term:
        return jsonify({ 'error': 'no session' }), 404
    os.write(term['fd'], b'\033c')
    return jsonify({ 'ok': True })


@app.route('/api/term/close', methods=['GET', 'POST'])
def t_close():
    data = request.json if request.is_json else None
    tid = request.args.get('tid') or (data.get('tid') if data else None)
    term = SESSIONS.pop(tid, None)
    if term:
        try:
            os.close(term['fd'])
        except Exception:
            pass
        try:
            os.kill(term['pid'], signal.SIGKILL)
        except Exception:
            pass
    return jsonify({ 'ok': True })


@app.route('/api/list')
def list_dir():
    path = request.args.get('path')
    # Default to session's home if tid provided
    tid = request.args.get('tid')
    home = None
    if not path and tid and tid in SESSIONS:
        home = SESSIONS[tid].get('home')
        path = home
    if not path:
        path = os.path.expanduser('~')
    try:
        items = []
        with os.scandir(path) as it:
            for entry in it:
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    items.append({ 'name': entry.name, 'is_dir': is_dir })
                except Exception:
                    continue
        items.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))
        return jsonify({ 'cwd': os.path.abspath(path), 'items': items })
    except Exception as e:
        return jsonify({ 'error': str(e) }), 400


@app.route('/api/info')
def info():
    try:
        user = os.environ.get('USER') or getpass.getuser()
    except Exception:
        user = 'user'
    host = socket.gethostname() or 'localhost'
    shell_path = (detect_shell()[0] if isinstance(detect_shell(), list) else 'sh')
    return jsonify({ 'user': user, 'host': host, 'shell': os.path.basename(shell_path) })


@app.route('/api/read-file')
def read_file():
    path = request.args.get('path')
    if not path:
        return jsonify({'error':'missing path'}), 400
    try:
        with open(path, 'rb') as f:
            data = f.read(2*1024*1024)
        try:
            text = data.decode('utf-8')
        except Exception:
            text = data.decode('utf-8', errors='ignore')
        return jsonify({'ok':True, 'data':text})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/save-file', methods=['POST'])
def save_file():
    data = request.json or {}
    path = data.get('path')
    content = data.get('data','')
    if not path:
        return jsonify({'error':'missing path'}), 400
    try:
        parent = os.path.dirname(path) or '.'
        os.makedirs(parent, exist_ok=True)
        with open(path, 'w', encoding='utf-8', errors='ignore') as f:
            f.write(content)
        return jsonify({'ok':True})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/system-stats')
def system_stats():
    try:
        # CPU usage
        cpu_percent = psutil.cpu_percent(interval=1)
        cpu_count = psutil.cpu_count()
        
        # Memory usage
        memory = psutil.virtual_memory()
        memory_total = memory.total
        memory_used = memory.used
        memory_percent = memory.percent
        
        # Disk usage
        disk = psutil.disk_usage('/')
        disk_total = disk.total
        disk_used = disk.used
        disk_percent = (disk_used / disk_total) * 100
        
        # Network I/O
        net_io = psutil.net_io_counters()
        
        # Process count
        process_count = len(psutil.pids())
        
        # Load average (Unix only)
        try:
            load_avg = os.getloadavg()
        except:
            load_avg = [0, 0, 0]
        
        # Boot time
        boot_time = psutil.boot_time()
        uptime = time.time() - boot_time
        
        return jsonify({
            'cpu': {
                'percent': round(cpu_percent, 1),
                'count': cpu_count
            },
            'memory': {
                'total': memory_total,
                'used': memory_used,
                'percent': round(memory_percent, 1),
                'total_gb': round(memory_total / (1024**3), 2),
                'used_gb': round(memory_used / (1024**3), 2)
            },
            'disk': {
                'total': disk_total,
                'used': disk_used,
                'percent': round(disk_percent, 1),
                'total_gb': round(disk_total / (1024**3), 2),
                'used_gb': round(disk_used / (1024**3), 2)
            },
            'network': {
                'bytes_sent': net_io.bytes_sent,
                'bytes_recv': net_io.bytes_recv
            },
            'system': {
                'processes': process_count,
                'load_avg': [round(x, 2) for x in load_avg],
                'uptime': round(uptime / 3600, 1)  # hours
            }
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    os.makedirs('static', exist_ok=True)
    app.run(host='0.0.0.0', port=8080)