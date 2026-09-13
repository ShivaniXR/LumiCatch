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


def bell(partials, dur, gain=0.55, attack=0.004):
    '''
    The shared bell body behind every chime here.

    partials is a list of (freq Hz, amplitude, decay rate, start time). Pulled
    out of capture_chime once a second and third chime were needed: three
    copies of the same loop is how they drift apart.
    '''
    n = int(RATE * dur)
    out = []
    for i in range(n):
        t = i / RATE
        v = 0.0
        for freq, amp, decay, start in partials:
            if t < start:
                continue
            tt = t - start
            env = math.exp(-decay * tt)
            if tt < attack:
                env *= tt / attack
            v += amp * env * math.sin(2 * math.pi * freq * tt)
        out.append(v * gain)
    return out


# ---------------------------------------------------------------------------
# Everything below obeys one hardware rule: nothing meaningful below about
# 220 Hz. Spectacles' speakers cannot move air down there and distort trying,
# which is heard as a rattle rather than as bass. See ambient_deep above for
# what that cost the first time.
# ---------------------------------------------------------------------------


def chime_rare():
    '''
    The gold Lumen. The common chime is two notes; this is three, climbing, and
    it rings roughly twice as long. It has to be recognisable as 'better' in
    the half second before you look at what you caught.
    '''
    return bell([
        (987.8,  0.46, 4.0, 0.00),   # B5
        (1480.0, 0.28, 5.0, 0.00),
        (1975.5, 0.16, 6.5, 0.00),
        (1318.5, 0.42, 3.6, 0.09),   # E6, the step up
        (1975.5, 0.24, 4.6, 0.09),
        (1567.9, 0.40, 3.0, 0.20),   # G6, the third and highest note
        (2349.3, 0.20, 4.0, 0.20),
        (3135.9, 0.09, 6.0, 0.20),
    ], dur=1.6)


def chime_super():
    '''
    The Abyssal, seen perhaps once a round. A five note arpeggio with a slow
    shimmer over it: longer and more ceremonial than anything else in the game,
    because the whole point of the creature is the moment it appears.
    '''
    notes = [
        # (freq, start) - a rising minor arpeggio, deliberately not the major
        # shape the rare chime uses, so the two are never confused
        (880.0,  0.00),
        (1046.5, 0.10),
        (1318.5, 0.20),
        (1760.0, 0.30),
        (2093.0, 0.42),
    ]
    partials = []
    for freq, start in notes:
        partials.append((freq, 0.36, 2.6, start))
        partials.append((freq * 1.5, 0.16, 3.4, start))
        partials.append((freq * 2.0, 0.08, 4.6, start))
    # A long high shimmer under the tail, which is what makes it feel rare
    # rather than merely loud.
    partials.append((2637.0, 0.06, 1.4, 0.42))
    partials.append((3520.0, 0.04, 1.6, 0.50))
    return bell(partials, dur=2.4, gain=0.5)


def miss_whiff():
    '''
    A swing through empty water.

    Deliberately not noise. An earlier ambient bed built from a broad spectrum
    was described as white noise coming from the PC, and a miss fires far more
    often than a catch does, so anything harsh here would be unbearable within
    a minute. This is a short downward chirp instead: soft, dry, and over in
    under a fifth of a second.
    '''
    dur = 0.18
    n = int(RATE * dur)
    out = []
    f0, f1 = 430.0, 250.0
    phase = 0.0
    for i in range(n):
        t = i / RATE
        p = t / dur
        freq = f0 + (f1 - f0) * p
        phase += 2 * math.pi * freq / RATE
        # Fast in, slow out, and quiet throughout: it should read as absence.
        env = math.exp(-7.0 * t)
        if t < 0.006:
            env *= t / 0.006
        out.append(0.22 * env * math.sin(phase))
    return out


def count_beep():
    '''One tick of the 3-2-1. Short, clean, unmistakably a countdown.'''
    return bell([
        (659.3, 0.55, 9.0, 0.0),     # E5
        (1318.5, 0.18, 12.0, 0.0),
    ], dur=0.22, gain=0.6)


def count_go():
    '''GO. The same voice as the ticks, an octave up and held longer.'''
    return bell([
        (880.0,  0.52, 4.2, 0.00),
        (1318.5, 0.34, 5.0, 0.00),
        (1760.0, 0.22, 6.0, 0.00),
        (2637.0, 0.10, 8.0, 0.00),
    ], dur=0.75, gain=0.62)


def game_over():
    '''
    Time up. A falling figure, the exact inverse of the rare chime's climb, so
    the end of a round sounds like the opposite of a good catch. Ends on a held
    low note with a long tail rather than a hard stop.
    '''
    return bell([
        (784.0, 0.44, 3.2, 0.00),    # G5
        (1176.0, 0.20, 4.0, 0.00),
        (587.3, 0.44, 2.8, 0.22),    # D5
        (880.0, 0.20, 3.6, 0.22),
        (392.0, 0.50, 1.6, 0.46),    # G4, the landing, still well above 110 Hz
        (587.3, 0.26, 2.0, 0.46),
        (784.0, 0.12, 2.6, 0.46),
    ], dur=2.2, gain=0.55)


def main():
    if not os.path.isdir(OUT):
        print('cannot find', OUT, '- run this from the repo root')
        return 1
    print('Writing audio into %s' % OUT)
    write_wav('CaptureChime.wav', capture_chime())
    write_wav('AmbientDeep.wav', ambient_deep())
    # Per kind catch chimes, so what you caught is audible before it is read.
    write_wav('ChimeRare.wav', chime_rare())
    write_wav('ChimeSuper.wav', chime_super())
    # Round and feedback sounds.
    write_wav('MissWhiff.wav', miss_whiff())
    write_wav('CountBeep.wav', count_beep())
    write_wav('CountGoSfx.wav', count_go())
    write_wav('GameOver.wav', game_over())
    print('Done. Lens Studio should import them automatically.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
