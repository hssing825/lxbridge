interface FallbackBatchSong {
  source: string;
  id: string;
}

export interface FallbackBatchItem<TSong extends FallbackBatchSong = FallbackBatchSong> {
  song: TSong;
  quality: string;
}

interface SelectRunnableFallbackBatchOptions<TSong extends FallbackBatchSong> {
  batch: Array<FallbackBatchItem<TSong>>;
  maxConcurrent: number;
  usedCandidates: Set<string>;
  blockedPlatforms: Set<string>;
  getCooldownRemaining: (source: string) => Promise<number>;
}

export async function selectRunnableFallbackBatch<TSong extends FallbackBatchSong>(
  options: SelectRunnableFallbackBatchOptions<TSong>
): Promise<{
  runnable: Array<FallbackBatchItem<TSong>>;
  skippedCooldowns: Array<{ source: string; remainingMs: number }>;
}> {
  const runnable: Array<FallbackBatchItem<TSong>> = [];
  const skippedCooldowns: Array<{ source: string; remainingMs: number }> = [];

  for (let index = 0; index < options.batch.length && runnable.length < options.maxConcurrent; index++) {
    const item = options.batch[index];
    const key = item.song.source + ':' + item.song.id + ':' + item.quality;
    if (options.usedCandidates.has(key) || options.blockedPlatforms.has(item.song.source)) continue;

    const remainingMs = await options.getCooldownRemaining(item.song.source);
    if (remainingMs > 0) {
      options.blockedPlatforms.add(item.song.source);
      skippedCooldowns.push({ source: item.song.source, remainingMs });
      continue;
    }

    options.usedCandidates.add(key);
    runnable.push(item);
  }

  return { runnable, skippedCooldowns };
}
