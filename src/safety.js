/** 本地显示边界：仅返回固定错误、公开文字和显式遮蔽，不解除上游敏感审查。 */
const ERROR_MESSAGES = Object.freeze({
  PROJECT_UNAVAILABLE: '项目目录不可读取或不符合本地安全边界。',
  UNSAFE_PATH: '读取路径不符合本地普通文件边界。',
  DATABASE_UNAVAILABLE: '项目数据库暂时不可读取。',
  DATABASE_TOO_LARGE: '项目数据库和日志超过64 MiB读取上限。',
  CAPTURE_CONFLICT: '数据库正在变化，本轮未取得稳定快照，请稍后重试。',
  ROLLBACK_JOURNAL: '数据库写入尚未结束，请稍后重试。',
  UNSUPPORTED_SCHEMA: '数据库版本或关键结构不受当前看板支持。',
  INVALID_DATABASE: '无法读取有效的 AWR 数据库副本。',
  INCOMPATIBLE_PROJECTION: '项目投影存在不兼容或不一致的必需字段。',
  UNSAFE_IDENTIFIER: '项目投影包含无法安全显示的结构标识。',
  NODE_LIMIT: '项目超过1000个真实工作项，不能提供完整依赖图。',
  SNAPSHOT_UNAVAILABLE: '本轮无法取得项目快照。',
});

/** 创建可公开返回的错误；已知读取错误使用固定说明，绝不拼接原始异常。 */
export class DashboardError extends Error {
  constructor(code, message = '', retryable = false) {
    const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) && !hasSensitiveContent(code)
      ? code : 'SNAPSHOT_UNAVAILABLE';
    super(ERROR_MESSAGES[safeCode] ?? sanitizeText(message || '请求无法完成。'));
    this.name = 'DashboardError';
    this.code = safeCode;
    this.retryable = retryable === true;
  }
}

const LABEL = '(?:[a-z][a-z0-9_]*[_-])?(?:api[\\s_-]*key|access[\\s_-]*token|refresh[\\s_-]*token|id[\\s_-]*token|client[\\s_-]*secret|password|passwd|pwd|secret|token|authorization|private[\\s_-]*prompt|private[\\s_-]*key|credential|密码|密碼|口令|令牌|密钥|密鑰|私有提示词|私有提示詞)';
const ASSIGNMENT = new RegExp(`(?:^|[^\\p{L}\\p{N}_])(${LABEL})[\\s"'\\x60]*[:=]\\s*`, 'giu');
const SECRET_KEY = new RegExp(`^(?:${LABEL})$`, 'iu');
const KNOWN_CREDENTIAL = /(?:^|[^\p{L}\p{N}_])(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}\b|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}|-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----|[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@)/iu;

/** 只规范化检测副本：还原嵌入的 Unicode 转义及零宽字符，不改写公开原文。 */
function detectionText(text) {
  return text.normalize('NFKC')
    .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})/gi, (match, wide, narrow) => {
      const value = Number.parseInt(wide || narrow, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    .replace(/[\p{Cf}\u0000]/gu, '');
}

/** 只有完整显式占位符可替代秘密值；普通示例值不视为脱敏。 */
function isPlaceholder(value) {
  if (value === null || value === undefined || value === '') return true;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return /^(?:\*{3,}|\[redacted\]|<redacted>|<placeholder>|\[hidden\]|已隐藏|已脱敏|敏感内容已隐藏|redacted|\$\{[A-Z_][A-Z0-9_]*\})$/i.test(text);
}

/** 在标签后的首个值边界内检测占位符，避免将 JSON 后续字段混入此值。 */
function assignmentValue(text) {
  const value = text.trimStart();
  if (value.startsWith('"') || value.startsWith("'")) {
    const end = value.indexOf(value[0], 1);
    return end < 0 ? value.slice(1) : value.slice(1, end);
  }
  return value.split(/[\r\n;,]/, 1)[0].trim();
}

/** 检测公开字符串中的明确危险特征；不回传匹配内容或附近文字。 */
function unsafeText(input) {
  const text = detectionText(input);
  if (KNOWN_CREDENTIAL.test(text)) return true;
  const auth = /(?:^|[^\p{L}\p{N}_])(?:bearer|basic)\s+([^\s,;]+)/giu;
  for (const match of text.matchAll(auth)) {
    if (!isPlaceholder(match[1])) return true;
  }
  // matchAll 使用正则副本，外部连续调用不会继承 lastIndex。
  for (const match of text.matchAll(ASSIGNMENT)) {
    if (!isPlaceholder(assignmentValue(text.slice(match.index + match[0].length)))) return true;
  }
  const environment = [...text.matchAll(/(?:^|[\s;])(?:export[ \t]+)?[A-Z_][A-Z0-9_]{1,80}[ \t]*=[ \t]*([^\r\n;]*)/g)];
  return environment.length >= 2 && environment.some((match) => !isPlaceholder(assignmentValue(match[1])));
}

/** 检查完整 JSON 值；循环、深度异常及秘密字段使用保守拒绝，不接受审查解除。 */
export function hasSensitiveContent(value) {
  const pending = [{ value, depth: 0 }];
  const seen = new Set();
  let examined = 0;
  while (pending.length) {
    const entry = pending.pop();
    examined += 1;
    if (examined > 100000 || entry.depth > 80) return true;
    if (typeof entry.value === 'string') {
      if (unsafeText(entry.value)) return true;
    } else if (entry.value !== null && typeof entry.value === 'object') {
      if (seen.has(entry.value)) return true;
      seen.add(entry.value);
      for (const [key, child] of Object.entries(entry.value)) {
        const normalizedKey = detectionText(key);
        if (unsafeText(normalizedKey)) return true;
        if (SECRET_KEY.test(normalizedKey) && !isPlaceholder(child)) return true;
        if (/^(?:env|environment|environment_dump)$/i.test(normalizedKey)
          && child && typeof child === 'object' && Object.values(child).some((item) => !isPlaceholder(item))) return true;
        pending.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }
  return false;
}

/** 完整检测后返回公开原文；危险值只返回调用者给定的安全固定占位。 */
export function sanitizeText(value, fallback = '敏感内容已隐藏') {
  const safeFallback = typeof fallback === 'string' && !hasSensitiveContent(fallback) ? fallback : '敏感内容已隐藏';
  if (typeof value !== 'string') return safeFallback;
  return hasSensitiveContent(value) ? safeFallback : value;
}
