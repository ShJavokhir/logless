import type {
  Cluster,
  ClusterMetrics,
  FictionalStory,
  Snapshot,
} from "./types";

// Aggregate, authored demo content only. These IDs identify published patterns, never records.
const SNAPSHOT_ID = "muse-demo-2026-09";
const GENERATED_AT = "2026-09-26T16:00:00.000Z";
const TOTAL_CONVERSATIONS = 600;

interface ClusterSeed {
  id: string;
  parentId: string;
  title: string;
  shortTitle: string;
  summary: string;
  needs: string[];
  gripes: string[];
  counts: [number, number, number, number, number, number];
  terms: string[];
  name: string;
  body: string;
}

const seeds: ClusterSeed[] = [
  {
    id: "changing-plans",
    parentId: "coordination",
    title: "Coordinating changing plans",
    shortTitle: "Changing plans",
    summary:
      "People use the assistant to carry a shared plan across changing availability, messages, and follow-ups.",
    needs: [
      "Keep everyone's latest constraints together.",
      "Carry agreed changes into a clear next step.",
    ],
    gripes: [
      "Earlier constraints reappear after a change.",
      "People repeat updates or check whether follow-ups happened.",
    ],
    counts: [108, 46, 14, 31, 24, 14],
    terms: [
      "coordinate",
      "coordinating",
      "coordination",
      "people",
      "together",
      "others",
      "group",
      "shared",
      "plans",
      "schedule",
      "availability",
      "reschedule",
      "changing",
      "follow up",
    ],
    name: "Alex",
    body: "Alex is trying to get everyone to agree on a plan. They ask the assistant to bring the latest availability together and make the next step clear. Then someone changes a constraint. The assistant revises the plan, but an earlier constraint returns, so Alex repeats an update they already gave. Before moving on, they check whether the follow-up reflects the new agreement. What Alex needs is continuity: the latest decision should carry through to the next message and reminder. The difficult part is keeping several small changes aligned, without having to rebuild the shared context each time.",
  },
  {
    id: "shared-commitments",
    parentId: "coordination",
    title: "Keeping shared commitments",
    shortTitle: "Shared commitments",
    summary:
      "People organize responsibilities with others and keep track of who has agreed to do what.",
    needs: [
      "Make ownership and next steps explicit.",
      "Keep shared responsibilities up to date.",
    ],
    gripes: [
      "Responsibility is assigned ambiguously.",
      "A revised agreement does not consistently reach the next reminder.",
    ],
    counts: [78, 27, 11, 18, 13, 8],
    terms: [
      "coordinate",
      "coordinating",
      "coordination",
      "people",
      "together",
      "others",
      "shared",
      "responsibilities",
      "commitments",
      "reminders",
      "ownership",
      "tasks",
      "delegate",
    ],
    name: "Sam",
    body: "Sam is organizing a few shared responsibilities with other people. They ask the assistant to turn the agreement into clear owners and next steps, then keep those commitments current as the arrangement changes. A responsibility is described without making its owner clear. Later, a reminder reflects an earlier version of the agreement. Sam has to clarify the assignment and check the reminder before relying on it. The underlying need is a dependable account of what each person has agreed to do. This fictional situation combines supported aggregate themes; it is not a reconstruction of one conversation or evidence that all shared commitments encounter these problems.",
  },
  {
    id: "closing-the-loop",
    parentId: "coordination",
    title: "Closing the loop with others",
    shortTitle: "Closing the loop",
    summary:
      "People turn an unanswered message or unfinished agreement into a timely follow-up and a clear next action.",
    needs: [
      "Remember what is still waiting on someone else.",
      "Follow up without losing the original request.",
    ],
    gripes: [
      "Follow-up drafts omit part of the original request.",
      "A requested follow-up action is not shown to complete.",
    ],
    counts: [48, 15, 8, 11, 8, 4],
    terms: [
      "coordinate",
      "coordinating",
      "coordination",
      "people",
      "together",
      "others",
      "follow up",
      "followups",
      "waiting",
      "reply",
      "response",
      "reminder",
      "unfinished",
    ],
    name: "Robin",
    body: "Robin is waiting for a reply before a shared task can move forward. They ask the assistant to remember the open request and prepare a follow-up that makes the next action clear. The draft leaves out part of what Robin originally needed, so they restore that context before continuing. They also need to know whether the requested follow-up action actually completed. A statement that the task is handled does not answer that question on its own. This example draws on the published need to preserve context and the observed follow-up problems. It leaves the eventual reply and outcome open because the aggregate evidence does not establish them.",
  },
  {
    id: "notes-to-actions",
    parentId: "everyday",
    title: "Turning notes into next steps",
    shortTitle: "Notes to next steps",
    summary:
      "People turn scattered notes into a concise account of what matters and what to do next.",
    needs: [
      "Separate useful actions from background information.",
      "Keep important qualifications when shortening notes.",
    ],
    gripes: [
      "A condensed version drops a useful qualification.",
      "A proposed next step does not match the notes.",
    ],
    counts: [72, 12, 14, 8, 5, 2],
    terms: [
      "notes",
      "summary",
      "summarize",
      "summaries",
      "actions",
      "next steps",
      "organize",
      "writing",
      "everyday",
    ],
    name: "Casey",
    body: "Casey has a loose set of notes and wants a short account they can act on. They ask the assistant to separate background information from useful next steps while keeping the qualifications that matter. One shortened passage loses a condition from the notes, and a suggested action does not quite match what was written. Casey corrects those parts before using the result. The value they seek is clarity without changing the meaning of the material. This invented example illustrates the cluster's published workflow and supported frustrations. It does not mean every summary has these problems, and it does not supply an outcome for conversations whose ending remains unclear.",
  },
  {
    id: "getting-wording-right",
    parentId: "everyday",
    title: "Getting the wording right",
    shortTitle: "Getting wording right",
    summary:
      "People refine messages until the wording matches their intended meaning, tone, and requested level of detail.",
    needs: [
      "Express the intended point in an appropriate tone.",
      "Preserve meaning through revisions.",
    ],
    gripes: [
      "A revision changes the intended meaning.",
      "A draft repeats a tone or length issue after correction.",
    ],
    counts: [54, 15, 9, 11, 7, 3],
    terms: [
      "write",
      "writing",
      "draft",
      "drafting",
      "messages",
      "message",
      "email",
      "wording",
      "tone",
      "rewrite",
      "edit",
    ],
    name: "Lee",
    body: "Lee is preparing a message and knows what they want it to communicate. They ask the assistant to make the wording clear and adjust the tone without changing the point. A revision sounds closer to the requested style but shifts the meaning. Lee corrects it, then finds that a length issue from an earlier draft has returned. They continue refining the text because getting the wording right includes preserving intent across revisions. This fictional scene uses only the cluster's published needs and frustrations. It does not treat a request for a different style as an assistant mistake, or imply that every revision in the cluster involved observed friction.",
  },
  {
    id: "everyday-admin",
    parentId: "everyday",
    title: "Handling everyday administration",
    shortTitle: "Everyday admin",
    summary:
      "People organize routine tasks, reminders, and small administrative actions into a manageable next step.",
    needs: [
      "Turn a routine request into a specific action.",
      "Know which requested actions remain open.",
    ],
    gripes: [
      "An action is described with the wrong requested detail.",
      "A failed action has no observed recovery.",
    ],
    counts: [36, 9, 7, 5, 4, 3],
    terms: [
      "admin",
      "administration",
      "routine",
      "tasks",
      "reminders",
      "organize",
      "everyday",
      "errands",
    ],
    name: "Avery",
    body: "Avery is working through a few routine tasks and asks the assistant to turn one request into a specific next action. They want the requested details preserved and a clear account of what remains open. The proposed action contains a detail that does not match the request, so Avery corrects it. An attempted action then fails, with no recovery established in the available evidence. Avery's need is to distinguish a prepared plan from an action that has actually completed. This fictional example illustrates supported aggregate themes. It does not identify a technical cause for the error or assume that every administrative request in the cluster failed.",
  },
  {
    id: "comparing-options",
    parentId: "research",
    title: "Comparing options before deciding",
    shortTitle: "Comparing options",
    summary:
      "People compare alternatives against their own constraints before making a practical decision.",
    needs: [
      "Compare options against the same requirements.",
      "Understand the trade-offs without losing important constraints.",
    ],
    gripes: [
      "A comparison omits a stated constraint.",
      "An option is described inconsistently across the answer.",
    ],
    counts: [60, 16, 10, 11, 8, 5],
    terms: [
      "compare",
      "comparing",
      "comparison",
      "options",
      "decide",
      "decision",
      "research",
      "tradeoffs",
      "choices",
      "recommend",
    ],
    name: "Jamie",
    body: "Jamie has several options and wants help comparing them against a few practical requirements. They ask the assistant to use the same criteria for each alternative and explain the trade-offs clearly. The comparison leaves out a stated constraint, so Jamie asks for it to be included. One option is also described differently in two parts of the answer. Jamie needs a consistent comparison before they can make their own decision. This invented situation reflects the published need and observed problems within the cluster. It does not establish which alternative Jamie chooses, whether that choice works out, or how often any specific omission appears beyond the reported aggregate measures.",
  },
  {
    id: "understanding-topics",
    parentId: "research",
    title: "Making sense of unfamiliar topics",
    shortTitle: "New topics",
    summary:
      "People ask for explanations that connect unfamiliar information to a question they are trying to understand.",
    needs: [
      "Get a clear explanation at the right level of detail.",
      "Keep the answer focused on the original question.",
    ],
    gripes: [
      "An explanation answers a different question.",
      "A correction is needed when an answer contradicts itself.",
    ],
    counts: [42, 7, 9, 4, 3, 2],
    terms: [
      "understand",
      "understanding",
      "explain",
      "explanation",
      "learn",
      "learning",
      "research",
      "information",
      "topics",
      "question",
    ],
    name: "Morgan",
    body: "Morgan is trying to understand an unfamiliar topic and has a specific question in mind. They ask the assistant for an explanation with enough detail to make the idea clear. The response moves toward a different question, so Morgan brings it back to the original point. They also ask for clarification where two parts of the answer conflict. The need is a focused explanation that stays coherent as the exchange continues. This fictional scene illustrates only the cluster's published aggregate patterns. It does not add a subject, personal background, or final learning outcome, and it does not classify an ordinary request for more detail as observed friction.",
  },
  {
    id: "other-unclear",
    parentId: "research",
    title: "Other or unclear workflows",
    shortTitle: "Other or unclear",
    summary:
      "These conversations do not support a more specific workflow assignment. They remain included in the published total.",
    needs: ["Keep requests visible when their intended workflow is unclear."],
    gripes: [],
    counts: [24, 2, 16, 1, 1, 0],
    terms: ["unclear", "unclassified", "uncertain", "ambiguous"],
    name: "Drew",
    body: "Drew starts a request, but the available aggregate description does not establish a specific workflow. This fictional example stays deliberately minimal: a person turns to the assistant with something they want help doing, and the published evidence is insufficient to describe that goal more precisely. No specific frustration is established for this story. Some conversations in this group have observed friction signals, but those counts do not support inventing a detailed gripe or assigning it to Drew. The example shows why an unclear group remains visible in the overall picture. Uncertainty is part of the evidence, and the absence of a specific account is not evidence of success.",
  },
  {
    id: "adapting-travel",
    parentId: "travel",
    title: "Adapting travel plans",
    shortTitle: "Adapting travel",
    summary:
      "People revise an itinerary when timing or preferences change while keeping the rest of the plan coherent.",
    needs: [
      "Carry a changed constraint through the itinerary.",
      "Keep the revised sequence practical and understandable.",
    ],
    gripes: [
      "An updated itinerary retains an earlier constraint.",
      "A revised sequence contains inconsistent timing.",
    ],
    counts: [36, 11, 6, 7, 5, 3],
    terms: [
      "travel",
      "trip",
      "itinerary",
      "planning",
      "plans",
      "change",
      "changing",
      "timing",
      "schedule",
    ],
    name: "Taylor",
    body: "Taylor has a travel plan and needs to revise it after a constraint changes. They ask the assistant to carry the update through the itinerary while keeping the sequence understandable. Part of the revision still reflects the earlier constraint. Another part contains timing that does not fit the rest of the plan. Taylor points out both issues and asks for a coherent version they can review. The underlying need is to preserve the relationship between the parts of a changing itinerary. This fictional example illustrates published aggregate needs and frustrations. It does not invent a destination, booking, missed connection, or eventual travel outcome that the evidence does not establish.",
  },
  {
    id: "trip-details",
    parentId: "travel",
    title: "Preparing the trip details",
    shortTitle: "Trip details",
    summary:
      "People bring scattered travel details together into a clear checklist or plan they can use.",
    needs: [
      "Keep the requested travel details in one place.",
      "Distinguish confirmed information from missing details.",
    ],
    gripes: [
      "A prepared summary omits a requested detail.",
      "Information that remains uncertain is presented too firmly.",
    ],
    counts: [24, 8, 4, 5, 4, 2],
    terms: [
      "travel",
      "trip",
      "details",
      "preparation",
      "prepare",
      "checklist",
      "packing",
      "organize",
      "itinerary",
    ],
    name: "Jordan",
    body: "Jordan is gathering the details for an upcoming trip and wants one clear place to review them. They ask the assistant to organize the requested information and distinguish confirmed details from gaps. The prepared summary leaves out something Jordan asked to include. It also states an uncertain detail more firmly than the available information supports. Jordan corrects the summary so it is easier to see what is ready and what still needs checking. This invented scene reflects the published workflow and its supported frustrations. It does not add a destination, reservation, or personal circumstance, and it leaves the trip's eventual outcome unspecified.",
  },
  {
    id: "travel-changes",
    parentId: "travel",
    title: "Resolving travel changes",
    shortTitle: "Travel changes",
    summary:
      "People work through a travel change and need to understand both the available next step and its action status.",
    needs: [
      "Understand the next action when a travel arrangement changes.",
      "Know whether a requested change actually completed.",
    ],
    gripes: [
      "The proposed action does not reflect the latest request.",
      "A failed change action is not shown to recover.",
    ],
    counts: [18, 6, 3, 3, 4, 2],
    terms: [
      "travel",
      "trip",
      "change",
      "changes",
      "cancel",
      "cancellation",
      "rebook",
      "reschedule",
      "booking",
      "resolve",
    ],
    name: "Riley",
    body: "Riley needs to change a travel arrangement and asks the assistant to explain the next action. They want the latest request reflected accurately and a clear distinction between a proposed change and a completed one. The suggested action does not match the updated request, so Riley corrects it. An attempted change then fails, with no recovery established in the available evidence. The situation illustrates a need for clear action status while resolving a travel change. This fictional story draws only on the cluster's published aggregate claims. It does not identify a provider, assign a technical cause, or claim that Riley ultimately completes the change.",
  },
];

function makeCluster(seed: ClusterSeed): Cluster {
  const [
    conversationCount,
    observedFrictionCount,
    unclearCount,
    corrections,
    complaints,
    unresolvedErrors,
  ] = seed.counts;
  const metrics: ClusterMetrics = {
    conversationCount,
    conversationShare: conversationCount / TOTAL_CONVERSATIONS,
    observedFrictionCount,
    observedFrictionShare: observedFrictionCount / conversationCount,
    unclearCount,
    signals: { corrections, complaints, unresolvedErrors },
  };
  return {
    id: seed.id,
    snapshotId: SNAPSHOT_ID,
    parentId: seed.parentId,
    title: seed.title,
    shortTitle: seed.shortTitle,
    summary: seed.summary,
    needs: seed.needs,
    gripes: seed.gripes,
    metrics,
    evidence: [
      {
        id: `${seed.id}:workflow`,
        label: "Workflow",
        description: seed.summary,
      },
      {
        id: `${seed.id}:needs`,
        label: "Published needs",
        description: seed.needs.join(" "),
      },
      {
        id: `${seed.id}:friction`,
        label: "Observed friction",
        description: seed.gripes.length
          ? seed.gripes.join(" ")
          : "Observed signals do not establish a more specific published gripe.",
      },
      {
        id: `${seed.id}:metrics`,
        label: "Aggregate counts",
        description: `${conversationCount} conversations; ${observedFrictionCount} with observed friction; ${unclearCount} with unclear assessments. Signals may overlap.`,
      },
    ],
  };
}

const clusters = seeds.map(makeCluster);

export const snapshotFixture: Snapshot = {
  id: SNAPSHOT_ID,
  synthetic: true,
  period: {
    start: "2026-08-30",
    end: "2026-09-26",
    label: "Aug 30 – Sep 26, 2026",
  },
  totals: {
    conversationCount: TOTAL_CONVERSATIONS,
    observedFrictionCount: clusters.reduce(
      (total, cluster) => total + cluster.metrics.observedFrictionCount,
      0,
    ),
    unclearCount: clusters.reduce(
      (total, cluster) => total + cluster.metrics.unclearCount,
      0,
    ),
  },
  categories: [
    { id: "coordination", title: "Coordinating with others" },
    { id: "everyday", title: "Everyday work" },
    { id: "research", title: "Research & decisions" },
    { id: "travel", title: "Travel & plans" },
  ],
  clusters,
  provenance: {
    label: "Authored aggregate demo · precomputed mock insights",
    generatedAt: GENERATED_AT,
  },
};

export const storyFixtures: Record<string, FictionalStory> = Object.fromEntries(
  seeds.map((seed) => [
    seed.id,
    {
      id: `story:${SNAPSHOT_ID}:${seed.id}`,
      snapshotId: SNAPSHOT_ID,
      clusterId: seed.id,
      label: "Fictional user story",
      disclosure:
        "Illustrates an aggregate pattern; not a real customer or additional evidence.",
      name: seed.name,
      body: seed.body,
      evidenceIds: [
        `${seed.id}:workflow`,
        `${seed.id}:needs`,
        `${seed.id}:friction`,
      ],
      generatedAt: GENERATED_AT,
      simulated: true,
    } satisfies FictionalStory,
  ]),
);

export const searchTerms: Record<string, string[]> = Object.fromEntries(
  seeds.map((seed) => [seed.id, seed.terms]),
);
