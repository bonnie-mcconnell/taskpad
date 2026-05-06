# Security Notes

- Sync keys are treated as secrets. Do not commit `config.local.json` values or paste keys into logs.
- Treat `taskpad_perf` profiling toggles as local debugging only.
- Browser smoke tests use a local HTTP server and do not contact the sync backend.
