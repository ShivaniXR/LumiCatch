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
| SDA | D20 (SDA) |
| SCL | D21 (SCL) |

1. Open Arduino App Lab, create a new App called `lumicatch`.
2. Paste this smoke-test into `sketch/sketch.ino` and run it:

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

3. Open the console. At rest one axis should read roughly 16000 (that is 1 g at the default range). Shake the board and the numbers should jump. If you see zeros or the sketch hangs, check SDA/SCL are not swapped and that AD0 on the breakout is unconnected or tied to GND (address 0x68).

## Phase 2 - Prove the motor works (30 min)

Build the transistor circuit on the mini breadboard exactly as in `wiring-diagram.svg`: D9 through the 1 kΩ resistor to the base, emitter to GND, motor between 3V3 and the collector, 1N4007 across the motor with its band towards the 3V3 side.

Run this in place of the previous sketch:

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
- `creaturePrefab`, `rarePrefab` and `camera` inputs wired, tuning calibrated for the Spectacles 2024 display

Verified by running the preview: compilation succeeds, and the log shows
`LumiCatch: SIMULATE mode` followed by `LumiCatch: [sim] haptic pattern 1`,
which proves creatures spawned and the AI update loop is running.

Still to add by hand, none of which blocks simulate mode:

- **Internet Module** (Asset Browser + > Internet Module), then assign it to the `internetModule` input. Only needed when you untick `simulate`. The MCP tools cannot create this asset type.
- Score Text, capture chime, ambient loop, burst prefab. All optional, all guarded with `@allowUndefined`.

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
| Motor never buzzes | Transistor pins reversed | Check E-B-C order against datasheet |
| `websockets` import error | Dependency missing | `sudo apt install python3-websockets` |
| `Bridge.call` returns None | App Lab version quirk | Open the built-in Bridge example in App Lab and match its call style |
| Laptop connects, Spectacles will not | Router client isolation | Use a phone hotspot for UNO Q + Spectacles |
| Lens preview connects, device does not | Experimental APIs off, or wrong IP | Enable in Project Settings, re-check `hostname -I` |
| Everything works, then dies mid-demo | Power bank auto-sleep at low draw | Use a bank with low-current mode, or add a small periodic LED blink to keep draw up |
| Lens will not compile, error on the SIK import line | SIK package not unpacked into `Cache/TypeScript/Src/Packages` | Unlikely, this was verified present. If it happens, delete the `import { SIK }` line and the body of `bindPinch()`, and untick `usePinchToSwing`. You lose only the on-device pinch fallback |
| Manager script seems to run after other scripts | Scene Hierarchy order | Lens Studio runs scripts top-down by hierarchy order. Keep the `LumiCatch` object near the top |
| Preview is empty, no jellyfish | `forwardSign` wrong, or `creaturePrefab` unassigned | Flip `forwardSign` to 1, confirm the prefab slot is filled |
| One jellyfish sits frozen and never moves | The prefab's original scene instance was left in the hierarchy | Delete it from Scene Hierarchy, the prefab asset is what matters |
| Clicking in preview does nothing | `simulate` unticked | Tick `simulate`. It must be on for click and pinch to fake a swing |
| Pinch does nothing on device | TapEvent does not fire on Spectacles | Expected. That is what `usePinchToSwing` is for, confirm it is ticked |
| Captures fire twice per click | Click and pinch both firing | Already debounced to 0.4 s. If it persists, untick `usePinchToSwing` while previewing |

## Realistic schedule

Day 1: Phases 1-4 (hardware fully proven). Day 2: Phase 5 (Lens). Day 3: Phases 6-7 (assembly and tuning). Day 4: film and edit. Build in that order and never film before Phase 7 is boringly reliable.
