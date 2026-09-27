"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  Loader2,
  X,
} from "lucide-react";
import type { Cluster, DemoAdapter, FictionalStory, Snapshot } from "./data";
import { number, percent } from "./format";

type StoryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; story: FictionalStory; cached: boolean };

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
  const requestedFromStory = useRef(false);
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 1100px)").matches)
      title.current?.scrollIntoView({ block: "start", behavior: "instant" });
    return () => controller.current?.abort();
  }, []);

  async function generateStory() {
    if (story.status === "loading") return;
    requestedFromStory.current = Boolean(
      storySection.current?.contains(document.activeElement),
    );
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
        setStory({ status: "ready", story: response.story, cached: true });
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
                cached: false,
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
      requestedFromStory.current &&
      (document.activeElement === document.body ||
        storySection.current.contains(document.activeElement))
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
        <span>Workflow insight</span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close details"
        >
          <X size={18} />
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
        <div className="metrics-pair">
          <div>
            <strong>{number(m.conversationCount)}</strong>
            <span>conversations</span>
            <small>
              {percent(m.conversationShare)} of all{" "}
              {number(snapshot.totals.conversationCount)}
            </small>
          </div>
          <div>
            <strong>{percent(m.observedFrictionShare)}</strong>
            <span>observed friction</span>
            <small>
              {m.observedFrictionCount} of {m.conversationCount} conversations
            </small>
          </div>
        </div>
        <section className="detail-section">
          <h3>What people need</h3>
          <ul className="prose-list">
            {cluster.needs.map((need) => (
              <li key={need}>{need}</li>
            ))}
          </ul>
        </section>
        <section className="detail-section">
          <h3>Where it gets difficult</h3>
          {cluster.gripes.length ? (
            <ul className="prose-list">
              {cluster.gripes.map((gripe) => (
                <li key={gripe}>{gripe}</li>
              ))}
            </ul>
          ) : (
            <p>No specific frustration is established in this finding.</p>
          )}
        </section>
        <details className="signal-details">
          <summary>
            Supporting signals{" "}
            <span>
              3 signals <ChevronDown size={14} />
            </span>
          </summary>
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
            Conversations can contain several signals. Counts overlap and do not
            add up to overall friction.
          </p>
          <p className="fine-print">
            {m.unclearCount} conversations have an unclear assessment and no
            observed signal. No observed friction does not mean success.
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
          aria-label="User story"
        >
          {story.status !== "ready" ? (
            <>
              <div className="story-heading">
                <BookOpen size={18} />
                <h3>Make the finding tangible</h3>
              </div>
              <p>An illustrative story, grounded in this aggregate finding.</p>
              <button
                className="primary-button"
                onClick={generateStory}
                disabled={story.status === "loading"}
              >
                {story.status === "loading" ? (
                  <>
                    <Loader2 size={16} className="spin" /> Preparing story…
                  </>
                ) : (
                  <>
                    <BookOpen size={16} />{" "}
                    {story.status === "error"
                      ? "Retry user story"
                      : "Generate user story"}
                    <ArrowUpRight size={15} />
                  </>
                )}
              </button>
              <div aria-live="polite">
                {story.status === "loading" && (
                  <p className="fine-print">
                    Simulated generation · using approved mock evidence
                  </p>
                )}
                {story.status === "error" && (
                  <p className="inline-error">
                    <CircleAlert size={15} /> The simulated story failed. Your
                    insight is still here.
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="story-result">
              <div className="story-label">
                <BookOpen size={16} />
                {story.story.label}
              </div>
              <p className="story-disclosure">{story.story.disclosure}</p>
              <h3 ref={storyTitle} tabIndex={-1}>
                {story.story.name}’s story
              </h3>
              <p className="story-copy">{story.story.body}</p>
              <div className="story-foot">
                <Check size={14} />
                {story.cached ? "Previously generated" : "Authored mock story"}
                <span>
                  · {story.story.evidenceIds.length} evidence references
                </span>
              </div>
            </div>
          )}
        </section>
        <p className="detail-footnote">
          Aggregate evidence only. No customer conversations are available in
          this workspace.
        </p>
      </div>
    </aside>
  );
}
