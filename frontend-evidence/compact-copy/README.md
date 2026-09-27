# Compact UI copy

This pass removes repeated page introductions, action subtitles, search suggestions, the duplicate sidebar highlight, the repeated story prompt, and repeated privacy footnotes. Definitions now sit under About these metrics or Supporting signals. Privacy and dataset attribution remain available from the sidebar disclosure. Story results retain a visible fictional label and evidence disclaimer.

Browser checks used the local Next.js app with its live data adapter. The overview and workflow details rendered correctly. Creating a story through the single action returned Marcus's story and moved keyboard focus to its heading. Metric help opened with pointer and keyboard. At 390 px, the page width remained 390 px with metric help open.

Screenshots: desktop.png, desktop-story.png, mobile.png. TypeScript, 16 tests, and the production build passed.

## Session-only commit boundary

The screenshots above document the shared working tree at verification time. The later session-only commit deliberately excludes the other chat's live adapter, backend, and semantic zoom work. Its isolated snapshot retains the existing mock-data adapter and explicit demo labels. That snapshot passes TypeScript and 10 tests; the production build was checked with Webpack because Turbopack rejects the temporary checkout's external node_modules symlink.
