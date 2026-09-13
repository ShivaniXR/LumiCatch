# Neon-Net - the shared shoal
# ---------------------------
# Runs on the Arduino UNO Q's Qualcomm Linux side. This is the authoritative
# simulation of the jellyfish: where every creature is, what it is doing, and
# who caught it.
#
# WHY THIS EXISTS ON THE BOARD
#
# Until now each pair of Spectacles simulated its own shoal. That is fine for
# one player and meaningless for two: both would swing at creatures the other
# could not see. For a shared shoal somebody has to be the authority, and the
# UNO Q is the only thing both headsets already talk to.
#
# It also puts the board where the hackathon wants it. The Qualcomm side is no
# longer a sensor with some AI attached, it is the game server: it owns the
# world, runs the creature behaviour, and settles who caught what.
#
# Deliberately free of any Arduino or hardware imports, so it runs and is
# tested on a laptop and then drops onto the board unchanged, exactly like
# neon_ai.py.
#
# COORDINATES
#
# Everything is centimetres in a shared room frame: origin at the middle of the
# play space, +Y up. Each Lens anchors this frame to its own room origin when
# the round begins. Two headsets that start from roughly the same spot, facing
# the same way, then agree about where the creatures are. That is approximate
# colocation, not the real thing: proper shared anchors need Connected Lenses.
# What is exact here is the STATE - the same creatures, the same ids, and one
# ruling on who caught which.

import math
import random

# Creature kinds. These numbers are part of the protocol: the Lens uses the
# same ones, so they may not be reordered without changing both sides.
KIND_DRIFTER = 0
KIND_SKITTISH = 1
KIND_LUMEN = 2
KIND_ABYSSAL = 3

POINTS = {KIND_DRIFTER: 1, KIND_SKITTISH: 1, KIND_LUMEN: 3, KIND_ABYSSAL: 8}

# Behaviour states, also shared with the Lens.
ST_DRIFT = 0
ST_ALERT = 1
ST_FLEE = 2
ST_RETURN = 3

# Shoal mood.
MOOD_CALM = 0
MOOD_SPOOKED = 1
MOOD_CURIOUS = 2


class Creature:
    """One jellyfish. Plain data plus the timers its behaviour needs."""

    __slots__ = ('id', 'kind', 'x', 'y', 'z', 'hx', 'hy', 'hz',
                 'state', 'state_t', 'seed', 'school',
                 'fx', 'fy', 'fz')

    def __init__(self, cid, kind, pos, home, school, seed):
        self.id = cid
        self.kind = kind
        self.x, self.y, self.z = pos
        self.hx, self.hy, self.hz = home
        self.state = ST_DRIFT
        self.state_t = 0.0
        self.seed = seed
        self.school = school
        self.fx, self.fy, self.fz = pos        # where it is fleeing to

    def as_dict(self):
        # Short keys on purpose. This goes out fourteen times per packet at
        # 15 Hz, and the board is talking over a phone hotspot.
        return {
            'i': self.id,
            'k': self.kind,
            'x': round(self.x, 1),
            'y': round(self.y, 1),
            'z': round(self.z, 1),
            's': self.state,
        }


class Shoal:
    """
    The authoritative shoal.

    Feed it player poses and a time step; read back a snapshot to broadcast.
    Catches are claims: a Lens says 'I hit number 7' and this decides whether
    it did, which is what stops two players both scoring the same creature.
    """

    def __init__(self,
                 count=14,
                 radius_cm=170.0,
                 floor_cm=60.0,
                 ceiling_cm=90.0,
                 alert_cm=55.0,
                 flee_cm=70.0,
                 flee_speed_cm=130.0,
                 drift_cm=22.0,
                 schools=2,
                 rare_chance=0.22,
                 skittish_chance=0.35,
                 super_rare_chance=0.05,
                 seed=None):
        self.count = int(count)
        self.radius_cm = float(radius_cm)
        self.floor_cm = float(floor_cm)
        self.ceiling_cm = float(ceiling_cm)
        self.alert_cm = float(alert_cm)
        self.flee_cm = float(flee_cm)
        self.flee_speed_cm = float(flee_speed_cm)
        self.drift_cm = float(drift_cm)
        self.schools = max(1, int(schools))
        self.rare_chance = float(rare_chance)
        self.skittish_chance = float(skittish_chance)
        self.super_rare_chance = float(super_rare_chance)

        self.rng = random.Random(seed)
        self.t = 0.0
        self.next_id = 1
        self.creatures = {}
        self.players = {}          # pid -> {'pos':(x,y,z), 'fwd':(x,y,z)}
        self.mood = MOOD_CALM
        self.mood_until = 0.0

        # Difficulty, as handed down by AdaptiveDifficulty.
        self.speed_mult = 1.0
        self.alert_mult = 1.0
        self.evasion_mult = 1.0

        self._recent_catches = []
        self._school_centres = [self._ring_point(i * 2.0)
                                for i in range(self.schools)]

        for _ in range(self.count):
            self._spawn()

    # ---------------------------------------------------------------- setup

    def _ring_point(self, bias=0.0):
        a = self.rng.uniform(0, math.tau) + bias
        r = self.rng.uniform(0.45, 1.0) * self.radius_cm
        y = self.rng.uniform(-self.floor_cm * 0.4, self.ceiling_cm * 0.6)
        return (math.cos(a) * r, y, math.sin(a) * r)

    def _pick_kind(self):
        r = self.rng.random()
        if r < self.super_rare_chance:
            return KIND_ABYSSAL
        r = self.rng.random()
        if r < self.rare_chance:
            return KIND_LUMEN
        if r < self.rare_chance + self.skittish_chance:
            return KIND_SKITTISH
        return KIND_DRIFTER

    def _spawn(self, kind=None):
        cid = self.next_id
        self.next_id += 1
        school = len(self.creatures) % self.schools
        home = self._ring_point()
        c = Creature(
            cid,
            self._pick_kind() if kind is None else kind,
            home, home, school,
            self.rng.uniform(0, 100),
        )
        self.creatures[cid] = c
        return c

    # --------------------------------------------------------------- inputs

    def add_player(self, pid):
        self.players[pid] = {'pos': (0.0, 0.0, 0.0), 'fwd': (0.0, 0.0, -1.0)}

    def remove_player(self, pid):
        self.players.pop(pid, None)

    def set_pose(self, pid, pos, fwd):
        if pid in self.players:
            self.players[pid]['pos'] = tuple(float(v) for v in pos)
            self.players[pid]['fwd'] = tuple(float(v) for v in fwd)

    def set_difficulty(self, params):
        """Take the multipliers AdaptiveDifficulty produces."""
        self.speed_mult = float(params.get('speedMult', 1.0))
        self.alert_mult = float(params.get('alertMult', 1.0))
        self.evasion_mult = float(params.get('evasionMult', 1.0))

    # ---------------------------------------------------------------- claim

    def claim(self, pid, cid):
        """
        A player says they caught creature `cid`.

        Returns (granted, kind, points). The first claim on a creature wins and
        every later one is refused, which is the whole reason this lives on the
        board: two players lunging at the same jellyfish cannot both score it.

        A creature that has already noticed the player is not catchable, the
        same rule the single player game uses.
        """
        c = self.creatures.get(cid)
        if c is None:
            return (False, None, 0)
        if c.state in (ST_ALERT, ST_FLEE):
            return (False, None, 0)

        kind = c.kind
        del self.creatures[cid]
        self._recent_catches.append(self.t)
        self._spawn()                      # keep the shoal at strength
        return (True, kind, POINTS.get(kind, 1))

    def record_miss(self, pid):
        """A swing that hit nothing. Used only to steer the mood."""
        self._curious_check()

    # ----------------------------------------------------------------- mood

    def _curious_check(self):
        if self.t >= self.mood_until:
            self.mood = MOOD_CURIOUS
            self.mood_until = self.t + 8.0

    def _spook_check(self):
        cutoff = self.t - 8.0
        self._recent_catches = [x for x in self._recent_catches if x >= cutoff]
        if len(self._recent_catches) >= 3:
            self._recent_catches = []
            self.mood = MOOD_SPOOKED
            self.mood_until = self.t + 6.0

    # ---------------------------------------------------------------- update

    def _nearest_player(self, c):
        best = None
        best_d = 1e9
        for p in self.players.values():
            px, py, pz = p['pos']
            d = math.sqrt((c.x - px) ** 2 + (c.y - py) ** 2 + (c.z - pz) ** 2)
            if d < best_d:
                best_d = d
                best = p
        return best, best_d

    def update(self, dt):
        dt = max(0.0, min(0.2, float(dt)))     # a stall must not teleport them
        self.t += dt
        self._spook_check()
        if self.mood != MOOD_CALM and self.t >= self.mood_until:
            self.mood = MOOD_CALM

        # Schools drift slowly, and pull tight when the shoal is spooked.
        cohesion = 0.55 if self.mood == MOOD_SPOOKED else (
            0.0 if self.mood == MOOD_CURIOUS else 0.22)

        for c in list(self.creatures.values()):
            c.state_t += dt
            player, dist = self._nearest_player(c)

            if c.state == ST_DRIFT:
                # Wander around home, with a slow bob. Deterministic in the
                # creature's own seed so it does not jitter between packets.
                wob = math.sin(self.t * 0.7 + c.seed) * self.drift_cm
                bob = math.sin(self.t * 1.1 + c.seed * 1.7) * self.drift_cm * 0.4
                tx = c.hx + wob
                ty = c.hy + bob
                tz = c.hz + math.cos(self.t * 0.6 + c.seed) * self.drift_cm

                if cohesion > 0:
                    sx, sy, sz = self._school_centres[c.school]
                    tx += (sx - tx) * cohesion
                    ty += (sy - ty) * cohesion
                    tz += (sz - tz) * cohesion

                k = min(1.0, dt * 1.2)
                c.x += (tx - c.x) * k
                c.y += (ty - c.y) * k
                c.z += (tz - c.z) * k

                if player is not None and dist < self.alert_cm * self.alert_mult:
                    c.state = ST_ALERT
                    c.state_t = 0.0

            elif c.state == ST_ALERT:
                # Hold still for a beat, so the dodge reads as a decision
                # rather than as a glitch.
                if c.state_t >= 0.18:
                    c.fx, c.fy, c.fz = self._flee_target(c, player)
                    c.state = ST_FLEE
                    c.state_t = 0.0

            elif c.state == ST_FLEE:
                step = self.flee_speed_cm * self.speed_mult * dt
                c.x, c.y, c.z = self._step_towards(
                    (c.x, c.y, c.z), (c.fx, c.fy, c.fz), step)
                reached = (abs(c.x - c.fx) + abs(c.y - c.fy)
                           + abs(c.z - c.fz)) < 8.0
                if reached or c.state_t > 1.2:
                    c.hx, c.hy, c.hz = self._ring_point()
                    c.state = ST_RETURN
                    c.state_t = 0.0

            elif c.state == ST_RETURN:
                k = min(1.0, dt * 0.9)
                c.x += (c.hx - c.x) * k
                c.y += (c.hy - c.y) * k
                c.z += (c.hz - c.z) * k
                if c.state_t > 1.4:
                    c.state = ST_DRIFT
                    c.state_t = 0.0

            self._clamp(c)

    def _flee_target(self, c, player):
        if player is None:
            return (c.x, c.y, c.z)
        px, py, pz = player['pos']
        dx, dy, dz = c.x - px, c.y - py, c.z - pz
        n = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
        reach = self.flee_cm * self.evasion_mult
        return (c.x + dx / n * reach,
                c.y + dy / n * reach * 0.35,
                c.z + dz / n * reach)

    @staticmethod
    def _step_towards(a, b, max_step):
        dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        d = math.sqrt(dx * dx + dy * dy + dz * dz)
        if d <= max_step or d < 1e-4:
            return b
        f = max_step / d
        return (a[0] + dx * f, a[1] + dy * f, a[2] + dz * f)

    def _clamp(self, c):
        """Keep the shoal inside the play volume."""
        r = math.sqrt(c.x * c.x + c.z * c.z)
        if r > self.radius_cm:
            f = self.radius_cm / r
            c.x *= f
            c.z *= f
        if c.y > self.ceiling_cm:
            c.y = self.ceiling_cm
        if c.y < -self.floor_cm:
            c.y = -self.floor_cm

    # -------------------------------------------------------------- outputs

    def snapshot(self):
        return {
            'type': 'shoal',
            't': round(self.t, 2),
            'mood': self.mood,
            'c': [c.as_dict() for c in self.creatures.values()],
        }
