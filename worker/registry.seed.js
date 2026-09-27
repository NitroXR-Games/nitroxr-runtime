// Seed asset registry: works with zero KV/R2 setup so the Worker is useful
// immediately after deploy.
//
// MULTI-TENANT KEY CONVENTION (R2 + registry):
//   {org}/{game}/{kind}/{file}
// e.g. nitroxr-games/maze/models/wall_plain.glb
//      acme-corp/shooter/textures/metal_panel.jpg
//
// Every entry carries `org` + `game`; POST /assets defaults them to
// nitroxr-games/maze when omitted. A second org/game can never collide
// with these keys because the namespace prefix is part of the URL.
const ORG = 'nitroxr-games';
const GAME = 'maze';
const NS = `{{ASSET_BASE}}/${ORG}/${GAME}`;

export const SEED_ASSETS = {
  nitro_concrete_wall: {
    id: 'nitro_concrete_wall',
    org: ORG,
    game: GAME,
    type: 'material',
    glb_url: `${NS}/models/wall_plain.glb`,
    texture_url: `${NS}/textures/concrete_wall_4k.jpg`,
    properties: { metallic: 0.2, roughness: 0.8 },
    priority: 2,
    description: 'Legacy maze wall (aliased by maze_wall_concrete)'
  },
  maze_wall_concrete: {
    id: 'maze_wall_concrete',
    org: ORG,
    game: GAME,
    type: 'material',
    glb_url: `${NS}/models/wall_plain.glb`,
    texture_url: `${NS}/textures/concrete_wall_4k.jpg`,
    properties: { metallic: 0.2, roughness: 0.8 },
    priority: 2,
    description: 'Low-poly concrete maze wall segment with PBR texture'
  },
  nitro_gray_floor: {
    id: 'nitro_gray_floor',
    org: ORG,
    game: GAME,
    type: 'material',
    glb_url: `${NS}/models/floor_tile.glb`,
    texture_url: `${NS}/textures/floor_tile_dark.jpg`,
    properties: { metallic: 0.4, roughness: 0.6 },
    priority: 1,
    description: 'Legacy maze floor (aliased by maze_floor_tile)'
  },
  maze_floor_tile: {
    id: 'maze_floor_tile',
    org: ORG,
    game: GAME,
    type: 'material',
    glb_url: `${NS}/models/floor_tile.glb`,
    texture_url: `${NS}/textures/floor_tile_dark.jpg`,
    properties: { metallic: 0.4, roughness: 0.6 },
    priority: 1,
    description: 'Dark metallic floor tile, seamless tiling'
  },
  nitro_gold_glow: {
    id: 'nitro_gold_glow',
    org: ORG,
    game: GAME,
    type: 'model',
    glb_url: `${NS}/models/goal_portal.glb`,
    properties: { metallic: 0.1, roughness: 0.3, emissive: true },
    priority: 3,
    description: 'Legacy goal marker (aliased by maze_goal_portal)'
  },
  maze_goal_portal: {
    id: 'maze_goal_portal',
    org: ORG,
    game: GAME,
    type: 'model',
    glb_url: `${NS}/models/goal_portal.glb`,
    properties: { metallic: 0.1, roughness: 0.3, emissive: true },
    priority: 3,
    description: 'Glowing sci-fi victory portal'
  },
  nitro_player_avatar: {
    id: 'nitro_player_avatar',
    org: ORG,
    game: GAME,
    type: 'model',
    glb_url: `${NS}/models/player_base.glb`,
    properties: { metallic: 0.5, roughness: 0.5 },
    priority: 2,
    description: 'Default XR player avatar drone'
  },
  maze_ghost: {
    id: 'maze_ghost',
    org: ORG,
    game: GAME,
    type: 'model',
    glb_url: `${NS}/models/ghost.glb`,
    properties: { metallic: 0.0, roughness: 0.4, translucent: true },
    priority: 4,
    description: 'Translucent async-racing ghost entity'
  }
};
