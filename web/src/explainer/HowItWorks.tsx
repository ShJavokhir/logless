import { useEffect, useRef, useState, type MouseEvent } from "react";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import {
  ArrowDown,
  ArrowRight,
  Check,
  ChevronDown,
  Eye,
  LockKeyhole,
  ShieldCheck,
  X,
} from "lucide-react";
import { examples, gateCases, stages, wildChatSamples } from "./content";
import overviewImage from "./analysis.png";
import "./how-it-works.css";

const repo = "https://github.com/ShJavokhir/logless/blob/master/";

function Atlas({
  selected,
  onSelect,
}: {
  selected: number;
  onSelect?: (index: number) => void;
}) {
  const circles = [
    [189, 190, 117],
    [361, 302, 80],
    [365, 121, 57],
    [152, 374, 48],
  ];
  return (
    <svg
      viewBox={onSelect ? "40 45 415 405" : "0 0 520 490"}
      className="hiw-atlas"
      role={onSelect ? "group" : "img"}
      aria-label="Illustrative workflow map; circle sizes are schematic"
    >
      <circle
        cx="263"
        cy="247"
        r="229"
        fill="none"
        stroke="currentColor"
        strokeOpacity=".18"
        strokeDasharray="3 7"
      />
      {circles.map(([x, y, r], i) => (
        <g
          key={i}
          role={onSelect ? "button" : undefined}
          tabIndex={onSelect ? 0 : undefined}
          aria-label={examples[i].workflow}
          aria-pressed={onSelect ? selected === i : undefined}
          onClick={() => onSelect?.(i)}
          onKeyDown={(e) => {
            if (onSelect && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              onSelect(i);
            }
          }}
          className={onSelect ? "hiw-map-node" : ""}
        >
          <circle
            cx={x}
            cy={y}
            r={r}
            fill={
              selected === i
                ? "#002fa7"
                : ["#dbe5fa", "#c3d3f5", "#9fb9ec", "#e3eafa"][i]
            }
          />
          <text
            x={x}
            y={y - 3}
            textAnchor="middle"
            fill={selected === i ? "#f6f8ff" : "#163572"}
            fontSize={r > 90 ? 19 : 16}
          >
            {["Group", "Shared", "Travel", "Morning"][i]}
          </text>
          <text
            x={x}
            y={y + 19}
            textAnchor="middle"
            fill={selected === i ? "#f6f8ff" : "#163572"}
            fontSize={r > 90 ? 19 : 16}
          >
            {["scheduling", "responsibilities", "constraints", "briefings"][i]}
          </text>
        </g>
      ))}
      {!onSelect && (
        <text
          x="262"
          y="478"
          textAnchor="middle"
          fontSize="11"
          fill="currentColor"
          opacity=".6"
        >
          WORKFLOWS, NOT PEOPLE
        </text>
      )}
    </svg>
  );
}

function PipelineFigure({
  stage,
  selected,
  select,
}: {
  stage: number;
  selected: number;
  select: (index: number) => void;
}) {
  const example = examples[selected];
  return (
    <div className="hiw-machine">
      <div className="hiw-machine-label">
        <span>
          {stage === 4 ? <Eye size={14} /> : <LockKeyhole size={14} />}
          {stage === 4 ? "Visible to the team" : "Private processing"}
        </span>
        <span>0{stage + 1} / 05</span>
      </div>
      <div
        className="hiw-example-picker"
        aria-label="Choose an illustrative conversation"
      >
        {examples.map((item, i) => (
          <button
            key={item.label}
            aria-pressed={i === selected}
            onClick={() => select(i)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="hiw-scene" aria-live="polite" aria-atomic="true">
        <div className="hiw-scene-inner" key={stage}>
          {stage === 0 && (
            <div className="hiw-message">
              <span className="hiw-overline">A PERSON ASKS</span>
              <blockquote>“{example.request}”</blockquote>
              <div className="hiw-outcome">
                <span>WHAT HAPPENED NEXT</span>
                <p>{example.outcome}</p>
              </div>
            </div>
          )}
          {stage === 1 && (
            <div className="hiw-facet">
              <span className="hiw-overline">PRIVATE FACET</span>
              <h3>{example.goal}</h3>
              <hr />
              <span className="hiw-overline">RELEVANT OUTCOME</span>
              <p>{example.facet}</p>
              <div className="hiw-facet-stamp">
                <LockKeyhole size={14} /> Generalized ≠ public
              </div>
            </div>
          )}
          {stage === 2 && (
            <div className="hiw-taxonomy">
              <span className="hiw-overline">
                FROM RELATED GOALS TO A WORKFLOW
              </span>
              <div className="hiw-mini-facets">
                <span>{example.goal}</span>
                <span>Related goals</span>
                <span>Similar outcomes</span>
              </div>
              <div className="hiw-connector">↓</div>
              <h3>{example.category}</h3>
              <div className="hiw-theme">{example.workflow}</div>
              <p>
                <strong>Membership:</strong> {example.rule}
              </p>
              <p>
                <strong>Exclude:</strong> {example.exclude}
              </p>
              <span className="hiw-stamp">
                <LockKeyhole size={12} /> Define the rules before classification
              </span>
            </div>
          )}
          {stage === 3 && (
            <div className="hiw-decisions">
              <span className="hiw-overline">ONE PRIMARY WORKFLOW</span>
              <h3>{example.workflow}</h3>
              <div>
                {[
                  "Correction",
                  "Task complaint",
                  "Unresolved action error",
                ].map((signal, i) => (
                  <div className="hiw-decision" key={signal}>
                    <span>{signal}</span>
                    <strong data-observed={example.signals[i] === "Observed"}>
                      {example.signals[i] === "Observed" ? (
                        <Check size={13} />
                      ) : (
                        "—"
                      )}{" "}
                      {example.signals[i]}
                    </strong>
                  </div>
                ))}
              </div>
              <p>
                Each signal is decided independently.
                <br />
                “Unclear” remains a valid answer.
              </p>
            </div>
          )}
          {stage === 4 && (
            <div className="hiw-published">
              <Atlas selected={selected} onSelect={select} />
              <p>
                <strong>{example.workflow}</strong>
                <br />A generalized theme, with counts computed in code.
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="hiw-machine-foot">
        <span className="hiw-small-dot" />
        Illustrative examples · no private data loaded
      </div>
    </div>
  );
}

export default function HowItWorks() {
  const [selected, setSelected] = useState(0);
  const [stage, setStage] = useState(0);
  const [smooth, setSmooth] = useState(true);
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [gate, setGate] = useState<keyof typeof gateCases>("aggregate");
  const lenis = useRef<Lenis | null>(null);
  const progress = useRef<HTMLDivElement>(null);
  const gateCase = gateCases[gate];

  useEffect(() => {
    const previous = document.title;
    document.title = "How Logless works · From conversations to understanding";
    window.scrollTo(0, 0);
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => {
      document.title = previous;
      media.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    if (reduced || !smooth) return;
    const instance = new Lenis({
      autoRaf: true,
      lerp: 0.1,
      smoothWheel: true,
      syncTouch: false,
    });
    lenis.current = instance;
    return () => {
      instance.destroy();
      lenis.current = null;
    };
  }, [smooth, reduced]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const height = document.documentElement.scrollHeight - innerHeight;
      if (progress.current)
        progress.current.style.transform = `scaleX(${height > 0 ? scrollY / height : 0})`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    update();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  function jump(id: string, event: MouseEvent<HTMLButtonElement>) {
    const target = document.getElementById(id);
    if (!target) return;
    const immediate = reduced || event.detail === 0;
    // Lenis reads scroll-margin-top from the target; don't subtract the header twice.
    if (lenis.current) lenis.current.scrollTo(target, { immediate });
    else target.scrollIntoView({ behavior: "instant", block: "start" });
    target.focus({ preventScroll: true });
  }

  return (
    <div className="hiw" data-reduced={reduced}>
      <button className="hiw-skip" onClick={(e) => jump("hiw-start", e)}>
        Skip to the explanation
      </button>
      <header className="hiw-header">
        <a href="#/" className="hiw-logo" aria-label="Logless home">
          <svg viewBox="0 0 35 28" width="31" height="25" aria-hidden="true">
            <circle cx="13" cy="14" r="10" />
            <circle cx="23" cy="14" r="10" />
          </svg>
          logless
        </a>
        <span className="hiw-header-context">A FIELD GUIDE</span>
        <nav aria-label="Page sections">
          <button onClick={(e) => jump("hiw-pipeline", e)}>The pipeline</button>
          <button onClick={(e) => jump("hiw-answers", e)}>
            Verified answers
          </button>
          <button onClick={(e) => jump("hiw-boundaries", e)}>
            The boundaries
          </button>
        </nav>
        <a className="hiw-workspace" href="#/explore">
          Explore Logless <ArrowRight size={15} />
        </a>
        <div ref={progress} className="hiw-progress" />
      </header>

      <main id="hiw-start" tabIndex={-1}>
        <section className="hiw-hero hiw-wrap">
          <div className="hiw-hero-copy">
            <p className="hiw-overline">HOW IT WORKS / LOGLESS</p>
            <h1>
              Understand
              <br />
              the work.
              <br />
              <em>
                Protect the
                <br className="hiw-hero-break" /> conversation.
              </em>
            </h1>
            <p className="hiw-lede">
              Understand what people need—without reading their chats.
            </p>
            <p className="hiw-hero-definition">
              Logless turns assistant conversations into shared patterns: what
              people do, where they struggle, and what to build next.
            </p>
            <button
              className="hiw-primary"
              onClick={(e) => jump("hiw-pipeline", e)}
            >
              Follow a conversation <ArrowDown size={16} />
            </button>
          </div>
          <div className="hiw-hero-art">
            <div className="hiw-orbit-label">MANY PRIVATE MOMENTS.</div>
            <div className="hiw-floating-note">
              <LockKeyhole size={12} />
              <span>“Can you move dinner to Friday?”</span>
            </div>
            <div className="hiw-floating-note hiw-note-two">
              <LockKeyhole size={12} />
              <span>“What needs my attention today?”</span>
            </div>
            <Atlas selected={0} />
            <div className="hiw-hero-art-caption">
              <span>ONE SHARED PICTURE.</span>
              <p>A map of needs, not a window into someone’s life.</p>
            </div>
          </div>
        </section>

        <div className="hiw-reading-bar hiw-wrap">
          <span>
            <span className="hiw-small-dot" /> A 4-minute interactive guide
          </span>
          <button
            aria-pressed={smooth && !reduced}
            disabled={reduced}
            onClick={() => setSmooth((value) => !value)}
          >
            {reduced
              ? "Reduced motion enabled"
              : `Smooth scroll ${smooth ? "on" : "off"}`}
            <span className="hiw-switch" />
          </button>
        </div>

        <section className="hiw-introduction hiw-wrap">
          <p className="hiw-overline">THE QUESTION BEHIND THE PRODUCT</p>
          <h2>
            “What are people trying to do—
            <br />
            <em>and what isn’t working?”</em>
          </h2>
          <div className="hiw-intro-columns">
            <p>
              Message counts tell you how much. Logless helps you understand
              why.
            </p>
            <p>
              Find recurring goals. See where people struggle. Ask questions
              about the patterns.
            </p>
          </div>
        </section>

        <section
          className="hiw-samples hiw-wrap"
          aria-labelledby="hiw-samples-title"
        >
          <div className="hiw-samples-heading">
            <div>
              <p className="hiw-overline">A LOOK AT THE SOURCE DATA</p>
              <h2 id="hiw-samples-title">What one WildChat row contains.</h2>
            </div>
            <p>
              WildChat records real user–ChatGPT exchanges. These three public
              rows show different tasks and languages. They are separate from
              the authored examples in the walkthrough below.
            </p>
          </div>
          <div className="hiw-sample-grid">
            {wildChatSamples.map((sample) => (
              <article className="hiw-sample-card" key={sample.row}>
                <div className="hiw-sample-topline">
                  <span>{sample.topic}</span>
                  <span>ROW {sample.row}</span>
                </div>
                <p className="hiw-sample-meta">{sample.meta}</p>
                <div className="hiw-sample-messages">
                  {sample.messages.map((message, index) => (
                    <div className="hiw-sample-message" key={index}>
                      <span>
                        {message.role}
                        {"summarized" in message
                          ? " · summarized"
                          : " · excerpt"}
                      </span>
                      <p
                        lang={
                          sample.row === 4 && !("summarized" in message)
                            ? "ar"
                            : undefined
                        }
                        dir="auto"
                      >
                        {message.text}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="hiw-sample-note">{sample.note}</p>
                <a
                  href={`https://datasets-server.huggingface.co/rows?dataset=allenai%2FWildChat&config=default&split=train&offset=${sample.row}&length=1`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View full source row <ArrowRight size={13} />
                </a>
              </article>
            ))}
          </div>
          <p className="hiw-samples-caption">
            Quoted excerpts retain the source wording; ellipses mark cuts.
            Summaries and English explanations are ours. These rows come from
            the public WildChat dataset, not necessarily the Logless demo
            sample.
          </p>
        </section>

        <section
          id="hiw-pipeline"
          tabIndex={-1}
          className="hiw-pipeline hiw-wrap"
        >
          <div className="hiw-section-heading">
            <span className="hiw-section-number">01</span>
            <div>
              <p className="hiw-overline">BUILD THE PICTURE</p>
              <h2>
                From a moment
                <br />
                to a meaningful pattern.
              </h2>
            </div>
            <p>
              Choose an example.
              <br />
              Follow it through five steps.
            </p>
          </div>
          <div className="hiw-step-nav" aria-label="Pipeline steps">
            {stages.map((item, i) => (
              <button
                key={item.short}
                aria-current={stage === i ? "step" : undefined}
                aria-label={`Step ${i + 1}: ${item.short}`}
                onClick={() => setStage(i)}
              >
                <span>0{i + 1}</span>
                <span>{item.short}</span>
              </button>
            ))}
          </div>
          <div className="hiw-pipeline-layout">
            <div className="hiw-step-copy">
              {stages.map((item, i) => (
                <article
                  key={item.short}
                  id={`hiw-step-${i}`}
                  tabIndex={-1}
                  data-pipeline-step={i}
                  className={stage === i ? "is-current" : ""}
                >
                  <span className="hiw-overline">
                    0{i + 1} / {item.role}
                  </span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                  <details>
                    <summary>
                      Under the hood <ChevronDown size={13} />
                    </summary>
                    <p>{item.detail}</p>
                  </details>
                </article>
              ))}
            </div>
            <div className="hiw-sticky">
              <PipelineFigure
                stage={stage}
                selected={selected}
                select={setSelected}
              />
            </div>
          </div>
          <div className="hiw-evolve">
            <span>↻</span>
            <div>
              <h3>The map can evolve.</h3>
              <p>
                Review unclear assignments, refine or split themes, and
                reclassify against a versioned taxonomy. A useful map should
                make room for new kinds of work.
              </p>
            </div>
          </div>
        </section>

        <section className="hiw-overview hiw-wrap">
          <details>
            <summary>
              <span>
                <span className="hiw-overline">THE WHOLE PICTURE</span>
                <strong>See all five steps together</strong>
              </span>
              <span className="hiw-expand">+</span>
            </summary>
            <figure>
              <a href={overviewImage} target="_blank" rel="noreferrer">
                <img
                  src={overviewImage}
                  alt="Logless overview: illustrative personal-assistant conversations become private facets, workflow themes, Jev decisions and published insights. Only aggregates cross the publication boundary."
                  loading="lazy"
                />
              </a>
              <figcaption>
                Conceptual overview. The deployed pipeline also uses embeddings
                and privacy checks. Open the image for a larger view.
              </figcaption>
            </figure>
          </details>
        </section>

        <section id="hiw-answers" tabIndex={-1} className="hiw-answers">
          <div className="hiw-wrap">
            <div className="hiw-section-heading">
              <span className="hiw-section-number">02</span>
              <div>
                <p className="hiw-overline">ASK A NEW QUESTION</p>
                <h2>
                  An answer should be
                  <br />
                  <em>computed. Then checked.</em>
                </h2>
              </div>
            </div>
            <div className="hiw-answer-intro">
              <p>“Which workflows have the most unresolved problems?”</p>
              <span>
                When a question needs calculation, Logless doesn’t ask a model
                to guess a number. It asks an agent to write the programs that
                calculate it.
              </span>
            </div>
            <ol className="hiw-execution-steps">
              <li>
                <b>01</b>
                <h3>Plan</h3>
                <p>
                  GLM 5.3 on Vultr turns the question into a bounded plan.
                  Unsupported requests stop here.
                </p>
              </li>
              <li>
                <b>02</b>
                <h3>Write twice</h3>
                <p>
                  Two separate calls write programs: one with pandas, one with
                  plain Python. The writer sees a data dictionary, not rows.
                </p>
              </li>
              <li>
                <b>03</b>
                <h3>Run in isolation</h3>
                <p>
                  Each program runs in a fresh gVisor container on a separate
                  Vultr VM, with typed rows and no conversation text.
                </p>
              </li>
              <li>
                <b>04</b>
                <h3>Verify, then explain</h3>
                <p>
                  The app checks the outputs and requires agreement. Verified
                  numbers fill the model’s explanation.
                </p>
              </li>
            </ol>
            <div className="hiw-gate-lab">
              <div className="hiw-lab-heading">
                <div>
                  <p className="hiw-overline">TRY THE OUTPUT GATE</p>
                  <h3>What should reach the team?</h3>
                </div>
                <span>Interactive illustration · no code is executed</span>
              </div>
              <div
                className="hiw-case-picker"
                aria-label="Choose an output scenario"
              >
                {Object.entries(gateCases).map(([key, item]) => (
                  <button
                    key={key}
                    aria-pressed={gate === key}
                    onClick={() => setGate(key as keyof typeof gateCases)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="hiw-gate-content">
                <div className="hiw-programs">
                  <div>
                    <span>PROGRAM A · PANDAS</span>
                    <code>{gateCase.a}</code>
                  </div>
                  <div>
                    <span>PROGRAM B · PYTHON</span>
                    <code>{gateCase.b}</code>
                  </div>
                  <p>Invented values · simplified output format.</p>
                </div>
                <div className="hiw-gate-result" aria-live="polite">
                  <span className="hiw-gate-icon">
                    {gateCase.pass ? (
                      <ShieldCheck size={26} />
                    ) : (
                      <X size={26} />
                    )}
                  </span>
                  <h4>{gateCase.status}</h4>
                  <p>{gateCase.detail}</p>
                </div>
              </div>
            </div>
            <div className="hiw-sandbox-limits">
              <span>
                <LockKeyhole size={15} /> No network
              </span>
              <span>No credentials</span>
              <span>Read-only inputs</span>
              <span>512 MiB memory</span>
              <span>10-second deadline</span>
              <span>Destroyed after the run</span>
            </div>
            <p className="hiw-answer-note">
              The map is aggregated by trusted application code. These
              disposable sandboxes are for agent-written programs answering live
              questions.
            </p>
          </div>
        </section>

        <section
          id="hiw-boundaries"
          tabIndex={-1}
          className="hiw-boundaries hiw-wrap"
        >
          <div className="hiw-section-heading">
            <span className="hiw-section-number">03</span>
            <div>
              <p className="hiw-overline">KNOW THE BOUNDARIES</p>
              <h2>
                Private from whom?
                <br />
                <em>It’s a fair question.</em>
              </h2>
            </div>
          </div>
          <div className="hiw-boundary-layout">
            <p className="hiw-boundary-intro">
              Privacy here is a set of explicit boundaries. It isn’t a promise
              that no system ever sees the data.
            </p>
            <div className="hiw-boundary-rows">
              <div>
                <span>01</span>
                <h3>The product team</h3>
                <p>
                  Sees published workflows, aggregate metrics, checked answers
                  and sanitized run receipts. No transcript browser or
                  individual-record export.
                </p>
              </div>
              <div>
                <span>02</span>
                <h3>The app & model providers</h3>
                <p>
                  The app holds private records and credentials. External model
                  providers process submitted text or facets as part of the
                  analysis.
                </p>
              </div>
              <div>
                <span>03</span>
                <h3>The execution sandbox</h3>
                <p>
                  Receives typed rows with randomized identifiers, code and a
                  bounded contract. It gets no conversation text, model keys or
                  network access.
                </p>
              </div>
            </div>
          </div>
          <div className="hiw-faq">
            <details>
              <summary>
                Does this guarantee anonymity? <ChevronDown size={17} />
              </summary>
              <p>
                No. Logless does not provide differential privacy or a minimum
                cluster-size guarantee. Generalization and output gates reduce
                exposure, but sensitive inference and leaks remain possible.
              </p>
            </details>
            <details>
              <summary>
                Can two programs agree and still be wrong?{" "}
                <ChevronDown size={17} />
              </summary>
              <p>
                Yes. Both programs come from the same model family and can share
                mistakes. Agreement and published-map checks improve
                verification; they do not prove every answer is correct.
              </p>
            </details>
            <details>
              <summary>
                Are the examples on this page real conversations?{" "}
                <ChevronDown size={17} />
              </summary>
              <p>
                No. They are authored personal-assistant scenarios. The
                documented demo uses WildChat conversations and planted
                evaluation fixtures. These examples are not findings about Muse,
                Grok, OpenClaw or any other assistant.
              </p>
            </details>
            <details>
              <summary>
                What can the team do with the result? <ChevronDown size={17} />
              </summary>
              <p>
                Explore workflow volume and friction, search published themes
                with Jev, and ask bounded analytical questions. Published
                metrics can also support a ranked roadmap, product briefs and a
                narrated video summary.
              </p>
            </details>
          </div>
        </section>

        <section className="hiw-closing hiw-wrap">
          <span className="hiw-overline">FROM UNDERSTANDING TO ACTION</span>
          <h2>
            Better questions.
            <br />
            <em>A clearer next step.</em>
          </h2>
          <p>
            Discover the workflows people depend on.
            <br />
            Find the friction worth fixing. Build from evidence.
          </p>
          <a href="#/explore" className="hiw-primary">
            Explore the workspace <ArrowRight size={16} />
          </a>
          <a href="#/" className="hiw-secondary">
            Take the live product tour ↗
          </a>
        </section>
      </main>
      <footer className="hiw-footer hiw-wrap">
        <a className="hiw-logo" href="#/">
          logless
        </a>
        <p>Inspired by Clio. Built for understanding.</p>
        <nav aria-label="Technical sources">
          <a href={`${repo}README.md`} target="_blank" rel="noreferrer">
            README ↗
          </a>
          <a
            href={`${repo}docs/ARCHITECTURE.md`}
            target="_blank"
            rel="noreferrer"
          >
            Architecture ↗
          </a>
          <a href={`${repo}docs/SECURITY.md`} target="_blank" rel="noreferrer">
            Security ↗
          </a>
        </nav>
      </footer>
    </div>
  );
}
