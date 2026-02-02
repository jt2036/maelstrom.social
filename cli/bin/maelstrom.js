#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Wallet, JsonRpcProvider, formatEther, Contract, AbiCoder, getBytes, hexlify } = require('ethers');

function usage(exitCode = 0) {
  const msg = `maelstrom (prototype)

Usage:
  maelstrom fc init [--name <agentName>] [--force]
  maelstrom fc register [--name <agentName>] [--secrets <path>] [--rpc <url>] [--id-gateway <addr>] [--key-gateway <addr>] [--no-signer]

Commands:
  fc init    Generate custody + recovery keys for a Farcaster agent and store locally.
  fc register  Register a new Farcaster FID + add an ed25519 signer key (on OP Mainnet).

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
    else if (a === '--id-gateway') args.idGateway = argv[++i];
    else if (a === '--key-gateway') args.keyGateway = argv[++i];
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

function base64urlToBytes(s) {
  if (typeof s !== 'string' || !s) throw new Error('Invalid base64url');
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Uint8Array.from(Buffer.from(b64, 'base64'));
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

    process.stdout.write(`Farcaster onchain registration\n\n`);
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

    // Defaults from farcasterxyz/contracts README (v3.1 OP Mainnet deployments)
    const DEFAULT_ID_GATEWAY = '0x00000000fc25870c6ed6b6c7e41fb078b7656f69';
    const DEFAULT_KEY_GATEWAY = '0x00000000fc56947c7e7183f8ca4b62398caadf0b';

    const idGatewayAddress = (args.idGateway || process.env.FC_ID_GATEWAY || DEFAULT_ID_GATEWAY).trim();
    const keyGatewayAddress = (args.keyGateway || process.env.FC_KEY_GATEWAY || DEFAULT_KEY_GATEWAY).trim();

    const idGatewayAbi = [
      'function idRegistry() view returns (address)',
      'function price(uint256 extraStorage) view returns (uint256)',
      'function register(address recovery) payable returns (uint256 fid, uint256 overpayment)'
    ];

    const idRegistryAbi = ['function idOf(address owner) view returns (uint256)'];

    const idGateway = new Contract(idGatewayAddress, idGatewayAbi, custody);
    const idRegistryAddress = await idGateway.idRegistry();
    const idRegistry = new Contract(idRegistryAddress, idRegistryAbi, provider);

    // Step 1: Register fid if needed
    let fid = await idRegistry.idOf(custody.address);
    if (fid === 0n) {
      const price = await idGateway.price(0);
      if (bal < price) {
        throw new Error(
          `Insufficient ETH for registration. Need at least ${formatEther(price)} ETH on Optimism to rent 1 storage unit.`
        );
      }

      process.stdout.write(`1) Registering a new FID via IdGateway...\n`);
      const tx = await idGateway['register(address)'](recovery.address, { value: price });
      process.stdout.write(`   tx: ${tx.hash}\n`);
      await tx.wait(2);

      fid = await idRegistry.idOf(custody.address);
      if (fid === 0n) throw new Error('FID registration tx mined but idOf(custody) is still 0');

      payload.fid = fid.toString();
      payload.fidRegisteredAt = new Date().toISOString();
      overwriteSecretsFile(secretsPath, payload);

      process.stdout.write(`   FID: ${fid.toString()}\n\n`);
    } else {
      process.stdout.write(`1) FID already exists for custody address: ${fid.toString()}\n\n`);
    }

    // Step 2: Add signer (ed25519) via KeyGateway
    if (args.noSigner) {
      process.stdout.write(`2) Skipping signer registration (--no-signer)\n`);
      return;
    }

    if (!keyGatewayAddress) {
      throw new Error(`Missing KeyGateway address. Provide --key-gateway <addr> or set FC_KEY_GATEWAY in env.`);
    }

    const keyGatewayAbi = [
      'function keyRegistry() view returns (address)',
      'function add(uint32 keyType, bytes key, uint8 metadataType, bytes metadata)'
    ];
    const keyRegistryAbi = [
      'function validators(uint32 keyType, uint8 metadataType) view returns (address)'
    ];

    const keyGateway = new Contract(keyGatewayAddress, keyGatewayAbi, custody);
    const keyRegistryAddress = await keyGateway.keyRegistry();
    const keyRegistry = new Contract(keyRegistryAddress, keyRegistryAbi, provider);
    const validatorAddress = await keyRegistry.validators(1, 1);

    if (!validatorAddress || validatorAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('Could not resolve SignedKeyRequestValidator address from KeyRegistry.validators(1,1)');
    }

    const pub = base64urlToBytes(payload.appSignerPublicKeyBase64url);
    if (pub.length !== 32) throw new Error(`App signer public key must be 32 bytes (got ${pub.length})`);

    const keyBytes = pub;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60); // 1 hour

    // SignedKeyRequest (EIP-712) signature by custody address
    const domain = {
      name: 'Farcaster SignedKeyRequestValidator',
      version: '1',
      chainId: Number(chainId),
      verifyingContract: validatorAddress
    };

    const types = {
      SignedKeyRequest: [
        { name: 'requestFid', type: 'uint256' },
        { name: 'key', type: 'bytes' },
        { name: 'deadline', type: 'uint256' }
      ]
    };

    const value = {
      requestFid: fid,
      key: hexlify(keyBytes),
      deadline
    };

    const signature = await custody.signTypedData(domain, types, value);

    // IMPORTANT: metadata must be ABI-encoded as a single SignedKeyRequestMetadata tuple (matches validator.encodeMetadata),
    // not as four top-level values.
    const metadata = AbiCoder.defaultAbiCoder().encode(
      ['tuple(uint256 requestFid,address requestSigner,bytes signature,uint256 deadline)'],
      [{ requestFid: fid, requestSigner: custody.address, signature, deadline }]
    );

    process.stdout.write(`2) Adding signer via KeyGateway...\n`);
    const addTx = await keyGateway.add(1, keyBytes, 1, metadata);
    process.stdout.write(`   tx: ${addTx.hash}\n`);
    await addTx.wait(2);

    payload.appSignerAddedAt = new Date().toISOString();
    overwriteSecretsFile(secretsPath, payload);

    process.stdout.write(`\nDone. FID ${fid.toString()} is registered and signer is added onchain.\n`);
    return;
  }

  usage(1);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err?.message || String(err)}\n`);
  process.exit(1);
});
