import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readProjectRegistry, normalizedProjectRoot, isRegisteredProjectId } from '../src/registry.js';
import { DashboardError } from '../src/safety.js';

/** 创建只有清单的独占夹具；登记根故意不存在，证明列名单不探测项目或数据库。 */
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'awr-dashboard-registry-test-'));
  const filename = path.join(directory, 'projects.json');
  const value = { version: 1, defaultProjectId: 'a', projects: [
    { id: 'a', name: '登记甲', root: path.join(directory, 'missing-a') },
    { id: 'b', name: '登记乙', root: path.join(directory, 'missing-b') },
  ] };
  await writeFile(filename, JSON.stringify(value));
  t.after(async () => {
    if (!path.basename(directory).startsWith('awr-dashboard-registry-test-')) throw new Error('Invalid fixture cleanup target');
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, filename, value };
}

/** 仅匹配固定错误类型和码，不把正文或系统异常当作业务诊断。 */
function errorCode(code) {
  return (error) => error instanceof DashboardError && error.code === code;
}

test('仅解析登记身份，未创建项目根仍保留所有条目且清单不变', async (t) => {
  const { filename, value } = await fixture(t);
  const before = await readFile(filename);
  const result = await readProjectRegistry(filename);
  assert.deepEqual(result.projects, value.projects);
  assert.equal(result.defaultProjectId, 'a');
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(filename), before);
});

test('热增删和改名每次读取生效，完整字节身份改变，不保留旧名单', async (t) => {
  const { directory, filename, value } = await fixture(t);
  const first = await readProjectRegistry(filename);
  const next = { ...value, projects: [{ ...value.projects[1], name: '新名称' },
    { id: 'c', name: '新登记', root: path.join(directory, 'missing-c') }] };
  await writeFile(filename, JSON.stringify(next));
  const changed = await readProjectRegistry(filename);
  assert.deepEqual(changed.projects, next.projects);
  assert.equal(changed.defaultProjectId, null);
  assert.notEqual(changed.fingerprint, first.fingerprint);
});

test('空清单与缺失默认条目可列为空或待选择，不自动选择首条', async (t) => {
  const { filename, value } = await fixture(t);
  for (const next of [{ ...value, defaultProjectId: 'gone' }, { version: 1, defaultProjectId: null, projects: [] }]) {
    await writeFile(filename, JSON.stringify(next));
    const result = await readProjectRegistry(filename);
    assert.equal(result.defaultProjectId, null);
    assert.deepEqual(result.projects, next.projects);
  }
});

test('未知字段、版本、重复标识、相对根及危险文字均固定拒绝', async (t) => {
  const { filename, value } = await fixture(t);
  const invalidValues = [
    { ...value, version: 2 }, { ...value, extra: true }, { version: 1, projects: value.projects },
    { ...value, projects: [value.projects[0], value.projects[0]] },
    { ...value, projects: [{ ...value.projects[0], root: '../unregistered' }] },
    { ...value, projects: [{ ...value.projects[0], id: 'C:\\secret\\file' }] },
    { ...value, projects: [{ ...value.projects[0], name: '' }] },
    { ...value, projects: [{ ...value.projects[0], name: 'password: fixture-secret-only' }] },
    { ...value, projects: [{ ...value.projects[0], credential: 'fixture-secret-only' }] },
  ];
  for (const invalid of invalidValues) {
    await writeFile(filename, JSON.stringify(invalid));
    await assert.rejects(readProjectRegistry(filename), (error) => errorCode('REGISTRY_INVALID')(error)
      && !/fixture-secret|unregistered/.test(error.message));
  }
});

test('损坏JSON及无效编码不返回正文，修复后重新读取有效名单', async (t) => {
  const { filename, value } = await fixture(t);
  for (const bytes of ['{"private_raw_text":', Buffer.from([0xff, 0xfe, 0xfa])]) {
    await writeFile(filename, bytes);
    await assert.rejects(readProjectRegistry(filename), (error) => errorCode('REGISTRY_INVALID')(error) && !error.message.includes('private_raw_text'));
  }
  await writeFile(filename, JSON.stringify(value));
  assert.deepEqual((await readProjectRegistry(filename)).projects, value.projects);
});

test('缺失或非普通文件拒绝，不创建替代清单', async (t) => {
  const { directory, filename } = await fixture(t);
  await rm(filename);
  await assert.rejects(readProjectRegistry(filename), errorCode('REGISTRY_UNAVAILABLE'));
  await assert.rejects(readProjectRegistry(directory), errorCode('REGISTRY_UNAVAILABLE'));
});

test('字节和条目超限明确拒绝而非截断', async (t) => {
  const { filename, value } = await fixture(t);
  await writeFile(filename, ' '.repeat(64 * 1024 + 1));
  await assert.rejects(readProjectRegistry(filename), errorCode('REGISTRY_TOO_LARGE'));
  await writeFile(filename, JSON.stringify({ ...value, projects: Array.from({ length: 1001 }, () => ({})) }));
  await assert.rejects(readProjectRegistry(filename), errorCode('REGISTRY_TOO_LARGE'));
});

test('捕获中改写清单不采用混合授权，不自动重试旧清单', async (t) => {
  const { filename, value } = await fixture(t);
  await assert.rejects(readProjectRegistry(filename, { onReadStep: async () => {
    await writeFile(filename, JSON.stringify({ ...value, defaultProjectId: 'b' }));
  } }), errorCode('REGISTRY_UNAVAILABLE'));
  assert.equal((await readProjectRegistry(filename)).defaultProjectId, 'b');
});

test('清单父目录经链接跳转被拒绝', async (t) => {
  const { directory, value } = await fixture(t);
  const target = path.join(directory, 'physical');
  const alias = path.join(directory, 'alias');
  await mkdir(target);
  await writeFile(path.join(target, 'projects.json'), JSON.stringify(value));
  try { await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前系统不允许测试目录链接'); return; }
    throw error;
  }
  await assert.rejects(readProjectRegistry(path.join(alias, 'projects.json')), errorCode('REGISTRY_UNAVAILABLE'));
});

test('根比较只规范化平台身份；登记标识不能伪装成路径', () => {
  assert.equal(isRegisteredProjectId('ntfy'), true);
  assert.equal(isRegisteredProjectId('knowledge-star'), true);
  assert.equal(isRegisteredProjectId('../a'), false);
  assert.equal(isRegisteredProjectId('file://a'), false);
  if (process.platform === 'win32') assert.equal(normalizedProjectRoot('E:/Project/A'), normalizedProjectRoot('e:\\project\\a'));
  else assert.notEqual(normalizedProjectRoot('/Project/A'), normalizedProjectRoot('/project/a'));
});
