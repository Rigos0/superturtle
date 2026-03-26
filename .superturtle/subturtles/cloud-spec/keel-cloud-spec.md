# Keel Cloud Product Specification

## Document Purpose
This document defines the product direction for Keel Cloud, a new developer-focused cloud platform designed to compete with AWS by being simpler, more opinionated, and faster for small teams to ship on.

## Product Snapshot
- Brand name: Keel Cloud
- Category: developer-first application cloud
- Positioning line: The opinionated cloud for teams shipping production software without building an infrastructure department.
- Core promise: Keel gives modern software teams a paved path to run APIs, jobs, databases, and internal services in production with sane defaults and fewer platform decisions.

## Brand Definition
### Why "Keel"
A keel is the structural spine that keeps a ship stable and moving in the right direction. The name signals steadiness, guidance, and focus. The brand should feel practical, reliable, and engineer-respecting rather than aspirational or futuristic.

### Brand Attributes
- Opinionated, not limiting
- Calm, precise, and competent
- Production-ready from day one
- Built for builders, not procurement theater

### Brand Narrative
AWS became the default cloud by offering every building block. For many software teams, that breadth now creates drag: too many services, too many decisions, too much invisible platform work before the product can move. Keel Cloud exists to narrow the path on purpose. It gives teams the handful of services they actually need, assembled into a coherent production platform with consistent workflows, defaults, and pricing.

## Ideal Customer Profile
### Primary ICP
Seed to Series B software companies with 5 to 40 engineers that are running revenue-critical products but do not want to staff a large platform team.

Common traits:
- Shipping multi-service web applications or APIs
- Running a small number of production environments
- Managing infrastructure today with a mix of AWS, Terraform, handwritten scripts, and operational tribal knowledge
- Feeling the pain of slow onboarding, fragile deployments, unclear spend, and platform maintenance leaking into feature work

### Core Users
- Founding engineers who need to move from prototype to reliable production
- Engineering managers responsible for team velocity and operational stability
- Staff or senior backend engineers who become the default infrastructure owner
- CTOs at smaller companies who want cloud leverage without hyperscaler complexity

### Secondary ICP
- AI application teams that need standard app infrastructure plus worker and job execution, but do not want to assemble that stack from raw cloud primitives
- Mid-market internal platform teams that want a simpler default platform for net-new services instead of expanding AWS footprint service by service

### Explicit Non-Goals for ICP
Keel Cloud should not initially optimize for:
- Large enterprises with broad procurement, sovereignty, or bespoke compliance requirements
- Lift-and-shift migrations of highly customized legacy systems
- Buyers whose main selection criterion is the absolute lowest raw infrastructure price
- Teams that want unconstrained access to dozens of low-level infrastructure primitives

## Problem Statement
Modern product teams face a bad tradeoff:
- AWS offers power and breadth, but teams pay an ongoing complexity tax to assemble, secure, observe, and operate even common application stacks.
- Lightweight developer platforms reduce setup time, but many stop short once teams need serious backend architecture, predictable networking, background workloads, or deeper operational control.

This leaves a large gap in the market: teams that need a real production cloud, but not a hyperscaler's surface area. They want opinionated infrastructure with enough control to run durable systems, without inheriting the full-time job of becoming cloud experts.

## Positioning
### Positioning Statement
Keel Cloud is the developer-first cloud for growing software teams that need production-grade backend infrastructure without hyperscaler complexity. Unlike AWS, Keel narrows the surface area to the services most teams actually need and makes them work together by default. Unlike frontend-centric or single-service platforms, Keel is designed around the full application stack: compute, networking, data, jobs, and operations.

### Competitive Frame
#### Versus AWS
Keel wins on speed to production, service cohesion, operational simplicity, and pricing clarity. AWS still wins on breadth, global scale, and long-tail enterprise requirements.

#### Versus Vercel, Render, and similar platforms
Keel wins when a team's application architecture includes multiple backend services, private networking, stateful components, and background workloads that need a more complete platform model.

#### Versus self-managed Kubernetes
Keel wins by removing cluster design, day-two operations, and platform assembly from the customer's critical path. Teams get the benefits they usually want from Kubernetes patterns without having to own Kubernetes itself.

### Positioning Principles
- Start from the application, not infrastructure primitives
- Make the best path the default path
- Expose control where it changes outcomes, not where it creates chores
- Price for trust and predictability, not for confusion

## Product Direction Outline
The sections below are intentionally left for later backlog items in this spec.

### MVP Services
Keel Cloud's MVP should feel like a complete application platform, not a loose menu of infrastructure parts. The initial surface area should stay narrow enough that every service shares the same deployment model, networking model, access controls, observability, and billing language.

#### 1. App Services
Long-running HTTP and gRPC services are the center of the platform.

Scope:
- Container-based deploys from Git or OCI images
- Autoscaling based on concurrency and CPU thresholds
- Rolling deploys with health checks and fast rollback
- Environment promotion across dev, staging, and production
- Built-in service metrics, logs, and deploy history

Default opinion:
- Every service gets a stable private address and optional public ingress
- HTTPS, health checks, and zero-downtime rollout behavior are on by default
- Runtime configuration is managed through first-party secrets and environment settings

#### 2. Jobs and Workers
The platform must support asynchronous application workloads without forcing teams into a separate infrastructure stack.

Scope:
- On-demand jobs for one-off or scheduled execution
- Always-on worker processes for queue consumers and background processors
- Cron scheduling with retry policy, timeout, and run history
- Shared build and deploy model with App Services

Default opinion:
- Jobs inherit the same network, identity, and secrets model as services
- Teams should not manage separate VM pools or bespoke schedulers

#### 3. Managed Postgres
Postgres is the default system of record for the target customer and should be a first-class product, not an add-on.

Scope:
- Provisioned Postgres instances sized for development and production
- Automated backups, point-in-time recovery window, and upgrade management
- Private connectivity from Keel services by default
- Read replicas and advanced tuning are explicitly out of MVP scope unless they are required for baseline reliability

Default opinion:
- Sensible presets should cover most workloads without exposing every engine flag
- Database creation, credentials, and rotation should fit the same workflow as the rest of the platform

#### 4. Managed Redis
Redis covers the most common caching, rate-limiting, and queue-backed app patterns.

Scope:
- Single-endpoint managed Redis for cache and ephemeral coordination use cases
- Private-only connectivity from Keel workloads
- Basic persistence and restart handling appropriate for app-platform usage

Default opinion:
- Position Redis as a performance and coordination primitive, not a primary database
- Keep configuration limited to the handful of choices customers can reason about

#### 5. Object Storage
Applications need a simple place for file uploads, generated artifacts, and model inputs/outputs.

Scope:
- S3-compatible object storage buckets
- Signed URL support
- Lifecycle retention policies for common storage classes
- Service-level access policies integrated with Keel identity

Default opinion:
- Buckets are project-scoped, private by default, and exposed publicly only through explicit configuration

#### 6. Networking and Edge Ingress
Networking is part of the product surface because customers experience it directly when they connect services together.

Scope:
- Project-scoped private service network
- Public HTTP ingress with managed TLS and custom domains
- Internal service-to-service discovery by stable name
- Environment isolation between dev, staging, and production

Default opinion:
- No customer-managed VPC design in MVP
- No manual load balancer assembly
- Public exposure should be an exception applied at the service boundary, not the default state of the network

#### 7. Platform Fundamentals Included in MVP
These are not separate SKUs, but they are required to make the platform coherent.

Included capabilities:
- Secrets and configuration management
- Centralized logs, metrics, and basic alerting
- Identity, RBAC, audit trail, and project/environment permissions
- Usage-aware billing visibility by project and service
- CLI, API, and web console for the same core workflows

#### Explicit MVP Non-Goals
The first release should not attempt to match hyperscaler breadth.

Out of scope:
- General-purpose virtual machines
- Customer-managed Kubernetes clusters
- GPU inference and training infrastructure
- Data warehouse, stream processing, or event bus products
- Multi-region active-active architectures
- Deep enterprise compliance and policy customization beyond basic auditability and access control

### Architecture Principles
Keel Cloud should behave like one product with a consistent control plane, not a collection of separately acquired services. The architecture needs to preserve that coherence even when it limits flexibility.

#### Opinionated by Default, Extensible at the Edges
The system should encode recommended patterns for deployment, networking, security, and operations. Customer choice should exist where it materially affects application outcomes, but the platform should avoid exposing low-level options that mainly create configuration debt.

Implication:
- Favor presets, guardrails, and constrained configuration surfaces over raw infrastructure knobs

#### Application-Centric Resource Model
Users should think in terms of projects, environments, services, jobs, databases, caches, and buckets rather than subnets, instances, and load balancers.

Implication:
- The control plane API, console, and CLI should share a single top-level resource model aligned to how teams ship software

#### Secure by Construction
Private networking, encrypted transport, secret isolation, and least-privilege access should be baseline behaviors rather than optional hardening steps.

Implication:
- New resources default to private reachability and explicit exposure rules
- Identity between platform components should be first-party, short-lived where possible, and auditable

#### Consistent Day-Two Operations
Every MVP service should inherit the same operational patterns for deploys, logs, metrics, access control, backups where applicable, and incident investigation.

Implication:
- Customers should not have to learn a different operational interface for each service category

#### Strong Environment Boundaries
Development, staging, and production must be treated as first-class isolated environments with predictable promotion paths.

Implication:
- Cross-environment access should be explicit and rare
- Promotion workflows should prefer immutable artifacts and configuration diffs over manual recreation

#### Managed Control Plane, Boring Data Plane
Keel can differentiate through product experience and control-plane intelligence while relying on proven underlying infrastructure patterns in the data plane.

Implication:
- Prefer mature open standards and commodity building blocks underneath a tightly integrated user experience
- Avoid novel infrastructure designs that raise operational risk without clear user benefit

#### Progressive Escape Hatches
The MVP should not pretend every team can live inside a sealed box forever. It should provide a narrow path to integrate with external systems without undermining the default platform model.

Implication:
- Support outbound connectivity, image-based deploys, API automation, and object-storage compatibility before adding raw infrastructure products

#### Reliability Over Breadth
Keel should add new services only when it can make them feel operationally complete. A smaller, dependable surface is strategically better than a larger, inconsistent one.

Implication:
- The architecture roadmap should prioritize shared platform capabilities before expanding the service catalog

### Pricing Philosophy
Keel Cloud should use pricing as a trust-building product feature. The target customer is already fatigued by hyperscaler billing sprawl, so the model must feel legible before it feels optimized.

#### Core Pricing Principles
- Make the bill explainable by an engineering manager in one screenshot
- Tie charges to user-visible platform concepts such as services, jobs, databases, and storage
- Include essential platform capabilities in the base price instead of monetizing every operational concern separately
- Optimize for predictable month-to-month spend over theoretical lowest possible unit cost
- Avoid pricing traps that punish good architecture, such as charging extra for internal networking between platform components

#### Recommended Packaging Model
Keel should price around a small number of productized building blocks rather than exposing raw infrastructure meters wherever possible.

Recommended structure:
- App Services and Workers: priced by instance class and runtime usage, with autoscaling reflected in a simple compute-hours or service-hours model
- Jobs: priced per execution tier with transparent duration bands so teams can estimate scheduled and bursty workloads
- Managed Postgres: priced as clear plans by size and backup retention band, not by dozens of independent IOPS and storage knobs
- Managed Redis: priced by memory tier with simple persistence options
- Object Storage: usage-based for stored data and egress, but with generous included transfer for common application workloads
- Platform seat or project fees: avoid in MVP unless they fund a clearly differentiated support or governance layer

#### What Should Be Included by Default
The MVP should bundle the fundamentals customers assume are part of a production platform:
- TLS and custom domains
- Logs, metrics, deploy history, and basic alerting
- Secrets management
- Private service networking
- Backups for managed databases within a defined retention window
- Staging environments up to a reasonable baseline quota

This inclusion model reinforces the product thesis: Keel sells a coherent platform, not a low entry price followed by operational add-ons.

#### Pricing Page Philosophy
The public pricing page should answer three questions immediately:
1. What does a small production team typically spend?
2. What causes the bill to grow?
3. What is included without surprise line items?

The page should use archetypal workload examples such as "single API plus worker plus Postgres" and "multi-service SaaS app" so buyers can map pricing to their actual architecture.

#### Strategic Pricing Stance
Keel does not need to beat AWS on every raw unit. It needs to win on total cost of operation for small teams. The pricing story should explicitly frame savings in avoided platform labor, faster onboarding, fewer misconfigurations, and lower need for specialist infrastructure staffing.

#### MVP Pricing Guardrails
- No separate charges for internal service-to-service traffic within a project
- No pricing dimensions that require customers to understand cloud networking internals
- No enterprise custom pricing motion in the first launch wave unless tied to a specific design-partner agreement
- Usage alerts and spend visibility should be present before aggressive scale makes surprise bills possible

### Go-To-Market Narrative
Keel Cloud should go to market as the cloud for teams that have outgrown hobby-hosting tools but reject the complexity tax of AWS. The narrative is not "all cloud, reimagined." It is "the handful of things modern product teams actually need, already assembled into a production platform."

#### Core GTM Thesis
The wedge is not IT transformation. It is engineering teams hitting the point where backend complexity starts stealing roadmap time. Keel wins when a team says:
- "We need something more complete than our current deploy platform"
- "We do not want to hire platform engineers yet"
- "AWS can do this, but we do not want to assemble it ourselves"

#### Primary Buyer Motion
The initial motion should be founder-led and engineering-led:
- Top-of-funnel audience: founders, CTOs, staff engineers, and engineering managers at small to mid-size software companies
- Initial sale shape: self-serve evaluation supported by high-touch founder or solutions-engineer help for migration design
- Conversion trigger: a team chooses Keel for a net-new service, staging environment overhaul, or migration off a brittle Render or AWS hand-built stack

This is a product-led sale with informed human support, not a pure self-serve commodity signup and not a heavy enterprise field motion.

#### Message Hierarchy
Keel's messaging should ladder from pain to promise in a disciplined order:

1. Too much cloud complexity is stealing engineering time.
2. Most teams only need a focused set of production services.
3. Keel makes those services work together by default.
4. You get control where it matters without building an internal platform team.

#### Category Framing
Keel should position itself as a developer-first application cloud, not simply a PaaS. That framing gives room for databases, networking, workers, and object storage without implying hyperscaler breadth.

#### Launch Channels
Recommended initial channels:
- Founder and operator networks for design-partner recruitment
- Technical content aimed at migration stories, architecture simplification, and transparent pricing comparisons
- Targeted outreach to startups already showing signs of AWS fatigue or backend-platform sprawl
- Product Hunt, Hacker News, and engineering communities only after the onboarding path and core documentation are strong enough to survive scrutiny

#### Proof Points Needed Early
The GTM motion depends on evidence, not slogans. The first launch materials should include:
- Architecture diagrams showing a realistic production app deployed on Keel
- Side-by-side operational comparison versus a typical AWS setup for the same workload
- Clear pricing examples for common team sizes and stack shapes
- Two or three strong customer or design-partner stories focused on faster setup, lower ops burden, or smoother developer onboarding

#### Competitive Story
Against AWS, Keel should emphasize coherence, speed, and predictability. Against lighter platforms, it should emphasize completeness for real backend systems. The company should avoid claiming universal superiority; the sharper message is that Keel is the best default for a specific class of software teams.

### Launch Sequencing
Keel Cloud should launch in deliberate stages so the product earns trust before broadening distribution. The sequencing should mirror the product thesis: narrow scope, strong defaults, operational completeness.

#### Phase 0: Design Partner Validation
Goal:
- Validate that the proposed resource model, deployment workflow, and pricing language solve real pain for the target ICP

Requirements:
- 5 to 10 design-partner teams with real staging or production workloads
- Weekly product feedback loops with direct access to founders or core product/engineering leads
- Manual migration assistance where needed to expose onboarding gaps quickly

Exit criteria:
- Repeated successful deployment patterns across app services, jobs, and managed Postgres
- Evidence that customers understand the platform model without custom retraining
- Clear objections and missing features ranked by frequency, not by loudest request

#### Phase 1: Private Beta
Goal:
- Prove that a small number of external teams can onboard with documentation and light support instead of fully manual setup

Scope:
- Public marketing remains limited
- Access is gated through waitlist approval
- Reliability targets and support expectations are explicit and conservative

Required assets:
- Core docs for deploys, networking, database provisioning, rollback, and pricing
- Opinionated quickstart for a representative web application stack
- Basic usage visibility and billing previews

Exit criteria:
- Time-to-first-production-deploy is consistently short for the target customer profile
- Most support issues are product or documentation fixes, not bespoke one-off infrastructure work
- At least a handful of customers are running revenue-adjacent workloads with stable weekly usage

#### Phase 2: Public Beta
Goal:
- Open the product to a broader developer audience while preserving credibility through a still-constrained surface area

Scope:
- Self-serve signup for the supported MVP product set
- Public pricing page and migration guides
- Broader launch marketing through content, communities, and selected partnerships

Focus:
- Tighten activation funnels
- Improve in-product guidance and failure recovery
- Turn early customer wins into repeatable sales and onboarding assets

Exit criteria:
- Activation, deployment success, and early retention metrics are healthy enough to scale acquisition
- Core support load remains manageable without white-glove intervention as the default
- Reliability and billing trust are strong enough that reference customers will speak publicly

#### Phase 3: General Availability
Goal:
- Present Keel as a dependable default platform for the defined ICP, with strong product confidence and a clear roadmap

Requirements:
- Stable onboarding without founder intervention
- Credible uptime, incident response, and support processes
- Mature billing accuracy and customer-facing spend controls
- A roadmap that deepens the platform rather than immediately expanding into hyperscaler sprawl

#### Sequencing Principles
- Add customer volume before adding major service breadth
- Fix operational rough edges before broad launch campaigns
- Use every launch phase to sharpen the ICP rather than broadening it prematurely
- Treat billing trust and migration success as launch blockers, not polish work

### Sample Customer Journey
Pending

### Risks
Pending
