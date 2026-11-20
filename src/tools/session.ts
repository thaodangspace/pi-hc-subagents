/**
 * Active tool session: the runtime plus run-scoped services.
 */
import type { Scheduler } from "../runtime/scheduler.ts";
import type { Registry } from "../runtime/registry.ts";
import type { ExtensionRuntime } from "../runtime/runtime.ts";

export interface ToolSession {
  runtime: ExtensionRuntime;
  registry: Registry;
  scheduler: Scheduler;
}
