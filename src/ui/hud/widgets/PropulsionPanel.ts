// Helm and propulsion panel (bottom right) for the powered boats. One sub-panel per helm
// class, built on first use: ships (telegraph, shaft RPM, load, rudder, bow thruster), the
// cruise ship's azipods, the centre console's outboards, the jet ski's jet drive and the
// hydroplane's turbine (N1 against the lever's order, propeller rpm, power, wing, rudder, turn g).

import { TELEGRAPH_NOTCHES } from '../../../input/axes';
import { DEG } from '../../../sim/core/conventions';
import { AttrSlot, build, ClassSlot, deg, TextSlot } from '../dom';
import { formatPercent, formatSide } from '../format';
import type {
  HudModel,
  JetPropulsion,
  OutboardPropulsion,
  PodPropulsion,
  PodReadout,
  Propulsion,
  ShipPropulsion,
  TurbinePropulsion,
} from '../model';
import { approach } from '../motion';
import { AngleGauge, CentreBar, LevelBar, Tach, TelegraphView, ThrottleLever } from './instruments';
import { type HudContext, NEEDLE_TAU, type Widget } from './widget';

interface SubPanel<P extends Propulsion> {
  readonly root: HTMLElement;
  readonly key: string; // rebuild when this changes (e.g. a different RPM range)
  write(p: P): void;
  animate(p: P, dt: number): void;
}

function compactLine(root: HTMLElement): TextSlot {
  const el = document.createElement('div');
  el.className = 'pp-compact';
  root.append(el);
  return new TextSlot(el);
}

class ShipPanel implements SubPanel<ShipPropulsion> {
  readonly root: HTMLElement;
  readonly key: string;
  private readonly telegraph = new TelegraphView();
  private readonly tach: Tach;
  private readonly load = new LevelBar('Engine load');
  private readonly thruster = new CentreBar('Bow thruster');
  private readonly rudder: AngleGauge;
  private readonly compact: TextSlot;

  constructor(p: ShipPropulsion) {
    this.key = panelKey(p);
    this.tach = new Tach('Shaft', p.maxRpm);
    this.rudder = new AngleGauge('Rudder', Math.round(p.rudderMax / DEG), true);
    const b = build(
      'pp-sub pp-ship',
      `<div class="pp-cols"><div data-r="left"></div><div class="pp-stack" data-r="right"></div></div>`,
    );
    b.ref('left').append(this.telegraph.root);
    b.ref('right').append(this.tach.root, this.load.root, this.thruster.root);
    b.root.append(this.rudder.root);
    this.root = b.root;
    this.compact = compactLine(this.root);
  }

  write(p: ShipPropulsion): void {
    this.telegraph.write(p.telegraph.notch);
    const dir = Math.abs(p.shaftRpm) < 0.5 ? 'stopped' : p.shaftRpm > 0 ? 'ahead' : 'astern';
    this.tach.write(p.shaftRpm, dir);
    this.load.write(formatPercent(p.engineLoad), p.engineLoad > 0.98);
    this.thruster.write(p.bowThruster, p.thrusterAvailable, 'too fast');
    this.rudder.write(p.rudderAngle, p.rudderOrder);
    const notch = TELEGRAPH_NOTCHES[p.telegraph.notch]?.short ?? '';
    this.compact.set(
      `${notch} · ${Math.round(Math.abs(p.shaftRpm))} rpm · Rudder ${formatSide(p.rudderAngle)}`,
    );
  }

  animate(p: ShipPropulsion, dt: number): void {
    this.telegraph.animate(p.telegraph.lever, p.telegraph.response, dt);
    this.tach.animate(p.shaftRpm, dt);
    this.load.animate(p.engineLoad, dt);
    this.thruster.animate(p.bowThruster, dt);
    this.rudder.animate(p.rudderAngle, p.rudderOrder, dt);
  }
}

// Top-down azipod: the pod swings like a rudder; the arrow shows thrust, reversed astern.
class PodDial {
  readonly root: HTMLElement;
  private readonly pod: AttrSlot;
  private readonly arrow: AttrSlot;
  private readonly arrowClass: ClassSlot;
  private readonly text: TextSlot;
  private angle = 0;
  private thrust = 0;

  constructor(label: string) {
    const b = build(
      'pod',
      `<svg class="pod-svg" viewBox="-50 -50 100 100" aria-hidden="true">
        <circle class="pod-ring" r="44"/>
        <path class="pod-ticks" d="M 0 -44 V -38 M 0 44 V 38 M -44 0 H -38 M 44 0 H 38"/>
        <g data-r="pod">
          <g class="pod-arrow" data-r="arrow"><path d="M 0 -6 V -34 M -7 -26 L 0 -35 L 7 -26"/></g>
          <rect class="pod-body" x="-6" y="-14" width="12" height="30" rx="6"/>
          <path class="pod-strut" d="M -2 -4 H 2"/>
        </g>
      </svg>
      <div class="pod-read"><span class="hud-label">${label}</span><b data-r="txt"></b></div>`,
    );
    this.root = b.root;
    this.pod = new AttrSlot(b.ref('pod'), 'transform');
    const arrowEl = b.ref<SVGElement>('arrow');
    this.arrow = new AttrSlot(arrowEl, 'transform');
    this.arrowClass = new ClassSlot(arrowEl);
    this.text = new TextSlot(b.ref('txt'));
  }

  write(p: PodReadout): void {
    this.text.set(`${formatSide(p.angle)} · ${p.thrust < 0 ? 'R ' : ''}${formatPercent(Math.abs(p.thrust))}`);
  }

  animate(p: PodReadout, dt: number): void {
    this.angle = approach(this.angle, p.angle, dt, NEEDLE_TAU);
    this.thrust = approach(this.thrust, p.thrust, dt, NEEDLE_TAU);
    this.pod.set(`rotate(${deg(this.angle)})`);
    const s = Math.max(0.05, Math.abs(this.thrust));
    this.arrow.set(`scale(1 ${(this.thrust < 0 ? -s : s).toFixed(3)})`);
    this.arrowClass.set(this.thrust < -0.01 ? 'astern' : null);
  }
}

class PodsPanel implements SubPanel<PodPropulsion> {
  readonly root: HTMLElement;
  readonly key: string;
  private readonly telegraph = new TelegraphView();
  private readonly pods: PodDial[];
  private readonly power = new LevelBar('Power');
  private readonly thruster = new CentreBar('Bow thrusters');
  private readonly compact: TextSlot;

  constructor(p: PodPropulsion) {
    this.key = panelKey(p);
    this.pods = p.pods.map(
      (_, i) => new PodDial(p.pods.length === 2 ? (i === 0 ? 'Port pod' : 'Stbd pod') : `Pod ${i + 1}`),
    );
    const b = build(
      'pp-sub pp-pods',
      `<div class="pp-cols"><div data-r="left"></div><div class="pp-stack" data-r="right"><div class="pod-row" data-r="pods"></div></div></div>`,
    );
    b.ref('left').append(this.telegraph.root);
    b.ref('pods').append(...this.pods.map((pod) => pod.root));
    b.ref('right').append(this.power.root, this.thruster.root);
    this.root = b.root;
    this.compact = compactLine(this.root);
  }

  write(p: PodPropulsion): void {
    this.telegraph.write(p.telegraph.notch);
    p.pods.forEach((pod, i) => this.pods[i]?.write(pod));
    this.power.write(formatPercent(p.powerLoad), p.powerLoad > 0.98);
    this.thruster.write(p.bowThruster, p.thrusterAvailable, 'too fast');
    const notch = TELEGRAPH_NOTCHES[p.telegraph.notch]?.short ?? '';
    this.compact.set(`${notch} · Pods ${p.pods.map((pod) => formatSide(pod.angle)).join(' / ')}`);
  }

  animate(p: PodPropulsion, dt: number): void {
    this.telegraph.animate(p.telegraph.lever, p.telegraph.response, dt);
    p.pods.forEach((pod, i) => this.pods[i]?.animate(pod, dt));
    this.power.animate(p.powerLoad, dt);
    this.thruster.animate(p.bowThruster, dt);
  }
}

class OutboardsPanel implements SubPanel<OutboardPropulsion> {
  readonly root: HTMLElement;
  readonly key: string;
  private readonly tachs: Tach[];
  private readonly levers: ThrottleLever[];
  private readonly trim = new LevelBar('Trim', 'pp-trim');
  private readonly steering: AngleGauge;
  private readonly compact: TextSlot;

  constructor(p: OutboardPropulsion) {
    const n = p.engines.length;
    this.key = panelKey(p);
    const name = (i: number): string => (n === 2 ? (i === 0 ? 'Port' : 'Stbd') : `Eng ${i + 1}`);
    this.tachs = p.engines.map((e, i) => new Tach(name(i), e.maxRpm));
    this.levers = p.engines.map((_, i) => new ThrottleLever(name(i)));
    this.steering = new AngleGauge('Steering', Math.round(p.steeringMax / DEG), false);
    const b = build(
      'pp-sub pp-outboards',
      `<div class="pp-tachs" data-r="tachs"></div>
      <div class="pp-cols pp-ob-low"><div class="pp-levers" data-r="levers"></div><div class="pp-stack" data-r="right"></div></div>`,
    );
    b.ref('tachs').append(...this.tachs.map((t) => t.root));
    b.ref('levers').append(...this.levers.map((l) => l.root));
    b.ref('right').append(this.steering.root, this.trim.root);
    this.root = b.root;
    this.compact = compactLine(this.root);
  }

  write(p: OutboardPropulsion): void {
    p.engines.forEach((e, i) => {
      this.tachs[i]?.write(e.rpm);
      this.levers[i]?.write(e.throttle);
    });
    const trim = average(p.engines.map((e) => e.trim));
    this.trim.write(formatPercent(trim));
    this.steering.write(p.steering, null);
    const throttle = average(p.engines.map((e) => e.throttle));
    this.compact.set(
      `Throttle ${formatPercent(throttle)} · ${Math.round(average(p.engines.map((e) => e.rpm)))} rpm · Trim ${formatPercent(trim)}`,
    );
  }

  animate(p: OutboardPropulsion, dt: number): void {
    p.engines.forEach((e, i) => {
      this.tachs[i]?.animate(e.rpm, dt);
      this.levers[i]?.animate(e.throttle, dt);
    });
    this.trim.animate(average(p.engines.map((e) => e.trim)), dt);
    this.steering.animate(p.steering, 0, dt);
  }
}

const BUCKET_LABEL = { ahead: 'Ahead', neutral: 'Neutral', brake: 'Brake', reverse: 'Reverse' } as const;

class JetPanel implements SubPanel<JetPropulsion> {
  readonly root: HTMLElement;
  readonly key: string;
  private readonly tach: Tach;
  private readonly throttle = new LevelBar('Throttle');
  private readonly nozzle: AngleGauge;
  private readonly bucket: TextSlot;
  private readonly bucketClass: ClassSlot;
  private readonly compact: TextSlot;

  constructor(p: JetPropulsion) {
    this.key = panelKey(p);
    this.tach = new Tach('Engine', p.maxRpm);
    this.nozzle = new AngleGauge('Nozzle', Math.round(p.nozzleMax / DEG), false);
    const b = build(
      'pp-sub pp-jet',
      `<div class="pp-cols"><div data-r="left"></div><div class="pp-stack" data-r="right">
        <div class="pp-bucket"><span class="hud-label">Bucket</span><span class="hud-badge" data-r="bucket">Ahead</span></div>
      </div></div>`,
    );
    b.ref('left').append(this.tach.root);
    b.ref('right').prepend(this.throttle.root);
    b.ref('right').append(this.nozzle.root);
    const bucket = b.ref('bucket');
    this.bucket = new TextSlot(bucket);
    this.bucketClass = new ClassSlot(bucket);
    this.root = b.root;
    this.compact = compactLine(this.root);
  }

  write(p: JetPropulsion): void {
    this.tach.write(p.rpm);
    this.throttle.write(formatPercent(p.throttle));
    this.nozzle.write(p.nozzle, null);
    this.bucket.set(BUCKET_LABEL[p.bucket]);
    this.bucketClass.set(
      p.bucket === 'ahead'
        ? 'good'
        : p.bucket === 'neutral'
          ? null
          : p.bucket === 'brake'
            ? 'warn'
            : 'danger',
    );
    this.compact.set(
      `Throttle ${formatPercent(p.throttle)} · ${Math.round(p.rpm)} rpm · ${BUCKET_LABEL[p.bucket]}`,
    );
  }

  animate(p: JetPropulsion, dt: number): void {
    this.tach.animate(p.rpm, dt);
    this.throttle.animate(p.throttle, dt);
    this.nozzle.animate(p.nozzle, 0, dt);
  }
}

// The turbine's state, from N1 against what the lever is asking for (3 % of play either way).
export function turbineState(p: TurbinePropulsion): {
  text: string;
  tone: 'good' | 'warn' | 'danger' | null;
} {
  if (p.killed) return { text: 'Fuel cut', tone: 'danger' };
  if (p.n1Order - p.n1 > 0.03) return { text: 'Spooling up', tone: 'warn' };
  if (p.n1 - p.n1Order > 0.03) return { text: 'Spooling down', tone: null };
  return { text: p.powerLever > 0.01 ? 'On power' : 'Idle', tone: p.powerLever > 0.01 ? 'good' : null };
}

class TurbinePanel implements SubPanel<TurbinePropulsion> {
  readonly root: HTMLElement;
  readonly key: string;
  private readonly n1 = new Tach('N1', 110, { unit: '% N1', order: true });
  private readonly prop: Tach;
  private readonly lever = new ThrottleLever('Lever', 'Idle');
  private readonly power = new LevelBar('Power');
  private readonly wing = new LevelBar('Wing', 'pp-trim');
  private readonly rudder: AngleGauge;
  private readonly state: TextSlot;
  private readonly stateClass: ClassSlot;
  private readonly g: TextSlot;
  private readonly compact: TextSlot;

  constructor(p: TurbinePropulsion) {
    this.key = panelKey(p);
    this.prop = new Tach('Prop', Math.ceil((p.maxRpm * 1.05) / 1000) * 1000);
    this.rudder = new AngleGauge('Rudder', Math.round(p.rudderMax / DEG), false);
    const b = build(
      'pp-sub pp-turbine',
      `<div class="pp-tachs" data-r="tachs"></div>
      <div class="pp-cols pp-ob-low"><div class="pp-levers" data-r="levers"></div><div class="pp-stack" data-r="right">
        <div class="pp-bucket"><span class="hud-label">Turbine</span><span class="hud-badge" data-r="state">Idle</span></div>
        <div class="pp-bucket"><span class="hud-label">Turn</span><b data-r="g">0.0 g</b></div>
      </div></div>`,
    );
    b.ref('tachs').append(this.n1.root, this.prop.root);
    b.ref('levers').append(this.lever.root);
    b.ref('right').prepend(this.rudder.root, this.power.root, this.wing.root);
    const state = b.ref('state');
    this.state = new TextSlot(state);
    this.stateClass = new ClassSlot(state);
    this.g = new TextSlot(b.ref('g'));
    this.root = b.root;
    this.compact = compactLine(this.root);
  }

  write(p: TurbinePropulsion): void {
    this.n1.write(p.n1 * 100);
    this.prop.write(p.propRpm);
    this.lever.write(p.powerLever);
    this.power.write(formatPercent(p.power), p.power > 0.98);
    const wing = `${p.wingAngle > 0.0005 ? '+' : p.wingAngle < -0.0005 ? '−' : ''}${Math.abs(p.wingAngle / DEG).toFixed(1)}°`;
    this.wing.write(wing);
    this.rudder.write(p.rudder, null);
    const state = turbineState(p);
    this.state.set(state.text);
    this.stateClass.set(state.tone);
    this.g.set(`${p.turnG.toFixed(1)} g`);
    this.compact.set(
      `N1 ${Math.round(p.n1 * 100)}% · ${Math.round(p.propRpm)} rpm · Wing ${wing} · ${state.text}`,
    );
  }

  animate(p: TurbinePropulsion, dt: number): void {
    this.n1.animate(p.n1 * 100, dt, p.n1Order * 100);
    this.prop.animate(p.propRpm, dt);
    this.lever.animate(p.powerLever, dt);
    this.power.animate(p.power, dt);
    this.wing.animate(p.wingTrim, dt);
    this.rudder.animate(p.rudder, 0, dt);
  }
}

function average(values: readonly number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

const TITLES: Record<Propulsion['type'], string> = {
  ship: 'Engine & helm',
  pods: 'Azipods & helm',
  outboards: 'Engines & helm',
  jet: 'Jet drive',
  turbine: 'Turbine & helm',
};

export class PropulsionPanel implements Widget {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly title: TextSlot;
  private sub: SubPanel<Propulsion> | null = null;

  constructor() {
    const b = build(
      'hud-panel hud-propulsion',
      `<div class="hud-title" data-r="title"></div><div data-r="body"></div>`,
    );
    this.root = b.root;
    this.body = b.ref('body');
    this.title = new TextSlot(b.ref('title'));
  }

  write(m: HudModel, _ctx: HudContext): void {
    const p = m.propulsion;
    if (!p) return;
    this.ensure(p).write(p);
    this.title.set(TITLES[p.type]);
  }

  animate(m: HudModel, dt: number): void {
    const p = m.propulsion;
    if (p) this.ensure(p).animate(p, dt);
  }

  private ensure(p: Propulsion): SubPanel<Propulsion> {
    const key = panelKey(p);
    if (this.sub?.key === key) return this.sub;
    const sub = createPanel(p);
    this.body.replaceChildren(sub.root);
    this.sub = sub;
    return sub;
  }
}

function panelKey(p: Propulsion): string {
  switch (p.type) {
    case 'ship':
      return `ship:${p.maxRpm}:${p.rudderMax}`;
    case 'pods':
      return `pods:${p.pods.length}`;
    case 'outboards':
      return `ob:${p.engines.length}:${p.engines[0]?.maxRpm ?? 6000}:${p.steeringMax}`;
    case 'jet':
      return `jet:${p.maxRpm}:${p.nozzleMax}`;
    case 'turbine':
      return `turbine:${p.maxRpm}:${p.rudderMax}`;
  }
}

// The sub-panels are typed per propulsion class; the dispatcher only pairs matching ones.
function createPanel(p: Propulsion): SubPanel<Propulsion> {
  switch (p.type) {
    case 'ship':
      return new ShipPanel(p);
    case 'pods':
      return new PodsPanel(p);
    case 'outboards':
      return new OutboardsPanel(p);
    case 'jet':
      return new JetPanel(p);
    case 'turbine':
      return new TurbinePanel(p);
  }
}
