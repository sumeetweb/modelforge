# Trusted artifact registry

`versions/<version>/model.joblib` and `manifest.json` are generated locally by `make artifacts` and intentionally gitignored. Register a unique version with `scripts/register-model v3 --regularization 3`; reusing a directory fails rather than overwriting a model. The logistic regression pipeline uses a stratified 70/30 split with seed 42 and sklearn's bundled Iris dataset. C is inverse regularization strength. Both scaler and classifier fit only the training split.

`scripts/validate-artifact v3` checks SHA-256 before deserializing the exact checked bytes, expected features/classes, schema version, sklearn runtime version, finite normalized probabilities, and recomputed held-out accuracy of at least 0.90. The holdout is 45 samples, unsuitable as evidence of business performance. Repeatedly tuning against this holdout would overfit the gate. This is deliberately a small release-validation example.

Manifest state moves from `candidate` to `validated`, then `canary` or `promoted` through CLI actions. `retired` is reserved metadata for a manually withdrawn version. State is an audit hint, not a live traffic measurement: a rollback restores release routing but does not rewrite historical manifests. `release.json` controls stable/candidate versions and weight; `routing.env` is generated for Compose. The last release and timestamped history are stored under `history/`. Rollback is manual and restores the immediately previous configuration. JSON replacement is atomic per file; the complete multi-file release is not a transaction. Use one operator and restart only after the command succeeds. Recover `routing.env` from `release.json` if interrupted between writes.

To check a candidate already running on a direct model endpoint before changing routing:

```bash
scripts/promote-model v2 --weight 10 --health-url http://127.0.0.1:8002
```

The direct endpoint must serve the proposed version and predict setosa for the smoke input. Never pass the weighted gateway here, because it may hit a different version or fallback. A candidate's offline evaluation does not prove its serving reliability. Observe a canary under load before promotion, then run smoke again after restart.

Only the trusted local training CLI or trusted CI writes artifacts. Do not upload arbitrary pickle/joblib files or expose registration as an HTTP endpoint. SHA-256 is not a signature. In AWS, task roles can read only their configured version prefix, the bucket is private/versioned, and publication uses conditional writes to avoid overwriting an existing version. Upload artifact bytes first and the manifest last. A partial publication needs operator cleanup or a new version identifier.

To establish a new stable baseline after acceptance, edit the authoritative release JSON (`stable`, `candidate`, `canary_percent`) and corresponding routing env together while services are stopped; retain a copy of the prior release. AWS uses explicit `stableVersion`, `candidateVersion`, and `canaryPercent` CDK context instead. No running service watches local files or S3 for changes.
