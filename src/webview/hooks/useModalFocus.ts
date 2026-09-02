import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface ModalFocusOptions {
  /** Whether the dialog is currently mounted and open. */
  open: boolean;
  /** Called on Escape and on a Tab that would leave the dialog is prevented. */
  onClose: () => void;
}

/**
 * Focus management for a modal dialog: move focus in, keep Tab inside, and put
 * it back where it was on close.
 *
 * Without this, Tab walks straight out of an "open" dialog into the dashboard
 * behind it — the dialog is visually modal but not modal to the keyboard — and
 * closing it drops focus onto `<body>`, so the next Tab restarts from the top
 * of the panel instead of the control that opened the dialog.
 *
 * Returns the ref to attach to the dialog element.
 */
export function useModalFocus<T extends HTMLElement>({ open, onClose }: ModalFocusOptions) {
  const dialogRef = useRef<T>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Held in a ref so the effect does not depend on the callback's identity.
  // Callers rebuild `onClose` whenever something like `saving` changes, which
  // tore the trap down and rebuilt it — moving focus — mid-dialog.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) { return; }

    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const dialog = dialogRef.current;
    focusFirst(dialog);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") { return; }

      const node = dialogRef.current;
      if (!node) { return; }
      const focusable = focusableWithin(node);
      if (focusable.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (!node.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const restoreTo = restoreFocusRef.current;
      restoreFocusRef.current = null;
      // Deferred: React runs cleanup before it commits the removal, so
      // focusing here would land while the dialog is still in the document and
      // the trap could immediately pull focus back inside.
      queueMicrotask(() => {
        if (restoreTo?.isConnected) { restoreTo.focus(); }
      });
    };
  }, [open]);

  return dialogRef;
}

function focusableWithin(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.offsetParent !== null || element === document.activeElement);
}

function focusFirst(node: HTMLElement | null): void {
  if (!node) { return; }
  const focusable = focusableWithin(node);
  (focusable[0] ?? node).focus();
}
