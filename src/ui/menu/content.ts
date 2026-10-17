// Static help copy: the sailing primer, a navigation-lights primer and gameplay tips. Kept as data so screens stay layout-only and copy edits stay in one place.

export interface Article {
  title: string;
  paragraphs: string[];
  points?: { term: string; text: string; tone?: 'port' | 'starboard' | 'white' }[];
}

export const SAILING_PRIMER: readonly Article[] = [
  {
    title: 'Points of sail',
    paragraphs: [
      'Everything on a sailboat depends on the angle between the bow and the wind. No boat can sail straight into it: ' +
        'about 40° either side of the wind is the no-go zone, shaded on the wind dial. The HUD names your angle ' +
        'above the sail-plan diagram.',
    ],
    points: [
      {
        term: 'In irons',
        text: 'Pointing into the wind. The sails flap and the boat stops. Steer away from the wind to fill them (in Arcade the boat slowly turns out by itself).',
      },
      {
        term: 'Close-hauled',
        text: '~40–55° off the wind, sails pulled in tight. As close to upwind as you can go.',
      },
      { term: 'Close reach', text: '~60°. Let the sails out a little; the boat speeds up.' },
      {
        term: 'Beam reach',
        text: '90°, wind on the side. Often the fastest point of sail, and where you start.',
      },
      { term: 'Broad reach', text: '~135°. Sails well out, fast and comfortable.' },
      {
        term: 'Run',
        text: 'Wind from behind. Sails all the way out. Keep the wind a little off the stern, or the boom can swing across on its own (an accidental gybe).',
      },
    ],
  },
  {
    title: 'How to trim',
    paragraphs: [
      'Trimming is setting how far out each sail sits, using its sheet (the rope that pulls it in). Let the sheet ' +
        'out until the front edge of the sail just starts to flutter, then pull it back in until the fluttering ' +
        'stops. That is the fastest setting. Too tight and the sail stalls: the boat leans over and slows.',
      'The sail-plan diagram helps: the sails are coloured by trim, the dashed lines show the ideal angle, the ' +
        'arrows say whether to trim in or ease out, and the telltales (streamers on the sails) all stream back when ' +
        'it is right. Auto-trim (T or hold L3) lets the crew do it: on by default in Arcade, off in Realistic. ' +
        'Touching a sheet turns it off.',
      'Caught by a gust? Hold Space to let fly: both sheets run right out and the sails spill the wind. Let go ' +
        'and auto-trim pulls them back in; without it they stay out until you trim (W, Q). On a gamepad, ease ' +
        'with LT and LB.',
    ],
  },
  {
    title: 'Tacking and gybing',
    paragraphs: [
      'To get from one side of the wind to the other, turn either the bow through the wind (a tack) or the stern ' +
        'through the wind (a gybe). The sails cross to the new side on their own.',
    ],
    points: [
      {
        term: 'Tack',
        text: 'From close-hauled, steer firmly through the no-go zone. Keep your speed up or you will stop in irons halfway round.',
      },
      {
        term: 'Gybe',
        text: 'From a run, turn the stern through the wind. The boom (the pole along the bottom of the mainsail) swings across hard: pull the mainsail in first, then let it out on the new side.',
      },
      {
        term: 'Accidental gybe',
        text: 'With the wind dead behind, a wave or a gust can slam the boom across without warning. Keep the wind a little off the stern.',
      },
    ],
  },
  {
    title: 'Reefing when overpowered',
    paragraphs: [
      'Leaning over more than about 25° makes the boat slower, not faster: the rudder loses grip and she swings up ' +
        'into the wind. When the HUD shows "Overpowered — reef", take in a reef (R or tap X), which makes the ' +
        'mainsail smaller, in up to three steps. Roll away some of the jib, the front sail, too (F or B: a third ' +
        'per press, then it sets again). Reef early: the first reef at about 18 kn of wind, the second at 24, the ' +
        'third at 30. The boat starts out reefed for the wind.',
      'Shake reefs out (Shift+R or hold X) as the wind eases; the HUD says when.',
    ],
  },
];

export const HYDRO_PRIMER: readonly Article[] = [
  {
    title: 'Driving a hydroplane',
    paragraphs: [
      'The U-7 Sea Fury is an Unlimited hydroplane: a 3,000 hp helicopter turbine in a 9 m hull that rides on ' +
        'three points at speed, the back corners of its two sponsons and half of its propeller. The rest is in the ' +
        'air, and the air carries half its weight at 200 mph. That is what makes it fast, and what can flip it.',
    ],
    points: [
      {
        term: 'Spool lag',
        text: 'The throttle (W) sets the turbine’s power, and the turbine takes about 3½ seconds to get there: listen to the whine climb, and watch the N1 needle chase the marker on its dial. It runs down just as slowly, so lift early.',
      },
      {
        term: 'Keep the bow down',
        text: 'At racing speed the air under the hull lifts the bow. A few degrees above its running trim and the lift wins: the boat flies up and over backwards (a blow-over). The HUD warns “Bow high” first. Snap the throttle shut (Space) or trim the wing down (Q).',
      },
      {
        term: 'The wing',
        text: 'The wing over the transom trims the boat (Q less, E more). More wing holds the bow up off a wave; less lets it settle. Never add wing flat out.',
      },
      {
        term: 'Turning',
        text: 'It grips through the turns on a skid fin and the edge of its right sponson, so it turns best to the left, like the race courses: over 2 g at 160 mph. To the right the fin lifts and it skids wide. Ease off before turning hard: above about 170 mph full lock to the left trips it over.',
      },
      {
        term: 'Waves at speed',
        text: 'It races on flat water only. In a chop each crest kicks the bow up, and a 2 m sea flips it at any real speed. The HUD says how fast is safe; in rough weather, slow right down.',
      },
      {
        term: 'Kill switch',
        text: 'Upside down, the driver is safe in his sealed capsule and the kill switch cuts the turbine. Recover (Backspace) rights the boat and relights it.',
      },
    ],
  },
];

export const LIGHTS_PRIMER: readonly Article[] = [
  {
    title: 'Navigation lights',
    paragraphs: [
      'After dark, other boats are just lights, and their colours tell you which way they are heading. Which ' +
        'lights a boat shows is set by the international collision rules (the COLREGs). Yours start switched on: ' +
        '1 (or N, or a tap on D-pad ↑) turns them off and on, and the HUD reminds you if they are off at night.',
    ],
    points: [
      {
        term: 'Port — red',
        tone: 'port',
        text: 'The left side shows a red sidelight, from dead ahead round to a little behind square (22.5°).',
      },
      {
        term: 'Starboard — green',
        tone: 'starboard',
        text: 'The right side shows green over the same arc. "Port wine is red."',
      },
      {
        term: 'Masthead — white',
        tone: 'white',
        text: 'Shines forward over 225°. Ships over 50 m carry two, the rear one higher.',
      },
      {
        term: 'Stern — white',
        tone: 'white',
        text: 'Shines backward over 135°, filling the gap the masthead light leaves.',
      },
    ],
  },
  {
    title: 'Which boat shows what',
    paragraphs: [],
    points: [
      { term: 'Ships and crab boat', text: 'Sidelights, a stern light and one or two masthead lights.' },
      {
        term: 'Center console',
        text: 'Sidelights and one all-round white in place of the masthead and stern lights, as boats under 12 m may.',
      },
      {
        term: 'Sailboat',
        text: 'Sidelights and a stern light but no masthead light: that marks her as sailing.',
      },
      {
        term: 'Hydroplane',
        text: 'Sidelights on the sponson noses and an all-round white on the wing, as boats under 12 m may.',
      },
      { term: 'Jet ski', text: 'Just a small white light. Jet skis aren’t meant to be out after dark.' },
    ],
  },
  {
    title: 'Reading what you see',
    paragraphs: [],
    points: [
      { term: 'Red and green together', text: 'She is heading straight at you.' },
      {
        term: 'Red only',
        tone: 'port',
        text: 'You see her left side, so she is crossing from your right. Between powered boats, you give way.',
      },
      {
        term: 'Green only',
        tone: 'starboard',
        text: 'You see her right side, crossing from your left. She gives way; hold your course.',
      },
      {
        term: 'White only',
        tone: 'white',
        text: 'You are looking at her stern, or she is at anchor, or she is a jet ski.',
      },
      {
        term: 'Two all-round reds',
        tone: 'port',
        text: 'Not under command: a ship drifting with her engines stopped. Keep clear. Ships show it automatically.',
      },
      {
        term: 'Red over white',
        text: 'Fishing. The crab boat shows it automatically when her deck lights are on and she is going slowly.',
      },
      {
        term: 'Red, white, red',
        text: 'Restricted in her ability to manoeuvre: a ship that can’t easily get out of your way.',
      },
    ],
  },
  {
    title: 'Your other lights',
    paragraphs: [
      'The number keys switch each kind of light on its own, and the HUD shows which are on. On a gamepad, tap ' +
        'a D-pad direction for the first light of a pair and hold it for the second.',
    ],
    points: [
      { term: '1 · Navigation', text: 'Sidelights, masthead and stern lights (N, tap D-pad ↑).' },
      {
        term: '2 · Deck',
        text: 'Deck and work floods, the sailboat’s spreader lights, the center console’s T-top lights (L, tap D-pad ↓).',
      },
      {
        term: '3 · Cabin',
        text: 'Cabins, wheelhouse and accommodation: the lit windows (hold D-pad ↓).',
      },
      {
        term: '4 · Signals',
        text:
          'Cycles automatic, at anchor (all-round white), restricted in ability to manoeuvre (ships only), then ' +
          'back to automatic (hold D-pad ↑).',
      },
      {
        term: '5 · Extras',
        text:
          'Searchlights on the ships and the crab boat (the cruise ship also floodlights her funnels), underwater ' +
          'lights on the center console, the jet ski’s headlight (hold D-pad ← or →).',
      },
    ],
  },
];

export const GAMEPLAY_TIPS: readonly string[] = [
  'Arcade: steering centres itself when you let go, the sails trim themselves, and a container ship answers in ' +
    'seconds. Realistic: the helm stays where you leave it (X, or a click of the left stick, centres it), you ' +
    'trim the sails yourself, and ships ' +
    'take their real minutes. Switch in Settings → Gameplay.',
  'Capsizing comes down to how you handle the boat. Big ships shrug off most storms; the crab boat, sailboat, center console and jet ski need care, and the hydroplane wants flat water.',
  'Meet big waves bow-first. Waves hitting your side, breaking ones most of all, are how small boats get rolled over.',
  'With big waves behind you, keep the speed down: surfing down a wave face can spin the boat sideways and roll it.',
  'In the center console and the jet ski, ease the throttle before each crest. Launching off big waves is how they flip.',
  'The hydroplane’s turbine lags the throttle by seconds, and a climbing bow at speed means a blow-over: Space shuts the throttle, Q trims the wing down. The Help’s Hydroplane tab has more.',
  'The HUD alerts say what the danger is and what to do about it: turn into the waves, slow down, or ease the sails.',
  'The attitude gauge shows how far you are leaning, with a red danger zone worked out for your boat. Stay out of it.',
  'Water on deck makes the boat less stable until it drains away. Slow down and give it time.',
  'A heavy load of crab pots makes the crab boat roll over more easily. Set the pot count in voyage setup and try the same storm laden and empty.',
  'Add boats in voyage setup or the pause menu’s Fleet screen, then switch helm with Tab or D-pad ← →.',
  'Capsized or sunk? Backspace, hold View, or Recover boat in the pause menu puts you back upright.',
  'A full day and night takes an hour by default (Settings → Gameplay → Day length). [ and ] jump half an hour; \\ fast-forwards.',
  'Click the view to look around with the mouse, or right-drag to orbit. Esc lets go of the mouse (and pauses from the helm view).',
  'The telemetry panel (engineering readouts) is off by default: G or Settings → HUD shows it.',
  'Each region has its own sea: picking one sets its season and typical weather, and its background swell runs under any weather without a swell of its own (Auto sea state).',
  'The Arctic region sits at 70°N: in June and July the sun never sets, and in December it never rises, with only a twilight glow at noon.',
];
