"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Layers2,
  Loader2,
  Menu,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  createDemoAdapter,
  type AnalysisIntent,
  type AnalysisResult,
  type DemoAdapterOptions,
  type DemoRun,
  type Snapshot,
} from "./data";
import { DetailPanel } from "./detail-panel";
import { UsageMap } from "./usage-map";
import { number, percent } from "./format";

function devOptions(): DemoAdapterOptions {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined")
    return {};
  const params = new URLSearchParams(window.location.search);
  const failure = params.get("demoFailure");
  return {
    empty: params.get("demoState") === "empty",
    ...(failure && ["snapshot", "search", "analysis", "story"].includes(failure)
      ? { failure: failure as DemoAdapterOptions["failure"] }
      : {}),
  };
}

const stageLabels = {
  planning: "Preparing analysis",
  executing: "Running simulated analysis",
  validating: "Checking mock results",
  explaining: "Preparing finding",
  completed: "Analysis complete",
  failed: "Analysis interrupted",
};

export function Explorer() {
  const [adapter, setAdapter] = useState(() => createDemoAdapter(devOptions()));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotState, setSnapshotState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [loadKey, setLoadKey] = useState(0);
  const [mode, setMode] = useState<AnalysisIntent>("usage");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<string[] | null>(null);
  const [searchState, setSearchState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [searchKey, setSearchKey] = useState(0);
  const [run, setRun] = useState<DemoRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState(false);
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
        .catch(() => {
          if (!controller.signal.aborted) {
            setMatches(null);
            setSearchState("error");
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
  function focusCategory(id: string) {
    setCategory((current) => (current === id ? null : id));
    setExpanded(id);
    setMobileNav(false);
  }
  function resetView() {
    setCategory(null);
    setQuery("");
    setSelectedId(null);
    setMobileNav(false);
  }

  async function analyze(intent: AnalysisIntent) {
    if (!snapshot || pendingIntent.current === intent) return;
    analysisController.current?.abort();
    const controller = new AbortController();
    analysisController.current = controller;
    pendingIntent.current = intent;
    setMode(intent);
    setRun(null);
    setRunError(false);
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
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
    } catch {
      if (!controller.signal.aborted) {
        setStarting(false);
        setRunError(true);
      }
    } finally {
      if (!controller.signal.aborted) pendingIntent.current = null;
    }
  }

  const selected = snapshot?.clusters.find((c) => c.id === selectedId) ?? null;
  const ranked = useMemo(() => {
    if (!snapshot) return [];
    const order = results[mode]?.orderedClusterIds;
    return [...snapshot.clusters].sort((a, b) =>
      order
        ? order.indexOf(a.id) - order.indexOf(b.id)
        : mode === "usage"
          ? b.metrics.conversationCount - a.metrics.conversationCount
          : b.metrics.observedFrictionCount - a.metrics.observedFrictionCount,
    );
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

  return (
    <div className={`workspace ${selected ? "has-detail" : ""}`}>
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
          <span className="workspace-symbol">M</span>
          <div>
            <strong>Muse</strong>
            <span>Synthetic demo</span>
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
          {hero && (
            <div className="sidebar-finding">
              <div className="nav-section-label">WORTH A CLOSER LOOK</div>
              <button onClick={() => select(hero.id)}>
                <span className="finding-glyph">
                  <CircleDot size={17} />
                </span>
                <span>
                  {hero.title}
                  <small>
                    {percent(hero.metrics.observedFrictionShare)} observed
                    friction
                  </small>
                </span>
                <ArrowUpRight size={14} />
              </button>
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <details>
            <summary>
              <ShieldCheck size={16} />
              Aggregate insights only
              <ChevronDown size={13} />
            </summary>
            <p>
              This demo contains authored aggregate fixtures. No transcripts or
              individual records are available. Synthetic data is not a privacy
              guarantee.
            </p>
          </details>
          <span className="snapshot-note">One snapshot. A wider view.</span>
        </div>
      </aside>

      <div className="workspace-content">
        <header className="topbar">
          <div>
            <Layers2 size={16} />
            <span>Explorer</span>
            <ChevronRight size={13} />
            <span className="muted">
              {category
                ? snapshot?.categories.find((c) => c.id === category)?.title
                : "All workflows"}
            </span>
          </div>
          <span className="demo-indicator">
            <span />
            Demo · Mock data
          </span>
        </header>
        <div className="content-columns">
          <main id="explorer" tabIndex={-1} className="explorer">
            <div className="page-heading">
              <div>
                <h1>
                  {mode === "usage"
                    ? "What are people doing?"
                    : "What’s not working?"}
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
            <div className="explorer-toolbar">
              <div className="mode-control" aria-label="Analysis question">
                <button
                  aria-label="Usage: What are people doing?"
                  aria-pressed={mode === "usage"}
                  onClick={() => analyze("usage")}
                  disabled={
                    !snapshot ||
                    snapshot.clusters.length === 0 ||
                    (busy && mode === "usage")
                  }
                >
                  <Layers2 size={15} />
                  Usage
                </button>
                <button
                  aria-label="Friction: What’s not working?"
                  aria-pressed={mode === "friction"}
                  onClick={() => analyze("friction")}
                  disabled={
                    !snapshot ||
                    snapshot.clusters.length === 0 ||
                    (busy && mode === "friction")
                  }
                >
                  <CircleAlert size={15} />
                  Friction
                </button>
              </div>
              <button
                aria-label="Run analysis"
                className="text-button run-again"
                onClick={() => analyze(mode)}
                disabled={busy || !snapshot || snapshot.clusters.length === 0}
              >
                <RefreshCw size={14} className={busy ? "spin" : ""} />
                <span>Run analysis</span>
              </button>
            </div>

            {snapshotState === "loading" ? (
              <div className="main-state" role="status">
                <Loader2 className="spin" size={24} />
                <h2>Opening your snapshot</h2>
                <p>Loading local mock insights…</p>
              </div>
            ) : snapshotState === "error" ? (
              <div className="main-state" role="alert">
                <CircleAlert size={25} />
                <h2>The snapshot couldn’t load</h2>
                <p>The demo is still available. Try loading it again.</p>
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
                <p>A complete snapshot will bring workflows into view.</p>
                <button
                  className="primary-button"
                  onClick={() => {
                    setAdapter(createDemoAdapter());
                    setSelectedId(null);
                  }}
                >
                  Load demo snapshot
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
                      {busy ? (
                        <Loader2 className="spin" size={14} />
                      ) : failed ? (
                        <CircleAlert size={14} />
                      ) : (
                        <Check size={14} />
                      )}
                      <span>
                        {busy
                          ? run
                            ? stageLabels[run.stage]
                            : "Preparing analysis"
                          : failed
                            ? "Simulated analysis interrupted"
                            : result
                              ? "Analysis complete · Simulated"
                              : "Ready from this snapshot"}
                      </span>
                      {!busy && !failed && !result && (
                        <span className="precomputed-label">
                          Precomputed mock
                        </span>
                      )}
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
                          className="text-link"
                          onClick={() => select(hero.id)}
                        >
                          {mode === "usage"
                            ? "Explore the finding"
                            : "Explore observed friction"}
                          <ArrowRight size={14} />
                        </button>
                      )}
                      {failed && (
                        <button
                          className="text-link retry"
                          onClick={() => analyze(mode)}
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
                            <b>Simulated local run</b>
                            <p>
                              {run?.executionReceipt?.label ??
                                "No model or sandbox is running."}
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
                              <dd>Authored mock snapshot</dd>
                              <dt>Validation</dt>
                              <dd>
                                {run?.validationStatus ?? "Pending"} · simulated
                              </dd>
                            </dl>
                            {failed && (
                              <p>
                                Mock failure.{" "}
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
                  <div className="search-wrap">
                    <Search size={18} />
                    <input
                      ref={searchRef}
                      aria-label="Find a workflow"
                      placeholder="Find a workflow…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
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
                        Finding matching workflows…
                      </span>
                    ) : searchState === "error" ? (
                      <span>
                        <CircleAlert size={13} />
                        Search couldn’t finish. Browsing is available.
                        <button onClick={() => setSearchKey((n) => n + 1)}>
                          Retry search
                        </button>
                      </span>
                    ) : query.trim() && matches !== null ? (
                      <span>
                        {matches.length
                          ? `${matches.length} matching workflows · Original counts unchanged`
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
                    ) : (
                      <span>
                        Explore a circle to see the workflow behind it.
                      </span>
                    )}
                  </div>
                  <UsageMap
                    snapshot={snapshot}
                    mode={mode}
                    selected={selectedId}
                    category={category}
                    matches={matches}
                    onSelect={select}
                    onCategory={focusCategory}
                  />
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
                        {mode === "usage"
                          ? "Leading workflows"
                          : "Where friction adds up"}
                      </h2>
                      <span>
                        {mode === "usage"
                          ? "Conversations · share of all"
                          : "With friction / conversations · share"}
                      </span>
                    </div>
                    {visibleRanked.length ? (
                      visibleRanked.slice(0, 3).map((c, index) => (
                        <button
                          className={`ranking-row ${selectedId === c.id ? "selected" : ""}`}
                          key={c.id}
                          onClick={() => select(c.id)}
                        >
                          <span className="ranking-position">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="ranking-title">{c.title}</span>
                          <span className="ranking-value">
                            {mode === "usage"
                              ? c.metrics.conversationCount
                              : `${c.metrics.observedFrictionCount} / ${c.metrics.conversationCount}`}
                          </span>
                          <span className="ranking-share">
                            {percent(
                              mode === "usage"
                                ? c.metrics.conversationShare
                                : c.metrics.observedFrictionShare,
                            )}
                          </span>
                          <ArrowUpRight size={14} />
                        </button>
                      ))
                    ) : (
                      <p className="ranking-empty">
                        No workflows match this view.{" "}
                        <button
                          className="text-link"
                          onClick={() => {
                            setCategory(null);
                            setQuery("");
                          }}
                        >
                          Show all workflows
                        </button>
                      </p>
                    )}
                  </section>
                  <footer className="explorer-footer">
                    <span>
                      <ShieldCheck size={13} />
                      Synthetic aggregates · No individual records
                    </span>
                    <details>
                      <summary>
                        How to read this
                        <ChevronDown size={12} />
                      </summary>
                      <p>
                        Circle area shows conversation volume. Outer circles
                        group related workflows; their area is not a metric.
                        Position has no semantic meaning. Friction is observed
                        corrections, complaints, or unresolved action errors.
                        Missing negative feedback does not establish success.
                      </p>
                    </details>
                  </footer>
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
