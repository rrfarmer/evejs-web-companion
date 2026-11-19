import * as THREE from "three";

interface RadiusBand {
  categoryRangeBegin: number;
  categoryRangeEnd?: number;
  graphicIDs: readonly number[];
}

interface TypeRadiusBand {
  typeCategoryRangeBegin: number;
  typeCategoryRangeEnd?: number;
  graphicIDs: readonly number[];
}

interface AsteroidRule {
  graphicIDs?: readonly number[];
  categories?: { categoryAttribute: string; categoryList: readonly RadiusBand[] };
  typeCategories?: { typeCategoryAttribute: string; typeCategoryList: readonly TypeRadiusBand[] };
  typeIDs?: Record<number, AsteroidRule>;
}

export interface AsteroidRules {
  groups: Record<number, AsteroidRule>;
  typeGraphicIDs: Record<number, number>;
}

export interface AsteroidBall {
  itemID: number;
  typeID: number | null;
  groupID: number | null;
  radius: number;
}

/** The installed group's ordered choices and half-open bands determine the graphic identity. */
export function asteroidGraphic(ball: AsteroidBall, rules: AsteroidRules): number | null {
  const group = ball.groupID === null ? undefined : rules.groups[ball.groupID];
  const own = ball.typeID === null ? undefined : group?.typeIDs?.[ball.typeID];
  const category = own?.categories ?? own?.typeCategories ?? group?.categories;
  let ids: readonly number[] | undefined;
  if (category && "categoryAttribute" in category && category.categoryAttribute.toLowerCase() === "radius") {
    ids = category.categoryList.find(b => ball.radius >= b.categoryRangeBegin && ball.radius < (b.categoryRangeEnd ?? Infinity))?.graphicIDs;
  } else if (category && "typeCategoryAttribute" in category && category.typeCategoryAttribute.toLowerCase() === "radius") {
    ids = category.typeCategoryList.find(b => ball.radius >= b.typeCategoryRangeBegin && ball.radius < (b.typeCategoryRangeEnd ?? Infinity))?.graphicIDs;
  }
  if (!ids?.length) ids = own?.graphicIDs ?? group?.graphicIDs;
  if (ids?.length) return ids[ball.itemID % ids.length] ?? null;
  return ball.typeID === null ? null : rules.typeGraphicIDs[ball.typeID] ?? null;
}

function randomFrom(seed: number): () => number {
  let state = (seed | 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

/** Original irregular rock geometry. The variant ID seeds the shape without carrying an asset. */
export function makeAsteroidGeometry(seed: number, icy = false): THREE.BufferGeometry {
  const random = randomFrom(seed);
  const lobe = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
  const phases = [random() * Math.PI, random() * Math.PI, random() * Math.PI];
  const squash = new THREE.Vector3(0.65 + random() * 0.35, 0.55 + random() * 0.45, 0.65 + random() * 0.35);
  const geometry = new THREE.IcosahedronGeometry(1, 5);
  const positions = geometry.attributes.position!;
  const colors = new Float32Array(positions.count * 3);
  const stone = new THREE.Color(icy ? 0x4e6976 : 0x615a50);
  const mineral = new THREE.Color(icy ? 0xb1d8dc : 0x9d8366);
  const color = new THREE.Color();
  const point = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i).normalize();
    const { x, y, z } = point;
    const strata = Math.sin(13 * (x * 0.31 + y * 0.83 - z * 0.2) + Math.sin(4 * x + 3 * z + phases[0]!) * 1.7);
    const coarse = Math.sin(x * 6.9 + y * 3.7 + phases[0]!) * Math.cos(z * 5.2 - y * 2.5 + phases[1]!);
    const grit = Math.sin(x * 42 - z * 35 + phases[2]!) * Math.cos(y * 40 + z * 14);
    const crater = Math.max(0, (point.dot(lobe) - 0.78) / 0.22);
    const surface = 1 + 0.16 * coarse + 0.045 * strata + 0.035 * grit - 0.2 * crater;
    point.multiply(squash).multiplyScalar(surface);
    positions.setXYZ(i, point.x, point.y, point.z);
    color.copy(stone).lerp(mineral, Math.min(1, Math.max(0, 0.22 + 0.21 * coarse + 0.17 * grit + 0.3 * strata ** 6)));
    color.toArray(colors, i * 3);
  }
  positions.needsUpdate = true;
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  const bounds = geometry.boundingSphere!;
  const scale = 1 / bounds.radius;
  geometry.translate(-bounds.center.x, -bounds.center.y, -bounds.center.z);
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingSphere();
  geometry.computeVertexNormals();
  return geometry;
}

let pendingRules: Promise<AsteroidRules | null> | null = null;
function loadRules(): Promise<AsteroidRules | null> {
  return pendingRules ??= fetch("/client-assets/asteroidRules.json")
    .then(response => response.ok ? response.json() as Promise<AsteroidRules> : null)
    .catch(() => null);
}

interface AsteroidVisual {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  axis: THREE.Vector3;
  phase: number;
  radius: number;
  groupID: number | null;
  typeID: number | null;
  rules: AsteroidRules | null;
}

export class AsteroidModels {
  private readonly byVariant = new Map<string, THREE.BufferGeometry>();
  private readonly visuals = new WeakMap<THREE.Object3D, AsteroidVisual>();
  private readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, emissive: 0x22201d, emissiveIntensity: 0.45 });
  private rules: AsteroidRules | null = null;
  private requested = false;

  update(holder: THREE.Object3D, ball: AsteroidBall, timeMs: number): void {
    if (!this.requested) {
      this.requested = true;
      void loadRules().then(rules => { this.rules = rules; });
    }
    let rock = this.visuals.get(holder);
    if (!rock) {
      const random = randomFrom(ball.itemID);
      const mesh = new THREE.Mesh(undefined, this.material);
      mesh.name = "Asteroid surface";
      holder.add(mesh);
      rock = { mesh, axis: new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize(),
        phase: random() * 2 * Math.PI, radius: NaN, groupID: null, typeID: null, rules: null };
      this.visuals.set(holder, rock);
    }
    if (rock.radius !== ball.radius || rock.typeID !== ball.typeID || rock.groupID !== ball.groupID || rock.rules !== this.rules) {
      const graphicID = this.rules ? asteroidGraphic(ball, this.rules) : null;
      const seed = graphicID ?? (ball.typeID ?? 0) * 4 + ball.itemID % 4;
      const icy = ball.groupID === 465;
      const key = `${seed}/${icy}`;
      let geometry = this.byVariant.get(key);
      if (!geometry) {
        geometry = makeAsteroidGeometry(seed, icy);
        this.byVariant.set(key, geometry);
      }
      rock.mesh.geometry = geometry;
      rock.mesh.userData.graphicID = graphicID;
      rock.mesh.scale.setScalar(Number.isFinite(ball.radius) && ball.radius > 0 ? ball.radius : 5);
      rock.radius = ball.radius;
      rock.groupID = ball.groupID;
      rock.typeID = ball.typeID;
      rock.rules = this.rules;
    }
    const period = 75 * Math.log(Math.max(2, rock.mesh.scale.x)) * 1000;
    rock.mesh.quaternion.setFromAxisAngle(rock.axis, rock.phase + (timeMs % period) / period * 2 * Math.PI);
  }

  meshOf(holder: THREE.Object3D): AsteroidVisual["mesh"] | undefined {
    return this.visuals.get(holder)?.mesh;
  }

  dispose(): void {
    this.material.dispose();
    for (const geometry of this.byVariant.values()) geometry.dispose();
    this.byVariant.clear();
  }
}
