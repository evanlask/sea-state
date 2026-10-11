// Adds two numbers. Here to give the example test something to assert against.
export function add(a: number, b: number): number {
  return a + b;
}

// Wires up a click counter on the given button.
export function setupCounter(button: HTMLButtonElement): void {
  let count = 0;

  const render = () => {
    button.textContent = `count is ${count}`;
  };

  button.addEventListener('click', () => {
    count = add(count, 1);
    render();
  });

  render();
}
