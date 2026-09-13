# Neon-Net: bill of materials

Everything needed to rebuild Neon-Net, verified against the hardware that was
actually built. Nothing here is exotic: every part is a common hobby component
with widely available substitutes.

**Connections and component values are in the circuit diagram,
[`wiring-diagram.png`](wiring-diagram.png).**

---

## Hardware

| # | Item | Qty | Why it is there |
|---|---|---|---|
| 1 | **Arduino UNO Q** | 1 | The whole point. Qualcomm QRB2210 running Debian Linux alongside an STM32U585 running Zephyr. Supplied for the hackathon |
| 2 | **Snap Spectacles (2024)** | 1 | Developer units. Renders the Lens |
| 3 | **MPU-6050 / GY-521 IMU breakout** | 2 | One is a spare, and you will want it. The first was lost to a soldering fault mid-build |
| 4 | **ERM coin vibration motor, 3 V** | 1 | The haptics. A flat coin type, not a cylindrical pager type |
| 5 | **NPN transistor, 2N2222 or S8050** | 1 | TO-92. Switches the motor, because an MCU pin cannot source its stall current |
| 6 | **Resistor, 1 kΩ** | 1 | Base current limiter for the transistor |
| 7 | **Diode, 1N4007** | 1 | Flyback across the motor. Without it the motor's collapsing field spikes the rail and resets the board |
| 8 | **Mini breadboard, 170 point** | 1 | No power rails, which is what makes it small enough to tape to a net handle |
| 9 | **Jumper wires** | ~20 | You need **both** male-male and male-female. The IMU takes female ends |
| 10 | **USB-C power bank** | 1 | Any 5 V bank with a 2 A output. Goes in your pocket, not on the net |
| 11 | **USB-C cable, 1 m or longer** | 1 | Long enough to run from pocket to net handle without tugging |
| 12 | **Aquarium fish net** | 1 | The small mesh net used to scoop fish out of a tank. ~25 cm handle. The cheapest one in the shop is the right one |
| 13 | **Electrical tape / cable ties** | — | Mounting the breadboard and strain-relieving the cable |

The Arduino UNO Q and the Snap Spectacles are development hardware. Everything
else is a handful of common components and a fish net from a pet shop.

### Pin connections

Full diagram in [`wiring-diagram.png`](wiring-diagram.png); this table is the
same information in text, so the BOM stands on its own.

| UNO Q pin | Goes to | Note |
|---|---|---|
| `3V3` | MPU-6050 `VCC`, and motor `+` | **3.3 V only.** On 5 V the IMU's pull-ups drag SDA and SCL to 5 V |
| `GND` | MPU-6050 `GND` | |
| `SDA` | MPU-6050 `SDA` | Use the header pins marked on the silkscreen; `Wire.begin()` takes no arguments |
| `SCL` | MPU-6050 `SCL` | |
| `D9` (PWM) | 1 kΩ resistor, then transistor **base** | D9 never carries motor current, only base current |
| `GND` | Transistor **emitter** | |
| — | Motor `−` to transistor **collector** | |
| — | 1N4007 across the motor, band towards the `3V3` side | Flyback. Not optional |

The MPU-6050 sits at I2C address `0x68` with `AD0` unconnected, and `0x69` if
`AD0` is tied high. The firmware probes both.

### Why the transistor circuit, and not just a pin

An ERM motor draws far more at stall than a microcontroller pin can safely
source, and it is an inductive load. So the motor is switched rather than
driven: the MCU pin feeds a 1 kΩ resistor into the transistor's base, the motor
sits in the collector path, and the 1N4007 sits across the motor to absorb the
reverse spike when it switches off. Omitting the diode is the classic way to
brown out your own board, and in this build a brownout does something
particularly nasty: it resets the MPU-6050 into sleep, where it still
acknowledges on I2C and returns nothing but zeros.

Full wiring is in [`wiring-diagram.svg`](wiring-diagram.svg) and, with
explanation, in [`wiring-complete.html`](wiring-complete.html).

---

## Software

Every version below is the one the project was actually built and tested
against.

| Item | Version | Notes |
|---|---|---|
| **Arduino App Lab** | as shipped with the UNO Q | Hosts the Linux-side app in a container |
| **Arduino core** | `arduino:zephyr` 0.90.0 | For the STM32 side |
| **Arduino_RouterBridge** | 0.4.3 | RPC between the two processors. **Note it replaces `Serial` with `Monitor`** |
| **Lens Studio** | 5.15.4 | Builds the Spectacles Lens |
| **Spectacles Interaction Kit** | 0.16.4 | Used for real hit-targeted pinch on the start button |
| **Python** | 3 (system Python on the board) | **Standard library only** |

### Python dependencies: none

There are deliberately **zero** Python packages to install. The WebSocket
server, the HTTP dashboard and both AI models are written against the standard
library alone, including a hand-rolled RFC 6455 implementation. App Lab
containers make package installation awkward, and 'nothing to install' is worth
more on the day than any convenience a library would have bought.

### Arduino libraries

| Library | Purpose |
|---|---|
| `Arduino_RouterBridge` | RPC to the Linux side |
| `Wire` | I2C to the IMU |

No IMU library is used. The MPU-6050 is driven with raw register reads, which
is about thirty lines and means one less thing to break.

---

## Tools

| Item | Notes |
|---|---|
| Soldering iron and solder | For the IMU header. A cold joint here cost a full evening |
| Multimeter | Continuity checking the soldered IMU |
| Phone camera | Genuinely useful: photograph solder joints and zoom in, it beats squinting |
| A second device | For viewing the dashboard while playing |

---

## Assets

| Item | Source | Licence |
|---|---|---|
| `simple_jellyfish.glb` | Sketchfab | Check and record the model's licence before publishing |
| `CaptureChime.wav` | Generated by [`make-audio.py`](make-audio.py) | Ours |
| `AmbientDeep.wav` | Generated by [`make-audio.py`](make-audio.py) | Ours |

Both sounds are synthesised from scratch by a standard-library Python script,
so they are ours to publish and the ambient bed loops seamlessly. Every partial
in it completes a whole number of cycles inside the 8 second buffer, which is
the only way to make a loop point genuinely inaudible.

> **Action required:** confirm the licence on the Sketchfab jellyfish model and
> record it above with attribution, before the repository is submitted.

---

## Measured figures

Real numbers from the built hardware, not estimates.

| Quantity | Value |
|---|---|
| IMU at rest | 0.87 g |
| Walking, electronics mounted on the net | 2.0 to 3.0 g |
| A real swing | peaks at 5.5 g |
| Swing detection threshold | 3.5 g |
| Motor PWM floor (below this it does not turn) | 55 of 255 |
| Motor coast-down | 80 to 100 ms |
| Trajectory prediction lead | 35 to 84 ms before the peak |
| Sketch flash use | 93 KB, 11 per cent |
| Sketch RAM use | 35 KB, 13 per cent |
| Creature triangle count | 1110 each, 14 on screen |
| Python dependencies | 0 |
