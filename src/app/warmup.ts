// Off-screen warm-up: before the first visible frame (the loading screen still covers the canvas),
// and again behind the "Applying graphics settings…" overlay after a setting rebuilds pipelines,
// render real frames with every boat drawing all its LODs unculled. Every pipeline the voyage can
// need — boats at any distance, shadow cascades, the lit ocean and sky with the final light set (the
// pooled deck lights render their shadow maps even when dark), rain and the lightning bolt — is
// then built here instead of stalling the GPU process mid-voyage. Real frames rather than
// compileAsync(): three keys render objects (and node builds) by render context, and compileAsync's
// (canvas, call depth 0) never matches the post pipeline's nested scene pass.
//
// three builds every new pipeline of a frame synchronously inside that frame, so the warm-up reveals
// the scene a part at a time (SeaScene.setWarmupView), one part per frame, waiting for the next
// animation frame between parts so the loading screen paints and its progress moves:
//
//   sky, clouds, compute and the post chain → the ocean → particles and weather → each boat in turn
//   (all LODs, main and shadow passes, lamps) → a few frames of everything
//
// The light set never changes during or after the warm-up, so nothing lit is built twice.

import type { SeaScene, WarmupView } from '../render/SeaScene';
import type { TaskContext } from './loading/LoadingManager';

export interface WarmUpOptions {
  scene: Pick<SeaScene, 'setWarmup' | 'setWarmupView' | 'boatCount'>;
  boats: number; // boats the session starts with
  tick: (now: number) => void; // one frame of the game loop
  frames?: number; // rendered once every boat is in (default 3)
  timeoutMs?: number; // give up waiting for boats after this (default 8 s)
  // Resolves on the next animation frame (tests pass a fake).
  nextFrame?: () => Promise<number>;
}

const animationFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

// The scene stages, before the boats.
const SCENE_STAGES: readonly WarmupView[] = [
  { ocean: false, effects: false, boats: 0 },
  { ocean: true, effects: false, boats: 0 },
  { ocean: true, effects: true, boats: 0 },
];

export interface WarmUp {
  // Sky, ocean and effects (the loading screen's "Compiling ocean and sky shaders").
  scene(context?: TaskContext): Promise<void>;
  // Every boat, one per frame, then whole frames ("Warming up the boats and shadows").
  boats(context?: TaskContext): Promise<void>;
  // Back to normal drawing; call in a finally.
  end(): void;
}

export function beginWarmUp(options: WarmUpOptions): WarmUp {
  const { scene, tick } = options;
  const nextFrame = options.nextFrame ?? animationFrame;
  const frame = async (): Promise<number> => {
    const now = await nextFrame();
    tick(now);
    return now;
  };
  scene.setWarmup(true);
  scene.setWarmupView(SCENE_STAGES[0]!);
  let ended = false;
  return {
    async scene(context) {
      for (let i = 0; i < SCENE_STAGES.length; i++) {
        scene.setWarmupView(SCENE_STAGES[i]!);
        await frame();
        context?.progress((i + 1) / SCENE_STAGES.length);
      }
    },
    async boats(context) {
      const timeout = options.timeoutMs ?? 8000;
      const wanted = Math.max(1, options.boats);
      const steps = wanted + 1; // each boat, then the whole frames
      // Frames (drawing no boats) until every boat has arrived in a snapshot.
      let start: number | null = null;
      while (scene.boatCount < options.boats) {
        const now = await frame();
        start ??= now;
        if (now - start > timeout) break;
      }
      // One more boat per frame.
      const count = scene.boatCount;
      for (let i = 1; i <= count; i++) {
        scene.setWarmupView({ ocean: true, effects: true, boats: i });
        await frame();
        context?.progress(Math.min(i, wanted) / steps);
      }
      scene.setWarmupView(null);
      const frames = options.frames ?? 3;
      for (let i = 0; i < frames; i++) {
        await frame();
        context?.progress((wanted + (i + 1) / frames) / steps);
      }
    },
    end() {
      if (ended) return;
      ended = true;
      scene.setWarmup(false);
    },
  };
}

// The whole warm-up in one go (a settings rebuild: no loading screen).
export async function warmUp(options: WarmUpOptions): Promise<void> {
  const warm = beginWarmUp(options);
  try {
    await warm.scene();
    await warm.boats();
  } finally {
    warm.end();
  }
}
