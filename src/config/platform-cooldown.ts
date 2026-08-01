export interface PlatformCooldownEntry {
  blockedAt: number;
  expiresAt: number;
}

export type PlatformCooldowns = Record<string, PlatformCooldownEntry>;

export function normalizePlatformCooldowns(
  input: PlatformCooldowns,
  now: number = Date.now()
): { cooldowns: PlatformCooldowns; changed: boolean } {
  const cooldowns: PlatformCooldowns = { ...input };
  let changed = false;

  for (const source of Object.keys(cooldowns)) {
    const entry = cooldowns[source];
    if (
      source === '__global__' ||
      !entry ||
      typeof entry.blockedAt !== 'number' ||
      typeof entry.expiresAt !== 'number' ||
      entry.expiresAt <= now
    ) {
      delete cooldowns[source];
      changed = true;
    }
  }

  return { cooldowns, changed };
}

export function recordSourceCooldown(
  input: PlatformCooldowns,
  source: string,
  now: number,
  cooldownMs: number
): PlatformCooldowns {
  const normalized = normalizePlatformCooldowns(input, now).cooldowns;
  normalized[source] = { blockedAt: now, expiresAt: now + cooldownMs };
  return normalized;
}
