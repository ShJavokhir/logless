# Motion verification

The animation changes cover story reveals (200 ms), analysis-stage changes (150 ms), and primary-button presses (150 ms). They use CSS transitions and the shared `--ease-out` curve. Keyboard and assistive activation skip these new effects. Reduced motion uses 100 ms opacity-only transitions.

`browser-checks.json` contains browser transition events and computed styles from the actual frontend components, bundled with the existing local adapter fixtures. Story generation on the live connection returned an error during concurrent integration, so these checks do not establish successful live story generation. The fixture screenshot is a test view, even though the product labels retain the concurrent integration's Live API wording.

The reduced-motion check forced the existing media-query rule bodies active in test-served CSS. It did not change the operating system preference. Normal stage and story events reached their final values in 150 ms and 200 ms. Reduced-motion stage and story events used only opacity, ending in 100 ms. Keyboard-triggered and cached keyboard stories had no transition or transform. Pointer-button transform events were observed; the automated click released immediately, so a held press was not measured.

Validation: `npm run check` passed TypeScript and all 16 tests. `npm run build` passed. The autoreview helper ran with `--mode local --no-web-search`, scoped to the animation changes in the three frontend files, and returned no actionable findings.
