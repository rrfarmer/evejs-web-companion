import { MathUtils, Vector3 } from "three";
import type { SpaceVector } from "../store/types.ts";

interface Celestial {
  itemID: number;
  kind: string;
  typeID: number | null;
  radius: number;
  position: SpaceVector;
}

interface Crossing {
  id: number;
  center: number;
  halfChord: number;
  small: boolean;
}

const SMALL_SUNS = new Set([3801, 3799, 45038, 3802, 45041, 3803, 45042]);
const FLASH_SPAN = 2_000_000;
export interface WarpPlanetFade {
  body: number | null;
  entering: number;
  leaving: number;
  brightness: number;
  tint: number;
}
const EMPTY: WarpPlanetFade = { body: null, entering: 0, leaving: 0, brightness: 0.6, tint: 0 };

/** The legacy warp graph runs its fades on distance along the flight path, in 10 km units. */
export class WarpPlanetCrossings {
  private shipID: number | null = null;
  private readonly source = new Vector3();
  private readonly destination = new Vector3();
  private readonly axis = new Vector3();
  private crossings: Crossing[] = [];

  sample(ship: { itemID: number; position: SpaceVector } | null, destination: SpaceVector | null,
    entities: readonly Celestial[], intensity: number, warpMultiplier: number): WarpPlanetFade {
    if (!ship || !destination) {
      this.shipID = null;
      return EMPTY;
    }
    if (this.shipID !== ship.itemID || this.destination.x !== destination.x ||
        this.destination.y !== destination.y || this.destination.z !== destination.z) {
      this.plan(ship, destination, entities);
    }
    if (!this.crossings.length) return EMPTY;
    const { x, y, z } = ship.position;
    const traveled = (x - this.source.x) * this.axis.x + (y - this.source.y) * this.axis.y + (z - this.source.z) * this.axis.z;
    // Warp.py's _fadeLength binding uses 3 * 80,000 * the hull multiplier and the speed curve's output.
    const length = 800_000_000 * 3 * warpMultiplier * intensity + 1_000;
    for (const crossing of this.crossings) {
      const entry = crossing.center - crossing.halfChord;
      const exit = crossing.center + (crossing.small ? 1.1 : crossing.halfChord);
      if (traveled > exit + Math.max(2 * FLASH_SPAN, length / 4)) continue;
      const a = MathUtils.clamp((traveled - entry) / (length / 6) + 1, 0, 1);
      const b = MathUtils.clamp((traveled - exit) / (length / 4), 0, 1);
      // The expression keys' adjoining Hermite tangents are 2. Trinity uses them directly.
      const entering = a * a, leaving = b * (2 - b);
      const q = MathUtils.smoothstep(traveled, entry - FLASH_SPAN, entry);
      const r = MathUtils.smoothstep(traveled, entry, entry + FLASH_SPAN);
      const s = MathUtils.smoothstep(traveled, exit - FLASH_SPAN, exit);
      const t = MathUtils.smoothstep(traveled, exit, exit + FLASH_SPAN);
      const brightness = 0.6 - 0.3 * q + 0.5 * r - 0.3 * s + 0.1 * t;
      const warmUp = MathUtils.clamp(1 + (traveled - entry) / 3_000_000, 0, 1);
      const coolDown = MathUtils.clamp((exit + 4_000_000 - traveled) / 6_000_000, 0, 1);
      const tint = Math.min(warmUp * warmUp, coolDown * coolDown);
      return { body: traveled >= entry && traveled < exit ? crossing.id : null, entering, leaving, brightness, tint };
    }
    return EMPTY;
  }

  private plan(ship: { itemID: number; position: SpaceVector }, destination: SpaceVector, entities: readonly Celestial[]): void {
    this.shipID = ship.itemID;
    this.source.copy(ship.position);
    this.destination.copy(destination);
    this.axis.subVectors(this.destination, this.source);
    const length = this.axis.length();
    this.axis.normalize();
    const relative = new Vector3();
    this.crossings = [];
    for (const body of entities) {
      if (body.kind !== "planet" && body.kind !== "moon" && body.kind !== "sun") continue;
      relative.subVectors(body.position, this.source);
      const center = relative.dot(this.axis);
      if (center < 0 || relative.lengthSq() > length * length) continue;
      const closest = relative.addScaledVector(this.axis, -center).lengthSq();
      const scale = body.kind !== "sun" ? 1 : SMALL_SUNS.has(body.typeID ?? 0) ? 0.25 : 0.5;
      const radius = body.radius * scale;
      if (closest >= radius * radius) continue;
      const halfChord = 1.1 * Math.sqrt(radius * radius - closest);
      this.crossings.push({ id: body.itemID, center, halfChord, small: body.radius < 450_000 });
    }
    this.crossings.sort((a, b) => a.center - b.center);
  }
}
