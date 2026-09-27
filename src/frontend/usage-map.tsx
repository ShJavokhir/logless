"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { layoutMap } from "./map-layout";
import { circleCamera, interpolateCamera, type Camera } from "./map-camera";
import type { AnalysisIntent, Snapshot } from "./data";
import { number, percent, splitLabel } from "./format";

export function UsageMap({ snapshot, mode, selected, category, matches, onSelect, onCategory }: {
  snapshot: Snapshot;
  mode: AnalysisIntent;
  selected: string | null;
  category: string | null;
  matches: string[] | null;
  onSelect: (id: string) => void;
  onCategory: (id: string | null) => void;
}) {
  const figure = useRef<HTMLElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [aspect, setAspect] = useState(1.6);
  // A fixed layout preserves spatial context when opening the detail panel or resizing the viewport.
  const layout = useMemo(() => layoutMap(snapshot, 3), [snapshot]);
  const group = layout.groups.find((item) => item.id === category);
  const leaf = layout.groups.flatMap((parent) => parent.circles.map((node) => ({ ...node, x: parent.x + node.x, y: parent.y + node.y, parent }))).find((node) => node.cluster.id === selected);
  const level = leaf ? "workflow" : group ? "category" : "overview";
  const target = leaf
    ? circleCamera(leaf.x, leaf.y, leaf.r, aspect)
    : group
      ? circleCamera(group.x, group.y, group.enclosure.r + 28, aspect)
      : { x: 0, y: 0, width: layout.width, height: layout.height };
  const [camera, setCamera] = useState<Camera>(target);
  const current = useRef(camera);
  const [moving, setMoving] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.height > 0) setAspect(entry.contentRect.width / entry.contentRect.height);
    });
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, []);
  const { x, y, width, height } = target;
  useEffect(() => {
    const destination = { x, y, width, height };
    if (reducedMotion) {
      current.current = destination; setCamera(destination); setMoving(false); return;
    }
    const from = current.current;
    const start = performance.now();
    let frame = 0;
    setMoving(true);
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 420);
      current.current = interpolateCamera(from, destination, progress);
      setCamera(current.current);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else setMoving(false);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [x, y, width, height, reducedMotion]);

  function zoomOut() {
    onCategory(leaf ? leaf.parent.id : null);
    requestAnimationFrame(() => svg.current?.focus({ preventScroll: true }));
  }
  const scale = 720 / camera.width;
  return (
    <figure ref={figure} className="usage-map semantic-map" aria-label="Two-level aggregate workflow map" data-zoom-level={level} data-zoom-moving={moving} data-reduced-motion={reducedMotion}>
      <nav className="map-breadcrumbs" aria-label="Map zoom">
        <button onClick={() => onCategory(null)} aria-current={level === "overview" ? "location" : undefined}>All workflows</button>
        {(group || leaf) && <><span aria-hidden="true">/</span><button onClick={() => onCategory((leaf?.parent ?? group)!.id)} aria-current={level === "category" ? "location" : undefined}>{(leaf?.parent ?? group)!.title}</button></>}
        {leaf && <><span aria-hidden="true">/</span><span aria-current="location">{leaf.cluster.shortTitle}</span></>}
        {level !== "overview" && <button className="zoom-out" onClick={zoomOut}>Zoom out <kbd>Esc</kbd></button>}
      </nav>
      <div className="sr-only" role="status" aria-live="polite">{level === "overview" ? "Overview. Choose a category to see its workflows." : `${level === "category" ? "Category" : "Workflow"}: ${leaf?.cluster.title ?? group?.title}. Escape returns one level.`}</div>
      <svg ref={svg} viewBox={`${camera.x} ${camera.y} ${camera.width} ${camera.height}`} role="group" tabIndex={-1}
        aria-label="Workflow circles. Enter to zoom. Escape to zoom out. Circle area represents conversations."
        onKeyDown={(event) => { if (event.key === "Escape" && level !== "overview") { event.preventDefault(); event.stopPropagation(); zoomOut(); } }}>
        {layout.groups.map((parent) => {
          const dimGroup = category !== null && category !== parent.id;
          const parentMatch = matches === null || parent.leaves.some((c) => matches.includes(c.id));
          return <g key={parent.id} className={dimGroup || !parentMatch ? "map-group dim" : "map-group"}>
            <g role="button" tabIndex={level === "overview" || parent.id === category ? 0 : -1} aria-label={`Zoom into ${parent.title}`} aria-pressed={category === parent.id}
              className="category-circle" onClick={() => onCategory(parent.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCategory(parent.id); } }}>
              <title>{parent.title}: {number(parent.leaves.reduce((sum, c) => sum + c.metrics.conversationCount, 0))} conversations</title>
              <circle cx={parent.x} cy={parent.y} r={parent.enclosure.r + 14} />
              {level !== "workflow" && <text x={parent.x} y={parent.y + parent.enclosure.r + 34} textAnchor="middle" className="category-label">{parent.title}</text>}
            </g>
            {parent.circles.map((node) => {
              const c = node.cluster;
              const matched = matches !== null && matches.includes(c.id);
              const dim = (matches !== null && !matched) || (level === "workflow" && selected !== c.id);
              const cx = parent.x + node.x, cy = parent.y + node.y;
              const shade = mode === "friction" ? Math.round(245 - (c.metrics.observedFrictionShare ?? 0) * 150) : 231;
              const reveal = (level === "category" && parent.id === category) || selected === c.id;
              const lines = splitLabel(c.shortTitle);
              const fontSize = Math.min(15, node.r / 3.6);
              return <g key={c.id} role="button" tabIndex={parent.id === category ? 0 : -1}
                aria-label={`Inspect ${c.title}, ${number(c.metrics.conversationCount)} conversations`} aria-pressed={selected === c.id}
                data-cluster={c.id} data-x={cx} data-y={cy} data-r={node.r}
                className={`leaf-circle ${selected === c.id ? "selected" : ""} ${matched ? "matched" : ""} ${dim ? "dim" : ""}`}
                onClick={() => level === "overview" ? onCategory(parent.id) : onSelect(c.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(c.id); } }}>
                <title>{c.title}: {number(c.metrics.conversationCount)} conversations, {percent(c.metrics.observedFrictionShare)} with observed friction</title>
                <circle cx={cx} cy={cy} r={node.r} style={{ fill: selected === c.id ? "#f4f6fc" : `rgb(${shade}, ${shade}, ${shade})` }} />
                {(reveal || (level !== "workflow" && node.r * scale > 48)) && <text x={cx} y={cy - (lines.length - 1) * fontSize * .6 - fontSize * .3} textAnchor="middle" style={{ fontSize }}>
                  {lines.map((line, i) => <tspan key={i} x={cx} dy={i === 0 ? 0 : fontSize * 1.2}>{line}</tspan>)}
                  {reveal && <tspan x={cx} dy={fontSize * 1.5} className="leaf-value" style={{ fontSize: fontSize * .9 }}>{mode === "usage" ? number(c.metrics.conversationCount) : percent(c.metrics.observedFrictionShare)}</tspan>}
                </text>}
              </g>;
            })}
          </g>;
        })}
      </svg>
      <figcaption>Circle area = conversations · {level === "overview" ? "Choose a category" : level === "category" ? "Choose a workflow for details" : `${number(leaf!.cluster.metrics.conversationCount)} conversations · ${percent(leaf!.cluster.metrics.observedFrictionShare)} with friction`} · {mode === "usage" ? "Positions stay fixed while zooming" : "Darker = more observed friction"}</figcaption>
    </figure>
  );
}
