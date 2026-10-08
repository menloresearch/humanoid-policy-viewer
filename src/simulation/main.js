import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DragStateManager } from './utils/DragStateManager.js';
import { createSimulationWrapper, downloadExampleScenesFolder, getPosition, getQuaternion, toMujocoPos, reloadScene, reloadPolicy } from './mujocoUtils.js';
import { commandSequencer } from './commandSequencer.js';
import { asimovCommandState } from './observationHelpers.js';
import { IdealPathTracker, yawFromQuat } from './idealPath.js';

const defaultPolicy = "./examples/checkpoints/asimov/reference_policy_config.json";
// The canonical Asimov model from the asimov-1 submodule; see
// public/examples/scenes/README.md. Mirrors the 'asimov-reference' entry's
// scenePath in Demo.vue's policy list — keep the two in sync so the scene
// shown on load matches what re-selecting that same policy would load.
const defaultScene = "asimov-1/sim-model/xmls/asimov_1.xml";

// Extra robots of a grouped benchmark run (addExtraRobots) are drawn see-through
// and tinted, on a layer of their own: the main camera renders it, the floor
// Reflector's camera (layer 0 only) does not, so they stay out of the reflection.
const EXTRA_ROBOT_LAYER = 1;
const EXTRA_ROBOT_OPACITY = 0.35;
const FALLEN_ROBOT_OPACITY = 0.15;
const EXTRA_ROBOT_TINTS = [0x4fc3f7, 0xffb74d, 0xba68c8, 0x81c784];

export class MuJoCoDemo {
  constructor(mujoco) {
    this.mujoco = mujoco;
    mujoco.FS.mkdir('/working');
    mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working');

    this.params = {
      paused: true,
      current_motion: 'default',
      compliance_enabled: false,
      compliance_threshold: 10.0
    };
    this.policyRunner = null;
    this.kpPolicy = null;
    this.kdPolicy = null;
    this.kdFfPolicy = null;
    this.actionTarget = null;
    this.filteredActionTarget = null;
    this.actionLpfAlpha = 1.0; // 1.0 means no filtering
    this.actionDelayMinLag = 0;
    this.actionDelayMaxLag = 0;
    this.actionDelayLag = 0;
    this.actionDelayBuffer = [];
    this.maxRawAction = 0;
    this.rawActions = null;
    this.model = null;
    this.data = null;
    this.simulation = null;
    this.currentPolicyPath = defaultPolicy;
    this.currentOnnxPath = null;
    this.currentPolicyConfig = null;
    this.__simMetricsRecorders = new Set();
    // Loud-but-non-fatal resolveBodyId() fallbacks (a targetBody name that
    // didn't match anything in the loaded model) accumulate here so a
    // benchmark run can fold them into that test's reported warning instead
    // of leaving them findable only in the browser console — see
    // drainBodyResolutionWarnings().
    this._bodyResolutionWarnings = new Set();
    // Robots 1..n-1 of a grouped benchmark run; robot 0 is the demo itself.
    this.extraRobots = [];

    this.bodies = {};
    this.lights = {};

    this.container = document.getElementById('mujoco-container');

    this.scene = new THREE.Scene();
    this.scene.name = 'scene';

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.001, 100);
    this.camera.name = 'PerspectiveCamera';
    this.camera.position.set(3.0, 2.2, 3.0);
    this.camera.layers.enable(EXTRA_ROBOT_LAYER);
    this.scene.add(this.camera);

    this.scene.background = new THREE.Color(0.15, 0.25, 0.35);
    this.scene.fog = null;

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
    this.ambientLight.name = 'AmbientLight';
    this.scene.add(this.ambientLight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderScale = 2.0;
    this.renderer.setPixelRatio(this.renderScale);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.simStepHz = 0;
    this._stepFrameCount = 0;
    this._stepLastTime = performance.now();
    this._lastRenderTime = 0;

    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.7, 0);
    this.controls.panSpeed = 2;
    this.controls.zoomSpeed = 1;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.10;
    this.controls.screenSpacePanning = true;
    this.controls.update();

    window.addEventListener('resize', this.onWindowResize.bind(this));

    this.dragStateManager = new DragStateManager(this.scene, this.renderer, this.camera, this.container.parentElement, this.controls);

    // Click-to-push and scripted (JSON) pushes both queue here — plural so a
    // scripted push firing mid-drain doesn't clobber a live click-to-push.
    this._activePushes = []; // [{bodyID, force:{x,y,z}, point:{x,y,z}, stepsLeft}]

    // Click-to-push: double-click applies impulse from camera direction
    this._pickingMode = false;
    this.renderer.domElement.addEventListener('dblclick', (e) => {
      // Suppress while the target-body picker (PushEventDialog) has borrowed
      // this canvas — a stray double-click shouldn't shove the live sim.
      if (this._pickingMode) return;
      if (!this.simulation || !this.model) return;
      const closestBody = this.raycastBodyAt(e.clientX, e.clientY);
      if (closestBody) {
        // Push direction: from camera toward click point
        const dir = closestBody.rayDirection;
        const pushForce = 200.0; // Newtons
        const force = toMujocoPos(dir.multiplyScalar(pushForce));
        const point = toMujocoPos(closestBody.point.clone());
        // Apply for ~0.1s (= 0.1/0.005 = 20 physics steps)
        this._activePushes.push({
          bodyID: closestBody.bodyID,
          force: { x: force.x, y: force.y, z: force.z },
          point: { x: point.x, y: point.y, z: point.z },
          stepsLeft: 20
        });
        console.log(`Push: ${pushForce}N on body ${closestBody.bodyID} for 0.1s`);
      }
    });

    this.followEnabled = false;
    this.followHeight = 0.75;
    this.followLerp = 0.05;
    this.followTarget = new THREE.Vector3();
    this.followTargetDesired = new THREE.Vector3();
    this.followDelta = new THREE.Vector3();
    this.followOffset = new THREE.Vector3();
    this.followInitialized = false;
    this.followBodyId = null;
    this.followDistance = this.camera.position.distanceTo(this.controls.target);

    this.lastSimState = {
      bodies: new Map(),
      lights: new Map(),
      tendons: {
        numWraps: 0,
        matrix: new THREE.Matrix4()
      }
    };

    // Idealized-path ghost: dead-reckons the commanded trajectory
    this.idealPath = new IdealPathTracker();
    this.showIdealMarker = true;
    this._buildIdealMarker();

    this.renderer.setAnimationLoop(this.render.bind(this));

    this.reloadScene = reloadScene.bind(this);
    this.reloadPolicy = reloadPolicy.bind(this);
  }

  /**
   * Permanently stops the WebGL draw loop. render() only copies simulation
   * state into the Three.js scene graph and issues the draw call — nothing
   * a benchmark reads depends on it (metrics read this.simulation
   * directly) — so headless CI runs (see
   * runHeadlessBenchmark() in Demo.vue) can skip it entirely. Software-
   * rendered WebGL (no GPU passthrough, e.g. most CI runners) makes this a
   * meaningful chunk of the per-frame cost, not just an idle canvas.
   */
  stopRenderLoop() {
    this.renderer.setAnimationLoop(null);
  }

  /** Undoes stopRenderLoop(), e.g. for a benchmark run someone is watching. */
  startRenderLoop() {
    this.renderer.setAnimationLoop(this.render.bind(this));
  }

  _buildIdealMarker() {
    // Isosceles pyramid pointing along the heading direction (+X at heading 0),
    // laid horizontal and flattened so it reads as a flat directional arrow.
    const geo = new THREE.ConeGeometry(0.11, 0.34, 4);
    geo.rotateZ(-Math.PI / 2); // apex +Y -> +X
    geo.scale(1, 0.4, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff6d00,
      transparent: true,
      opacity: 0.55,
      depthWrite: false
    });
    this.idealMarker = new THREE.Mesh(geo, mat);
    this.idealMarker.renderOrder = 1;
    // Added to the scene (not mujocoRoot, which is destroyed on scene reload)
    this.scene.add(this.idealMarker);
  }

  reanchorIdealPath(robot = this) {
    if (!robot.simulation) {
      return;
    }
    const q = robot.simulation.qpos;
    const comZ = robot.data?.subtree_com?.[2] ?? 0.6;
    robot.idealPath.reanchor(q[0], q[1], yawFromQuat(q[3], q[4], q[5], q[6]), comZ);
  }

  async init() {
    this.defaultScenePath = defaultScene;
    await downloadExampleScenesFolder(this.mujoco);
    await this.reloadScene(defaultScene);
    commandSequencer.bindSim(this);
    this.updateFollowBodyId();
    await this.reloadPolicy(defaultPolicy);
    this.reanchorIdealPath();
    this.alive = true;
  }

  async reload(mjcf_path) {
    await this.reloadScene(mjcf_path);
    commandSequencer.bindSim(this);
    this.updateFollowBodyId();
    this.timestep = this.model.opt.timestep;
    this.decimation = Math.max(1, Math.round(0.02 / this.timestep));

    console.log('timestep:', this.timestep, 'decimation:', this.decimation);

    await this.reloadPolicy(this.currentPolicyPath ?? defaultPolicy, { onnxPath: this.currentOnnxPath });
    this.reanchorIdealPath();
    this.alive = true;
  }

  /**
   * Resolve a push event's optional targetBody name to a real body id,
   * falling back to the pelvis if unset — so an event with no targetBody
   * (the common case) needs no scene-specific knowledge. A *given* name that
   * doesn't match any body in the loaded model still falls back to the
   * pelvis (an event authored against one scene degrades gracefully on
   * another), but that fallback is loud: a typo'd targetBody in a test file
   * would otherwise silently score as "pushed the pelvis" with no sign the
   * intended location was never touched.
   */
  resolveBodyId(name) {
    if (typeof name === 'string' && name) {
      for (const id of Object.keys(this.bodies || {})) {
        if (this.bodies[id]?.name === name) return Number(id);
      }
      const message = `no body named "${name}" in the loaded model — targeted the pelvis instead`;
      console.warn(`[MuJoCoDemo] resolveBodyId: ${message}`);
      this._bodyResolutionWarnings?.add(message);
    }
    return this.pelvis_body_id;
  }

  /** Drain (and clear) resolveBodyId()'s accumulated fallback warnings — call once per test/run. */
  drainBodyResolutionWarnings() {
    const warnings = Array.from(this._bodyResolutionWarnings || []);
    this._bodyResolutionWarnings?.clear();
    return warnings;
  }

  /** Real MJCF body names (skipping the world body) — for a target-body picker. */
  listBodyNames() {
    return Object.values(this.bodies || {})
      .filter((b) => b && b.bodyID > 0 && b.name)
      .map((b) => b.name)
      .sort();
  }

  /**
   * Subtree mass of a named body (or the pelvis's, if unset/unrecognized).
   * Throws rather than substituting a fallback mass: this feeds directly
   * into push-force normalization (metrics.js), where a wrong mass silently
   * corrupts scoring with no visible error.
   */
  getBodyMass(name) {
    const bodyID = this.resolveBodyId(name);
    const mass = this.model?.body_subtreemass?.[bodyID];
    if (mass == null) {
      throw new Error(`getBodyMass: could not resolve subtree mass for body id ${bodyID} (name="${name ?? '(default)'}") — is a model loaded?`);
    }
    return mass;
  }

  /**
   * Friction-stress benchmark support: override the ground grip by setting
   * the sliding friction (element 0 of geom_friction) on the foot collision
   * geoms — NOT the floor geom. The floor geom's own friction is inert here:
   * MuJoCo combines a contact's parameters by taking ALL of them from
   * whichever of the two geoms has the higher `priority`, with no mixing,
   * and the foot geoms (class="collision" in asimov_1.xml) carry priority="1"
   * against the floor's default 0. So this is the only lever that actually
   * changes foot-ground grip without a scene reload. Returns a
   * Map<geomId, [slide, torsional, rolling]> of the previous values, for
   * restoreFootFriction() to undo after the test.
   *
   * Throws instead of silently no-oping when the model isn't loaded or no
   * geom matches the naming convention — a friction-stress test that quietly
   * ran on the scene's default friction would look identical in the report
   * to one that actually stressed the requested floor grip.
   */
  setFootFriction(slideValue) {
    if (!Number.isFinite(slideValue)) {
      throw new Error(`setFootFriction: slideValue must be a finite number, got ${slideValue}`);
    }
    if (!this.model) {
      throw new Error('setFootFriction: no model loaded');
    }
    const prev = new Map();
    const textDecoder = new TextDecoder('utf-8');
    const namesArray = new Uint8Array(this.model.names);
    for (let g = 0; g < this.model.ngeom; g++) {
      let start = this.model.name_geomadr[g];
      let end = start;
      while (end < namesArray.length && namesArray[end] !== 0) end++;
      const name = textDecoder.decode(namesArray.subarray(start, end));
      if (!/foot\d*_collision$/.test(name)) continue;
      const base = g * 3;
      prev.set(g, [
        this.model.geom_friction[base],
        this.model.geom_friction[base + 1],
        this.model.geom_friction[base + 2],
      ]);
      this.model.geom_friction[base] = slideValue;
    }
    if (prev.size === 0) {
      throw new Error('setFootFriction: no geoms matched /foot\\d*_collision$/ in the loaded model — floor-friction override would silently no-op');
    }
    return prev;
  }

  /** Undo setFootFriction() with the Map it returned. */
  restoreFootFriction(prevMap) {
    if (!this.model || !prevMap) return;
    for (const [g, [s, t, r]] of prevMap) {
      const base = g * 3;
      this.model.geom_friction[base] = s;
      this.model.geom_friction[base + 1] = t;
      this.model.geom_friction[base + 2] = r;
    }
  }

  /**
   * Closest body under a screen point, via the same raycast-every-body
   * approach as click-to-push. Shared by the dblclick push handler and the
   * target-body picker (see enterBodyPicker below).
   */
  raycastBodyAt(clientX, clientY) {
    if (!this.model || !this.bodies) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);

    let closest = null;
    let closestDist = Infinity;
    for (let b = 1; b < this.model.nbody; b++) {
      if (!this.bodies[b]) continue;
      const intersects = raycaster.intersectObject(this.bodies[b], true);
      if (intersects.length > 0 && intersects[0].distance < closestDist) {
        closestDist = intersects[0].distance;
        closest = { bodyID: b, name: this.bodies[b].name, point: intersects[0].point };
      }
    }
    if (!closest) return null;
    return { ...closest, rayDirection: raycaster.ray.direction.clone().normalize() };
  }

  /**
   * Recompute emissive tint for every body touched by hover/selection. Hover
   * (transient, orange) takes priority over selection (persistent, green) on
   * the same body; anything no longer hovered or selected is restored to its
   * original emissive.
   */
  _applyBodyTints() {
    const touched = new Set(this._tintedBodyIDs || []);
    if (this._highlightedBodyID != null) touched.add(this._highlightedBodyID);
    if (this._selectedBodyID != null) touched.add(this._selectedBodyID);
    const nextTinted = new Set();
    for (const bodyID of touched) {
      const body = this.bodies[bodyID];
      if (!body) continue;
      const color = bodyID === this._highlightedBodyID ? 0xffaa00
        : bodyID === this._selectedBodyID ? 0x33cc66
        : null;
      body.traverse((obj) => {
        if (!obj.isMesh || !obj.material?.emissive) return;
        if (color != null) {
          if (!obj.userData._origEmissive) obj.userData._origEmissive = obj.material.emissive.clone();
          obj.material.emissive.setHex(color);
        } else if (obj.userData._origEmissive) {
          obj.material.emissive.copy(obj.userData._origEmissive);
          delete obj.userData._origEmissive;
        }
      });
      if (color != null) nextTinted.add(bodyID);
    }
    this._tintedBodyIDs = nextTinted;
    this.render();
  }

  /** Transient hover tint (orange) — used by the picker's pointermove handler. */
  _setHighlightedBody(bodyID) {
    if (this._highlightedBodyID === bodyID) return;
    this._highlightedBodyID = bodyID;
    this._applyBodyTints();
  }

  /** Persistent selection tint (green) — the currently chosen push target body. */
  _setSelectedBody(bodyID) {
    if (this._selectedBodyID === bodyID) return;
    this._selectedBodyID = bodyID;
    this._applyBodyTints();
  }

  /** Resolve a target-body name (or null for default/pelvis) and tint it as selected. */
  selectBody(name) {
    const bodyID = typeof name === 'string' && name ? this.resolveBodyId(name) : null;
    this._setSelectedBody(bodyID);
  }

  /**
   * Borrow the live canvas for a target-body picker embedded elsewhere on the
   * page (see PushEventDialog.vue) — reparents the renderer's canvas into
   * containerEl and resizes to fit it, rather than building a second scene.
   * OrbitControls (bound directly to the canvas element) keeps working after
   * the move; DragStateManager (bound to the *original* parent) naturally
   * stops receiving events once the canvas leaves it, so no explicit
   * disabling is needed there.
   */
  enterBodyPicker(containerEl, { onHover, onPick } = {}) {
    if (this._pickingMode) this.exitBodyPicker();
    this._pickingMode = true;
    this._pickerContainer = containerEl;
    containerEl.appendChild(this.renderer.domElement);
    this.camera.aspect = containerEl.clientWidth / containerEl.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(containerEl.clientWidth, containerEl.clientHeight);
    this.render();

    let downPos = null;
    const CLICK_SLOP = 4;
    this._pickerHandlers = {
      pointermove: (e) => {
        const hit = this.raycastBodyAt(e.clientX, e.clientY);
        this._setHighlightedBody(hit?.bodyID ?? null);
        onHover?.(hit?.name ?? null);
      },
      pointerdown: (e) => {
        downPos = { x: e.clientX, y: e.clientY };
      },
      pointerup: (e) => {
        if (!downPos) return;
        const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
        downPos = null;
        if (moved > CLICK_SLOP) return; // an orbit drag, not a pick
        const hit = this.raycastBodyAt(e.clientX, e.clientY);
        if (hit) {
          this._setSelectedBody(hit.bodyID);
          onPick?.(hit.name);
        }
      },
    };
    for (const [type, handler] of Object.entries(this._pickerHandlers)) {
      this.renderer.domElement.addEventListener(type, handler);
    }
  }

  exitBodyPicker() {
    if (!this._pickingMode) return;
    for (const [type, handler] of Object.entries(this._pickerHandlers || {})) {
      this.renderer.domElement.removeEventListener(type, handler);
    }
    this._pickerHandlers = null;
    this._setHighlightedBody(null);
    this._setSelectedBody(null);
    document.getElementById('mujoco-container')?.appendChild(this.renderer.domElement);
    this._pickingMode = false;
    this._pickerContainer = null;
    this.onWindowResize();
  }

  /**
   * Apply a scripted push event as a real, sustained force (and optional
   * torque) through the target body's own center of mass (xipos) — fixed
   * relative to that body, so the effective push point is consistent
   * regardless of arm/leg pose, unlike the whole-body subtree_com. Queues
   * onto _activePushes, drained by the same per-substep consumer as
   * click-to-push. Every robot gets the push, at its own body's CoM.
   *
   * ev: { dir:[x,y,z], force, duration, torqueAxis?:[x,y,z], torqueMag?, targetBody? }
   * force is authored directly in Newtons — no mass lookup needed to apply
   * it (mass only matters for normalizing the push-resistance metric, see
   * getBodyMass() above). Torque is likewise specified directly in N·m.
   */
  applyScriptedPush(ev) {
    if (!this.simulation || !this.model || !this.data) return;
    const bodyID = this.resolveBodyId(ev.targetBody);
    if (bodyID == null) return;
    const [dx, dy, dz] = ev.dir;
    const dirLen = Math.hypot(dx, dy, dz || 0);
    if (dirLen === 0) return;
    // Force is authored as a magnitude — direction lives entirely in "dir" —
    // so a stray negative here must not flip the push's physical direction.
    const mag = Math.abs(Number(ev.force) || 0); // Newtons, authored directly
    const stepsLeft = Math.max(1, Math.round(ev.duration / this.timestep));

    let torque = { x: 0, y: 0, z: 0 };
    if (Array.isArray(ev.torqueAxis) && ev.torqueMag) {
      const [tx, ty, tz] = ev.torqueAxis;
      const axisLen = Math.hypot(tx, ty, tz) || 1;
      torque = {
        x: (tx / axisLen) * ev.torqueMag,
        y: (ty / axisLen) * ev.torqueMag,
        z: (tz / axisLen) * ev.torqueMag,
      };
    }

    for (const robot of this.robots) {
      const xipos = robot.simulation.xipos;
      robot._activePushes.push({
        bodyID,
        force: { x: (dx / dirLen) * mag, y: (dy / dirLen) * mag, z: ((dz || 0) / dirLen) * mag },
        torque: { ...torque },
        point: { x: xipos[bodyID * 3 + 0], y: xipos[bodyID * 3 + 1], z: xipos[bodyID * 3 + 2] },
        stepsLeft,
      });
    }
  }

  setFollowEnabled(enabled) {
    this.followEnabled = Boolean(enabled);
    this.followInitialized = false;
    if (this.followEnabled) {
      this.followOffset.subVectors(this.camera.position, this.controls.target);
      if (this.followOffset.lengthSq() === 0) {
        this.followOffset.set(0, 0, 1);
      }
      this.followOffset.setLength(this.followDistance);
      this.camera.position.copy(this.controls.target).add(this.followOffset);
      this.controls.update();
    }
  }

  configureActionDelay(minLag, maxLag) {
    const min = Number.isFinite(minLag) ? Math.max(0, Math.floor(minLag)) : 0;
    const max = Number.isFinite(maxLag) ? Math.max(min, Math.floor(maxLag)) : min;
    this.actionDelayMinLag = min;
    this.actionDelayMaxLag = max;
    this.resetActionDelay();
  }

  /**
   * Seeded randomisation for benchmark repeats, or null for none (the default).
   * `{ random, actionDelay: 'midpoint' | 'env_range', initialJointNoiseRad }`,
   * where `random()` is a seeded generator returning [0, 1). It is read by
   * resetSimulation(), so set it before the reset that starts a test. Each
   * robot of a grouped run has its own (its repeat's seed).
   */
  setBenchmarkRandomization(randomization, robot = this) {
    robot.benchmarkRandomization = randomization ?? null;
  }

  resetActionDelay(seedTarget = null, robot = this) {
    const span = this.actionDelayMaxLag - this.actionDelayMinLag + 1;
    const randomization = robot.benchmarkRandomization;
    if (randomization?.actionDelay === 'env_range') {
      // A benchmark repeat draws the lag from the env.yaml range with its own
      // seeded generator, so every repeat is reproducible from its seed.
      robot.actionDelayLag = this.actionDelayMinLag + Math.floor(randomization.random() * span);
    } else {
      // Pin a fixed, reproducible "typical" lag (the midpoint of the policy's
      // configured delay range) instead of drawing one — an unseeded draw here
      // was the sole source of run-to-run flakiness in push-threshold results
      // near a policy's actual capability boundary.
      robot.actionDelayLag = this.actionDelayMinLag + Math.floor((span - 1) / 2);
    }
    robot.actionDelayBuffer = [];
    if (seedTarget && robot.actionDelayLag > 0) {
      for (let i = 0; i < robot.actionDelayLag; i++) {
        robot.actionDelayBuffer.push(new Float32Array(seedTarget));
      }
    }
  }

  getDelayedActionTarget(sourceTarget, robot = this) {
    if (!sourceTarget || robot.actionDelayLag <= 0) {
      return sourceTarget;
    }
    robot.actionDelayBuffer.push(new Float32Array(sourceTarget));
    while (robot.actionDelayBuffer.length > robot.actionDelayLag + 1) {
      robot.actionDelayBuffer.shift();
    }
    return robot.actionDelayBuffer[0] ?? sourceTarget;
  }

  /** Every robot in the scene: the demo itself (robot 0), then any extra robots. */
  get robots() {
    return [this, ...this.extraRobots];
  }

  /**
   * Adds `count` robots to the scene for a grouped benchmark run (several
   * repeats of one test at once). They share the loaded mjModel (so a test's
   * friction/terrain/torque-limit changes reach all of them) but each has its
   * own mjData, and a policy runner of its own that shares robot 0's ONNX
   * session. An extra robot is a plain object with the same per-robot fields
   * the demo uses for robot 0, which is what stepPolicyTick() and the
   * robot-taking methods (resetSimulation, readPolicyState, ...) read. Replaces
   * any extra robots already present; removeExtraRobots() takes them away.
   */
  addExtraRobots(count) {
    this.removeExtraRobots();
    if (count <= 0) {
      return this.robots;
    }
    if (!this.model || !this.policyRunner) {
      throw new Error('addExtraRobots: no model or policy loaded');
    }
    for (let i = 0; i < count; i++) {
      const data = new this.mujoco.MjData(this.model);
      const robot = {
        index: this.extraRobots.length + 1,
        data,
        simulation: createSimulationWrapper(this.mujoco, this.model, data),
        policyRunner: this.policyRunner.twin(),
        actionTarget: null,
        filteredActionTarget: null,
        rawActions: null,
        maxRawAction: 0,
        actionDelayLag: 0,
        actionDelayBuffer: [],
        benchmarkRandomization: null,
        _tumbling: false,
        _activePushes: [],
        idealPath: new IdealPathTracker(),
        lastSimState: { bodies: new Map() },
        bodies: {},
        visual: null,
        materials: [],
      };
      this._buildExtraRobotVisual(robot);
      this.extraRobots.push(robot);
    }
    return this.robots;
  }

  /** Removes the extra robots: their meshes, materials and mjData. */
  removeExtraRobots() {
    for (const robot of this.extraRobots) {
      robot.visual?.removeFromParent();
      for (const material of robot.materials) material.dispose();
      robot.data.delete();
    }
    this.extraRobots = [];
  }

  /**
   * A copy of robot 0's bodies for an extra robot: geometry (and textures)
   * shared, materials cloned and tinted, see-through, casting no shadow and on
   * EXTRA_ROBOT_LAYER so the floor reflection leaves them out.
   */
  _buildExtraRobotVisual(robot) {
    const world = this.bodies?.[0];
    if (!world) {
      return;
    }
    const tint = new THREE.Color(EXTRA_ROBOT_TINTS[(robot.index - 1) % EXTRA_ROBOT_TINTS.length]);
    const materials = new Map(); // robot 0's material -> this robot's copy
    const group = new THREE.Group();
    group.name = `Extra robot ${robot.index}`;
    for (let b = 1; b < this.model.nbody; b++) {
      if (!this.bodies[b]) continue;
      const body = this.bodies[b].clone();
      body.bodyID = b;
      body.traverse((obj) => {
        obj.layers.set(EXTRA_ROBOT_LAYER);
        if (!obj.isMesh) return;
        obj.castShadow = false;
        obj.receiveShadow = false;
        let material = materials.get(obj.material);
        if (!material) {
          material = obj.material.clone();
          material.color.lerp(tint, 0.6);
          material.transparent = true;
          material.opacity = EXTRA_ROBOT_OPACITY;
          material.depthWrite = false;
          materials.set(obj.material, material);
        }
        obj.material = material;
      });
      robot.bodies[b] = body;
      group.add(body);
    }
    world.add(group);
    robot.visual = group;
    robot.materials = [...materials.values()];
  }

  updateFollowBodyId() {
    if (Number.isInteger(this.pelvis_body_id)) {
      this.followBodyId = this.pelvis_body_id;
      return;
    }
    if (this.model && this.model.nbody > 1) {
      this.followBodyId = 1;
    }
  }

  updateCameraFollow() {
    if (!this.followEnabled) {
      return;
    }
    const bodyId = Number.isInteger(this.followBodyId) ? this.followBodyId : null;
    if (bodyId === null) {
      return;
    }
    const cached = this.lastSimState.bodies.get(bodyId);
    if (!cached) {
      return;
    }
    this.followTargetDesired.set(cached.position.x, this.followHeight, cached.position.z);
    if (!this.followInitialized) {
      this.followTarget.copy(this.followTargetDesired);
      this.followInitialized = true;
    } else {
      this.followTarget.lerp(this.followTargetDesired, this.followLerp);
    }

    this.followDelta.subVectors(this.followTarget, this.controls.target);
    this.controls.target.copy(this.followTarget);
    this.camera.position.add(this.followDelta);
  }

  /**
   * Starts the real-time loop, unless one is already running, in which case its
   * promise is returned. Callers restart the loop with `alive = false ... alive
   * = true; main_loop()`; if the old loop was still asleep, that used to leave
   * two loops stepping the same sim at twice the speed.
   */
  main_loop() {
    if (!this.policyRunner) {
      return Promise.resolve();
    }
    if (!this._loopPromise) {
      this._loopPromise = this._runLoop().finally(() => {
        this._loopPromise = null;
      });
    }
    return this._loopPromise;
  }

  /** Stops the real-time loop and waits until its in-flight tick has finished. */
  async stopMainLoop() {
    this.alive = false;
    await this._loopPromise;
  }

  async _runLoop() {
    while (this.alive) {
      const loopStart = performance.now();

      if (!this.params.paused && this.model && this.data && this.simulation && this.policyRunner) {
        if (!(await this.stepPolicyTick())) {
          break;
        }

        this._stepFrameCount += 1;
        const now = performance.now();
        const elapsedStep = now - this._stepLastTime;
        if (elapsedStep >= 500) {
          this.simStepHz = (this._stepFrameCount * 1000) / elapsedStep;
          this._stepFrameCount = 0;
          this._stepLastTime = now;
        }
      } else {
        this.simStepHz = 0;
        this._stepFrameCount = 0;
        this._stepLastTime = performance.now();
      }

      const loopEnd = performance.now();
      const elapsed = (loopEnd - loopStart) / 1000;
      const target = this.timestep * this.decimation;
      const sleepTime = Math.max(0, target - elapsed);
      await new Promise((resolve) => setTimeout(resolve, sleepTime * 1000));
    }
  }

  /**
   * Advances the sim by exactly one policy tick: the command clock, one policy
   * inference and `decimation` physics substeps. The real-time loop calls it
   * once per iteration; a benchmark run stops that loop and calls it itself, so
   * a test is always the same number of ticks however fast the machine is.
   * Returns false if inference failed (and sets `alive = false`).
   *
   * In a grouped benchmark run (see addExtraRobots) every robot takes this
   * tick in turn, against the one command the sequencer set for it. The robots
   * share the mjModel but each has its own mjData and policy state, so each
   * one's run is bit-for-bit what it would be alone.
   */
  async stepPolicyTick() {
    // Advance command playback/recording clock by one policy tick,
    // before observations are read so the command applies this tick
    commandSequencer.tick(this.timestep * this.decimation);

    for (const robot of this.robots) {
      if (!(await this._stepRobot(robot))) {
        return false;
      }
    }

    for (const runner of this.__simMetricsRecorders) {
      runner.captureFrame();
    }

    this._cacheRenderState();
    return true;
  }

  /**
   * One policy tick of one robot: fall detection, inference and the physics
   * substeps. `robot` is the demo itself (robot 0) or an extra robot; it holds
   * the per-robot state (mjData, policy runner, action buffers, pushes), while
   * the joint mapping, gains and model are shared from the demo.
   */
  async _stepRobot(robot) {
    const sim = robot.simulation;

    // Integrate the idealized command path and sample both traces. Uses the
    // same command the policy sees this tick; CoM is read from raw MjData.
    {
      const com = robot.data?.subtree_com;
      robot.idealPath.update(
        asimovCommandState,
        this.timestep * this.decimation,
        com ? { x: com[0], y: com[1] } : null
      );
    }

    // Tumble/fall detection BEFORE policy inference
    const gyroMag = Math.abs(sim.qvel[3] || 0)
                  + Math.abs(sim.qvel[4] || 0)
                  + Math.abs(sim.qvel[5] || 0);

    // Compute projected gravity z in body frame from quaternion
    // quat = [w, x, y, z] at qpos[3:7]
    const qw = sim.qpos[3], qx = sim.qpos[4];
    const qy = sim.qpos[5], qz = sim.qpos[6];
    // gravity_z_body = R^T * [0,0,-1] dot [0,0,1] = -(1 - 2(qx²+qy²))
    const gravZ = -(1.0 - 2.0 * (qx * qx + qy * qy));

    // Fall detection: gravity_z > -0.866 means >30° tilt → DAMP mode
    if (gravZ > -0.166) robot._tumbling = true;

    if (robot._tumbling) {
      // DAMP mode: skip policy, hold current positions with KP=10 KD=3
      if (!robot.actionTarget) {
        robot.actionTarget = new Float32Array(this.numActions);
      }
      for (let i = 0; i < this.numActions; i++) {
        const qpos_adr = this.qpos_adr_policy[i];
        robot.actionTarget[i] = sim.qpos[qpos_adr];
      }
      if (robot.filteredActionTarget) {
        robot.filteredActionTarget.set(robot.actionTarget);
      } else {
        robot.filteredActionTarget = new Float32Array(robot.actionTarget);
      }
    } else {
      // Normal mode: run policy
      const state = this.readPolicyState(robot);
      try {
        robot.actionTarget = await robot.policyRunner.step(state);
      } catch (e) {
        console.error('Inference error in main loop:', e);
        this.alive = false;
        return false;
      }

      // Track raw action magnitudes — DAMP if any action saturates
      if (robot.actionTarget) {
        robot.rawActions = robot.actionTarget;
        let maxAbs = 0;
        for (let i = 0; i < robot.actionTarget.length; i++) {
          const abs = Math.abs(robot.actionTarget[i]);
          if (abs > maxAbs) maxAbs = abs;
        }
        robot.maxRawAction = maxAbs;
        if (maxAbs > 100.0) robot._tumbling = true;
      }

      // Jitter computation at policy rate (50Hz) — 3rd finite difference (jerk)
      // From arXiv:2603.16180: |x_t - 3x_{t-1} + 3x_{t-2} - x_{t-3}| / dt³
      {
        const policyDt = this.timestep * this.decimation;
        const dt3 = policyDt * policyDt * policyDt;

        // Initialize jitter buffers
        if (!robot._jitterActionHist) {
          robot._jitterActionHist = [];
          robot._jitterVelHist = [];
          robot._jitterTorqueHist = [];
          robot._jitterAccum = { action: 0, vel: 0, torque: 0, count: 0 };
        }

        // Capture current values
        const nAct = this.numActions || 0;
        const curAction = robot.actionTarget ? Array.from(robot.actionTarget) : null;
        const nv = this.model?.nv || 0;
        const curVel = nv > 6 ? Array.from(sim.qvel).slice(6, 6 + nAct) : null;
        const curTorque = sim.ctrl ? Array.from(sim.ctrl).slice(0, nAct) : null;

        robot._jitterActionHist.push(curAction);
        robot._jitterVelHist.push(curVel);
        robot._jitterTorqueHist.push(curTorque);

        // Keep only last 4
        if (robot._jitterActionHist.length > 4) robot._jitterActionHist.shift();
        if (robot._jitterVelHist.length > 4) robot._jitterVelHist.shift();
        if (robot._jitterTorqueHist.length > 4) robot._jitterTorqueHist.shift();

        // Compute jerk if 4 frames available
        if (robot._jitterActionHist.length === 4 && robot._jitterActionHist[0]) {
          const jerk = (hist) => {
            if (!hist[0] || !hist[1] || !hist[2] || !hist[3]) return 0;
            let sum = 0;
            for (let i = 0; i < hist[0].length; i++) {
              sum += Math.abs(hist[3][i] - 3*hist[2][i] + 3*hist[1][i] - hist[0][i]) / dt3;
            }
            return sum / hist[0].length;
          };
          robot._jitterAccum.action += jerk(robot._jitterActionHist);
          robot._jitterAccum.vel += jerk(robot._jitterVelHist);
          robot._jitterAccum.torque += jerk(robot._jitterTorqueHist);
          robot._jitterAccum.count++;
        }

        // Expose averaged jitter (reset every 50 steps = 1 second)
        if (robot._jitterAccum.count >= 50) {
          const c = robot._jitterAccum.count;
          robot.jitterMetrics = {
            action: robot._jitterAccum.action / c,
            vel: robot._jitterAccum.vel / c,
            torque: robot._jitterAccum.torque / c,
          };
          robot._jitterAccum = { action: 0, vel: 0, torque: 0, count: 0 };
        }
      }

      // Apply one-pole LPF on action targets if configured
      if (robot.actionTarget) {
        if (!robot.filteredActionTarget) {
          robot.filteredActionTarget = new Float32Array(robot.actionTarget);
        } else {
          const alpha = this.actionLpfAlpha;
          for (let i = 0; i < this.numActions; i++) {
            robot.filteredActionTarget[i] = alpha * robot.actionTarget[i] + (1 - alpha) * robot.filteredActionTarget[i];
          }
        }
      }
    }

    for (let substep = 0; substep < this.decimation; substep++) {
      const sourceTarget = robot.filteredActionTarget ?? robot.actionTarget;
      const delayedActionTarget = robot._tumbling
        ? sourceTarget
        : this.getDelayedActionTarget(sourceTarget, robot);

      if (this.control_type === 'joint_position') {
        for (let i = 0; i < this.numActions; i++) {
          const qpos_adr = this.qpos_adr_policy[i];
          const qvel_adr = this.qvel_adr_policy[i];
          const ctrl_adr = this.ctrl_adr_policy[i];

          const targetJpos = delayedActionTarget ? delayedActionTarget[i] : 0.0;
          const kp = robot._tumbling ? 10.0 : (this.kpPolicy ? this.kpPolicy[i] : 0.0);
          const vel = sim.qvel[qvel_adr];

          // When feedforward damping is configured, split kd into kd_hw and kd_ff
          const hasFf = this.kdFfPolicy !== null && this.kdFfPolicy !== undefined;
          const kd = robot._tumbling ? 3.0 : (this.kdPolicy ? this.kdPolicy[i] : 0.0);
          const kd_hw = robot._tumbling ? 3.0 : (hasFf ? Math.min(kd, 5.0) : kd);
          let torque = kp * (targetJpos - sim.qpos[qpos_adr]) + kd_hw * (0 - vel);

          // Feedforward damping (only when kd_ff array is provided, skip in DAMP mode)
          if (hasFf && !robot._tumbling) {
            const kd_ff = this.kdFfPolicy[i] ?? 0.0;
            if (kd_ff > 0) {
              const tau_ff = Math.max(-30, Math.min(30, -kd_ff * vel));
              torque += tau_ff;
            }
          }

          let ctrlValue = torque;
          const ctrlRange = this.model?.actuator_ctrlrange;
          if (ctrlRange && ctrlRange.length >= (ctrl_adr + 1) * 2) {
            const min = ctrlRange[ctrl_adr * 2];
            const max = ctrlRange[(ctrl_adr * 2) + 1];
            if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
              ctrlValue = Math.min(Math.max(ctrlValue, min), max);
            }
          }
          sim.ctrl[ctrl_adr] = ctrlValue;
        }
      } else if (this.control_type === 'torque') {
        console.error('Torque control not implemented yet.');
      }

      const applied = sim.qfrc_applied;
      for (let i = 0; i < applied.length; i++) {
        applied[i] = 0.0;
      }
      // Mouse drag acts on robot 0 only, like click-to-push and the telemetry.
      const dragged = robot === this ? this.dragStateManager.physicsObject : null;
      if (robot === this && (!dragged || !dragged.bodyID)) {
        this.lastDragForce = 0;
      }
      if (dragged && dragged.bodyID) {
        for (let b = 0; b < this.model.nbody; b++) {
          if (this.bodies[b]) {
            getPosition(sim.xpos, b, this.bodies[b].position);
            getQuaternion(sim.xquat, b, this.bodies[b].quaternion);
            this.bodies[b].updateWorldMatrix();
          }
        }
        const bodyID = dragged.bodyID;
        this.dragStateManager.update();
        const force = toMujocoPos(
          this.dragStateManager.currentWorld.clone()
            .sub(this.dragStateManager.worldHit)
            .multiplyScalar(60.0)
        );
        // clamp force magnitude
        const forceMagnitude = Math.sqrt(force.x * force.x + force.y * force.y + force.z * force.z);
        const maxForce = 50.0;
        if (forceMagnitude > maxForce) {
          const scale = maxForce / forceMagnitude;
          force.x *= scale;
          force.y *= scale;
          force.z *= scale;
        }
        this.lastDragForce = Math.min(forceMagnitude, maxForce);
        const point = toMujocoPos(this.dragStateManager.worldHit.clone());
        sim.applyForce(force.x, force.y, force.z, 0, 0, 0, point.x, point.y, point.z, bodyID);
      }

      // Click-to-push and scripted (JSON) pushes: apply each active push's
      // force (and torque, if any — click-to-push/drag entries never set
      // one, so this falls back to zero for them) for its remaining
      // substeps, then drop it once exhausted.
      for (let i = robot._activePushes.length - 1; i >= 0; i--) {
        const p = robot._activePushes[i];
        const tq = p.torque || { x: 0, y: 0, z: 0 };
        sim.applyForce(p.force.x, p.force.y, p.force.z, tq.x, tq.y, tq.z, p.point.x, p.point.y, p.point.z, p.bodyID);
        p.stepsLeft--;
        if (p.stepsLeft <= 0) robot._activePushes.splice(i, 1);
      }

      sim.step();
    }

    return true;
  }

  /** Copies body, light and tendon poses for render(); see lastSimState. */
  _cacheRenderState() {
    for (let b = 0; b < this.model.nbody; b++) {
      if (!this.bodies[b]) {
        continue;
      }
      if (!this.lastSimState.bodies.has(b)) {
        this.lastSimState.bodies.set(b, {
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion()
        });
      }
      const cached = this.lastSimState.bodies.get(b);
      getPosition(this.simulation.xpos, b, cached.position);
      getQuaternion(this.simulation.xquat, b, cached.quaternion);
    }

    const numLights = this.model.nlight;
    for (let l = 0; l < numLights; l++) {
      if (!this.lights[l]) {
        continue;
      }
      if (!this.lastSimState.lights.has(l)) {
        this.lastSimState.lights.set(l, {
          position: new THREE.Vector3(),
          direction: new THREE.Vector3()
        });
      }
      const cached = this.lastSimState.lights.get(l);
      getPosition(this.simulation.light_xpos, l, cached.position);
      getPosition(this.simulation.light_xdir, l, cached.direction);
    }

    this.lastSimState.tendons.numWraps = {
      count: this.model.nwrap,
      matrix: this.lastSimState.tendons.matrix
    };
    for (const robot of this.extraRobots) {
      for (const b of Object.keys(robot.bodies)) {
        if (!robot.lastSimState.bodies.has(b)) {
          robot.lastSimState.bodies.set(b, {
            position: new THREE.Vector3(),
            quaternion: new THREE.Quaternion()
          });
        }
        const cached = robot.lastSimState.bodies.get(b);
        getPosition(robot.simulation.xpos, Number(b), cached.position);
        getQuaternion(robot.simulation.xquat, Number(b), cached.quaternion);
      }
    }
  }

  onWindowResize() {
    // While the body picker has borrowed the canvas (see enterBodyPicker), it
    // is sized to the small picker container, not the full window — resizing
    // the browser must keep it fit to that container instead of re-stretching
    // it to window dimensions inside the small dialog panel.
    if (this._pickingMode && this._pickerContainer) {
      const width = this._pickerContainer.clientWidth;
      const height = this._pickerContainer.clientHeight;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(this.renderScale);
      this.renderer.setSize(width, height);
      this._lastRenderTime = 0;
      this.render();
      return;
    }
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.renderScale);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this._lastRenderTime = 0;
    this.render();
  }

  setRenderScale(scale) {
    const clamped = Math.max(0.5, Math.min(2.0, scale));
    this.renderScale = clamped;
    this.renderer.setPixelRatio(this.renderScale);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this._lastRenderTime = 0;
    this.render();
  }

  getSimStepHz() {
    return this.simStepHz;
  }

  readPolicyState(robot = this) {
    const qpos = robot.simulation.qpos;
    const qvel = robot.simulation.qvel;
    const jointPos = new Float32Array(this.numActions);
    const jointVel = new Float32Array(this.numActions);
    for (let i = 0; i < this.numActions; i++) {
      const qposAdr = this.qpos_adr_policy[i];
      const qvelAdr = this.qvel_adr_policy[i];
      jointPos[i] = qpos[qposAdr];
      jointVel[i] = qvel[qvelAdr];
    }
    const rootPos = new Float32Array([qpos[0], qpos[1], qpos[2]]);
    const rootQuat = new Float32Array([qpos[3], qpos[4], qpos[5], qpos[6]]);
    const rootAngVel = new Float32Array([qvel[3], qvel[4], qvel[5]]);
    const complianceEnabled = Boolean(this.params?.compliance_enabled);
    const rawThreshold = Number(this.params?.compliance_threshold);
    const complianceThreshold = Number.isFinite(rawThreshold) ? rawThreshold : 10.0;
    return {
      jointPos,
      jointVel,
      rootPos,
      rootQuat,
      rootAngVel,
      complianceEnabled,
      complianceThreshold
    };
  }

  resetSimulation(robot = this) {
    if (!robot.simulation) {
      return;
    }
    this.params.paused = true;
    robot.simulation.resetData();
    robot._tumbling = false;

    // Apply keyframe: set root height and joint positions
    // Freejoint qpos: [x, y, z, qw, qx, qy, qz] at indices 0-6
    robot.simulation.qpos[2] = 0.614;  // standing height (shallow crouch)
    robot.simulation.qpos[3] = 1.0;    // quat w (upright)
    robot.simulation.qpos[4] = 0.0;
    robot.simulation.qpos[5] = 0.0;
    robot.simulation.qpos[6] = 0.0;
    if (this.defaultJposPolicy && this.qpos_adr_policy) {
      const noise = robot.benchmarkRandomization?.initialJointNoiseRad || 0;
      const random = robot.benchmarkRandomization?.random;
      for (let i = 0; i < this.numActions; i++) {
        const qpos_adr = this.qpos_adr_policy[i];
        const offset = noise > 0 && random ? (random() * 2 - 1) * noise : 0;
        robot.simulation.qpos[qpos_adr] = this.defaultJposPolicy[i] + offset;
      }
    }

    robot.simulation.forward();
    robot.actionTarget = null;
    robot.filteredActionTarget = null;
    robot.rawActions = null;
    // A push still being applied when the previous test ended must not carry
    // over into this one.
    robot._activePushes = [];
    this.resetActionDelay(null, robot);
    if (robot.policyRunner) {
      const state = this.readPolicyState(robot);
      robot.policyRunner.reset(state);
      this.params.current_motion = 'default';
    }
    this.reanchorIdealPath(robot);
    this.params.paused = false;
  }

  render() {
    if (!this.model || !this.data || !this.simulation) {
      return;
    }
    const now = performance.now();
    if (now - this._lastRenderTime < 30) {
      return;
    }
    this._lastRenderTime = now;

    this.updateCameraFollow();
    this.controls.update();

    for (const [b, cached] of this.lastSimState.bodies) {
      if (this.bodies[b]) {
        this.bodies[b].position.copy(cached.position);
        this.bodies[b].quaternion.copy(cached.quaternion);
        this.bodies[b].updateWorldMatrix();
      }
    }

    for (const robot of this.extraRobots) {
      for (const [b, cached] of robot.lastSimState.bodies) {
        const body = robot.bodies[b];
        if (body) {
          body.position.copy(cached.position);
          body.quaternion.copy(cached.quaternion);
          body.updateWorldMatrix();
        }
      }
      // A fallen robot fades further, so the ones still walking stand out.
      const opacity = robot._tumbling ? FALLEN_ROBOT_OPACITY : EXTRA_ROBOT_OPACITY;
      if (robot._shownOpacity !== opacity) {
        for (const material of robot.materials) material.opacity = opacity;
        robot._shownOpacity = opacity;
      }
    }

    for (const [l, cached] of this.lastSimState.lights) {
      if (this.lights[l]) {
        this.lights[l].position.copy(cached.position);
        this.lights[l].lookAt(cached.direction.clone().add(this.lights[l].position));
      }
    }

    if (this.mujocoRoot && this.mujocoRoot.cylinders) {
      const numWraps = this.lastSimState.tendons.numWraps.count;
      this.mujocoRoot.cylinders.count = numWraps;
      this.mujocoRoot.spheres.count = numWraps > 0 ? numWraps + 1 : 0;
      this.mujocoRoot.cylinders.instanceMatrix.needsUpdate = true;
      this.mujocoRoot.spheres.instanceMatrix.needsUpdate = true;
    }

    if (this.idealMarker) {
      this.idealMarker.visible = Boolean(this.showIdealMarker);
      const p = this.idealPath;
      // MuJoCo (x, y, z) -> Three (x, z, -y); yaw about +Z maps to rotation.y
      this.idealMarker.position.set(p.x, p.comZ, -p.y);
      this.idealMarker.rotation.y = p.heading;
    }

    this.renderer.render(this.scene, this.camera);
  }
}
