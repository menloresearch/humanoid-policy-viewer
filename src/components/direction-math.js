// Spherical az/elevation <-> [x, y, z] direction conversions shared by
// DirectionDial (compass + elevation dials) and PushLane (timeline arrows).
// Screen convention: x-right = +x, y-up = +y, elevation = angle above the xy
// plane. Kept in one place so the two components' conventions never drift
// apart.

export function toSpherical(v) {
  const x = v?.[0] ?? 1, y = v?.[1] ?? 0, z = v?.[2] ?? 0;
  const azDeg = Math.atan2(y, x) * 180 / Math.PI;
  const elevDeg = Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI;
  return { azDeg, elevDeg };
}

export function fromSpherical(azDeg, elevDeg) {
  const az = azDeg * Math.PI / 180;
  const elev = elevDeg * Math.PI / 180;
  return [
    Math.round(Math.cos(elev) * Math.cos(az) * 1000) / 1000,
    Math.round(Math.cos(elev) * Math.sin(az) * 1000) / 1000,
    Math.round(Math.sin(elev) * 1000) / 1000,
  ];
}
