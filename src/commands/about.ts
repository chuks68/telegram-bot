import { escapeMd } from "../notifications/format.js";
import { networkLabel, type BotConfig } from "../config.js";

const REPOSITORY_URL = "https://github.com/example/stellar-bot";

export function aboutMessage(config: BotConfig, version: string): string {
  const network = networkLabel(config);
  return [
    `*Stellar Bot*`,
    ``,
    `Version: ${escapeMd(version)}`,
    `Network: ${escapeMd(network)}`,
    `Repository: ${escapeMd(REPOSITORY_URL)}`,
  ].join("\n");
}
