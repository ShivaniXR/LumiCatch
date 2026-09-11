/*
 * Neon-Net Phase 2 - prove the haptic driver works
 * -------------------------------------------------
 * Leave the MPU-6050 wired. It is working, and reseating it is now the
 * bigger risk. This test only touches D9 and the motor circuit.
 *
 *   D9  --[ 1k ]--> transistor base
 *   transistor emitter --> GND
 *   motor between 3V3 and transistor collector
 *   1N4007 across the motor, band toward the 3V3 side
 *
 * Runs four tests in order, then stops:
 *
 *   A. Three slow pulses. Proves the circuit switches at all.
 *   B. A PWM ramp. Measured floor on this motor is 55, so the usable
 *      range is 55 to 255 and intensity is a real design dimension.
 *   C. The four real patterns from sketch.ino, announced before each.
 *   D. The two pairs that blurred on the first run, played back to back,
 *      which is the comparison that actually decides it.
 *
 * Printing: Arduino_RouterBridge.h replaces Serial with Monitor on this
 * board. Monitor.begin() is required and the pause after it stops the first
 * lines being swallowed.
 *
 * SAFETY: if the transistor warms up at all, cut power immediately. That is
 * base and collector swapped, and it will not survive long.
 */

#include "Arduino_RouterBridge.h"

// If this line fails to compile, the core wants a plain number: use 9.
const int MOTOR_PIN = D9;

// ---- The four patterns, copied from sketch.ino so what you feel here is
// ---- exactly what the game will play.
struct Step { unsigned int ms; uint8_t pwm; };

// Measured on this motor in the first Phase 2 run:
//   PWM floor 55, so 110 is a soft but real buzz and 255 is full
//   coast-down 80 to 100 ms, so gaps must clear that or taps smear together
const unsigned int HAPTIC_GAP_MS = 150;

const Step PAT_SHORT[]  = { {70, 110}, {0, 0} };
const Step PAT_DOUBLE[] = { {70, 255}, {HAPTIC_GAP_MS, 0}, {70, 255}, {0, 0} };
const Step PAT_LONG[]   = { {420, 255}, {0, 0} };
const Step PAT_RAPID[]  = { {320, 255}, {HAPTIC_GAP_MS, 0},
                            {70, 255},  {HAPTIC_GAP_MS, 0},
                            {70, 255},  {0, 0} };

// Blocking playback is fine for a bench test. The real firmware runs these
// as a non-blocking state machine so the IMU keeps being sampled.
void playPattern(const Step* pattern) {
  for (int i = 0; pattern[i].ms != 0; i++) {
    analogWrite(MOTOR_PIN, pattern[i].pwm);
    delay(pattern[i].ms);
  }
  analogWrite(MOTOR_PIN, 0);
}

void setup() {
  pinMode(MOTOR_PIN, OUTPUT);
  analogWrite(MOTOR_PIN, 0);      // motor off before anything else

  Monitor.begin();
  delay(3000);                    // without this the opening lines are lost

  Monitor.println("");
  Monitor.println("=== Neon-Net Phase 2: haptic driver ===");
  Monitor.println("If the transistor gets warm, cut power now.");
  Monitor.println("");

  // ---------- A. Does it switch at all ----------
  Monitor.println("A. Three pulses, one second apart.");
  for (int i = 1; i <= 3; i++) {
    Monitor.print("   pulse ");
    Monitor.println(i);
    analogWrite(MOTOR_PIN, 255);
    delay(300);
    analogWrite(MOTOR_PIN, 0);
    delay(700);
  }
  Monitor.println("   If nothing moved, check the transistor pinout.");
  Monitor.println("");
  delay(1000);

  // ---------- B. Where does it actually start turning ----------
  Monitor.println("B. PWM ramp. Floor measured at 55 last run.");
  for (int duty = 40; duty <= 255; duty += 15) {
    Monitor.print("   pwm ");
    Monitor.println(duty);
    analogWrite(MOTOR_PIN, duty);
    delay(700);
  }
  analogWrite(MOTOR_PIN, 0);
  Monitor.println("   That first value is the motor's starting floor.");
  Monitor.println("");
  delay(1500);

  // ---------- C. The four game patterns ----------
  Monitor.println("C. The four patterns the game uses.");
  Monitor.println("   Hold it the way you will hold the net handle.");
  Monitor.println("");
  delay(1000);

  Monitor.println("   1 of 4: NEARBY   - soft short blip");
  playPattern(PAT_SHORT);
  delay(1600);

  Monitor.println("   2 of 4: RARE     - two clean separated taps");
  playPattern(PAT_DOUBLE);
  delay(1600);

  Monitor.println("   3 of 4: CAPTURE  - one long sustained buzz");
  playPattern(PAT_LONG);
  delay(1600);

  Monitor.println("   4 of 4: COMBO    - long buzz, then two taps");
  playPattern(PAT_RAPID);
  delay(1600);

  // ---------- D. The two pairs that blurred last time ----------
  // Judging patterns minutes apart is unreliable. Back to back is the test
  // that matters, because in play they arrive seconds apart.
  Monitor.println("");
  Monitor.println("D. Back to back pairs. These two blurred last run.");
  Monitor.println("");
  delay(1200);

  Monitor.println("   NEARBY then CAPTURE  (soft blip vs long buzz)");
  playPattern(PAT_SHORT);
  delay(900);
  playPattern(PAT_LONG);
  delay(2200);

  Monitor.println("   RARE then COMBO      (two taps vs buzz plus two taps)");
  playPattern(PAT_DOUBLE);
  delay(900);
  playPattern(PAT_RAPID);
  delay(2200);

  Monitor.println("");
  Monitor.println("Done. Motor is off.");
  Monitor.println("Both pairs clearly different now? If not, raise HAPTIC_GAP_MS to 200.");
}

void loop() {
  // Deliberately empty. The motor stays off so nothing is left buzzing on
  // the bench, and a stuck-on motor cannot drain the power bank.
}
