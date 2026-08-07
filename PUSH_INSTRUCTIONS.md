# Incident 9:42 visual interface update

Use these two files to update the GitHub repository:

- `frontend/src/App.tsx`
- `frontend/src/styles.css`

What changed:

- Rebuilt the mission workspace to match the provided reference interface.
- Added a left mission rail with Relay Nine mission brief, Mara coaching, captions, and next decision guidance.
- Expanded the center service topology into a more dimensional service map.
- Moved Live Signals and Evidence into a right rail.
- Changed the answer area into four decision cards across the bottom.
- Kept answer selection randomized for each new attempt.
- Updated narration, captions, guided focus, and instructions so they point to the new visual layout.
- Kept accessibility controls, closed captions, text size controls, music toggle, replay, reset, and xAPI tracking.

Push steps:

```bash
git add frontend/src/App.tsx frontend/src/styles.css
git commit -m "Update Incident 9:42 interface to reference layout"
git push origin main
```

Render should redeploy from the GitHub push if auto deploy is enabled.
