"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Layers2,
  Loader2,
  List,
  Menu,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  createLiveAdapter,
  LiveApiError,
  type AnalysisIntent,
  type AnalysisResult,
  type DemoRun,
  type Snapshot,
} from "./data";
import { DetailPanel } from "./detail-panel";
import { UsageMap } from "./usage-map";
import { number, percent } from "./format";

const stageLabels = {
  planning: "Preparing analysis",
  executing: "Analyzing workflows",
  validating: "Checking results",
  explaining: "Preparing finding",
  completed: "Analysis complete",
  failed: "Analysis interrupted",
};

export function Explorer() {
  const [adapter] = useState(() => createLiveAdapter());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotState, setSnapshotState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [loadKey, setLoadKey] = useState(0);
  const [mode, setMode] = useState<AnalysisIntent>("usage");
  const [view, setView] = useState<"list" | "map">("list");
  const [motionInput, setMotionInput] = useState<"keyboard" | "pointer">(
    "keyboard",
  );
  // Keep async result motion tied to its trigger, including assistive clicks (detail = 0).
  const [animateAnalysis, setAnimateAnalysis] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<string[] | null>(null);
  const [searchState, setSearchState] = useState<
    "idle" | "loading" | "ready" | "error" | "stale"
  >("idle");
  const [searchKey, setSearchKey] = useState(0);
  const [run, setRun] = useState<DemoRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [results, setResults] = useState<
    Partial<Record<AnalysisIntent, AnalysisResult>>
  >({});
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | SVGElement | null>(null);
  const analysisController = useRef<AbortController | null>(null);
  const pendingIntent = useRef<AnalysisIntent | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshotState("loading");
    adapter
      .getSnapshot({ signal: controller.signal })
      .then((data) => {
        setSnapshot(data);
        setSnapshotState("ready");
        setExpanded(data.categories[0]?.id ?? null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSnapshotState("error");
      });
    return () => controller.abort();
  }, [adapter, loadKey]);

  useEffect(() => {
    const controller = new AbortController();
    if (!snapshot || !query.trim()) {
      setMatches(null);
      setSearchState("idle");
      return;
    }
    setSearchState("loading");
    const timer = setTimeout(() => {
      adapter
        .search({
          snapshotId: snapshot.id,
          query: query.trim(),
          signal: controller.signal,
        })
        .then((result) => {
          if (!controller.signal.aborted && result.snapshotId === snapshot.id) {
            setMatches(result.clusterIds);
            setSearchState("ready");
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setMatches(null);
            setSearchState(error instanceof LiveApiError && error.code === "stale_snapshot" ? "stale" : "error");
          }
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, snapshot, adapter, searchKey]);

  useEffect(() => () => analysisController.current?.abort(), []);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const inInput =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement;
      if (event.key === "/" && !inInput) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && inInput && query) {
        event.preventDefault();
        setQuery("");
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [query]);

  function select(id: string) {
    triggerRef.current = document.activeElement as HTMLElement | SVGElement;
    setSelectedId(id);
    const parent = snapshot?.clusters.find((cluster) => cluster.id === id)?.parentId;
    if (parent) setCategory(parent);
    setMobileNav(false);
  }
  function closeDetails() {
    setSelectedId(null);
    requestAnimationFrame(() => {
      const narrow = window.matchMedia("(max-width: 1100px)").matches;
      const target =
        narrow && triggerRef.current?.closest("nav")
          ? searchRef.current
          : triggerRef.current;
      target?.focus({ preventScroll: !narrow });
    });
  }
  function focusCategory(id: string | null) {
    setSelectedId(null);
    setCategory(id);
    setExpanded(id);
    setMobileNav(false);
  }
  function resetView() {
    setCategory(null);
    setQuery("");
    setSelectedId(null);
    setMobileNav(false);
  }

  function reloadSnapshot() {
    analysisController.current?.abort();
    pendingIntent.current = null;
    setStarting(false);
    setSelectedId(null);
    setCategory(null);
    setMatches(null);
    setRun(null);
    setRunError(null);
    setResults({});
    setLoadKey((key) => key + 1);
  }

  async function analyze(intent: AnalysisIntent, animate: boolean) {
    if (!snapshot || pendingIntent.current === intent) return;
    if (snapshot.synthetic) { setMode(intent); return; }
    analysisController.current?.abort();
    const controller = new AbortController();
    analysisController.current = controller;
    pendingIntent.current = intent;
    setAnimateAnalysis(animate);
    setMode(intent);
    setRun(null);
    setRunError(null);
    setStarting(true);
    try {
      const { runId } = await adapter.createAnalysis({
        snapshotId: snapshot.id,
        intent,
      });
      while (!controller.signal.aborted) {
        const next = await adapter.getRun(runId, { signal: controller.signal });
        if (controller.signal.aborted) break;
        setRun(next);
        setStarting(false);
        if (next.state === "failed") break;
        if (
          next.state === "completed" &&
          next.result.kind === "analysis" &&
          next.snapshotId === snapshot.id
        ) {
          const result = next.result;
          setResults((previous) => ({ ...previous, [intent]: result }));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setStarting(false);
        setRun(null);
        setRunError(
          error instanceof Error
            ? error.message
            : "The analysis request failed.",
        );
      }
    } finally {
      if (!controller.signal.aborted) pendingIntent.current = null;
    }
  }

  const selected = snapshot?.clusters.find((c) => c.id === selectedId) ?? null;
  const ranked = useMemo(() => {
    if (!snapshot) return [];
    const order = results[mode]?.orderedClusterIds;
    return [...snapshot.clusters].sort((a, b) => {
      const rank = (id: string) => {
        const index = order?.indexOf(id) ?? -1;
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
      };
      // The API returns at most ten rows. Keep remaining workflows in metric order.
      return (
        rank(a.id) - rank(b.id) ||
        (mode === "usage"
          ? b.metrics.conversationCount - a.metrics.conversationCount
          : b.metrics.observedFrictionCount - a.metrics.observedFrictionCount)
      );
    });
  }, [snapshot, mode, results]);
  const visibleRanked = ranked.filter(
    (c) =>
      (!category || category === c.parentId) &&
      (matches === null || matches.includes(c.id)),
  );
  const hero = ranked[0];
  const busy = starting || run?.state === "running";
  const failed = run?.state === "failed" || runError;
  const result = results[mode];
  const analysisStatus = busy
    ? run
      ? stageLabels[run.stage]
      : "Preparing analysis"
    : failed
      ? "Analysis interrupted"
      : result
        ? "Verified finding"
        : "Published finding";

  return (
    <div
      className={`workspace ${selected ? "has-detail" : ""}`}
      data-motion-input={motionInput}
      onPointerDownCapture={(event) => {
        if (event.isPrimary && event.button === 0) setMotionInput("pointer");
      }}
      onKeyDownCapture={() => setMotionInput("keyboard")}
    >
      <a className="skip-link" href="#explorer">
        Skip to explorer
      </a>
      <aside
        className={`sidebar ${mobileNav ? "mobile-open" : ""}`}
        aria-label="Workspace navigation"
      >
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
          </span>
          <span>logless</span>
          <button
            className="mobile-menu icon-button"
            aria-label="Toggle navigation"
            aria-expanded={mobileNav}
            onClick={() => setMobileNav(!mobileNav)}
          >
            <Menu size={19} />
          </button>
        </div>
        <div className="workspace-name">
          <div>
            <strong>{snapshot?.workspaceName ?? "logless"}</strong>
          </div>
        </div>
        <nav className="nav-content">
          <button
            className={`nav-overview ${!category ? "active" : ""}`}
            onClick={resetView}
          >
            <Layers2 size={17} />
            <span>All workflows</span>
            <span className="count">{snapshot?.clusters.length ?? "—"}</span>
          </button>
          <div className="nav-section-label">WORKFLOWS</div>
          {snapshot?.categories.map((group) => {
            const children = snapshot.clusters.filter(
              (c) => c.parentId === group.id,
            );
            return (
              <div className="nav-group" key={group.id}>
                <div
                  className={`nav-parent ${category === group.id ? "current" : ""}`}
                >
                  <button
                    className="expand-button"
                    aria-label={`${expanded === group.id ? "Collapse" : "Expand"} ${group.title}`}
                    aria-expanded={expanded === group.id}
                    onClick={() =>
                      setExpanded(expanded === group.id ? null : group.id)
                    }
                  >
                    {expanded === group.id ? (
                      <ChevronDown size={13} />
                    ) : (
                      <ChevronRight size={13} />
                    )}
                  </button>
                  <button
                    className="parent-title"
                    onClick={() => focusCategory(group.id)}
                  >
                    {group.title}
                    <span>
                      {children.reduce(
                        (n, c) => n + c.metrics.conversationCount,
                        0,
                      )}
                    </span>
                  </button>
                </div>
                {expanded === group.id && (
                  <div className="nav-children">
                    {children.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => select(c.id)}
                        className={selectedId === c.id ? "selected" : ""}
                        aria-pressed={selectedId === c.id}
                      >
                        <span>{c.shortTitle}</span>
                        <span className="count">
                          {c.metrics.conversationCount}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <a href="/how-it-works" className="sidebar-story-link">
            <CircleDot size={15} />
            How Logless works
          </a>
          <details>
            <summary>
              <ShieldCheck size={16} />
              Privacy
              <ChevronDown size={13} />
            </summary>
            <p>
              Published aggregates only. No transcripts or individual records
              are available. Automated processing still uses model providers.
              {snapshot?.datasetNote}
            </p>
            <span className="snapshot-note">
              {snapshot?.attribution && (
                <a href={snapshot.sourceUrl} target="_blank" rel="noreferrer">
                  {snapshot.attribution}
                </a>
              )}
            </span>
          </details>
        </div>
      </aside>

      <div className="workspace-content">
        <header className="topbar">
          <div>
            <Layers2 size={16} />
            <span>Customer insights</span>
            <ChevronRight size={13} />
            <span className="muted">
              {category
                ? snapshot?.categories.find((c) => c.id === category)?.title
                : "All workflows"}
            </span>
          </div>
          <span className="demo-indicator">
            <span />
            {snapshot?.synthetic ? "Synthetic · Live Jev" : "WildChat · Live API"}
          </span>
        </header>
        <div className="content-columns">
          <main id="explorer" tabIndex={-1} className="explorer">
            <div className="page-heading">
              <div>
                <h1>
                  {mode === "usage" ? "Customer usage" : "Customer friction"}
                </h1>
                <div className="period">
                  {snapshot?.period.label ?? "Published snapshot"}
                  <span>·</span>
                  {snapshot
                    ? `${number(snapshot.totals.conversationCount)} conversations`
                    : "Loading conversations…"}
                </div>
              </div>
            </div>
            <div
              className="task-switcher"
              aria-label="What do you want to learn?"
            >
              <button
                aria-pressed={mode === "usage"}
                onClick={(event) => analyze("usage", event.detail > 0)}
                disabled={
                  !snapshot ||
                  !snapshot.clusters.length ||
                  (busy && mode === "usage")
                }
              >
                <Layers2 size={19} />
                <span>
                  <strong>Understand usage</strong>
                </span>
                {mode === "usage" && <Check size={16} />}
              </button>
              <button
                aria-pressed={mode === "friction"}
                onClick={(event) => analyze("friction", event.detail > 0)}
                disabled={
                  !snapshot ||
                  !snapshot.clusters.length ||
                  (busy && mode === "friction")
                }
              >
                <CircleAlert size={19} />
                <span>
                  <strong>Find problems</strong>
                </span>
                {mode === "friction" && <Check size={16} />}
              </button>
            </div>

            {snapshotState === "loading" ? (
              <div className="main-state" role="status">
                <Loader2 className="spin" size={24} />
                <h2>Loading insights…</h2>
              </div>
            ) : snapshotState === "error" ? (
              <div className="main-state" role="alert">
                <CircleAlert size={25} />
                <h2>The snapshot couldn’t load</h2>
                <button
                  className="primary-button"
                  onClick={() => setLoadKey((n) => n + 1)}
                >
                  Retry snapshot
                </button>
              </div>
            ) : snapshot && snapshot.clusters.length === 0 ? (
              <div className="main-state">
                <Layers2 size={26} />
                <h2>No published insights yet</h2>
                <button
                  className="primary-button"
                  onClick={() => {
                    setLoadKey((n) => n + 1);
                    setSelectedId(null);
                  }}
                >
                  Refresh snapshot
                </button>
              </div>
            ) : (
              snapshot && (
                <>
                  <section
                    className="finding-summary"
                    aria-label="Snapshot finding"
                  >
                    <div className="finding-state" aria-live="polite">
                      <span
                        key={analysisStatus}
                        className="analysis-stage"
                        data-animate={animateAnalysis}
                      >
                        {busy ? (
                          <Loader2 className="spin" size={14} />
                        ) : failed ? (
                          <CircleAlert size={14} />
                        ) : (
                          <Check size={14} />
                        )}
                        {analysisStatus}
                      </span>
                    </div>
                    <p>
                      {result?.summary ??
                        (mode === "usage"
                          ? `The largest workflow is ${hero.title.toLowerCase()}: ${hero.metrics.conversationCount} of ${snapshot.totals.conversationCount} conversations (${percent(hero.metrics.conversationShare)}).`
                          : `${hero.title} has the most observed friction: ${hero.metrics.observedFrictionCount} of ${hero.metrics.conversationCount} conversations (${percent(hero.metrics.observedFrictionShare)}).`)}
                    </p>
                    <div className="finding-actions">
                      {hero && (
                        <button
                          className="primary-button"
                          onClick={() => select(hero.id)}
                        >
                          {mode === "usage"
                            ? "Inspect this workflow"
                            : "See what goes wrong"}
                          <ArrowRight size={14} />
                        </button>
                      )}
                      <button
                        className="text-button"
                        onClick={(event) => analyze(mode, event.detail > 0)}
                        disabled={busy || snapshot.synthetic}
                        title={snapshot.synthetic ? "Counts are computed during the synthetic rebuild" : "Analyze this snapshot in the live sandbox"}
                      >
                        <RefreshCw size={14} className={busy ? "spin" : ""} />
                        Refresh finding
                      </button>
                      {failed && (
                        <button
                          className="text-link retry"
                          onClick={(event) => analyze(mode, event.detail > 0)}
                        >
                          Retry analysis
                          <RefreshCw size={13} />
                        </button>
                      )}
                      {(run || starting || runError) && (
                        <details className="run-details">
                          <summary>
                            Run details
                            <ChevronDown size={12} />
                          </summary>
                          <div>
                            <b>Live API run</b>
                            {result && (
                              <p>
                                Analysis ranks up to ten named workflows,
                                excluding Other or unclear. The list includes
                                all workflows.
                              </p>
                            )}
                            <p>
                              {run?.executionReceipt?.label ??
                                "Waiting for an execution receipt."}
                            </p>
                            <dl>
                              <dt>State</dt>
                              <dd>
                                {run
                                  ? stageLabels[run.stage]
                                  : runError
                                    ? "Failed"
                                    : "Preparing"}
                              </dd>
                              <dt>Source</dt>
                              <dd>{snapshot?.provenance.label ?? "Published snapshot"}</dd>
                              <dt>Validation</dt>
                              <dd>{run?.validationStatus ?? "Pending"}</dd>
                            </dl>
                            {failed && (
                              <p>
                                {run?.state === "failed"
                                  ? run.error.message
                                  : runError}{" "}
                                {result
                                  ? "The previous result remains visible."
                                  : "The precomputed finding remains visible."}
                              </p>
                            )}
                          </div>
                        </details>
                      )}
                    </div>
                  </section>
                  <div className="browse-heading">
                    <div>
                      <h2>Workflows</h2>
                    </div>
                    <div className="view-control" aria-label="Workflow view">
                      <button
                        aria-pressed={view === "list"}
                        onClick={() => setView("list")}
                      >
                        <List size={16} /> List
                      </button>
                      <button
                        aria-pressed={view === "map"}
                        onClick={() => setView("map")}
                      >
                        <CircleDot size={16} /> Map
                      </button>
                    </div>
                  </div>
                  <label className="sr-only" htmlFor="workflow-search">
                    Search workflows
                  </label>
                  <div className="search-wrap">
                    <Search size={18} />
                    <input
                      ref={searchRef}
                      id="workflow-search"
                      placeholder="Search workflows…"
                      value={query}
                      onChange={(e) => {
                        setCategory(null);
                        setQuery(e.target.value);
                      }}
                      maxLength={240}
                      autoComplete="off"
                    />
                    {query ? (
                      <button
                        className="icon-button"
                        aria-label="Clear search"
                        onClick={() => {
                          setQuery("");
                          searchRef.current?.focus();
                        }}
                      >
                        <X size={16} />
                      </button>
                    ) : (
                      <kbd>/</kbd>
                    )}
                  </div>
                  <div className="search-context" aria-live="polite">
                    {searchState === "loading" ? (
                      <span>
                        <Loader2 className="spin" size={13} />
                        Searching…
                      </span>
                    ) : searchState === "stale" ? (
                      <span>
                        Updated insights are available.
                        <button onClick={reloadSnapshot}>Load latest insights</button>
                      </span>
                    ) : searchState === "error" ? (
                      <span>
                        <CircleAlert size={13} />
                        Search failed.
                        <button onClick={() => setSearchKey((n) => n + 1)}>
                          Retry search
                        </button>
                      </span>
                    ) : query.trim() && matches !== null ? (
                      <span>
                        {matches.length
                          ? `${matches.length} matching workflows`
                          : "No matching published insights"}
                        {!matches.length && (
                          <button
                            onClick={() => {
                              setQuery("");
                              searchRef.current?.focus();
                            }}
                          >
                            Clear search
                          </button>
                        )}
                      </span>
                    ) : category ? (
                      <span>
                        <button onClick={() => setCategory(null)}>
                          All workflows
                        </button>
                        <ChevronRight size={12} />
                        {
                          snapshot.categories.find((c) => c.id === category)
                            ?.title
                        }
                      </span>
                    ) : null}
                  </div>
                  {view === "map" && (
                    <p className="browse-instruction">
                      Zoom into a category, then choose a workflow.
                    </p>
                  )}
                  {view === "map" && (
                    <UsageMap
                      snapshot={snapshot}
                      mode={mode}
                      selected={selectedId}
                      category={category}
                      matches={matches}
                      onSelect={select}
                      onCategory={focusCategory}
                    />
                  )}
                  <section
                    className="ranked-section"
                    aria-label={
                      mode === "usage"
                        ? "Leading workflows by volume"
                        : "Workflows ranked by friction count"
                    }
                  >
                    <div className="ranking-heading">
                      <h2>
                        {mode === "usage" ? "Most used" : "Most friction"}
                      </h2>
                      <span>{visibleRanked.length} workflows</span>
                      <details className="metric-help">
                        <summary>
                          About these metrics <ChevronDown size={12} />
                        </summary>
                        <div>
                          <p>
                            Workflows are customer tasks. Counts measure
                            conversations, not people. Search keeps the original
                            counts.
                          </p>
                          <p>
                            {snapshot.synthetic ? "Friction means corrections, task complaints, or unresolved action errors." : "Friction means corrections, repeated requests, assistant limits, or complaints."} No observed
                            friction does not mean success.
                          </p>
                          {mode === "friction" && (
                            <p>
                              Ranked by conversations with friction, not
                              friction rate.
                            </p>
                          )}
                          {view === "map" && (
                            <p>
                              Circle area shows conversation volume. Outer
                              circles group workflows. Their size and position
                              carry no metric.
                            </p>
                          )}
                        </div>
                      </details>
                    </div>
                    {visibleRanked.length ? (
                      <div className="workflow-rows">
                        <div className="workflow-columns" aria-hidden="true">
                          <span>Customer task</span>
                          <span>Conversations</span>
                          <span>With friction</span>
                          <span />
                        </div>
                        {(view === "map"
                          ? visibleRanked.slice(0, 3)
                          : visibleRanked
                        ).map((c) => (
                          <button
                            className={`workflow-row ${selectedId === c.id ? "selected" : ""}`}
                            key={c.id}
                            aria-pressed={selectedId === c.id}
                            aria-label={`Inspect ${c.title}. ${c.metrics.conversationCount} conversations. ${c.metrics.observedFrictionCount} with observed friction.`}
                            onClick={() => select(c.id)}
                          >
                            <span className="workflow-name">
                              <strong>{c.title}</strong>
                              <small>
                                {
                                  snapshot.categories.find(
                                    (group) => group.id === c.parentId,
                                  )?.title
                                }
                              </small>
                            </span>
                            <span className="workflow-metric">
                              <b>
                                {number(c.metrics.conversationCount)}
                                <span className="metric-unit">
                                  {" "}
                                  conversations
                                </span>
                              </b>
                              <small>
                                {percent(c.metrics.conversationShare)} of all
                              </small>
                            </span>
                            <span className="workflow-metric">
                              <b>
                                {c.metrics.observedFrictionCount}
                                <span className="metric-unit">
                                  {" "}
                                  with friction
                                </span>
                              </b>
                              <small>
                                {percent(c.metrics.observedFrictionShare)}
                              </small>
                            </span>
                            <span className="row-action">
                              Inspect <ArrowRight size={16} />
                            </span>
                          </button>
                        ))}
                        {view === "map" && visibleRanked.length > 3 && (
                          <button
                            className="text-link browse-all"
                            onClick={() => setView("list")}
                          >
                            View all {visibleRanked.length} workflows{" "}
                            <ArrowRight size={15} />
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="ranking-empty">
                        <p>No workflows match. Try a broader search.</p>
                        <button
                          className="text-link"
                          onClick={() => {
                            setCategory(null);
                            setQuery("");
                          }}
                        >
                          Show all workflows <ArrowRight size={15} />
                        </button>
                      </div>
                    )}
                  </section>
                </>
              )
            )}
          </main>
          {selected && snapshot && (
            <DetailPanel
              key={`${snapshot.id}:${selected.id}`}
              cluster={selected}
              snapshot={snapshot}
              adapter={adapter}
              onClose={closeDetails}
            />
          )}
        </div>
      </div>
    </div>
  );
}
