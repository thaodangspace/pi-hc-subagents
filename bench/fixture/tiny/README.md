# tiny fixture

A deliberately small service used by the delegation benchmark. It has no
dependencies and nothing here runs in production.

Modules:

- `src/config.ts` — env parsing, defaults, and validation.
- `src/errors.ts` — the `AppError` hierarchy.
- `src/retry.ts` — exponential backoff shared by callers.
- `src/http.ts` — fetch wrapper with retries.
- `src/jobs.ts` — job runner with retries.
- `src/index.ts` — `createApp` wiring and public exports.
- `src/legacy/retry.ts` — deprecated retry loop kept until 2.0.

Run the tests with `node --test test/config.test.ts`.
