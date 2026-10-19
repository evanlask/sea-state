// Input contexts: which group of bindings is live. Every boat kind maps onto a
// helm class, because a container ship and a crab boat share a telegraph and a
// bow thruster while a jet ski has a spring-loaded trigger and the hydroplane a
// turbine's power lever and a wing.

import type { BoatKind } from '../sim/world/protocol';

export type BoatContext = 'ship' | 'cruise' | 'powerboat' | 'pwc' | 'hydro' | 'sail';

// 'photo' is the free/photo camera: WASD flies the camera instead of the boat.
export type InputContext = 'global' | 'camera' | 'menu' | 'photo' | BoatContext;

export const BOAT_CONTEXTS: readonly BoatContext[] = ['ship', 'cruise', 'powerboat', 'pwc', 'hydro', 'sail'];

// The context requested per frame: a helm class while playing, photo mode, or the menu.
export type PollContext = BoatContext | 'photo' | 'menu';

export const POLL_CONTEXTS: readonly PollContext[] = [...BOAT_CONTEXTS, 'photo', 'menu'];

const BY_KIND: Record<BoatKind, BoatContext> = {
  cargo: 'ship',
  crab: 'ship',
  cruise: 'cruise',
  powerboat: 'powerboat',
  pwc: 'pwc',
  sail: 'sail',
  hydro: 'hydro',
};

export function contextForBoat(kind: BoatKind): BoatContext {
  return BY_KIND[kind];
}

export function isBoatContext(context: InputContext): context is BoatContext {
  return (BOAT_CONTEXTS as readonly InputContext[]).includes(context);
}

// Contexts whose bindings are live together, so they must not conflict. Menus
// are exclusive: Esc and B mean "back" there rather than pause or brake. Photo mode replaces the
// helm (the boat sails on hands-off) but keeps the camera and global controls.
export function activeContexts(context: PollContext): readonly InputContext[] {
  return context === 'menu' ? ['menu'] : ['global', 'camera', context];
}
