2026-07-11

# VIBE PRD: Conclave

## Product Name

**Conclave**
*A collaborative command center where coding AIs work together with the user inside one shared environment.*

## Product Vision

Build a locally controlled application that brings multiple command-line AI coding agents into a single collaborative workspace.

The system should support tools such as:

* Claude Code
* OpenAI Codex
* Gemini CLI
* Grok-based coding tools
* Kimi Code
* Aider
* OpenCode
* Continue CLI
* Other compatible agents added through a modular adapter system

Instead of running each coding AI in a separate terminal with no awareness of the others, Conclave places them inside a shared, observable collaboration environment.

Each agent remains an independent intelligence with its own model, context, tools, strengths, and authentication. Conclave coordinates their communication, gives them controlled access to shared projects, and lets the human user participate as the central operator.

The goal is not to disguise several models as one AI. The goal is to create a genuine multi-agent engineering room where specialized coding intelligences can discuss problems, challenge one another, divide work, inspect results, and collectively execute projects.

---

# 1. Core Experience

The user launches Conclave locally and opens its interface in a browser.

From there, the user can:

1. Connect installed AI coding CLIs.
2. Create a project workspace.
3. Invite selected agents into a shared room.
4. Describe a goal or assign a task.
5. Watch the agents communicate in real time.
6. Speak directly to the entire room or mention a specific agent.
7. Approve or reject sensitive operations.
8. Inspect commands, file edits, reasoning summaries, disagreements, and task status.
9. Allow agents to divide work among themselves.
10. Review and accept the resulting implementation.

The experience should feel like operating a room full of highly capable software engineers, not like switching among unrelated terminal windows.

---

# 2. Product Principles

## Real Agents, Not Simulations

Every connected agent must represent an actual installed CLI, API-backed agent, or explicitly configured local model.

The application must not fabricate:

* Agent output
* Tool execution
* Terminal results
* File changes
* Test results
* Agent availability
* Provider capabilities
* Usage or token data

If an agent cannot be reached, authenticated, or executed, the interface must say so clearly.

## Human Sovereignty

The user is the final authority.

Agents may propose, debate, delegate, and execute within granted permissions, but the user must be able to:

* Interrupt any agent
* Pause the entire room
* Revoke permissions
* Reject proposed actions
* Redirect the task
* Override routing decisions
* Remove an agent
* Restore project checkpoints

## Visible Causal Lineage

The user should be able to determine:

* Who proposed an action
* Which agent executed it
* What files were affected
* What command was run
* What evidence supported a conclusion
* Whether another agent reviewed the result
* What remains uncertain or unresolved

## Useful Collaboration Over Agent Chatter

Agents should not endlessly respond to one another merely because they can.

The system should encourage communication when it serves a purpose:

* Requesting expertise
* Challenging an assumption
* Reviewing a change
* Resolving a conflict
* Handing off work
* Reporting evidence
* Identifying a blocker
* Coordinating access to shared files

Conversation loops, repetitive agreement, performative summaries, and uncontrolled token consumption should be detected and stopped.

## Local-First Control

The primary application should operate locally, with project files, logs, credentials, permissions, and execution under the user’s control.

Remote AI services may still be used by their corresponding CLIs, but Conclave itself should not require an external coordination service unless the user deliberately enables one.

---

# 3. Primary User Story

> As a developer, I want to place several AI coding agents inside one shared project room so that they can collaborate, critique one another, divide work according to their strengths, and execute a project while I observe and participate from a unified interface.

---

# 4. The Collaborative Room

The room is the central operating environment.

It combines:

* Multi-agent chat
* User participation
* Task planning
* Shared project context
* Live terminal activity
* File-change tracking
* Permission requests
* Agent status
* Review and approval workflows

Every message must visibly identify its source:

* User
* Claude Code
* Codex
* Gemini
* Kimi
* Grok
* System orchestrator
* Other configured agents

Messages should support structured types in addition to ordinary text:

* Proposal
* Question
* Delegation
* Evidence
* Objection
* Decision
* Progress update
* Tool request
* Permission request
* Review result
* Blocker
* Final result

The interface may display these naturally, but the underlying distinction should be machine-readable so the orchestration system can react intelligently.

---

# 5. Agent Connections

## Agent Adapter System

Each coding agent is connected through an adapter that translates between Conclave and the agent’s actual interface.

An adapter should define:

* How the agent is detected
* How it is launched
* How input is delivered
* How output is captured
* Whether structured or streaming output is available
* Whether the agent supports persistent sessions
* Whether it can edit files
* Whether it can run commands
* Whether it supports tool approval
* How cancellation works
* How usage is reported
* What authentication it requires

This architecture must allow new agents to be added without redesigning the application.

## Connection Modes

Depending on the agent’s capabilities, Conclave may communicate through:

* Native CLI invocation
* Persistent terminal sessions
* Structured subprocess communication
* Official SDKs
* Local APIs
* MCP-compatible interfaces
* Agent-to-agent protocols
* User-defined adapters

The system should use the most reliable supported integration for each agent. Terminal-screen scraping should be treated as a compatibility fallback, not the preferred foundation.

## Capability Discovery

Conclave should not assume every agent can perform every operation.

Each connected agent should expose a capability profile, including:

* Code generation
* Repository inspection
* File editing
* Command execution
* Web research
* Image understanding
* Long-context analysis
* Code review
* Testing
* Documentation
* Planning
* Independent subtask execution

---

# 6. Collaboration and Orchestration

## Collaboration Modes

### Operator-Directed

The user assigns work directly to specific agents.

Example:

> `@Codex inspect the backend architecture.`
> `@Claude review Codex’s findings for failure modes.`
> `@Gemini research the current library documentation.`

### Moderator-Directed

A designated coordinator decomposes the user’s goal, assigns subtasks, and manages handoffs.

The coordinator may be:

* A selected AI agent
* A lightweight local orchestration model
* A deterministic rules engine
* The user

### Open Council

All invited agents may contribute, challenge claims, and volunteer for work. Turn limits and loop protection prevent uncontrolled discussion.

### Parallel Execution

Independent subtasks may run simultaneously when they do not create unsafe file conflicts.

### Adversarial Review

One agent implements a change while another tests, critiques, or attempts to falsify it.

## Task Graph

Complex goals should be represented as a task graph rather than only as chat history.

Each task can include:

* Objective
* Assigned agent
* Dependencies
* Required context
* Permissions
* Status
* Deliverables
* Evidence
* Review requirements
* Completion criteria

Supported states should include:

* Proposed
* Ready
* Active
* Waiting
* Blocked
* Review required
* Rejected
* Completed
* Failed
* Cancelled

## Delegation

Agents may request help from other agents when permitted.

Example:

> Codex identifies that a task depends on current external documentation. It delegates documentation research to Gemini, continues inspecting the local codebase, and integrates Gemini’s cited findings when they arrive.

Delegations must remain visible to the user and must not silently expand project scope or permissions.

---

# 7. Shared Context and Memory

## Project Context

All participating agents should be able to receive a controlled view of:

* Project objective
* Repository structure
* Relevant files
* Current task graph
* Confirmed decisions
* Known constraints
* Test results
* Agent findings
* User instructions

The system should avoid dumping the entire conversation and repository into every agent call. Context should be assembled according to the agent’s current task.

## Shared Knowledge Ledger

Important findings should be extracted into a durable project ledger containing:

* Confirmed facts
* Architectural decisions
* User requirements
* Open questions
* Rejected approaches
* Known defects
* Environmental constraints
* Test evidence
* Agent disagreements

Each entry should record its source and confidence status.

## Context Boundaries

Agents must not automatically inherit:

* Another provider’s hidden reasoning
* Credentials
* Private environment variables
* Files outside the project scope
* Unapproved personal information
* Unrelated conversation history

Agents should exchange conclusions, evidence, and relevant artifacts, not hidden internal reasoning.

---

# 8. Workspace and File Safety

## Shared Workspace

Agents may operate within a common project workspace, but file access must be coordinated.

The system should detect:

* Simultaneous edits to the same file
* Conflicting patches
* Deleted or renamed files
* Changes made outside the current task
* Uncommitted user changes
* Generated artifacts
* Commands affecting files beyond the workspace

## Isolated Work Areas

For parallel or experimental work, agents should be able to receive isolated branches or workspaces.

A safe flow could be:

1. Create an isolated work area.
2. Allow an agent to implement its task.
3. Run validation.
4. Show the resulting diff.
5. Request review.
6. Merge only after approval or configured policy satisfaction.

## Checkpoints

Conclave should create recoverable checkpoints before significant changes.

The user must be able to inspect and restore earlier project states without relying on agents to reverse their own work correctly.

---

# 9. Command Execution and Permissions

Every agent action should pass through a unified permission layer.

Permission categories may include:

* Read project files
* Modify project files
* Create files
* Delete files
* Execute local commands
* Install dependencies
* Access the network
* Read environment variables
* Access paths outside the project
* Use external services
* Modify version-control state
* Commit changes
* Push changes
* Open pull requests
* Run destructive operations

Permissions may be configured as:

* Always allow
* Allow during this task
* Ask every time
* Always deny

Sensitive commands must display:

* Requesting agent
* Exact command or action
* Working directory
* Intended purpose
* Expected impact
* Relevant risk
* Files or systems potentially affected

---

# 10. User Interface

## Main Layout

The primary interface should contain:

### Collaboration Feed

A real-time, chronological view of user messages, agent messages, delegations, decisions, reviews, and system events.

### Agent Panel

Each agent displays:

* Name
* Provider
* Connection status
* Current task
* Activity state
* Capability profile
* Permission level
* Context usage when available
* Cost or token usage when available
* Last meaningful action

### Task Board

A visual representation of the task graph, ownership, dependencies, progress, and blockers.

### Workspace Inspector

A view of:

* Modified files
* Diffs
* Active branches or isolated work areas
* File conflicts
* Test results
* Checkpoints

### Execution Console

A live view of commands and terminal output, clearly separated by agent and execution session.

### Approval Center

A centralized queue for actions requiring user authorization.

## User Controls

The user should be able to:

* Address the room
* Mention specific agents
* Assign or reassign tasks
* Pause or resume execution
* Interrupt an agent
* Change collaboration mode
* Approve or deny actions
* Inspect raw output
* Compare agent proposals
* Request a vote or critique
* Mark a decision as authoritative
* Export the complete session record

---

# 11. Agent Identity and Roles

Each room may assign roles such as:

* Coordinator
* Architect
* Implementer
* Researcher
* Code reviewer
* Test engineer
* Security reviewer
* Documentation writer
* Adversarial critic

Roles influence orchestration but should not artificially restrict an agent’s underlying capabilities.

The user may manually assign roles or allow Conclave to recommend assignments based on available capabilities.

---

# 12. Conflict Resolution

When agents disagree, Conclave should preserve the disagreement rather than prematurely merging their answers.

The interface should show:

* Competing proposals
* Evidence offered by each agent
* Assumptions behind each position
* Files or decisions affected
* Suggested tests that could discriminate between them

Resolution options include:

* User decision
* Additional evidence gathering
* Prototype comparison
* Test execution
* Third-agent review
* Majority recommendation
* Designated coordinator decision

A majority vote must never be represented as proof of correctness.

---

# 13. Loop and Cost Control

The system must detect and control:

* Agents repeatedly agreeing
* Circular delegation
* Repeated restatement
* Two agents continuously reviewing each other
* Tasks spawning unnecessary subtasks
* Excessive context retransmission
* High-cost activity without material progress
* Agents continuing after completion criteria are satisfied

Configurable limits should include:

* Maximum agent turns
* Maximum collaboration rounds
* Maximum task depth
* Time limit
* Token or cost budget
* Command limit
* Retry limit

When a limit is reached, the system should pause and explain the current state rather than silently terminating the project.

---

# 14. Session Record and Audit Trail

Every room should produce a complete, searchable session record containing:

* User instructions
* Agent responses
* Task assignments
* Delegations
* Permission decisions
* Commands
* Terminal output
* File changes
* Checkpoints
* Reviews
* Tests
* Errors
* Final decisions

The record should support filtering by:

* Agent
* Task
* File
* Event type
* Time
* Status

Sessions should be resumable without requiring agents to reconstruct the entire project from raw chat history.

---

# 15. Failure Handling

Conclave must handle real-world failures explicitly:

* Agent CLI not installed
* Authentication expired
* Provider rate limit
* Network unavailable
* CLI output format changed
* Agent process frozen
* Context limit reached
* Command timed out
* File conflict detected
* Test failure
* Agent returns malformed output
* User interrupts execution

A failed agent should not necessarily collapse the entire room. Its task may be retried, reassigned, or marked blocked.

---

# 16. Security Requirements

* Credentials remain outside chat transcripts.
* Secrets are redacted from logs and agent-to-agent messages.
* Project access is scoped by default.
* Network access is observable and controllable.
* External instructions encountered in repositories or web content are treated as untrusted data.
* Agents cannot silently grant permissions to other agents.
* Installed adapters must declare their access requirements.
* Commands and file modifications remain attributable to the responsible agent.
* Destructive actions require explicit user authorization unless the user deliberately establishes a narrowly scoped policy allowing them.

---

# 17. Minimum Viable Product

The first usable version should support:

1. Local browser-based interface.
2. Connection to at least two real coding CLIs.
3. A modular adapter interface.
4. Shared multi-agent chat.
5. Direct agent mentions.
6. A user-selected coordinator mode.
7. Live streaming of agent output.
8. Shared project workspace.
9. Visible file changes and diffs.
10. Unified command approval.
11. Task assignment and basic status tracking.
12. Agent interruption and cancellation.
13. Loop and turn limits.
14. Persistent session history.
15. Clear connection and failure reporting.
16. No fabricated integrations or execution results.

The MVP does not need autonomous organization-scale software development. It must first prove that multiple real coding agents can safely participate in one coherent, user-controlled project session.

---

# 18. Future Capabilities

After the core system is reliable, later versions may add:

* Remote team access
* Voice participation
* Agent performance analytics
* Automatic agent selection
* Reusable team configurations
* Specialized agent personas
* MCP server discovery
* Agent-to-agent protocol support
* Cross-project knowledge
* Visual dependency mapping
* Automated benchmark tasks
* Cost optimization
* Model routing by task type
* Pull-request workflows
* CI/CD integration
* Containerized execution
* Remote development environments
* Multi-user permissions
* Replayable collaboration sessions
* Agent reputation based on verified outcomes

---

# 19. Non-Goals

Conclave is not intended to:

* Pretend disconnected models are communicating
* Replace version control
* Hide agent activity from the user
* Give unrestricted machine access by default
* Treat agent consensus as correctness
* Allow endless autonomous conversation
* Depend on one AI provider
* Normalize every agent into an indistinguishable personality
* Expose hidden model reasoning
* Claim capabilities that an underlying CLI does not possess

---

# 20. MVP Acceptance Criteria

The MVP is successful when a user can:

1. Connect two independently installed coding agents.
2. Open an existing software project.
3. Give the room a development objective.
4. Assign different subtasks to each agent.
5. See each agent’s output stream in real time.
6. Allow one agent to request information or review from another.
7. Participate in the shared discussion.
8. Review every proposed command and file modification.
9. Prevent or resolve conflicting edits.
10. Run real validation commands.
11. Identify which agent produced each change.
12. Interrupt the process without corrupting the project.
13. Resume the session with its task state intact.
14. Obtain a final summary linked to actual changes and test evidence.

---

# 21. Build Directive

Build Conclave as a real, locally operable multi-agent coding environment.

Do not substitute mocked conversations, predetermined agent messages, simulated terminal output, fake integrations, placeholder execution, or fictional collaboration behavior for functional implementation.

If a provider cannot yet be integrated, represent it honestly as unsupported or unavailable. Design its adapter boundary, but do not imply that it works until it has been connected to the real underlying tool and verified.

Prioritize this sequence:

1. Reliable process control
2. Real agent connectivity
3. Permission enforcement
4. Shared workspace safety
5. Observable collaboration
6. Task orchestration
7. Interface refinement
8. Advanced autonomy

The defining proof is not that several AI names appear in one chat window. The defining proof is that multiple independent coding agents can exchange useful project information, coordinate real work, produce attributable changes, and remain under direct human control.

#VibePRD #Conclave #MultiAgentCoding #AICollaboration #LocalFirst #CodingAgents #AgentOrchestration
