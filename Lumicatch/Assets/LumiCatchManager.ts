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

// Shoal mood, driven entirely by what the player just did. Unlike emergent
// flocking this is deterministic: the same run of catches produces the same
// behaviour every take, which is what makes it filmable.
const MOOD_CALM = 0;
const MOOD_SPOOKED = 1;
const MOOD_CURIOUS = 2;

// Behaviour states
const ST_DRIFT = 0;
const ST_ALERT = 1;
const ST_FLEE = 2;
const ST_RETURN = 3;

// Colour per kind, applied at runtime. Editor-side material colour does not
// survive on these graph materials, so the script owns the tint.
// Spectacles displays are additive, so bright and saturated reads best and
// anything dark simply disappears.
const COL_DRIFTER = new vec4(0.15, 0.95, 1.0, 1.0);   // cyan
const COL_SKITTISH = new vec4(0.45, 0.5, 1.0, 1.0);   // violet
const COL_LUMEN = new vec4(1.0, 0.8, 0.15, 1.0);      // gold

interface Creature {
  obj: SceneObject;
  school: number;
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
  @input creatureCount: number = 14;
  @input spawnAllAround: boolean = true;   // 360 degrees around you, not just ahead
  @input separationCm: number = 35;        // keep creatures from overlapping, 0 disables
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

  // ---- Schools and mood ----
  @input schoolCount: number = 2;
  @input schoolSpreadCm: number = 70;      // how loose a school sits around its centre
  @input schoolMidCm: number = 170;        // school distance when calm
  @input schoolFarCm: number = 250;        // when spooked, they back off to here
  @input schoolNearCm: number = 100;       // when curious, they close in to here
  @input schoolDriftRate: number = 0.12;   // radians per second, schools counter rotate
  @input curiousDistanceCm: number = 85;   // how close an inquisitive one comes
  @input cohesionCalm: number = 0.15;
  @input cohesionSpooked: number = 0.75;   // tight shoal
  @input cohesionCurious: number = 0.0;    // fully dispersed
  @input spookCatches: number = 3;         // catches within spookWindowS to spook them
  @input spookWindowS: number = 8.0;
  @input spookSeconds: number = 5.0;
  @input curiousMisses: number = 2;
  @input curiousSeconds: number = 8.0;

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
  private nearbyActive: boolean = false;
  private kindMaterials: Material[] = [null, null, null];
  private tintWarned: boolean = false;
  private mood: number = MOOD_CALM;
  private moodUntil: number = 0;
  private catchTimes: number[] = [];
  private schoolAngle: number[] = [];
  private schoolCentre: vec3[] = [];

  // Live difficulty, pushed from the UNO Q's adaptive model. All multipliers,
  // so the Lens keeps its own tuned baselines and the board only scales them.
  private diffLevel: number = 0;
  private diffSpeedMult: number = 1.0;
  private diffEvasionMult: number = 1.0;
  private diffAlertMult: number = 1.0;
  private diffCloaking: boolean = false;

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

    this.initSchools(this.camera.getTransform().getWorldPosition());

    for (let i = 0; i < this.creatureCount; i++) {
      // Force the first one to be a Drifter so there is always an easy
      // target available for the guarantee to summon.
      this.spawnCreature(i === 0 ? KIND_DRIFTER : -1);
    }
    this.updateScore(0);

    // Put the first Drifter straight into the capture zone, so there is
    // something catchable the instant the Lens starts. Without this you spend
    // the first few seconds of every take waiting for one to swim into range.
    if (this.guaranteeEasyTarget && this.creatures.length > 0) {
      const heroT = this.camera.getTransform();
      const hero = heroT
        .getWorldPosition()
        .add(this.camForward().uniformScale(this.heroDistanceCm))
        .add(heroT.right.uniformScale((Math.random() - 0.5) * 30))
        .add(new vec3(0, 5, 0));
      this.creatures[0].home = hero;
      this.creatures[0].pos = hero;
    }

    // One-line sanity check on forwardSign, which is the most common setup
    // mistake and is invisible until you put the glasses on.
    const camPos0 = this.camera.getTransform().getWorldPosition();
    const fwd0 = this.camForward();
    let inFront = 0;
    for (let i = 0; i < this.creatures.length; i++) {
      const d = this.creatures[i].pos.sub(camPos0);
      if (d.length > 0.0001 && d.normalize().dot(fwd0) > 0) inFront++;
    }
    print(
      'LumiCatch: ' + inFront + ' of ' + this.creatures.length +
      ' creatures spawned in front. If this is 0, flip forwardSign.'
    );

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

  /**
   * The Internet Module, from the Inspector slot if you filled it, otherwise
   * pulled straight out of Lens Studio. Built in modules are reachable through
   * the 'LensStudio:' prefix, so nothing has to be added to the project at all.
   */
  private resolveInternetModule(): InternetModule {
    if (this.internetModule) return this.internetModule;
    try {
      return require('LensStudio:InternetModule') as InternetModule;
    } catch (e) {
      return null;
    }
  }

  private connect() {
    const net = this.resolveInternetModule();
    if (!net) {
      print('LumiCatch: no Internet Module available. Assign one, or tick simulate.');
      return;
    }
    print('LumiCatch: connecting to ' + this.serverUrl);
    this.socket = net.createWebSocket(this.serverUrl);

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
      return;
    }

    // The board's predictive model says a swing is about to peak. Used as an
    // early warning only: the authoritative catch still happens on the real
    // 'swing' message, so a wrong prediction can never award a false catch.
    if (data.type === 'predict') {
      print(
        'LumiCatch: swing predicted in ' + data.etaMs +
        ' ms, confidence ' + data.confidence
      );
      return;
    }

    // Adaptive difficulty from the UNO Q.
    if (data.type === 'difficulty') {
      this.diffLevel = data.level || 0;
      this.diffSpeedMult = data.speedMult || 1.0;
      this.diffEvasionMult = data.evasionMult || 1.0;
      this.diffAlertMult = data.alertMult || 1.0;
      this.diffCloaking = data.cloaking === true;
      if (typeof data.skittishBias === 'number') {
        this.skittishChance = data.skittishBias;
      }
      print(
        'LumiCatch: difficulty ' + this.diffLevel +
        ', speed x' + this.diffSpeedMult +
        (this.diffCloaking ? ', cloaking on' : '')
      );
    }
  }

  /** Tell the board whether that swing landed, so its model can adapt. */
  private sendResult(hit: boolean) {
    if (this.simulate) {
      print('LumiCatch: [sim] result ' + (hit ? 'hit' : 'miss'));
      return;
    }
    if (this.connected && this.socket) {
      this.socket.send(JSON.stringify({ type: 'result', hit: hit }));
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

  /**
   * A random point around the player, at a comfortable height.
   * With spawnAllAround on, yaw covers the full 360 degrees so creatures fill
   * the room and you have to turn to find them. With it off, they stay inside
   * the forward cone defined by spawnYawSpread.
   */
  private pointInCone(
    camPos: vec3,
    fwd: vec3,
    rightV: vec3,
    minCm: number,
    maxCm: number
  ): vec3 {
    const yaw = this.spawnAllAround
      ? Math.random() * Math.PI * 2
      : (Math.random() - 0.5) * this.spawnYawSpread;
    const dist = minCm + Math.random() * (maxCm - minCm);
    const dir = fwd
      .uniformScale(Math.cos(yaw))
      .add(rightV.uniformScale(Math.sin(yaw)));
    return camPos
      .add(dir.uniformScale(dist))
      .add(new vec3(0, (Math.random() - 0.35) * this.spawnHeightSpreadCm, 0));
  }

  /**
   * Cloaking, switched on by the board once difficulty passes its threshold.
   * The rare Lumen creatures shimmer down towards black, which on an additive
   * display means they genuinely fade out of sight rather than turning grey.
   * Driven through the shared per-kind material, so the whole rare population
   * pulses together and it reads as deliberate camouflage.
   */
  private updateCloaking() {
    const mat = this.kindMaterials[KIND_LUMEN];
    if (!mat) return;

    let k = 1.0;
    if (this.diffCloaking) {
      // Dip to roughly 15 per cent brightness and back, about once a second.
      const wave = 0.5 * (1 + Math.sin(this.elapsed * 2.1));
      k = 0.15 + 0.85 * wave * wave;
    }

    mat.mainPass.baseColor = new vec4(
      COL_LUMEN.r * k,
      COL_LUMEN.g * k,
      COL_LUMEN.b * k,
      COL_LUMEN.a
    );
  }

  // ---------------- Schools and mood ----------------

  /**
   * A point on a ring around 'centre'. Uses world axes rather than camera
   * axes on purpose: schools are anchored in the room, so turning your head
   * must not swing them around with you.
   */
  private pointAtAngle(
    centre: vec3,
    angle: number,
    dist: number,
    height: number
  ): vec3 {
    const dir = new vec3(Math.sin(angle), 0, Math.cos(angle));
    return centre.add(dir.uniformScale(dist)).add(new vec3(0, height, 0));
  }

  private randomOffset(r: number): vec3 {
    return new vec3(
      (Math.random() - 0.5) * r * 2,
      (Math.random() - 0.5) * r,
      (Math.random() - 0.5) * r * 2
    );
  }

  private initSchools(camPos: vec3) {
    this.schoolAngle = [];
    this.schoolCentre = [];
    for (let s = 0; s < this.schoolCount; s++) {
      const a = (s / this.schoolCount) * Math.PI * 2;
      this.schoolAngle.push(a);
      this.schoolCentre.push(
        this.pointAtAngle(camPos, a, this.schoolMidCm, 0)
      );
    }
  }

  private cohesionForMood(): number {
    if (this.mood === MOOD_SPOOKED) return this.cohesionSpooked;
    if (this.mood === MOOD_CURIOUS) return this.cohesionCurious;
    return this.cohesionCalm;
  }

  private schoolDistanceForMood(): number {
    if (this.mood === MOOD_SPOOKED) return this.schoolFarCm;
    if (this.mood === MOOD_CURIOUS) return this.schoolNearCm;
    return this.schoolMidCm;
  }

  private updateSchools(dt: number, camPos: vec3) {
    const dist = this.schoolDistanceForMood();
    for (let s = 0; s < this.schoolCentre.length; s++) {
      // Counter rotating, so the two schools sweep past each other rather than
      // orbiting in lockstep.
      this.schoolAngle[s] +=
        dt * this.schoolDriftRate * (s % 2 === 0 ? 1 : -1);
      const target = this.pointAtAngle(
        camPos,
        this.schoolAngle[s],
        dist,
        0
      );
      this.schoolCentre[s] = vec3.lerp(
        this.schoolCentre[s],
        target,
        Math.min(1, dt * 0.6)
      );
    }
  }

  private setMood(m: number, camPos: vec3) {
    if (this.mood === m) return;
    this.mood = m;

    if (m === MOOD_SPOOKED) {
      this.moodUntil = this.elapsed + this.spookSeconds;
      print('LumiCatch: spooked, the schools are grouping tight and backing off');
    } else if (m === MOOD_CURIOUS) {
      this.moodUntil = this.elapsed + this.curiousSeconds;
      print('LumiCatch: curious, the schools are dispersing and coming closer');
    } else {
      print('LumiCatch: the schools have settled');
    }

    this.rehomeForMood(camPos);
  }

  /** Give every creature a new home suited to the current mood. */
  private rehomeForMood(camPos: vec3) {
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];

      if (this.mood === MOOD_CURIOUS) {
        // Break formation. Each one picks its own spot close in, all around
        // you, so you are surrounded by inquisitive individuals.
        const a = Math.random() * Math.PI * 2;
        const d = this.curiousDistanceCm * (0.8 + Math.random() * 0.5);
        c.home = this.pointAtAngle(
          camPos,
          a,
          d,
          (Math.random() - 0.35) * this.spawnHeightSpreadCm
        );
      } else {
        const spread =
          this.mood === MOOD_SPOOKED
            ? this.schoolSpreadCm * 0.5
            : this.schoolSpreadCm;
        c.home = this.schoolCentre[c.school].add(this.randomOffset(spread));
      }

      // Send them swimming to the new home rather than snapping, so the mood
      // change is something you can watch happen.
      if (c.state === ST_DRIFT) c.state = ST_RETURN;
      c.stateT = 0;
    }
  }

  /** Find the first RenderMeshVisual on an object or anywhere below it. */
  private findVisual(obj: SceneObject): RenderMeshVisual {
    const own = obj.getComponent('Component.RenderMeshVisual');
    if (own) return own;
    const n = obj.getChildrenCount();
    for (let i = 0; i < n; i++) {
      const found = this.findVisual(obj.getChild(i));
      if (found) return found;
    }
    return null;
  }

  /**
   * Colour a creature by kind. The material is cloned once per kind, because
   * every instance shares the prefab's material asset and tinting that
   * directly would recolour every creature at once.
   */
  private tint(obj: SceneObject, kind: number) {
    const visual = this.findVisual(obj);
    if (!visual) {
      if (!this.tintWarned) {
        this.tintWarned = true;
        print('LumiCatch: no RenderMeshVisual found on the creature prefab, cannot tint');
      }
      return;
    }

    if (!this.kindMaterials[kind]) {
      const base = visual.mainMaterial;
      if (!base) return;
      const cloned = base.clone();
      cloned.mainPass.baseColor =
        kind === KIND_LUMEN
          ? COL_LUMEN
          : kind === KIND_SKITTISH
          ? COL_SKITTISH
          : COL_DRIFTER;
      this.kindMaterials[kind] = cloned;
    }

    visual.mainMaterial = this.kindMaterials[kind];
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
    this.tint(obj, kind);

    const camT = this.camera.getTransform();
    const camPos = camT.getWorldPosition();

    // Alternate schools so the two stay balanced as creatures are caught and
    // respawned.
    const school =
      this.schoolCount > 0 ? this.creatures.length % this.schoolCount : 0;

    // Born into its school if schools exist, otherwise the plain ring.
    const home =
      this.schoolCentre.length > school
        ? this.schoolCentre[school].add(this.randomOffset(this.schoolSpreadCm))
        : this.pointInCone(
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
      school: school,
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

    this.updateCloaking();

    // Moods are timed, and lapse back to calm on their own.
    if (this.mood !== MOOD_CALM && this.elapsed > this.moodUntil) {
      this.setMood(MOOD_CALM, camPos);
    }
    this.updateSchools(dt, camPos);

    let nearestDist = Number.MAX_VALUE;
    let nearestKind = KIND_DRIFTER;
    let easyReady = false;

    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      c.stateT += dt;

      const toC = c.pos.sub(camPos);
      const dist = toC.length;
      const dir = dist > 0.0001 ? toC.normalize() : fwd;

      // Leash. The distance limit always applies so nothing escapes to the far
      // side of the room. The 'behind you' rule only applies when creatures are
      // meant to stay ahead: with spawnAllAround on, being behind you is the
      // whole point, so re-homing them would fight the design.
      const strayed =
        dist > this.leashMaxCm ||
        (!this.spawnAllAround && dir.dot(fwd) < -0.15);
      if (strayed) {
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
          // Cohesion pulls the creature towards its school centre. At 0 it
          // ignores the school entirely and drifts alone, which is what the
          // curious mood uses.
          let target = c.home.add(wob);
          const coh = this.cohesionForMood();
          if (coh > 0 && this.schoolCentre.length > c.school) {
            target = vec3.lerp(
              target,
              this.schoolCentre[c.school].add(wob),
              coh
            );
          }
          c.pos = vec3.lerp(
            c.pos,
            target,
            Math.min(1, dt * this.driftEaseRate)
          );
          if (this.canFlee(c) && dist < this.alertRangeCm * this.diffAlertMult) {
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
          c.pos = this.stepTowards(
            c.pos,
            c.fleeTarget,
            this.fleeSpeedCm * this.diffSpeedMult * dt
          );
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
          c.pos = this.stepTowards(
            c.pos,
            c.home,
            this.returnSpeedCm * this.diffSpeedMult * dt
          );
          if (c.pos.distance(c.home) < 15) {
            c.state = ST_DRIFT;
            c.stateT = 0;
          }
          break;
        }
      }

    }

    // Gentle separation, so two creatures never sit in the same spot. This is
    // the one overlap artefact you would actually notice on camera. At 14
    // creatures it is 91 pair checks a frame, which is nothing, and unlike a
    // full flocking simulation it leaves each creature's path predictable.
    if (this.separationCm > 0) {
      for (let i = 0; i < this.creatures.length; i++) {
        for (let j = i + 1; j < this.creatures.length; j++) {
          const a = this.creatures[i];
          const b = this.creatures[j];
          const delta = b.pos.sub(a.pos);
          const len = delta.length;
          if (len > 0.0001 && len < this.separationCm) {
            const push = delta.uniformScale(
              ((this.separationCm - len) * 0.5) / len
            );
            a.pos = a.pos.sub(push);
            b.pos = b.pos.add(push);
          }
        }
      }
    }

    // Apply transforms once positions have settled. Yaw spin plus bell pulse,
    // no billboarding: a wrong facing axis is invisible in the editor and
    // obvious on video.
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
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

      const toC2 = c.pos.sub(camPos);
      const dist2 = toC2.length;
      const dir2 = dist2 > 0.0001 ? toC2.normalize() : fwd;

      if (dist2 < nearestDist) {
        nearestDist = dist2;
        nearestKind = c.kind;
      }
      if (
        c.kind === KIND_DRIFTER &&
        dist2 < this.captureRangeCm &&
        dir2.dot(fwd) >= this.captureConeDot
      ) {
        easyReady = true;
      }
    }

    // Guarantee: never let the player stand there with nothing catchable.
    // Suspended while spooked, since backing off is the whole point of that
    // mood and dragging one back would fight it. Spook only lasts a few
    // seconds and only follows a run of successful catches, so the take is
    // never left stranded.
    if (this.guaranteeEasyTarget && this.mood !== MOOD_SPOOKED) {
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

    // Proximity haptic, edge triggered. It fires when something arrives, not
    // continuously while it loiters, otherwise the net buzzes every couple of
    // seconds all demo long and the capture buzz stops feeling special.
    // The 1.25 multiplier is hysteresis, so a creature hovering on the
    // boundary cannot chatter the motor on and off.
    if (!this.nearbyActive && nearestDist < this.nearbyRangeCm) {
      this.nearbyActive = true;
      if (this.elapsed - this.lastNearbyPing > this.nearbyCooldownS) {
        this.lastNearbyPing = this.elapsed;
        this.sendHaptic(nearestKind === KIND_LUMEN ? 2 : 1);
      }
    } else if (this.nearbyActive && nearestDist > this.nearbyRangeCm * 1.25) {
      this.nearbyActive = false;
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

    return c.pos.add(
      fleeDir.uniformScale(this.fleeDistanceCm * boost * this.diffEvasionMult)
    );
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

    this.sendResult(bestIdx >= 0);

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
      // Checked before mercy, because mercy resets the counter.
      if (this.consecutiveMisses >= this.curiousMisses) {
        this.setMood(MOOD_CURIOUS, camPos);
      }
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

    // Back to back catches spook the shoal.
    this.catchTimes.push(this.elapsed);
    while (
      this.catchTimes.length > 0 &&
      this.elapsed - this.catchTimes[0] > this.spookWindowS
    ) {
      this.catchTimes.shift();
    }
    if (this.catchTimes.length >= this.spookCatches) {
      this.catchTimes = [];
      this.setMood(MOOD_SPOOKED, this.camera.getTransform().getWorldPosition());
    }

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
