# PM workflow clarity

Scope: the local Muse prototype on `oh-mvp`, served at `http://127.0.0.1:3000`.
The deployed WildChat interface in the separate `master` worktree is unchanged.

## Intended first visit

1. Choose **Understand usage** or **Find problems**.
2. Open the suggested finding, browse named workflows, or search for a task.
3. Select **Inspect** to see customer needs, observed problems, and counts.
4. Select **Create example user story** to illustrate the finding.
5. Return with **Back to workflows**. The previous view and focus are preserved.

The default list makes actions explicit. The map remains available as a secondary
view, with instructions for selecting workflows and filtering categories.
All data and analysis remain mocked. Stories remain fictional and are not evidence.

## Evidence

- Desktop layout at 1440 × 900: no horizontal overflow.
- Mobile layout at 390 × 844: no horizontal overflow.
- Usage/problem selection completes the existing simulated analysis.
- Travel search returns three workflows. Writing returns two workflows.
- No-match search explains recovery; Escape clears the search.
- Keyboard Enter filters a map category and opens workflow details.
- Story generation completes with an explicit fictional disclosure.
- `?demoFailure=story` produces the expected error; Retry completes the story.
- Back to workflows returns focus to the invoking control on mobile.
- No warnings or errors were captured in either browser test tab.
- `npm run check`: TypeScript passes; all 10 existing data tests pass.
- `npm run build`: production build passes.
- Autoreview (`--mode local --no-web-search`, scoped to the three frontend files):
  no actionable findings. It reviewed the UX changes, not unrelated local edits.

These are implementation and browser checks, not a usability study with external PMs.
Projection readability at the actual venue has not been tested.

## Screenshots

- `desktop-start.png`: first visit and clear task choices.
- `desktop-detail.png`: workflow inspection and prominent story action.
- `desktop-story.png`: the completed fictional story.
- `mobile-start.png`: first visit on a narrow screen.
- `mobile-story.png`: story completion after a simulated failure and retry.

Changed implementation: `src/frontend/explorer.tsx`, `src/frontend/detail-panel.tsx`,
and `src/app/globals.css`. No adapter, dataset, API, or deployment changes.
