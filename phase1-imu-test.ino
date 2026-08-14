/*
 * Neon-Net Phase 1 - prove the MPU-6050 is alive
 * -----------------------------------------------
 * Wire ONLY the MPU-6050 for this. No motor, no transistor, no diode yet.
 * One thing at a time, so a failure has only one possible cause.
 *
 *   MPU-6050        UNO Q
 *   --------        -----
 *   VCC       ->    3V3           (never 5V, the module is 3.3 V)
 *   GND       ->    GND
 *   SDA       ->    pin marked SDA (same line as A4)
 *   SCL       ->    pin marked SCL (same line as A5)
 *
 * Wire.begin() takes no pin arguments on purpose: the core already knows the
 * board's default I2C pins, so there is nothing to look up or mistype.
 *
 * This does three things the old smoke test did not:
 *   1. Checks something actually answers at address 0x68.
 *   2. Reads WHO_AM_I, which separates 'wiring wrong' from 'wrong chip'.
 *   3. Prints magnitude in g and tracks the peak, which is the exact signal
 *      the swing detector and the trajectory model both consume. Swing the
 *      breadboard and you are reading the numbers that tune the whole system.
 */

#include <Wire.h>

const uint8_t MPU_ADDR     = 0x68;
const uint8_t REG_WHO_AM_I = 0x75;
const uint8_t REG_PWR_MGMT = 0x6B;
const uint8_t REG_ACC_CFG  = 0x1C;
const uint8_t REG_ACC_XOUT = 0x3B;
const float   LSB_PER_G    = 4096.0f;   // +/-8 g range

float peakSeen = 0.0f;
unsigned long lastPrint = 0;

void mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

uint8_t mpuRead(uint8_t reg) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((int)MPU_ADDR, 1);
  if (Wire.available()) return Wire.read();
  return 0xFF;
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

void setup() {
  Serial.begin(115200);
  delay(500);

  Wire.begin();
  delay(200);

  Serial.println();
  Serial.println("=== Neon-Net Phase 1: IMU check ===");

  // --- Test 1: is anything on the bus? ---
  Wire.beginTransmission(MPU_ADDR);
  uint8_t err = Wire.endTransmission();
  if (err != 0) {
    Serial.println("FAIL: nothing answering at 0x68.");
    Serial.println("      Check SDA and SCL are not swapped.");
    Serial.println("      Check VCC is on 3V3 and GND is connected.");
    Serial.println("      If the module has an AD0 pin, leave it unconnected.");
  } else {
    Serial.println("PASS: a device answered at 0x68");
  }

  // --- Test 2: is it the chip we think it is? ---
  uint8_t who = mpuRead(REG_WHO_AM_I);
  Serial.print("WHO_AM_I = 0x");
  Serial.println(who, HEX);
  if (who == 0x68) {
    Serial.println("PASS: genuine MPU-6050");
  } else if (who == 0x70 || who == 0x71 || who == 0x73) {
    Serial.println("NOTE: this is an MPU-6500/9250 clone. Still fine,");
    Serial.println("      the registers we use are the same.");
  } else {
    Serial.println("WARN: unexpected WHO_AM_I, check wiring before trusting data");
  }

  // --- Wake it and set the range ---
  mpuWrite(REG_PWR_MGMT, 0x00);   // out of sleep
  mpuWrite(REG_ACC_CFG, 0x10);    // +/-8 g, matches sketch.ino
  delay(50);

  Serial.println();
  Serial.println("Hold it still: magnitude should sit near 1.00 g.");
  Serial.println("Then swing it like a net and watch the peak.");
  Serial.println();
}

void loop() {
  float gx, gy, gz;
  if (!mpuReadAccel(gx, gy, gz)) {
    Serial.println("read failed");
    delay(500);
    return;
  }

  float mag = sqrtf(gx * gx + gy * gy + gz * gz);
  if (mag > peakSeen) peakSeen = mag;

  // Sample fast so the peak is real, but print slowly so it stays readable.
  if (millis() - lastPrint >= 200) {
    lastPrint = millis();
    Serial.print("x ");   Serial.print(gx, 2);
    Serial.print("  y "); Serial.print(gy, 2);
    Serial.print("  z "); Serial.print(gz, 2);
    Serial.print("   |mag| "); Serial.print(mag, 2);
    Serial.print(" g   peak "); Serial.print(peakSeen, 2);
    Serial.println(" g");
  }

  delay(5);   // ~200 Hz, the same rate the real firmware samples at
}
