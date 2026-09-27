import type { Node as SnapshotNode } from "@/lib/types"

type Draft = { first_name: string; text: string; citations: string[] }

// Hand-written stories for the clusters the demo focuses on. Everything here is
// invented; each story only re-tells the cluster's generalized needs/problems.
const BY_TITLE: Record<string, Draft> = {
  "Other or unclear": {
    first_name: "Sam",
    citations: ["n1", "p1"],
    text:
      "Sam has just found the site through a friend and is not sure it works, so the first message is a single word: \"hello?\" The assistant replies with a friendly, general greeting and asks how it can help. Sam types \"test\" and then a short, half-finished question about something unrelated, then leaves before the conversation gets going. Many conversations in this group look like this: very short openings, quick checks that the service responds, or messages mixing several unrelated topics. They are kept here instead of being forced into a workflow they do not really belong to.",
  },
  "Writing Midjourney / Stable Diffusion prompts": {
    first_name: "Wen",
    citations: ["n1", "n2", "p1"],
    text:
      "Wen runs a small print-on-demand shop and needs dozens of fresh poster ideas every week. Instead of writing image prompts by hand, she pastes the same long template into the assistant and adds a one-line concept — \"a lighthouse in a storm\" — asking for four detailed prompts with style and aspect-ratio flags. She does this many times a day, so a single person produces a large share of the traffic. It mostly works, but every so often the output drifts from the template's structure and she has to fix the flags before pasting them into the image generator, which slows the whole batch down.",
  },
  "Debugging Python and JavaScript errors": {
    first_name: "Tomás",
    citations: ["n1", "n2", "p1", "p2"],
    text:
      "Tomás is a second-year student building a small web scraper for a class project. When the script crashes, he pastes the traceback and asks what it means and how to fix it without rewriting everything. The first answer looks right, but running it produces a different error, so he pastes that one too. On the third try he realises the suggested call belongs to an older version of the library he installed. He fixes it himself, but wishes the assistant had asked which version he was using before answering, instead of guessing twice.",
  },
  "Rewriting essays to sound human": {
    first_name: "Mei",
    citations: ["n1", "n2", "p1", "p2"],
    text:
      "Mei has a finished essay for an English course and is worried a detector will flag parts of it as machine-written. She asks the assistant to rephrase each paragraph so it reads more naturally while keeping her argument. After the first pass she checks the result elsewhere, comes back and asks again, then again. By the fourth round the wording is different but a key point has quietly shifted, and she has to compare versions line by line to restore what she originally meant. She ends up keeping about half of the rewrite and redoing the rest herself.",
  },
  "Getting real-time info the model can't access": {
    first_name: "Dmitri",
    citations: ["n1", "n2", "p1", "p2"],
    text:
      "Dmitri wants to know today's exchange rate before paying an invoice, so he asks the assistant directly. It explains that it cannot browse the internet or see recent data. He rephrases the question, then pastes a link to a news page and asks it to read that instead. Each time he gets a polite version of the same limitation. He closes the chat and checks a bank website, but he would have stayed if the assistant had said up front what it could and could not look up, and pointed him to where the figure is published.",
  },
  "Continuing fan-fiction and story episodes": {
    first_name: "Priya",
    citations: ["n1", "n2", "p1", "p2"],
    text:
      "Priya is writing a long series about a group of friends running a haunted café, and she returns every evening to ask for the next episode. She pastes a short recap and asks the assistant to continue with plenty of dialogue. Most nights it picks up well, but sometimes a character's name or backstory changes between episodes, and she has to correct it. Longer episodes often stop halfway, so she types \"continue\" several times to get a complete chapter she can post. She keeps a separate note of character details just to paste back in.",
  },
  "Solving math and physics problems": {
    first_name: "Aliya",
    citations: ["n1", "n2", "p1", "p2"],
    text:
      "Aliya is preparing for a physics exam and pastes problems from her worksheet, asking for every step rather than just the final answer so she can compare it with her own work. The method is usually right, but on one kinematics question a small arithmetic slip gives a different result from hers. She points it out and gets a corrected answer. Problems that depend on a diagram are harder: the pasted text loses the picture, so she has to describe it in words first, and sometimes her description leaves out the one detail the solution depends on.",
  },
}

const NAMES = ["Lena", "Kofi", "Rui", "Sana", "Mateo", "Ines", "Yusuf", "Hana", "Oskar", "Noor", "Bruno", "Ada"]

function lowerFirst(s: string) {
  return s ? s[0].toLowerCase() + s.slice(1) : s
}

function sentence(s: string) {
  const t = s.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}

export function mockStory(node: SnapshotNode): Draft {
  const hand = BY_TITLE[node.title]
  if (hand) return hand
  const needs = node.needs ?? []
  const problems = node.problems ?? []
  const idx = [...node.id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % NAMES.length
  const name = NAMES[idx]
  const n1 = needs[0]
  const n2 = needs[1]
  const p1 = problems[0]
  const p2 = problems[1]
  const parts: string[] = [
    `${name} opens the assistant with a clear goal in mind: to ${lowerFirst(n1?.text ?? "get a task done quickly")}.`,
    n2 ? `Along the way ${name} also wants to ${lowerFirst(n2.text)}, and explains the situation in a few sentences.` : "",
    "The first answer is a useful start, and the conversation moves quickly for a few turns.",
    p1 ? `Then things stall: ${lowerFirst(sentence(p1.text))}` : "",
    p1 ? `${name} rephrases the request and tries again, adding more detail each time.` : "",
    p2 ? `A second snag follows — ${lowerFirst(sentence(p2.text))}` : "",
    `In the end ${name} gets part of what was needed, but spends noticeably longer than expected getting there.`,
  ]
  return {
    first_name: name,
    text: parts.filter(Boolean).join(" "),
    citations: [n1?.id, n2?.id, p1?.id, p2?.id].filter((x): x is string => !!x),
  }
}
