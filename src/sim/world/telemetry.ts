// BoatSnapshot.telemetry keys. Every value is a number (flags are 0/1); SI
// units and the conventions in sim/core/conventions.ts (angles in rad, + to
// starboard / bow up / starboard down). Keys a boat does not have are absent.
//
// Every boat (BoatDynamics, WorldBoat):
//   surge, sway            m/s through the water, body axes (+ ahead, + starboard)
//   speedThroughWater      m/s, horizontal
//   yawRate                rad/s, + bow to starboard
//   heel, trim             rad (+ starboard down, + bow up)
//   immersion              0..1 of the design displacement under water
//   wettedArea             m²
//   airborne               0/1, hull (almost) clear of the water
//   onPlane                0/1, planing hulls riding on the plane
//   mass                   kg including shipped water
//   resistance             N, calibrated calm-water resistance being applied
//   froude                 Fn on the waterline length
//   slam                   impact speed of the latest slam, m/s (decays)
//   deckWater              0..1 of the largest open well's capacity (if it has one)
//   deckWaterMass          kg
//   flooding               0..1 of the floodable internal volume
//   floodWaterMass         kg
//   downflooding           0/1, an opening is under water now
//   breaking               N, breaking-crest impact force this step
//   propEmersion           0..1, propeller (or jet intake) out of the water
//   capsized, sunk         0/1
//   avs                    rad, intact angle of vanishing stability
//   gmEffective            m, GM less the free-surface loss of shipped/flood water
//   cpuUs                  µs of worker CPU per 120 Hz step for this boat (smoothed)
//   autopilot              0 none, 1 drift, 2 hold, 3 follow, 4 circle, 5 windAngle
//   crabPots               crab boat: pots stacked on deck (its loading condition)
//   ballast                cargo ship: 1 in ballast, 0 laden
//   wakeUs                 µs of worker CPU per 30 Hz update of this boat's wake grid (smoothed)
//
// Ships with a shaft (cargo, crab): telegraphOrder (−1..1 lever), telegraphResponse
//   (−1..1, delivered), rpm (signed shaft rpm), maxRpm, load (0..1 of MCR), thrust (N),
//   propSlip (0..1), rudderOrder, rudderAngle, rudderMax (rad), thruster (−1..1
//   delivered), thrusterAvailable (0/1).
// Cruise ship (azipods): pod0Angle, pod0Thrust, pod1Angle, pod1Thrust (rad, −1..1),
//   telegraphOrder, telegraphResponse, rpm, maxRpm, load, thruster, thrusterAvailable.
// Center console (outboards): eng0Throttle, eng0Rpm, eng0Trim, eng0Load, eng1Throttle, eng1Rpm,
//   eng1Trim, eng1Load (−1..1, crank rpm, 0..1, 0..1), rpm and load (the busier engine's),
//   maxRpm, steering, steeringMax (rad), outboardTrim (0..1), thrust (N).
// Jet ski: throttle (0..1), rpm, maxRpm, load (0..1 of rated power), nozzle, nozzleMax (rad),
//   bucket (0 ahead, 1 neutral, 2 brake, 3 reverse), ventilated (0..1), thrust (N), riderLean (−1..1).
// Hydroplane (turbine): throttle (0..1), gasGenerator (0..1 power), n1 (gas-generator speed,
//   share of rated), n1Order (the N1 the lever asks for), killSwitch (0/1, fuel cut after a
//   capsize until Recover), rpm (propeller), maxRpm, turbineRpm, load, thrust (N), propLift (N),
//   steering, steeringMax, rudderAngle, rudderMax (rad); its flying hull: aeroLift (N),
//   aeroLiftShare, aeroAlpha (rad), wingAngle (rad), wingTrim (0..1, bow up), outboardTrim.
// Planing hulls (jet ski, center console): slipDrag (N), the drag of sliding in a turn.
// Sailboat: rudderOrder, rudderAngle, rudderMax, plus the sail module's 'sail.*' keys
//   (sim/sail/telemetry.ts).
//
// Readers (HUD, audio, light signals, the engineering panel) are checked against these writers by
// app/telemetryKeys.test.ts.

export const AUTOPILOT_CODES = { none: 0, drift: 1, hold: 2, follow: 3, circle: 4, windAngle: 5 } as const;
