// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGNATURE_CANCELLED_MESSAGE } from "@/lib/signature-error";
import {
  ACCOUNT_CHANGED_ERROR,
  STORAGE_KEY,
  WalletProvider,
  checkNetworkMismatch,
  getWalletNetworkStatus,
  parseStoredSession,
  serializeSession,
  setKitPromiseForTesting,
  shouldUpdateAddress,
  updateStoredSessionAddress,
  useWallet,
} from "@/lib/wallet";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";

const ADDRESS_A = "GAEWDXVDI3WI35TWTZXNQ4NTRYIG6J34XPRSNKX655LBA377M5ZOCBY5";
const ADDRESS_B = "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE";
const WALLET_ID = "freighter";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";

// The provider reads the native balance whenever the address changes; these
// cases are about the address, so Horizon is never really asked.
vi.mock("@/lib/account", () => ({
  readNativeAccount: vi.fn(async () => ({ state: "missing" as const })),
  fundWithFriendbot: vi.fn(async () => {}),
}));

vi.mock("@/lib/config", () => ({
  config: {
    networkPassphrase: "Test SDF Network ; September 2015",
  },
}));

describe("wallet pure functions", () => {
  describe("checkNetworkMismatch", () => {
    it("returns false when wallet network is null or unknown", () => {
      expect(checkNetworkMismatch(null, TESTNET_PASSPHRASE)).toBe(false);
    });

    describe("getWalletNetworkStatus", () => {
      it("distinguishes unknown, matching and mismatched networks", () => {
        expect(getWalletNetworkStatus(null, TESTNET_PASSPHRASE)).toBe("unknown");
        expect(getWalletNetworkStatus(TESTNET_PASSPHRASE, TESTNET_PASSPHRASE)).toBe("matching");
        expect(getWalletNetworkStatus(PUBLIC_PASSPHRASE, TESTNET_PASSPHRASE)).toBe("mismatch");
      });
    });

    it("returns false when wallet network matches configured passphrase", () => {
      expect(checkNetworkMismatch(TESTNET_PASSPHRASE, TESTNET_PASSPHRASE)).toBe(false);
    });

    it("returns true when wallet network differs from configured passphrase", () => {
      expect(checkNetworkMismatch(PUBLIC_PASSPHRASE, TESTNET_PASSPHRASE)).toBe(true);
    });
  });

  describe("shouldUpdateAddress", () => {
    it("returns false when current address is null (no wallet connected)", () => {
      expect(shouldUpdateAddress(null, ADDRESS_A)).toBe(false);
    });

    it("returns false when detected address is null or undefined", () => {
      expect(shouldUpdateAddress(ADDRESS_A, null)).toBe(false);
      expect(shouldUpdateAddress(ADDRESS_A, undefined)).toBe(false);
    });

    it("returns false when current address and detected address match", () => {
      expect(shouldUpdateAddress(ADDRESS_A, ADDRESS_A)).toBe(false);
    });

    it("returns true when detected address differs from current address", () => {
      expect(shouldUpdateAddress(ADDRESS_A, ADDRESS_B)).toBe(true);
    });
  });

  describe("session storage helpers", () => {
    it("parses valid session JSON", () => {
      const raw = JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A });
      expect(parseStoredSession(raw)).toEqual({
        walletId: WALLET_ID,
        address: ADDRESS_A,
      });
    });

    it("returns null for invalid or corrupted session JSON", () => {
      expect(parseStoredSession(null)).toBeNull();
      expect(parseStoredSession("")).toBeNull();
      expect(parseStoredSession("not-json")).toBeNull();
      expect(parseStoredSession(JSON.stringify({ walletId: 123 }))).toBeNull();
      expect(parseStoredSession(JSON.stringify({ address: ADDRESS_A }))).toBeNull();
    });

    it("serializes session accurately", () => {
      expect(serializeSession(WALLET_ID, ADDRESS_A)).toBe(
        JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A }),
      );
    });

    it("updates address in stored session while preserving wallet ID", () => {
      const raw = JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A });
      const updated = updateStoredSessionAddress(raw, ADDRESS_B);
      expect(parseStoredSession(updated)).toEqual({
        walletId: WALLET_ID,
        address: ADDRESS_B,
      });
    });

    it("returns null when updating an invalid session string", () => {
      expect(updateStoredSessionAddress(null, ADDRESS_B)).toBeNull();
      expect(updateStoredSessionAddress("invalid", ADDRESS_B)).toBeNull();
    });
  });
});

describe("WalletProvider and account change detection", () => {
  const mockKit = {
    setWallet: vi.fn(),
    getAddress: vi.fn(),
    getNetwork: vi.fn(),
    signTransaction: vi.fn(),
    openModal: vi.fn(),
    disconnect: vi.fn(),
  };

  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    mockKit.getNetwork.mockResolvedValue({ networkPassphrase: TESTNET_PASSPHRASE });
    setKitPromiseForTesting(Promise.resolve(mockKit as unknown as StellarWalletsKit));
  });

  afterEach(() => {
    cleanup();
    setKitPromiseForTesting(null);
  });

  function TestConsumer() {
    const {
      address,
      error,
      networkMismatch,
      rememberedWalletId,
      reconnect,
      signXdr,
      disconnect,
    } = useWallet();
    return (
      <div>
        <div data-testid="address">{address ?? "disconnected"}</div>
        <div data-testid="mismatch">{networkMismatch ? "mismatch" : "matched"}</div>
        <div data-testid="remembered-wallet">{rememberedWalletId ?? "none"}</div>
        {error && <div data-testid="error">{error}</div>}
        <button type="button" data-testid="reconnect-btn" onClick={() => void reconnect()}>
          Reconnect
        </button>
        <button
          type="button"
          data-testid="sign-btn"
          onClick={() => void signXdr("AAAA").catch(() => {})}
        >
          Sign
        </button>
        <button type="button" data-testid="disconnect-btn" onClick={() => void disconnect()}>
          Disconnect
        </button>
      </div>
    );
  }

  it("offers a saved wallet without accessing it until the user reconnects", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A }),
    );
    // While away, user switched to ADDRESS_B in wallet extension
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_B });

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>,
    );

    expect(screen.getByTestId("address").textContent).toBe("disconnected");
    expect(screen.getByTestId("remembered-wallet").textContent).toBe(WALLET_ID);
    expect(mockKit.setWallet).not.toHaveBeenCalled();
    expect(mockKit.getAddress).not.toHaveBeenCalled();

    await act(async () => screen.getByTestId("reconnect-btn").click());
    expect(await screen.findByText(ADDRESS_B)).toBeTruthy();
    expect(mockKit.setWallet).toHaveBeenCalledWith(WALLET_ID);
    // localStorage should be updated with new address
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain(ADDRESS_B);
  });

  it("notices when the wallet's account changes on window focus and updates UI", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A }),
    );
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_A });

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>,
    );

    await act(async () => screen.getByTestId("reconnect-btn").click());
    expect(await screen.findByText(ADDRESS_A)).toBeTruthy();

    // User switches account inside wallet extension to ADDRESS_B
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_B });

    // Focus returns to the browser tab
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    // UI updates with the new address
    expect(await screen.findByText(ADDRESS_B)).toBeTruthy();
    // localStorage updated with new address
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain(ADDRESS_B);
  });

  it("notices when the wallet's account changes on document visibility change", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A }),
    );
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_A });

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>,
    );

    await act(async () => screen.getByTestId("reconnect-btn").click());
    expect(await screen.findByText(ADDRESS_A)).toBeTruthy();

    // User switches account to ADDRESS_B
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_B });

    // Tab becomes visible again
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(await screen.findByText(ADDRESS_B)).toBeTruthy();
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain(ADDRESS_B);
  });

  it("does not query wallet when no wallet is connected", async () => {
    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>,
    );

    expect(screen.getByTestId("address").textContent).toBe("disconnected");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(mockKit.getAddress).not.toHaveBeenCalled();
    expect(screen.getByTestId("address").textContent).toBe("disconnected");
  });

  it("re-reads address before signing and throws if account changed", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A }),
    );
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_A });
    mockKit.signTransaction.mockResolvedValue({ signedTxXdr: "SIGNED_XDR" });

    let capturedSignXdr!: (xdr: string) => Promise<string>;
    let capturedReconnect!: () => Promise<void>;

    function SignConsumer() {
      const { signXdr, address, reconnect } = useWallet();
      capturedSignXdr = signXdr;
      capturedReconnect = reconnect;
      return <div data-testid="address">{address}</div>;
    }

    render(
      <WalletProvider>
        <SignConsumer />
      </WalletProvider>,
    );

    await act(async () => capturedReconnect());
    expect(await screen.findByText(ADDRESS_A)).toBeTruthy();

    // Successful sign when address hasn't changed
    const res = await capturedSignXdr("UNISGNED_XDR");
    expect(res).toBe("SIGNED_XDR");

    // User switched account to ADDRESS_B right before next signature
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_B });

    // Attempting to sign now should reject and update UI
    await expect(capturedSignXdr("UNSIGNED_XDR_2")).rejects.toThrow(
      ACCOUNT_CHANGED_ERROR,
    );

    // Context address must have updated to ADDRESS_B
    expect(await screen.findByText(ADDRESS_B)).toBeTruthy();
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain(ADDRESS_B);
  });

  it.each([
    ["Freighter", new Error("The user rejected this request.")],
    [
      "Albedo",
      { message: "Action request was rejected by the user.", code: -4 },
    ],
  ])("replaces a %s signature rejection with a friendly message", async (_wallet, rejection) => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A }),
    );
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_A });
    mockKit.signTransaction.mockRejectedValue(rejection);

    let capturedSignXdr!: (xdr: string) => Promise<string>;
    let capturedReconnect!: () => Promise<void>;

    function SignConsumer() {
      const { signXdr, address, reconnect } = useWallet();
      capturedSignXdr = signXdr;
      capturedReconnect = reconnect;
      return <div data-testid="address">{address}</div>;
    }

    render(
      <WalletProvider>
        <SignConsumer />
      </WalletProvider>,
    );

    await act(async () => capturedReconnect());
    expect(await screen.findByText(ADDRESS_A)).toBeTruthy();
    await expect(capturedSignXdr("UNSIGNED_XDR")).rejects.toThrow(
      SIGNATURE_CANCELLED_MESSAGE,
    );
  });

  it("keeps a wallet error that is not a cancellation", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A }),
    );
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_A });
    mockKit.signTransaction.mockRejectedValue(
      new Error("The wallet encountered an internal error. Please try again."),
    );

    let capturedSignXdr!: (xdr: string) => Promise<string>;
    let capturedReconnect!: () => Promise<void>;

    function SignConsumer() {
      const { signXdr, address, reconnect } = useWallet();
      capturedSignXdr = signXdr;
      capturedReconnect = reconnect;
      return <div data-testid="address">{address}</div>;
    }

    render(
      <WalletProvider>
        <SignConsumer />
      </WalletProvider>,
    );

    await act(async () => capturedReconnect());
    expect(await screen.findByText(ADDRESS_A)).toBeTruthy();
    await expect(capturedSignXdr("UNSIGNED_XDR")).rejects.toThrow(
      "The wallet encountered an internal error. Please try again.",
    );
  });

  it("updates WalletButton UI when mocked account switch occurs", async () => {
    const { WalletButton } = await import("@/components/WalletButton");
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A }),
    );
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_A });

    render(
      <WalletProvider>
        <WalletButton />
      </WalletProvider>,
    );

    // The saved selection is offered but is not connected automatically.
    expect(screen.getByRole("button", { name: `Reconnect ${WALLET_ID}` })).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: `Reconnect ${WALLET_ID}` }).click());
    expect(await screen.findByText(/GAEWD/)).toBeTruthy();

    // Switch account in wallet
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_B });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    const updated = await screen.findByText(/GAP6Q/);
    expect(updated).toBeTruthy();
  });



  it("triggers data reloading in consumers when account changes", async () => {
    const loadMock = vi.fn();

    function DataConsumer() {
      const { address, reconnect } = useWallet();
      reconnectWallet = reconnect;

      useEffect(() => {
        if (address) {
          loadMock(address);
        }
      }, [address]);

      return <div data-testid="active-user">{address ? `User: ${address}` : "No user"}</div>;
    }
    let reconnectWallet!: () => Promise<void>;

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A }),
    );
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_A });

    render(
      <WalletProvider>
        <DataConsumer />
      </WalletProvider>,
    );

    await act(async () => reconnectWallet());
    expect(await screen.findByText(`User: ${ADDRESS_A}`)).toBeTruthy();
    expect(loadMock).toHaveBeenCalledWith(ADDRESS_A);

    // Mock account switch in extension
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_B });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(await screen.findByText(`User: ${ADDRESS_B}`)).toBeTruthy();
    expect(loadMock).toHaveBeenCalledWith(ADDRESS_B);
  });

  it("handles wallet getAddress error gracefully on focus without clearing state", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A }),
    );
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_A });

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>,
    );

    await act(async () => screen.getByTestId("reconnect-btn").click());
    expect(await screen.findByText(ADDRESS_A)).toBeTruthy();

    // Wallet is locked or extension temporarily throws
    mockKit.getAddress.mockRejectedValue(new Error("Wallet locked"));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    // Address remains ADDRESS_A and does not crash
    expect(screen.getByTestId("address").textContent).toBe(ADDRESS_A);
  });

  it("clears address and storage on disconnect", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ walletId: WALLET_ID, address: ADDRESS_A }),
    );
    mockKit.getAddress.mockResolvedValue({ address: ADDRESS_A });

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>,
    );

    await act(async () => screen.getByTestId("reconnect-btn").click());
    expect(await screen.findByText(ADDRESS_A)).toBeTruthy();

    await act(async () => {
      screen.getByTestId("disconnect-btn").click();
    });

    expect(screen.getByTestId("address").textContent).toBe("disconnected");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});


describe("WalletProvider connection and signing lifecycle", () => {
  const kit = {
    setWallet: vi.fn(),
    getAddress: vi.fn(),
    getNetwork: vi.fn(),
    signTransaction: vi.fn(),
    openModal: vi.fn(),
    disconnect: vi.fn(),
  };

  function mountWallet() {
    return renderHook(() => useWallet(), { wrapper: WalletProvider });
  }

  beforeEach(() => {
    window.localStorage.clear();
    vi.resetAllMocks();
    kit.getAddress.mockResolvedValue({ address: ADDRESS_A });
    kit.getNetwork.mockResolvedValue({ networkPassphrase: TESTNET_PASSPHRASE });
    kit.signTransaction.mockResolvedValue({ signedTxXdr: "SIGNED_XDR" });
    kit.disconnect.mockResolvedValue(undefined);
    kit.openModal.mockImplementation(async ({ onWalletSelected }) => {
      await onWalletSelected({ id: WALLET_ID });
    });
    setKitPromiseForTesting(Promise.resolve(kit as unknown as StellarWalletsKit));
  });

  afterEach(() => {
    cleanup();
    setKitPromiseForTesting(null);
    window.localStorage.clear();
  });

  it("starts disconnected without prompting or querying a wallet", () => {
    const { result } = mountWallet();
    expect(result.current.address).toBeNull();
    expect(result.current.connecting).toBe(false);
    expect(kit.openModal).not.toHaveBeenCalled();
    expect(kit.getAddress).not.toHaveBeenCalled();
  });

  it("connects through the selected wallet and persists its public session", async () => {
    const { result } = mountWallet();
    await act(async () => result.current.connect());
    expect(kit.setWallet).toHaveBeenCalledWith(WALLET_ID);
    expect(result.current.address).toBe(ADDRESS_A);
    expect(result.current.walletNetwork).toBe(TESTNET_PASSPHRASE);
    expect(result.current.connecting).toBe(false);
    expect(result.current.error).toBeNull();
    expect(parseStoredSession(localStorage.getItem(STORAGE_KEY))).toEqual({
      walletId: WALLET_ID,
      address: ADDRESS_A,
    });
  });

  it("persists a newly selected wallet when switching providers", async () => {
    kit.openModal.mockImplementationOnce(async ({ onWalletSelected }) => {
      await onWalletSelected({ id: "lobstr" });
    });
    const { result } = mountWallet();

    await act(async () => result.current.connect());

    expect(result.current.walletId).toBe("lobstr");
    expect(result.current.rememberedWalletId).toBe("lobstr");
    expect(parseStoredSession(localStorage.getItem(STORAGE_KEY))).toEqual({
      walletId: "lobstr",
      address: ADDRESS_A,
    });
  });

  it("does not crash or fail to connect when browser storage is unavailable", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const { result } = mountWallet();

    await act(async () => result.current.connect());

    expect(result.current.address).toBe(ADDRESS_A);
    expect(result.current.error).toBeNull();
    setItem.mockRestore();
  });

  it("ignores duplicate reconnect attempts while one is already running", async () => {
    localStorage.setItem(STORAGE_KEY, serializeSession(WALLET_ID, ADDRESS_A));
    let resolveAddress!: (value: { address: string }) => void;
    kit.getAddress.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAddress = resolve; }),
    );
    const { result } = mountWallet();
    let firstAttempt!: Promise<void>;

    await act(async () => {
      firstAttempt = result.current.reconnect();
      await result.current.reconnect();
    });
    expect(kit.getAddress).toHaveBeenCalledOnce();
    expect(result.current.connecting).toBe(true);

    await act(async () => {
      resolveAddress({ address: ADDRESS_A });
      await firstAttempt;
    });
    expect(result.current.address).toBe(ADDRESS_A);
  });

  it("stays connecting until the modal closes without a selection", async () => {
    let close: (() => void) | undefined;
    kit.openModal.mockImplementationOnce(async ({ onClosed }) => { close = onClosed; });
    const { result } = mountWallet();
    await act(async () => result.current.connect());
    expect(result.current.connecting).toBe(true);
    act(() => close?.());
    expect(result.current.connecting).toBe(false);
    expect(result.current.address).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reports a modal failure and allows retrying the connection", async () => {
    kit.openModal.mockRejectedValueOnce(new Error("Wallet unavailable"));
    const { result } = mountWallet();
    await act(async () => result.current.connect());
    expect(result.current.error).toBe("Wallet unavailable");
    expect(result.current.connecting).toBe(false);
    expect(result.current.address).toBeNull();
    await act(async () => result.current.connect());
    expect(result.current.address).toBe(ADDRESS_A);
    expect(result.current.error).toBeNull();
  });

  it("does not store a session when reading the selected account fails", async () => {
    kit.getAddress.mockRejectedValueOnce(new Error("Account locked"));
    const { result } = mountWallet();
    await act(async () => result.current.connect());
    expect(result.current.error).toBe("Account locked");
    expect(result.current.connecting).toBe(false);
    expect(result.current.address).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("removes corrupt stored sessions without opening the wallet modal", () => {
    localStorage.setItem(STORAGE_KEY, "not-json");
    const { result } = mountWallet();
    expect(result.current.address).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(kit.openModal).not.toHaveBeenCalled();
    expect(kit.setWallet).not.toHaveBeenCalled();
  });

  it("stays usable when browser storage cannot be accessed", () => {
    const storageGetter = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    try {
      const { result } = mountWallet();
      expect(result.current.address).toBeNull();
      expect(result.current.walletSelectionLoaded).toBe(true);
      expect(kit.openModal).not.toHaveBeenCalled();
    } finally {
      storageGetter.mockRestore();
    }
  });

  it("offers a saved wallet and exposes its network mismatch after explicit reconnection", async () => {
    localStorage.setItem(STORAGE_KEY, serializeSession(WALLET_ID, ADDRESS_A));
    kit.getNetwork.mockResolvedValue({ networkPassphrase: PUBLIC_PASSPHRASE });
    const { result } = mountWallet();
    expect(result.current.address).toBeNull();
    expect(result.current.rememberedWalletId).toBe(WALLET_ID);
    expect(result.current.networkStatus).toBe("unknown");
    expect(kit.getAddress).not.toHaveBeenCalled();
    await act(async () => result.current.reconnect());
    await waitFor(() => expect(result.current.networkMismatch).toBe(true));
    expect(result.current.address).toBe(ADDRESS_A);
    expect(result.current.walletNetwork).toBe(PUBLIC_PASSPHRASE);
    expect(kit.openModal).not.toHaveBeenCalled();
    await expect(result.current.signXdr("UNSIGNED")).rejects.toThrow("correct network");
    expect(kit.signTransaction).not.toHaveBeenCalled();
  });

  it("keeps the saved wallet available when reconnect fails or is rejected", async () => {
    localStorage.setItem(STORAGE_KEY, serializeSession(WALLET_ID, ADDRESS_A));
    kit.getAddress.mockRejectedValueOnce(new Error("The user rejected this request."));
    const { result } = mountWallet();

    await act(async () => result.current.reconnect());

    expect(result.current.address).toBeNull();
    expect(result.current.rememberedWalletId).toBe(WALLET_ID);
    expect(result.current.error).toBe("The user rejected this request.");
    expect(localStorage.getItem(STORAGE_KEY)).toContain(WALLET_ID);
  });

  it("blocks signing when the wallet network cannot be verified", async () => {
    kit.getNetwork.mockRejectedValue(new Error("Network unavailable"));
    const { result } = mountWallet();
    await act(async () => result.current.connect());

    expect(result.current.networkStatus).toBe("unknown");
    await expect(result.current.signXdr("UNSIGNED")).rejects.toThrow(
      "Could not verify the wallet network",
    );
    expect(kit.signTransaction).not.toHaveBeenCalled();
  });

  it("blocks signing when the final network check returns no identifier", async () => {
    const { result } = mountWallet();
    await act(async () => result.current.connect());
    kit.getNetwork.mockReset();
    kit.getNetwork
      .mockResolvedValueOnce({ networkPassphrase: TESTNET_PASSPHRASE })
      .mockResolvedValueOnce({ networkPassphrase: "" });

    await act(async () => {
      await expect(result.current.signXdr("UNSIGNED")).rejects.toThrow(
        "Could not verify the wallet network",
      );
    });

    expect(result.current.networkStatus).toBe("unknown");
    expect(kit.signTransaction).not.toHaveBeenCalled();
  });

  it("checks the live network before signing even before a focus update", async () => {
    const { result } = mountWallet();
    await act(async () => result.current.connect());
    expect(result.current.networkStatus).toBe("matching");

    kit.getNetwork.mockReset();
    kit.getNetwork
      .mockResolvedValueOnce({ networkPassphrase: TESTNET_PASSPHRASE })
      .mockResolvedValueOnce({ networkPassphrase: PUBLIC_PASSPHRASE });
    await act(async () => {
      await expect(result.current.signXdr("UNSIGNED")).rejects.toThrow("correct network");
    });

    expect(result.current.networkStatus).toBe("mismatch");
    expect(kit.signTransaction).not.toHaveBeenCalled();
  });

  it("updates the mismatch state after the wallet network changes", async () => {
    const { result } = mountWallet();
    await act(async () => result.current.connect());
    expect(result.current.networkStatus).toBe("matching");

    kit.getNetwork.mockResolvedValue({ networkPassphrase: PUBLIC_PASSPHRASE });
    await act(async () => window.dispatchEvent(new Event("focus")));

    expect(result.current.networkStatus).toBe("mismatch");
    expect(result.current.networkMismatch).toBe(true);
  });

  it("rejects signing while disconnected before accessing the wallet", async () => {
    const { result } = mountWallet();
    await expect(result.current.signXdr("UNSIGNED")).rejects.toThrow("Connect a wallet first");
    expect(kit.getAddress).not.toHaveBeenCalled();
    expect(kit.signTransaction).not.toHaveBeenCalled();
  });

  it("passes the configured network and active public address when signing", async () => {
    const { result } = mountWallet();
    await act(async () => result.current.connect());
    await expect(result.current.signXdr("UNSIGNED")).resolves.toBe("SIGNED_XDR");
    expect(kit.signTransaction).toHaveBeenCalledWith("UNSIGNED", {
      networkPassphrase: TESTNET_PASSPHRASE,
      address: ADDRESS_A,
    });
  });

  it("propagates account-read errors without requesting a signature", async () => {
    const { result } = mountWallet();
    await act(async () => result.current.connect());
    kit.getAddress.mockRejectedValueOnce(new Error("Extension disconnected"));
    await expect(result.current.signXdr("UNSIGNED")).rejects.toThrow("Extension disconnected");
    expect(kit.signTransaction).not.toHaveBeenCalled();
  });

  it("preserves the active session and reports disconnect errors", async () => {
    kit.getNetwork.mockResolvedValue({ networkPassphrase: PUBLIC_PASSPHRASE });
    const { result } = mountWallet();
    await act(async () => result.current.connect());
    expect(result.current.networkMismatch).toBe(true);
    kit.disconnect.mockRejectedValueOnce(new Error("Disconnect is unsupported"));
    await act(async () => result.current.disconnect());
    expect(result.current.address).toBe(ADDRESS_A);
    expect(result.current.walletNetwork).toBe(PUBLIC_PASSPHRASE);
    expect(result.current.networkMismatch).toBe(true);
    expect(result.current.error).toBe("Disconnect is unsupported");
    expect(localStorage.getItem(STORAGE_KEY)).toContain(WALLET_ID);
  });

  it("removes account-change listeners when the provider unmounts", async () => {
    const { result, unmount } = mountWallet();
    await act(async () => result.current.connect());
    unmount();
    kit.getAddress.mockClear();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(kit.getAddress).not.toHaveBeenCalled();
  });
});
