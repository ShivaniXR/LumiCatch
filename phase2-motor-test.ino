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
 * Runs three tests in order, then stops:
 *
 *   A. Three slow pulses. Proves the circuit switches at all.
 *   B. A PWM ramp. Coin motors need a minimum duty before they start
 *      turning, and it is usually well above zero. Knowing that floor tells
 *      you how much room the haptic patterns actually have.
 *   C. The four real patterns from sketch.ino, announced before each. Feel
 *      them and decide whether you can tell them apart. Four patterns that
 *      are indistinguishable through a net handle are three wasted patterns,
 *      and this is the cheapest moment to find out.
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

const Step PAT_SHORT[]  = { {80, 255}, {0, 0} };
const Step PAT_DOUBLE[] = { {70, 255}, {80, 0}, {70, 255}, {0, 0} };
const Step PAT_LONG[]   = { {350, 255}, {0, 0} };
const Step PAT_RAPID[]  = { {60, 255}, {50, 0}, {60, 255}, {50, 0}, {60, 255}, {0, 0} };

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
  Monitor.println("B. PWM ramp. Note the first value you can feel.");
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

  Monitor.println("   1 of 4: NEARBY   - one short tap");
  playPattern(PAT_SHORT);
  delay(1600);

  Monitor.println("   2 of 4: RARE     - two taps");
  playPattern(PAT_DOUBLE);
  delay(1600);

  Monitor.println("   3 of 4: CAPTURE  - one long buzz");
  playPattern(PAT_LONG);
  delay(1600);

  Monitor.println("   4 of 4: COMBO    - three fast taps");
  playPattern(PAT_RAPID);
  delay(1600);

  Monitor.println("");
  Monitor.println("Done. Motor is off.");
  Monitor.println("Could you tell all four apart? If not, say which pair blurred.");
}

void loop() {
  // Deliberately empty. The motor stays off so nothing is left buzzing on
  // the bench, and a stuck-on motor cannot drain the power bank.
}
