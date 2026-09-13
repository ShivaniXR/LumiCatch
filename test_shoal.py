#!/usr/bin/env python3
'''
Tests for the shared shoal. Runs on a laptop, no hardware needed.

    python3 test_shoal.py

The point of these is the multiplayer rules. A shared shoal is only worth
having if two players cannot both score the same creature, if a creature that
has spotted you is genuinely out of reach, and if the whole thing stays inside
the room while nobody is looking.
'''

import math
import sys

from shoal import (Shoal, KIND_ABYSSAL, KIND_DRIFTER, KIND_LUMEN,
                   ST_ALERT, ST_DRIFT, ST_FLEE, MOOD_SPOOKED, POINTS)

failures = []


def check(label, condition, detail=''):
    if condition:
        print('  PASS  %s' % label)
    else:
        print('  FAIL  %s %s' % (label, detail))
        failures.append(label)


print('=== shoal basics ===')

s = Shoal(count=14, seed=7)
check('spawns the requested number', len(s.creatures) == 14,
      '(got %d)' % len(s.creatures))
check('every creature has a unique id',
      len({c.id for c in s.creatures.values()}) == 14)

ids = sorted(c.id for c in s.creatures.values())
snap = s.snapshot()
check('snapshot carries every creature', len(snap['c']) == 14)
check('snapshot ids match the shoal',
      sorted(e['i'] for e in snap['c']) == ids)
check('snapshot keys are the short protocol form',
      set(snap['c'][0].keys()) == {'i', 'k', 'x', 'y', 'z', 's'},
      '(got %s)' % sorted(snap['c'][0].keys()))


print()
print('=== the rule that makes multiplayer work ===')

s2 = Shoal(count=6, seed=11)
s2.add_player('a')
s2.add_player('b')
# Pick a creature that is calm and therefore catchable.
target = next(c.id for c in s2.creatures.values() if c.state == ST_DRIFT)

ok_a, kind_a, pts_a = s2.claim('a', target)
ok_b, kind_b, pts_b = s2.claim('b', target)
check('the first claim is granted', ok_a is True)
check('the second claim on the same creature is refused', ok_b is False,
      '(player b also got it)')
check('a refused claim scores nothing', pts_b == 0)
check('the winner is told what they caught', kind_a is not None)
check('points match the kind', pts_a == POINTS[kind_a],
      '(%d for kind %s)' % (pts_a, kind_a))
check('the caught creature has left the shoal', target not in s2.creatures)
check('the shoal stays at strength', len(s2.creatures) == 6,
      '(got %d)' % len(s2.creatures))

ok_c, _, _ = s2.claim('a', 99999)
check('claiming a creature that never existed is refused', ok_c is False)


print()
print('=== being seen is a real escape ===')

s3 = Shoal(count=4, seed=3)
s3.add_player('a')
victim = list(s3.creatures.values())[0]
victim.state = ST_ALERT
ok, _, _ = s3.claim('a', victim.id)
check('an alerted creature cannot be claimed', ok is False)
victim.state = ST_FLEE
ok, _, _ = s3.claim('a', victim.id)
check('a fleeing creature cannot be claimed', ok is False)
victim.state = ST_DRIFT
ok, _, _ = s3.claim('a', victim.id)
check('the same creature can be claimed once it settles', ok is True)


print()
print('=== a player in the room makes them run ===')

s4 = Shoal(count=10, seed=5)
s4.add_player('a')
# Stand on top of the shoal and let it run.
c0 = list(s4.creatures.values())[0]
s4.set_pose('a', (c0.x, c0.y, c0.z), (0, 0, -1))
for _ in range(40):
    s4.update(1 / 30.0)
states = [c.state for c in s4.creatures.values()]
check('somebody noticed the player',
      any(st != ST_DRIFT for st in states),
      '(all %d still drifting)' % len(states))

start = (c0.x, c0.y, c0.z)
for _ in range(60):
    s4.update(1 / 30.0)
moved = math.dist(start, (c0.x, c0.y, c0.z)) if c0.id in s4.creatures else 999
check('and moved away from where it was', moved > 1.0,
      '(moved %.1f cm)' % moved)


print()
print('=== the shoal stays in the room ===')

s5 = Shoal(count=14, radius_cm=170, floor_cm=60, ceiling_cm=90, seed=9)
s5.add_player('a')
for i in range(600):                       # 20 seconds at 30 Hz
    # Walk the player around, which is what drives creatures outward.
    a = i / 40.0
    s5.set_pose('a', (math.cos(a) * 80, 0, math.sin(a) * 80), (0, 0, -1))
    s5.update(1 / 30.0)

worst_r = max(math.sqrt(c.x ** 2 + c.z ** 2) for c in s5.creatures.values())
worst_hi = max(c.y for c in s5.creatures.values())
worst_lo = min(c.y for c in s5.creatures.values())
check('nothing escapes the radius', worst_r <= 170.5,
      '(furthest %.1f cm)' % worst_r)
check('nothing goes through the ceiling', worst_hi <= 90.5,
      '(highest %.1f cm)' % worst_hi)
check('nothing goes through the floor', worst_lo >= -60.5,
      '(lowest %.1f cm)' % worst_lo)
check('the shoal is still the right size', len(s5.creatures) == 14)


print()
print('=== a stalled board must not teleport the shoal ===')

s6 = Shoal(count=6, seed=13)
s6.add_player('a')
s6.set_pose('a', (0, 0, 0), (0, 0, -1))
before = [(c.x, c.y, c.z) for c in s6.creatures.values()]
s6.update(5.0)          # as if the process hung for five seconds
after = [(c.x, c.y, c.z) for c in s6.creatures.values()]
jump = max(math.dist(a, b) for a, b in zip(before, after))
check('a huge dt is clamped rather than applied', jump < 60.0,
      '(largest jump %.1f cm)' % jump)


print()
print('=== catching quickly spooks them ===')

s7 = Shoal(count=20, seed=17)
s7.add_player('a')
taken = 0
for c in list(s7.creatures.values()):
    if taken >= 3:
        break
    if c.state == ST_DRIFT:
        ok, _, _ = s7.claim('a', c.id)
        if ok:
            taken += 1
s7.update(1 / 30.0)
check('three quick catches spook the shoal', s7.mood == MOOD_SPOOKED,
      '(mood %d after %d catches)' % (s7.mood, taken))


print()
print('=== difficulty reaches the creatures ===')

s8 = Shoal(count=4, seed=19)
s8.set_difficulty({'speedMult': 1.8, 'alertMult': 1.9, 'evasionMult': 2.0})
check('speed multiplier taken', abs(s8.speed_mult - 1.8) < 1e-6)
check('alert multiplier taken', abs(s8.alert_mult - 1.9) < 1e-6)
check('evasion multiplier taken', abs(s8.evasion_mult - 2.0) < 1e-6)


print()
print('=== rare kinds appear, and are worth more ===')

s9 = Shoal(count=400, seed=23)
kinds = [c.kind for c in s9.creatures.values()]
check('the rare gold kind occurs', KIND_LUMEN in kinds)
check('the super rare kind occurs', KIND_ABYSSAL in kinds,
      '(none in 400)')
check('super rare outscores rare',
      POINTS[KIND_ABYSSAL] > POINTS[KIND_LUMEN] > POINTS[KIND_DRIFTER])
rare_share = kinds.count(KIND_ABYSSAL) / float(len(kinds))
check('super rare stays rare', rare_share < 0.12,
      '(%.1f%% of the shoal)' % (100 * rare_share))


print()
if failures:
    print('RESULT: %d FAILURE(S): %s' % (len(failures), ', '.join(failures)))
    sys.exit(1)
print('RESULT: ALL PASS')
