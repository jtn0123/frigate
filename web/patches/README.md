# Frontend dependency patches

`npm run postinstall` applies these files with `patch-package` after the
lockfile install. Keep the package versions pinned until each patch is removed;
an upgrade should first test the unpatched package and then regenerate or
delete its patch.

| Patch | Reason | Removal check |
|---|---|---|
| `@radix-ui+react-compose-refs+1.1.2.patch` | Keeps the composed ref callback stable and handles React 19 ref cleanup. The slot patch depends on this helper. | Test dialogs, sheets, drawers and their triggers after a Radix upgrade, then remove both Radix patches together if refs remain stable. |
| `@radix-ui+react-slot+1.2.4.patch` | Uses the stable composed-ref hook for Slot clones under React 19. | Exercise nested `asChild` triggers, including keyboard and pointer opening, on an unpatched release. |
| `vite-plugin-monaco-editor+1.1.0.patch` | Replaces removed `fs.rmdirSync({recursive:true})` with `fs.rmSync` for Vite's worker cache cleanup. | Build and open the config editor with an unpatched plugin release. |

`nosleep.js` remains the fallback for browsers without the Screen Wake Lock API
(`src/utils/screen-wake-lock.ts`). The Monaco plugin remains required by
`vite.config.ts`. The unused JavaScript `strftime` package and its type package
were removed; the app's date formatting is implemented with `date-fns` and
`date-fns-tz`.
