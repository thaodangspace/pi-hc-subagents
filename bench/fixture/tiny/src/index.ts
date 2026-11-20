import { loadConfig, validateConfig, type Config } from "./config.ts";
import { request } from "./http.ts";
import { runJob } from "./jobs.ts";

export interface App {
  config: Config;
  ping(url: string): Promise<number>;
  run(name: string, work: () => Promise<string>): Promise<string>;
}

export function createApp(config: Config = loadConfig()): App {
  validateConfig(config);
  return {
    config,
    ping: async (url) => (await request(url, config)).status,
    run: async (name, work) => (await runJob(name, work, config)).value,
  };
}

export { loadConfig, request, runJob };
export type { Config };
