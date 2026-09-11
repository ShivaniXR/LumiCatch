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
import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';

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

  // The AudioComponent's track cannot be assigned from the editor API, so the
  // tracks come in as assets and the script wires them up at start. Same
  // reason the material colours are applied in code.
  @input('Asset.AudioTrackAsset') @allowUndefined captureTrack: AudioTrackAsset;
  @input('Asset.AudioTrackAsset') @allowUndefined ambientTrack: AudioTrackAsset;
  @input captureVolume: number = 1.0;
  @input ambientVolume: number = 0.4;

  @input serverUrl: string = 'ws://192.168.1.50:8765';
  @input simulate: boolean = true;
  @input usePinchToSwing: boolean = true;

  // Fallback for a dead net IMU. With this on, a pinch fires a swing even
  // while connected to the net, so the game stays fully playable: the net
  // still buzzes on capture, the board still runs its difficulty model, and
  // the dashboard still shows live sessions. Only the trajectory predictor
  // is lost, because that is the one thing that genuinely needs the IMU.
  @input pinchAsSwing: boolean = false;

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

  // ---- Sense strand (the AI, made visible) ----
  // The net's own bioluminescence rather than a readout. It takes the same
  // colours as the creatures so it belongs to the world: cyan when the shoal
  // is calm, violet when curious, gold when spooked. Its glow extends with
  // difficulty, and a mote runs along it the instant the board predicts a
  // swing. Everything is positioned by script, because editor-side transforms
  // on camera children do not survive a reload.
  @input('Component.Text') @allowUndefined moodText: Text;
  @input hudDistanceCm: number = 100;   // sits on the 1 m focus plane
  @input hudWidthCm: number = 30;
  @input hudYCm: number = -20;
  @input hudMoteCount: number = 11;
  @input hudMoteBaseCm: number = 2.2;
  @input hudMoteLitCm: number = 4.5;
  @input hudArcCm: number = 2.5;        // gentle droop, like a resting strand
  @input pulseTravelS: number = 0.7;
  @input moodHoldS: number = 2.6;
  @input scoreScale: number = 1.5;
  @input moodScale: number = 0.95;

  // ---- Start screen ----
  // An attract state: creatures drift dimmed behind a title and a button until
  // the player begins. It exists as much for filming as for the player, since
  // it lets every take start clean instead of mid-flight.
  @input requireStart: boolean = true;
  @input('SceneObject') @allowUndefined startTitle: SceneObject;
  @input('Component.Text') @allowUndefined startTitleText: Text;
  @input('Component.Text') @allowUndefined startStatusText: Text;
  @input('SceneObject') @allowUndefined startButton: SceneObject;
  @input('Component.Text') @allowUndefined startButtonText: Text;
  @input startTitleLabel: string = 'NEON-NET';
  @input startButtonLabel: string = 'BEGIN';
  @input attractDim: number = 0.45;     // creature brightness before starting
  @input plateRadius: number = 2.2;     // corner rounding on title and button
  @input plateMargin: number = 2.4;

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

  // Sense strand runtime state.
  private motes: SceneObject[] = [];
  private moteMats: Material[] = [];
  private pulseT: number = -1;
  private moodFadeT: number = -1;
  private moodLabel: string = '';
  // Stand-in for the board's adaptive model while running in simulate mode,
  // so the strand is alive in preview instead of sitting dark at zero.
  private simOutcomes: boolean[] = [];
  private started: boolean = false;
  private pressT: number = -1;          // button press animation, seconds
  private startMats: Material[] = [null, null];   // button body, title

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
    this.buildHud();
    this.bindStartButton();
    const hudReport = this.createEvent('DelayedCallbackEvent');
    hudReport.bind(() => this.reportHud());
    hudReport.reset(1.0);

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

    this.setupAudio();

    if (this.simulate) {
      print('LumiCatch: SIMULATE mode. Click in preview or pinch on device. No hardware needed.');
    } else {
      this.connect();
    }
  }

  /**
   * Attach the tracks and start the bed. The capture chime is spatialised, so
   * it plays from wherever the creature was rather than flatly in your head:
   * catch one on your left and you hear it on your left. That is the '3D
   * spatial audio' the design calls for, not a stereo sound effect.
   */
  private setupAudio() {
    if (this.captureSound) {
      if (this.captureTrack) this.captureSound.audioTrack = this.captureTrack;
      this.captureSound.volume = this.captureVolume;
      try {
        this.captureSound.spatialAudio.enabled = true;
      } catch (e) {
        print('LumiCatch: spatial audio unavailable, chime will play flat');
      }
    }

    if (this.ambientSound) {
      if (this.ambientTrack) this.ambientSound.audioTrack = this.ambientTrack;
      this.ambientSound.volume = this.ambientVolume;
      // The bed is deliberately NOT spatialised. It is the sea around you,
      // not an object in it, so it should not swing about as you turn.
      try {
        this.ambientSound.spatialAudio.enabled = false;
      } catch (e) {
        // older runtimes may not expose it, harmless
      }
      this.ambientSound.play(-1);   // -1 = loop forever
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
    // While the start screen is up, swings do nothing. Starting requires
    // actually hitting the button, via the Interactable below.
    if (this.requireStart && !this.started) return;

    // Normally only in simulate mode, but pinchAsSwing keeps it live while
    // connected, which is what rescues a demo with a broken sensor.
    if (!this.simulate && !this.pinchAsSwing) return;
    // Click and pinch can both fire on the same gesture, so debounce to
    // roughly match the firmware's DEBOUNCE_MS.
    if (this.elapsed - this.lastSimSwing < 0.4) return;
    this.lastSimSwing = this.elapsed;
    print(
      this.simulate
        ? 'LumiCatch: simulated swing'
        : 'LumiCatch: pinch swing (IMU bypassed)'
    );
    this.fireWave();
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
      this.onPredicted(data.etaMs || 0);
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
      // No board attached, so keep a local history for the strand to read.
      this.simOutcomes.push(hit);
      if (this.simOutcomes.length > 8) this.simOutcomes.shift();
      print('LumiCatch: [sim] result ' + (hit ? 'hit' : 'miss'));
      return;
    }
    if (this.connected && this.socket) {
      // Mood rides along so the App Lab dashboard can show the real shoal
      // state per player rather than guessing it from the difficulty number.
      const mood =
        this.mood === MOOD_SPOOKED
          ? 'spooked'
          : this.mood === MOOD_CURIOUS
          ? 'curious'
          : 'calm';
      this.socket.send(
        JSON.stringify({ type: 'result', hit: hit, mood: mood })
      );
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
    // Before the game begins the whole shoal is dimmed, so the start screen
    // reads clearly against them and the moment of starting has some lift.
    const attract =
      this.requireStart && !this.started ? this.attractDim : 1.0;

    for (let i = 0; i < this.kindMaterials.length; i++) {
      if (i === KIND_LUMEN) continue;    // handled below, it also cloaks
      const m = this.kindMaterials[i];
      if (!m) continue;
      const base = i === KIND_SKITTISH ? COL_SKITTISH : COL_DRIFTER;
      m.mainPass.baseColor = new vec4(
        base.r * attract, base.g * attract, base.b * attract, base.a
      );
    }

    const mat = this.kindMaterials[KIND_LUMEN];
    if (!mat) return;

    let k = attract;
    if (this.diffCloaking) {
      // Dip to roughly 15 per cent brightness and back, about once a second.
      const wave = 0.5 * (1 + Math.sin(this.elapsed * 2.1));
      k = (0.15 + 0.85 * wave * wave) * attract;
    }

    mat.mainPass.baseColor = new vec4(
      COL_LUMEN.r * k,
      COL_LUMEN.g * k,
      COL_LUMEN.b * k,
      COL_LUMEN.a
    );
  }

  // ---------------- Start screen ----------------

  /**
   * Subscribe to the button's Interactable. This is real SIK hit targeting:
   * the button carries a collider and an Interactable, and onTriggerEnd only
   * fires when an interactor actually resolved to this object. Pinching at
   * thin air does nothing.
   */
  private bindStartButton() {
    if (!this.startButton) return;
    const it = this.startButton.getComponent(Interactable.getTypeName());
    if (!it) {
      print('LumiCatch: StartButton has no Interactable, cannot be pressed');
      return;
    }
    it.onTriggerEnd.add(() => {
      if (!this.started) {
        this.pressT = 0;
        this.beginGame();
      }
    });
    print('LumiCatch: start button armed');
  }

  private beginGame() {
    this.started = true;
    this.score = 0;
    this.updateScore(0);
    this.simOutcomes = [];

    // Everything the start screen was holding back now comes up: the shoal
    // returns to full brightness, the strand lights, the score appears and
    // swings start counting. updateStartScreen hides the panel on this frame.
    this.moodLabel = 'they drift all around you';
    this.moodFadeT = 0;

    print(
      'LumiCatch: game started, ' + this.creatures.length +
      ' creatures live, strand and score on'
    );
  }

  /** Show the connection state on the start screen, where eyes already are. */
  private startStatusLine(): string {
    if (this.simulate) return 'practice mode';
    return this.connected ? 'net connected' : 'looking for the net...';
  }

  /**
   * Give a Text component a rounded background plate. Lens Studio's Text has
   * a built in background with a corner radius, which is a far better way to
   * get rounded edges than trying to build them from a box mesh.
   */
  private plate(t: Text, col: vec4, alpha: number, radius: number, margin: number) {
    const bg = t.backgroundSettings;
    bg.enabled = true;
    bg.cornerRadius = radius;
    bg.margins.left = margin;
    bg.margins.right = margin;
    bg.margins.top = margin * 0.6;
    bg.margins.bottom = margin * 0.6;
    bg.fill.color = new vec4(col.r, col.g, col.b, alpha);
  }

  private updateStartScreen(dt: number) {
    const showing = this.requireStart && !this.started;

    // Title
    if (this.startTitle) this.startTitle.enabled = showing;
    if (this.startTitleText && showing) {
      const t = this.startTitleText.getSceneObject().getTransform();
      t.setLocalPosition(new vec3(0, 16, -this.hudDistanceCm));
      t.setLocalScale(new vec3(1.9, 1.9, 1.9));
      this.startTitleText.text = this.startTitleLabel;
      this.startTitleText.textFill.color = new vec4(
        COL_DRIFTER.r, COL_DRIFTER.g, COL_DRIFTER.b, 1
      );
      // Dark rounded backplate, so the title reads against drifting creatures.
      this.plate(
        this.startTitleText,
        new vec4(0.02, 0.07, 0.10, 1),
        0.72,
        this.plateRadius,
        this.plateMargin
      );
    }

    // Status
    if (this.startStatusText) {
      this.startStatusText.getSceneObject().enabled = showing;
      if (showing) {
        const t = this.startStatusText.getSceneObject().getTransform();
        t.setLocalPosition(new vec3(0, -14, -this.hudDistanceCm));
        t.setLocalScale(new vec3(0.75, 0.75, 0.75));
        this.startStatusText.text = this.startStatusLine();
        const ok = this.simulate || this.connected;
        const c = ok ? COL_DRIFTER : COL_LUMEN;
        // A slow pulse while searching, steady once connected.
        const k = ok ? 1.0 : 0.55 + 0.45 * Math.sin(this.elapsed * 3.0);
        this.startStatusText.textFill.color = new vec4(c.r, c.g, c.b, k);
      }
    }

    // Button
    if (this.startButton) {
      this.startButton.enabled = showing;
      if (showing) {
        let press = 0;
        if (this.pressT >= 0) {
          this.pressT += dt;
          if (this.pressT > 0.25) this.pressT = -1;
          else press = 1 - this.pressT / 0.25;
        }
        const t = this.startButton.getTransform();
        const w = 20 - press * 2.5;   // squashes in when pressed
        t.setLocalPosition(new vec3(0, 2, -this.hudDistanceCm));
        t.setLocalScale(new vec3(w, 7 - press * 0.8, 1.2));
        t.setLocalRotation(quat.quatIdentity());

        // The box mesh is the hit volume only. What you see is the label's
        // rounded plate, because a box cannot have rounded corners.
        const visual = this.findVisual(this.startButton);
        if (visual) visual.enabled = false;
      }
    }

    if (this.startButtonText) {
      this.startButtonText.getSceneObject().enabled = showing;
      if (showing) {
        const t = this.startButtonText.getSceneObject().getTransform();
        t.setLocalPosition(new vec3(0, 2, -this.hudDistanceCm + 2));
        t.setLocalScale(new vec3(0.8, 0.8, 0.8));
        this.startButtonText.text = this.startButtonLabel;
        this.startButtonText.textFill.color = new vec4(0.02, 0.06, 0.08, 1);

        let press = 0;
        if (this.pressT >= 0) press = 1 - Math.min(1, this.pressT / 0.25);
        const glow = 0.62 + 0.12 * Math.sin(this.elapsed * 1.8) + press * 0.38;
        this.plate(
          this.startButtonText,
          new vec4(
            Math.min(1, COL_DRIFTER.r * glow + press * 0.4),
            Math.min(1, COL_DRIFTER.g * glow),
            Math.min(1, COL_DRIFTER.b * glow),
            1
          ),
          Math.min(1, 0.88 + press * 0.12),
          this.plateRadius,
          this.plateMargin * 1.5
        );
      }
    }
  }

  // ---------------- Sense strand ----------------
  //
  // A drift of bioluminescent motes low in the view, not a bar. How far the
  // glow reaches along them is how alert the shoal has become; a bright wave
  // runs their length the instant a swing is sensed. Built from the creature
  // prefab itself, so the strand is literally made of the same light as the
  // jellyfish, and so it needs no scene objects and no Inspector wiring.

  /** The shoal's mood as a colour, borrowed from the creatures themselves. */
  private moodColour(): vec4 {
    if (this.mood === MOOD_SPOOKED) return COL_LUMEN;
    if (this.mood === MOOD_CURIOUS) return COL_SKITTISH;
    return COL_DRIFTER;
  }

  private buildHud() {
    if (!this.creaturePrefab || !this.camera) return;
    const parent = this.camera.getSceneObject();

    for (let i = 0; i < this.hudMoteCount; i++) {
      const mote = this.creaturePrefab.instantiate(parent);
      const visual = this.findVisual(mote);
      let mat: Material = null;
      if (visual && visual.mainMaterial) {
        mat = visual.mainMaterial.clone();
        // Real transparency rather than fading towards black. Depth writing
        // off so overlapping motes blend instead of punching holes in
        // each other.
        mat.mainPass.blendMode = BlendMode.Normal;
        mat.mainPass.depthWrite = false;
        visual.mainMaterial = mat;
      }
      this.motes.push(mote);
      this.moteMats.push(mat);
    }

    print(
      'LumiCatch: built ' + this.motes.length + ' sense motes, ' +
      this.moteMats.filter((m) => m !== null).length + ' with their own material'
    );
  }

  /** One-shot report so an invisible strand can be diagnosed from the log. */
  private reportHud() {
    if (this.motes.length === 0) {
      print('LumiCatch: HUD has no motes. creaturePrefab or camera was missing.');
      return;
    }
    const t = this.motes[0].getTransform();
    const wp = t.getWorldPosition();
    const ws = t.getWorldScale();
    const camPos = this.camera.getTransform().getWorldPosition();
    const toMote = wp.sub(camPos);
    const ahead = toMote.normalize().dot(this.camForward());
    print(
      'LumiCatch: mote 0 world scale ' + ws.x.toFixed(2) +
      ' cm, ' + toMote.length.toFixed(0) + ' cm away, ' +
      (ahead > 0 ? 'IN FRONT' : 'BEHIND (flip hudDistanceCm)')
    );
  }

  /**
   * How far the glow reaches, 0 to 1. Off the board when connected; in
   * simulate mode a local stand-in, so the strand still responds to how you
   * are playing while there is no hardware attached.
   */
  private hudLevel(): number {
    if (!this.simulate) return this.diffLevel;
    if (this.simOutcomes.length < 3) return 0.35;
    let hits = 0;
    for (let i = 0; i < this.simOutcomes.length; i++) {
      if (this.simOutcomes[i]) hits++;
    }
    return Math.max(0, Math.min(1, hits / this.simOutcomes.length));
  }

  /** Send a wave down the strand. */
  private fireWave() {
    this.pulseT = 0;
  }

  /** The board has seen a swing coming. */
  private onPredicted(etaMs: number) {
    this.fireWave();
    this.moodLabel = 'sensed  +' + Math.round(etaMs) + 'ms';
    this.moodFadeT = 0;
  }

  private updateHud(dt: number) {
    const n = this.motes.length;
    if (n === 0) return;

    const col = this.moodColour();
    const half = this.hudWidthCm * 0.5;
    const reach = Math.max(0.04, this.hudLevel()) * n;

    // Wave position along the strand, negative when idle.
    let wave = -1;
    if (this.pulseT >= 0) {
      this.pulseT += dt;
      const p = this.pulseT / this.pulseTravelS;
      if (p >= 1) this.pulseT = -1;
      else wave = p * n;
    }

    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0.5 : i / (n - 1);
      const x = -half + this.hudWidthCm * f;

      // Shallow droop, so it hangs like a strand rather than ruling a line.
      const across = 2 * f - 1;
      const droop = -this.hudArcCm * (1 - across * across);
      const bob = Math.sin(this.elapsed * 1.1 + i * 0.7) * 0.45;

      // Soft edge instead of a hard step, so the glow tapers off.
      const lit = Math.max(0, Math.min(1, reach - i));

      // The wave flares each mote as it passes.
      let flare = 0;
      if (wave >= 0) {
        const d = Math.abs(wave - i);
        if (d < 1.8) {
          const k = 1 - d / 1.8;
          flare = k * k;
        }
      }

      const size =
        this.hudMoteBaseCm +
        (this.hudMoteLitCm - this.hudMoteBaseCm) * Math.min(1, lit + flare);

      const t = this.motes[i].getTransform();
      t.setLocalPosition(
        new vec3(x, this.hudYCm + droop + bob, -this.hudDistanceCm)
      );
      t.setLocalScale(new vec3(size, size, size));

      const mat = this.moteMats[i];
      if (mat) {
        const toWhite = Math.min(1, flare * 1.3);
        mat.mainPass.baseColor = new vec4(
          col.r + (1 - col.r) * toWhite,
          col.g + (1 - col.g) * toWhite,
          col.b + (1 - col.b) * toWhite,
          Math.min(1, 0.28 + 0.62 * lit + 0.8 * flare)
        );
      }
    }

    // A whisper under the strand, only when something changed, fading out so
    // the view stays clear for the creatures.
    if (this.moodText) {
      const mt = this.moodText.getSceneObject().getTransform();
      mt.setLocalPosition(
        new vec3(0, this.hudYCm - this.hudArcCm - 7, -this.hudDistanceCm)
      );
      mt.setLocalScale(
        new vec3(this.moodScale, this.moodScale, this.moodScale)
      );

      let k = 0;
      if (this.moodFadeT >= 0) {
        this.moodFadeT += dt;
        if (this.moodFadeT >= this.moodHoldS) {
          this.moodFadeT = -1;
        } else {
          const p = this.moodFadeT / this.moodHoldS;
          k = p < 0.12 ? p / 0.12 : 1 - (p - 0.12) / 0.88;
        }
      }
      this.moodText.text = this.moodLabel;
      this.moodText.textFill.color = new vec4(col.r, col.g, col.b, k);
    }

    // Score sits above the strand, script owned like everything else.
    if (this.scoreText) {
      const st = this.scoreText.getSceneObject().getTransform();
      st.setLocalPosition(new vec3(0, this.hudYCm + 11, -this.hudDistanceCm));
      st.setLocalScale(
        new vec3(this.scoreScale, this.scoreScale, this.scoreScale)
      );
    }
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
      this.moodLabel = 'the shoal scatters';
      print('LumiCatch: spooked, the schools are grouping tight and backing off');
    } else if (m === MOOD_CURIOUS) {
      this.moodUntil = this.elapsed + this.curiousSeconds;
      this.moodLabel = 'they drift closer';
      print('LumiCatch: curious, the schools are dispersing and coming closer');
    } else {
      this.moodLabel = 'the water settles';
      print('LumiCatch: the schools have settled');
    }
    this.moodFadeT = 0;

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
    this.updateStartScreen(dt);
    this.updateHud(dt);

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
    // Nothing is catchable until the player has begun.
    if (this.requireStart && !this.started) return;

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

    if (this.captureSound) {
      // Move the emitter to where the creature was, so the spatialised chime
      // comes from the right direction.
      this.captureSound.getSceneObject().getTransform().setWorldPosition(pos);
      this.captureSound.play(1);
    }

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
