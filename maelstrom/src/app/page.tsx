"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import QRCode from "qrcode";

const ZERO = BigInt(0);
const OP_CHAIN_ID = BigInt(10);
const OP_EXPLORER = "https://optimistic.etherscan.io";
const DEFAULT_OP_RPC = "https://mainnet.optimism.io";
const BALANCE_POLL_MS = 8000;
const AUTO_REGISTER_RETRY_MS = 30000;
const REGISTRATION_BUFFER_WEI = ethers.parseEther("0.0002");

const ID_GATEWAY_ADDRESS = "0x00000000fc25870c6ed6b6c7e41fb078b7656f69";

const idGatewayAbi = [
  "function idRegistry() view returns (address)",
  "function price(uint256 extraStorage) view returns (uint256)",
  "function register(address recovery) payable returns (uint256 fid, uint256 overpayment)",
] as const;

const idRegistryAbi = ["function idOf(address owner) view returns (uint256)"] as const;

type ActivityLevel = "info" | "success" | "error";
type Activity = {
  id: number;
  time: string;
  message: string;
  level: ActivityLevel;
};

type BusyAction = "generate" | "refresh" | "register" | "copy" | "download" | "copyAddress" | "copyProfile" | null;

function formatEth(wei: bigint | null): string {
  if (wei === null) return "-";
  return Number(ethers.formatEther(wei)).toFixed(6);
}

function shortAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatError(error: unknown): string {
  if (error && typeof error === "object") {
    const maybe = error as { shortMessage?: string; reason?: string; message?: string };
    return maybe.shortMessage || maybe.reason || maybe.message || "Unknown error";
  }
  if (typeof error === "string") return error;
  return "Unknown error";
}

function toHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
    return "";
  } catch {
    return "";
  }
}

export default function Home() {
  const [seedPhrase, setSeedPhrase] = useState("");
  const [custodyAddress, setCustodyAddress] = useState("");
  const [recoveryAddressInput, setRecoveryAddressInput] = useState("");
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileAvatarUrl, setProfileAvatarUrl] = useState("");
  const [rpcUrl, setRpcUrl] = useState(DEFAULT_OP_RPC);
  const [requestedFundingEth, setRequestedFundingEth] = useState("");
  const [simpleQrMode, setSimpleQrMode] = useState(true);
  const [priceWei, setPriceWei] = useState<bigint | null>(null);
  const [custodyBalanceWei, setCustodyBalanceWei] = useState<bigint | null>(null);
  const [fid, setFid] = useState<bigint | null>(null);
  const [registrationTxHash, setRegistrationTxHash] = useState("");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState("");
  const [seedVisible, setSeedVisible] = useState(false);
  const [backedUp, setBackedUp] = useState(false);
  const [autoRegisterEnabled, setAutoRegisterEnabled] = useState(true);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const pollErrorRef = useRef("");
  const autoRegisterLockRef = useRef(false);
  const autoRegisterNextAttemptRef = useRef(0);
  const autoBackupWarningRef = useRef(false);
  const profilePromptShownRef = useRef(false);

  const words = seedPhrase ? seedPhrase.split(" ") : [];

  const resolvedRecoveryAddress = useMemo(() => {
    const fromInput = recoveryAddressInput.trim();
    if (fromInput) return fromInput;
    return custodyAddress;
  }, [recoveryAddressInput, custodyAddress]);

  const suggestedFundingWei = useMemo(() => {
    if (priceWei === null) return null;
    const current = custodyBalanceWei ?? ZERO;
    if (current >= priceWei) return REGISTRATION_BUFFER_WEI;
    return priceWei - current + REGISTRATION_BUFFER_WEI;
  }, [priceWei, custodyBalanceWei]);

  const requestedFundingWei = useMemo(() => {
    const fromInput = requestedFundingEth.trim();
    if (!fromInput) return suggestedFundingWei;
    try {
      const parsed = ethers.parseEther(fromInput);
      if (parsed <= ZERO) return null;
      return parsed;
    } catch {
      return null;
    }
  }, [requestedFundingEth, suggestedFundingWei]);

  const requestedFundingInvalid = requestedFundingEth.trim().length > 0 && requestedFundingWei === null;

  const fundingUri = useMemo(() => {
    if (!custodyAddress) return "";
    if (simpleQrMode) return custodyAddress;
    if (requestedFundingWei === null) return `ethereum:${custodyAddress}@10`;
    return `ethereum:${custodyAddress}@10?value=${requestedFundingWei.toString()}`;
  }, [custodyAddress, simpleQrMode, requestedFundingWei]);

  const isFunded = priceWei !== null && custodyBalanceWei !== null && custodyBalanceWei >= priceWei;
  const fundingShortfallWei =
    priceWei !== null && custodyBalanceWei !== null && custodyBalanceWei < priceWei ? priceWei - custodyBalanceWei : ZERO;
  const canAttemptRegistration =
    seedPhrase.length > 0 && custodyAddress.length > 0 && ethers.isAddress(resolvedRecoveryAddress);
  const profileAvatarHttpUrl = useMemo(() => toHttpUrl(profileAvatarUrl), [profileAvatarUrl]);
  const hasProfileDraft = profileDisplayName.trim().length > 0 || profileAvatarUrl.trim().length > 0;

  const isBusy = busyAction !== null;

  const pushActivity = useCallback((message: string, level: ActivityLevel = "info") => {
    const entry: Activity = {
      id: Date.now() + Math.floor(Math.random() * 10_000),
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      message,
      level,
    };
    setActivity((current) => [entry, ...current].slice(0, 8));
  }, []);

  const readOnchainState = useCallback(async (targetAddress?: string) => {
    const rpc = rpcUrl.trim() || DEFAULT_OP_RPC;
    const provider = new ethers.JsonRpcProvider(rpc);
    const network = await provider.getNetwork();
    if (network.chainId !== OP_CHAIN_ID) {
      throw new Error(`RPC is on chainId ${network.chainId.toString()}. Use Optimism Mainnet (chainId 10).`);
    }

    const idGateway = new ethers.Contract(ID_GATEWAY_ADDRESS, idGatewayAbi, provider);
    const idRegistryAddress = (await idGateway.idRegistry()) as string;
    const idRegistry = new ethers.Contract(idRegistryAddress, idRegistryAbi, provider);
    const nextPrice = (await idGateway.price(0)) as bigint;

    setPriceWei(nextPrice);

    if (targetAddress && ethers.isAddress(targetAddress)) {
      const currentBalance = await provider.getBalance(targetAddress);
      setCustodyBalanceWei(currentBalance);
      const maybeFid = (await idRegistry.idOf(targetAddress)) as bigint;
      setFid(maybeFid === ZERO ? null : maybeFid);
    }
  }, [rpcUrl]);

  const handleGenerate = useCallback(async () => {
    setBusyAction("generate");
    try {
      const wallet = ethers.Wallet.createRandom();
      const phrase = wallet.mnemonic?.phrase;
      if (!phrase) throw new Error("Failed to generate a mnemonic phrase.");

      setSeedPhrase(phrase);
      setCustodyAddress(wallet.address);
      setRecoveryAddressInput("");
      setProfileDisplayName("");
      setProfileAvatarUrl("");
      setRequestedFundingEth("");
      setSimpleQrMode(true);
      setSeedVisible(false);
      setBackedUp(false);
      setRegistrationTxHash("");
      setQrCodeDataUrl("");
      setCustodyBalanceWei(null);
      setFid(null);
      pollErrorRef.current = "";
      autoRegisterLockRef.current = false;
      autoRegisterNextAttemptRef.current = 0;
      autoBackupWarningRef.current = false;
      profilePromptShownRef.current = false;

      pushActivity(`Generated new seed phrase for custody ${shortAddress(wallet.address)}.`, "success");

      await readOnchainState(wallet.address);
      pushActivity("Loaded IdGateway price and started balance watcher.", "info");
    } catch (error) {
      pushActivity(`Generate failed: ${formatError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }, [pushActivity, readOnchainState]);

  const handleCopyPhrase = useCallback(async () => {
    if (!seedPhrase) return;
    setBusyAction("copy");
    try {
      await navigator.clipboard.writeText(seedPhrase);
      pushActivity("Seed phrase copied to clipboard.", "success");
    } catch (error) {
      pushActivity(`Copy failed: ${formatError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }, [seedPhrase, pushActivity]);

  const handleDownloadBackup = useCallback(async () => {
    if (!seedPhrase || !custodyAddress) return;
    setBusyAction("download");
    try {
      const payload = {
        kind: "maelstrom-farcaster-seed-backup",
        createdAt: new Date().toISOString(),
        network: "optimism-mainnet",
        chainId: 10,
        seedPhrase,
        custodyAddress,
        suggestedRecoveryAddress: resolvedRecoveryAddress || null,
        profileDraft: {
          displayName: profileDisplayName.trim() || null,
          avatarUrl: profileAvatarUrl.trim() || null,
        },
        idGateway: ID_GATEWAY_ADDRESS,
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `maelstrom-farcaster-backup-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);

      pushActivity("Downloaded local backup file containing the seed phrase.", "success");
    } catch (error) {
      pushActivity(`Backup download failed: ${formatError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }, [seedPhrase, custodyAddress, resolvedRecoveryAddress, profileDisplayName, profileAvatarUrl, pushActivity]);

  const handleCopyAddress = useCallback(async () => {
    if (!custodyAddress) return;
    setBusyAction("copyAddress");
    try {
      await navigator.clipboard.writeText(custodyAddress);
      pushActivity("Custody address copied to clipboard.", "success");
    } catch (error) {
      pushActivity(`Copy address failed: ${formatError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }, [custodyAddress, pushActivity]);

  const handleRefreshQuote = useCallback(async () => {
    setBusyAction("refresh");
    try {
      await readOnchainState(custodyAddress || undefined);
      pushActivity("Refreshed IdGateway pricing, balance, and FID status.", "success");
    } catch (error) {
      pushActivity(`Refresh failed: ${formatError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }, [custodyAddress, readOnchainState, pushActivity]);

  const handleCopyProfileDraft = useCallback(async () => {
    setBusyAction("copyProfile");
    try {
      const lines = [
        `FID: ${fid ? fid.toString() : "pending"}`,
        `Display name: ${profileDisplayName.trim() || "(set in app)"}`,
        `Avatar URL: ${profileAvatarUrl.trim() || "(set in app)"}`,
      ];
      await navigator.clipboard.writeText(lines.join("\n"));
      pushActivity("Profile draft copied to clipboard.", "success");
    } catch (error) {
      pushActivity(`Copy profile draft failed: ${formatError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }, [fid, profileDisplayName, profileAvatarUrl, pushActivity]);

  const handleRegister = useCallback(async (source: "manual" | "auto" = "manual") => {
    setBusyAction("register");
    try {
      if (!seedPhrase || !custodyAddress) throw new Error("Generate a seed phrase first.");

      const recoveryAddress = resolvedRecoveryAddress.trim();
      if (!ethers.isAddress(recoveryAddress)) throw new Error("Recovery address is invalid.");

      const rpc = rpcUrl.trim() || DEFAULT_OP_RPC;
      const provider = new ethers.JsonRpcProvider(rpc);
      const network = await provider.getNetwork();
      if (network.chainId !== OP_CHAIN_ID) {
        throw new Error(`RPC is on chainId ${network.chainId.toString()}. Use Optimism Mainnet (chainId 10).`);
      }

      const custodyWallet = ethers.HDNodeWallet.fromPhrase(seedPhrase).connect(provider);
      if (custodyWallet.address.toLowerCase() !== custodyAddress.toLowerCase()) {
        throw new Error("Seed phrase does not match the displayed custody address.");
      }

      const idGateway = new ethers.Contract(ID_GATEWAY_ADDRESS, idGatewayAbi, custodyWallet);
      const idRegistryAddress = (await idGateway.idRegistry()) as string;
      const idRegistry = new ethers.Contract(idRegistryAddress, idRegistryAbi, provider);

      let maybeFid = (await idRegistry.idOf(custodyWallet.address)) as bigint;
      if (maybeFid > ZERO) {
        setFid(maybeFid);
        pushActivity(`Address already has FID ${maybeFid.toString()}.`, "success");
        return;
      }

      const currentPrice = (await idGateway.price(0)) as bigint;
      setPriceWei(currentPrice);

      const balance = await provider.getBalance(custodyWallet.address);
      if (balance < currentPrice) {
        throw new Error(
          `Custody wallet has ${ethers.formatEther(balance)} ETH; needs at least ${ethers.formatEther(currentPrice)} ETH.`,
        );
      }

      const tx = await idGateway["register(address)"](recoveryAddress, { value: currentPrice });
      setRegistrationTxHash(tx.hash);
      pushActivity(`${source === "auto" ? "Auto-register" : "Register"} tx submitted: ${tx.hash}`, "info");
      const receipt = await tx.wait(2);

      if (!receipt || receipt.status !== 1) throw new Error("Registration transaction failed.");

      maybeFid = (await idRegistry.idOf(custodyWallet.address)) as bigint;
      if (maybeFid === ZERO) throw new Error("Transaction mined, but FID is still 0.");

      setFid(maybeFid);
      pushActivity(`FID ${maybeFid.toString()} registered successfully.`, "success");
    } catch (error) {
      pushActivity(`Register failed: ${formatError(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }, [seedPhrase, custodyAddress, resolvedRecoveryAddress, rpcUrl, pushActivity]);

  useEffect(() => {
    if (!fundingUri) {
      setQrCodeDataUrl("");
      return;
    }

    let ignore = false;
    void QRCode.toDataURL(fundingUri, {
      width: 280,
      margin: 1,
      errorCorrectionLevel: "M",
    })
      .then((nextCode: string) => {
        if (!ignore) setQrCodeDataUrl(nextCode);
      })
      .catch((error: unknown) => {
        if (!ignore) {
          setQrCodeDataUrl("");
          pushActivity(`QR code generation failed: ${formatError(error)}`, "error");
        }
      });

    return () => {
      ignore = true;
    };
  }, [fundingUri, pushActivity]);

  useEffect(() => {
    if (!custodyAddress) return;

    const poll = async () => {
      try {
        await readOnchainState(custodyAddress);
        pollErrorRef.current = "";
      } catch (error) {
        const message = formatError(error);
        if (message !== pollErrorRef.current) {
          pollErrorRef.current = message;
          pushActivity(`Balance watcher error: ${message}`, "error");
        }
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, BALANCE_POLL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [custodyAddress, readOnchainState, pushActivity]);

  useEffect(() => {
    if (!autoRegisterEnabled || !isFunded || fid !== null || !canAttemptRegistration) return;
    if (busyAction !== null && busyAction !== "register") return;
    if (autoRegisterLockRef.current) return;

    const now = Date.now();
    if (now < autoRegisterNextAttemptRef.current) return;
    autoRegisterNextAttemptRef.current = now + AUTO_REGISTER_RETRY_MS;

    autoRegisterLockRef.current = true;

    if (!backedUp && !autoBackupWarningRef.current) {
      autoBackupWarningRef.current = true;
      pushActivity("Funding detected before backup confirmation. Save the seed phrase immediately.", "info");
    }
    pushActivity("Funding detected. Attempting automatic FID registration.", "info");

    void handleRegister("auto").finally(() => {
      autoRegisterLockRef.current = false;
    });
  }, [autoRegisterEnabled, isFunded, fid, canAttemptRegistration, busyAction, backedUp, handleRegister, pushActivity]);

  useEffect(() => {
    if (!fid) {
      profilePromptShownRef.current = false;
      return;
    }
    if (profilePromptShownRef.current) return;
    profilePromptShownRef.current = true;
    pushActivity("FID is live. Set your profile name/avatar below, then import the seed in the Farcaster app.", "success");
  }, [fid, pushActivity]);

  return (
    <main className="container">
      <section className="hero panel">
        <p className="eyebrow">Maelstrom / Farcaster onboarding</p>
        <h1 className="title">Create a Farcaster account with QR funding + auto registration</h1>
        <p className="subtitle">
          Generate a fresh seed phrase, scan the wallet QR from your phone, and as soon as funding lands on Optimism this
          page will try to register the FID automatically.
        </p>
      </section>

      <section className="grid">
        <article className="panel card">
          <h2>1) Generate seed phrase</h2>
          <p className="muted">
            This seed phrase controls the Farcaster custody wallet. The phrase never leaves your browser.
          </p>
          <div className="actions">
            <button type="button" className="btn primary" disabled={isBusy} onClick={handleGenerate}>
              {seedPhrase ? "Regenerate phrase" : "Generate phrase"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!seedPhrase || isBusy}
              onClick={() => setSeedVisible((current) => !current)}
            >
              {seedVisible ? "Hide phrase" : "Reveal phrase"}
            </button>
            <button type="button" className="btn" disabled={!seedPhrase || isBusy} onClick={handleCopyPhrase}>
              Copy phrase
            </button>
            <button type="button" className="btn" disabled={!seedPhrase || isBusy} onClick={handleDownloadBackup}>
              Download backup
            </button>
          </div>

          {seedPhrase ? (
            <>
              {seedVisible ? (
                <div className="seedGrid">
                  {words.map((word, index) => (
                    <div key={`${word}-${index}`} className="seedWord">
                      <span>{index + 1}.</span>
                      <strong>{word}</strong>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="hiddenSecret">Seed phrase hidden. Click &quot;Reveal phrase&quot; to view it.</div>
              )}
              <dl className="facts">
                <div>
                  <dt>Custody address</dt>
                  <dd>
                    <code>{custodyAddress}</code>
                  </dd>
                </div>
                <div>
                  <dt>Current FID status</dt>
                  <dd>{fid ? `FID ${fid.toString()}` : "Not registered yet"}</dd>
                </div>
              </dl>
              <label className="checkbox">
                <input type="checkbox" checked={backedUp} onChange={(event) => setBackedUp(event.target.checked)} />
                <span>I have written down this seed phrase and can recover it later.</span>
              </label>
            </>
          ) : null}
        </article>

        <article className="panel card">
          <h2>2) Fund by QR</h2>
          <p className="muted">
            Send OP ETH to this custody address from any wallet app. No browser wallet connection needed.
          </p>
          <div className="stack">
            <label>
              Optimism RPC
              <input value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} placeholder={DEFAULT_OP_RPC} />
            </label>
            <label>
              Requested amount (OP ETH)
              <input
                value={requestedFundingEth}
                onChange={(event) => setRequestedFundingEth(event.target.value)}
                placeholder={suggestedFundingWei ? formatEth(suggestedFundingWei) : "0.0025"}
              />
            </label>
            {requestedFundingInvalid ? (
              <p className="inlineWarning">Requested amount is invalid. Using network-only QR payload.</p>
            ) : null}
            <label className="checkbox compact">
              <input type="checkbox" checked={simpleQrMode} onChange={(event) => setSimpleQrMode(event.target.checked)} />
              <span>Rainbow-compatible QR (address only, recommended)</span>
            </label>
            <div className="actions">
              <button type="button" className="btn" disabled={isBusy} onClick={handleRefreshQuote}>
                Refresh status
              </button>
              <button type="button" className="btn primary" disabled={!custodyAddress || isBusy} onClick={handleCopyAddress}>
                Copy custody address
              </button>
            </div>
          </div>

          {custodyAddress ? (
            <div className="qrWrap">
              <div className="qrFrame">
                {qrCodeDataUrl ? (
                  <Image src={qrCodeDataUrl} alt="Funding QR code for custody wallet" width={220} height={220} />
                ) : (
                  <div className="qrPlaceholder">Generating QR...</div>
                )}
              </div>
              <div className="qrInfo">
                <p className="muted">
                  {simpleQrMode
                    ? "Simple address QR (best for Rainbow and most wallets). Select Optimism and send OP ETH manually."
                    : "EIP-681 QR with Optimism network + requested amount (supported by many wallets)."}
                </p>
                <code>{custodyAddress}</code>
                <a href={`${OP_EXPLORER}/address/${custodyAddress}`} target="_blank" rel="noreferrer">
                  View custody on explorer
                </a>
                {!simpleQrMode ? <code className="qrPayload">{fundingUri}</code> : null}
              </div>
            </div>
          ) : null}

          <dl className="facts">
            <div>
              <dt>IdGateway rent price</dt>
              <dd>{priceWei !== null ? `${formatEth(priceWei)} ETH` : "Not loaded"}</dd>
            </div>
            <div>
              <dt>Detected custody balance</dt>
              <dd>{custodyBalanceWei !== null ? `${formatEth(custodyBalanceWei)} ETH` : "Waiting for wallet..."}</dd>
            </div>
            <div>
              <dt>Suggested send amount</dt>
              <dd>{suggestedFundingWei !== null ? `${formatEth(suggestedFundingWei)} ETH` : "-"}</dd>
            </div>
            <div>
              <dt>QR requested amount</dt>
              <dd>{requestedFundingWei !== null ? `${formatEth(requestedFundingWei)} ETH` : "Network only"}</dd>
            </div>
          </dl>
          <p className={`statusPill ${isFunded ? "good" : "pending"}`}>
            {isFunded
              ? "Funding detected. Auto-register will run."
              : `Waiting for funding: short by ${formatEth(fundingShortfallWei)} ETH`}
          </p>
        </article>

        <article className="panel card span2">
          <h2>3) Recovery + registration</h2>
          <p className="muted">
            Registration is signed by the generated seed phrase wallet and sent directly to IdGateway on Optimism.
          </p>
          <div className="stack">
            <label>
              Recovery address (optional)
              <input
                value={recoveryAddressInput}
                onChange={(event) => setRecoveryAddressInput(event.target.value)}
                placeholder={custodyAddress || "0x..."}
              />
            </label>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoRegisterEnabled}
              onChange={(event) => setAutoRegisterEnabled(event.target.checked)}
            />
            <span>Automatically try FID registration when funding is detected.</span>
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn good"
              disabled={!canAttemptRegistration || isBusy}
              onClick={() => void handleRegister("manual")}
            >
              Try register now
            </button>
          </div>
          {!backedUp ? (
            <div className="note">
              <p>Seed backup not yet confirmed. Save the phrase before moving funds.</p>
            </div>
          ) : null}

          <div className="results">
            <div>
              <span>FID</span>
              <strong>{fid ? fid.toString() : "-"}</strong>
            </div>
            <div>
              <span>Custody</span>
              {custodyAddress ? (
                <a href={`${OP_EXPLORER}/address/${custodyAddress}`} target="_blank" rel="noreferrer">
                  {shortAddress(custodyAddress)}
                </a>
              ) : (
                <strong>-</strong>
              )}
            </div>
            <div>
              <span>Recovery</span>
              <code>{resolvedRecoveryAddress || "-"}</code>
            </div>
            <div>
              <span>Register tx</span>
              {registrationTxHash ? (
                <a href={`${OP_EXPLORER}/tx/${registrationTxHash}`} target="_blank" rel="noreferrer">
                  {shortAddress(registrationTxHash)}
                </a>
              ) : (
                <strong>-</strong>
              )}
            </div>
          </div>

          <div className="note">
            <p>
              After registration, import this seed phrase in the phone wallet used for Farcaster. Keep the phrase offline
              and treat it as the account key.
            </p>
          </div>
        </article>

        <article className="panel card span2">
          <h2>4) Name + avatar + app handoff</h2>
          <p className="muted">
            {fid
              ? `FID ${fid.toString()} is registered. Fill out your profile draft, then finish setup in the Farcaster app.`
              : "This step unlocks once FID registration succeeds."}
          </p>
          <div className="stack">
            <label>
              Display name
              <input
                value={profileDisplayName}
                onChange={(event) => setProfileDisplayName(event.target.value)}
                placeholder="John Titor"
                disabled={!fid}
              />
            </label>
            <label>
              Avatar image URL
              <input
                value={profileAvatarUrl}
                onChange={(event) => setProfileAvatarUrl(event.target.value)}
                placeholder="https://example.com/avatar.png"
                disabled={!fid}
              />
            </label>
          </div>
          <div className="profilePreview">
            <div
              className="avatarPreview"
              style={profileAvatarHttpUrl ? { backgroundImage: `url("${profileAvatarHttpUrl}")` } : undefined}
              aria-label="Avatar preview"
            >
              {!profileAvatarHttpUrl ? (profileDisplayName.trim().slice(0, 2).toUpperCase() || "FC") : null}
            </div>
            <div className="profileMeta">
              <strong>{profileDisplayName.trim() || "Display name preview"}</strong>
              <p className="muted">{profileAvatarHttpUrl ? profileAvatarHttpUrl : "Enter a public HTTPS image URL."}</p>
            </div>
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={!fid || !hasProfileDraft || isBusy}
              onClick={handleCopyProfileDraft}
            >
              Copy profile draft
            </button>
          </div>
          <div className="note">
            <p>
              Current flow registers your FID onchain here. Name and avatar are completed in-app after import.
            </p>
          </div>
          <ol className="steps">
            <li>
              Install Farcaster app:
              {" "}
              <a href="https://warpcast.com/" target="_blank" rel="noreferrer">
                iOS / Android (Warpcast)
              </a>
            </li>
            <li>Open the app and choose account recovery/import, then paste this seed phrase.</li>
            <li>Set display name and avatar in profile settings using the values above.</li>
          </ol>
        </article>
      </section>

      <section className="panel log">
        <h2>Activity</h2>
        {activity.length === 0 ? (
          <p className="muted">No actions yet.</p>
        ) : (
          <ul>
            {activity.map((entry) => (
              <li key={entry.id} className={`entry ${entry.level}`}>
                <span>{entry.time}</span>
                <p>{entry.message}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
