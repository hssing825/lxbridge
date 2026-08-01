import type { FailureClassification, FailureHint } from './types';

const PLATFORM_BLOCK_PATTERNS = [
  /\bblock(?:ed)?[\s_-]*ip\b/i,
  /\bip[\s_-]*(?:is|was)[\s_-]*blocked\b/i,
  /\bip[\s_-]*blocked\b/i,
  /ip\s*(?:被封|封禁|限制)/i,
  /(?:封禁|限制)\s*ip/i,
];

const AUTH_PATTERNS = [
  /\binvalid[\s_-]*token\b/i,
  /\btoken[\s_-]*(?:expired|invalid)\b/i,
  /\b(?:authentication|login)[\s_-]*required\b/i,
  /\bnot[\s_-]*logged[\s_-]*in\b/i,
  /token.*(?:无效|过期)/i,
  /认证.*(?:失败|无效|过期)/i,
  /用户.*未登录/i,
];

const CONFIG_PATTERNS = [
  /lxserver\s*地址未配置/i,
  /\bmissing[\s_-]*(?:host|username|password)\b/i,
  /\b(?:host|username|password)[\s_-]*(?:is[\s_-]*)?required\b/i,
  /(?:地址|用户名|密码).*(?:未配置|缺失|必填)/i,
];

const INVALID_URL_PATTERNS = [
  /\babnormal[\s_-]*url\b/i,
  /\binvalid[\s_-]*url\b/i,
  /\bno[\s_-]*url[\s_-]*(?:in[\s_-]*response|returned)\b/i,
  /\burl[\s_-]*missing\b/i,
  /无效.*url/i,
  /未返回.*url/i,
];

const TIMEOUT_PATTERNS = [
  /\btimeout\b/i,
  /\btimed[\s_-]*out\b/i,
  /超时/i,
];

const NETWORK_PATTERNS = [
  /\bfetch[\s_-]*failed\b/i,
  /\bnetwork[\s_-]*error\b/i,
  /\bconnection[\s_-]*(?:refused|reset|failed)\b/i,
  /\bsocket[\s_-]*hang[\s_-]*up\b/i,
  /\bdns[\s_-]*(?:error|failed|failure)\b/i,
  /\bgetaddrinfo\b/i,
  /\benotfound\b/i,
  /\beai_again\b/i,
  /DNS.*(?:解析|错误|失败|超时)/i,
  /域名解析/i,
  /网络错误/i,
  /连接失败/i,
];

const NO_RESULT_PATTERNS = [
  /\bno[\s_-]*(?:result|candidate|match|song)s?\b/i,
  /\bempty[\s_-]*(?:result|response)\b/i,
  /无结果/i,
  /无候选/i,
  /未找到.*(?:歌曲|结果|候选)/i,
  /候选均不可用/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(function(pattern) { return pattern.test(text); });
}

function result(
  category: FailureClassification['category'],
  confidence: number,
  action: FailureClassification['action'],
  failureReason: string,
  httpStatus: number,
): FailureClassification {
  return {
    category,
    confidence,
    action,
    failureReason,
    httpStatus: httpStatus || undefined,
    isHighConfidence: confidence >= 90,
    shouldStop: action === 'stop',
  };
}

export class FailureClassifier {
  static classify(
    failureText: string = '',
    httpStatus: number = 0,
    hint?: FailureHint,
  ): FailureClassification {
    const text = String(failureText || '').trim();

    if (matchesAny(text, PLATFORM_BLOCK_PATTERNS)) {
      return result('platform_block', 100, 'cooldown', '明确的平台访问限制', httpStatus);
    }

    if (
      httpStatus === 401
      || matchesAny(text, CONFIG_PATTERNS)
      || matchesAny(text, AUTH_PATTERNS)
    ) {
      return result('auth_config', 100, 'stop', '认证或必要配置错误', httpStatus);
    }

    if (hint === 'invalid_url' || matchesAny(text, INVALID_URL_PATTERNS)) {
      return result('invalid_url', 100, 'skip', '返回了无效音频地址', httpStatus);
    }

    if (httpStatus === 408 || httpStatus === 504 || matchesAny(text, TIMEOUT_PATTERNS)) {
      return result('timeout', 80, 'record', '请求超时', httpStatus);
    }

    if (httpStatus === 502 || httpStatus === 503 || matchesAny(text, NETWORK_PATTERNS)) {
      return result('network', 70, 'record', '网络或服务暂时不可达', httpStatus);
    }

    if (matchesAny(text, NO_RESULT_PATTERNS)) {
      return result('no_result', 80, 'record', '没有可用结果', httpStatus);
    }

    return result('unknown', 0, 'record', '未知失败', httpStatus);
  }

  static buildSafeClassificationResult(classification: FailureClassification): FailureClassification {
    return {
      category: classification.category,
      confidence: classification.confidence,
      action: classification.action,
      failureReason: classification.failureReason,
      httpStatus: classification.httpStatus,
      isHighConfidence: classification.isHighConfidence,
      shouldStop: classification.shouldStop,
    };
  }
}
