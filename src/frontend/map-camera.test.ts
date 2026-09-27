import assert from "node:assert/strict";
import test from "node:test";
import { circleCamera, interpolateCamera } from "./map-camera";

test("zoom keeps its focus centered and fits both portrait and landscape viewports", () => {
  for (const aspect of [.7, 1, 1.8]) {
    const camera = circleCamera(210, 340, 50, aspect);
    assert.equal(camera.x + camera.width / 2, 210);
    assert.equal(camera.y + camera.height / 2, 340);
    assert.ok(camera.width >= 100 && camera.height >= 100);
    assert.ok(Math.abs(camera.width / camera.height - aspect) < 1e-9);
  }
});

test("interrupted zoom can resume from its current camera without a jump", () => {
  const overview = { x: 0, y: 0, width: 1080, height: 1140 };
  const category = circleCamera(180, 164, 140, 1.6);
  const current = interpolateCamera(overview, category, .4);
  const leaf = circleCamera(200, 180, 30, 1.6);
  assert.deepEqual(interpolateCamera(current, leaf, 0), current);
  assert.deepEqual(interpolateCamera(current, leaf, 1), leaf);
  assert.ok(interpolateCamera(current, leaf, .5).width > 0);
});
