## Current Task
Deploy the app to production on Vercel.

## End Goal with Specs
- App deployed to Vercel with a public URL
- Environment variable REACT_APP_CONVEX_URL set on Vercel to "https://tough-mosquito-145.convex.cloud"
- Build succeeds on Vercel (CRA build: npm run build, output dir: build)
- App loads and shows the feed with data from Convex

## Backlog
- [x] Link the project to Vercel: run `cd linkedin-demo && vercel link` — if it prompts interactively, try `vercel --yes` or `vercel deploy --yes` instead which auto-creates the project
- [x] Set environment variable on Vercel: `vercel env add REACT_APP_CONVEX_URL production` with value `https://tough-mosquito-145.convex.cloud` — if interactive prompts fail, use `echo "https://tough-mosquito-145.convex.cloud" | vercel env add REACT_APP_CONVEX_URL production`
- [ ] Deploy to production: `vercel deploy --prod --yes` from the `linkedin-demo/` directory. The build command is `npm run build` and the output directory is `build` <- current
- [ ] Verify the deployment URL loads and returns HTTP 200
- [ ] Commit any Vercel config files (`.vercel/project.json` etc) with message "Add Vercel deployment config for Bíbr In"

## Notes
- Working directory for ALL commands: `/Users/Richard.Mladek/Documents/projects/agentic/linkedin-demo`
- Vercel CLI is installed and logged in as `rigos0`
- This is a CRA (create-react-app) project: build command = `npm run build`, output dir = `build`
- The `.env.local` file has `REACT_APP_CONVEX_URL=https://tough-mosquito-145.convex.cloud` — but Vercel needs it set as an env var in the project settings too
- If `vercel link` or `vercel deploy` asks interactive questions about framework/settings, prefer `--yes` flag to auto-detect CRA
- Do NOT include `.env.local` in the deployment (it contains the dev deployment key)
- The Convex cloud URL for production is: `https://tough-mosquito-145.convex.cloud`
