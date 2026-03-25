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
});
