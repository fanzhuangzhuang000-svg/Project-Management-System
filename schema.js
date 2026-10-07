'use strict';
/**
 * 弱电智能化工程项目管理系统 —— 数据模型定义
 * 这一份定义同时驱动：数据库建表、后端接口校验、前端表格列与录入表单。
 */

// ---------- 常用枚举 ----------
const PROJECT_STATUS = ['未开工', '进行中', '已完工', '结算中', '已结清', '已归档'];
const PROJECT_CATEGORY = [
  '综合布线', '安防监控', '门禁一卡通', '机房工程', '会议系统', '楼宇自控',
  '智能照明', '停车管理', '信息发布', '网络通信', '公共广播', '智能家居', '其他',
];
const PARTNER_TYPE = ['甲方', '供应商', '分包商', '劳务队', '监理', '设计院', '其他'];
const CONTRACT_CATEGORY = ['项目合同', '采购合同', '分包合同', '劳务合同', '框架协议', '其他'];
const CONTRACT_STATUS = ['草稿', '执行中', '已完成', '已终止'];
const PAY_KIND = ['预付款', '进度款', '到货款', '尾款', '质保金', '其他'];
const PAY_METHOD = ['银行转账', '银行承兑', '商业承兑', '现金', '抵账', '其他'];
// 收付款计划节点
const SCHEDULE_PHASE = ['预付款', '进度款', '到货款', '验收款', '尾款', '质保金', '其他'];
const SCHEDULE_STATE = ['待收付', '部分收付', '已完成', '已逾期'];
const INVOICE_TYPE = ['增值税专用发票', '工程类增值税专用发票', '增值税普通发票', '劳务发票', '电子专票', '电子普票', '普票', '其他'];
const INVOICE_STATUS = ['已开具', '已认证', '已作废', '红冲'];
const MATERIAL_CATEGORY = ['设备', '线缆', '管材', '桥架', '机柜', '辅材', '其他'];
const MATERIAL_STATUS = ['待采购', '已下单', '部分到货', '已到货', '已安装', '已退场'];
// 项目费用科目（用于算实际成本）
const EXPENSE_CATEGORY = ['材料设备', '人工费', '分包费', '机械租赁', '差旅交通', '业务招待', '税费', '现场经费', '其他'];
const EXPENSE_STATUS = ['已付', '未付'];
const EXPENSE_INVOICE = ['有票', '无票'];
// 质保期售后维修
const MAINT_STATUS = ['待处理', '处理中', '已完成', '已关闭'];
const MAINT_WARRANTY = ['质保内', '质保外'];
// 合同变更类型
const CHANGE_TYPE = ['增补金额', '削减金额', '工期变更', '范围变更', '其他'];
const CHANGE_STATUS = ['草稿', '已确认', '已作废'];

// 合同方向：in=收入合同（我方收甲方钱），out=支出合同（我方付给供应商/分包）
const CONTRACT_DIRECTION = [
  { value: 'in', label: '收入合同' },
  { value: 'out', label: '支出合同' },
];
// 款项方向
const PAY_DIRECTION = [
  { value: 'in', label: '收款' },
  { value: 'out', label: '付款' },
];
// 发票方向：out=销项（我开给甲方），in=进项（供应商开给我）
const INVOICE_DIRECTION = [
  { value: 'out', label: '销项（我开出）' },
  { value: 'in', label: '进项（收到）' },
];

// 合同类别 -> 默认方向
const CATEGORY_DIRECTION = {
  项目合同: 'in',
  框架协议: 'in',
  采购合同: 'out',
  分包合同: 'out',
  劳务合同: 'out',
  其他: 'out',
};

// ---------- 表定义 ----------
// fields 为有序数组：决定录入表单顺序与列表列顺序
// 字段属性：
//   name/label/type 必填；type: text|textarea|number|money|percent|date|select|multi|ref
//   list: 列表中显示    form: 是否出现在表单(默认 true)    width: 列宽
//   required: 必填      span: 表单占几列(默认1, 2=整行)
//   options: 数组，元素为字符串或 {value,label}
//   refTable: 外键指向的表    calc: 由后端计算的派生字段（只读）    virtual: 实时汇总列（不落库）
//   multi: 可多选，库内以英文逗号分隔存储（一个项目常常涉及多个弱电子系统）
const TABLES = {
  projects: {
    label: '项目台账',
    icon: '🏗️',
    order: 10,
    display: 'name',
    searchFields: ['name', 'code', 'manager', 'location', 'category', 'remark'],
    fields: [
      { name: 'code', label: '项目编号', type: 'text', list: true, width: 130, placeholder: '如 RD-2026-001' },
      { name: 'name', label: '项目名称', type: 'text', list: true, width: 240, required: true, span: 2 },
      { name: 'client_id', label: '甲方单位', type: 'ref', refTable: 'partners', list: true, width: 170 },
      { name: 'category', label: '子系统类别', type: 'multi', options: PROJECT_CATEGORY, list: true, width: 180, default: '综合布线', placeholder: '可多选，一个项目涉及几个系统就勾几个' },
      { name: 'status', label: '项目状态', type: 'select', options: PROJECT_STATUS, list: true, default: '进行中', badge: true },
      { name: 'manager', label: '项目经理', type: 'text', list: true, width: 100 },
      { name: 'progress', label: '完工进度(%)', type: 'percent', list: true, default: 0 },
    // 表单专用的快捷录入（virtual = 不建库、不进数据）。
    // 金额的唯一来源始终是合同，这里只是让「建项目」和「填金额」一次做完：
    // 填了之后后端会自动建/更新这个项目的主合同。
    {
      name: '_main_contract', label: '收入合同额', type: 'money', virtual: true, quick: true, prefillFrom: 'contract_in',
      placeholder: '填了自动建一份主合同',
      hint: '本项目跟甲方签的合同金额。填了会自动帮你建一份主合同，已有则更新；'
        + '分包、采购这些支出合同请到「合同管理」里录。',
    },
      // 以下为虚拟列：不落库，由后端实时按合同/收付款汇总，列表与导出时可用
      { name: 'contract_in', label: '收入合同额', type: 'money', list: true, virtual: true, width: 118 },
      { name: 'contract_out', label: '支出成本', type: 'money', list: true, virtual: true, width: 112 },
      { name: 'paid_in', label: '已收款', type: 'money', list: true, virtual: true, width: 112 },
      { name: 'receivable', label: '应收余额', type: 'money', list: true, virtual: true, width: 112, danger: true },
      { name: 'gross_rate', label: '毛利率', type: 'percent', list: true, virtual: true, width: 96 },
      { name: 'location', label: '项目地点', type: 'text', span: 2 },
      { name: 'start_date', label: '开工日期', type: 'date' },
      { name: 'end_date', label: '竣工日期', type: 'date' },
      { name: 'remark', label: '备注', type: 'textarea', span: 2 },
    ],
  },

  contracts: {
    label: '合同管理',
    icon: '📑',
    order: 20,
    display: 'name',
    searchFields: ['name', 'code', 'payment_terms', 'remark'],
    fields: [
      { name: 'code', label: '合同编号', type: 'text', list: true, width: 140 },
      { name: 'name', label: '合同名称', type: 'text', list: true, width: 230, required: true, span: 2 },
      { name: 'project_id', label: '所属项目', type: 'ref', refTable: 'projects', list: true, width: 200, required: true },
      { name: 'category', label: '合同类别', type: 'select', options: CONTRACT_CATEGORY, list: true, default: '项目合同' },
      { name: 'direction', label: '收支方向', type: 'select', options: CONTRACT_DIRECTION, list: true, default: 'in', badge: true },
      { name: 'partner_id', label: '对方单位', type: 'ref', refTable: 'partners', list: true, width: 170 },
      { name: 'amount', label: '合同金额(含税)', type: 'money', list: true, required: true, default: 0 },
      { name: 'tax_rate', label: '税率(%)', type: 'number', default: 9, step: 0.01 },
      { name: 'amount_ex_tax', label: '不含税金额', type: 'money', list: true, calc: true },
      { name: 'sign_date', label: '签订日期', type: 'date' },
      { name: 'start_date', label: '开始日期', type: 'date' },
      { name: 'end_date', label: '结束日期', type: 'date' },
      { name: 'status', label: '合同状态', type: 'select', options: CONTRACT_STATUS, list: true, default: '执行中', badge: true },
      // 虚拟列：由「合同变更」里已确认的增减额汇总而来
      { name: 'change_amount', label: '变更增减', type: 'money', list: true, virtual: true, width: 110 },
      { name: 'final_amount', label: '最终金额', type: 'money', list: true, virtual: true, width: 120 },
      { name: 'payment_terms', label: '付款条款', type: 'textarea', span: 2, placeholder: '如：预付30%，到货40%，验收25%，质保5%' },
      { name: 'remark', label: '备注', type: 'textarea', span: 2 },
    ],
  },

  // 合同变更 / 补充协议：增补、削减、工期与范围调整都记在这里，
  // 合同「最终金额」= 原金额 + 已确认变更的增减额，项目统计按最终金额算。
  contract_changes: {
    label: '合同变更',
    icon: '📝',
    order: 22,
    display: 'title',
    searchFields: ['title', 'reason', 'remark'],
    fields: [
      { name: 'project_id', label: '所属项目', type: 'ref', refTable: 'projects', list: true, width: 180, placeholder: '选好合同后会自动带出' },
      { name: 'contract_id', label: '所属合同', type: 'ref', refTable: 'contracts', list: true, width: 220, required: true },
      { name: 'title', label: '变更事由', type: 'text', list: true, width: 220, required: true, span: 2, placeholder: '如：增加 3 号楼门禁点位 / 因工期顺延增加措施费' },
      { name: 'change_type', label: '变更类型', type: 'select', options: CHANGE_TYPE, list: true, default: '增补金额', badge: true },
      { name: 'change_date', label: '变更日期', type: 'date', list: true, required: true },
      // 正数表示增加，负数表示削减；用「变更类型」辅助理解
      { name: 'amount_delta', label: '金额增减', type: 'money', list: true, default: 0, placeholder: '增加填正数，削减填负数，如 -50000' },
      { name: 'status', label: '状态', type: 'select', options: CHANGE_STATUS, list: true, default: '已确认', badge: true },
      { name: 'doc_no', label: '协议编号', type: 'text', list: true, width: 130 },
      { name: 'operator', label: '经办人', type: 'text', list: true, width: 90 },
      { name: 'reason', label: '变更内容', type: 'textarea', span: 2 },
      { name: 'remark', label: '备注', type: 'textarea', span: 2 },
    ],
  },

  schedules: {
    label: '收付款计划',
    icon: '📅',
    order: 25,
    display: 'phase',
    searchFields: ['phase', 'basis', 'remark'],
    fields: [
      { name: 'project_id', label: '所属项目', type: 'ref', refTable: 'projects', list: true, width: 200, required: true },
      { name: 'contract_id', label: '关联合同', type: 'ref', refTable: 'contracts', list: true, width: 200 },
      { name: 'direction', label: '收/付', type: 'select', options: PAY_DIRECTION, list: true, default: 'in', badge: true, required: true },
      { name: 'phase', label: '节点名称', type: 'select', options: SCHEDULE_PHASE, list: true, default: '进度款', required: true },
      { name: 'ratio', label: '占合同比例(%)', type: 'number', step: 0.01 },
      { name: 'amount', label: '计划金额', type: 'money', list: true, required: true },
      { name: 'due_date', label: '计划日期', type: 'date', list: true, required: true },
      { name: 'basis', label: '触发条件', type: 'text', span: 2, placeholder: '如：合同签订后 7 个工作日内' },
      // 虚拟列：由实际收付款按计划日期先后自动冲抵后算出
      { name: 'paid_amount', label: '已收付', type: 'money', list: true, virtual: true, width: 112 },
      { name: 'remaining', label: '未收付', type: 'money', list: true, virtual: true, width: 112, danger: true },
      { name: 'state', label: '状态', type: 'select', options: SCHEDULE_STATE, list: true, virtual: true, badge: true, width: 92 },
      { name: 'remark', label: '备注', type: 'textarea', span: 2 },
    ],
  },

  payments: {
    label: '收付款',
    icon: '💰',
    order: 30,
    display: 'id',
    searchFields: ['voucher_no', 'remark'],
    fields: [
      { name: 'project_id', label: '所属项目', type: 'ref', refTable: 'projects', list: true, width: 200, required: true },
      { name: 'contract_id', label: '关联合同', type: 'ref', refTable: 'contracts', list: true, width: 200 },
      { name: 'invoice_id', label: '对应发票', type: 'ref', refTable: 'invoices', list: true, width: 150, placeholder: '这笔款对应哪张发票（用于发票勾稽）' },
      { name: 'direction', label: '收/付', type: 'select', options: PAY_DIRECTION, list: true, default: 'in', badge: true, required: true },
      { name: 'kind', label: '款项性质', type: 'select', options: PAY_KIND, list: true, default: '进度款' },
      { name: 'amount', label: '金额', type: 'money', list: true, required: true },
      { name: 'pay_date', label: '发生日期', type: 'date', list: true, required: true },
      { name: 'method', label: '结算方式', type: 'select', options: PAY_METHOD, list: true, default: '银行转账' },
      { name: 'voucher_no', label: '凭证/流水号', type: 'text', list: true, width: 140 },
      { name: 'remark', label: '备注', type: 'textarea', span: 2 },
    ],
  },

  invoices: {
    label: '发票管理',
    icon: '🧾',
    order: 40,
    display: 'invoice_no',
    searchFields: ['invoice_no', 'remark'],
    fields: [
      { name: 'project_id', label: '所属项目', type: 'ref', refTable: 'projects', list: true, width: 200, required: true },
      { name: 'contract_id', label: '关联合同', type: 'ref', refTable: 'contracts', list: true, width: 180 },
      { name: 'partner_id', label: '对方单位', type: 'ref', refTable: 'partners', list: true, width: 170 },
      { name: 'direction', label: '销项/进项', type: 'select', options: INVOICE_DIRECTION, list: true, default: 'out', badge: true, required: true },
      { name: 'invoice_type', label: '发票种类', type: 'select', options: INVOICE_TYPE, list: true, default: '增值税专用发票' },
      { name: 'invoice_no', label: '发票号码', type: 'text', list: true, width: 140 },
      { name: 'issue_date', label: '开票日期', type: 'date', list: true, required: true },
      { name: 'amount', label: '金额(不含税)', type: 'money', list: true, required: true },
      { name: 'tax_rate', label: '税率(%)', type: 'number', list: true, default: 9, step: 0.01 },
      { name: 'tax_amount', label: '税额', type: 'money', list: true, calc: true },
      { name: 'total_amount', label: '价税合计', type: 'money', list: true, calc: true },
      // 虚拟列：由收付款里"对应发票"指向本张发票的记录自动汇总
      { name: 'paid_amount', label: '已收付', type: 'money', list: true, virtual: true, width: 108 },
      { name: 'unpaid_amount', label: '未收付', type: 'money', list: true, virtual: true, width: 108, danger: true },
      { name: 'status', label: '发票状态', type: 'select', options: INVOICE_STATUS, list: true, default: '已开具', badge: true },
      { name: 'remark', label: '备注', type: 'textarea', span: 2 },
    ],
  },

  expenses: {
    label: '项目费用',
    icon: '💸',
    order: 45,
    display: 'name',
    searchFields: ['name', 'remark'],
    fields: [
      { name: 'project_id', label: '所属项目', type: 'ref', refTable: 'projects', list: true, width: 190, required: true },
      { name: 'contract_id', label: '关联支出合同', type: 'ref', refTable: 'contracts', list: true, width: 180 },
      { name: 'category', label: '费用科目', type: 'select', options: EXPENSE_CATEGORY, list: true, default: '材料设备', badge: true },
      { name: 'name', label: '费用说明', type: 'text', list: true, width: 200, required: true },
      { name: 'amount', label: '金额(含税)', type: 'money', list: true, required: true },
      { name: 'tax_rate', label: '税率(%)', type: 'number', default: 0, step: 0.01 },
      { name: 'amount_ex_tax', label: '不含税金额', type: 'money', list: true, calc: true },
      { name: 'expense_date', label: '发生日期', type: 'date', list: true, required: true },
      { name: 'payee_id', label: '收款方', type: 'ref', refTable: 'partners', list: true, width: 150 },
      { name: 'has_invoice', label: '发票情况', type: 'select', options: EXPENSE_INVOICE, list: true, default: '有票' },
      { name: 'status', label: '付款状态', type: 'select', options: EXPENSE_STATUS, list: true, default: '已付', badge: true },
      { name: 'remark', label: '备注', type: 'textarea', span: 2 },
    ],
  },

  materials: {
    label: '材料设备清单',
    icon: '📦',
    order: 50,
    display: 'name',
    searchFields: ['name', 'brand', 'model', 'spec', 'remark'],
    fields: [
      { name: 'project_id', label: '所属项目', type: 'ref', refTable: 'projects', list: true, width: 190, required: true },
      { name: 'category', label: '类别', type: 'select', options: MATERIAL_CATEGORY, list: true, default: '设备' },
      { name: 'name', label: '名称', type: 'text', list: true, width: 190, required: true },
      { name: 'brand', label: '品牌', type: 'text', list: true, width: 100 },
      { name: 'model', label: '型号', type: 'text', list: true, width: 140 },
      { name: 'spec', label: '规格参数', type: 'text', list: true, width: 150 },
      { name: 'unit', label: '单位', type: 'text', list: true, width: 60, default: '台' },
      { name: 'quantity', label: '数量', type: 'number', list: true, default: 1 },
      { name: 'unit_price', label: '单价', type: 'money', list: true, default: 0 },
      { name: 'amount', label: '金额', type: 'money', list: true, calc: true },
      { name: 'supplier_id', label: '供应商', type: 'ref', refTable: 'partners', list: true, width: 150 },
      { name: 'contract_id', label: '关联采购合同', type: 'ref', refTable: 'contracts', width: 180 },
      { name: 'status', label: '采购状态', type: 'select', options: MATERIAL_STATUS, list: true, default: '待采购', badge: true },
      { name: 'remark', label: '备注', type: 'textarea', span: 2 },
    ],
  },

  maintenance: {
    label: '售后维修',
    icon: '🔧',
    order: 65,
    display: 'issue',
    searchFields: ['issue', 'reporter', 'handler', 'remark'],
    fields: [
      { name: 'project_id', label: '所属项目', type: 'ref', refTable: 'projects', list: true, width: 190, required: true },
      { name: 'report_date', label: '报修日期', type: 'date', list: true, required: true },
      { name: 'issue', label: '故障 / 问题', type: 'text', list: true, width: 220, required: true, span: 2 },
      { name: 'reporter', label: '报修人', type: 'text', list: true, width: 90 },
      { name: 'handler', label: '处理人', type: 'text', list: true, width: 90 },
      { name: 'in_warranty', label: '质保内/外', type: 'select', options: MAINT_WARRANTY, list: true, default: '质保内', badge: true },
      { name: 'status', label: '处理状态', type: 'select', options: MAINT_STATUS, list: true, default: '待处理', badge: true },
      { name: 'finish_date', label: '完成日期', type: 'date', list: true },
      { name: 'cost', label: '维修成本', type: 'money', list: true, default: 0 },
      { name: 'remark', label: '处理记录', type: 'textarea', span: 2 },
    ],
  },

  partners: {
    label: '往来单位',
    icon: '🏢',
    order: 60,
    display: 'name',
    searchFields: ['name', 'short_name', 'contact', 'phone', 'tax_no', 'remark'],
    fields: [
      { name: 'name', label: '单位名称', type: 'text', list: true, width: 240, required: true, span: 2 },
      { name: 'type', label: '单位类型', type: 'select', options: PARTNER_TYPE, list: true, default: '供应商', badge: true },
      { name: 'short_name', label: '简称', type: 'text', list: true, width: 100 },
      { name: 'contact', label: '联系人', type: 'text', list: true, width: 90 },
      { name: 'phone', label: '联系电话', type: 'text', list: true, width: 130 },
      { name: 'tax_no', label: '纳税人识别号', type: 'text', width: 200 },
      { name: 'bank', label: '开户银行', type: 'text' },
      { name: 'account', label: '银行账号', type: 'text' },
      { name: 'address', label: '单位地址', type: 'text', span: 2 },
      { name: 'remark', label: '备注', type: 'textarea', span: 2 },
    ],
  },
};

const TABLE_ORDER = Object.keys(TABLES).sort((a, b) => TABLES[a].order - TABLES[b].order);

module.exports = {
  TABLES,
  TABLE_ORDER,
  CATEGORY_DIRECTION,
  ENUMS: {
    PROJECT_STATUS, PROJECT_CATEGORY, PARTNER_TYPE, CONTRACT_CATEGORY, CONTRACT_STATUS,
    PAY_KIND, PAY_METHOD, INVOICE_TYPE, INVOICE_STATUS, MATERIAL_CATEGORY, MATERIAL_STATUS,
    SCHEDULE_PHASE, SCHEDULE_STATE, EXPENSE_CATEGORY, EXPENSE_STATUS, EXPENSE_INVOICE,
    MAINT_STATUS, MAINT_WARRANTY, CHANGE_TYPE, CHANGE_STATUS,
  },
};
