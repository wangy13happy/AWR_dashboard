import { spawn } from 'node:child_process';

// 仅为真实作业生命周期提供已知合成入口：不读取项目、配置、数据库或端口，不保存凭据。
if (process.argv[2] === 'exit-code') {
  // Windows实际进程退出使用完整32位值；负的有符号形式避免Node参数范围检查截断本例高位。
  // 留出有界观测窗口，让控制器持有完成端口报告的系统控制台辅助进程；不改变待核验退出值。
  setTimeout(() => process.exit(-249346713), 250);
}
if (process.argv[2] === 'tree') {
  // 后代只执行同一个固定合成入口；不指定脱离作业标志，不把父的作业/IPC句柄给后代。
  spawn(process.execPath, [process.argv[1], 'leaf'], { windowsHide: true, stdio: 'ignore' });
}
setInterval(() => {}, 1000);
