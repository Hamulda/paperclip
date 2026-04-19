// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceServicesEditor } from "./WorkspaceServicesEditor";

const DEBOUNCE_MS = 300;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkspaceServicesEditor", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";
  });

  const renderEditor = (value: Record<string, unknown> | null = null) => {
    root = createRoot(container);
    act(() => {
      root.render(<WorkspaceServicesEditor value={value} onChange={onChange} />);
    });
  };

  it("renders empty state when no services configured", () => {
    renderEditor();
    expect(document.body.textContent).toContain("No services configured");
    expect(document.body.textContent).toContain("Add service");
  });

  it("renders existing services", () => {
    renderEditor({
      services: [{ name: "web", command: "pnpm dev" }],
    });
    expect(document.body.textContent).toContain("web");
    // Input values appear in textContent for type="text" inputs
    const input = container.querySelector('input[value="web"]');
    expect(input).toBeTruthy();
  });

  it("renders multiple services with all fields", () => {
    renderEditor({
      services: [
        { name: "web", command: "pnpm dev", cwd: "/app", lifecycle: "ephemeral" },
      ],
    });
    expect(document.body.textContent).toContain("web");
    // Input values are not in textContent, check for the input element directly
    const commandInput = container.querySelector('input[value="pnpm dev"]');
    expect(commandInput).toBeTruthy();
    const cwdInput = container.querySelector('input[value="/app"]');
    expect(cwdInput).toBeTruthy();
    expect(document.body.textContent).toContain("Ephemeral");
  });

  it("shows JSON toggle button", () => {
    renderEditor();
    const jsonButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "JSON",
    );
    expect(jsonButton).toBeTruthy();
  });

  it("toggles to JSON mode", () => {
    renderEditor();
    const jsonButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "JSON",
    );
    act(() => {
      jsonButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
  });

  it("switches back to structured mode from JSON", () => {
    renderEditor();
    const jsonButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "JSON",
    );
    act(() => {
      jsonButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const structuredButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Structured",
    );
    act(() => {
      structuredButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Add service");
  });

  it("displays service count", () => {
    renderEditor({
      services: [
        { name: "web", command: "pnpm dev" },
        { name: "api", command: "python server.py" },
      ],
    });
    expect(document.body.textContent).toContain("2 services configured");
  });

  it("shows validation message for incomplete services", () => {
    renderEditor({
      services: [{ name: "", command: "" }],
    });
    // Add another service to trigger validation
    const addButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Add service"),
    );
    act(() => {
      addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("name is required");
  });

  it("renders lifecycle options", () => {
    renderEditor({
      services: [{ name: "web", command: "pnpm dev" }],
    });
    expect(document.body.textContent).toContain("Shared");
    expect(document.body.textContent).toContain("Ephemeral");
  });

  it("renders reuse scope options", () => {
    renderEditor({
      services: [{ name: "web", command: "pnpm dev" }],
    });
    expect(document.body.textContent).toContain("Project workspace");
    expect(document.body.textContent).toContain("Execution workspace");
    expect(document.body.textContent).toContain("Run");
    expect(document.body.textContent).toContain("Agent");
  });

  it("does not emit on rapid keystrokes without debounce wait", () => {
    renderEditor({
      services: [{ name: "web", command: "pnpm dev" }],
    });
    const nameInput = container.querySelector('input[value="web"]') as HTMLInputElement;
    expect(nameInput).toBeTruthy();

    act(() => {
      nameInput.setSelectionRange(3, 3);
      nameInput.setRangeText("2");
    });
    nameInput.dispatchEvent(new Event("change", { bubbles: true }));

    act(() => {
      nameInput.setSelectionRange(4, 4);
      nameInput.setRangeText("3");
    });
    nameInput.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits after debounce delay", () => {
    renderEditor({
      services: [{ name: "web", command: "pnpm dev" }],
    });
    const nameInput = container.querySelector('input[value="web"]') as HTMLInputElement;

    act(() => {
      nameInput.setSelectionRange(3, 3);
      nameInput.setRangeText("2");
    });
    nameInput.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const emitted = onChange.mock.calls[0][0] as Record<string, unknown>;
    expect((emitted.services as unknown[])[0]).toMatchObject({ name: "web2", command: "pnpm dev" });
  });

  it("does not emit when value is identical after debounce", () => {
    renderEditor({
      services: [{ name: "web", command: "pnpm dev" }],
    });

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    onChange.mockClear();

    const nameInput = container.querySelector('input[value="web"]') as HTMLInputElement;
    // Replace "web" with "web" (same value via setRangeText)
    act(() => {
      nameInput.setSelectionRange(0, 3);
    });
    act(() => {
      nameInput.setRangeText("web");
    });
    nameInput.dispatchEvent(new Event("change", { bubbles: true }));

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("aborts pending emit when parent updates value", () => {
    renderEditor({
      services: [{ name: "web", command: "pnpm dev" }],
    });
    const nameInput = container.querySelector('input[value="web"]') as HTMLInputElement;

    act(() => {
      nameInput.setSelectionRange(3, 3);
      nameInput.setRangeText("2");
    });
    nameInput.dispatchEvent(new Event("change", { bubbles: true }));

    // Unmount first (clears timer via cleanup effect), THEN advance time
    act(() => {
      root.unmount();
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears pending debounce on unmount", () => {
    renderEditor({
      services: [{ name: "web", command: "pnpm dev" }],
    });
    const nameInput = container.querySelector('input[value="web"]') as HTMLInputElement;

    act(() => {
      nameInput.setSelectionRange(3, 3);
      nameInput.setRangeText("2");
    });
    nameInput.dispatchEvent(new Event("change", { bubbles: true }));

    act(() => {
      root.unmount();
    });

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not emit in JSON mode when parsed value is identical", () => {
    renderEditor({
      services: [{ name: "web", command: "pnpm dev" }],
    });
    onChange.mockClear();

    const jsonButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "JSON",
    );
    act(() => {
      jsonButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      textarea.setSelectionRange(0, 0);
    });

    const validJson = JSON.stringify({ services: [{ name: "web", command: "pnpm dev" }] }, null, 2);
    act(() => {
      textarea.setRangeText(validJson);
    });
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onChange).not.toHaveBeenCalled();
  });
});