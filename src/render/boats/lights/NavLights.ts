// A boat's navigation lights: a LampField with one lamp per mount (lit when any of its roles is
// required) plus a small pool of spill lights so the red/green and the stern-pole white tint the hull,
// deck and water next to them. The pool is fixed at construction and re-aimed when the lit set
// changes, so toggling lights never changes the scene's light count (which would recompile every
// lit material).

import { Group, SpotLight, Vector3 } from 'three/webgpu';

import {
  LIGHT_COLOURS,
  luminousIntensity,
  type NavRole,
  requiredIntensity,
  SECTORS,
  sectorCentre,
  VERTICAL_FLOOR,
  VERTICAL_FLOOR_SAIL,
  type VesselLightProfile,
} from './colregs';
import { type LampEntry, LampField } from './LampField';
import { type LightMount, mountLight } from './mounts';

const DEG = Math.PI / 180;

export interface NavLightsOptions {
  profile: VesselLightProfile;
  mounts: readonly LightMount[];
  hullHeight: number; // m above the waterline (spill lights only where they reach something)
  spill: number; // spill lights in the pool
  lens?: boolean;
  intensityScale?: number; // real lanterns often exceed the Annex I minimum; 1 = minimum
}

// Which lit lanterns get spill lights first.
const SPILL_ORDER: readonly NavRole[] = [
  'port',
  'starboard',
  'stern',
  'allRoundWhite',
  'anchorForward',
  'signalRedUpper',
  'signalWhite',
  'signalRedLower',
  'anchorAft',
  'masthead',
];
const SPILL_MIN_LUX = 0.03; // illuminance a lantern must put on the deck below to earn a spill light
const SPILL_SHARE = 0.7; // lanterns put less light below the horizontal than along it
const SPILL_FADE_START = 600; // m camera distance where spill starts to fade (nobody can see it)
const SPILL_FADE_END = 1500;
const SPILL_PENUMBRA = 0.6;

interface SpillSlot {
  light: SpotLight;
  mount: number; // −1 = idle
}

const scratch = new Vector3();

export class NavLights {
  readonly object = new Group();
  readonly mounts: readonly LightMount[];
  readonly field: LampField;
  private intensities: number[];
  private lit: boolean[];
  private roles: NavRole[] = [];
  private hullHeight: number;
  private slots: SpillSlot[] = [];
  private owned: SpotLight[] = [];
  private pooled: readonly SpotLight[] | null = null;

  constructor(options: NavLightsOptions) {
    this.object.name = 'nav-lights';
    this.hullHeight = options.hullHeight;
    this.mounts = options.mounts.map((m) => ({ ...m }));
    const scale = options.intensityScale ?? 1;
    const floor = options.profile.type === 'sail' ? VERTICAL_FLOOR_SAIL : VERTICAL_FLOOR;
    this.intensities = this.mounts.map((m) => {
      const { kind } = mountLight(m);
      const base =
        m.intensity ??
        (m.rangeNm !== undefined
          ? luminousIntensity(m.rangeNm)
          : requiredIntensity(kind, options.profile.length));
      return base * scale;
    });
    const entries: LampEntry[] = this.mounts.map((m, i) => {
      const { kind, colour } = mountLight(m);
      return {
        position: m.position,
        lensRadius: m.lensRadius ?? 0.05,
        colour: LIGHT_COLOURS[colour],
        intensity: this.intensities[i] ?? 0,
        shape: { mode: 'sector', sector: m.sector ?? SECTORS[kind], verticalFloor: floor },
      };
    });
    this.lit = this.mounts.map(() => false);
    this.field = new LampField(entries, { lens: options.lens });
    this.object.add(this.field.object);

    for (let i = 0; i < Math.max(0, options.spill); i++) {
      const light = new SpotLight(0xffffff, 0, 10, 60 * DEG, SPILL_PENUMBRA, 2);
      light.name = `nav-spill-${i}`;
      light.castShadow = false;
      this.object.add(light, light.target);
      this.owned.push(light);
    }
    this.slots = this.owned.map((light) => ({ light, mount: -1 }));
  }

  // Roles currently lit (for the HUD's status icons).
  get activeRoles(): readonly NavRole[] {
    return this.roles;
  }

  isLit(mountName: string): boolean {
    const i = this.mounts.findIndex((m) => m.name === mountName);
    return i >= 0 && this.lit[i] === true;
  }

  intensityOf(mountName: string): number {
    const i = this.mounts.findIndex((m) => m.name === mountName);
    return this.intensities[i] ?? 0;
  }

  setRoles(roles: readonly NavRole[]): void {
    this.roles = [...roles];
    this.mounts.forEach((m, i) => {
      const on = m.roles.some((r) => roles.includes(r));
      this.lit[i] = on;
      this.field.setOn(i, on);
    });
    this.assignSpill();
  }

  // cameraDistance: m from the camera to the boat, to fade spill nobody can see.
  update(preExposure: number, cameraDistance: number): void {
    const t = Math.min(
      1,
      Math.max(0, (cameraDistance - SPILL_FADE_START) / (SPILL_FADE_END - SPILL_FADE_START)),
    );
    const fade = 1 - t;
    for (const slot of this.slots) {
      const cd = slot.mount >= 0 ? (this.intensities[slot.mount] ?? 0) : 0;
      slot.light.intensity = cd * SPILL_SHARE * preExposure * fade;
    }
  }

  dispose(): void {
    this.bindSpill(null);
    this.field.dispose();
    for (const light of this.owned) light.dispose();
    this.object.removeFromParent();
  }

  // Spill from the given (pooled, unshadowed) spot lights instead of its own; null: its own again.
  bindSpill(lights: readonly SpotLight[] | null): void {
    if (lights === this.pooled) return;
    for (const slot of this.slots) slot.light.intensity = 0;
    this.pooled = lights;
    this.slots = (lights ?? this.owned).map((light) => ({ light, mount: -1 }));
    this.assignSpill();
  }

  private assignSpill(): void {
    if (this.slots.length === 0) return;
    const candidates: number[] = [];
    for (const role of SPILL_ORDER) {
      this.mounts.forEach((m, i) => {
        if (!this.lit[i] || !m.roles.includes(role) || candidates.includes(i)) return;
        const drop = Math.max(0.5, m.position.y - this.hullHeight);
        if ((this.intensities[i] ?? 0) / (drop * drop) >= SPILL_MIN_LUX) candidates.push(i);
      });
    }
    this.slots.forEach((slot, s) => {
      const i = candidates[s] ?? -1;
      slot.mount = i;
      const m = this.mounts[i];
      if (!m) {
        slot.light.intensity = 0;
        return;
      }
      const { kind, colour } = mountLight(m);
      const c = LIGHT_COLOURS[colour];
      const cd = this.intensities[i] ?? 0;
      const light = slot.light;
      light.color.setRGB(c[0], c[1], c[2]);
      light.distance = Math.min(25, Math.max(3, 4 * Math.sqrt(cd)));
      light.penumbra = SPILL_PENUMBRA;
      light.position.set(m.position.x, m.position.y, m.position.z);
      const sector = m.sector ?? SECTORS[kind];
      const { centre, halfWidth } = sectorCentre(sector);
      if (halfWidth >= Math.PI - 1e-3) {
        // All-round: straight down over the deck and the water around it.
        scratch.set(0, -1, 0);
        light.angle = 85 * DEG;
      } else {
        const down = 25 * DEG;
        scratch.set(Math.sin(centre) * Math.cos(down), -Math.sin(down), -Math.cos(centre) * Math.cos(down));
        light.angle = Math.min(80 * DEG, halfWidth + 5 * DEG);
      }
      light.target.position.copy(light.position).addScaledVector(scratch, 5);
    });
  }
}
