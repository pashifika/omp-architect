import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";

type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

/** Both entry points install the same editor, so loading optional brief cannot undo Auto's guard. */
export function createCommandEditor(
  CustomEditor: ExtensionAPI["pi"]["CustomEditor"],
): EditorFactory {
  // Use the running host's constructor. Importing the TUI subpath falls back to
  // source SDK files in bundled OMP and can require an unavailable native addon.
  return (tui, theme, keybindings) =>
    new (class extends CustomEditor {
      override handleInput(data: string): void {
        if (/^\s*\/(?:auto|brief)\s/.test(this.getText())) {
          if (data === " ") {
            this.insertText(data);
            return;
          }
          // Explicit Tab accepts a choice. Submit never inserts an unchosen option/block,
          // including when the completion popup is stale or the host uses Kitty Enter.
          if (
            (data === "\n" || keybindings.matches(data, "tui.input.submit")) &&
            this.isShowingAutocomplete()
          )
            super.handleInput("\x1b");
        }
        super.handleInput(data);
      }
    })(tui, theme, keybindings);
}
