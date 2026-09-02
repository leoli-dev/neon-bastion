import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Unit tests exercise the pure game-logic modules in a node environment.
// The logic core (map, collision, hitscan, movement, spread, AI, scoring,
// match, spectator) must run without DOM/WebGL/network/wall-clock.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: ['tests/unit/**/*.test.ts'],
      globals: false,
      testTimeout: 20000,
      hookTimeout: 20000,
    },
  })
);
