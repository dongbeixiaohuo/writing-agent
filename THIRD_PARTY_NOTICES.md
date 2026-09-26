# Third-Party Notices

This file records third-party source that is actually included in Writing Agent 1.0 deliverables. It must be updated together with `upstream-sources.json` whenever source is copied, patched, bundled, or removed.

## Distributed DSH-derived source

Writing Agent now distributes a selected UI source slice from:

- Project: DeepSeek Harness
- Source: https://github.com/deepseek-ai/deepseek-harness
- Fixed commit: `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`
- License: MIT
- Copyright: Copyright (c) 2026 DeepSeek

The copied files are the theme token/styles (`base.css`, `design-platform.css`, `scrollbar.css`, `corner-shape.css`), AppFrame column geometry, Sidebar and InputBar styles, the Button primitive, and the desktop single-instance lifecycle helper listed with exact paths and SHA-256 values in `upstream-sources.json`. The desktop helper is an exact copy of `apps/desktop/src/single-instance.ts` at the fixed upstream commit; all runtime startup, preload/IPC, protocol, data paths, packaging, updater and product identity code is Writing Agent-owned. No DeepSeek logo, official brand module, font, icon pack, telemetry, account, update, plugin, terminal or remote-host code is included.

The selected browser runtime closure is React 18.3.1, React DOM 18.3.1 and clsx 2.1.1 as locked by this repository. Vite and its React plugin are build-only dependencies. The copied slice has no additional bundled font, image, WASM or worker asset.

### MIT License for the selected DeepSeek Harness source

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Writing Agent is not an official DeepSeek product. User-visible identity and product behavior are implemented by this repository; the notice above preserves the legal provenance of the selected source slice.

## cc-switch provider metadata

- Project: cc-switch, https://github.com/farion1231/cc-switch
- Fixed commit: `da193d4f7a6ce3710623c312245c752376c0d036`
- Sources: `src/config/codexProviderPresets.ts`, `src/config/claudeProviderPresets.ts`, `src/config/opencodeProviderPresets.ts`
- Adapted data: `packages/client-bridge/src/cc-switch-codex-presets.ts`, supplemental plan variants in `provider-presets.ts`, and reviewed region/product/edition labels in `provider-offerings.ts` in the same directory.
- Included: provider names, API formats, primary API base addresses and model ID examples.
- Excluded: SDK/runtime code, OAuth integration, supplier system prompts, model capability claims, affiliate links, promotions, logos and icons. Inclusion is not endorsement or account-level verification.

### MIT License for cc-switch metadata

Copyright (c) 2025 Jason Young

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Writing Agent itself remains licensed under the repository `LICENSE`. Nothing in this file changes the terms of any third-party component.
