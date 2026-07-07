/**
 * Copy text to clipboard with a robust fallback.
 *
 * The Clipboard API (`navigator.clipboard.writeText`) is often blocked in
 * cross-origin iframes (preview environments) by the Permissions Policy
 * (`clipboard-write`), and also requires a secure context + user gesture.
 * When it throws or is unavailable, we fall back to a hidden <textarea>
 * + `document.execCommand("copy")` which works inside iframes as long as
 * the call happens during a user gesture (click/keydown handler).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") return false;

  // 1) Try the async Clipboard API when it looks usable.
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function" &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }

  // 2) Legacy fallback — works inside iframes without clipboard-write policy.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.padding = "0";
    ta.style.border = "none";
    ta.style.outline = "none";
    ta.style.boxShadow = "none";
    ta.style.background = "transparent";
    ta.style.opacity = "0";
    document.body.appendChild(ta);

    const selection = document.getSelection();
    const prevRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);

    const ok = document.execCommand("copy");
    document.body.removeChild(ta);

    if (prevRange && selection) {
      selection.removeAllRanges();
      selection.addRange(prevRange);
    }

    return ok;
  } catch {
    return false;
  }
}
