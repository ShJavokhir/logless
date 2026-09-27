import { defineCatalog, type Spec } from "@json-render/core"
import { schema } from "@json-render/react/schema"
import { z } from "zod"

export const componentTypes = {
  ranking: "Ranking", cards: "WorkflowCards", friction: "FrictionPlot", signals: "SignalBreakdown", needs: "NeedsBoard",
} as const
export type CanvasCandidate = keyof typeof componentTypes
export type CanvasRequest = { snapshot_id: string; run_id: string; instruction: string; previous: CanvasCandidate[] }
export type CanvasResponse = {
  snapshot_id: string; run_id: string; status: "composed" | "fallback" | "needs_analysis" | "mock"
  selected: CanvasCandidate[]; spec: Spec
}

// All data comes from the checked run and published snapshot via React context.
// Empty props deliberately prevent the model from supplying numbers or prose.
const leaf = (description: string) => ({ props: z.object({}).strict(), description })
export const canvasCatalog = defineCatalog(schema, {
  components: {
    AnswerLayout: { ...leaf("Readable answer sections"), slots: ["default"] },
    Ranking: leaf("Checked counts and shares as ranked bars"),
    WorkflowCards: leaf("Workflow descriptions with checked metrics"),
    FrictionPlot: leaf("Published workflow volume versus observed friction rate"),
    SignalBreakdown: leaf("Published overlapping friction signals per workflow"),
    NeedsBoard: leaf("Published needs and recurring problems, grouped by workflow"),
  },
  actions: {},
})

export function canvasSpec(selected: CanvasCandidate[]): Spec {
  return { root: "canvas", elements: {
    canvas: { type: "AnswerLayout", props: {}, children: selected },
    ...Object.fromEntries(selected.map((id) => [id, { type: componentTypes[id], props: {}, children: [] }])),
  } }
}

const candidateSchema = z.enum(["ranking", "cards", "friction", "signals", "needs"])
const elementSchema = z.object({ type: z.string(), props: z.object({}).strict(), children: z.array(z.string()) }).strict()
const responseSchema = z.object({
  snapshot_id: z.string(), run_id: z.string(), status: z.enum(["composed", "fallback", "needs_analysis", "mock"]),
  selected: z.array(candidateSchema).min(1).max(3),
  spec: z.object({ root: z.literal("canvas"), elements: z.record(z.string(), elementSchema) }).strict(),
}).strict()

export function validateCanvas(value: unknown, request: Pick<CanvasRequest, "snapshot_id" | "run_id">): CanvasResponse {
  const result = responseSchema.parse(value)
  if (result.snapshot_id !== request.snapshot_id || result.run_id !== request.run_id) throw new Error("This view belongs to another answer.")
  if (new Set(result.selected).size !== result.selected.length) throw new Error("Repeated canvas component.")
  const expected = canvasSpec(result.selected)
  // Validate topology as well as component names; reject extra nodes, cycles,
  // expressions, event handlers and data before json-render can process them.
  if (Object.keys(result.spec.elements).length !== Object.keys(expected.elements).length) throw new Error("Unexpected canvas elements.")
  for (const [id, element] of Object.entries(expected.elements)) {
    const received = result.spec.elements[id]
    if (!received || received.type !== element.type || JSON.stringify(received.children) !== JSON.stringify(element.children)) {
      throw new Error("Invalid canvas structure.")
    }
  }
  return result
}
