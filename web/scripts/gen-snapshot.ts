// Generates src/mocks/snapshot.json from hand-authored leaf specs.
// Category and total metrics are *computed* from the leaves so the contract
// invariants hold (leaf conversations partition the total; category counts are
// exact sums; users are non-additive and chosen per category / total).
//
//   node scripts/gen-snapshot.ts
//
// Numbers are illustrative mock values shaped like WildChat-1M (Apr–May 2023).
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Metrics, Node, Problem, Signal, Snapshot } from "../src/lib/types.ts"

const TOTAL_CONVERSATIONS = 5050
const TOTAL_USERS = 2790
const SNAPSHOT_ID = "snap_20260927T031412_7c1e"
const CREATED_AT = "2026-09-27T03:14:12Z"

type Mix = [number, number, number, number] // correction, repeat_request, assistant_limit, complaint
type Lang = [string, number]

type LeafSpec = {
  title: string
  description: string
  conversations: number
  users: number
  friction: number // observed friction share
  mix: Mix
  overlap?: number // sum(signals) / friction conversations
  unclear: number // share of conversations
  langs: Lang[]
  needs: string[]
  problems: [string, Signal | null, Problem["support"]][]
  surprising?: number // score; flag when >= 0.7
  is_other?: boolean
}

type CategorySpec = { title: string; description: string; users: number; leaves: LeafSpec[] }

const L = {
  general: [["English", 0.64], ["Chinese", 0.11], ["Russian", 0.1], ["French", 0.03], ["Spanish", 0.03], ["Portuguese", 0.02], ["German", 0.02], ["Arabic", 0.015]] as Lang[],
  code: [["English", 0.67], ["Chinese", 0.14], ["Russian", 0.09], ["Portuguese", 0.02], ["Spanish", 0.02], ["Japanese", 0.015], ["German", 0.012]] as Lang[],
  zhAcademic: [["English", 0.47], ["Chinese", 0.29], ["Russian", 0.1], ["Korean", 0.03], ["French", 0.025], ["Spanish", 0.02], ["Arabic", 0.015]] as Lang[],
  ruHomework: [["English", 0.48], ["Russian", 0.24], ["Chinese", 0.14], ["Ukrainian", 0.03], ["Spanish", 0.025], ["French", 0.02], ["Turkish", 0.015]] as Lang[],
  fiction: [["English", 0.86], ["Russian", 0.05], ["Chinese", 0.03], ["Spanish", 0.02], ["Portuguese", 0.015]] as Lang[],
  crossover: [["English", 0.94], ["Russian", 0.03], ["Spanish", 0.015]] as Lang[],
  midjourney: [["English", 0.9], ["Chinese", 0.09], ["Russian", 0.007]] as Lang[],
  translation: [["English", 0.38], ["Chinese", 0.19], ["Russian", 0.13], ["French", 0.07], ["Spanish", 0.06], ["German", 0.05], ["Japanese", 0.035], ["Italian", 0.03]] as Lang[],
  business: [["English", 0.71], ["Chinese", 0.08], ["Russian", 0.07], ["Spanish", 0.04], ["French", 0.03], ["Portuguese", 0.02], ["Arabic", 0.015]] as Lang[],
  everyday: [["English", 0.55], ["Russian", 0.13], ["Chinese", 0.12], ["Spanish", 0.05], ["French", 0.04], ["Arabic", 0.03], ["Turkish", 0.02], ["Italian", 0.02]] as Lang[],
}

const categories: CategorySpec[] = [
  {
    title: "Software development",
    description: "People write, fix and explain code across web, data, bots and games.",
    users: 796,
    leaves: [
      {
        title: "Debugging Python and JavaScript errors",
        description: "People paste an error or failing snippet and ask for the cause and a working fix.",
        conversations: 448, users: 371, friction: 0.214, mix: [0.44, 0.36, 0.07, 0.13], unclear: 0.052, langs: L.code,
        needs: [
          "Explain what a traceback or console error actually means",
          "Get a minimal fix that runs without rewriting the whole program",
          "Understand why a library call behaves differently than expected",
        ],
        problems: [
          ["Suggested fixes introduce a new error on the next run", "correction", "common"],
          ["Answers target an older library version than the one installed", "correction", "common"],
          ["Long files get truncated, so the fix misses the failing line", "assistant_limit", "common"],
        ],
      },
      {
        title: "Building web apps and APIs",
        description: "People scaffold front-end pages, back-end endpoints and database models for small web projects.",
        conversations: 321, users: 262, friction: 0.176, mix: [0.38, 0.4, 0.1, 0.12], unclear: 0.047, langs: L.code,
        needs: [
          "Generate a complete, runnable project skeleton",
          "Connect a front-end form to a back-end endpoint",
          "Add authentication or payments to an existing app",
        ],
        problems: [
          ["Generated code stops mid-file and has to be requested again", "repeat_request", "common"],
          ["Framework versions are mixed within one answer", "correction", "common"],
          ["Deployment steps assume tools the person does not have", null, "observed"],
        ],
      },
      {
        title: "Building Discord and Telegram bots",
        description: "People build chat bots with command handlers, scheduled posts and API integrations.",
        conversations: 112, users: 64, friction: 0.205, mix: [0.42, 0.38, 0.08, 0.12], unclear: 0.054, langs: L.code,
        needs: [
          "Wire up bot commands and event handlers",
          "Call a third-party API from inside a bot",
        ],
        problems: [
          ["Library APIs changed after the model's training data", "correction", "common"],
          ["Tokens and intents setup is skipped in the instructions", "repeat_request", "observed"],
        ],
      },
      {
        title: "Game scripting for Unity and Roblox",
        description: "People write gameplay scripts, movement controllers and UI logic for hobby games.",
        conversations: 96, users: 61, friction: 0.24, mix: [0.47, 0.33, 0.07, 0.13], unclear: 0.063, langs: L.code,
        needs: [
          "Write a character or camera controller from a description",
          "Fix a script that compiles but does nothing in the game",
        ],
        problems: [
          ["Engine-specific APIs are invented or misnamed", "correction", "common"],
          ["The model cannot see the scene setup the script depends on", "assistant_limit", "observed"],
        ],
      },
      {
        title: "Writing SQL and data-analysis scripts",
        description: "People write queries, pandas transformations and spreadsheet formulas for their own data.",
        conversations: 139, users: 117, friction: 0.13, mix: [0.46, 0.3, 0.1, 0.14], unclear: 0.043, langs: L.code,
        needs: [
          "Turn a plain-language question into a correct query",
          "Clean and reshape a table before charting it",
        ],
        problems: [
          ["Queries use a different SQL dialect than the person's database", "correction", "common"],
          ["Column names are guessed instead of asked for", "correction", "observed"],
        ],
      },
    ],
  },
  {
    title: "Writing & editing",
    description: "People draft, rewrite, translate and condense text for school and work.",
    users: 661,
    leaves: [
      {
        title: "Rewriting essays to sound human",
        description: "People ask for essays or paragraphs to be rephrased so they read as human-written and pass AI detectors.",
        conversations: 214, users: 163, friction: 0.192, mix: [0.2, 0.52, 0.08, 0.2], unclear: 0.061, langs: L.zhAcademic,
        needs: [
          "Rephrase text so it no longer reads as machine-written",
          "Keep the original argument while changing the wording",
        ],
        problems: [
          ["Rewrites are rejected as still sounding generated, prompting repeated attempts", "repeat_request", "common"],
          ["Meaning drifts after several rounds of paraphrasing", "correction", "common"],
          ["The person reports a detector score and asks to try again", "complaint", "observed"],
        ],
        surprising: 0.84,
      },
      {
        title: "Translating and polishing work emails",
        description: "People translate messages between languages and adjust tone for colleagues and clients.",
        conversations: 243, users: 207, friction: 0.071, mix: [0.5, 0.3, 0.05, 0.15], unclear: 0.034, langs: L.translation,
        needs: [
          "Translate a message while keeping a professional tone",
          "Make a short email more polite or more direct",
          "Check grammar in a second language before sending",
        ],
        problems: [
          ["Formality level does not match the recipient", "correction", "common"],
          ["Names and product terms get translated when they should not", "correction", "observed"],
        ],
      },
      {
        title: "Drafting academic papers and literature reviews",
        description: "People outline, draft and expand thesis chapters, reports and literature reviews.",
        conversations: 242, users: 191, friction: 0.161, mix: [0.3, 0.24, 0.3, 0.16], unclear: 0.058, langs: L.zhAcademic,
        needs: [
          "Expand an outline into a structured chapter",
          "Find and cite relevant prior work",
          "Meet a specific word count and format",
        ],
        problems: [
          ["Citations are invented or cannot be verified", "assistant_limit", "common"],
          ["Word-count targets are missed and re-requested", "repeat_request", "common"],
          ["The model cannot read papers behind the links provided", "assistant_limit", "common"],
        ],
      },
      {
        title: "Summarizing and paraphrasing articles",
        description: "People paste long passages and ask for summaries, key points or simplified versions.",
        conversations: 181, users: 160, friction: 0.088, mix: [0.28, 0.26, 0.32, 0.14], unclear: 0.039, langs: L.general,
        needs: [
          "Condense a long text into a few key points",
          "Simplify dense material for a younger reader",
        ],
        problems: [
          ["Pasted text exceeds the length the model can take in", "assistant_limit", "common"],
          ["Summaries add claims that are not in the source", "correction", "observed"],
        ],
      },
    ],
  },
  {
    title: "Creative & role-play",
    description: "People co-write stories, scenarios, poems and interactive role-play.",
    users: 358,
    leaves: [
      {
        title: "Continuing fan-fiction and story episodes",
        description: "People develop long-running stories with recurring characters, asking for the next episode again and again.",
        conversations: 398, users: 97, friction: 0.118, mix: [0.36, 0.42, 0.1, 0.12], unclear: 0.044, langs: L.fiction,
        needs: [
          "Continue a story consistently from where it stopped",
          "Keep characters' names, traits and relationships stable",
          "Write longer episodes with dialogue",
        ],
        problems: [
          ["Characters' details drift between episodes", "correction", "common"],
          ["Episodes end early and have to be continued manually", "repeat_request", "common"],
        ],
      },
      {
        title: "Anime and game crossover scenarios",
        description: "People write what-if scenes where characters from different franchises meet and react to each other.",
        conversations: 206, users: 38, friction: 0.083, mix: [0.34, 0.4, 0.12, 0.14], unclear: 0.041, langs: L.crossover,
        needs: [
          "Stage a crossover between characters from different series",
          "Produce many short variations on the same premise",
        ],
        problems: [
          ["Canon details for lesser-known characters are wrong", "correction", "common"],
          ["Requests are declined when scenes involve conflict", "assistant_limit", "observed"],
        ],
      },
      {
        title: "Role-play with unrestricted personas",
        description: "People ask the assistant to adopt a persona that ignores its usual rules, then test what it will say.",
        conversations: 157, users: 121, friction: 0.293, mix: [0.1, 0.24, 0.42, 0.24], unclear: 0.071, langs: L.general,
        needs: [
          "Keep an assigned persona for the whole conversation",
          "Get answers the default assistant declines to give",
        ],
        problems: [
          ["The assistant breaks character and declines", "assistant_limit", "common"],
          ["People complain the persona instructions were ignored", "complaint", "common"],
          ["The same setup prompt is pasted several times in a row", "repeat_request", "common"],
        ],
        surprising: 0.88,
      },
      {
        title: "Poems, song lyrics and jokes",
        description: "People ask for short creative pieces for occasions, friends and social posts.",
        conversations: 172, users: 151, friction: 0.064, mix: [0.34, 0.36, 0.1, 0.2], unclear: 0.03, langs: L.general,
        needs: [
          "Write a short poem for a specific person or occasion",
          "Make a joke or pun on a given topic",
        ],
        problems: [
          ["Rhymes and meter break in non-English poems", "correction", "common"],
          ["Jokes are explained rather than landed", "complaint", "observed"],
        ],
      },
    ],
  },
  {
    title: "Image-prompt generation",
    description: "People use the assistant to write prompts and concepts for image generators.",
    users: 69,
    leaves: [
      {
        title: "Writing Midjourney / Stable Diffusion prompts",
        description: "A pasted template asks for batches of structured image-generator prompts from a short concept, repeated at high volume.",
        conversations: 412, users: 11, friction: 0.053, mix: [0.3, 0.42, 0.08, 0.2], unclear: 0.022, langs: L.midjourney,
        needs: [
          "Turn a one-line concept into several detailed image prompts",
          "Follow a strict output format with style and aspect-ratio flags",
        ],
        problems: [
          ["Output format drifts from the template's required structure", "correction", "common"],
          ["Batches repeat the same composition with small wording changes", "repeat_request", "observed"],
        ],
        surprising: 0.91,
      },
      {
        title: "Designing logos and visual concepts",
        description: "People describe a brand or scene and ask for design ideas, color palettes or an image.",
        conversations: 73, users: 61, friction: 0.171, mix: [0.12, 0.26, 0.5, 0.12], unclear: 0.055, langs: L.business,
        needs: [
          "Get concrete visual directions for a logo or poster",
          "Receive an actual image rather than a description",
        ],
        problems: [
          ["The assistant cannot produce images, only describe them", "assistant_limit", "common"],
          ["Palette suggestions ignore stated brand colors", "correction", "observed"],
        ],
      },
    ],
  },
  {
    title: "Learning & homework",
    description: "People work through problems, exam questions and explanations while studying.",
    users: 571,
    leaves: [
      {
        title: "Solving math and physics problems",
        description: "People paste problem sets and ask for step-by-step solutions and final answers.",
        conversations: 284, users: 227, friction: 0.232, mix: [0.56, 0.24, 0.08, 0.12], unclear: 0.066, langs: L.ruHomework,
        needs: [
          "See each step of the solution, not only the answer",
          "Check their own answer against a worked solution",
        ],
        problems: [
          ["Arithmetic slips lead to a wrong final answer", "correction", "common"],
          ["Diagrams and formulas lose meaning when pasted as text", "assistant_limit", "common"],
        ],
      },
      {
        title: "Answering exam and quiz questions",
        description: "People paste multiple-choice or short-answer questions, often many in a row, and ask for the answers.",
        conversations: 203, users: 139, friction: 0.113, mix: [0.52, 0.24, 0.08, 0.16], unclear: 0.049, langs: L.ruHomework,
        needs: [
          "Get the correct option with a one-line reason",
          "Work through a long list of questions quickly",
        ],
        problems: [
          ["Confident answers are wrong and the person corrects them", "correction", "common"],
          ["Questions that reference a figure cannot be answered", "assistant_limit", "observed"],
        ],
      },
      {
        title: "Explaining science, history and economics",
        description: "People ask for plain-language explanations of concepts, events and theories.",
        conversations: 196, users: 176, friction: 0.071, mix: [0.44, 0.26, 0.14, 0.16], unclear: 0.036, langs: L.general,
        needs: [
          "Understand a concept at a chosen level of detail",
          "Compare two theories or events side by side",
        ],
        problems: [
          ["Dates and figures are stated with false precision", "correction", "common"],
          ["Explanations stay too abstract for the person's level", "repeat_request", "observed"],
        ],
      },
      {
        title: "Practising English and other languages",
        description: "People ask for grammar explanations, vocabulary drills and corrections of their own sentences.",
        conversations: 118, users: 99, friction: 0.076, mix: [0.44, 0.3, 0.1, 0.16], unclear: 0.034, langs: L.translation,
        needs: [
          "Get corrections with the reason for each change",
          "Practise conversation at a beginner level",
        ],
        problems: [
          ["Corrections change the person's meaning", "correction", "observed"],
          ["Replies switch to English when practice was in another language", "repeat_request", "common"],
        ],
      },
    ],
  },
  {
    title: "Business & career",
    description: "People write job applications, marketing material and business plans.",
    users: 331,
    leaves: [
      {
        title: "Writing cover letters and resumes",
        description: "People tailor resumes and cover letters to specific job postings.",
        conversations: 129, users: 118, friction: 0.093, mix: [0.42, 0.34, 0.08, 0.16], unclear: 0.039, langs: L.business,
        needs: [
          "Match a resume to the wording of a job posting",
          "Describe experience with stronger, measurable language",
        ],
        problems: [
          ["Achievements are inflated beyond what the person gave", "correction", "common"],
          ["Letters are too long for the requested format", "repeat_request", "observed"],
        ],
      },
      {
        title: "Marketing copy, SEO and social posts",
        description: "People produce product descriptions, SEO articles and batches of social media posts.",
        conversations: 196, users: 142, friction: 0.102, mix: [0.3, 0.46, 0.1, 0.14], unclear: 0.041, langs: L.business,
        needs: [
          "Write many variants of a post for different platforms",
          "Include target keywords without sounding forced",
        ],
        problems: [
          ["Copy repeats the same phrasing across variants", "repeat_request", "common"],
          ["Keyword and length requirements are dropped", "correction", "common"],
        ],
      },
      {
        title: "Business plans and startup ideas",
        description: "People brainstorm business ideas and draft plans, pitches and financial outlines.",
        conversations: 97, users: 88, friction: 0.062, mix: [0.34, 0.3, 0.2, 0.16], unclear: 0.031, langs: L.business,
        needs: [
          "Test whether an idea has an obvious market",
          "Draft a one-page plan with rough numbers",
        ],
        problems: [
          ["Market figures cannot be sourced or checked", "assistant_limit", "observed"],
          ["Plans stay generic across very different ideas", "complaint", "observed"],
        ],
      },
    ],
  },
  {
    title: "Everyday advice",
    description: "People ask about current events, the assistant itself, and personal decisions.",
    users: 233,
    leaves: [
      {
        title: "Getting real-time info the model can't access",
        description: "People ask for today's news, prices, weather or links, which the assistant cannot retrieve.",
        conversations: 104, users: 95, friction: 0.298, mix: [0.12, 0.22, 0.52, 0.14], unclear: 0.077, langs: L.everyday,
        needs: [
          "Get current prices, scores or news",
          "Open and read a link the person shares",
        ],
        problems: [
          ["The assistant explains it has no internet access or recent data", "assistant_limit", "common"],
          ["People rephrase the same request hoping for live data", "repeat_request", "common"],
        ],
      },
      {
        title: "Asking which model the assistant is",
        description: "People ask whether they are talking to GPT-4, what its knowledge cutoff is, and who runs the service.",
        conversations: 71, users: 68, friction: 0.254, mix: [0.14, 0.26, 0.34, 0.26], unclear: 0.07, langs: L.everyday,
        needs: [
          "Confirm which model version is answering",
          "Understand the service's limits before relying on it",
        ],
        problems: [
          ["Answers about the model's identity are inconsistent", "complaint", "common"],
          ["The assistant cannot state its own version reliably", "assistant_limit", "common"],
        ],
        surprising: 0.72,
      },
      {
        title: "Health, fitness and relationship advice",
        description: "People describe a personal situation and ask what to do next.",
        conversations: 88, users: 81, friction: 0.102, mix: [0.2, 0.3, 0.3, 0.2], unclear: 0.045, langs: L.everyday,
        needs: [
          "Get practical next steps for a personal situation",
          "Build a simple workout or meal plan",
        ],
        problems: [
          ["Advice defers to professionals without a concrete next step", "assistant_limit", "common"],
          ["Follow-up questions ignore details already given", "correction", "observed"],
        ],
      },
    ],
  },
  {
    title: "Other or unclear",
    description: "Conversations too short, too mixed or too unclear to place in a specific workflow.",
    users: 139,
    leaves: [
      {
        title: "Other or unclear",
        description: "Greetings, single-word messages, tests and conversations with no clear goal.",
        conversations: 150, users: 139, friction: 0.133, mix: [0.26, 0.3, 0.24, 0.2], unclear: 0.093, langs: L.general,
        needs: ["Test whether the assistant is working"],
        problems: [["Very short openings get generic replies", null, "common"]],
        is_other: true,
      },
    ],
  },
]

// Short map labels (contract §5 `short_title`: 1–3 words, <= 22 chars).
const SHORT: Record<string, string> = {
  "Software development": "Software",
  "Writing & editing": "Writing",
  "Creative & role-play": "Creative",
  "Image-prompt generation": "Image prompts",
  "Learning & homework": "Learning",
  "Business & career": "Business",
  "Everyday advice": "Everyday",
  "Debugging Python and JavaScript errors": "Debugging errors",
  "Building web apps and APIs": "Web apps & APIs",
  "Building Discord and Telegram bots": "Chat bots",
  "Game scripting for Unity and Roblox": "Game scripting",
  "Writing SQL and data-analysis scripts": "SQL & data scripts",
  "Rewriting essays to sound human": "Humanizing essays",
  "Translating and polishing work emails": "Work emails",
  "Drafting academic papers and literature reviews": "Academic papers",
  "Summarizing and paraphrasing articles": "Summaries",
  "Continuing fan-fiction and story episodes": "Fan-fiction episodes",
  "Anime and game crossover scenarios": "Crossover scenarios",
  "Role-play with unrestricted personas": "Unrestricted personas",
  "Poems, song lyrics and jokes": "Poems & jokes",
  "Writing Midjourney / Stable Diffusion prompts": "Image prompts",
  "Designing logos and visual concepts": "Logos & visuals",
  "Solving math and physics problems": "Math & physics",
  "Answering exam and quiz questions": "Exam answers",
  "Explaining science, history and economics": "Explainers",
  "Practising English and other languages": "Language practice",
  "Writing cover letters and resumes": "Resumes",
  "Marketing copy, SEO and social posts": "Marketing copy",
  "Business plans and startup ideas": "Business plans",
  "Getting real-time info the model can't access": "Real-time info",
  "Asking which model the assistant is": "Model identity",
  "Health, fitness and relationship advice": "Personal advice",
  "Other or unclear": "Other",
}
const shortOf = (title: string) => {
  const s = SHORT[title]
  if (!s || s.length > 22 || s.split(/\s+/).filter((w) => /\w/.test(w)).length > 3) throw new Error(`short_title missing/too long for ${title}`)
  return s
}

// ---------------------------------------------------------------- helpers

const hex = (seed: string) => createHash("sha256").update(seed).digest("hex").slice(0, 6)
const round4 = (x: number) => Math.round(x * 10000) / 10000
const SIG: Signal[] = ["correction", "repeat_request", "assistant_limit", "complaint"]

/** Largest-remainder apportionment of `total` over `weights`. */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  const raw = weights.map((w) => (w / sum) * total)
  const out = raw.map(Math.floor)
  let rest = total - out.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (rest <= 0) break
    out[i] += 1
    rest -= 1
  }
  return out
}

function leafMetrics(s: LeafSpec) {
  const fc = Math.round(s.conversations * s.friction)
  const sumSignals = Math.round(fc * (s.overlap ?? 1.24))
  const sig = apportion(sumSignals, s.mix)
  // no single signal can exceed the conversations with >=1 observed signal
  for (let i = 0; i < 4; i++) if (sig[i] > fc) sig[i] = fc
  const covered = s.langs.reduce((a, [, w]) => a + w, 0)
  const langCounts = apportion(s.conversations, [...s.langs.map(([, w]) => w), Math.max(0, 1 - covered)])
  const langs = s.langs.map(([name], i) => ({ name, conversations: langCounts[i] }))
  return {
    fc,
    signals: Object.fromEntries(SIG.map((k, i) => [k, sig[i]])) as Record<Signal, number>,
    unclear: Math.round(s.conversations * s.unclear),
    langs,
  }
}

const OTHER_LANGUAGES = "Other languages"

/** Top 5 named languages with >= 5 conversations; everything else folds into "Other languages". */
function top5(all: Map<string, number>, total: number) {
  const named = [...all.entries()]
    .filter(([name, n]) => name !== OTHER_LANGUAGES && n >= 5)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, conversations]) => ({ name, conversations }))
  const rest = total - named.reduce((a, l) => a + l.conversations, 0)
  return rest > 0 ? [...named, { name: OTHER_LANGUAGES, conversations: rest }] : named
}

function metrics(
  conversations: number,
  users: number,
  fc: number,
  unclear: number,
  signals: Record<Signal, number>,
  langs: Map<string, number>,
): Metrics {
  return {
    conversations,
    users,
    share: round4(conversations / TOTAL_CONVERSATIONS),
    friction: {
      conversations: fc,
      share: conversations === 0 ? null : round4(fc / conversations),
      unclear,
      signals,
    },
    languages: top5(langs, conversations),
  }
}

// ---------------------------------------------------------------- build

const catNodes: Node[] = []
const leafNodes: Node[] = []
const allLangs = new Map<string, number>()
const totalSignals: Record<Signal, number> = { correction: 0, repeat_request: 0, assistant_limit: 0, complaint: 0 }
let totalConv = 0
let totalFc = 0
let totalUnclear = 0

for (const c of categories) {
  const catId = c.leaves.length === 1 && c.leaves[0].is_other ? `cat_${hex("cat:other")}` : `cat_${hex(`cat:${c.title}`)}`
  const catLangs = new Map<string, number>()
  const catSignals: Record<Signal, number> = { correction: 0, repeat_request: 0, assistant_limit: 0, complaint: 0 }
  let conv = 0
  let fc = 0
  let unclear = 0
  const children: string[] = []
  const maxChildUsers = Math.max(...c.leaves.map((l) => l.users))
  const sumChildUsers = c.leaves.reduce((a, l) => a + l.users, 0)
  if (c.users < maxChildUsers || c.users > sumChildUsers) {
    throw new Error(`${c.title}: users ${c.users} outside [${maxChildUsers}, ${sumChildUsers}]`)
  }

  for (const s of c.leaves) {
    const id = s.is_other ? "cl_other" : `cl_${hex(`leaf:${s.title}`)}`
    const m = leafMetrics(s)
    children.push(id)
    conv += s.conversations
    fc += m.fc
    unclear += m.unclear
    for (const k of SIG) catSignals[k] += m.signals[k]
    const leafLangs = new Map<string, number>()
    for (const { name, conversations } of m.langs) {
      leafLangs.set(name, conversations)
      catLangs.set(name, (catLangs.get(name) ?? 0) + conversations)
    }
    const node: Node = {
      id,
      level: 2,
      parent_id: catId,
      title: s.title,
      short_title: shortOf(s.title),
      description: s.description,
      ...metrics(s.conversations, s.users, m.fc, m.unclear, m.signals, leafLangs),
      needs: s.needs.map((text, i) => ({ id: `n${i + 1}`, text })),
      problems: s.problems.map(([text, signal, support], i) => ({ id: `p${i + 1}`, text, signal, support })),
      surprising: { flag: (s.surprising ?? 0) >= 0.7, score: s.surprising ?? round4(0.08 + (parseInt(hex(s.title), 16) % 37) / 100) },
    }
    if (s.is_other) node.is_other = true
    leafNodes.push(node)
  }

  const cat: Node = {
    id: catId,
    level: 1,
    parent_id: null,
    title: c.title,
    short_title: shortOf(c.title),
    description: c.description,
    ...metrics(conv, c.users, fc, unclear, catSignals, catLangs),
    children,
  }
  if (c.leaves.every((l) => l.is_other)) cat.is_other = true
  catNodes.push(cat)
  totalConv += conv
  totalFc += fc
  totalUnclear += unclear
  for (const k of SIG) totalSignals[k] += catSignals[k]
  for (const [k, v] of catLangs) allLangs.set(k, (allLangs.get(k) ?? 0) + v)
}

if (totalConv !== TOTAL_CONVERSATIONS) throw new Error(`leaf conversations sum to ${totalConv}, expected ${TOTAL_CONVERSATIONS}`)
const catUserSum = catNodes.reduce((a, n) => a + n.users, 0)
const catUserMax = Math.max(...catNodes.map((n) => n.users))
if (TOTAL_USERS > catUserSum || TOTAL_USERS < catUserMax) throw new Error(`total users ${TOTAL_USERS} outside [${catUserMax}, ${catUserSum}]`)

const t = (h: number, m: number, s = 0) => `2026-09-27T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`

const snapshot: Snapshot = {
  snapshot_id: SNAPSHOT_ID,
  created_at: CREATED_AT,
  workspace: {
    name: "WildChat · public research sample",
    description: "A free public chatbot front-end (GPT-3.5 / GPT-4) whose users consented to research release of their conversations.",
  },
  dataset: {
    name: "WildChat-1M",
    source_url: "https://huggingface.co/datasets/allenai/WildChat-1M",
    revision: "7d6490e462285cf85d91eabea0f9a954fbddcd1f",
    license: "ODC-BY-1.0",
    attribution: 'Zhao et al., "WildChat: 1M ChatGPT Interaction Logs in the Wild", ICLR 2024',
    period_start: "2023-04-09",
    period_end: "2023-05-04",
    conversations: TOTAL_CONVERSATIONS,
    users: TOTAL_USERS,
    languages: 55,
    sample_note: "Seeded uniform sample of 5,000 conversations from WildChat-1M shard 0, plus 40 planted canary conversations and 10 injection-bait fixtures used by the evaluation.",
    fixtures: { canary_conversations: 40, injection_conversations: 10 },
  },
  totals: metrics(TOTAL_CONVERSATIONS, TOTAL_USERS, totalFc, totalUnclear, totalSignals, allLangs),
  categories: catNodes,
  clusters: leafNodes,
  intended_uses: [
    "Answering general-knowledge questions",
    "Writing and editing help",
    "Programming help and code explanation",
    "Tutoring and study help",
    "Brainstorming and planning",
    "Translation",
  ],
  provenance: {
    pipeline_version: "0.4.0",
    dataset_hash: "sha256:3b1f0c9e5a7d",
    models: {
      facets: "glm-5.3",
      discovery: "glm-5.3",
      summaries: "glm-5.3",
      stories: "glm-5.3",
      analysis_code: "glm-5.3",
      classification: "jev-latest",
      friction: "jev-latest",
      relevance: "jev-latest",
      embeddings: "fireworks/qwen3-embedding-8b",
    },
    prompt_versions: { facets: "fv3", discovery: "dv2", summaries: "sv2", friction: "FRICTION_QV4", stories: "st1" },
    discovery_rounds: 3,
    build_seconds: 1486,
    stats_source: "sandbox",
    stages: [
      { stage: "sample", started_at: t(2, 49, 26), finished_at: t(2, 49, 51), counts: { conversations: 5000, canaries: 40, injection_bait: 10 }, models: [] },
      { stage: "facets", started_at: t(2, 49, 51), finished_at: t(2, 58, 4), counts: { conversations: 5050 }, models: ["glm-5.3"] },
      { stage: "embed", started_at: t(2, 58, 4), finished_at: t(2, 59, 12), counts: { vectors: 5050 }, models: ["fireworks/qwen3-embedding-8b"] },
      { stage: "discover", started_at: t(2, 59, 12), finished_at: t(3, 2, 40), counts: { rounds: 3, leaves: leafNodes.length, categories: catNodes.length }, models: ["glm-5.3"] },
      { stage: "classify", started_at: t(3, 2, 40), finished_at: t(3, 6, 58), counts: { conversations: 5050, other: 150 }, models: ["jev-latest"] },
      { stage: "friction", started_at: t(3, 6, 58), finished_at: t(3, 11, 3), counts: { decisions: 20200 }, models: ["jev-latest"] },
      { stage: "aggregate", started_at: t(3, 11, 3), finished_at: t(3, 11, 5), counts: { sandbox_jobs: 1 }, models: [] },
      { stage: "summarize", started_at: t(3, 11, 5), finished_at: t(3, 14, 8), counts: { clusters: leafNodes.length }, models: ["glm-5.3"] },
      { stage: "publish", started_at: t(3, 14, 8), finished_at: t(3, 14, 12), counts: { nodes: leafNodes.length + catNodes.length }, models: [] },
    ],
  },
}

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, "../src/mocks/snapshot.json")
writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n")
console.log(
  `wrote ${out}: ${catNodes.length} categories, ${leafNodes.length} leaves, ${totalConv} conversations, ` +
    `friction ${totalFc} (${((totalFc / totalConv) * 100).toFixed(1)}%), cat user sum ${catUserSum}`,
)
