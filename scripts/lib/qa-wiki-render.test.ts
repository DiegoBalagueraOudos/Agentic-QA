/**
 * Tests for `scripts/lib/qa-wiki-render.ts`, the preview-only Markdown renderer:
 * HTML escaping, tables with escaped pipes, lists, fenced code, link/image
 * rewriting and refusal, Mermaid pie as SVG, other Mermaid kept as source.
 */

import { describe, expect, it } from 'bun:test';

import { parsePie, renderMarkdown, renderPieSvg } from './qa-wiki-render.ts';

const render = (md: string, page = 'Home.md'): string => renderMarkdown(md, { page });

describe('escaping', () => {
  it('never lets raw HTML through', () => {
    const html = render('# T <script>alert(1)</script>\n\n<img src=x onerror=alert(1)> **b** `<b>`');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<code>&lt;b&gt;</code>');
  });

  it('escapes table cells and attribute values', () => {
    const html = render('| A |\n| --- |\n| <i>x</i> |\n\n[a"b](x.md)');
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(html).not.toContain('<i>');
  });
});

describe('blocks', () => {
  it('renders headings, paragraph, rule and blockquote', () => {
    const html = render('# Uno\n\n## Dos\n\nlinea a\nlinea b\n\n---\n\n> cita');
    expect(html).toContain('<h1>Uno</h1>');
    expect(html).toContain('<h2>Dos</h2>');
    expect(html).toContain('<p>linea a linea b</p>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<blockquote><p>cita</p></blockquote>');
  });

  it('renders a table with an escaped pipe kept inside its cell', () => {
    const html = render('| Caso | Escenario |\n| --- | --- |\n| A-1 | valida a \\| b |\n| A-2 | otro |');
    expect(html).toContain('<th>Caso</th>');
    expect(html).toContain('<td>valida a | b</td>');
    expect(html.match(/<tr>/g)?.length).toBe(3);
  });

  it('renders bullet, numbered and nested lists', () => {
    const html = render('- uno\n- dos\n  - hijo\n- tres\n\n1. a\n2. b');
    expect(html).toContain('<ul><li>uno</li><li>dos\n<ul><li>hijo</li></ul></li><li>tres</li></ul>');
    expect(html).toContain('<ol><li>a</li><li>b</li></ol>');
  });

  it('renders fenced code verbatim and escaped', () => {
    const html = render('```ts\nconst a = "<b>";\n```\n\ndespues');
    expect(html).toContain('<pre><code class="language-ts">const a = &quot;&lt;b&gt;&quot;;</code></pre>');
    expect(html).toContain('<p>despues</p>');
  });
});

describe('links and images', () => {
  it('resolves relative targets against the page folder', () => {
    const html = render('[bug](../Bugs/X-1.md) ![f](../.attachments/bugs/X-1/a.png)', 'Casos/AUT.md');
    expect(html).toContain('<a href="/Bugs/X-1.md">bug</a>');
    expect(html).toContain('<img src="/.attachments/bugs/X-1/a.png" alt="f">');
  });

  it('keeps https and mailto, drops script schemes, escapes and external images', () => {
    const html = render('[ok](https://example.com/a) [js](javascript:alert(1)) [d](data:text/html,x) [up](../../etc/passwd) ![e](https://example.com/i.png)', 'Bugs/X.md');
    expect(html).toContain('<a href="https://example.com/a">ok</a>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text');
    expect(html).not.toContain('etc/passwd');
    expect(html).not.toContain('<img');
    expect(html).toContain('[imagen: e]');
  });
});

describe('mermaid', () => {
  it('draws a pie as inline SVG with every slice in the legend', () => {
    const html = render('```mermaid\npie title Estado\n    "Pendiente" : 3\n    "Hecho" : 1\n```');
    expect(html).toContain('<svg');
    expect(html).toContain('Estado');
    expect(html).toContain('Pendiente (3, 75%)');
    expect(html).toContain('Hecho (1, 25%)');
    expect(html).not.toContain('<script');
  });

  it('is deterministic and handles a single slice', () => {
    expect(renderPieSvg('T', [['a', 2], ['b', 1]])).toBe(renderPieSvg('T', [['a', 2], ['b', 1]]));
    expect(renderPieSvg('T', [['a', 2]])).toContain('<circle');
  });

  it('parses pie sources and rejects non-pies', () => {
    expect(parsePie('pie title X\n  "a" : 1\n  "b" : 0')).toEqual({ title: 'X', slices: [['a', 1]] });
    expect(parsePie('graph TD\n  A-->B')).toBeNull();
    expect(parsePie('pie title X')).toBeNull();
  });

  it('shows other Mermaid types as source with a note', () => {
    const html = render('```mermaid\ngraph TD\n  A-->B\n```');
    expect(html).not.toContain('<svg');
    expect(html).toContain('A--&gt;B');
    expect(html).toContain('Azure DevOps');
  });
});
