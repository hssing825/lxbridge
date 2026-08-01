// Songloft-LX 插件 — 诊断脱敏工具
// 供诊断报告使用：移除密码、Token、Secret、URL、内网地址与绝对路径等敏感内容。

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;
const IPV4_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6_PATTERN = /(?:\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b|\b(?:[a-f0-9]{1,4}:){1,7}:|::(?:[a-f0-9]{1,4}:){0,6}[a-f0-9]{1,4}\b)/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HOST_PATTERN = /\b(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+(?:[a-z]{2,63}|local|lan|home|internal))(?::\d{1,5})?\b/gi;
const PATH_PATTERN = /(?:[A-Za-z]:\\[^"'<>|,;\r\n]*|\/(?:Users|home|tmp|var|etc|opt|root|usr)\/[^"'<>|,;\r\n]*)/gi;
const SECRET_KEY_PATTERN =
  /(password|passwd|pwd|token|secret|authorization|credential|api[_-]?key|access[_-]?key|username|user|account(?:_id)?)\s*[=:]\s*["']?[^\s,;)"']\S*(?:\s+\S+)*/gi;
const BEARER_PATTERN = /\b(?:authorization\s+)?bearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

export function redactText(input: unknown): string {
  if (input === undefined || input === null) return '';
  let out = String(input);

  out = out.replace(SECRET_KEY_PATTERN, function(match) {
    const eq = match.indexOf('=');
    const colon = match.indexOf(':');
    let separator = -1;
    if (eq !== -1 && colon !== -1) separator = Math.min(eq, colon);
    else if (eq !== -1) separator = eq;
    else if (colon !== -1) separator = colon;
    if (separator === -1) return '[redacted]';
    return match.substring(0, separator + 1) + '[redacted]';
  });

  out = out.replace(BEARER_PATTERN, '[redacted]');
  out = out.replace(URL_PATTERN, '[url]');
  out = out.replace(EMAIL_PATTERN, '[account]');
  out = out.replace(IPV4_PATTERN, '[ip]');
  out = out.replace(IPV6_PATTERN, '[ip]');
  out = out.replace(HOST_PATTERN, '[host]');
  out = out.replace(PATH_PATTERN, '[path]');
  return out;
}

export function isRedacted(value: unknown): boolean {
  return redactText(value).indexOf('[url]') === -1
    && redactText(value).indexOf('[ip]') === -1
    && redactText(value).indexOf('[path]') === -1
    && redactText(value).indexOf('[redacted]') === -1;
}
