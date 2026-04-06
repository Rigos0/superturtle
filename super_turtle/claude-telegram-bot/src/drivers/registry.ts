import { CodexDriver } from "./codex-driver";
import type { ChatDriver, DriverId } from "./types";

const codexDriver = new CodexDriver();

export function getDriver(_driverId?: DriverId): ChatDriver {
  return codexDriver;
}

export function getCurrentDriver(): ChatDriver {
  return codexDriver;
}
