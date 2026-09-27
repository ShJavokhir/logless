import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { capturePresenterKey } from "./lib/presenter"

// Read ?presenter=<key> once and strip it from the URL before anything else runs.
capturePresenterKey()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
