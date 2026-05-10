/**
 * Config-browser pane (RFC-0023 §9 / AISDLC-178.5 AC#4-6).
 *
 * Two states:
 *   - List view: shows every `.ai-sdlc/*.yaml` with a status icon
 *     (✓ valid / ✗ invalid). Operator picks one with ↑↓/Enter.
 *   - Detail view: syntax-highlighted body with inline error annotations
 *     (rendered as a red gutter line directly under the offending line).
 *     `e` launches `$EDITOR`; on exit the file is re-read + re-validated.
 *     `Esc`/`q` returns to list view.
 *
 * Mode-switch + global keymap routing belong in `modes/router.tsx`; this
 * pane only handles its own internal navigation.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import {
  listConfigFiles,
  readConfigFile,
  type ConfigFile,
  type ListConfigFilesOpts,
  type ReadConfigFileOpts,
  type ReadConfigFileResult,
} from './file-walker.js';
import {
  validateYaml,
  type SchemaValidator,
  type YamlValidationIssue,
  type YamlValidationResult,
} from './validator.js';
import { highlightYaml, type Token, type TokenKind } from './highlight.js';
import { launchEditor, type LaunchEditorOpts, type LaunchEditorResult } from './editor-handoff.js';
import { loadReferenceSchemaValidator } from './reference-validator.js';
import type { SourceErrorKind } from '../sources/types.js';

// ── Color map for syntax tokens ──────────────────────────────────────────────

const TOKEN_COLOR: Record<TokenKind, string | undefined> = {
  key: 'cyan',
  value: undefined,
  string: 'green',
  number: 'yellow',
  comment: 'gray',
  punct: 'gray',
  plain: undefined,
};

function TokenSpan({ token }: { token: Token }): React.ReactElement {
  const color = TOKEN_COLOR[token.kind];
  return color ? <Text color={color}>{token.text}</Text> : <Text>{token.text}</Text>;
}

// ── List-row icon ────────────────────────────────────────────────────────────

interface FileStatus {
  loaded: boolean;
  valid: boolean | null;
  detectedKind: string | null;
}

function FileRow({
  file,
  status,
  selected,
  filterMatched,
}: {
  file: ConfigFile;
  status: FileStatus | undefined;
  selected: boolean;
  filterMatched: boolean;
}): React.ReactElement {
  const icon = !status || !status.loaded ? '·' : status.valid ? '✓' : '✗';
  const iconColor = !status || !status.loaded ? 'gray' : status.valid ? 'green' : 'red';
  const prefix = selected ? '▶ ' : '  ';
  const labelColor = !filterMatched ? 'gray' : selected ? 'white' : undefined;
  const kind = status?.detectedKind ?? '';

  return (
    <Box>
      <Text color={selected ? 'white' : undefined}>{prefix}</Text>
      <Text color={iconColor}>{icon} </Text>
      <Text color={labelColor} bold={selected}>
        {file.name.padEnd(38)}
      </Text>
      <Text color="gray">{kind}</Text>
    </Box>
  );
}

// ── Detail view ──────────────────────────────────────────────────────────────

interface DetailViewProps {
  file: ConfigFile;
  text: string | null;
  validation: YamlValidationResult | null;
  readError: SourceErrorKind | null;
  editorMessage: string | null;
  onEdit: () => void;
  onClose: () => void;
}

function DetailView({
  file,
  text,
  validation,
  readError,
  editorMessage,
  onEdit,
  onClose,
}: DetailViewProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
    } else if (input === 'e') {
      onEdit();
    }
  });

  const errorByLine = useMemo(() => {
    const map = new Map<number, YamlValidationIssue[]>();
    if (!validation) return map;
    for (const issue of validation.issues) {
      const ln = issue.line ?? 1;
      if (!map.has(ln)) map.set(ln, []);
      map.get(ln)!.push(issue);
    }
    return map;
  }, [validation]);

  const lines = text ? highlightYaml(text) : [];

  return (
    <Box flexDirection="column" borderStyle="double" paddingX={1} flexGrow={1}>
      <Text bold color="magenta">
        ⚙ CONFIG — {file.relPath}
      </Text>
      {readError && (
        <Box marginTop={1}>
          <Text color="red">⚠ unable to read file: {readError}</Text>
        </Box>
      )}
      {!readError && validation && validation.valid && (
        <Box marginTop={1}>
          <Text color="green">
            ✓ valid {validation.detectedKind ? `(${validation.detectedKind})` : '(no schema)'}
          </Text>
        </Box>
      )}
      {!readError && validation && !validation.valid && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">
            ✗ {validation.issues.length} issue{validation.issues.length === 1 ? '' : 's'} —{' '}
            {validation.detectedKind ?? '(no schema match)'}
          </Text>
        </Box>
      )}
      {editorMessage && (
        <Box marginTop={1}>
          <Text color="yellow">{editorMessage}</Text>
        </Box>
      )}
      {/* Body */}
      <Box marginTop={1} flexDirection="column">
        {lines.map((hl) => {
          const errs = errorByLine.get(hl.lineNumber);
          return (
            <Box key={hl.lineNumber} flexDirection="column">
              <Box>
                <Text color="gray">{String(hl.lineNumber).padStart(4)}│ </Text>
                {hl.tokens.length === 0 ? (
                  <Text> </Text>
                ) : (
                  hl.tokens.map((t, i) => <TokenSpan key={i} token={t} />)
                )}
              </Box>
              {errs?.map((issue, idx) => (
                <Box key={`err-${idx}`}>
                  <Text color="red"> ↳ {formatIssue(issue)}</Text>
                </Box>
              ))}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          [e] edit in $EDITOR [Esc/q] back to list
        </Text>
      </Box>
    </Box>
  );
}

function formatIssue(issue: YamlValidationIssue): string {
  const tag = issue.source === 'parse' ? 'parse' : 'schema';
  const path = issue.path ? ` ${issue.path}` : '';
  return `[${tag}]${path} ${issue.message}`;
}

// ── Main pane ────────────────────────────────────────────────────────────────

export interface ConfigBrowserPaneProps {
  /** Project root. Defaults `process.cwd()`. */
  workDir?: string;
  /** Inject the file walker (tests). */
  walker?: (opts: ListConfigFilesOpts) => ReturnType<typeof listConfigFiles>;
  /** Inject the file reader (tests). */
  fileReader?: (opts: ReadConfigFileOpts) => ReadConfigFileResult;
  /** Inject the schema validator (tests). Defaults: dynamic-load reference. */
  schemaValidator?: SchemaValidator;
  /** Inject editor launcher (tests). */
  editorLauncher?: (opts: LaunchEditorOpts) => LaunchEditorResult;
  /** Inject filter (search) string. Empty/null disables filtering. */
  filterQuery?: string | null;
  /** Refresh-nonce (`r` keystroke) — bumping triggers re-walk. */
  refreshNonce?: number;
  /**
   * Inject useApp().exit so tests can verify an editor handoff that
   * suspends Ink without actually re-mounting. Defaults to no-op outside
   * of the live render path (we DO NOT call exit() in the pane — Ink's
   * raw-mode TTY is restored by the spawnSync `stdio: 'inherit'` itself).
   */
  onEditorOpenedHook?: (file: ConfigFile) => void;
}

export function ConfigBrowserPane(props: ConfigBrowserPaneProps): React.ReactElement {
  const {
    workDir,
    walker = listConfigFiles,
    fileReader = readConfigFile,
    schemaValidator,
    editorLauncher = launchEditor,
    filterQuery = null,
    refreshNonce = 0,
    onEditorOpenedHook,
  } = props;

  // Files + per-file status (validity icon).
  const [walkResult, setWalkResult] = useState<{
    files: ConfigFile[];
    error: SourceErrorKind | null;
  }>({
    files: [],
    error: null,
  });
  const [statuses, setStatuses] = useState<Map<string, FileStatus>>(new Map());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [openFile, setOpenFile] = useState<ConfigFile | null>(null);
  const [openText, setOpenText] = useState<string | null>(null);
  const [openValidation, setOpenValidation] = useState<YamlValidationResult | null>(null);
  const [openReadError, setOpenReadError] = useState<SourceErrorKind | null>(null);
  const [editorMessage, setEditorMessage] = useState<string | null>(null);
  const [resolvedSchemaValidator, setResolvedSchemaValidator] = useState<SchemaValidator | null>(
    schemaValidator ?? null,
  );

  // Lazy-resolve the reference validator on mount when the caller didn't inject one.
  useEffect(() => {
    if (schemaValidator) return;
    let cancelled = false;
    void loadReferenceSchemaValidator().then((v) => {
      if (!cancelled && v) setResolvedSchemaValidator(() => v);
    });
    return (): void => {
      cancelled = true;
    };
  }, [schemaValidator]);

  // Walk the dir + read each file to compute status icons.
  useEffect(() => {
    const result = walker({ workDir });
    setWalkResult(result);

    const newStatuses = new Map<string, FileStatus>();
    for (const file of result.files) {
      const read = fileReader({ absPath: file.absPath });
      if (read.text === null) {
        newStatuses.set(file.absPath, { loaded: true, valid: false, detectedKind: null });
        continue;
      }
      const validation = validateYaml({
        text: read.text,
        schemaValidator: resolvedSchemaValidator ?? undefined,
      });
      newStatuses.set(file.absPath, {
        loaded: true,
        valid: validation.valid,
        detectedKind: validation.detectedKind,
      });
    }
    setStatuses(newStatuses);
  }, [workDir, walker, fileReader, resolvedSchemaValidator, refreshNonce]);

  // Filter files by search.
  const visibleFiles = useMemo(() => {
    if (!filterQuery) return walkResult.files;
    const q = filterQuery.toLowerCase();
    return walkResult.files.filter((f) => f.name.toLowerCase().includes(q));
  }, [walkResult.files, filterQuery]);

  // Clamp selection.
  const clampedIndex = Math.min(selectedIndex, Math.max(0, visibleFiles.length - 1));

  // ── Open a file: read body + run full validation ──────────────────────────
  const openSelected = (file: ConfigFile): void => {
    const read = fileReader({ absPath: file.absPath });
    setOpenFile(file);
    setOpenText(read.text);
    setOpenReadError(read.error);
    setEditorMessage(null);
    if (read.text !== null) {
      const validation = validateYaml({
        text: read.text,
        schemaValidator: resolvedSchemaValidator ?? undefined,
      });
      setOpenValidation(validation);
    } else {
      setOpenValidation(null);
    }
  };

  // ── Edit-handoff: spawn $EDITOR, re-validate on return ────────────────────
  const editorLauncherRef = useRef(editorLauncher);
  editorLauncherRef.current = editorLauncher;
  const onEditorHookRef = useRef(onEditorOpenedHook);
  onEditorHookRef.current = onEditorOpenedHook;

  const handleEdit = (): void => {
    if (!openFile) return;
    onEditorHookRef.current?.(openFile);
    const result = editorLauncherRef.current({ filePath: openFile.absPath });
    if (result.outcome === 'EDITOR_NOT_SET') {
      setEditorMessage(
        '$EDITOR not set — set EDITOR=vim (or your preferred editor) to enable in-place edits.',
      );
      return;
    }
    if (result.outcome === 'EDITOR_FAILED') {
      setEditorMessage(`$EDITOR failed: ${result.error ?? 'unknown error'}`);
      return;
    }
    // Editor exited — re-read + re-validate.
    const read = fileReader({ absPath: openFile.absPath });
    setOpenText(read.text);
    setOpenReadError(read.error);
    if (read.text !== null) {
      const validation = validateYaml({
        text: read.text,
        schemaValidator: resolvedSchemaValidator ?? undefined,
      });
      setOpenValidation(validation);
      setEditorMessage(
        validation.valid
          ? `✓ saved & re-validated — ${validation.detectedKind ?? 'no schema'}`
          : `✗ ${validation.issues.length} issue(s) after edit — fix and press [e] again`,
      );
      // Refresh the list-view status row for this file.
      setStatuses((prev) => {
        const next = new Map(prev);
        next.set(openFile.absPath, {
          loaded: true,
          valid: validation.valid,
          detectedKind: validation.detectedKind,
        });
        return next;
      });
    } else {
      setOpenValidation(null);
      setEditorMessage('Could not re-read file after editor exit.');
    }
  };

  // Use Ink's app handle to silence unused-import lint when the prop is omitted.
  void useApp;

  // ── List-view input handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (openFile) return; // Detail view owns input.
    if (key.upArrow || input === 'k') {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex((i) => Math.min(visibleFiles.length - 1, i + 1));
    } else if (key.return && visibleFiles.length > 0) {
      const file = visibleFiles[clampedIndex];
      if (file) openSelected(file);
    }
  });

  // ── Render: detail view ───────────────────────────────────────────────────
  if (openFile) {
    return (
      <DetailView
        file={openFile}
        text={openText}
        validation={openValidation}
        readError={openReadError}
        editorMessage={editorMessage}
        onEdit={handleEdit}
        onClose={() => {
          setOpenFile(null);
          setOpenText(null);
          setOpenValidation(null);
          setOpenReadError(null);
          setEditorMessage(null);
        }}
      />
    );
  }

  // ── Render: list view ─────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <Text bold color="magenta">
        ⚙ CONFIGURATION ({walkResult.files.length} files)
      </Text>
      {walkResult.error && (
        <Box marginTop={1}>
          <Text color="red">⚠ unable to list .ai-sdlc/: {walkResult.error}</Text>
        </Box>
      )}
      {!walkResult.error && walkResult.files.length === 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            No .yaml files under .ai-sdlc/
          </Text>
        </Box>
      )}
      {visibleFiles.length === 0 && walkResult.files.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            No matches for "{filterQuery}"
          </Text>
        </Box>
      )}
      {visibleFiles.map((file, idx) => (
        <FileRow
          key={file.absPath}
          file={file}
          status={statuses.get(file.absPath)}
          selected={idx === clampedIndex}
          filterMatched={true}
        />
      ))}
      {visibleFiles.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            [↑↓/jk] navigate [Enter] open [Esc] back
          </Text>
        </Box>
      )}
    </Box>
  );
}
