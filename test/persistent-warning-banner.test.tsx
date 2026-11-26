// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  PersistentWarningBanner,
  warningDismissalKey,
} from "@/components/PersistentWarningBanner";

describe("PersistentWarningBanner", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the unaudited testnet warning and persists dismissal", async () => {
    const { unmount } = render(<PersistentWarningBanner networkId="testnet" />);
    const banner = screen.getByRole("status");

    expect(banner.textContent).toContain("Testnet software");
    expect(banner.textContent).toContain("unaudited");
    expect(banner.className).toContain("bg-warn/10");
    expect(screen.getByRole("button", {
      name: "Dismiss testnet and unaudited software warning",
    })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", {
      name: "Dismiss testnet and unaudited software warning",
    }));

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(localStorage.getItem(warningDismissalKey("testnet"))).toBe("true");

    unmount();
    render(<PersistentWarningBanner networkId="testnet" />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("uses a separate unaudited warning and dismissal for another network", () => {
    localStorage.setItem(warningDismissalKey("testnet"), "true");
    render(<PersistentWarningBanner networkId="mainnet" />);

    expect(screen.getByRole("status").textContent).toContain("Unaudited software");
    expect(screen.getByRole("status").textContent).not.toContain("Testnet software");
    expect(warningDismissalKey("mainnet")).not.toBe(warningDismissalKey("testnet"));
  });

  it("remains visible and can be dismissed for this visit when storage fails", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    render(<PersistentWarningBanner networkId="testnet" />);

    expect(screen.getByRole("status")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {
      name: "Dismiss testnet and unaudited software warning",
    }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
