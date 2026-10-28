import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

/** 载入真实页面函数但不启动页面；无浏览器、计时器、网络请求或生产项目读取。 */
async function loadTitleFunction() {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const startup = source.lastIndexOf('\ninitialize();');
  assert.ok(startup > 0, '必须识别唯一的页面启动入口，不能意外执行初始化');
  const context = vm.createContext({ document: { getElementById: () => null, querySelector: () => null } });
  vm.runInContext(source.slice(0, startup), context);
  return vm.runInContext('taskTitle', context);
}

const titleFor = await loadTitleFunction();
const automaticKey = 'WORK-79f7f99df2f1ffc3a414a3113f165be8';
const cases = [
  ['自动编号使用完整业务标题', automaticKey, 'INVALID-RESPONSE-RCA-001：完整说明', 'INVALID-RESPONSE-RCA-001：完整说明'],
  ['普通业务编号同样名称优先', 'ND-007', '景区商圈车辆到访分析', '景区商圈车辆到访分析'],
  ['空标题回退完整编号而不截短', automaticKey, '', automaticKey],
  ['混合空白标题回退完整编号', automaticKey, ' \t\r\n\u00a0\u3000 ', automaticKey],
  ['非空标题保留原文中的首尾空格和换行', 'A', '  完整名称\n第二行  ', '  完整名称\n第二行  '],
  ['敏感占位照常显示', automaticKey, '敏感内容已隐藏', '敏感内容已隐藏'],
  ['缺失项占位照常显示', automaticKey, '缺失工作项', '缺失工作项'],
];
for (const [name, key, title, expected] of cases) {
  test(name, () => {
    const node = Object.freeze({ key, title });
    assert.equal(titleFor(node), expected);
    assert.equal(node.key, key, '标题处理不能改动完整身份键');
    assert.equal(node.title, title, '标题处理不能改写来源文字');
  });
}
