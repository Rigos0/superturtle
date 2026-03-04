## Current Task
Run commit for plain-HTML dashboard detail routes and clickable links (`feat(dashboard): plain html pages with clickable detail links`).

## End Goal with Specs
No custom CSS in dashboard HTML and working clickable detail pages:
- `/dashboard` plain HTML only
- `/dashboard/subturtles/:name`
- `/dashboard/jobs/:id`
- `/dashboard/processes/:id`

Each detail page must show real API data and links back to `/dashboard`.

## Backlog
- [x] In `super_turtle/claude-telegram-bot/src/dashboard.ts`, remove `<style>` from `renderDashboardHtml()` and simplify markup to plain HTML tables/lists only
- [x] In `renderDashboardHtml()` script, render anchors for SubTurtle names (`/dashboard/subturtles/<name>`), process labels (`/dashboard/processes/<id>`), and current jobs (`/dashboard/jobs/<id>` from `/api/jobs/current`)
- [x] Add HTML route handlers in `routes` for `/dashboard/subturtles/:name`, `/dashboard/jobs/:id`, `/dashboard/processes/:id` that fetch existing API helpers and render plain HTML pages with core fields and `<pre>` logs/JSON blocks
- [x] Add tests in `super_turtle/claude-telegram-bot/src/dashboard.test.ts` for new `/dashboard/...` route matches and ensure root HTML no longer contains `<style>`
- [x] Run `bun test super_turtle/claude-telegram-bot/src/dashboard.test.ts`
- [x] Commit with message: `feat(dashboard): plain html pages with clickable detail links`

## Loop Control
STOP

## Notes
- Keep JSON API endpoints unchanged.
- Do not spend time on design/styling; functionality only.
- Do one focused commit and stop.
