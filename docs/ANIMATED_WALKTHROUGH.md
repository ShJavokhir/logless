# Animated walkthrough

Open `/how-it-works`, or select **How Logless works** in the explorer sidebar.

The 26-second sequence explains conversations → private abstractions → discovered
themes → Jev decisions → published aggregates. It is an explanation, not a live
pipeline run or a sandbox execution receipt.

## Design choice

A particle canvas could emphasize volume, but would need a separate text and
accessibility layer. An SVG timeline keeps the examples, decisions, and privacy
boundary readable and supports exact seeking. The implementation uses SVG with
native Web Animations, without adding a motion or scrolling library.

Only transforms and opacity animate. All elements share the same timeline;
chapter buttons pause at settled poses. Playback stops after one pass and pauses
when the page is hidden or the player leaves the viewport. Mobile has its own
composition. System reduced motion and the **Still frames** control use the same
static chapter mode. Native range controls support keyboard seeking.

## Data boundary

Conversation examples and theme illustrations are authored fiction. The page
loads only the existing published snapshot endpoint. Final conversation and
workflow counts come from that snapshot. Circle sizes are schematic. If the API
fails, the page shows the explanation without measured counts. No provider keys,
source fixtures, abstractions, or per-record decisions enter the client bundle.

The reusable component is `src/frontend/pipeline-story.tsx`; its styles are in
`src/frontend/pipeline-story.css`. `CHAPTERS` defines narration and settled poses.
