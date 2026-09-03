#!/usr/bin/env python3
'''
Tests for the Neon-Net AI models. Runs on a laptop, no hardware needed.

    python3 test_neon_ai.py

Feeds synthetic IMU traces shaped like real swings and checks the predictor
fires early with a sane forecast, then drives the difficulty model with
scripted play and checks it moves the right way.
'''

import math
import sys

from neon_ai import AdaptiveDifficulty, TrajectoryPredictor

SAMPLE_HZ = 200.0          # matches the sketch's ~200 Hz loop
DT = 1.0 / SAMPLE_HZ

failures = []


def check(label, condition, detail=''):
    if condition:
        print('  PASS  %s' % label)
    else:
        print('  FAIL  %s %s' % (label, detail))
        failures.append(label)


def swing_trace(peak_g=3.0, rise_s=0.18, start_t=0.0, rest_g=1.0):
    '''
    A swing as a raised cosine: rest, accelerate to a peak, fall back to rest.
    Shape matters more than realism here, since the predictor only cares about
    slope and curvature.
    '''
    samples = []
    total = rise_s * 2.0
    n = int(total / DT)
    for i in range(n):
        t = start_t + i * DT
        phase = (i * DT) / total
        bump = 0.5 * (1.0 - math.cos(2.0 * math.pi * phase))
        samples.append((t, rest_g + (peak_g - rest_g) * bump))
    return samples


def idle_trace(seconds, start_t=0.0, rest_g=1.0):
    return [(start_t + i * DT, rest_g)
            for i in range(int(seconds / DT))]


print('=== TrajectoryPredictor ===')

# --- fires once, early, with a sensible forecast ---
pred = TrajectoryPredictor(horizon_ms=100.0)
trace = swing_trace(peak_g=3.0, rise_s=0.18)
true_peak_t = trace[len(trace) // 2][0]
true_peak_g = max(m for _, m in trace)

fired = []
for t, mag in trace:
    p = pred.update(t, mag)
    if p:
        fired.append((t, p))

check('fires exactly once per swing', len(fired) == 1,
      '(fired %d times)' % len(fired))

if fired:
    fire_t, p = fired[0]
    lead_ms = (true_peak_t - fire_t) * 1000.0
    check('fires before the peak', fire_t < true_peak_t,
          '(fired at %.3fs, peak at %.3fs)' % (fire_t, true_peak_t))
    check('lead time is inside the 100 ms horizon',
          0 < lead_ms <= 100.0, '(lead %.1f ms)' % lead_ms)
    check('eta roughly matches the real lead',
          abs(p.eta_ms - lead_ms) < 45.0,
          '(eta %.1f ms vs actual %.1f ms)' % (p.eta_ms, lead_ms))
    check('predicted peak is in the right region',
          abs(p.predicted_peak - true_peak_g) < 1.2,
          '(predicted %.2f g vs actual %.2f g)' % (p.predicted_peak, true_peak_g))
    check('confidence is a sane 0..1', 0.0 <= p.confidence <= 1.0,
          '(%.2f)' % p.confidence)
    print('        -> %r, real lead %.1f ms, real peak %.2f g'
          % (p, lead_ms, true_peak_g))

# --- does not fire on a still net ---
pred2 = TrajectoryPredictor()
quiet = [pred2.update(t, m) for t, m in idle_trace(1.0)]
check('silent when the net is still', not any(quiet))

# --- real measured walking must not trigger a swing ---
# Profile taken from the actual net IMU while walking about holding it:
# magnitude swings between 0.65 and 1.08 g at roughly a 2 Hz stride, which
# works out at about 2.7 g/s of slope. This is the trace that matters, since
# a false swing while walking to your mark ruins a take.
pred3 = TrajectoryPredictor()
walk = []
for i in range(1200):
    t = i * DT
    mag = 0.865 + 0.215 * math.sin(2.0 * math.pi * 2.0 * t)
    walk.append(pred3.update(t, mag))
check('ignores real measured walking (0.65-1.08 g)', not any(walk),
      '(fired %d times)' % sum(1 for w in walk if w))

# --- and a brisk, jostling carry, worst case ---
pred3b = TrajectoryPredictor()
jostle = []
for i in range(1200):
    t = i * DT
    mag = (0.9
           + 0.3 * math.sin(2.0 * math.pi * 2.5 * t)
           + 0.15 * math.sin(2.0 * math.pi * 6.0 * t))
    jostle.append(pred3b.update(t, mag))
check('ignores brisk jostling carry', not any(jostle),
      '(fired %d times)' % sum(1 for j in jostle if j))

# --- re-arms so a second swing is also caught ---
pred4 = TrajectoryPredictor()
count = 0
t0 = 0.0
for swing in range(3):
    for t, mag in swing_trace(peak_g=2.8, rise_s=0.18, start_t=t0):
        if pred4.update(t, mag):
            count += 1
    t0 += 0.36
    for t, mag in idle_trace(0.3, start_t=t0):
        pred4.update(t, mag)
    t0 += 0.3
check('re-arms between swings', count == 3, '(caught %d of 3)' % count)

# --- the real measured swing: rest 0.87 g, peak 5.5 g ---
# These are the numbers the actual net produced, so this is the case that
# decides whether the predictor works in the video.
pred_real = TrajectoryPredictor()
real_trace = swing_trace(peak_g=5.5, rise_s=0.15, rest_g=0.87)
real_peak_t = real_trace[len(real_trace) // 2][0]
real_fired = []
for t, mag in real_trace:
    p = pred_real.update(t, mag)
    if p:
        real_fired.append((t, p))

check('fires on the real measured 5.5 g swing', len(real_fired) == 1,
      '(fired %d times)' % len(real_fired))
if real_fired:
    ft, rp = real_fired[0]
    real_lead = (real_peak_t - ft) * 1000.0
    check('real swing gives useful warning time', real_lead > 20.0,
          '(lead %.1f ms)' % real_lead)
    check('real swing scores decent confidence', rp.confidence >= 0.5,
          '(%.2f)' % rp.confidence)
    print('        -> %r, real lead %.1f ms' % (rp, real_lead))

# --- a harder, faster swing should still be caught ---
pred5 = TrajectoryPredictor()
hard = [p for t, m in swing_trace(peak_g=5.0, rise_s=0.10)
        for p in [pred5.update(t, m)] if p]
check('catches a fast hard swing', len(hard) == 1,
      '(fired %d times)' % len(hard))


print()
print('=== AdaptiveDifficulty ===')

# --- a player who never misses should drive difficulty up ---
dda = AdaptiveDifficulty(start=0.35)
start_level = dda.level()
for _ in range(20):
    dda.record_result(True)
check('skilled play raises difficulty', dda.level() > start_level,
      '(%.2f -> %.2f)' % (start_level, dda.level()))
check('difficulty is capped at 1.0', dda.level() <= 1.0,
      '(%.2f)' % dda.level())
check('cloaking switches on when hard', dda.params()['cloaking'] is True)

# --- a player who never lands one should drive it down ---
dda2 = AdaptiveDifficulty(start=0.8)
start2 = dda2.level()
for _ in range(20):
    dda2.record_result(False)
check('struggling play lowers difficulty', dda2.level() < start2,
      '(%.2f -> %.2f)' % (start2, dda2.level()))
check('difficulty is floored at 0.0', dda2.level() >= 0.0,
      '(%.2f)' % dda2.level())
check('cloaking switches off when easy',
      dda2.params()['cloaking'] is False)

# --- play at the target rate should hold roughly steady ---
dda3 = AdaptiveDifficulty(start=0.5, target_ratio=0.5, dead_band=0.15)
held = dda3.level()
pattern = [True, False] * 15
for hit in pattern:
    dda3.record_result(hit)
check('play at the target rate stays stable',
      abs(dda3.level() - held) < 0.25,
      '(%.2f -> %.2f)' % (held, dda3.level()))

# --- it should not lurch on the very first swing ---
dda4 = AdaptiveDifficulty(start=0.4, min_samples=4)
before = dda4.level()
dda4.record_result(True)
check('waits for enough samples before reacting',
      dda4.level() == before, '(%.2f -> %.2f)' % (before, dda4.level()))

# --- params must be well formed for the Lens ---
p = AdaptiveDifficulty(start=0.5).params()
required = ['type', 'level', 'catchRatio', 'speedMult', 'evasionMult',
            'alertMult', 'cloaking', 'skittishBias']
check('params carry every field the Lens expects',
      all(k in p for k in required),
      '(missing %s)' % [k for k in required if k not in p])
check('multipliers never fall below 1.0',
      p['speedMult'] >= 1.0 and p['evasionMult'] >= 1.0
      and p['alertMult'] >= 1.0)
print('        -> %s' % p)

print()
if failures:
    print('RESULT: %d FAILURE(S): %s' % (len(failures), ', '.join(failures)))
    sys.exit(1)
print('RESULT: ALL PASS')
