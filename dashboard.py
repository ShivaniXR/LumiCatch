# Neon-Net - App Lab game dashboard
# ----------------------------------
# Hosted by the Arduino UNO Q's Qualcomm Linux side, alongside the WebSocket
# server. This is the App Lab half of the project made visible: it shows the
# multiplayer sessions the board is managing, and what the two AI models are
# doing to each player, without anyone having to wear the glasses.
#
# Written to be understood at a glance by someone who has never seen the
# project. Every number is labelled in plain English, and each player card says
# in a sentence what the difficulty AI just decided and why. The players are the
# top of the page, not a footnote, because the multiplayer sessions are the
# thing worth showing.
#
# Zero dependencies: the standard library's HTTP server only, matching the rest
# of the Linux side. Nothing to install on the board, and no webfonts or CDNs,
# since the board is often on a hotspot with no route to the internet.
#
# It is deliberately decoupled: it takes a callable that returns the current
# state as a dict, so main.py (real hardware) and mock-net.py (laptop) can both
# serve the same dashboard.
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
 /* A single, deliberately dark instrument panel. It is filmed beside gameplay
    footage shot in a dim room, so it commits to one look rather than tracking
    the viewer's theme. Every colour is painted explicitly. */
 :root{
   --abyss:#06101a;      /* page ground */
   --panel:#0d1a26;      /* card ground */
   --panel-2:#112331;    /* nested wells */
   --line:#1d3040;
   --ink:#dcecf2;
   --dim:#6b8896;        /* slate with a cyan bias, not a neutral grey */
   --cyan:#2ff0e0;
   --violet:#8a7dff;
   --gold:#ffc247;
   --coral:#ff6b7a;
 }
 *{box-sizing:border-box}
 html{-webkit-text-size-adjust:100%}
 body{
   margin:0;background:var(--abyss);color:var(--ink);
   font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
   font-size:15px;line-height:1.55;
 }
 .mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
 .num{font-variant-numeric:tabular-nums;
   font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}

 .wrap{max-width:1060px;margin:0 auto;padding:26px 18px 64px;
   display:flex;flex-direction:column;gap:26px}

 /* ---- header ---- */
 header{display:flex;justify-content:space-between;align-items:flex-start;
   flex-wrap:wrap;gap:14px;border-bottom:1px solid var(--line);
   padding-bottom:16px}
 h1{margin:0;font-size:19px;letter-spacing:.18em;text-transform:uppercase;
   font-weight:600}
 header p{margin:6px 0 0;color:var(--dim);font-size:13px;max-width:56ch}
 .live{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dim);
   letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}
 .dot{width:8px;height:8px;border-radius:50%;background:var(--cyan);
   box-shadow:0 0 10px var(--cyan);animation:p 1.6s infinite}
 .dot.off{background:#4a5c67;box-shadow:none;animation:none}
 @keyframes p{0%,100%{opacity:1}50%{opacity:.25}}
 @media (prefers-reduced-motion:reduce){.dot{animation:none}}

 /* ---- shared bits ---- */
 .k{font-size:10.5px;letter-spacing:.15em;text-transform:uppercase;
   color:var(--dim)}
 section>h2{margin:0 0 4px;font-size:12px;letter-spacing:.16em;
   text-transform:uppercase;color:var(--ink);font-weight:600}
 section>p.lead{margin:0 0 14px;color:var(--dim);font-size:13px;max-width:64ch}

 /* ---- player cards: the hero of the page ---- */
 .players{display:grid;gap:14px;
   grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
 .player{background:var(--panel);border:1px solid var(--line);border-radius:6px;
   padding:18px;display:flex;flex-direction:column;gap:16px}
 .player.lead-player{border-color:#2f4a52;box-shadow:inset 3px 0 0 var(--gold)}
 .phead{display:flex;justify-content:space-between;align-items:flex-start;
   gap:10px}
 .pname{font-size:17px;font-weight:600;letter-spacing:.03em}
 .paddr{font-size:11.5px;color:var(--dim);margin-top:2px}
 .chip{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;
   padding:3px 8px;border:1px solid currentColor;border-radius:99px;
   white-space:nowrap}
 .calm{color:var(--cyan)}
 .curious{color:var(--violet)}
 .spooked{color:var(--gold)}
 .mode{font-size:10px;letter-spacing:.14em;text-transform:uppercase;
   padding:2px 7px;border-radius:99px;white-space:nowrap;margin-left:7px}
 .mode.solo{color:var(--dim);border:1px solid var(--line)}
 .mode.shared{color:#0a1620;background:var(--violet);font-weight:600}
 .crown{color:var(--gold);font-size:10.5px;letter-spacing:.14em;
   text-transform:uppercase;margin-top:6px;display:block}

 .pstats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
 .pstats .v{font-size:27px;margin-top:3px;line-height:1.15}
 .pstats small{display:block;font-size:11.5px;color:var(--dim);
   font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;margin-top:2px}

 .diff{background:var(--panel-2);border-radius:4px;padding:13px 14px}
 .dhead{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
 .dband{font-size:13px}
 .bar{height:7px;background:#0a1620;border-radius:4px;overflow:hidden;
   margin-top:9px}
 .bar i{display:block;height:100%;border-radius:4px;transition:width .45s ease}
 .note{margin:10px 0 0;font-size:12.5px;color:var(--dim);line-height:1.5}

 .empty{background:var(--panel);border:1px dashed var(--line);border-radius:6px;
   padding:26px 20px;color:var(--dim);font-size:13.5px}
 .empty strong{color:var(--ink);display:block;margin-bottom:6px;
   font-weight:600;font-size:14px}

 /* ---- the two AI models ---- */
 .models{display:grid;gap:14px;
   grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
 .model{background:var(--panel);border:1px solid var(--line);border-radius:6px;
   padding:18px;display:flex;flex-direction:column;gap:14px}
 .mname{font-size:14px;font-weight:600;letter-spacing:.03em}
 .mname span{display:block;font-size:10.5px;letter-spacing:.14em;
   text-transform:uppercase;color:var(--cyan);margin-bottom:5px;font-weight:400}
 .model.b .mname span{color:var(--violet)}
 .mdesc{margin:0;font-size:12.5px;color:var(--dim);line-height:1.55}
 .mstats{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;
   border-top:1px solid var(--line);padding-top:13px;margin-top:auto}
 .mstats .v{font-size:22px;margin-top:3px}

 /* ---- footer strip ---- */
 .strip{display:flex;flex-wrap:wrap;gap:22px 34px;border-top:1px solid var(--line);
   padding-top:16px;color:var(--dim);font-size:12.5px}
 .strip b{color:var(--ink);font-weight:600}
</style></head><body>
<div class="wrap">

 <header>
   <div>
     <h1>Neon-Net Control</h1>
     <p>Running on the Arduino UNO Q. It hosts the game, keeps one session per
        player, and re-tunes the jellyfish for each of them independently.</p>
   </div>
   <div class="live"><span class="dot" id="dot"></span><span id="status">connecting</span></div>
 </header>

 <section>
   <h2>Players in this world</h2>
   <p class="lead">Every pair of Spectacles that connects gets its own session
      and its own difficulty AI, so two people of different skill can share the
      same room and each get a fair game.</p>
   <div class="players" id="players"></div>
 </section>

 <section id="shoalsec" style="display:none">
   <h2>The shared shoal</h2>
   <p class="lead">When players choose the shared game, the board stops keeping
      score for two separate worlds and starts running one. Every creature below
      lives on the UNO Q: it decides where they drift, when they bolt, and which
      player got there first.</p>
   <div class="models">
     <div class="model a">
       <div class="mname"><span>Authoritative</span>One shoal, on the board</div>
       <p class="mdesc">The headsets render what they are told and ask
          permission to catch. Two players lunging at the same jellyfish cannot
          both score it, because only one claim is ever granted.</p>
       <div class="mstats">
         <div><div class="k">Creatures in the water</div><div class="v num" id="shoalsize">--</div></div>
         <div><div class="k">In the shared game</div><div class="v num" id="sharedn">0</div></div>
       </div>
     </div>
     <div class="model b">
       <div class="mname"><span>Shoal state</span>How it feels about you</div>
       <p class="mdesc">Calm by default. Three quick catches and it panics,
          groups tight and backs away. Keep missing and it turns curious and
          drifts closer to see what you are.</p>
       <div class="mstats">
         <div><div class="k">Mood</div><div class="v" id="shoalmood">--</div></div>
         <div><div class="k">Broadcast rate</div><div class="v num">15 Hz</div></div>
       </div>
     </div>
   </div>
 </section>

 <section>
   <h2>The AI running on the board</h2>
   <p class="lead">Both models run on the UNO Q's Qualcomm Linux side. Nothing
      is sent to the cloud.</p>
   <div class="models">
     <div class="model a">
       <div class="mname"><span>Model 1</span>Predictive Trajectory AI</div>
       <p class="mdesc">Reads the net's motion 200 times a second and works out
          when the swing will peak, roughly a tenth of a second before it does.
          The glasses are told a catch is coming while the net is still moving,
          which is what hides the wireless delay.</p>
       <div class="mstats">
         <div><div class="k">Swings forecast</div><div class="v num" id="preds">0</div></div>
         <div><div class="k">Warning given</div><div class="v num" id="eta">--</div></div>
       </div>
     </div>
     <div class="model b">
       <div class="mname"><span>Model 2</span>Adaptive Difficulty AI</div>
       <p class="mdesc">Watches how often each player actually catches something
          over their last ten swings and moves their difficulty to keep them near
          a 55 per cent catch rate. Too easy and the shoal speeds up and starts
          cloaking; too hard and it eases off.</p>
       <div class="mstats">
         <div><div class="k">Players tuned</div><div class="v num" id="tuned">0</div></div>
         <div><div class="k">Forecast confidence</div><div class="v num" id="conf">--</div></div>
       </div>
     </div>
   </div>
 </section>

 <div class="strip">
   <span><b id="swings">0</b> swings taken</span>
   <span><b id="catches">0</b> jellyfish caught</span>
   <span>running for <b id="up">--</b></span>
   <span>refreshing twice a second</span>
 </div>

</div>
<script>
function pct(x){ return Math.round((x||0)*100) + '%'; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,
  function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

// Plain words for a number between 0 and 1, so nobody has to know what 0.45
// means. The bands match what the Lens actually does at each level.
function band(d){
  if(d < 0.25) return {word:'Gentle',   col:'var(--cyan)'};
  if(d < 0.45) return {word:'Easy',     col:'var(--cyan)'};
  if(d < 0.65) return {word:'Balanced', col:'var(--violet)'};
  if(d < 0.85) return {word:'Hard',     col:'var(--gold)'};
  return           {word:'Brutal',   col:'var(--coral)'};
}

// What the difficulty AI last decided, said out loud. The thresholds are the
// model's real target and dead band, sent with the state rather than guessed.
function note(p){
  var target = (p.target_ratio == null) ? 0.55 : p.target_ratio;
  var dead   = (p.dead_band == null) ? 0.12 : p.dead_band;
  if(p.swings < 4)
    return 'Watching the first few swings before it changes anything.';
  if(p.catch_ratio > target + dead)
    return 'Catching more than ' + pct(target) + ' of swings, so the shoal was '
         + 'sped up and made harder to sneak up on.';
  if(p.catch_ratio < target - dead)
    return 'Catching less than ' + pct(target) + ' of swings, so the shoal was '
         + 'slowed down and made less jumpy.';
  return 'Catch rate is inside the ' + pct(target - dead) + ' to '
       + pct(target + dead) + ' band the AI aims for, so difficulty is '
       + 'holding steady.';
}

function moodChip(m){
  var words = {calm:'Shoal calm', curious:'Shoal curious',
               spooked:'Shoal spooked'};
  var cls = (m === 'curious' || m === 'spooked') ? m : 'calm';
  return '<span class="chip ' + cls + '">' + (words[cls]) + '</span>';
}

function playerCard(p, leading, many){
  var d = p.difficulty || 0, b = band(d);
  return '<article class="player' + (leading ? ' lead-player' : '') + '">'
    + '<div class="phead"><div>'
    +   '<div class="pname">Player ' + esc(p.id)
    +     '<span class="mode ' + (p.mode === 'shared' ? 'shared' : 'solo')
    +     '">' + (p.mode === 'shared' ? 'shared shoal' : 'solo')
    +     '</span></div>'
    +   '<div class="paddr mono">' + esc(p.address) + '</div>'
    +   (leading && many ? '<span class="crown">Leading</span>' : '')
    + '</div>' + moodChip(p.mood) + '</div>'
    + '<div class="pstats">'
    +   '<div><div class="k">Score</div><div class="v num">'
    +     (p.score == null ? '--' : esc(p.score)) + '</div></div>'
    +   '<div><div class="k">Caught</div><div class="v num">' + esc(p.hits)
    +     '<small>of ' + esc(p.swings) + ' swings</small></div></div>'
    +   '<div><div class="k">Catch rate</div><div class="v num">'
    +     pct(p.catch_ratio) + '</div></div>'
    + '</div>'
    + '<div class="diff">'
    +   '<div class="dhead"><span class="k">Difficulty the AI chose</span>'
    +     '<span class="dband num" style="color:' + b.col + '">' + b.word
    +     '  ' + d.toFixed(2) + '</span></div>'
    +   '<div class="bar"><i style="width:' + pct(d) + ';background:' + b.col
    +     '"></i></div>'
    +   '<p class="note">' + note(p) + '</p>'
    + '</div></article>';
}

var EMPTY = '<div class="empty"><strong>Nobody is playing yet.</strong>'
  + 'Put on the Spectacles and start the Lens with <span class="mono">simulate'
  + '</span> unticked. Each pair that connects appears here as its own session '
  + 'with its own difficulty AI. Run a second client to see multiplayer.</div>';

function fmtUptime(s){
  s = Math.floor(s || 0);
  var m = Math.floor(s / 60);
  return m ? (m + 'm ' + (s % 60) + 's') : (s + 's');
}

async function tick(){
  try{
    const r = await fetch('/state', {cache:'no-store'});
    const s = await r.json();
    document.getElementById('status').textContent = 'live';
    document.getElementById('dot').classList.remove('off');

    var ps = (s.sessions || []).slice();
    // Highest score first, so the leaderboard reads top-left downwards.
    ps.sort(function(a, b){ return (b.score || 0) - (a.score || 0)
                                || a.id - b.id; });
    var many = ps.length > 1;
    document.getElementById('players').innerHTML = ps.length
      ? ps.map(function(p, i){ return playerCard(p, i === 0, many); }).join('')
      : EMPTY;

    // The shoal panel appears only once somebody is actually playing the
    // shared game, so a solo session is not cluttered with it.
    var sharedN = s.shared_players || 0;
    document.getElementById('shoalsec').style.display =
      sharedN > 0 ? '' : 'none';
    document.getElementById('sharedn').textContent = sharedN;
    document.getElementById('shoalsize').textContent =
      (s.shoal_size == null) ? '--' : s.shoal_size;
    var mood = s.shoal_mood || 'calm';
    var moodEl = document.getElementById('shoalmood');
    moodEl.textContent = mood;
    moodEl.className = 'v ' + mood;

    document.getElementById('tuned').textContent   = ps.length;
    document.getElementById('preds').textContent   = s.predictions;
    document.getElementById('swings').textContent  = s.total_swings;
    document.getElementById('catches').textContent = s.total_hits;
    document.getElementById('eta').textContent =
      s.last_eta_ms ? s.last_eta_ms.toFixed(0) + ' ms' : '--';
    document.getElementById('conf').textContent =
      s.last_confidence ? s.last_confidence.toFixed(2) : '--';
    document.getElementById('up').textContent = fmtUptime(s.uptime_s);
  }catch(e){
    document.getElementById('status').textContent = 'offline';
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

    Each session should carry id, address, swings, hits, catch_ratio,
    difficulty and mood. score, target_ratio and dead_band are optional; the
    page falls back sensibly when they are missing.
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
