# -*- coding: utf-8 -*-
"""
生成导入功能测试用的样例文件（xlsx / csv）。
只在需要重新生成素材时运行：
    python tools/fixtures/make-fixtures.py
"""
import os
from openpyxl import Workbook

HERE = os.path.dirname(os.path.abspath(__file__))


def save_partners():
    """往来单位 —— 用 xlsx，验证共享字符串 + 中文"""
    wb = Workbook()
    ws = wb.active
    ws.title = "往来单位"
    ws.append(["单位名称", "单位类型", "简称", "联系人", "联系电话", "备注"])
    ws.append(["测试甲方建设集团有限公司", "甲方", "测试甲方", "王主任", "13900001111", "导入测试数据"])
    ws.append(["测试供应商科技有限公司", "供应商", "测试供应商", "李经理", "13900002222", "导入测试数据"])
    ws.append(["测试分包劳务有限公司", "分包商", "测试分包", "赵工", "13900003333", "导入测试数据"])
    wb.save(os.path.join(HERE, "import-partners.xlsx"))


def save_projects():
    """项目 —— 用 xlsx，含日期单元格（Excel 日期序列号）"""
    from datetime import date
    wb = Workbook()
    ws = wb.active
    ws.append(["项目编号", "项目名称", "甲方单位", "子系统类别", "项目状态",
               "项目经理", "完工进度", "开工日期", "竣工日期", "项目地点", "备注"])
    ws.append(["TEST-IMP-001", "测试项目·智慧园区弱电工程", "测试甲方建设集团有限公司", "安防监控",
               "进行中", "测试员甲", 30, date(2026, 1, 10), date(2026, 11, 30), "测试市测试路 1 号", "导入测试数据"])
    ws.append(["TEST-IMP-002", "测试项目·办公楼机房改造", "测试甲方建设集团有限公司", "机房工程",
               "未开工", "测试员乙", 0, "2026/3/1", "2026年9月30日", "测试市测试路 2 号", "导入测试数据"])
    wb.save(os.path.join(HERE, "import-projects.xlsx"))


def save_contracts_csv():
    """合同 —— 两份内容相同的 CSV：一份 GBK（中文 Excel「另存为 CSV」的默认编码），一份 UTF-8，验证两种编码都能读"""
    header = "合同编号,合同名称,所属项目,合同类别,收支方向,对方单位,合同金额,税率,签订日期,合同状态,付款条款"
    rows = [
        "TEST-HT-001,测试项目智慧园区施工合同,测试项目·智慧园区弱电工程,项目合同,收入,测试甲方建设集团有限公司,"
        "\"2,180,000.00\",9,2026-01-05,执行中,\"预付款30%，验收款65%，质保金5%\"",
        "TEST-CG-001,测试监控设备采购合同,测试项目·智慧园区弱电工程,采购合同,支出,测试供应商科技有限公司,"
        "\"1,130,000.00\",13,2026-01-08,执行中,\"预付40%，到货50%，质保10%\"",
    ]
    body = header + "\r\n" + "\r\n".join(rows) + "\r\n"
    # GBK：不带 BOM（GBK 编不出 U+FEFF）
    with open(os.path.join(HERE, "import-contracts-gbk.csv"), "w", encoding="gbk", newline="") as f:
        f.write(body)
    # UTF-8：带 BOM，和 Excel 的「CSV UTF-8」一致
    with open(os.path.join(HERE, "import-contracts-utf8.csv"), "w", encoding="utf-8-sig", newline="") as f:
        f.write(body)


if __name__ == "__main__":
    save_partners()
    save_projects()
    save_contracts_csv()
    print("已生成：import-partners.xlsx / import-projects.xlsx / import-contracts.csv")
