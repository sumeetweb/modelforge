import { createHash, randomUUID } from "node:crypto";
import { Config, Endpoint } from "./config";

export function chooseEndpoint(
  config: Config,
  key: string = randomUUID(),
): Endpoint {
  const bucket =
    (createHash("sha256").update(key).digest().readUInt32BE(0) / 2 ** 32) * 100;
  return bucket < config.canaryPercent
    ? config.endpoints[1]
    : config.endpoints[0];
}

// One half-open probe at a time; in-flight failures cannot extend an open circuit forever.
export class CircuitBreaker {
  failures = 0;
  openedAt: number | undefined;
  probing = false;
  constructor(
    private threshold: number,
    private cooldown: number,
    private now = Date.now,
  ) {}
  acquire(): boolean {
    if (this.openedAt === undefined) return true;
    if (this.now() - this.openedAt < this.cooldown || this.probing)
      return false;
    this.probing = true;
    return true;
  }
  success() {
    this.failures = 0;
    this.openedAt = undefined;
    this.probing = false;
  }
  failure() {
    this.failures++;
    if (
      this.probing ||
      (this.failures >= this.threshold && this.openedAt === undefined)
    )
      this.openedAt = this.now();
    this.probing = false;
  }
  get state() {
    return this.openedAt === undefined
      ? "closed"
      : this.probing
        ? "half_open"
        : "open";
  }
}
