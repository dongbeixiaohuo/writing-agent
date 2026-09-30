# Legacy migration and gate fixtures

These fixtures freeze the input shapes discovered during WA-001. They contain synthetic data only: no user article, account, API key, machine path, or copied production database.

## Contents

- `manifest-project/`: a readable legacy `articles/<project>/` snapshot whose fact-check state is stale and must be rechecked after import.
- `desktop-v0.1.0/`: the observed 0.1.0 SQLite schema expressed as SQL plus a synthetic `project.json`. Tests load the SQL into an in-memory SQLite database; no binary database is committed.
- `fact-gate-v2/`: deterministic strict-gate inputs. `__SNAPSHOT_ID__` is replaced with the snapshot generated from `base/` at test time. Malformed and stale-binding cases must fail closed.

Fixture changes are contract changes. Update the migration/differential test and the baseline audit in the same change; never replace a fixture with private data just because it is more realistic.
