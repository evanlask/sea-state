// How much cloth simulation each sail gets per frame. The XPBD sails run on the main thread at
// ~1 ms substeps (SailCloth), which is wasteful for a boat 300 m away. The helm boat keeps full
// rate; others step less often and with fewer substeps as they shrink on screen, and barely at all
// off screen. Pure.

export interface ClothBudget {
  interval: number; // step every n-th frame (the skipped frames' time is carried into the next step)
  maxSubsteps: number; // cap on XPBD substeps per step
}

export interface ClothBudgetInput {
  helm: boolean; // the boat the player is sailing
  visible: boolean; // inside the camera frustum
  lod: number; // the boat model's level of detail (0 near, 2 far)
}

export const FULL_CLOTH: Readonly<ClothBudget> = { interval: 1, maxSubsteps: 24 };

export function clothBudget(input: ClothBudgetInput): ClothBudget {
  if (input.helm) return { ...FULL_CLOTH };
  if (!input.visible) return { interval: 8, maxSubsteps: 6 };
  if (input.lod <= 0) return { interval: 1, maxSubsteps: 16 };
  if (input.lod === 1) return { interval: 2, maxSubsteps: 10 };
  return { interval: 4, maxSubsteps: 6 };
}

// Frame gate for one sail: accumulates time over skipped frames. Staggered by `phase` so several
// distant boats don't all step on the same frame.
export class ClothStepper {
  private frame: number;
  private pending = 0;

  constructor(phase = 0) {
    this.frame = phase;
  }

  // Returns the time to simulate this frame, or 0 to skip.
  advance(dt: number, budget: ClothBudget): number {
    this.pending += dt;
    this.frame++;
    if (this.frame % Math.max(1, Math.floor(budget.interval)) !== 0) return 0;
    const step = this.pending;
    this.pending = 0;
    return step;
  }
}
