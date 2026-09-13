# LumiCatch Build Guide

A step-by-step path from a bag of parts to a filmed, working demo. Each phase ends with something testable, so you always know the last thing that worked. Budget build: Arduino UNO Q (owned), MPU-6050, ERM coin motor with a 2N2222 transistor, aquarium fish net, power bank.

## How the system fits together

```
[Physical net]
  MPU-6050 --I2C--> STM32 (sketch.ino)          <- swing detection + haptics
                       |  Bridge RPC (built in)
                    Linux side (main.py)         <- WebSocket server, port 8765
                       |  WiFi (same network)
                  Snap Spectacles (Lens)         <- creatures, capture logic,
                  LumiCatchManager.ts               audio, score
```

The MCU does the time-critical work (200 Hz sampling, vibration timing). The Linux side only relays messages. Spectacles owns all game logic. Nothing touches the cloud.

Message protocol (JSON over WebSocket):

```
Net -> Spectacles : {"type": "swing", "peak": 2.7}
Spectacles -> Net : {"type": "haptic", "pattern": 3}
    1 = short pulse (creature nearby)
    2 = double pulse (rare creature)
    3 = long buzz (capture)
    4 = rapid triple (combo)
```

## Phase 1 - Prove the IMU works (30 min)

Wire only the MPU-6050 first. Follow `wiring-diagram.svg`:

| MPU-6050 | UNO Q |
|---|---|
| VCC | 3V3 (never 5 V) |
| GND | GND |
| SDA | the header pin marked **SDA** (same line as A4) |
| SCL | the header pin marked **SCL** (same line as A5) |

Go by the silkscreen labels, not by a pin number. `Wire.begin()` takes no
arguments and the core already knows the board's default I2C pins, so there is
nothing to look up and nothing to mistype. Arduino's UNO Q page keeps the
pinout in a separate PDF rather than inline, so the silkscreen is the
authority.

1. Open Arduino App Lab, create a new App called `lumicatch`.
2. Paste `diagnostics/phase1-imu-test.ino` into `sketch/sketch.ino` and run it. That file is the smoke test: it checks the bus answers at 0x68, reads `WHO_AM_I` to prove it is the right chip, then prints magnitude in g and tracks the peak.

Reading the peak matters more than it looks. Magnitude in g is the exact signal
the swing detector thresholds on **and** the trajectory model differentiates, so
swinging the bare breadboard now tells you what `SWING_THRESHOLD_G` should be
before anything is assembled. Note the peak your natural swing produces, and the
highest value you see while just walking around holding it. The threshold wants
to sit between those two.

The older, shorter smoke test below still works if you want the absolute
minimum:

```cpp
#include <Wire.h>
void setup() {
  Serial.begin(115200);
  Wire.begin();
  delay(200);
  Wire.beginTransmission(0x68);
  Wire.write(0x6B); Wire.write(0x00);   // wake the MPU-6050
  Wire.endTransmission();
}
void loop() {
  Wire.beginTransmission(0x68);
  Wire.write(0x3B);
  Wire.endTransmission(false);
  Wire.requestFrom(0x68, 6);
  int16_t x = (Wire.read() << 8) | Wire.read();
  int16_t y = (Wire.read() << 8) | Wire.read();
  int16_t z = (Wire.read() << 8) | Wire.read();
  Serial.print(x); Serial.print("\t");
  Serial.print(y); Serial.print("\t");
  Serial.println(z);
  delay(100);
}
```

3. Open **`Console > Serial Monitor`**. Not the deploy log, and not the Python console. App Lab has three separate output panels and only the Serial Monitor shows sketch output:

| Console | Shows |
|---|---|
| **Serial Monitor** | `Monitor.println` from the sketch, over the Router Bridge |
| **Python** | `print()` from `main.py` on the Linux side |
| Deploy log | compile, flash and container startup. Ends in `Container ... Started` |

Wait about five seconds after starting. Three of those are the deliberate delay after `Monitor.begin()`.

Expected: `PASS: a device answered at 0x68`, `WHO_AM_I = 0x68`, then a stream of readings with magnitude near 1.00 g at rest. If you see zeros or the sketch hangs, check SDA/SCL are not swapped and that AD0 on the breakout is unconnected or tied to GND (address 0x68).

### Measured calibration (Phase 1 results)

Real numbers off this net's own IMU. Every threshold in the project is now set
from these rather than from theory:

| State | Magnitude | Slope |
|---|---|---|
| At rest | ~0.87 g | 0 |
| Walking about holding it | 0.65 to 1.08 g | ~2.7 g/s |
| A real swing | peaks at **5.50 g** | ~30 g/s |

A five times separation between walking and swinging, which is a comfortable
margin. What it set:

| Value | Where | Was | Now | Why |
|---|---|---|---|---|
| `SWING_THRESHOLD_G` | `sketch.ino` | 2.2 | 2.2, kept | Twice the worst walking reading, under half a swing. The default happened to be right, and is now confirmed rather than assumed |
| `arm_threshold_g` | `neon_ai.py` | 1.35 | **1.6** | 1.35 sat barely above the 1.08 g walking peak. Too close |
| `rearm_threshold_g` | `neon_ai.py` | 1.15 | **1.2** | Follows the arm threshold |
| `min_slope` | `neon_ai.py` | 2.0 | **8.0** | Walking produces about 2.7 g/s, so the old value could be tripped by carrying the net. A swing gives ~30 g/s, so 8 sits cleanly between |

The module reads about 8 per cent low, so 1 g of gravity shows as 0.87 g. That
is normal gain error on cheap MPU-6050 boards and needs no correction, because
every threshold is set from measured values rather than theoretical ones.

Against the real 5.5 g swing profile the predictor fires **35 ms before the
peak** with 0.59 confidence, which covers most of the WiFi round trip. The
test suite now includes that exact profile, plus the measured walking trace and
a worst case jostling carry, all of which must produce no prediction.

**Re-measure after Phase 6.** Mounting the sensor near the hoop lengthens the
lever arm, so the same swing will read higher than it does on a bare
breadboard. Expect to raise `SWING_THRESHOLD_G`.

### Connection reliability is the real hardware risk

The first swing test killed the sensor: a jumper moved, the MPU lost power for
an instant, reset into sleep mode, and returned zeros from then on while still
acknowledging on I2C. Silent, mid-motion, and it looks exactly like a dead
sensor.

Two defences, and you need both.

**Firmware.** `sketch.ino` and `diagnostics/phase1-imu-test.ino` now watch for a magnitude
of essentially zero. Gravity never goes away, so twenty dead samples in a row
(100 ms) means the sensor slept rather than the net going weightless. It
re-wakes automatically and prints a recovery count. Note this is a safety net,
not a fix: if the message appears, the wiring still needs attention.

**Wiring.** This whole project is a breadboard being swung through the air, so
treat connections as the primary failure mode:

- Push every jumper fully home. Half-seated pins are what move first.
- Prefer the shortest jumpers you have. Long loops whip about and lever pins out.
- Once Phase 1 passes, tape the jumper bundle to the breadboard so the strain lands on tape rather than pins.
- At assembly, hot glue or tape over the MPU's four connections. This is the single highest-value thirty seconds in the build.
- If you own a soldering iron, soldering the MPU's four wires directly removes this entire class of failure. Worth it before filming.

## Phase 2 - Prove the motor works (30 min)

Build the transistor circuit on the mini breadboard exactly as in `wiring-diagram.svg`: D9 through the 1 kΩ resistor to the base, emitter to GND, motor between 3V3 and the collector, 1N4007 across the motor with its band towards the 3V3 side.

Use `diagnostics/phase2-motor-test.ino`. It runs three tests and then
stops with the motor off:

- **A. Three pulses.** Proves the circuit switches at all.
- **B. A PWM ramp** from 40 to 255. Coin motors need a minimum duty before they turn, usually well above zero. Note the first value you can feel: that is the motor's starting floor, and it tells you how much room the patterns actually have.
- **C. The four game patterns**, announced before each, copied verbatim from `sketch.ino`. Hold it the way you will hold the net handle and decide whether you can tell all four apart. Four patterns that blur into each other through a handle are three wasted patterns, and this is the cheapest moment to find out.

If the transistor warms up at all, cut power immediately: that is base and
collector swapped.

The older minimal test still works if you want the absolute simplest check:

```cpp
const int MOTOR = D9;
void setup() { pinMode(MOTOR, OUTPUT); }
void loop() {
  analogWrite(MOTOR, 255); delay(300);
  analogWrite(MOTOR, 0);   delay(700);
}
```

### Measured motor behaviour (Phase 2 results)

| Property | Measured | What it means |
|---|---|---|
| PWM floor | **55** | Below this the rotor does not turn at all. Usable range is 55 to 255, so intensity is a real design dimension |
| Coast-down | **80 to 100 ms** | Any gap shorter than this and the motor never stops, so separate taps smear into one buzz |
| D9 is PWM | **confirmed** | The ramp produced a genuine floor rather than on/off, so no need to move to `~10` |
| Transistor temperature | cool | Pinout correct |

### Why the first four patterns failed

The original set was designed as if the motor were instantaneous. It is not,
and two pairs came back indistinguishable:

| Pattern | Gap used | Coast-down | Result |
|---|---|---|---|
| Two taps | 80 ms | ~80 to 100 ms | One buzz with a wobble |
| Three fast taps | 50 ms | ~80 to 100 ms | One buzz with a wobble |

An 80 ms 'short tap' plus its coast-down also lands near 180 ms of felt
vibration, which is not far enough from a 350 ms 'long buzz' to tell apart.

### The redesigned set

Gaps are now **150 ms**, comfortably past coast-down, and the four differ by
**shape** rather than by counting taps. Counting is the hardest thing to do
through a wrapped handle mid-swing.

| Pattern | Shape | Steps |
|---|---|---|
| Nearby | soft short blip, deliberately gentle since it fires most often | 70 ms at PWM 110 |
| Rare | two clean separated taps | 70 on, 150 off, 70 on, all at 255 |
| Capture | one long sustained buzz | 420 ms at 255 |
| Combo | that same buzz, then two taps: capture, and then some | 320 on, 150 off, 70 on, 150 off, 70 on |

Nearby is separated by **intensity** as well as length, using the floor of 55
as the reference: 110 is soft but unmistakably present. Combo is deliberately
built on top of Capture, because in play a combo *is* a capture plus more, so
the haptic should say the same thing.

Both `sketch.ino` and `diagnostics/phase2-motor-test.ino` carry the identical set, driven
by one `HAPTIC_GAP_MS` constant. **If taps still blur, raise it to 200.**

The test now ends with a **section D** that plays the two previously confused
pairs back to back. Judging patterns minutes apart is unreliable; in play they
arrive seconds apart, so that is the comparison that decides it.

The motor should pulse once a second. If it is weak, check the transistor pinout (2N2222 flat face towards you: E-B-C left to right; S8050 is also E-B-C but verify against its datasheet). If nothing happens, confirm the motor spins when touched directly across 3V3 and GND for a moment.

## Phase 3 - Load the real firmware (20 min)

Replace the sketch with the provided `sketch.ino`. On boot the motor gives one confirmation buzz. Swing the breadboard sharply: the console prints `Swing peak: x.xx`. Tune two constants at the top if needed:

- `SWING_THRESHOLD_G` (default 2.2): raise it if walking triggers swings, lower it if honest swings are missed.
- `DEBOUNCE_MS` (default 400): stops one swing registering twice.

## Phase 4 - Bring up the Linux side (30 to 45 min)

### 4.1 The websockets dependency

App Lab manages Python packages with a **`requirements.txt`** handled by `uv`,
not with `apt`. Your Python runs in a container, so a host level `apt install`
may never reach it.

Create `requirements.txt` in the App's `python/` folder containing one line:

```
websockets
```

Then restart the App. From the console if there is no file button:

```
cd ~/ArduinoApps/lumicatch/python
echo "websockets" > requirements.txt
```

**If that fails, do not fight it.** Use `main-nodeps.py` instead, which needs
no packages at all: it implements the WebSocket server on raw sockets from the
standard library. Same protocol, same sessions, same dashboard, same AI.

| File | Needs `websockets` | Files required |
|---|---|---|
| `main.py` | yes | plus `neon_ai.py`, `dashboard.py` |
| `main-standalone.py` | yes | one file, everything inlined |
| **`main-nodeps.py`** | **no** | plus `neon_ai.py`, `dashboard.py` |

Verified end to end on a laptop with the board stubbed out: handshake, per
session difficulty pushed on connect, four results moving difficulty from 0.35
to 0.45, haptic message accepted, dashboard reporting the session correctly.

The frame layer in it is the same code already proven in `mock-net.py`, so it
is not new or untested, just relocated.

### 4.2 Get the Python side onto the board

Three files make up the Linux side:

| File | Job |
|---|---|
| `main.py` | polls the MCU, serves the WebSocket, tracks sessions |
| `neon_ai.py` | the two AI models |
| `dashboard.py` | the App Lab game dashboard on port 8080 |

**Try all three first.** If App Lab will not take more than one Python file, or
the console shows `ModuleNotFoundError: No module named 'neon_ai'` or
`'dashboard'`, paste **`main-standalone.py`** instead. It is all three inlined
into one file, generated by `build-standalone.py`, behaviour identical.

If you edit `main.py`, `neon_ai.py` or `dashboard.py`, regenerate it:

```
python3 build-standalone.py
```

### 4.3 Run it, and watch the right console

App Lab has three output panels and they show different things:

| Console | Shows |
|---|---|
| **Python** | `main.py` output. **This is the one for Phase 4** |
| Serial Monitor | the sketch's `Monitor.print` output |
| deploy log | compile, flash, container startup. Ends `Container ... Started` |

Expected in the **Python** console within a few seconds of starting:

```
Dashboard on http://<board-ip>:8080
WebSocket server listening on port 8765
```

Both lines must appear. If only the dashboard line shows, the `websockets`
package is missing: go back to 4.1.

### 4.3b Expose the ports, or nothing outside can reach them

**This will stop you dead and the symptom is confusing.** App Lab runs your
Python in a Docker container. The server correctly reports
`WebSocket server listening on port 8765`, and yet nothing on the network can
connect, because the container never publishes the port to the board's WiFi
interface.

The fix is one line in **`app.yaml`**, which sits at the app root, **not** the
`sketch.yaml` inside `sketch/`:

```
~/ArduinoApps/lumicatch/
├── app.yaml        <- ports go here
├── sketch/
│   └── sketch.yaml <- compile config, leave alone
└── python/
```

It ships with the ports list empty:

```yaml
ports: []
```

Change it to:

```yaml
ports: [8765, 8080]
```

or from the console:

```
sed -i 's/^ports: \[\]/ports: [8765, 8080]/' ~/ArduinoApps/lumicatch/app.yaml
```

Restart the App afterwards.

How to recognise this from the outside: the board answers ping, SSH on port 22
is open because that runs on the host, and 8765 and 8080 are both closed. That
combination means the container is not publishing, not that the network is
broken.

App Lab's UI does not always let you view or edit `app.yaml`, so use the
console.

### 4.4 Find the board's address

```
hostname -I
```

Note it. It goes into two places: the dashboard URL, and later the Lens
`serverUrl` as `ws://<that-address>:8765`.

### 4.5 Open the dashboard

From a laptop or phone on the same network:

```
http://<board-ip>:8080
```

You should get a dark page headed **Neon-Net Control**, a live dot in the top
right, and four counters all at zero with `No players connected` in the table.

If the page loads but the dot says `offline`, the page is served but `/state`
is failing: check the Python console for a traceback.

### 4.6 Prove the return path, including the motor

This is the important test, and **it works with a dead IMU**, because nothing
here touches the sensor. From a browser console on the same network:

```js
const s = new WebSocket('ws://<UNO-Q-IP>:8765');
s.onmessage = (e) => console.log(e.data);
s.onopen = () => s.send(JSON.stringify({type: 'haptic', pattern: 3}));
```

What should happen, in order:

1. **The net gives the long capture buzz.** That is the whole return path proven: browser to WebSocket to Bridge to MCU to transistor to motor.
2. The browser logs a `difficulty` message, pushed on connect.
3. The dashboard shows **1 session**.

Then send a result and watch the board's AI respond:

```js
s.send(JSON.stringify({type: 'result', hit: true, mood: 'calm'}));
```

The Python console prints `Player 1 HIT | ratio 1.00 | difficulty 0.35`, the
browser receives a fresh `difficulty` message, and the dashboard row updates.
Send a few and the difficulty figure moves.

**If all of that works, the hardware and network halves of the project are
finished.** Only swing detection remains.

### 4.7 What you will see with a dead or missing IMU

Expected and harmless:

- `Bridge call get_samples failed` in the Python console, at most every hundredth attempt
- No `Predicted swing peak` lines
- No `Swing detected` lines
- Everything else above works normally

`bridge_call()` swallows Bridge failures deliberately, so a dead sensor cannot
take the Linux side down. The game remains fully playable through
`pinchAsSwing` on the Lens.

### 4.8 When the IMU is back

Nothing to change on the Linux side. Restart the App and you should start
seeing, in the Python console:

```
Predicted swing peak in 84 ms (confidence 0.59)
Swing detected, peak 5.50 g
```

The first line is the trajectory model. If swings appear but predictions never
do, `get_samples` is the suspect, and it is the one part of the firmware never
proven on hardware. The game works without it: comment out the
`Bridge.provide("get_samples", ...)` line and carry on.

Once stable, use the arrow next to Run and switch on **Run at startup**, so the
net works untethered from a power bank while you film.

### Phase 4 troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: neon_ai` or `dashboard` | App Lab took only one file | Use `main-standalone.py` |
| `No module named 'websockets'` | Dependency missing | `sudo apt install python3-websockets` |
| Nothing in the console at all | Watching the wrong panel | Python console, not Serial Monitor or the deploy log |
| Dashboard page will not load | Wrong address, or different network | Re-check `hostname -I`. Laptop and board must be on the same network |
| Dashboard loads, dot says offline | `/state` throwing | Look for a traceback in the Python console |
| Browser connects, no buzz | Bridge or motor circuit | Does the boot self test give one long buzz? If it gives short bursts, fix the IMU first |
| `Address already in use` on 8765 or 8080 | An older run still holds the port | Stop the App fully, or reboot the board |
| Console says listening, but nothing can connect | **`ports: []` in `app.yaml`** | The container is not publishing. Set `ports: [8765, 8080]` and restart. Board pings, SSH answers, app ports closed is the signature |
| Dashboard prints a 172.x address that does not work | That is the container's own bridge IP | Get the real address with `hostname -I` on the board, or from the hotspot's device list |
| Nothing on the network can see anything | Access point isolates clients | Common on college, office and public WiFi. Every ARP entry reads `(incomplete)`. Use a phone hotspot for board, laptop and Spectacles |

## Phase 4 (original notes)

1. Open the App Lab console (bottom-left terminal button) and install the one dependency:

```
sudo apt install python3-websockets
```

2. Paste the provided `main.py` into the Python part of the same App and run the App. The console should show `WebSocket server listening on port 8765`.
3. Find the board's IP address:

```
hostname -I
```

4. Test from your laptop (same WiFi) before involving Spectacles at all. In a browser console:

```js
const s = new WebSocket('ws://<UNO-Q-IP>:8765');
s.onmessage = (e) => console.log(e.data);
s.onopen = () => s.send(JSON.stringify({type: 'haptic', pattern: 3}));
```

When it opens, the net should buzz (pattern 3). Swing the net and the browser should log a swing message. If this round-trip works, the hardware half of the project is finished.

Once stable, use the arrow next to Run and switch on 'Run at startup' so the net works untethered from a power bank while you film.

### Testing the network path before the hardware exists

`mock-net.py` at the repo root is a laptop stand-in for the UNO Q. It speaks the
identical protocol, so proving the Lens against it means that when the real net
arrives, any failure is the hardware and not the Lens. Zero dependencies, pure
standard library, so there is nothing to install.

```
python3 mock-net.py
```

It prints the exact `ws://<your-laptop-ip>:8765` to paste into `serverUrl`.
Untick `simulate` in the Lens and run it. Then:

- Press Enter in the terminal to send a swing. The Lens should print `swing received` and capture a creature.
- Type a number such as `2.9` to send a swing with that peak value.
- When the Lens captures something, the terminal prints `<- haptic 3 (capture)`.
- `q` quits.

Seeing a swing go out and a haptic come back proves the whole message loop.
Verified working by an automated round-trip test: handshake, masked inbound
frame, unmasked outbound frame, correct JSON in both directions.

Note your laptop and the Spectacles must be on the same network. A phone
hotspot is the reliable choice, since it does not do client isolation.

## Phase 4b - Test the Lens network path without hardware (15 min)

`mock-net.py` is a laptop stand-in for the UNO Q. It speaks exactly the protocol
in `main.py`, so it proves the Lens side of the WebSocket works before the
hardware exists. When the real net arrives you change only the IP.

It uses raw sockets and the standard library only. Nothing to install.

```
python3 mock-net.py
```

It prints the URL to use, for example `ws://172.20.10.2:8765`. Then in the Lens:

1. Untick `simulate`
2. Set `serverUrl` to the URL it printed
3. Make sure Experimental APIs is on in Project Settings, or `ws://` is blocked
4. Run the Lens

Expected: the terminal shows `Lens connected from ...`. Press Enter to send a
swing and a jellyfish should be captured. The terminal then logs
`<- haptic 3 (capture)` coming back from the Lens.

Controls: Enter sends a swing at the default peak, typing a number such as `2.9`
sends a swing with that peak, `q` quits.

That round trip is the whole protocol. If it works here, any later failure with
the real net is a hardware or network problem, not a Lens problem. That is worth
knowing in advance, because it removes half the search space when something
breaks the day before filming.

Verified by an automated round-trip test: handshake, masked inbound frame,
unmasked outbound frame, correct JSON in both directions.

## Phase 5 - Put the Lens on the glasses (1 to 2 hours)

The Lens is already built, wired and tested in preview. Phase 5 is now only
connecting it to the real net and getting it onto the glasses. Everything below
this heading in the older Phase 5 notes is history: read it only if something
is missing from the scene.

### 5.1 Point the Lens at the net

On the `LumiCatch` object in the Inspector:

| Input | Set to |
|---|---|
| `serverUrl` | `ws://<UNO-Q-IP>:8765` from `hostname -I` |
| `simulate` | **untick** |

Project Settings must have **Experimental APIs on**, which they already are.
Plain `ws://` will not connect without it, and it fails quietly, so if the
connection never opens check this before anything else.

Leave `internetModule` empty. The script pulls it from Lens Studio itself.

### 5.2 Test in preview first, still on the laptop

Press Preview with the net powered and on the same network. In the Logger:

```
LumiCatch: connecting to ws://...
LumiCatch: connected to net
LumiCatch: difficulty 0.35, speed x1.28
```

Then swing the physical net:

```
LumiCatch: swing predicted in 84 ms, confidence 0.59
LumiCatch: swing received, peak 5.50
```

**That is the whole system working.** Physical swing, IMU, MCU, Bridge, two AI
models, WebSocket, Lens, capture. If you see those lines, everything after this
is polish and filming.

### 5.3 Push to the glasses

Pair the Spectacles and send the Lens. **The glasses and the UNO Q must be on
the same network.** Use a phone hotspot: many routers isolate clients from each
other, which blocks the connection with no useful error. Your laptop already
reported a `172.20.10.x` address, which is a phone hotspot range, so you are
probably on one already. Keep it that way.

### 5.4 What to check on device, in this order

1. **Do jellyfish appear at all?** If the view is empty, read the startup log for `N of 14 creatures spawned in front`. Zero means flip `forwardSign`.
2. **Is the sense strand visible?** Eleven motes low in view. The log line `mote 0 world scale ... cm, ... cm away, IN FRONT` tells you exactly where they are.
3. **Does a swing capture?** The authoritative test.
4. **Does the net buzz on capture?** Long sustained buzz, pattern 3.
5. **Does the strand's wave fire on a swing?**

### 5.5 Expect to retune for the glasses

The Lens Studio preview camera is 63.5 degrees wide. The Spectacles display is
about 27 degrees. Everything looks twice as spread out in preview as it will on
your face. The values in this guide are already calibrated for the glasses, not
the preview, but tune while wearing them, never in preview.

Most likely adjustments on device:

- Creatures feel too far apart: lower `spawnMaxCm`, or raise `creatureCount`.
- Nothing catchable: lower `captureConeDot` towards 0.6.
- Strand too low or too small: `hudYCm`, `hudMoteLitCm`.
- Score unreadable: `scoreScale`.

Remember: **changing a default in the source does nothing once the input
exists.** Change it in the Inspector.

## Phase 5 (original build notes)

The Lens is the critical path. It needs no hardware, so build it first and in
simulate mode. The project lives at `Lumicatch/Lumicatch/` and is a Spectacles
project on Lens Studio 5.15.4.

The canonical copy of the script is `Lumicatch/Assets/LumiCatchManager.ts`,
because that is the one Lens Studio compiles. The copy at the repo root is a
convenience mirror. Edit the one in `Assets/`.

### Already built in the project

Steps 3 to 8 below have been done, via the Lens Studio MCP tools. The scene now contains:

- `Jellyfish` prefab, sphere with the unlit `JellyfishGlow` material in cyan
- `JellyfishRare` prefab, sphere with the unlit `JellyfishGold` material
- `LumiCatch` scene object carrying the `LumiCatchManager` script component
- `ScoreText`, a world-space Text parented to the Camera Object at 100 cm forward and 25 cm down, so it is head locked and always in shot
- `creaturePrefab`, `rarePrefab`, `camera` and `scoreText` inputs wired, tuning calibrated for the Spectacles 2024 display

Verified by running the preview and reading the logs:

```
LumiCatch: 5 of 5 creatures spawned in front. If this is 0, flip forwardSign.
LumiCatch: SIMULATE mode. Click in preview or pinch on device.
LumiCatch: [sim] haptic pattern 1
```

That first line settles `forwardSign`: at -1 every creature spawns in front of
the camera, so the default is correct and does not need flipping.

Still to add by hand, neither of which blocks simulate mode:

- Capture chime, ambient loop, burst prefab. All optional, all guarded with `@allowUndefined`.

Nothing else. The Internet Module is resolved in script, see below.

### Two fixes that only showed up by running it

Both were invisible in the code and obvious in the logs.

**A jellyfish now starts inside the capture zone.** Previously the first
creature spawned anywhere between 90 and 200 cm at a random angle, so roughly
two thirds of the time there was nothing catchable at t=0 and the Guarantee had
to swim one in. That is three wasted seconds at the start of every take. The
first Drifter is now placed at `heroDistanceCm` directly ahead.

**The proximity haptic is edge triggered.** It used to fire every
`nearbyCooldownS` for as long as any creature sat inside `nearbyRangeCm`, which
in practice meant the net buzzing every 2.5 seconds forever. It now fires once
when a creature arrives, with a 1.25x hysteresis band so one hovering on the
boundary cannot chatter the motor. Confirmed in the logs: one buzz at 0.9 s,
then silence for the next 25 seconds.

1. Open `Lumicatch/Lumicatch.esproj`. In Project Settings enable Experimental APIs (needed for plain `ws://` during development; published lenses require `wss://`, which does not matter for your video).
2. Add an Internet Module from the Asset Browser (+ > Internet Module).
3. Build the creature prefab:
   - Scene Hierarchy + > Sphere (or import a low-poly jelly mesh). Rename it `Jellyfish`.
   - Give it an Unlit material, emissive, cyan or violet. Add a soft glow sprite child if you want the bloom.
   - Scale it to roughly 15 cm so it reads at arm's length.
   - Drag the object from Scene Hierarchy into the Asset Browser to make it a Prefab, or right-click it and choose Save as Prefab.
   - **Then delete the object from the Scene Hierarchy.** Making a prefab converts the original into an instance of itself, and it stays in the scene. If you leave it, a jellyfish sits frozen at the origin that the script does not control, and it will be in your footage.
4. Optional but worth it: duplicate the prefab, tint it gold, scale it up a little, and save it as `JellyfishRare`. This is the Lumen creature. If you skip it, rare creatures just use the common prefab.
5. Add a Text component for the score, and an AudioComponent with a chime for captures.
6. Create an empty Scene Object called `LumiCatch`. Add `LumiCatchManager.ts` to it as a Script component.
7. Assign the inputs: Internet Module, `creaturePrefab`, main Camera, score Text, capture sound. Leave `simulate` ticked and `serverUrl` alone for now.
8. Press Preview and click in the preview window. Expected: jellyfish drifting in front of you, a click captures the nearest one, score increments, log shows `[sim] haptic pattern 3`.
9. Only once that works, untick `simulate`, set `serverUrl` to `ws://<UNO-Q-IP>:8765`, and test against the real net. The log should show `connected to net`, then `swing received` when you swing.
10. Pair Spectacles and push the Lens. Spectacles must be on the same WiFi network as the UNO Q. Phone hotspots are the usual saviour here if your router isolates clients (see troubleshooting).

Capture logic note: the Lens captures the nearest creature within 1.5 m and roughly in front of you at the moment of the swing. For a rehearsed video this reads as perfect physical accuracy. Hand tracking (offsetting a collider from the tracked hand to the net head) is the post-hackathon upgrade, not worth the risk before the deadline.

### Creature AI

Three personalities, all driven from the one script. No per-creature scripts and
no extra prefab wiring, because every Inspector slot is another thing to get
wrong on shoot day.

| Kind | Frequency | Behaviour | Points |
|---|---|---|---|
| Drifter | most common | bobs on the spot, never flees | 1 |
| Skittish | `skittishChance`, default 0.35 | notices the net inside `alertRangeCm`, pauses for a beat, then dodges sideways and swims back | 1 |
| Lumen | `rareChance`, default 0.22 | bigger, slower pulse, dodges further, fires haptic pattern 2 when nearby | 3 |

Fleeing is deliberately sideways across your view rather than straight away from
you. A creature that flees directly away shrinks to a dot and leaves frame,
which ruins a take.

Three safeguards exist only to protect the filming, all switchable in the Inspector:

- **Leash** (`leashMaxCm`, default 260): nothing may drift behind you or past that radius. Anything that does is re-homed into the forward cone.
- **Mercy** (`useMercy`): after `mercyMisses` failed swings in a row, fleeing switches off for `mercySeconds`. Guarantees a bad run recovers on camera.
- **Guarantee** (`guaranteeEasyTarget`): if no easy target has been in front of you for `guaranteeDelayS`, a Drifter swims into range at `heroDistanceCm`. This is your one-take insurance and the single most valuable setting in the file.

Turn all three off only if you are debugging the AI itself. Turn them back on before filming.

### Audio

The pitch promised 3D spatial audio and the game was silent, so it was added.
Two sounds, both synthesised from scratch by `make-audio.py` using nothing but
the Python standard library, so they are ours to publish with no licensing
question:

| File | What it is |
|---|---|
| `CaptureChime.wav` | 0.9 s two note bell with slightly inharmonic partials, so it does not sound like a test tone |
| `AmbientDeep.wav` | 8 s underwater bed, looped forever |

The ambient bed loops **seamlessly**: every partial completes a whole number of
cycles inside the eight second window, so the join is silent. Measured step
across the loop point is 124 out of 32767, which is inaudible. That only works
because the frequencies were chosen as multiples of 0.125 Hz; pick them freely
and you get a click every eight seconds that nobody can find.

**The capture chime is genuinely spatialised.** The emitter is moved to the
captured creature's world position before it plays, so a jellyfish caught on
your left is heard on your left. The ambient bed is deliberately *not*
spatialised: it is the sea around you rather than an object in it, so it must
not swing about as you turn your head.

Three things this needs, all of which cost a round of debugging:

1. **An Audio Listener component on the Camera Object.** Without it, spatial audio silently does nothing and the console repeats `Audio Listener component has to be added to your scene`.
2. **The track assigned from script.** `audioTrack` is not exposed to the editor API, exactly like the material colours, so `setupAudio()` wires it at start from an asset input.
3. **Volumes set in code**, for the same reason.

Regenerate the sounds any time with:

```
python3 make-audio.py
```

### The sense strand: showing the AI on camera

Both models ran invisibly for most of the build. They worked, but a judge
watching the video would have seen jellyfish moving and had to take the AI on
trust. The strand fixes that without turning the game into a dashboard.

It is framed as **the net's own bioluminescence**, not an overlay. It borrows
the creature palette so it belongs to the same world:

| Shoal mood | Strand colour |
|---|---|
| Calm | cyan, as the Drifters |
| Curious | violet, as the Skittish |
| Spooked | gold, as the Lumen |

It is a drift of small bioluminescent **motes**, not a bar. The first version
was a scaled box and looked like a progress meter bolted onto an underwater
scene, which is exactly the wrong register.

- **Eleven motes** hang in a shallow droop low in the view, bobbing gently out of phase.
- **How far the glow reaches along them** is how alert the shoal has become. The edge is soft, so the glow tapers rather than stepping.
- **A bright wave** runs their length the instant a swing is sensed, flaring each mote towards white as it passes. This is the one moment the AI is directly visible, and it is the shot worth cutting to in the video.

The motes are instantiated from the **creature prefab itself**, so the strand
is literally made of the same light as the jellyfish. That also means no scene
objects to create and no Inspector wiring to get wrong.

**`MoodWhisper`** is a line of text under the strand that fades in when
something changes and fades straight back out, so the view stays clear:
`the shoal scatters`, `they drift closer`, `sensed +84ms`.

Everything is positioned, scaled and coloured by the script every frame. That
is deliberate: editor-side transforms on camera children do not survive a
reload, exactly like the material colours.

Fading uses **real alpha**, with `blendMode` set to `Normal` and `depthWrite`
off so overlapping motes blend instead of punching holes in each other. An
earlier version faded towards black on the theory that additive displays make
dark equal invisible; on screen it just looked muddy.

**The strand works without hardware.** With `simulate` on there is no board
sending difficulty or predictions, so the strand used to sit dark at zero.
It now reads a local rolling catch history as a stand-in, and every simulated
swing sends a wave. Play in preview and it responds.

Tuning lives on the manager: `hudDistanceCm` (100, the focus plane),
`hudWidthCm` (30), `hudYCm` (-20), `hudMoteCount` (11), `hudMoteBaseCm`,
`hudMoteLitCm`, `hudArcCm`, `pulseTravelS`, `moodHoldS`, `scoreScale` (1.5)
and `moodScale`.

**If the strand does not appear**, the likely cause is the same forward-axis
question as `forwardSign`: the pieces sit at local `-z` from the camera, so
flipping the sign of `hudDistanceCm` puts them in front instead of behind.

Verified end to end against `mock-net.py` running the real models: the Lens
connected, received `difficulty 0.35`, and logged `swing predicted in 83.7 ms`
followed by the confirmed swing.

### What the first real playtest changed

Playing the whole thing on the glasses with the net produced six complaints.
They are worth recording because five of them were right, and the fixes are
what turned a tech demo into a game.

**1. The strand was unreadable.** *"the ui at the bottom that changes colour
blue orange etc whats that for?"* One element was carrying four different
meanings at once. It was split into four labelled readouts, each with one job:

| Object | Input | Shows |
|---|---|---|
| `MoodFace` | `moodFaceText` | The shoal's state as a face plus a word: `^_^` calm, `o_o` curious, `>_<` spooked |
| `PredictFlash` | `predictFlashText` | Fires when the trajectory model calls a swing, e.g. `SENSED  84ms` |
| `CatchPopup` | `catchPopupText` | `RARE  COMBO  +6` on a catch, gold for rare and combo |
| `DifficultyLabel` | `difficultyLabelText` | `SHOAL ALERTNESS  62%`, the difficulty AI made visible |

The faces are set by `moodFaceCalm`, `moodFaceCurious` and `moodFaceSpooked` so
they can be changed without touching code. All four are children of the Camera
Object, positioned at runtime from `hudDistanceCm`, and all four are hidden
unless `showGame` is true, so they never sit on top of the start screen.

This also answers the *"make the AI visible rather than claimed"* point in the
rubric: the prediction flash and the alertness percentage are the two models
putting themselves on camera, without narration.

**2. Fled jellyfish could still be caught.** *"even if jellyfish have run away
and I swing in that position it says caught."* `onSwing` tested proximity
against every creature including ones already fleeing, so a swing at empty air
where one used to be still scored. Fixed by skipping any creature that has
already noticed you:

```ts
const st = this.creatures[i].state;
if (st === ST_ALERT || st === ST_FLEE) continue;
```

Being seen is now a real escape, which is also what makes the alertness number
mean anything.

**3. There was no round.** A timer was added: `roundSeconds` (60), a countdown
on the score line that turns gold and pulses for the last ten seconds, and a
result screen that reuses the start screen showing `SCORE  N`, `PLAY AGAIN` and
the best score so far. Without it there was no reason to stop and nothing to
beat, and a filmed take had no shape.

**4. Score wording disagreed with the dashboard.** The Lens said `Caught:` and
the dashboard said something else. The Lens now says `Score  N` and sends its
score to the board with every result, so the two screens can be filmed side by
side without contradicting each other.

**5. Creatures swam into walls and furniture.** Covered under Room bounds
below. The short version: use Lens Studio's own `WorldQueryModule`, which is
the world mesh API, rather than inventing a geometry system.

**6. The dashboard was incomprehensible.** Covered under App Lab hosting the
dashboard, above.

### Making it a game

Everything above made it work. None of it made it fun. A second playtest pass
asked the blunt question, and the honest answer was that the loop had no
decision in it and no payoff at the end of one. Two things were being wasted
rather than missing.

**The swing had no skill in it.** `onSwing(peak)` had always received the
swing's peak in g from the firmware, and used it in exactly one place: a
`print`. A 3.6 g flick and a 7 g lunge did the same thing, which made the net,
the one genuinely novel input in the project, an expensive button.

**The catch had the least feedback of any moment in the game.** `capture()`
called `obj.destroy()` and the creature blinked out. `burstPrefab` had been
sitting unassigned since it was added, so there was no burst either. The single
most important event was a disappearance.

#### Sneak or lunge

How hard you swing now decides both reach and cost:

| | reach | who notices |
|---|---|---|
| sneak, under `gentleSwingG` (4.6 g) | 85 cm | only within 40 cm |
| lunge, over it | 170 cm | everything within 120 cm |

A woken creature is skipped by `onSwing`, so this is a real price: lunge into a
cluster and miss, and you have made the whole cluster untouchable for a couple
of seconds. `disturb()` respects `canFlee`, so the mercy window still protects a
player who is struggling, and `useSwingQuality` turns the whole thing off and
restores the old flat reach if a take is going badly.

The easy-target guarantee was repointed at the **sneak** reach. It exists as
filming insurance, so it has to promise a creature you can take with the gentle
swing rather than one that needs a committed lunge.

**These thresholds must be re-measured on the assembled net.** Walking already
reads 2 to 3 g, and the gentle band sits above that rather than below it, so
'gentle' and 'hard' have to stay reliably distinguishable while you are moving
and with the power bank fitted.

#### The catch, made to land

The creature is now taken off the roster but not destroyed. `updateCaught()`
flies it into the net on an accelerating curve while shrinking it to nothing,
and `spawnBurst()` throws off six motes that scatter and fade. The motes are
instances of the **old sphere creature prefab**, so this cost no new assets at
all.

#### Chains, and the bloom

The combo existed as an invisible flat x2. It now escalates to `comboMax` (4)
and shows on the score line between the score and the clock, with its dots
draining as the window closes, and nothing shown at all when no chain is live.

The bloom is the finale: for the last `bloomSeconds` (15) of the round, six
extra creatures arrive and everything is worth double. It announces itself with
its own popup and the rare-creature haptic, and the score line turns gold for
the whole of it rather than only the last ten seconds. This one is mostly for
the film, which needs a climax rather than a stop.

Verified by forcing two catches a second apart in preview:

```
after 1st  score=1 combo=1 label="SNEAK  CAUGHT | +1" inflight=1 motes=6
after 2nd  score=3 combo=2 label="LUNGE  SKITTISH | x2   +2" inflight=1
```

and by shortening the round to 12 s with a 6 s bloom:

```
LumiCatch: game started, 14 creatures live, readouts and score on
LumiCatch: bloom, +6 creatures, x2 points
LumiCatch: round over, score 0
```

#### A bug the bloom exposed

`beginGame()` was only ever reachable from the start button. So
`requireStart = false` silently disabled the round timer, the bloom and the
score reset: the creatures drifted and swings scored, but no round ever ran.

That is exactly the fallback you would reach for if the start button misbehaved
on the day, which makes it the worst possible place for a dormant bug.
`updateRound()` now begins the round itself when the gate is off.

### The sense strand, and why it was cut

The first version of the readouts was a 'sense strand': an arc of eleven
glowing motes low in the view, built at runtime from the creature prefab so it
was literally made of the same light as the jellyfish. Its colour was the
shoal's mood, how far the glow reached was the difficulty, and a bright wave ran
its length whenever the board predicted a swing.

It was the nicest looking thing in the project and it was cut, in two stages.

First it was split into four labelled readouts, because one element carrying
three meanings at once could not be read in play. Then the strand itself went,
because once mood, difficulty and prediction each had a label, the strand was
saying nothing that was not already said in words, and a 27 degree display has
no room for decoration. That removed about 150 lines, eleven runtime objects
and eleven cloned materials.

Worth recording as a design lesson: *the strand was not removed because it was
broken.* It worked exactly as designed. It was removed because 'what is that
for?' is a fatal question for a HUD element, and no amount of polish answers it.

There was a second, accidental reason it had to go. The motes were instantiated
from `creaturePrefab`, which was fine when that prefab was a sphere. The moment
the prefab became an imported jellyfish model, the strand would have become
eleven tiny animated jellyfish hanging in a row under the score.

The whispered mood line ('the shoal scatters') went at the same time. It had sat
just under the strand; with the strand gone it shared a row with the mood face,
which already showed the same state permanently rather than for two seconds.

### Room-wide spawning

`spawnAllAround` (default on) spreads creatures through the full 360 degrees
rather than a forward cone, so you turn your head and your body to find them.
Confirmed working: the startup log reports roughly half the creatures in front,
which is what a uniform ring should give.

`creatureCount` is 14. Fourteen unlit spheres is cheap even on Spectacles, but
if the frame rate drops on device this is the first number to lower.

With creatures behind you, the leash changes meaning. The distance limit
(`leashMaxCm`, 300) still applies so nothing escapes across the room, but the
'behind you' rule is skipped when `spawnAllAround` is on, since being behind you
is the entire point. Turn `spawnAllAround` off and the old forward-cone
behaviour returns, along with the behind-you leash.

The Guarantee still keeps one Drifter in front of you, and the first creature
still starts inside the capture zone. Those are filming insurance and they
survive the change to room-wide spawning.

### Swapping the spheres for a real jellyfish model

The creatures started as unlit spheres, which was the right call while the game
logic was being built and a deliberate one: a sphere has no orientation, no
animation and no import surprises. Once everything else worked, a real model
was dropped in: `simple_jellyfish.glb`, a Sketchfab export.

**Check the model before trusting it.** Reading the glTF directly, rather than
importing and hoping:

| | |
|---|---|
| Vertices | 557 |
| Triangles | 1110 |
| Skin joints | 14 |
| Animations | 1, `StandardMoving`, 4.12 s, LINEAR |
| Textures | none |
| Material | `KHR_materials_pbrSpecularGlossiness`, translucent, doubleSided |

1110 triangles means fourteen of them is nothing, so the creature count did not
have to change.

**Importing.** Copy the `.glb` into `Lumicatch/Assets/` and Lens Studio picks it
up on its own. It arrives as an `ObjectPrefab`, which is the same type the
`creaturePrefab` input already took, so instantiation needed no code change at
all. Inside it, Lens Studio builds:

- an **`AnimationPlayer`** on `Sketchfab_Scene`, with `autoplay` already true and the clip already looping, so the swim cycle needs no script to start it
- a **`Skin`** component driving the 14 bones
- a **`RenderMeshVisual`** several levels down, on `Object_21`

That last point matters. The existing `findVisual()` already searched
recursively, so tinting kept working; a version that only looked at the root
object would have silently failed to colour anything.

**Keeping the neon.** The imported model brings its own PBR material, which
lights realistically and turns the shoal into grey plastic. A new
`neonMaterial` input takes the existing unlit `JellyfishGlow.mat`, and `tint()`
clones and colours that instead of the model's own material, so the cyan,
violet and gold are exactly as before. The clone is also set `twoSided`,
because a sphere never showed you its inside and a bell does: swim under one
with backface culling on and the jellyfish disappears.

**Three things the model needed that a sphere never did.**

*It looked like it was lying on its side, and the fix was to stop 'fixing' it.*
**The correct value of `modelUprightDeg` is 0.** Lens Studio's importer already
resolves the glTF axis chain, and the prefab arrives upright.

That took three wrong values to establish, and the reason is worth more than the
answer. Two separate measurements both reported the creature was upright while
it was plainly horizontal on screen:

- **`worldAabbMin()` / `worldAabbMax()`.** On a **skinned** mesh these return the
  **rest pose** bounds transformed by the object matrix, not the vertices being
  drawn. For this model the rest pose is a flat wide slab, so the box reported a
  tall creature no matter which way the visible one was pointing. It is equally
  useless for measuring size.
- **A single pair of bones.** `Bone_00` to `Bone.001_end_010` looked like
  bell-to-tentacle from the node names. It is a short bone *inside the bell*. A
  real direction that means nothing.

What finally worked was measuring the **root joint against the average of every
leaf bone**, which is the direction the tentacles actually hang:

```
LumiCatch: body axis root->tentacles = (-0.05, -1.00, -0.03)  from 5 tips  ->  Y  UPRIGHT (tentacles down)
```

Roughly `(0, -1, 0)` is upright, `(0, +1, 0)` is upside down, and a dominant X or
Z is on its side. Those readings are unambiguous, and they are what the eye
agrees with.

**The lesson, stated plainly: on a skinned mesh, do not trust a bounding box for
orientation or for size, and do not trust bone names to tell you anatomy.**
Measure the posed skeleton, and believe the person looking at the screen. Three
rounds of this were spent arguing with a number that was measuring the wrong
geometry.

*It was three metres tall.* Creature size is not something you can read off the
source, because it is the prefab's own scale chain times `creatureScale`, and an
imported model brings its own units. `reportCreatureSize()` logs the real span
a second after startup, measured across the **posed bones** for the reason
above:

```
LumiCatch: creature spans 9.4 x 20.1 x 6.9 cm across 14 bones at creatureScale 0.060, animated
```

`creatureScale` ended at 0.055 for a 20 cm creature. The bone span runs slightly
small, since the mesh skins a little beyond the bones, so the drawn creature is
a couple of centimetres larger than the figure.

**That 20 cm figure is now in doubt, for a non-technical reason.** It was chosen
against a stated comparison of 'comfortably smaller than the net hoop', on the
assumption that the prop was a butterfly net with a hoop about 30 cm across. It
is an **aquarium fish net**, the sort used to scoop fish out of a tank, whose
hoop is nearer 10 to 15 cm. The creature is therefore currently wider than the
net that is supposed to be catching it.

Worth recording because the error was not in any measurement: every number was
right, and the reasoning on top of them rested on a wrong picture of the
physical object. Measure the hoop and re-decide.

Note the value in the **Inspector overrides the source default**, a trap this
project has hit repeatedly. It was sitting at 10 while the source said 1.0.
Both were set.

*All fourteen pulsed in lockstep.* The clip autoplays from t=0 on every
instance, so the whole shoal beat on the same frame, which reads as a
screensaver rather than a shoal. `desyncAnimation()` starts each one at a random
point with `playClipAt(clip.name, Math.random() * clip.end)`. It is a no-op on a
prefab with no animation, which is how the sphere behaved.

The old fake bell pulse, `pulseAmount`, was a sine wave scaling the whole sphere
up and down. With a real skeletal swim cycle it fights the animation and makes
the creature visibly inflate, so it is now 0.

*The animation was not playing, and three checks in a row said it was.* This
one is worth reading as a cautionary tale, because every intermediate
conclusion was confidently wrong.

Reported as 'why can't I see the animation of jellyfish 3d model', and then, a
fix later, 'i still cant see the animation'.

**Wrong answer 1: 'the bones are animating, it is just subtle.'** The check
sampled the world space bounding box of the bones twice and saw it change by
6.29 cm, so it declared the skeleton animating. It was measuring the creature's
**yaw spin**. A bounding box in world space changes when a rigid object
rotates. Measuring a moving object in world space and calling the difference
deformation is simply a bug in the measurement.

**Wrong answer 2: 'speed the clip up.'** Built on wrong answer 1. It made the
number bigger without making the creature move.

**The check that worked** is rotation invariant: the sum of all pairwise
distances between bones. That is the creature's *shape*, which rigid motion
cannot change and deformation must:

```
skeleton shape changed 0.02% over 1.6 s  ->  RIGID, the clip is not driving the bones
```

With spin disabled and the shape measured properly, the skeleton was perfectly
rigid. Not subtle. Not playing.

**The actual cause.** Logging the clip gave it away immediately:

```
anim clip "StandardMoving" clips=1 begin=0 end=0.1375 mode=1 playing=false
```

`end = 0.1375` seconds. The glTF animation is **4.125** seconds long, and
0.1375 is exactly 4.125 / 30: Lens Studio's importer has read the glTF's
keyframe times, which the format specifies in **seconds**, as **frames**, and
divided by 30 fps. The player was faithfully looping a 137 millisecond sliver
of a four second swim cycle, which holds the creature very nearly still.

The fix is to repair the clip's length in script before playing it:

```ts
if (this.swimClipSeconds > 0) {   // 4.125, the real length from the glTF
  clip.begin = 0;
  clip.end = this.swimClipSeconds;
}
clip.playbackMode = PlaybackMode.Loop;
player.setClipEnabled(clip.name, true);
player.playClipAt(clip.name, Math.random() * clip.end);
```

Measured afterwards: **8.80% shape change over 1.6 s**, with the creature's
height moving between 20.1 and 22.0 cm as the bell contracts. `pulseAmount`
went back to 0, because the fake scale pulse added while chasing 'too subtle'
is genuinely redundant now and reads as inflation on top of a real animation.

**If you import a glTF or FBX animation into Lens Studio and it looks static,
print `clip.end` first.** Compare it against the source file's real duration
before touching anything else. Two of the three wrong turns above would have
been skipped by that one line.

The general lesson, twice learned in this project: **verify the thing the user
can see.** 'The AnimationPlayer exists, autoplay is true, and the clip is
looping' was entirely true and entirely useless.

*They all hung at exactly the same angle.* Real jellyfish drift at all sorts
of attitudes, and as the user put it, 'in a shoal of jellyfish not all are
vertical, some are horizontal as well'. So the lean is two-tiered, both tiers
hashed from the creature's existing `seed` so an attitude is fixed for its
lifetime and unrelated to its neighbours':

- the upright majority get a gentle `tiltVarietyDeg` (16 degrees) either way
- `horizontalShare` (0.3) of the shoal instead loll over onto their sides, up to `maxTiltDeg` (85 degrees)

Set `horizontalShare` to 0 for an all-upright shoal, and `tiltVarietyDeg` to 0
as well for a rigid formation, which is what you want while checking
orientation and not what you want on camera.

Note that the orientation diagnostic reports **one** creature and includes that
creature's own lean, so a sideways reading there is only a fault if every
creature reads that way. The log line says so, to stop it being misread as a
regression later.

**Confirmed working:** the unlit neon material tints the skinned mesh correctly.
That was the one real risk in the swap, since the creature colours are set by
cloning and tinting a material at runtime and a shader that did not handle bone
skinning would have failed silently. Cyan, violet and gold all render.

### Room bounds: keeping jellyfish out of the walls

Spawning all around the room exposed the next problem, reported after the first
real playtest: *"currently they go inside the walls, can we have a room scale
boundry? so the jellyfish dont go inside walls and furnitures"*.

The instruction that followed mattered more than the feature: *"make sure to
use world mesh and not your own thing, use what lens studio already gives."*
That is the right call. A hand-rolled geometry system would be more code, worse
results, and one more thing to fail on camera.

**`WorldQueryModule` is the world mesh API.** There is no separate thing to
install:

```ts
const wq = require('LensStudio:WorldQueryModule');
this.hitSession = wq.createHitTestSession(options);
this.hitSession.start();
```

`checkWalls()` raycasts from the camera towards one creature per frame, round
robin, so the cost is one hit test per frame no matter how many creatures are
in the room. If a real surface comes back closer than the creature, the
creature is pulled in front of it by `wallMarginCm` (25 cm) and re-homed there,
so it does not immediately swim back into the wall.

The hit test result arrives in a callback, by which time the creature array may
have changed, so the callback re-checks before touching anything:

```ts
if (this.creatures.indexOf(c) < 0) return;
```

Inputs: `useWorldMesh` (on), `wallMarginCm` (25), plus `useRoomBounds` (on) and
`roomRadiusCm` (170) as a plain spherical fallback for rooms where the mesh has
not been built up yet. Both can run together; the sphere is the cheap floor and
the mesh is the accurate one.

**Occlusion is a separate step and worth doing.** Hit testing stops creatures
entering walls, but it does not make a wall hide one that is behind it. For
that, add a **World Mesh** object to the scene and give its visual an occluder
material, `RoomOccluder` here. Real furniture then hides the jellyfish, which is
the single strongest argument on camera that this is mixed reality and not an
overlay. Confirmed in the log:

```
LumiCatch: world mesh hit testing active
```

Note the object the preset creates is named **World Mesh**, and the preset
returns the **component** UUID rather than the object's, which is worth knowing
before hunting for it in the scene graph.

### Internet Module: nothing to install

You do not need to add an Internet Module asset at all. Lens Studio exposes its
built in modules to script through the `LensStudio:` prefix, so the script pulls
one itself:

```ts
require('LensStudio:InternetModule')
```

`resolveInternetModule()` uses the Inspector slot if you have filled it, and
falls back to that `require` if you have not. The `internetModule` input can
stay empty forever.

**Verified end to end**, with the input slot deliberately left empty: the Lens
logged `connected to net`, and `mock-net.py` logged `Lens connected from
127.0.0.1` followed by a real `<- haptic 1 (nearby)` message arriving over the
socket. Connection and Lens-to-Net messaging both proven with no hardware and
no asset.

Do not install either Asset Library result that looks relevant:

- **Remote Service Gateway** is a Snap-hosted proxy for third party cloud APIs. It ships with a companion 'Remote Service Gateway Token Generator', which tells you what it is. It needs a token and a cloud round trip, and it cannot reach a server on your own network. Wrong tool, and against the no-cloud constraint.
- **WebSocketExamples** is a sample project. It contains an Internet Module asset, which is why it looks like the source, but you do not need to import a whole example project to get one.

For context: `createWebSocket` moved from `RemoteServiceModule` to
`InternetModule` in Lens Studio 5.9. We are on 5.15.4, so `InternetModule` is
correct and current.

### Two schools, and shoal mood

Creatures are split between two schools, alternating as they spawn so the pair
stays balanced as you catch and they respawn. Each school has a centre that
orbits you slowly, and the two counter rotate so they sweep past each other
rather than moving in lockstep. School centres use world axes, not camera axes,
so turning your head does not drag the schools around with you.

The shoal has a mood, and the mood is set by what you just did:

| Mood | Trigger | Behaviour |
|---|---|---|
| Calm | default | Loose schools at `schoolMidCm` (170), cohesion 0.15 |
| Spooked | `spookCatches` (3) catches within `spookWindowS` (8 s) | Schools pull tight (cohesion 0.75) and back off to `schoolFarCm` (250) for `spookSeconds` (5 s) |
| Curious | `curiousMisses` (2) misses in a row | Formation breaks entirely (cohesion 0), each creature picks its own spot around you at `curiousDistanceCm` (85) for `curiousSeconds` (8 s) |

Every mood change re-homes each creature and sets it swimming to the new spot
rather than snapping, so the change is something you watch happen. It prints to
the log too, which is how you confirm it fired:

```
LumiCatch: spooked, the schools are grouping tight and backing off
LumiCatch: curious, the schools are dispersing and coming closer
LumiCatch: the schools have settled
```

The read on camera is deliberate: catch three in a row and they flee as a shoal,
which makes you look dangerous. Miss twice and they crowd in around you, which
gives you an easy recovery and a good close-up. The game gets easier exactly
when the take is going badly.

**The Guarantee stands down while spooked.** Backing off is the point of that
mood, and dragging a creature back would fight it. Spook lasts five seconds and
only ever follows a run of successful catches, so a take is never stranded.

### Why not boids

Boids was considered and rejected. Three reasons, in order of weight:

1. **It is the wrong read.** Boids produces flocking, which looks like a school of fish moving as one body. Jellyfish drift independently on their own currents. Flocking would make them look like the wrong animal.
2. **It fights a rehearsed take.** Boids positions are emergent, so where the swarm goes is not predictable between takes. The whole design here is built on knowing what will be in front of the camera.
3. **It costs more than it returns.** Neighbour queries are the expensive part, and the payoff is a behaviour that actively hurts points 1 and 2.

The schools above are **not** boids. There are no neighbour queries and nothing
emergent: each school has a centre point, creatures lerp towards it by a
cohesion value, and that value is set by a mood your own catches and misses
trigger. Same inputs, same behaviour, every take.

The one piece of boids actually worth having is a
**separation** rule (`separationCm`, 35) that pushes overlapping creatures
apart. Two jellyfish occupying the same point is the single overlap artefact a
viewer would notice, and separation alone fixes it. At 14 creatures that is 91
pair checks per frame, which is free, and every creature keeps its own
predictable path.

If you want more life in the movement, raise `driftAmplitudeCm` or vary
`spinRate`. Both are safe. Flocking is not.

### Creature colour is set by the script, not the material

The `JellyfishGlow` and `JellyfishGold` material assets are graph materials, and
their colour does **not** persist when set from outside Lens Studio: writing
`baseColor` or `Port_Default_N369` reports success and then reverts to white.
That is why creatures first appeared as plain white spheres.

Colour is therefore owned by the script. `COL_DRIFTER`, `COL_SKITTISH` and
`COL_LUMEN` at the top of `LumiCatchManager.ts` define cyan, violet and gold.
At spawn the prefab's material is cloned once per kind and tinted, so all three
personalities are visually distinct from a single prefab.

To change a colour, edit those three constants. Do not bother editing the
material asset from a script or tool, it will not stick. Editing the colour by
hand in the Lens Studio Material inspector does work, if you prefer that.

Spectacles displays are additive: bright saturated colours read well and dark
colours vanish. Keep all three constants bright.

### Spectacles 2024 display geometry, and why the tuning changed

This matters more than anything else in this file, because the submission is filmed through the glasses rather than captured from the Lens Studio preview.

Snap's own figure: the displays reach full overlap at 1.1 m, where the visible content area is roughly **53 cm wide by 77 cm tall**. Work the angles back from that:

- Horizontal field of view is about **27 degrees**, so plus or minus 13.5 degrees from centre
- Vertical is about **39 degrees**
- The focus plane sits at 1 m, so content is most comfortable near that distance

The Lens Studio preview camera has a 63.5 degree field of view. That is more than twice as wide as the glasses. **Anything you tune by eye in the preview will be far too spread out on device**, and creatures you can see perfectly well in preview will simply not be on the display when you put the glasses on.

Values were recalibrated against that geometry:

| Input | Was | Now | Reason |
|---|---|---|---|
| `spawnYawSpread` | 1.9 rad (+/- 54 deg) | 0.7 rad (+/- 20 deg) | At the old value most creatures spawned outside the display entirely. The new value keeps most in view, with a few needing a small head turn |
| `spawnMinCm` | 80 | 90 | Sits closer to the 1 m focus plane |
| `spawnMaxCm` | 220 | 200 | Same reason, and keeps creatures readable at 10 cm across |
| `spawnHeightSpreadCm` | 70 | 45 | The old range put creatures above the top edge of the display |
| `captureConeDot` | 0.45 (63 deg) | 0.8 (37 deg) | The old cone let you capture creatures you could not see, so the burst happened off screen and the take looked like nothing happened |
| `driftAmplitudeCm` | 22 | 15 | 22 cm of drift at 1 m is about 11 degrees, a large fraction of a 27 degree display |
| `fleeDistanceCm` | 70 | 32 | A 70 cm dodge threw the creature clean out of frame |
| `leashMaxCm` | 260 | 230 | Follows the reduced `spawnMaxCm` |
| `creatureScale` | 1.0 | 10 | The script drives world scale every frame, so it overrides prefab scale. 10 matches the sphere preset's own default |

If you later tune by eye, **tune while wearing the glasses, not in the preview**. The preview will lie to you about spread every time.

## Phase 6 - Assemble the net (1 hour)

1. Strap the breadboard and UNO Q flat against the handle with velcro or rubber bands, board USB port facing the handle end.
2. Tape the MPU-6050 rigidly near the top of the handle, close to the hoop. Rigid mounting matters more than position: a wobbly sensor smears the acceleration signal. Keep its axes roughly aligned with the handle for sanity while debugging (the maths uses magnitude, so exact orientation does not matter).
3. Tape the coin motor where your top hand grips, in direct contact with the handle so the buzz carries.
4. Velcro the power bank near the base of the handle: it doubles as a counterweight for the hoop.
5. Wrap everything in black insulation tape. On camera it reads as prototype hardware rather than mess.

## Phase 7 - End-to-end tuning (1 hour)

Run the full loop wearing Spectacles. Things to tune:

- False captures while walking: raise `SWING_THRESHOLD_G` to 2.6 or so.
- Swings feel laggy: the chain is IMU (150 ms peak window) + 30 ms poll + WiFi. Reduce `PEAK_WINDOW_MS` to 100 for snappier response at the cost of slightly less accurate peak values, which you are not using for scoring anyway.
- Creatures spawn inside walls: reduce `spawnMaxCm` in the Lens script for a small room.
- Proximity buzz too chatty: raise `nearbyCooldownS`.

Creature AI tuning, all in the Inspector:

- Nothing ever seems catchable: lower `captureConeDot` towards 0.3 to widen the cone, or raise `captureRangeCm`.
- Creatures dodge too well and the video looks frustrating: lower `skittishChance`, raise `alertRangeCm` so they react earlier and end up further away, or just raise `mercySeconds`.
- Dodges look like a glitch rather than a decision: raise `alertHoldS` to about 0.35. That pause is what makes the behaviour legible on camera.
- Creatures wander out of shot: lower `leashMaxCm`, and check `forwardSign`.
- Everything spawns behind you: flip `forwardSign` from -1 to 1. This is the first thing to check if the scene looks empty.
- Jellyfish are the wrong size: use `creatureScale`, not the prefab scale. The script drives world scale every frame for the bell pulse, so prefab scale is overridden.
- Motion feels too frantic: lower `spinRate` and `pulseAmount`. On a small headset display, less is more.

## Phase 8 - Film it (half a day)

Structure the video as proof, not montage:

1. Open on the Spectacles first-person capture (built-in recording): jellyfish drifting, swing, capture burst, score tick. This is your hero footage.
2. Third-person phone shot of you swinging the physical net, intercut with the first-person view of the same moment so judges connect the two.
3. The haptic insert: close-up of the motor on the handle with a few grains of rice on it, buzzing at the capture moment. This one shot proves the feedback loop.
4. A five-second architecture card (the diagram at the top of this guide) while you narrate: swing detected on the microcontroller, relayed by the onboard Linux side over local WebSocket, zero cloud.
5. End on two or three consecutive captures with combo haptics.

Record the Spectacles capture and phone footage of the same take so the sync is genuine; judges can spot faked sync cuts.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| MPU reads zeros | SDA/SCL swapped, or 5 V power | Rewire per diagram, use 3V3 |
| No swing prints | Threshold too high, loose sensor | Lower threshold, tape sensor rigidly |
| Readings fine at rest, all zeros the moment you move it | The MPU browned out and reset into **sleep mode**. Asleep it still ACKs on I2C and returns zeros, so it looks like a dead sensor rather than a loose wire | Firmware now detects this and re-wakes it automatically, printing `IMU had reset to sleep`. If that message appears at all, fix the wiring: it is a warning, not a cure |
| `peak` value goes **down** | The sketch restarted | Peak only ever climbs, so a decrease means a reset. Usually a power glitch from a moving jumper |
| Magnitude reads about 0.92 g at rest instead of 1.00 | Normal gain error on cheap MPU-6050 modules | Harmless. Thresholds are relative, so set them from what you actually measure rather than from theory |
| Motor never buzzes | Transistor pins reversed | Check E-B-C order against datasheet |
| `websockets` import error | Dependency missing | `sudo apt install python3-websockets` |
| `Bridge.call` returns None | App Lab version quirk | Open the built-in Bridge example in App Lab and match its call style |
| Sketch uploads fine, console stays empty | Looking at the deploy log, not the Serial Monitor | App Lab has three consoles. Sketch output is `Console > Serial Monitor`. The log ending in `Container ... Started` is the deploy log and never shows sketch output |
| Sketch uploads fine, Serial Monitor still empty | Used `Serial` instead of `Monitor` | Including `Arduino_RouterBridge.h` replaces `Serial` with `Monitor` on the UNO Q. Call `Monitor.begin()` and use `Monitor.print`. This is the most common reason a working sketch looks dead |
| Printing worked in Phase 1 and 2, stopped in Phase 3 | **`Bridge.begin()` called after `Monitor.begin()`** | `Monitor` rides on the same Router Bridge transport, so starting the Bridge afterwards resets the channel and every print after that point vanishes. Phases 1 and 2 printed fine precisely because neither called `Bridge.begin()`. Call `Bridge.begin()` and register the RPCs **first**, then `Monitor.begin()` |
| Need to check swing detection with no console | `BUZZ_ON_SWING` | Set true in `sketch.ino` and every detected swing gives a strong 140 ms tick at full power. Verifies the whole detection path without reading a line of output. **Set it false before filming** |
| Swing ticks not felt at all | Early version used the gentle nearby blip, 70 ms at PWM 110 | With a floor of 55 and 50 to 100 ms of spin-up, the rotor barely turns in that time. `BUZZ_ON_SWING` now uses a dedicated full power tick instead |

### Reading the boot buzz

Because the console is not dependable once the Bridge is up, the motor reports
the IMU's health at boot. Count the buzzes:

| Buzzes | Meaning | What to do |
|---|---|---|
| **1 long** | IMU alive and reading gravity | All good, carry on |
| **2 short** | Nothing answering at 0x68 | Wiring. SDA, SCL, VCC or GND has come loose |
| **3 short** | Answering but reading zero | Asleep or dead. Usually a power glitch, check VCC seating |
| **4 short** | `WHO_AM_I` unexpected | Wrong chip, or a marginal connection |

That turns the motor into a diagnostic channel, which matters on a build where
the console has already proven unreliable twice.
| First few printed lines are missing | `Monitor` needs time after `begin()` | Add `delay(3000)` straight after `Monitor.begin()` |
| Laptop connects, Spectacles will not | Router client isolation | Use a phone hotspot for UNO Q + Spectacles |
| Lens preview connects, device does not | Experimental APIs off, or wrong IP | Enable in Project Settings, re-check `hostname -I` |
| Everything works, then dies mid-demo | Power bank auto-sleep at low draw | Use a bank with low-current mode, or add a small periodic LED blink to keep draw up |
| Lens will not compile, error on the SIK import line | SIK package not unpacked into `Cache/TypeScript/Src/Packages` | Unlikely, this was verified present. If it happens, delete the `import { SIK }` line and the body of `bindPinch()`, and untick `usePinchToSwing`. You lose only the on-device pinch fallback |
| Manager script seems to run after other scripts | Scene Hierarchy order | Lens Studio runs scripts top-down by hierarchy order. Keep the `LumiCatch` object near the top |
| Preview is empty, no jellyfish | `forwardSign` wrong, or `creaturePrefab` unassigned | Read the startup log. `0 of 5 creatures spawned in front` means flip `forwardSign` to 1. Otherwise confirm the prefab slot is filled |
| Net buzzes constantly | Old build without edge triggered proximity | Fixed. If it returns, check `nearbyActive` is being reset in `onUpdate` |
| Nothing catchable for the first few seconds | Old build without the hero creature | Fixed. Confirm `guaranteeEasyTarget` is ticked |
| Creatures are plain white spheres | Material colour set outside Lens Studio does not persist | Colour is applied by the script at spawn. Edit `COL_DRIFTER` / `COL_SKITTISH` / `COL_LUMEN` in `LumiCatchManager.ts`, or set it by hand in the Material inspector |
| Changed a default in the code and nothing happened | **Once an `@input` exists, the Inspector's stored value wins over the code default** | Change it in the Inspector, not in the source. This has caused several 'the fix did nothing' rounds. Editing a default only affects inputs Lens Studio has never seen |
| Sense strand invisible | Motes too small to notice | Run the preview and read `mote 0 world scale ... cm, ... cm away`. Below about 3 cm at 1 m they vanish into the background. Raise `hudMoteLitCm` |
| Log says 'no RenderMeshVisual found on the creature prefab' | Prefab has no mesh anywhere in its hierarchy | Rebuild the prefab from a Sphere object, the script searches the whole subtree |
| Creatures feel sparse now they are all around | Only about a fifth are in view at any moment with a 27 degree display | Raise `creatureCount`, or turn `spawnAllAround` off to concentrate them ahead of you |
| One jellyfish sits frozen and never moves | The prefab's original scene instance was left in the hierarchy | Delete it from Scene Hierarchy, the prefab asset is what matters |
| Clicking in preview does nothing | `simulate` unticked | Tick `simulate`. It must be on for click and pinch to fake a swing |
| Pinch does nothing on device | TapEvent does not fire on Spectacles | Expected. That is what `usePinchToSwing` is for, confirm it is ticked |
| Captures fire twice per click | Click and pinch both firing | Already debounced to 0.4 s. If it persists, untick `usePinchToSwing` while previewing |

## How this maps to the scenario brief

The brief: *a robot that interacts with players in physical space while syncing
with a digital game, laser tag meets AR. Computer vision for tracking, AI for
dynamic gameplay. App Lab hosting the game dashboard and multiplayer sessions.*

Clause by clause, honestly.

### Interacts in physical space, synced with a digital game

The core of the project. A physical net carrying sensing, computation and
actuation, swung in a real room, driving an AR world in real time, with
vibration coming back through the handle on capture. Round trip is local, with
no cloud in the path.

### Robot

The net is a **kinetic peripheral**: it senses (6-axis IMU at 200 Hz), computes
(STM32 for real-time, Qualcomm for models), actuates (haptic motor), and acts on
its own decisions rather than relaying raw data. It does not drive itself
around, and the write-up should not claim it does. Describe it as the robotic
instrument the player wields, which is what it is.

### Computer vision for tracking

**This runs on the Spectacles, not on the UNO Q.** Snap's Device Tracking is
visual-inertial SLAM: the glasses' cameras track the room and the player's
position within it, which is what lets creatures hold their place in space while
the player walks around them. That is genuine computer-vision tracking, and it
is load-bearing here, not decorative. Say precisely that, and say where it runs.

An OV7670 was considered for on-board vision and rejected. It is a parallel DVP
sensor, so it lands on the STM32 side while the models run on the Qualcomm side,
and a VGA frame is 614 KB against a Bridge carrying a few floats per poll. The
Qualcomm image pipeline expects MIPI CSI, which a parallel sensor cannot use.
For on-board vision after the deadline the right part is a plain USB webcam,
which appears as `/dev/video0` on the board's Debian.

### AI for dynamic gameplay

Two models on the Qualcomm side, in `neon_ai.py`. Covered in full below.

### App Lab hosting the dashboard and multiplayer sessions

`dashboard.py`, served on **port 8080** from the same Python process as the
WebSocket server. Open `http://<board-ip>:8080` on any device on the network.

The page is built for someone who has never seen the project. The first
playtest verdict on the old version was blunt, and fair: *"what is the use of
dashboard i dont understand."* It was a grid of unlabelled numbers. It was
rewritten around three questions instead.

**Who is playing.** Players are the top of the page, one card each, sorted by
score with the leader marked. Each card carries the player number, their
address, their score, catches out of swings, catch rate, and the shoal mood
they are currently seeing.

**What the AI decided for them.** Every card has a difficulty meter labelled in
words rather than a bare number: *Gentle, Easy, Balanced, Hard, Brutal*. Under
it, a sentence saying what the model just did and why, for example *"Catching
more than 55% of swings, so the shoal was sped up and made harder to sneak up
on."* The thresholds in that sentence are sent with the state as
`target_ratio` and `dead_band`, read off the live `AdaptiveDifficulty`, so the
explanation cannot drift away from what the model is actually doing.

**What the two models are.** Each is named, described in a sentence of plain
English, and shown with its live figures: swings forecast and warning time for
the trajectory model, players tuned and forecast confidence for the difficulty
model.

Totals sit in a thin strip at the bottom, because the per-player story is the
point and the totals are not.

**Multiplayer is real, not decorative.** Every connected Lens becomes a
`Session` with **its own `AdaptiveDifficulty` model**, so two players on one net
world each get tuned to their own skill rather than sharing an average. Results
and difficulty updates are addressed per socket, not broadcast. The Lens sends
its score with every result, so the leaderboard is the game's own score rather
than a count kept separately on the board.

No webfonts and no CDN: the board is usually on a phone hotspot with no route
out, so anything external would silently fail to load.

`mock-net.py` serves the identical page. Note that the mock keeps **one** shared
difficulty model for all clients, because it is a single-player rehearsal tool,
so two clients against the mock show identical figures. **Film the multiplayer
shot against the board**, where the per-session models are real.

Verified: two clients driven through nine results each showed correct
per-session scores, catch rates, difficulty and mood, with the page serving and
every field the UI renders present in `/state`.

#### Dead sessions used to pile up

Found while testing the new page: the dashboard was listing **eleven players
from one address, all with zero swings**. None of them existed.

Every Lens preview restart opens a fresh WebSocket, and the old socket is left
open with nobody behind it. No TCP FIN ever arrives, so `read_frame` blocked on
`recv` for ever, the handler thread parked, and the session stayed listed for
the life of the process. Rehearse a few times before filming and the board
invents a dozen players in the middle of the multiplayer shot.

The fix is a read timeout plus a keepalive ping:

```python
conn.settimeout(IDLE_PING_INTERVAL)      # 30 seconds
...
try:
    frame = read_frame(conn)
except socket.timeout:
    conn.sendall(b'\x89\x00')            # ping, empty payload
    continue
```

The Lens only speaks when something happens, so silence is normal and is never
on its own grounds to drop anyone. The ping is what provokes a dead peer's
machine into answering with a reset, which makes the next read raise and clears
the session. Deliberately **not** conditional on getting a pong back, so a
healthy but idle player can never be dropped whatever the Lens does about pings.

Tested on real sockets both ways: a silent client survived four consecutive
ping intervals, and a client killed abruptly with `SO_LINGER 0` was reaped.

**Filming note.** The dashboard is the easiest way to put the AI and the
multiplayer claim on screen. A browser window beside the first-person capture,
difficulty visibly moving as you play, is a stronger evidence shot than any
amount of narration.

## Shared play: the board takes the world over

Up to this point each pair of Spectacles simulated its own shoal, and the board
predicted swings and set difficulty. That is a complete single player game and a
non-existent multiplayer one: two headsets would run two unrelated shoals, and
each player would swing at jellyfish the other could not see.

Sharing a shoal needs an authority, and the UNO Q is the only thing both
headsets already talk to. So the architecture inverted.

| | SOLO | SHARED |
|---|---|---|
| Creature positions and behaviour | Lens | **UNO Q** (`shoal.py`) |
| Who caught what | Lens | **UNO Q**, first claim wins |
| Swing prediction, difficulty | UNO Q | UNO Q |
| Rendering, HUD, haptics | Lens | Lens |

### The rule that makes it a game

A headset in shared play does not catch anything. It **claims**:

```
Lens  -> { "type": "claim", "id": 7 }
board -> { "type": "taken", "id": 7, "by": 2, "kind": 3, "points": 8 }
```

The board grants the first claim and refuses every later one, so two players
lunging at the same jellyfish cannot both score it. A creature that has already
noticed you is refused as well, which is the same rule the single player game
uses, now enforced somewhere neither player can argue with.

### The protocol

| Message | Direction | When |
|---|---|---|
| `hello` | Lens to board | on pressing SOLO or SHARED, declares the mode |
| `mode` | board to Lens | acknowledges, and tells the Lens its player number |
| `pose` | Lens to board | 10 Hz, head position so creatures know when to bolt |
| `shoal` | board to Lens | 15 Hz, every creature's id, kind, position and state |
| `claim` | Lens to board | a swing landed on creature N |
| `taken` | board to all | somebody caught something, with who and what it was worth |
| `claimed` | board to Lens | that claim was granted or refused |

Keys in the `shoal` packet are single letters. It carries fourteen creatures
fifteen times a second over a phone hotspot, and that is not the place for
readable JSON.

### Colocation, honestly

Two Spectacles do not share a coordinate origin. Each headset pins the board's
room frame to wherever it stood when the round began, so two players who start
from roughly the same spot facing the same way will agree about where the
creatures are.

What is exact is the **state**: the same creatures, the same ids, one ruling on
each catch. Proper shared spatial anchors need Connected Lenses, which this
deliberately does not use, and the code says so rather than implying more than
it delivers.

### Three bugs worth recording

**The standalone build silently broke.** `build-standalone.py` inlines the
project's own modules so App Lab gets one file with no imports. It did not know
about `shoal.py`, so the generated file carried a live `from shoal import Shoal`
that would have failed on the board. Nothing complained locally, because
`shoal.py` is right there during development. If you add a module, add it to the
generator in the same commit.

**Twice as many jellyfish.** The Lens spawns its own shoal at startup, and in
shared play the board's shoal arrived on top of it: twenty-eight creatures, half
of them invisible to the other player. The first shared packet now clears the
local ones.

**A frozen shoal on disconnect.** If the board went quiet mid-round the Lens
kept rendering the last positions it was sent, leaving a motionless shoal
hanging in the room. It now notices after two seconds and falls back to
simulating its own. A dropped connection should cost you the shared game, not
the game.

### Tested on a laptop

`shoal.py` has no hardware imports, so `test_shoal.py` runs anywhere. The tests
worth having are the multiplayer rules rather than the arithmetic:

- the second claim on a creature is refused, and scores nothing
- a creature that has spotted you cannot be claimed
- the shoal never leaves the room, with a player walking circles for twenty simulated seconds
- a five second stall does not teleport the shoal, because `dt` is clamped

```sh
python3 test_shoal.py     # 30 checks
```

## The AI layer (hackathon requirement)

The hackathon requires the UNO Q's AI to be the project's main AI, and the
pitch commits to two models. Both live in `neon_ai.py`, which runs on the
Qualcomm Linux side inside App Lab. It imports nothing from Arduino, so the
whole thing runs and is tested on a laptop and then drops onto the board
unchanged.

### 1. Predictive Trajectory AI

`TrajectoryPredictor` forecasts a swing's peak before it happens, so the
Spectacles are warned while the net is still moving. That lead time is what
hides the WiFi round trip.

It fits a parabola through three smoothed points of the acceleration magnitude
and solves for the vertex. If that turning point falls inside the 100 ms
horizon, it emits a prediction with the peak value the swing is heading for and
a confidence score.

A parabola rather than straight Newtonian extrapolation for a concrete reason:
a swing decelerates harder the closer it gets to its peak, so projecting the
current slope forward at constant acceleration lands the peak roughly **twice**
as far ahead as it really is. On synthetic swings that error was 91 ms against
a true 40 ms. The parabola fit brought it to 84 ms, and firing early is the
safe direction for latency hiding.

**Known limitation, to fix on hardware:** the forecast is still biased late by
about 40 ms on synthetic traces. The early warning itself is sound, and it
fires roughly 40 ms before the real peak, which covers most of the round trip.
The `etaMs` number should be re-tuned against real IMU data before you rely on
it for anything tighter.

Safety property worth knowing: a prediction never awards a catch. The
authoritative catch still happens on the confirmed `swing` message, so a wrong
forecast can only ever be a wasted early warning.

### 2. Adaptive Heuristics (DDA)

`AdaptiveDifficulty` keeps the player near a target catch rate of 0.55. Every
swing reports hit or miss, and over a sliding window of 10 the ratio moves a
single difficulty value between 0 and 1. The Lens receives multipliers rather
than the raw number, so it keeps its own tuned baselines and the board only
scales them:

| Field | Effect in the Lens |
|---|---|
| `speedMult` | flee and return speed |
| `evasionMult` | how far a dodge carries |
| `alertMult` | how early a creature notices the net |
| `skittishBias` | proportion of creatures that flee at all |
| `cloaking` | above 0.65, rare Lumen creatures shimmer towards black |

Cloaking works because Spectacles displays are additive: fading a colour
towards black genuinely fades it out of sight rather than turning it grey.

### Hardening for a filmed take

Two problems found by reviewing the code that runs on the board, both fixed
before either file had ever executed:

**The sample buffer had a threading race.** `get_samples()` runs on the Bridge
RPC thread while `loop()` appends to the same array. When the buffer filled,
`loop()` shifted all 48 entries down, and that shift was the longest stretch
where both threads touched the same slots. Indices were always in bounds so it
could not crash, but it could hand the predictor garbled values. Overflow now
starts a fresh batch instead, which is a single assignment. It only triggers if
the Linux side stalls for over 240 ms, which should never happen at 30 Hz.

**A Bridge failure could kill the whole Linux side.** Any exception raised out
of the user loop takes the process down, and mid-take that means the net simply
stops existing. Every call now goes through `bridge_call()`, which swallows
failures, logs the first and then every hundredth, and returns `None`. A dropped
poll is recoverable; a dead process is not. The haptic call in the WebSocket
handler is guarded the same way, so a failed buzz cannot drop the Spectacles
connection.

### Getting the IMU stream to the Linux side

The models need raw samples, not just finished swings, and the sketch samples
at 200 Hz while the Linux poll runs at 30 Hz. So the sketch buffers magnitudes
and hands over a batch on each poll through a new RPC:

```cpp
String get_samples()    // "1.02,1.15,1.44", then clears the buffer
```

The buffer holds 48 samples, well above the ~6 per poll, and drops oldest
first if a poll runs late.

**This is the one part not yet verified.** Everything else in the AI layer is
tested; whether the Bridge returns a `String` cleanly is a hardware question.
Test it first when the board arrives. If strings do not come through, the
fallback is a fixed-width RPC returning one float at a time at a faster poll,
at the cost of prediction resolution.

### What is tested, and how

```
python3 test_neon_ai.py
```

Covers both models with synthetic swing traces: the predictor fires once per
swing, fires before the peak, stays inside the horizon, ignores walking and
sway, and re-arms between swings. The difficulty model rises on skilled play,
falls on struggle, holds steady at the target rate, clamps at both ends, and
waits for enough samples before reacting.

`mock-net.py` imports the **same** models, so running it exercises the real AI
rather than a stub. It synthesises an IMU trace per swing, pushes it through
the predictor, and emits a genuine `predict` before the `swing`. Verified end
to end: difficulty pushed on connect, `predict` 84 ms ahead of `swing`, twelve
reported hits driving difficulty to 1.0, then fourteen misses pulling it back
to 0.1.

## Why the AI is scoped this way

The UNO Q pairs a Qualcomm Dragonwing QRB2210 running Debian with an STM32U585
running the sketch. The Qualcomm side can run edge AI: it has an Adreno 702 GPU
and dual image signal processors, so inference is GPU assisted rather than on a
dedicated NPU, and Edge Impulse supports the board directly.

Both models are **heuristic**, matching the pitch's own wording of a
'lightweight heuristic model' and 'Adaptive Heuristics'. That is a deliberate
choice, not a shortcut:

- They run inside the 30 Hz poll loop with room to spare, on a board whose inference is GPU assisted rather than backed by a dedicated NPU.
- Their behaviour is inspectable and repeatable. A trained network's is not, and the whole project has to survive being filmed in one take.
- They need no training data, which matters when the hardware is not yet assembled.

The architecture is worth narrating in the video alongside the AI: **two
processors, split by latency budget.** The STM32 samples the IMU at 200 Hz and
times the vibration where microseconds matter, while the Qualcomm side runs the
models and the WebSocket server where they do not. The sample buffer bridging
them is exactly where that split becomes visible.

If judges push for a trained model, the natural upgrade is **swing type
classification** on Edge Impulse, which supports the UNO Q directly: tell an
overhand scoop from a backhand sweep from a flick and send the class alongside
the peak, so different catches score differently. The IMU stream is already
being buffered and sent, so the data pipeline for it exists. Budget a day for
collection and tuning.

## If the net's IMU dies

It happened during Phase 3: the module stayed powered, its LED lit, but nothing
answered on I2C at any address. Wires were on the right pads and the motor
circuit was ruled out by unplugging it.

**The game does not need the IMU to be demonstrable.** Set `pinchAsSwing` on the
`LumiCatch` object and a hand pinch fires a swing while still connected to the
net. What survives:

| Feature | Without the IMU |
|---|---|
| Capture, score, creature AI, schools and moods | Works |
| Haptics on capture | Works, the net still buzzes |
| Adaptive difficulty on the board | Works, fed by results from the Lens |
| App Lab dashboard and multiplayer sessions | Works |
| Sense strand | Works, driven by difficulty |
| **Trajectory predictor** | **Lost.** It is the one thing that genuinely needs the IMU stream |

So a dead sensor costs you one of two AI models, not the project. Film with
`pinchAsSwing` on, swing the net for the camera and pinch at the same moment,
and say plainly in the write-up which part is running from hand tracking.
An honest architecture description beats a claim that falls apart under a
question.

### Reviving a soldered module

Ranked by likelihood, not by drama:

1. **Solder bridge** between the adjacent `SCL` and `SDA` pads, or either to `GND`. Kills the bus, leaves power untouched, LED still lit. Zoom in with a phone camera under bright light: you want small shiny cones, not dull blobs. Fix with a clean iron tip.
2. **Cold joint.** Looks attached, conducts nothing. Re-touch each of the four with the iron, letting the pad heat properly before the solder flows.
3. **Wrong pads.** The GY-521 order is `VCC GND SCL SDA XDA XCL AD0 INT`. `XDA` and `XCL` are the auxiliary bus, not the main one, and land you exactly here. Note `SCL` comes **before** `SDA`.
4. **Lifted pad.** Too much heat or force pulls the copper away. Visible under magnification, and effectively terminal without fine rework.
5. **Heat damage to the chip.** Possible, but last on the list. A lit LED shows the power section survived, and the I2C pins are not especially fragile.

`diagnostics/i2c-scan.ino` rescans every four seconds, so leave it running while you rework
a joint and watch for `Found a device at 0x68` without touching anything.

## If you run short of time

Ranked by what the submission actually needs. Cut from the bottom.

**Must have, in this order**

1. Phase 3 passing: the net prints swing peaks reliably.
2. Phase 4 passing: `WebSocket server listening`, and the browser round trip works.
3. Phase 5.2: the Lens connects and captures from a real swing, on the laptop.
4. The net assembled well enough to swing, Phase 6.
5. Footage. A rough take that works beats a perfect one you never shot.

**Worth having**

6. The sense strand tuned on device.
7. The haptic insert shot: motor close-up with rice grains, buzzing on capture.
8. The third-person and first-person intercut.

**Drop without hesitation**

9. The trajectory predictor, if `get_samples` fights you. The adaptive difficulty model still runs on the board and still satisfies the AI requirement, and the strand still responds. Say so honestly in the write-up rather than claiming a model you could not land.
10. Capture chime, ambient loop, burst prefab. All optional and guarded.
11. Any further creature AI tuning.

**The one thing that is not optional:** film something. A project that works on
a bench and was never recorded scores nothing.

## Realistic schedule

Day 1: Phases 1-4 (hardware fully proven). Day 2: Phase 5 (Lens). Day 3: Phases 6-7 (assembly and tuning). Day 4: film and edit. Build in that order and never film before Phase 7 is boringly reliable.
