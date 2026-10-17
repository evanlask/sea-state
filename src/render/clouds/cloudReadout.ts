// The cloud system's CPU readouts (transmittance toward the light at the focus, its directional
// share and the air light) come back from the GPU four times a second, so whatever followed them
// directly (the spray and rain lighting, the haze's brightness, the exposure's cloud dimming) stepped
// at that rate as a cloud's shadow crossed the boat. They ease toward each readback instead. Pure TS.

const CLOUD_READOUT_SMOOTHING = 0.3; // s, about one readback interval

export interface CloudReadoutValues {
  through: number; // cloud transmittance toward the light at the focus
  direct: number; // its directional (shadow-casting) share
  air: number; // light reaching the haze under the clouds
}

export class CloudReadout {
  readonly value: CloudReadoutValues = { through: 1, direct: 1, air: 1 };
  private primed = false;
  private tau: number;

  constructor(tau = CLOUD_READOUT_SMOOTHING) {
    this.tau = tau;
  }

  update(target: Readonly<CloudReadoutValues>, dt: number): Readonly<CloudReadoutValues> {
    const v = this.value;
    if (!this.primed || !(this.tau > 0)) {
      this.primed = true;
      v.through = target.through;
      v.direct = target.direct;
      v.air = target.air;
      return v;
    }
    const k = 1 - Math.exp(-Math.max(0, dt) / this.tau);
    v.through += (target.through - v.through) * k;
    v.direct += (target.direct - v.direct) * k;
    v.air += (target.air - v.air) * k;
    return v;
  }
}
