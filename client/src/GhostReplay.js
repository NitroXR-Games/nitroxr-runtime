// Lap 6: ghost recording + playback (async racing).
//
// Dependency-free: no three.js import, so this runs in node (tests) and in
// the browser. Game code moves bytes via NitroXR.Cloud:
//   recorder -> compressPath -> Cloud.submitGhost(userId, payload)
//   Cloud.getGhost(userId) -> GhostPlayer.load(payload) -> update() in loop
//
// Wire format v1 (JSON-safe):
//   { v: 1, hz, start: [x, y, z], deltas: [[dx, dy, dz, dtMs], ...] }
// Positions are millimeter-quantized ints, times are ms ints. Deltas shrink
// typical maze runs ~70% versus raw float arrays.

export const GHOST_FORMAT = 1;

function quantize(n) {
  return Math.round(n * 1000);
}

function dequantize(n) {
  return n / 1000;
}

export function compressPath(points, hz = 10) {
  if (!Array.isArray(points) || points.length === 0) {
    return { v: GHOST_FORMAT, hz, start: [0, 0, 0], t0: 0, n: 0, deltas: [] };
  }
  const t0 = points[0].t || 0;
  const start = [points[0].x || 0, points[0].y || 0, points[0].z || 0];
  let px = quantize(start[0]);
  let py = quantize(start[1]);
  let pz = quantize(start[2]);
  let pt = 0;
  const deltas = [];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const qx = quantize(p.x || 0);
    const qy = quantize(p.y || 0);
    const qz = quantize(p.z || 0);
    const qt = Math.round((p.t || 0) - t0);
    deltas.push([qx - px, qy - py, qz - pz, qt - pt]);
    px = qx;
    py = qy;
    pz = qz;
    pt = qt;
  }
  return { v: GHOST_FORMAT, hz, start, t0, n: points.length, deltas };
}

export function decompressPath(packed) {
  if (!packed) return [];
  // Back-compat: raw point arrays pass through untouched.
  if (Array.isArray(packed)) return packed;
  if (packed.v !== GHOST_FORMAT || !Array.isArray(packed.deltas)) {
    throw new Error(`GhostReplay: unsupported format v${packed.v}`);
  }
  if (packed.n === 0) return [];
  const points = [{ x: packed.start[0], y: packed.start[1], z: packed.start[2], t: packed.t0 || 0 }];
  let qx = quantize(packed.start[0]);
  let qy = quantize(packed.start[1]);
  let qz = quantize(packed.start[2]);
  let qt = 0;
  for (const [dx, dy, dz, dt] of packed.deltas) {
    qx += dx;
    qy += dy;
    qz += dz;
    qt += dt;
    points.push({ x: dequantize(qx), y: dequantize(qy), z: dequantize(qz), t: (packed.t0 || 0) + qt });
  }
  return points;
}

export function payloadBytes(packed) {
  return JSON.stringify(packed).length;
}

// Samples an entity's position at a fixed rate. Call sample() every frame;
// only points spaced >= 1/hz apart are kept, so frame-rate spikes never
// inflate the payload.
export class GhostRecorder {
  constructor({ hz = 10 } = {}) {
    this.hz = hz;
    this.points = [];
    this._lastT = -Infinity;
  }

  sample(position, nowMs = Date.now()) {
    if (this._lastT !== -Infinity && nowMs - this._lastT < 1000 / this.hz) return false;
    this._lastT = nowMs;
    this.points.push({ x: position[0], y: position[1], z: position[2], t: nowMs });
    return true;
  }

  get count() {
    return this.points.length;
  }

  reset() {
    this.points = [];
    this._lastT = -Infinity;
  }

  toPayload() {
    return compressPath(this.points, this.hz);
  }
}

// Plays a ghost path back onto any entity with setPosition([x, y, z]).
// Linear interpolation between samples keeps motion smooth even at 10Hz;
// update() is O(1) amortized via a forward-only cursor (plus resync scan
// on seeks/loops), so it never threatens the 16.6ms budget.
export class GhostPlayer {
  constructor(entity, { loop = true } = {}) {
    this.entity = entity;
    this.loop = loop;
    this.points = [];
    this.duration = 0;
    this.playing = false;
    this._cursor = 0;
    this._startOffset = 0;
  }

  load(packedOrPoints) {
    const data = packedOrPoints && packedOrPoints.path
      ? packedOrPoints.path
      : packedOrPoints;
    this.points = decompressPath(data);
    this.duration = this.points.length > 1
      ? this.points[this.points.length - 1].t - this.points[0].t
      : 0;
    this._cursor = 0;
    this._startOffset = 0;
    if (this.points.length > 0) {
      const p = this.points[0];
      this.entity.setPosition([p.x, p.y, p.z]);
    }
    return this.points.length;
  }

  play(nowMs = Date.now()) {
    if (this.points.length === 0) return false;
    this.playing = true;
    this._startOffset = nowMs - this.points[0].t;
    this._cursor = 0;
    return true;
  }

  pause() {
    this.playing = false;
  }

  stop() {
    this.playing = false;
    this._cursor = 0;
  }

  update(nowMs = Date.now()) {
    if (!this.playing || this.points.length === 0) return false;
    if (this.points.length === 1) {
      const p = this.points[0];
      this.entity.setPosition([p.x, p.y, p.z]);
      return true;
    }
    const t0 = this.points[0].t;
    let elapsed = nowMs - this._startOffset - t0;
    if (elapsed < 0) elapsed = 0;
    if (elapsed >= this.duration) {
      if (!this.loop) {
        const p = this.points[this.points.length - 1];
        this.entity.setPosition([p.x, p.y, p.z]);
        this.playing = false;
        return false;
      }
      // Preserve phase across loops instead of snapping to path start.
      this._startOffset = nowMs - t0 - (elapsed % this.duration);
      this._cursor = 0;
      elapsed = elapsed % this.duration;
    }
    const target = t0 + elapsed;
    let i = this._cursor;
    while (i < this.points.length - 2 && this.points[i + 1].t <= target) i++;
    while (i > 0 && this.points[i].t > target) i--;
    this._cursor = i;
    const a = this.points[i];
    const b = this.points[i + 1];
    const span = b.t - a.t;
    const f = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 1;
    this.entity.setPosition([
      a.x + (b.x - a.x) * f,
      a.y + (b.y - a.y) * f,
      a.z + (b.z - a.z) * f
    ]);
    return true;
  }
}
