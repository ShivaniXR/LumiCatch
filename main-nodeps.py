# Neon-Net - Linux side, NO DEPENDENCIES build
# ---------------------------------------------
# Identical behaviour to main.py, but the WebSocket server is raw sockets from
# the standard library instead of the `websockets` package. Use this when
# App Lab will not install dependencies into the app container.
#
# The frame layer here is the same code proven end to end in mock-net.py:
# handshake, masked inbound frames, unmasked outbound frames.
#
# Nothing to install. Nothing to fail on the day.

import json
import threading
import time
import socket
import struct
import base64
import hashlib

from arduino.app_utils import *

from neon_ai import AdaptiveDifficulty, TrajectoryPredictor
from shoal import Shoal
from dashboard import start_dashboard

WS_PORT = 8765
SHOAL_HZ = 15.0               # how often the shared shoal is broadcast
# 50 Hz rather than 30. A swing waits here on average half a poll before it is
# noticed, so this halves that from 15 ms to 10 ms. Small next to the MCU's
# peak window, but it is free: the loop does nothing but two RPC calls unless
# somebody is playing.
POLL_INTERVAL = 0.02          # seconds, ~50 Hz
MCU_SAMPLE_INTERVAL = 0.005   # the sketch samples at ~200 Hz
IDLE_PING_INTERVAL = 30.0     # how often to probe a silent player, seconds

clients = set()
bridge_lock = threading.Lock()

# ---- Multiplayer sessions -------------------------------------------------
# Every connected Lens is a session with its own adaptive difficulty model, so
# two players on the same net world each get tuned to their own skill rather
# than sharing one average. The dashboard reads this.
sessions = {}          # websocket -> Session
sessions_lock = threading.Lock()
next_session_id = 1
started_at = time.time()

stats = {
    "swings_detected": 0,     # swings the MCU reported
    "predictions": 0,         # forecasts the trajectory model emitted
    "last_eta_ms": 0.0,
    "last_confidence": 0.0,
}


# The shared shoal, simulated here rather than in either headset.
#
# This is what makes two players a game rather than two separate games: there
# is one list of creatures, the board moves them, and the board decides who
# caught what. A headset in SOLO mode ignores all of it and runs its own
# creatures locally, exactly as before.
shoal = Shoal()
shoal_lock = threading.Lock()
_last_shoal_send = 0.0


class Session:
    """One connected player."""

    def __init__(self, sid, address):
        self.id = sid
        self.address = address
        self.mode = "solo"
        self.dda = AdaptiveDifficulty()
        self.swings = 0
        self.hits = 0
        self.mood = "calm"
        self.score = 0          # the Lens is the authority on this

    def as_dict(self):
        return {
            "id": self.id,
            "address": self.address,
            "swings": self.swings,
            "hits": self.hits,
            "score": self.score,
            "catch_ratio": (self.hits / self.swings) if self.swings else 0.0,
            "difficulty": self.dda.level(),
            "mood": self.mood,
            "mode": self.mode,
            # The dashboard explains in words why difficulty moved, so it needs
            # the model's real thresholds rather than a second copy of them.
            "target_ratio": self.dda.target_ratio,
            "dead_band": self.dda.dead_band,
        }


MOOD_NAMES = {0: "calm", 1: "spooked", 2: "curious"}


def dashboard_state():
    with sessions_lock:
        players = [s.as_dict() for s in sessions.values()]
    with shoal_lock:
        shoal_size = len(shoal.creatures)
        shoal_mood = MOOD_NAMES.get(shoal.mood, "calm")
    return {
        "sessions": sorted(players, key=lambda p: p["id"]),
        "total_swings": stats["swings_detected"],
        "total_hits": sum(p["hits"] for p in players),
        "predictions": stats["predictions"],
        "last_eta_ms": stats["last_eta_ms"],
        "last_confidence": stats["last_confidence"],
        "uptime_s": time.time() - started_at,
        # The shared shoal, so the dashboard can show that the board really is
        # running the world rather than just keeping score for it.
        "shared_players": sum(1 for p in players if p.get("mode") == "shared"),
        "shoal_size": shoal_size,
        "shoal_mood": shoal_mood,
    }

# The trajectory model is shared: there is one net, so one motion stream.
# Difficulty is per player instead, and lives on each Session.
predictor = TrajectoryPredictor(horizon_ms=100.0)

# Monotonic clock for the reconstructed sample timestamps.
sample_clock = 0.0


WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

HAPTIC_NAMES = {
    1: 'nearby',
    2: 'rare',
    3: 'capture',
    4: 'combo'
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



def _send_text(conn, payload: str):
    data = payload.encode('utf-8')
    hdr = bytearray([0x81])
    n = len(data)
    if n < 126:
        hdr.append(n)
    elif n < (1 << 16):
        hdr.append(126)
        hdr.extend(struct.pack('>H', n))
    else:
        hdr.append(127)
        hdr.extend(struct.pack('>Q', n))
    conn.sendall(bytes(hdr) + data)


def handle_client(conn, addr):
    global next_session_id
    with sessions_lock:
        sid = next_session_id
        next_session_id += 1
        session = Session(sid, addr[0])
        sessions[conn] = session
    clients.add(conn)
    print(f"Player {sid} joined from {addr[0]}")

    try:
        request = conn.recv(4096).decode('utf-8', errors='ignore')
        response = build_handshake(request)
        if response is None:
            conn.close()
            return
        conn.sendall(response.encode())
        _send_text(conn, json.dumps(session.dda.params()))

        # Without this, a Lens that goes away without closing cleanly, which is
        # what happens every time the preview restarts, leaves this thread
        # blocked on recv forever and its session listed on the dashboard for
        # good. Rehearse a few times and the board invents a dozen players.
        conn.settimeout(IDLE_PING_INTERVAL)

        while True:
            try:
                frame = read_frame(conn)
            except socket.timeout:
                # The Lens only speaks when something happens, so a long
                # silence is normal and is never on its own grounds to drop a
                # player. Poke the socket instead: if the peer is gone its
                # machine answers with a reset, and the next read raises, which
                # ends this thread and clears the session below.
                conn.sendall(b'\x89\x00')      # ping, empty payload
                continue
            if frame is None:
                break
            opcode, payload = frame
            if opcode == 0x8:
                break
            if opcode == 0x9:
                conn.sendall(b'\x8a\x00')
                continue
            if opcode != 0x1:
                continue
            try:
                data = json.loads(payload.decode('utf-8'))
            except (ValueError, UnicodeDecodeError):
                continue

            kind = data.get("type")
            if kind == "hello":
                # The headset declares which game it is playing. SHARED means
                # it renders the board's shoal; SOLO means it runs its own and
                # only wants difficulty and swing prediction.
                session.mode = (
                    "shared" if data.get("mode") == "shared" else "solo"
                )
                with shoal_lock:
                    if session.mode == "shared":
                        shoal.add_player(sid)
                    else:
                        shoal.remove_player(sid)
                print("Player %d is playing %s" % (sid, session.mode))
                _send_text(conn, json.dumps({
                    "type": "mode", "mode": session.mode, "player": sid
                }))

            elif kind == "pose":
                # Head position in the shared room frame. The creatures need it
                # to know when to bolt, and it is the only per-frame message
                # the headset sends, so it stays four numbers and no more.
                with shoal_lock:
                    shoal.set_pose(
                        sid,
                        (data.get("x", 0.0), data.get("y", 0.0),
                         data.get("z", 0.0)),
                        (data.get("fx", 0.0), data.get("fy", 0.0),
                         data.get("fz", -1.0)),
                    )

            elif kind == "claim":
                # 'I caught number 7.' The board decides. First claim wins, so
                # two players lunging at the same creature cannot both score.
                cid = int(data.get("id", -1))
                with shoal_lock:
                    ok, ckind, pts = shoal.claim(sid, cid)
                if ok:
                    session.score += pts
                    session.swings += 1
                    session.hits += 1
                    session.dda.record_result(True)
                    broadcast({"type": "taken", "id": cid,
                               "by": sid, "kind": ckind, "points": pts})
                    print("Player %d caught #%d (kind %d, %d points)"
                          % (sid, cid, ckind, pts))
                    _send_text(conn, json.dumps(session.dda.params()))
                _send_text(conn, json.dumps({
                    "type": "claimed", "id": cid, "ok": bool(ok),
                    "points": pts if ok else 0
                }))

            elif kind == "haptic":
                pattern = int(data.get("pattern", 3))
                bridge_call("play_haptic", pattern)
                print(f"Player {sid}: haptic {pattern}")
            elif kind == "result":
                hit = bool(data.get("hit"))
                session.swings += 1
                if hit:
                    session.hits += 1
                if isinstance(data.get("mood"), str):
                    session.mood = data["mood"]
                if isinstance(data.get("score"), (int, float)):
                    session.score = int(data["score"])
                session.dda.record_result(hit)
                params = session.dda.params()
                # The board's own creatures obey the same difficulty the Lens
                # does, or a shared shoal would ignore the AI entirely.
                with shoal_lock:
                    shoal.set_difficulty(params)
                    if not hit:
                        shoal.record_miss(sid)
                print("Player %d %s | ratio %.2f | difficulty %.2f"
                      % (sid, "HIT " if hit else "miss",
                         params["catchRatio"], params["level"]))
                _send_text(conn, json.dumps(params))
    except (OSError, ConnectionResetError, BrokenPipeError):
        pass
    finally:
        clients.discard(conn)
        with shoal_lock:
            shoal.remove_player(sid)
        with sessions_lock:
            sessions.pop(conn, None)
        try:
            conn.close()
        except OSError:
            pass
        print(f"Player {sid} left")


def _accept_loop(server):
    while True:
        try:
            conn, addr = server.accept()
        except OSError:
            return
        threading.Thread(target=handle_client, args=(conn, addr),
                         daemon=True).start()


def start_ws_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", WS_PORT))
    server.listen(8)
    print(f"WebSocket server listening on port {WS_PORT}")
    threading.Thread(target=_accept_loop, args=(server,), daemon=True).start()


start_ws_server()
start_dashboard(dashboard_state)


def broadcast(obj):
    msg = json.dumps(obj)
    for conn in list(clients):
        try:
            _send_text(conn, msg)
        except OSError:
            pass


def parse_samples(raw):
    '''
    The sketch hands back the magnitudes captured since the last call, as a
    comma separated string such as "1.02,1.15,1.44". Returns a list of floats,
    empty if there was nothing or the payload was malformed.
    '''
    if not raw:
        return []
    out = []
    for piece in str(raw).split(","):
        piece = piece.strip()
        if not piece:
            continue
        try:
            out.append(float(piece))
        except ValueError:
            continue
    return out


bridge_errors = 0


def bridge_call(name, *args):
    '''
    Call the MCU, and never let a failure escape. An exception raised out of
    the user loop can take the whole Linux side down, which mid-take means
    the net simply stops existing. A dropped poll is recoverable; a dead
    process is not.
    '''
    global bridge_errors
    try:
        with bridge_lock:
            result = Bridge.call(name, *args)
        bridge_errors = 0
        return result
    except Exception as exc:                      # noqa: BLE001
        bridge_errors += 1
        # Only complain occasionally, or a persistent fault floods the console
        # and hides everything else.
        if bridge_errors == 1 or bridge_errors % 100 == 0:
            print("Bridge call %s failed (%d in a row): %s"
                  % (name, bridge_errors, exc))
        return None


def _shared_players():
    with sessions_lock:
        return [s for s in sessions.values() if s.mode == "shared"]


def loop():
    global sample_clock, _last_shoal_send

    # ---- 0. Step the shared shoal and tell everyone where it is ----
    #
    # Only when somebody is actually playing the shared game. A solo player
    # costs nothing here, and with nobody connected the board does no work.
    now = time.time()
    if _shared_players():
        dt = now - _last_shoal_send if _last_shoal_send else POLL_INTERVAL
        if dt >= 1.0 / SHOAL_HZ:
            _last_shoal_send = now
            with shoal_lock:
                shoal.update(dt)
                snap = shoal.snapshot()
            broadcast(snap)

    # ---- 1. Drain the IMU sample buffer and run the predictor ----
    raw = bridge_call("get_samples")

    for mag in parse_samples(raw):
        sample_clock += MCU_SAMPLE_INTERVAL
        prediction = predictor.update(sample_clock, mag)
        if prediction:
            stats["predictions"] += 1
            stats["last_eta_ms"] = prediction.eta_ms
            stats["last_confidence"] = prediction.confidence
            print("Predicted swing peak in %.0f ms (confidence %.2f)"
                  % (prediction.eta_ms, prediction.confidence))
            msg = {"type": "predict"}
            msg.update(prediction.as_dict())
            broadcast(msg)

    # ---- 2. Confirmed swings still come from the MCU's own detector ----
    peak = bridge_call("get_event")
    if peak and peak > 0:
        stats["swings_detected"] += 1
        print(f"Swing detected, peak {peak:.2f} g")
        broadcast({"type": "swing", "peak": round(float(peak), 2)})

    time.sleep(POLL_INTERVAL)


App.run(user_loop=loop)
