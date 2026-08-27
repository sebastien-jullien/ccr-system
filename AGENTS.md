# CCR — Repository Instructions

These instructions govern all AI-assisted work in this repository.

They are intentionally shared between `CLAUDE.md` and `AGENTS.md`.

No assistant has structural authority over another in this repository. Wherever
these instructions name a provider, they are describing an adapter, a CLI, or a
provider-specific test — never a role in the protocol.

---

# 1. Mission

This repository implements **CCR — Contradictory Cross-Review / Contre-expertise
croisée**.

CCR improves the reliability of AI-assisted software development by maintaining
independent persistent conversations with multiple AI experts and organizing
their confrontation without turning model agreement into truth.

The core principle is:

> **Evidence beats agreement.**

The delivered system spans persistent expert sessions, canonical state, handoffs,
human intervention, a local cockpit, a CLI, usage governance, controversy
representation, materials and adductions, and reconciliation.

Keep changes within the contract you are working on. Do not widen a task into a
redesign of the platform.

---

# 2. Source hierarchy

Before planning or modifying code, read the relevant repository sources.

1. `docs/doctrine.md`
   - normative doctrine;
   - what CCR asserts, and what it refuses to assert;
   - governs every other source below.

2. `docs/specs/`
   - current technical contracts, per domain:
     `controversy.md`, `evidence.md`, `reconciliation.md`;
   - define objects, effects, validations and prohibitions.

3. `README.md`
   - repository positioning, product surfaces, and how to run it.

4. Existing code and tests
   - describe the implementation state actually present in the repository.

5. Comments, TODOs and historical implementation notes
   - local context only;
   - never override active specifications.

If two sources genuinely conflict, do not silently choose one.

Identify the conflict explicitly and determine whether it blocks implementation.

---

# 3. Scope discipline

CCR is a neutral orchestrator of contradictory review. It is not a general
multi-agent framework, and not an autonomous decision system.

## Stay inside the contract

A change belongs to a domain, and that domain has a contract. Read it before
writing code, and keep the change inside it.

## Do not introduce, unless a contract is deliberately revised

- direct provider APIs bypassing the official CLIs;
- OAuth/token extraction or credential management;
- automatic arbitration, ranking, scoring or winner selection;
- automatic convergence, automatic closure, or consensus-as-truth;
- automatic claim extraction or automatic disagreement summarization;
- model voting;
- a general-purpose workflow engine;
- a database server or SQL persistence;
- a remote-facing service.

Ease of implementation is never a reason to add a capability the contracts do
not carry.

---

# 4. Architectural invariants

These invariants are more important than implementation convenience.

## 4.1 A CCR run owns two expert slots

A run has exactly one `author` and one `challenger`. Each slot is bound to a
provider, and each active slot owns its own native session:

```text
CCR run_id
├── author slot
│   ├── provider assignment
│   └── native session identity
└── challenger slot
    ├── provider assignment
    └── native session identity
```

Three rules follow, and none of them is optional:

```text
ROLE ≠ PROVIDER            the slot key is the role; the provider is an engine
SAME PROVIDER = ALLOWED    a run may bind both slots to the same provider
DISTINCT NATIVE SESSIONS   every active slot has its own session identity
```

Neither slot is reserved for a particular provider. A helper that hard-codes one
would make the protocol provider-dependent again.

Native session identities must remain stable across turns and process restarts.

Never emulate persistence by rebuilding the entire conversation in a fresh prompt when a native resume mechanism is available.

---

## 4.2 Native conversation and CCR canonical state are different

Each expert slot's native provider session maintains cognitive continuity.

CCR maintains canonical orchestration state — epistemic continuity.

Do not treat an expert's conversation as the CCR database.

Conversely, do not attempt to replace native conversation history with `events.jsonl`.

---

## 4.3 The orchestrator is neutral

CCR may transfer and frame messages.

CCR must not decide that one expert is correct.

Do not silently:

- summarize away disagreement;
- rewrite a model position;
- select a winner;
- convert consensus into fact;
- alter a human decision.

---

## 4.4 Preserve provenance

Attribution in CCR is **multi-dimensional**. There is no single global union of
provenance values, and inventing one would collapse distinctions the contracts
depend on:

```text
RECORDER           ≠ SEMANTIC ORIGIN
TECHNICAL EXECUTOR ≠ SEMANTIC ORIGIN
PROVIDER           ≠ SEMANTIC ORIGIN
PROVENANCE         ≠ STATEMENT AUTHORSHIP
```

Attribution vocabularies are **contract-local**. Each domain contract in
`docs/specs/` defines the vocabulary it needs, and none of them is authoritative
outside its own journal.

At the storage layer, two event-actor vocabularies exist per run generation —
the historical one names providers, the native one names an expert. They are
implementation-local vocabularies for one journal each. Do not present either as
universal provenance, universal semantic origin, or protocol identity.

When content is transferred from one expert to another, preserve the original content and its source.

Prefer faithful transfer over intelligent transformation.

---

## 4.5 Human authority remains explicit

The human can pause the automation and intervene in either expert's native session.

Human product decisions are not equivalent to model suggestions.

A critical normative decision must not exist only inside an agent transcript if CCR is expected to rely on it later.

---

## 4.6 One writer per run

Never allow two CCR processes to mutate the same run concurrently.

Use a local run lock.

Handle stale locks explicitly.

---

## 4.7 Recovery before autonomy

A crash must not destroy:

- `run_id`;
- each slot's provider assignment;
- each slot's native session identity;
- completed events;
- completed rounds;
- the ability to resume the run.

Prefer a boring recoverable system to a sophisticated fragile one.

---

# 5. CLI integration rules

Use only the official locally installed CLIs.

## Claude

Programmatic execution is based on the official non-interactive mode and native session resume.

Conceptually:

```text
claude -p ...
claude -p --resume <session_id> ...
```

Use structured output for machine parsing.

## Codex

Programmatic execution is based on:

```text
codex exec ...
codex exec resume <session_id> ...
```

Use structured output where appropriate.

## Rules

- invoke subprocesses using argument arrays;
- avoid shell command concatenation;
- avoid `shell: true` unless demonstrably required;
- preserve `stdout` and `stderr` separately;
- record exit status;
- implement configurable timeout handling;
- launch both experts from the run's canonical working directory;
- never inspect, copy or manipulate authentication tokens;
- never log environment variables wholesale;
- never weaken the agents’ configured permission systems automatically.

CLI-specific parsing belongs inside adapters.

The rest of CCR must not know any provider's output format.

---

# 6. Adapter boundary

The core must reason about a generic agent result, not vendor-specific JSON.

Target conceptual contract:

```text
AgentAdapter
├── start(prompt)
├── resume(sessionId, prompt)
└── openInteractive(sessionId)
```

A normalized result should expose at least:

```text
sessionId
content
exitCode
startedAt
completedAt
stdoutRaw
stderrRaw
```

Vendor quirks remain inside:

```text
ClaudeAdapter
CodexAdapter
```

Do not spread CLI parsing across commands, stores or business logic.

---

# 7. State model

Keep workflow state explicit.

runtime states:

```text
READY
RUNNING
WAITING_AGENT
WAITING_HUMAN
PAUSED
RECOVERY_REQUIRED
FAILED_INITIALIZATION
FAILED
CLOSED
```

Every state must correspond to a situation CCR actually produces or recovers.

`CONVERGED` is **reserved** and is not part of the runtime state machine. CCR must never assign it: agreement between two agents is
not convergence.

`RUNNING` and `WAITING_AGENT` are not interchangeable. `WAITING_AGENT` means an
expert turn is in flight. Finding that state persisted after a restart means the
turn may or may not have happened, and must lead to `RECOVERY_REQUIRED`.

`WAITING_HUMAN` and `PAUSED` are not interchangeable either. The first is an
impossibility observed by CCR; the second is a deliberate human suspension.

Control ownership is separate:

```text
AUTOMATION
HUMAN
```

Do not infer control ownership from whether a child process currently exists.

---

# 8. Persistence rules

Prefer transparent local files.

A run directory holds three distinct families, and conflating them is a design
error:

```text
CORE RUN FILES        manifest.json · state.json · events.jsonl · decisions.jsonl
DOMAIN JOURNALS       controversies.jsonl · evidence.jsonl · reconciliations.jsonl
                      plus the usage-governance journals
DIAGNOSTIC ARTIFACTS  rounds/ · artifacts/ · raw CLI output
```

Domain journals are **additive and outside run revision**: writing one never
invalidates a run-level precondition, and its absence is the normal state of any
run created before that domain existed. Each carries its own schema version and
its own freshness token namespace.

`decisions.jsonl` is a historical run-decision journal. It has no native writer
or reader, and it is **not** the current universal decision authority. Do not
revive it as one.

## `manifest.json`

Stable run identity, expert-slot bindings, and configuration.

## `state.json`

Current mutable state.

Write mutable state atomically.

## `events.jsonl`

Append-only CCR event journal.

Do not rewrite history to make it cleaner.

Corrections should create new events.

## Raw CLI output

May be retained for debugging and parser evolution.

Raw output is diagnostic evidence, not application state.

---

# 9. Canonical working directory

A run owns one canonical working directory.

Capture at minimum:

```text
workspace cwd
```

Both agents are always launched from it, so that they see the same files and
the same project configuration.

CCR does **not** capture Git context — no repository, branch, `HEAD` SHA or
dirty state — and executes no Git command. This is a deliberate product
decision, not an oversight.

Consequence to respect: CCR cannot establish that two rounds examined the same
source state. Never imply that it can.

Never automatically reset, clean, stash, commit, amend or discard user changes.

---

# 10. Human handoff

Human intervention is a first-class operation.

Expected flow:

```text
automation
→ pause
→ HUMAN control
→ interactive Claude or Codex session
→ human exits
→ run remains paused
→ explicit resume
→ AUTOMATION control
```

Closing an interactive session must not automatically restart the orchestration.

The human decides when automation resumes.

---

# 11. External/native interventions

A human may open a Claude or Codex session outside CCR.

CCR does not need to parse private native transcript formats to reconstruct every external message.

Do not add such parsing opportunistically.

CCR may record that an external handoff occurred and continue using the same native session afterward.

Future synchronization belongs to a later version.

---

# 12. Error handling

Never turn uncertainty into success.

Examples:

- malformed Claude JSON;
- incomplete Codex JSONL;
- missing session ID;
- non-zero exit;
- timeout;
- missing executable;
- partial initialization;
- crash during an expert turn;
- stale lock.

These must become explicit states/errors.

Do not invent a model response.

Do not silently create a fresh session when resume fails.

A failed resume is materially different from a new conversation.

---

# 13. Partial initialization

If one expert slot establishes a valid native session and the other fails to
initialize, preserve the successful slot's valid state — its provider assignment
and its native session identity.

Do not destroy valid state to make initialization look atomic.

Recovery must be able to complete only the missing side.

This is a rule about slots, not about a provider pair. It holds when both slots
are bound to the same provider, and it holds whichever slot failed.

---

# 14. Testing doctrine

Tests must verify behavior, not merely implementation structure.

## Unit tests

Cover at minimum:

- stores;
- atomic state writes;
- event append;
- locks;
- state transitions;
- Claude parsing;
- Codex parsing;
- subprocess failure handling;
- session ID preservation.

## Integration tests

Where installed CLIs and authentication permit, test the real programs.

Critical tests include:

### Claude continuity

Turn 1 stores a unique witness value.

Terminate the process.

Resume the same session.

Turn 2 must recall it.

### Codex continuity

Same principle.

These two are **adapter and integration tests**. They prove that a given
provider's resume mechanism works; they say nothing about protocol identity.

### Cross-slot ping-pong

At least two turns per expert slot, each reusing its own native session
identity.

### Human handoff

Automated turn → pause → interactive intervention → automated resume.

The expert must know that the human intervened.

### CCR restart

Stop CCR completely.

Reload the run from persisted files.

Continue both original native sessions.

Mocks can test parsers and failure modes.

Mocks do **not** prove native session continuity.

Real provider tests are deliberate and consume account resources. They are not
run by reflex, and never to check an unrelated change.

Never report a contract as validated solely from mocked CLI tests.
`IMPLEMENTED` ≠ `EMPIRICALLY VERIFIED`.

---

# 15. Completion discipline

Each contract in `docs/specs/` defines what its completion requires.

Do not weaken it to fit the current code.

If the environment prevents execution of a real acceptance test, report:

```text
IMPLEMENTED
NOT EMPIRICALLY VERIFIED
```

rather than `DONE`.

---

# 16. Development workflow

For non-trivial work:

1. read the governing documents;
2. inspect the current repository;
3. identify existing implementation and tests;
4. compare implementation state with contract requirements;
5. propose or update an implementation plan;
6. implement the smallest coherent slice;
7. run targeted tests;
8. run broader relevant tests;
9. inspect the diff;
10. verify scope;
11. update implementation documentation only when needed;
12. report evidence.

Do not begin with code generation before understanding the current state.

---

# 17. Evidence discipline

When stating that something works, provide the evidence used.

Preferred evidence:

```text
command
exit code
test result
relevant output
```

Distinguish clearly:

```text
verified
inferred
not tested
blocked
```

Never transform:

> “the code appears correct”

into:

> “validated”.

---

# 18. No naked completion claims

Avoid statements such as:

> “All requirements are implemented.”

unless they have been checked against the implementation specification.

For contract completion, produce a requirement/acceptance matrix against the acceptance criteria of the applicable contract.

---

# 19. No opportunistic redesign

While implementing a contract, you may discover a better long-term architecture.

Record it.

Do not automatically implement it.

Classify it as:

```text
blocker
improvement
future design
```

A future design idea is not a contract requirement.

---

# 20. Standard project structure

Use standard, idiomatic directories and conventions for the selected runtime.

Avoid custom repository structures when normal ecosystem conventions exist.

Keep concerns separated at least conceptually:

```text
CLI
run management
process execution
agent adapters
state/event persistence
locking
tests
```

Do not create abstractions merely because future versions might need them.

---

# 21. Dependency discipline

Prefer platform/runtime capabilities when they are sufficient.

Every external dependency must solve a concrete current problem.

Avoid dependencies for:

- trivial argument parsing if unnecessary;
- file IO wrappers;
- subprocess wrappers without a demonstrated need;
- framework infrastructure;
- speculative future functionality.

Speculative infrastructure is not introduced ahead of a demonstrated need.

---

# 22. Security

CCR runs locally with the user’s existing Claude Code and Codex installations.

Never:

- extract OAuth tokens;
- read credential stores unnecessarily;
- print secrets;
- persist authentication data;
- disable CLI safeguards;
- expose CCR as a remote service;
- assume that local personal authentication is suitable for a hosted service.

CCR is a local tool. The cockpit is a **local HTTP surface** bound to the
loopback interface; it exists today, and it is not a remote hosted service.
Keeping that distinction intact is part of the security posture, not a
formality.

---

# 23. Documentation changes

Do not rewrite the conceptual doctrine just because implementation details evolve.

Use the correct layer:

```text
README.md
→ repository orientation

docs/doctrine.md
→ normative doctrine

docs/specs/
→ current technical contracts, per domain

code/tests
→ current implementation
```

If implementation reveals a conceptual issue, report it before modifying doctrine.

---

# 24. Working with the other AI reviewer

When asked to perform adversarial review:

> **Try to refute, not confirm.**

Search specifically for:

- incorrect assumptions;
- unimplemented requirements;
- hidden scope expansion;
- false completion claims;
- recovery gaps;
- concurrency gaps;
- session continuity breaks;
- vendor-specific behavior leaking outside adapters;
- tests that prove only mocks;
- unsupported absolute statements.

Do not manufacture disagreement.

If the implementation is correct, say so and show the evidence.

---

# 25. Core design maxim

Keep this distinction intact throughout the project:

> **Native conversations provide cognitive continuity.  
> CCR provides epistemic continuity.**

CCR succeeds when the bridge between those two persistent conversations is simple, reliable, inspectable and recoverable.
