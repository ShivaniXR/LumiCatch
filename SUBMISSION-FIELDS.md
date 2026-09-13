# Hackster submission fields

Copy-paste ready. Checked against the contest's stated requirements.

---

## Project name

```
Neon-Net
```

Optional longer form if a subtitle field exists:

```
Neon-Net: jellyfishing in your living room
```

---

## Short project description

Hackster shows this under the title and in listings. Keep it to one or two
sentences.

```
A real aquarium fish net, wired with an Arduino UNO Q, that catches AR jellyfish
in your living room. The UNO Q reads the swing at 200 Hz, predicts its peak
before it happens, adapts the difficulty to the player, and in shared play runs
the whole shoal as the authoritative game server for everyone in the room.
```

Shorter alternative if the field is tight:

```
Swing a real fish net to catch AR jellyfish. An Arduino UNO Q on the handle
predicts your swing before it peaks and tunes the difficulty to you.
```

---

## Prize category

Select **Gaming**.

The five prize categories are Industrial IoT, Home Automation, Robotics, Gaming
and Social Impact. Under Gaming the guide lists three *example* ideas: an
AI-powered retro gaming console, a smart multiplayer arcade cabinet, and a
mixed-reality gaming robot. Those are prompts, not sub-categories to pick from,
and Neon-Net sits squarely in Gaming on its own terms: a mixed-reality game with
both AI models running on the UNO Q, plus shared multiplayer where the board is
the authoritative server.

**On calling it a robot.** Neon-Net is genuinely mixed reality and genuinely a
game, but it is not a robot: there is no actuation beyond a haptic motor and
nothing moves under its own power. Describing it as a 'mixed-reality gaming
robot' invites a judge to look for a robot, not find one, and discount the
entry. The honest framing is stronger anyway, because what is distinctive here
is not locomotion:

- the controller is a **physical object read by an IMU**, not a gamepad
- the board **predicts the swing before it peaks**, 35 to 84 ms of lead, which is what hides the wireless round trip
- the board **adapts difficulty** to the player in real time
- in shared play the board is **the game server**, ruling on who caught what

Lead with those. 'Mixed reality' and 'powered by AI' are both accurate and both
map onto what the rules actually ask for.

---

## Story / Instructions

Paste the whole of [`STORY.md`](STORY.md), replacing the seven `> **PHOTO:**`
and `> **HERO VIDEO:**` markers with the real media as you go.

The rubric asks: *'If I were a beginner reading this project, would I understand
how to recreate it?'* The story links to the build guide for the phase-by-phase
detail, so both the narrative and the instructions are covered.

---

## Things used

Hackster has structured fields for these. Everything is in [`BOM.md`](BOM.md).

**Hardware:** Arduino UNO Q, Snap Spectacles (2024), MPU-6050 / GY-521 IMU,
ERM coin vibration motor (3 V), 2N2222 NPN transistor, 1 kΩ resistor, 1N4007
diode, 170-point mini breadboard, jumper wires, USB-C power bank, USB-C cable,
aquarium fish net.

**Software:** Arduino App Lab, Arduino core `arduino:zephyr` 0.90.0,
Arduino_RouterBridge 0.4.3, Lens Studio 5.15.4, Spectacles Interaction Kit
0.16.4, Python 3 (standard library only).

> **Both `Arduino UNO Q` and `Arduino App Lab` MUST appear in the Hackster
> 'Things used in this project' fields.** The project guide says a submission
> missing either one may be disqualified. Add them as structured entries, not
> only as prose in the story: the hardware field and the software field are
> what the judges filter on.

**Tools:** soldering iron, multimeter, phone camera.

---

## Schematics

Upload both. They serve different readers and the rubric accepts either:

| File | What it is |
|---|---|
| `wiring-diagram.png` | The **circuit diagram**: components, values, how the signals connect |
| `breadboard-view.png` | The **breadboard view**: jumper colours and which hole every wire goes into, Fritzing-style |

SVG sources (`wiring-diagram.svg`, `breadboard-view.svg`) can go up as resource
files alongside them.

`wiring-complete.html` is a longer illustrated wiring walkthrough if a second
resource is wanted.

The rubric accepts drawn diagrams *and/or* detailed photographs, so add close-up
photos of the real breadboard as well once you have them. Both count.

---

## Code

Link the public repository: <https://github.com/ShivaniXR/LumiCatch>

If Hackster wants individual code blocks attached, the ones worth attaching are:

| File | Why |
|---|---|
| `sketch.ino` | MCU firmware: IMU, swing detection, haptics, watchdog |
| `neon_ai.py` | Both AI models, heavily commented |
| `shoal.py` | The authoritative shared shoal: creature behaviour and catch arbitration |
| `main-nodeps-standalone.py` | The Linux side as actually deployed |
| `Lumicatch/Assets/LumiCatchManager.ts` | The Lens |

---

## Cover image

**Required, and not yet shot.** The strongest option is the finished net held up
with the electronics visible on the handle, on a plain background.

---

## Media still needed

| # | Shot | Where it goes |
|---|---|---|
| 1 | Finished net, whole, plain background | **Cover image** |
| 2 | 60 to 90 s demo video: first-person capture intercut with the net being swung | Top of story |
| 3 | First-person capture mid-round, jellyfish close, HUD visible | 'What it is like to play' |
| 4 | Shoal across the room, creatures occluded by real furniture | 'What it is like to play' |
| 5 | Dashboard on a laptop beside the gameplay, two sessions listed | 'App Lab' section |
| 6 | Soldered IMU close up, and the transistor circuit on the breadboard | 'Five things that went wrong' |
| 7 | Net mid-assembly, before the electronics were taped down | 'Five things that went wrong' |

Shot 5 is the multiplayer evidence, and shots 2 and 3 are what carry the
Creativity marks, since they are the only place the AI readouts are visible in
motion.
