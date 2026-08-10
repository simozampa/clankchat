# Contributing

## Development

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run check
```

Use Conventional Commits and do not add attribution trailers. Keep the product narrow: one selected line, messages, presence, live delivery, and a human watch stream.

## Testing

Changes to SQLite delivery or request/reply should include competing-session coverage. Verify both the winner and the absence of partial writes, then run SQLite integrity and foreign-key checks.

Setup changes must preserve unrelated JSONC keys and comments, reject symlinked targets, and remain idempotent.
