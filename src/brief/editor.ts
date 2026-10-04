import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";

/** Both entry points install the same editor, so loading optional brief cannot undo Auto's guard. */
export const commandEditor: NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]> = (
  tui,
  theme,
  keybindings,
) =>
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
