// Shown when the browser can't run Sea State, or when the graphics device is lost or a scenario fails
// to build and there is nothing left to play.
export function showUnsupported(root: HTMLElement, reason: string): void {
  root.replaceChildren();
  const panel = document.createElement('section');
  panel.className = 'unsupported';
  panel.innerHTML = `
    <h1>Sea State needs WebGPU</h1>
    <p class="unsupported-reason"></p>
    <p>Try a current version of Chrome or Edge, Safari 26 or later, or Firefox on Windows or Apple Silicon Macs.
    Make sure hardware acceleration is turned on in your browser settings.</p>
  `;
  const reasonElement = panel.querySelector('.unsupported-reason');
  if (reasonElement) reasonElement.textContent = reason;
  root.append(panel);
}

// A fatal problem after startup (device lost, a voyage that failed to build): says what happened and
// offers a reload, instead of leaving a frozen or blank canvas.
export function showFatalError(root: HTMLElement, reason: string): void {
  root.replaceChildren();
  const panel = document.createElement('section');
  panel.className = 'unsupported';
  panel.setAttribute('role', 'alert');
  const title = document.createElement('h1');
  title.textContent = 'Sea State stopped';
  const reasonElement = document.createElement('p');
  reasonElement.className = 'unsupported-reason';
  reasonElement.textContent = reason;
  const advice = document.createElement('p');
  advice.textContent =
    'Reload the page to start again. If it keeps happening, try a lower graphics quality or update your browser and graphics drivers.';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'unsupported-reload';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => window.location.reload());
  panel.append(title, reasonElement, advice, reload);
  root.append(panel);
  reload.focus();
}
