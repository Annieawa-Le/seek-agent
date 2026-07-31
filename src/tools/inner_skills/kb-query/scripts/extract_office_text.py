#!/usr/bin/env python3
"""
提取 Office 文档（.docx / .pptx）中的纯文本内容。
依赖: Python 标准库 (zipfile + xml.etree.ElementTree)，无需额外安装。

用法:
    python extract_office_text.py <文件路径>
输出:
    JSON: {"text": "...全文...", "error": null} 或 {"text": "", "error": "错误信息"}
"""

import json
import sys
import zipfile
import xml.etree.ElementTree as ET


def extract_docx(path: str) -> str:
    """提取 .docx 中的所有文本"""
    texts: list[str] = []
    with zipfile.ZipFile(path, 'r') as z:
        # word/document.xml 是主文档体
        if 'word/document.xml' not in z.namelist():
            raise ValueError('不是有效的 .docx 文件（缺少 word/document.xml）')

        # 解析主文档
        tree = ET.parse(z.open('word/document.xml'))
        root = tree.getroot()

        # 注册命名空间
        ns = {
            'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        }

        # 提取所有 <w:t> 标签中的文本
        for t in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'):
            if t.text:
                texts.append(t.text)

            # <w:br/> 换行符
            for br in t.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}br'):
                texts.append('\n')

        # 段落结束加换行
        result = ''
        for p in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'):
            para_text = ''
            for t in p.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'):
                if t.text:
                    para_text += t.text
            if para_text:
                result += para_text + '\n'

        return result


def extract_pptx(path: str) -> str:
    """提取 .pptx 中的所有文本"""
    texts: list[str] = []
    with zipfile.ZipFile(path, 'r') as z:
        # 获取所有幻灯片文件
        slide_files = sorted([f for f in z.namelist() if f.startswith('ppt/slides/slide') and f.endswith('.xml')])

        if not slide_files:
            raise ValueError('不是有效的 .pptx 文件（未找到幻灯片）')

        ns = {
            'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
        }

        for slide_file in slide_files:
            tree = ET.parse(z.open(slide_file))
            root = tree.getroot()

            slide_texts: list[str] = []
            # 提取所有 <a:t> 标签中的文本
            for t in root.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t'):
                if t.text:
                    slide_texts.append(t.text)

            if slide_texts:
                texts.append(' '.join(slide_texts))

    return '\n\n'.join(texts)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'text': '', 'error': '用法: extract_office_text.py <文件路径>'}))
        sys.exit(1)

    file_path = sys.argv[1].strip()
    ext = file_path.lower().rsplit('.', 1)[-1] if '.' in file_path else ''

    try:
        if ext == 'docx':
            text = extract_docx(file_path)
        elif ext == 'pptx':
            text = extract_pptx(file_path)
        else:
            print(json.dumps({'text': '', 'error': f'不支持的文件格式: .{ext}'}))
            sys.exit(1)

        print(json.dumps({'text': text, 'error': None}))
    except Exception as e:
        print(json.dumps({'text': '', 'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
