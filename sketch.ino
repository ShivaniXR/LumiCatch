/*
 * LumiCatch Net - MCU firmware (Arduino UNO Q, STM32 side)
 * ---------------------------------------------------------
 * - Reads MPU-6050 over I2C (Wire: D20 SDA / D21 SCL) with raw
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
const float SWING_THRESHOLD_G = 2.2f;   // raise if false triggers, lower if misses
const unsigned long PEAK_WINDOW_MS = 150;
const unsigned long DEBOUNCE_MS    = 400;

// ---------- Shared state (volatile: touched from RPC thread) ----------
volatile float pendingPeak = 0.0f;      // latest swing peak, cleared on read
volatile int   requestedPattern = 0;    // set by play_haptic RPC

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

// ================= Setup =================

void setup() {
  Serial.begin(115200);
  pinMode(MOTOR_PIN, OUTPUT);
  analogWrite(MOTOR_PIN, 0);

  Wire.begin();
  delay(100);
  mpuWrite(REG_PWR_MGMT, 0x00);  // wake up
  mpuWrite(REG_ACC_CFG, 0x10);   // +/-8g
  delay(50);

  Bridge.begin();
  Bridge.provide("get_event", get_event);
  Bridge.provide_safe("play_haptic", play_haptic);

  // Boot confirmation buzz so you know the firmware is alive.
  analogWrite(MOTOR_PIN, 200);
  delay(150);
  analogWrite(MOTOR_PIN, 0);

  Serial.println("LumiCatch net ready");
}

// ================= Loop =================

void loop() {
  unsigned long now = millis();

  // ----- 1. Read IMU and run swing detection -----
  float gx, gy, gz;
  if (mpuReadAccel(gx, gy, gz)) {
    float mag = sqrtf(gx * gx + gy * gy + gz * gz);

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
          Serial.print("Swing peak: ");
          Serial.println(windowPeak);
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
