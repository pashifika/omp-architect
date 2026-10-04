import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createCommandEditor } from "./editor.ts";
import brief from "./runtime.ts";

/** The standalone runtime is opt-in; the main extension never imports this entry. */
export default function briefExtension(pi: ExtensionAPI): void {
  type Host = Parameters<typeof brief>[0];
  let cwd = process.cwd();
  brief({
    get cwd() {
      return cwd;
    },
    pi: {
      getAgentDir: pi.pi.getAgentDir,
    },
    registerCommand: (name, command) =>
      pi.registerCommand(name, {
        ...command,
        handler: async (args, ctx) => {
          cwd = ctx.cwd;
          await command.handler(args, ctx);
        },
      }),
    on: (_event, handler) =>
      pi.on("session_start", (event, ctx) => {
        cwd = ctx.cwd;
        ctx.ui.setEditorComponent(createCommandEditor(pi.pi.CustomEditor));
        // The compatibility surface retains the supplied editor's behavior.
        handler(event, ctx as unknown as Parameters<Parameters<Host["on"]>[1]>[1]);
      }),
    sendUserMessage: (content) => pi.sendUserMessage(content),
  });
}
