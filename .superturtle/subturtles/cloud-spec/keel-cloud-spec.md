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
Pending

### Architecture Principles
Pending

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
