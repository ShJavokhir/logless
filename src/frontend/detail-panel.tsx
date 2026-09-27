"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  Loader2,
} from "lucide-react";
import type { Cluster, DemoAdapter, FictionalStory, Snapshot } from "./data";
import { number, percent } from "./format";

type StoryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      story: FictionalStory;
      animate: boolean;
    };

export function DetailPanel({
  cluster,
  snapshot,
  adapter,
  onClose,
}: {
  cluster: Cluster;
  snapshot: Snapshot;
  adapter: DemoAdapter;
  onClose: () => void;
}) {
  const [story, setStory] = useState<StoryState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const storySection = useRef<HTMLElement>(null);
  const storyTitle = useRef<HTMLHeadingElement>(null);
  const storyAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 1100px)").matches)
      title.current?.scrollIntoView({ block: "start", behavior: "instant" });
    return () => controller.current?.abort();
  }, []);

  async function generateStory(animate: boolean) {
    if (story.status === "loading") return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setStory({ status: "loading" });
    try {
      const response = await adapter.requestStory({
        snapshotId: snapshot.id,
        clusterId: cluster.id,
      });
      if (current.signal.aborted) return;
      if (response.status === "cached")
        setStory({
          status: "ready",
          story: response.story,
          animate,
        });
      else {
        while (!current.signal.aborted) {
          const run = await adapter.getRun(response.runId, {
            signal: current.signal,
          });
          if (run.state === "failed") throw new Error(run.error.message);
          if (run.state === "completed" && run.result.kind === "story") {
            if (
              !current.signal.aborted &&
              run.result.story.clusterId === cluster.id &&
              run.snapshotId === snapshot.id
            )
              setStory({
                status: "ready",
                story: run.result.story,
                animate,
              });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 180));
        }
      }
    } catch {
      if (!current.signal.aborted) setStory({ status: "error" });
    }
  }

  useEffect(() => {
    if (story.status !== "ready" || !storySection.current) return;
    // Do not steal focus if the user moved elsewhere while the request ran.
    if (
      document.activeElement === storyAction.current ||
      document.activeElement === document.body
    )
      storyTitle.current?.focus({ preventScroll: true });
    const panel = storySection.current.closest<HTMLElement>(".detail-panel");
    if (window.matchMedia("(min-width: 1101px)").matches && panel) {
      // Scroll only the detail panel; keep the map and persistent demo label in place.
      panel.scrollTo({
        top: storySection.current.offsetTop - 76,
        behavior: "instant",
      });
    } else
      storySection.current.scrollIntoView({
        block: "nearest",
        behavior: "instant",
      });
  }, [story.status]);
  const m = cluster.metrics;
  return (
    <aside
      className="detail-panel"
      aria-label="Workflow details"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="detail-topline">
        <button className="text-link" onClick={onClose}>
          <ArrowLeft size={16} /> Back to workflows
        </button>
      </div>
      <div className="detail-body">
        <div className="sr-only" role="status" aria-live="polite">
          {story.status === "ready"
            ? `Fictional user story ready for ${story.story.name}.`
            : story.status === "loading"
              ? "Preparing a fictional user story from mock evidence."
              : story.status === "error"
                ? "Story generation failed. Retry is available."
                : ""}
        </div>
        <div className="eyebrow">
          {snapshot.categories.find((c) => c.id === cluster.parentId)?.title}
        </div>
        <h2 ref={title} tabIndex={-1}>
          {cluster.title}
        </h2>
        <p className="summary">{cluster.summary}</p>
        <div className="detail-next-action">
          <button
            ref={storyAction}
            className="primary-button"
            disabled={story.status === "loading"}
            onClick={(event) => {
              if (story.status === "ready") {
                storyTitle.current?.focus({ preventScroll: true });
                storySection.current?.scrollIntoView({
                  block: "nearest",
                  behavior: "instant",
                });
              } else void generateStory(event.detail > 0);
            }}
          >
            {story.status === "loading" ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <BookOpen size={16} />
            )}
            {story.status === "ready"
              ? "Read story"
              : story.status === "loading"
                ? "Preparing story…"
                : story.status === "error"
                  ? "Retry story"
                  : "Create fictional story"}
          </button>
        </div>
        <div className="metrics-pair">
          <div>
            <strong>{number(m.conversationCount)}</strong>
            <span>conversations</span>
            <small>{percent(m.conversationShare)} of all conversations</small>
          </div>
          <div>
            <strong>{percent(m.observedFrictionShare)}</strong>
            <span>with friction</span>
            <small>
              {m.observedFrictionCount} of {m.conversationCount} conversations
            </small>
          </div>
        </div>
        <section className="detail-section">
          <h3>Customer needs</h3>
          <ul className="prose-list">
            {cluster.needs.map((need) => (
              <li key={need}>{need}</li>
            ))}
          </ul>
        </section>
        <section className="detail-section">
          <h3>Problems</h3>
          {cluster.gripes.length ? (
            <ul className="prose-list">
              {cluster.gripes.map((gripe) => (
                <li key={gripe}>{gripe}</li>
              ))}
            </ul>
          ) : (
            <p>No specific problem established.</p>
          )}
        </section>
        <details className="signal-details">
          <summary>
            Supporting signals{" "}
            <span>
              <ChevronDown size={14} />
            </span>
          </summary>
          <p className="fine-print">
            Friction means a correction, task complaint, or unresolved action
            error.
          </p>
          <div className="signals">
            {(
              [
                ["Corrections", m.signals.corrections],
                ["Task-related complaints", m.signals.complaints],
                ["Unresolved action errors", m.signals.unresolvedErrors],
              ] as const
            ).map(([label, count]) => (
              <div key={label}>
                <span>{label}</span>
                <b>
                  {count} / {m.conversationCount}
                </b>
                <small>{percent(count / m.conversationCount)}</small>
              </div>
            ))}
          </div>
          <p className="fine-print">
            Signals overlap; do not add these counts.
          </p>
          <p className="fine-print">
            {m.unclearCount} unclear assessments. No observed friction does not
            mean success.
          </p>
          <div className="evidence-list">
            {cluster.evidence.map((evidence) => (
              <div key={evidence.id}>
                <strong>{evidence.label}</strong>
                <p>{evidence.description}</p>
              </div>
            ))}
          </div>
        </details>
        <section
          className="story-section"
          ref={storySection}
          aria-label="Example user story"
          tabIndex={-1}
        >
          {story.status === "error" ? (
            <p className="inline-error" role="alert">
              <CircleAlert size={15} /> Couldn’t generate the story. Try again.
            </p>
          ) : story.status === "ready" ? (
            <div className="story-result">
              <div className="story-label">
                <BookOpen size={16} />
                {story.story.label}
              </div>
              <p className="story-disclosure">
                Based on aggregate patterns. Not a real customer or additional
                evidence.
              </p>
              <div className="story-reveal" data-animate={story.animate}>
                <h3 ref={storyTitle} tabIndex={-1}>
                  {story.story.name}’s story
                </h3>
                <p className="story-copy">{story.story.body}</p>
              </div>
              <div className="story-foot">
                <Check size={14} />
                {story.story.evidenceIds.length} evidence references
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </aside>
  );
}
