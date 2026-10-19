# Sea~State TODO

Ideas split into separate jobs and grouped by size. Each job has the original note, what the change
involves, where the code lives, and how we'll know it's done. Pick jobs off from here, and delete
each one once it's finished.

Sizes:

- **Small:** under an hour, low risk
- **Medium:** one focused agent session
- **Large:** several steps, some risk
- **Very large:** several agents in sequence

---

## Small

### 20. Last CPU savings (optional)

> (Performance pass, heavy scene: 8 boats, Hurricane 3, night. GPU: the ocean reflections now cost ~1.5 ms instead of ~12–15 ms, GTAO ~1.7 ms instead of 3.3. CPU: draws ~300 → ~220, `SeaScene.render` 6.8 → 4.9 ms, garbage ~25 → ~18 MB/s, session switches no longer leak.)

- The snapshot from the worker is still structured-cloned (~2 MB/s): pack the telemetry into a pooled typed array.
- The HUD model is rebuilt every frame though the HUD repaints at 20 Hz.
- NavLights and DeckLights could share one LampField (2 draws a boat fewer); render bundles for static boat parts.
- Worth doing only if a slower machine is CPU-bound.

---

## Medium

### 13. Jittery front sail

> (Start from the sail-shape change: it added aerodynamic damping that already calmed the genoa about 3×.)

> The sail can look jittery/flappy, especially the front sail.

- Investigate the cloth simulation (`src/cloth/`) for the jib: number of steps, damping, how stiff the luff and leech are, and how the wind pressure is applied.
- Likely fixes: more substeps for the jib, smoothing the wind pressure over a few frames, extra damping, and smoothing the drawn mesh.
- Luffing should still flutter when the sail is undertrimmed.
- The cause is uncertain, so it may take a couple of rounds.

### 14. Setup choices previewed in the menu backdrop

> When configuring a sail, see the options I'm picking reflected in the demo scene behind the menu, if it's not a big performance issue. Backing out restores the initial scene.

- Weather, time, sea state and region are cheap: the live conditions command already exists. Apply them to the backdrop as you change them, and restore the defaults when you leave setup without starting.
- Changing the boat would stutter (models and shaders) unless that boat is already loaded. Preview only boats that are already loaded, or keep the backdrop boat.
- **Done when:** changing weather or time in setup changes the backdrop within a second or two, with no loading screen.

### 16. More cloud layers

> A couple of cloud layers for a more interesting sky; upper layers can be texture-based rather than volumetric.

- Keep the 3D clouds for the low cumulus and stratus.
- Add a cheap flat mid-level layer (altocumulus or altostratus) next to the existing high cirrus layer: textured, lit by the sun, scrolling with the upper wind.
- Each weather preset chooses which layers appear and how much they cover.
- **Done when:** fair and breezy skies have depth (low puffs, a mid deck, high cirrus) at no noticeable cost.

### 24. Sailboat storm tactics

> (Found while checking skill-based capsizing.)

- In a Category 1 the reefed sailboat running off (the textbook tactic) capsizes about as often as one left beam-on with its sails up (a quarter of three-minute runs), and lying beam-on rarely rolls it: the wind pins it at 60–110° rather than a breaker rolling it. Real yachts lying ahull are rolled by breakers (Fastnet 1979) and survive running off slowly, ideally with a drogue.
- Look at: bare-pole lying ahull (sails down), a drogue or warps astern (a new control), and how breakers meet a hull heeled 60–90° (they now strike the topsides; a pinned boat presents its deck).
- **Done when:** in `scripts/capsize-sweep.ts` running off slowly survives clearly more often than lying ahull in a Category 1.

---

## Large

### 18. Air temperature and snow

> Model air temperature, with a setting and presets. Precipitation changes from rain to snow at certain temperatures. Air temperature only, no water temperature.

- Add air temperature to the weather state (`src/sim/weather/`), with a value per preset, a custom slider and a HUD readout.
- Precipitation type follows temperature: rain above about 3 °C, sleet in between, snow below about 0 °C.
- Snow needs:
  - slow, drifting flakes instead of rain streaks
  - a quieter precipitation sound
  - flakes instead of drops on the camera and windows
  - shorter visibility in heavy snow
- No snow piling up on decks; it could come later.
- Possible new preset: Bering Sea snow squall.
- **Done when:** a cold preset or custom temperature turns the rain into believable snow.

### 19. Jet ski 360° spins

> Real jet skis spin all the way round if you turn sharply at full throttle, without capsizing. Emulate that.

- In `src/sim/physics/planingCarve.ts` and the jet ski's hull and jet forces: at full throttle and full lock above a speed threshold, let the hull break loose so its grip on the water drops and the steered jet thrust spins it around, while the roll stays limited.
- Keep the earlier fix for flipping at full lock intact.
- **Tests:** a spin of 360° or more within a few seconds in calm water without capsizing; normal carving unchanged at part throttle; it can still flip in big seas.

---

## Suggested order

1. Jobs 13, 24: realism polish.
2. Jobs 14, 16, 18, 19: new features.
