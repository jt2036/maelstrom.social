#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Wallet } = require('ethers');

function usage(exitCode = 0) {
  const msg = `maelstrom (prototype)

Usage:
  maelstrom fc init [--name <agentName>] [--force]

Commands:
  fc init    Generate custody + recovery keys for a Farcaster agent and store locally.

Notes:
  - This command NEVER prints private keys.
  - Keys are written to ~/.config/maelstrom/farcaster/<name>.json with chmod 600.
`;
  process.stdout.write(msg);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') args.name = argv[++i];
    else if (a === '--force') args.force = true;
    else args._.push(a);
  }
  return args;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}

function writeSecretsFile(filePath, obj, force) {
  if (fs.existsSync(filePath) && !force) {
    throw new Error(`Refusing to overwrite existing secrets file: ${filePath} (use --force)`);
  }

  const tmp = `${filePath}.tmp-${process.pid}`;
  const data = JSON.stringify(obj, null, 2) + '\n';

  fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'w' });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) usage(0);

  const [ns, cmd, ...rest] = argv;
  const args = parseArgs(rest);

  if (ns !== 'fc') usage(1);

  if (cmd === 'init') {
    const name = (args.name || 'JohnTitor').trim();
    if (!name) throw new Error('Missing --name');

    const baseDir = path.join(os.homedir(), '.config', 'maelstrom', 'farcaster');
    ensureDir(baseDir);

    const secretsPath = path.join(baseDir, `${name}.json`);

    const custody = Wallet.createRandom();
    const recovery = Wallet.createRandom();

    const payload = {
      kind: 'farcaster-keys',
      name,
      createdAt: new Date().toISOString(),
      custodyAddress: custody.address,
      recoveryAddress: recovery.address,
      // secrets
      custodyPrivateKey: custody.privateKey,
      recoveryPrivateKey: recovery.privateKey
    };

    writeSecretsFile(secretsPath, payload, !!args.force);

    // Print ONLY public material
    process.stdout.write(`Created Farcaster keys for ${name}\n\n`);
    process.stdout.write(`Secrets file: ${secretsPath}\n`);
    process.stdout.write(`Custody address:  ${payload.custodyAddress}\n`);
    process.stdout.write(`Recovery address: ${payload.recoveryAddress}\n\n`);
    process.stdout.write(`Next: fund the custody address on Optimism with a small amount of ETH to pay for registration txs.\n`);
    process.stdout.write(`(Never paste private keys into chat; they are stored only on this box.)\n`);
    return;
  }

  usage(1);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err?.message || String(err)}\n`);
  process.exit(1);
});
