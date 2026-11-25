#!/usr/bin/env python3
"""生成实验室劳务费发放表（xlsx）到 ~/Downloads，供微信发送财务。

以 data/labor/template.xlsx 为格式模板（列结构/字体/列宽与历史发放表一致）：
  A1:I1 合并标题「{owner}实验室{M}月津贴发放清单」
  行2表头：序号/姓名/硕/博/学号/导师/课题指导老师/工作内容/津贴等级
  行3起数据，模板预填序号 1..11；名单写入 B/C/D/E/G/H，多余序号行清空

stdout 输出 JSON 行进度（供观自在 /api/labor/generate 展示）：
  {"ok":true,"path":"...","rows":N,"total":1200}
"""

import argparse
import json
import re
import os
import tempfile
from pathlib import Path

from openpyxl import load_workbook

from receipt_runtime import DATA_ROOT

ROOT = DATA_ROOT
TEMPLATE = ROOT / 'data' / 'labor' / 'template.xlsx'
ROSTER = ROOT / 'data' / 'labor' / 'roster.json'
DEFAULT_OUTPUT = Path.home() / 'Downloads'

# 模板列（1-based）：B姓名 C硕/博 D学号 E导师 G工作内容 H津贴等级(金额) I备注
COL_NAME, COL_DEGREE, COL_STUDENT_ID, COL_ADVISOR, COL_WORK, COL_AMOUNT, COL_NOTE = 2, 3, 4, 5, 7, 8, 9
DATA_START_ROW = 3
TEMPLATE_SEQ_ROWS = 11  # 模板预填的序号行数


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def load_roster() -> list[dict]:
    if not ROSTER.exists():
        return []
    doc = json.loads(ROSTER.read_text(encoding='utf-8'))
    return [m for m in doc.get('members', []) if str(m.get('name', '')).strip()]


def to_number(student_id: str):
    """纯数字学号转 int（与模板一致），否则原样字符串。"""
    text = str(student_id).strip()
    return int(text) if re.fullmatch(r'\d{1,15}', text) else text


def generate(month: str, owner: str, out_dir: Path, members: list[dict]) -> Path:
    if not members:
        raise RuntimeError('名单为空——请先在弹窗中添加人员并保存')
    if not TEMPLATE.exists():
        raise RuntimeError(f'缺少模板 {TEMPLATE}')

    year, mon = (int(p) for p in month.split('-'))
    ws_title = f'{owner}实验室{mon}月津贴发放清单'

    # 模板加载 → 重写标题与数据行 → 原子写出到目标
    wb = load_workbook(TEMPLATE)
    ws = wb.worksheets[0]
    ws.cell(row=1, column=1, value=ws_title)

    rows = DATA_START_ROW
    for index, member in enumerate(members, start=1):
        if rows > ws.max_row:  # 名单超出模板序号行：补行并复制上一行样式
            ws.insert_rows(rows)
            for col in range(1, 10):
                src, dst = ws.cell(row=rows - 1, column=col), ws.cell(row=rows, column=col)
                dst._style = src._style
            ws.cell(row=rows, column=1, value=rows - DATA_START_ROW + 1)
        ws.cell(row=rows, column=COL_NAME, value=str(member.get('name', '')).strip())
        ws.cell(row=rows, column=COL_DEGREE, value=str(member.get('degree', '')).strip())
        ws.cell(row=rows, column=COL_STUDENT_ID, value=to_number(member.get('studentId', '')))
        ws.cell(row=rows, column=COL_ADVISOR, value=str(member.get('advisor', '') or owner).strip())
        ws.cell(row=rows, column=COL_WORK, value=str(member.get('workContent', '')).strip())
        amount = member.get('amount', 0)
        ws.cell(row=rows, column=COL_AMOUNT, value=amount if isinstance(amount, (int, float)) else 0)
        ws.cell(row=rows, column=COL_NOTE, value=str(member.get('note', '') or '').strip())
        rows += 1

    # 清掉多余预填序号行内容（保留行与格式，与历史表观感一致）
    while rows <= ws.max_row:
        for col in range(2, 10):
            ws.cell(row=rows, column=col, value=None)
        rows += 1

    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f'实验室学生津贴发放情况表-{owner}.xlsx'
    fd, tmp_name = tempfile.mkstemp(suffix='.xlsx', dir=str(out_dir))
    os.close(fd)
    temporary = Path(tmp_name)
    try:
        wb.save(temporary)
        temporary.replace(target)
    finally:
        wb.close()
        temporary.unlink(missing_ok=True)
    return target


def main():
    today_parser = argparse.ArgumentParser(description='生成实验室劳务费发放表')
    today_parser.add_argument('--month', required=True, help='YYYY-MM')
    today_parser.add_argument('--owner', default='', help='导师/负责人姓名（标题与导师列）')
    today_parser.add_argument('--out-dir', default=str(DEFAULT_OUTPUT))
    args = today_parser.parse_args()

    members = load_roster()
    target = generate(args.month, args.owner.strip(), Path(args.out_dir), members)
    total = sum(float(m.get('amount', 0) or 0) for m in members if str(m.get('name', '')).strip())
    emit({'ok': True, 'path': str(target), 'rows': len(members), 'total': round(total, 2)})


if __name__ == '__main__':
    main()
