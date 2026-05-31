# token-watch

A VS Code extension scaffold built with TypeScript and esbuild.

## Features

- `Token Watch: Hello World` command (`token-watch.helloWorld`).
- `tokenWatch.enabled` setting.

## Project structure

```
token-watch/
├── .vscode/              # Debug + build tasks
│   ├── launch.json
│   ├── tasks.json
│   └── extensions.json
├── src/
│   ├── extension.ts      # Entry point (activate / deactivate)
│   └── test/
│       └── extension.test.ts
├── dist/                 # Bundled output (esbuild, gitignored)
├── out/                  # Compiled tests (tsc, gitignored)
├── esbuild.js            # Bundler config
├── tsconfig.json
├── .eslintrc.json
├── .vscodeignore
└── package.json          # Extension manifest
```

## Develop

```bash
npm install
npm run watch     # build + type-check in watch mode
```

Press `F5` in VS Code to launch the Extension Development Host.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run compile` | Type-check, lint, and bundle once |
| `npm run watch` | Watch mode (esbuild + tsc) |
| `npm run package` | Production bundle |
| `npm run lint` | Run ESLint |
| `npm test` | Run extension tests |

## Requirements

- VS Code `^1.90.0`
- Node.js 20+
