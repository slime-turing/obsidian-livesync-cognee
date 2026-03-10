# Changelog

## 0.2.0

- make `obsidian_vault_deep_graph_search` the only Obsidian vault tool exposed to agents by default
- add `defaults.agentTools.defaultExpose` so operators can widen the default agent-visible tool set when needed
- register the remaining Obsidian vault tools as optional plugin tools to reduce normal channel-turn tool catalog size and token pressure
- update the plugin manifest, README, and config reference to document the new default exposure model and opt-in paths
- add live gateway verification for channel-shaped turns using OpenClaw `systemPromptReport.tools.entries` against a disposable CouchDB-backed vault
