export type Camera = { x: number; y: number; width: number; height: number };

/** Fit a circle without changing node positions or the area scale. */
export function circleCamera(x: number, y: number, radius: number, aspect: number): Camera {
  const size = Math.max(32, radius * 2.7);
  const width = Math.max(size, size * aspect);
  const height = Math.max(size, size / aspect);
  return { x: x - width / 2, y: y - height / 2, width, height };
}

export function interpolateCamera(from: Camera, to: Camera, progress: number): Camera {
  const t = Math.min(1, Math.max(0, progress));
  if (t === 0) return from;
  if (t === 1) return to;
  const ease = t * t * (3 - 2 * t);
  return {
    x: from.x + (to.x - from.x) * ease, y: from.y + (to.y - from.y) * ease,
    width: from.width + (to.width - from.width) * ease,
    height: from.height + (to.height - from.height) * ease,
  };
}
