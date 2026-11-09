// The BFF's Destiny code, bundled for the browser by the Vite plugin `destiny-for-the-browser`
// (vite.config.ts). Typed loosely: the source is CommonJS with JSDoc, documented where it lives.
declare module "virtual:destiny" {
  export interface Vec3 { x: number; y: number; z: number }
  export interface Ball { id: number | bigint; mode: number; newPos: Vec3; newVel: Vec3; radius: number; [k: string]: unknown }
  export class Ballpark {
    constructor(options?: Record<string, unknown>);
    balls: Map<number | bigint, Ball>;
    ball(id: number | bigint): Ball | undefined;
  }
  export class Park {
    constructor(options?: { ballpark?: Ballpark; [k: string]: unknown });
    ballpark: Ballpark;
    history: unknown[];
    currentTime: number;
    validState: boolean;
    resets: number;
    fatalDesyncs: number;
    failed: Set<string>;
    tick(): void;
    /** Step for every whole tick of the sim clock since the last; returns how many steps were taken. */
    onTick(simTime: number): number;
    fraction(simTime: number): number;
  }
  export const MODE: Record<string, number>;
  export const MODE_NAME: Record<number, string>;
  export function readState(bytes: Uint8Array): unknown;
  export function marshalDecode(bytes: Uint8Array): unknown;
  export function readFeedItem(item: FeedItem, decode: (bytes: Uint8Array) => unknown): { method: string; args: unknown[] };
  export function applyToPark(park: Park, method: string, args: unknown[], guard?: (name: string, fn: () => void) => void): boolean;
  export function rebaseDelta(times: unknown): number | null;
  export interface FeedItem { atMs: number; method: string; inner: string }
}
