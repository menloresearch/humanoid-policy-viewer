#!/usr/bin/env python3
"""Generate the terrain benchmark: terrain fragments (MJCF files of static geoms) and the test sequences that load
them through their top-level "terrain" field. At test time src/simulation/terrainScene.js splices the fragment into
the default robot scene, so the robot model itself is never copied or edited.

Every course starts 1.5 m in front of the spawn point, is 6 m wide and runs along +x (the robot's initial heading).
The robot is commanded to walk forward at 0.4 m/s for 20 s, so a policy that keeps pace ends near x = 8 m; getting
stuck shows up as drift from the ideal path, a fall as a fall.

    python3 scripts/make_terrain_benchmark.py      (from humanoid-policy-viewer/)

Writes public/examples/scenes/terrain/<name>.xml, benchmark/terrain/<name>.json and appends the fragments to
public/examples/scenes/files.json. Existing scenes and tests are not touched.
"""
import json
import math
import random
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
SCENES = APP / "public" / "examples" / "scenes"
TESTS = APP / "benchmark" / "terrain"

X0 = 1.5       # course start (m)
WIDTH = 6.0    # course width (m): wide enough that a drifting policy is scored on drift, not on walking off an edge
SPEED = 0.4    # commanded forward speed (m/s)
MATERIAL = '<material name="terrain" rgba="0.55 0.5 0.42 1"/>'


def box(name, cx, cy, cz, hx, hy, hz, euler=None):
    rot = f' euler="{euler[0]:.5f} {euler[1]:.5f} {euler[2]:.5f}"' if euler else ""
    return (f'    <geom name="{name}" type="box" pos="{cx:.4f} {cy:.4f} {cz:.4f}" size="{hx:.4f} {hy:.4f} {hz:.4f}"{rot}'
            f' material="terrain" contype="1" conaffinity="1" condim="3" friction="1.0 0.5 0.1"/>')


def stairs(step_h, n=5, tread=0.35, top=1.5):
    """Pyramid: n steps up, a top platform, n steps down (stacked boxes, one per height level)."""
    end = X0 + 2 * n * tread + top
    geoms = []
    for i in range(1, n + 1):
        x_lo, x_hi = X0 + (i - 1) * tread, end - (i - 1) * tread
        geoms.append(box(f"stair{i}", (x_lo + x_hi) / 2, 0, (i - 0.5) * step_h, (x_hi - x_lo) / 2, WIDTH / 2, step_h / 2))
    return geoms


def ramps(angle_deg, height, top=1.5, thick=0.2):
    """Ramp up at angle_deg to height, a top platform, ramp down."""
    th = math.radians(angle_deg)
    run = height / math.tan(th)
    half_len = math.hypot(run, height) / 2
    geoms = []
    for k, (x_mid, sign) in enumerate(((X0 + run / 2, 1), (X0 + run + top + run / 2, -1))):
        # centre sits half a thickness below the sloped top surface
        cx = x_mid + sign * (thick / 2) * math.sin(th)
        cz = height / 2 - (thick / 2) * math.cos(th)
        geoms.append(box(f"ramp{k}", cx, 0, cz, half_len, WIDTH / 2, thick / 2, euler=(0, -sign * th, 0)))
    geoms.append(box("ramp_top", X0 + run + top / 2, 0, height / 2, top / 2 + 0.02, WIDTH / 2, height / 2))
    return geoms


def obstacles(seed=7, n=14, h_range=(0.03, 0.07)):
    """Scattered low boxes (0.2-0.4 m footprint, 3-7 cm high) across the walking lane."""
    rnd = random.Random(seed)
    geoms = []
    for i in range(n):
        hx, hy, h = rnd.uniform(0.1, 0.2), rnd.uniform(0.1, 0.2), rnd.uniform(*h_range)
        cx, cy = rnd.uniform(X0 + 0.2, X0 + 6.0), rnd.uniform(-0.6, 0.6)
        geoms.append(box(f"obstacle{i}", cx, cy, h / 2, hx, hy, h / 2, euler=(0, 0, rnd.uniform(0, math.pi))))
    return geoms


def rough(seed=11, tile=0.3, h_max=0.04, length=6.3):
    """Cobblestone patch: 0.3 m tiles with random heights in [0, h_max]."""
    rnd = random.Random(seed)
    geoms = []
    nx, ny = round(length / tile), round(WIDTH / tile)
    for i in range(nx):
        for j in range(ny):
            h = rnd.uniform(0.005, h_max)
            geoms.append(box(f"tile{i}_{j}", X0 + (i + 0.5) * tile, -WIDTH / 2 + (j + 0.5) * tile, h / 2,
                             tile / 2, tile / 2, h / 2))
    return geoms


COURSES = {
    "stairs_5cm": ("5 cm stairs up and down (5 steps each way, 35 cm treads)", stairs(0.05)),
    "stairs_10cm": ("10 cm stairs up and down (5 steps each way, 35 cm treads)", stairs(0.10)),
    "slope_10deg": ("10 degree ramp up to 0.3 m and down", ramps(10, 0.3)),
    "slope_15deg": ("15 degree ramp up to 0.4 m and down", ramps(15, 0.4)),
    "obstacles": ("scattered 3-7 cm boxes across the lane", obstacles()),
    "rough": ("cobblestone patch, 30 cm tiles 0.5-4 cm high", rough()),
}


def write_fragment(name, desc, geoms):
    xml = (f'<mujoco model="terrain {name}">\n'
           f"  <!-- {desc} (scripts/make_terrain_benchmark.py) -->\n"
           f"  <asset>\n    {MATERIAL}\n  </asset>\n"
           f"  <worldbody>\n" + "\n".join(geoms) + "\n  </worldbody>\n</mujoco>\n")
    (SCENES / "terrain").mkdir(exist_ok=True)
    (SCENES / "terrain" / f"{name}.xml").write_text(xml)


def walk_test(name, desc, terrain, events=None):
    seq = {
        "name": f"terrain: {desc}",
        "duration": 22,
        "terrain": terrain,
        "commands": [
            {"t": 0, "vx": 0, "vy": 0, "wz": 0},
            {"t": 0.3, "vx": SPEED, "vy": 0, "wz": 0},
            {"t": 20.5, "vx": 0, "vy": 0, "wz": 0},
        ],
    }
    if events:
        seq["events"] = events
    (TESTS / f"{name}.json").write_text(json.dumps(seq, indent=2) + "\n")


def main():
    TESTS.mkdir(parents=True, exist_ok=True)
    for name, (desc, geoms) in COURSES.items():
        write_fragment(name, desc, geoms)
        walk_test(name, desc, f"terrain/{name}.xml")
    # climbing the 10 degree ramp while a lateral shoulder push (walking tier, 150 N then 225 N) hits
    walk_test("slope_push", "10 degree ramp with lateral shoulder pushes while climbing", "terrain/slope_10deg.xml",
              events=[
                  {"t": 5.5, "type": "push", "dir": [0, 1, 0], "force": 150, "duration": 0.15,
                   "targetBody": "left_shoulder_pitch_link", "label": "shoulder lateral 150 N on the ramp"},
                  {"t": 12.5, "type": "push", "dir": [0, -1, 0], "force": 225, "duration": 0.15,
                   "targetBody": "right_shoulder_pitch_link", "label": "shoulder lateral 225 N going down the ramp"},
              ])
    # append the fragments to the download index (keeping its existing order, so the change stays additive)
    index = SCENES / "files.json"
    files = json.loads(index.read_text())
    files += sorted(f"terrain/{n}.xml" for n in COURSES if f"terrain/{n}.xml" not in files)
    index.write_text(json.dumps(files, indent=2) + ("\n" if index.read_text().endswith("\n") else ""))
    print(f"wrote {len(COURSES)} terrain fragments and {len(COURSES) + 1} tests")


if __name__ == "__main__":
    main()
