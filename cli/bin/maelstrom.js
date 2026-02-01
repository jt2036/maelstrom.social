#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Wallet, JsonRpcProvider, formatEther } = require('ethers');

function usage(exitCode = 0) {
  const msg = `maelstrom (prototype)

Usage:
  maelstrom fc init [--name <agentName>] [--force]
  maelstrom fc register [--name <agentName>] [--secrets <path>] [--rpc <url>] [--no-signer]

Commands:
  fc init    Generate custody + recovery keys for a Farcaster agent and store locally.
  fc register  (WIP) Check Optimism connectivity + balance and print the onchain tx steps to register a new FID + signer.

Notes:
  - This command NEVER prints private keys.
  - Keys are written to ~/.config/maelstrom/farcaster/<name>.json with chmod 600.
  - Optimism RPC: uses OP_RPC_URL if set, otherwise a public default.
`;
  process.stdout.write(msg);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') args.name = argv[++i];
    else if (a === '--secrets') args.secrets = argv[++i];
    else if (a === '--rpc') args.rpc = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--no-signer') args.noSigner = true;
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

function overwriteSecretsFile(filePath, obj) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  const data = JSON.stringify(obj, null, 2) + '\n';

  fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'w' });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function resolveSecretsPath(args) {
  if (args.secrets) return path.resolve(args.secrets);

  const name = (args.name || 'JohnTitor').trim();
  if (!name) throw new Error('Missing --name');

  const baseDir = path.join(os.homedir(), '.config', 'maelstrom', 'farcaster');
  return path.join(baseDir, `${name}.json`);
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${filePath}`);
  }
}

function assertFarcasterKeys(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Secrets file is not an object');
  if (payload.kind !== 'farcaster-keys') throw new Error(`Unsupported secrets kind: ${payload.kind}`);
  if (!payload.custodyPrivateKey || typeof payload.custodyPrivateKey !== 'string') {
    throw new Error('Secrets file missing custodyPrivateKey');
  }
  if (!payload.recoveryPrivateKey || typeof payload.recoveryPrivateKey !== 'string') {
    throw new Error('Secrets file missing recoveryPrivateKey');
  }
}

function generateEd25519Signer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwkPublic = publicKey.export({ format: 'jwk' });
  const jwkPrivate = privateKey.export({ format: 'jwk' });

  if (!jwkPublic?.x || !jwkPrivate?.d) throw new Error('Failed to export ed25519 keypair');

  // Farcaster signer public keys are raw 32-byte ed25519 keys; store in base64url for portability.
  const publicKeyBase64url = jwkPublic.x;
  const privateKeyBase64url = jwkPrivate.d;

  return {
    keyType: 'ed25519',
    publicKeyBase64url,
    privateKeyBase64url,
    createdAt: new Date().toISOString()
  };
}

function getOptimismRpcUrl(args) {
  const fromArgs = (args.rpc || '').trim();
  if (fromArgs) return fromArgs;

  const fromEnv = (process.env.OP_RPC_URL || '').trim();
  if (fromEnv) return fromEnv;

  // No API key required; may be rate-limited.
  return 'https://mainnet.optimism.io';
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

  if (cmd === 'register') {
    const secretsPath = resolveSecretsPath(args);
    if (!fs.existsSync(secretsPath)) {
      throw new Error(`Secrets file not found: ${secretsPath} (run: maelstrom fc init --name <agentName>)`);
    }

    const payload = readJson(secretsPath);
    assertFarcasterKeys(payload);

    const rpcUrl = getOptimismRpcUrl(args);
    const provider = new JsonRpcProvider(rpcUrl);
    const custody = new Wallet(payload.custodyPrivateKey, provider);
    const recovery = new Wallet(payload.recoveryPrivateKey);

    // Generate an app signer keypair (ed25519) if missing.
    if (!args.noSigner) {
      const hasSigner =
        payload.appSignerKeyType &&
        payload.appSignerPublicKeyBase64url &&
        payload.appSignerPrivateKeyBase64url;
      if (!hasSigner) {
        const signer = generateEd25519Signer();
        payload.appSignerKeyType = signer.keyType;
        payload.appSignerPublicKeyBase64url = signer.publicKeyBase64url;
        payload.appSignerPrivateKeyBase64url = signer.privateKeyBase64url;
        payload.appSignerCreatedAt = signer.createdAt;
        overwriteSecretsFile(secretsPath, payload);
      }
    }

    process.stdout.write(`Farcaster onchain registration (WIP)\n\n`);
    process.stdout.write(`Secrets file: ${secretsPath}\n`);
    process.stdout.write(`OP RPC: ${rpcUrl}\n`);

    const network = await provider.getNetwork();
    const chainId = network?.chainId;
    process.stdout.write(`Chain ID: ${chainId?.toString?.() || String(chainId)}\n`);

    if (chainId !== 10n) {
      throw new Error(
        `Connected to wrong chain (expected Optimism Mainnet chainId 10). ` +
          `Set OP_RPC_URL (or --rpc) to an Optimism Mainnet RPC.`
      );
    }

    process.stdout.write(`Custody address:  ${custody.address}\n`);
    process.stdout.write(`Recovery address: ${recovery.address}\n`);

    const bal = await provider.getBalance(custody.address);
    process.stdout.write(`Custody balance:  ${formatEther(bal)} ETH\n\n`);

    if (bal === 0n) {
      process.stdout.write(
        `Warning: custody address has 0 ETH on Optimism; you must fund it before you can register an FID.\n\n`
      );
    }

    if (!args.noSigner) {
      if (payload.appSignerPublicKeyBase64url) {
        process.stdout.write(`App signer key:   ed25519 (stored in secrets file)\n`);
      }
    } else {
      process.stdout.write(`App signer key:   (skipped; --no-signer)\n`);
    }

    process.stdout.write(`\nNext required Optimism transactions (TODO: implement in CLI):\n`);
    process.stdout.write(
      `  1) Register a new Farcaster identity (FID)\n` +
        `     - From: custody address\n` +
        `     - Inputs: recovery address\n` +
        `     - Effect: assigns a new FID to the custody address onchain\n`
    );
    process.stdout.write(
      `  2) Add the app signer key to Farcaster (so the agent can post without custody key)\n` +
        `     - From: custody address\n` +
        `     - Inputs: app signer public key (ed25519)\n` +
        `     - Effect: authorizes the signer in Farcaster's Key Registry onchain\n`
    );
    process.stdout.write(
      `\nNotes:\n` +
        `  - Contract addresses/ABIs and exact function calls are intentionally TODO'd here.\n` +
        `  - Once implemented, this command should submit txs and print tx hashes + resulting FID.\n`
    );
    return;
  }

  usage(1);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err?.message || String(err)}\n`);
  process.exit(1);
});
