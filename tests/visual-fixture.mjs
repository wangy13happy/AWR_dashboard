import { createReaderFixture } from './reader-fixture.mjs';

/** 根据参考图构造明确标记的视觉夹具；以下任务不是用户项目的实时进度。 */
export async function createVisualFixture() {
  const titles = {
    'ND-000': '数据盘点与质量校验', 'ND-001': '主城区出行车辆分析',
    'ND-002': '城市道路在途量分析', 'ND-003': '宏观出入城流量分析',
    'ND-004': '外地来济车辆与出入城通道分析', 'ND-005': '通行时长与驻留分析',
    'ND-006': '骨干道路速度与拥堵指数分析', 'ND-007': '景区商圈车辆到访分析',
    'ND-008': '景区商圈拥堵指数分析', 'ND-009': '网约车运行分析',
    'ND-010': '素材汇总与报告大纲', 'ND-011': '交管官方素材采集与核对',
    'ND-012': '报告指标口径表与共享模块', 'ND-013': '管理效果与政策背景综合',
    'ND-014': '报告出图与撰写', 'ND-015': '主城区速度与拥堵指数分析',
    'ND-016': '大明湖路单行措施评估设计', 'ND-017': '大明湖路单行措施影响评估',
    'ND-018': '补充数据需求清单（视觉样本）', 'ND-019': '定稿与收尾',
    'ND-020': '开工口径与边界确认', 'ND-021': '融创茂文旅城专题分析',
    'ND-022': '主城区假期过车来源地分析',
  };
  const completed = new Set(['ND-000', 'ND-009', 'ND-011', 'ND-012', 'ND-016', 'ND-020']);
  const running = new Set(['ND-001', 'ND-002', 'ND-003', 'ND-004', 'ND-005', 'ND-007']);
  const analytical = ['ND-001', 'ND-002', 'ND-003', 'ND-004', 'ND-005', 'ND-006', 'ND-007', 'ND-008', 'ND-009', 'ND-015', 'ND-017', 'ND-021', 'ND-022'];
  const works = Object.entries(titles).map(([key, title]) => ({
    key, title, status: completed.has(key) ? 'completed' : running.has(key) ? 'in_progress' : key === 'ND-018' ? 'cancelled' : 'planned',
    payload: {
      kind: analytical.includes(key) ? '分析' : ['ND-000', 'ND-012'].includes(key) ? '数据质量' : '综合',
      priority: analytical.includes(key) ? 'P1' : 'P0',
      summary: '参考图视觉验收夹具；不代表真实业务项目状态。',
      next_action: key === 'ND-007'
        ? '已完成：视觉夹具中的素材与口径对齐。下一步：检查右侧验收、依赖和证据展示。此处仅为演示，不对应真实分析结论。'
        : '继续验证看板交互和实时更新；仅修改本测试夹具。',
      acceptance: key === 'ND-007' ? [
        '展示景区商圈工作项的标题、来源状态及当前认领。',
        '直接上游与下游可点击定位，不能执行工作项。',
        '验收条目及已登记证据只作为文字展示。',
        '未完成来源声明不显示为已通过业务验收。',
      ] : ['视觉测试夹具验收项'],
    },
  }));
  const edges = [
    { from: 'ND-016', to: 'ND-011' }, { from: 'ND-012', to: 'ND-000' },
    { from: 'ND-012', to: 'ND-020' }, { from: 'ND-012', to: 'ND-011' },
    ...analytical.map(key => ({ from: key, to: 'ND-012' })),
    { from: 'ND-017', to: 'ND-016' },
    ...analytical.map(key => ({ from: 'ND-013', to: key })),
    { from: 'ND-010', to: 'ND-013' },
    ...analytical.map(key => ({ from: 'ND-010', to: key })),
    { from: 'ND-014', to: 'ND-010' }, { from: 'ND-019', to: 'ND-014' },
  ];
  return createReaderFixture({
    name: '20261008 国庆交通分析 · 演示', wal: true, works, edges,
    claims: [...running, 'ND-006'].map(key => ({ key, agent: '演示代理', branch: false })),
    evidence: [
      { key: 'ND-007', type: 'visual', locator: 'analysis/nd007_scenic_visits.py', summary: '演示路径，不读取目标文件' },
      { key: 'ND-007', type: 'visual', locator: 'outputs/07_scenic_vehicles/素材分析.md', summary: '演示素材登记' },
      { key: 'ND-007', type: 'visual', locator: 'outputs/07_scenic_vehicles/可引用数字表.csv', summary: '演示引用登记' },
      { key: 'ND-007', type: 'visual', locator: 'outputs/07_scenic_vehicles/分时到访.csv', summary: '演示分时登记' },
    ],
  });
}
