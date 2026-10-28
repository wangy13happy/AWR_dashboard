import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { readSnapshot } from '../src/reader.js';
import { createRunningFixture } from './agent-running-fixture.mjs';
import { fixtureFileBaseline } from './reader-fixture.mjs';
import { windowsPowerShellEnvironment } from './support/background-project-fixture.mjs';

const output = path.resolve(process.env.AWR_RUNNING_BROWSER_ROOT ?? 'verification/agent-running-session-browser');
const report = { checks: [], pageErrors: [], passed: false, scope: 'temporary AWR fixture and explicit native observations; no real project or agent scan' };
let fixture, server, browser;let state = 'executing';
const started = performance.now();
/** 只检查本测试节点的子孙浏览器，不枚举其他项目代理或停止其他进程。 */
async function ownedBrowserPids() {
  if (process.platform !== 'win32') return [];
  const script = `$p=@(${process.pid});$a=@();for($d=0;$d -lt 5;$d++){$n=@();foreach($id in $p){$n+=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -Property ProcessId,Name)};$a+=$n;$p=@($n|ForEach-Object ProcessId)};@($a|Where-Object Name -Match '^(chrome|headless_shell|msedge)[.]exe$'|Select-Object -ExpandProperty ProcessId)|ConvertTo-Json -Compress`;
  const {stdout} = await promisify(execFile)('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {windowsHide:true,env:windowsPowerShellEnvironment(),timeout:10000});
  return stdout.trim() ? [].concat(JSON.parse(stdout)) : [];
}
/** 保存真正完成的断言，原始失败由finally保留。 */
function passed(name) {report.checks.push({name,passed:true});}
try {
  await mkdir(output,{recursive:true});report.browserPidsBefore = await ownedBrowserPids();
  fixture = await createRunningFixture();const baseline = await fixtureFileBaseline(fixture.root);
  server = createDashboardServer({projectRoot:fixture.root,snapshotReader: root => readSnapshot(root,{agentObservation:fixture.observation(state,Date.now())})});
  await new Promise(r => server.listen(0,'127.0.0.1',r));report.port=server.address().port;
  assert.ok(![4317,8765].includes(report.port));const base=`http://127.0.0.1:${report.port}`;
  browser = await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1366,height:900}});
  page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(`${base}/#view=graph`);
  await expect(page.locator('.agent-running-icon')).toHaveCount(1);passed('无领取及无runner目录，绑定原生执行回合显示光环');
  const geometry=await page.locator('.task-card').evaluate(node=>{const r=node.getBoundingClientRect();return [r.width,r.height];});
  // 信号节点仍按原期限出现；可见效果改为卡片外圈旋转光环和加粗边框，卡内小环隐藏。
  const halo=()=>page.locator('.task-card').evaluate(node=>{const b=getComputedStyle(node,'::before'),a=getComputedStyle(node,'::after');
    return [getComputedStyle(node.querySelector('.agent-running-icon')).display,b.content,b.animationName,b.pointerEvents,a.boxShadow,a.pointerEvents];});
  assert.deepEqual(await halo(),['none','""','card-halo-rotate','none','rgb(71, 123, 255) 0px 0px 0px 2px inset','none']);passed('信号显示为卡片外圈旋转光环与内加2像素加粗边框，光环不响应指针');
  await page.screenshot({path:path.join(output,'executing-desktop.png'),fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.deepEqual(await halo(),['none','""','none','none','rgb(71, 123, 255) 0px 0px 0px 2px inset','none']);passed('减少动态效果时光环静止但仍显示，加粗边框保持');
  await page.emulateMedia({reducedMotion:'no-preference'});
  const mobile=await browser.newPage({viewport:{width:390,height:844}});mobile.on('pageerror',e=>report.pageErrors.push(e.message));await mobile.goto(`${base}/#view=graph`);
  await expect(mobile.locator('.agent-running-icon')).toHaveCount(1);
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await mobile.screenshot({path:path.join(output,'executing-mobile.png'),fullPage:true});passed('390像素光环可见且无横向溢出');await mobile.close();
  state='ended';const endedAt=performance.now();await expect(page.locator('.agent-running-icon')).toHaveCount(0,{timeout:7500});
  report.endedRefreshMs=performance.now()-endedAt;
  assert.deepEqual(await page.locator('.task-card').evaluate(node=>[getComputedStyle(node,'::before').content,getComputedStyle(node,'::after').content]),['none','none']);
  passed('进程仍活但回合结束，下次刷新熄灭且光环与加粗边框一并消失');
  assert.deepEqual(await page.locator('.task-card').evaluate(node=>{const r=node.getBoundingClientRect();return [r.width,r.height];}),geometry);
  passed('亮灭不改变卡片宽高或原文案');await page.screenshot({path:path.join(output,'ended-desktop.png'),fullPage:true});
  state='executing';await expect(page.locator('.agent-running-icon')).toHaveCount(1,{timeout:7500});passed('下一回合重新执行时恢复显示');
  state='unknown';await expect(page.locator('.agent-running-icon')).toHaveCount(0,{timeout:7500});passed('缺少当前回合证据撤销旧肯定');
  assert.deepEqual(await fixtureFileBaseline(fixture.root),baseline);passed('所有浏览器读取保持临时项目字节与元数据全等');
  assert.deepEqual(report.pageErrors,[]);report.passed=true;
} catch(error) {report.error=String(error);process.exitCode=1;}
finally {
  await browser?.close();
  if(server){await new Promise(r=>server.close(r));await server.agentObserverStopped;report.serverListeningAfter=server.listening;}
  report.browserPidsAfter=await ownedBrowserPids();if(report.browserPidsAfter.length){report.passed=false;process.exitCode=1;}
  await fixture?.dispose();report.durationMs=performance.now()-started;
  await writeFile(path.join(output,'browser-results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
