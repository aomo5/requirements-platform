"use strict";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5 -]/g, "")
    .replace(/\s+/g, "-");
}

function isExternalUrl(value) {
  return /^(https?:|mailto:|tel:|data:|#|\/)/i.test(value);
}

function parseInline(text, options = {}) {
  const markers = [...text.matchAll(/<!-- wb-rule:(rule-[a-zA-Z0-9_-]{1,75}) -->/g)].map(match => `<span data-wb-rule-id="${match[1]}" hidden></span>`).join("");
  let html = escapeHtml(text.replace(/ ?<!-- wb-rule:rule-[a-zA-Z0-9_-]{1,75} -->/g, ""));
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, source) => {
    const resolvedSource =
      !isExternalUrl(source) && typeof options.resolveAssetUrl === "function" ? options.resolveAssetUrl(source) : source;
    return `<img class="md-image" src="${resolvedSource}" alt="${alt}">`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html + markers;
}

function renderCodeBlock(lines, language) {
  const languageClass = language ? ` class="language-${escapeHtml(language)}"` : "";
  return `<pre><code${languageClass}>${escapeHtml(lines.join("\n"))}</code></pre>`;
}

function renderTable(rows, options, startLine) {
  if (rows.length < 2) {
    return rows.map((row) => `<p>${parseInline(row.join(" | "), options)}</p>`).join("");
  }

  const header = rows[0];
  const body = rows.slice(2);
  const thead = `<thead><tr>${header.map((cell) => `<th>${parseInline(cell, options)}</th>`).join("")}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body.map((row, index) => `<tr${options.trackSource ? ` data-wb-source-line="${startLine + index + 2}"` : ""}>${row.map((cell) => `<td>${parseInline(cell, options)}</td>`).join("")}</tr>`).join("")}</tbody>`
    : "";

  return `<div class="md-table-wrap"><table>${thead}${tbody}</table></div>`;
}

function isTableLine(line) {
  return /^\s*\|(.+\|)+\s*$/.test(line);
}

function isTableDivider(line) {
  return /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
}

function splitTableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderMarkdown(markdown, options = {}) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const output = [];

  let paragraph = [], paragraphLine = 0, tableLine = 0, quoteIndexes = [];
  const sourceAttr = line => options.trackSource ? ` data-wb-source-line="${line}"` : "";
  let listItems = [];
  let listType = null;
  let quoteLines = [];
  let codeLines = [];
  let codeLanguage = "";
  let inCodeBlock = false;
  let tableLines = [];

  function flushParagraph() {
    if (!paragraph.length) {
      return;
    }
    output.push(`<p${sourceAttr(paragraphLine)}>${parseInline(paragraph.join(" "), options)}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length) {
      return;
    }
    const tag = listType === "ol" ? "ol" : "ul";
    output.push(`<${tag}>${listItems.join("")}</${tag}>`);
    listItems = [];
    listType = null;
  }

  function flushQuote() {
    if (!quoteLines.length) {
      return;
    }
    output.push(`<blockquote>${quoteLines.map((line, index) => `<p${sourceAttr(quoteIndexes[index])}>${parseInline(line, options)}</p>`).join("")}</blockquote>`);
    quoteLines = []; quoteIndexes = [];
  }

  function flushTable() {
    if (!tableLines.length) {
      return;
    }
    output.push(renderTable(tableLines.map(splitTableCells), options, tableLine));
    tableLines = [];
  }

  function flushAllTextual() {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (inCodeBlock) {
      if (/^```/.test(trimmed)) {
        output.push(renderCodeBlock(codeLines, codeLanguage));
        codeLines = [];
        codeLanguage = "";
        inCodeBlock = false;
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (/^```/.test(trimmed)) {
      flushAllTextual();
      inCodeBlock = true;
      codeLanguage = trimmed.slice(3).trim();
      continue;
    }

    if (!trimmed) {
      flushAllTextual();
      continue;
    }

    if (isTableLine(trimmed)) {
      if (!tableLines.length) {
        tableLine = index;
        flushParagraph();
        flushList();
        flushQuote();
      }
      tableLines.push(trimmed);
      const nextLine = lines[index + 1] ? lines[index + 1].trim() : "";
      if (!nextLine || (!isTableLine(nextLine) && !isTableDivider(nextLine))) {
        flushTable();
      }
      continue;
    }

    if (tableLines.length) {
      flushTable();
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushAllTextual();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const id = slugify(text) || `heading-${index + 1}`;
      output.push(`<h${level} id="${escapeHtml(id)}">${parseInline(text, options)}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushAllTextual();
      output.push("<hr>");
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      flushList();
      quoteIndexes.push(index);
      quoteLines.push(trimmed.replace(/^>\s?/, ""));
      continue;
    }

    const orderedMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph();
      flushQuote();
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listItems.push(`<li${sourceAttr(index)}>${parseInline(orderedMatch[2], options)}</li>`);
      continue;
    }

    const unorderedMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unorderedMatch) {
      flushParagraph();
      flushQuote();
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      const itemText = unorderedMatch[1];
      const taskMatch = itemText.match(/^\[( |x|X)\]\s+(.+)$/);
      if (taskMatch) {
        const checked = taskMatch[1].toLowerCase() === "x" ? ' checked' : "";
        listItems.push(
          `<li class="task-item"${sourceAttr(index)}><label><input type="checkbox"${checked} disabled><span>${parseInline(taskMatch[2], options)}</span></label></li>`
        );
      } else {
        listItems.push(`<li${sourceAttr(index)}>${parseInline(itemText, options)}</li>`);
      }
      continue;
    }

    if (listItems.length) {
      flushList();
    }

    if (quoteLines.length) {
      flushQuote();
    }

    if (!paragraph.length) paragraphLine = index;
    paragraph.push(trimmed);
  }

  flushAllTextual();

  if (inCodeBlock) {
    output.push(renderCodeBlock(codeLines, codeLanguage));
  }

  return output.join("\n");
}

module.exports = {
  escapeHtml,
  renderMarkdown,
};
