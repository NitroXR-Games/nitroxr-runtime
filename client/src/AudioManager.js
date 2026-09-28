// Web Audio graph owner: master + per-category buses, crossfading music,
// one-shot SFX and positional sources. Games decide *what* plays *when*; this
// owns *how* it is mixed.
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.categoryGains = { music: null, sfx: null, ui: null };
    this.currentMusic = null;
    this._spatial = new Set();
    this._initialized = false;
  }

  // Safe to call repeatedly. Browsers start the context suspended, so playback
  // only actually begins after the first user gesture resumes it.
  ensureInitialized() {
    if (this._initialized) return this.ctx;
    if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null;

    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(this.ctx.destination);

    for (const cat of Object.keys(this.categoryGains)) {
      const gain = this.ctx.createGain();
      gain.gain.value = 1;
      gain.connect(this.masterGain);
      this.categoryGains[cat] = gain;
    }

    const resume = () => {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    };
    for (const evt of ['click', 'keydown', 'touchstart']) {
      window.addEventListener(evt, resume, { once: true });
    }

    this._initialized = true;
    return this.ctx;
  }

  // Master volume 0..1. Lazily initialises so a pre-gesture call is not a
  // silent no-op.
  setMasterVolume(v) {
    this.ensureInitialized();
    if (!this.masterGain) return;
    this.masterGain.gain.value = Math.max(0, Math.min(1, v));
  }

  setCategoryVolume(category, v) {
    this.ensureInitialized();
    const bus = this.categoryGains[category];
    if (!bus) return;
    bus.gain.value = Math.max(0, Math.min(1, v));
  }

  // Fades the current music track out and clears it. Tolerates a source that
  // has already ended: AudioBufferSourceNode.stop() throws InvalidStateError
  // on a finished node, which is the common case for loop:false stingers.
  _stopCurrent(fade) {
    if (!this.currentMusic || !this.ctx) return;
    const { source, gain } = this.currentMusic;
    this.currentMusic = null;
    if (source._ended) return;
    try {
      gain.gain.cancelScheduledValues(this.ctx.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + fade);
      source.stop(this.ctx.currentTime + fade);
    } catch {
      // Node already stopped or never started; nothing to fade.
    }
  }

  async crossfade(toBuffer, { category = 'music', volume = 1, fade = 1, loop = true } = {}) {
    this.ensureInitialized();
    if (!this.ctx || !toBuffer) return null;

    this._stopCurrent(fade);

    const source = this.ctx.createBufferSource();
    source.buffer = toBuffer;
    source.loop = loop;
    // Track natural completion so _stopCurrent can skip finished nodes.
    source._ended = false;
    source.onended = () => { source._ended = true; };

    const bus = this.categoryGains[category] || this.categoryGains.music;
    const sourceGain = this.ctx.createGain();
    sourceGain.gain.value = 0;
    source.connect(sourceGain).connect(bus);

    const t = this.ctx.currentTime;
    sourceGain.gain.linearRampToValueAtTime(volume, t + fade);
    source.start();

    this.currentMusic = { source, gain: sourceGain, category };
    return source;
  }

  // One-shot sound effect. Returns the source so the caller can stop it early.
  play(buffer, { category = 'sfx', volume = 1, pitch = 1 } = {}) {
    this.ensureInitialized();
    if (!this.ctx || !buffer) return null;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = pitch;

    const bus = this.categoryGains[category] || this.categoryGains.sfx;
    const sourceGain = this.ctx.createGain();
    sourceGain.gain.value = volume;

    source.connect(sourceGain).connect(bus);
    source.start();
    return source;
  }

  // Positional source bound to an object whose .position is (x, y, z).
  // Its panner is refreshed by update(), which the game loop should call.
  createSpatialSource(buffer, object3D, {
    category = 'sfx', volume = 1, refDistance = 1, maxDistance = 100, rolloffFactor = 1
  } = {}) {
    this.ensureInitialized();
    if (!this.ctx || !buffer || !object3D) return null;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = false;
    source._ended = false;
    source.onended = () => { source._ended = true; this._spatial.delete(handle); };

    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = rolloffFactor;

    const bus = this.categoryGains[category] || this.categoryGains.sfx;
    const sourceGain = this.ctx.createGain();
    sourceGain.gain.value = volume;
    source.connect(sourceGain).connect(panner).connect(bus);

    const handle = {
      source, panner, object3D,
      stop: () => {
        try { source.stop(); } catch { /* already ended */ }
        this._spatial.delete(handle);
      }
    };
    this._spatial.add(handle);
    this._syncSpatial(handle);
    source.start();
    return handle;
  }

  // Call once per frame to keep positional panners glued to their objects.
  update() {
    for (const handle of this._spatial) this._syncSpatial(handle);
  }

  _syncSpatial(handle) {
    const p = handle.object3D && handle.object3D.position;
    if (!p) return;
    if (handle.panner.positionX) {
      handle.panner.positionX.value = p.x;
      handle.panner.positionY.value = p.y;
      handle.panner.positionZ.value = p.z;
    } else {
      handle.panner.setPosition(p.x, p.y, p.z);
    }
  }

  async loadAudio(url) {
    this.ensureInitialized();
    if (!this.ctx || !url) return null;
    const res = await fetch(url);
    // Without this a 404 HTML error page is handed to decodeAudioData and
    // we wait for it to throw instead of failing fast.
    if (!res.ok) throw new Error(`Audio fetch failed: ${res.status} ${url}`);
    return this.ctx.decodeAudioData(await res.arrayBuffer());
  }

  stopMusic(fade = 0.5) {
    if (!this.ctx) return;
    this._stopCurrent(fade);
  }

  // Close the context and drop every reference. Without this the AudioContext
  // (and its hardware output) leaks when a scene is torn down.
  dispose() {
    this._stopCurrent(0);
    this._spatial.clear();
    if (this.ctx && this.ctx.state !== 'closed') {
      try { this.ctx.close(); } catch { /* already closed */ }
    }
    this.ctx = null;
    this.masterGain = null;
    for (const cat of Object.keys(this.categoryGains)) this.categoryGains[cat] = null;
    this._initialized = false;
  }
}
