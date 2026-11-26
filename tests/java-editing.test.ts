import assert from "node:assert/strict";
import test from "node:test";
import { completeJavaStatement, expandJavaOutput, javaCallArguments, preserveJavaCallSuffix, type JavaEdit } from "../src/renderer/java-editing.js";

function atCaret(example: string) {
  const offset = example.indexOf("|");
  assert.notEqual(offset, -1);
  return { source: example.slice(0, offset) + example.slice(offset + 1), offset };
}

function apply(source: string, edit: JavaEdit | undefined) {
  if (!edit) return;
  const result = source.slice(0, edit.from) + edit.text + source.slice(edit.to);
  return result.slice(0, edit.cursor) + "|" + result.slice(edit.cursor);
}

function inMethod(statement: string) {
  return "class Example {\n  void run() {\n    " + statement + "\n  }\n}";
}

test("Java 语句补全沿语法结构补分号、收合括号，并保留行尾注释和后续语句", () => {
  const cases = [
    ['print("literal );")| // keep', 'print("literal );"); // keep\n    |'],
    ["print(Math.max(1, 2|", "print(Math.max(1, 2));\n    |"],
    ["return items[0|", "return items[0];\n    |"],
    ["print(\n        1,|\n        2\n    )", "print(\n        1,\n        2\n    );\n    |"],
    ["run();|", "run();\n    |"],
    ["run()|\n    keep();", "run();\n    |\n    keep();"],
    ["int[] xs = {1, 2}|", "int[] xs = {1, 2};\n    |"],
  ];
  for (const [input, expected] of cases) {
    const { source, offset } = atCaret(inMethod(input));
    assert.equal(apply(source, completeJavaStatement(source, offset, "  ", "\n")), inMethod(expected), input);
  }
});

test("Java 语句补全生成控制块和方法体，空条件保留输入位置", () => {
  const cases = [
    ["if|", "if (|) {\n      \n    }"],
    ["if (ready)| // condition", "if (ready) { // condition\n      |\n    }"],
    ["if (ready)| {}", "if (ready) {\n      |\n    }"],
    ["if (ready)|\n      run();", "if (ready)\n      |run();"],
    ["if (ready) {} else|", "if (ready) {} else {\n      |\n    }"],
    ["for (int i = 0; i < 3; i++|", "for (int i = 0; i < 3; i++) {\n      |\n    }"],
    ["for (String item : items|", "for (String item : items) {\n      |\n    }"],
    ["try {} catch (Exception ex|", "try {} catch (Exception ex) {\n      |\n    }"],
  ];
  for (const [input, expected] of cases) {
    const { source, offset } = atCaret(inMethod(input));
    assert.equal(apply(source, completeJavaStatement(source, offset, "  ", "\n")), inMethod(expected), input);
  }
  const { source, offset } = atCaret("class Example {\r\n\tvoid run(|\r\n}");
  assert.equal(apply(source, completeJavaStatement(source, offset, "\t", "\r\n")), "class Example {\r\n\tvoid run() {\r\n\t\t|\r\n\t}\r\n}");
  const signature = atCaret("interface Example {\n  void run(|\n}");
  assert.equal(apply(signature.source, completeJavaStatement(signature.source, signature.offset, "  ", "\n")),
    "interface Example {\n  void run();\n  |\n}");
});

test("Java 输出模板只在可执行语句展开，并把光标放入输出内容", () => {
  for (const [input, expected] of [
    ["sout|; // note", "System.out.println(|); // note"],
    ["serr|", "System.err.println(|);"],
    ["souf|", 'System.out.printf("|");'],
  ]) {
    const { source, offset } = atCaret(inMethod(input));
    assert.equal(apply(source, expandJavaOutput(source, offset)), inMethod(expected));
  }
  for (const input of ['// sout|', '"sout|"', "obj.sout|", "print(sout|)", "xsout|", "sout|Value"]) {
    const { source, offset } = atCaret(inMethod(input));
    assert.equal(expandJavaOutput(source, offset), undefined, input);
  }
  const wrongContext = atCaret("class Example { sout| }");
  assert.equal(expandJavaOutput(wrongContext.source, wrongContext.offset), undefined);
});

test("参数提示可从调用右括号回到参数区域", () => {
  const { source, offset } = atCaret(inMethod("this.clear();|"));
  assert.equal(javaCallArguments(source, offset), offset - 2);
  const condition = atCaret(inMethod("if (ready)| {}"));
  assert.equal(javaCallArguments(condition.source, condition.offset), undefined);
  const start = atCaret(inMethod("print|(value);"));
  assert.equal(javaCallArguments(start.source, start.offset), start.offset + 1);
});

test("方法补全复用已经输入的参数列表或分号", () => {
  assert.equal(preserveJavaCallSuffix("clear();", "();"), "clear");
  assert.equal(preserveJavaCallSuffix('send(${1:value})', '(existingValue)'), "send");
  assert.equal(preserveJavaCallSuffix('send(${1:value});', ';'), 'send(${1:value})');
  assert.equal(preserveJavaCallSuffix("clear();", ""), "clear();");
});
