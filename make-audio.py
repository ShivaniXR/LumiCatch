#!/usr/bin/env python3
'''
Generate Neon-Net's two sounds as 16 bit mono WAVs, standard library only.

    python3 make-audio.py

Writes into the Lens project's Assets folder, where Lens Studio picks them up:

    CaptureChime.wav   short bright bell, played at the creature's position
    AmbientDeep.wav    slow underwater drone, looped forever

Synthesised rather than downloaded so they are ours to publish, and so the
ambient bed loops with no seam: every partial completes a whole number of
cycles inside the buffer, which is the only way a loop point becomes inaudible.
'''

import math
import os
import struct
import wave

RATE = 44100
OUT = os.path.join('Lumicatch', 'Assets')


def write_wav(name, samples):
    path = os.path.join(OUT, name)
    with wave.open(path, 'w') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        frames = b''.join(
            struct.pack('<h', max(-32767, min(32767, int(s * 32767))))
            for s in samples
        )
        w.writeframes(frames)
    print('  %-18s %5.1f s  %6.1f KB' %
          (name, len(samples) / RATE, os.path.getsize(path) / 1024))


def capture_chime():
    '''
    A bright two-note rise with a fast attack and a long tail. Partials are
    slightly inharmonic, which is what stops a synthesised bell sounding like
    a test tone.
    '''
    dur = 0.9
    n = int(RATE * dur)
    out = []
    partials = [
        # (freq Hz, amplitude, decay rate, start time)
        (880.0,  0.50, 5.5, 0.00),
        (1318.5, 0.32, 6.5, 0.00),
        (1760.0, 0.20, 8.0, 0.00),
        (2637.0, 0.10, 11.0, 0.00),
        (1174.7, 0.40, 5.0, 0.11),   # the second note, a step up
        (1760.0, 0.26, 6.0, 0.11),
        (2349.3, 0.14, 8.5, 0.11),
    ]
    for i in range(n):
        t = i / RATE
        v = 0.0
        for freq, amp, decay, start in partials:
            if t < start:
                continue
            tt = t - start
            env = math.exp(-decay * tt)
            # 4 ms attack, so it reads as a strike rather than a click
            if tt < 0.004:
                env *= tt / 0.004
            v += amp * env * math.sin(2 * math.pi * freq * tt)
        out.append(v * 0.55)
    return out


def ambient_deep():
    """
    A slow underwater bed, pitched for the hardware rather than for headphones.

    The first version of this was built from 55, 82.5 and 110 Hz, which put 96
    per cent of its energy at or below 110 Hz. It sounded superb on a laptop
    and awful on the glasses: Spectacles' speakers are tiny and cannot move air
    at those frequencies, so instead of a deep hum you get the driver
    distorting, which is heard as a rattling, wobbling artefact.

    Everything here now sits between 220 and 880 Hz, where the speakers are
    actually capable, and the underwater feeling comes from the slow swells and
    the close intervals rather than from depth.

    Eight seconds, and every frequency completes a whole number of cycles in
    that window, so the loop point is silent. All values are multiples of
    0.125 Hz for exactly that reason.
    """
    dur = 8.0
    n = int(RATE * dur)
    out = []
    # (freq, amplitude). A low drone with a fifth and an octave over it, plus
    # two quiet upper voices for movement.
    voices = [
        (220.0, 0.26),
        (330.0, 0.15),
        (440.0, 0.11),
        (587.0, 0.05),
        (660.0, 0.04),
    ]
    for i in range(n):
        t = i / RATE
        # two slow swells, also whole cycles across the window
        lfo_a = 0.72 + 0.28 * math.sin(2 * math.pi * 0.125 * t)
        lfo_b = 0.85 + 0.15 * math.sin(2 * math.pi * 0.375 * t + 1.1)
        v = 0.0
        for freq, amp in voices:
            v += amp * math.sin(2 * math.pi * freq * t)
        # a high shimmer, very quiet, gives it some air
        v += 0.012 * math.sin(2 * math.pi * 880.0 * t) * lfo_b
        out.append(v * lfo_a * 0.5)
    return out


def main():
    if not os.path.isdir(OUT):
        print('cannot find', OUT, '- run this from the repo root')
        return 1
    print('Writing audio into %s' % OUT)
    write_wav('CaptureChime.wav', capture_chime())
    write_wav('AmbientDeep.wav', ambient_deep())
    print('Done. Lens Studio should import them automatically.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
