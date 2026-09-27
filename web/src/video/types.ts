// The brief the API returns (docs/VIDEO_BRIEF.md). Every number here was filled by
// the backend from published metrics; the model only wrote the words.

export type Signal = "correction" | "repeat_request" | "assistant_limit" | "complaint"

export type MapLeaf = { id: string; title: string; share: number; conversations: number; friction_share: number | null }
export type MapCategory = MapLeaf & { is_other: boolean; children: MapLeaf[] }

type Base = { seconds: number; from_frame: number; frames: number; headline: string }

export type IntroScene = Base & { type: "intro"; kicker?: string | null }
export type MapScene = Base & { type: "map"; data: { categories: MapCategory[] } }
export type TopScene = Base & {
  type: "top_workflows"
  data: { items: { id: string; title: string; category: string; share: number; conversations: number; people: number }[] }
}
export type FrictionScene = Base & {
  type: "friction"
  data: {
    overall_share: number
    items: { id: string; title: string; friction_share: number; friction_conversations: number; conversations: number }[]
  }
}
export type SignalsScene = Base & {
  type: "signals"
  data: { friction_conversations: number; items: { signal: Signal; label: string; conversations: number }[] }
}
export type SpotlightScene = Base & {
  type: "spotlight"
  insight: string
  data: {
    id: string
    title: string
    category: string
    description: string
    share: number
    conversations: number
    people: number
    friction_share: number | null
    signals: Partial<Record<Signal, number>>
    problems: string[]
    needs: string[]
  }
}
export type LanguagesScene = Base & {
  type: "languages"
  data: { languages: number; items: { name: string; conversations: number; share: number }[] }
}
export type TakeawaysScene = Base & { type: "takeaways"; bullets: string[] }
export type OutroScene = Base & { type: "outro"; data: { snapshot_id: string; pipeline: string } }

export type Scene =
  | IntroScene
  | MapScene
  | TopScene
  | FrictionScene
  | SignalsScene
  | SpotlightScene
  | LanguagesScene
  | TakeawaysScene
  | OutroScene

export type Brief = {
  brief_id: string
  snapshot_id: string
  generated_at: string
  model: string
  label: string
  fps: number
  width: number
  height: number
  duration_frames: number
  title: string
  dataset: { name: string; workspace: string; period_start: string; period_end: string }
  totals: {
    conversations: number
    people: number
    languages: number
    friction_share: number
    friction_conversations: number
    unclear: number
  }
  scenes: Scene[]
  metrics_used: { name: string; value: string }[]
  checks: string[]
  attempts: number
  video_status?: "ready" | "rendering" | "failed" | "none" | "unavailable"
  video_url: string | null
}

export type BriefVideoProps = { brief: Brief }

/** GET/POST /api/brief. */
export type BriefResponse = { status: "ready"; brief: Brief } | { status: "pending"; run_id: string } | { status: "none" }
