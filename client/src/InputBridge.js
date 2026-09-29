export class InputBridge {
  constructor(renderer = null) {
    this.renderer = renderer;
    this.keys = new Set();
    this._onKeyDown = (e) => this.keys.add(e.code);
    this._onKeyUp = (e) => this.keys.delete(e.code);
    // A key held while the tab loses focus never fires keyup, so it would stay
    // pressed forever and the player would walk into a wall on return.
    this._onBlur = () => this.keys.clear();
    this._listening = false;

    if (typeof window !== 'undefined') {
      this.attachKeyboard();
    }
  }

  attachKeyboard() {
    if (this._listening || typeof window === 'undefined') return;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    // Switching tabs does not always fire window blur, but visibilitychange
    // always fires; cover both.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onBlur);
    }
    this._listening = true;
  }

  dispose() {
    if (typeof window !== 'undefined' && this._listening) {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this._onBlur);
      }
      this._listening = false;
    }
  }

  isXRPresenting() {
    try {
      return !!(this.renderer && this.renderer.xr && this.renderer.xr.isPresenting);
    } catch {
      return false;
    }
  }

  static async isXRSupported() {
    try {
      if (typeof navigator === 'undefined' || !navigator.xr) return false;
      return await navigator.xr.isSessionSupported('immersive-vr');
    } catch {
      return false;
    }
  }

  async enterXR(options = {}) {
    if (!this.renderer) throw new Error('InputBridge: no renderer attached');
    if (typeof navigator === 'undefined' || !navigator.xr) {
      throw new Error('InputBridge: WebXR not available in this browser');
    }
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', ...(options.optionalFeatures || [])]
    });
    await this.renderer.xr.setSession(session);
    return session;
  }

  _pollXRControllers() {
    const state = {
      moveX: 0, // left-hand translate (strafe)
      moveZ: 0, // left-hand translate (forward)
      turnX: 0, // right-hand turn (smooth)
      interact: false,
      shoot: false,
      reload: false,
      changeAvatar: false
    };

    try {
      if (!this.isXRPresenting()) return state;
      const session = this.renderer.xr.getSession();
      if (!session || !session.inputSources) return state;

      for (const source of session.inputSources) {
        const gamepad = source.gamepad;
        if (!gamepad) continue;

        const axes = gamepad.axes || [];
        const buttons = gamepad.buttons || [];

        // Thumbstick on axes[2]/axes[3] (standard mapping); fall back to axes[0]/axes[1]
        const ax = axes.length >= 4 ? axes[2] : (axes[0] || 0);
        const az = axes.length >= 4 ? axes[3] : (axes[1] || 0);
        // Left hand translates, right hand turns. Unknown handedness: translate.
        if (source.handedness === 'right') {
          if (Math.abs(ax) > 0.3) state.turnX += ax;
        } else {
          if (Math.abs(ax) > 0.15) state.moveX += ax;
          if (Math.abs(az) > 0.15) state.moveZ += az;
        }

        const pressed = (i) => !!(buttons[i] && buttons[i].pressed);
        if (pressed(0)) state.shoot = true; // trigger
        if (pressed(1)) state.reload = true; // squeeze/grip
        if (pressed(3)) state.interact = true; // thumbstick click
        if (pressed(4)) state.changeAvatar = true;
      }

      state.moveX = Math.max(-1, Math.min(1, state.moveX));
      state.moveZ = Math.max(-1, Math.min(1, state.moveZ));
      state.turnX = Math.max(-1, Math.min(1, state.turnX));
    } catch {
      // XR polling must never throw into the frame loop
    }

    return state;
  }

  getInput() {
    const k = this.keys;
    // v2 scheme: WASD/arrows ALL translate (strafe included), Q/E turn.
    const kbForward = k.has('KeyW') || k.has('ArrowUp');
    const kbBackward = k.has('KeyS') || k.has('ArrowDown');
    const kbLeft = k.has('KeyA') || k.has('ArrowLeft');
    const kbRight = k.has('KeyD') || k.has('ArrowRight');
    const kbInteract = k.has('KeyE') || k.has('Space') || k.has('Enter');
    const kbTurnLeft = k.has('KeyQ');
    const kbTurnRight = k.has('KeyE'); // E doubles as interact, but interact only acts in editor mode where turning is inert

    const xr = this._pollXRControllers();
    const xrActive = this.isXRPresenting();

    const moveX = (kbRight ? 1 : 0) - (kbLeft ? 1 : 0) + (xr.moveX || 0);
    const moveZ = (kbBackward ? 1 : 0) - (kbForward ? 1 : 0) + (xr.moveZ || 0);
    const turn = ((kbTurnRight ? 1 : 0) - (kbTurnLeft ? 1 : 0)) + (xr.turnX || 0);

    return {
      forward: kbForward || moveZ < -0.15,
      backward: kbBackward || moveZ > 0.15,
      left: kbLeft || moveX < -0.15,
      right: kbRight || moveX > 0.15,
      turnLeft: kbTurnLeft || turn < -0.3,
      turnRight: kbTurnRight || turn > 0.3,
      moveX: Math.max(-1, Math.min(1, moveX)),
      moveZ: Math.max(-1, Math.min(1, moveZ)),
      turn: Math.max(-1, Math.min(1, turn)),
      interact: kbInteract || xr.interact,
      shoot: xr.shoot,
      reload: xr.reload,
      changeAvatar: k.has('KeyC') || xr.changeAvatar,
      toggleEditor: k.has('KeyT'),
      // Lap 7 editor persistence. These are level-triggered in the consumer
      // (edge-detected there), not here, so a held key cannot re-save 60x/second.
      saveLayout: k.has('KeyK'),
      loadLayout: k.has('KeyO'),
      xrActive,
      timestamp: Date.now()
    };
  }
}
