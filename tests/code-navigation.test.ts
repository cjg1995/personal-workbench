import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { EditorFiles } from "../src/core/editor-files.js";
import { resolveCodeNavigation } from "../src/core/code-navigation.js";

function writeFiles(root: string, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

function positionOf(text: string, needle: string, occurrence = 1): { line: number; column: number } {
  let index = -1;
  let from = 0;
  for (let i = 0; i < occurrence; i++) {
    index = text.indexOf(needle, from);
    assert.ok(index >= 0, `未找到定位片段：${needle}`);
    from = index + needle.length;
  }
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 2 };
}

test("Java 符号解析：本页重载方法、字段/局部变量、跨页 DAO/静态泛型工具/父类继承/接口与实现", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pw-nav-java-"));
  const editorFiles = new EditorFiles();
  try {
    const serviceImplFile = "src/com/house/home/serviceImpl/wecom/WeComGroupChatServiceImpl.java";
    const serviceImplText = [
      "package com.house.home.serviceImpl.wecom;",
      "",
      "import java.util.List;",
      "import java.util.Map;",
      "import com.alibaba.fastjson.JSONObject;",
      "import com.house.framework.commons.utils.CollectionUtils;",
      "import com.house.home.dao.wecom.WeComGroupChatUserDao;",
      "import com.house.home.entity.wecom.WeComGroupChatUser;",
      "import com.house.home.service.BaseServiceImpl;",
      "import com.house.home.service.wecom.WeComSyncHelperService;",
      "import static com.house.home.service.wecom.WeComConstants.DEFAULT_ROLE;",
      "",
      "public class WeComGroupChatServiceImpl extends BaseServiceImpl {",
      "  private static final String INTERNAL_GROUP_ASSISTANT_USER_ID = \"assistant\";",
      "  private WeComGroupChatUserDao weComGroupChatUserDao;",
      "  private WeComSyncHelperService syncHelperService;",
      "",
      "  public void sync(String roomId, JSONObject groupChat) {",
      "    saveOrUpdate(roomId);",
      "    List<WeComGroupChatUser> oldMemberList = weComGroupChatUserDao.findAllByChatId(roomId);",
      "    Map<String, WeComGroupChatUser> oldMemberMap = CollectionUtils.<String, WeComGroupChatUser>convertToMap(oldMemberList, \"userId\");",
      "    saveOrUpdateGroupChatMember(roomId, groupChat, \"1\", oldMemberMap);",
      "    syncHelperService.dispatchSync(roomId);",
      "    String role = DEFAULT_ROLE;",
      "    Object val = oldMemberMap.get(INTERNAL_GROUP_ASSISTANT_USER_ID);",
      "    Object created = groupChat.getLong(\"room_create_time\");",
      "  }",
      "",
      "  private void saveOrUpdateGroupChatMember(String roomId) {}",
      "",
      "  private void saveOrUpdateGroupChatMember(String roomId, JSONObject member, String type, Map<String, WeComGroupChatUser> oldMap) {",
      "    String id = INTERNAL_GROUP_ASSISTANT_USER_ID;",
      "  }",
      "}",
    ].join("\n");

    writeFiles(root, {
      [serviceImplFile]: serviceImplText,
      "src/com/house/home/dao/wecom/WeComGroupChatUserDao.java": [
        "package com.house.home.dao.wecom;",
        "import java.util.List;",
        "import com.house.home.entity.wecom.WeComGroupChatUser;",
        "public class WeComGroupChatUserDao {",
        "  public List<WeComGroupChatUser> findAllByChatId(String chatId) {",
        "    return null;",
        "  }",
        "}",
      ].join("\n"),
      "src/com/house/home/entity/wecom/WeComGroupChatUser.java": [
        "package com.house.home.entity.wecom;",
        "public class WeComGroupChatUser {",
        "  public WeComGroupChatUser(String userId) {}",
        "}",
      ].join("\n"),
      "src/com/house/framework/commons/utils/CollectionUtils.java": [
        "package com.house.framework.commons.utils;",
        "import java.util.List;",
        "import java.util.Map;",
        "public class CollectionUtils {",
        "  public static <K, V> Map<K, V> convertToMap(List<V> list) { return null; }",
        "  public static <K, V> Map<K, V> convertToMap(List<V> list, String keyField) { return null; }",
        "}",
      ].join("\n"),
      "src/com/house/home/service/BaseServiceImpl.java": [
        "package com.house.home.service;",
        "public class BaseServiceImpl {",
        "  public void saveOrUpdate(Object entity) {}",
        "}",
      ].join("\n"),
      "src/com/house/home/service/wecom/WeComSyncHelperService.java": [
        "package com.house.home.service.wecom;",
        "public interface WeComSyncHelperService {",
        "  void dispatchSync(String roomId);",
        "}",
      ].join("\n"),
      "src/com/house/home/serviceImpl/wecom/WeComSyncHelperServiceImpl.java": [
        "package com.house.home.serviceImpl.wecom;",
        "import com.house.home.service.wecom.WeComSyncHelperService;",
        "public class WeComSyncHelperServiceImpl implements WeComSyncHelperService {",
        "  @Override",
        "  public void dispatchSync(String roomId) {",
        "  }",
        "}",
      ].join("\n"),
      "src/com/house/home/service/wecom/WeComConstants.java": [
        "package com.house.home.service.wecom;",
        "public class WeComConstants {",
        "  public static final String DEFAULT_ROLE = \"1\";",
        "}",
      ].join("\n"),
    });

    // 1. 本页调用（且精准匹配 4 参数重载而非 1 参数重载）
    {
      const pos = positionOf(serviceImplText, "saveOrUpdateGroupChatMember(roomId, groupChat");
      const res = await resolveCodeNavigation({
        root, file: serviceImplFile, text: serviceImplText, line: pos.line, column: pos.column,
      }, editorFiles);
      assert.equal(res.symbol, "saveOrUpdateGroupChatMember");
      assert.equal(res.targets.length, 1);
      assert.equal(res.targets[0].sameFile, true);
      assert.equal(res.targets[0].line, 31);
    }

    // 2. 旧版本快照（如 HEAD 左侧面板行数与磁盘不同）按当前缓冲区文本定位
    {
      const olderSnapshot = "\n\n\n" + serviceImplText;
      const pos = positionOf(olderSnapshot, "saveOrUpdateGroupChatMember(roomId, groupChat");
      const res = await resolveCodeNavigation({
        root, file: serviceImplFile, text: olderSnapshot, line: pos.line, column: pos.column, allowLsp: false,
      }, editorFiles);
      assert.equal(res.targets.length, 1);
      assert.equal(res.targets[0].sameFile, true);
      assert.equal(res.targets[0].line, 34);
    }

    // 3. 跨页字段调用：weComGroupChatUserDao.findAllByChatId(roomId)
    {
      const pos = positionOf(serviceImplText, "findAllByChatId");
      const res = await resolveCodeNavigation({
        root, file: serviceImplFile, text: serviceImplText, line: pos.line, column: pos.column,
      }, editorFiles);
      assert.equal(res.targets.length, 1);
      assert.equal(res.targets[0].sameFile, false);
      assert.equal(res.targets[0].file, "src/com/house/home/dao/wecom/WeComGroupChatUserDao.java");
      assert.equal(res.targets[0].line, 5);
    }

    // 4. 跨页静态泛型调用：CollectionUtils.<String, WeComGroupChatUser>convertToMap(..., ...)
    {
      const pos = positionOf(serviceImplText, "convertToMap");
      const res = await resolveCodeNavigation({
        root, file: serviceImplFile, text: serviceImplText, line: pos.line, column: pos.column,
      }, editorFiles);
      assert.equal(res.targets.length, 1);
      assert.equal(res.targets[0].sameFile, false);
      assert.equal(res.targets[0].file, "src/com/house/framework/commons/utils/CollectionUtils.java");
      assert.equal(res.targets[0].line, 6);
    }

    // 5. 父类继承方法：saveOrUpdate(roomId) -> BaseServiceImpl
    {
      const pos = positionOf(serviceImplText, "saveOrUpdate(roomId)");
      const res = await resolveCodeNavigation({
        root, file: serviceImplFile, text: serviceImplText, line: pos.line, column: pos.column,
      }, editorFiles);
      assert.equal(res.targets.length, 1);
      assert.equal(res.targets[0].sameFile, false);
      assert.equal(res.targets[0].file, "src/com/house/home/service/BaseServiceImpl.java");
      assert.equal(res.targets[0].line, 3);
    }

    // 6. 接口方法：默认同时列出实现（排第一）和接口；kind="implementation" 直达实现
    {
      const pos = positionOf(serviceImplText, "dispatchSync");
      const defRes = await resolveCodeNavigation({
        root, file: serviceImplFile, text: serviceImplText, line: pos.line, column: pos.column, kind: "definition",
      }, editorFiles);
      assert.equal(defRes.targets.length, 2);
      assert.equal(defRes.targets[0].role, "implementation");
      assert.equal(defRes.targets[0].file, "src/com/house/home/serviceImpl/wecom/WeComSyncHelperServiceImpl.java");
      assert.equal(defRes.targets[0].line, 5);
      assert.equal(defRes.targets[1].role, "interface");
      assert.equal(defRes.targets[1].file, "src/com/house/home/service/wecom/WeComSyncHelperService.java");

      const implRes = await resolveCodeNavigation({
        root, file: serviceImplFile, text: serviceImplText, line: pos.line, column: pos.column, kind: "implementation",
      }, editorFiles);
      assert.equal(implRes.targets.length, 1);
      assert.equal(implRes.targets[0].file, "src/com/house/home/serviceImpl/wecom/WeComSyncHelperServiceImpl.java");
    }

    // 7. 静态导入常量与本页常量
    {
      const staticPos = positionOf(serviceImplText, "DEFAULT_ROLE", 2);
      const staticRes = await resolveCodeNavigation({
        root, file: serviceImplFile, text: serviceImplText, line: staticPos.line, column: staticPos.column,
      }, editorFiles);
      assert.equal(staticRes.targets.length, 1);
      assert.equal(staticRes.targets[0].file, "src/com/house/home/service/wecom/WeComConstants.java");
      assert.equal(staticRes.targets[0].line, 3);

      const fieldPos = positionOf(serviceImplText, "INTERNAL_GROUP_ASSISTANT_USER_ID", 2);
      const fieldRes = await resolveCodeNavigation({
        root, file: serviceImplFile, text: serviceImplText, line: fieldPos.line, column: fieldPos.column,
      }, editorFiles);
      assert.equal(fieldRes.targets.length, 1);
      assert.equal(fieldRes.targets[0].sameFile, true);
      assert.equal(fieldRes.targets[0].line, 14);
    }

    // 8. 外部依赖类（Map.get / JSONObject.getLong）不误匹配无关项目方法，给出明确提示
    {
      const pos = positionOf(serviceImplText, "getLong");
      const res = await resolveCodeNavigation({
        root, file: serviceImplFile, text: serviceImplText, line: pos.line, column: pos.column,
      }, editorFiles);
      assert.equal(res.targets.length, 0);
      assert.match(res.notice || "", /外部依赖/);
    }

    // 9. 光标已在定义处时不原地空跳
    {
      const pos = positionOf(serviceImplText, "saveOrUpdateGroupChatMember(String roomId)");
      const res = await resolveCodeNavigation({
        root, file: serviceImplFile, text: serviceImplText, line: pos.line, column: pos.column,
      }, editorFiles);
      assert.equal(res.targets.length, 0);
      assert.match(res.notice || "", /已是/);
    }

    // 10. LSP 协同：allowLsp=true 时外部依赖可借助已就绪 JDT LS 返回 jdt:// 虚拟源码
    {
      const pos = positionOf(serviceImplText, "getLong");
      const res = await resolveCodeNavigation(
        { root, file: serviceImplFile, text: serviceImplText, line: pos.line, column: pos.column, allowLsp: true },
        editorFiles,
        async () => [{ uri: "jdt://contents/fastjson.jar/JSONObject.class", range: { start: { line: 41, character: 15 } } }],
      );
      assert.equal(res.source, "lsp");
      assert.equal(res.targets.length, 1);
      assert.equal(res.targets[0].sameFile, false);
      assert.equal(res.targets[0].uri, "jdt://contents/fastjson.jar/JSONObject.class");
      assert.equal(res.targets[0].line, 42);
    }

    // 11. allowLsp=false 时不调用 LSP
    {
      let called = false;
      const pos = positionOf(serviceImplText, "getLong");
      await resolveCodeNavigation(
        { root, file: serviceImplFile, text: serviceImplText, line: pos.line, column: pos.column, allowLsp: false },
        editorFiles,
        async () => {
          called = true;
          return [{ uri: pathToFileURL(path.join(root, serviceImplFile)).href, range: { start: { line: 0, character: 0 } } }];
        },
      );
      assert.equal(called, false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Vue / TS / JS 符号解析：模板事件、本页函数、ES 命名导入别名、@/ 路径与命名空间调用", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pw-nav-web-"));
  const editorFiles = new EditorFiles();
  try {
    const vueFile = "src/pages/WeComChat.vue";
    const vueText = [
      "<template>",
      "  <button @click=\"handleSubmit\">保存</button>",
      "</template>",
      "<script setup lang=\"ts\">",
      "import { formatRoomTitle as fmtTitle } from \"../utils/format\";",
      "import wecomApi from \"@/api/wecom\";",
      "",
      "async function handleSubmit() {",
      "  const title = fmtTitle(\"room-1\");",
      "  await wecomApi.syncMembers(title);",
      "}",
      "</script>",
    ].join("\n");

    writeFiles(root, {
      [vueFile]: vueText,
      "src/utils/format.ts": [
        "export function formatRoomTitle(id: string) {",
        "  return id.trim();",
        "}",
      ].join("\n"),
      "src/api/wecom.ts": [
        "export default {",
        "  syncMembers(title: string) {",
        "    return Promise.resolve(title);",
        "  },",
        "};",
      ].join("\n"),
    });

    // 1. 模板事件 @click="handleSubmit" -> 跳到本页 <script> 中的 handleSubmit
    {
      const pos = positionOf(vueText, "handleSubmit");
      const res = await resolveCodeNavigation({
        root, file: vueFile, text: vueText, line: pos.line, column: pos.column,
      }, editorFiles);
      assert.equal(res.targets.length, 1);
      assert.equal(res.targets[0].sameFile, true);
      assert.equal(res.targets[0].line, 8);
    }

    // 2. 别名命名导入 fmtTitle -> 跳到 ../utils/format.ts 的 formatRoomTitle
    {
      const pos = positionOf(vueText, "fmtTitle", 2);
      const res = await resolveCodeNavigation({
        root, file: vueFile, text: vueText, line: pos.line, column: pos.column,
      }, editorFiles);
      assert.equal(res.targets.length, 1);
      assert.equal(res.targets[0].sameFile, false);
      assert.equal(res.targets[0].file, "src/utils/format.ts");
      assert.equal(res.targets[0].line, 1);
    }

    // 3. @/ 路径默认导入方法调用 wecomApi.syncMembers -> 跳到 src/api/wecom.ts
    {
      const pos = positionOf(vueText, "syncMembers");
      const res = await resolveCodeNavigation({
        root, file: vueFile, text: vueText, line: pos.line, column: pos.column,
      }, editorFiles);
      assert.equal(res.targets.length, 1);
      assert.equal(res.targets[0].sameFile, false);
      assert.equal(res.targets[0].file, "src/api/wecom.ts");
      assert.equal(res.targets[0].line, 2);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
