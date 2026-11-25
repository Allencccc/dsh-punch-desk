# Contributing to Punch Desk

Thanks for taking the time to contribute.

## Repository model

`Allencccc/dsh-punch-desk` is the public product mirror. Maintainers develop in a private source repository and publish reviewed snapshots here. You are welcome to open issues and pull requests; accepted changes are reviewed and backported to the source repository, then included in a future snapshot. A merged PR may therefore not appear here immediately, and this repository is not the place for unreviewed feature branches.

## Before you start

- Node.js `>= 22.19.0`
- DeepSeek Harness (DSH) `>= 0.2.2-rc.1` for manual testing
- Install dependencies with `npm ci`

## Build and test

```bash
npm ci
npm test
npm run build
node --check client.js
```

`client.js` is a generated bundle. Do not edit it by hand: run `npm run build` and commit the result. Pull requests that change source must include the rebuilt `client.js`.

## Pull requests

- Keep changes focused; separate refactors from behavior changes.
- Add or update tests for behavior changes.
- Update `README.md` and `README.en.md` when user-facing behavior changes. The plugin detail documents under `docs/plugin-detail/` must stay in sync; tests enforce the mirror.
- Do not include secrets, personal absolute paths, real session data, or screenshots taken from a real GUI.
- Describe the user problem, the change, and how you verified it.

## Reporting bugs

Open an issue with steps to reproduce, your DSH version, operating system, and expected versus actual behavior. For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing, you agree that your contributions are licensed under the MIT License.
