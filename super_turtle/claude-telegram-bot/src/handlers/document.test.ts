import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __test__ } from "./document";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

async function createDocx(xml: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "superturtle-docx-"));
  tempRoots.push(root);
  const wordDir = join(root, "word");
  mkdirSync(wordDir, { recursive: true });
  writeFileSync(join(wordDir, "document.xml"), xml, "utf-8");
  const outputPath = join(root, "sample.docx");
  await Bun.$`zip -qr ${outputPath} word`.cwd(root).quiet();
  return outputPath;
}

async function createPptx(slides: string[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "superturtle-pptx-"));
  tempRoots.push(root);
  const slidesDir = join(root, "ppt", "slides");
  mkdirSync(slidesDir, { recursive: true });
  slides.forEach((xml, index) => {
    writeFileSync(join(slidesDir, `slide${index + 1}.xml`), xml, "utf-8");
  });
  const outputPath = join(root, "sample.pptx");
  await Bun.$`zip -qr ${outputPath} ppt`.cwd(root).quiet();
  return outputPath;
}

async function createXlsx(sharedStrings: string[], sheets: Array<{ name: string; xml: string }>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "superturtle-xlsx-"));
  tempRoots.push(root);
  const xlDir = join(root, "xl");
  const worksheetsDir = join(xlDir, "worksheets");
  const relsDir = join(xlDir, "_rels");
  mkdirSync(worksheetsDir, { recursive: true });
  mkdirSync(relsDir, { recursive: true });

  const workbookXml = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`,
    `<sheets>`,
    ...sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`),
    `</sheets>`,
    `</workbook>`,
  ].join("");
  writeFileSync(join(xlDir, "workbook.xml"), workbookXml, "utf-8");

  const workbookRelsXml = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
    ...sheets.map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    ),
    `</Relationships>`,
  ].join("");
  writeFileSync(join(relsDir, "workbook.xml.rels"), workbookRelsXml, "utf-8");

  const sharedStringsXml = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`,
    ...sharedStrings.map((value) => `<si><t>${value}</t></si>`),
    `</sst>`,
  ].join("");
  writeFileSync(join(xlDir, "sharedStrings.xml"), sharedStringsXml, "utf-8");

  sheets.forEach((sheet, index) => {
    writeFileSync(join(worksheetsDir, `sheet${index + 1}.xml`), sheet.xml, "utf-8");
  });

  const outputPath = join(root, "sample.xlsx");
  await Bun.$`zip -qr ${outputPath} xl`.cwd(root).quiet();
  return outputPath;
}

describe("document office extraction", () => {
  it("extracts text from docx files", async () => {
    const docxPath = await createDocx(
      [
        `<w:document xmlns:w="urn:test">`,
        `<w:body>`,
        `<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`,
        `<w:p><w:r><w:t>Docx world</w:t></w:r></w:p>`,
        `</w:body>`,
        `</w:document>`,
      ].join("")
    );

    const text = await __test__.extractText(
      docxPath,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    expect(text).toContain("Hello");
    expect(text).toContain("Docx world");
  });

  it("extracts text from pptx slide xml", async () => {
    const pptxPath = await createPptx([
      `<p:sld xmlns:p="urn:test" xmlns:a="urn:test"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide one</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      `<p:sld xmlns:p="urn:test" xmlns:a="urn:test"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide two</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ]);

    const text = await __test__.extractText(
      pptxPath,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );

    expect(text).toContain("Slide one");
    expect(text).toContain("Slide two");
    expect(text).toContain("--- Slide 1 ---");
    expect(text).toContain("--- Slide 2 ---");
  });

  it("extracts text from xlsx worksheets", async () => {
    const xlsxPath = await createXlsx(
      ["Department", "Spend", "Ops", "1200", "Sales", "900"],
      [
        {
          name: "March Close",
          xml: [
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
            `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`,
            `<sheetData>`,
            `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`,
            `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row>`,
            `<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>900</v></c></row>`,
            `</sheetData>`,
            `</worksheet>`,
          ].join(""),
        },
      ]
    );

    const text = await __test__.extractText(
      xlsxPath,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    expect(text).toContain("--- Sheet: March Close ---");
    expect(text).toContain("Department\tSpend");
    expect(text).toContain("Ops\t1200");
    expect(text).toContain("Sales\t900");
  });
});
