#!/usr/bin/env python3
"""
info_extract.py - 信息提取工具

用法: python info_extract.py <文档路径> [提取类型]

提取类型:
  contract  - 合同文档（默认）
  resume    - 简历
  report    - 报告
  general   - 通用

输出 JSON 结构:
{
  "ok": true,
  "expert": { "name": "信息提取专家", "title": "...", "description": "..." },
  "configConfirmed": true,
  "steps": [
    { "id": "step_1", "title": "步骤标题", "description": "步骤描述", "status": "completed|running|pending" }
  ]
}
"""

import json
import sys
import os
from pathlib import Path


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: info_extract.py <path> [extraction_type]"}))
        sys.exit(1)

    doc_path = sys.argv[1]
    extraction_type = sys.argv[2] if len(sys.argv) > 2 else "contract"

    # 验证文件存在
    if not os.path.exists(doc_path):
        print(json.dumps({"ok": False, "error": f"File not found: {doc_path}"}))
        sys.exit(1)

    # 根据提取类型生成执行步骤
    step_definitions = {
        "contract": [
            {
                "id": "step_1",
                "title": "合同类型识别",
                "description": "自动识别合同类型与结构",
                "status": "completed"
            },
            {
                "id": "step_2",
                "title": "关键信息提取",
                "description": "提取合同各方信息、核心条款与关键日期",
                "status": "running"
            }
        ],
        "resume": [
            {
                "id": "step_1",
                "title": "简历结构识别",
                "description": "识别简历结构（教育经历、工作经历、技能等）",
                "status": "completed"
            },
            {
                "id": "step_2",
                "title": "关键信息提取",
                "description": "提取个人信息、工作经历、教育背景和技能",
                "status": "running"
            }
        ],
        "report": [
            {
                "id": "step_1",
                "title": "报告结构识别",
                "description": "识别报告章节结构与数据类型",
                "status": "completed"
            },
            {
                "id": "step_2",
                "title": "关键信息提取",
                "description": "提取核心数据、结论和建议",
                "status": "running"
            }
        ],
        "general": [
            {
                "id": "step_1",
                "title": "文档结构分析",
                "description": "分析文档结构与内容类型",
                "status": "completed"
            },
            {
                "id": "step_2",
                "title": "关键信息提取",
                "description": "提取文档中的关键信息",
                "status": "running"
            }
        ]
    }

    expert_configs = {
        "contract": {
            "name": "信息提取专家",
            "title": "合同信息提取",
            "description": "专注于合同文档的关键信息提取，包括各方信息、核心条款、关键日期等。"
        },
        "resume": {
            "name": "简历信息提取专家",
            "title": "简历信息提取",
            "description": "专注于简历文档的信息提取，包括教育经历、工作经历、技能等。"
        },
        "report": {
            "name": "报告信息提取专家",
            "title": "报告信息提取",
            "description": "专注于报告文档的信息提取，包括核心数据、结论和建议。"
        },
        "general": {
            "name": "信息提取专家",
            "title": "通用信息提取",
            "description": "通用的文档信息提取专家，自动识别文档类型并提取关键信息。"
        }
    }

    file_name = os.path.basename(doc_path)

    result = {
        "ok": True,
        "expert": expert_configs.get(extraction_type, expert_configs["general"]),
        "configConfirmed": True,
        "sourceDocument": file_name,
        "extractionType": extraction_type,
        "steps": step_definitions.get(extraction_type, step_definitions["general"])
    }

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
