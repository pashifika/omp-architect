import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";

/** SDK agentDir scopes session storage, not the process-global host path resolver. */
export function withAgentDir(factory: ExtensionFactory, agentDir: string): ExtensionFactory {
  return (pi) => {
    const host = Object.create(pi) as typeof pi;
    Object.defineProperty(host, "pi", {
      value: { ...pi.pi, getAgentDir: () => agentDir },
    });
    return factory(host);
  };
}
