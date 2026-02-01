# Maelstrom CLI (prototype)

This is a minimal CLI to support **agent-owned** Farcaster onboarding.

## Install (local)

```bash
cd cli
npm install
npm link
```

## Generate keys (no private key output)

```bash
maelstrom fc init --name JohnTitor
```

This writes:
- `~/.config/maelstrom/farcaster/JohnTitor.json` (chmod 600)

