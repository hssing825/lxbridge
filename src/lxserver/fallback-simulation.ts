export interface FallbackSimulationResult {
  success: boolean;
  attempts: number;
  elapsedMs: number;
  failureReason?: string;
  fallbackSteps: string[];
}

export function simulateFallbackV22(scenario: string): FallbackSimulationResult {
  const batches = [
    ['kg/320k', 'tx/320k'],
    ['wy/320k', 'mg/320k'],
    ['kw/320k', '另一正式版/320k'],
    ['高匹配候选/128k', 'custom新候选/128k'],
  ];
  const steps = ['模拟V22：预算10秒/8次；每批最多2个并行'];
  let attempts = 0;

  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    attempts += batch.length;
    steps.push('第' + (index + 1) + '批：并行解析 ' + batch.join(' + '));

    if (scenario === 'success_batch_3' && index === 2) {
      steps.push('✓ 模拟成功：kw/320k');
      return { success: true, attempts, elapsedMs: 0, fallbackSteps: steps };
    }
    if (scenario === 'platform_block' && index === 0) {
      steps.push('block ip：kg；模拟平台冷却15分钟');
      steps.push('✓ 模拟成功：tx/320k；其他平台不受影响');
      return { success: true, attempts, elapsedMs: 0, fallbackSteps: steps };
    }
    if (scenario === 'global_block' && index === 0) {
      steps.push('block ip：kg；模拟平台冷却15分钟');
      steps.push('block ip：tx；模拟平台冷却15分钟');
      steps.push('两个平台均只记录自身冷却，继续下一批');
      continue;
    }
    if (scenario === 'global_block' && index === 1) {
      steps.push('✓ 模拟成功：wy/320k；其他平台不受影响');
      return { success: true, attempts, elapsedMs: 0, fallbackSteps: steps };
    }
    steps.push('✗ 模拟失败：本批无可用URL');
  }

  return { success: false, attempts, elapsedMs: 0, failureReason: '模拟8次URL解析预算耗尽', fallbackSteps: steps };
}
