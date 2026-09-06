// PdfText - extract the text of a PDF, for building the interview persona.
//
// PDFKit rather than a JavaScript PDF library: it ships with macOS, handles the
// awkward real-world files (multi-column CVs, embedded fonts) better than most
// pure-JS parsers, and adds no dependency to the project.
//
//   usage : pdftext <file.pdf>
//   stdout: {"ok":true,"pages":3,"chars":8421,"title":"...","text":"..."}
//           {"ok":false,"error":"..."}
//
// Always exits 0 with JSON on stdout so the caller parses one shape either way.

import Foundation
import PDFKit

func emit(_ obj: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
    FileHandle.standardOutput.write(data)
    exit(0)
}

guard CommandLine.arguments.count > 1 else {
    emit(["ok": false, "error": "usage: pdftext <file.pdf>"])
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)

guard FileManager.default.fileExists(atPath: path) else {
    emit(["ok": false, "error": "file not found: \(path)"])
}
guard let doc = PDFDocument(url: url) else {
    emit(["ok": false, "error": "not a readable PDF (it may be encrypted or corrupt)"])
}
if doc.isEncrypted && doc.isLocked {
    emit(["ok": false, "error": "PDF is password protected"])
}

var parts: [String] = []
for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i), let s = page.string else { continue }
    parts.append(s)
}

var text = parts.joined(separator: "\n")

// CV layouts leave a lot of vertical whitespace behind. Collapse it so the
// model spends its context on content rather than on blank lines.
text = text.replacingOccurrences(of: "\r\n", with: "\n")
text = text.replacingOccurrences(of: "\u{00A0}", with: " ")
text = text.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
text = text.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
text = text.trimmingCharacters(in: .whitespacesAndNewlines)

if text.isEmpty {
    emit([
        "ok": false,
        "error": "no selectable text found - this looks like a scanned image, which needs OCR",
        "pages": doc.pageCount,
    ])
}

let title = (doc.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String) ?? ""

emit([
    "ok": true,
    "pages": doc.pageCount,
    "chars": text.count,
    "title": title,
    "text": text,
])
