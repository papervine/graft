/**
 * Rendering for `graft check`.
 *
 * The report is the product (SPEC.md §3.6), so its legibility is a feature, not polish. Two
 * rules shape everything here:
 *
 *   - Lead with the count and the fact. "20 schemas serve as both request and response" is
 *     actionable; "possible model conflation detected" is not.
 *   - Always show the fix. A diagnostic the reader cannot act on has not done its job.
 */

import pc from 'picocolors';
import type { Diagnostic, Severity } from '@graft/protocol';

export interface ReportOptions {
  readonly color: boolean;
}

const MARKS: Record<Severity, string> = { error: '✗', warn: '⚠', info: 'ℹ' };

function paint(text: string, severity: Severity, options: ReportOptions): string {
  if (!options.color) return text;
  if (severity === 'error') return pc.red(text);
  if (severity === 'warn') return pc.yellow(text);
  return pc.blue(text);
}

function dim(text: string, options: ReportOptions): string {
  return options.color ? pc.dim(text) : text;
}

function bold(text: string, options: ReportOptions): string {
  return options.color ? pc.bold(text) : text;
}

export interface ReportHeader {
  readonly source: string;
  readonly operationCount: number;
  readonly resourceCount: number;
  readonly namedSchemaCount: number;
  readonly inlineSchemaCount: number;
}

export function renderHeader(header: ReportHeader, options: ReportOptions): string {
  const counts = [
    `${header.operationCount} operations`,
    `${header.resourceCount} resources`,
    `${header.namedSchemaCount} named schemas`,
    `${header.inlineSchemaCount} inline schemas`,
  ].join(', ');
  return `${bold(header.source, options)} ${dim('→', options)} ${counts}`;
}

export function renderDiagnostic(diagnostic: Diagnostic, options: ReportOptions): string {
  const lines: string[] = [];
  const mark = paint(MARKS[diagnostic.severity], diagnostic.severity, options);
  lines.push(`  ${mark} ${diagnostic.message} ${dim(`[${diagnostic.code}]`, options)}`);

  for (const detail of diagnostic.detail ?? []) {
    lines.push(`      ${dim(detail, options)}`);
  }
  if (diagnostic.fix !== undefined) {
    const fixLines = diagnostic.fix.split('\n');
    lines.push(`      ${options.color ? pc.green('→') : '→'} ${fixLines[0] ?? ''}`);
    for (const line of fixLines.slice(1)) {
      lines.push(`        ${line}`);
    }
  }
  return lines.join('\n');
}

export interface ReportSummary {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
}

export function summarize(diagnostics: readonly Diagnostic[]): ReportSummary {
  return {
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warn').length,
    infos: diagnostics.filter((d) => d.severity === 'info').length,
  };
}

export function renderSummary(
  summary: ReportSummary,
  options: ReportOptions,
  strict: boolean,
): string {
  if (summary.errors === 0 && summary.warnings === 0) {
    const ok = options.color ? pc.green('✓') : '✓';
    return `${ok} No under-specification found${
      summary.infos > 0 ? ` (${summary.infos} informational)` : ''
    }.`;
  }
  const parts: string[] = [];
  if (summary.errors > 0) parts.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`);
  if (summary.warnings > 0) {
    parts.push(`${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`);
  }
  if (summary.infos > 0) parts.push(`${summary.infos} informational`);

  const tail = strict
    ? ' Exiting non-zero because --strict is set.'
    : ' Generation will proceed; run with --strict to gate on this in CI.';
  return `${parts.join(', ')}.${dim(tail, options)}`;
}

export function renderReport(
  header: ReportHeader,
  diagnostics: readonly Diagnostic[],
  options: ReportOptions,
  strict: boolean,
): string {
  const summary = summarize(diagnostics);
  const sections = [renderHeader(header, options), ''];
  for (const diagnostic of diagnostics) {
    sections.push(renderDiagnostic(diagnostic, options), '');
  }
  sections.push(renderSummary(summary, options, strict));
  return sections.join('\n');
}
