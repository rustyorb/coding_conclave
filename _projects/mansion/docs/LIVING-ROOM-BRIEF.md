# Living-Room Surface Brief

**Status:** Proposed Product & UX Brief  
**Date:** 2026-07-17  
**Bounded Context:** Room / Workspace Frontend  
**Companions:** [CHARTER.md](CHARTER.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [V1-LESSONS.md](V1-LESSONS.md)  
**Primary Target:** `U:\coding_mansion\docs\LIVING-ROOM-BRIEF.md` (stand-alone) and `U:\mansion\docs\LIVING-ROOM-BRIEF.md` (development mirror)

---

## 1. What the "Living Room" Is

The **Living Room** is the primary visual interface for the Mansion: a local-first, highly polished web client built for a single operator. It is designed to feel like a premium, distraction-free environment where the operator directs agents and reviews work, rather than micromanaging permissions or digging through raw stdout logs.

Unlike traditional developer tools that place heavy Kanban boards, file trees, or issue lists at the center, the Living Room is **chat-first**. The conversation is the home. Background tasks, active paths, and process telemetry are moved into collapsible "furniture" (a side panel) to preserve a clean, human-first visual lane.

---

## 2. Lanes & Layout

The interface is split into two primary structural regions: a **Primary Chat Surface** and a **Secondary Status Side Panel**.

```
+-----------------------------------------------------------+
|  Mansion                                       [Status]   |
+---------------------------------------+-------------------+
|                                       | Active Leases     |
|  Agent: "I've started M1 tasks..."   | - gemini  23m rem |
|                                       |   /src/modules/   |
|  [System Notice: Test Run Passed]     |                   |
|  (6 tests green, click to expand)     | Active Executions |
|                                       | - npm test (run)  |
|  Operator: "Excellent. Let's push."   | - git push (idle) |
|                                       |                   |
|  +---------------------------------+  | Agent Heartbeats  |
|  | [c1: index.js] [c2: mockup.png] |  | - Codex    (busy) |
|  | Enter message or slash command  |  | - Claude   (idle) |
|  +---------------------------------+  | - Gemini   (idle) |
+---------------------------------------+-------------------+
```

### 2.1 Primary Chat Surface (The Main Lane)
- **Human-First Conversation:** A clean chat stream containing only the developer's inputs and the agents' final high-salience text responses.
- **Accidental Complexity Exclusion:** Raw telemetry dumps, full NPM test logs, and JSON data structures are strictly banned from the main chat bubble stream. 
- **Inline System Notices (Accordions):** Significant events from the EventLog (e.g., process starts, git checkouts, task transitions, test runs, search completions) are injected as compact, inline system notice cards. They feature:
  - High-level summaries (e.g., `"npm test passed (15 green)"`).
  - Color-coded indicator lights (green for success, amber for gates, red for failures).
  - An expandable drawer containing the raw logs or process output, capped to avoid lagging the viewport.
- **Unified Text Input:** A multi-line textarea that dynamically expands (1 to 10 lines) as the user types. Supports standard slash commands (e.g., `/task`, `/approve`, `/set-trust`) to trigger workspace actions.

### 2.2 Secondary Status Side Panel ("The Furniture")
A collapsible, right-anchored sidebar that acts as the "control room" of the room, exposing real-time projections without cluttering the chat history.
- **Active Path Leases:** Lists which agents currently hold locks on workspace paths, with real-time countdown timers showing when lease expiry occurs (e.g., `gemini - 1h 42m remaining on src/modules/room`).
- **Active Executions (Runs):** Shows active agent executions and background commands. Each row includes a spinner, duration, and a prominent **[Cancel]** button to immediately kill the subprocess.
- **Agent Heartbeats:** Displays the list of registered agents, their current liveness states (idle, busy, offline), and watchdog ticks.
- **Workspace State:** A summary card showing the current workspace path, active git branch, and a badge indicating clean/dirty repository state.

---

## 3. Attachment Pipeline & Drag-and-Drop

Attachments are first-class input citizens. The interface handles them smoothly to make sharing code and UI assets natural.

- **Drag-and-Drop Dropzone:** Dragging a file or directory over the window activates a full-pane translucent overlay with a modern dashed border, prompting: *"Drop files to stage in conversation"*.
- **Pasted Clipboards:** Operators can copy text files, code blocks, or screenshot images and paste them (`Ctrl+V`) directly into the input bar.
- **Staging Tray:** Staged files are displayed in an attachment tray immediately above the text input as visual preview chips:
  - **Images:** A small thumbnail crop.
  - **Code/Text:** A file type icon (e.g., JS, MD, PY) and name.
  - **Details:** File name and size.
  - **Actions:** A hoverable `"×"` button to unstage the attachment.

---

## 4. Multimodal Binding & Inline Provenance

Once sent, attachments are bound directly into the room's EventLog record and conversation stream:

- **Reference Linking:** Users can reference staged attachments using an `@` symbol (e.g., `@mockup.png` or `@index.js`) to anchor them within their message text. Clicking the reference in the final message scrolls the chat to the attachment or flashes it.
- **Lightbox Previewer:** Image attachment bubbles in the chat history show high-resolution preview grids. Clicking any image opens a premium fullscreen lightbox overlay with pan, zoom, and close capabilities.
- **Code Snippet Chips:** Attached code blocks render with syntax highlighting and a copy-to-clipboard action. Hovering displays the file path, and a quick link lets the operator jump to the line range or open the file in their local editor using the configured CLI tool.
- **Provenance Association:** If an agent executes a search, the results are displayed as interactive search notices. Citations (e.g., `[c1]`, `[c2]`) within agent text are hyperlinked directly to the search record events in the side panel or event log explorer.

---

## 5. Non-Goals

- **No Kanban-as-Home:** The home dashboard is never a grid of cards, issues, or kanban lists. Task structures exist in the database (Work module) and are visible in status drawers, but the primary view is the chat.
- **No Chat-to-Work Drive-bys:** Chatting with an agent never creates or runs a workspace-write task. Tasks must be explicitly promoted via button clicks or specific slash commands (`/task`).
- **No Complex Settings/IAM UI:** Since this is a trusted-local application, there are no screens for user registration, team management, billing, or advanced security policy configurations.

---

## 6. Visual Identity & Aesthetics

The UI must feel premium, modern, and alive, using rich design tokens and micro-interactions.

- **Color Palette (Dark Mode First):**
  - **Base Background:** Deep slate/charcoal gray (`#121316` / `hsl(220, 11%, 8%)`).
  - **Panel/Card Background:** Slightly lighter gray (`#1a1c23` / `hsl(220, 13%, 12%)`) with glassmorphism (`backdrop-filter: blur(12px)` and `rgba(255, 255, 255, 0.05)` borders).
  - **Text:** High-contrast off-white (`#f3f4f6`) for readability; secondary text in muted gray (`#9ca3af`).
  - **Accent Colors:** Electric blue (`#3b82f6`) for focus/active items; emerald (`#10b981`) for success/done; amber (`#f59e0b`) for gates/pending; rose (`#ef4444`) for errors.
- **Typography:**
  - UI font: **Outfit** or **Inter** (Google Fonts) for premium, clean layout.
  - Monospace font: **JetBrains Mono** or **Fira Code** for code snippets and system notices.
- **Animations:**
  - Transition duration: `150ms` using `cubic-bezier(0.4, 0, 0.2, 1)` for panel toggles, hover expansions, and modal overlays.
  - Dropzone active state: Gentle pulsing outer-border animation.
  - Active execution: Modern rotating segment spinner (no basic browser load indicators).

---

## 7. Acceptance Criteria (UI Slice Implementation Guide)

A frontend slice implementing this brief must satisfy the following testable criteria:

### Chat & input Lane
- [ ] **Dynamic Input Resizing:** The input box text area expands vertically as content is typed, capping at `10 lines` max-height before showing an internal scrollbar.
- [ ] **Log Collapsibility:** All system notices (build runs, test results, git changes) display in collapsed accordions. Expanding them shows log output in a monospace block, capped at `500 lines` with a scrollbar and a "View full log" button.
- [ ] **No Chat Telemetry:** Agent chat bubble messages contain text and markdown formatting only. Output arrays, intermediate step objects, and raw stderr are rendered exclusively in system notices or the runs panel.
- [ ] **Command Autocomplete:** Typing `/` in the empty input bar displays a popup menu listing commands (`/task`, `/approve`, `/set-trust`) with keyboard navigation (`Up`/`Down`/`Enter`).

### Drag-and-Drop & Attachments
- [ ] **Dropzone Overlay:** Dragging a file over the browser window shows a full-screen, blurry dropzone overlay within `50ms`. Dropping files adds them to the staged attachment tray.
- [ ] **Clipboard Paste:** Copying an image or text from the OS and pressing `Ctrl+V` while the input is focused stages that image/text as an attachment chip.
- [ ] **Attachment Chips:** Staged attachments display as individual chips inside the input area. Each chip shows a file name, size (e.g., `42 KB`), icon representing file type, and a close button that removes the file when clicked.
- [ ] **File Limit Cap:** Attempting to stage a directory or file larger than `50MB` displays an error toast: `"File exceeds 50MB cap"`.

### Multimodal Binding & Previews
- [ ] **Image Lightbox:** Clicking an image in the chat stream opens a fullscreen overlay. Pressing `Esc` or clicking outside the image dismisses the lightbox.
- [ ] **Inline Code Highlights:** Attached code snippets render with syntax highlighting corresponding to the file extension. Hovering over a code chip shows its absolute file path.
- [ ] **Reference Anchors:** Clicking a text reference (e.g., `@App.js`) highlights and flashes the associated attachment card/chip in the chat.

### Status Side Panel (Furniture)
- [ ] **Side Panel Toggle:** Clicking the status icon in the top header toggles the sidebar. Collapsing/expanding the sidebar adapts the chat container width smoothly with a CSS transition.
- [ ] **Timer Counting:** Active leases in the sidebar display a countdown timer updating every second. Once the lease reaches `00:00`, the lease entry vanishes from the list.
- [ ] **Process Cancellation:** Active execution rows in the sidebar display a `[Cancel]` button. Clicking this button sends an immediate cancel request to the backend and changes the status icon to a red cancelled state.
- [ ] **Liveness Indicator:** Agent avatars in the sidebar display a status dot (Green: Active/Running, Muted Blue: Idle, Gray: Offline) linked to their heartbeat ticks.
