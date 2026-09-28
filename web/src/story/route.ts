export const TABS = [
  { id: "data", label: "Dataset", short: "Data" },
  { id: "loggy", label: "Loggy", short: "Loggy" },
  { id: "build", label: "Build", short: "Build" },
  { id: "arch", label: "Architecture", short: "Arch" },
] as const

export type Tab = (typeof TABS)[number]["id"]
export type Route = { page: "explore" } | { page: "how-it-works" } | { page: "marble-lab" } | { page: "demo"; tab: Tab }

/** "#/explore" is the workspace, "#/" or "#/<tab>" the demo; anything else (in-page anchors) is not a route. */
export function readRoute(hash: string): Route | null {
  if (!hash || hash === "#") return { page: "demo", tab: "data" }
  if (!hash.startsWith("#/")) return null
  const slug = hash.slice(2).split(/[/?]/)[0]
  if (slug === "how-it-works") return { page: "how-it-works" }
  if (slug === "explore") return { page: "explore" }
  if (slug === "marble-lab") return { page: "marble-lab" }
  return { page: "demo", tab: TABS.find((t) => t.id === slug)?.id ?? "data" }
}

export const hrefOf = (tab: Tab) => `#/${tab}`
export const EXPLORE_HREF = "#/explore"
