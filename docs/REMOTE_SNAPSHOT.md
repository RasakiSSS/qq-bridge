# Remote source snapshot

This branch saves the local qq-bridge feature work as one source snapshot on the public upstream baseline. Local development history, account configuration, tokens, sessions, state, binaries and private untracked role files are not included. IDs and personal paths in operational notes are examples.

Before deploying, configure the explicit executable and workspace paths in the administrator-only qq-chat-v2-files preset and regenerate its patch. Do not broaden the permitted filesystem root. Native AddBuddy support is version-pinned and disabled by default; production installation requires its separate deployment procedure.

SnowLuma itself has no functional source modifications in this snapshot: the WebSocket compatibility adapter and native friend service live in this repository.
