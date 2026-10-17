// Bakes boat AO volumes (kit/ao.ts) off the main thread. Pure typed arrays in and out.

import { type AoBakeInput, bakeAoVolume } from './ao';

interface BakeRequest {
  id: number;
  input: AoBakeInput;
}

const scope = self as unknown as Worker;

scope.onmessage = (event: MessageEvent<BakeRequest>): void => {
  const { id, input } = event.data;
  try {
    const data = bakeAoVolume(input);
    scope.postMessage({ id, data }, [data.data.buffer]);
  } catch (error) {
    scope.postMessage({ id, error: String(error) });
  }
};
