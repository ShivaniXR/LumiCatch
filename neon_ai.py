# Neon-Net AI - the Kinetic Engine's two models
# ----------------------------------------------
# Runs on the Arduino UNO Q's Qualcomm Linux side, inside App Lab.
#
# Deliberately free of any Arduino or hardware imports, so the whole thing can
# be run and tested on a laptop and then dropped onto the board unchanged.
# main.py feeds it IMU samples and catch results, and reads back predictions
# and difficulty parameters.
#
#   1. TrajectoryPredictor - predicts a swing's peak before it happens, so the
#      Spectacles can be told a catch is coming while the net is still moving.
#      This is what hides the network round trip.
#
#   2. AdaptiveDifficulty - watches the catch-to-swing ratio over a sliding
#      window and moves a single difficulty value, which the Lens turns into
#      creature speed, evasion and cloaking.
#
# Both are heuristic models by design. They are cheap enough to run inside the
# 30 Hz poll loop and, unlike a trained network, their behaviour is inspectable
# and repeatable, which matters when the whole thing has to survive being
# filmed in one take.

from collections import deque

# ---------------------------------------------------------------- prediction

DEFAULT_HORIZON_MS = 100.0


class Prediction:
    '''A forecast that a swing will peak shortly.'''

    def __init__(self, eta_ms, predicted_peak, confidence):
        self.eta_ms = eta_ms
        self.predicted_peak = predicted_peak
        self.confidence = confidence

    def as_dict(self):
        return {
            'etaMs': round(self.eta_ms, 1),
            'predictedPeak': round(self.predicted_peak, 2),
            'confidence': round(self.confidence, 2)
        }

    def __repr__(self):
        return ('Prediction(eta_ms=%.1f, peak=%.2f, conf=%.2f)'
                % (self.eta_ms, self.predicted_peak, self.confidence))


class TrajectoryPredictor:
    '''
    Watches acceleration magnitude and extrapolates forward to find the peak.

    The model fits a parabola through three smoothed points and solves for its
    vertex, which is the peak of the swing. If that vertex lands inside the
    horizon, the swing is announced early along with the peak value it is
    heading for.

    A parabola rather than plain Newtonian extrapolation on purpose: a swing
    decelerates harder the closer it gets to its peak, so projecting the
    current slope forward at constant acceleration lands the peak roughly twice
    as far ahead as it really is. Fitting the curve through three points picks
    the turning point up directly.

    One prediction per swing. It re-arms once the motion has died back down,
    so a single swing cannot fire a burst of forecasts.
    '''

    def __init__(self,
                 horizon_ms=DEFAULT_HORIZON_MS,
                 arm_threshold_g=1.35,
                 rearm_threshold_g=1.15,
                 min_slope=2.0,
                 smoothing=3):
        self.horizon_ms = float(horizon_ms)
        self.arm_threshold_g = float(arm_threshold_g)
        self.rearm_threshold_g = float(rearm_threshold_g)
        self.min_slope = float(min_slope)
        self.smoothing = max(1, int(smoothing))

        self._samples = deque(maxlen=16)   # (t_seconds, magnitude_g)
        self._armed = True
        self.last_prediction = None

    def reset(self):
        self._samples.clear()
        self._armed = True
        self.last_prediction = None

    def _smoothed(self, index_from_end):
        '''Mean of the last `smoothing` samples ending at the given offset.'''
        end = len(self._samples) - index_from_end
        start = max(0, end - self.smoothing)
        window = list(self._samples)[start:end]
        if not window:
            return None
        t = sum(s[0] for s in window) / len(window)
        mag = sum(s[1] for s in window) / len(window)
        return t, mag

    def update(self, t_seconds, magnitude_g):
        '''
        Feed one IMU sample. Returns a Prediction the moment a peak is
        forecast inside the horizon, otherwise None.
        '''
        self._samples.append((float(t_seconds), float(magnitude_g)))

        # Re-arm once the net has settled, ready for the next swing.
        if not self._armed and magnitude_g < self.rearm_threshold_g:
            self._armed = True
            return None

        if not self._armed:
            return None
        if magnitude_g < self.arm_threshold_g:
            return None
        if len(self._samples) < self.smoothing * 3:
            return None

        # Three smoothed points, evenly spaced back through the buffer.
        p2 = self._smoothed(0)
        p1 = self._smoothed(self.smoothing)
        p0 = self._smoothed(self.smoothing * 2)
        if p0 is None or p1 is None or p2 is None:
            return None

        t0, m0 = p0
        t1, m1 = p1
        t2, m2 = p2

        dt1 = t2 - t1
        dt0 = t1 - t0
        if dt1 <= 1e-6 or dt0 <= 1e-6:
            return None

        # Divided differences give the parabola through the three points.
        f01 = (m1 - m0) / dt0
        f12 = (m2 - m1) / dt1
        curvature = (f12 - f01) / (t2 - t0)      # the quadratic coefficient

        # Must be rising, and curving over. That combination has a peak ahead.
        v_now = f12
        if v_now <= self.min_slope or curvature >= -1e-9:
            return None

        # Vertex of the parabola, in Newton form.
        t_peak = 0.5 * (t0 + t1) - f01 / (2.0 * curvature)

        eta_s = t_peak - t2
        eta_ms = eta_s * 1000.0
        if eta_ms <= 0 or eta_ms > self.horizon_ms:
            return None

        predicted_peak = (m0
                          + f01 * (t_peak - t0)
                          + curvature * (t_peak - t0) * (t_peak - t1))

        # Confidence falls off as the forecast reaches further ahead, and rises
        # with how decisively the swing is accelerating.
        reach = 1.0 - (eta_ms / self.horizon_ms)
        vigour = min(1.0, v_now / (self.min_slope * 4.0))
        confidence = max(0.0, min(1.0, 0.45 * reach + 0.55 * vigour))

        self._armed = False
        self.last_prediction = Prediction(eta_ms, predicted_peak, confidence)
        return self.last_prediction


# ---------------------------------------------------------------- difficulty

class AdaptiveDifficulty:
    '''
    Keeps the player near a target catch rate.

    Every swing produces a hit or a miss. Over a sliding window the ratio is
    compared against target_ratio, and a single difficulty value between 0 and
    1 moves to close the gap. Too easy and it climbs, too hard and it drops.

    The Lens receives derived parameters rather than the raw number, so all the
    balancing lives here on the board and the Lens simply obeys.
    '''

    def __init__(self,
                 window=10,
                 target_ratio=0.55,
                 dead_band=0.12,
                 step=0.1,
                 start=0.35,
                 min_samples=4):
        self.window = int(window)
        self.target_ratio = float(target_ratio)
        self.dead_band = float(dead_band)
        self.step = float(step)
        self.min_samples = int(min_samples)

        self._outcomes = deque(maxlen=self.window)
        self._difficulty = max(0.0, min(1.0, float(start)))
        self.swings = 0
        self.hits = 0

    # -- inputs --

    def record_result(self, hit):
        '''Record the outcome of one swing, then re-balance.'''
        self._outcomes.append(bool(hit))
        self.swings += 1
        if hit:
            self.hits += 1
        self._rebalance()

    def _rebalance(self):
        if len(self._outcomes) < self.min_samples:
            return
        ratio = self.catch_ratio()
        if ratio > self.target_ratio + self.dead_band:
            self._difficulty = min(1.0, self._difficulty + self.step)
        elif ratio < self.target_ratio - self.dead_band:
            self._difficulty = max(0.0, self._difficulty - self.step)

    # -- outputs --

    def catch_ratio(self):
        if not self._outcomes:
            return 0.0
        return sum(1 for o in self._outcomes if o) / float(len(self._outcomes))

    def level(self):
        return self._difficulty

    def params(self):
        '''
        The message the Lens acts on. Everything is a multiplier so the Lens
        keeps its own tuned baselines and simply scales them.
        '''
        d = self._difficulty
        return {
            'type': 'difficulty',
            'level': round(d, 3),
            'catchRatio': round(self.catch_ratio(), 3),
            'speedMult': round(1.0 + d * 0.8, 3),      # drift and flee speed
            'evasionMult': round(1.0 + d * 1.2, 3),    # how far they dodge
            'alertMult': round(1.0 + d * 0.9, 3),      # how early they notice
            'cloaking': d > 0.65,                      # rare ones fade out
            'skittishBias': round(min(0.8, 0.35 + d * 0.45), 3)
        }
