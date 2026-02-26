# Releases Directory

This folder is for release documentation and optional packaged artifacts.

## Current State

- This repository currently does **not** include committed extension zip artifacts by default.
- Build artifacts are usually generated locally or by CI and then distributed externally.

## Build Extension Package Locally

From repository root:

```bash
pnpm install
pnpm --filter webpage-mcp-server build
pnpm --filter webpage-mcp-server zip
```

Generated zip files are placed in:

- `app/chrome-extension/.output/`

## Load Extension Unpacked (Recommended for Dev)

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `app/chrome-extension/.output/chrome-mv3`
