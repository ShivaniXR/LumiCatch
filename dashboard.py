# Neon-Net - App Lab game dashboard
# ----------------------------------
# Hosted by the Arduino UNO Q's Qualcomm Linux side, alongside the WebSocket
# server. Shows live session state so an operator, or a judge, can watch the
# AI working without wearing the glasses.
#
# Zero dependencies: the standard library's HTTP server only, matching the
# rest of the Linux side. Nothing to install on the board.
#
# It is deliberately decoupled: it takes a callable that returns the current
# state as a dict, so main.py (real hardware) and mock-net.py (laptop) can
# both serve the same dashboard.
#
#   from dashboard import start_dashboard
#   start_dashboard(lambda: {...}, port=8080)

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

DASHBOARD_PORT = 8080

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neon-Net Control</title>
<style>
 :root{
   --bg:#070d12;--panel:#0e1922;--line:#1b2a36;--ink:#dff2f6;--dim:#6d8794;
   --cyan:#26f0ff;--violet:#7a80ff;--gold:#ffc93c;
 }
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);
   font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
   font-size:15px;line-height:1.5}
 .wrap{max-width:1000px;margin:0 auto;padding:28px 18px 60px;
   display:flex;flex-direction:column;gap:24px}
 header{display:flex;justify-content:space-between;align-items:baseline;
   flex-wrap:wrap;gap:10px;border-bottom:1px solid var(--line);padding-bottom:14px}
 h1{margin:0;font-size:20px;letter-spacing:.14em;text-transform:uppercase}
 .live{font-size:12px;color:var(--dim);display:flex;align-items:center;gap:8px}
 .dot{width:8px;height:8px;border-radius:50%;background:var(--cyan);
   box-shadow:0 0 10px var(--cyan);animation:p 1.6s infinite}
 .dot.off{background:#54646f;box-shadow:none}
 @keyframes p{0%,100%{opacity:1}50%{opacity:.25}}
 @media (prefers-reduced-motion:reduce){.dot{animation:none}}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:16px}
 .k{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
 .v{font-size:30px;margin-top:6px;font-variant-numeric:tabular-nums}
 h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);
   margin:0 0 10px;font-weight:400}
 table{width:100%;border-collapse:collapse;font-size:14px}
 th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}
 th{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);font-weight:400}
 td.n{text-align:right;font-variant-numeric:tabular-nums}
 .bar{height:6px;background:#122029;border-radius:3px;overflow:hidden;margin-top:8px}
 .bar i{display:block;height:100%;background:var(--cyan);transition:width .4s}
 .tag{font-size:11px;padding:2px 7px;border:1px solid currentColor;border-radius:2px}
 .calm{color:var(--cyan)}.curious{color:var(--violet)}.spooked{color:var(--gold)}
 .empty{color:var(--dim);padding:18px 10px}
 .wrapover{overflow-x:auto}
</style></head><body>
<div class="wrap">
 <header>
   <h1>Neon-Net Control</h1>
   <div class="live"><span class="dot" id="dot"></span><span id="status">connecting</span></div>
 </header>

 <div class="grid">
   <div class="card"><div class="k">Sessions</div><div class="v" id="sessions">0</div></div>
   <div class="card"><div class="k">Swings</div><div class="v" id="swings">0</div></div>
   <div class="card"><div class="k">Catches</div><div class="v" id="catches">0</div></div>
   <div class="card"><div class="k">Predictions</div><div class="v" id="preds">0</div></div>
 </div>

 <div class="card">
   <h2>Players</h2>
   <div class="wrapover">
   <table><thead><tr>
     <th>Session</th><th>Address</th><th class="n">Swings</th>
     <th class="n">Catches</th><th class="n">Catch rate</th><th>Difficulty</th>
   </tr></thead><tbody id="rows"></tbody></table>
   </div>
 </div>

 <div class="card">
   <h2>Kinetic engine</h2>
   <div class="grid">
     <div><div class="k">Last predicted lead</div><div class="v" id="eta">--</div></div>
     <div><div class="k">Confidence</div><div class="v" id="conf">--</div></div>
     <div><div class="k">Uptime</div><div class="v" id="up">--</div></div>
   </div>
 </div>
</div>
<script>
function pct(x){return (x*100).toFixed(0)+'%';}
async function tick(){
  try{
    const r = await fetch('/state',{cache:'no-store'});
    const s = await r.json();
    document.getElementById('status').textContent='live';
    document.getElementById('dot').classList.remove('off');
    document.getElementById('sessions').textContent=s.sessions.length;
    document.getElementById('swings').textContent=s.total_swings;
    document.getElementById('catches').textContent=s.total_hits;
    document.getElementById('preds').textContent=s.predictions;
    document.getElementById('eta').textContent=s.last_eta_ms?s.last_eta_ms.toFixed(0)+' ms':'--';
    document.getElementById('conf').textContent=s.last_confidence?s.last_confidence.toFixed(2):'--';
    document.getElementById('up').textContent=Math.floor(s.uptime_s)+' s';
    const rows=document.getElementById('rows');
    if(!s.sessions.length){
      rows.innerHTML='<tr><td colspan="6" class="empty">No players connected. Start the Lens with simulate unticked.</td></tr>';
    }else{
      rows.innerHTML=s.sessions.map(p=>`<tr>
        <td>#${p.id} <span class="tag ${p.mood}">${p.mood}</span></td>
        <td>${p.address}</td>
        <td class="n">${p.swings}</td>
        <td class="n">${p.hits}</td>
        <td class="n">${pct(p.catch_ratio)}</td>
        <td>${p.difficulty.toFixed(2)}<div class="bar"><i style="width:${pct(p.difficulty)}"></i></div></td>
      </tr>`).join('');
    }
  }catch(e){
    document.getElementById('status').textContent='offline';
    document.getElementById('dot').classList.add('off');
  }
}
tick(); setInterval(tick, 500);
</script></body></html>
"""


def _lan_address():
    '''
    Best effort at the address another device should use.

    The App runs in a container, so asking the socket layer "what is my
    address" returns the container's own bridge IP (172.x.x.x) rather than the
    board's address on your WiFi. That number is useless from a laptop, so
    detect it and say so rather than print a confident wrong answer.
    '''
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(('8.8.8.8', 80))      # no packets are actually sent
        addr = probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()

    # Docker bridge ranges. 172.16-172.31 is the private block Docker uses.
    first, second = addr.split('.')[0], int(addr.split('.')[1])
    if first == '172' and 16 <= second <= 31:
        return None
    if addr.startswith('127.'):
        return None
    return addr


def start_dashboard(state_provider, port=DASHBOARD_PORT):
    '''
    Serve the dashboard on a background thread.

    state_provider() must return a dict shaped like:
        {sessions: [...], total_swings, total_hits, predictions,
         last_eta_ms, last_confidence, uptime_s}
    '''

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith('/state'):
                self._send(200, 'application/json',
                           json.dumps(state_provider()).encode())
            elif self.path in ('/', '/index.html'):
                self._send(200, 'text/html; charset=utf-8', PAGE.encode())
            else:
                self._send(404, 'text/plain', b'not found')

        def _send(self, code, ctype, body):
            try:
                self.send_response(code)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, fmt, *args):
            pass          # the App Lab console has better things to show

    def serve():
        try:
            HTTPServer(('0.0.0.0', port), Handler).serve_forever()
        except OSError as exc:
            print('Dashboard could not start on port %d: %s' % (port, exc))

    threading.Thread(target=serve, daemon=True).start()
    addr = _lan_address()
    if addr:
        print('Dashboard on http://%s:%d' % (addr, port))
    else:
        print('Dashboard listening on port %d.' % port)
        print('  Running in a container, so the board\'s WiFi address is not')
        print('  visible from here. Get it with  hostname -I  on the board,')
        print('  or from your phone hotspot\'s connected devices list.')
