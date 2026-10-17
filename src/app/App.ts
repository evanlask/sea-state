// Top-level orchestration. The app owns the renderer, settings, input, camera,
// menus and one requestAnimationFrame loop; each scenario runs in a Session
// (simulation host + loop + scene) that is torn down and rebuilt when the
// player starts a new voyage. The main menu floats over a live background
// session.

import { Vector3 } from 'three/webgpu';

import { AudioEngine } from '../audio/AudioEngine';
import { SampleBank } from '../audio/SampleBank';
import { type CameraMode, CameraRig, parseCameraMode } from '../camera/CameraRig';
import { contextForBoat } from '../input/contexts';
import { attachInputListeners } from '../input/dom';
import { inputSettingsFrom } from '../input/fromSettings';
import { type InputFrame, InputManager } from '../input/InputManager';
import { loadBoatTemplate, prepareBoatModels } from '../render/boats/createBoatVisual';
import { preloadBoatDetail } from '../render/boats/detail/preload';
import { boatModelNotices, preloadBoatModels } from '../render/boats/glb/boatModels';
import { preloadRider } from '../render/boats/rider/preload';
import { type PostSettings, postSettingsFrom } from '../render/post/postSettings';
import { Renderer, UnsupportedError } from '../render/Renderer';
import { type SceneWeather, SeaScene } from '../render/SeaScene';
import { needsRebuild } from '../settings/applyMode';
import { suggestInitialPreset } from '../settings/presets';
import { dayLengthTimeScale, type HudMode } from '../settings/schema';
import { SettingsStore } from '../settings/store';
import { formatIsoDate, SimClock } from '../sim/astro/clock';
import { getRegion } from '../sim/astro/regions';
import { attitudeFromQuat } from '../sim/core/attitude';
import { DEG } from '../sim/core/conventions';
import {
  type BoatControls,
  type BoatKind,
  type BoatSnapshot,
  neutralControls,
  PROBE_STRIDE,
  type SimCommand,
  type SimEvent,
  type SpectrumMessage,
} from '../sim/world/protocol';
import { type SimHost, LocalSimHost, WorkerSimHost } from '../sim/world/SimHost';
import { ApplyingOverlay } from '../ui/applyingOverlay';
import { Hud } from '../ui/hud/Hud';
import type { CapsizeCardModel, HudAlert, LightSignal } from '../ui/hud/model';
import { LoadingScreen } from '../ui/loading/LoadingScreen';
import { BOAT_CARDS } from '../ui/menu/boats';
import { type FleetAutopilot, MenuController } from '../ui/menu/MenuController';
import {
  type Conditions,
  defaultSetup,
  formatDuration,
  MAX_FLEET,
  type ScenarioSetup,
} from '../ui/menu/setup';
import { type LinkableSetup, setupFromSearch, setupSearch } from '../ui/menu/setupLink';
import { FpsCounter } from '../ui/overlay/FpsCounter';
import { PerfOverlay } from '../ui/overlay/PerfOverlay';
import { TelemetryPanel } from '../ui/telemetry/TelemetryPanel';
import { showFatalError, showUnsupported } from '../ui/unsupported';
import { AudioFrameBuilder } from './audioFrame';
import {
  capsizeCard,
  CollisionAlert,
  type Rumble,
  rumbleForCollision,
  rumbleForSlam,
  WinchTracker,
} from './feedback';
import { FrameRuntime } from './FrameRuntime';
import { type FrameInfo, GameLoop } from './GameLoop';
import { sceneGraphicsFor } from './graphicsOptions';
import { RebuildScheduler } from './graphicsRebuild';
import { HudModelBuilder } from './hudModel';
import { interpolateBoats } from './interpolate';
import { nextSignalOverride, type SignalOverride, signalsWithOverride } from './lightSignals';
import { defaultStorage } from './loading/eta';
import { LoadingManager } from './loading/LoadingManager';
import { loadRecordings } from './loadRecordings';
import { defaultScenario, type LaunchOptions } from './Scenario';
import {
  blendSceneWeather,
  CONDITION_TRANSITIONS,
  conditionsCommand,
  conditionsFor,
  type FleetPose,
  joiningSpawn,
  loadFor,
  type ScenarioChoices,
  sceneWeatherFor,
  simConfigFor,
  weatherChanged,
  windFor,
  withConditions,
} from './scenarioConfig';
import { blendSeaReadout, foamWindVelocity, type SeaReadout, seaReadoutOf } from './seaReadout';
import { loadSurvivalBests, recordSurvival, RunStats, SurvivalRun } from './survival';
import { beginWarmUp, warmUp } from './warmup';

export interface BootUi {
  setStatus(text: string): void;
  hide(): void;
}

// With ?debug, the console gets a deep link that reopens this voyage. The address bar itself
// never changes during play.
function logDeepLink(setup: LinkableSetup): void {
  const search = setupSearch(setup, window.location.search);
  console.info(`Deep link: ${window.location.origin}${window.location.pathname}${search}`);
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// True when only post-chain settings changed (not reflections, which rebuild the ocean material).
function postOnlyChange(previous: string, next: PostSettings): boolean {
  try {
    const before = JSON.parse(previous) as Partial<PostSettings>;
    return (before.reflections ?? 'env') === (next.reflections ?? 'env');
  } catch {
    return false;
  }
}

// Alerts the capsize card replaces while it shows: it says it all, and handling advice is moot
// with the boat upside down. The Storm Survival result waits until after the recovery.
const CARD_COVERS = new Set([
  'capsized',
  'capsize-risk',
  'heeling',
  'heavy-roll',
  'beam-seas',
  'following-seas',
  'airborne',
  'deck-water',
  'deck-awash',
  'flooding',
  'accidental-gybe',
  'in-irons',
  'survival-result',
]);

// What the main menu floats over.
const menuBackground = (): ScenarioChoices => ({
  ...defaultScenario(),
  playerBoat: 'sail',
  weather: 'breezy',
});

interface Session {
  host: SimHost;
  loop: GameLoop;
  scene: SeaScene;
  clock: SimClock;
  weather: SceneWeather;
  choices: ScenarioChoices;
  playerKind: BoatKind;
  background: boolean; // the main menu's backdrop rather than a voyage
  fromMenu: boolean; // started from the menu (so live changes carry over to Continue)
  // --- live changes from the pause menu ---
  conditions: Conditions; // what's running, as the Conditions screen edits it
  conditionsDue: boolean; // a setConditions command is waiting for the throttle
  // The sky blends from weatherFrom to weatherTo over weatherDuration real seconds.
  weatherFrom: SceneWeather;
  weatherTo: SceneWeather;
  weatherAge: number;
  weatherDuration: number;
  // The newest ocean spectrum, and the sea readout when it arrived (the HUD and the foam blend with
  // the sea).
  spectrum: SpectrumMessage;
  seaFrom: SeaReadout;
  nextFleetIndex: number; // ids for boats joining mid-voyage
  pendingSpawns: (FleetPose & { id: string })[]; // asked for, not yet in a snapshot (quick adds don't stack)
  post: string; // the post settings the scene runs with (JSON), to skip rebuilds that change nothing
  builtPosts: Set<string>; // post settings whose pipelines this voyage has built (instant to return to)
}

// At most one live weather rebuild in the worker per this interval while a slider is dragged.
const CONDITIONS_THROTTLE_MS = 300;

const smoothstep = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export class App {
  private renderer: Renderer;
  private settings: SettingsStore;
  private options: LaunchOptions;
  private loading: LoadingManager;
  private input: InputManager;
  private rig = new CameraRig();
  private perf = new PerfOverlay();
  private fps: FpsCounter; // graphics.showFps
  private frames: FrameRuntime;
  private warming = false; // warm-up frames drive the loop themselves
  private disposed = false; // the page is going away
  // Null where the browser refuses localStorage (sandboxed iframe, blocked site data): nothing persists.
  private readonly storage = defaultStorage();
  private readonly root: HTMLElement; // #app, replaced by the error panel when the app can't go on
  // Graphics changes that rebuild pipelines apply together, behind an overlay (rebuildGraphics).
  private rebuild = new RebuildScheduler(() => this.rebuildGraphics());
  private applying: ApplyingOverlay;
  private menu: MenuController;
  private session: Session | null = null;
  private frameInput: InputFrame | null = null;
  private pendingCommands: SimCommand[] = [];
  private lastConditionsSent = -Infinity;
  private renderTime = 0;
  private fleetKey = '';
  private boatsNow: readonly BoatSnapshot[] = [];
  private parityRing: { x: number; z: number }[] = [];
  private starting = false;
  private focus = new Vector3();
  // The boat the player is steering; fleet boats nobody helms follow their autopilots.
  private helmId = 'player';
  private helmBoat: BoatSnapshot | null = null;
  private fleetIds: { id: string; kind: BoatKind }[] = [];
  private survival: SurvivalRun | null = null;
  private telemetry: TelemetryPanel;
  private survivalNotice: HudAlert | null = null;
  private hud: Hud;
  private audio: AudioEngine;
  private samples = new SampleBank(); // the recorded sea and rain loops
  private recordings: Promise<void> | null = null;
  private audioFrames = new AudioFrameBuilder();
  private hudBuilder = new HudModelBuilder();
  private hudMode: HudMode;
  // The light switches (1–5): each on its own, shared by the fleet; signals are per helm boat below.
  private lights = { nav: true, deck: false, cabin: false, extra: false };
  // What startSession has built so far, to clean up if loading is cancelled part-way.
  private building: { host: SimHost; scene?: SeaScene } | null = null;
  private signalOverride: SignalOverride = null; // the helm boat's manual signal
  private signalScratch: Record<LightSignal, boolean> = {
    fishing: false,
    nuc: false,
    anchor: false,
    ram: false,
  };
  private autopilots = new Map<string, FleetAutopilot>(); // chosen in pause → Fleet (default: follow)
  // --- helm feedback: the voyage since the helm boat was last righted, its capsize card, winches ---
  private voyage = new RunStats();
  private helmDown: { sunk: boolean } | null = null; // capsized or sunk, until recovered
  private cameraBeforeCapsize: CameraMode | null = null;
  private survivalBest = false;
  private collisionAlert = new CollisionAlert();
  private collisionDebug = false; // ?debug panel: collision prism wireframes
  private winches = new Map<string, WinchTracker>();

  private constructor(
    renderer: Renderer,
    settings: SettingsStore,
    options: LaunchOptions,
    loading: LoadingManager,
    uiRoot: HTMLElement,
  ) {
    this.renderer = renderer;
    this.settings = settings;
    this.options = options;
    this.loading = loading;
    this.root = uiRoot.parentElement ?? uiRoot;
    const current = settings.get();
    this.input = new InputManager(inputSettingsFrom(current.controls));
    this.rig.setFov(current.graphics.fov);
    this.frames = new FrameRuntime(renderer, current.graphics);
    this.menu = new MenuController(uiRoot, {
      settings,
      storage: this.storage,
      initialSetup: setupFromSearch(window.location.search, defaultSetup(options.scenario)),
    });
    this.hud = new Hud(uiRoot, current.hud);
    this.telemetry = new TelemetryPanel(uiRoot);
    this.audio = new AudioEngine({ settings: current.audio, samples: this.samples });
    this.applying = new ApplyingOverlay(uiRoot);
    this.fps = new FpsCounter(uiRoot, { enabled: current.graphics.showFps, scale: current.hud.scale });
    settings.subscribe((next, previous) => {
      if (next.physics.mode !== previous.physics.mode) {
        const mode = next.physics.mode;
        this.pendingCommands.push({ type: 'setPhysicsMode', mode });
        this.input.setPhysicsMode(mode);
        if (this.session) this.session.choices = { ...this.session.choices, physicsMode: mode };
        // One physics mode: the voyage setup (next voyage, and Continue) follows the setting.
        this.menu.setSetup({ ...this.menu.getSetup(), physicsMode: mode });
        this.menu.updateLastSetup({ physicsMode: mode });
      }
      if (next.physics.dayLength !== previous.physics.dayLength && this.session)
        this.session.clock.timeScale = dayLengthTimeScale(next.physics.dayLength);
      if (next.physics.capsizeAssist !== previous.physics.capsizeAssist) {
        this.pendingCommands.push({ type: 'setCapsizeAssist', enabled: next.physics.capsizeAssist });
      }
      this.audio.applySettings(next.audio);
      if (next.controls !== previous.controls) this.input.updateSettings(inputSettingsFrom(next.controls));
      this.hud.setSettings(next.hud);
      this.fps.setEnabled(next.graphics.showFps);
      this.fps.setScale(next.hud.scale);
      // The setting is only changed from the menu, so it can't wait for the menu to close; H cycles
      // the mode in game without touching the setting.
      if (next.hud.mode !== previous.hud.mode) this.hudMode = next.hud.mode;
    });
    this.hudMode = current.hud.mode;
    // The setup screen starts on the saved physics mode unless the link chose one.
    if (!new URLSearchParams(window.location.search).has('physics')) {
      this.menu.setSetup({ ...this.menu.getSetup(), physicsMode: current.physics.mode });
    }
    this.menu.on('start', (setup) => void this.beginVoyage(setup));
    this.menu.on('resume', () => this.resume());
    this.menu.on('recover', () => {
      this.pendingCommands.push({ type: 'recover', boatId: this.helmId });
      this.resume();
    });
    this.menu.on('quit', () => void this.returnToMainMenu());
    this.menu.on('takeHelm', (id) => this.takeHelm(id));
    this.menu.on('fleetAutopilot', ({ id, mode }) => {
      this.autopilots.set(id, mode);
      this.pendingCommands.push({ type: 'setAutopilot', boatId: id, autopilot: { mode } });
      this.refreshFleetMenu();
    });
    this.menu.on('conditions', (conditions) => this.applyConditions(conditions));
    this.menu.on('fleetAdd', (kind) => this.addFleetBoat(kind));
    this.menu.on('fleetRemove', (id) => this.removeFleetBoat(id));
    this.menu.setSurvivalResults(loadSurvivalBests(this.storage));
    renderer.onResize((width, height) => this.rig.setAspect(width, height));
    settings.subscribe((next, previous) => {
      // Render scale, dynamic resolution, FPS cap and FOV apply live. Post-processing changes
      // rebuild pipelines, so they wait for the player to settle (or leave Settings) and apply
      // behind an overlay; the rest apply at the next voyage (settings/applyMode.ts).
      this.frames.apply(next.graphics);
      this.rig.setFov(next.graphics.fov);
      if (needsRebuild(previous, next)) this.rebuild.schedule();
    });
    this.menu.on('screen', ({ screen, previous }) => {
      if (previous === 'settings' && screen !== 'settings') void this.rebuild.flush();
    });
  }

  static async start(
    root: HTMLElement,
    options: LaunchOptions,
    boot: BootUi,
    loading: LoadingManager,
  ): Promise<App | null> {
    const viewport = document.createElement('div');
    viewport.className = 'viewport';
    const uiRoot = document.createElement('div');
    uiRoot.className = 'ui-root';
    root.append(viewport, uiRoot);

    const settings = new SettingsStore({
      firstRunPreset: suggestInitialPreset({
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        isMobile: /Mobi|Android|iPhone|iPad/.test(navigator.userAgent),
      }),
    });
    if (options.quality) settings.update({ graphics: { preset: options.quality } });

    loading.add({ id: 'webgpu', label: 'Starting WebGPU', kind: 'compile', weight: 1 });
    let renderer: Renderer;
    try {
      renderer = await loading.run(
        'webgpu',
        () =>
          Renderer.create({
            container: viewport,
            renderScale: settings.get().graphics.renderScale,
            gpuTiming: options.debug,
          }),
        { onError: 'throw' },
      );
    } catch (error) {
      boot.hide();
      const reason =
        error instanceof UnsupportedError ? error.message : `WebGPU failed to start: ${String(error)}`;
      showUnsupported(root, reason);
      return null;
    }

    const app = new App(renderer, settings, options, loading, uiRoot);
    // A lost device (driver reset, GPU crash, the OS reclaiming it) ends every pipeline and buffer:
    // say so and offer a reload rather than freezing on the last frame.
    const device = (renderer.three.backend as { device?: GPUDevice | null }).device;
    void device?.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      app.fail(`The graphics device was lost${info.message ? ` (${info.message})` : ''}.`, info);
    });
    // Leaving the page (navigation, reload, closing the tab): release the GPU now, so the next page
    // load doesn't wait seconds for this one's pipelines and buffers to be torn down. A page
    // restored from the back/forward cache has no renderer left, so it reloads.
    window.addEventListener('pagehide', () => app.dispose());
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && app.disposed) window.location.reload();
    });
    // The recorded sea and rain download alongside the first scene.
    const recordings = app.loadRecordings(loading);
    try {
      if (options.skipMenu) {
        // The whole setup from the link: survival mode, custom weather, sea and loading too.
        await app.startSession(app.menu.getSetup(), false);
      } else {
        await app.startSession(menuBackground(), true);
        app.menu.showMain();
        app.preloadMenuModels();
      }
    } catch (error) {
      boot.hide();
      app.fail(`Sea State could not start: ${errorText(error)}`, error);
      return null;
    }
    attachInputListeners(app.input, {
      target: renderer.canvas,
      pointerLockOnClick: true,
      onPointerLockLost: () => {
        if (app.rig.mode === 'helm' && !app.menu.isOpen) app.pause();
      },
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) app.pause();
      app.settings.flush();
    });
    if (options.debug) {
      await app.installDebugPanel();
      // Console handle for poking at the running game (cameras, sessions) while debugging.
      (window as unknown as { seaState?: App }).seaState = app;
    }
    await recordings;
    loading.finish();
    app.run();
    boot.hide();
    return app;
  }

  // Loads the recorded ambience once; failures leave it synthesized.
  private loadRecordings(loading: LoadingManager | null): Promise<void> {
    this.recordings ??= loadRecordings(this.samples, loading)
      .then((count) => {
        if (count > 0) this.audio.refreshRecordings();
      })
      .catch((error: unknown) => {
        console.warn('Sea and rain recordings unavailable; the ambience stays synthesized.', error);
        this.recordings = null;
      });
    return this.recordings;
  }

  private run(): void {
    const frame = (now: number): void => {
      if (this.disposed) return;
      requestAnimationFrame(frame);
      if (this.warming || !this.frames.shouldRender(now)) return;
      this.session?.loop.tick(now);
      this.frames.afterFrame(now);
      // Shown in play with any HUD mode; menus, the main-menu backdrop and photo mode hide it.
      const session = this.session;
      this.fps.frame(now, !!session && !session.background && !this.menu.isOpen && !this.rig.isPhoto);
    };
    requestAnimationFrame(frame);
  }

  // Builds a fresh simulation + scene for these choices, replacing any current session.
  private async startSession(choices: ScenarioChoices, background: boolean, fromMenu = false): Promise<void> {
    // The new scene is built with the current settings: no rebuild of the old one.
    this.rebuild.cancel();
    await this.rebuild.idle();
    this.session?.host.dispose();
    this.session?.scene.dispose();
    this.session = null;
    this.audio.reset();
    // A voyage's physics mode (picked in its setup) becomes the setting, so Settings shows what runs.
    if (!background) this.settings.set('physics.mode', choices.physicsMode);
    const loading = this.loading;
    loading.addAll([
      { id: 'sim', label: 'Starting the simulation', kind: 'compute', weight: 1 },
      { id: 'stars', label: 'Charting the stars', kind: 'download', weight: 0.5, bytes: 92_000 },
      { id: 'shaders', label: 'Compiling ocean and sky shaders', kind: 'compile', weight: 2 },
      { id: 'warmup', label: 'Warming up the boats and shadows', kind: 'warmup', weight: 2 },
    ]);
    const { graphics, physics } = this.settings.get();
    const host: SimHost = this.options.simLocal ? new LocalSimHost() : new WorkerSimHost();
    this.building = { host };
    const config = simConfigFor(choices, { ...graphics.visualDetailCascades }, physics.capsizeAssist);
    await loading.run('sim', () => host.init(config));
    // GLB models listed in the asset manifest replace procedural ones; the procedural ones get
    // surface-detail textures (Medium quality and up), and a jet ski its skinned rider.
    const kinds = [choices.playerBoat, ...choices.fleet];
    await Promise.all([
      preloadBoatModels(kinds, this.renderer.three, loading),
      preloadBoatDetail(kinds, graphics.preset, this.renderer.three, loading),
      preloadRider(kinds, this.renderer.three, loading),
    ]);
    // Every procedural model the voyage starts with (AO bakes in workers), not inside a frame.
    await loading.run({ id: 'boats', label: 'Building the boats', kind: 'compute', weight: 1.5 }, (task) =>
      prepareBoatModels(
        kinds.map((kind) => {
          const load = loadFor(kind, choices);
          return { kind, variant: { crabPots: load?.crabPots, ballast: load?.cargo === 'ballast' } };
        }),
        (done, total) => task.progress(done / total),
      ),
    );
    if (!host.spectrum) throw new Error('The simulation started without an ocean spectrum');

    const region = getRegion(choices.region);
    const look = sceneGraphicsFor(graphics);
    const scene = new SeaScene(this.renderer.three, {
      spectrum: host.spectrum,
      quality: look.quality,
      shadows: { enabled: true, ...look.shadows, maxFar: 600 },
      seed: choices.seed,
      latitudeDeg: region.latitudeDeg,
      longitudeDeg: region.longitudeDeg,
      water: region.water,
      post: look.post,
      clouds: look.clouds,
      clipmapRings: look.clipmapRings,
      particleBudget: look.particleBudget,
      sailCloth: look.sailCloth,
    });
    this.building = { host, scene };
    if (this.options.contrail && !background) scene.contrails.requestForce();
    const clock = new SimClock({
      date: choices.date,
      timeOfDay: choices.timeOfDay,
      longitude: region.longitudeDeg * DEG,
      timeScale: dayLengthTimeScale(this.settings.get().physics.dayLength),
    });
    await loading.run('stars', async () => {
      try {
        await scene.loadStars(`${import.meta.env.BASE_URL}data/stars.bin.gz`);
      } catch (error) {
        console.warn('Star catalogue unavailable; using the procedural star field.', error);
      }
    });
    host.onSnapshot((snapshot) => {
      if (snapshot.wakes?.length) scene.setWakeGrids(snapshot.wakes);
      if (snapshot.events.length === 0) return;
      scene.handleEvents(snapshot.events, snapshot.boats);
      this.audio.handleSimEvents(snapshot.events);
      this.helmEvents(snapshot.events, snapshot.boats);
    });
    scene.onThunder((event) => {
      this.audio.thunder(event);
      const eye = this.rig.camera.position;
      this.hudBuilder.addThunder(Math.hypot(event.x - eye.x, event.z - eye.z));
    });
    const loop = new GameLoop(host, {
      collectControls: () => this.collectControls(),
      collectCommands: () => this.collectCommands(),
      collectProbes: () => this.collectProbes(),
      render: (frame) => this.renderFrame(frame),
    });
    this.helmId = 'player';
    this.autopilots.clear();
    const setup = choices as Partial<ScenarioSetup>;
    this.survival =
      !background && setup.mode === 'storm-survival' && setup.weather
        ? new SurvivalRun(choices.playerBoat, setup.weather)
        : null;
    this.survivalNotice = null;
    this.resetHelmFeedback();
    this.winches.clear();
    const weather = sceneWeatherFor(choices);
    const spectrum = host.spectrum;
    const session: Session = {
      host,
      loop,
      scene,
      clock,
      weather,
      choices,
      playerKind: choices.playerBoat,
      background,
      fromMenu,
      conditions: conditionsFor(choices),
      conditionsDue: false,
      weatherFrom: weather,
      weatherTo: weather,
      weatherAge: 0,
      weatherDuration: 0,
      spectrum,
      seaFrom: seaReadoutOf(spectrum),
      nextFleetIndex: choices.fleet.length + 1,
      pendingSpawns: [],
      post: JSON.stringify(look.post),
      builtPosts: new Set([JSON.stringify(look.post)]),
    };
    this.session = session;
    if (this.collisionDebug) void scene.setCollisionDebug(true);
    this.pendingCommands = [];
    this.fleetKey = '';
    // Weather changes: the GPU sea crossfades to the new spectrum in step with the physics copy.
    host.onSpectrum((next) => {
      if (this.session !== session || next.version <= session.spectrum.version) return;
      session.seaFrom = this.seaReadout(session);
      session.spectrum = next;
      scene.setSpectrum(next);
    });
    this.rig.setBoat(choices.playerBoat);
    // The menu backdrop runs the cinematic auto-director.
    this.rig.setMode(background ? 'cinematic' : (parseCameraMode(choices.camera) ?? 'chase'));
    this.rig.setCinematic(background);
    this.rig.cut();
    this.input.setPhysicsMode(choices.physicsMode);
    this.input.resetHelm();
    // Pipelines are built by real frames behind the loading screen, a part of the scene per frame
    // (app/warmup.ts): sky, ocean and effects, then each boat.
    this.warming = true;
    this.frames.paused = true;
    const warm = beginWarmUp({ scene, boats: kinds.length, tick: (now) => loop.tick(now) });
    try {
      await loading.run('shaders', (task) => warm.scene(task));
      await loading.run('warmup', (task) => warm.boats(task));
    } finally {
      warm.end();
      this.warming = false;
      this.frames.paused = false;
      this.frames.resetTiming();
      loop.resetTiming();
    }
  }

  // While the main menu is up, builds the other boat models (and their detail textures) a few at a
  // time in idle moments, so starting a voyage only compiles shaders. Model geometry takes 20–140 ms
  // of main thread per boat; the AO bakes run in workers.
  private preloadMenuModels(): void {
    // Not the sloop: the backdrop is sailing it (a rebuild would dispose its materials).
    const kinds: BoatKind[] = ['crab', 'powerboat', 'pwc', 'cargo', 'cruise'];
    const idle = (fn: () => void): void => {
      if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 4000 });
      else setTimeout(fn, 250);
    };
    const next = (): void => {
      const kind = kinds.shift();
      if (!kind || !this.session?.background || this.starting) return;
      void loadBoatTemplate(kind)
        .catch(() => null)
        .finally(() => idle(next));
    };
    const graphics = this.settings.get().graphics;
    setTimeout(() => {
      if (!this.session?.background) return;
      preloadBoatDetail(kinds, graphics.preset, this.renderer.three, new LoadingManager())
        .catch(() => undefined)
        .finally(() => idle(next));
    }, 1500);
  }

  private async beginVoyage(setup: ScenarioSetup): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.menu.hide();
    this.loading.reset();
    const screen = LoadingScreen.create(document.body).attach(this.loading);
    try {
      await this.startSession(setup, false, true);
      if (this.options.debug) logDeepLink(setup);
      this.loading.finish();
    } catch (error) {
      this.fail(`The voyage could not start: ${errorText(error)}`, error);
    } finally {
      this.building = null;
      screen.hide();
      this.starting = false;
    }
  }

  // The loading screen covers the rebuild (its progress keeps moving through the warm-up), and a
  // second Quit can't start another one meanwhile.
  private async returnToMainMenu(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.menu.hide();
    this.loading.reset();
    const screen = LoadingScreen.create(document.body).attach(this.loading);
    try {
      await this.startSession(menuBackground(), true);
      this.loading.finish();
    } catch (error) {
      this.fail(`Returning to the main menu failed: ${errorText(error)}`, error);
      return;
    } finally {
      screen.hide();
      this.starting = false;
    }
    this.menu.showMain();
    this.preloadMenuModels();
  }

  // Applies changed post-processing settings (AA, AO, reflections, bloom, lens
  // droplets; a preset's too) in one go: the overlay is painted first, then the change, then the
  // same incremental warm-up as a voyage start rebuilds every pipeline behind it, rather than as
  // stalls once play resumes. The frame-pacing controller sees none of these frames.
  private async rebuildGraphics(): Promise<void> {
    const session = this.session;
    if (!session || this.starting || this.disposed) return;
    const post = postSettingsFrom(this.settings.get().graphics);
    const key = JSON.stringify(post);
    if (key === session.post) return; // changed and changed back
    // From Medium up the scene pass's outputs never change (see planPost), so a post chain built
    // earlier this voyage applies instantly, without the overlay or staged warm-up. A first build
    // can't: SMAA alone takes over a second.
    if (
      session.builtPosts.has(key) &&
      postOnlyChange(session.post, post) &&
      session.scene.qualityTier !== 'low'
    ) {
      session.post = key;
      session.scene.applyPostSettings(post);
      this.frames.resetTiming();
      return;
    }
    const menu = this.menu.element;
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menu.inert = true;
    await this.applying.show();
    this.warming = true;
    this.frames.paused = true;
    try {
      if (this.session !== session || this.disposed) return;
      session.post = key;
      session.builtPosts.add(key);
      session.scene.applyPostSettings(post);
      await warmUp({
        scene: session.scene,
        boats: session.scene.boatCount,
        tick: (now) => {
          if (this.session === session && !this.disposed) session.loop.tick(now);
        },
      });
    } finally {
      this.warming = false;
      this.frames.paused = false;
      this.frames.resetTiming();
      session.loop.resetTiming();
      this.applying.hide();
      menu.inert = false;
      if (focus?.isConnected && !this.menu.element.hidden) focus.focus({ preventScroll: true });
    }
  }

  // Nothing left to play (a session that failed to build, a lost graphics device): release
  // everything and replace the page with the reason and a reload button. A page that is already going
  // away has nobody to tell.
  private fail(reason: string, error: unknown): void {
    console.error(reason, error);
    if (this.disposed) return;
    try {
      this.dispose();
    } catch (disposeError) {
      console.error('Cleaning up after the failure also failed', disposeError);
    }
    showFatalError(this.root, reason);
  }

  // Releases the GPU, the simulation worker and audio (pagehide). Destroying the device ends its
  // work at once instead of leaving the browser to tear it down while the next page starts.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settings.flush();
    this.rebuild.cancel();
    try {
      const session = this.session;
      const built = this.building;
      session?.host.dispose();
      session?.scene.dispose();
      // A session still loading (`building` also keeps the live one after the first load).
      if (built && built.host !== session?.host) {
        built.host.dispose();
        built.scene?.dispose();
      }
      this.session = null;
      this.building = null;
      this.audio.dispose();
    } finally {
      const device = (this.renderer.three.backend as { device?: GPUDevice | null }).device;
      this.renderer.dispose();
      device?.destroy();
    }
  }

  // Take the helm of another boat: the one we leave holds its course and speed.
  private takeHelm(id: string): void {
    const session = this.session;
    const target = this.fleetIds.find((boat) => boat.id === id);
    if (!session || !target || id === this.helmId) return;
    // A sailboat can't hold a course into the wind: it holds its wind angle instead.
    const leaving = this.fleetIds.find((boat) => boat.id === this.helmId);
    const leavingMode = leaving?.kind === 'sail' ? 'windAngle' : 'hold';
    this.autopilots.set(this.helmId, leavingMode);
    this.pendingCommands.push(
      { type: 'setAutopilot', boatId: this.helmId, autopilot: { mode: leavingMode } },
      { type: 'setAutopilot', boatId: id, autopilot: null },
    );
    this.helmId = id;
    this.resetHelmFeedback();
    session.playerKind = target.kind;
    this.rig.setBoat(target.kind);
    this.input.resetHelm();
    this.hudBuilder = new HudModelBuilder();
    this.refreshFleetMenu();
  }

  private cycleHelm(direction: 1 | -1): void {
    if (this.fleetIds.length < 2) return;
    const index = this.fleetIds.findIndex((boat) => boat.id === this.helmId);
    const next = this.fleetIds[(index + direction + this.fleetIds.length) % this.fleetIds.length];
    if (next) this.takeHelm(next.id);
  }

  private refreshFleetMenu(): void {
    this.menu.setFleet(
      this.fleetIds.map((boat) => ({
        id: boat.id,
        kind: boat.kind,
        helm: boat.id === this.helmId,
        autopilot: this.autopilots.get(boat.id) ?? 'follow',
      })),
    );
  }

  // --- Live changes from the pause menu ------------------------------------------------------

  // Conditions screen: weather and sea blend in (sky in real time, sea and wind in sim time); a
  // moved time or date applies at once.
  private applyConditions(conditions: Conditions): void {
    const session = this.session;
    if (!session || session.background) return;
    const previous = session.conditions;
    session.conditions = structuredClone(conditions);
    if (conditions.timeOfDay !== previous.timeOfDay) session.clock.setTimeOfDay(conditions.timeOfDay);
    if (conditions.date !== previous.date) session.clock.setDate(conditions.date);
    session.choices = withConditions(session.choices, conditions);
    if (session.fromMenu) this.menu.updateLastSetup(structuredClone(conditions));
    if (!weatherChanged(previous, conditions)) return;
    session.weatherFrom = session.weather;
    session.weatherTo = sceneWeatherFor(session.choices);
    session.weatherAge = 0;
    session.weatherDuration = CONDITION_TRANSITIONS[session.choices.physicsMode].sky;
    session.conditionsDue = true;
  }

  // The sim rebuilds the spectrum per change, so a dragged slider is throttled.
  private collectCommands(): SimCommand[] {
    const session = this.session;
    const now = performance.now();
    if (session?.conditionsDue && now - this.lastConditionsSent >= CONDITIONS_THROTTLE_MS) {
      session.conditionsDue = false;
      this.lastConditionsSent = now;
      this.pendingCommands.push(conditionsCommand(session.choices, session.choices.physicsMode));
    }
    return this.pendingCommands.splice(0);
  }

  // Hs and Tp for the HUD and audio, and the foam's wind, following the sea's crossfade to the newest
  // spectrum in simulation time.
  private seaReadout(session: Session): SeaReadout {
    return blendSeaReadout(session.seaFrom, session.spectrum, this.renderTime);
  }

  // Fleet screen: a new boat joins abeam of the helm boat, outboard of the line, and keeps station
  // on it by autopilot (sim/world/SimWorld), so the line is measured from it.
  private addFleetBoat(kind: BoatKind): void {
    const session = this.session;
    if (!session || session.background) return;
    const boats = this.boatsNow;
    if (boats.length + session.pendingSpawns.length >= MAX_FLEET + 1) return;
    const anchor = boats.find((boat) => boat.id === this.helmId);
    if (!anchor) return;
    const pose = (boat: BoatSnapshot): FleetPose => ({
      kind: boat.kind,
      x: boat.position.x,
      z: boat.position.z,
      heading: attitudeFromQuat(boat.orientation).heading,
    });
    const others = [...boats.filter((boat) => boat !== anchor).map(pose), ...session.pendingSpawns];
    const spawn = joiningSpawn(
      `fleet-${session.nextFleetIndex++}`,
      kind,
      pose(anchor),
      others,
      loadFor(kind, session.choices),
      windFor(session.choices),
    );
    session.pendingSpawns.push(spawn);
    this.pendingCommands.push({ type: 'spawnBoat', spawn, leaderId: anchor.id });
  }

  private removeFleetBoat(id: string): void {
    const session = this.session;
    // The helm boat stays (the menu disables its Remove button too).
    if (!session || session.background || id === this.helmId) return;
    if (!this.fleetIds.some((boat) => boat.id === id)) return;
    this.pendingCommands.push({ type: 'removeBoat', boatId: id });
  }

  // The visible fleet changed (a boat joined or left): menus follow.
  private fleetChanged(session: Session, boats: readonly BoatSnapshot[]): void {
    const key = boats.map((boat) => boat.id).join(',');
    if (key === this.fleetKey) return;
    this.fleetKey = key;
    session.pendingSpawns = session.pendingSpawns.filter(
      (spawn) => !boats.some((boat) => boat.id === spawn.id),
    );
    this.refreshFleetMenu();
  }

  private pause(): void {
    const session = this.session;
    if (!session || session.background || this.menu.isOpen) return;
    session.loop.paused = true;
    this.refreshFleetMenu();
    // The Conditions screen starts from the clock as it is now, not as the voyage began.
    session.conditions = {
      ...session.conditions,
      timeOfDay: session.clock.localSolarHours,
      date: formatIsoDate(session.clock.date),
    };
    this.menu.setConditions(session.conditions);
    this.menu.showPause({ helmDown: this.helmDown !== null });
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private resume(): void {
    this.menu.hide();
    if (this.session) {
      this.session.loop.paused = false;
      this.session.loop.resetTiming();
    }
  }

  private collectControls(): Record<string, BoatControls> {
    const session = this.session;
    const dt = session?.loop.lastRealDt ?? 1 / 60;
    if (this.menu.isOpen || !session) {
      const frame = this.input.poll(dt, 'menu');
      this.frameInput = frame;
      // Not while graphics settings apply: the menu is inert behind the overlay.
      if (!this.applying.visible) this.menu.update(frame.menu, dt);
      return { [this.helmId]: neutralControls() };
    }
    // Photo mode: WASD flies the camera while the boat sails on hands-off.
    const helm = contextForBoat(session.playerKind);
    const frame = this.input.poll(dt, this.rig.isPhoto ? 'photo' : helm, helm);
    this.frameInput = frame;
    this.handleActions(frame);
    return { [this.helmId]: frame.controls };
  }

  private handleActions(frame: InputFrame): void {
    const triggered = frame.triggered;
    if (triggered.has('pause')) this.pause();
    if (triggered.has('help')) {
      this.pause();
      this.menu.open('help');
    }
    if (triggered.has('perf')) this.perf.toggle();
    if (triggered.has('telemetry'))
      this.settings.set('physics.telemetryPanel', this.telemetryVisible() ? 'off' : 'on');
    const boatId = this.helmId;
    if (triggered.has('recover')) this.pendingCommands.push({ type: 'recover', boatId });
    if (triggered.has('reefIn')) this.pendingCommands.push({ type: 'reef', boatId, delta: 1 });
    if (triggered.has('reefOut')) this.pendingCommands.push({ type: 'reef', boatId, delta: -1 });
    if (triggered.has('furl')) this.pendingCommands.push({ type: 'furl', boatId });
    if (triggered.has('autoTrim')) {
      const on = (this.helmBoat?.telemetry['sail.autoTrim'] ?? 0) > 0.5;
      this.pendingCommands.push({ type: 'autoTrim', boatId, enabled: !on });
    }
    if (triggered.has('nextBoat')) this.cycleHelm(1);
    if (triggered.has('prevBoat')) this.cycleHelm(-1);
    if (triggered.has('hud')) this.hudMode = this.hud.cycleMode();
    if (triggered.has('signals')) this.signalOverride = nextSignalOverride(this.signalOverride);
    if (triggered.has('navLights')) this.lights = { ...this.lights, nav: !this.lights.nav };
    if (triggered.has('deckLights')) this.lights = { ...this.lights, deck: !this.lights.deck };
    if (triggered.has('cabinLights')) this.lights = { ...this.lights, cabin: !this.lights.cabin };
    if (triggered.has('extraLights')) this.lights = { ...this.lights, extra: !this.lights.extra };
    const clock = this.session?.clock;
    if (clock) {
      if (triggered.has('timeEarlier')) clock.addSeconds(-30 * 60);
      if (triggered.has('timeLater')) clock.addSeconds(30 * 60);
      if (triggered.has('timeScale')) {
        // The chosen day length, then fast-forward.
        const scales = [dayLengthTimeScale(this.settings.get().physics.dayLength), 600, 3600];
        clock.timeScale = scales[(scales.indexOf(clock.timeScale) + 1) % scales.length] ?? 1;
      }
    }
  }

  // Probe 0 is the water under the camera, for the external-camera clamp; with ?parity a ring of
  // probes around the player follows.
  private collectProbes(): Float64Array {
    const camera = this.rig.camera.position;
    if (!this.options.parity) return new Float64Array([camera.x, camera.z]);
    this.parityRing = [];
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      const radius = 6 + (i % 3) * 7;
      this.parityRing.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });
    }
    return new Float64Array([camera.x, camera.z, ...this.parityRing.flatMap((p) => [p.x, p.z])]);
  }

  private renderFrame(frame: FrameInfo): void {
    const session = this.session;
    if (!session) return;
    const bracket = frame.snapshots.bracket(frame.renderTime);
    if (!bracket) return;
    const boats = interpolateBoats(bracket);
    const player = boats.find((boat) => boat.id === this.helmId) ?? boats[0];
    this.helmBoat = player ?? null;
    this.fleetIds = boats.map((boat) => ({ id: boat.id, kind: boat.kind }));
    this.boatsNow = boats;
    this.renderTime = frame.renderTime;
    this.fleetChanged(session, boats);
    // The sky follows a live weather change in real time, so it moves behind the pause menu too.
    if (session.weatherAge < session.weatherDuration) {
      session.weatherAge += frame.realDt;
      const w = smoothstep(session.weatherAge / session.weatherDuration);
      session.weather = blendSceneWeather(session.weatherFrom, session.weatherTo, w);
    }
    const sea = this.seaReadout(session);
    const latest = frame.snapshots.latest;
    const waterHeight = latest?.probes[0] ?? 0;
    if (this.options.parity && latest) {
      session.scene.showParity(
        this.parityRing.map((point, i) => ({
          x: point.x,
          y: latest.probes[(i + 1) * PROBE_STRIDE] ?? 0,
          z: point.z,
        })),
      );
    }
    const cameraInput = this.menu.isOpen ? null : (this.frameInput?.camera ?? null);
    this.rig.setSeaState(sea.hs);
    if (player) this.rig.update(frame.realDt, player, cameraInput, waterHeight, boats);
    session.loop.timeScale = this.rig.timeScale;
    session.scene.setDof(this.rig.dof); // photo mode's depth of field, if the post pipeline has it
    if (!session.loop.paused) session.clock.advance(frame.realDt);
    if (player) this.focus.set(player.position.x, player.position.y, player.position.z);
    session.scene.update({
      camera: this.rig.camera,
      boats,
      time: frame.renderTime,
      dt: frame.realDt * session.loop.timeScale,
      clock: session.clock,
      weather: session.weather,
      seaWind: foamWindVelocity(sea),
      focus: this.focus,
      cameraWaterHeight: waterHeight,
      seaHs: sea.hs,
      cameraMode: this.rig.mode,
      lights: {
        helmId: this.helmId,
        state: {
          nav: this.lights.nav,
          deck: this.lights.deck,
          extra: this.lights.extra,
          cabin: this.lights.cabin,
        },
        signals: (boat) => this.signalSet(boat),
      },
    });
    session.scene.render(this.rig.camera, frame.renderTime);
    this.updateHud(session, boats, frame.realDt, sea);
    this.audio.update(
      frame.realDt,
      this.audioFrames.build({
        camera: this.rig.camera,
        cameraMode: this.rig.mode,
        playerKind: session.playerKind,
        waterHeight,
        choices: session.choices,
        weather: session.weather,
        hs: sea.hs,
        tp: sea.tp,
        boats,
        simTime: frame.renderTime,
        aircraft: session.scene.contrails.aircraft,
      }),
    );
    this.audio.horn(this.helmId, !this.menu.isOpen && (this.frameInput?.held.has('horn') ?? false));
    if (!session.loop.paused) this.trackHelm(boats, frame.realDt);
    this.perf.frame({
      simStepMs: session.loop.simStepMs,
      simSteps: session.loop.simSteps,
      gpuMs: this.frames.gpuMs,
      renderInfo: this.renderer.three.info.render,
      resolution: {
        scale: this.frames.renderScale,
        width: this.renderer.three.domElement.width,
        height: this.renderer.three.domElement.height,
        dynamic: this.settings.get().graphics.dynamicResolution,
      },
    });
  }

  private updateHud(
    session: Session,
    boats: Parameters<HudModelBuilder['build']>[0]['boats'],
    dt: number,
    sea: { hs: number; tp: number },
  ): void {
    const visible = !this.menu.isOpen && !session.background && !this.rig.isPhoto;
    this.hud.setMode(visible ? this.hudMode : 'off');
    if (!visible) {
      // Menus and the main-menu backdrop hide the instrument panels too.
      this.telemetry.setVisible(false);
      return;
    }
    const region = getRegion(session.choices.region);
    const model = this.hudBuilder.build({
      boats,
      playerId: this.helmId,
      dt,
      choices: session.choices,
      spectrum: { ...session.spectrum, significantHeight: sea.hs, peakPeriod: sea.tp },
      clock: session.clock,
      latitudeDeg: region.latitudeDeg,
      longitudeDeg: region.longitudeDeg,
      camera: this.rig.modeLabel,
      device: this.input.lastDevice,
      lights: { ...this.lights, signals: this.helmBoat ? this.signalsFor(this.helmBoat) : [] },
      alerts: [...boatModelNotices(), ...this.survivalAlerts(boats, dt, session), ...this.feedbackAlerts(dt)],
      units: this.settings.get().hud.units,
    });
    if (model) {
      model.capsize = this.capsizeCardModel();
      // The capsize card says it all: drop the alerts that repeat it.
      if (model.capsize) model.alerts = model.alerts.filter((a) => !CARD_COVERS.has(a.id));
      this.hud.update(model, dt);
    }
    this.telemetry.setVisible(visible && this.telemetryVisible());
    if (this.helmBoat) this.telemetry.update(dt, this.helmBoat.kind, this.helmBoat.telemetry);
  }

  // The boat's signals as the scene's light switches, in one object reused for every boat (the
  // lights copy it).
  private signalSet(boat: BoatSnapshot): Partial<Record<LightSignal, boolean>> {
    const set = this.signalScratch;
    set.fishing = set.nuc = set.anchor = set.ram = false;
    for (const signal of this.signalsFor(boat)) set[signal] = true;
    return set;
  }

  private signalsFor(boat: BoatSnapshot): LightSignal[] {
    const v = boat.velocity;
    const input = {
      kind: boat.kind,
      speed: Math.hypot(v.x, v.z),
      telemetry: boat.telemetry,
      deckLights: this.lights.deck,
    };
    return signalsWithOverride(input, boat.id === this.helmId ? this.signalOverride : null);
  }

  // The engineering panel: off unless the setting (or G, which flips it) turns it on.
  private telemetryVisible(): boolean {
    return this.settings.get().physics.telemetryPanel === 'on';
  }

  // Storm Survival bookkeeping, reported through the HUD's alert strip.
  private survivalAlerts(boats: readonly BoatSnapshot[], dt: number, session: Session): HudAlert[] {
    const run = this.survival;
    if (!run) return [];
    const boat = boats.find((b) => b.id === this.helmId);
    if (boat && !session.loop.paused && !run.finished) {
      const ended = run.sample({
        dt,
        roll: attitudeFromQuat(boat.orientation).roll,
        deckWater: boat.telemetry['deckWater'] ?? 0,
        capsized: (boat.telemetry['capsized'] ?? 0) > 0.5,
      });
      if (ended) {
        const result = run.result();
        const { bests, isBest } = recordSurvival(this.storage, result);
        this.survivalBest = isBest;
        this.menu.setSurvivalResults(bests);
        this.survivalNotice = {
          id: 'survival-result',
          severity: 'info',
          text: `Storm Survival over${isBest ? ' — new best!' : ''}`,
          detail: `${formatDuration(result.survivedS)} afloat · max roll ${result.maxRollDeg}°`,
        };
      }
    }
    if (this.survivalNotice) return [this.survivalNotice];
    // The start, briefly (info alerts fade after a few seconds); the capsize card has the score.
    return [
      {
        id: 'survival-start',
        severity: 'info',
        text: 'Storm Survival',
        detail: 'Stay upright as long as you can',
      },
    ];
  }

  // --- helm feedback ------------------------------------------------------------------------

  private resetHelmFeedback(): void {
    this.voyage = new RunStats();
    this.helmDown = null;
    this.cameraBeforeCapsize = null;
    this.survivalBest = false;
    this.collisionAlert = new CollisionAlert();
  }

  private rumble(r: Rumble | null): void {
    if (r && !this.menu.isOpen) this.input.rumble(r.strong, r.weak, r.ms);
  }

  // Sim events that concern the boat at the helm: slams and collisions count, buzz the pad and warn;
  // a capsize cuts to an outside view of the roll with the voyage's card; recovering puts it back.
  private helmEvents(events: readonly SimEvent[], boats: readonly BoatSnapshot[]): void {
    const helm = this.helmId;
    for (const event of events) {
      switch (event.type) {
        case 'slam':
          if (event.boatId !== helm) break;
          this.hudBuilder.addSlam();
          this.survival?.addSlam();
          if (!this.helmDown) this.voyage.addSlam();
          this.rumble(rumbleForSlam(event.strength));
          break;
        case 'collision': {
          if (event.boatId !== helm && event.otherId !== helm) break;
          const otherId = event.boatId === helm ? event.otherId : event.boatId;
          const other = boats.find((boat) => boat.id === otherId);
          this.collisionAlert.hit(
            other ? BOAT_CARDS[other.kind].name : 'another boat',
            event.speed,
            this.settings.get().hud.units.speed,
          );
          this.rumble(rumbleForCollision(event.speed));
          break;
        }
        case 'capsized':
        case 'sunk':
          if (event.boatId !== helm) break;
          this.helmDown = { sunk: event.type === 'sunk' || (this.helmDown?.sunk ?? false) };
          if (this.cameraBeforeCapsize === null && !this.session?.background) {
            this.cameraBeforeCapsize = this.rig.mode;
            this.rig.setMode('orbit');
            this.rig.cut();
          }
          break;
        case 'recovered':
          if (event.boatId !== helm) break;
          if (this.cameraBeforeCapsize !== null) {
            this.rig.setMode(this.cameraBeforeCapsize);
            this.rig.cut();
          }
          this.resetHelmFeedback();
          break;
      }
    }
  }

  // Voyage stats for the capsize card, and winch clicks for every sailboat in the fleet.
  private trackHelm(boats: readonly BoatSnapshot[], dt: number): void {
    const helm = this.helmBoat;
    if (helm && !this.helmDown) {
      this.voyage.track({
        dt,
        roll: attitudeFromQuat(helm.orientation).roll,
        deckWater: helm.telemetry['deckWater'] ?? 0,
        capsized: false,
      });
    }
    for (const boat of boats) {
      if (boat.kind !== 'sail') continue;
      let winch = this.winches.get(boat.id);
      if (!winch) this.winches.set(boat.id, (winch = new WinchTracker()));
      const clicks = winch.update(boat.telemetry, dt);
      if (clicks > 0) this.audio.winch(boat.id, clicks);
    }
    if (this.winches.size > boats.length) {
      for (const id of this.winches.keys())
        if (!boats.some((boat) => boat.id === id)) this.winches.delete(id);
    }
  }

  private feedbackAlerts(dt: number): HudAlert[] {
    const collision = this.collisionAlert.update(dt);
    return collision ? [collision] : [];
  }

  private capsizeCardModel(): CapsizeCardModel | null {
    const down = this.helmDown;
    if (!down) return null;
    const run = this.survival;
    return capsizeCard(run ?? this.voyage, {
      device: this.input.lastDevice,
      sunk: down.sunk,
      survival: run ? { isBest: this.survivalBest } : undefined,
    });
  }

  // Debug (console, the panel's button, or ?contrail at start): a jet passing almost overhead, its
  // contrail already stretching back across the sky.
  forceContrail(): void {
    this.session?.scene.contrails.requestForce();
  }

  private async installDebugPanel(): Promise<void> {
    const { GUI } = await import('three/addons/libs/lil-gui.module.min.js');
    const gui = new GUI({ title: 'Sea State debug' });
    const stats = { simTime: 0, stepMs: 0, camera: '' };
    gui.add(stats, 'simTime').listen().disable();
    gui.add(stats, 'stepMs').listen().disable();
    gui.add(stats, 'camera').listen().disable();
    const view = { collisionShapes: this.collisionDebug };
    gui
      .add(view, 'collisionShapes')
      .name('collision shapes')
      .onChange((on: boolean) => {
        this.collisionDebug = on;
        void this.session?.scene.setCollisionDebug(on);
      });
    gui.add({ contrail: () => this.forceContrail() }, 'contrail').name('jet contrail overhead');
    setInterval(() => {
      const loop = this.session?.loop;
      stats.simTime = Math.round((loop?.simTime ?? 0) * 100) / 100;
      stats.stepMs = Math.round((loop?.simStepMs ?? 0) * 1000) / 1000;
      stats.camera = this.rig.modeLabel;
    }, 250);
  }
}
