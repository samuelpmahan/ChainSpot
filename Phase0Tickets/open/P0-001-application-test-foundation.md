# P0-001: Application and test foundation

## Status

`open`

## Objective

Establish the smallest runnable, type-safe SvelteKit application and automated test foundation on which Phase 0 behavior can be implemented.

## Why this exists

The repository currently contains planning documents only. Phase 0 requires SvelteKit, strict TypeScript, Vite through SvelteKit, Konva, Vitest, and Playwright, with no backend.

## Scope

- Create a minimal SvelteKit application using TypeScript strict mode and the normal Vite-based development/build flow.
- Add Konva as the canvas scene-graph dependency.
- Configure Vitest for pure logic and component/integration tests and Playwright for current Chromium desktop browser tests.
- Define minimal run, type-check, unit-test, browser-test, and production-build commands.
- Add a single application-shell smoke test and browser smoke test that prove the harnesses work.
- Add tiny synthetic PNG and JPEG fixtures sufficient for deterministic image decoding, MIME/type, intrinsic-dimension, and test-harness use; establish their simple repository convention without speculative fixture infrastructure.
- Add concise foundation instructions to the repository README.

## Out of scope

- Image upload, canvas panes, point editing, or any other product behavior.
- Backend routes, databases, authentication, deployment, CI/CD, SSR-specific design, a design system, or a generalized test framework.
- Placeholder product modules or empty future-phase directories.

## Dependencies

None

## Requirements

- The app must run entirely in the browser and must not require a server beyond SvelteKit's local development/static application tooling.
- TypeScript strict checking must be enabled.
- Test commands must be deterministic and suitable for local use from a clean checkout after dependency installation.
- The supported Phase 0 browser baseline must be documented as current Chromium-based desktop browsers.
- Dependency versions must be recorded through the repository's normal package manifest and lockfile.

## Implementation notes

Use the standard minimal SvelteKit layout and ordinary scoped/global application CSS only as needed for the shell. Treat SvelteKit, Svelte, TypeScript, Vite, Konva, Vitest, and Playwright as the approved core stack. Do not add state-management, component-library, validation, archive, or utility dependencies in this ticket.

## Acceptance criteria

- [ ] A fresh dependency install supports documented development, type-check, test, browser-test, and build commands.
- [ ] The application shell loads in current Chromium without a runtime error.
- [ ] TypeScript runs in strict mode and the project type-checks.
- [ ] Vitest and Playwright each execute at least one meaningful smoke test.
- [ ] Tiny synthetic PNG and JPEG fixtures are available to earlier image-workspace tests without depending on later tickets.
- [ ] Konva is installed and importable without prematurely building the workspace.
- [ ] No backend, deployment, or Phase 0 product behavior has been introduced.

## Test requirements

- Add a Vitest smoke test that runs through the configured TypeScript test environment.
- Add a Playwright smoke test that opens the root application and checks a stable shell landmark.
- Verify the tiny synthetic PNG/JPEG fixtures decode with their documented intrinsic dimensions in the configured test environment.
- Run type checking and a production build.

## Manual verification

Confirm the documented local development command opens the shell in Chromium and that the browser console has no unexpected errors.

## Deliverables

- Minimal SvelteKit application and package/lock configuration.
- Strict TypeScript, Vitest, and Playwright configuration.
- Smoke tests, tiny synthetic PNG/JPEG decoding fixtures, and their simple fixture convention.
- Repository README foundation commands and browser baseline.

## Completion record

### Summary

### Tests run

### Manual checks

### Deviations

### Follow-up concerns
