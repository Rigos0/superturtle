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
Pending

### Go-To-Market Narrative
Pending

### Launch Sequencing
Pending

### Sample Customer Journey
Pending

### Risks
Pending
