import { packEnclose, packSiblings } from "d3-hierarchy";
import type { Snapshot } from "./data/types";

/** Fixed-size cells support any category count; one radius scale preserves count comparisons. */
export function layoutMap(snapshot: Snapshot, columns: number) {
  const packed = snapshot.categories.map((category) => {
    const leaves = snapshot.clusters.filter((cluster) => cluster.parentId === category.id);
    const circles = packSiblings(leaves.map((cluster) => ({
      r: Math.sqrt(cluster.metrics.conversationCount) + 1,
      x: 0, y: 0, cluster,
    })));
    return { ...category, leaves, circles, enclosure: packEnclose(circles) ?? { x: 0, y: 0, r: 0 } };
  });
  const scale = 140 / Math.max(1, ...packed.map((group) => group.enclosure.r));
  return {
    width: columns * 360,
    height: Math.max(1, Math.ceil(packed.length / columns)) * 380,
    groups: packed.map((group, index) => ({
      ...group,
      x: (index % columns) * 360 + 180,
      y: Math.floor(index / columns) * 380 + 164,
      enclosure: { x: 0, y: 0, r: group.enclosure.r * scale },
      circles: group.circles.map((circle) => ({
        ...circle,
        x: (circle.x - group.enclosure.x) * scale,
        y: (circle.y - group.enclosure.y) * scale,
        r: Math.sqrt(circle.cluster.metrics.conversationCount) * scale,
      })),
    })),
  };
}
