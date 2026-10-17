// Per-boat light facade: navigation lights (COLREG sets per state), deck/work lights, the extras
// (searchlights, underwater LEDs, headlight, funnel floodlight) and the cabin glow, from a model's
// named markers or the defaults in mounts.ts. Each switches on its own.
//
// Usage (one per boat; `parent` is the boat's body-frame Object3D, bow −Z):
//   const lights = new BoatLights(boatObject, { kind: 'crab', quality, local: isPlayer });
//   lights.setState({ nav: 'auto', deck: 'auto', extra: false, signals: { fishing: true },
//     makingWay: speed > 0.3 });
//   every frame, before rendering: lights.update(camera, dt, exposure.preExposure, sunElevation,
//     { hazeDensity, visibility });
//
// Automatic behaviours (the app decides the inputs; this only renders them):
//   nav 'auto'   on from sunset to sunrise (sun < −0.83°) or in restricted visibility (< 2 nm), Rule 20.
//   deck 'auto'  on after dusk when anchored or fishing, and always on vessels ≥ 50 m and the console
//                boat (its T-top and courtesy lights).
//   extra 'auto' on after dusk for the console boat's underwater LEDs and the PWC headlight.
//   cabin 'auto' fades in through twilight.
//   NUC: the app sets signals.nuc when a ship drifts without propulsion (engine off/failed) and clears
//   it when propulsion returns; anchor overrides NUC; RAM, fishing and NUC add sidelights + sternlight
//   only while makingWay.
//
// Model markers: any descendant of `model` named `light:<mount>` (e.g. light:port, light:masthead-aft)
// moves that nav mount to the marker; `deck:<mount>` moves a deck light (keeping its beam direction,
// or aimed at userData.target = [x, y, z] in the body frame; new fittings aim along the marker's −Z).
// Unknown names add mounts; userData may carry any LightMount/DeckMount field (roles, kind, colour,
// intensity, lensRadius…).

import { type Camera, Group, Matrix4, type Object3D, Vector3 } from 'three/webgpu';

import type { QualityPreset } from '../../../app/Scenario';
import type { BoatKind } from '../../../sim/world/protocol';
import { type N } from '../../tsl';
import {
  lightsRequired,
  type NavRole,
  navRoles,
  NO_SIGNALS,
  type NavSignals,
  type SignalKey,
  SUNSET_ELEVATION,
  VESSEL_LIGHTS,
  type VesselLightProfile,
} from './colregs';
import { DeckLights } from './DeckLights';
import { type FleetBeam, fleetBeam } from './fleetLighting';
import { LIGHT_BUDGET, type LightBudget, REMOTE_BUDGET } from './lightBudget';
import { lightUniforms, setLightAtmosphere } from './lightNodes';
import type { SceneLightPool } from './LightPool';
import {
  deckGroupOf,
  type DeckMount,
  defaultDeckMounts,
  defaultMounts,
  HULL_HEIGHT,
  type LightMount,
  mergeMounts,
} from './mounts';
import { NavLights } from './NavLights';

const DEG = Math.PI / 180;

export type AutoSwitch = boolean | 'auto';

export interface BoatLightState {
  nav: AutoSwitch;
  deck: AutoSwitch;
  extra: AutoSwitch; // searchlights, underwater LEDs, headlight, funnel floodlight
  cabin: AutoSwitch | number; // number: 0..1 share of cabins lit
  signals: Partial<NavSignals>;
  makingWay: boolean; // through the water, > ~0.3 kn
}

const DEFAULT_LIGHT_STATE: Readonly<BoatLightState> = {
  nav: 'auto',
  deck: 'auto',
  extra: 'auto',
  cabin: 'auto',
  signals: {},
  makingWay: true,
};

export interface LightEnvironment {
  hazeDensity?: number; // SkySystem haze (1 = clear maritime air)
  visibility?: number; // m, meteorological visibility from fog/rain (restricted visibility → lights)
}

export interface BoatLightsOptions {
  kind: BoatKind;
  quality?: QualityPreset; // scene-light budget (default 'high')
  local?: boolean; // false: lamps and glows only, no scene lights (distant fleet boats). Default true.
  shadows?: boolean; // allow shadowed deck lights (default true)
  model?: Object3D; // scanned for light:/deck: markers
  mounts?: readonly LightMount[]; // merged over the defaults (after markers)
  deckMounts?: readonly DeckMount[];
  replaceFloods?: boolean; // drop the default 'flood' deck mounts (the model brings its own)
  lens?: boolean; // draw lens meshes (default true)
  intensityScale?: number; // × the Annex I minimum (default 1.5: typical LED lanterns)
}

const SIGNAL_KEYS = Object.keys(NO_SIGNALS) as SignalKey[];

const worldA = new Vector3();
const worldB = new Vector3();

export class BoatLights {
  readonly object = new Group();
  readonly kind: BoatKind;
  readonly profile: VesselLightProfile;
  readonly nav: NavLights;
  readonly deck: DeckLights;
  readonly budget: Readonly<LightBudget>;
  // The one beam a fleet light shines for this boat when it isn't the helm (FleetLightPool): its main
  // deck floods, or with the deck lights off its main extra (searchlight, headlight); see litFleetBeam.
  readonly fleetBeam: FleetBeam | null;
  readonly extraBeam: FleetBeam | null;
  private current: BoatLightState = { ...DEFAULT_LIGHT_STATE, signals: {} };
  private navOn = false;
  private deckOn = false;
  private extraOn = false;
  private roleKey = -1; // the switches the roles were resolved for (update)
  private pool: SceneLightPool | null = null;

  constructor(parent: Object3D, options: BoatLightsOptions) {
    this.kind = options.kind;
    this.profile = VESSEL_LIGHTS[options.kind];
    this.object.name = `boat-lights-${options.kind}`;
    const local = options.local !== false;
    const base = local ? LIGHT_BUDGET[options.quality ?? 'high'] : REMOTE_BUDGET;
    this.budget = options.shadows === false ? { ...base, deckShadows: 0 } : base;

    const markers = options.model ? mountsFromObject(options.model, options.kind) : { nav: [], deck: [] };
    const navMounts = mergeMounts(
      mergeMounts(defaultMounts(options.kind), markers.nav),
      options.mounts ?? [],
    );
    const deckMounts = mergeMounts(
      mergeMounts(
        defaultDeckMounts(options.kind).filter((m) => !options.replaceFloods || m.type !== 'flood'),
        markers.deck,
      ),
      options.deckMounts ?? [],
    );
    this.nav = new NavLights({
      profile: this.profile,
      mounts: navMounts,
      hullHeight: HULL_HEIGHT[options.kind],
      spill: this.budget.navSpill,
      lens: options.lens,
      intensityScale: options.intensityScale ?? 1.5,
    });
    this.deck = new DeckLights({ mounts: deckMounts, budget: this.budget, lens: options.lens });
    this.fleetBeam = fleetBeam(this.deck.mounts.filter((m) => deckGroupOf(m.type) === 'deck'));
    this.extraBeam = fleetBeam(this.deck.mounts.filter((m) => deckGroupOf(m.type) === 'extra'));
    this.object.add(this.nav.object, this.deck.object);
    parent.add(this.object);
  }

  get state(): Readonly<BoatLightState> {
    return this.current;
  }

  get supportedSignals(): readonly SignalKey[] {
    return this.profile.signals;
  }

  // Resolved switches after 'auto' (as of the last update), for the HUD status icons.
  get navigationLightsOn(): boolean {
    return this.navOn;
  }

  get deckLightsOn(): boolean {
    return this.deckOn;
  }

  get extraLightsOn(): boolean {
    return this.extraOn;
  }

  // The fleet beam for the switches as resolved (null: nothing lit worth a fleet light).
  get litFleetBeam(): FleetBeam | null {
    if (this.deckOn && this.fleetBeam) return this.fleetBeam;
    return this.extraOn ? this.extraBeam : null;
  }

  get activeRoles(): readonly NavRole[] {
    return this.nav.activeRoles;
  }

  // Pre-exposed cabin-window luminance for the model's window emissive (see DeckLights).
  get cabinGlowNode(): N {
    return this.deck.cabinGlowNode;
  }

  // Lights the boat's surroundings with the session's pooled scene lights (the helm boat), or stops
  // (null). The pool's lights are re-aimed at this boat's mounts; none are added or removed.
  bindPool(pool: SceneLightPool | null): void {
    if (pool === this.pool) return;
    this.pool = pool;
    this.nav.bindSpill(pool ? pool.spill : null);
    this.deck.bindPool(pool ? { lights: pool.deck, shadowed: pool.shadowed } : null);
    this.roleKey = -1; // re-resolve (and re-assign the spill) on the next update
  }

  get poolBound(): boolean {
    return this.pool !== null;
  }

  // Called every frame: copies into the current state rather than building a new one.
  setState(state: Partial<BoatLightState>): void {
    const c = this.current;
    if (state.nav !== undefined) c.nav = state.nav;
    if (state.deck !== undefined) c.deck = state.deck;
    if (state.extra !== undefined) c.extra = state.extra;
    if (state.cabin !== undefined) c.cabin = state.cabin;
    if (state.makingWay !== undefined) c.makingWay = state.makingWay;
    if (state.signals) {
      // Every key assigned (undefined for missing ones) so the object keeps its shape.
      const signals = c.signals as Record<SignalKey, boolean | undefined>;
      for (let i = 0; i < SIGNAL_KEYS.length; i++) {
        const key = SIGNAL_KEYS[i]!;
        signals[key] = state.signals[key];
      }
    }
  }

  // Warm-up (loading, a boat joining): the lamp glows draw even while dark (their pipelines build).
  setWarmup(on: boolean): void {
    this.nav.field.setWarmup(on);
    this.deck.field.setWarmup(on);
    this.deck.underwater.setWarmup(on);
  }

  update(
    camera: Camera,
    _dt: number,
    preExposure: number,
    sunElevation: number,
    environment: LightEnvironment = {},
  ): void {
    const s = this.current;
    const visibility = environment.visibility ?? Number.POSITIVE_INFINITY;
    lightUniforms.preExposure.value = preExposure;
    // A wall clock, so several boats updating per frame don't speed the twinkle up.
    lightUniforms.time.value = (performance.now() / 1000) % 3600;
    setLightAtmosphere(environment.hazeDensity ?? 1, visibility);

    const dark = sunElevation < 2 * DEG;
    this.navOn = s.nav === 'auto' ? lightsRequired(sunElevation, visibility) : s.nav;
    this.deckOn = s.deck === 'auto' ? dark && this.deckWanted() : s.deck;
    this.extraOn = s.extra === 'auto' ? dark && (this.kind === 'powerboat' || this.kind === 'pwc') : s.extra;
    // The roles change only with these switches: a bit each.
    let key = (this.navOn ? 1 : 0) | (s.makingWay ? 2 : 0);
    for (let i = 0; i < SIGNAL_KEYS.length; i++) if (s.signals[SIGNAL_KEYS[i]!] === true) key |= 4 << i;
    if (key !== this.roleKey) {
      this.roleKey = key;
      this.nav.setRoles(
        navRoles(this.profile, { on: this.navOn, makingWay: s.makingWay, signals: s.signals }),
      );
    }
    this.deck.setGroup('deck', this.deckOn);
    this.deck.setGroup('extra', this.extraOn);
    this.deck.setCabin(cabinLevel(s.cabin, sunElevation));

    camera.getWorldPosition(worldA);
    this.object.getWorldPosition(worldB);
    const distance = worldA.distanceTo(worldB);
    this.nav.update(preExposure, distance);
    this.deck.update(preExposure, distance);
  }

  dispose(): void {
    this.nav.dispose();
    this.deck.dispose();
    this.object.removeFromParent();
  }

  private deckWanted(): boolean {
    const sig = this.current.signals;
    const anchored = sig.anchor === true && this.profile.signals.includes('anchor');
    const fishing = sig.fishing === true && this.profile.signals.includes('fishing');
    return anchored || fishing || this.profile.length >= 50 || this.kind === 'powerboat';
  }
}

function cabinLevel(cabin: BoatLightState['cabin'], sunElevation: number): number {
  if (typeof cabin === 'number') return Math.min(1, Math.max(0, cabin));
  if (cabin !== 'auto') return cabin ? 1 : 0;
  // Fades in from 4° above the horizon to 4° below the sunset elevation.
  const t = Math.min(1, Math.max(0, (4 * DEG - sunElevation) / (4 * DEG - (SUNSET_ELEVATION - 4 * DEG))));
  return t * t * (3 - 2 * t);
}

const toLocal = new Matrix4();
const markerWorld = new Vector3();
const aimWorld = new Vector3();

type MarkerData = Partial<LightMount> & Partial<Omit<DeckMount, 'target'>> & { target?: number[] };

// Light mounts from named markers under a model root (positions relative to the root = body frame).
function mountsFromObject(root: Object3D, kind: BoatKind): { nav: LightMount[]; deck: DeckMount[] } {
  root.updateMatrixWorld(true);
  toLocal.copy(root.matrixWorld).invert();
  const navDefaults = new Map(defaultMounts(kind).map((m) => [m.name, m]));
  const deckDefaults = new Map(defaultDeckMounts(kind).map((m) => [m.name, m]));
  const nav: LightMount[] = [];
  const deck: DeckMount[] = [];
  root.traverse((object) => {
    const match = /^(light|deck):(.+)$/.exec(object.name);
    if (!match) return;
    const [, type, name = ''] = match;
    const data = object.userData as MarkerData;
    object.getWorldPosition(markerWorld).applyMatrix4(toLocal);
    const position = { x: markerWorld.x, y: markerWorld.y, z: markerWorld.z };
    if (type === 'light') {
      const base = navDefaults.get(name);
      const roles = data.roles ?? base?.roles;
      if (!roles) return; // an unknown lantern needs its roles
      nav.push({ ...base, ...(data as Partial<LightMount>), name, roles, position });
      return;
    }
    const base = deckDefaults.get(name);
    let target: DeckMount['target'];
    if (Array.isArray(data.target) && data.target.length === 3) {
      const [x = 0, y = 0, z = 0] = data.target;
      target = { x, y, z };
    } else if (base) {
      // Moved fitting, same beam direction.
      const t = base.target;
      const p = base.position;
      target = { x: position.x + t.x - p.x, y: position.y + t.y - p.y, z: position.z + t.z - p.z };
    } else {
      object.localToWorld(aimWorld.set(0, 0, -10)).applyMatrix4(toLocal);
      target = { x: aimWorld.x, y: aimWorld.y, z: aimWorld.z };
    }
    if (!base && data.intensity === undefined) return; // a new fitting needs at least an intensity
    const fallback: DeckMount = base ?? {
      ...defaultDeckMounts('crab')[0]!,
      name,
      priority: 99,
      shadow: false,
    };
    deck.push({ ...fallback, ...(data as Partial<DeckMount>), name, position, target });
  });
  return { nav, deck };
}
