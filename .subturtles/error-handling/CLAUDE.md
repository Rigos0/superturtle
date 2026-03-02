## Current Task
Add confirm dialogs for destructive actions: delete post, remove connection, remove experience/education — use MUI Dialog with "Are you sure?" pattern.

## End Goal with Specs
Every mutation that can fail shows a user-facing Snackbar/toast on error. No more silent console.error failures. Consistent pattern across all components.

## Backlog
- [x] Create shared error toast hook or context — `linkedin-demo/src/hooks/useErrorToast.js` — provides `showError(message)` that renders a MUI Snackbar. Or use a simple pattern each component can adopt.
- [x] Add error toasts to Post.js mutations (lines ~367, 468, 492, 525, 551, 619, 643) — like, comment, delete, edit, bookmark, repost all need user feedback on failure
- [x] Add error toasts to Profile.js mutations (lines ~467, 483, 499, 521, 553, 622, 694, 717, 790, 816, 850, 868, 894, 957, 1006) — experience, education, skills, photo uploads, profile edits
- [x] Add error toasts to Network.js mutations (lines ~82, 98, 114, 131, 157, 432, 464) — connect, accept, reject, follow
- [x] Add error toasts to Messaging.js (line ~123) — send message failure
- [x] Add error toasts to Notifications.js (lines ~69, 106) — mark read, clear all
- [ ] Add confirm dialogs for destructive actions: delete post, remove connection, remove experience/education — use MUI Dialog with "Are you sure?" pattern <- current
- [ ] Test build: `cd linkedin-demo && npm run build`
- [ ] Commit

## Notes
- Post.js already has a Snackbar for report success (lines ~1320-1326) — follow that pattern
- MUI Snackbar + Alert: `import { Snackbar } from '@material-ui/core'; import { Alert } from '@material-ui/lab'`
- Keep error messages user-friendly: "Failed to save comment. Please try again." not raw error text
- Add try/catch around all mutation calls that currently only console.error
