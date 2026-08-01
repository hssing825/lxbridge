// Songloft-LX 插件 — 脱敏诊断报告生成
// 报告只保留必要的计数、状态、耗时和通用失败原因；
// 不含密码、Token、Secret、Authorization、完整 URL、账号、设备 ID、内网地址、本机绝对路径与歌曲名。

import type { DiagnosticsOverview } from './types.ts';
import { redactText } from './redact.ts';
import type { ErrorCategory } from './error-summary.ts';

const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  auth_config: '认证/配置',
  platform_block: '平台限制',
  invalid_url: '无效地址',
  timeout: '超时',
  network: '网络',
  no_result: '无结果',
  unknown: '未知',
};

const SOURCE_LABELS: Record<string, string> = {
  'miot-voice': '音箱语音',
  'web-ui': '网页',
};

function levelLabel(level: string): string {
  if (level === 'ok') return '正常';
  if (level === 'warn') return '需关注';
  if (level === 'error') return '异常';
  return level;
}

export function formatReportTime(timestamp: number): string {
  if (!timestamp) return '--';
  const d = new Date(timestamp);
  const pad = function(n: number) { return n < 10 ? '0' + n : String(n); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

export function buildReportText(overview: DiagnosticsOverview): string {
  const lines: string[] = [];
  const separator = '----------------------------------------';

  lines.push('LX音乐桥 系统诊断报告');
  lines.push('生成时间: ' + formatReportTime(overview.generatedAt));
  lines.push('插件版本: v' + overview.version);
  lines.push(separator);

  // 1. 健康检查结果
  lines.push('1. 健康检查结果');
  for (const check of overview.health.checks) {
    lines.push('  [' + levelLabel(check.level) + '] ' + check.label + ': ' + redactText(check.detail));
  }
  lines.push('  整体状态: ' + levelLabel(overview.health.overall));
  lines.push('  lxserver: ' + (overview.lxserver.configured ? '已配置' : '未配置')
    + (overview.lxserver.connected === true ? '，连接正常' : overview.lxserver.connected === false ? '，连接异常' : ''));
  lines.push('  登录令牌: ' + (overview.lxserver.tokenValid ? '有效' : '无有效令牌'));
  lines.push('  MIoT: ' + (overview.miot.installed ? '已安装' : '未安装')
    + (overview.miot.configured ? '，已配置' : '，未配置')
    + '，设备 ' + overview.miot.deviceCount + ' 台（在线 ' + overview.miot.onlineDeviceCount + '）');
  lines.push('  自定义源: ' + overview.customSources.total + ' 个（启用 ' + overview.customSources.enabled + '）');

  // 2. 平台冷却概况
  lines.push(separator);
  lines.push('2. 平台冷却概况');
  lines.push('  全局冷却: ' + (overview.platformCooldowns.global
    ? '是（剩余 ' + overview.platformCooldowns.globalRemainingSeconds + ' 秒）'
    : '否'));
  if (overview.platformCooldowns.active.length === 0) {
    lines.push('  无活动冷却');
  } else {
    for (const cooldown of overview.platformCooldowns.active) {
      lines.push('  ' + cooldown.platform + ': 剩余 ' + cooldown.remainingSeconds + ' 秒');
    }
  }

  // 3. 最近降级 / 播放摘要
  lines.push(separator);
  lines.push('3. 最近降级 / 播放摘要');
  lines.push('  降级记录: ' + overview.recent.fallback.length + ' 条');
  for (const record of overview.recent.fallback.slice(0, 10)) {
    lines.push('    - ' + formatReportTime(record.time)
      + ' ' + (record.finalSource || '未知') + '/' + (record.finalQuality || '-')
      + (record.reason ? '（' + redactText(record.reason) + '）' : ''));
  }
  lines.push('  语音搜索: 共 ' + overview.recent.voice.total + ' 次，失败 ' + overview.recent.voice.failures + ' 次');
  lines.push('  播放追踪: 共 ' + overview.recent.playback.total + ' 次');
  for (const source of Object.keys(overview.recent.playback.bySource)) {
    lines.push('    - ' + (SOURCE_LABELS[source] || source) + ': ' + overview.recent.playback.bySource[source] + ' 次');
  }

  // 4. 错误分类
  lines.push(separator);
  lines.push('4. 错误分类');
  if (overview.errorSummary.total === 0) {
    lines.push('  无已记录的失败事件');
  } else {
    for (const entry of overview.errorSummary.byCategory) {
      lines.push('  ' + (CATEGORY_LABELS[entry.category as ErrorCategory] || entry.category) + ': ' + entry.count);
    }
    lines.push('  合计: ' + overview.errorSummary.total);
  }

  // 5. 缓存概况
  lines.push(separator);
  lines.push('5. 缓存概况');
  lines.push('  播放历史: ' + overview.cache.historyCount + ' 条');
  lines.push('  降级日志: ' + overview.cache.fallbackLogCount + ' 条');
  lines.push('  音质黑名单: ' + overview.cache.blacklistCount + ' 条');
  lines.push('  自定义源统计: ' + overview.cache.customSourceStatCount + ' 条');

  lines.push(separator);
  lines.push('本报告由 LX音乐桥 生成，仅用于故障排查。');

  return redactText(lines.join('\n'));
}
