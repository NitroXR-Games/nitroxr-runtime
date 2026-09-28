import * as THREE from 'three';

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.categoryGains = {
      music: null,
      sfx: null,
      ui: null,
    };
    this.currentMusic = null;
    this._gestureHandler = null;
    this._initialized = false;
  }

  // Must be called after a user gesture (click, keydown, etc.) to satisfy
  // browser autoplay policy. Call once on first user interaction.
  ensureInitialized() {
    if (this._initialized) return;
    if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return;

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

    // Resume on first user gesture (required by browser autoplay policy)
    const resume = () => {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      window.removeEventListener('click', resume);
      window.removeEventListener('keydown', resume);
      window.removeEventListener('touchstart', resume);
    };
    window.addEventListener('click', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });
    window.addEventListener('touchstart', resume, { once: true });

    this._initialized = true;
  }

  // Master volume (0-1)
  setMasterVolume(v) {
    if (!this.masterGain) return;
    this.masterGain.gain.value = Math.max(0, Math.min(1, v));
  }

  // Category volume (0-1)
  setCategoryVolume(category, v) {
    if (!this.categoryGains[category]) return;
    this.categoryGains[category].gain.value = Math.max(0, Math.min(1, v));
  }

  // Crossfade between two audio buffers. `from` and `to` can be AudioBufferSourceNode
  // or buffer references. Returns the new source node.
  async crossfade(toBuffer, { category = 'music', volume = 1, fade = 1, loop = true } = {}) {
    this.ensureInitialized();
    if (!this.ctx) return null;

    // Stop current with fade
    if (this.currentMusic) {
      const fromGain = this.currentMusic.gain;
      fromGain.gain.linearRampToValueAtTime(fromGain.gain.value, this.ctx.currentTime);
      fromGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + fade);
      this.currentMusic.source.stop(this.ctx.currentTime + fade);
    }

    // Start new
    const source = this.ctx.createBufferSource();
    source.buffer = toBuffer;
    source.loop = loop;

    const catGain = this.categoryGains[category] || this.categoryGains.music;
    const sourceGain = this.ctx.createGain();
    sourceGain.gain.value = 0;
    source.connect(sourceGain).connect(catGain);

    sourceGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime);
    sourceGain.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + fade);
    source.start();

    this.currentMusic = { source, gain: sourceGain, category };
    return source;
  }

  // Play a one-shot sound effect
  play(buffer, { category = 'sfx', volume = 1, pitch = 1 } = {}) {
    this.ensureInitialized();
    if (!this.ctx || !buffer) return null;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = pitch;

    const catGain = this.categoryGains[category] || this.categoryGains.sfx;
    const sourceGain = this.ctx.createGain();
    sourceGain.gain.value = volume;

    source.connect(sourceGain).connect(catGain);
    source.start();
    return source;
  }

  // Create a spatial (3D) sound attached to a Three.js Object3D
  createSpatialSource(buffer, object3D, { category = 'sfx', volume = 1, refDistance = 1, maxDistance = 100, rolloffFactor = 1 } = {}) {
    this.ensureInitialized();
    if (!this.ctx || !buffer) return null;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = false;

    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = rolloffFactor;
    panner.positionX.value = object3D.position.x;
    panner.positionY.value = object3D.position.y;
    panner.positionZ.value = object3D.position.z;

    const catGain = this.categoryGains[category] || this.categoryGains.sfx;
    const sourceGain = this.ctx.createGain();
    sourceGain.gain.value = 1;

    source.connect(sourceGain).connect(panner).connect(catGain);

    // Update panner position from object3D each frame
    const update = () => {
      if (!object3D) return;
      panner.positionX.value = object3D.position.x;
      panner.positionY.value = object3D.position.y;
      panner.positionZ.value = object3D.position.z;
    };

    source.start();
    return { source, panner, update, stop: () => source.stop() };
  }

  // Load an audio file from URL and return AudioBuffer
  async loadAudio(url) {
    this.ensureInitialized();
    if (!this.ctx) return null;
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    return this.ctx.decodeAudioData(arrayBuffer);
  }

  // Stop all music with fade
  stopMusic(fade = 0.5) {
    if (this.currentMusic && this.ctx) {
      const gain = this.currentMusic.gain;
      gain.gain.linearRampToValueAtTime(gain.gain.value, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + fade);
      this.currentMusic.source.stop(this.ctx.currentTime + fade);
      this.currentMusic = null;
    }
  }
}