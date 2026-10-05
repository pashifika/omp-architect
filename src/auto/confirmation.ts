import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";

type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomArguments = Parameters<CustomFactory>;
type ConfirmationFactory = (
  tui: CustomArguments[0],
  theme: CustomArguments[1],
  keybindings: CustomArguments[2],
  done: (result: boolean) => void,
) => ReturnType<CustomFactory>;
type Host = Pick<ExtensionAPI["pi"], "Text">;

export const autoConfirmationTitle = "Start bounded Rasen Auto?";

export function autoConfirmationMessage(change: string, guidance: string): string {
  return `Resume apply, verification and review of change ${change} using the installed Rasen Auto workflow, native OMP LEAD/leaf model roles and normal approvals? At stage boundaries, bounded task/stage/tool evidence will be sent to TypeSafe Jev for step selection, with optional architect-role fallback. Additional instructions and the rendered brief will be retained in the main run and architect review evidence. Do not include secrets or unauthorized data. No publishing, merging, or expanded permissions are granted.${guidance ? `\n\nAdditional guidance (frozen for this run):\n${guidance}` : ""}`;
}

/**
 * Keep the disclosure/guidance out of the native selector's title/subtitle path.
 * Text wraps the complete literal body first, preserving its paragraph breaks;
 * only then do we add one border to every physical row. Do not normalize the
 * source text, render its Markdown, or feed these display rows back into Auto.
 */
export function createAutoConfirmation({ Text }: Host, message: string): ConfirmationFactory {
  return (tui, theme, keybindings, done) => {
    const title = new Text(theme.bold(autoConfirmationTitle), 0, 0);
    const body = new Text(message, 0, 0);
    const choices = new Text("", 0, 0);
    const hint = (action: Parameters<typeof keybindings.getKeys>[0]) =>
      keybindings.getKeys(action).join("/");
    const help = new Text(
      `${hint("tui.select.up")}/${hint("tui.select.down")} choose; ${hint("tui.select.confirm")} confirm; ${hint("tui.select.cancel")} cancel; ${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} scroll`,
      0,
      0,
    );
    let approved = true;
    let closed = false;
    let offset = 0;
    let pageSize = 1;
    let lastOffset = 0;
    const finish = (result: boolean) => {
      if (closed) return;
      closed = true;
      done(result);
    };
    // Render-only is intentional: OMP's native backend carries this as a `rows`
    // node instead of reinterpreting the multiline body as a picker subtitle.
    return {
      render(width) {
        const columns = Math.max(0, Math.floor(width));
        const framed = columns >= 5;
        const inner = Math.max(1, columns - (framed ? 4 : 0));
        choices.setText(approved ? "> Yes\n  No" : "  Yes\n> No");
        const heading = title.render(inner);
        const controls = [...choices.render(inner), ...help.render(inner)];
        const lines = body.render(inner);
        // Reserve the title, choices, help, borders and scroll-position row.
        pageSize = Math.max(1, tui.terminal.rows - heading.length - controls.length - 5);
        lastOffset = Math.max(0, lines.length - pageSize);
        offset = Math.min(offset, lastOffset);
        const position = new Text(
          lastOffset > 0
            ? `[${offset + 1}-${Math.min(lines.length, offset + pageSize)} / ${lines.length}]`
            : "",
          0,
          0,
        );
        const rows = [
          ...heading,
          ...lines.slice(offset, offset + pageSize),
          ...position.render(inner),
          ...controls,
        ];
        if (!framed) return rows;
        const box = theme.boxRound;
        const border = (text: string) => theme.fg("border", text);
        return [
          border(box.topLeft + box.horizontal.repeat(columns - 2) + box.topRight),
          ...rows.map((line) => `${border(box.vertical)} ${line} ${border(box.vertical)}`),
          border(box.bottomLeft + box.horizontal.repeat(columns - 2) + box.bottomRight),
        ];
      },
      handleInput(data) {
        if (closed) return;
        if (keybindings.matches(data, "tui.select.cancel")) finish(false);
        else if (keybindings.matches(data, "tui.select.confirm")) finish(approved);
        else if (keybindings.matches(data, "tui.select.up")) approved = true;
        else if (keybindings.matches(data, "tui.select.down")) approved = false;
        else if (keybindings.matches(data, "tui.select.pageUp"))
          offset = Math.max(0, offset - pageSize);
        else if (keybindings.matches(data, "tui.select.pageDown"))
          offset = Math.min(lastOffset, offset + pageSize);
        else return;
        if (!closed) tui.requestRender();
      },
      invalidate() {
        for (const text of [title, body, choices, help]) text.invalidate();
      },
      dispose() {
        closed = true;
      },
    };
  };
}

export async function confirmAutoStart(
  host: Host,
  ui: Pick<ExtensionUIContext, "custom">,
  change: string,
  guidance: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  try {
    const result = await ui.custom<boolean>(
      createAutoConfirmation(host, autoConfirmationMessage(change, guidance)),
      { signal },
    );
    return result === true && !signal.aborted;
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return false;
    throw error;
  }
}
