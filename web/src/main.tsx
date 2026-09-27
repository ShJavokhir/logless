import { lazy, Suspense, StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { StoryApp } from "./story/StoryApp.tsx"
import { capturePresenterKey } from "./lib/presenter"
import { readRoute, type Route } from "./story/route"

// Read ?presenter=<key> once and strip it from the URL before anything else runs.
capturePresenterKey()
const HowItWorks = lazy(() => import("./explainer/HowItWorks"))
const MarbleLab = lazy(() => import("./lab/MarbleLab"))

function Root() {
  const [route, setRoute] = useState<Route>(() => readRoute(window.location.hash) ?? { page: "demo", tab: "data" })
  useEffect(() => {
    // Only "#/..." hashes are routes; in-page anchors such as #containment leave the page alone.
    const onHash = () => {
      const next = readRoute(window.location.hash)
      if (next) setRoute(next)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])
  if (route.page === "how-it-works") return <Suspense fallback={<p className="p-8">Loading the guide…</p>}><HowItWorks /></Suspense>
  if (route.page === "marble-lab") return <Suspense fallback={null}><MarbleLab /></Suspense>
  return route.page === "explore" ? <App /> : <StoryApp tab={route.tab} />
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
