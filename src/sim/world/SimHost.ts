// Main-thread handle on the simulation. The worker host is used in the game;
// the local host runs the same SimWorld in-thread for tests and `?sim=local`.
import type { AdvanceRequest, SimConfig, SimToMain, Snapshot, SpectrumMessage } from './protocol';
import type { SimWorld } from './SimWorld';

export interface SimHost {
  // Resolves once the world exists and its first ocean spectrum is available.
  init(config: SimConfig): Promise<void>;
  // Latest ocean spectrum, for the GPU ocean.
  readonly spectrum: SpectrumMessage | null;
  onSpectrum(listener: (spectrum: SpectrumMessage) => void): void;
  // Fire-and-forget; the resulting snapshot arrives through onSnapshot.
  advance(request: AdvanceRequest): void;
  onSnapshot(listener: (snapshot: Snapshot) => void): void;
  dispose(): void;
}

export class LocalSimHost implements SimHost {
  spectrum: SpectrumMessage | null = null;
  private world: SimWorld | null = null;
  private listeners: ((snapshot: Snapshot) => void)[] = [];
  private spectrumListeners: ((spectrum: SpectrumMessage) => void)[] = [];

  async init(config: SimConfig): Promise<void> {
    // Loaded on demand: the game runs the world in the worker, so the main bundle leaves it out.
    const { SimWorld } = await import('./SimWorld');
    this.world = new SimWorld(config);
    this.takeSpectrum();
  }

  onSpectrum(listener: (spectrum: SpectrumMessage) => void): void {
    this.spectrumListeners.push(listener);
  }

  private takeSpectrum(): void {
    const spectrum = this.world?.spectrum;
    if (!spectrum || !this.world) return;
    this.world.spectrum = null;
    this.spectrum = spectrum;
    for (const listener of this.spectrumListeners) listener(spectrum);
  }

  advance(request: AdvanceRequest): void {
    if (!this.world) return;
    const snapshot = this.world.advance(request);
    this.takeSpectrum();
    for (const listener of this.listeners) listener(snapshot);
  }

  onSnapshot(listener: (snapshot: Snapshot) => void): void {
    this.listeners.push(listener);
  }

  dispose(): void {
    this.world = null;
    this.listeners = [];
    this.spectrumListeners = [];
  }
}

export class WorkerSimHost implements SimHost {
  spectrum: SpectrumMessage | null = null;
  private worker: Worker;
  private listeners: ((snapshot: Snapshot) => void)[] = [];
  private spectrumListeners: ((spectrum: SpectrumMessage) => void)[] = [];
  private ready: Promise<void> | null = null;
  private inFlight = 0;
  private held: AdvanceRequest['commands'] = [];
  private heldSpent: ArrayBuffer[] = []; // spent wake buffers of skipped requests

  constructor() {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
  }

  init(config: SimConfig): Promise<void> {
    this.ready = new Promise((resolve, reject) => {
      // Other messages (the first spectrum) arrive before 'ready', so listen until it does.
      const onMessage = (event: MessageEvent<SimToMain>): void => {
        const message = event.data;
        if (message.type === 'ready') {
          this.worker.removeEventListener('message', onMessage);
          resolve();
        } else if (message.type === 'error') {
          this.worker.removeEventListener('message', onMessage);
          reject(new Error(message.message));
        }
      };
      this.worker.addEventListener('message', onMessage);
      this.worker.addEventListener('error', (event) => reject(new Error(event.message)), { once: true });
    });
    this.worker.addEventListener('message', (event: MessageEvent<SimToMain>) => {
      const message = event.data;
      if (message.type === 'snapshot') {
        this.inFlight = Math.max(0, this.inFlight - 1);
        for (const listener of this.listeners) listener(message);
      } else if (message.type === 'spectrum') {
        this.spectrum = message;
        for (const listener of this.spectrumListeners) listener(message);
      } else if (message.type === 'error') {
        // A failed advance answers with an error instead of a snapshot: it no longer counts as in
        // flight, or a few transient failures would stall the simulation for good.
        this.inFlight = Math.max(0, this.inFlight - 1);
        console.error('[sim worker]', message.message);
      }
    });
    // After start-up, a crash of the worker itself is logged (the init promise has settled by then).
    this.worker.addEventListener('error', (event) => console.error('[sim worker]', event.message));
    this.worker.postMessage({ type: 'init', config });
    return this.ready;
  }

  advance(request: AdvanceRequest): void {
    // If the worker falls behind, skip this request; the next one carries a later target time, and
    // the skipped one's commands (weather, fleet changes) ride along with it.
    if (this.inFlight > 2) {
      this.held.push(...request.commands);
      if (request.spent) this.heldSpent.push(...request.spent);
      return;
    }
    if (this.held.length > 0) {
      request.commands = [...this.held, ...request.commands];
      this.held = [];
    }
    if (this.heldSpent.length > 0) {
      request.spent = request.spent ? [...this.heldSpent, ...request.spent] : this.heldSpent;
      this.heldSpent = [];
    }
    this.inFlight++;
    const transfer: Transferable[] = [request.probes.buffer];
    if (request.spent) for (const buffer of request.spent) transfer.push(buffer);
    this.worker.postMessage(request, transfer);
  }

  onSnapshot(listener: (snapshot: Snapshot) => void): void {
    this.listeners.push(listener);
  }

  onSpectrum(listener: (spectrum: SpectrumMessage) => void): void {
    this.spectrumListeners.push(listener);
  }

  dispose(): void {
    this.worker.terminate();
    // The listeners close over the session (scene, loop): drop them with it.
    this.listeners = [];
    this.spectrumListeners = [];
  }
}
