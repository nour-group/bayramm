import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/* Страж всего репозитория: в исходниках приложений (apps/*\/src, без тестов) нет системных
   контролов, которые заменяет набор @bayramm/ui/react. Разбор — компилятором TypeScript,
   а не регуляркой: многострочные теги, стрелочные функции в атрибутах и комментарии
   не дают ни пропусков, ни ложных срабатываний.

   Запрещено                              Вместо
   <select>, <datalist>                   Select
   <input type="checkbox|radio">          Checkbox, Switch, RadioGroup
   <input type="number|range">            NumberStepper
   <input type="date|month|week|…">       DateField
   <input type="time">                    TimeField
   <input type={выражение}>               литерал: иначе страж не видит тип
   <input type="file">                    FileDrop
   <input type="search">                  SearchField
   <dialog>, window.confirm/alert/prompt  ConfirmSheet, Dialog, useToast
   title="…" на элементе разметки         Tooltip */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const APPS = join(ROOT, "apps");

const FORBIDDEN_TAGS: Record<string, string> = {
  select: "Select",
  datalist: "Select",
  dialog: "Dialog / ConfirmSheet",
};

const FORBIDDEN_INPUTS: Record<string, string> = {
  checkbox: "Checkbox / Switch",
  radio: "RadioGroup",
  number: "NumberStepper",
  range: "NumberStepper",
  date: "DateField",
  time: "TimeField",
  "datetime-local": "DateField",
  month: "DateField",
  week: "DateField",
  color: "Select",
  file: "FileDrop",
  search: "SearchField",
};

const FORBIDDEN_CALLS: Record<string, string> = {
  confirm: "ConfirmSheet",
  alert: "useToast",
  prompt: "Dialog",
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}

const attribute = (element: ts.JsxOpeningLikeElement, name: string) =>
  element.attributes.properties.find(
    (prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText() === name,
  );

/** Значение атрибута, если оно строка: type="checkbox" или type={"checkbox"} */
function literal(attr: ts.JsxAttribute | undefined): string | null {
  const init = attr?.initializer;
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression))
    return init.expression.text;
  return null;
}

/** Нарушения в одном файле: «файл:строка — что — чем заменить» */
function findNativeControls(path: string, code: string): string[] {
  const file = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const at = (node: ts.Node, what: string, instead: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${relative(ROOT, path)}:${line + 1} — ${what} → ${instead}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      // Элементы разметки — со строчной буквы; компоненты (<Select title=…>) не трогаем
      if (/^[a-z]/.test(tag)) {
        const instead = FORBIDDEN_TAGS[tag];
        if (instead) at(node, `<${tag}>`, instead);
        const typeAttr = tag === "input" ? attribute(node, "type") : undefined;
        const type = literal(typeAttr);
        const input = type ? FORBIDDEN_INPUTS[type] : undefined;
        if (input) at(node, `<input type="${type}">`, input);
        // Тип выражением (type={field.type}) страж проверить не может: только литерал
        if (typeAttr?.initializer && type === null)
          at(node, "<input type={…}>", "литерал или контрол набора");
        if (attribute(node, "title")) at(node, `title= на <${tag}>`, "Tooltip");
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) &&
            /^(window|globalThis|self)$/.test(callee.expression.getText())
          ? callee.name.text
          : null;
      const instead = name ? FORBIDDEN_CALLS[name] : undefined;
      if (name && instead) at(node, `${name}()`, instead);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("системные контролы в приложениях", () => {
  it("страж находит то, что должен, и не путает компоненты с разметкой", () => {
    const code = `
      const a = <select value={x} onChange={(e) => f(e)}><option>1</option></select>;
      const b = <input
        className="x"
        onChange={() => y > 1}
        type="checkbox" />;
      const c = <input type={"file"} />;
      const d = <input type="text" inputMode="numeric" />;
      const h = <input type={extra.type} />;
      const e = <Select title="Район" />;
      const g = <span title="подсказка">!</span>;
      if (window.confirm("?")) alert("!");
      // <select> в комментарии и confirm() в строке — не нарушения
      const s = "confirm()";
    `;
    const found = findNativeControls(join(APPS, "x/src/sample.tsx"), code).map(
      (line) => line.split(" — ")[1]?.split(" → ")[0],
    );
    expect(found).toEqual([
      "<select>",
      '<input type="checkbox">',
      '<input type="file">',
      "<input type={…}>",
      "title= на <span>",
      "confirm()",
      "alert()",
    ]);
  });

  it("в apps/*/src нет <select>, window.confirm/alert/prompt и прочих системных контролов", () => {
    const apps = existsSync(APPS)
      ? readdirSync(APPS).filter((name) => existsSync(join(APPS, name, "src")))
      : [];
    expect(apps).toEqual(expect.arrayContaining(["web", "vendor", "admin"]));
    const found = apps.flatMap((app) =>
      sources(join(APPS, app, "src")).flatMap((path) => findNativeControls(path, readFileSync(path, "utf8"))),
    );
    expect(found).toEqual([]);
  });
});
