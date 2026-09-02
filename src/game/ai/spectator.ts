// Spectator logic (pure). When the player dies they spectate a living ally
// (cycled with Q/E); if no ally is alive they get a free overhead camera.

export interface SpectatorResult {
  mode: 'ally' | 'free';
  targetId: number | null;
}

/**
 * Resolve the spectator target. `allies` must be the living teammates (the
 * player excluded). `index` is the Q/E selection offset.
 */
export function resolveSpectator(allies: readonly { id: number; alive: boolean }[], index: number): SpectatorResult {
  const living = allies.filter((a) => a.alive);
  if (living.length === 0) return { mode: 'free', targetId: null };
  const len = living.length;
  const idx = ((index % len) + len) % len;
  return { mode: 'ally', targetId: living[idx].id };
}
