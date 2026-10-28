# Input formats — reading the sources of `stories` mode

> Owner: `test-case-generation-local`. Read when an input is not plain Markdown.

## 1. The rule

Every input is first turned into text in the **session scratchpad**, never inside the repo. The converted copy can hold names, emails, ids or screenshots of real data; it is deleted with the session. The case files carry only the derived business statements and a citation (document and section), never a pasted block of the source.

An input that cannot be read is listed in the plan as `unreadable` with the reason, and the run continues with the rest. Never guess its content.

## 2. Per format

| Format | How to read it |
|---|---|
| `.md`, `.txt` | The Read tool directly. |
| `.pdf` | The Read tool with the `pages` parameter, at most 20 pages per call, in order. A scanned PDF with no text layer is `unreadable` unless an OCR step is available (the `pdf` skill of the harness does OCR when installed); say which one was used. |
| `.docx` | If a `docx` skill is available, use it to extract text, tables and comments. Otherwise unzip the file in the scratchpad and read `word/document.xml`; strip the tags, keep headings and table rows. Tracked changes and comments are read, not applied. |
| `.xlsx` | If an `xlsx` skill is available, use it. Otherwise unzip in the scratchpad and read `xl/sharedStrings.xml` and `xl/worksheets/sheet*.xml`. Read every sheet; the sheet name is part of the citation. A traceability matrix (stories x requirements) is a source of ids and links, not of acceptance criteria. |
| A folder | Read the file names first, order them by name and version (`V1`, `V2.1`), and prefer the newest version of a document; list the older ones as `superseded` in the plan. |
| `.html` | The Read tool; the visible text and headings only. |

## 3. What to extract per story

Id (or a stable label), title, role, the acceptance criteria as written, the rules, limits, states and literal messages they name, the module, and the citation (document, version, section or sheet and row). Keep the story's own words for the expected result.

## 4. Several versions of the same story

When two versions disagree, the newest wins for the case, and the disagreement is a finding listing both versions and their citations. Do not merge them silently.

## 5. Mockups and images

An image or a mockup is evidence for the layout and the labels, not for behaviour. Use it to quote literal labels and messages; do not infer rules from it.
