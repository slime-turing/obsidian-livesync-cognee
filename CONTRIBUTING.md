# Contributing

## Scope

This project is a trusted OpenClaw plugin. Changes should preserve that trust boundary.

- Do not widen agent access when a narrow plugin tool or hook will do.
- Prefer explicit operator controls over implicit automation.
- Keep CouchDB conflict handling conservative.
- Keep snapshot provenance stable because Cognee indexing depends on it.

## Development workflow

```bash
npm install
npm run check
npm test
```

## Pull request expectations

- Explain the user-facing or operator-facing change.
- Call out any config schema changes.
- Mention whether the change affects sync semantics, conflict resolution, snapshot contents, or Cognee ingestion.
- Include tests for controller, CLI, or config behavior when practical.
- Avoid unrelated refactors in the same pull request.

## Review checklist

- Does the change preserve OpenClaw sandbox boundaries?
- Does it avoid destructive conflict resolution unless explicitly requested?
- Does it keep snapshot metadata and source references intact?
- Does it document new config, CLI, or tool behavior?

## Reporting issues

Use the GitHub issue templates so reports include enough detail about CouchDB, LiveSync document shape, OpenClaw version, and Cognee behavior.
