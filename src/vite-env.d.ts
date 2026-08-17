/// <reference types="vite/client" />

declare module "canvas-confetti" {
  type Options = {
    angle?: number;
    origin?: { x?: number; y?: number };
    particleCount?: number;
    scalar?: number;
    spread?: number;
    startVelocity?: number;
    ticks?: number;
    colors?: string[];
  };

  export default function confetti(options?: Options): Promise<null> | null;
}
