// Web Worker entry point that owns the SimWorld.
import type { MainToSim, SimToMain } from './protocol';
import { SimWorld } from './SimWorld';

let world: SimWorld | null = null;

const post = (message: SimToMain, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(message, transfer);
};

// A new spectrum (start-up, or a weather change) goes out ahead of the snapshot that follows it.
const postSpectrum = (): void => {
  const spectrum = world?.spectrum;
  if (!world || !spectrum) return;
  world.spectrum = null;
  post(
    spectrum,
    spectrum.cascades.map((cascade) => cascade.h0.buffer),
  );
};

self.addEventListener('message', (event: MessageEvent<MainToSim>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'init':
        world = new SimWorld(message.config);
        postSpectrum();
        post({ type: 'ready', time: world.time });
        break;
      case 'advance': {
        if (!world) return;
        const snapshot = world.advance(message);
        postSpectrum();
        const transfer: Transferable[] = [snapshot.probes.buffer];
        for (const grid of snapshot.wakes ?? []) transfer.push(grid.height.buffer);
        post(snapshot, transfer);
        break;
      }
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
});
