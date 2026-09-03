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
const uint8_t MPU_ADDR      = 0x68;
const uint8_t REG_PWR_MGMT  = 0x6B;
const uint8_t REG_ACC_CFG   = 0x1C;
const uint8_t REG_ACC_XOUT  = 0x3B;
const float   LSB_PER_G     = 4096.0f;  // +/-8g range

// ---------- Swing detection tuning ----------
// Measured on this net's own IMU during Phase 1:
//   at rest    ~0.87 g   (this module reads about 8 per cent low, harmless)
//   walking     0.65 to 1.08 g
//   real swing  peaks at 5.50 g
// 2.2 sits twice above the worst walking reading and well under half a swing,
// so it has margin in both directions. Re-measure after the net is assembled:
// mounting the sensor near the hoop lengthens the lever arm and will push
// swing peaks higher.
const float SWING_THRESHOLD_G = 2.2f;   // raise if false triggers, lower if misses
const unsigned long PEAK_WINDOW_MS = 150;
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

const Step PAT_SHORT[]  = { {80, 255}, {0, 0} };
const Step PAT_DOUBLE[] = { {70, 255}, {80, 0}, {70, 255}, {0, 0} };
const Step PAT_LONG[]   = { {350, 255}, {0, 0} };
const Step PAT_RAPID[]  = { {60, 255}, {50, 0}, {60, 255}, {50, 0}, {60, 255}, {0, 0} };

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
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool mpuReadAccel(float &gx, float &gy, float &gz) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(REG_ACC_XOUT);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)MPU_ADDR, 6) != 6) return false;
  int16_t rx = (Wire.read() << 8) | Wire.read();
  int16_t ry = (Wire.read() << 8) | Wire.read();
  int16_t rz = (Wire.read() << 8) | Wire.read();
  gx = rx / LSB_PER_G;
  gy = ry / LSB_PER_G;
  gz = rz / LSB_PER_G;
  return true;
}

void mpuInit() {
  mpuWrite(REG_PWR_MGMT, 0x00);  // wake up
  delay(10);
  mpuWrite(REG_ACC_CFG, 0x10);   // +/-8g
  delay(10);
}

// ================= Setup =================

void setup() {
  Monitor.begin();
  delay(3000);   // Monitor needs a moment or the first lines are lost
  pinMode(MOTOR_PIN, OUTPUT);
  analogWrite(MOTOR_PIN, 0);

  Wire.begin();
  delay(100);
  mpuInit();
  delay(50);

  Bridge.begin();
  Bridge.provide("get_event", get_event);
  Bridge.provide("get_samples", get_samples);
  Bridge.provide_safe("play_haptic", play_haptic);

  // Boot confirmation buzz so you know the firmware is alive.
  analogWrite(MOTOR_PIN, 200);
  delay(150);
  analogWrite(MOTOR_PIN, 0);

  Monitor.println("LumiCatch net ready");
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
