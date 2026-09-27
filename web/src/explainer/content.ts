export const examples = [
  {
    label: "Group plans",
    request:
      "Move dinner to Friday. Check the group chat and update the calendar.",
    outcome: "The event moved, but one invitation failed to send.",
    goal: "Coordinate a group event",
    facet: "One participant did not receive the updated invitation.",
    category: "Coordination",
    workflow: "Group scheduling",
    rule: "Arrange or change a shared event across participants.",
    exclude: "Personal reminders without group coordination.",
    signals: ["Not observed", "Not observed", "Observed"],
  },
  {
    label: "Shared chores",
    request: "Rotate the chores between us and remind whoever is up next.",
    outcome: "The rotation was assigned and the reminders were created.",
    goal: "Share recurring responsibilities",
    facet: "A schedule and reminders were created for recurring tasks.",
    category: "Coordination",
    workflow: "Shared responsibilities",
    rule: "Assign recurring responsibilities across people.",
    exclude: "One-off chores for a single person.",
    signals: ["Not observed", "Not observed", "Not observed"],
  },
  {
    label: "Travel",
    request: "Find a refundable stay near the station. Ask me before booking.",
    outcome:
      "The user corrected a non-refundable recommendation. No booking was made.",
    goal: "Find a stay within constraints",
    facet: "The recommendation missed the refundability requirement.",
    category: "Planning",
    workflow: "Travel constraints",
    rule: "Find accommodation that meets explicit constraints.",
    exclude: "Flights or general destination research.",
    signals: ["Observed", "Not observed", "Not observed"],
  },
  {
    label: "Morning brief",
    request: "Brief me each morning from my inbox, calendar and saved links.",
    outcome: "The user complained that the brief missed an urgent reply.",
    goal: "Prioritize daily information",
    facet: "The summary omitted an item the user said was urgent.",
    category: "Information",
    workflow: "Morning briefings",
    rule: "Combine sources into a prioritized daily summary.",
    exclude: "Drafting a single reply.",
    signals: ["Not observed", "Observed", "Not observed"],
  },
] as const;

// Public source rows are kept separate from the authored pipeline scenarios above.
export const wildChatSamples = [
  {
    topic: "Travel advice",
    meta: "English · 1 turn · GPT-4",
    row: 133,
    messages: [
      {
        role: "User",
        text: "What are the security concerns when travelling to Italy?",
      },
      {
        role: "Assistant",
        text: "While Italy is generally considered a safe country for tourists…",
      },
    ],
    note: "The reply continues with practical travel advice.",
  },
  {
    topic: "Programming help",
    meta: "English · 3 turns · GPT-4",
    row: 160,
    messages: [
      {
        role: "User",
        text: "Please explain building a custom arc in rust language",
      },
      {
        role: "Assistant",
        text: "Explains Rust’s Arc<T> and shared ownership across threads.",
        summarized: true,
      },
      {
        role: "User",
        text: "What's a real life situation where a custom arc is necessary?",
      },
    ],
    note: "The user later asks for a database-specific example. Two assistant replies and the final exchange are omitted.",
  },
  {
    topic: "Research and revision",
    meta: "Arabic · 3 turns · GPT-3.5 Turbo",
    row: 4,
    messages: [
      {
        role: "User",
        text: "اكتب لي بحث عن اهميه نظام اتحاد النقل الجوي الدولي بالنسبه لاشخاص والبضائع والتاءمين عليها",
      },
      {
        role: "Assistant",
        text: "Writes an Arabic overview of international air transport, goods, and insurance.",
        summarized: true,
      },
      { role: "User", text: "هل يمكنك استبدال IATA بكلمه نظام الاتحاد الدولي" },
    ],
    note: "The first request asks for a paper on air transport. The follow-up asks to replace “IATA” with an Arabic phrase. Later messages are omitted.",
  },
] as const;

export const stages = [
  {
    title: "Start with what people actually need.",
    short: "Conversations",
    role: "PRIVATE INPUT",
    body: "Start with the user’s goal and what happened next. Read the conversation in context.",
    detail:
      "Try the examples on the right. They are authored personal-assistant scenarios, not private records from the live dataset.",
  },
  {
    title: "Keep the meaning. Generalize the details.",
    short: "Private facets",
    role: "GLM · UNDERSTAND",
    body: "GLM summarizes the goal and outcome into private facets. Names and distinctive details are generalized.",
    detail:
      "Model providers process the submitted inputs. Private here means unavailable to the analyst—not invisible to the model provider.",
  },
  {
    title: "Discover workflows, not just keywords.",
    short: "Workflow themes",
    role: "EMBEDDINGS + GLM · ORGANIZE",
    body: "Group similar goals. Give each workflow a clear name and membership rules.",
    detail:
      "Embeddings represent similarity numerically. The current pipeline embeds generalized facets through Fireworks, then uses GLM for naming and hierarchy.",
  },
  {
    title: "Make small, explicit decisions.",
    short: "Jev decisions",
    role: "JEV · CLASSIFY",
    body: "Jev assigns a workflow and checks three signals independently: correction, complaint, and unresolved action error.",
    detail:
      "Not observed does not mean successful. Uncertainty stays unclear, and unmatched interactions retain an Other destination. Counts are calculated in code.",
  },
  {
    title: "Share the pattern. Keep the records private.",
    short: "Published insights",
    role: "PRIVACY GATE + CODE · PUBLISH",
    body: "Check descriptions for privacy. Count in code. Publish a map of workflows and friction—not individual conversations.",
    detail:
      "The browser receives generalized cluster summaries and aggregate metrics. Semantic search with Jev matches only published titles and descriptions.",
  },
] as const;

export const gateCases = {
  aggregate: {
    label: "Aggregate answer",
    a: '{ "conversations": 24, "friction": 6 }',
    b: '{ "conversations": 24, "friction": 6 }',
    status: "Release the checked result",
    detail:
      "Both programs agree. The result matches the allowed schema and the relevant published-map checks. Verified numbers can fill the explanation.",
    pass: true,
  },
  leak: {
    label: "Per-person export",
    a: '{ "user_id": 17, "conversation": "…" }',
    b: '{ "conversations": 24, "friction": 6 }',
    status: "Block the output",
    detail:
      "Individual records are outside the output contract. The app rejects the payload; it does not send the private value to the browser or the repair prompt.",
    pass: false,
  },
  disagree: {
    label: "Programs disagree",
    a: '{ "conversations": 24, "friction": 6 }',
    b: '{ "conversations": 24, "friction": 9 }',
    status: "Repair once. Check again.",
    detail:
      "Disagreement prevents release. The agent gets fixed check names for one repair round. If the programs still fail or disagree, no answer is returned.",
    pass: false,
  },
} as const;
