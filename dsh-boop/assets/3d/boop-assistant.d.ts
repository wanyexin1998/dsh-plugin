export type BoopState = 'idle' | 'listen' | 'think' | 'success' | 'error';
export interface BoopOptions {
  onStateChange?: (state: BoopState) => void;
  onError?: (error: Error) => void;
  fps?: number;
  pixelRatio?: number;
  reducedMotion?: boolean | null;
}
export class BoopAssistant {
  constructor(canvas: HTMLCanvasElement, options?: BoopOptions);
  readonly state: BoopState;
  readonly disposed: boolean;
  readonly elapsed: number;
  load(url: string): Promise<this>;
  parse(buffer: ArrayBuffer): this;
  setState(state: BoopState, options?: { immediate?: boolean }): void;
  setPose(state: BoopState, seconds?: number): void;
  setReducedMotion(value: boolean | null): void;
  setAccessories(value: boolean): void;
  setActive(value: boolean): void;
  setView(yaw?: number, pitch?: number, zoom?: number): void;
  pause(): void;
  play(): void;
  resize(): void;
  render(): void;
  capture(): string;
  dispose(): void;
}
