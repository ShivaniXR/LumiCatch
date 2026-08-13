# LumiCatch Net - Linux side (Arduino UNO Q, Qualcomm/Debian side)
# ----------------------------------------------------------------
# - Polls the MCU over the Bridge for swing events (~30 Hz).
# - Runs a WebSocket server on port 8765 for Snap Spectacles.
# - Forwards swings to Spectacles; forwards haptic commands back
#   to the MCU.
#
# One-time setup (App Lab console / SSH):
#   sudo apt install python3-websockets
#
# Protocol (JSON text frames):
#   Net -> Spectacles : {"type": "swing", "peak": 2.7}
#   Spectacles -> Net : {"type": "haptic", "pattern": 3}
#     patterns: 1 nearby, 2 rare, 3 capture, 4 combo

import asyncio
import json
import threading
import time

import websockets
from arduino.app_utils import *

WS_PORT = 8765
POLL_INTERVAL = 0.03  # seconds

clients = set()
ws_loop = None
bridge_lock = threading.Lock()


async def handler(ws):
    print(f"Spectacles connected: {ws.remote_address}")
    clients.add(ws)
    try:
        async for msg in ws:
            try:
                data = json.loads(msg)
            except (ValueError, TypeError):
                continue
            if data.get("type") == "haptic":
                pattern = int(data.get("pattern", 3))
                with bridge_lock:
                    Bridge.call("play_haptic", pattern)
                print(f"Haptic pattern {pattern} sent to net")
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


def loop():
    with bridge_lock:
        peak = Bridge.call("get_event")
    if peak and peak > 0:
        print(f"Swing detected, peak {peak:.2f} g")
        broadcast({"type": "swing", "peak": round(float(peak), 2)})
    time.sleep(POLL_INTERVAL)


App.run(user_loop=loop)
