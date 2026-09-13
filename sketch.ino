/*
 * LumiCatch Net - MCU firmware (Arduino UNO Q, STM32 side)
 * ---------------------------------------------------------
 * - Reads MPU-6050 over I2C (the pins marked SDA / SCL) with raw
 *   register access, so no external library is required.
 * - Detects swings with an acceleration-magnitude threshold,
 *   captures the peak over a short window, then debounces.
 * - Exposes two RPC functions to the Linux side via the Bridge:
 *     get_event()          -> float peak g of latest swing (0 = none)
 *     play_haptic(pattern) -> plays a vibration pattern (non-blocking)
 * - Haptic motor on D9 (PWM) through an NPN transistor.
 *
 * Patterns:
 *   1 = short pulse   (creature nearby)
 *   2 = double pulse  (rare creature)
 *   3 = long buzz     (capture)
 *   4 = rapid triple  (combo capture)
 *
 * Printing: Arduino_RouterBridge.h replaces Serial with Monitor on this board.
 * Monitor.begin() is required, and the pause after it stops the first lines
 * being swallowed. Use Monitor.print, never Serial.print, or the App Lab
 * console stays empty and the sketch looks dead while running perfectly.
 */

#include <Wire.h>
#include "Arduino_RouterBridge.h"

// ---------- Pins ----------
const int MOTOR_PIN = D9;   // PWM-capable on UNO Q

// ---------- MPU-6050 registers ----------
// AD0 low or unconnected gives 0x68; AD0 pulled high gives 0x69. A jumper
// nudged onto a 3V3 line silently moves the whole module, and the symptom is
// identical to a dead sensor. So probe both and use whichever answers.
const uint8_t MPU_ADDR_LOW  = 0x68;
const uint8_t MPU_ADDR_HIGH = 0x69;
uint8_t mpuAddr = MPU_ADDR_LOW;
const uint8_t REG_WHO_AM_I  = 0x75;   // 0x68 on a real MPU-6050
const uint8_t REG_PWR_MGMT  = 0x6B;
const uint8_t REG_ACC_CFG   = 0x1C;
const uint8_t REG_ACC_XOUT  = 0x3B;
const float   LSB_PER_G     = 4096.0f;  // +/-8g range

// ---------- Swing detection tuning ----------
// Measured twice. On a bare breadboard, then again once mounted on the net,
// because mounting changed everything:
//
//                      bare board      mounted on the net
//   at rest            0.87 g          -
//   walking            0.65 to 1.08    2.0 to 3.0     <- three times higher
//   a real swing       5.50 peak       above 4.0
//
// Mass on a lever amplifies every footfall, so the walking figure tripled
// while the swing figure did not. That left only about 1 g of separation, and
// the old 2.2 threshold sat INSIDE the walking band: simply carrying the net
// registered as swinging.
//
// 3.5 sits between the two, with roughly 0.5 g of margin each way. If walking
// still triggers, raise it. If honest swings are missed, lower it. There is
// not much room, so change it in steps of 0.2.
// 3.5 -> 3.0 -> 2.6, each step after a real play test. Swings register at 3.0
// but not easily enough.
//
// 2.6 sits INSIDE the measured walking band, which is 2.0 to 3.0 g with the
// electronics mounted. That is a deliberate trade, not an oversight: the game
// is played standing roughly still and swinging, and a missed swing ruins a
// take far more surely than a spurious one. DEBOUNCE_MS still limits it to one
// trigger every 400 ms, so even a false positive cannot machine-gun.
//
// If simply carrying the net across the room starts scoring swings, this is
// the number, and 2.8 is the next step back up.
const float SWING_THRESHOLD_G = 2.6f;   // raise if false triggers, lower if misses

// Phase 3 aid: give a soft blip on every detected swing, so swing detection
// can be checked by feel when the console is not cooperating. It reuses the
// non-blocking haptic state machine, so it costs nothing.
// Set TRUE to debug swing detection by feel, FALSE for play and filming.
// While true every swing buzzes whether or not it caught anything, which
// muddles the haptic language: the buzz is supposed to mean CAUGHT.
const bool BUZZ_ON_SWING = false;
// PEAK_WINDOW_MS is the single largest source of felt lag in the whole game.
// Nothing is reported until the window closes, so it is added in full to every
// catch: threshold crossed, wait, report, send, render. It was 150 ms, which
// on its own was most of the delay between swinging and seeing anything.
//
// 80 ms still comfortably contains the peak of a real swing, which arrives
// within about 50 ms of the threshold crossing, while halving the wait. If
// sneak and lunge start being confused for each other the window is clipping
// the peak and this should go back up towards 120.
const unsigned long PEAK_WINDOW_MS = 80;
const unsigned long DEBOUNCE_MS    = 400;

// ---------- Shared state (volatile: touched from RPC thread) ----------
volatile float pendingPeak = 0.0f;      // latest swing peak, cleared on read
volatile int   requestedPattern = 0;    // set by play_haptic RPC

// ---------- IMU sample buffer, drained by the Linux side ----------
// The Qualcomm side runs the trajectory prediction, so it needs the raw
// magnitude stream rather than just finished swings. We buffer here at the
// full 200 Hz and hand over a batch on each poll (~30 Hz, so about 6 samples).
// Sized well above that so a late poll cannot lose data.
const int SAMPLE_BUF = 48;
volatile float sampleBuf[SAMPLE_BUF];
volatile int   sampleCount = 0;

// ---------- Sensor watchdog ----------
// A brief brownout, a jumper twitching mid-swing, resets the MPU-6050 into
// sleep mode. Asleep it still ACKs on I2C and just returns zeros, so the
// failure is completely silent. Gravity is always present, so a magnitude of
// essentially zero means the sensor died rather than the net being weightless.
int zeroRun = 0;
int sensorRecoveries = 0;

// ---------- Swing state machine ----------
enum SwingState { IDLE, PEAKING, COOLDOWN };
SwingState swingState = IDLE;
unsigned long swingTimer = 0;
float windowPeak = 0.0f;

// ---------- Haptic state machine ----------
// Each pattern is a list of {duration_ms, pwm} steps, 0 duration ends it.
struct Step { unsigned int ms; uint8_t pwm; };

// Designed around what this motor actually does, measured in Phase 2:
//
//   PWM floor 55   below this the rotor does not turn at all, so the usable
//                  range is 55 to 255 and intensity is a real dimension
//   coast-down     roughly 80 to 100 ms. Any gap shorter than that and the
//                  motor never stops, so separate taps smear into one buzz
//
// The first attempt used 50 and 80 ms gaps and two pairs were
// indistinguishable. Gaps are now 150 ms, comfortably past coast-down, and
// the four patterns differ by SHAPE rather than by counting taps:
//
//   nearby   a soft short blip, deliberately gentle, it fires most often
//   rare     two clean separated taps
//   capture  one long sustained buzz
//   combo    that same buzz, then two taps: capture, and then some
//
// If taps still blur, raise HAPTIC_GAP_MS to 200.
const unsigned int HAPTIC_GAP_MS = 150;

const Step PAT_SHORT[]  = { {70, 110}, {0, 0} };
const Step PAT_DOUBLE[] = { {70, 255}, {HAPTIC_GAP_MS, 0}, {70, 255}, {0, 0} };
const Step PAT_LONG[]   = { {420, 255}, {0, 0} };
const Step PAT_RAPID[]  = { {320, 255}, {HAPTIC_GAP_MS, 0},
                            {70, 255},  {HAPTIC_GAP_MS, 0},
                            {70, 255},  {0, 0} };

// Diagnostic only, used by BUZZ_ON_SWING. Full power and long enough to be
// unmistakable through tape and a handle. The nearby blip is deliberately
// gentle, which makes it a poor thing to hunt for when you are trying to
// work out whether detection fires at all.
const Step PAT_TICK[]   = { {140, 255}, {0, 0} };

const Step* activePattern = nullptr;
int stepIndex = 0;
unsigned long stepStart = 0;

// ================= RPC functions =================

float get_event() {
  // Runs on the Bridge RPC thread: keep it tiny and thread-safe.
  float p = pendingPeak;
  pendingPeak = 0.0f;
  return p;
}

void play_haptic(int pattern) {
  // provide_safe -> executes in loop() context, safe to touch state.
  requestedPattern = pattern;
}

String get_samples() {
  // Hands the buffered magnitudes to the Linux side and empties the buffer.
  // Comma separated, two decimals: "1.02,1.15,1.44".
  //
  // This runs on the Bridge RPC thread while loop() is appending to the same
  // array, so keep it short. The count is captured and clamped up front, so
  // indices stay in bounds whatever loop() does meanwhile. The worst case is
  // a sample arriving mid-read and being dropped, which costs one 5 ms
  // reading out of roughly six per poll and is not worth locking for.
  String out = "";
  int n = sampleCount;
  if (n > SAMPLE_BUF) n = SAMPLE_BUF;
  for (int i = 0; i < n; i++) {
    if (i > 0) out += ",";
    out += String(sampleBuf[i], 2);
  }
  sampleCount = 0;
  return out;
}

// ================= MPU-6050 helpers =================

void mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool mpuReadAccel(float &gx, float &gy, float &gz) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(REG_ACC_XOUT);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)mpuAddr, 6) != 6) return false;
  int16_t rx = (Wire.read() << 8) | Wire.read();
  int16_t ry = (Wire.read() << 8) | Wire.read();
  int16_t rz = (Wire.read() << 8) | Wire.read();
  gx = rx / LSB_PER_G;
  gy = ry / LSB_PER_G;
  gz = rz / LSB_PER_G;
  return true;
}

bool mpuProbe() {
  const uint8_t candidates[2] = { MPU_ADDR_LOW, MPU_ADDR_HIGH };
  for (int i = 0; i < 2; i++) {
    Wire.beginTransmission(candidates[i]);
    if (Wire.endTransmission() == 0) {
      mpuAddr = candidates[i];
      return true;
    }
  }
  return false;
}

int mpuReadReg(uint8_t reg) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((int)mpuAddr, 1) != 1) return -1;
  return Wire.read();
}

void mpuInit() {
  mpuWrite(REG_PWR_MGMT, 0x00);  // wake up
  delay(10);
  mpuWrite(REG_ACC_CFG, 0x10);   // +/-8g
  delay(10);
}

// ================= Boot self test =================
//
// The console is not dependable once the Bridge is up, so the motor reports
// the IMU's health instead. Count the buzzes at boot:
//
//   1 long    IMU alive and reading gravity. All good.
//   2 short   nothing answering at 0x68. Wiring: SDA, SCL, VCC or GND.
//   3 short   answering but reading zero. Asleep, or the sensor has died.
//   4 short   WHO_AM_I unexpected. Wrong chip, or a bad connection.

void buzzCode(int count, unsigned int ms) {
  for (int i = 0; i < count; i++) {
    analogWrite(MOTOR_PIN, 255);
    delay(ms);
    analogWrite(MOTOR_PIN, 0);
    delay(190);
  }
}

int imuSelfTest() {
  if (!mpuProbe()) return 2;                      // nobody home at either address

  int who = mpuReadReg(REG_WHO_AM_I);
  if (who != 0x68 && who != 0x70 && who != 0x71 && who != 0x73) return 4;

  mpuInit();
  delay(60);

  float gx, gy, gz;
  if (!mpuReadAccel(gx, gy, gz)) return 3;
  // Gravity is always there. Near zero means asleep, not weightless.
  if (sqrtf(gx * gx + gy * gy + gz * gz) < 0.3f) return 3;

  return 1;
}

// ================= Setup =================

void setup() {
  // Motor pin first, before anything that takes time. An uninitialised pin
  // can float high, and the Monitor pause below is three seconds long: that
  // is three seconds of a motor buzzing on the net every time it boots.
  pinMode(MOTOR_PIN, OUTPUT);
  analogWrite(MOTOR_PIN, 0);

  // Bridge BEFORE Monitor. Monitor rides on the same Router Bridge transport,
  // so bringing the Bridge up afterwards resets the channel and every print
  // after that point vanishes. Phases 1 and 2 printed fine precisely because
  // neither of them called Bridge.begin().
  Bridge.begin();
  Bridge.provide("get_event", get_event);

  // Returning a String over the Bridge is the one thing in this firmware that
  // has never been proven on hardware. If it will not compile, or the sketch
  // dies at boot, comment out just this line: only the trajectory predictor
  // depends on it, and swing detection, haptics and the game all still work.
  Bridge.provide("get_samples", get_samples);

  // If provide_safe does not exist in your Arduino_RouterBridge version, use
  // plain provide here. play_haptic only assigns one volatile int, so running
  // it on the RPC thread is harmless.
  Bridge.provide_safe("play_haptic", play_haptic);

  Monitor.begin();
  delay(3000);   // Monitor needs a moment or the first lines are lost

  Wire.begin();
  delay(100);
  mpuInit();
  delay(50);

  // Boot report, through the motor. One long buzz means the IMU is healthy;
  // any burst of short ones is a fault code, see the table above.
  int health = imuSelfTest();
  if (health == 1) {
    buzzCode(1, 400);
    Monitor.print("LumiCatch net ready, IMU healthy at 0x");
    Monitor.println(mpuAddr, HEX);
  } else {
    buzzCode(health, 90);
    Monitor.print("LumiCatch: IMU SELF TEST FAILED, code ");
    Monitor.println(health);
  }
}

// ================= Loop =================

void loop() {
  unsigned long now = millis();

  // ----- 1. Read IMU and run swing detection -----
  float gx, gy, gz;
  bool sensorLive = false;
  float mag = 0.0f;

  if (mpuReadAccel(gx, gy, gz)) {
    mag = sqrtf(gx * gx + gy * gy + gz * gz);

    // Sensor watchdog. 20 dead samples is 100 ms, short enough that a real
    // swing survives it, long enough not to fire on noise.
    if (mag < 0.05f) {
      zeroRun++;
      if (zeroRun >= 20) {
        zeroRun = 0;
        sensorRecoveries++;
        mpuProbe();      // it may have come back at the other address
        mpuInit();
        Monitor.print("IMU had reset to sleep, woken again (recovery #");
        Monitor.print(sensorRecoveries);
        Monitor.println(")");
      }
    } else {
      zeroRun = 0;
      sensorLive = true;
    }
  }

  // Never 'return' early from here: the haptic state machine below still has
  // to run, or a motor caught mid-pattern stays switched on. A dead sensor
  // must not become a motor stuck at full power on the net handle.
  if (sensorLive) {
    // Buffer for the Linux side's trajectory model. If the buffer fills
    // because a poll was late, drop the oldest rather than the newest: the
    // predictor cares about the most recent motion.
    if (sampleCount < SAMPLE_BUF) {
      sampleBuf[sampleCount++] = mag;
    } else {
      // Overflow means the Linux side has not polled for over 240 ms, which
      // should never happen at 30 Hz. Start a fresh batch rather than shifting
      // the whole array down: that shift was the longest stretch where the
      // Bridge RPC thread could be reading these same slots mid-move, and the
      // predictor only cares about recent motion anyway.
      sampleBuf[0] = mag;
      sampleCount = 1;
    }

    switch (swingState) {
      case IDLE:
        if (mag > SWING_THRESHOLD_G) {
          swingState = PEAKING;
          swingTimer = now;
          windowPeak = mag;
        }
        break;

      case PEAKING:
        if (mag > windowPeak) windowPeak = mag;
        if (now - swingTimer >= PEAK_WINDOW_MS) {
          pendingPeak = windowPeak;   // hand off to Linux side
          if (BUZZ_ON_SWING) requestedPattern = 9;   // strong tick, felt not seen
          Monitor.print("Swing peak: ");
          Monitor.println(windowPeak);
          swingState = COOLDOWN;
          swingTimer = now;
        }
        break;

      case COOLDOWN:
        if (now - swingTimer >= DEBOUNCE_MS) swingState = IDLE;
        break;
    }
  }

  // ----- 2. Start a haptic pattern if one was requested -----
  if (requestedPattern != 0) {
    switch (requestedPattern) {
      case 1: activePattern = PAT_SHORT;  break;
      case 2: activePattern = PAT_DOUBLE; break;
      case 3: activePattern = PAT_LONG;   break;
      case 4: activePattern = PAT_RAPID;  break;
      case 9: activePattern = PAT_TICK;   break;   // BUZZ_ON_SWING diagnostic
      default: activePattern = nullptr;
    }
    requestedPattern = 0;
    stepIndex = 0;
    stepStart = now;
    if (activePattern) analogWrite(MOTOR_PIN, activePattern[0].pwm);
  }

  // ----- 3. Advance the haptic pattern (non-blocking) -----
  if (activePattern) {
    if (activePattern[stepIndex].ms == 0) {
      analogWrite(MOTOR_PIN, 0);
      activePattern = nullptr;
    } else if (now - stepStart >= activePattern[stepIndex].ms) {
      stepIndex++;
      stepStart = now;
      analogWrite(MOTOR_PIN, activePattern[stepIndex].pwm);
    }
  }

  delay(5);  // ~200 Hz sampling, plenty for swing detection
}
