#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer } from '../src/server.js';
import { readProjectRegistry, normalizedProjectRoot } from '../src/registry.js';
import { DashboardError } from '../src/safety.js';

/** 解析本地登记清单与启动默认参数；项目参数只能选择清单内根，不扩大允许名单。 */
function parseArguments(args) {
  const options = { projects: fileURLToPath(new URL('../config/projects.json', import.meta.url)), port: 4317, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (!['--project', '--projects', '--port'].includes(flag) || seen.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new DashboardError('STARTUP_ARGUMENTS', '只支持各一次的 --project <已登记目录>、--projects <清单>、--port <端口> 和 --help。');
    }
    seen.add(flag);
    const value = args[++index];
    if (flag === '--project') options.project = value;
    else if (flag === '--projects') options.projects = value;
    else {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new DashboardError('STARTUP_ARGUMENTS', '端口须为1至65535的整数。');
      options.port = Number(value);
    }
  }
  return options;
}

/** 启动本地查看服务；不会初始化所选项目、执行上游命令或创建后台服务。 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('AWR 外置只读依赖看板\n用法：npm start -- [--projects <本地登记清单>] [--project <已登记的启动默认目录>] [--port 4317]\n默认使用本插件config/projects.json；仅监听127.0.0.1；每5秒更新名单与图；按 Ctrl+C 停止。');
    return;
  }
  const registryPath = path.resolve(options.projects);
  const registry = await readProjectRegistry(registryPath);
  let projectRoot;
  if (options.project !== undefined) {
    const selectedRoot = normalizedProjectRoot(path.resolve(options.project));
    const entry = registry.projects.find((project) => normalizedProjectRoot(project.root) === selectedRoot);
    if (!entry) throw new DashboardError('PROJECT_NOT_REGISTERED', '启动默认项目未登记；请先修改本插件登记清单，--project不能新增读取权限。');
    projectRoot = entry.root;
  }
  // 启动和列名单不检查各项目DB：不可用的单项不得阻止其他已登记项目被选择。
  const server = createDashboardServer({ registryPath, projectRoot, onError: code => console.error(`看板读取：${code}`) });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? '启动失败：该端口已被占用，请使用 --port 指定其他端口。' : '启动失败：无法监听本地端口。');
    process.exitCode = 1;
  });
  server.listen(options.port, '127.0.0.1', () => {
    console.log(`只读依赖看板：http://127.0.0.1:${options.port}`);
    console.log('网页可选择清单内项目；清单修改会热生效，停止此进程即可关闭看板。');
    if (!projectRoot && registry.defaultProjectId === null) console.log('当前没有已登记的启动默认项目，请在网页中选择。');
  });
  /** 仅关闭本进程的监听；读取器会在finally清理自己的副本，不碰项目文件。 */
  function stop() {
    server.close(() => { process.exitCode = 0; });
    server.closeIdleConnections();
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error instanceof DashboardError ? `启动失败：${error.message}` : '启动失败：参数或运行环境无效。使用 --help 查看用法。');
  process.exitCode = 1;
});
