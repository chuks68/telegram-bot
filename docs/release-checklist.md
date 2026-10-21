# Release Checklist

Repeatable procedure for preparing, verifying, packaging, and rolling back releases of `@mimir-stellar/telegram-bot`.

---

## 1. Pre-Release Verification

Run all repository quality gates and security scans against the release branch. Every command referenced below must pass cleanly before advancing.

### 1.1 Secret Scanning
Scan tracked repository files for secret-shaped strings, private keys, or exposed tokens:
```bash
npm run scan:secrets
```

### 1.2 Lockfile Verification
Confirm that `package-lock.json` is consistent with `package.json` (v3 format, registry-pinned) and fully reproducible:
```bash
npm run lockfile:check
npm run lockfile:reproduce
```

### 1.3 TypeScript Typechecking
Verify static types across the codebase without emitting artifacts:
```bash
npm run typecheck
```

### 1.4 Test Suite & Rollback Verification
Execute the test runner. This compiles TypeScript to `dist/` and executes all test suites, including unit, integration, and `tests/rollback.test.mjs`:
```bash
npm test
```

To run the rollback smoke suite in isolation:
```bash
node --test tests/rollback.test.mjs
```

### 1.5 Environment & Contributor Health Check
Run the offline contributor doctor CLI to verify local environment invariants:
```bash
npm run doctor
```

---

## 2. Version Bump & Changelog Update

### 2.1 Update CHANGELOG.md
1. Open `CHANGELOG.md`.
2. Move unreleased changes from `## [Unreleased]` into a new section titled:
   ```markdown
   ## [X.Y.Z] - YYYY-MM-DD
   ```
3. Group notable changes under standard headers: `Added`, `Changed`, `Fixed`, `Deprecated`, `Removed`, `Security`.

### 2.2 Bump Version in `package.json`
Update the `version` field in `package.json` to the target semantic version `X.Y.Z`:
```bash
npm version <patch|minor|major> --no-git-tag-version
```
*(Or manually edit `"version": "X.Y.Z"` in `package.json` and sync the lockfile via `npm install --package-lock-only`.)*

### 2.3 Verify Lockfile Alignment
Confirm that `package-lock.json` matches the updated `package.json`:
```bash
npm run lockfile:check
```

---

## 3. Build & SBOM Generation

### 3.1 Compile TypeScript
Build the production JavaScript bundles in `dist/`:
```bash
npm run build
```

### 3.2 Generate Software Bill of Materials (SBOM)
Generate a deterministic SPDX 2.3 JSON document using the built SBOM generator (`src/sbom.ts`):
```bash
node dist/sbom.js > sbom.json
```
Verify that `sbom.json` was generated and contains valid JSON with package metadata.

---

## 4. Docker Image Build

Build the production multi-stage container image locally using the repository `Dockerfile`:
```bash
docker build -t mimir-telegram-bot:vX.Y.Z -t mimir-telegram-bot:latest .
```

Verify that the image builds without errors and dependencies install cleanly via `npm ci --omit=dev`.

---

## 5. Release Commit & Tagging

Stage release files, create the release commit, and tag the release:
```bash
git add CHANGELOG.md package.json package-lock.json
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "Release vX.Y.Z"
```

Push the commit and tag to the remote repository:
```bash
git push origin <branch-name> --tags
```

---

## 6. Rollback Plan

In the event of an operational failure, regression, or network incompatibility after deployment, follow this rollback plan.

### 6.1 Rollback Invariants (Covered by `tests/rollback.test.mjs`)
The bot architecture guarantees safe rollbacks through the following invariants:
1. **Cursor Backwards Compatibility**: The cursor file (`./data/cursor.json`) uses a stable schema version (`version: 1`). Any new or unknown fields persisted by newer builds are safely ignored by earlier builds.
2. **Cold Start Resilience**: If a cursor file is absent or corrupted, the poller does not crash. It quarantines corrupt files to `./data/cursor.json.corrupt.<timestamp>` and starts cold by scanning `START_LOOKBACK_LEDGERS` (default: 60) behind the chain tip.
3. **RPC and Network Isolation**: Soroban RPC errors or Telegram send failures do not corrupt or zero the persisted cursor. Next poll cycles resume from the last committed ledger.
4. **Configuration Fail-Fast**: Bad or missing configuration triggers a `ConfigError` before entering the event loop, preventing silent broken states.

### 6.2 Pre-Deployment Snapshot
Before deploying a new release to production, capture a backup of the current cursor:
```bash
npm run cursor -- backup
```
*(Creates a timestamped backup in `./data/cursor.json.<timestamp>.bak`.)*

### 6.3 Rollback Steps

#### If deployed as a Docker container:
1. Stop the running container:
   ```bash
   docker stop <container-id>
   ```
2. Redeploy the previous known-good Docker image:
   ```bash
   docker run -d --env-file .env -v bot-data:/app/data mimir-telegram-bot:<previous-version>
   ```

#### If deployed on bare metal / systemd:
1. Stop the systemd service:
   ```bash
   sudo systemctl stop telegram-bot
   ```
2. Check out the previous release tag:
   ```bash
   git checkout v<previous-version>
   ```
3. Re-install and rebuild:
   ```bash
   npm ci
   npm run build
   ```
4. Restart the service:
   ```bash
   sudo systemctl start telegram-bot
   ```

### 6.4 Cursor Recovery (If Needed)
If a bad deployment corrupted or misaligned cursor positions, restore the previous cursor backup:
```bash
npm run cursor -- restore --from ./data/cursor.json.<timestamp>.bak
```
Alternatively, remove the cursor file to let the bot cold-start from recent ledgers:
```bash
rm -f ./data/cursor.json
```

### 6.5 Post-Rollback Verification
Confirm that the restored instance is operating normally:
1. Run local diagnostic checks:
   ```bash
   npm run doctor
   ```
2. Verify poller logs to ensure event cycles are executing without repeated errors:
   ```bash
   docker logs -f <container-id>
   # or
   journalctl -u telegram-bot -f
   ```
