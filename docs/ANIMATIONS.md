# CRM animations

The animation reference supplied in `Downloads/animations.css` is adapted in `client/src/styles/animations.css` and imported once after the base stylesheet in `client/src/main.jsx`. The original download is unchanged. No animation library or new project dependency is required.

- Page content fades up on pathname changes. The wrapper keeps the same key during account checks, query refreshes and search-parameter changes, preserving mounted forms and their drafts.
- Dashboard metrics/panels, property cards and target cards have staggered entrances, soft shadows, a gold top accent and mouse hover lift. The stagger stops increasing after the eighth item. Entrance animations release their transform afterward so hover effects still work.
- Shared buttons, button links and upload labels lift 1 px on hover and press in on click (the earlier shine sweep was removed in the October 2026 redesign). Disabled buttons do not move. Sidebar links change colour and their icon scales slightly; the sidebar width animates when collapsed or expanded.
- Shared tables highlight hovered rows and rows containing keyboard focus. Inputs retain a gold focus ring. Selected call deal tags use a gold border and background.
- Native dialogs and reminders pop in. Dialogs closed with ×, Escape or the backdrop fade out for 140 ms first (skipped when the browser prefers reduced motion, and when a parent keeps the dialog open). Toasts slide in and fade out just before they disappear. Segmented tabs ease between states. Pipeline and target progress bars grow from the left, dashboard stage bars grow upward and the on-time ring draws itself. Loading status includes a small shimmer underneath its text.
- The reminder bell animates on mouse hover; unread counts pulse for three cycles when their count changes. Mouse-only effects use `(hover: hover) and (pointer: fine)`.
- Reduced-motion preferences stop animations and transitions, including pseudo elements, hover/press movement and shimmer. Static focus, color and selection feedback remains visible.

The stylesheet uses the existing `--navy` and `--gold` palette. Timing is centralized in `--fx-fast`, `--fx-med` and `--fx-slow`, which since the redesign map to the design tokens `--dur-fast` (140 ms), `--dur` (200 ms) and `--dur-slow` (300 ms) in `tokens.css`. See `UI_DESIGN_SYSTEM.md`. Hover, entrance and press motion primarily use transforms and opacity. Decorative overlays ignore pointer events, and ordinary content remains visible if animations are disabled.

Run the CRM normally with `npm run dev` and refresh the browser to see the changes. Verification results and browser limitations are recorded in `VERIFICATION.md`.
