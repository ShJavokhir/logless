"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { packEnclose, packSiblings } from "d3-hierarchy";
import type { AnalysisIntent, Cluster, Snapshot } from "./data";
import { percent, splitLabel } from "./format";

export function UsageMap({
  snapshot,
  mode,
  selected,
  category,
  matches,
  onSelect,
  onCategory,
}: {
  snapshot: Snapshot;
  mode: AnalysisIntent;
  selected: string | null;
  category: string | null;
  matches: string[] | null;
  onSelect: (id: string) => void;
  onCategory: (id: string) => void;
}) {
  const figure = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    if (!figure.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setWide(entry.contentRect.width > 900);
      setStacked(entry.contentRect.width < 570);
    });
    observer.observe(figure.current);
    return () => observer.disconnect();
  }, []);
  // A single radius scale preserves area comparisons across every category.
  // Search, selection, and friction never participate in layout calculation.
  const groups = useMemo(
    () =>
      snapshot.categories.map((group, index) => {
        const leaves = snapshot.clusters.filter((c) => c.parentId === group.id);
        const circles = packSiblings(
          leaves.map((cluster) => ({
            r: Math.sqrt(cluster.metrics.conversationCount) * 6.1 + 4,
            x: 0,
            y: 0,
            cluster,
          })),
        );
        const enclosure = packEnclose(circles) ?? { x: 0, y: 0, r: 0 };
        return {
          ...group,
          leaves,
          circles,
          enclosure,
          x: stacked
            ? 210
            : wide
              ? [150, 435, 685, 905][index]
              : index % 2 === 0
                ? 224
                : 612,
          y: stacked ? 155 + index * 310 : wide ? 150 : index < 2 ? 155 : 445,
        };
      }),
    [snapshot, wide, stacked],
  );

  return (
    <figure
      ref={figure}
      className={`usage-map ${stacked ? "stacked-map" : wide ? "wide-map" : "compact-map"}`}
      aria-label="Two-level aggregate workflow map"
    >
      <svg
        viewBox={
          stacked ? "0 0 420 1230" : wide ? "0 0 1040 325" : "0 0 840 610"
        }
        role="group"
        aria-label="Workflow circles. Circle area represents conversations, not people."
      >
        {groups.map((group) => {
          const groupDim = category !== null && category !== group.id;
          const parentMatches =
            matches === null ||
            group.leaves.some((c) => matches.includes(c.id));
          return (
            <g
              key={group.id}
              className={
                groupDim || !parentMatches ? "map-group dim" : "map-group"
              }
            >
              <g
                role="button"
                tabIndex={0}
                aria-label={`Focus ${group.title}`}
                aria-pressed={category === group.id}
                className="category-circle"
                onClick={() => onCategory(group.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onCategory(group.id);
                  }
                }}
              >
                <circle cx={group.x} cy={group.y} r={group.enclosure.r + 14} />
                <text
                  x={group.x}
                  y={group.y + group.enclosure.r + 34}
                  textAnchor="middle"
                  className="category-label"
                >
                  {group.title}
                  <tspan className="category-count">
                    {" "}
                    ·{" "}
                    {group.leaves.reduce(
                      (n, c) => n + c.metrics.conversationCount,
                      0,
                    )}
                  </tspan>
                </text>
              </g>
              {group.circles.map((node) => {
                const c: Cluster = node.cluster;
                const lines = splitLabel(c.shortTitle);
                const isSelected = selected === c.id;
                const matched = matches !== null && matches.includes(c.id);
                const dim = matches !== null && !matched;
                const x = group.x + node.x - group.enclosure.x;
                const y = group.y + node.y - group.enclosure.y;
                const r = node.r - 4;
                const shade =
                  mode === "friction"
                    ? Math.round(
                        245 - (c.metrics.observedFrictionShare ?? 0) * 150,
                      )
                    : 231;
                return (
                  <g
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Inspect ${c.title}, ${c.metrics.conversationCount} conversations${mode === "friction" ? `, ${percent(c.metrics.observedFrictionShare)} observed friction` : ""}`}
                    aria-pressed={isSelected}
                    data-cluster={c.id}
                    data-x={x}
                    data-y={y}
                    data-r={r}
                    className={`leaf-circle ${isSelected ? "selected" : ""} ${matched ? "matched" : ""} ${dim ? "dim" : ""}`}
                    onClick={() => onSelect(c.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(c.id);
                      }
                    }}
                  >
                    <circle
                      cx={x}
                      cy={y}
                      r={r}
                      style={{
                        fill: isSelected
                          ? "#f4f6fc"
                          : `rgb(${shade}, ${shade}, ${shade})`,
                      }}
                    />
                    <text
                      x={x}
                      y={y - (lines.length - 1) * 8 - 5}
                      textAnchor="middle"
                    >
                      {lines.map((line, i) => (
                        <tspan key={i} x={x} dy={i === 0 ? 0 : 16}>
                          {line}
                        </tspan>
                      ))}
                      <tspan x={x} dy={21} className="leaf-value">
                        {mode === "usage"
                          ? c.metrics.conversationCount
                          : percent(c.metrics.observedFrictionShare)}
                      </tspan>
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <figcaption>
        <span className="legend-circles" aria-hidden="true">
          <i />
          <i />
        </span>{" "}
        Circle area = conversations <span className="legend-separator">·</span>{" "}
        {mode === "usage"
          ? "Grouped by workflow"
          : "Darker = more observed friction"}
      </figcaption>
    </figure>
  );
}
