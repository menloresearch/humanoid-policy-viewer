import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DragStateManager } from './utils/DragStateManager.js';
import { downloadExampleScenesFolder, getPosition, getQuaternion, toMujocoPos, reloadScene, reloadPolicy } from './mujocoUtils.js';
import { commandSequencer } from './commandSequencer.js';
import { asimovCommandState } from './observationHelpers.js';
import { IdealPathTracker, yawFromQuat } from './idealPath.js';

const defaultPolicy = "./examples/checkpoints/asimov/reference_policy_config.json";
// The canonical Asimov model from the asimov-1 submodule; see
// public/examples/scenes/README.md. Mirrors the 'asimov-reference' entry's
// scenePath in Demo.vue's policy list — keep the two in sync so the scene
// shown on load matches what re-selecting that same policy would load.
const defaultScene = "asimov-1/sim-model/xmls/asimov_1.xml";

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

    this.bodies = {};
    this.lights = {};

    this.container = document.getElementById('mujoco-container');

    this.scene = new THREE.Scene();
    this.scene.name = 'scene';

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.001, 100);
    this.camera.name = 'PerspectiveCamera';
    this.camera.position.set(3.0, 2.2, 3.0);
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
   * a benchmark reads depends on it (metrics read this.simulation /
   * readFootGroundForces() directly) — so headless CI runs (see
   * runHeadlessBenchmark() in Demo.vue) can skip it entirely. Software-
   * rendered WebGL (no GPU passthrough, e.g. most CI runners) makes this a
   * meaningful chunk of the per-frame cost, not just an idle canvas.
   */
  stopRenderLoop() {
    this.renderer.setAnimationLoop(null);
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

  reanchorIdealPath() {
    if (!this.simulation) {
      return;
    }
    const q = this.simulation.qpos;
    const comZ = this.data?.subtree_com?.[2] ?? 0.6;
    this.idealPath.reanchor(q[0], q[1], yawFromQuat(q[3], q[4], q[5], q[6]), comZ);
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
   * click-to-push.
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
    const xipos = this.simulation.xipos;

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

    this._activePushes.push({
      bodyID,
      force: { x: (dx / dirLen) * mag, y: (dy / dirLen) * mag, z: ((dz || 0) / dirLen) * mag },
      torque,
      point: { x: xipos[bodyID * 3 + 0], y: xipos[bodyID * 3 + 1], z: xipos[bodyID * 3 + 2] },
      stepsLeft,
    });
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

  resetActionDelay(seedTarget = null) {
    const span = this.actionDelayMaxLag - this.actionDelayMinLag + 1;
    // Pin a fixed, reproducible "typical" lag (the midpoint of the policy's
    // configured delay range) instead of drawing one — a random draw here was
    // the sole source of run-to-run flakiness in push-threshold results near a
    // policy's actual capability boundary (see benchmark/VARIANCE_ANALYSIS.md).
    this.actionDelayLag = this.actionDelayMinLag + Math.floor((span - 1) / 2);
    this.actionDelayBuffer = [];
    if (seedTarget && this.actionDelayLag > 0) {
      for (let i = 0; i < this.actionDelayLag; i++) {
        this.actionDelayBuffer.push(new Float32Array(seedTarget));
      }
    }
  }

  getDelayedActionTarget(sourceTarget) {
    if (!sourceTarget || this.actionDelayLag <= 0) {
      return sourceTarget;
    }
    this.actionDelayBuffer.push(new Float32Array(sourceTarget));
    while (this.actionDelayBuffer.length > this.actionDelayLag + 1) {
      this.actionDelayBuffer.shift();
    }
    return this.actionDelayBuffer[0] ?? sourceTarget;
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

  async main_loop() {
    if (!this.policyRunner) {
      return;
    }

    while (this.alive) {
      const loopStart = performance.now();

      if (!this.params.paused && this.model && this.data && this.simulation && this.policyRunner) {
        // Advance command playback/recording clock by one policy tick,
        // before observations are read so the command applies this tick
        commandSequencer.tick(this.timestep * this.decimation);

        // Integrate the idealized command path and sample both traces. Uses the
        // same command the policy sees this tick; CoM is read from raw MjData.
        {
          const com = this.data?.subtree_com;
          this.idealPath.update(
            asimovCommandState,
            this.timestep * this.decimation,
            com ? { x: com[0], y: com[1] } : null
          );
        }

        // Tumble/fall detection BEFORE policy inference
        const gyroMag = Math.abs(this.simulation.qvel[3] || 0)
                      + Math.abs(this.simulation.qvel[4] || 0)
                      + Math.abs(this.simulation.qvel[5] || 0);

        // Compute projected gravity z in body frame from quaternion
        // quat = [w, x, y, z] at qpos[3:7]
        const qw = this.simulation.qpos[3], qx = this.simulation.qpos[4];
        const qy = this.simulation.qpos[5], qz = this.simulation.qpos[6];
        // gravity_z_body = R^T * [0,0,-1] dot [0,0,1] = -(1 - 2(qx²+qy²))
        const gravZ = -(1.0 - 2.0 * (qx * qx + qy * qy));

        // Fall detection: gravity_z > -0.866 means >30° tilt → DAMP mode
        if (gravZ > -0.166) this._tumbling = true;

        if (this._tumbling) {
          // DAMP mode: skip policy, hold current positions with KP=10 KD=3
          if (!this.actionTarget) {
            this.actionTarget = new Float32Array(this.numActions);
          }
          for (let i = 0; i < this.numActions; i++) {
            const qpos_adr = this.qpos_adr_policy[i];
            this.actionTarget[i] = this.simulation.qpos[qpos_adr];
          }
          if (this.filteredActionTarget) {
            this.filteredActionTarget.set(this.actionTarget);
          } else {
            this.filteredActionTarget = new Float32Array(this.actionTarget);
          }
        } else {
          // Normal mode: run policy
          const state = this.readPolicyState();
          try {
            this.actionTarget = await this.policyRunner.step(state);
          } catch (e) {
            console.error('Inference error in main loop:', e);
            this.alive = false;
            break;
          }

          // Track raw action magnitudes — DAMP if any action saturates
          if (this.actionTarget) {
            this.rawActions = this.actionTarget;
            let maxAbs = 0;
            for (let i = 0; i < this.actionTarget.length; i++) {
              const abs = Math.abs(this.actionTarget[i]);
              if (abs > maxAbs) maxAbs = abs;
            }
            this.maxRawAction = maxAbs;
            if (maxAbs > 100.0) this._tumbling = true;
          }

          // Jitter computation at policy rate (50Hz) — 3rd finite difference (jerk)
          // From arXiv:2603.16180: |x_t - 3x_{t-1} + 3x_{t-2} - x_{t-3}| / dt³
          {
            const policyDt = this.timestep * this.decimation;
            const dt3 = policyDt * policyDt * policyDt;

            // Initialize jitter buffers
            if (!this._jitterActionHist) {
              this._jitterActionHist = [];
              this._jitterVelHist = [];
              this._jitterTorqueHist = [];
              this._jitterAccum = { action: 0, vel: 0, torque: 0, count: 0 };
            }

            // Capture current values
            const nAct = this.numActions || 0;
            const curAction = this.actionTarget ? Array.from(this.actionTarget) : null;
            const nv = this.model?.nv || 0;
            const curVel = nv > 6 ? Array.from(this.simulation.qvel).slice(6, 6 + nAct) : null;
            const curTorque = this.simulation.ctrl ? Array.from(this.simulation.ctrl).slice(0, nAct) : null;

            this._jitterActionHist.push(curAction);
            this._jitterVelHist.push(curVel);
            this._jitterTorqueHist.push(curTorque);

            // Keep only last 4
            if (this._jitterActionHist.length > 4) this._jitterActionHist.shift();
            if (this._jitterVelHist.length > 4) this._jitterVelHist.shift();
            if (this._jitterTorqueHist.length > 4) this._jitterTorqueHist.shift();

            // Compute jerk if 4 frames available
            if (this._jitterActionHist.length === 4 && this._jitterActionHist[0]) {
              const jerk = (hist) => {
                if (!hist[0] || !hist[1] || !hist[2] || !hist[3]) return 0;
                let sum = 0;
                for (let i = 0; i < hist[0].length; i++) {
                  sum += Math.abs(hist[3][i] - 3*hist[2][i] + 3*hist[1][i] - hist[0][i]) / dt3;
                }
                return sum / hist[0].length;
              };
              this._jitterAccum.action += jerk(this._jitterActionHist);
              this._jitterAccum.vel += jerk(this._jitterVelHist);
              this._jitterAccum.torque += jerk(this._jitterTorqueHist);
              this._jitterAccum.count++;
            }

            // Expose averaged jitter (reset every 50 steps = 1 second)
            if (this._jitterAccum.count >= 50) {
              const c = this._jitterAccum.count;
              this.jitterMetrics = {
                action: this._jitterAccum.action / c,
                vel: this._jitterAccum.vel / c,
                torque: this._jitterAccum.torque / c,
              };
              this._jitterAccum = { action: 0, vel: 0, torque: 0, count: 0 };
            }
          }

          // Apply one-pole LPF on action targets if configured
          if (this.actionTarget) {
            if (!this.filteredActionTarget) {
              this.filteredActionTarget = new Float32Array(this.actionTarget);
            } else {
              const alpha = this.actionLpfAlpha;
              for (let i = 0; i < this.numActions; i++) {
                this.filteredActionTarget[i] = alpha * this.actionTarget[i] + (1 - alpha) * this.filteredActionTarget[i];
              }
            }
          }
        }

        for (let substep = 0; substep < this.decimation; substep++) {
          const sourceTarget = this.filteredActionTarget ?? this.actionTarget;
          const delayedActionTarget = this._tumbling
            ? sourceTarget
            : this.getDelayedActionTarget(sourceTarget);

          if (this.control_type === 'joint_position') {
            for (let i = 0; i < this.numActions; i++) {
              const qpos_adr = this.qpos_adr_policy[i];
              const qvel_adr = this.qvel_adr_policy[i];
              const ctrl_adr = this.ctrl_adr_policy[i];

              const targetJpos = delayedActionTarget ? delayedActionTarget[i] : 0.0;
              const kp = this._tumbling ? 10.0 : (this.kpPolicy ? this.kpPolicy[i] : 0.0);
              const vel = this.simulation.qvel[qvel_adr];

              // When feedforward damping is configured, split kd into kd_hw and kd_ff
              const hasFf = this.kdFfPolicy !== null && this.kdFfPolicy !== undefined;
              const kd = this._tumbling ? 3.0 : (this.kdPolicy ? this.kdPolicy[i] : 0.0);
              const kd_hw = this._tumbling ? 3.0 : (hasFf ? Math.min(kd, 5.0) : kd);
              let torque = kp * (targetJpos - this.simulation.qpos[qpos_adr]) + kd_hw * (0 - vel);

              // Feedforward damping (only when kd_ff array is provided, skip in DAMP mode)
              if (hasFf && !this._tumbling) {
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
              this.simulation.ctrl[ctrl_adr] = ctrlValue;
            }
          } else if (this.control_type === 'torque') {
            console.error('Torque control not implemented yet.');
          }

          const applied = this.simulation.qfrc_applied;
          for (let i = 0; i < applied.length; i++) {
            applied[i] = 0.0;
          }
          const dragged = this.dragStateManager.physicsObject;
          if (!dragged || !dragged.bodyID) {
            this.lastDragForce = 0;
          }
          if (dragged && dragged.bodyID) {
            for (let b = 0; b < this.model.nbody; b++) {
              if (this.bodies[b]) {
                getPosition(this.simulation.xpos, b, this.bodies[b].position);
                getQuaternion(this.simulation.xquat, b, this.bodies[b].quaternion);
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
            this.simulation.applyForce(force.x, force.y, force.z, 0, 0, 0, point.x, point.y, point.z, bodyID);
          }

          // Click-to-push and scripted (JSON) pushes: apply each active push's
          // force (and torque, if any — click-to-push/drag entries never set
          // one, so this falls back to zero for them) for its remaining
          // substeps, then drop it once exhausted.
          for (let i = this._activePushes.length - 1; i >= 0; i--) {
            const p = this._activePushes[i];
            const tq = p.torque || { x: 0, y: 0, z: 0 };
            this.simulation.applyForce(p.force.x, p.force.y, p.force.z, tq.x, tq.y, tq.z, p.point.x, p.point.y, p.point.z, p.bodyID);
            p.stepsLeft--;
            if (p.stepsLeft <= 0) this._activePushes.splice(i, 1);
          }

          this.simulation.step();
        }

        for (const runner of this.__simMetricsRecorders) {
          runner.captureFrame();
        }

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

  readPolicyState() {
    const qpos = this.simulation.qpos;
    const qvel = this.simulation.qvel;
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

  resetSimulation() {
    if (!this.simulation) {
      return;
    }
    this.params.paused = true;
    this.simulation.resetData();
    this._tumbling = false;

    // Apply keyframe: set root height and joint positions
    // Freejoint qpos: [x, y, z, qw, qx, qy, qz] at indices 0-6
    this.simulation.qpos[2] = 0.614;  // standing height (shallow crouch)
    this.simulation.qpos[3] = 1.0;    // quat w (upright)
    this.simulation.qpos[4] = 0.0;
    this.simulation.qpos[5] = 0.0;
    this.simulation.qpos[6] = 0.0;
    if (this.defaultJposPolicy && this.qpos_adr_policy) {
      for (let i = 0; i < this.numActions; i++) {
        const qpos_adr = this.qpos_adr_policy[i];
        this.simulation.qpos[qpos_adr] = this.defaultJposPolicy[i];
      }
    }

    this.simulation.forward();
    this.actionTarget = null;
    this.filteredActionTarget = null;
    this.resetActionDelay();
    if (this.policyRunner) {
      const state = this.readPolicyState();
      this.policyRunner.reset(state);
      this.params.current_motion = 'default';
    }
    this.reanchorIdealPath();
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
