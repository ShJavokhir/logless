import assert from "node:assert/strict";
import test from "node:test";
import snapshotJson from "../../web/src/mocks/real-snapshot.json";
import type { Snapshot as ApiSnapshot } from "../../web/src/lib/types";
import { mapSnapshot } from "./data/live";
import { layoutMap } from "./map-layout";

test("real-data categories fit every responsive map and circle areas remain proportional", () => {
  const snapshot = mapSnapshot(snapshotJson as unknown as ApiSnapshot);
  for (const columns of [1, 2, 3]) {
    const layout = layoutMap(snapshot, columns);
    assert.equal(layout.groups.length, snapshot.categories.length);
    const ratios: number[] = [];
    for (const group of layout.groups) {
      assert.ok(group.x - group.enclosure.r - 14 >= 0);
      assert.ok(group.x + group.enclosure.r + 14 <= layout.width);
      assert.ok(group.y - group.enclosure.r - 14 >= 0);
      assert.ok(group.y + group.enclosure.r + 34 <= layout.height);
      for (const circle of group.circles) {
        assert.ok(Number.isFinite(circle.x) && Number.isFinite(circle.y));
        if (circle.cluster.metrics.conversationCount) ratios.push(circle.r ** 2 / circle.cluster.metrics.conversationCount);
      }
    }
    assert.ok(Math.max(...ratios) - Math.min(...ratios) < 1e-9);
  }
});
