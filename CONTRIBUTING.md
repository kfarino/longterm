# Contributing

Thanks for interest in Longterm. This repo is meant to be **forked** as a
starting point for another household’s local planner.

## Before you open a PR

1. Read [`AGENTS.md`](./AGENTS.md) (privacy + footguns).
2. Run `npm run check:secrets` — must pass.
3. Run relevant tests under `data/test-*.mjs` for the area you touched.
4. **Never** commit real `data/*.json` household files, `.env` files, or bank exports.
5. Use invented merchants/amounts in tests, fixtures, screenshots, and issue text.

## Pull requests

- Prefer small, focused changes.
- Prefer editing `examples/` + scripts over embedding anyone’s real finances.
- If a design choice is large, open an issue or add a short note under
  `docs/superpowers/specs/` first.

## License

By contributing, you agree your contributions are licensed under the MIT
License (`LICENSE`).
