## Current Task
Rename page title and static public text from "LinkedOut" to "Bíbr In" in `linkedin-demo/public/index.html`.

## End Goal with Specs
Every user-visible and metadata occurrence of "LinkedOut" becomes "Bíbr In". Build and tests still pass after rename.

## Backlog
- [x] Rename header brand text from "LinkedOut" to "Bíbr In" in `linkedin-demo/src/components/header/Header.js` (line 55, the `<span>` text)
- [ ] Rename page title in `linkedin-demo/public/index.html` (`<title>` tag line 35, demo-banner text line 42, noscript line 44) <- current
- [ ] Rename in `linkedin-demo/public/manifest.json` (short_name and name fields)
- [x] Rename in `linkedin-demo/src/App.test.js` (any test assertions referencing "LinkedOut")
- [ ] Run `cd linkedin-demo && CI=true npm test -- --watchAll=false && npm run build` to confirm green
- [ ] Commit with message "Rebrand LinkedOut to Bíbr In across demo app"

## Notes
- Files to touch: `linkedin-demo/src/components/header/Header.js`, `linkedin-demo/public/index.html`, `linkedin-demo/public/manifest.json`, `linkedin-demo/src/App.test.js`
- Keep the blue color (#0a66c2) and font styling on the header brand — just change the text
- Do NOT touch mock data files or Post component
