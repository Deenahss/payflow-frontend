// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WalletButton } from "@/components/WalletButton";
import { shortAddress } from "@/lib/format";

const fixtures = vi.hoisted(() => ({
  wallet: {
    address: null as string | null,
    connecting: false,
    reconnecting: false,
    disconnecting: false,
    rememberedWalletId: null as string | null,
    walletSelectionLoaded: true,
    error: null as string | null,
    account: { state: "loading" as const },
    funding: false,
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    fund: vi.fn(),
  },
  copyToClipboard: vi.fn(),
}));

vi.mock("@/lib/wallet", () => ({ useWallet: () => fixtures.wallet }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: fixtures.copyToClipboard }));

const ADDRESS = "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE";

describe("WalletButton", () => {
  beforeEach(() => {
    Object.assign(fixtures.wallet, {
      address: null,
      connecting: false,
      reconnecting: false,
      disconnecting: false,
      rememberedWalletId: null,
      walletSelectionLoaded: true,
      error: null,
      account: { state: "loading" },
      funding: false,
    });
    fixtures.wallet.connect.mockReset();
    fixtures.wallet.reconnect.mockReset();
    fixtures.wallet.disconnect.mockReset();
    fixtures.wallet.fund.mockReset();
    fixtures.copyToClipboard.mockReset();
  });

  afterEach(cleanup);

  it("offers one-tap reconnect and a way to choose another wallet", () => {
    fixtures.wallet.rememberedWalletId = "freighter";
    render(<WalletButton />);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect freighter" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose another wallet" }));

    expect(fixtures.wallet.reconnect).toHaveBeenCalledOnce();
    expect(fixtures.wallet.connect).toHaveBeenCalledOnce();
  });

  it("shows loading while the saved wallet preference is being checked", () => {
    fixtures.wallet.walletSelectionLoaded = false;
    render(<WalletButton />);

    expect(screen.getByRole("status").textContent).toContain("Checking saved wallet");
    expect(screen.queryByRole("button", { name: "Connect wallet" })).toBeNull();
  });

  it("shows a truncated connected account and copies the full address", async () => {
    fixtures.wallet.address = ADDRESS;
    fixtures.copyToClipboard.mockResolvedValue(true);
    const { rerender } = render(<WalletButton />);

    expect(screen.getByText(shortAddress(ADDRESS, 5))).toBeTruthy();
    expect(screen.getByRole("group", { name: `Connected account ${ADDRESS}` })).toBeTruthy();
    expect(screen.getByTitle(ADDRESS)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy connected wallet address" }));

    await waitFor(() => {
      expect(fixtures.copyToClipboard).toHaveBeenCalledWith(ADDRESS);
      expect(screen.getByRole("status").textContent).toContain("Wallet address copied");
      expect(screen.getByText("Copied!")).toBeTruthy();
    });

    fixtures.wallet.address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    rerender(<WalletButton />);
    expect(screen.queryByText("Copied!")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Change wallet" }));
    expect(fixtures.wallet.connect).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(fixtures.wallet.disconnect).toHaveBeenCalledOnce();
  });

  it("shows copy failure feedback and keeps disconnect available", async () => {
    fixtures.wallet.address = ADDRESS;
    fixtures.copyToClipboard.mockResolvedValue(false);
    render(<WalletButton />);

    fireEvent.click(screen.getByRole("button", { name: "Copy connected wallet address" }));
    await waitFor(() => {
      expect(screen.getByText("Could not copy the wallet address")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("announces and disables an in-progress reconnect", () => {
    fixtures.wallet.rememberedWalletId = "freighter";
    fixtures.wallet.connecting = true;
    fixtures.wallet.reconnecting = true;
    render(<WalletButton />);

    expect(screen.getByRole("button", { name: "Reconnecting…" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows disconnect failures from the shared wallet state", async () => {
    fixtures.wallet.address = ADDRESS;
    fixtures.wallet.disconnect.mockImplementation(() => {
      fixtures.wallet.error = "Disconnect failed";
    });
    const { rerender } = render(<WalletButton />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    });
    rerender(<WalletButton />);

    expect(screen.getByRole("alert").textContent).toContain("Disconnect failed");
    expect(screen.getByTitle(ADDRESS)).toBeTruthy();
  });
});
