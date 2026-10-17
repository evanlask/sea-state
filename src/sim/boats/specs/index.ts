// Registry of the boat specs by kind.

import type { BoatKind } from '../../world/protocol';
import type { BoatSpec } from '../BoatSpec';
import { cargoSpec } from './cargo';
import { crabSpec } from './crab';
import { cruiseSpec } from './cruise';
import { hydroSpec } from './hydro';
import { powerboatSpec } from './powerboat';
import { pwcSpec } from './pwc';
import { sailSpec } from './sail';

export const BOAT_SPECS: Readonly<Record<BoatKind, BoatSpec>> = {
  cargo: cargoSpec,
  cruise: cruiseSpec,
  crab: crabSpec,
  sail: sailSpec,
  powerboat: powerboatSpec,
  pwc: pwcSpec,
  hydro: hydroSpec,
};
