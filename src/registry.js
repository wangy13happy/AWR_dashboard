import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DashboardError, hasSensitiveContent } from './safety.js';

const REGISTRY_LIMIT = 64 * 1024;
const PROJECT_LIMIT = 1000;

/** 仅规范化已声明绝对根的比较身份，不查目录、不发现项目、不放宽读取器的链接检查。 */
export function normalizedProjectRoot(value) {
  const normalized = path.normalize(value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, ''));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 登记标识是有界的不透明键，不能把网页提供的路径、命令或定位符当作标识。 */
export function isRegisteredProjectId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

/** 固定清单错误只提供可操作类别，不拼接路径、JSON正文、敏感匹配或系统异常。 */
function registryError(code = 'REGISTRY_INVALID') {
  const messages = {
    REGISTRY_INVALID: '项目登记清单格式无效，已停止新的项目读取，请修复清单。',
    REGISTRY_UNAVAILABLE: '项目登记清单无法稳定读取，已停止新的项目读取，请检查清单。',
    REGISTRY_TOO_LARGE: '项目登记清单超过64 KiB或1000条上限，未采用截断名单。',
  };
  return new DashboardError(code, messages[code], true);
}

/** 比较文件身份与纳秒元数据，替换/截断/持续编辑时不能使用混合清单授权。 */
function sameFile(first, second) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((field) => first[field] === second[field]);
}

/** 从同一普通文件句柄按明确偏移有界读字节，读取上限在分配和解析之前执行。 */
async function readBytes(handle) {
  const chunks = [];
  let total = 0;
  while (true) {
    const buffer = Buffer.alloc(Math.min(8192, REGISTRY_LIMIT - total + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (!bytesRead) break;
    total += bytesRead;
    if (total > REGISTRY_LIMIT) throw registryError('REGISTRY_TOO_LARGE');
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

/** 校验完整有界清单；坏项目目录不在这里探测，只有结构错误使整份清单无效。 */
function registryValue(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw registryError(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['version', 'defaultProjectId', 'projects'].includes(key))
    || value.version !== 1 || !Array.isArray(value.projects)
    || !Object.hasOwn(value, 'defaultProjectId')
    || (value.defaultProjectId !== null && !isRegisteredProjectId(value.defaultProjectId))
    || hasSensitiveContent(value)) throw registryError();
  if (value.projects.length > PROJECT_LIMIT) throw registryError('REGISTRY_TOO_LARGE');
  const ids = new Set();
  const projects = value.projects.map((project) => {
    if (!project || typeof project !== 'object' || Array.isArray(project)
      || Object.keys(project).some((key) => !['id', 'name', 'root'].includes(key))
      || !isRegisteredProjectId(project.id) || ids.has(project.id)
      || typeof project.name !== 'string' || !project.name.trim() || project.name.length > 200
      || typeof project.root !== 'string' || project.root.length > 4096 || !path.isAbsolute(project.root)
      || /[\u0000-\u001f\u007f]/.test(project.name + project.root)) throw registryError();
    ids.add(project.id);
    return { id: project.id, name: project.name, root: project.root };
  });
  return { version: 1, defaultProjectId: ids.has(value.defaultProjectId) ? value.defaultProjectId : null,
    projects, fingerprint: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * 每次重新读取登记清单，双读并核对文件身份，不保留旧清单作为失败时的授权回退。
 * 清单原文与登记根只供本地服务内部使用；onReadStep 仅供专用夹具制造确定的捕获变化。
 */
export async function readProjectRegistry(registryPath, options = {}) {
  let handle;
  try {
    if (typeof registryPath !== 'string' || !registryPath || hasSensitiveContent(registryPath)) throw registryError('REGISTRY_UNAVAILABLE');
    const filename = path.resolve(registryPath);
    const before = await lstat(filename, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()
      || normalizedProjectRoot(await realpath(filename)) !== normalizedProjectRoot(filename)) throw registryError('REGISTRY_UNAVAILABLE');
    if (before.size > BigInt(REGISTRY_LIMIT)) throw registryError('REGISTRY_TOO_LARGE');
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!sameFile(before, await handle.stat({ bigint: true }))) throw registryError('REGISTRY_UNAVAILABLE');
    const bytes = await readBytes(handle);
    // 正式服务不暴露测试钩子；生产读取只使用固定清单路径，绝不来自网页参数。
    if (options.onReadStep) await options.onReadStep();
    const second = await readBytes(handle);
    const after = await lstat(filename, { bigint: true });
    if (!bytes.equals(second) || BigInt(bytes.length) !== before.size || !sameFile(before, after)
      || !sameFile(before, await handle.stat({ bigint: true }))
      || normalizedProjectRoot(await realpath(filename)) !== normalizedProjectRoot(filename)) throw registryError('REGISTRY_UNAVAILABLE');
    return registryValue(bytes);
  } catch (error) {
    if (error instanceof DashboardError && /^REGISTRY_/.test(error.code)) throw error;
    throw registryError('REGISTRY_UNAVAILABLE');
  } finally {
    if (handle) await handle.close();
  }
}
