# NitroXR Runtime SDK Documentation

Welcome to the NitroXR Runtime. This engine separates the **Brain** (Client Logic) from the **Body** (Cloud Assets).

## 1. Quick Start

### Installation
```bash
npm install @nitroxr/runtime
```

### Basic Setup
```javascript
import { NitroXR } from '@nitroxr/runtime';

const scene = new NitroXR.Scene();
const player = await scene.createEntity('player', {
  position: [0, 1.6, 0],
  model: 'nitro_player_avatar' // Asset ID from Cloud
});

NitroXR.onUpdate((input) => {
  // Handle movement based on input
  if (input.forward) {
    player.setPosition([...player.position]); // Update position
  }
  scene.update(); // Step physics and render
});
```

## 2. Core API Reference

### `NitroXR.Scene`
The orchestrator of the 3D world.
- `createEntity(id, props)`: Creates a visual and physical entity.
  - `props.model`: Either a primitive (`'cube'`, `'sphere'`) or a Cloud Asset ID.
  - `props.position`: `[x, y, z]` coordinates.
  - `props.physics`: `{ isStatic: boolean, velocity: [x,y,z] }`.
- `update(deltaTime)`: Processes the physics step and renders the frame.
- `clear()`: Wipes the scene.

### `NitroXR.Cloud`
The interface to the Cloud Body.
- `submit(data)`: Sends scores or state to the Cloudflare Worker.
- `getGhost(userId)`: Retrieves recorded path data for an async racer.

### `NitroXR.onUpdate(callback)`
The deterministic heartbeat. Runs at the display's refresh rate.

## 3. Asset Pipeline

NitroXR uses **Asset IDs** instead of file paths.

1. **Upload**: Upload your `.glb` model to Cloudflare R2.
2. **Register**: Add the ID $\to$ URL mapping in the Cloud Registry (KV/D1).
3. **Reference**: Use the ID in your code: `model: 'my_custom_model'`.

The `AssetResolver` handles the streaming, caching, and PBR material application automatically.

## 4. Performance Guardrails

To prevent motion sickness in XR, the engine enforces:
- **16.6ms Frame Budget**: All logic must complete within one frame.
- **Async Assets**: Loading assets never blocks the render loop.
- **Deterministic Physics**: Movement is calculated using `deltaTime` to ensure consistency across different headset refresh rates.
