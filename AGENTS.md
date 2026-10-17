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

- Roles, workflow and the hand-off brief template live in `docs/DOI_AGENT.md` (version 2, 17/10/2026: five hard rules — design before code for large work, red test before logic changes, root cause before bug fixes, evidence before "done", commit only when the user says; three work sizes Small/Medium/Large; plans and designs for Large work in `docs/plans/`). Agent profiles are in `.claude/agents/` (`trinh-sat`, `thuc-thi-logic`, `thuc-thi-khuon`, `kiem-thu`); the independent review skill is `.claude/skills/review-codex`.
- Executors work only inside the files and anchor strings named in their brief, never commit, never run migrations or deploys, and report real test output. The lead merges, runs `python scripts/run_tests.py`, and owns migrations, deploys and commits.
- Decisions already recorded as "do not do" in `RULES.md` are binding for every agent.

## Project map (read first, from 17/10/2026)

- `docs/PROJECT_MAP.md` is the quick map of the whole project: home tiles → hash routes → `index.html` block ids, Extension files and commands, Edge actions, Supabase tables, which migration file holds the latest version of each function, test and deploy commands. Read it before exploring; grep only to confirm the part you touch.
- One-line architecture: static `index.html` (GitHub Pages) + Chrome Extension `extension/inside-po-connector` (reads Inside/WMS inside logged-in tabs; tokens never leave the tab; 0.10.0 also runs auto-sync in the background) + Supabase (RPC/RLS/pg_cron, Edge `sku-sync`, `group-uid-sync`, `print-assistant`, `sku-vision`) + print agent on `may-kho-01` reading `print_jobs`.
- Every module lives in `index.html` as a `<style id=…>` + `<section id=…-screen>` + `<script id=…>` IIFE; locate by id or anchor string, never by line number. Shared gates: `window.PrintSkuQueue`, `PrintSkuAdminAuth`/`PrintSkuAdminAccess`, `extensionRequest` helpers (count asserted by `tests/bridge_ready.cjs`), `window.HasakiSkuIt`.
- Release order is always migration → deploy Edge → Reload Extension (then reload Inside/WMS tabs). `python scripts/run_tests.py` runs the whole suite against the static server on port 8000; agent worktrees must use another port and `BASE=`.
- Decisions already made live in `RULES.md` (local, not in git) and in the lead's memory; the lead updates `docs/PROJECT_MAP.md` in the same commit whenever a module, command, Edge action or migration chain changes.
