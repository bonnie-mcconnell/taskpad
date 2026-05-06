# Taskpad Tray

## Test

Run the unit tests and browser smoke tests:

```bash
npm test
npm run test:e2e
```

## Notes

- Shared ordering behavior lives in `src/app/ordering-core.mjs`.
- Set `localStorage.taskpad_perf = '1'` to log slow render and drag operations in the console.
