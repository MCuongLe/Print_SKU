# AGENTS.md

## Scope

These instructions apply to the entire repository.

## Repository overview

- This repository contains a Vietnamese browser application for printing SKU labels.
- The application is delivered as a single self-contained `index.html` file.
- `index.html` includes a production React bundle and generated/minified CSS. There is currently no source tree, package manifest, build script, or automated test suite in the repository.
- The app includes barcode/QR functionality, camera access, print layouts, and browser-side state. Treat those flows as user-facing production behavior.

## Working rules

- Keep the application usable as a standalone static page unless the task explicitly changes the deployment model.
- Do not invent npm, build, lint, or test commands that are not present in the repository.
- Avoid broad reformatting or re-minifying `index.html`; its generated sections produce very large diffs. Make the smallest targeted edit possible.
- Preserve Vietnamese UI copy, Unicode encoding, existing print styles, and responsive behavior unless the requested change requires otherwise.
- Do not add external runtime dependencies, CDN assets, analytics, trackers, or network calls without explicit approval.
- Do not commit secrets, credentials, private endpoints, or real customer/SKU data. Use clearly synthetic examples when test data is needed.
- If a requested change is substantial, first note that the repository lacks editable source files. Prefer obtaining or restoring the original source project over reverse-engineering the minified bundle.

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
