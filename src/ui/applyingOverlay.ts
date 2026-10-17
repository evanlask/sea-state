// "Applying graphics settings…": covers the game while a graphics change rebuilds its pipelines
// (app/App.rebuildGraphics): an opaque screen in the loading screen's colours over the menus and the
// scene, so the pause reads as deliberate. Styled in menu/menu.css.

export class ApplyingOverlay {
  private readonly element: HTMLElement;

  constructor(parent: HTMLElement) {
    const element = document.createElement('div');
    element.className = 'apply-overlay';
    element.hidden = true;
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    const card = document.createElement('div');
    card.className = 'apply-overlay-card';
    const spinner = document.createElement('div');
    spinner.className = 'apply-overlay-spinner';
    const title = document.createElement('div');
    title.className = 'apply-overlay-title';
    title.textContent = 'Applying graphics settings…';
    const note = document.createElement('div');
    note.className = 'apply-overlay-note';
    note.textContent = 'Rebuilding shaders. This takes a few seconds.';
    card.append(spinner, title, note);
    element.append(card);
    parent.append(element);
    this.element = element;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  // Resolves once the overlay has been painted (two animation frames), so a freeze that follows
  // happens behind it.
  async show(): Promise<void> {
    this.element.hidden = false;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  hide(): void {
    this.element.hidden = true;
  }
}
