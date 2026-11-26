"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n/provider";

import { useWallet } from "@/lib/wallet";
import { config } from "@/lib/config";
import { fromStroops, shortAddress, spendableBalance } from "@/lib/format";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * The header's wallet control: the connected address, what it can spend, and a
 * way out of the dead end a brand new testnet account is in.
 */
export function WalletButton() {
  const { t: tr } = useI18n();
  const {
    address,
    connecting,
    reconnecting,
    disconnecting,
    rememberedWalletId,
    walletSelectionLoaded,
    connect,
    reconnect,
    disconnect,
    error,
    account,
    funding,
    fund,
  } = useWallet();
  const [copying, setCopying] = useState(false);
  const [copyResult, setCopyResult] = useState<{
    address: string;
    result: "copied" | "error";
  } | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyFeedback =
    copyResult?.address === address ? copyResult.result : null;

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  async function copyAddress() {
    if (!address || copying) return;
    const copiedAddress = address;
    setCopying(true);
    let result: "copied" | "error";
    try {
      result = await copyToClipboard(copiedAddress) ? "copied" : "error";
    } catch {
      result = "error";
    } finally {
      setCopying(false);
    }
    setCopyResult({ address: copiedAddress, result });

    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(
      () => setCopyResult(null),
      result === "error" ? 4_000 : 2_000,
    );
  }

  if (!walletSelectionLoaded) {
    return (
      <span role="status" aria-live="polite" className="text-xs text-muted">
        {tr("Checking saved wallet…")}
      </span>
    );
  }

  if (!address) {
    return (
      <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
        {rememberedWalletId && (
          <button
            type="button"
            onClick={() => void reconnect()}
            disabled={connecting}
            className="btn-primary"
          >
            {reconnecting
              ? tr("Reconnecting…")
              : tr("Reconnect {0}", { "0": rememberedWalletId })}
          </button>
        )}
        <button
          type="button"
          onClick={() => void connect()}
          disabled={connecting || disconnecting}
          className={rememberedWalletId ? "btn-ghost" : "btn-primary"}
        >
          {connecting && !reconnecting
            ? tr("Connecting…")
            : rememberedWalletId
              ? tr("Choose another wallet")
              : tr("Connect wallet")}
        </button>
        {error && (
          <span role="alert" className="basis-full text-right text-xs text-danger">
            {tr(error)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex max-w-full flex-wrap items-center justify-end gap-2"
      aria-busy={disconnecting || connecting || undefined}
    >
      <BalanceLabel account={account} />
      <span
        role="group"
        className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-edge px-2.5 py-2 text-muted"
        title={address}
        aria-label={tr("Connected account {0}", { "0": address })}
      >
        <span className="h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
        <span className="mono truncate">{shortAddress(address, 5)}</span>
      </span>
      <button
        type="button"
        onClick={() => void connect()}
        disabled={connecting || disconnecting}
        className="btn-ghost"
      >
        {connecting ? tr("Connecting…") : tr("Change wallet")}
      </button>
      <button
        type="button"
        onClick={() => void copyAddress()}
        disabled={copying}
        className="btn-ghost"
        aria-label={tr("Copy connected wallet address")}
      >
        {copying
          ? tr("Copying…")
          : copyFeedback === "copied"
            ? tr("Copied!")
            : tr("Copy address")}
      </button>
      <button
        type="button"
        onClick={() => void disconnect()}
        disabled={disconnecting || connecting}
        className="btn-ghost"
      >
        {disconnecting ? tr("Disconnecting…") : tr("Disconnect")}
      </button>
      <span
        role="status"
        aria-live="polite"
        className={
          copyFeedback === "error"
            ? "basis-full text-right text-xs text-danger"
            : "sr-only"
        }
      >
        {copyFeedback === "copied"
          ? tr("Wallet address copied to clipboard")
          : copyFeedback === "error"
            ? tr("Could not copy the wallet address")
            : ""}
      </span>
      {error && (
        <span role="alert" className="basis-full text-right text-xs text-danger">
          {tr(error)}
        </span>
      )}
      {/* Friendbot is a testnet faucet; off testnet there is nothing to offer. */}
      {account.state === "missing" && config.friendbotUrl && (
        <button
          type="button"
          onClick={() => void fund()}
          disabled={funding}
          className="btn-primary"
          aria-label="Fund with Friendbot"
          title="This account does not exist on testnet yet. Friendbot will create it and give it 10,000 test XLM."
        >
          {funding ? (
            "Funding…"
          ) : (
            <>
              <span aria-hidden="true" className="sm:hidden">
                Fund
              </span>
              <span aria-hidden="true" className="hidden sm:inline">
                Fund with Friendbot
              </span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

/**
 * The spendable native balance.
 *
 * Says nothing while loading rather than flashing "0", because a wrong zero
 * reads as "you are broke" and sends people to the wrong page.
 */
function BalanceLabel({
  account,
}: {
  account: ReturnType<typeof useWallet>["account"];
}) {
  if (account.state === "loading") {
    return (
      <span className="text-xs text-muted tabular-nums" aria-live="polite">
        Reading balance…
      </span>
    );
  }
  if (account.state === "error") {
    return (
      <span className="text-xs text-amber-300" title={account.message}>
        Balance unavailable
      </span>
    );
  }
  if (account.state === "missing") {
    // The Fund button next to this says the same thing, so the label is only
    // worth the width where there is room for both.
    return (
      <span className="hidden text-xs text-amber-300 sm:inline" aria-hidden="true">
        Account not funded
      </span>
    );
  }

  const { balance, subentryCount } = account.account;
  const spendable = spendableBalance(balance, subentryCount);
  return (
    <span
      className="whitespace-nowrap text-xs text-muted tabular-nums"
      // Announced so a screen-reader user hears the balance change after a
      // transaction without having to go looking for it.
      aria-live="polite"
      title={`${fromStroops(balance)} XLM held, ${fromStroops(spendable)} XLM spendable after the ${subentryCount} ledger ${subentryCount === 1 ? "entry" : "entries"} this account keeps`}
    >
      {fromStroops(spendable)} XLM
    </span>
  );
}