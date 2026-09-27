"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Eye, LockKeyhole, Pause, Play, RotateCcw } from "lucide-react";
import { createLiveAdapter, type Snapshot } from "./data";

const DURATION = 26_000;
const MOVE = "cubic-bezier(0.77, 0, 0.175, 1)";
const coordinate = (value: number) => Math.round(value * 100) / 100;
const CHAPTERS = [
  { title: "Conversations", tag: "THE STARTING POINT", start: 0, pose: .07, heading: "A thousand different moments.", copy: "Every conversation starts with something a person wants to do. The details stay in private processing." },
  { title: "Abstract", tag: "01 / MAP · GLM 5.3", start: .17, pose: .27, heading: "Keep the meaning. Leave the details.", copy: "GLM turns each interaction into a compact description of its goal and outcome, without personal details." },
  { title: "Discover", tag: "02 / CLUSTER · GLM 5.3", start: .35, pose: .44, heading: "Individual goals find common ground.", copy: "Related goals form workflow themes. Each theme gets a name, membership rules, and exclusions. Then the taxonomy is frozen." },
  { title: "Classify", tag: "03 / REDUCE · JEV", start: .53, pose: .65, heading: "One workflow. Three independent signals.", copy: "Jev assigns one workflow, with Other or unclear as a fallback. It separately checks correction, complaint, and unresolved action error." },
  { title: "Publish", tag: "04 / AGGREGATE · CODE", start: .77, pose: .96, heading: "Now the bigger picture can be shared.", copy: "Code counts the decisions. Only published cluster summaries and aggregate metrics reach the explorer. Private records stay behind." },
] as const;

type Pose = { at: number; x?: number; y?: number; s?: number; r?: number; a?: number };
function keyframes(poses: Pose[]): Keyframe[] {
  return poses.map(({ at, x = 0, y = 0, s = 1, r = 0, a = 1 }) => ({
    offset: coordinate(at * 1000) / 1000, transform: `translate(${coordinate(x)}px, ${coordinate(y)}px) rotate(${r}deg) scale(${s})`, opacity: a, easing: MOVE,
  }));
}

function Motion({ poses, children, className }: { poses: Pose[]; children: ReactNode; className?: string }) {
  const frames = keyframes(poses);
  return <g className={className} data-story-motion={JSON.stringify(frames)} style={{ transform: String(frames[0].transform), opacity: Number(frames[0].opacity) }}>{children}</g>;
}

function scene(start: number, end: number, x = 0, y = 0): Pose[] {
  return [
    { at: 0, x, y: y + 14, a: start === 0 ? 1 : 0 },
    ...(start ? [{ at: start, x, y: y + 14, a: 0 }, { at: start + .045, x, y, a: 1 }] : []),
    { at: end, x, y, a: 1 },
    ...(end < .95 ? [{ at: end + .04, x, y: y - 12, a: 0 }, { at: 1, x, y: y - 12, a: 0 }] : []),
  ];
}

function SvgLock({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`} fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="0" y="5" width="10" height="8" rx="2" /><path d="M2 5V3a3 3 0 0 1 6 0v2" /></g>;
}

function Conversation({ small = false }: { small?: boolean }) {
  return <g>
    <rect width="286" height="196" rx="10" className="story-paper" />
    <circle cx="23" cy="24" r="4" fill="#002fa7" />
    <text x="36" y="28" className="story-micro">A FICTIONAL CONVERSATION</text>
    <text x="22" y="64" className="story-conversation"><tspan x="22">Can you find a time</tspan><tspan x="22" dy="27">everyone can make?</tspan></text>
    <path d="M22 110H264" stroke="#e4e4de" />
    <text x="22" y="134" className="story-small">A time is agreed. The calendar</text>
    <text x="22" y="153" className="story-small">invite fails to send.</text>
    {!small && <text x="22" y="178" className="story-micro story-muted">GOAL + CONTEXT + OUTCOME</text>}
  </g>;
}

function Abstraction({ secondary = false }: { secondary?: boolean }) {
  return <g>
    <rect width={secondary ? 204 : 286} height={secondary ? 116 : 196} rx="10" className="story-paper" />
    <text x="22" y="29" className="story-micro story-blue">{secondary ? "PRIVATE ABSTRACTION" : "THE DETAILS FALL AWAY"}</text>
    <text x="22" y="63" className="story-card-title">{secondary ? "Write a clear reply" : "Coordinate a group"}</text>
    <text x="22" y="86" className="story-card-title">{secondary ? "" : "meeting"}</text>
    {!secondary && <><path d="M22 111H264" stroke="#e4e4de" /><text x="22" y="137" className="story-micro">RELEVANT OUTCOME</text><text x="22" y="161" className="story-small">Invite not delivered.</text><SvgLock x={252} y={171} /></>}
    {secondary && <text x="22" y="92" className="story-small">Draft accepted.</text>}
  </g>;
}

function Decisions({ compact = false }: { compact?: boolean }) {
  const width = compact ? 326 : 344;
  return <g>
    <rect width={width} height="246" rx="10" fill="#fff" stroke="#c9d5f3" />
    <rect x="16" y="16" width="39" height="25" rx="4" fill="#002fa7" />
    <text x="24" y="33" className="story-micro story-white">JEV</text>
    <text x="66" y="33" className="story-micro">FROZEN TAXONOMY</text>
    <text x="20" y="72" className="story-micro story-muted">PRIMARY WORKFLOW</text>
    <text x="20" y="100" className="story-card-title">Group coordination</text>
    <path d={`M20 120H${width - 20}`} stroke="#e4e4de" />
    {[['Correction', 'Not observed'], ['Task complaint', 'Not observed'], ['Unresolved action error', 'Observed']].map(([name, value], i) => <g key={name}>
      <text x="20" y={148 + i * 32} className="story-small">{name}</text>
      <circle cx={width - 105} cy={144 + i * 32} r="3" fill={i === 2 ? '#002fa7' : '#a3a59d'} />
      <text x={width - 96} y={148 + i * 32} className={`story-verdict ${i === 2 ? 'story-blue' : ''}`}>{value}</text>
    </g>)}
  </g>;
}

const points = Array.from({ length: 54 }, (_, i) => {
  const group = i % 3, n = Math.floor(i / 3), angle = n * 2.39996;
  const radius = Math.sqrt(n + .5) * 16;
  // Rounded coordinates render identically across server and browser math engines.
  return { group, dx: coordinate(Math.cos(angle) * radius), dy: coordinate(Math.sin(angle) * radius) };
});

function PublishedMap({ snapshot, compact = false }: { snapshot: Snapshot | null; compact?: boolean }) {
  const total = snapshot?.totals.conversationCount;
  return <g>
    <circle r={compact ? 128 : 139} fill="#f0f3fb" stroke="#d3dcf0" strokeDasharray="3 5" />
    <circle cx="-28" cy="-20" r="79" fill="#002fa7" />
    <circle cx="70" cy="45" r="44" fill="#6381c9" />
    <circle cx="-28" cy="89" r="26" fill="#b8c7e8" />
    <circle cx="73" cy="-54" r="24" fill="#91a8da" />
    <text x="-28" y="-32" textAnchor="middle" className="story-map-number" fill="#fff">{total?.toLocaleString() ?? 'Shared'}</text>
    <text x="-28" y="-8" textAnchor="middle" className="story-map-label" fill="#dce5ff">{total !== undefined ? 'conversations' : 'patterns'}</text>
    <text x="-28" y="10" textAnchor="middle" className="story-map-label" fill="#dce5ff">{snapshot?.synthetic ? 'synthetic dataset' : total === undefined ? 'not private records' : 'in this snapshot'}</text>
    <text x="70" y="43" textAnchor="middle" fill="white" className="story-map-small-number">{snapshot?.clusters.length ?? '↗'}</text>
    <text x="70" y="60" textAnchor="middle" fill="white" className="story-map-label">workflows</text>
  </g>;
}

const StoryVisual = memo(function StoryVisual({ snapshot, compact = false }: { snapshot: Snapshot | null; compact?: boolean }) {
  if (compact) return <svg className="story-visual story-visual-mobile" viewBox="0 0 400 390" aria-hidden="true">
    <defs><pattern id="story-mobile-dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#dedfd8" /></pattern></defs>
    <rect width="400" height="390" fill="url(#story-mobile-dots)" />
    <Motion poses={scene(0, .15, 57, 84)}><Conversation /></Motion>
    <Motion poses={scene(.18, .33, 57, 84)}><Abstraction /></Motion>
    <Motion poses={scene(.36, .51)}>
      {[[128, 145, 62, 'Coordination'], [276, 187, 57, 'Writing'], [148, 278, 49, 'Planning']].map(([x, y, r, name]) => <g key={name}>
        <circle cx={x} cy={y} r={r} fill="#e9eef9" stroke="#c7d3eb" />
        {points.filter((p) => p.group === 0).slice(0, 13).map((p, i) => <circle key={i} cx={coordinate(Number(x) + p.dx * .66)} cy={coordinate(Number(y) + p.dy * .66 - 12)} r="3" fill="#002fa7" />)}
        <text x={x} y={Number(y) + 33} textAnchor="middle" className="story-small story-blue">{name}</text>
      </g>)}
      <text x="200" y="49" textAnchor="middle" className="story-micro">NAME THE THEMES. FREEZE THE RULES.</text>
    </Motion>
    <Motion poses={scene(.54, .75, 37, 66)}><Decisions compact /></Motion>
    <Motion poses={scene(.79, 1, 200, 181)}><PublishedMap snapshot={snapshot} compact /><text x="0" y="171" textAnchor="middle" className="story-small story-blue">Published aggregates only</text></Motion>
  </svg>;

  return <svg className="story-visual story-visual-desktop" viewBox="0 0 1200 440" aria-hidden="true">
    <defs>
      <pattern id="story-dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".65" fill="#dadcd5" /></pattern>
      <pattern id="story-boundary" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><line y2="8" stroke="#cbd3df" strokeWidth="2" /></pattern>
      <clipPath id="story-private-clip"><rect width="862" height="440" /></clipPath>
    </defs>
    <rect width="863" height="440" fill="url(#story-dots)" />
    <rect x="863" width="8" height="440" fill="url(#story-boundary)" />
    <line x1="39" y1="238" x2="1164" y2="238" stroke="#d9ded8" strokeDasharray="2 6" />
    <text x="42" y="38" className="story-micro story-muted">PRIVATE PROCESSING</text>
    <SvgLock x={194} y={26} />
    <text x="906" y="38" className="story-micro story-blue">VISIBLE TO YOUR TEAM</text>
    <circle cx="1030" cy="238" r="139" fill="none" stroke="#e5e8e0" strokeDasharray="3 5" />
    <Motion poses={[{ at: 0, a: 1 }, { at: .78, a: 1 }, { at: .84, a: 0 }, { at: 1, a: 0 }]}>
      <circle cx="1030" cy="238" r="4" fill="#b6bcb1" />
      <text x="1030" y="277" textAnchor="middle" className="story-small story-muted">A picture is taking shape.</text>
    </Motion>
    <g clipPath="url(#story-private-clip)">
      <Motion poses={[{ at: 0, x: 109, y: 110, r: -6 }, { at: .13, x: 109, y: 110, r: -6 }, { at: .2, x: 240, y: 135, s: .95, r: 0, a: 0 }, { at: 1, x: 240, y: 135, a: 0 }]}>
        <rect width="242" height="192" rx="9" fill="#e9ebe4" stroke="#daddd3" />
        <path d="M24 32H163M24 52H190M24 95H133M24 115H190M24 135H157" stroke="#c8cec2" strokeWidth="5" strokeLinecap="round" />
      </Motion>
      <Motion poses={[{ at: 0, x: 441, y: 137, r: 7 }, { at: .13, x: 441, y: 137, r: 7 }, { at: .2, x: 280, y: 135, s: .95, a: 0 }, { at: 1, x: 280, y: 135, a: 0 }]}>
        <rect width="242" height="192" rx="9" fill="#e9ebe4" stroke="#daddd3" />
        <path d="M24 32H163M24 52H190M24 95H133M24 115H190M24 135H157" stroke="#c8cec2" strokeWidth="5" strokeLinecap="round" />
      </Motion>
      <Motion poses={[{ at: 0, x: 249, y: 115 }, { at: .14, x: 249, y: 115 }, { at: .2, x: 249, y: 98, s: .97, a: 0 }, { at: 1, x: 249, y: 98, a: 0 }]}><Conversation /></Motion>
      <Motion poses={scene(.19, .33, 249, 115)}><Abstraction /></Motion>
      <Motion poses={scene(.23, .32, 575, 168)}><Abstraction secondary /></Motion>
      <Motion poses={scene(.25, .32, 52, 164)}>
        <rect width="153" height="112" rx="8" className="story-paper" /><text x="17" y="28" className="story-micro story-blue">USER GOAL</text><text x="17" y="57" className="story-small">Plan the week</text><path d="M18 78H113M18 91H84" stroke="#d4dccb" strokeWidth="4" strokeLinecap="round" />
      </Motion>
      <Motion poses={scene(.37, .52)}>
        {[[225, 214, 91, 'Coordination'], [461, 274, 78, 'Writing'], [665, 191, 86, 'Daily planning']].map(([x, y, r, name]) => <g key={name}>
          <circle cx={x} cy={y} r={r} fill="#f0f3fa" stroke="#c6d3ec" />
          <text x={x} y={Number(y) + Number(r) + 28} textAnchor="middle" className="story-small story-blue">{name}</text>
        </g>)}
        <text x="430" y="72" textAnchor="middle" className="story-micro">DIFFERENT WORDS. RELATED GOALS.</text>
      </Motion>
      {points.map((p, i) => {
        const center = [[225, 214], [461, 274], [665, 191]][p.group];
        const baseX = 70 + (i % 12) * 62, baseY = 124 + Math.floor(i / 12) * 46;
        return <Motion key={i} poses={[
          { at: 0, x: baseX, y: baseY, a: 0 }, { at: .32, x: baseX, y: baseY, a: 0 },
          { at: .365, x: baseX, y: baseY, a: .8 }, { at: .405 + (i % 6) * .004, x: center[0] + p.dx, y: center[1] + p.dy },
          { at: .505, x: center[0] + p.dx, y: center[1] + p.dy },
          { at: .585 + (i % 5) * .006, x: 90 + (i % 6) * 29, y: 178 + Math.floor(i / 6) * 16, a: .65 },
          { at: .7, x: 90 + (i % 6) * 29, y: 178 + Math.floor(i / 6) * 16, a: .65 },
          { at: .79, x: 423, y: 236, a: 0 }, { at: 1, x: 423, y: 236, a: 0 },
        ]}><circle r={i % 7 === 0 ? 4.5 : 3.2} fill={p.group === 1 ? '#6684c9' : p.group === 2 ? '#8ba5d6' : '#002fa7'} /></Motion>;
      })}
      <Motion poses={scene(.55, .75, 394, 104)}><Decisions /></Motion>
      <Motion poses={scene(.56, .74)}><path d="M274 238H366m-7-5 7 5-7 5" fill="none" stroke="#8b9fca" /><text x="177" y="347" textAnchor="middle" className="story-micro">EVERY ABSTRACTION</text></Motion>
      <Motion poses={scene(.81, 1, 169, 147)}>
        <rect width="498" height="147" rx="10" fill="#f3f4ee" stroke="#dce0d4" />
        <SvgLock x={22} y={22} /><text x="45" y="34" className="story-micro">PRIVATE RECORDS STAY HERE</text>
        <path d="M22 64H222M22 83H276M22 102H170M321 64H455M321 83H414M321 102H442" stroke="#d4dacd" strokeWidth="6" strokeLinecap="round" />
        <text x="249" y="184" textAnchor="middle" className="story-small story-muted">Review unclear cases. Version the taxonomy. Repeat.</text>
      </Motion>
    </g>
    {[0, 1, 2].map((i) => <Motion key={i} poses={[
      { at: 0, x: 735, y: 212 + i * 23, a: 0 }, { at: .758 + i * .012, x: 735, y: 212 + i * 23, a: 0 },
      { at: .78 + i * .012, x: 795, y: 212 + i * 23, a: 1 }, { at: .836 + i * .012, x: 1027, y: 238, a: 1 },
      { at: .86 + i * .012, x: 1027, y: 238, a: 0 }, { at: 1, x: 1027, y: 238, a: 0 },
    ]}><rect width="28" height="13" rx="3" fill="#002fa7" /><path d="M7 4H21M7 8H17" stroke="#b6c9fb" strokeWidth="1.5" /></Motion>)}
    <Motion poses={scene(.818, 1, 1030, 238)}><PublishedMap snapshot={snapshot} /></Motion>
    <circle cx="867" cy="238" r="16" fill="#f9faf6" stroke="#cbd3c8" /><SvgLock x={862} y={231} />
    <text x="867" y="404" textAnchor="middle" className="story-micro story-muted">PUBLICATION BOUNDARY</text>
  </svg>;
});

function chapterAt(time: number) {
  return CHAPTERS.findLastIndex((chapter) => time / DURATION >= chapter.start);
}

export function PipelineStory() {
  const stageRef = useRef<HTMLDivElement>(null);
  const animations = useRef<Animation[]>([]);
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [prefersReduced, setPrefersReduced] = useState(false);
  const [stillFrames, setStillFrames] = useState(false);
  const reduced = prefersReduced || stillFrames;
  const [visible, setVisible] = useState(true);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const chapter = Math.max(0, chapterAt(time));
  const current = CHAPTERS[chapter];

  useEffect(() => {
    const abort = new AbortController();
    createLiveAdapter().getSnapshot({ signal: abort.signal }).then(setSnapshot).catch(() => { if (!abort.signal.aborted) setSnapshotFailed(true); });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { setPrefersReduced(media.matches); if (media.matches) setPlaying(false); };
    update();
    setPlaying(!media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!reduced) return;
    setPlaying(false);
    const settled = CHAPTERS[Math.max(0, chapterAt(timeRef.current))].pose * DURATION;
    timeRef.current = settled;
    setTime(settled);
    animations.current.forEach((animation) => { animation.pause(); animation.currentTime = settled; });
  }, [reduced]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    // All scenes share one clock. Seeking never changes geometry or restarts a scene.
    animations.current = Array.from(node.querySelectorAll<SVGElement>("[data-story-motion]")).map((element) => {
      const animation = element.animate(JSON.parse(element.dataset.storyMotion!), { duration: DURATION, fill: "both" });
      animation.pause();
      animation.currentTime = timeRef.current;
      if (playingRef.current) animation.play();
      return animation;
    });
    return () => { animations.current.forEach((animation) => animation.cancel()); animations.current = []; };
  }, []);

  useEffect(() => {
    let inView = true;
    const update = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; update(); }, { threshold: .15 });
    if (stageRef.current) observer.observe(stageRef.current);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);

  useEffect(() => {
    const running = playing && visible && !reduced;
    playingRef.current = running;
    animations.current.forEach((animation) => running ? animation.play() : animation.pause());
    if (!running) return;
    let frame = 0, lastUpdate = 0;
    const tick = (now: number) => {
      const position = Math.min(DURATION, Number(animations.current[0]?.currentTime ?? 0));
      timeRef.current = position;
      if (now - lastUpdate > 80 || position === DURATION) { setTime(position); lastUpdate = now; }
      if (position >= DURATION) { setPlaying(false); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, visible, reduced]);

  const seek = useCallback((position: number) => {
    setPlaying(false);
    // Reduced motion uses the chapter's settled pose, including keyboard scrubbing.
    const settled = reduced ? CHAPTERS[Math.max(0, chapterAt(position))].pose * DURATION : position;
    timeRef.current = settled;
    animations.current.forEach((animation) => { animation.pause(); animation.currentTime = settled; });
    setTime(settled);
  }, [reduced]);

  function togglePlay() {
    if (playing) { setPlaying(false); return; }
    if (timeRef.current >= DURATION) {
      timeRef.current = 0;
      setTime(0);
      animations.current.forEach((animation) => { animation.currentTime = 0; });
    }
    setPlaying(true);
  }

  return <main className="pipeline-story">
    <header className="story-nav">
      <a href="/" className="story-brand" aria-label="Logless home"><svg width="27" height="24" viewBox="0 0 30 24" aria-hidden="true"><circle cx="11" cy="12" r="9" /><circle cx="20" cy="12" r="9" /></svg>logless<span className="story-nav-divider" /><span className="story-nav-context">Behind the picture</span></a>
      <a href="/" className="story-back"><span>Explore insights</span><ArrowRight size={16} /></a>
    </header>

    <section className="story-intro" aria-labelledby="story-title">
      <div><p className="story-eyebrow">THE MAKING OF AN INSIGHT</p><h1 id="story-title">The big picture.<br /><em>Without the private details.</em></h1></div>
      <p className="story-deck">People come to AI for a million different reasons.<br className="story-desktop-break" /> Logless makes sense of the patterns—while keeping<br className="story-desktop-break" /> the conversations out of your dashboard.</p>
    </section>

    <section className="story-player" aria-label="How Logless works: animated walkthrough">
      <div className="story-player-top"><span><span className="story-status-dot" />FROM CONVERSATIONS TO UNDERSTANDING</span><button className="story-motion-toggle" aria-pressed={reduced} disabled={prefersReduced} onClick={() => setStillFrames(!stillFrames)}><Pause size={10} />{prefersReduced ? 'Reduced motion' : 'Still frames'}</button></div>
      <div className="story-stage" ref={stageRef}>
        <div className="story-mobile-privacy">{chapter === 4 ? <><Eye size={13} />Published aggregates</> : <><LockKeyhole size={13} />Private processing</>}</div>
        <StoryVisual snapshot={snapshot} /><StoryVisual snapshot={snapshot} compact />
      </div>
      <div className="story-caption" aria-live="polite" aria-atomic="true"><div><span className="story-eyebrow">{current.tag}</span><h2>{current.heading}</h2></div><p>{current.copy}</p><span className="sr-only">{chapter === 0 ? 'Fictional example: find a time everyone can meet. A time is agreed, but the calendar invite fails to send.' : chapter === 1 ? 'Private abstraction: coordinate a group meeting. Outcome: invite not delivered.' : chapter === 2 ? 'Illustrative themes: coordination, writing, and daily planning.' : chapter === 3 ? 'Example: Group coordination. Correction and task complaint not observed. Unresolved action error observed.' : snapshot ? `${snapshot.totals.conversationCount} conversations in ${snapshot.clusters.length} published workflows. ${snapshot.synthetic ? 'Synthetic dataset.' : ''} Circles are schematic.` : 'Shared patterns, not private records. No measured counts available.'}</span></div>
      <div className="story-transport">
        {reduced ? <span className="story-reduced-label">Reduced motion · select a step</span> : <button className="story-play" onClick={togglePlay} aria-label={playing ? 'Pause animation' : time >= DURATION ? 'Replay animation' : 'Play animation'}>{playing ? <Pause size={15} fill="currentColor" /> : time >= DURATION ? <RotateCcw size={16} /> : <Play size={15} fill="currentColor" />}</button>}
        <input aria-label="Animation timeline" type="range" min="0" max={reduced ? 4 : DURATION} step={reduced ? 1 : 100} value={reduced ? chapter : time} onChange={(event) => seek(reduced ? CHAPTERS[Number(event.target.value)].pose * DURATION : Number(event.target.value))} aria-valuetext={`${current.title}, ${Math.round(time / 1000)} of 26 seconds`} style={{ '--story-progress': `${time / DURATION * 100}%` } as React.CSSProperties} />
        <span className="story-time" aria-hidden="true">{String(Math.floor(time / 1000)).padStart(2, '0')} <span>/ 26</span></span>
        <button className="story-restart" aria-label="Restart walkthrough" onClick={() => seek(0)}><RotateCcw size={15} /></button>
      </div>
      <nav className="story-chapters" aria-label="Walkthrough steps">{CHAPTERS.map((item, i) => <button key={item.title} onClick={() => seek(item.pose * DURATION)} className={chapter === i ? 'is-active' : ''} aria-current={chapter === i ? 'step' : undefined}><span className="story-chapter-number">0{i + 1}</span><span>{item.title}</span>{i === 4 ? <Eye size={15} /> : <ArrowRight size={14} />}</button>)}</nav>
    </section>

    <footer className="story-footer"><p>Scenes and circle sizes are illustrative. {snapshot ? `Counts from the published ${snapshot.synthetic ? 'synthetic ' : ''}snapshot.` : snapshotFailed ? 'Published snapshot unavailable; no measured counts shown.' : 'Loading published counts…'}</p><a href="/">See the bigger picture<ArrowRight size={15} /></a></footer>
    <section className="story-principle" aria-label="The Logless approach"><span>THE IDEA IS SIMPLE</span><p>LLMs find the meaning.<br className="story-mobile-break" /> Jev makes the decisions.<br className="story-mobile-break" /> <em>Code does the counting.</em></p><a href="/" className="story-bottom-back"><ArrowLeft size={14} />Back to your workspace</a></section>
  </main>;
}
