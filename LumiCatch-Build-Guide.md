# LumiCatch Build Guide

A step-by-step path from a bag of parts to a filmed, working demo. Each phase ends with something testable, so you always know the last thing that worked. Budget build: Arduino UNO Q (owned), MPU-6050, ERM coin motor with a 2N2222 transistor, toy net, power bank.

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
2. Paste `phase1-imu-test.ino` from the repo root into `sketch/sketch.ino` and run it. That file is the smoke test: it checks the bus answers at 0x68, reads `WHO_AM_I` to prove it is the right chip, then prints magnitude in g and tracks the peak.

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

**Firmware.** `sketch.ino` and `phase1-imu-test.ino` now watch for a magnitude
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

Use `phase2-motor-test.ino` from the repo root. It runs three tests and then
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

The motor should pulse once a second. If it is weak, check the transistor pinout (2N2222 flat face towards you: E-B-C left to right; S8050 is also E-B-C but verify against its datasheet). If nothing happens, confirm the motor spins when touched directly across 3V3 and GND for a moment.

## Phase 3 - Load the real firmware (20 min)

Replace the sketch with the provided `sketch.ino`. On boot the motor gives one confirmation buzz. Swing the breadboard sharply: the console prints `Swing peak: x.xx`. Tune two constants at the top if needed:

- `SWING_THRESHOLD_G` (default 2.2): raise it if walking triggers swings, lower it if honest swings are missed.
- `DEBOUNCE_MS` (default 400): stops one swing registering twice.

## Phase 4 - Bring up the Linux side (30 min)

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

## Phase 5 - Build the Lens (half a day)

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

## Realistic schedule

Day 1: Phases 1-4 (hardware fully proven). Day 2: Phase 5 (Lens). Day 3: Phases 6-7 (assembly and tuning). Day 4: film and edit. Build in that order and never film before Phase 7 is boringly reliable.
