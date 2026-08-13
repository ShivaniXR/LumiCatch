/*
 * LumiCatchManager.ts - Snap Spectacles Lens
 * -------------------------------------------
 * Spectacles (2024) -> Lens Studio 5.15.4
 *
 * SIMULATE MODE lets you build and tune the whole Lens before the
 * net hardware exists. Turn 'simulate' on and a swing is faked by a
 * mouse click in the Lens Studio preview, or a hand pinch on device.
 * Turn it off and the Lens listens to the real net over WebSocket.
 *
 * Inspector setup:
 *   internetModule  - Internet Module asset
 *   creaturePrefab  - common jellyfish prefab (REQUIRED)
 *   rarePrefab      - optional gold 'Lumen' jellyfish, falls back to the common one
 *   burstPrefab     - optional particle burst played on capture
 *   creatureParent  - optional SceneObject to hold spawned creatures
 *   camera          - the Camera component (main camera)
 *   scoreText       - Text component for the score
 *   captureSound    - AudioComponent with a capture chime
 *   ambientSound    - AudioComponent with a looping underwater bed
 *   serverUrl       - ws://<UNO-Q-IP>:8765
 *   simulate        - true while you have no hardware
 *
 * Creature AI, in one line each:
 *   Drifter  - common, never flees, this is your reliable camera target
 *   Skittish - common, notices the net and dodges sideways, then returns
 *   Lumen    - rare, bigger, worth 3 points, dodges further and harder
 *
 * Three safeguards exist purely so a filmed take cannot be ruined:
 *   1. Leash      - nothing may drift behind you or past leashMaxCm
 *   2. Mercy      - after two missed swings, fleeing switches off briefly
 *   3. Guarantee  - if no easy target is in front of you, one swims into shot
 * Turn all three off only if you are debugging the AI itself.
 */

import { SIK } from 'SpectaclesInteractionKit.lspkg/SIK';

// Creature kinds
const KIND_DRIFTER = 0;
const KIND_SKITTISH = 1;
const KIND_LUMEN = 2;

// Behaviour states
const ST_DRIFT = 0;
const ST_ALERT = 1;
const ST_FLEE = 2;
const ST_RETURN = 3;

interface Creature {
  obj: SceneObject;
  kind: number;
  state: number;
  stateT: number;
  home: vec3;
  pos: vec3;
  fleeTarget: vec3;
  seed: number;
  scale: number;
}

@component
export class LumiCatchManager extends BaseScriptComponent {
  // Only needed when 'simulate' is off. Leave empty while building the Lens.
  @input @allowUndefined internetModule: InternetModule;
  @input creaturePrefab: ObjectPrefab;
  @input('Asset.ObjectPrefab') @allowUndefined rarePrefab: ObjectPrefab;
  @input('Asset.ObjectPrefab') @allowUndefined burstPrefab: ObjectPrefab;
  @input('SceneObject') @allowUndefined creatureParent: SceneObject;
  @input camera: Camera;
  @input('Component.Text') @allowUndefined scoreText: Text;
  @input('Component.AudioComponent') @allowUndefined captureSound: AudioComponent;
  @input('Component.AudioComponent') @allowUndefined ambientSound: AudioComponent;

  @input serverUrl: string = 'ws://192.168.1.50:8765';
  @input simulate: boolean = true;
  @input usePinchToSwing: boolean = true;

  // ---- Spawning ----
  @input creatureCount: number = 5;
  @input spawnMinCm: number = 80;
  @input spawnMaxCm: number = 220;
  @input spawnYawSpread: number = 1.9;       // radians of total spread, 1.9 is about +/- 54 deg
  @input spawnHeightSpreadCm: number = 70;

  // ---- Capture ----
  @input captureRangeCm: number = 150;
  @input captureConeDot: number = 0.45;      // 1.0 = dead centre, 0.0 = 90 deg cone
  @input nearbyRangeCm: number = 90;
  @input nearbyCooldownS: number = 2.5;

  // ---- Creature mix ----
  @input rareChance: number = 0.22;
  @input skittishChance: number = 0.35;
  @input creatureScale: number = 1.0;
  @input rareScaleMult: number = 1.35;

  // ---- Movement ----
  @input driftAmplitudeCm: number = 22;
  @input driftEaseRate: number = 1.2;
  @input fleeSpeedCm: number = 130;
  @input fleeDistanceCm: number = 70;
  @input returnSpeedCm: number = 55;
  @input alertRangeCm: number = 55;
  @input alertHoldS: number = 0.22;          // the beat where it notices you, keeps the dodge legible
  @input leashMaxCm: number = 260;

  // ---- Look ----
  @input pulseAmount: number = 0.12;
  @input spinRate: number = 0.35;            // radians per second

  // ---- Demo safeguards ----
  @input useMercy: boolean = true;
  @input mercyMisses: number = 2;
  @input mercySeconds: number = 6.0;
  @input guaranteeEasyTarget: boolean = true;
  @input guaranteeDelayS: number = 3.0;
  @input heroDistanceCm: number = 110;

  // Lens Studio's transform.forward points along +z on some rigs.
  // If creatures spawn behind you, flip this to 1.
  @input forwardSign: number = -1;

  private socket: WebSocket = null;
  private connected: boolean = false;
  private creatures: Creature[] = [];
  private score: number = 0;
  private lastCapture: number = -10;
  private lastNearbyPing: number = -10;
  private lastSimSwing: number = -10;
  private elapsed: number = 0;
  private consecutiveMisses: number = 0;
  private mercyUntil: number = -10;
  private easyMissingT: number = 0;

  onAwake() {
    this.createEvent('OnStartEvent').bind(() => this.onStart());
    this.createEvent('UpdateEvent').bind(() => this.onUpdate());

    // Simulated swing, route one: mouse click in the Lens Studio preview.
    this.createEvent('TapEvent').bind(() => this.simulatedSwing());
  }

  private onStart() {
    // Simulated swing, route two: hand pinch on device. TapEvent does not
    // reliably fire on Spectacles, so this is the on-device fallback.
    if (this.usePinchToSwing) {
      this.bindPinch();
    }

    for (let i = 0; i < this.creatureCount; i++) {
      // Force the first one to be a Drifter so there is always an easy
      // target available for the guarantee to summon.
      this.spawnCreature(i === 0 ? KIND_DRIFTER : -1);
    }
    this.updateScore(0);

    if (this.ambientSound) {
      this.ambientSound.play(-1); // -1 = loop forever
    }

    if (this.simulate) {
      print('LumiCatch: SIMULATE mode. Click in preview or pinch on device. No hardware needed.');
    } else {
      this.connect();
    }
  }

  private bindPinch() {
    const handInput = SIK.HandInputData;
    const left = handInput.getHand('left');
    const right = handInput.getHand('right');
    if (left) left.onPinchDown.add(() => this.simulatedSwing());
    if (right) right.onPinchDown.add(() => this.simulatedSwing());
  }

  private simulatedSwing() {
    if (!this.simulate) return;
    // Click and pinch can both fire on the same gesture, so debounce to
    // roughly match the firmware's DEBOUNCE_MS.
    if (this.elapsed - this.lastSimSwing < 0.4) return;
    this.lastSimSwing = this.elapsed;
    print('LumiCatch: simulated swing');
    this.onSwing(3.0);
  }

  // ---------------- WebSocket ----------------

  private connect() {
    if (!this.internetModule) {
      print('LumiCatch: no Internet Module assigned. Assign one, or tick simulate.');
      return;
    }
    print('LumiCatch: connecting to ' + this.serverUrl);
    this.socket = this.internetModule.createWebSocket(this.serverUrl);

    this.socket.onopen = () => {
      this.connected = true;
      print('LumiCatch: connected to net');
    };

    this.socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this.handleMessage(event.data);
      }
    };

    this.socket.onclose = () => {
      this.connected = false;
      print('LumiCatch: connection closed, retrying in 2 s');
      const retry = this.createEvent('DelayedCallbackEvent');
      retry.bind(() => this.connect());
      retry.reset(2.0);
    };

    this.socket.onerror = () => print('LumiCatch: socket error');
  }

  private handleMessage(raw: string) {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (data.type === 'swing') {
      print('LumiCatch: swing received, peak ' + data.peak);
      this.onSwing(data.peak || 0);
    }
  }

  private sendHaptic(pattern: number) {
    if (this.simulate) {
      print('LumiCatch: [sim] haptic pattern ' + pattern);
      return;
    }
    if (this.connected && this.socket) {
      this.socket.send(JSON.stringify({ type: 'haptic', pattern: pattern }));
    }
  }

  // ---------------- Helpers ----------------

  private camForward(): vec3 {
    return this.camera.getTransform().forward.uniformScale(this.forwardSign);
  }

  private creatureRoot(): SceneObject {
    return this.creatureParent ? this.creatureParent : this.getSceneObject();
  }

  /** A random point inside the forward cone, at a comfortable height. */
  private pointInCone(
    camPos: vec3,
    fwd: vec3,
    rightV: vec3,
    minCm: number,
    maxCm: number
  ): vec3 {
    const yaw = (Math.random() - 0.5) * this.spawnYawSpread;
    const dist = minCm + Math.random() * (maxCm - minCm);
    const dir = fwd
      .uniformScale(Math.cos(yaw))
      .add(rightV.uniformScale(Math.sin(yaw)));
    return camPos
      .add(dir.uniformScale(dist))
      .add(new vec3(0, (Math.random() - 0.35) * this.spawnHeightSpreadCm, 0));
  }

  /** Move from 'from' towards 'to' by at most maxStep centimetres. */
  private stepTowards(from: vec3, to: vec3, maxStep: number): vec3 {
    const d = to.sub(from);
    const len = d.length;
    if (len <= maxStep || len < 0.0001) return to;
    return from.add(d.uniformScale(maxStep / len));
  }

  private pointsFor(kind: number): number {
    return kind === KIND_LUMEN ? 3 : 1;
  }

  private canFlee(c: Creature): boolean {
    if (c.kind === KIND_DRIFTER) return false;
    if (this.useMercy && this.elapsed < this.mercyUntil) return false;
    return true;
  }

  // ---------------- Spawning ----------------

  private pickKind(): number {
    const r = Math.random();
    if (r < this.rareChance) return KIND_LUMEN;
    if (r < this.rareChance + this.skittishChance) return KIND_SKITTISH;
    return KIND_DRIFTER;
  }

  /** forceKind of -1 means 'choose randomly'. */
  private spawnCreature(forceKind: number) {
    const kind = forceKind >= 0 ? forceKind : this.pickKind();

    const prefab =
      kind === KIND_LUMEN && this.rarePrefab
        ? this.rarePrefab
        : this.creaturePrefab;

    const obj = prefab.instantiate(this.creatureRoot());

    const camT = this.camera.getTransform();
    const camPos = camT.getWorldPosition();
    const home = this.pointInCone(
      camPos,
      this.camForward(),
      camT.right,
      this.spawnMinCm,
      this.spawnMaxCm
    );

    const scale =
      this.creatureScale * (kind === KIND_LUMEN ? this.rareScaleMult : 1.0);

    obj.getTransform().setWorldPosition(home);

    this.creatures.push({
      obj: obj,
      kind: kind,
      state: ST_DRIFT,
      stateT: 0,
      home: home,
      pos: home,
      fleeTarget: home,
      seed: Math.random() * 100,
      scale: scale
    });
  }

  // ---------------- Per-frame AI ----------------

  private onUpdate() {
    const dt = getDeltaTime();
    this.elapsed += dt;

    const camT = this.camera.getTransform();
    const camPos = camT.getWorldPosition();
    const fwd = this.camForward();
    const rightV = camT.right;
    const worldUp = new vec3(0, 1, 0);

    let nearestDist = Number.MAX_VALUE;
    let nearestKind = KIND_DRIFTER;
    let easyReady = false;

    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      c.stateT += dt;

      const toC = c.pos.sub(camPos);
      const dist = toC.length;
      const dir = dist > 0.0001 ? toC.normalize() : fwd;

      // Leash. Nothing is allowed to wander out of shot or behind the player.
      if (dist > this.leashMaxCm || dir.dot(fwd) < -0.15) {
        c.home = this.pointInCone(
          camPos,
          fwd,
          rightV,
          this.spawnMinCm,
          this.spawnMaxCm
        );
        c.state = ST_RETURN;
        c.stateT = 0;
      }

      switch (c.state) {
        case ST_DRIFT: {
          // Slow orbit plus a faster vertical bob: reads as a jellyfish pulse.
          const a = this.driftAmplitudeCm;
          const wob = new vec3(
            Math.sin(this.elapsed * 0.4 + c.seed) * a,
            Math.sin(this.elapsed * 0.9 + c.seed * 2) * a * 0.5,
            Math.cos(this.elapsed * 0.3 + c.seed) * a
          );
          c.pos = vec3.lerp(
            c.pos,
            c.home.add(wob),
            Math.min(1, dt * this.driftEaseRate)
          );
          if (this.canFlee(c) && dist < this.alertRangeCm) {
            c.state = ST_ALERT;
            c.stateT = 0;
          }
          break;
        }

        case ST_ALERT: {
          // Hold still for a beat. Without this the dodge looks like a
          // rendering glitch rather than a decision, especially on camera.
          if (c.stateT >= this.alertHoldS) {
            c.fleeTarget = this.computeFleeTarget(c, camPos, dir, rightV, worldUp);
            c.state = ST_FLEE;
            c.stateT = 0;
          }
          break;
        }

        case ST_FLEE: {
          c.pos = this.stepTowards(c.pos, c.fleeTarget, this.fleeSpeedCm * dt);
          if (c.pos.distance(c.fleeTarget) < 8 || c.stateT > 1.2) {
            c.home = this.pointInCone(
              camPos,
              fwd,
              rightV,
              this.spawnMinCm,
              this.spawnMaxCm
            );
            c.state = ST_RETURN;
            c.stateT = 0;
          }
          break;
        }

        case ST_RETURN: {
          c.pos = this.stepTowards(c.pos, c.home, this.returnSpeedCm * dt);
          if (c.pos.distance(c.home) < 15) {
            c.state = ST_DRIFT;
            c.stateT = 0;
          }
          break;
        }
      }

      // Apply the transform. Yaw spin plus bell pulse, no billboarding:
      // a wrong facing axis is invisible in the editor and obvious on video.
      const t = c.obj.getTransform();
      t.setWorldPosition(c.pos);

      const pulseSpeed = c.kind === KIND_LUMEN ? 1.4 : 2.2;
      const s =
        c.scale *
        (1 + Math.sin(this.elapsed * pulseSpeed + c.seed) * this.pulseAmount);
      t.setWorldScale(new vec3(s, s, s));
      t.setWorldRotation(
        quat.angleAxis(this.elapsed * this.spinRate + c.seed, worldUp)
      );

      if (dist < nearestDist) {
        nearestDist = dist;
        nearestKind = c.kind;
      }
      if (
        c.kind === KIND_DRIFTER &&
        dist < this.captureRangeCm &&
        dir.dot(fwd) >= this.captureConeDot
      ) {
        easyReady = true;
      }
    }

    // Guarantee: never let the player stand there with nothing catchable.
    if (this.guaranteeEasyTarget) {
      if (easyReady) {
        this.easyMissingT = 0;
      } else {
        this.easyMissingT += dt;
        if (this.easyMissingT > this.guaranteeDelayS) {
          this.easyMissingT = 0;
          this.summonEasyTarget(camPos, fwd, rightV);
        }
      }
    }

    // Proximity haptic. Rare creatures get their own pattern.
    if (
      nearestDist < this.nearbyRangeCm &&
      this.elapsed - this.lastNearbyPing > this.nearbyCooldownS
    ) {
      this.lastNearbyPing = this.elapsed;
      this.sendHaptic(nearestKind === KIND_LUMEN ? 2 : 1);
    }
  }

  /**
   * Flee sideways across the player's view rather than straight away.
   * Straight-away fleeing shrinks the creature to a dot and loses it from
   * frame, which is fatal to a one-take video.
   */
  private computeFleeTarget(
    c: Creature,
    camPos: vec3,
    away: vec3,
    rightV: vec3,
    worldUp: vec3
  ): vec3 {
    // Dodge towards the centre of frame, not out of it.
    const side = c.pos.sub(camPos).dot(rightV) > 0 ? -1 : 1;
    const boost = c.kind === KIND_LUMEN ? 1.25 : 1.0;

    const fleeDir = rightV
      .uniformScale(side * 0.85)
      .add(worldUp.uniformScale(0.3))
      .add(away.uniformScale(0.3))
      .normalize();

    return c.pos.add(fleeDir.uniformScale(this.fleeDistanceCm * boost));
  }

  /** Send a Drifter swimming into the capture zone in front of the player. */
  private summonEasyTarget(camPos: vec3, fwd: vec3, rightV: vec3) {
    let pick = -1;
    for (let i = 0; i < this.creatures.length; i++) {
      if (this.creatures[i].kind === KIND_DRIFTER) {
        pick = i;
        break;
      }
    }
    if (pick < 0) {
      // No Drifter left. Promote a Skittish one: it shares the same prefab,
      // so the change is invisible.
      for (let i = 0; i < this.creatures.length; i++) {
        if (this.creatures[i].kind === KIND_SKITTISH) {
          this.creatures[i].kind = KIND_DRIFTER;
          pick = i;
          break;
        }
      }
    }
    if (pick < 0) return;

    const c = this.creatures[pick];
    c.home = camPos
      .add(fwd.uniformScale(this.heroDistanceCm))
      .add(rightV.uniformScale((Math.random() - 0.5) * 40))
      .add(new vec3(0, 10, 0));
    c.state = ST_RETURN;
    c.stateT = 0;
    print('LumiCatch: sending an easy target into range');
  }

  // ---------------- Capture ----------------

  private onSwing(peak: number) {
    const camT = this.camera.getTransform();
    const camPos = camT.getWorldPosition();
    const fwd = this.camForward();

    let bestIdx = -1;
    let bestDist = Number.MAX_VALUE;

    for (let i = 0; i < this.creatures.length; i++) {
      const toC = this.creatures[i].pos.sub(camPos);
      const dist = toC.length;
      if (dist > this.captureRangeCm) continue;
      if (dist < 0.0001) continue;
      if (toC.normalize().dot(fwd) < this.captureConeDot) continue;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      this.consecutiveMisses = 0;
      this.capture(bestIdx);
    } else {
      this.consecutiveMisses++;
      print(
        'LumiCatch: swing missed (peak ' +
          peak +
          ', misses ' +
          this.consecutiveMisses +
          ')'
      );
      if (this.useMercy && this.consecutiveMisses >= this.mercyMisses) {
        this.mercyUntil = this.elapsed + this.mercySeconds;
        this.consecutiveMisses = 0;
        print('LumiCatch: mercy window, fleeing paused');
      }
    }
  }

  private capture(idx: number) {
    const c = this.creatures[idx];
    const pos = c.pos;
    const kind = c.kind;

    this.creatures.splice(idx, 1);
    c.obj.destroy();

    if (this.burstPrefab) {
      const burst = this.burstPrefab.instantiate(this.creatureRoot());
      burst.getTransform().setWorldPosition(pos);
      const cleanup = this.createEvent('DelayedCallbackEvent');
      cleanup.bind(() => burst.destroy());
      cleanup.reset(2.0);
    }

    if (this.captureSound) this.captureSound.play(1);

    const combo = this.elapsed - this.lastCapture < 4.0;
    this.lastCapture = this.elapsed;
    this.sendHaptic(combo ? 4 : 3);
    this.updateScore(this.score + this.pointsFor(kind) * (combo ? 2 : 1));

    const respawn = this.createEvent('DelayedCallbackEvent');
    respawn.bind(() => this.spawnCreature(-1));
    respawn.reset(1.5);
  }

  private updateScore(v: number) {
    this.score = v;
    if (this.scoreText) this.scoreText.text = 'Caught: ' + v;
  }
}
