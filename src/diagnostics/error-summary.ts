// Songloft-LX 插件 — 诊断报告错误分类汇总
// 只读的保守分类，仅用于诊断报告计数，不改变任何失败处理流程。
// 与降级流程共用 FailureClassifier，避免诊断计数和实际处理规则漂移。

import { FailureClassifier } from '../lxserver/failure-classification.ts';

export type ErrorCategory =
  | 'auth_config'
  | 'platform_block'
  | 'invalid_url'
  | 'timeout'
  | 'network'
  | 'no_result'
  | 'unknown';

export const ERROR_CATEGORY_ORDER: ErrorCategory[] = [
  'auth_config',
  'platform_block',
  'invalid_url',
  'timeout',
  'network',
  'no_result',
  'unknown',
];

const ERROR_CATEGORY_LABELS: Record<ErrorCategory, string> = {
  auth_config: '认证或配置错误',
  platform_block: '访问受限',
  invalid_url: '无效地址',
  timeout: '请求超时',
  network: '网络异常',
  no_result: '无可用结果',
  unknown: '未知失败',
};

export function getErrorCategoryLabel(category: ErrorCategory): string {
  return ERROR_CATEGORY_LABELS[category];
}

export function classifyFailureMessage(message: unknown): ErrorCategory {
  const text = String(message === undefined || message === null ? '' : message).trim();
  if (!text) return 'unknown';
  if (/^(?:(?:LXServer\s*)?登录失败|Token验证失败)/i.test(text)) return 'auth_config';
  return FailureClassifier.classify(text).category as ErrorCategory;
}

export interface ErrorSummary {
  total: number;
  byCategory: Array<{ category: ErrorCategory; count: number }>;
}

export function summarizeFailures(messages: Array<unknown>): ErrorSummary {
  const counts: Partial<Record<ErrorCategory, number>> = {};
  let total = 0;
  for (const message of messages) {
    const text = String(message === undefined || message === null ? '' : message).trim();
    if (!text) continue;
    const category = classifyFailureMessage(text);
    counts[category] = (counts[category] || 0) + 1;
    total += 1;
  }
  const byCategory: Array<{ category: ErrorCategory; count: number }> = [];
  for (const category of ERROR_CATEGORY_ORDER) {
    const count = counts[category] || 0;
    if (count > 0) byCategory.push({ category, count });
  }
  return { total, byCategory };
}
