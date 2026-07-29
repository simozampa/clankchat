import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { SameTreeError } from './errors.js';
import { type RepositoryContext, resolveRepository } from './git.js';

const PATH_KEYS = new Set([
  'cwd',
  'directory',
  'file',
  'filepath',
  'filepaths',
  'files',
  'filename',
  'filenames',
  'notebookpath',
  'path',
  'paths',
  'root',
  'workdir',
]);
const CONTEXT_KEYS = new Set(['cwd', 'workdir']);
const COMMAND_KEYS = new Set(['command']);
const PATCH_KEYS = new Set(['patch', 'patchtext']);
const DIRECTORY_COMMANDS = new Set([
  '.',
  'cd',
  'eval',
  'invoke-expression',
  'pop-location',
  'popd',
  'push-location',
  'pushd',
  'set-location',
  'source',
]);
const INTEGRATING_GIT_COMMANDS = new Set([
  'am',
  'checkout',
  'cherry-pick',
  'clone',
  'init',
  'merge',
  'pull',
  'rebase',
  'submodule',
  'switch',
  'worktree',
]);
const SHELL_COMMANDS = new Set(['bash', 'cmd', 'dash', 'fish', 'ksh', 'pwsh', 'sh', 'zsh']);
const CONTROL_WORDS = new Set(['!', 'do', 'elif', 'else', 'if', 'then', 'time', 'until', 'while']);
const GIT_CONTEXT_VARIABLE =
  /^(?:GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CEILING_DIRECTORIES|GIT_COMMON_DIR|GIT_CONFIG(?:_[A-Za-z0-9_]+)?|GIT_DIR|GIT_INDEX_FILE|GIT_NAMESPACE|GIT_OBJECT_DIRECTORY|GIT_WORK_TREE)=/u;

interface GuardRequest {
  cwd?: unknown;
  tool?: unknown;
  toolInput?: unknown;
  toolName?: unknown;
  tool_input?: unknown;
  tool_name?: unknown;
}

interface ShellToken {
  kind: 'operator' | 'word';
  value: string;
}

function refuse(
  message: string,
  repository: RepositoryContext,
  details: Record<string, unknown> = {},
): never {
  throw new SameTreeError('HOOK_REFUSED', message, {
    repositoryRoot: repository.root,
    ...details,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedKey(value: string): string {
  return value.replaceAll(/[-_]/gu, '').toLocaleLowerCase('en-US');
}

function isPathKey(value: string): boolean {
  return PATH_KEYS.has(value) || value.endsWith('path') || value.endsWith('paths');
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function metadata(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null;
    throw error;
  }
}

function canonicalCandidate(
  repository: RepositoryContext,
  baseDirectory: string,
  input: string,
): { candidate: string; contextDirectory: string } {
  if (input.includes('\0')) {
    refuse('SameTree blocked a path containing a null byte.', repository, { path: input });
  }
  if (/^~/u.test(input)) {
    refuse(
      'SameTree blocked a home-relative path outside its explicit worktree context.',
      repository,
      {
        path: input,
      },
    );
  }
  if (/^[A-Za-z]:[\\/]/u.test(input) || /^\\\\/u.test(input)) {
    refuse('SameTree blocked a path in a foreign filesystem context.', repository, {
      path: input,
    });
  }

  const absolute = path.resolve(baseDirectory, input || '.');
  if (!isInside(repository.root, absolute)) {
    refuse('SameTree blocked a path outside the launch worktree.', repository, { path: input });
  }

  let ancestor = absolute;
  let ancestorMetadata = metadata(ancestor);
  while (!ancestorMetadata && ancestor !== repository.root) {
    ancestor = path.dirname(ancestor);
    ancestorMetadata = metadata(ancestor);
  }
  if (!ancestorMetadata) {
    refuse('SameTree could not resolve the launch worktree path.', repository, { path: input });
  }
  if (
    ancestor !== absolute &&
    !ancestorMetadata.isDirectory() &&
    !ancestorMetadata.isSymbolicLink()
  ) {
    refuse('SameTree blocked a path with a non-directory parent.', repository, { path: input });
  }

  let resolvedAncestor: string;
  try {
    resolvedAncestor = realpathSync(ancestor);
  } catch {
    refuse('SameTree blocked a path through a dangling symbolic link.', repository, {
      path: input,
    });
  }
  const candidate = path.resolve(resolvedAncestor, path.relative(ancestor, absolute));
  if (!isInside(repository.root, candidate)) {
    refuse('SameTree blocked a path that resolves outside the launch worktree.', repository, {
      path: input,
    });
  }

  const resolvedMetadata = metadata(resolvedAncestor);
  const contextDirectory = resolvedMetadata?.isDirectory()
    ? resolvedAncestor
    : path.dirname(resolvedAncestor);
  return { candidate, contextDirectory };
}

function assertPath(repository: RepositoryContext, baseDirectory: string, input: string): string {
  const { candidate, contextDirectory } = canonicalCandidate(repository, baseDirectory, input);
  let candidateRepository: RepositoryContext;
  try {
    candidateRepository = resolveRepository(contextDirectory);
  } catch {
    refuse('SameTree blocked a path outside the launch Git worktree.', repository, { path: input });
  }
  if (candidateRepository.privateGitDirectory !== repository.privateGitDirectory) {
    refuse('SameTree blocked a path in a different Git worktree.', repository, {
      path: input,
      resolvedRoot: candidateRepository.root,
    });
  }
  return candidate;
}

function tokenizeShell(command: string, repository: RepositoryContext): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  const flush = () => {
    if (started) tokens.push({ kind: 'word', value: current });
    current = '';
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? '';
    if (escaped) {
      current += character;
      started = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else current += character;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') escaped = true;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      if (character === '\n') tokens.push({ kind: 'operator', value: character });
      continue;
    }
    if (';&|()'.includes(character)) {
      flush();
      const next = command[index + 1];
      if (next === character && ';&|'.includes(character)) {
        tokens.push({ kind: 'operator', value: `${character}${next}` });
        index += 1;
      } else {
        tokens.push({ kind: 'operator', value: character });
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (quote || escaped) {
    refuse('SameTree blocked a shell command with ambiguous quoting.', repository);
  }
  flush();
  return tokens;
}

function commandName(value: string): string {
  return path.basename(value).toLocaleLowerCase('en-US');
}

function firstCommand(words: string[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? '';
    if (CONTROL_WORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) {
      index += 1;
      continue;
    }
    if (word === 'command' || word === 'builtin' || word === 'exec' || word === 'nohup') {
      index += 1;
      while (words[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (word === 'sudo') {
      index += 1;
      while (words[index]?.startsWith('-')) {
        const option = words[index];
        index += 1;
        if (option === '-u' || option === '-g' || option === '--user' || option === '--group') {
          index += 1;
        }
      }
      continue;
    }
    if (word === 'env') {
      index += 1;
      while (index < words.length) {
        const option = words[index] ?? '';
        if (option === '-C' || option === '--chdir' || option.startsWith('--chdir=')) return index;
        if (option.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(option)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    return index;
  }
  return index;
}

function gitSubcommand(
  words: string[],
  start: number,
  repository: RepositoryContext,
): string | null {
  for (let index = start + 1; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (
      word === '-C' ||
      word.startsWith('-C') ||
      word === '--git-dir' ||
      word.startsWith('--git-dir=') ||
      word === '--work-tree' ||
      word.startsWith('--work-tree=')
    ) {
      refuse('SameTree blocked a Git command that overrides worktree context.', repository, {
        command: words.join(' '),
      });
    }
    if (word === '-c' || word === '--config-env') {
      const configuration = words[index + 1] ?? '';
      const key = configuration.split('=', 1)[0]?.toLocaleLowerCase('en-US') ?? '';
      if (key.startsWith('alias.') || key === 'core.bare' || key === 'core.worktree') {
        refuse(
          'SameTree blocked a Git configuration that can override command context.',
          repository,
          {
            configuration,
          },
        );
      }
      index += 1;
      continue;
    }
    if (word.startsWith('--config-env=')) {
      const key = word.slice('--config-env='.length).split('=', 1)[0]?.toLocaleLowerCase('en-US');
      if (key?.startsWith('alias.') || key === 'core.bare' || key === 'core.worktree') {
        refuse(
          'SameTree blocked a Git configuration that can override command context.',
          repository,
          {
            configuration: word,
          },
        );
      }
      continue;
    }
    if (word === '--exec-path') {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return word.toLocaleLowerCase('en-US');
  }
  return null;
}

function pathCandidate(word: string, repository: RepositoryContext): string | null {
  let candidate = word.replace(/^\d*[<>]+/u, '');
  if (candidate.includes('=')) candidate = candidate.slice(candidate.indexOf('=') + 1);
  if (/^-[^-].*[\\/]/u.test(candidate)) {
    const attached = candidate.slice(2);
    if (
      attached.startsWith('/') ||
      attached.startsWith('./') ||
      attached.startsWith('../') ||
      attached.startsWith('~') ||
      /^[A-Za-z]:[\\/]/u.test(attached) ||
      /^\\\\/u.test(attached)
    ) {
      candidate = attached;
    } else {
      refuse('SameTree blocked an ambiguous attached shell path option.', repository, {
        option: word,
      });
    }
  } else if (/^--.*[\\/]/u.test(candidate)) return candidate;
  if (!candidate || candidate === '-' || candidate.startsWith('-')) return null;
  return candidate;
}

function assertShellPaths(
  words: string[],
  commandIndex: number,
  repository: RepositoryContext,
  baseDirectory: string,
): void {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (GIT_CONTEXT_VARIABLE.test(word)) {
      refuse('SameTree blocked a Git environment override.', repository, {
        environment: word.slice(0, word.indexOf('=')),
      });
    }
    if (index === commandIndex) {
      const executablePath = pathCandidate(word, repository);
      if (executablePath && !['git', 'gh', ...SHELL_COMMANDS].includes(commandName(word))) {
        assertPath(repository, baseDirectory, executablePath);
      }
      continue;
    }
    if (index < commandIndex && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) continue;
    const candidate = pathCandidate(word, repository);
    if (
      candidate &&
      !['/dev/null', '/dev/stderr', '/dev/stdin', '/dev/stdout'].includes(candidate)
    ) {
      assertPath(repository, baseDirectory, candidate);
    }
  }
}

function assertShellSegment(
  words: string[],
  repository: RepositoryContext,
  baseDirectory: string,
): void {
  const start = firstCommand(words);
  const executable = words[start];
  if (!executable) return;
  if (executable === '-C' || executable === '--chdir' || executable.startsWith('--chdir=')) {
    refuse('SameTree blocked a shell command that changes process directory.', repository, {
      command: words.join(' '),
    });
  }
  assertShellPaths(words, start, repository, baseDirectory);

  const name = commandName(executable);
  if (DIRECTORY_COMMANDS.has(name)) {
    refuse('SameTree blocked a shell command that changes directory context.', repository, {
      command: words.join(' '),
    });
  }
  if (name === 'git') {
    const subcommand = gitSubcommand(words, start, repository);
    if (subcommand && INTEGRATING_GIT_COMMANDS.has(subcommand)) {
      refuse(
        'SameTree blocked a Git command that can change worktree or branch context.',
        repository,
        {
          gitSubcommand: subcommand,
        },
      );
    }
  }
  if (name === 'gh') {
    const args = words.slice(start + 1).map((word) => word.toLocaleLowerCase('en-US'));
    if (args[0] === 'pr' && (args[1] === 'checkout' || args[1] === 'merge')) {
      refuse(
        'SameTree blocked a GitHub command that can integrate or switch branches.',
        repository,
        {
          command: words.join(' '),
        },
      );
    }
  }
  for (let shellIndex = start; shellIndex < words.length; shellIndex += 1) {
    const shell = commandName(words[shellIndex] ?? '');
    if (!SHELL_COMMANDS.has(shell)) continue;
    const nestedIndex = words.findIndex((word, index) => {
      if (index <= shellIndex) return false;
      const option = word.toLocaleLowerCase('en-US');
      if (shell === 'cmd') return option === '/c';
      if (shell === 'pwsh') return option === '-command' || option === '-c';
      return option === '-c' || /^-[^-]*c[A-Za-z]*$/u.test(option);
    });
    const nested = nestedIndex >= 0 ? words[nestedIndex + 1] : undefined;
    if (nested) assertShellCommand(nested, repository, baseDirectory);
  }
}

function hasDynamicExpansion(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== "'" && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote !== "'" && (character === '$' || character === '`')) return true;
  }
  return false;
}

function assertShellCommand(
  command: string,
  repository: RepositoryContext,
  baseDirectory: string,
): void {
  if (/(?:^|[\s=<>])(?:[A-Za-z]:[\\/]|\\\\)/u.test(command)) {
    refuse('SameTree blocked a shell path in a foreign filesystem context.', repository);
  }
  if (hasDynamicExpansion(command)) {
    refuse('SameTree blocked a shell command with dynamic expansion.', repository);
  }
  const tokens = tokenizeShell(command, repository);
  let segment: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'operator') {
      assertShellSegment(segment, repository, baseDirectory);
      segment = [];
    } else {
      segment.push(token.value);
    }
  }
  assertShellSegment(segment, repository, baseDirectory);
}

function assertPatchPaths(
  patchText: string,
  repository: RepositoryContext,
  baseDirectory: string,
): void {
  for (const line of patchText.split('\n')) {
    const match = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/u.exec(line);
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    const target = match?.[1] ?? move?.[1];
    if (target !== undefined) assertPath(repository, baseDirectory, target);
  }
}

function assertInput(
  value: unknown,
  repository: RepositoryContext,
  baseDirectory: string,
  contextDirectory: string,
  seen: Set<object>,
): void {
  if (!isRecord(value) || seen.has(value)) return;
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (COMMAND_KEYS.has(normalized) && typeof entry === 'string') {
      assertShellCommand(entry, repository, baseDirectory);
    }
    if (PATCH_KEYS.has(normalized) && typeof entry === 'string') {
      assertPatchPaths(entry, repository, baseDirectory);
    }
    if (isPathKey(normalized)) {
      const pathBase = CONTEXT_KEYS.has(normalized) ? contextDirectory : baseDirectory;
      if (typeof entry === 'string') assertPath(repository, pathBase, entry);
      else if (Array.isArray(entry)) {
        for (const item of entry) {
          if (typeof item === 'string') assertPath(repository, pathBase, item);
        }
      }
    }
    if (Array.isArray(entry)) {
      for (const item of entry) {
        assertInput(item, repository, baseDirectory, contextDirectory, seen);
      }
    } else {
      assertInput(entry, repository, baseDirectory, contextDirectory, seen);
    }
  }
}

/** Reject harness tool calls that can escape the Git worktree where the harness launched. */
export function assertWorktreeBoundary(cwd: string, input: unknown): void {
  const repository = resolveRepository(cwd);
  if (!isRecord(input)) {
    refuse('SameTree received an invalid worktree guard payload.', repository);
  }
  const request = input as GuardRequest;
  const toolName = request.tool_name ?? request.toolName ?? request.tool;
  if (toolName !== undefined && typeof toolName !== 'string') {
    refuse('SameTree received an invalid tool name.', repository);
  }
  if (request.cwd !== undefined && typeof request.cwd !== 'string') {
    refuse('SameTree received an invalid tool working directory.', repository);
  }
  const effectiveDirectory =
    typeof request.cwd === 'string' ? assertPath(repository, repository.root, request.cwd) : cwd;
  const toolInput = request.tool_input ?? request.toolInput;
  if (toolInput !== undefined && !isRecord(toolInput)) {
    refuse('SameTree received invalid tool arguments.', repository);
  }
  if (toolInput === undefined && toolName === undefined && request.cwd === undefined) {
    refuse('SameTree received an empty worktree guard payload.', repository);
  }

  let baseDirectory = effectiveDirectory;
  if (isRecord(toolInput)) {
    for (const [key, value] of Object.entries(toolInput)) {
      if (CONTEXT_KEYS.has(normalizedKey(key)) && typeof value === 'string') {
        baseDirectory = assertPath(repository, effectiveDirectory, value);
        break;
      }
    }
    assertInput(toolInput, repository, baseDirectory, effectiveDirectory, new Set());
  }
}
