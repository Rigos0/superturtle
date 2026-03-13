# Current task
Simplify `src/app/navigation.tsx`: remove Overview/Pricing nav links and mobile Sheet drawer; just AccountMenu when logged in or sign-in button when logged out. Then delete `src/components/ui/sheet.tsx` if orphaned.

# End goal with specs
A clean, minimal app with only the pages and components needed for:
1. GitHub OAuth login (`/login`, `/auth/callback`)
2. Dashboard (`/account`) showing identity, billing, CLI link status, machine status
3. CLI verify flow (`/cli/verify` + all `/api/cli/` and `/v1/cli/` API routes)
4. Stripe billing (webhooks at `/api/webhooks`, checkout, `/manage-subscription`)

No marketing homepage, no pricing page, no legal pages, no design system page, no email templates, no unused components. The homepage (`/`) should be a simple landing with a "Sign in with GitHub" CTA. Navigation should be just logo + account menu (logged in) or logo + sign-in button (logged out).

The build (`npm run build`) and lint (`npm run lint`) must pass when done.

Keep ALL feature controllers (`src/features/account/`, `src/features/cli/`, `src/features/pricing/controllers/`, `src/features/pricing/actions/`, `src/features/pricing/types.ts`), ALL API routes (`/api/cli/`, `/v1/cli/`, `/api/webhooks`), ALL libs (`src/libs/supabase/`, `src/libs/stripe/`), ALL utils, middleware, types. Keep `sexy-boarder.tsx` (imported by button.tsx), `badge.tsx`, `button.tsx`, `card.tsx`, `dropdown-menu.tsx`, `input.tsx`, `toast.tsx`, `toaster.tsx`, `use-toast.ts`, `section-heading.tsx`, `status-pill.tsx`, `logo.tsx`, `account-menu.tsx`.

The repo is at the cwd (superturtle-web). Some deletions may already be done from a prior partial attempt — check first and skip what's gone.

# Roadmap (Completed)
- Nothing yet

# Roadmap (Upcoming)
- Simplify all pages and components
- Verify build and lint pass

# Backlog
- [x] Delete unnecessary files: `delete-me/`, `src/features/emails/`, `src/libs/resend/`, `src/app/pricing/`, `src/app/privacy/`, `src/app/terms/`, `src/app/design-system/`, unused UI components (`collapsible.tsx`, `tabs.tsx`), unused images (`public/example*.png`, `public/hero-shape.png`, `public/section-bg.png`), `src/components/container.tsx`, `src/features/pricing/components/`, `src/features/pricing/models/`. Skip any already deleted.
- [x] Replace `src/app/page.tsx` with minimal landing: just title, one-liner, and "Sign in with GitHub" button linking to /login
- [x] Simplify `src/app/layout.tsx`: remove Footer entirely, keep header (logo + nav), main content, Toaster, Analytics
- [ ] Simplify `src/app/navigation.tsx`: remove Overview/Pricing nav links and mobile Sheet drawer; just AccountMenu when logged in or sign-in button when logged out. Then delete `src/components/ui/sheet.tsx` if orphaned. <- current
- [ ] Simplify `src/app/(auth)/auth-ui.tsx`: remove two-column layout, Terms/Privacy links, AuthFact cards; single-column sign-in card with GitHub button
- [ ] Simplify `src/app/(account)/account/page.tsx`: remove dark gradient summary panel and SectionHeading import; use clean simple cards for identity, billing, CLI, machine. Fix the /pricing link since pricing page is deleted.
- [ ] Grep entire src/ tree for dangling imports to deleted files and fix them all
- [ ] Run npm run build and fix all errors until it passes
- [ ] Run npm run lint and fix all errors until it passes
- [ ] Commit all changes with a clear message
