// Loading-screen tips: controls, weather, COLREGs and seamanship. Kept factual; the
// rotator shuffles them and never shows the same tip twice in a row.

type TipCategory = 'controls' | 'weather' | 'colregs' | 'sailing' | 'boats';

export interface Tip {
  readonly category: TipCategory;
  readonly text: string;
}

export const TIPS: readonly Tip[] = [
  // Controls.
  { category: 'controls', text: 'Press C and V to cycle through the cameras.' },
  {
    category: 'controls',
    text: 'Sailing into a gust? Hold Space to let fly: the sheets run out and the sails spill the wind.',
  },
  {
    category: 'controls',
    text: 'The number keys switch the lights: 1 navigation, 2 deck, 3 cabin, 4 signals, 5 extras such as searchlights.',
  },
  { category: 'controls', text: 'In a fleet, Tab switches which boat you are steering.' },
  { category: 'controls', text: 'Capsized or stuck? Backspace recovers your boat.' },
  { category: 'controls', text: 'Use [ and ] to move the time of day, and \\ to change the time scale.' },
  { category: 'controls', text: 'Press H to hide the HUD, and F1 or ? for help with the controls.' },
  { category: 'controls', text: 'G opens the telemetry panel with roll, pitch and heave numbers.' },

  // Weather and sea state.
  { category: 'weather', text: 'Beaufort force 8 is a gale: 34–40 knots of wind.' },
  { category: 'weather', text: 'Beaufort force 12 is hurricane force: 64 knots or more.' },
  {
    category: 'weather',
    text: 'Beaufort force 4, a moderate breeze of 11–16 knots, brings frequent white horses.',
  },
  {
    category: 'weather',
    text: 'Admiral Francis Beaufort devised his wind scale in 1805, before anemometers were common.',
  },
  { category: 'weather', text: 'Significant wave height is the average of the highest third of the waves.' },
  {
    category: 'weather',
    text: 'Wave size depends on wind speed, how long it has blown, and the fetch of open water.',
  },
  {
    category: 'weather',
    text: 'A Category 5 hurricane has sustained winds of at least 137 knots (157 mph).',
  },
  { category: 'weather', text: 'One knot is one nautical mile (1,852 m) per hour, about 1.15 mph.' },

  // COLREGs and lights.
  { category: 'colregs', text: 'Green is starboard, red is port. Port and left both have four letters.' },
  { category: 'colregs', text: 'Sidelights shine over 112.5°, from dead ahead to 22.5° abaft the beam.' },
  {
    category: 'colregs',
    text: 'Two all-round red lights, one above the other, mean a vessel not under command.',
  },
  {
    category: 'colregs',
    text: '"Red over white, fishing at night": all-round red over white marks a vessel fishing, not trawling.',
  },
  {
    category: 'colregs',
    text: 'Vessels 50 m and longer show a second masthead light, aft of and higher than the first.',
  },
  { category: 'colregs', text: 'Meeting head-on, both power-driven vessels alter course to starboard.' },
  {
    category: 'colregs',
    text: 'In a crossing situation, the vessel that has the other on her starboard side gives way.',
  },
  {
    category: 'colregs',
    text: 'One short blast means "I am altering my course to starboard"; two short blasts, to port.',
  },
  {
    category: 'colregs',
    text: 'Five or more short, rapid blasts mean "I doubt you are taking enough action to avoid a collision".',
  },
  { category: 'colregs', text: 'Two sailboats on opposite tacks: the one on port tack keeps clear.' },
  {
    category: 'colregs',
    text: 'An overtaking vessel keeps clear, even if it is a sailboat overtaking a ship.',
  },

  // Sailing and seamanship.
  { category: 'sailing', text: "A sailboat can't sail closer than about 40° to the wind." },
  { category: 'sailing', text: "If you're wondering whether to reef, it's already time to reef." },
  {
    category: 'sailing',
    text: 'Sailing upwind, apparent wind is stronger and further forward than the true wind.',
  },
  { category: 'sailing', text: 'A displacement hull tops out near 1.34 × √(waterline in feet) knots.' },
  {
    category: 'sailing',
    text: 'In breaking seas, avoid taking them on the beam; meet them at an angle off the bow or stern.',
  },
  {
    category: 'sailing',
    text: 'Rolling building up? Your wave encounter period may match the roll period: change course or speed.',
  },

  // Boats.
  {
    category: 'boats',
    text: 'A loaded Panamax container ship can need more than a nautical mile to stop from full speed.',
  },
  {
    category: 'boats',
    text: 'Container ships can suffer parametric roll when waves arrive at half their roll period.',
  },
  {
    category: 'boats',
    text: "A cruise ship's azipods rotate a full 360°, so it can steer without a rudder.",
  },
  {
    category: 'boats',
    text: 'A jet ski steers with its jet: let go of the throttle and most of your steering goes too.',
  },
  {
    category: 'boats',
    text: 'A deck stacked with crab pots raises the center of gravity and cuts stability.',
  },
  {
    category: 'boats',
    text: 'An Unlimited hydroplane runs on a helicopter turbine: open the throttle and it takes seconds to spool up.',
  },
  {
    category: 'boats',
    text: 'At 200 mph a hydroplane rides on its two sponsons and half a propeller. Let the bow climb a few degrees and the air throws it over backwards.',
  },
  {
    category: 'boats',
    text: 'Hydroplane drivers sit in a sealed safety capsule. A kill switch stops the turbine if the boat flips.',
  },
  {
    category: 'controls',
    text: 'In the hydroplane, Space snaps the throttle shut and Q trims the wing down: both bring a climbing bow back down.',
  },
];

// Shuffles through the list; the first tip of each new pass is never the last of the previous one.
export class TipRotator {
  private readonly tips: readonly Tip[];
  private readonly random: () => number;
  private order: number[] = [];
  private last = -1;

  constructor(tips: readonly Tip[] = TIPS, random: () => number = Math.random) {
    if (tips.length === 0) throw new Error('TipRotator needs at least one tip');
    this.tips = tips;
    this.random = random;
  }

  next(): Tip {
    if (this.order.length === 0) this.refill();
    const index = this.order.pop() ?? 0;
    this.last = index;
    return this.tips[index];
  }

  private refill(): void {
    const order = this.tips.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // next() pops from the end, so the end is what shows first.
    const end = order.length - 1;
    if (end > 0 && order[end] === this.last) [order[0], order[end]] = [order[end], order[0]];
    this.order = order;
  }
}
