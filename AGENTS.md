# AGENTS.md

## Scope

These instructions apply to the entire repository.

## Repository overview

- The app includes barcode/QR functionality, camera access, print layouts, and browser-side state. Treat those flows as user-facing production behavior.

## Working rules

- Keep the application usable as a standalone static page unless the task explicitly changes the deployment model.
- Do not invent npm, build, lint, or test commands that are not present in the repository.
- Avoid broad reformatting or re-minifying `index.html`; its generated sections produce very large diffs. Make the smallest targeted edit possible.
- Preserve Vietnamese UI copy, Unicode encoding, existing print styles, and responsive behavior unless the requested change requires otherwise.
- Do not add external runtime dependencies, CDN assets, analytics, trackers, or network calls without explicit approval.
- Do not commit secrets, credentials, private endpoints, or real customer/SKU data. Use clearly synthetic examples when test data is needed.

## Validation

For every change, perform the checks that apply:

1. Review `git diff --check` and inspect the final diff for accidental large generated changes.
2. Serve the repository locally rather than relying only on opening the file directly. One available option is:

   ```powershell
   python -m http.server 8000
   ```

3. Open `http://localhost:8000/` in a modern Chromium-based browser and confirm the page loads without console errors.
4. Exercise the affected workflow with synthetic SKU data. Check both desktop and narrow/mobile viewport behavior.
5. For label or layout changes, use print preview and verify page size, margins, clipping, barcode readability, and multi-label pagination.
6. For scanner or camera changes, test permission denied, unavailable camera, successful scan, and manual-entry fallback. Camera behavior must remain compatible with secure contexts (`https://` or localhost).
7. If automated validation is not possible, state exactly which manual checks remain for the user.

## Change handoff

- Summarize the user-visible behavior changed.
- List the validation performed and any untested browser, camera, printer, or label-size scenarios.
- Call out unusually large changes to `index.html` and explain why they were necessary.

## Agent team (from 16/10/2026)

- Roles and workflow live in `docs/DOI_AGENT.md` (version 3, 18/10/2026: the lead does most work directly; four hard rules — evidence before "done", root cause before bug fixes, commit only when the user says, migration before push; red test first only for bug fixes and logic changes; one Codex round per batch for SQL/Edge/Extension/print/permissions AND for UI via screenshots; plan files in `docs/plans/` only for multi-step migration work). Agent profiles are in `.claude/agents/` (`trinh-sat`, `thuc-thi-logic`, `kiem-thu`; `thuc-thi-khuon` removed 18/10/2026 — the lead builds UI directly; `co-van` (Fable, read-only) advises the Opus lead at four hard-decision points listed in DOI_AGENT and, from 22/10/2026, triages every code-review round — merges raw Codex + Claude findings, confirms them in code, sorts fix / later / skip), used only when work can genuinely run in parallel; the independent review skills are `.claude/skills/review-codex` and, run in parallel with it from 18/10/2026, `.claude/skills/review-claude` (three Claude reviewers + Haiku confidence filter ≥ 80, same diff scope and three-round limit via `scripts/codex_review.py --prepare-only`).
- Agents given work stay inside the files and anchor strings named in their brief, never commit, never run migrations or deploys, never write `RULES.md`, and report real test output. The lead runs the related tests while working, the whole `python scripts/run_tests.py` once (in the background, it retries failures once and labels flaky tests) and `python scripts/commit_gate.py` before reporting, and owns migrations, deploys, commits and `RULES.md`.
- Decisions already recorded as "do not do" in `RULES.md` are binding for every agent.

## Project map (read first, from 17/10/2026)

- Reading order for every session and agent: this file → `docs/CONTEXT_MAP.md` → `docs/PROJECT_MAP.md` → the index at the top of `RULES.md`. `docs/CONTEXT_MAP.md` (from 23/10/2026): one-page map of the six context sources (Source Code, Database, Business Logic, Dependencies, Documentation, Git History) with the diagram `docs/context-map.svg`, the reading order, and how to build a one-file AI context pack with repomix (`repomix.config.json` → `outputs/repomix/print-sku-context.xml`, not committed).
- `RULES.md` (local only) now opens with a topic index "QUYẾT ĐỊNH ĐANG HIỆU LỰC" (12 topics, dropped / deferred items, what is live on Supabase); read that index instead of grepping the long log below it, and record each new decision in both the log and the index.
- `index.html` blocks: run `python scripts/index_outline.py [filter]` for current line ranges (every style/script block has an id); always cap line length when grepping `index.html` (the `worker-bundle` block has lines of hundreds of KB).
- New `SECURITY DEFINER` SQL functions: revoke EXECUTE explicitly `from public, anon, authenticated` (schema default privileges grant anon/authenticated), then grant only the roles that need it.
- `docs/PROJECT_MAP.md` is the quick map of the whole project: home tiles → hash routes → `index.html` block ids, Extension files and commands, Edge actions, Supabase tables, which migration file holds the latest version of each function, test and deploy commands. Read it before exploring; grep only to confirm the part you touch.
- One-line architecture: static `index.html` (GitHub Pages) + Chrome Extension `extension/inside-po-connector` (reads Inside/WMS inside logged-in tabs; tokens never leave the tab; since 0.10.0 it also runs auto-sync in the background; current version in `manifest.json`) + Supabase (RPC/RLS/pg_cron, Edge `sku-sync`, `group-uid-sync`, `print-assistant`, `sku-vision`) + print agent on `may-kho-01` reading `print_jobs`.
- Every module lives in `index.html` as a `<style id=…>` + `<section id=…-screen>` + `<script id=…>` IIFE; locate by id or anchor string, never by line number. Shared gates: `window.PrintSkuQueue`, `PrintSkuAdminAuth`/`PrintSkuAdminAccess`, `extensionRequest` helpers (count asserted by `tests/bridge_ready.cjs`), `window.HasakiSkuIt`.
- Release order is always migration → deploy Edge → Reload Extension (then reload Inside/WMS tabs). Pushing `main` deploys the web immediately (GitHub Pages): when the web needs new database functions or Edge actions, commit without pushing, run the migration/deploy, then push. The Supabase MCP plugin is for reads only; writes go through the scripts the user runs. `python scripts/run_tests.py` runs the whole suite against the static server on port 8000; agent worktrees must use another port and `BASE=`.
- Decisions already made live in `RULES.md` (local, not in git) and in the lead's memory; the lead updates `docs/PROJECT_MAP.md` in the same commit whenever a module, command, Edge action or migration chain changes.
