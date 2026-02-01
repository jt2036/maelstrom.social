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

## Register Farcaster identity (FID) + app signer (WIP)

This command reads the secrets file created by `fc init`, connects to Optimism Mainnet, and prints the required onchain transactions.

```bash
maelstrom fc register --name JohnTitor
```

RPC selection:
- `--rpc <url>` (highest precedence)
- `OP_RPC_URL` env var
- default: `https://mainnet.optimism.io`

If you want to point at an explicit secrets path:

```bash
maelstrom fc register --secrets ~/.config/maelstrom/farcaster/JohnTitor.json
```

Notes:
- This currently performs a **chain id check** (expects Optimism Mainnet, `chainId=10`) and a **custody balance check**.
- It generates an **ed25519 app signer key** (stored in the secrets file) unless you pass `--no-signer`.
- Submitting the actual Farcaster registration / key registry transactions is TODO (the command prints the next tx steps to implement).
