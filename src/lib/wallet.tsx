"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { config } from "./config";
import { createWalletModules } from "./wallet-modules";
import type { SignXdr } from "./payflow";
import { translateSignatureError } from "./signature-error";
import { fundWithFriendbot, readNativeAccount, type NativeAccount } from "./account";
import {
  clearMerchantSession,
  getMerchantToken,
  merchantSession,
  setMerchantTokenProvider,
} from "./sep10";

export const STORAGE_KEY = "payflow.wallet";
export const ACCOUNT_CHANGED_ERROR =
  "Wallet account changed. Please retry the transaction with the new account.";

export interface StoredSession {
  walletId: string;
  address: string;
}

export type WalletNetworkStatus = "unknown" | "matching" | "mismatch";

export function parseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed?.walletId === "string" && typeof parsed?.address === "string") {
      return { walletId: parsed.walletId, address: parsed.address };
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeSession(walletId: string, address: string): string {
  return JSON.stringify({ walletId, address });
}

export function updateStoredSessionAddress(
  raw: string | null,
  newAddress: string,
): string | null {
  const session = parseStoredSession(raw);
  if (!session) return null;
  return serializeSession(session.walletId, newAddress);
}

export function checkNetworkMismatch(
  walletNetwork: string | null,
  targetPassphrase = config.networkPassphrase,
): boolean {
  if (!walletNetwork) return false;
  return walletNetwork !== targetPassphrase;
}

export function getWalletNetworkStatus(
  walletNetwork: string | null,
  targetPassphrase = config.networkPassphrase,
): WalletNetworkStatus {
  if (!walletNetwork) return "unknown";
  return checkNetworkMismatch(walletNetwork, targetPassphrase) ? "mismatch" : "matching";
}

function getWalletStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function saveWalletSession(walletId: string, address: string): void {
  try {
    getWalletStorage()?.setItem(STORAGE_KEY, serializeSession(walletId, address));
  } catch {
    // A blocked storage only means this wallet cannot be remembered.
  }
}

export function shouldUpdateAddress(
  currentAddress: string | null,
  detectedAddress: string | null | undefined,
): boolean {
  if (!currentAddress || !detectedAddress) return false;
  return currentAddress !== detectedAddress;
}

/**
 * What the header knows about the connected account's native balance.
 *
 * `missing` (the network has no such account) is kept apart from `error` (we
 * could not ask): only the first means "this needs funding".
 */
export type AccountState =
  | { state: "loading" }
  | { state: "loaded"; account: NativeAccount }
  | { state: "missing" }
  | { state: "error"; message: string };

export interface WalletState {
  address: string | null;
  walletId: string | null;
  rememberedWalletId: string | null;
  walletSelectionLoaded: boolean;
  connecting: boolean;
  reconnecting: boolean;
  disconnecting: boolean;
  error: string | null;
  networkMismatch: boolean;
  networkStatus: WalletNetworkStatus;
  walletNetwork: string | null;
  /** Native balance and entry count, or why they are not known. */
  account: AccountState;
  /** True while a Friendbot request is in flight. */
  funding: boolean;
  connect: () => Promise<void>;
  reconnect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Re-reads the native balance. Safe to call after any transaction. */
  refreshAccount: () => Promise<void>;
  /** Creates and funds the account with Friendbot. Testnet only. */
  fund: () => Promise<void>;
  signXdr: SignXdr;
}

const WalletContext = createContext<WalletState | null>(null);

/**
 * The kit registers browser custom elements on construction, so it is imported
 * dynamically and only ever instantiated client-side. Building it at module
 * scope breaks the Next.js server render.
 */
let kitPromise: Promise<StellarWalletsKit> | null = null;

export async function getKit(): Promise<StellarWalletsKit> {
  if (!kitPromise) {
    kitPromise = (async () => {
      const mod = await import("@creit.tech/stellar-wallets-kit");
      const network = config.networkPassphrase as (typeof mod.WalletNetwork)[keyof typeof mod.WalletNetwork];
      const modules = await createWalletModules(mod.allowAllModules, {
        projectId: config.walletConnectProjectId,
        network,
        appUrl: typeof window !== "undefined"
        ? `${window.location.origin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`
        : process.env.NEXT_PUBLIC_BASE_PATH ?? "/",
      });
      return new mod.StellarWalletsKit({ network, modules });
    })();
  }
  return kitPromise;
}

/**
 * Injects a kit instance for testing.
 */
export function setKitPromiseForTesting(p: Promise<StellarWalletsKit> | null) {
  kitPromise = p;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [rememberedWalletId, setRememberedWalletId] = useState<string | null>(null);
  const [walletSelectionLoaded, setWalletSelectionLoaded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletNetwork, setWalletNetwork] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountState>({ state: "loading" });
  const [funding, setFunding] = useState(false);
  const walletIdRef = useRef<string | null>(null);
  const connectionAttemptRef = useRef(false);
  const disconnectAttemptRef = useRef(false);

  // Keep a ref of the current address to avoid stale closures in event listeners
  // and async callbacks. Every setter below already writes the ref alongside the
  // state, so this effect only keeps them in step for addresses that reach the
  // state some other way. Refs are not written during render (react-hooks/refs).
  const addressRef = useRef<string | null>(address);
  useEffect(() => {
    addressRef.current = address;
  }, [address]);

  // False once the provider has unmounted, so a lookup that resolves later
  // does not set state on a provider that is gone.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Track in-flight checks to prevent duplicate concurrent queries.
  const syncingRef = useRef(false);

  /**
   * Read the native balance of whichever address is connected. Called on
   * connect and after anything that moves XLM; a disconnected wallet reads
   * nothing, so no address is ever sent to Horizon without a session.
   */
  const refreshAccount = useCallback(async () => {
    const current = addressRef.current;
    if (!current) {
      setAccount({ state: "loading" });
      return;
    }
    const result = await readNativeAccount(current);
    if (!mountedRef.current) return; // the provider unmounted meanwhile
    if (addressRef.current !== current) return; // the wallet switched meanwhile
    if (result.state === "found") {
      setAccount({ state: "loaded", account: result.account });
    } else if (result.state === "missing") {
      setAccount({ state: "missing" });
    } else {
      setAccount({ state: "error", message: result.message });
    }
  }, []);

  useEffect(() => {
    void refreshAccount();
  }, [address, refreshAccount]);

  /**
   * Ask Friendbot to create the account, then re-read it: the balance only
   * exists once Friendbot has funded it. A refusal is surfaced through the
   * usual error channel rather than thrown at the click handler.
   */
  const fund = useCallback(async () => {
    const current = addressRef.current;
    if (!current || funding) return;
    setFunding(true);
    setError(null);
    try {
      await fundWithFriendbot(current);
      await refreshAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFunding(false);
    }
  }, [funding, refreshAccount]);

  const networkStatus = address ? getWalletNetworkStatus(walletNetwork) : "unknown";
  const networkMismatch = networkStatus === "mismatch";

  const applyAccountChange = useCallback((newAddress: string) => {
    addressRef.current = newAddress;
    setAddress(newAddress);
    // The token was minted for the previous account; drop it now so a request
    // made for the new account cannot carry it. (The account-change effect
    // below clears again, but mid-flight calls run before it does.)
    clearMerchantSession();
    const activeWalletId = walletIdRef.current;
    if (activeWalletId) saveWalletSession(activeWalletId, newAddress);
  }, []);

  const checkWallet = useCallback(async () => {
    if (!addressRef.current || syncingRef.current) return;
    syncingRef.current = true;
    try {
      const kit = await getKit();
      const currentAddress = addressRef.current;
      if (!currentAddress) return;
      const currentWalletId = walletIdRef.current;
      try {
        const { address: detected } = await kit.getAddress({ skipRequestAccess: true });
        if (mountedRef.current && shouldUpdateAddress(currentAddress, detected)) {
          applyAccountChange(detected);
        }
      } catch {
        // A locked or unavailable wallet must not trigger a background prompt.
      }
      try {
        const { networkPassphrase } = await kit.getNetwork();
        if (mountedRef.current && walletIdRef.current === currentWalletId && addressRef.current) {
          setWalletNetwork(networkPassphrase || null);
        }
      } catch {
        if (mountedRef.current && walletIdRef.current === currentWalletId && addressRef.current) {
          setWalletNetwork(null);
        }
      }
    } catch {
      if (mountedRef.current) setWalletNetwork(null);
    } finally {
      syncingRef.current = false;
    }
  }, [applyAccountChange]);

  // Restore the wallet choice only. Reconnecting requires an explicit user action.
  useEffect(() => {
    try {
      const storage = getWalletStorage();
      if (!storage) return;
      const stored = storage.getItem(STORAGE_KEY);
      if (!stored) return;
      const session = parseStoredSession(stored);
      if (!session) {
        storage.removeItem(STORAGE_KEY);
        return;
      }
      walletIdRef.current = session.walletId;
      setRememberedWalletId(session.walletId);
    } catch {
      // Storage is optional; the wallet remains usable without persistence.
    } finally {
      setWalletSelectionLoaded(true);
    }
  }, []);

  // Re-read address on window focus or document visibility change. If the user
  // switched accounts in the wallet extension popup and returned to this tab,
  // update state and storage.
  useEffect(() => {
    if (!address) return;

    function onFocus() {
      void checkWallet();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void checkWallet();
      }
    }

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [address, checkWallet]);

  const activateWallet = useCallback(async (
    kit: StellarWalletsKit,
    selectedWalletId: string,
  ) => {
    kit.setWallet(selectedWalletId);
    const { address: selectedAddress } = await kit.getAddress();
    if (!selectedAddress) throw new Error("The selected wallet did not return an account address.");

    addressRef.current = selectedAddress;
    walletIdRef.current = selectedWalletId;
    setAddress(selectedAddress);
    setWalletId(selectedWalletId);
    setRememberedWalletId(selectedWalletId);
    setWalletNetwork(null);
    saveWalletSession(selectedWalletId, selectedAddress);

    try {
      const { networkPassphrase } = await kit.getNetwork();
      setWalletNetwork(networkPassphrase || null);
    } catch {
      setWalletNetwork(null);
    }
  }, []);

  const connect = useCallback(async () => {
    if (connectionAttemptRef.current) return;
    connectionAttemptRef.current = true;
    setConnecting(true);
    setReconnecting(false);
    setError(null);
    const finish = () => {
      connectionAttemptRef.current = false;
      setConnecting(false);
      setReconnecting(false);
    };
    try {
      const kit = await getKit();
      await kit.openModal({
        onWalletSelected: async (option) => {
          const previousWalletId = walletIdRef.current;
          try {
            await activateWallet(kit, option.id);
          } catch (err) {
            let message = err instanceof Error
              ? err.message
              : "Could not connect to the selected wallet.";
            if (previousWalletId) {
              try {
                kit.setWallet(previousWalletId);
              } catch (restoreError) {
                const detail = restoreError instanceof Error
                  ? restoreError.message
                  : String(restoreError);
                message = `${message} The previous wallet selection could not be restored: ${detail}`;
              }
            }
            setError(message);
          } finally {
            finish();
          }
        },
        onClosed: finish,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open wallet");
      finish();
    }
  }, [activateWallet]);

  const reconnect = useCallback(async () => {
    const selectedWalletId = rememberedWalletId;
    if (!selectedWalletId || connectionAttemptRef.current) return;
    connectionAttemptRef.current = true;
    setConnecting(true);
    setReconnecting(true);
    setError(null);
    try {
      const kit = await getKit();
      await activateWallet(kit, selectedWalletId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reconnect to the saved wallet.");
    } finally {
      connectionAttemptRef.current = false;
      setConnecting(false);
      setReconnecting(false);
    }
  }, [activateWallet, rememberedWalletId]);

  const disconnect = useCallback(async () => {
    if (disconnectAttemptRef.current) return;
    disconnectAttemptRef.current = true;
    setDisconnecting(true);
    setError(null);
    try {
      const kit = await getKit();
      await kit.disconnect();
      try {
        getWalletStorage()?.removeItem(STORAGE_KEY);
      } catch {
        // The current page can disconnect even if storage is unavailable.
      }
      walletIdRef.current = null;
      setWalletId(null);
      setRememberedWalletId(null);
      addressRef.current = null;
      setAddress(null);
      setWalletNetwork(null);
      clearMerchantSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect the wallet.");
    } finally {
      disconnectAttemptRef.current = false;
      setDisconnecting(false);
    }
  }, []);

  const signXdr = useCallback<SignXdr>(
    async (xdrString) => {
      if (!address) throw new Error("Connect a wallet first.");
      const kit = await getKit();

      // Verify the live network immediately before signing; a focus event may
      // not have fired if the wallet changed networks in another window.
      let finalSigningNetwork: string;
      try {
        const { networkPassphrase } = await kit.getNetwork();
        finalSigningNetwork = networkPassphrase;
      } catch {
        setWalletNetwork(null);
        throw new Error("Could not verify the wallet network. Signing is disabled until it can be checked.");
      }
      if (!finalSigningNetwork) {
        setWalletNetwork(null);
        throw new Error("Could not verify the wallet network. Signing is disabled until it can be checked.");
      }
      setWalletNetwork(finalSigningNetwork);
      if (checkNetworkMismatch(finalSigningNetwork)) {
        throw new Error("Switch your wallet to the correct network first.");
      }

      // Re-read the address before signing. If the user switched accounts
      // in the wallet extension popup, the prepared transaction was built
      // for the previous address. Signing it would fail verification or act
      // on the wrong account.
      let currentAddress: string | null = null;
      try {
        const res = await kit.getAddress();
        currentAddress = res.address;
      } catch (err) {
        throw new Error(
          err instanceof Error ? err.message : "Could not read address from wallet.",
        );
      }

      if (!currentAddress) throw new Error("Could not read address from wallet.");
      if (shouldUpdateAddress(address, currentAddress)) {
        applyAccountChange(currentAddress);
        throw new Error(ACCOUNT_CHANGED_ERROR);
      }

      if (addressRef.current !== address || walletIdRef.current !== walletId) {
        throw new Error("Wallet connection changed before signing. Please retry.");
      }

      let signingNetwork: string;
      try {
        const { networkPassphrase } = await kit.getNetwork();
        signingNetwork = networkPassphrase;
      } catch {
        setWalletNetwork(null);
        throw new Error("Could not verify the wallet network. Signing is disabled until it can be checked.");
      }
      if (!signingNetwork) {
        setWalletNetwork(null);
        throw new Error("Could not verify the wallet network. Signing is disabled until it can be checked.");
      }
      setWalletNetwork(signingNetwork);
      if (checkNetworkMismatch(signingNetwork)) {
        throw new Error("Switch your wallet to the correct network first.");
      }

      try {
        const { signedTxXdr } = await kit.signTransaction(xdrString, {
          networkPassphrase: config.networkPassphrase,
          address,
        });
        return signedTxXdr;
      } catch (err) {
        translateSignatureError(err);
      }
    },
    [address, walletId, applyAccountChange],
  );

  // Bind the SEP-10 merchant-session token provider to the connected account,
  // and clear the in-memory session whenever the account changes or the wallet
  // disconnects. A token minted for the previous account must never be
  // attached to a request made after the change, so the previous session is
  // dropped before the new one is bound. The token itself lives only in the
  // module singleton (`merchantSession`), never in localStorage.
  useEffect(() => {
    if (!address) {
      clearMerchantSession();
      setMerchantTokenProvider(null);
      return;
    }
    clearMerchantSession();
    setMerchantTokenProvider((merchant) => {
      // Only sign for the connected account: a subscriber viewing a merchant's
      // page must not trigger a SEP-10 challenge for that merchant.
      if (merchant !== address) return Promise.resolve(null);
      return getMerchantToken(
        {
          address,
          signXdr,
          apiUrl: config.apiUrl,
          networkPassphrase: config.networkPassphrase,
        },
        merchantSession,
      );
    });
  }, [address, signXdr]);

  const value = useMemo<WalletState>(
    () => ({
      address,
      walletId,
      rememberedWalletId,
      walletSelectionLoaded,
      connecting,
      reconnecting,
      disconnecting,
      error,
      networkMismatch,
      networkStatus,
      walletNetwork,
      account,
      funding,
      connect,
      reconnect,
      disconnect,
      refreshAccount,
      fund,
      signXdr,
    }),
    [
      address,
      walletId,
      rememberedWalletId,
      walletSelectionLoaded,
      connecting,
      reconnecting,
      disconnecting,
      error,
      networkMismatch,
      networkStatus,
      walletNetwork,
      account,
      funding,
      fund,
      connect,
      reconnect,
      disconnect,
      refreshAccount,
      signXdr,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside a WalletProvider");
  return ctx;
}
