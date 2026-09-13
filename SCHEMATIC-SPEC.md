# Neon-Net: schematic specification

What to draw, so the KiCad work is execution rather than rediscovery. Every
value here is from the built hardware, cross-checked against
[`wiring-diagram.svg`](wiring-diagram.svg) and [`BOM.md`](BOM.md).

Three sheets:

1. **System** — everything on one page, for the submission's main schematic
2. **IMU** — the MPU-6050 sensing subsystem alone
3. **Haptics** — the ERM motor driver alone

---

## Common

- **Board:** Arduino UNO Q. **3.3 V logic.** This is the single most important fact on the sheet, because the obvious mistake is powering the IMU from 5 V.
- **Power rails:** `+3V3` and `GND` only. There is no 5 V rail anywhere in this design.
- **Supply:** USB-C power bank into the UNO Q. Draw it as a labelled input, not as a battery symbol; it is a 5 V bank feeding the board's own regulator.

### Net names

| Net | From | To |
|---|---|---|
| `+3V3` | UNO Q `3V3` | MPU-6050 `VCC`, motor `+`, diode cathode |
| `GND` | UNO Q `GND` | MPU-6050 `GND`, Q1 emitter |
| `SDA` | UNO Q `SDA` | MPU-6050 `SDA` |
| `SCL` | UNO Q `SCL` | MPU-6050 `SCL` |
| `HAPTIC_PWM` | UNO Q `D9` | R1 |
| `Q1_BASE` | R1 | Q1 base |
| `MOTOR_N` | Q1 collector | motor `-`, diode anode |

---

## Sheet 1: System

Both subsystems on one page. Layout: UNO Q on the left as a rectangular
connector-style symbol with only the seven pins actually used. IMU top right,
haptic driver bottom right. Power rails horizontal, signals left to right.

Do **not** draw the full UNO Q pinout. Seven pins used, seven pins shown: the
schematic should answer 'what do I connect' and nothing else.

### Components

| Ref | Value | Footprint | Notes |
|---|---|---|---|
| `A1` | Arduino UNO Q | — | Symbol as a labelled connector block |
| `U1` | MPU-6050 (GY-521 breakout) | breakout header, 8 pin | Not the bare QFN: the build uses a module |
| `M1` | ERM coin motor, 3 V | 2 pad | Flat coin type |
| `Q1` | 2N2222 (or S8050) | TO-92 | NPN, low-side switch |
| `R1` | 1 kΩ | axial / 0805 | Base current limiter |
| `D1` | 1N4007 | DO-41 | Flyback, across the motor |

---

## Sheet 2: IMU subsystem

`U1` alone, with the four connections and the two facts that cost time:

- **3V3 only.** The GY-521's on-board pull-ups tie SDA and SCL to whatever VCC is. On 5 V it drags a 3.3 V bus to 5 V. Annotate the VCC pin directly.
- **`AD0` left unconnected** selects I2C address `0x68`; tied high it is `0x69`. The firmware probes both, so either works, but the sheet should say which one an unconnected pin gives you.

Label the I2C bus as a bus, and note that `Wire.begin()` takes no arguments
because the core already knows which pins carry it.

> **Annotation to include:** a momentary loss of VCC resets the MPU-6050 into
> sleep, where it still acknowledges on I2C and returns nothing but zeros. It
> looks exactly like a dead sensor. Secure every jumper.

---

## Sheet 3: Haptic subsystem

`Q1`, `R1`, `D1`, `M1`. A textbook low-side switch, drawn so the reasoning is
visible:

```
  +3V3 ──┬─────────────┐
         │             │
        M1            D1        D1 cathode (band) to +3V3
        motor       flyback
         │             │
         └──── MOTOR_N ┘
               │
               C
  D9 ──[ R1 ]──B  Q1   2N2222 NPN
               E
               │
              GND
```

Three annotations, because each one is a mistake somebody will otherwise make:

1. **D9 never carries motor current.** It supplies base current only. An ERM draws far more at stall than a pin can source.
2. **The diode is not optional.** Without it the motor's collapsing field spikes the rail when it switches off, and on this build that spike browns out the MPU-6050 into sleep. Band towards `+3V3`.
3. **Transistor pinout varies by manufacturer.** Check the part in your hand. A transistor that warms up means base and collector are swapped: cut power.

---

## Measured figures worth putting on the system sheet

| Quantity | Value |
|---|---|
| Motor PWM floor | 55 of 255 |
| Motor coast-down | 80 to 100 ms |
| I2C address | `0x68` (AD0 floating) |
| IMU sample rate | ~200 Hz |

---

## Output wanted

- `.kicad_sch` sources committed to the repo
- A **PNG export of each sheet** for the Hackster Schematics section, which renders PNG more reliably than SVG
- Keep [`wiring-diagram.png`](wiring-diagram.png) as well: it is pictorial rather than a schematic, and the two serve different readers
