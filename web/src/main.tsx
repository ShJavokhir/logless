import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { StoryApp } from "./story/StoryApp.tsx"
import { capturePresenterKey } from "./lib/presenter"
import { readRoute, type Route } from "./story/route"

// Read ?presenter=<key> once and strip it from the URL before anything else runs.
capturePresenterKey()

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
  return route.page === "explore" ? <App /> : <StoryApp tab={route.tab} />
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
