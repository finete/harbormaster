# Volatility-Based Architecture Guide

This guide provides volatility-based decomposition principles for designing maintainable, change-resilient service architectures.

> **Harbormaster calibration:** the **Resource Access separation is a hard
> rule** — all storage/external-system I/O (state files, git, GitHub, Pi
> sessions, ptys) goes through `*Access` services exposing atomic business
> verbs, and nothing above the access layer touches a resource directly.
> The "business logic must live in Engines" guidance is advisory: small rule
> sets may live in their Manager until they are shared or volatile enough to
> deserve an Engine. Call-chain direction rules (no upward calls, no layer
> bypassing) remain hard.

---

## Core Concept: Volatility-Based Decomposition

### Why Avoid Functional Decomposition

Functional decomposition—basing services on the order of logical steps in use cases—leads to:

- **Service explosion or bloating**: Too many small services or too few large ones
- **Duplicated behaviors**: Same logic spread across multiple services
- **Polluted clients**: Business logic leaks into client layer
- **Prevented reuse**: Services coupled to specific use case order
- **Change amplification**: Any change impacts multiple components

**The House Analogy**

❌ **Functional decomposition of a house:**
```
Cooking → Eating → Bathing → Sleeping → Entertaining → Working...
```
How many sub-services under "Cooking"? (Breakfast, Lunch, Dinner, Guests, Snacks...)
How would you implement "just cooking"? Impossible—it touches everything.

✅ **Volatility-based decomposition of a house:**
```
Kitchen | Bedroom | Living Room | Garage | Bathroom
```
Each room encapsulates its own volatility. Changes to the kitchen don't affect bedrooms.

### The Principle

> **Encapsulate change to insulate from it.**

Decompose based on what *could change*, not on what *happens in sequence*.

### Two Axes of Volatility

Identify volatility along two independent axes:

| Axis | Description | Example |
|------|-------------|---------|
| **Same customer over time** | What changes as requirements evolve | Authentication methods, notification transport |
| **Same time across customers** | What varies between deployments/customers | Locale rules, feature flags, integrations |

Axes should be independent. If they're not, you may have functional decomposition in disguise.

### When to Identify Volatilities

- **Before architecture and decomposition** (during requirements gathering)
- Ask: "What could change along each axis?"
- Designating a volatility costs nothing—later you allocate effort to design

### From Volatility to Services

The mapping from volatilities to services is rarely 1:1:
- Sometimes a single service encapsulates multiple volatility areas
- Some areas map to operational concepts or third-party components
- Data storage volatility → Access Services
- Notification volatility → Notification Service
- Workflow volatility → Workflow Manager

---

## Service Classification

The Method defines four service types organized in layers:

### Service Types

| Type | Purpose | State | Key Characteristics |
|------|---------|-------|---------------------|
| **Manager** | Orchestrate workflows and use cases | Session state | Collection of related use cases; coordinates Engines |
| **Engine** | Implement business rules and activities | Stateless | Shareable between Managers; pure logic |
| **Resource Access** | Abstract data storage | Owns data | Atomic business verbs (not CRUD); shared across layers |
| **Utility** | Cross-cutting infrastructure | Config only | Logging, Security, Pub/Sub, Hosting |

### Decision Table: "If X → It's a Y"

| If the component... | It's a... | Examples |
|---------------------|-----------|----------|
| Orchestrates a workflow or use case | **Manager** | `TradeWorkflowManager`, `OrderManager`, `CheckoutManager` |
| Encapsulates the *sequence* of steps | **Manager** | `OnboardingManager`, `PaymentFlowManager` |
| Implements business rules, is stateless | **Engine** | `PricingEngine`, `ValidationEngine`, `RiskEngine` |
| Can be shared between multiple workflows | **Engine** | `TaxCalculationEngine`, `DiscountEngine` |
| Abstracts where/how data is stored | **Resource Access** | `TradesAccess`, `CustomersAccess`, `OrdersAccess` |
| Exposes atomic business verbs (not CRUD) | **Resource Access** | `ReserveInventory()`, `DebitAccount()` |
| Provides infrastructure to all services | **Utility** | `Logging`, `Security`, `Pub/Sub`, `MessageBus` |

### Detailed Service Definitions

#### Managers
- **Encapsulate volatility in**: Sequence of use cases and workflows
- **Each Manager is**: A collection of related use cases
- **May use**: Zero or more Engines
- **Contains**: Session state, workflow coordination logic
- **Changes when**: Use case sequence changes (not when rules change)

#### Engines
- **Encapsulate volatility in**: Business rules and activities
- **Are**: Stateless and shareable between Managers
- **May use**: Resource Access services and other Engines
- **Changes when**: Business rules change (not when workflow changes)

#### Resource Access
- **Encapsulate volatility in**: Where and how data is stored
- **Expose**: Atomic business verbs (e.g., `ReserveStock`, `TransferFunds`)
- **NOT**: Raw CRUD operations (`Create`, `Read`, `Update`, `Delete`)
- **Can be**: Shared across Engines and Managers
- **Changes when**: Storage technology or location changes

#### Utilities
- **Provide**: Common infrastructure to all services
- **Examples**: Logging, Diagnostics, Security, Pub/Sub, Hosting, Message Bus
- **Are**: Cross-cutting concerns that every service needs

### Codebase Mapping

| Generic Term | This Codebase |
|--------------|---------------|
| Manager | `lib/services/*Manager` or workflow orchestrators |
| Engine | `lib/services/*Engine` or stateless business logic services |
| Resource Access | `lib/services/*Access` or MongoDB repositories |
| Utility | `lib/go/` utilities, logging, security packages |
| Resource | MongoDB collections, external APIs, file storage |

---

## Call Chain Rules

### Allowed Call Directions

```
┌─────────────────┐
│     Client      │  (Presentation layer)
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│    Manager      │────▶│    Utility      │
└────────┬────────┘     └─────────────────┘
         │                      ▲
         ▼                      │
┌─────────────────┐             │
│     Engine      │─────────────┤
└────────┬────────┘             │
         │                      │
         ▼                      │
┌─────────────────┐             │
│ Resource Access │─────────────┘
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    Resource     │  (Database, External API)
└─────────────────┘
```

### Rules Summary

| From | Can Call | Cannot Call |
|------|----------|-------------|
| Client | Manager, Utility | Engine, Resource Access, Resource |
| Manager | Engine, Resource Access, Utility | Other Managers (avoid), Client |
| Engine | Resource Access, Utility, other Engines | Manager, Client |
| Resource Access | Resource, Utility | Engine, Manager, Client |
| Utility | Other Utilities | Everything else |

### Forbidden Patterns

| Pattern | Why It's Forbidden |
|---------|-------------------|
| Engine → Manager | Violates layer direction; creates circular dependencies |
| Resource Access → Engine | Violates layer direction; data layer shouldn't know business logic |
| Client → Resource Access | Bypasses business layer; leaks data concerns to presentation |
| Manager → Manager | Creates coupling between workflows; use shared Engine instead |

### Why These Rules Exist

- **Layer direction**: Higher layers depend on lower layers, never reverse
- **Containing change**: Changes propagate down, not up
- **Single responsibility**: Each layer has one job
- **Testability**: Lower layers can be tested without upper layers

---

## Decomposition Decision Tree

Follow these steps when decomposing a new feature:

### Step 1: List Feature Responsibilities

Write down everything the feature needs to do:
- User interactions
- Data operations
- Business rules
- External integrations
- Notifications

### Step 2: Identify Volatilities (Both Axes)

For each responsibility, ask:

**Axis 1 - Same customer over time:**
- What might change as requirements evolve?
- What's likely to be customized or extended?

**Axis 2 - Same time across customers:**
- What varies between deployments?
- What's configurable per customer/environment?

### Step 3: Group by Volatility Axis

Group related volatilities that change together:
- Things that change together → Same service
- Things that change independently → Different services

### Step 4: Classify Each Group

For each group, determine its service type:

```
Is it orchestrating a workflow?
  → YES: Manager
  → NO: Continue

Is it implementing business rules (stateless)?
  → YES: Engine
  → NO: Continue

Is it abstracting data storage?
  → YES: Resource Access
  → NO: Continue

Is it cross-cutting infrastructure?
  → YES: Utility
  → NO: Reconsider grouping
```

### Step 5: Define Contracts Between Services

For each service boundary:
- Define the interface (what operations are exposed)
- Specify input/output types
- Document error conditions
- Ensure atomic business verbs (not CRUD)

---

## Worked Example: Notification System

### Requirements
- Send notifications to users via email, SMS, push
- Users can configure notification preferences
- Different notification types (alerts, marketing, transactional)
- Track delivery status
- Support templates with dynamic content

### Step 1: List Responsibilities
- Determine notification channel (email/SMS/push)
- Render notification content from template
- Deliver notification via appropriate transport
- Track delivery status
- Manage user preferences
- Store notification history

### Step 2: Identify Volatilities

| Responsibility | Axis 1 (Over Time) | Axis 2 (Across Customers) |
|----------------|-------------------|---------------------------|
| Channel selection | New channels (Slack, WhatsApp) | Customer-specific channels |
| Content rendering | Template engine changes | Brand-specific templates |
| Delivery transport | Provider changes | Multi-tenant providers |
| Status tracking | New status types | SLA requirements |
| Preferences | New preference types | Default preferences |
| History storage | Retention policies | Storage location |

### Step 3: Group by Volatility

| Group | Volatilities | Why Together |
|-------|--------------|--------------|
| Notification Workflow | Channel selection, preference checking | Sequence of sending |
| Template Engine | Content rendering, template management | Rendering logic |
| Transport Services | Email delivery, SMS delivery, Push delivery | Same interface, different impl |
| Notification Access | History storage, status tracking | Data persistence |
| Preference Access | Preference storage, retrieval | User data |

### Step 4: Classify Services

| Service | Type | Rationale |
|---------|------|-----------|
| `NotificationManager` | Manager | Orchestrates the send workflow |
| `TemplateEngine` | Engine | Stateless content rendering |
| `EmailTransport` | Engine | Stateless delivery logic |
| `SMSTransport` | Engine | Stateless delivery logic |
| `PushTransport` | Engine | Stateless delivery logic |
| `NotificationAccess` | Resource Access | Abstracts notification storage |
| `PreferenceAccess` | Resource Access | Abstracts preference storage |

### Step 5: Call Chain

```
Client
   │
   ▼
NotificationManager ──────────────────────┐
   │                                      │
   ├──▶ PreferenceAccess                  │
   │         │                            │
   │         ▼                            ▼
   │    PreferenceDB                  Logging
   │                                      ▲
   ├──▶ TemplateEngine ───────────────────┤
   │                                      │
   ├──▶ EmailTransport ───────────────────┤
   │         │                            │
   │         ▼                            │
   │    SMTP Provider                     │
   │                                      │
   └──▶ NotificationAccess ───────────────┘
             │
             ▼
        NotificationDB
```

---

## Anti-Patterns

### 1. Functional Decomposition

**Symptom**: Services named after use case steps
```
❌ ValidateOrderService → CalculateTaxService → ProcessPaymentService → SendConfirmationService
```

**Problem**: Every new use case requires new services or rewiring existing ones.

**Fix**: Decompose by volatility
```
✅ OrderManager (orchestrates) → PricingEngine → PaymentEngine → NotificationManager
```

### 2. God Service

**Symptom**: One service does everything for a domain
```
❌ OrderService: CreateOrder, ValidateOrder, CalculateTotal, ProcessPayment,
                SendNotification, UpdateInventory, GenerateReport...
```

**Problem**: Any change affects the entire service; impossible to scale or test independently.

**Fix**: Split by volatility axis
```
✅ OrderManager, PricingEngine, PaymentEngine, InventoryAccess, NotificationManager
```

### 3. Chatty Interfaces

**Symptom**: Many small calls between services
```
❌ GetCustomer() → GetAddress() → ValidateAddress() → GetTaxRate() → CalculateTax()
```

**Problem**: Network overhead, latency, partial failure handling complexity.

**Fix**: Coarser-grained operations with atomic business verbs
```
✅ CalculateOrderTax(orderId) // Internally handles all steps
```

### 4. Circular Dependencies

**Symptom**: A → B → C → A
```
❌ OrderManager → InventoryEngine → PricingEngine → OrderManager
```

**Problem**: Cannot deploy, test, or reason about independently.

**Fix**: Extract shared logic to lower layer
```
✅ OrderManager → InventoryEngine → InventoryAccess
    OrderManager → PricingEngine → PricingRulesAccess
```

### 5. Bypassing Layers

**Symptom**: Client directly calls Resource Access
```
❌ WebApp → OrdersAccess (skipping business logic)
```

**Problem**: Business rules not enforced; duplication when rules needed elsewhere.

**Fix**: Always go through business layer
```
✅ WebApp → OrderManager → OrdersAccess
```

---

## Quick Validation Checklist

Use this checklist when reviewing architecture proposals:

### Decomposition Quality
- [ ] Each service encapsulates a single volatility axis
- [ ] Services are named after what they encapsulate, not what they do
- [ ] No functional decomposition (use case steps as services)

### Call Chain Compliance
- [ ] Call direction is always downward (Client → Manager → Engine → Access)
- [ ] No circular dependencies between services
- [ ] No layer bypassing (Client doesn't call Resource Access directly)

### Service Classification
- [ ] Managers contain workflow logic only (not business rules)
- [ ] Engines are stateless and shareable
- [ ] Resource Access exposes business verbs (not CRUD)
- [ ] Utilities are cross-cutting only

### Contract Quality
- [ ] Interfaces use atomic business verbs
- [ ] No chatty interfaces (multiple calls for one logical operation)
- [ ] Contracts are defined at boundaries

### Codebase Alignment
- [ ] Generic terms mapped to codebase conventions
- [ ] Follows existing patterns in the codebase

---

