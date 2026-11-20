/**
 * pi-hc-subagents — delegate tasks to interactive pi subagents in herdr-core terminals.
 *
 * `index.ts` is wiring only. Business logic lives in `src/`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function hcSubagentsExtension(_pi: ExtensionAPI): void {
  // Tools, commands, and lifecycle hooks are registered by later phases once
  // prerequisites have been established. Loading the extension must always be
  // side-effect free and safe outside an hc terminal.
}
