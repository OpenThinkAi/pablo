// Public surface of the screen package. The CLI imports this lazily, only when bare `pablo` opens the screen.

export { runScreen } from "./screen";
export type { ScreenOptions } from "./screen";
