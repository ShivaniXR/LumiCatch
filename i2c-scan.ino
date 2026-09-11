/*
 * Neon-Net - I2C bus scanner
 * ---------------------------
 * Answers one question: is ANYTHING on the I2C bus, at any address?
 *
 * Use it when the MPU's power LED is lit but nothing answers. A lit LED
 * proves VCC and GND are both good, because the LED cannot light without a
 * complete circuit through them. That leaves only SDA and SCL, and this tells
 * you whether either of them is actually working.
 *
 * Reading the result:
 *
 *   Found 0x68            the MPU is alive and the bus is fine. Whatever was
 *                         wrong has been fixed by reseating.
 *   Found 0x69            AD0 has drifted high. Harmless, both firmware and
 *                         the Phase 1 test now probe for it.
 *   Found some other      something else is on the bus. Unexpected here.
 *   Found NOTHING         SDA or SCL is not connected, or they are swapped,
 *                         or the module's I2C side has died. If a fresh pair
 *                         of jumpers on the pins marked SDA and SCL still
 *                         gives nothing, swap in the spare module.
 *
 * No Bridge here on purpose, so Monitor prints reliably.
 */

#include <Wire.h>
#include "Arduino_RouterBridge.h"

void setup() {
  Monitor.begin();
  delay(3000);

  Wire.begin();
  delay(200);

  Monitor.println("");
  Monitor.println("=== I2C bus scan ===");
  Monitor.println("Scanning 0x08 to 0x77...");
  Monitor.println("");
}

void loop() {
  int found = 0;

  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      found++;
      Monitor.print("  Found a device at 0x");
      if (addr < 16) Monitor.print("0");
      Monitor.print(addr, HEX);
      if (addr == 0x68) Monitor.print("   <- MPU-6050, AD0 low. Correct.");
      if (addr == 0x69) Monitor.print("   <- MPU-6050, AD0 high. Also fine.");
      Monitor.println("");
    }
    delay(3);
  }

  if (found == 0) {
    Monitor.println("  NOTHING on the bus.");
    Monitor.println("");
    Monitor.println("  The power LED being lit proves VCC and GND are good,");
    Monitor.println("  so the fault is SDA or SCL. In order:");
    Monitor.println("   1. Reseat both, pushing each pin fully home.");
    Monitor.println("   2. Try a fresh pair of jumper wires.");
    Monitor.println("   3. Try swapping SDA and SCL over.");
    Monitor.println("   4. Move them to different breadboard rows.");
    Monitor.println("   5. Swap in the spare MPU-6050.");
  } else {
    Monitor.print("  ");
    Monitor.print(found);
    Monitor.println(" device(s) found. The bus is working.");
  }

  Monitor.println("");
  Monitor.println("Rescanning in 4 s. Reseat a wire and watch it appear.");
  Monitor.println("");
  delay(4000);
}
