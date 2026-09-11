# Neon-Net: submission checklist

Scored against the Hackster rubric, and against what the winning pitch actually
promised. Written while the replacement IMU was being soldered.

Total is 100 points. **65 of them are documentation, BOM and schematics.** The
engineering is in good shape; the submission is not, and that is where the
marks are.

---

## Where the points are

| Category | Points | State | Gap |
|---|---|---|---|
| Project Documentation | **30** | weak | No images, no video, no narrative story |
| Complete BOM | **20** | missing | Nothing written. Easiest 20 points available |
| Schematics | **15** | good | `wiring-diagram.svg` plus the full wiring page. Add build photos |
| Code & Contribution | **15** | strong, but private | Well commented and tested. **Not in version control, not public** |
| Creativity | **20** | strong | Concept is distinctive. Make the AI visible in the video |

---

## Promised in the pitch, not yet built

Judges compare the submission against the pitch that won the hardware. These
are the gaps.

### 1. 3D spatial audio — promised explicitly, entirely absent

The pitch lists it as a main feature. `captureSound` and `ambientSound` inputs
exist on the manager and are both unassigned, so the game is silent.

This is the clearest unmet promise, it is cheap to fix, and it transforms the
video. An underwater ambient bed plus a capture chime turns a screen recording
into an experience.

### 2. Multiplayer — built, never demonstrated

Per player sessions and per player difficulty models are implemented and
tested. Nothing in the submission will show it unless two clients connect at
once. **A single dashboard screenshot with two sessions listed is enough
evidence**, and the mock net can be the second client.

### 3. 'Velocity and orientation' — only magnitude is computed

The pitch says the UNO Q "calculates the net's velocity and orientation". The
firmware computes acceleration magnitude only. Two honest options:

- Reword the write-up to say acceleration magnitude, which is what the swing detector and the trajectory model actually consume, or
- Use the gyro, which the MPU-6050 already has, to report orientation as well

The first is free and truthful. The second is a genuine feature if time allows.

### 4. App Lab 'Communication Bricks'

The pitch names Bricks; the build uses the Router Bridge RPC directly, which is
the lower level mechanism underneath. Not a problem, but describe what was
actually used rather than repeating the pitch wording.

---

## What to do, in order of points per hour

### 1. Photograph everything, now, while assembling

Once the net is taped and wrapped, the interesting shots are gone forever.
Documentation is the largest category and photos are most of it.

Shoot: the bare breadboard with the MPU, the transistor circuit close up, the
soldered IMU, the net mid-assembly, the finished handle, the power bank strap,
and the whole net on a plain background.

### 2. Write the BOM

Twenty points, about an hour, no cleverness required. Hardware with quantities
and prices, software with versions, tools. Details in the section below.

### 3. `git init` and publish

'Code & Contribution' implies sharing. A public repository with the commented
source, the guide and the wiring diagram is what that category is asking for.
Add a `.gitignore` for the Lens Studio `Cache/` folder.

### 4. Add the audio

Fills the clearest unmet promise and improves the video more than any other
half hour available.

### 5. Turn the build guide into a story

`LumiCatch-Build-Guide.md` is genuinely strong engineering documentation but it
is written as notes to self. The rubric asks: *"If I were a beginner reading
this project, would I understand how to recreate it?"*

**The debugging is an asset, not an embarrassment.** Most submissions present a
clean path that never happened. This build hit, and solved, a series of real
faults that any other UNO Q builder will hit too:

- `Serial` prints nothing once `Arduino_RouterBridge.h` is included; it is `Monitor`
- `Bridge.begin()` after `Monitor.begin()` silently kills all further printing
- `ports: []` in `app.yaml` means the container never publishes, so a working server is unreachable
- A momentary brownout resets the MPU-6050 into sleep, where it still ACKs on I2C and returns only zeros
- ERM coast-down is 80 to 100 ms, so haptic patterns with shorter gaps blur into one buzz

Written up honestly, that section is more useful to a beginner than the happy
path, and it demonstrates depth that a polished-but-shallow submission cannot.

### 6. Evidence the AI on camera

The strongest creativity argument is that the AI is visible rather than
claimed. Two shots:

- The **dashboard beside the gameplay**, difficulty moving as the player improves
- The **sense strand**, with the prediction mote running its length

---

## BOM to write up

**Hardware**

| Item | Qty | Notes |
|---|---|---|
| Arduino UNO Q | 1 | Qualcomm QRB2210 plus STM32U585 |
| MPU-6050 / GY-521 IMU | 1 | plus a spare, one was lost to a soldering fault |
| ERM coin vibration motor | 1 | 3 V |
| 2N2222 or S8050 NPN transistor | 1 | TO-92 |
| 1 kΩ resistor | 1 | base current limiter |
| 1N4007 diode | 1 | flyback across the motor |
| Mini breadboard, 170 point | 1 | no power rails |
| Jumper wires | ~20 | male-male and male-female both needed |
| USB-C power bank | 1 | also acts as handle counterweight |
| Toy butterfly net | 1 | |
| Snap Spectacles (2024) | 1 | |

**Software**

| Item | Version |
|---|---|
| Arduino App Lab | as shipped |
| Arduino core | `arduino:zephyr` 0.90.0 |
| Arduino_RouterBridge | 0.4.3 |
| Lens Studio | 5.15.4 |
| Spectacles Interaction Kit | 0.16.4 |
| Python | 3, standard library only, no packages |

**Tools**: soldering iron, phone camera for close inspection, a second device
for the dashboard.

---

## Measured figures worth quoting

Real numbers carry more weight than adjectives, and these are all measured on
the actual build:

| Quantity | Value |
|---|---|
| IMU at rest | 0.87 g |
| Walking with the net | 0.65 to 1.08 g |
| A real swing | peaks at 5.50 g |
| Swing threshold | 2.2 g, twice the worst walking reading |
| Motor PWM floor | 55 of 255 |
| Motor coast-down | 80 to 100 ms |
| Prediction lead | 35 ms before peak, confidence 0.59 |
| Sketch flash use | 93 KB, 11 per cent |
| Sketch RAM use | 35 KB, 13 per cent |
| Python dependencies | zero |

---

## What is already strong

Do not undersell these.

- **Two AI models running on the Qualcomm side**, both tested, calibrated against measured hardware rather than guesses
- **A dual processor architecture with a real justification**: STM32 for 200 Hz sampling and vibration timing, Qualcomm for models and networking, split by latency budget
- **App Lab hosting a live game dashboard** with per player sessions and per player difficulty
- **Haptics designed around measured motor physics**, redesigned after the first four patterns proved indistinguishable
- **Filming safeguards** built in deliberately: leash, mercy window, guaranteed easy target
- **Zero cloud**, zero dependencies, everything on the local network
