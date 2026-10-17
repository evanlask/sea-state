// Telemetry keys written by the sail force module (BoatSnapshot.telemetry). Every key is prefixed
// 'sail.' so it can't collide with hull or world readouts. Units are SI, angles in radians, signs as in
// sim/core/conventions.ts (relative angles + to starboard). Booleans are 0/1.
//
// HUD (SailingState; pointOfSail is derived from twa with ui/hud/sailing.ts pointOfSail):
//   tws, twa            true wind at 10 m: speed, angle off the bow (+ from starboard)
//   aws, awa            apparent wind at the masthead, in the plane perpendicular to the mast
//   boomAngle           β from the centreline, + boom to starboard
//   jibAngle            genoa sheeting angle at the tack, + clew to starboard
//   idealBoomAngle, idealJibAngle   the auto-trim optimum for the current apparent wind (signed)
//   mainTrim, jibTrim   −1 luffing (under-trimmed), 0 optimal, 1 stalled (over-trimmed)
//   telltaleJibWindward, telltaleJibLeeward, telltaleMainLeech   1 streaming, 0 lifting, −1 stalled
//   reef                target reef level 0..3 (reefProgress is the animated level)
//   jibFurl             0 fully set .. 1 rolled away (animated)
//   autoTrim, heel (+ starboard down), vmg (+ toward the wind), targetSpeed (ORC polar), targetPct
//   bestUpwindTwa, bestDownwindTwa (ORC beat/run angles, unsigned), gybeDanger, inIrons
// Audio:
//   mainLuff, jibLuff   0..1 flogging intensity (scale by aws² for loudness)
//   boomSlams           count of boom snubs harder than 0.6 rad/s; boomSlam is the last one's rad/s
//   boomCrossings       completed boom swings across (tacks/gybes); gybes counts those made downwind
// Rendering (body frame, metres; the cloth and SailView read these):
//   mainClewX/Y/Z, jibClewX/Y/Z, boomEndX/Y/Z
//   mainAwX/Y/Z, jibAwX/Y/Z   relative air at each sail's centre of effort, body frame, m/s
//   mainForce, jibForce       aerodynamic force magnitude per sail, N (cloth pressure scaling)
//   mainFill, jibFill         0 flogging .. 1 drawing
//   mainSheet, jibSheet       sheet limit (max out angle), rad; mainSheetLength, jibSheetLength, m
// Engineering panel:
//   mainAlpha, jibAlpha, mainCl, mainCd, jibCl, jibCd, mainArea, jibArea (m², after reef/furl)
//   drive (N forward), side (N to starboard), heelMoment (N·m, + heels to starboard),
//   yawMoment (N·m, + turns the bow to starboard), lightAir (arcade assist active)

export const SAIL_KEYS = {
  tws: 'sail.tws',
  twa: 'sail.twa',
  aws: 'sail.aws',
  awa: 'sail.awa',
  boomAngle: 'sail.boomAngle',
  jibAngle: 'sail.jibAngle',
  idealBoomAngle: 'sail.idealBoomAngle',
  idealJibAngle: 'sail.idealJibAngle',
  mainTrim: 'sail.mainTrim',
  jibTrim: 'sail.jibTrim',
  telltaleJibWindward: 'sail.telltaleJibWindward',
  telltaleJibLeeward: 'sail.telltaleJibLeeward',
  telltaleMainLeech: 'sail.telltaleMainLeech',
  reef: 'sail.reef',
  reefProgress: 'sail.reefProgress',
  jibFurl: 'sail.jibFurl',
  autoTrim: 'sail.autoTrim',
  heel: 'sail.heel',
  vmg: 'sail.vmg',
  targetSpeed: 'sail.targetSpeed',
  targetPct: 'sail.targetPct',
  bestUpwindTwa: 'sail.bestUpwindTwa',
  bestDownwindTwa: 'sail.bestDownwindTwa',
  gybeDanger: 'sail.gybeDanger',
  inIrons: 'sail.inIrons',
  mainLuff: 'sail.mainLuff',
  jibLuff: 'sail.jibLuff',
  boomSlams: 'sail.boomSlams',
  boomSlam: 'sail.boomSlam',
  boomCrossings: 'sail.boomCrossings',
  gybes: 'sail.gybes',
  mainClewX: 'sail.mainClewX',
  mainClewY: 'sail.mainClewY',
  mainClewZ: 'sail.mainClewZ',
  jibClewX: 'sail.jibClewX',
  jibClewY: 'sail.jibClewY',
  jibClewZ: 'sail.jibClewZ',
  boomEndX: 'sail.boomEndX',
  boomEndY: 'sail.boomEndY',
  boomEndZ: 'sail.boomEndZ',
  mainAwX: 'sail.mainAwX',
  mainAwY: 'sail.mainAwY',
  mainAwZ: 'sail.mainAwZ',
  jibAwX: 'sail.jibAwX',
  jibAwY: 'sail.jibAwY',
  jibAwZ: 'sail.jibAwZ',
  mainForce: 'sail.mainForce',
  jibForce: 'sail.jibForce',
  mainFill: 'sail.mainFill',
  jibFill: 'sail.jibFill',
  mainSheet: 'sail.mainSheet',
  jibSheet: 'sail.jibSheet',
  mainSheetLength: 'sail.mainSheetLength',
  jibSheetLength: 'sail.jibSheetLength',
  mainAlpha: 'sail.mainAlpha',
  jibAlpha: 'sail.jibAlpha',
  mainCl: 'sail.mainCl',
  mainCd: 'sail.mainCd',
  jibCl: 'sail.jibCl',
  jibCd: 'sail.jibCd',
  mainArea: 'sail.mainArea',
  jibArea: 'sail.jibArea',
  drive: 'sail.drive',
  side: 'sail.side',
  heelMoment: 'sail.heelMoment',
  yawMoment: 'sail.yawMoment',
  lightAir: 'sail.lightAir',
} as const;

type SailTrimState = 'luffing' | 'optimal' | 'stalled';

export const trimStateOf = (code: number): SailTrimState =>
  code < -0.5 ? 'luffing' : code > 0.5 ? 'stalled' : 'optimal';
