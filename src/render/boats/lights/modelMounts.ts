// Light mounts from a procedural model's markers (BoatVisual.lights): the model kit names its
// lanterns by fitting (mastheadForward, sidePort, deckFlood…); the lights system by COLREG mount
// (masthead, port, signal-red-upper…). Nav markers move the matching default mount onto the model's
// lantern housing; spreader and searchlight markers move those fittings; deckFlood markers replace
// the default floods, keeping their colour and output.

import { Vector3 } from 'three/webgpu';

import type { BoatKind } from '../../../sim/world/protocol';
import type { LightKind as MarkerKind, LightMount as ModelMarker } from '../kit/BoatVisual';
import { type DeckMount, defaultDeckMounts, defaultMounts, type LightMount, type Vec3Like } from './mounts';

const MARKER_MOUNT: Partial<Record<MarkerKind, string>> = {
  mastheadForward: 'masthead',
  mastheadAft: 'masthead-aft',
  sidePort: 'port',
  sideStarboard: 'starboard',
  stern: 'stern',
  nucUpper: 'signal-red-upper',
  nucLower: 'signal-red-lower',
  fishingRed: 'signal-red-upper',
  fishingWhite: 'signal-white',
  anchorForward: 'anchor-forward',
  anchorAft: 'anchor-aft',
};

// The all-round white lantern is a different mount per boat.
const ALL_ROUND: Partial<Record<BoatKind, string>> = {
  powerboat: 'stern-pole',
  pwc: 'accessory',
  sail: 'anchor',
  hydro: 'wing',
};

export interface MarkerInput {
  kind: MarkerKind;
  position: Vec3Like; // body frame
  aim?: Vec3Like; // unit beam direction, body frame (floods)
}

export interface ModelLightMounts {
  mounts: LightMount[];
  deckMounts: DeckMount[];
  replaceFloods: boolean; // the model has its own floods: drop the default 'flood' mounts
}

export function mountsFromMarkers(kind: BoatKind, markers: readonly MarkerInput[]): ModelLightMounts {
  const navDefaults = new Map(defaultMounts(kind).map((m) => [m.name, m]));
  const mounts: LightMount[] = [];
  const floods: MarkerInput[] = [];
  const spreaders: MarkerInput[] = [];
  const searchlights: MarkerInput[] = [];
  for (const marker of markers) {
    if (marker.kind === 'deckFlood') {
      floods.push(marker);
      continue;
    }
    if (marker.kind === 'spreader') {
      spreaders.push(marker);
      continue;
    }
    if (marker.kind === 'searchlight') {
      searchlights.push(marker);
      continue;
    }
    // One masthead tricolour lantern carries all three sectors.
    const names =
      marker.kind === 'tricolour'
        ? ['tricolour-port', 'tricolour-starboard', 'tricolour-stern']
        : [marker.kind === 'allRoundWhite' ? ALL_ROUND[kind] : MARKER_MOUNT[marker.kind]];
    for (const name of names) {
      const base = name ? navDefaults.get(name) : undefined;
      if (!base) continue; // a fitting this boat's light set doesn't use
      mounts.push({ ...base, roles: [...base.roles], position: { ...marker.position } });
    }
  }

  // Spreader markers move the default spreader lights (same names, so they override them).
  const spreaderDefaults = defaultDeckMounts(kind).filter((m) => m.type === 'spreader');
  const moved = spreaders.slice(0, spreaderDefaults.length).map((marker, i): DeckMount => {
    const base = spreaderDefaults[i]!;
    const p = marker.position;
    const reach = Math.hypot(
      base.target.x - base.position.x,
      base.target.y - base.position.y,
      base.target.z - base.position.z,
    );
    const aim = marker.aim ?? { x: 0, y: -1, z: 0 };
    return {
      ...base,
      position: { ...p },
      target: { x: p.x + aim.x * reach, y: p.y + aim.y * reach, z: p.z + aim.z * reach },
    };
  });
  // Searchlight markers move the default searchlights onto the model's lamp heads, keeping the aim.
  const searchDefaults = defaultDeckMounts(kind).filter((m) => m.type === 'searchlight');
  for (const [i, marker] of searchlights.slice(0, searchDefaults.length).entries()) {
    const base = searchDefaults[i]!;
    const p = marker.position;
    const t = base.target;
    const q = base.position;
    moved.push({
      ...base,
      position: { ...p },
      target: { x: p.x + t.x - q.x, y: p.y + t.y - q.y, z: p.z + t.z - q.z },
    });
  }
  const defaults = defaultDeckMounts(kind).filter((m) => m.type === 'flood');
  if (floods.length === 0 || defaults.length === 0)
    return { mounts, deckMounts: moved, replaceFloods: false };
  const deckMounts = floods.map((marker, i): DeckMount => {
    const base = defaults[i % defaults.length]!;
    const p = marker.position;
    const reach = Math.hypot(
      base.target.x - base.position.x,
      base.target.y - base.position.y,
      base.target.z - base.position.z,
    );
    const aim = marker.aim ?? { x: 0, y: -0.6, z: 0.8 };
    return {
      ...base,
      name: `model-flood-${i}`,
      position: { ...p },
      target: { x: p.x + aim.x * reach, y: p.y + aim.y * reach, z: p.z + aim.z * reach },
      // Interleave so the first scene lights spread over different fittings.
      priority: base.priority + Math.floor(i / defaults.length) * 10,
      shadow: base.shadow && i < defaults.length,
    };
  });
  return { mounts, deckMounts: [...moved, ...deckMounts], replaceFloods: true };
}

// Markers are direct children of the visual's root (body frame); floods aim along their +Z (lookAt).
export function markersFromModel(lights: readonly ModelMarker[]): MarkerInput[] {
  return lights.map(({ kind, object }) => {
    const z = new Vector3(0, 0, 1).applyQuaternion(object.quaternion);
    return {
      kind,
      position: { x: object.position.x, y: object.position.y, z: object.position.z },
      aim: { x: z.x, y: z.y, z: z.z },
    };
  });
}
