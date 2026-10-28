import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_COMPILER, NATIVE_OBJDUMP, nativeSkipReason } from './native/native-test-support.mjs';

/** 提供明确的合成先决条件，不操作系统工具、正式配置或后台；只有本测试调用会注入替身。 */
function capabilities(overrides = {}) {
  return {
    platform: 'win32', architecture: 'x64', release: '10.0.19045',
    toolReason: async () => null,
    identity: async () => ({ userSid: 'S-1-5-21-101', elevated: false, integrityRid: 8192,
      commonData: 'C:\\ProgramData', systemX86: 'C:\\Windows\\SysWOW64' }),
    target: async () => 'mingw32', ...overrides,
  };
}

test('缺编译器只跳过依赖工具的原生用例，参数拒绝检查仍可运行', async () => {
  const probes = capabilities({ toolReason: async filename => filename === NATIVE_COMPILER
    ? `缺少测试工具：${filename}` : null,
  target: async () => { throw new Error('缺失工具不得执行'); } });
  assert.equal(await nativeSkipReason({ toolchain: true }, probes), `缺少测试工具：${NATIVE_COMPILER}`);
  assert.equal(await nativeSkipReason({ builder: true }, probes), `缺少测试工具：${NATIVE_COMPILER}`);
  assert.equal(await nativeSkipReason({ powerShell: true }, probes), null);
});

test('已有工具的探测退出失败、权限错误及1460不会被转换为能力跳过', async () => {
  for (const code of [1, 'EACCES', 1460]) {
    const failure = Object.assign(new Error('synthetic-probe-failed'), { code });
    await assert.rejects(nativeSkipReason({ toolchain: true }, capabilities({ target: async () => { throw failure; } })),
      error => error === failure);
    await assert.rejects(nativeSkipReason({ toolchain: true }, capabilities({ toolReason: async () => { throw failure; } })),
      error => error === failure);
  }
});

test('构建器身份查询失败继续失败，缺导入检查工具只影响构建集成', async () => {
  const failure = new Error('synthetic-identity-query-failed');
  await assert.rejects(nativeSkipReason({ builder: true }, capabilities({ identity: async () => { throw failure; } })),
    error => error === failure);
  const probes = capabilities({ toolReason: async filename => filename === NATIVE_OBJDUMP
    ? `缺少测试工具：${filename}` : null });
  assert.equal(await nativeSkipReason({ builder: true }, probes), `缺少测试工具：${NATIVE_OBJDUMP}`);
  assert.equal(await nativeSkipReason({ toolchain: true }, probes), null);
  assert.equal(await nativeSkipReason({ powerShell: true }, probes), null);
});

test('跨位数和作业列表系统条件只限制真实生命周期，协议替身保留执行', async () => {
  for (const probes of [capabilities({ architecture: 'arm64' }), capabilities({ release: '6.3.9600' })]) {
    assert.match(await nativeSkipReason({ toolchain: true, jobs: true }, probes), /64位Node.js|Windows 10/);
    assert.equal(await nativeSkipReason({ toolchain: true }, probes), null);
  }
});

test('真实作业仅在已确认的中等普通权限下运行，查询失败和协议替身不会被一并跳过', async () => {
  const requirements = { toolchain: true, jobs: true };
  for (const observed of [{ elevated: true, integrityRid: 12288 }, { elevated: false, integrityRid: 4096 }]) {
    const probes = capabilities({ identity: async () => observed });
    assert.match(await nativeSkipReason(requirements, probes), /管理员角色已启用|中等完整性令牌/);
    assert.equal(await nativeSkipReason({ toolchain: true }, probes), null);
  }
  const failure = new Error('synthetic-token-query-failed');
  await assert.rejects(nativeSkipReason(requirements, capabilities({ identity: async () => { throw failure; } })),
    error => error === failure);
});

test('完整受支持条件执行所有原生类别，错误工具目标给出明确环境原因', async () => {
  for (const requirements of [{ builder: true }, { powerShell: true }, { toolchain: true }, { toolchain: true, jobs: true }]) {
    assert.equal(await nativeSkipReason(requirements, capabilities()), null);
  }
  assert.equal(await nativeSkipReason({ toolchain: true }, capabilities({ target: async () => 'x86_64-w64-mingw32' })),
    '此夹具要求mingw32工具链，当前目标为x86_64-w64-mingw32');
});
