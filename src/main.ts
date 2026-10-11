import './style.css';
import { setupCounter } from './counter';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Missing #app element in index.html');
}

app.innerHTML = `
  <main>
    <h1>viteplus-starter</h1>
    <p>Edit <code>src/main.ts</code> and save to test HMR.</p>
    <button type="button" id="counter"></button>
  </main>
`;

setupCounter(app.querySelector<HTMLButtonElement>('#counter')!);
