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

  // ---- Swing quality: sneak or lunge ----
  //
  // The firmware has always sent the swing's peak in g, and the game used to
  // print it and throw it away. Every swing was therefore identical, which
  // made the net an expensive button. Now how hard you swing is the decision
  // the whole game turns on:
  //
  //   a sneak   short reach, and only a creature you practically brushed
  //             past notices
  //   a lunge   nearly double the reach, but it is loud: everything close by
  //             wakes up, and a woken creature cannot be caught
  //
  // Thresholds are in g and must be re-measured on the assembled net. Walking
  // already reads 2 to 3 g, so the gentle band sits above that, not below it.
  @input useSwingQuality: boolean = true;   // off restores the old flat reach
  @input gentleSwingG: number = 4.6;        // under this is a sneak
  @input sneakRangeCm: number = 85;
  @input lungeRangeCm: number = 170;
  @input sneakSpookCm: number = 40;         // a sneak disturbs almost nothing
  @input lungeSpookCm: number = 120;        // a lunge wakes the neighbourhood

  // ---- The catch, made to land ----
  // A catch used to be obj.destroy(): the creature blinked out and left
  // nothing to react to. Now it rushes into the net and shrinks away, with a
  // burst of motes thrown off. burstPrefab is the old sphere creature prefab,
  // so this costs no new assets.
  @input catchFlyS: number = 0.2;           // how long the rush into the net takes
  @input catchFlyToCm: number = 35;         // how close to the face it ends
  @input burstMotes: number = 6;
  @input burstSpreadCm: number = 26;
  @input burstLifeS: number = 0.45;
  @input burstMoteScale: number = 3.0;      // world scale, tune if motes look wrong

  // ---- Chains ----
  // Catches inside the window multiply. This existed as a flat, invisible x2;
  // now it escalates and shows on the score line so it is worth chasing.
  @input comboWindowS: number = 4.0;
  @input comboMax: number = 4;

  // ---- The bloom finale ----
  // A round used to feel the same at second 5 and second 55. The last stretch
  // now turns into a feeding frenzy: extra creatures, everything worth more.
  // This is mostly for the film, which needs a climax rather than a stop.
  @input bloomSeconds: number = 15;         // 0 disables the finale
  @input bloomSpawnCount: number = 6;
  @input bloomMultiplier: number = 2;

  // ---- Creature mix ----
  @input rareChance: number = 0.22;
  @input skittishChance: number = 0.35;
  // Tuned against the skeleton, measured: the creature spans 33.2 cm tall at
  // scale 0.10, so 0.06 puts it at roughly 20 cm, about a large grapefruit.
  // Big enough to read at 1 to 3 m on a 27 degree display, and comfortably
  // smaller than the net hoop so catches look precise.
  //
  // Do NOT tune this against a bounding box. worldAabbMin/Max on a skinned
  // mesh returns the rest pose, which for this model is a flat wide slab and
  // nothing like the upright creature on screen. The startup log measures the
  // posed bones instead, and runs slightly small since the mesh skins a little
  // beyond them.
  @input creatureScale: number = 0.06;
  @input rareScaleMult: number = 1.35;

  // The unlit neon material every creature is tinted from. Set this when the
  // creature prefab is an imported model, so the model's own realistic
  // material is replaced rather than tinted. Leave it empty and the prefab's
  // own material is used instead.
  @input('Asset.Material') @allowUndefined neonMaterial: Material;

  // Corrects an imported model's rest orientation, in degrees about X.
  //
  // For THIS model the correct value is 0: Lens Studio's importer already
  // resolves the glTF axis chain, and the prefab arrives upright. It is kept as
  // an input only because a different model may not.
  //
  // Left here as a warning. Three separate 'corrections' were applied to this
  // value before settling on doing nothing, because two different measurements
  // both reported the creature was upright when it was plainly lying on its
  // side on screen:
  //
  //   worldAabbMin/Max  on a SKINNED mesh these return the REST POSE bounds
  //                     transformed by the object matrix, not the vertices
  //                     being drawn. Useless for orientation, and useless for
  //                     size too.
  //   a single bone pair Bone_00 to Bone.001_end_010 is a short bone inside
  //                     the bell. A real direction that means nothing.
  //
  // The startup log now measures the root joint against the average of every
  // leaf bone, which is the direction the tentacles actually hang. Upright
  // reads as roughly (0, -1, 0). Trust that line, and trust your eyes over any
  // bounding box.
  @input modelUprightDeg: number = 0;

  // How solid a creature is, 0 transparent to 1 opaque.
  //
  // The spheres were opaque and it did not matter: a sphere silhouette is a
  // sphere whichever way you turn it. A jellyfish is almost all silhouette, so
  // at alpha 1 the model renders as a featureless neon blob with no bell, no
  // tentacles and no way to tell which way up it is. The source model ships
  // translucent for exactly this reason. This is what makes it read as a
  // jellyfish rather than a balloon.
  @input creatureOpacity: number = 0.55;

  // Jellyfish do not hang in a rigid grid, they drift at slight angles. A few
  // degrees of lean, fixed per creature so it does not wobble, stops the shoal
  // looking like a formation. 0 makes every one perfectly vertical.
  @input tiltVarietyDeg: number = 16;

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
  // How fast to play the model's own swim cycle. 1.0 is the clip as authored,
  // which is far too slow to see at this size. 0 leaves it untouched.
  @input swimSpeed: number = 2.2;

  // A whole-body breathing pulse, on top of the skeletal swim.
  //
  // This was 0.12 for the spheres, then set to 0 on the grounds that a real
  // animation made it redundant. That was wrong: measuring the skeleton showed
  // the swim cycle moves about 1.6 cm in 1.6 s, which is invisible on a 20 cm
  // creature at arm's length on this display. A small scale pulse is what
  // actually makes the shoal look alive, so it is back, gentler than before.
  @input pulseAmount: number = 0.07;
  @input spinRate: number = 0.35;            // radians per second

  // ---- Room bounds ----
  // A play volume, not true wall detection. Creature positions are clamped to
  // a cylinder centred where the player stood when the round began, which
  // stops them drifting through walls and furniture in a normal room.
  //
  // Real geometry awareness would use the Spectacles World Mesh and a raycast
  // per creature. That is the proper fix and the obvious upgrade, but it is a
  // far bigger job than clamping a radius.
  // World mesh is the real fix: cast a ray from the player to each creature
  // and see whether anything solid is in the way. The play volume below stays
  // on as a backstop, because it costs nothing and covers the case where the
  // room has not been scanned yet.
  @input useWorldMesh: boolean = true;
  @input wallMarginCm: number = 25;     // keep this far off any surface
  @input useRoomBounds: boolean = true;
  @input roomRadiusCm: number = 170;    // horizontal reach from the centre
  @input roomCeilingCm: number = 55;    // above head height
  @input roomFloorCm: number = 110;     // below head height

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

  // ---- Readouts (the AI, made visible) ----
  // There used to be a 'sense strand' here: an arc of glowing motes low in the
  // view that carried mood, difficulty and prediction all at once. It was
  // pretty and it was unreadable. The first playtest verdict was 'the ui at the
  // bottom that changes colour blue orange etc whats that for?', and after the
  // readouts below were added it was simply redundant clutter on a 27 degree
  // display, so it was cut. Each piece of the AI now gets its OWN labelled
  // readout, positioned by script, because editor-side transforms on camera
  // children do not survive a reload.
  @input('Component.Text') @allowUndefined moodFaceText: Text;
  @input('Component.Text') @allowUndefined predictFlashText: Text;
  @input('Component.Text') @allowUndefined catchPopupText: Text;
  @input('Component.Text') @allowUndefined difficultyLabelText: Text;

  // Faces as plain characters rather than emoji, because the default Lens
  // Studio font has no emoji glyphs and you would get empty boxes. Change
  // these in the Inspector if your font does support them.
  @input moodFaceCalm: string = '^_^';
  @input moodFaceCurious: string = 'o_o';
  @input moodFaceSpooked: string = '>_<';
  @input hudDistanceCm: number = 100;   // sits on the 1 m focus plane
  @input hudWidthCm: number = 30;       // how far apart the corner readouts sit
  @input hudYCm: number = -20;
  @input scoreScale: number = 1.5;

  // ---- Start screen ----
  // An attract state: creatures drift dimmed behind a title and a button until
  // the player begins. It exists as much for filming as for the player, since
  // it lets every take start clean instead of mid-flight.
  @input requireStart: boolean = true;
  @input roundSeconds: number = 60;     // 0 disables the timer entirely
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
  // Creatures mid-flight into the net, and the motes thrown off a catch.
  // Neither is in this.creatures any more, so only updateCaught touches them.
  private caught: { obj: SceneObject; t: number; from: vec3; scale: number }[] = [];
  private motes: { obj: SceneObject; t: number; from: vec3; dir: vec3 }[] = [];
  private comboCount: number = 0;
  private comboUntil: number = -1;
  private bloomActive: boolean = false;
  private bloomAnnounced: boolean = false;
  private firstSpan: vec3 = null;      // for the animation check at startup
  private schoolAngle: number[] = [];
  private schoolCentre: vec3[] = [];

  // Live difficulty, pushed from the UNO Q's adaptive model. All multipliers,
  // so the Lens keeps its own tuned baselines and the board only scales them.
  private diffLevel: number = 0;
  private diffSpeedMult: number = 1.0;
  private diffEvasionMult: number = 1.0;
  private diffAlertMult: number = 1.0;
  private diffCloaking: boolean = false;

  // Stand-in for the board's adaptive model while running in simulate mode, so
  // the readouts are alive in preview instead of sitting dark at zero.
  private simOutcomes: boolean[] = [];
  private started: boolean = false;
  private roundLeft: number = 0;
  private roomCentre: vec3 = null;      // where the player stood at kick off
  private hitSession: any = null;
  private wallCheckIdx: number = 0;
  private wallPushes: number = 0;
  private predictFlashT: number = -1;
  private predictLabel: string = '';
  private catchPopT: number = -1;
  private catchLabel: string = '';
  private roundOver: boolean = false;
  private bestScore: number = 0;
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
    this.bindStartButton();
    this.setupWorldMesh();
    const sizeReport = this.createEvent('DelayedCallbackEvent');
    sizeReport.bind(() => this.reportCreatureSize());
    sizeReport.reset(1.0);

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
      // Score travels too, because it is POINTS and the dashboard counts
      // landed swings. Two different numbers, so the dashboard shows both.
      this.socket.send(
        JSON.stringify({
          type: 'result', hit: hit, mood: mood, score: this.score
        })
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
        base.r * attract, base.g * attract, base.b * attract,
        this.creatureOpacity
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
      this.creatureOpacity
    );
  }

  // ---------------- Start screen ----------------

  /**
   * Subscribe to the button's Interactable. This is real SIK hit targeting:
   * the button carries a collider and an Interactable, and onTriggerEnd only
   * fires when an interactor actually resolved to this object. Pinching at
   * thin air does nothing.
   */
  /**
   * Bring up world mesh hit testing. Built in modules are reachable through
   * the 'LensStudio:' prefix, so this needs no asset wiring, the same trick
   * that gets the Internet Module.
   */
  private setupWorldMesh() {
    if (!this.useWorldMesh) return;
    try {
      const wqm = require('LensStudio:WorldQueryModule');
      this.hitSession = wqm.createHitTestSession();
      this.hitSession.start();
      print('LumiCatch: world mesh hit testing active');
    } catch (e) {
      this.hitSession = null;
      print('LumiCatch: no world mesh available, using the play volume only');
    }
  }

  /**
   * Check one creature per frame against the room geometry. A ray from the
   * player to the creature that hits something first means the creature is
   * inside a wall or a sofa, so it gets pulled back in front of the surface.
   *
   * One per frame on purpose: fourteen raycasts every frame would be wasteful,
   * and creatures drift slowly enough that checking each one about three times
   * a second is ample.
   */
  private checkWalls(camPos: vec3) {
    if (!this.hitSession || this.creatures.length === 0) return;

    this.wallCheckIdx = (this.wallCheckIdx + 1) % this.creatures.length;
    const c = this.creatures[this.wallCheckIdx];
    const toC = c.pos.sub(camPos);
    const len = toC.length;
    if (len < 20) return;

    // Probe slightly past the creature, so a wall sitting right at it counts.
    const end = camPos.add(
      toC.uniformScale((len + this.wallMarginCm) / len)
    );

    this.hitSession.hitTest(camPos, end, (hit) => {
      if (!hit || !hit.position) return;
      // The array may have changed while the hit test was in flight, so work
      // from the object rather than the index.
      if (this.creatures.indexOf(c) < 0) return;

      const d = hit.position.distance(camPos);
      if (d >= len) return;               // the surface is behind it, fine

      const pull = Math.max(this.spawnMinCm * 0.5, d - this.wallMarginCm);
      const p = camPos.add(toC.uniformScale(pull / len));
      c.pos = p;
      c.home = p;                          // or it swims straight back in
      this.wallPushes++;
    });
  }

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

  /** Count the round down, and end it cleanly when time runs out. */
  private updateRound(dt: number) {
    // With the start gate off there is no button to press, so the round has to
    // begin on its own. beginGame() was only ever reachable from the button,
    // which meant requireStart=false silently disabled the timer, the bloom
    // and the score reset. That is precisely the fallback you would reach for
    // if the button misbehaved on the day, so it needs to work.
    if (!this.requireStart && !this.started && !this.roundOver) {
      this.beginGame();
    }

    if (!this.started || this.roundOver || this.roundSeconds <= 0) return;

    this.roundLeft -= dt;

    // The bloom. For the last stretch the shoal swarms: extra creatures
    // arrive and everything is worth more. Announced with its own popup and
    // the rare-creature haptic, so the player feels it start without reading.
    if (
      !this.bloomAnnounced &&
      this.bloomSeconds > 0 &&
      this.roundLeft <= this.bloomSeconds
    ) {
      this.bloomAnnounced = true;
      this.bloomActive = true;
      for (let i = 0; i < this.bloomSpawnCount; i++) this.spawnCreature(-1);
      this.catchLabel = 'BLOOM\nx' + this.bloomMultiplier + '  ALL';
      this.catchPopT = 0;
      this.sendHaptic(2);
      print(
        'LumiCatch: bloom, +' + this.bloomSpawnCount + ' creatures, x' +
        this.bloomMultiplier + ' points'
      );
    }

    if (this.roundLeft > 0) return;

    this.roundLeft = 0;
    this.roundOver = true;
    if (this.score > this.bestScore) this.bestScore = this.score;

    // Back to the attract state, but showing the result rather than the title.
    this.started = false;
    print('LumiCatch: round over, score ' + this.score);
  }

  private beginGame() {
    this.started = true;
    this.roundOver = false;
    this.roundLeft = this.roundSeconds;
    this.roomCentre = this.camera.getTransform().getWorldPosition();
    this.score = 0;
    this.updateScore(0);
    this.simOutcomes = [];
    this.bloomActive = false;
    this.bloomAnnounced = false;
    this.comboCount = 0;
    this.comboUntil = -1;

    // Bloom spawns survive until they are caught, so without this every round
    // starts more crowded than the one before it.
    while (this.creatures.length > this.creatureCount) {
      const extra = this.creatures.pop();
      extra.obj.destroy();
    }

    // Everything the start screen was holding back now comes up: the shoal
    // returns to full brightness, the readouts appear and swings start
    // counting. updateStartScreen hides the panel on this frame.

    print(
      'LumiCatch: game started, ' + this.creatures.length +
      ' creatures live, readouts and score on'
    );
  }

  /** Show the connection state on the start screen, where eyes already are. */
  private startStatusLine(): string {
    if (this.roundOver) {
      return this.bestScore > this.score
        ? 'best ' + this.bestScore
        : 'a new best';
    }
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
      this.startTitleText.text = this.roundOver
        ? 'SCORE  ' + this.score
        : this.startTitleLabel;
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
        this.startButtonText.text = this.roundOver
          ? 'PLAY AGAIN'
          : this.startButtonLabel;
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

  // ---------------- Readouts ----------------
  //
  // Four small pieces of text, each with exactly one job. They are children of
  // the camera and are placed by script every frame, because editor-side
  // transforms on camera children do not survive a reload.

  /** The shoal's mood as a colour, borrowed from the creatures themselves. */
  private moodColour(): vec4 {
    if (this.mood === MOOD_SPOOKED) return COL_LUMEN;
    if (this.mood === MOOD_CURIOUS) return COL_SKITTISH;
    return COL_DRIFTER;
  }

  /**
   * How alert the shoal is, 0 to 1. Off the board when connected; in simulate
   * mode a local stand-in, so the readouts respond to how you are playing
   * while there is no hardware attached.
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

  /** The board has seen a swing coming. */
  private onPredicted(etaMs: number) {
    this.predictLabel = 'SENSED  ' + Math.round(etaMs) + 'ms';
    this.predictFlashT = 0;
  }

  private updateHud(dt: number) {
    if (!this.camera) return;

    // Readouts belong to play, not to the start or result screen.
    const showGame = !this.requireStart || (this.started && !this.roundOver);
    const col = this.moodColour();
    const half = this.hudWidthCm * 0.5;
    // The bottom row of readouts. This used to be measured down from the
    // strand's droop; with the strand gone it is a plain offset, chosen to
    // leave the row exactly where players were already used to seeing it.
    const rowY = this.hudYCm - 9.5;

    // ---- mood, as a face plus a word, bottom left ----
    if (this.moodFaceText) {
      const o = this.moodFaceText.getSceneObject();
      o.enabled = showGame;
      if (showGame) {
        const t = o.getTransform();
        t.setLocalPosition(
          new vec3(-half + 4, rowY, -this.hudDistanceCm)
        );
        t.setLocalScale(new vec3(0.62, 0.62, 0.62));
        const face =
          this.mood === MOOD_SPOOKED ? this.moodFaceSpooked
          : this.mood === MOOD_CURIOUS ? this.moodFaceCurious
          : this.moodFaceCalm;
        const word =
          this.mood === MOOD_SPOOKED ? 'SPOOKED'
          : this.mood === MOOD_CURIOUS ? 'CURIOUS' : 'CALM';
        this.moodFaceText.text = face + '  ' + word;
        this.moodFaceText.textFill.color = new vec4(col.r, col.g, col.b, 1);
      }
    }

    // ---- the trajectory model firing, bottom right, flashes and fades ----
    if (this.predictFlashText) {
      const o = this.predictFlashText.getSceneObject();
      let k = 0;
      if (this.predictFlashT >= 0) {
        this.predictFlashT += dt;
        if (this.predictFlashT >= 1.1) this.predictFlashT = -1;
        else {
          const p = this.predictFlashT / 1.1;
          k = p < 0.08 ? p / 0.08 : 1 - (p - 0.08) / 0.92;
        }
      }
      o.enabled = showGame && k > 0.01;
      if (o.enabled) {
        const t = o.getTransform();
        t.setLocalPosition(
          new vec3(half - 4, rowY, -this.hudDistanceCm)
        );
        t.setLocalScale(new vec3(0.58, 0.58, 0.58));
        this.predictFlashText.text = this.predictLabel;
        // White, so it is unmistakably not the mood colour.
        this.predictFlashText.textFill.color = new vec4(1, 1, 1, k);
      }
    }

    // ---- what you just caught, large, centre, fades upward ----
    if (this.catchPopupText) {
      const o = this.catchPopupText.getSceneObject();
      let k = 0;
      let rise = 0;
      if (this.catchPopT >= 0) {
        this.catchPopT += dt;
        if (this.catchPopT >= 1.3) this.catchPopT = -1;
        else {
          const p = this.catchPopT / 1.3;
          k = p < 0.1 ? p / 0.1 : 1 - (p - 0.1) / 0.9;
          rise = p * 6;
        }
      }
      o.enabled = showGame && k > 0.01;
      if (o.enabled) {
        const t = o.getTransform();
        t.setLocalPosition(new vec3(0, 6 + rise, -this.hudDistanceCm));
        t.setLocalScale(new vec3(1.15, 1.15, 1.15));
        this.catchPopupText.text = this.catchLabel;
        const gold = this.catchLabel.indexOf('RARE') >= 0
                  || this.catchLabel.indexOf('COMBO') >= 0;
        const c = gold ? COL_LUMEN : COL_DRIFTER;
        this.catchPopupText.textFill.color = new vec4(c.r, c.g, c.b, k);
      }
    }

    // ---- a small label so the strand is not a mystery ----
    if (this.difficultyLabelText) {
      const o = this.difficultyLabelText.getSceneObject();
      o.enabled = showGame;
      if (showGame) {
        const t = o.getTransform();
        t.setLocalPosition(
          new vec3(0, this.hudYCm + 4.5, -this.hudDistanceCm)
        );
        t.setLocalScale(new vec3(0.42, 0.42, 0.42));
        this.difficultyLabelText.text =
          'SHOAL ALERTNESS  ' + Math.round(this.hudLevel() * 100) + '%';
        this.difficultyLabelText.textFill.color =
          new vec4(col.r, col.g, col.b, 0.75);
      }
    }

    // The whispered mood line ('the shoal scatters') used to sit here. It said
    // the same thing as the mood face two lines above and now shared its row,
    // so it was cut rather than left to overlap.

    // Score sits above the readout row, script owned like everything else.
    if (this.scoreText) {
      // Score and clock on one line, so there is only one thing to read.
      if (this.started && this.roundSeconds > 0) {
        // A live chain sits between the score and the clock, with the dots
        // draining as its window closes. Nothing is shown when no chain is
        // running, so the line stays quiet most of the time.
        let mid = '     ';
        if (this.comboCount > 1 && this.elapsed < this.comboUntil) {
          const left = (this.comboUntil - this.elapsed) / this.comboWindowS;
          let dots = '';
          const ticks = Math.max(1, Math.ceil(left * 3));
          for (let i = 0; i < ticks; i++) dots += '.';
          mid =
            '   x' + Math.min(this.comboCount, this.comboMax) + ' ' + dots + '   ';
        }
        this.scoreText.text =
          'Score  ' + this.score + mid + Math.ceil(this.roundLeft) + 's';
        // Gold for the last ten seconds, and for the whole bloom, so the
        // finale is visible on the score line as well as felt.
        const urgent = this.roundLeft <= 10 || this.bloomActive;
        const c = urgent ? COL_LUMEN : COL_DRIFTER;
        const k = urgent ? 0.7 + 0.3 * Math.sin(this.elapsed * 7.0) : 1.0;
        this.scoreText.textFill.color = new vec4(c.r, c.g, c.b, k);
      }
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

  /** Gather the world position of every bone at or below an object. */
  private collectBones(obj: SceneObject, out: vec3[]) {
    out.push(obj.getTransform().getWorldPosition());
    const n = obj.getChildrenCount();
    for (let i = 0; i < n; i++) this.collectBones(obj.getChild(i), out);
  }

  /** Gather the world position of every leaf bone below an object. */
  private collectTips(obj: SceneObject, out: vec3[]) {
    const n = obj.getChildrenCount();
    if (n === 0) {
      out.push(obj.getTransform().getWorldPosition());
      return;
    }
    for (let i = 0; i < n; i++) this.collectTips(obj.getChild(i), out);
  }

  /** Find a descendant by exact name, depth first. */
  private findChildNamed(obj: SceneObject, name: string): SceneObject {
    if (obj.name === name) return obj;
    const n = obj.getChildrenCount();
    for (let i = 0; i < n; i++) {
      const found = this.findChildNamed(obj.getChild(i), name);
      if (found) return found;
    }
    return null;
  }

  /** Find the first AnimationPlayer on an object or anywhere below it. */
  private findAnimation(obj: SceneObject): AnimationPlayer {
    const own = obj.getComponent('Component.AnimationPlayer');
    if (own) return own;
    const n = obj.getChildrenCount();
    for (let i = 0; i < n; i++) {
      const found = this.findAnimation(obj.getChild(i));
      if (found) return found;
    }
    return null;
  }

  /**
   * Start the model's own swim cycle at a random point in the loop.
   *
   * The imported glTF already autoplays and loops, so this is not about
   * starting it. It is about breaking the lockstep: without it all fourteen
   * jellyfish pulse on exactly the same frame, which reads as a screensaver
   * rather than a shoal. Harmless when the prefab has no animation at all,
   * which is how the old sphere prefab behaved.
   */
  private desyncAnimation(obj: SceneObject) {
    const player = this.findAnimation(obj);
    if (!player) return;
    const clips = player.clips;
    if (!clips || clips.length === 0) return;
    const clip = clips[0];
    // The model's swim cycle is 4.12 s, which is graceful and, at 20 cm on a
    // 27 degree display, imperceptible: measured, the whole skeleton moves
    // about 1.6 cm in 1.6 s. Speeding the clip up is what makes the creature
    // read as alive rather than as a static prop.
    if (this.swimSpeed > 0) clip.playbackSpeed = this.swimSpeed;
    player.playClipAt(clip.name, Math.random() * Math.max(0.01, clip.end));
  }

  /**
   * One-shot log of how big a creature actually ends up on screen.
   *
   * Worth keeping because creature size is not something you can read off the
   * source: it is the prefab's own scale chain times creatureScale, and an
   * imported model brings its own units with it. This prints the real answer
   * in centimetres so the number can be tuned against something measured
   * rather than guessed.
   */
  private reportCreatureSize() {
    if (this.creatures.length === 0) {
      print('LumiCatch: no creatures to measure.');
      return;
    }
    // Measured from the skeleton, not from worldAabbMin/Max. On a skinned mesh
    // those return the rest pose transformed by the object matrix, which for
    // this model is a flat wide box bearing no relation to the upright
    // creature actually on screen. The bones are posed by the animation, so
    // their spread is the real size. It runs slightly small, since the mesh
    // skins a little beyond the bones, but it is honest.
    const root = this.creatures[0].obj;
    const joint = this.findChildNamed(root, '_rootJoint');
    if (!joint) {
      print('LumiCatch: no _rootJoint, cannot measure.');
      return;
    }
    const pts: vec3[] = [];
    this.collectBones(joint, pts);
    let lo = pts[0], hi = pts[0];
    for (let i = 1; i < pts.length; i++) {
      lo = new vec3(Math.min(lo.x, pts[i].x), Math.min(lo.y, pts[i].y),
                    Math.min(lo.z, pts[i].z));
      hi = new vec3(Math.max(hi.x, pts[i].x), Math.max(hi.y, pts[i].y),
                    Math.max(hi.z, pts[i].z));
    }
    print(
      'LumiCatch: creature spans ' +
      (hi.x - lo.x).toFixed(1) + ' x ' +
      (hi.y - lo.y).toFixed(1) + ' x ' +
      (hi.z - lo.z).toFixed(1) + ' cm across ' + pts.length +
      ' bones at creatureScale ' + this.creatureScale.toFixed(3) +
      (this.findAnimation(root) ? ', animated' : ', static')
    );

    // Is the skeleton actually MOVING, or just posed?
    //
    // 'The AnimationPlayer exists and autoplays' is not the same claim as 'the
    // creature visibly animates'. The bones are driven regardless of what the
    // material does, so sampling them twice separates the two possible faults:
    // a still skeleton means the animation is not running, while a skeleton
    // that moves under a mesh that does not is a skinning problem in the
    // material.
    const span = new vec3(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z);
    if (this.firstSpan === null) {
      this.firstSpan = span;
      const again = this.createEvent('DelayedCallbackEvent');
      again.bind(() => this.reportCreatureSize());
      again.reset(1.6);
    } else {
      const d =
        Math.abs(span.x - this.firstSpan.x) +
        Math.abs(span.y - this.firstSpan.y) +
        Math.abs(span.z - this.firstSpan.z);
      print(
        'LumiCatch: skeleton moved ' + d.toFixed(2) +
        ' cm over 1.6 s  ->  ' +
        (d > 0.5
          ? 'BONES ARE ANIMATING'
          : 'BONES ARE STILL, the clip is not playing')
      );
    }

    // Which way is the creature actually pointing?
    //
    // Two earlier attempts at this both lied, and both lied confidently.
    //
    // The bounding box was the first. On a SKINNED mesh worldAabbMin/Max
    // reports the rest pose transformed by the object matrix, not the vertices
    // actually being drawn, so it happily reported a tall creature while the
    // screen showed a horizontal one.
    //
    // A single pair of bones was the second. Bone_00 to Bone.001_end_010 is a
    // short bone inside the bell, not the body axis, so it measured a real
    // direction that meant nothing.
    //
    // This one uses the skeleton's extremities: every bone whose name ends in
    // a tip, averaged, relative to the root joint. That is the direction the
    // tentacles actually hang, and it is what the eye reads as 'which way up'.
    const tips: vec3[] = [];
    this.collectTips(joint, tips);
    if (tips.length === 0) {
      print('LumiCatch: found no tip bones, cannot check orientation.');
      return;
    }
    let sum = new vec3(0, 0, 0);
    for (let i = 0; i < tips.length; i++) sum = sum.add(tips[i]);
    const centre = sum.uniformScale(1 / tips.length);
    const d = centre.sub(joint.getTransform().getWorldPosition()).normalize();
    const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
    const axis =
      ay > ax && ay > az
        ? (d.y < 0 ? 'Y  UPRIGHT (tentacles down)' : 'Y  UPSIDE DOWN')
        : ax > az ? 'X  ON ITS SIDE' : 'Z  ON ITS SIDE';
    print(
      'LumiCatch: body axis root->tentacles = (' +
      d.x.toFixed(2) + ', ' + d.y.toFixed(2) + ', ' + d.z.toFixed(2) +
      ')  from ' + tips.length + ' tips  ->  ' + axis
    );
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
      // Prefer the neon material over whatever the model shipped with. An
      // imported glTF brings its own PBR material, which lights realistically
      // and turns the shoal into grey plastic; the whole look depends on these
      // being unlit and self coloured. Falls back to the prefab's own material
      // when the input is unset, which is how the sphere prefab worked.
      const base = this.neonMaterial || visual.mainMaterial;
      if (!base) return;
      const cloned = base.clone();
      cloned.mainPass.baseColor =
        kind === KIND_LUMEN
          ? COL_LUMEN
          : kind === KIND_SKITTISH
          ? COL_SKITTISH
          : COL_DRIFTER;
      // A sphere never showed you its inside, so backface culling was free. A
      // bell does: swim under one with culling on and the jellyfish vanishes.
      // The source model is doubleSided for exactly this reason.
      cloned.mainPass.twoSided = true;
      // Translucent, and not writing depth, so the bell and the tentacles
      // behind it blend into each other instead of the nearest surface
      // painting a flat silhouette over everything behind it.
      cloned.mainPass.blendMode = BlendMode.Normal;
      cloned.mainPass.depthWrite = false;
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

  /** Throw a handful of motes off a catch. */
  private spawnBurst(pos: vec3) {
    if (!this.burstPrefab || this.burstMotes <= 0) return;
    for (let i = 0; i < this.burstMotes; i++) {
      const o = this.burstPrefab.instantiate(this.creatureRoot());
      const dir = new vec3(
        Math.random() - 0.5,
        Math.random() - 0.5,
        Math.random() - 0.5
      ).normalize();
      o.getTransform().setWorldPosition(pos);
      this.motes.push({ obj: o, t: 0, from: pos, dir: dir });
    }
  }

  /**
   * Fly caught creatures into the net, and scatter the burst motes.
   *
   * This is the whole of the catch payoff. Before it, a catch was a creature
   * calling destroy() on itself: the single most important moment in the game
   * had the least feedback in it.
   */
  private updateCaught(dt: number, camPos: vec3, fwd: vec3) {
    const target = camPos.add(fwd.uniformScale(this.catchFlyToCm));
    for (let i = this.caught.length - 1; i >= 0; i--) {
      const e = this.caught[i];
      e.t += dt;
      const p = Math.min(1, e.t / Math.max(0.01, this.catchFlyS));
      const t = e.obj.getTransform();
      // Accelerating in, so it reads as being scooped rather than drifting.
      t.setWorldPosition(vec3.lerp(e.from, target, p * p));
      const s = e.scale * (1 - p);
      t.setWorldScale(new vec3(s, s, s));
      if (p >= 1) {
        e.obj.destroy();
        this.caught.splice(i, 1);
      }
    }

    for (let i = this.motes.length - 1; i >= 0; i--) {
      const m = this.motes[i];
      m.t += dt;
      const p = Math.min(1, m.t / Math.max(0.01, this.burstLifeS));
      // Fast out, easing to a stop, which is how a spark of light behaves.
      const out = 1 - (1 - p) * (1 - p);
      const t = m.obj.getTransform();
      t.setWorldPosition(
        m.from.add(m.dir.uniformScale(this.burstSpreadCm * out))
      );
      const s = this.burstMoteScale * (1 - p);
      t.setWorldScale(new vec3(s, s, s));
      if (p >= 1) {
        m.obj.destroy();
        this.motes.splice(i, 1);
      }
    }
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
    this.desyncAnimation(obj);

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
    this.updateCaught(dt, camPos, fwd);
    this.updateRound(dt);
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

    this.checkWalls(camPos);

    // Keep everything inside the play volume. Done after separation so a push
    // cannot shove a creature through a wall, and before the transforms are
    // applied so nothing is ever drawn out of bounds even for one frame.
    if (this.useRoomBounds && this.roomCentre) {
      for (let i = 0; i < this.creatures.length; i++) {
        const c = this.creatures[i];
        const flat = new vec3(
          c.pos.x - this.roomCentre.x,
          0,
          c.pos.z - this.roomCentre.z
        );
        const r = flat.length;
        if (r > this.roomRadiusCm) {
          const pulled = flat.uniformScale(this.roomRadiusCm / r);
          c.pos = new vec3(
            this.roomCentre.x + pulled.x,
            c.pos.y,
            this.roomCentre.z + pulled.z
          );
          // Re-home it too, or it swims straight back into the wall.
          c.home = c.pos;
        }
        const top = this.roomCentre.y + this.roomCeilingCm;
        const bottom = this.roomCentre.y - this.roomFloorCm;
        if (c.pos.y > top) c.pos = new vec3(c.pos.x, top, c.pos.z);
        if (c.pos.y < bottom) c.pos = new vec3(c.pos.x, bottom, c.pos.z);
      }
    }

    // Apply transforms once positions have settled. Yaw spin plus bell pulse,
    // no billboarding: a wrong facing axis is invisible in the editor and
    // obvious on video.
    const upright = quat.angleAxis(
      (this.modelUprightDeg * Math.PI) / 180,
      new vec3(1, 0, 0)
    );
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      const t = c.obj.getTransform();
      t.setWorldPosition(c.pos);

      const pulseSpeed = c.kind === KIND_LUMEN ? 1.4 : 2.2;
      const s =
        c.scale *
        (1 + Math.sin(this.elapsed * pulseSpeed + c.seed) * this.pulseAmount);
      t.setWorldScale(new vec3(s, s, s));
      // Yaw, then a fixed lean, then stand the model up. Order matters: the
      // upright correction has to sit innermost, or the creature tips over as
      // it turns instead of rotating about its own vertical axis.
      //
      // The lean is derived from the creature's seed rather than stored, so it
      // is constant for that creature but different between them.
      let rot = quat.angleAxis(
        this.elapsed * this.spinRate + c.seed,
        worldUp
      );
      if (this.tiltVarietyDeg > 0) {
        const lean = (Math.sin(c.seed * 12.9898) * this.tiltVarietyDeg * Math.PI) / 180;
        const leanAxis = new vec3(Math.cos(c.seed * 4.1), 0, Math.sin(c.seed * 4.1));
        rot = rot.multiply(quat.angleAxis(lean, leanAxis));
      }
      t.setWorldRotation(rot.multiply(upright));

      const toC2 = c.pos.sub(camPos);
      const dist2 = toC2.length;
      const dir2 = dist2 > 0.0001 ? toC2.normalize() : fwd;

      if (dist2 < nearestDist) {
        nearestDist = dist2;
        nearestKind = c.kind;
      }
      if (
        c.kind === KIND_DRIFTER &&
        // The sneak reach, not the lunge reach. The guarantee exists as
        // filming insurance, so it has to promise a target you can take with
        // the gentler swing, not one that needs a committed lunge.
        dist2 <
          (this.useSwingQuality ? this.sneakRangeCm : this.captureRangeCm) &&
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
    // Nothing is catchable until the player has begun, or after time is up.
    if (this.requireStart && !this.started) return;
    if (this.roundOver) return;

    const camT = this.camera.getTransform();
    const camPos = camT.getWorldPosition();
    const fwd = this.camForward();

    // Sneak or lunge. This is the one thing that turns the net from a button
    // into an instrument: the same gesture at two different speeds now has
    // two different reaches and two different costs.
    const gentle = this.useSwingQuality && peak < this.gentleSwingG;
    const reach = !this.useSwingQuality
      ? this.captureRangeCm
      : gentle
      ? this.sneakRangeCm
      : this.lungeRangeCm;

    let bestIdx = -1;
    let bestDist = Number.MAX_VALUE;

    for (let i = 0; i < this.creatures.length; i++) {
      // A creature that is actively dodging has evaded you. Without this the
      // flee is cosmetic: fleeDistanceCm is 32 while the reach is far longer,
      // so a dodged creature stays well inside it and you catch it anyway.
      const st = this.creatures[i].state;
      if (st === ST_ALERT || st === ST_FLEE) continue;

      const toC = this.creatures[i].pos.sub(camPos);
      const dist = toC.length;
      if (dist > reach) continue;
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
      this.capture(bestIdx, gentle);
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

    // The cost of the swing, paid whether or not it landed. Done after the
    // capture so the creature you just took is already off the roster.
    if (this.useSwingQuality) {
      this.disturb(camPos, gentle ? this.sneakSpookCm : this.lungeSpookCm);
    }
  }

  /**
   * Wake every calm creature within reach of the noise a swing made.
   *
   * Woken creatures are skipped by onSwing, so this is a real cost: lunge into
   * a cluster and miss, and you have just made the whole cluster untouchable
   * for a couple of seconds. Respects canFlee, so the mercy window still
   * protects a player who is struggling.
   */
  private disturb(camPos: vec3, radiusCm: number) {
    if (radiusCm <= 0) return;
    let woken = 0;
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      if (c.state !== ST_DRIFT) continue;
      if (!this.canFlee(c)) continue;
      if (c.pos.distance(camPos) > radiusCm) continue;
      c.state = ST_ALERT;
      c.stateT = 0;
      woken++;
    }
    if (woken > 0) {
      print('LumiCatch: the swing disturbed ' + woken + ' creature(s)');
    }
  }

  private capture(idx: number, gentle: boolean) {
    const c = this.creatures[idx];
    const pos = c.pos;
    const kind = c.kind;

    // Off the roster at once so it cannot be caught twice, but deliberately
    // NOT destroyed: it still has to fly into the net. updateCaught owns it
    // from here and destroys it at the end of the flight.
    this.creatures.splice(idx, 1);
    this.caught.push({ obj: c.obj, t: 0, from: pos, scale: c.scale });

    this.spawnBurst(pos);

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

    // Chain. Each catch inside the window raises the multiplier rather than
    // just setting a flat x2, so a run of quick catches is worth chasing.
    if (this.elapsed < this.comboUntil) this.comboCount++;
    else this.comboCount = 1;
    this.comboUntil = this.elapsed + this.comboWindowS;
    this.lastCapture = this.elapsed;

    const chain = Math.min(this.comboCount, this.comboMax);
    const bloom = this.bloomActive ? this.bloomMultiplier : 1;
    const mult = chain * bloom;
    const pts = this.pointsFor(kind) * mult;

    // Tell the player what they just caught and what it was worth, or the
    // score simply jumps by twelve with no explanation. Two short lines rather
    // than one long one, because the display is only 27 degrees wide.
    let what = 'CAUGHT';
    if (kind === KIND_LUMEN) what = 'RARE';
    else if (kind === KIND_SKITTISH) what = 'SKITTISH';
    const head = (gentle ? 'SNEAK  ' : 'LUNGE  ') + what;
    const tail = (mult > 1 ? 'x' + mult + '   ' : '') + '+' + pts;
    this.catchLabel = head + '\n' + tail;
    this.catchPopT = 0;
    this.sendHaptic(mult > 1 ? 4 : 3);
    this.updateScore(this.score + pts);

    const respawn = this.createEvent('DelayedCallbackEvent');
    respawn.bind(() => this.spawnCreature(-1));
    respawn.reset(1.5);
  }

  private updateScore(v: number) {
    this.score = v;
    if (this.scoreText) this.scoreText.text = 'Score  ' + v;
  }
}
