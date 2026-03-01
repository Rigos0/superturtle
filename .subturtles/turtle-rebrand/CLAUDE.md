## Current Task
Update profile page in `linkedin-demo/src/components/profile/Profile.js`: change all "#0a66c2" to "#2e7d32", change cover gradient from blues to greens (e.g. "linear-gradient(135deg, #2e7d32 0%, #1b5e20 100%)").

## End Goal with Specs
- App name: "Turtle In" everywhere (header, title, manifest, tests, banner)
- Green color scheme replacing LinkedIn blue (#0a66c2 → #2e7d32, light blue → #66bb6a)
- All Tadeáš/Bíbr/ReKrabice/Slevomat/Behavio references removed
- Seed data uses generic professional users (not Tadeáš)
- Profile page works with generic featured user data
- Turtle emoji 🐢 in branding where appropriate
- Build passes, tests pass

## Backlog
- [x] Update Colors.js at `linkedin-demo/src/assets/Colors.js`: change LinkedInBlue from "#0073b1" to "#2e7d32" (Material green 800), LinkedInLightBlue from "#70b5f9" to "#66bb6a" (Material green 400), LinkedInBgColor stays "#f3f2ef"
- [x] Update header brand in `linkedin-demo/src/components/header/Header.js`: change text from "Bíbr In" to "Turtle In", change color from "#0a66c2" to "#2e7d32"
- [ ] Update profile page in `linkedin-demo/src/components/profile/Profile.js`: change all "#0a66c2" to "#2e7d32", change cover gradient from blues to greens (e.g. "linear-gradient(135deg, #2e7d32 0%, #1b5e20 100%)") <- current
- [ ] Update profile Style.js at `linkedin-demo/src/components/profile/Style.js`: change any blue references to green
- [ ] Update `linkedin-demo/public/index.html`: change title and banner text from "Bíbr In" to "Turtle In"
- [ ] Update `linkedin-demo/public/manifest.json`: change short_name and name to "Turtle In"
- [ ] Update `linkedin-demo/src/App.test.js`: change any "Bíbr In" references to "Turtle In"
- [ ] Replace mock user data in `linkedin-demo/src/mock/user.js`: change displayName to "Alex Turner", remove tadeas-bibr.jpg import (use "https://i.pravatar.cc/200?img=68" instead), title to "🐢 Full-Stack Developer | Building things that matter", headline to "Turning ideas into products", location to "San Francisco, CA", about to "Passionate developer with a love for clean code and great UX. Previously built products at startups and scale-ups.", experience to ["🚀 Senior Developer — TechStartup (Building the future)", "💡 Product Engineer — ScaleUp Inc (Shipping fast)", "🎓 CS Graduate — State University"], connections 500, followers 750
- [ ] Replace mock posts in `linkedin-demo/src/mock/posts.js`: change mockUsers.tadeas to use the new Alex Turner data (no tadeasBibrAvatar import, use pravatar URL). Update post descriptions to be generic professional LinkedIn-style posts (not Tadeáš box jokes). Keep the same structure and other users (Avery, Devin, Sofia) but remove any Tadeáš references from their posts too.
- [ ] Update seed data in `linkedin-demo/src/convex/seed.ts`: replace Tadeáš Bíbr with Alex Turner matching the mock user data above. Replace all Tadeáš-specific post text with the same generic professional posts. Keep 4 users + 9 posts structure.
- [ ] Update `linkedin-demo/src/components/posts/post/Post.js`: the `isTadeas` check compares against mockUser.displayName — update this to compare against the new featured user name "Alex Turner"
- [ ] Update `linkedin-demo/src/components/posts/Posts.js`: check for any Tadeáš/Bíbr references
- [ ] Delete the tadeas-bibr.jpg asset file at `linkedin-demo/src/assets/tadeas-bibr.jpg` if no longer imported
- [ ] Run `cd linkedin-demo && npm run build` to verify build passes
- [ ] Commit with message "Rebrand to Turtle In with green theme, replace demo content"

## Notes
- All paths relative to repo root `/Users/Richard.Mladek/Documents/projects/agentic/`
- Run npm commands from `linkedin-demo/`
- Key green colors: primary #2e7d32 (Material green 800), light #66bb6a (green 400), dark #1b5e20 (green 900)
- The app uses Material-UI — some colors come from the Colors.js constants (LinkedInBlue, LinkedInLightBlue), others are hardcoded as "#0a66c2" in inline styles
- Search for ALL occurrences of "#0a66c2" and replace with "#2e7d32"
- Search for ALL occurrences of "Bíbr In" and replace with "Turtle In"
- Search for ALL occurrences of "Tadeáš" or "tadeas" and replace appropriately
- The Post.js import of mockUser from "../../mock/user" should still work with the updated user data
