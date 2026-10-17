import './styles/base.css';
import { App } from './app/App';
import { LoadingManager } from './app/loading/LoadingManager';
import { parseLaunchOptions } from './app/Scenario';
import { LoadingScreen } from './ui/loading/LoadingScreen';
import { showFatalError } from './ui/unsupported';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Missing #app element in index.html');

const loading = new LoadingManager();
const bootElement = document.querySelector<HTMLElement>('#boot');
// The inline boot screen paints before any JavaScript; the loading screen takes it over seamlessly.
const boot = bootElement
  ? LoadingScreen.adoptBootScreen(bootElement).attach(loading)
  : { setStatus(): void {}, hide(): void {} };

// Anything that escapes App.start (it reports the expected failures itself) would otherwise leave the
// boot screen up for ever.
App.start(root, parseLaunchOptions(window.location.search), boot, loading).catch((error: unknown) => {
  console.error('Sea State failed to start', error);
  boot.hide();
  showFatalError(
    root,
    `Sea State could not start: ${error instanceof Error ? error.message : String(error)}`,
  );
});
