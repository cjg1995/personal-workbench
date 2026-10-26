"""Development-only template distillation. Never invoked by the installed app."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree as E

parser = argparse.ArgumentParser()
parser.add_argument('source')
parser.add_argument('output')
args = parser.parse_args()
source, output = Path(args.source), Path(args.output)
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'}
W = '{' + ns['w'] + '}'
with ZipFile(source) as archive:
    parts = {name: archive.read(name) for name in archive.namelist() if not name.endswith('/')}
doc = E.fromstring(parts['word/document.xml'])
body = doc.find(W + 'body')
original = list(body)
extent = original[1].find('.//wp:extent', ns)
width, height = int(extent.get('cx')) // 635, int(extent.get('cy')) // 635
contract=output.parent.parent/'.spike'/'artifact.md'
contract.parent.mkdir(parents=True,exist_ok=True)
contract.write_text(f'''# 月报模板执行约定

原件 `{source}`，SHA256 `{hashlib.sha256(source.read_bytes()).hexdigest()}`，只读保留。
Word 16.0 实际打开为 2 页；参考渲染位于 `.spike/reference-1.png`、`.spike/reference-2.png`，已逐页查看。
一节 A4 11906 × 16838 twips，上下边距 1440，左右 1800，页眉 851、页脚 992，单栏，行网格 312。
源正文位置以 word/document.xml 的 body 子元素从 0 开始编号。

保留第 0 段工作成果、第 2 段主要工作、第 8 段其他、第 26—28 段学习、计划、建议章节；保留其 pPr/rPr、编号、字体、行距和缩进。
源第 3、9、29 段作为可编辑正文原型，仅保留格式；原正文分别替换为五个章节槽位，允许克隆原型扩展条目，换行留在条目内。
第 1 段九月数据截图明确清除，按 2026-10-26 用户新决定，只保留一个可编辑空行供粘贴截图，不保留大表格。
删除原图片关系和图片字节。不保留顶部月份姓名标题，禁止遗留九月业务正文或“无”。
其余段落为旧业务内容或多余空段，清除。原节设置完整保留，正文长度改变允许自然分页，不能缩小字体填充。
样式、编号、主题、字体表、文档设置及其他未涉及的包部件保持原始字节；只改 document.xml、其图片关系，移除旧图片。
槽位为主要工作、其他、个人学习和成长、个人工作计划、学习目标、部门工作中存在问题及改进建议。段落定位由实际 XML 的 marker 文本确定；五章节不得缺失。
输出需检查中文、多段、特殊符号、编号、原图空白位置、所有章节及可编辑性。无素材章节留空。源 SHA256 在完成后重新核对。
''',encoding='utf-8')

def text_paragraph(prototype, text):
    p = copy.deepcopy(prototype)
    first = p.find(W + 'r')
    properties = copy.deepcopy(first.find(W + 'rPr')) if first is not None and first.find(W + 'rPr') is not None else None
    for child in list(p):
        if child.tag != W + 'pPr':
            p.remove(child)
    r = E.SubElement(p, W + 'r')
    if properties is not None:
        r.append(properties)
    E.SubElement(r, W + 't').text = text
    return p

# Current user decision: no report title, and one editable blank paragraph for a screenshot.
blank = text_paragraph(original[29], '')
blank_properties = blank.find(W + 'pPr')
if blank_properties is not None:
    for child in list(blank_properties):
        if child.tag in [W+'numPr', W+'ind', W+'spacing']:
            blank_properties.remove(child)
new_body=[copy.deepcopy(original[0]),blank,copy.deepcopy(original[2]),text_paragraph(original[3],'{{主要工作}}'),copy.deepcopy(original[8]),text_paragraph(original[9],'{{其他}}'),copy.deepcopy(original[26]),text_paragraph(original[29],'{{个人学习和成长}}'),copy.deepcopy(original[27]),text_paragraph(original[29],'{{个人工作计划、学习目标}}'),copy.deepcopy(original[28]),text_paragraph(original[29],'{{部门工作中存在问题及改进建议}}'),copy.deepcopy(original[-1])]
for child in list(body):body.remove(child)
for child in new_body:body.append(child)
parts['word/document.xml']=E.tostring(doc,encoding='UTF-8',xml_declaration=True,standalone=True)
rels_name='word/_rels/document.xml.rels'
rels=E.fromstring(parts[rels_name])
for rel in list(rels):
    if rel.get('Type','').endswith('/image'):
        target=rel.get('Target','')
        parts.pop('word/'+target,None)
        rels.remove(rel)
parts[rels_name]=E.tostring(rels,encoding='UTF-8',xml_declaration=True,standalone=True)
output.parent.mkdir(parents=True,exist_ok=True)
with ZipFile(output,'w',ZIP_DEFLATED) as archive:
    for name,data in parts.items():archive.writestr(name,data)
inventory={name:{'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()} for name,data in parts.items()}
output.with_suffix('.inventory.json').write_text(json.dumps({'source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'imageSlot':'one-blank-paragraph','parts':inventory},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'output':str(output),'imageSlot':'one-blank-paragraph','parts':len(parts)},ensure_ascii=False))
