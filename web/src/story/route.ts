export type Route = { page: "explore" } | { page: "story"; step: number }

export const STEPS = [
  { slug: "", label: "Intro" },
  { slug: "organize", label: "Organize" },
  { slug: "ask", label: "Ask" },
  { slug: "build", label: "Build" },
] as const

/** "#/explore" is the workspace, "#/" or "#/<step>" the story; anything else (in-page anchors) is not a route. */
export function readRoute(hash: string): Route | null {
  if (!hash || hash === "#") return { page: "story", step: 0 }
  if (!hash.startsWith("#/")) return null
  const slug = hash.slice(2).split(/[/?]/)[0]
  if (slug === "explore") return { page: "explore" }
  const step = STEPS.findIndex((s) => s.slug === slug)
  return { page: "story", step: step < 0 ? 0 : step }
}

export const hrefOf = (step: number) => `#/${STEPS[step]?.slug ?? ""}`
export const EXPLORE_HREF = "#/explore"

export const ORGANIZE_BEATS = ["One conversation", "All conversations", "The map"] as const
export const ASK_BEATS = ["The agent", "Containment"] as const
