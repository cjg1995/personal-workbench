import test from "node:test";
import assert from "node:assert/strict";
import {
  formatNoteLabel,
  formatNotePreview,
  formatNoteText,
} from "../src/shared/note-text.js";

test("记录文本展示保留句号、冒号与多行原文，不再误拆分标题与正文", () => {
  const twoSentences =
    "楼盘性质添加军产房、人才房。客户来源添加一个‘驻点客户’。";
  assert.equal(formatNoteText(twoSentences), twoSentences);
  assert.equal(formatNotePreview(twoSentences), twoSentences);
  assert.equal(formatNoteLabel(twoSentences), twoSentences);

  const withColon =
    "需求排查：客户来源与楼盘性质字段核对完毕，确认无需额外迁移历史数据。";
  assert.equal(formatNoteText(withColon), withColon);
  assert.equal(formatNotePreview(withColon), withColon);

  const longSingle =
    "商务经理统计分析演练数为0但到店明细有演练时间问题查找（主界面按申请到店时间查询，到店明细按最早的演练时间，修复后保持完全一致）";
  assert.equal(formatNoteText(longSingle), longSingle);
});

test("记录文本统一换行与首尾空白，列表预览压缩空行且标签保持单行", () => {
  const multiline = "  第一项工作内容\r\n\r\n  第二项工作内容  \r\n ";
  assert.equal(formatNoteText(multiline), "第一项工作内容\n\n  第二项工作内容");
  assert.equal(
    formatNotePreview(multiline),
    "第一项工作内容\n第二项工作内容",
  );
  assert.equal(
    formatNoteLabel(multiline),
    "第一项工作内容 第二项工作内容",
  );

  assert.equal(formatNoteText(""), "");
  assert.equal(formatNotePreview("   \r\n  "), "");
  assert.equal(formatNoteLabel("   "), "");
});
