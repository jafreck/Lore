# CLAUDE.md

## Node.js Version

Always use **Node.js 22** when running commands in the terminal. Before executing any `node`, `npx`, `npm`, or `vitest` command, ensure the active Node version is 22 (e.g. via `nvm use 22`). The project requires `>=22.0.0` as specified in `package.json` `engines` and `.nvmrc`. Do **not** use Node 25 or any other version — native add-ons (tree-sitter) are only built for Node 22.

## Running the CLI

Use the compiled JS build, not tsx:

```sh
node dist/cli.js <command>
```

## Running Tests

```sh
npx vitest run <test-path>
```
