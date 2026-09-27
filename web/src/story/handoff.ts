import { hrefOf } from "./route"

// A question chosen elsewhere in the story (a map finding, a roadmap row) is asked on the Ask step.
let pending: string | null = null

export function askFromStory(question: string) {
  pending = question
  window.location.hash = hrefOf(2)
}

export function takePendingQuestion(): string | null {
  const q = pending
  pending = null
  return q
}
