#!/usr/bin/env python3
# LumiCatch mock net - laptop stand-in for the UNO Q
# --------------------------------------------------
# Lets you test the Lens over a real WebSocket before the hardware exists.
# Speaks exactly the same protocol as main.py, so when the UNO Q arrives you
# change only the IP in the Lens and nothing else.
#
#   Net -> Lens : {"type": "swing", "peak": 2.7}
#   Lens -> Net : {"type": "haptic", "pattern": 3}
#
# Deliberately zero dependencies: raw sockets and the standard library only,
# so there is nothing to install and nothing to break on shoot day.
#
# Run:
#   python3 mock-net.py
#
# Then in the Lens, untick 'simulate' and set serverUrl to
# ws://<YOUR-LAPTOP-IP>:8765
#
# Controls, typed into this terminal:
#   Enter      send a swing with a default peak
#   2.9        send a swing with that peak value
#   q          quit

import base64
import hashlib
import json
import math
import socket
import struct
import sys
import threading
import time

from neon_ai import AdaptiveDifficulty, TrajectoryPredictor
from dashboard import start_dashboard

HOST = '0.0.0.0'
PORT = 8765
DEFAULT_PEAK = 2.7
IDLE_PING_INTERVAL = 30.0     # how often to probe a silent client, seconds

# Magic value from RFC 6455, used to build the handshake response.
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

HAPTIC_NAMES = {
    1: 'nearby',
    2: 'rare',
    3: 'capture',
    4: 'combo'
}

clients = []
clients_lock = threading.Lock()

# The same two models main.py runs on the UNO Q, so this mock exercises the
# real AI rather than a stub. A swing here is synthesised as an IMU trace and
# pushed through the predictor exactly as the board would.
dda = AdaptiveDifficulty()
predictor = TrajectoryPredictor()

# Mirrors the shape main.py reports, so the same dashboard runs against the
# mock. Handy for filming the dashboard if the board is being difficult.
started_at = time.time()
mock_stats = {"swings": 0, "hits": 0, "predictions": 0,
              "eta": 0.0, "conf": 0.0, "mood": "calm", "score": 0}


def dashboard_state():
    with clients_lock:
        addrs = [str(i + 1) for i in range(len(clients))]
    return {
        "sessions": [{
            "id": i + 1, "address": "mock-lens",
            "swings": mock_stats["swings"], "hits": mock_stats["hits"],
            "score": mock_stats["score"],
            "catch_ratio": (mock_stats["hits"] / mock_stats["swings"])
                           if mock_stats["swings"] else 0.0,
            "difficulty": dda.level(), "mood": mock_stats["mood"],
            "target_ratio": dda.target_ratio, "dead_band": dda.dead_band,
        } for i, _ in enumerate(addrs)],
        "total_swings": mock_stats["swings"],
        "total_hits": mock_stats["hits"],
        "predictions": mock_stats["predictions"],
        "last_eta_ms": mock_stats["eta"],
        "last_confidence": mock_stats["conf"],
        "uptime_s": time.time() - started_at,
    }


def build_handshake(request: str) -> str:
    '''Compute the Sec-WebSocket-Accept response for a client handshake.'''
    key = None
    for line in request.split('\r\n'):
        if line.lower().startswith('sec-websocket-key:'):
            key = line.split(':', 1)[1].strip()
            break
    if key is None:
        return None

    digest = hashlib.sha1((key + WS_GUID).encode()).digest()
    accept = base64.b64encode(digest).decode()
    return (
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    )


def encode_frame(payload: str) -> bytes:
    '''Encode a single unfragmented text frame. Server frames are never masked.'''
    data = payload.encode('utf-8')
    header = bytearray()
    header.append(0x81)  # FIN set, opcode 1 (text)

    length = len(data)
    if length < 126:
        header.append(length)
    elif length < (1 << 16):
        header.append(126)
        header.extend(struct.pack('>H', length))
    else:
        header.append(127)
        header.extend(struct.pack('>Q', length))

    return bytes(header) + data


def recv_exactly(conn: socket.socket, count: int) -> bytes:
    '''Read exactly count bytes, or return None if the peer went away.'''
    buf = b''
    while len(buf) < count:
        chunk = conn.recv(count - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_frame(conn: socket.socket):
    '''
    Read one frame. Returns (opcode, payload_bytes) or None on close.
    Client frames are always masked, so the mask is applied on the way in.
    '''
    head = recv_exactly(conn, 2)
    if head is None:
        return None

    opcode = head[0] & 0x0F
    masked = (head[1] & 0x80) != 0
    length = head[1] & 0x7F

    if length == 126:
        ext = recv_exactly(conn, 2)
        if ext is None:
            return None
        length = struct.unpack('>H', ext)[0]
    elif length == 127:
        ext = recv_exactly(conn, 8)
        if ext is None:
            return None
        length = struct.unpack('>Q', ext)[0]

    mask_key = b''
    if masked:
        mask_key = recv_exactly(conn, 4)
        if mask_key is None:
            return None

    payload = recv_exactly(conn, length) if length else b''
    if payload is None:
        return None

    if masked:
        payload = bytes(payload[i] ^ mask_key[i % 4] for i in range(len(payload)))

    return opcode, payload


def handle_client(conn: socket.socket, addr):
    try:
        request = conn.recv(4096).decode('utf-8', errors='ignore')
        response = build_handshake(request)
        if response is None:
            print('Rejected a connection with no WebSocket key (was that a browser?)')
            conn.close()
            return

        conn.sendall(response.encode())
        with clients_lock:
            clients.append(conn)
        print('Lens connected from ' + str(addr[0]))
        print('Press Enter to send a swing.')
        # Start the Lens off in sync with the current difficulty.
        broadcast(dda.params())

        # See main-nodeps.py: a preview restart leaves the old socket open with
        # nobody on the other end, so without a timeout this thread blocks for
        # ever and the dead client is never dropped from the list.
        conn.settimeout(IDLE_PING_INTERVAL)

        while True:
            try:
                frame = read_frame(conn)
            except socket.timeout:
                conn.sendall(b'\x89\x00')      # ping, empty payload
                continue
            if frame is None:
                break
            opcode, payload = frame

            if opcode == 0x8:  # close
                break
            if opcode == 0x9:  # ping, answer with a pong
                conn.sendall(b'\x8a\x00')
                continue
            if opcode != 0x1:  # only text frames carry our protocol
                continue

            try:
                data = json.loads(payload.decode('utf-8'))
            except (ValueError, UnicodeDecodeError):
                continue

            kind = data.get('type')

            if kind == 'haptic':
                pattern = data.get('pattern')
                name = HAPTIC_NAMES.get(pattern, 'unknown')
                print('  <- haptic ' + str(pattern) + ' (' + name + ')')

            elif kind == 'result':
                # Feed the adaptive model, then push the new difficulty back.
                hit = bool(data.get('hit'))
                mock_stats["swings"] += 1
                if hit:
                    mock_stats["hits"] += 1
                if isinstance(data.get('mood'), str):
                    mock_stats["mood"] = data['mood']
                if isinstance(data.get('score'), (int, float)):
                    mock_stats["score"] = int(data['score'])
                dda.record_result(hit)
                params = dda.params()
                print('  <- result %s   ratio %.2f, difficulty %.2f'
                      % ('HIT ' if hit else 'miss',
                         params['catchRatio'], params['level']))
                broadcast(params)

    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        with clients_lock:
            if conn in clients:
                clients.remove(conn)
        try:
            conn.close()
        except OSError:
            pass
        print('Lens disconnected')


def broadcast(obj):
    msg = encode_frame(json.dumps(obj))
    with clients_lock:
        targets = list(clients)
    if not targets:
        print('  (no Lens connected yet)')
        return
    for conn in targets:
        try:
            conn.sendall(msg)
        except OSError:
            pass


def emit_swing(peak: float):
    '''
    Synthesise one swing the way the net would produce it: an IMU trace fed
    through the predictor, so a 'predict' goes out early, then the confirmed
    'swing' once the peak actually lands.
    '''
    predictor.reset()
    dt = 1.0 / 200.0                 # matches the sketch's sampling rate
    rise = 0.18
    steps = int((rise * 2.0) / dt)
    fired_at = None

    for i in range(steps):
        t = i * dt
        phase = (i * dt) / (rise * 2.0)
        mag = 1.0 + (peak - 1.0) * 0.5 * (1.0 - math.cos(2.0 * math.pi * phase))
        p = predictor.update(t, mag)
        if p and fired_at is None:
            fired_at = t
            mock_stats["predictions"] += 1
            mock_stats["eta"] = p.eta_ms
            mock_stats["conf"] = p.confidence
            msg = {'type': 'predict'}
            msg.update(p.as_dict())
            print('  -> predict, peak in %.0f ms (confidence %.2f)'
                  % (p.eta_ms, p.confidence))
            broadcast(msg)

    if fired_at is None:
        print('  (predictor did not fire, swing too gentle)')

    # Let the early warning land before the confirmed swing, the way the real
    # lead time would.
    time.sleep(0.04)
    print('  -> swing, peak ' + str(peak))
    broadcast({'type': 'swing', 'peak': peak})


def accept_loop(server: socket.socket):
    while True:
        try:
            conn, addr = server.accept()
        except OSError:
            return
        threading.Thread(target=handle_client, args=(conn, addr), daemon=True).start()


def local_ip() -> str:
    '''Best guess at the LAN address the Spectacles should connect to.'''
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(('8.8.8.8', 80))  # no packets are actually sent
        return probe.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        probe.close()


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((HOST, PORT))
    server.listen(4)

    print('LumiCatch mock net listening on port ' + str(PORT))
    print('Set the Lens serverUrl to  ws://' + local_ip() + ':' + str(PORT))
    print('Untick simulate in the Lens, then run it.')
    print('Enter = swing, a number = swing with that peak, q = quit')

    threading.Thread(target=accept_loop, args=(server,), daemon=True).start()
    start_dashboard(dashboard_state)

    try:
        for line in sys.stdin:
            text = line.strip().lower()
            if text == 'q':
                break
            peak = DEFAULT_PEAK
            if text:
                try:
                    peak = float(text)
                except ValueError:
                    print('Not a number, using ' + str(DEFAULT_PEAK))
            emit_swing(peak)

        # stdin reached EOF: backgrounded, or fed from /dev/null. Keep serving
        # rather than exiting, otherwise the server dies the moment it starts.
        print('stdin closed, serving without keyboard control. Ctrl-C to stop.')
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
        print('\nMock net stopped')


if __name__ == '__main__':
    main()
