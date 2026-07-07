# Blog AI Assistant Design Audit

Date: 2026-07-07

## Screenshots

- `01-desktop-first-screen.png`: desktop first screen.
- `02-desktop-full-page.png`: desktop full page.
- `03-mobile-first-screen.png`: mobile first screen.
- `04-mobile-full-page.png`: mobile full page.

## Scope

Reviewed `docs/blog-ai-assistant-design.html` as a product and architecture design report for the blog AI assistant.

## Strengths

1. The desktop first screen has a clear hierarchy: large title, short positioning text, and a compact summary card.
2. The page reads like an implementation-oriented design document, not a marketing page. This suits the current engineering task.
3. The chat widget sketch communicates the intended UI pattern well: floating entry, panel, messages, citation card, and input area.
4. The content covers product boundaries, architecture, RAG flow, deployment, CI/CD, and safety concerns in one place.

## UX Risks

1. The document is visually polished but very long. Without a sticky table of contents or section navigation, later sections are hard to scan.
2. Some technical decisions in the document do not match the current target exactly, such as `llama.cpp server`, `/api/assistant/chat`, and SSE, while the current implementation direction expects Ollama and `/api/chat`.
3. The page mixes product design, architecture, API, deployment, CI, and rollout details at the same visual priority, so readers may not know which decisions are final and which are exploratory.
4. Tables are useful on desktop, but they dominate the later sections and make the page feel more like a spec dump than a guided design.

## Accessibility And Responsive Risks

1. Mobile has horizontal overflow. At 390px viewport, tables expand the page from 375px content width to 411px scroll width.
2. Long tables need a mobile treatment: horizontal scroll wrappers, stacked rows, or card-style rows.
3. The chat preview is illustrative, but its fake controls are not interactive or semantically representative. This is fine for a report, but not enough as an implementation prototype.
4. The all-light, low-saturation palette is readable overall, but muted text inside dense tables may need contrast checks before production use.

## Recommendations

1. Add a compact sticky or floating table of contents for the report itself.
2. Split sections into three visual groups: product experience, backend architecture, and deployment/operations.
3. Mark decisions as `Confirmed`, `Open`, or `Rejected` so the document can guide implementation without ambiguity.
4. Align endpoint and model-service naming with the current target: `/api/chat`, Ollama, Qdrant, Spring AI RAG API, and k3s CronJob indexer.
5. Fix mobile table overflow before treating this as a shareable design artifact.
6. Convert the chat widget section into a closer production mock: empty state, loading state, answer with citations, busy/error state.
