# Neon-Net - Linux side (Arduino UNO Q, Qualcomm/Debian side)
# ------------------------------------------------------------
# This is the Kinetic Engine's brain. It runs inside App Lab on the Qualcomm
# side and does three jobs:
#
#   1. Pulls the IMU sample stream off the STM32 over the Bridge.
#   2. Runs both AI models from neon_ai.py:
#        - TrajectoryPredictor, forecasting a swing's peak up to 100 ms early
#          so the Spectacles can be warned before the net actually arrives.
#        - AdaptiveDifficulty, watching the catch-to-swing ratio and steering
#          creature behaviour to hold the player in flow.
#   3. Serves a local WebSocket on port 8765 for the Spectacles.
#
# Nothing leaves the local network. All inference is on the edge.
#
# One-time setup (App Lab console / SSH):
#   sudo apt install python3-websockets
#
# Protocol (JSON text frames):
#   Net -> Lens : {"type": "predict", "etaMs": 84, "predictedPeak": 3.4,
#                  "confidence": 0.62}
#   Net -> Lens : {"type": "swing", "peak": 2.7}
#   Net -> Lens : {"type": "difficulty", "level": 0.6, "speedMult": 1.48, ...}
#   Lens -> Net : {"type": "haptic", "pattern": 3}
#   Lens -> Net : {"type": "result", "hit": true}

import asyncio
import json
import threading
import time

import websockets
from arduino.app_utils import *

from neon_ai import AdaptiveDifficulty, TrajectoryPredictor

WS_PORT = 8765
POLL_INTERVAL = 0.03          # seconds, ~30 Hz
MCU_SAMPLE_INTERVAL = 0.005   # the sketch samples at ~200 Hz

clients = set()
ws_loop = None
bridge_lock = threading.Lock()

# The two models. Identical code to the ones tested on the laptop.
predictor = TrajectoryPredictor(horizon_ms=100.0)
dda = AdaptiveDifficulty()

# Monotonic clock for the reconstructed sample timestamps.
sample_clock = 0.0


async def handler(ws):
    print(f"Spectacles connected: {ws.remote_address}")
    clients.add(ws)
    try:
        # Start the Lens in sync with the current difficulty.
        await ws.send(json.dumps(dda.params()))

        async for msg in ws:
            try:
                data = json.loads(msg)
            except (ValueError, TypeError):
                continue

            kind = data.get("type")

            if kind == "haptic":
                pattern = int(data.get("pattern", 3))
                # Guarded, so a failed buzz cannot drop the Spectacles
                # connection. Losing one vibration is nothing; losing the
                # socket mid-take means reconnecting on camera.
                bridge_call("play_haptic", pattern)
                print(f"Haptic pattern {pattern} sent to net")

            elif kind == "result":
                # Feed the adaptive model and push the new difficulty out.
                hit = bool(data.get("hit"))
                dda.record_result(hit)
                params = dda.params()
                print("Result %s | ratio %.2f | difficulty %.2f"
                      % ("HIT" if hit else "miss",
                         params["catchRatio"], params["level"]))
                broadcast(params)

    except websockets.ConnectionClosed:
        pass
    finally:
        clients.discard(ws)
        print("Spectacles disconnected")


async def ws_main():
    global ws_loop
    ws_loop = asyncio.get_running_loop()
    async with websockets.serve(handler, "0.0.0.0", WS_PORT):
        print(f"WebSocket server listening on port {WS_PORT}")
        await asyncio.Future()  # run forever


def start_ws_thread():
    asyncio.run(ws_main())


threading.Thread(target=start_ws_thread, daemon=True).start()


def broadcast(obj):
    if ws_loop is None:
        return
    msg = json.dumps(obj)
    for ws in list(clients):
        asyncio.run_coroutine_threadsafe(ws.send(msg), ws_loop)


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


def loop():
    global sample_clock

    # ---- 1. Drain the IMU sample buffer and run the predictor ----
    raw = bridge_call("get_samples")

    for mag in parse_samples(raw):
        sample_clock += MCU_SAMPLE_INTERVAL
        prediction = predictor.update(sample_clock, mag)
        if prediction:
            print("Predicted swing peak in %.0f ms (confidence %.2f)"
                  % (prediction.eta_ms, prediction.confidence))
            msg = {"type": "predict"}
            msg.update(prediction.as_dict())
            broadcast(msg)

    # ---- 2. Confirmed swings still come from the MCU's own detector ----
    peak = bridge_call("get_event")
    if peak and peak > 0:
        print(f"Swing detected, peak {peak:.2f} g")
        broadcast({"type": "swing", "peak": round(float(peak), 2)})

    time.sleep(POLL_INTERVAL)


App.run(user_loop=loop)
