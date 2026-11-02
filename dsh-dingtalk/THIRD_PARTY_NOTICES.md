# Third-Party Notices

Parts of the DingTalk transport, AI Card, media, heartbeat, and onboarding implementations were adapted from:

- Project: `DingTalk-Real-AI/dingtalk-openclaw-connector`
- Source: <https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector>
- Reference snapshot reviewed for this migration: `e8dfa58614a73faa01f3a2ec828d5126a55117a0`
- License: MIT
- Copyright: Copyright (c) 2026 DingTalk Real Team

The adapted code has diverged to fit the DeepSeek Harness lifecycle and service model. File headers identify the relevant upstream modules where substantial behavior was retained.

The upstream MIT license text is reproduced in this repository's `LICENSE` file and is included in the published NPM package.

## DWS capability catalog

`enhancements/src/catalog/catalog.json` is a reduced, annotated export of the official
[DingTalk Workspace CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)
Schema, version 1.0.66, commit `f215043e676d6889e1ddce3464828d8b1ec40c31`.
Copyright 2026 Alibaba Group. Licensed under Apache-2.0.
The generator removes provenance expansion and adds CLI array encoding metadata.
Generated Client command labels are also derived from this catalog.
The original license and notices are included in
`enhancements/skills/dingtalk-workspace/DWS-LICENSE` and `DWS-NOTICE`.
The plugin itself retains its MIT license.
