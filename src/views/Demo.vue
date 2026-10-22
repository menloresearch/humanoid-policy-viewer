<template>
  <div id="mujoco-container"></div>
  <div v-show="state === 1" class="minimap">
    <canvas ref="minimapCanvas" class="minimap-canvas"></canvas>
    <div class="minimap-readout">tracking err: {{ minimapError }} m</div>
  </div>
  <div class="global-alerts">
    <v-alert
      v-if="isSmallScreen"
      v-model="showSmallScreenAlert"
      type="warning"
      variant="flat"
      density="compact"
      closable
      class="small-screen-alert"
    >
      Screen too small. The control panel is unavailable on small screens. Please use a desktop device.
    </v-alert>
    <v-alert
      v-if="isSafari"
      v-model="showSafariAlert"
      type="warning"
      variant="flat"
      density="compact"
      closable
      class="safari-alert"
    >
      Safari has lower memory limits, which can cause WASM to crash.
    </v-alert>
  </div>
  <div v-if="!isSmallScreen" class="controls" :style="{ width: panelWidth + 'px' }">
    <!-- Drag the inner edge to trade panel width against visible viewport;
         double-click resets. Pointer capture keeps the drag alive outside the
         handle and away from the canvas's orbit controls. -->
    <div
      class="panel-resizer"
      :class="{ dragging: isResizingPanel }"
      title="Drag to resize the panel · double-click to reset"
      @pointerdown="startPanelResize"
      @dblclick="resetPanelWidth"
    ><span class="grip"></span></div>
    <v-card class="controls-card">
      <v-card-title class="pb-0">Humanoid Policy Viewer</v-card-title>
      <div class="viewer-subtitle">
        <span class="made-for">made for</span>
        <a href="https://github.com/menloresearch/cyclotron" target="_blank" rel="noopener">
          <v-icon icon="mdi-github" size="small"></v-icon>Cyclotron
        </a>
      </div>
      <v-card-text class="py-0 controls-body">
        <v-divider class="my-2"/>
        <span class="status-name">Policy</span>
        <div v-if="policyDescription" class="text-caption">{{ policyDescription }}</div>
        <v-select
          v-model="currentPolicy"
          :items="policyItems"
          class="mt-2"
          label="Select policy"
          density="compact"
          hide-details
          item-title="title"
          item-value="value"
          :disabled="isPolicyLoading || state !== 1"
          @update:modelValue="onPolicyChange"
        ></v-select>
        <v-progress-linear
          v-if="isPolicyLoading"
          indeterminate
          height="4"
          color="primary"
          class="mt-2"
        ></v-progress-linear>
        <v-alert
          v-if="policyLoadError"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-2"
        >
          {{ policyLoadError }}
        </v-alert>

        <template v-if="!isVelocityCommandPolicy">
          <div class="status-legend follow-controls mt-2">
            <span class="status-name">Compliance</span>
            <v-btn
              size="x-small"
              variant="tonal"
              color="primary"
              :disabled="state !== 1"
              @click="toggleCompliance"
            >
              {{ complianceEnabled ? 'On' : 'Off' }}
            </v-btn>
            <span class="status-name">threshold</span>
            <span class="text-caption">{{ complianceThresholdLabel }}</span>
          </div>
          <v-slider
            v-model="complianceThreshold"
            min="10"
            max="20"
            step="0.1"
            density="compact"
            hide-details
            :disabled="state !== 1 || !complianceEnabled"
            @update:modelValue="onComplianceThresholdChange"
          ></v-slider>
        </template>

        <v-divider class="my-2"/>
        <!-- How Reset starts the robot; a benchmark test sets its own -->
        <v-select
          v-model="startPreset" :items="START_PRESETS" item-title="title" item-value="value"
          label="Start pose" density="compact" hide-details class="mb-1"
          title="Where Reset puts the robot. Policy default is the policy's own start (env.yaml init_state); loading a policy always starts it there"
        ></v-select>
        <div class="d-flex align-center ga-2">
          <v-checkbox
            v-model="settleOn" label="Drop and settle" density="compact" hide-details
            title="On Reset, leave the robot limp until it comes to rest before the policy takes over"
          ></v-checkbox>
          <v-text-field
            v-if="settleOn"
            v-model.number="settleSeconds" label="settle (s)" type="number" min="0.1" :max="MAX_SETTLE_S" step="0.5"
            density="compact" hide-details="auto" :error-messages="settleError" style="max-width: 110px"
          ></v-text-field>
        </div>
        <template v-if="isVelocityCommandPolicy">
          <v-divider class="my-2"/>
          <span class="status-name">Velocity Command</span>
          <div class="status-legend mt-1">
            <span class="text-caption">vx (fwd)</span>
            <span class="text-caption">{{ cmdVxLabel }}</span>
          </div>
          <v-slider
            v-model="cmdVx"
            :min="cmdLimits.vx[0]"
            :max="cmdLimits.vx[1]"
            step="0.05"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onCmdVxChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">vy (lateral)</span>
            <span class="text-caption">{{ cmdVyLabel }}</span>
          </div>
          <v-slider
            v-model="cmdVy"
            :min="cmdLimits.vy[0]"
            :max="cmdLimits.vy[1]"
            step="0.05"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onCmdVyChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">wz (yaw rate)</span>
            <span class="text-caption">{{ cmdWzLabel }}</span>
          </div>
          <v-slider
            v-model="cmdWz"
            :min="cmdLimits.wz[0]"
            :max="cmdLimits.wz[1]"
            step="0.05"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onCmdWzChange"
          ></v-slider>

          <v-divider class="my-2"/>
          <details open>
            <summary style="cursor:pointer; font-size: 12px;"><b>Tests &amp; Benchmark</b></summary>

            <!-- Benchmarks and their tests: double-click a benchmark to run it,
                 double-click a test to play it live, pencil to edit it. -->
            <BenchmarkBrowser
              ref="benchmarkBrowser"
              class="mt-1"
              :running="benchmark.running"
              @play="playTest"
              @edit="editTest"
              @new="newTestInEditor"
              @run="requestBenchmark"
            />

            <div class="d-flex align-center mt-2">
              <span class="text-caption text-medium-emphasis">
                Policies to benchmark ({{ benchmarkPolicies.length }}/{{ policyItems.length }})
              </span>
              <v-spacer />
              <v-btn
                variant="text"
                size="x-small"
                :disabled="benchmark.running"
                @click="selectAllPolicies(true)"
              >all</v-btn>
              <v-btn
                variant="text"
                size="x-small"
                :disabled="benchmark.running"
                @click="selectAllPolicies(false)"
              >none</v-btn>
            </div>
            <div class="policy-picker">
              <div
                v-for="item in policyItems"
                :key="item.value"
                class="policy-row d-flex align-center ga-1"
              >
                <v-checkbox-btn
                  :model-value="benchmarkPolicies.includes(item.value)"
                  class="flex-shrink-0"
                  density="compact"
                  hide-details
                  :disabled="benchmark.running"
                  @update:modelValue="togglePolicy(item.value)"
                />
                <span class="policy-label" :title="item.title">{{ policyShort(item.title) }}</span>
                <v-icon
                  v-if="item.value === currentPolicy"
                  size="13"
                  class="flex-shrink-0 text-medium-emphasis"
                  title="Currently loaded in the viewer"
                >mdi-eye-outline</v-icon>
              </div>
            </div>

            <v-btn
              density="compact"
              color="primary"
              variant="flat"
              block
              class="mt-2"
              prepend-icon="mdi-play-box-multiple"
              :disabled="benchmarkSelectionCount === 0 || benchmark.running"
              @click="requestBenchmark"
            >Run Benchmark ({{ benchmarkSelectionCount }})</v-btn>

            <v-alert v-if="policyCatalogError" type="warning" density="compact" class="my-1">
              {{ policyCatalogError }} — only the built-in policy is available.
            </v-alert>
            <v-alert v-if="benchmark.error" type="error" density="compact" class="my-1">{{ benchmark.error }}</v-alert>
            <template v-if="benchmark.running">
              <div class="status-legend mt-1">
                <span class="text-caption">{{ benchmark.label || 'starting…' }}</span>
                <span class="text-caption">{{ benchmark.done }} / {{ benchmark.total }}</span>
              </div>
              <v-progress-linear
                :model-value="benchmark.total ? 100 * benchmark.done / benchmark.total : 0"
                height="4"
                color="primary"
                class="my-1"
              ></v-progress-linear>
              <v-btn
                density="compact"
                variant="text"
                size="small"
                block
                prepend-icon="mdi-stop"
                :disabled="benchmark.stopping"
                @click="benchmark.stopping = true"
              >{{ benchmark.stopping ? 'Stopping after this test…' : 'Stop (nothing is saved)' }}</v-btn>
            </template>
            <v-btn
              v-if="hasBenchmarkResult && !benchmark.running"
              density="compact"
              color="primary"
              variant="tonal"
              block
              prepend-icon="mdi-chart-box-outline"
              class="mt-1"
              :loading="resultsLoading"
              @click="viewResults"
            >View Results</v-btn>
            <template v-if="savedResultCount && !benchmark.running">
              <div class="text-caption text-medium-emphasis mt-2">
                Saved results ({{ savedResultCount }}) — open one on the results page for its charts and HTML export
              </div>
              <div class="saved-results">
                <div
                  v-for="result in appState.savedResults"
                  :key="result.file"
                  class="saved-result d-flex align-center ga-1"
                  :class="{ current: result.file === appState.benchmarkResultsFile }"
                >
                  <v-icon size="13" class="flex-shrink-0 text-medium-emphasis">mdi-file-chart-outline</v-icon>
                  <span class="result-label" :title="result.file">{{ resultLabel(result) }}</span>
                  <v-btn
                    v-if="!STATIC"
                    icon
                    size="x-small"
                    variant="text"
                    title="Delete this result"
                    @click="askDeleteResult(result)"
                  >
                    <v-icon size="14">mdi-delete-outline</v-icon>
                  </v-btn>
                </div>
              </div>
              <v-alert v-if="resultDeleteError" type="error" density="compact" class="my-1">{{ resultDeleteError }}</v-alert>
            </template>

            <!-- Live playback transport for the sequence currently loaded -->
            <v-alert v-if="playbackError" type="error" density="compact" class="my-1">{{ playbackError }}</v-alert>
            <v-alert v-if="playbackWarning" type="warning" density="compact" class="my-1">{{ playbackWarning }}</v-alert>
            <div class="status-legend mt-1">
              <span class="text-caption">{{ seq.name || 'no sequence loaded' }}</span>
              <span class="text-caption">t = {{ seq.t.toFixed(1) }} / {{ seq.duration.toFixed(1) }} s</span>
            </div>
            <v-progress-linear
              :model-value="seq.duration ? 100 * seq.t / seq.duration : 0"
              height="4"
              class="my-1"
            ></v-progress-linear>
            <div class="d-flex align-center ga-2 mt-1">
              <v-btn
                density="compact"
                color="primary"
                :disabled="state !== 1 || !seq.hasSequence || seq.mode === 'recording' || benchmark.running"
                @click="togglePlay"
              >{{ seq.mode === 'playing' ? 'Stop' : 'Play' }}</v-btn>
              <v-checkbox
                v-model="seqLoop"
                label="Loop"
                density="compact"
                hide-details
                @update:modelValue="onSeqLoopChange"
              ></v-checkbox>
            </div>
            <div class="d-flex align-center ga-2 mt-1">
              <v-btn
                density="compact"
                :color="seq.mode === 'recording' ? 'error' : undefined"
                :disabled="state !== 1 || seq.mode === 'playing' || benchmark.running"
                @click="toggleRecord"
              >{{ seq.mode === 'recording' ? `Stop Rec (${seq.keypointCount})` : 'Record' }}</v-btn>
              <v-btn
                density="compact"
                color="primary"
                variant="tonal"
                prepend-icon="mdi-pencil"
                :disabled="state !== 1 || seq.mode === 'recording' || benchmark.running"
                @click="openTrajectoryEditor"
              >Edit</v-btn>
            </div>
          </details>

          <!-- Deleting a saved result removes the file from disk; confirm first -->
          <v-dialog v-model="showDeleteResultConfirm" max-width="420">
            <v-card>
              <v-card-title class="text-subtitle-1">Delete this result?</v-card-title>
              <v-card-text class="text-body-2">
                <div class="mono-path">{{ pendingDeleteResult?.file }}</div>
                <div class="mt-1">{{ pendingDeleteResult ? resultLabel(pendingDeleteResult) : '' }}</div>
                <div class="text-caption text-medium-emphasis mt-2">
                  The file is removed from benchmark_results/ and can't be recovered from the app.
                  Download its HTML report first if you want to keep it.
                </div>
              </v-card-text>
              <v-card-actions>
                <v-spacer />
                <v-btn variant="text" @click="showDeleteResultConfirm = false">Cancel</v-btn>
                <v-btn color="error" variant="flat" :loading="deletingResult" @click="confirmDeleteResult">Delete</v-btn>
              </v-card-actions>
            </v-card>
          </v-dialog>

          <!-- Estimate + confirm before a (potentially long) benchmark run -->
          <v-dialog v-model="showBenchmarkConfirm" max-width="460">
            <v-card>
              <v-card-title class="text-subtitle-1">
                Run {{ pendingBenchmarkTitle || 'benchmark' }}?
              </v-card-title>
              <v-card-text class="text-body-2">
                <div v-if="pendingRun">
                  {{ pendingRun.tests.length }} test(s), {{ pendingRun.cells.length }} seeded repeat(s)
                  × {{ pendingRun.policies.length }} policy(ies)
                  = {{ pendingRun.cells.length * pendingRun.policies.length }} run(s),
                  up to {{ maxRobots }} robots side by side.
                </div>
                <v-alert
                  v-if="pendingRun?.problems.length"
                  type="warning"
                  density="compact"
                  class="mt-2"
                >
                  This viewer does not match the benchmark:
                  <ul class="ml-4"><li v-for="problem in pendingRun.problems" :key="problem">{{ problem }}</li></ul>
                  Running it anyway gives local-only results.
                </v-alert>
                <div v-if="pendingRun?.warnings.length" class="text-caption text-medium-emphasis mt-2">
                  <div v-for="warning in pendingRun.warnings" :key="warning">{{ warning }}</div>
                </div>
                <div class="mt-1">
                  Estimated time: <b>{{ benchmarkEstimateLabel }}</b> (sim time; wall-clock varies with
                  render speed).
                </div>
                <v-checkbox
                  v-model="benchmarkRealtime"
                  label="Watch at real-time speed"
                  density="compact"
                  hide-details
                  class="mt-1"
                ></v-checkbox>
                <div class="text-caption text-medium-emphasis">
                  The viewer will cycle policies and replay each test{{ benchmarkRealtime ? ' at real-time speed' : ', fast-forwarded' }};
                  leave this tab in the foreground.
                </div>
              </v-card-text>
              <v-card-actions>
                <v-spacer />
                <v-btn variant="text" @click="showBenchmarkConfirm = false">Cancel</v-btn>
                <v-btn
                  color="primary"
                  variant="flat"
                  @click="startBenchmark"
                >{{ pendingRun?.problems.length ? 'Run anyway' : 'Run' }}</v-btn>
              </v-card-actions>
            </v-card>
          </v-dialog>

          <v-divider class="my-2"/>
          <div class="status-legend">
            <span class="status-name">Interrupt (upper body)</span>
            <span class="text-caption">{{ interruptMask ? 'EXTERNAL' : 'POLICY' }}</span>
          </div>
          <v-switch
            v-model="interruptMask"
            :label="interruptMask ? 'Arms externally driven (mask=1)' : 'Policy controls arms (mask=0)'"
            density="compact"
            hide-details
            color="warning"
            :disabled="state !== 1"
            @update:modelValue="onInterruptMaskChange"
          ></v-switch>

          <v-divider class="my-2"/>
          <details>
          <summary style="cursor:pointer; font-size: 12px;">
            <b>Telemetry</b>
            <span :style="{color: robotStatus.color, fontWeight: 'bold', marginLeft: '6px'}">{{ robotStatus.label }}</span>
          </summary>
          <div class="telemetry-grid mt-1" style="font-family: monospace; font-size: 11px; line-height: 1.4;">
            <div><b>Base vel:</b> x={{ telemetry.vx }} y={{ telemetry.vy }} z={{ telemetry.vz }}</div>
            <div><b>Ang vel:</b> {{ telemetry.wx }} {{ telemetry.wy }} {{ telemetry.wz }}</div>
            <div><b>Height:</b> {{ telemetry.height }}m</div>
            <div><b>Pull force:</b> {{ telemetry.pullForce }}N (peak: {{ telemetry.peakPullForce }}N)</div>
            <div><b>Max action:</b> {{ telemetry.maxAction }}</div>
            <div><b>Gyro mag:</b> {{ telemetry.gyroMag }} rad/s</div>
            <div><b>Grav:</b> {{ telemetry.gravX }} {{ telemetry.gravY }} {{ telemetry.gravZ }}</div>
            <div><b>Peak gyro:</b> {{ telemetry.peakGyro }} rad/s</div>
            <div><b>Joint vel RMS:</b> {{ telemetry.jointVelRms }} rad/s</div>
            <div><b>Action jitter:</b> {{ telemetry.actionJitter }}</div>
            <div><b>Torque jitter:</b> {{ telemetry.torqueJitter }}</div>
            <div><b>Vel jerk:</b> {{ telemetry.velJerk }} rad/s³</div>
          </div>
          </details>
          <v-divider class="my-1"/>
          <details>
            <summary style="cursor:pointer; font-size: 12px;"><b>Joint Torques</b></summary>
            <div style="font-family: monospace; font-size: 10px; line-height: 1.3; max-height: 200px; overflow-y: auto;">
              <div v-for="(t, i) in telemetry.torques" :key="i">
                {{ telemetry.jointNames[i] }}: {{ t }}
              </div>
            </div>
          </details>
          <details>
            <summary style="cursor:pointer; font-size: 12px;"><b>Joint Positions</b></summary>
            <div style="font-family: monospace; font-size: 10px; line-height: 1.3; max-height: 200px; overflow-y: auto;">
              <div v-for="(p, i) in telemetry.jointPositions" :key="'jp'+i">
                {{ telemetry.allJointNames[i] }}: {{ p }}
              </div>
            </div>
          </details>
          <details>
            <summary style="cursor:pointer; font-size: 12px;"><b>L/R Symmetry Debug</b> (Δ=|L+R|, should be ~0)</summary>
            <div style="font-family: monospace; font-size: 10px; line-height: 1.3;">
              <div>Total asymmetry: <b :style="{color: parseFloat(telemetry.lrAsymmetryTotal) > 0.3 ? '#ff4444' : '#44ff44'}">{{ telemetry.lrAsymmetryTotal }}</b></div>
              <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 2px 6px; margin-top: 4px;">
                <div style="font-weight:bold;">joint</div>
                <div style="font-weight:bold; text-align:right;">L pos</div>
                <div style="font-weight:bold; text-align:right;">R pos</div>
                <div style="font-weight:bold; text-align:right;">|L+R|</div>
                <template v-for="(p, i) in telemetry.lrPairs" :key="'lr'+i">
                  <div>{{ p.name }}</div>
                  <div style="text-align:right;">{{ p.lPos }}</div>
                  <div style="text-align:right;">{{ p.rPos }}</div>
                  <div style="text-align:right;" :style="{color: parseFloat(p.posMirror) > 0.1 ? '#ff6644' : ''}">{{ p.posMirror }}</div>
                </template>
              </div>
              <div style="margin-top: 6px; color: #888;">Torques:</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 2px 6px;">
                <div style="font-weight:bold;">joint</div>
                <div style="font-weight:bold; text-align:right;">L τ</div>
                <div style="font-weight:bold; text-align:right;">R τ</div>
                <div style="font-weight:bold; text-align:right;">|L+R|</div>
                <template v-for="(p, i) in telemetry.lrPairs" :key="'lrt'+i">
                  <div>{{ p.name }}</div>
                  <div style="text-align:right;">{{ p.lTorque }}</div>
                  <div style="text-align:right;">{{ p.rTorque }}</div>
                  <div style="text-align:right;" :style="{color: parseFloat(p.torqueMirror) > 3.0 ? '#ff6644' : ''}">{{ p.torqueMirror }}</div>
                </template>
              </div>
            </div>
          </details>

          <v-divider class="my-2"/>
          <v-btn color="error" block density="compact" @click="resetVelocities" :disabled="state !== 1">
            Reset Velocities
          </v-btn>

          <v-divider class="my-2"/>
          <details>
          <summary style="cursor:pointer; font-size: 12px;"><b>Domain Randomization</b></summary>
          <div class="status-legend mt-1">
            <span class="text-caption">Friction</span>
            <span class="text-caption">{{ drFriction.toFixed(2) }}</span>
          </div>
          <v-slider
            v-model="drFriction"
            min="0.3"
            max="1.5"
            step="0.05"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrFrictionChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">Armature Scale</span>
            <span class="text-caption">{{ drArmatureScale.toFixed(2) }}x</span>
          </div>
          <v-slider
            v-model="drArmatureScale"
            min="0.5"
            max="1.5"
            step="0.05"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrArmatureChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">Delay Min Lag</span>
            <span class="text-caption">{{ drDelayMinLag }} steps</span>
          </div>
          <v-slider
            v-model="drDelayMinLag"
            min="0"
            max="5"
            step="1"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrDelayChange('min', $event)"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">Delay Max Lag</span>
            <span class="text-caption">{{ drDelayMaxLag }} steps</span>
          </div>
          <v-slider
            v-model="drDelayMaxLag"
            min="0"
            max="5"
            step="1"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrDelayChange('max', $event)"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">Gravity X</span>
            <span class="text-caption">{{ drGravityX.toFixed(2) }} m/s2</span>
          </div>
          <v-slider
            v-model="drGravityX"
            min="-0.5"
            max="0.5"
            step="0.05"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrGravityChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">Gravity Y</span>
            <span class="text-caption">{{ drGravityY.toFixed(2) }} m/s2</span>
          </div>
          <v-slider
            v-model="drGravityY"
            min="-0.5"
            max="0.5"
            step="0.05"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrGravityChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption" style="color: #ff6b6b;">IMU Bias X (obs only)</span>
            <span class="text-caption" style="color: #ff6b6b;">{{ imuBiasX.toFixed(2) }}</span>
          </div>
          <v-slider
            v-model="imuBiasX"
            min="-0.4"
            max="0.4"
            step="0.01"
            density="compact"
            hide-details
            color="red"
            @update:modelValue="onImuBiasXChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption" style="color: #ff6b6b;">IMU Bias Y (obs only)</span>
            <span class="text-caption" style="color: #ff6b6b;">{{ imuBiasY.toFixed(2) }}</span>
          </div>
          <v-slider
            v-model="imuBiasY"
            min="-0.4"
            max="0.4"
            step="0.01"
            density="compact"
            hide-details
            color="red"
            @update:modelValue="onImuBiasYChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">Added Mass (kg)</span>
            <span class="text-caption">{{ drAddedMass.toFixed(1) }} kg</span>
          </div>
          <v-slider
            v-model="drAddedMass"
            min="-5.0"
            max="5.0"
            step="0.5"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrMassChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">KP Scale</span>
            <span class="text-caption">{{ drKpScale.toFixed(2) }}x</span>
          </div>
          <v-slider
            v-model="drKpScale"
            min="0.5"
            max="2.0"
            step="0.05"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrKpChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">KD Scale</span>
            <span class="text-caption">{{ drKdScale.toFixed(2) }}x</span>
          </div>
          <v-slider
            v-model="drKdScale"
            min="0.5"
            max="2.0"
            step="0.05"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrKdChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">COM X (cm)</span>
            <span class="text-caption">{{ (drComX * 100).toFixed(1) }}</span>
          </div>
          <v-slider
            v-model="drComX"
            min="-0.05"
            max="0.05"
            step="0.005"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrComChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">COM Y (cm)</span>
            <span class="text-caption">{{ (drComY * 100).toFixed(1) }}</span>
          </div>
          <v-slider
            v-model="drComY"
            min="-0.05"
            max="0.05"
            step="0.005"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrComChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">COM Z (cm)</span>
            <span class="text-caption">{{ (drComZ * 100).toFixed(1) }}</span>
          </div>
          <v-slider
            v-model="drComZ"
            min="0.0"
            max="0.1"
            step="0.005"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrComChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">Link Mass Scale</span>
            <span class="text-caption">{{ drLinkMassScale.toFixed(2) }}x</span>
          </div>
          <v-slider
            v-model="drLinkMassScale"
            min="0.7"
            max="1.3"
            step="0.05"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrLinkMassChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">Toe Stiffness</span>
            <span class="text-caption">{{ drToeStiffness.toFixed(1) }} Nm/rad</span>
          </div>
          <v-slider
            v-model="drToeStiffness"
            min="0.5"
            max="15.0"
            step="0.5"
            density="compact"
            hide-details
            :disabled="state !== 1"
            @update:modelValue="onDrToeStiffnessChange"
          ></v-slider>
          <div class="status-legend">
            <span class="text-caption">Push Force</span>
            <span class="text-caption">{{ pushForce.toFixed(1) }} m/s</span>
          </div>
          <v-slider
            v-model="pushForce"
            min="0.5"
            max="3.0"
            step="0.1"
            density="compact"
            hide-details
            :disabled="state !== 1"
          ></v-slider>
          <div class="d-flex ga-1 mt-2">
            <v-btn color="warning" density="compact" class="flex-grow-1" @click="pushRobot('front')" :disabled="state !== 1">Front</v-btn>
            <v-btn color="warning" density="compact" class="flex-grow-1" @click="pushRobot('back')" :disabled="state !== 1">Back</v-btn>
            <v-btn color="warning" density="compact" class="flex-grow-1" @click="pushRobot('random')" :disabled="state !== 1">Random</v-btn>
          </div>
          </details>
        </template>

        <template v-if="!isVelocityCommandPolicy">
        <v-divider class="my-2"/>
        <div class="motion-status" v-if="trackingState">
          <div class="status-legend" v-if="trackingState.available">
            <span class="status-name">Current motion: {{ trackingState.currentName }}</span>
          </div>
        </div>

          <v-progress-linear
            v-if="shouldShowProgress"
            :model-value="progressValue"
            height="5"
            color="primary"
            rounded
            class="mt-3 motion-progress-no-animation"
          ></v-progress-linear>
        <v-alert
          v-if="showBackToDefault"
          type="info"
          variant="tonal"
          density="compact"
          class="mt-3"
        >
          Motion "{{ trackingState.currentName }}" finished. Return to the default pose before starting another clip.
          <v-btn color="primary" block density="compact" @click="backToDefault">
            Back to default pose
          </v-btn>
        </v-alert>

        <v-alert
          v-else-if="showMotionLockedNotice"
          type="warning"
          variant="tonal"
          density="compact"
          class="mt-3"
        >
          "{{ trackingState.currentName }}" is still playing. Wait until it finishes and returns to default pose before switching.
        </v-alert>

        <div v-if="showMotionSelect" class="motion-groups">
          <div v-for="group in motionGroups" :key="group.title" class="motion-group">
            <span class="status-name motion-group-title">{{ group.title }}</span>
            <v-chip
              v-for="item in group.items"
              :key="item.value"
              :disabled="item.disabled"
              :color="currentMotion === item.value ? 'primary' : undefined"
              :variant="currentMotion === item.value ? 'flat' : 'tonal'"
              class="motion-chip"
              size="x-small"
              @click="onMotionChange(item.value)"
            >
              {{ item.title }}
            </v-chip>
          </div>
        </div>

        <v-alert
          v-else-if="!trackingState.available"
          type="info"
          variant="tonal"
          density="compact"
        >
          Loading motion presets…
        </v-alert>

        <v-divider class="my-2"/>
        <div class="upload-section">
          <v-btn
            v-if="!showUploadOptions"
            variant="text"
            density="compact"
            color="primary"
            class="upload-toggle"
            @click="showUploadOptions = true"
          >
            Want to use customized motions?
          </v-btn>
          <template v-else>
            <span class="status-name">Custom motions</span>
            <v-file-input
              v-model="motionUploadFiles"
              label="Upload motion JSON"
              density="compact"
              hide-details
              accept=".json,application/json"
              prepend-icon="mdi-upload"
              multiple
              show-size
              :disabled="state !== 1"
              @update:modelValue="onMotionUpload"
            ></v-file-input>
            <div class="text-caption">
              See the <a target="_blank" href="https://github.com/menloresearch/humanoid-policy-viewer/blob/main/docs/adding-a-robot.md#3-optional-add-tracking-motions">motion format</a> for how to write motion JSON files.<br/>
              Each file should be a single clip (same schema as motions/default.json). File name becomes the motion name (prefixed with [new]). Duplicate names are ignored.
            </div>
            <v-alert
              v-if="motionUploadMessage"
              :type="motionUploadType"
              variant="tonal"
              density="compact"
            >
              {{ motionUploadMessage }}
            </v-alert>
          </template>
        </div>
        </template>

        <v-divider class="my-2"/>
        <div class="status-legend follow-controls">
          <span class="status-name">Camera follow</span>
          <v-btn
            size="x-small"
            variant="tonal"
            color="primary"
            :disabled="state !== 1"
            @click="toggleCameraFollow"
          >
            {{ cameraFollowEnabled ? 'On' : 'Off' }}
          </v-btn>
        </div>
        <div class="status-legend">
          <span class="status-name">Render scale</span>
          <span class="text-caption">{{ renderScaleLabel }}</span>
          <span class="status-name">Sim Freq</span>
          <span class="text-caption">{{ simStepLabel }}</span>
        </div>
        <v-slider
          v-model="renderScale"
          min="0.5"
          max="2.0"
          step="0.1"
          density="compact"
          hide-details
          @update:modelValue="onRenderScaleChange"
        ></v-slider>
      </v-card-text>
      <v-card-actions>
        <v-btn
          :color="damped ? 'success' : 'warning'" variant="tonal" :disabled="state !== 1" @click="toggleDamp"
          :title="damped ? 'Turn the policy back on, starting from where the robot is now' : 'Stop the policy and hold the joints weakly where they are (DAMP)'"
        >{{ damped ? 'Resume policy' : 'Damp' }}</v-btn>
        <v-btn color="primary" variant="tonal" class="flex-grow-1" :disabled="!!settleError" @click="reset">Reset</v-btn>
      </v-card-actions>
    </v-card>
  </div>
  <v-dialog :model-value="state === 0" persistent max-width="600px" scrollable>
    <v-card title="Loading Simulation Environment">
      <v-card-text>
        <v-progress-linear indeterminate color="primary"></v-progress-linear>
        Loading MuJoCo and ONNX policy, please wait
      </v-card-text>
    </v-card>
  </v-dialog>
  <v-dialog :model-value="state < 0" persistent max-width="600px" scrollable>
    <v-card title="Simulation Environment Loading Error">
      <v-card-text>
        <span v-if="state === -1">
          Unexpected runtime error, please refresh the page.<br />
          {{ extra_error_message }}
        </span>
        <span v-else-if="state === -2">
          Your browser does not support WebAssembly. Please use a recent version of Chrome, Edge, or Firefox.
        </span>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script>
import { MuJoCoDemo } from '@/simulation/main.js';
import { asimovCommandState, asimovInterruptState, imuBiasState } from '@/simulation/observationHelpers.js';
import { commandSequencer } from '@/simulation/commandSequencer.js';
import { runBenchmarkGroup, waitForPolicyReady, estimateBenchmarkSeconds } from '@/simulation/benchmarkRunner.js';
import { loadTestScene } from '@/simulation/terrainScene.js';
import { checkTests } from '@/benchmark/check.js';
import {
  MAX_ROBOTS, RESULT_SCHEMA, cellResult, groupCells, isComplete, planCells, sortCells, summarize
} from '@/benchmark/run.js';
import { compatibilityProblems, parseBenchmark } from '@/benchmark/settings.js';
import { rowToSequence } from '@/benchmark/testRow.js';
import { DEFAULT_SETTLE_S, MAX_SETTLE_S, START_PRESETS, validateSettle } from '@/simulation/startState.js';
import { appState, openEditor, newBlankSequence, openResults, setBenchmarkResults } from '@/state/appState.js';
import { demoRef } from '@/state/demoRef.js';
import { loadBenchmarkDataset, loadTest, saveTest } from '@/state/testStore.js';
import { STATIC } from '@/state/viewerMode.js';
import { listPolicies } from '@/state/policyStore.js';
import {
  postResult, listResults, loadResult, deleteResult
} from '@/state/resultStore.js';
import BenchmarkBrowser from '@/components/BenchmarkBrowser.vue';
import loadMujoco from 'mujoco-js';

// Reference policy config, reused as the template by every catalog policy:
// observation recipe, joint order, policy_hz. Wherever a policy's training
// env.yaml records a setting (gains, action scale, default pose, delay, command
// and torque limits) it overrides this file. See docs/policy-config.md.
const REFERENCE_POLICY_CONFIG = './examples/checkpoints/asimov/reference_policy_config.json';

// Control-panel width: dragged by the user, remembered per browser.
const PANEL_WIDTH_KEY = 'humanoidViewer.panelWidth';
const PANEL_DEFAULT_WIDTH = 320;
const PANEL_MIN_WIDTH = 260;
const PANEL_MAX_WIDTH = 760;

export default {
  name: 'DemoPage',
  components: { BenchmarkBrowser },
  data: () => ({
    STATIC,
    state: 0, // 0: loading, 1: running, -1: JS error, -2: wasm unsupported
    extra_error_message: '',
    keydown_listener: null,
    currentMotion: null,
    availableMotions: [],
    trackingState: {
      available: false,
      currentName: 'default',
      currentDone: true,
      refIdx: 0,
      refLen: 0,
      transitionLen: 0,
      motionLen: 0,
      inTransition: false,
      isDefault: true
    },
    trackingTimer: null,
    builtinPolicies: [
      {
        value: 'asimov-reference',
        title: 'Asimov (bundled example, policy Aug 18)',
        description: 'Bundled example policy (78-dim obs, delayed PD actuators): runs without a policy library. Its env.yaml overrides the reference config.',
        policyPath: REFERENCE_POLICY_CONFIG,
        scenePath: 'asimov-1/sim-model/xmls/asimov_1.xml',
        supportsVelocityCommands: true
      }
    ],
    policyCatalog: [],
    policyCatalogError: '',
    benchmarkPolicies: [],
    benchmark: { running: false, stopping: false, done: 0, total: 0, label: '', error: '' },
    showBenchmarkConfirm: false,
    pendingRun: null, // what requestBenchmark() planned and startBenchmark() runs (see planRun)
    pendingBenchmarkTitle: '',
    benchmarkRealtime: false, // play each test at wall-clock speed to watch the run
    benchmarkEstimateSeconds: 0,
    resultsLoading: false,
    panelWidth: 320,
    isResizingPanel: false,
    showDeleteResultConfirm: false,
    pendingDeleteResult: null,
    deletingResult: false,
    resultDeleteError: '',
    currentPolicy: 'asimov-reference',
    cmdVx: 0.0,
    cmdVy: 0.0,
    cmdWz: 0.0,
    // UI slider bounds — the defaults here match this file's original
    // hand-tuned ranges (not COMMAND_LIMITS, which is a looser reference, see
    // commandSequencer.js) and are only overridden per-axis when the loaded
    // policy's own env.yaml declares a command_limits range.
    cmdLimits: { vx: [-1.0, 1.5], vy: [-0.6, 0.6], wz: [-0.8, 0.8] },
    interruptMask: false,
    drFriction: 1.0,
    drArmatureScale: 1.0,
    drDelayMinLag: 0,
    drDelayMaxLag: 5,
    drGravityX: 0.0,
    drGravityY: 0.0,
    imuBiasX: 0.0,
    imuBiasY: 0.0,
    drAddedMass: 0.0,
    drKpScale: 1.0,
    drKdScale: 1.0,
    drComX: 0.0,
    drComY: 0.0,
    drComZ: 0.05,
    drLinkMassScale: 1.0,
    drToeStiffness: 4.0,
    pushForce: 0.5,
    policyLabel: '',
    isPolicyLoading: false,
    policyLoadError: '',
    motionUploadFiles: [],
    motionUploadMessage: '',
    motionUploadType: 'success',
    showUploadOptions: false,
    cameraFollowEnabled: true,
    complianceEnabled: false,
    complianceThreshold: 10.0,
    renderScale: 2.0,
    simStepHz: 0,
    isSmallScreen: false,
    showSmallScreenAlert: true,
    isSafari: false,
    showSafariAlert: true,
    resize_listener: null,
    telemetryTimer: null,
    uiPollTimer: null,
    seq: {
      mode: 'idle', t: 0, duration: 0, name: '', keypointCount: 0,
      hasSequence: false, hasRecording: false
    },
    seqLoop: false,
    playbackError: '',
    playbackWarning: '',
    currentTestFile: null, // on-disk file the loaded test came from
    // How Reset starts the robot (startState.js).
    START_PRESETS,
    MAX_SETTLE_S,
    startPreset: 'policy_default',
    settleOn: false,
    settleSeconds: DEFAULT_SETTLE_S,
    damped: false, // the Damp button's state (demo.damp)
    minimapError: '0.00',
    telemetry: {
      vx: '0.00', vy: '0.00', vz: '0.00',
      wx: '0.00', wy: '0.00', wz: '0.00',
      height: '0.00',
      pullForce: '0.00',
      peakPullForce: '0.00',
      maxAction: '0.00',
      gyroMag: '0.00',
      gravX: '0.00',
      gravY: '0.00',
      gravZ: '-1.00',
      fallen: false,
      settling: false,
      peakGyro: '0.00',
      tumbling: false,
      torques: [],
      jointNames: [],
      jointPositions: [],
      allJointNames: [],
      // L/R mirror-symmetry debug
      lrPairs: [],           // [{name, lPos, rPos, lTorque, rTorque, posMirror, torqueMirror}]
      lrAsymmetryTotal: '0.00', // sum of abs mirror-deviations
    },
    tumbleThreshold: 3.0,
    _peakGyroValue: 0,
    _peakPullForceValue: 0
  }),
  computed: {
    robotStatus() {
      if (this.damped) return { label: 'DAMP', color: '#ffaa00' };
      if (this.telemetry.settling) return { label: 'SETTLING', color: '#ffaa00' };
      if (this.telemetry.fallen) return { label: 'FALLEN', color: '#ff4444' };
      return { label: 'OK', color: '#44ff44' };
    },
    settleError() {
      return this.settleOn ? (validateSettle(Number(this.settleSeconds))[0] ?? '') : '';
    },
    appState() {
      return appState;
    },
    maxRobots() {
      return MAX_ROBOTS;
    },
    editorPage() {
      return appState.page;
    },
    shouldShowProgress() {
      const state = this.trackingState;
      if (!state || !state.available) {
        return false;
      }
      if (state.refLen > 1) {
        return true;
      }
      return !state.currentDone || !state.isDefault || state.inTransition;
    },
    progressValue() {
      const state = this.trackingState;
      if (!state || state.refLen <= 0) {
        return 0;
      }
      const value = ((state.refIdx + 1) / state.refLen) * 100;
      return Math.max(0, Math.min(100, value));
    },
    showBackToDefault() {
      const state = this.trackingState;
      return state && state.available && !state.isDefault && state.currentDone;
    },
    showMotionLockedNotice() {
      const state = this.trackingState;
      return state && state.available && !state.isDefault && !state.currentDone;
    },
    showMotionSelect() {
      const state = this.trackingState;
      if (!state || !state.available) {
        return false;
      }
      if (!state.isDefault || !state.currentDone) {
        return false;
      }
      return this.motionItems.some((item) => !item.disabled);
    },
    motionItems() {
      const names = [...this.availableMotions].sort((a, b) => {
        if (a === 'default') {
          return -1;
        }
        if (b === 'default') {
          return 1;
        }
        return a.localeCompare(b);
      });
      return names.map((name) => ({
        title: name.split('_')[0],
        value: name,
        disabled: this.isMotionDisabled(name)
      }));
    },
    motionGroups() {
      const items = this.motionItems.filter((item) => item.value !== 'default');
      if (items.length === 0) {
        return [];
      }
      const customized = [];
      const amass = [];
      const gentleHumanoid = [];
      const lafan = [];

      for (const item of items) {
        const value = item.value.toLowerCase();
        if (/(^|[_\s-])gentle$/.test(value)) {
          gentleHumanoid.push(item);
        } else if (value.includes('[new]')) {
          customized.push(item);
        } else if (value.includes('amass')) {
          amass.push(item);
        } else {
          lafan.push(item);
        }
      }

      const groups = [];
      if (lafan.length > 0) {
        groups.push({ title: 'LAFAN1', items: lafan });
      }
      if (amass.length > 0) {
        groups.push({ title: 'AMASS', items: amass });
      }
      if (gentleHumanoid.length > 0) {
        groups.push({ title: 'GentleHumanoid', items: gentleHumanoid });
      }
      if (customized.length > 0) {
        groups.push({ title: 'Customized', items: customized });
      }
      return groups;
    },
    // Policies discovered in the policy library reuse the
    // base observation config and load joint control values from env.yaml.
    catalogPolicies() {
      return this.policyCatalog.map((entry) => ({
        value: `lib:${entry.path}`,
        title: entry.label ?? entry.path,
        description: `${entry.path} (reference config: ${REFERENCE_POLICY_CONFIG.split('/').pop()})`,
        policyPath: REFERENCE_POLICY_CONFIG,
        onnxPath: entry.url,
        supportsVelocityCommands: true
      }));
    },
    policies() {
      return [...this.builtinPolicies, ...this.catalogPolicies];
    },
    policyItems() {
      return this.policies.map((policy) => ({
        title: policy.title,
        value: policy.value
      }));
    },
    selectedPolicy() {
      return this.policies.find((policy) => policy.value === this.currentPolicy) ?? null;
    },
    hasBenchmarkResult() {
      return !!appState.benchmarkResults || appState.savedResults.length > 0;
    },
    savedResultCount() {
      return appState.savedResults.length;
    },
    benchmarkSelectionCount() {
      return appState.benchmarkSelection.length;
    },
    benchmarkEstimateLabel() {
      const seconds = Math.round(this.benchmarkEstimateSeconds);
      if (seconds < 90) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      return `${minutes}m ${seconds % 60}s`;
    },
    policyDescription() {
      return this.selectedPolicy?.description ?? '';
    },
    renderScaleLabel() {
      return `${this.renderScale.toFixed(2)}x`;
    },
    complianceThresholdLabel() {
      return this.complianceThreshold.toFixed(1);
    },
    simStepLabel() {
      if (!this.simStepHz || !Number.isFinite(this.simStepHz)) {
        return '—';
      }
      return `${this.simStepHz.toFixed(1)} Hz`;
    },
    // Capability flag, not an identity check: any policy driven by velocity
    // commands (the built-in baseline and every catalog policy) gets the
    // command sliders, playback and benchmark UI.
    isVelocityCommandPolicy() {
      return this.selectedPolicy?.supportsVelocityCommands === true;
    },
    cmdVxLabel() {
      return `${this.cmdVx.toFixed(2)} m/s`;
    },
    cmdVyLabel() {
      return `${this.cmdVy.toFixed(2)} m/s`;
    },
    cmdWzLabel() {
      return `${this.cmdWz.toFixed(2)} rad/s`;
    }
  },
  watch: {
    isResizingPanel(active) {
      // Dragging across the WebGL canvas would otherwise select surrounding text.
      document.body.style.userSelect = active ? 'none' : '';
    },
    editorPage(page) {
      if (page === 'viewer') {
        // Returning from the editor: restore prior pause state and pick up any
        // tests saved on disk while editing.
        if (this.demo?.params) {
          this.demo.params.paused = this._pausedBeforeEditor ?? false;
        }
        this.$refs.benchmarkBrowser?.refresh();
      }
    }
  },
  methods: {
    // ---- Control-panel resizing ------------------------------------------
    startPanelResize(event) {
      event.preventDefault();
      event.stopPropagation();
      this.isResizingPanel = true;
      const startX = event.clientX;
      const startWidth = this.panelWidth;
      const target = event.currentTarget;
      target.setPointerCapture?.(event.pointerId);

      const onMove = (moveEvent) => {
        // The panel is anchored right, so dragging left (smaller clientX) widens it.
        this.panelWidth = this.clampPanelWidth(startWidth + (startX - moveEvent.clientX));
      };
      const onUp = () => {
        this.isResizingPanel = false;
        target.releasePointerCapture?.(event.pointerId);
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        this.savePanelWidth();
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    },
    clampPanelWidth(width) {
      const max = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, window.innerWidth - 60));
      return Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, width)));
    },
    resetPanelWidth() {
      this.panelWidth = PANEL_DEFAULT_WIDTH;
      this.savePanelWidth();
    },
    savePanelWidth() {
      try {
        window.localStorage.setItem(PANEL_WIDTH_KEY, String(this.panelWidth));
      } catch {
        // Private mode / storage disabled: the width just won't persist.
      }
    },
    restorePanelWidth() {
      let stored = null;
      try {
        stored = window.localStorage.getItem(PANEL_WIDTH_KEY);
      } catch {
        stored = null;
      }
      const width = Number(stored);
      this.panelWidth = this.clampPanelWidth(Number.isFinite(width) && width > 0 ? width : PANEL_DEFAULT_WIDTH);
    },
    detectSafari() {
      const ua = navigator.userAgent;
      return /Safari\//.test(ua)
        && !/Chrome\//.test(ua)
        && !/Chromium\//.test(ua)
        && !/Edg\//.test(ua)
        && !/OPR\//.test(ua)
        && !/SamsungBrowser\//.test(ua)
        && !/CriOS\//.test(ua)
        && !/FxiOS\//.test(ua);
    },
    updateScreenState() {
      const isSmall = window.innerWidth < 400 || window.innerHeight < 400;
      if (!isSmall && this.isSmallScreen) {
        this.showSmallScreenAlert = true;
      }
      this.isSmallScreen = isSmall;
    },
    async init() {
      if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
        this.state = -2;
        return;
      }

      try {
        const mujoco = await loadMujoco();
        this.demo = new MuJoCoDemo(mujoco);
        window.__humanoidViewerDemo = this.demo;
        demoRef.current = this.demo;
        this.demo.setFollowEnabled?.(this.cameraFollowEnabled);
        await this.demo.init();
        this.startAtPolicyDefault();
        window.__humanoidViewerDemo = this.demo;
        demoRef.current = this.demo;
        this.syncCommandLimits();
        this.demo.main_loop();
        this.demo.params.paused = false;
        this.reapplyCustomMotions();
        this.availableMotions = this.getAvailableMotions();
        this.currentMotion = this.demo.params.current_motion ?? this.availableMotions[0] ?? null;
        this.complianceEnabled = Boolean(this.demo.params?.compliance_enabled);
        const threshold = Number(this.demo.params?.compliance_threshold);
        if (Number.isFinite(threshold)) {
          this.complianceThreshold = threshold;
        }
        this.startTrackingPoll();
        this.startTelemetryPoll();
        this.startUIPoll();
        this.fetchPolicyCatalog();
        this.refreshSavedResults();
        this.renderScale = this.demo.renderScale ?? this.renderScale;
        const matchingPolicy = this.policies.find(
          (policy) => policy.policyPath === this.demo.currentPolicyPath
        );
        if (matchingPolicy) {
          this.currentPolicy = matchingPolicy.value;
        }
        this.policyLabel = this.demo.currentPolicyPath?.split('/').pop() ?? this.policyLabel;
        this.state = 1;
        await this.selectPolicyFromUrl();
        await this.openResultFromUrl();
      } catch (error) {
        this.state = -1;
        this.extra_error_message = error.toString();
        console.error(error);
      }
    },
    // `?policy=lib:<library path>` (set by `npm run hf`) starts on that catalog policy.
    async selectPolicyFromUrl() {
      const requested = new URLSearchParams(window.location.search).get('policy');
      if (!requested) return;
      await this.fetchPolicyCatalog();
      if (!this.policies.some((policy) => policy.value === requested)) {
        this.policyLoadError = `Policy "${requested}" is not in the policy library`;
        return;
      }
      this.currentPolicy = requested;
      await this.onPolicyChange(requested);
    },
    // `?result=<folder>/result.json` (set by `npm run benchmark view`) opens that saved result's page.
    async openResultFromUrl() {
      const file = new URLSearchParams(window.location.search).get('result');
      if (!file) return;
      try {
        const run = await loadResult(file);
        setBenchmarkResults(run, file);
        await this.refreshSavedResults();
        openResults(run);
      } catch (e) {
        this.benchmark.error = `Could not load ${file}: ${e.message}`;
      }
    },
    /** Slider bounds for the currently loaded policy, falling back to this file's original hand-tuned defaults. */
    syncCommandLimits() {
      const overrides = this.demo?.currentPolicyConfig?.command_limits;
      this.cmdLimits = {
        vx: overrides?.vx ?? [-1.0, 1.5],
        vy: overrides?.vy ?? [-0.6, 0.6],
        wz: overrides?.wz ?? [-0.8, 0.8],
      };
    },
    reapplyCustomMotions() {
      if (!this.demo || !this.customMotions) {
        return;
      }
      const names = Object.keys(this.customMotions);
      if (names.length === 0) {
        return;
      }
      this.addMotions(this.customMotions);
    },
    async onMotionUpload(files) {
      const fileList = Array.isArray(files)
        ? files
        : files instanceof FileList
          ? Array.from(files)
          : files
            ? [files]
            : [];
      if (fileList.length === 0) {
        return;
      }
      if (!this.demo) {
        this.motionUploadMessage = 'Demo not ready yet. Please wait for loading to finish.';
        this.motionUploadType = 'warning';
        this.motionUploadFiles = [];
        return;
      }

      let added = 0;
      let skipped = 0;
      let invalid = 0;
      let failed = 0;
      const prefix = '[new] ';

      for (const file of fileList) {
        try {
          const text = await file.text();
          const parsed = JSON.parse(text);
          const clip = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
          if (!clip) {
            invalid += 1;
            continue;
          }

          const baseName = file.name.replace(/\.[^/.]+$/, '').trim();
          const normalizedName = baseName ? baseName : 'motion';
          const motionName = normalizedName.startsWith(prefix)
            ? normalizedName
            : `${prefix}${normalizedName}`;
          const result = this.addMotions({ [motionName]: clip });
          added += result.added.length;
          skipped += result.skipped.length;
          invalid += result.invalid.length;

          if (result.added.length > 0) {
            if (!this.customMotions) {
              this.customMotions = {};
            }
            for (const name of result.added) {
              this.customMotions[name] = clip;
            }
          }
        } catch (error) {
          console.error('Failed to read motion JSON:', error);
          failed += 1;
        }
      }

      if (added > 0) {
        this.availableMotions = this.getAvailableMotions();
      }

      const parts = [];
      if (added > 0) {
        parts.push(`Added ${added} motion${added === 1 ? '' : 's'}`);
      }
      if (skipped > 0) {
        parts.push(`Skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`);
      }
      const badCount = invalid + failed;
      if (badCount > 0) {
        parts.push(`Ignored ${badCount} invalid file${badCount === 1 ? '' : 's'}`);
      }
      if (parts.length === 0) {
        this.motionUploadMessage = 'No motions were added.';
        this.motionUploadType = 'info';
      } else {
        this.motionUploadMessage = `${parts.join('. ')}.`;
        this.motionUploadType = badCount > 0 ? 'warning' : 'success';
      }
      this.motionUploadFiles = [];
    },
    toggleCameraFollow() {
      this.cameraFollowEnabled = !this.cameraFollowEnabled;
      if (this.demo?.setFollowEnabled) {
        this.demo.setFollowEnabled(this.cameraFollowEnabled);
      }
    },
    toggleCompliance() {
      const nextEnabled = !this.complianceEnabled;
      if (nextEnabled) {
        const current = this.currentMotion ?? this.demo?.params?.current_motion;
        if (current && !this.isMotionComplianceSuitable(current)) {
          return;
        }
      }
      this.complianceEnabled = nextEnabled;
      this.applyComplianceSettings();
    },
    onComplianceThresholdChange(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return;
      }
      this.complianceThreshold = numeric;
      this.applyComplianceSettings();
    },
    applyComplianceSettings() {
      if (!this.demo?.params) {
        return;
      }
      this.demo.params.compliance_enabled = Boolean(this.complianceEnabled);
      this.demo.params.compliance_threshold = Number(this.complianceThreshold);
    },
    isMotionComplianceSuitable(name) {
      const tracking = this.demo?.policyRunner?.tracking ?? null;
      if (!tracking || typeof tracking.isComplianceSuitable !== 'function') {
        return true;
      }
      return tracking.isComplianceSuitable(name);
    },
    isMotionDisabled(name) {
      if (name === 'default') {
        return true;
      }
      if (!this.complianceEnabled) {
        return false;
      }
      return !this.isMotionComplianceSuitable(name);
    },
    onMotionChange(value) {
      if (!this.demo) {
        return;
      }
      if (!value || value === this.demo.params.current_motion) {
        this.currentMotion = this.demo.params.current_motion ?? value;
        return;
      }
      const accepted = this.requestMotion(value);
      if (!accepted) {
        this.currentMotion = this.demo.params.current_motion;
      } else {
        this.currentMotion = value;
        this.updateTrackingState();
      }
    },
    async onPolicyChange(value, { force = false } = {}) {
      if (!this.demo || !value) {
        return;
      }
      const selected = this.policies.find((policy) => policy.value === value);
      if (!selected) {
        return;
      }
      const needsReload = force
        || selected.policyPath !== this.demo.currentPolicyPath
        || selected.onnxPath;
      if (!needsReload) {
        return;
      }
      const wasPaused = this.demo.params?.paused ?? false;
      this.demo.params.paused = true;
      this.isPolicyLoading = true;
      this.policyLoadError = '';
      try {
        // If the selected policy has a different scene, reload the full scene first
        if (selected.scenePath) {
          this.demo.alive = false;
          await this.demo.reloadScene(selected.scenePath);
          this.demo.updateFollowBodyId();
          this.demo.timestep = this.demo.model.opt.timestep;
          this.demo.decimation = Math.max(1, Math.round(0.02 / this.demo.timestep));
          // reloadScene swaps the sim handle; re-bind so sequence push events
          // land on the live simulation.
          commandSequencer.bindSim(this.demo);
        }
        await this.demo.reloadPolicy(selected.policyPath, {
          onnxPath: selected.onnxPath || undefined
        });
        this.startAtPolicyDefault();
        this.syncCommandLimits();
        this.policyLabel = selected.policyPath?.split('/').pop() ?? this.policyLabel;
        this.reapplyCustomMotions();
        this.availableMotions = this.getAvailableMotions();
        this.currentMotion = this.demo.params.current_motion ?? this.availableMotions[0] ?? null;
        this.updateTrackingState();
        if (selected.scenePath) {
          this.demo.alive = true;
          this.demo.main_loop();
        }
      } catch (error) {
        console.error('Failed to reload policy:', error);
        this.policyLoadError = error.toString();
      } finally {
        this.isPolicyLoading = false;
        this.demo.params.paused = wasPaused;
      }
    },
    reset() {
      if (!this.demo) {
        return;
      }
      this.demo.viewerStart = {
        start: START_PRESETS.find((p) => p.value === this.startPreset)?.start ?? null,
        settleS: this.settleOn ? Number(this.settleSeconds) : null,
      };
      // The viewer shows the drop: it settles over the next policy ticks, not inside Reset.
      this.demo.resetSimulation(this.demo, { settleLive: true });
      this.damped = false;
      this._peakGyroValue = 0;
      this.telemetry.peakGyro = '0.00';
      this._peakPullForceValue = 0;
      this.telemetry.peakPullForce = '0.00';
      this.availableMotions = this.getAvailableMotions();
      this.currentMotion = this.demo.params.current_motion ?? this.availableMotions[0] ?? null;
      this.updateTrackingState();
    },
    backToDefault() {
      if (!this.demo) {
        return;
      }
      const accepted = this.requestMotion('default');
      if (accepted) {
        this.currentMotion = 'default';
        this.updateTrackingState();
      }
    },
    startTrackingPoll() {
      this.stopTrackingPoll();
      this.updateTrackingState();
      this.updatePerformanceStats();
      this.trackingTimer = setInterval(() => {
        this.updateTrackingState();
        this.updatePerformanceStats();
      }, 33);
    },
    stopTrackingPoll() {
      if (this.trackingTimer) {
        clearInterval(this.trackingTimer);
        this.trackingTimer = null;
      }
    },
    updateTrackingState() {
      const tracking = this.demo?.policyRunner?.tracking ?? null;
      if (!tracking) {
        this.trackingState = {
          available: false,
          currentName: 'default',
          currentDone: true,
          refIdx: 0,
          refLen: 0,
          transitionLen: 0,
          motionLen: 0,
          inTransition: false,
          isDefault: true
        };
        return;
      }
      const state = tracking.playbackState();
      this.trackingState = { ...state };
      this.availableMotions = tracking.availableMotions();
      const current = this.demo.params.current_motion ?? state.currentName ?? null;
      if (current && this.currentMotion !== current) {
        this.currentMotion = current;
      }
    },
    updatePerformanceStats() {
      if (!this.demo) {
        this.simStepHz = 0;
        return;
      }
      this.simStepHz = this.demo.getSimStepHz?.() ?? this.demo.simStepHz ?? 0;
    },
    onImuBiasXChange(value) {
      imuBiasState.x = Number(value) || 0;
    },
    onImuBiasYChange(value) {
      imuBiasState.y = Number(value) || 0;
    },
    onCmdVxChange(value) {
      this.cmdVx = Number(value) || 0;
      asimovCommandState.vx = this.cmdVx;
      this.onManualCommandInput();
    },
    onCmdVyChange(value) {
      this.cmdVy = Number(value) || 0;
      asimovCommandState.vy = this.cmdVy;
      this.onManualCommandInput();
    },
    onCmdWzChange(value) {
      this.cmdWz = Number(value) || 0;
      asimovCommandState.wz = this.cmdWz;
      this.onManualCommandInput();
    },
    onManualCommandInput() {
      if (this._syncingSliders) return;
      if (commandSequencer.mode === 'playing') {
        // Grabbing a slider mid-playback takes control; keep the user's value
        commandSequencer.stop({ zero: false });
      } else if (commandSequencer.mode === 'recording') {
        commandSequencer.recordKeypoint(asimovCommandState);
      }
    },
    syncSlidersFromCommandState() {
      this._syncingSliders = true;
      this.cmdVx = asimovCommandState.vx;
      this.cmdVy = asimovCommandState.vy;
      this.cmdWz = asimovCommandState.wz;
      this._syncingSliders = false;
    },
    onSeqLoopChange(value) {
      commandSequencer.loop = Boolean(value);
    },
    togglePlay() {
      if (commandSequencer.mode === 'playing') {
        commandSequencer.stop({ zero: true });
        this.syncSlidersFromCommandState();
      } else {
        // Re-anchor the ideal path so playback comparisons start aligned
        this.demo?.reanchorIdealPath?.();
        commandSequencer.play();
      }
    },
    toggleRecord() {
      if (commandSequencer.mode === 'recording') {
        const recording = commandSequencer.stopRecording();
        if (recording) {
          // Make the recording immediately replayable via the Play button
          commandSequencer.loadSequence(recording, recording.name);
          // Persist to disk so it survives reloads
          this.persistRecording(recording);
        }
      } else {
        this.playbackError = '';
        this.playbackWarning = '';
        commandSequencer.startRecording();
      }
    },
    async persistRecording(recording) {
      // Auto-save manual recordings to disk so they survive reloads.
      try {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
        const file = `recording_${stamp}.json`;
        await saveTest(file, recording);
        this.currentTestFile = file;
        this.$refs.benchmarkBrowser?.refresh();
        this.playbackWarning = `Recording saved to ${file}`;
      } catch (e) {
        // Persistence unavailable (e.g. static host) — recording is still in
        // memory and exportable; don't surface as a hard error.
        console.warn('Could not persist recording:', e.message);
      }
    },
    openTrajectoryEditor() {
      this._pausedBeforeEditor = this.demo?.params?.paused ?? false;
      if (this.demo?.params) this.demo.params.paused = true;
      // Carry the on-disk filename the current sequence came from, so edits can
      // be saved back over the same file. Pass robot mass for the editor's
      // momentum/impulse charts.
      openEditor(
        commandSequencer.sequence,
        this.currentTestFile ?? null,
        this.demo?.model?.body_subtreemass?.[this.demo?.pelvis_body_id],
        this.demo?.listBodyNames?.()
      );
    },

    // ---- Benchmark browser (folder manager) --------------------------------
    /** Double-click in the browser: load a test on disk and play it live. */
    async playTest(file) {
      this.playbackError = '';
      this.playbackWarning = '';
      try {
        const parsed = await loadTest(file);
        // A terrain test plays on its course, any other test on the default scene.
        await loadTestScene(this.demo, parsed.terrain);
        const { warning } = commandSequencer.loadSequence(parsed, file.replace(/\.json$/i, ''));
        this.currentTestFile = file;
        this.playbackWarning = warning;
        this.syncSlidersFromCommandState();
        commandSequencer.bindSim(this.demo);
        this.demo?.reanchorIdealPath?.();
        commandSequencer.play();
      } catch (e) {
        this.playbackError = `Failed to load ${file}: ${e.message}`;
      }
    },
    /** Pencil in the browser: open that test in the trajectory editor. */
    async editTest(file) {
      this.playbackError = '';
      try {
        const parsed = await loadTest(file);
        this._pausedBeforeEditor = this.demo?.params?.paused ?? false;
        if (this.demo?.params) this.demo.params.paused = true;
        this.currentTestFile = file;
        openEditor(parsed, file, this.demo?.model?.body_subtreemass?.[this.demo?.pelvis_body_id], this.demo?.listBodyNames?.());
      } catch (e) {
        this.playbackError = `Failed to load ${file}: ${e.message}`;
      }
    },
    newTestInEditor() {
      this._pausedBeforeEditor = this.demo?.params?.paused ?? false;
      if (this.demo?.params) this.demo.params.paused = true;
      this.currentTestFile = null;
      newBlankSequence();
      openEditor(null, null, this.demo?.model?.body_subtreemass?.[this.demo?.pelvis_body_id], this.demo?.listBodyNames?.());
    },

    // ---- Benchmark --------------------------------------------------------
    async fetchPolicyCatalog() {
      this.policyCatalogError = '';
      try {
        this.policyCatalog = await listPolicies();
      } catch (e) {
        this.policyCatalog = [];
        this.policyCatalogError = e?.message || 'Could not load the policy catalog';
      }
    },
    togglePolicy(value) {
      const i = this.benchmarkPolicies.indexOf(value);
      if (i >= 0) this.benchmarkPolicies.splice(i, 1);
      else this.benchmarkPolicies.push(value);
    },
    selectAllPolicies(all) {
      this.benchmarkPolicies = all ? this.policyItems.map((item) => item.value) : [];
    },
    /** Last two path segments — the part that actually distinguishes a policy. */
    policyShort(title) {
      const parts = String(title).split('/');
      return parts.length > 2 ? parts.slice(-2).join('/') : String(title);
    },
    /**
     * What a Run of the checked tests does, planned as `npm run benchmark` plans
     * it (src/benchmark/run.js) from the open benchmark's files: every repeat of
     * each checked test benchmark.yaml selects, with its seed. Throws when a test
     * cannot run.
     */
    async planRun(files) {
      const dataset = await loadBenchmarkDataset(appState.currentBenchmark);
      if (dataset.problems.length) throw new Error(`The benchmark has invalid tests:\n${dataset.problems.join('\n')}`);
      const benchmark = parseBenchmark(dataset.raw);
      const { errors, warnings } = checkTests({ benchmark, rows: dataset.rows });
      if (errors.length) throw new Error(`The benchmark has errors:\n${errors.join('\n')}`);
      const checked = new Set(files.map((file) => file.replace(/\.json$/i, '')));
      const all = planCells(benchmark, dataset.rows);
      const ids = all.tests.map((row) => row.id);
      // As tests= does; null when every test of the benchmark is checked.
      const only = ids.every((id) => checked.has(id)) ? null : ids.filter((id) => checked.has(id));
      if (only && !only.length) throw new Error('None of the checked tests is selected by benchmark.yaml tests.');
      const { cells, tests } = only ? planCells(benchmark, dataset.rows, { only }) : all;
      return { dataset, problems: compatibilityProblems(benchmark), warnings, only, cells, tests, groups: groupCells(cells) };
    },
    /**
     * "Run Benchmark": plan the checked tests for the selected policies, then
     * show the plan and time estimate for confirmation. Nothing runs until
     * startBenchmark().
     */
    async requestBenchmark() {
      this.benchmark.error = '';
      const files = [...appState.benchmarkSelection];
      if (!files.length) {
        this.benchmark.error = 'Check at least one test in the list.';
        return;
      }
      // Default to the policy shown live if none were explicitly selected.
      const policyValues = this.benchmarkPolicies.length
        ? this.benchmarkPolicies
        : [this.currentPolicy];
      const policies = policyValues
        .map((value) => this.policies.find((p) => p.value === value))
        .filter(Boolean)
        .map((p, i) => ({
          key: `m${i}`,
          label: p.title,
          configPath: p.policyPath,
          onnxPath: p.onnxPath || null
        }));
      if (!policies.length) {
        this.benchmark.error = 'Select at least one policy to benchmark.';
        return;
      }
      let plan;
      try {
        plan = await this.planRun(files);
      } catch (e) {
        this.benchmark.error = e?.message || String(e);
        return;
      }
      this.pendingRun = { ...plan, policies };
      this.pendingBenchmarkTitle = this.$refs.benchmarkBrowser?.currentBenchmarkTitle() || '';
      this.benchmarkEstimateSeconds = estimateBenchmarkSeconds(
        policies.length,
        plan.groups.map((group) => ({ duration: group[0].duration }))
      );
      this.showBenchmarkConfirm = true;
    },
    /**
     * Runs pendingRun as `npm run benchmark` does, one group of repeats at a
     * time through runBenchmarkGroupOnPage (the page's __runBenchmarkGroup),
     * then saves the result.json it makes via POST /api/results. Stop abandons
     * the run; nothing is saved.
     */
    async startBenchmark() {
      this.showBenchmarkConfirm = false;
      const plan = this.pendingRun;
      if (!this.demo || this.benchmark.running || !plan) return;
      const { dataset, problems, only, cells, tests, groups, policies } = plan;
      const previousPolicy = this.currentPolicy;
      const sequences = Object.fromEntries(tests.map((row) => [row.id, rowToSequence(row)]));

      this.benchmark = {
        running: true,
        stopping: false,
        done: 0,
        total: cells.length * policies.length,
        label: '',
        error: ''
      };
      this._runPolicyKey = null;
      const started = Date.now();
      const results = [];
      // The file each policy actually ran, for the server to hash.
      const recorded = policies.map(({ configPath, ...policy }) => policy);
      try {
        for (const [index, policy] of policies.entries()) {
          let loadError = null;
          for (const group of groups) {
            if (this.benchmark.stopping) return;
            this.benchmark.label = `${this.policyShort(policy.label)} / ${group[0].testId} ×${group.length}`;
            const groupStarted = Date.now();
            let outcome;
            if (loadError) {
              outcome = { error: loadError, metrics: null };
            } else {
              try {
                outcome = await this.runBenchmarkGroupOnPage(policy, {
                  sequence: sequences[group[0].testId],
                  cells: group.map((cell) => ({ seed: cell.seed, randomize: cell.randomize })),
                  realtime: this.benchmarkRealtime,
                  draw: true,
                  // The robots of a group step one after another, so its budget grows with them.
                  timeoutMs: Math.max(...group.map((cell) => cell.timeoutS)) * group.length * 1000
                });
              } catch (e) {
                outcome = { error: e?.message || String(e), metrics: null };
              }
              if (outcome.policyLoadError) loadError = outcome.error;
              else recorded[index].onnxPath = new URL(this.demo.currentPolicyConfig.onnx.path, window.location.href).pathname;
            }
            // A group shares its wall time; each cell is charged its share.
            const wallMs = loadError && !outcome.policyLoadError ? 0 : Math.round((Date.now() - groupStarted) / group.length);
            group.forEach((cell, i) => {
              results.push(cellResult(policy.key, cell, outcome.results ? outcome.results[i] : outcome, wallMs));
            });
            this.benchmark.done += group.length;
          }
        }

        const result = {
          schema: RESULT_SCHEMA,
          generatedAt: new Date().toISOString(),
          wallSeconds: Math.round((Date.now() - started) / 1000),
          // The server adds the rest (collectProvenance), as the CLI does.
          provenance: { runtime: { chromium: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null } },
          benchmark: { source: 'local', path: dataset.dir, raw: dataset.raw, problems },
          overrides: { tests: only, repeats: null, force: problems.length > 0 },
          shard: null,
          jobs: 1,
          robots: MAX_ROBOTS,
          policies: recorded,
          tests,
          expectedCells: cells.length * policies.length,
          cells: sortCells(results)
        };
        try {
          const file = await postResult(result);
          const saved = await loadResult(file);
          setBenchmarkResults(saved, file);
          await this.refreshSavedResults();
          openResults(saved);
        } catch (e) {
          // Static host / read-only server: the result still lives in memory.
          Object.assign(result, isComplete(result) ? summarize(result) : {});
          setBenchmarkResults(result, null);
          openResults(result);
          this.benchmark.error = `The result was not saved: ${e?.message || e}`;
        }
      } catch (e) {
        console.error('Benchmark failed:', e);
        this.benchmark.error = e?.message || String(e);
      } finally {
        this.benchmark.running = false;
        this.benchmark.stopping = false;
        this.benchmark.label = '';
        this._runPolicyKey = null;
        // Restore the policy that was showing live before the sweep.
        if (this.currentPolicy !== previousPolicy) {
          this.currentPolicy = previousPolicy;
        }
        await this.onPolicyChange(previousPolicy, { force: true });
        commandSequencer.bindSim(this.demo);
        this.syncSlidersFromCommandState();
      }
    },
    /**
     * Loads `policy` ({ configPath?, onnxPath? }) for a Run unless it is the one
     * the last group ran; the Run in this page and `npm run benchmark` both go
     * through here. Throws when it does not load.
     */
    async loadPolicyForRun(policy) {
      const key = `${policy.configPath ?? REFERENCE_POLICY_CONFIG}|${policy.onnxPath}`;
      if (this._runPolicyKey === key) return;
      this._runPolicyKey = null;
      await this.demo.stopMainLoop();
      await this.demo.reloadPolicy(policy.configPath ?? REFERENCE_POLICY_CONFIG, { onnxPath: policy.onnxPath || undefined });
      if (!(await waitForPolicyReady(this.demo, 30000))) throw new Error('it did not become ready within 30s');
      this._runPolicyKey = key;
    },
    /**
     * Runs several repeats of one test at once, as that many robots in one scene
     * (runBenchmarkGroup), for `policy` ({ configPath?, onnxPath }). This is
     * window.__runBenchmarkGroup, which `npm run benchmark` calls, and what the
     * in-app Run calls per group. The page keeps the last policy loaded, so a
     * policy's groups run without reloading it.
     * `group` = { sequence, cells: [{ seed, randomize }], realtime, timeoutMs, draw? };
     * returns { results: [one per cell, in order] }, or { policyLoadError, error }.
     * The scene is drawn when `draw` (default: when real time) and not otherwise.
     */
    async runBenchmarkGroupOnPage(policy, group) {
      if (!this.demo) throw new Error('Demo not ready yet');
      if (group.draw ?? group.realtime) this.demo.startRenderLoop?.();
      else this.demo.stopRenderLoop?.();
      try {
        await this.loadPolicyForRun(policy);
      } catch (error) {
        // Reported, not thrown: the page is fine, only this policy is not.
        return { policyLoadError: true, error: `Could not load policy ${policy.onnxPath ?? policy.configPath}: ${error?.message || error}`, metrics: null };
      }
      // The runner reads the live command state each frame; reading it through
      // an adapter avoids depending on the 33ms slider-sync poll.
      const commandView = {
        get cmdVx() { return asimovCommandState.vx; },
        get cmdVy() { return asimovCommandState.vy; },
        get cmdWz() { return asimovCommandState.wz; }
      };
      const results = await runBenchmarkGroup({
        demo: this.demo,
        component: commandView,
        sequence: group.sequence,
        randomizations: group.cells.map((cell) => (cell.seed === undefined || cell.seed === null
          ? null
          : { seed: cell.seed, randomize: cell.randomize ?? {} })),
        realtime: !!group.realtime,
        timeoutMs: group.timeoutMs ?? undefined,
      });
      return { results };
    },
    async refreshSavedResults() {
      try {
        appState.savedResults = await listResults();
      } catch (e) {
        // No dev endpoint (static host): in-memory results still work.
        appState.savedResults = [];
      }
    },
    /**
     * The full payload of a run is large, so a page load only fetches the run
     * *list*; the newest run's data is pulled in on demand the first time it is
     * actually needed.
     */
    async ensureResultsLoaded() {
      if (appState.benchmarkResults) return appState.benchmarkResults;
      const newest = appState.savedResults[0];
      if (!newest) return null;
      this.resultsLoading = true;
      try {
        const run = await loadResult(newest.file);
        setBenchmarkResults(run, newest.file);
        return run;
      } catch (e) {
        this.benchmark.error = `Could not load ${newest.file}: ${e.message}`;
        return null;
      } finally {
        this.resultsLoading = false;
      }
    },
    resultLabel(result) {
      const when = result.generatedAt
        ? new Date(result.generatedAt).toLocaleString()
        : result.file.replace(/\/result\.json$/, '');
      const shape = result.policyCount != null && result.testCount != null
        ? ` · ${result.policyCount}p × ${result.testCount}t`
        : '';
      return when + shape;
    },
    askDeleteResult(result) {
      this.resultDeleteError = '';
      this.pendingDeleteResult = result;
      this.showDeleteResultConfirm = true;
    },
    async confirmDeleteResult() {
      const result = this.pendingDeleteResult;
      if (!result) return;
      this.deletingResult = true;
      this.resultDeleteError = '';
      try {
        await deleteResult(result.file);
        // Drop it from view too if it was the result currently loaded.
        if (appState.benchmarkResultsFile === result.file) {
          setBenchmarkResults(null, null);
        }
        await this.refreshSavedResults();
        this.showDeleteResultConfirm = false;
        this.pendingDeleteResult = null;
      } catch (e) {
        this.resultDeleteError = `Could not delete ${result.file}: ${e.message}`;
      } finally {
        this.deletingResult = false;
      }
    },
    async viewResults() {
      await this.ensureResultsLoaded();
      openResults();
    },
    startUIPoll() {
      if (this.uiPollTimer) clearInterval(this.uiPollTimer);
      this.uiPollTimer = setInterval(() => {
        const wasPlaying = this.seq.mode === 'playing';
        this.seq = commandSequencer.getStatus();
        if (this.seq.mode === 'playing' || wasPlaying) {
          // Thumbs track playback; on playing->idle they land on the final commands
          this.syncSlidersFromCommandState();
        }
        this.drawMinimap();
      }, 33);
    },
    stopUIPoll() {
      if (this.uiPollTimer) {
        clearInterval(this.uiPollTimer);
        this.uiPollTimer = null;
      }
    },
    drawMinimap() {
      if (this.state !== 1 || appState.page !== 'viewer') return;
      const canvas = this.$refs.minimapCanvas;
      const tracker = this.demo?.idealPath;
      if (!canvas || !tracker) return;

      const SIZE = 220;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== SIZE * dpr) {
        canvas.width = SIZE * dpr;
        canvas.height = SIZE * dpr;
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);

      const ideal = tracker.idealTrace;
      const actual = tracker.actualTrace;
      const com = this.demo.data?.subtree_com;
      const curActual = com
        ? { x: com[0], y: com[1] }
        : actual.length ? actual[actual.length - 1] : null;
      const curIdeal = { x: tracker.x, y: tracker.y };

      // Bounding box over both full traces + current points
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const extend = (p) => {
        if (!p) return;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      };
      for (const p of ideal) extend(p);
      for (const p of actual) extend(p);
      extend(curIdeal);
      extend(curActual);
      if (!Number.isFinite(minX)) { minX = maxX = minY = maxY = 0; }

      const MIN_SPAN = 1.0;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const span = Math.max(maxX - minX, maxY - minY, MIN_SPAN);
      const pad = 14;
      const scale = (SIZE - 2 * pad) / span;
      // MuJoCo x -> right, MuJoCo y -> up (screen y inverted)
      const toPx = (p) => ({
        px: SIZE / 2 + (p.x - cx) * scale,
        py: SIZE / 2 - (p.y - cy) * scale
      });

      const polyline = (trace, color) => {
        if (trace.length < 2) return;
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        trace.forEach((p, i) => {
          const { px, py } = toPx(p);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      };
      polyline(actual, '#1976D2');
      polyline(ideal, '#FF6D00');

      // Connector + current markers
      if (curActual) {
        const a = toPx(curActual);
        const b = toPx(curIdeal);
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(211,47,47,0.7)';
        ctx.lineWidth = 1;
        ctx.moveTo(a.px, a.py);
        ctx.lineTo(b.px, b.py);
        ctx.stroke();
        ctx.fillStyle = '#1976D2';
        ctx.beginPath();
        ctx.arc(a.px, a.py, 3.5, 0, Math.PI * 2);
        ctx.fill();
        const err = Math.hypot(curIdeal.x - curActual.x, curIdeal.y - curActual.y);
        this.minimapError = err.toFixed(2);
      }
      // Ideal heading triangle
      {
        const b = toPx(curIdeal);
        const h = tracker.heading;
        ctx.save();
        ctx.translate(b.px, b.py);
        ctx.rotate(-h); // screen y is inverted, so negate the world yaw
        ctx.fillStyle = '#FF6D00';
        ctx.beginPath();
        ctx.moveTo(7, 0);
        ctx.lineTo(-4, 4);
        ctx.lineTo(-4, -4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // Legend
      ctx.font = '9px monospace';
      ctx.fillStyle = '#1976D2';
      ctx.fillRect(6, 6, 8, 3);
      ctx.fillText('robot', 18, 10);
      ctx.fillStyle = '#FF6D00';
      ctx.fillRect(6, 16, 8, 3);
      ctx.fillText('ideal', 18, 20);
    },
    onInterruptMaskChange(value) {
      this.interruptMask = Boolean(value);
      asimovInterruptState.active = this.interruptMask ? 1 : 0;
    },
    onDrFrictionChange(value) {
      if (!this.demo?.model) return;
      const model = this.demo.model;
      const ngeom = model.ngeom;
      for (let g = 0; g < ngeom; g++) {
        model.geom_friction[g * 3] = Number(value);
      }
    },
    onDrArmatureChange(value) {
      if (!this.demo?.model) return;
      const model = this.demo.model;
      const scale = Number(value);
      if (!this._defaultArmature) {
        this._defaultArmature = new Float64Array(model.dof_armature);
      }
      for (let i = 0; i < model.dof_armature.length; i++) {
        model.dof_armature[i] = this._defaultArmature[i] * scale;
      }
    },
    onDrDelayChange(bound, value) {
      const lag = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
      if (bound === 'min') {
        this.drDelayMinLag = Math.min(lag, this.drDelayMaxLag);
      } else {
        this.drDelayMaxLag = Math.max(lag, this.drDelayMinLag);
      }
      this.demo?.configureActionDelay?.(this.drDelayMinLag, this.drDelayMaxLag);
    },
    onDrGravityChange() {
      if (!this.demo?.model) return;
      this.demo.model.opt.gravity[0] = Number(this.drGravityX);
      this.demo.model.opt.gravity[1] = Number(this.drGravityY);
    },
    onDrMassChange(value) {
      if (!this.demo?.model) return;
      const model = this.demo.model;
      if (!this._defaultBodyMass) {
        this._defaultBodyMass = new Float64Array(model.body_mass);
      }
      // Add mass to the pelvis (body index 1, first non-world body)
      model.body_mass[1] = this._defaultBodyMass[1] + Number(value);
    },
    onDrKpChange(value) {
      if (!this.demo?.kpPolicy) return;
      if (!this._defaultKp) {
        this._defaultKp = new Float32Array(this.demo.kpPolicy);
      }
      const scale = Number(value);
      for (let i = 0; i < this.demo.kpPolicy.length; i++) {
        this.demo.kpPolicy[i] = this._defaultKp[i] * scale;
      }
    },
    onDrKdChange(value) {
      if (!this.demo?.kdPolicy) return;
      if (!this._defaultKd) {
        this._defaultKd = new Float32Array(this.demo.kdPolicy);
      }
      const scale = Number(value);
      for (let i = 0; i < this.demo.kdPolicy.length; i++) {
        this.demo.kdPolicy[i] = this._defaultKd[i] * scale;
      }
    },
    onDrComChange() {
      if (!this.demo?.model) return;
      const model = this.demo.model;
      if (!this._defaultBodyIpos) {
        this._defaultBodyIpos = new Float64Array(model.body_ipos);
      }
      // Pelvis is body index 1, ipos is [x, y, z] per body
      model.body_ipos[1 * 3 + 0] = this._defaultBodyIpos[1 * 3 + 0] + Number(this.drComX);
      model.body_ipos[1 * 3 + 1] = this._defaultBodyIpos[1 * 3 + 1] + Number(this.drComY);
      model.body_ipos[1 * 3 + 2] = this._defaultBodyIpos[1 * 3 + 2] + Number(this.drComZ);
    },
    onDrToeStiffnessChange(value) {
      if (!this.demo?.model) return;
      const model = this.demo.model;
      const stiffness = Number(value);
      // Find toe joints and set their stiffness
      for (let j = 0; j < model.njnt; j++) {
        const name = this.demo.mujoco.mj_id2name(model, this.demo.mujoco.mjtObj.mjOBJ_JOINT.value, j);
        if (name && name.includes('toe')) {
          model.jnt_stiffness[j] = stiffness;
        }
      }
    },
    onDrLinkMassChange(value) {
      if (!this.demo?.model) return;
      const model = this.demo.model;
      if (!this._defaultBodyMass) {
        this._defaultBodyMass = new Float64Array(model.body_mass);
      }
      const scale = Number(value);
      // Scale all bodies except world (index 0)
      for (let i = 1; i < model.nbody; i++) {
        model.body_mass[i] = this._defaultBodyMass[i] * scale;
      }
    },
    pushRobot(direction = 'random') {
      if (!this.demo?.simulation) return;
      const force = this.pushForce || 0.5;
      if (direction === 'front') {
        // Push forward (+x in MuJoCo body frame)
        this.demo.simulation.qvel[0] += force;
      } else if (direction === 'back') {
        // Push backward (-x)
        this.demo.simulation.qvel[0] -= force;
      } else {
        // Random direction
        const angle = Math.random() * Math.PI * 2;
        this.demo.simulation.qvel[0] += Math.cos(angle) * force;
        this.demo.simulation.qvel[1] += Math.sin(angle) * force;
      }
    },
    // A newly loaded policy starts at its own start pose (env.yaml init_state),
    // whatever Reset's Start pose and drop-and-settle settings are.
    startAtPolicyDefault() {
      this.demo.resetSimulation(this.demo, { start: null, settleS: null });
      this.damped = false;
    },
    toggleDamp() {
      if (!this.demo) return;
      this.demo.setDamp(!this.demo.damp);
      this.damped = this.demo.damp;
    },
    resetVelocities() {
      if (!this.demo?.simulation) return;
      const qvel = this.demo.simulation.qvel;
      for (let i = 0; i < qvel.length; i++) {
        qvel[i] = 0.0;
      }
    },
    startTelemetryPoll() {
      if (this.telemetryTimer) clearInterval(this.telemetryTimer);
      this.telemetryTimer = setInterval(() => {
        if (!this.demo?.simulation || !this.demo?.model) return;
        const sim = this.demo.simulation;
        const f = (v) => v.toFixed(2);

        // Base velocity (qvel[0:6])
        this.telemetry.vx = f(sim.qvel[0] || 0);
        this.telemetry.vy = f(sim.qvel[1] || 0);
        this.telemetry.vz = f(sim.qvel[2] || 0);
        this.telemetry.wx = f(sim.qvel[3] || 0);
        this.telemetry.wy = f(sim.qvel[4] || 0);
        this.telemetry.wz = f(sim.qvel[5] || 0);

        // Height (qpos[2])
        this.telemetry.height = f(sim.qpos[2] || 0);

        // Pull force from drag interaction
        const dragForce = this.demo.lastDragForce || 0;
        this.telemetry.pullForce = f(dragForce);
        if (dragForce > this._peakPullForceValue) {
          this._peakPullForceValue = dragForce;
          this.telemetry.peakPullForce = f(dragForce);
        }

        // Max raw action from policy
        this.telemetry.maxAction = f(this.demo.maxRawAction || 0);

        // Gyro magnitude (same as firmware: sum of abs angular velocities)
        const wx = Math.abs(sim.qvel[3] || 0);
        const wy = Math.abs(sim.qvel[4] || 0);
        const wz = Math.abs(sim.qvel[5] || 0);
        const gyroMag = wx + wy + wz;
        this.telemetry.gyroMag = f(gyroMag);

        // Gravity XYZ in body frame (projected gravity)
        const qw2 = sim.qpos[3], qx2 = sim.qpos[4], qy2 = sim.qpos[5], qz2 = sim.qpos[6];
        const gravXval = 2.0 * (qx2 * qz2 - qw2 * qy2);
        const gravYval = 2.0 * (qy2 * qz2 + qw2 * qx2);
        const gravZval = -(1.0 - 2.0 * (qx2 * qx2 + qy2 * qy2));
        this.telemetry.gravX = f(gravXval);
        this.telemetry.gravY = f(gravYval);
        this.telemetry.gravZ = f(gravZval);
        this.telemetry.fallen = this.demo.fallen || false;
        this.telemetry.settling = this.demo.settleTicksLeft > 0;
        this.damped = !!this.demo.damp;
        if (gyroMag > this._peakGyroValue) {
          this._peakGyroValue = gyroMag;
          this.telemetry.peakGyro = f(gyroMag);
        }

        // Joint velocity RMS
        try {
          const nv = this.demo.model?.nv || 0;
          if (nv > 6) {
            let velSumSq = 0;
            const nJoints = nv - 6;
            for (let i = 6; i < nv; i++) {
              const v = sim.qvel[i] || 0;
              velSumSq += v * v;
            }
            this.telemetry.jointVelRms = f(Math.sqrt(velSumSq / nJoints));
          }
        } catch(e) {}

        // Jitter metrics from sim loop (computed at 50Hz policy rate, averaged over 1s)
        if (this.demo.jitterMetrics) {
          const j = this.demo.jitterMetrics;
          this.telemetry.actionJitter = j.action.toExponential(2);
          this.telemetry.torqueJitter = j.torque.toExponential(2);
          this.telemetry.velJerk = j.vel.toExponential(2);
        }

        // Joint torques from ctrl
        const ctrl = sim.ctrl;
        if (ctrl) {
          const torques = [];
          const names = this.demo.policyRunner?.policyJointNames || [];
          for (let i = 0; i < Math.min(ctrl.length, 23); i++) {
            torques.push(f(ctrl[i] || 0));
          }
          this.telemetry.torques = torques;
          this.telemetry.jointNames = names.map(n => n.replace('_joint','').replace('left_','L_').replace('right_','R_'));
        }

        // Joint positions (all joints including toes)
        try {
          const model = this.demo.model;
          const allMjcNames = this.demo.jointNamesMJC || [];
          if (allMjcNames.length > 0) {
            const positions = [];
            const allNames = [];
            for (let j = 0; j < allMjcNames.length; j++) {
              const name = allMjcNames[j];
              if (name === 'root') continue;
              const adr = model.jnt_qposadr[j];
              positions.push(f(sim.qpos[adr] || 0));
              allNames.push(name.replace('_joint','').replace('left_','L_').replace('right_','R_'));
            }
            this.telemetry.jointPositions = positions;
            this.telemetry.allJointNames = allNames;
          }
        } catch(e) {}

        // L/R mirror-symmetry debug
        // For Asimov, the keyframe convention uses OPPOSITE qpos signs for mirror pose
        // (e.g. L_hip_pitch=-0.1, R_hip_pitch=+0.1). So |L + R| is the deviation from
        // mirror symmetry. Works for both opposite-axis and same-axis joints because
        // the keyframe chose signs such that mirror ⇒ L = -R ⇒ L + R = 0.
        try {
          const model = this.demo.model;
          const allMjcNames = this.demo.jointNamesMJC || [];
          const ctrl = sim.ctrl;
          const policyNames = this.demo.policyRunner?.policyJointNames || [];
          if (allMjcNames.length > 0) {
            // Build name → qpos adr map for quick lookup
            const nameToAdr = {};
            for (let j = 0; j < allMjcNames.length; j++) {
              nameToAdr[allMjcNames[j]] = model.jnt_qposadr[j];
            }
            // Build policy-joint-name → action/ctrl index map
            const nameToCtrlIdx = {};
            policyNames.forEach((n, i) => { nameToCtrlIdx[n] = i; });

            const pairs = [
              ['hip_pitch',    'left_hip_pitch_joint',    'right_hip_pitch_joint'],
              ['hip_roll',     'left_hip_roll_joint',     'right_hip_roll_joint'],
              ['hip_yaw',      'left_hip_yaw_joint',      'right_hip_yaw_joint'],
              ['knee',         'left_knee_joint',         'right_knee_joint'],
              ['ankle_pitch',  'left_ankle_pitch_joint',  'right_ankle_pitch_joint'],
              ['ankle_roll',   'left_ankle_roll_joint',   'right_ankle_roll_joint'],
            ];

            const out = [];
            let totalAsym = 0;
            for (const [name, lName, rName] of pairs) {
              const lAdr = nameToAdr[lName];
              const rAdr = nameToAdr[rName];
              const lPos = (lAdr != null ? sim.qpos[lAdr] : 0) || 0;
              const rPos = (rAdr != null ? sim.qpos[rAdr] : 0) || 0;
              const lIdx = nameToCtrlIdx[lName];
              const rIdx = nameToCtrlIdx[rName];
              const lTau = (lIdx != null && ctrl) ? (ctrl[lIdx] || 0) : 0;
              const rTau = (rIdx != null && ctrl) ? (ctrl[rIdx] || 0) : 0;
              const posMirror = Math.abs(lPos + rPos);
              const torqueMirror = Math.abs(lTau + rTau);
              totalAsym += posMirror;
              out.push({
                name,
                lPos: lPos.toFixed(3),
                rPos: rPos.toFixed(3),
                lTorque: lTau.toFixed(2),
                rTorque: rTau.toFixed(2),
                posMirror: posMirror.toFixed(3),
                torqueMirror: torqueMirror.toFixed(2),
              });
            }
            this.telemetry.lrPairs = out;
            this.telemetry.lrAsymmetryTotal = totalAsym.toFixed(2);
          }
        } catch(e) {}
      }, 100); // 10 Hz update
    },
    onRenderScaleChange(value) {
      if (!this.demo) {
        return;
      }
      this.demo.setRenderScale(value);
    },
    getAvailableMotions() {
      const tracking = this.demo?.policyRunner?.tracking ?? null;
      return tracking ? tracking.availableMotions() : [];
    },
    addMotions(motions, options = {}) {
      const tracking = this.demo?.policyRunner?.tracking ?? null;
      if (!tracking) {
        return { added: [], skipped: [], invalid: [] };
      }
      return tracking.addMotions(motions, options);
    },
    requestMotion(name) {
      const tracking = this.demo?.policyRunner?.tracking ?? null;
      if (!tracking || !this.demo) {
        return false;
      }
      const state = this.demo.readPolicyState();
      const accepted = tracking.requestMotion(name, state);
      if (accepted) {
        this.demo.params.current_motion = name;
      }
      return accepted;
    }
  },
  mounted() {
    window.__humanoidViewerDemoComponent = this;
    window.__runBenchmarkGroup = (policy, group) => this.runBenchmarkGroupOnPage(policy, group);
    this.customMotions = {};
    this.isSafari = this.detectSafari();
    this.restorePanelWidth();
    this.updateScreenState();
    this.resize_listener = () => {
      this.updateScreenState();
      // A narrower window must not leave the panel wider than the viewport.
      this.panelWidth = this.clampPanelWidth(this.panelWidth);
    };
    window.addEventListener('resize', this.resize_listener);
    this.init();
    this.wasdKeys = { KeyW: false, KeyS: false, KeyA: false, KeyD: false, KeyQ: false, KeyE: false };
    const WASD_V = 0.6;
    const WASD_W = 0.6;
    const updateWasdCmd = () => {
      let vx = 0;
      let vy = 0;
      let wz = 0;
      if (this.wasdKeys.KeyW) vx += WASD_V;
      if (this.wasdKeys.KeyS) vx -= WASD_V;
      if (this.wasdKeys.KeyA) vy += WASD_V;
      if (this.wasdKeys.KeyD) vy -= WASD_V;
      if (this.wasdKeys.KeyQ) wz += WASD_W; // turn left
      if (this.wasdKeys.KeyE) wz -= WASD_W; // turn right
      this.onCmdVxChange(vx);
      this.onCmdVyChange(vy);
      this.onCmdWzChange(wz);
    };
    const isTypingTarget = (el) => {
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    };
    this.keydown_listener = (event) => {
      if (event.code === 'Backspace') {
        this.reset();
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (event.code in this.wasdKeys && !this.wasdKeys[event.code]) {
        this.wasdKeys[event.code] = true;
        updateWasdCmd();
      }
    };
    this.keyup_listener = (event) => {
      if (event.code in this.wasdKeys && this.wasdKeys[event.code]) {
        this.wasdKeys[event.code] = false;
        updateWasdCmd();
      }
    };
    document.addEventListener('keydown', this.keydown_listener);
    document.addEventListener('keyup', this.keyup_listener);
  },
  beforeUnmount() {
    if (window.__humanoidViewerDemoComponent === this) {
      window.__humanoidViewerDemoComponent = null;
    }
    if (window.__runBenchmarkGroup) {
      window.__runBenchmarkGroup = null;
    }
    if (window.__humanoidViewerDemo === this.demo) {
      window.__humanoidViewerDemo = null;
    }
    this.stopTrackingPoll();
    this.stopUIPoll();
    commandSequencer.deactivate();
    document.removeEventListener('keydown', this.keydown_listener);
    document.removeEventListener('keyup', this.keyup_listener);
    if (this.resize_listener) {
      window.removeEventListener('resize', this.resize_listener);
    }
  }
};
</script>

<style scoped>
.viewer-subtitle {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 16px 4px;
  font-size: 12px;
}

.viewer-subtitle .made-for {
  font-family: Georgia, 'Times New Roman', serif;
  font-style: italic;
  opacity: 0.7;
}

.viewer-subtitle a {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
  font-weight: 500;
}

.viewer-subtitle a:hover {
  text-decoration: underline;
}

/* Policy picker: a plain checkbox list, no dropdown to open. */
.policy-picker {
  max-height: 148px;
  overflow-y: auto;
}
.policy-row {
  min-width: 0;
  min-height: 26px;
  border-radius: 4px;
  padding-right: 2px;
}
.policy-row:hover {
  background: rgba(127, 127, 127, 0.12);
}
.policy-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
}

/* Saved benchmark results: the label clips with an ellipsis so a long timestamp
   never pushes the delete button out of the panel. */
.saved-results {
  max-height: 132px;
  overflow-y: auto;
  margin-top: 2px;
}
.saved-result {
  min-width: 0;
  min-height: 24px;
  border-radius: 4px;
  padding: 0 2px;
}
.saved-result:hover {
  background: rgba(127, 127, 127, 0.12);
}
.saved-result.current {
  background: rgba(42, 120, 214, 0.14);
}
.saved-result .result-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
}
.mono-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  word-break: break-all;
}

.minimap {
  position: fixed;
  top: 20px;
  left: 20px;
  width: 220px;
  z-index: 1100;
  background: rgba(255, 255, 255, 0.88);
  border-radius: 6px;
  padding: 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.minimap-canvas {
  width: 220px;
  height: 220px;
  display: block;
}

.minimap-readout {
  font: 11px monospace;
  text-align: center;
  color: #333;
  margin-top: 2px;
}

.controls {
  position: fixed;
  top: 20px;
  right: 20px;
  width: 320px;
  z-index: 1000;
}

/* Grab strip on the panel's inner edge. Sits just outside the card so it never
   covers a control, and widens its own hit area beyond the visible line. */
.panel-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -14px;
  width: 16px;
  cursor: ew-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  z-index: 1;
}
.panel-resizer .grip {
  width: 4px;
  height: 46px;
  border-radius: 2px;
  background: rgba(127, 127, 127, 0.35);
  transition: background 120ms ease, height 120ms ease;
}
.panel-resizer:hover .grip,
.panel-resizer.dragging .grip {
  background: rgb(var(--v-theme-primary));
  height: 74px;
}
/* While dragging, keep the cursor and stop text selection anywhere on screen. */
.panel-resizer.dragging {
  cursor: ew-resize;
}

.global-alerts {
  position: fixed;
  top: 20px;
  left: 16px;
  right: 16px;
  max-width: 520px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 1200;
}

.small-screen-alert {
  width: 100%;
}

.safari-alert {
  width: 100%;
}

.controls-card {
  max-height: calc(100vh - 40px);
}

.controls-body {
  max-height: calc(100vh - 160px);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.motion-status {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.motion-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  max-height: 200px;
  overflow-y: auto;
}

.motion-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.motion-chip {
  text-transform: none;
  font-size: 0.7rem;
}

.status-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.status-name {
  font-weight: 600;
}

.policy-file {
  display: block;
  margin-top: 4px;
}


.upload-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.upload-toggle {
  padding: 0;
  min-height: unset;
  font-size: 0.85rem;
  text-transform: none;
}

.motion-progress-no-animation,
.motion-progress-no-animation *,
.motion-progress-no-animation::before,
.motion-progress-no-animation::after {
  transition: none !important;
  animation: none !important;
}

.motion-progress-no-animation :deep(.v-progress-linear__determinate),
.motion-progress-no-animation :deep(.v-progress-linear__indeterminate),
.motion-progress-no-animation :deep(.v-progress-linear__background) {
  transition: none !important;
  animation: none !important;
}
</style>
