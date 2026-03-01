## Current Task
Ensure viewport meta tag is present and correct for mobile.

## End Goal with Specs
- Browser title shows "LinkedOut" and indicates demo.
- `public/manifest.json` name/short_name updated to LinkedOut.
- `public/index.html` includes an explicit demo note in meta or body.
- No changes to React component files (avoid conflicts).

## Backlog
- [x] Update `linkedin-demo/public/index.html` title to "LinkedOut" and add a brief demo description meta
- [ ] Ensure viewport meta tag is present and correct for mobile <- current
- [ ] Update `linkedin-demo/public/manifest.json` name and short_name to "LinkedOut" (or "LinkedOut Demo")
- [ ] Add a small demo banner in `linkedin-demo/public/index.html` (e.g., in root div comment or noscript) without touching React files

## Notes
- Only touch files under `linkedin-demo/public/`
- Keep changes minimal to avoid merge conflicts
