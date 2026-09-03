/*
 * Neon-Net Phase 1b - work out WHY the IMU reads zero
 * ----------------------------------------------------
 * Symptom this is for: the device acknowledges on I2C (no 'read failed')
 * but every axis reads 0.00.
 *
 * Two suspects, and they need different fixes:
 *
 *   A. The MPU-6050 is still asleep. It powers up in sleep mode and returns
 *      zeros until PWR_MGMT_1 is cleared. If that write did not land, this is
 *      exactly what you see.
 *
 *   B. Zephyr's Wire ignores the repeated start. Reading a register normally
 *      means: write the register number, DO NOT release the bus
 *      (endTransmission(false)), then read. If the core ignores that 'false',
 *      the register pointer is never set and every read returns zeros.
 *
 * This tries both addressing styles, reads the power register back to prove
 * the wake actually took, and dumps raw bytes so nothing is hidden behind
 * scaling maths.
 *
 * Wiring is unchanged: MPU-6050 only, VCC to 3V3, GND, SDA, SCL.
 */

#include <Wire.h>
#include "Arduino_RouterBridge.h"

const uint8_t MPU_ADDR     = 0x68;
const uint8_t REG_WHO_AM_I = 0x75;
const uint8_t REG_PWR_MGMT = 0x6B;
const uint8_t REG_ACC_CFG  = 0x1C;
const uint8_t REG_ACC_XOUT = 0x3B;

// Read a register using a repeated start (no STOP between write and read).
// This is the usual way, and the way the current firmware does it.
int readRegRepeatedStart(uint8_t reg) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((int)MPU_ADDR, 1) != 1) return -2;
  return Wire.read();
}

// Read a register with a full STOP in between, then a fresh START.
// Slower, but works on cores that do not implement repeated start.
int readRegStopStart(uint8_t reg) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return -1;      // note: STOP
  if (Wire.requestFrom((int)MPU_ADDR, 1) != 1) return -2;
  return Wire.read();
}

void writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

void show(const char* label, int v) {
  Monitor.print(label);
  if (v == -1)      Monitor.println("write failed (no ACK)");
  else if (v == -2) Monitor.println("no data returned");
  else {
    Monitor.print("0x");
    if (v < 16) Monitor.print("0");
    Monitor.println(v, HEX);
  }
}

void setup() {
  Monitor.begin();
  delay(3000);

  Wire.begin();
  delay(200);

  Monitor.println("");
  Monitor.println("=== Phase 1b: why is the IMU reading zero ===");
  Monitor.println("");

  // ---- 1. Does the device acknowledge at all? ----
  Wire.beginTransmission(MPU_ADDR);
  uint8_t ack = Wire.endTransmission();
  Monitor.print("ACK at 0x68: ");
  Monitor.println(ack == 0 ? "yes" : "NO");

  // ---- 2. WHO_AM_I both ways. This is the deciding test. ----
  Monitor.println("");
  Monitor.println("WHO_AM_I should be 0x68 (or 0x70/0x71/0x73 on a clone):");
  show("  repeated start : ", readRegRepeatedStart(REG_WHO_AM_I));
  show("  stop then start: ", readRegStopStart(REG_WHO_AM_I));

  // ---- 3. Wake it, then read the power register back ----
  Monitor.println("");
  Monitor.println("Waking the sensor:");
  show("  PWR_MGMT_1 before: ", readRegStopStart(REG_PWR_MGMT));
  writeReg(REG_PWR_MGMT, 0x00);
  delay(100);
  show("  PWR_MGMT_1 after : ", readRegStopStart(REG_PWR_MGMT));
  Monitor.println("  (0x00 means awake. 0x40 means still asleep.)");

  writeReg(REG_ACC_CFG, 0x10);   // +/-8 g
  delay(50);
  show("  ACCEL_CONFIG     : ", readRegStopStart(REG_ACC_CFG));
  Monitor.println("  (0x10 means the +/-8 g range took.)");

  Monitor.println("");
  Monitor.println("Now watching raw accelerometer bytes.");
  Monitor.println("Tilt the board: the numbers must change.");
  Monitor.println("");
}

void loop() {
  // Read the six accel bytes with a STOP between, byte at a time, so a
  // broken repeated start cannot hide the result.
  int xh = readRegStopStart(REG_ACC_XOUT);
  int xl = readRegStopStart(REG_ACC_XOUT + 1);
  int yh = readRegStopStart(REG_ACC_XOUT + 2);
  int yl = readRegStopStart(REG_ACC_XOUT + 3);
  int zh = readRegStopStart(REG_ACC_XOUT + 4);
  int zl = readRegStopStart(REG_ACC_XOUT + 5);

  if (xh < 0 || xl < 0 || yh < 0 || yl < 0 || zh < 0 || zl < 0) {
    Monitor.println("a register read failed");
    delay(500);
    return;
  }

  int16_t rx = (int16_t)((xh << 8) | xl);
  int16_t ry = (int16_t)((yh << 8) | yl);
  int16_t rz = (int16_t)((zh << 8) | zl);

  Monitor.print("raw  x ");   Monitor.print(rx);
  Monitor.print("  y ");      Monitor.print(ry);
  Monitor.print("  z ");      Monitor.print(rz);
  Monitor.print("    -> g  ");
  Monitor.print(rx / 4096.0f, 2); Monitor.print(", ");
  Monitor.print(ry / 4096.0f, 2); Monitor.print(", ");
  Monitor.println(rz / 4096.0f, 2);

  delay(300);
}
