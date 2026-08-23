import { existsSync } from "node:fs";
import { basename } from "node:path";

export interface PiInvocation {
  command: string;
  args: string[];
}

export interface PiInvocationInputs {
  currentScript?: string;
  executablePath?: string;
  fileExists?: (path: string) => boolean;
}

/** Resolve the exact Pi executable/runtime that launched this process. */
export function resolvePiInvocation(inputs: PiInvocationInputs = {}): PiInvocation {
  const currentScript = inputs.currentScript ?? process.argv[1];
  const executablePath = inputs.executablePath ?? process.execPath;
  const fileExists = inputs.fileExists ?? existsSync;
  const bunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !bunVirtual && fileExists(currentScript)) {
    return { command: executablePath, args: [currentScript] };
  }
  const executable = basename(executablePath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: executablePath, args: [] };
  return { command: "pi", args: [] };
}
