import * as THREE from "three";
import { dnaModel, graphicModel } from "../three/hullModel.ts";
import type { HangarGraphics } from "./hangarRegistry.ts";

type Pose = [number[], number[], number[]];
interface Part { name: string; hull: string; pose: Pose; background?: boolean; children?: Part[] }
interface Layout { root: string; parts: Part[]; capital?: Pose }

function applyPose(object: THREE.Object3D, [[x, y, z], [qx, qy, qz, qw], scale]: Pose): void {
  // Extracted geometry mirrors Z. Reflect both the locator position and rotation into that coordinate system.
  object.position.set(x!, y!, -z!);
  object.quaternion.set(-qx!, -qy!, qz!, qw!).normalize();
  object.scale.fromArray(scale);
}

export async function modularHangar(graphics: HangarGraphics): Promise<THREE.Object3D | null> {
  const response = await fetch(`/client-assets/graphic/${graphics.model}`);
  if (!response.ok) return null;
  const { hangarLayout, faction } = await response.json() as { hangarLayout?: Layout; faction: string };
  const material = graphics.modular?.faction ?? faction;
  const root = graphics.modular?.faction && hangarLayout
    ? await dnaModel(`${hangarLayout.root}:${material}:generic`).catch(() => null)
    : await graphicModel(graphics.model);
  if (!root || !hangarLayout) return root;
  const layout = new THREE.Group();
  layout.name = "Upwell layout";
  const addParts = async (parent: THREE.Object3D, parts: Part[]): Promise<void> => {
    await Promise.all(parts.map(async part => {
      const attachment = new THREE.Group();
      attachment.name = part.name;
      applyPose(attachment, part.pose);
      parent.add(attachment);
      const [model] = await Promise.all([
        dnaModel(`${part.hull}:${material}:generic`).catch(() => null),
        part.children ? addParts(attachment, part.children) : null,
      ]);
      if (!model) return;
      // These placements are instanced scenery in the client. Keep their low LOD mesh without the dock effects.
      const lod = part.background ? model.getObjectByProperty("type", "LOD") as THREE.LOD | undefined : undefined;
      const low = lod?.levels[Math.min(2, lod.levels.length - 1)]?.object;
      if (low) {
        low.visible = true;
        low.userData.hull = part.hull;
      }
      attachment.add(low ?? model);
    }));
  };
  await addParts(layout, hangarLayout.parts);
  if (hangarLayout.capital) {
    const dock = new THREE.Object3D();
    dock.name = "ship_placement";
    applyPose(dock, hangarLayout.capital);
    layout.add(dock);
  }
  root.add(layout);
  return root;
}

export function modularDock(hangar: THREE.Object3D, kind: NonNullable<HangarGraphics["modular"]>["dock"]): THREE.Object3D | undefined {
  const layout = hangar.getObjectByName("Upwell layout");
  if (kind === "capital") return layout?.getObjectByName("ship_placement");
  const small = layout?.getObjectByName("small_dock_ships_potato");
  const medium = layout?.getObjectByName("medium_dock_ships");
  return kind === "medium" ? medium ?? small : small ?? medium;
}
