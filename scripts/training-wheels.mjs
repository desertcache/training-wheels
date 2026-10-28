#!/usr/bin/env node
// training-wheels: a Claude Code PreToolUse hook for someone making their first pull request.
//
// Claude Code runs this before every Bash or PowerShell command the agent wants to run, with the
// call as JSON on stdin. git commands run only if they are on a short list of what a first pull
// request needs (see README.md, "Allowed commands"); the classic ways to lose work get a
// one-sentence reason and a safer command, and anything else gets "not on the training-wheels list".
// Anything the guard can't read exactly (wrappers that carry a command, shell variables, escapes,
// globs or redirection tricks in a git line) is refused rather than parsed. Commands that aren't git
// pass through to Claude Code's normal permission flow.
//
// What it is for: catching the honest mistakes an agent makes while helping a beginner. It is not a
// sandbox and not a defense against an agent set on getting around it.
//
// It only stops the agent. You can still type any command yourself, and TRAINING_WHEELS=off in the
// environment Claude Code starts in turns the check off.
//
// No dependencies. Node 18 or later.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ rule: string, shown: string, why: string, instead: string }} Block
 * @typedef {'bash' | 'powershell'} Shell
 * @typedef {{ cwd?: string, shell?: Shell, isRef?: (name: string) => boolean, isPath?: (name: string) => boolean,
 *   alias?: (name: string) => string | null }} Context
 */

/** @param {string} rule @param {string} shown @param {string} why @param {string} instead @returns {Block} */
const block = (rule, shown, why, instead) => ({ rule, shown, why, instead });

/** A command the guard can't read exactly. @param {string} what */
const unreadable = (what) => block('cannot-read', what,
  "the guard can't read safely what it would run, so it doesn't run",
  'run the git command itself, on one line, written out in full: no wrappers, variables, escapes or wildcards');

/** A git command that isn't on the list. @param {string} what */
const offList = (what) => block('not-on-list', what,
  "it isn't on the training-wheels list of what a first pull request needs",
  'ask a reviewer to run it, or use a command from the list in README.md');

// ---------------------------------------------------------------------------------------------
// Reading a command line
// ---------------------------------------------------------------------------------------------

/**
 * A word after quote removal. `dollar`: a $ expansion or $'...' string the shell would rewrite.
 * `escape`: an escape character the shell would remove (backslash in bash, backtick in PowerShell).
 * `glob`: an unquoted *, ? or [ the shell may expand into file names.
 * @typedef {{ text: string, dollar: boolean, escape: boolean, glob: boolean }} Word
 */

/** What can follow a $ to make it an expansion. @param {string | undefined} c */
const expands = (c) => c !== undefined && /[A-Za-z_{(0-9@*#?$!'"-]/.test(c);

/**
 * Split a line into simple commands at ; && || | & newlines and parentheses, never inside quotes,
 * skipping heredoc bodies. Notes the first construct that makes the line unreadable: command
 * substitution, a bash backtick, an unquoted brace, process substitution, a heredoc that runs a command.
 * @param {string} src
 * @param {Shell} shell
 * @returns {{ commands: Word[][], why: string | null }}
 */
export function parse(src, shell = 'bash') {
  /** @type {Word[][]} */
  const commands = [];
  /** @type {Word[]} */
  let words = [];
  /** @type {Word | null} */
  let cur = null;
  /** @type {null | "'" | '"'} */
  let quote = null;
  /** @type {{ delim: string, strip: boolean, expands: boolean }[]} */
  let heredocs = [];
  /** @type {string | null} */
  let why = null;
  const flag = (w) => { why ??= w; };
  const word = () => (cur ??= { text: '', dollar: false, escape: false, glob: false });
  const endWord = () => {
    if (cur) words.push(cur);
    cur = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  const escapeChar = shell === 'powershell' ? '`' : '\\';

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word().text += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === escapeChar && (shell === 'powershell' || '"\\$`'.includes(src[i + 1] ?? ''))) {
        word().escape = true;
        word().text += src[++i] ?? '';
      } else {
        if (c === '`') flag('a backtick');
        if (c === '$' && src[i + 1] === '(') flag('$( ... )');
        if (c === '$' && expands(src[i + 1])) word().dollar = true;
        word().text += c;
      }
      continue;
    }
    // Unquoted.
    if (c === "'" || c === '"') {
      word();
      quote = c;
    } else if (c === escapeChar) {
      if (src[i + 1] !== '\n') {
        word().escape = true;
        word().text += src[i + 1] ?? '';
      }
      i++;
    } else if (c === '`') {
      flag('a backtick');
    } else if (c === '$') {
      if (src[i + 1] === '(') flag('$( ... )');
      if (expands(src[i + 1])) word().dollar = true;
      word().text += c;
    } else if (c === '{' || c === '}') {
      flag('braces');
      word().text += c;
    } else if ((c === '<' || c === '>') && src[i + 1] === '(') {
      flag('process substitution');
      endCommand();
    } else if (src.startsWith('<<<', i)) {
      endWord();
      words.push({ text: '<<<', dollar: false, escape: false, glob: false });
      i += 2;
    } else if (c === '<' && src[i + 1] === '<') {
      // A heredoc: note its delimiter; its body starts at the next newline.
      let j = i + 2;
      const strip = src[j] === '-';
      if (strip) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      let delim = '';
      let quoted = false;
      while (j < src.length && !/[\s;&|<>()]/.test(src[j])) {
        if (src[j] === "'" || src[j] === '"') {
          const q = src[j++];
          quoted = true;
          while (j < src.length && src[j] !== q) delim += src[j++];
          j++;
        } else if (src[j] === '\\') {
          quoted = true;
          delim += src[j + 1] ?? '';
          j += 2;
        } else delim += src[j++];
      }
      if (delim) heredocs.push({ delim, strip, expands: !quoted });
      endWord();
      i = j - 1;
    } else if (c === '\n' && heredocs.length) {
      endCommand();
      let pos = i + 1;
      for (const h of heredocs) {
        while (pos < src.length) {
          const nl = src.indexOf('\n', pos);
          const end = nl === -1 ? src.length : nl;
          let text = src.slice(pos, end).replace(/\r$/, '');
          if (h.strip) text = text.replace(/^\t+/, '');
          pos = end + 1;
          if (text === h.delim) break;
          if (h.expands && /\$\(|`/.test(text)) flag('a heredoc that runs a command');
        }
      }
      heredocs = [];
      i = pos - 1;
    } else if (';&|()\n\r'.includes(c)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      const w = word();
      if ('*?['.includes(c)) w.glob = true;
      w.text += c;
    }
  }
  endCommand();
  return { commands, why };
}

/**
 * The simple commands in a line, as plain words.
 * @param {string} src @param {Shell} [shell]
 * @returns {string[][]}
 */
export function splitCommands(src, shell = 'bash') {
  return parse(src, shell).commands.map((ws) => ws.map((w) => w.text));
}

// A line that mentions git, even spelled with quotes or punctuation in between (g'i't, ('g'+'it')).
const MENTIONS_GIT = /g[^a-z0-9]*i[^a-z0-9]*t/i;
// The one redirection kept: duplicating one numbered stream onto another (2>&1, >&2). It names no file
// and takes no word, so removing it changes nothing git sees.
const FD_DUP = /(^|\s)\d?[<>]&(\d|-)(?=\s|$|;|&&|\|\|)/g;

/**
 * The first of these characters that appears outside quotes in a line, or null.
 * @param {string} line @param {string} chars
 */
function unquoted(line, chars) {
  /** @type {string | null} */
  let quote = null;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (chars.includes(c)) return c;
  }
  return null;
}

/**
 * Refusals on the raw text of a line that mentions git, before any parsing: redirections that can
 * take a word with them, backslashes, and line breaks.
 * @param {string} line
 * @returns {string | null} why, or null
 */
function rawRefusal(line) {
  if (!MENTIONS_GIT.test(line)) return null;
  const rest = line.replace(FD_DUP, '$1');
  if (/>&|<&|&>|\|&/.test(rest)) return 'a redirection in a git line';
  if (line.includes('\\')) return 'a backslash in a git line';
  if (/[\r\n]/.test(line)) return 'a line break in a git line';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------------------------

/** The program a word names: "C:\\Program Files\\Git\\cmd\\git.exe" and "/usr/bin/git" are both "git". */
const program = (w) => basename(w.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();

const RM = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri']);
// Programs that run another command, or define a name or variable that another command will use.
const REFUSED_PROGRAMS = new Set(['xargs', 'env', 'eval', 'iex', 'invoke-expression', 'invoke-command', 'icm', 'start-process', 'saps',
  'start', 'start-job', 'sajb', 'foreach-object', '%', 'parallel', 'watch', 'su', 'doas', 'runas', 'chroot', 'script', 'unbuffer',
  'stdbuf', 'ionice', 'chronic', 'time', 'busybox', 'cmd', 'wsl', 'trap', 'alias', 'set-variable', 'sv', 'new-variable', 'nv',
  'set-alias', 'sal', 'new-alias', 'nal', 'set-item', 'si', 'new-item', 'ni']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const INLINE_CODE = new Map([
  ['node', /^(-e|--eval|-p|--print)$/], ['python', /^-c$/], ['python3', /^-c$/], ['py', /^-c$/], ['perl', /^-[eE]$/],
  ['ruby', /^-e$/], ['php', /^-r$/], ['deno', /^eval$/], ['bun', /^(-e|--eval)$/],
]);
const RISKY_VARIABLE = /^(GIT_[A-Z_]*|EDITOR|VISUAL|PAGER|PATH|LESS|LESSOPEN|BASH_ENV|ENV)$/i;
// A program name the guard reads as a name: letters, digits and path characters, nothing to evaluate.
const PLAIN_PROGRAM = /^[A-Za-z0-9_.\/:\\-]+$/;

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

const GIT_GLOBAL_VALUE = new Set(['-C', '-c']);
const GIT_GLOBAL_FLAG = new Set(['--no-pager', '-P', '--version', '--help', '-v', '-h']);
// Settings that can't make git run a program: the only ones -c or git config may set.
const SAFE_CONFIG = /^(user\.(name|email)|color\.[a-z.]+|core\.(quotepath|autocrlf|safecrlf)|init\.defaultbranch|advice\.[a-z]+|push\.(default|autosetupremote)|pull\.ff|fetch\.prune)$/i;

/**
 * A subcommand's allowed options: short letters that take a value (attached, or the next word), short
 * letters that take none, and long options that take a value or none. Anything else is off the list.
 * @typedef {{ shortValue?: string, shortFlags?: string, longValue?: string[], longFlags?: string[] }} Spec
 */

/**
 * Walk a subcommand's arguments the way git parses them, against its allowed options.
 * @param {string[]} args
 * @param {Spec} spec
 * @returns {{ longs: string[], shorts: string, valued: string, positional: string[], paths: string[], off: string | null }}
 */
function walk(args, spec) {
  const longs = [];
  let shorts = '';
  let valued = '';
  const positional = [];
  let paths = [];
  /** @type {string | null} */
  let off = null;
  const known = [...(spec.longValue ?? []), ...(spec.longFlags ?? [])];
  for (let k = 0; k < args.length && !off; k++) {
    const a = args[k];
    if (a === '--') {
      paths = args.slice(k + 1);
      break;
    }
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      const matches = known.filter((n) => n.startsWith(name));
      const resolved = known.includes(name) ? name : matches.length === 1 ? matches[0] : null;
      if (!resolved) {
        off = a;
        break;
      }
      longs.push(resolved);
      if (!a.includes('=') && spec.longValue?.includes(resolved)) k++;
      continue;
    }
    if (a.length > 1 && a.startsWith('-')) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (spec.shortValue?.includes(c)) {
          valued += c;
          if (j === a.length - 1) k++;
          break;
        }
        if (!spec.shortFlags?.includes(c)) {
          off = a;
          break;
        }
        shorts += c;
      }
      continue;
    }
    positional.push(a);
  }
  return { longs, shorts, valued, positional, paths, off };
}

/**
 * A long option as git matches it: the full name or any prefix of it (git accepts an unambiguous
 * prefix, so --forc is --force; an ambiguous one makes git refuse to run, so counting it costs nothing).
 * @param {string[]} args @param {...string} names
 */
const hasLong = (args, ...names) => args.some((a) => {
  if (!a.startsWith('--') || a === '--') return false;
  const name = a.split('=')[0];
  return names.some((n) => name === n || (name.length > 2 && n.startsWith(name)));
});
/** A short option letter, alone or in a cluster. @param {string[]} args @param {string} ch */
const hasShort = (args, ch) => args.some((a) => /^-[A-Za-z0-9]+$/.test(a) && a.slice(1).includes(ch));
/** Options only: everything before a lone "--". @param {string[]} args */
const optsOf = (args) => (args.includes('--') ? args.slice(0, args.indexOf('--')) : args);

/**
 * The classic ways to lose work, with their own reason. Detected generously (a letter anywhere in a
 * cluster counts): anything caught here would be refused by the list anyway, so this only picks the
 * message.
 * @param {string} sub @param {string[]} rest @param {Required<Context>} ctx
 * @returns {Block | null}
 */
function classic(sub, rest, ctx) {
  const o = optsOf(rest);
  const positional = o.filter((a) => !a.startsWith('-'));
  switch (sub) {
    case 'push':
      if (hasLong(o, '--force', '--force-with-lease', '--force-if-includes') || hasShort(o, 'f') || positional.some((a) => a.startsWith('+'))) {
        return block('force-push', 'git push --force',
          'a force push replaces the branch on GitHub with yours, and whatever it replaces is gone for everyone who uses it',
          'pull first (git pull), fix any conflicts, then push normally');
      }
      if (hasLong(o, '--delete', '--prune', '--mirror') || hasShort(o, 'd') || positional.slice(1).some((a) => a.startsWith(':'))) {
        return block('remote-delete', 'git push --delete',
          'it deletes branches on GitHub, and a deleted branch there takes its unmerged commits with it',
          'leave the branch; GitHub offers to delete it for you after the pull request merges');
      }
      return null;
    case 'reset':
      return hasLong(o, '--hard', '--merge', '--keep') ? block('reset-hard', 'git reset --hard',
        "it throws away every change you haven't committed, and git can't bring those changes back",
        'git stash sets your changes aside, and git stash pop brings them back') : null;
    case 'branch':
      if (hasShort(o, 'D') || hasShort(o, 'd') || hasLong(o, '--delete')) {
        return block('branch-delete', 'git branch -d',
          "it deletes a branch, and any of its work that isn't merged goes with it",
          'leave it; GitHub offers to delete the branch after the pull request merges');
      }
      if (hasShort(o, 'f') || hasShort(o, 'M') || hasShort(o, 'C') || hasLong(o, '--force')) {
        return block('branch-force', 'git branch --force',
          'it overwrites an existing branch, and the commits that branch pointed to can be lost',
          'pick a new branch name instead of reusing one that exists');
      }
      return null;
    case 'clean':
      return hasShort(o, 'f') || hasLong(o, '--force') ? block('clean', 'git clean -f',
        "it deletes files git isn't tracking, and since they were never committed, git can't bring them back",
        'git clean -n lists what would go, so you can delete only what you mean to by hand') : null;
    case 'checkout': {
      if (hasShort(o, 'f') || hasLong(o, '--force')) {
        return block('checkout-force', 'git checkout --force',
          "it switches branches by throwing away changes you haven't committed",
          'commit or git stash your changes first, then switch');
      }
      if (hasShort(o, 'B')) {
        return block('checkout-reset-branch', 'git checkout -B',
          'it resets a branch that already exists, and its commits can be lost',
          'git switch -c with a new branch name');
      }
      const creating = hasShort(o, 'b') || hasLong(o, '--orphan');
      const discards = rest.includes('--') || positional.includes('.')
        || (!creating && (positional.length > 1 || (positional.length === 1 && !ctx.isRef(positional[0]) && ctx.isPath(positional[0]))));
      return discards ? block('checkout-files', 'git checkout -- <file>',
        "it replaces your files with the last committed version, and changes you haven't committed are gone for good",
        'git stash sets your changes aside, and git stash pop brings them back') : null;
    }
    case 'restore':
      return !(hasShort(o, 'S') || hasLong(o, '--staged')) || hasShort(o, 'W') || hasLong(o, '--worktree') ? block('restore', 'git restore <file>',
        "it replaces your files with the last committed version, and changes you haven't committed are gone for good",
        'git restore --staged <file> only unstages a file; git stash sets changes aside and git stash pop brings them back') : null;
    case 'switch':
      if (hasShort(o, 'f') || hasLong(o, '--discard-changes', '--force')) {
        return block('switch-discard', 'git switch --discard-changes',
          "it switches branches by throwing away changes you haven't committed",
          'commit or git stash your changes first, then switch');
      }
      return hasShort(o, 'C') || hasLong(o, '--force-create') ? block('switch-force-create', 'git switch -C',
        'it resets a branch that already exists, and its commits can be lost',
        'git switch -c with a new branch name') : null;
    case 'stash': {
      const action = rest.find((a) => !a.startsWith('-'));
      return action === 'drop' || action === 'clear' ? block('stash-drop', `git stash ${action}`,
        'it deletes stashed changes, and git keeps no easy way back to them',
        'leave the stash where it is; git stash list shows what is in it') : null;
    }
    case 'rebase':
      return rest.length === 1 && hasLong(rest, '--abort', '--quit') ? null : block('rebase', 'git rebase',
        'it rewrites the commits on your branch, which confuses anyone who already has them',
        'git merge main brings main into your branch without rewriting anything');
    case 'commit':
      return hasLong(o, '--amend') ? block('amend', 'git commit --amend',
        'it rewrites your last commit, and if that commit is already pushed, only a force push can follow',
        'make a new commit with the fix; history stays as it was') : null;
    case 'rm':
      return hasShort(o, 'f') || hasLong(o, '--force') ? block('rm-force', 'git rm --force',
        "it deletes files even when they have changes you haven't committed",
        'commit or git stash your changes first, then git rm without --force') : null;
    case 'filter-branch':
    case 'filter-repo':
      return block('rewrite-history', `git ${sub}`, "it rewrites the project's whole history", 'leave history alone; ask someone who maintains the repository');
    default:
      return null;
  }
}

// Read-only subcommands, each with the options it may use; any other option is off the list (so, for
// example, diff --output, which overwrites a file, grep -O and ls-remote --upload-pack, which start a
// program). An option that takes an optional value is listed as a flag: git only reads its value
// when it's attached (--format=%h), so it never takes the next word.
const DIGITS = '0123456789';
/** @type {Record<string, Spec>} */
const READ_ONLY = {
  status: { shortFlags: 'sbvz', longFlags: ['--short', '--branch', '--porcelain', '--long', '--verbose', '--untracked-files', '--ignored',
    '--show-stash', '--ahead-behind', '--no-ahead-behind', '--renames', '--no-renames', '--column', '--no-column', '--null'] },
  diff: { shortValue: 'U', shortFlags: 'wbRpz', longValue: ['--unified', '--diff-filter'],
    longFlags: ['--staged', '--cached', '--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--word-diff', '--color',
      '--no-color', '--color-words', '--ignore-all-space', '--ignore-space-change', '--ignore-blank-lines', '--exit-code', '--quiet',
      '--check', '--minimal', '--patience', '--histogram', '--patch', '--no-patch', '--summary', '--merge-base', '--relative'] },
  log: { shortValue: 'nSG', shortFlags: `pi${DIGITS}`, longValue: ['--max-count', '--skip', '--since', '--after', '--until', '--before',
    '--author', '--committer', '--grep', '--date'],
  longFlags: ['--oneline', '--graph', '--decorate', '--no-decorate', '--all', '--branches', '--tags', '--remotes', '--stat', '--shortstat',
    '--numstat', '--name-only', '--name-status', '--patch', '--no-patch', '--follow', '--reverse', '--first-parent', '--merges',
    '--no-merges', '--abbrev-commit', '--format', '--pretty', '--color', '--no-color', '--left-right', '--word-diff', '--relative-date',
    '--date-order', '--topo-order', '--regexp-ignore-case'] },
  show: { shortValue: 'U', shortFlags: `psqw${DIGITS}`, longValue: ['--date'],
    longFlags: ['--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--oneline', '--format', '--pretty', '--patch',
      '--no-patch', '--abbrev-commit', '--color', '--no-color', '--word-diff', '--quiet', '--summary'] },
  blame: { shortValue: 'L', shortFlags: 'wesl', longValue: ['--date'],
    longFlags: ['--show-email', '--show-name', '--show-number', '--porcelain', '--line-porcelain', '--root', '--show-stats'] },
  shortlog: { shortFlags: 'sne', longFlags: ['--summary', '--numbered', '--email', '--all', '--no-merges'] },
  'ls-files': { shortFlags: 'mocdsuzt', longFlags: ['--modified', '--others', '--cached', '--deleted', '--stage', '--unmerged',
    '--exclude-standard', '--full-name', '--error-unmatch', '--directory', '--no-empty-directory', '--eol'] },
  'ls-remote': { shortFlags: 'qt', longValue: ['--sort'], longFlags: ['--heads', '--branches', '--tags', '--refs', '--quiet', '--get-url', '--symref'] },
  'rev-parse': { shortFlags: 'q', longFlags: ['--show-toplevel', '--abbrev-ref', '--short', '--git-dir', '--git-common-dir',
    '--is-inside-work-tree', '--is-inside-git-dir', '--verify', '--quiet', '--symbolic-full-name', '--show-prefix', '--show-cdup',
    '--absolute-git-dir'] },
  describe: { longFlags: ['--tags', '--all', '--always', '--abbrev', '--dirty', '--long', '--contains', '--exact-match', '--first-parent'] },
  grep: { shortValue: 'eABC', shortFlags: `niwlLcvEFIhH${DIGITS}`, longValue: ['--max-depth', '--context', '--after-context', '--before-context'],
    longFlags: ['--line-number', '--ignore-case', '--word-regexp', '--files-with-matches', '--files-without-match', '--count', '--invert-match',
      '--extended-regexp', '--fixed-strings', '--basic-regexp', '--cached', '--untracked', '--break', '--heading', '--full-name',
      '--only-matching', '--column', '--color', '--no-color', '--all-match', '--and', '--or', '--not'] },
  help: { shortFlags: 'ag', longFlags: ['--all', '--guides'] },
  version: { longFlags: ['--build-options'] },
};

/** @param {string[]} rest @param {Spec} spec */
function offWalk(rest, spec) {
  return walk(rest, spec).off;
}

/**
 * The list: each subcommand a first pull request needs, with the options it may use and any rule on
 * its arguments. Each returns null when the command is on the list, or what put it off the list.
 * @type {Record<string, (rest: string[], ctx: Required<Context>) => string | null>}
 */
const ALLOWED = {
  add: (rest) => offWalk(rest, { shortFlags: 'AuvnN', longFlags: ['--all', '--update', '--verbose', '--dry-run', '--intent-to-add'] }),
  commit: (rest) => {
    const w = walk(rest, { shortValue: 'mF', shortFlags: 'a', longValue: ['--message', '--file'], longFlags: ['--all'] });
    if (w.off) return w.off;
    return w.valued || w.longs.some((n) => n === '--message' || n === '--file') ? null : 'commit without -m';
  },
  branch: (rest) => {
    const w = walk(rest, { shortValue: 'u', shortFlags: 'arlv', longValue: ['--set-upstream-to', '--sort', '--format', '--points-at'],
      longFlags: ['--all', '--remotes', '--list', '--verbose', '--show-current', '--merged', '--no-merged', '--contains', '--no-contains', '--color', '--no-color'] });
    return w.off ?? (w.positional.length > 2 || w.paths.length ? 'branch with these arguments' : null);
  },
  checkout: (rest, ctx) => {
    const w = walk(rest, { shortValue: 'b', shortFlags: 'qt', longFlags: ['--quiet', '--track', '--no-track'] });
    if (w.off) return w.off;
    if (w.paths.length) return 'checkout with paths';
    if (w.valued.includes('b')) return w.positional.length <= 1 ? null : 'checkout -b with these arguments';
    return w.positional.length === 1 && ctx.isRef(w.positional[0]) && !ctx.isPath(w.positional[0]) ? null : 'checkout of something that is not a branch';
  },
  switch: (rest) => {
    const w = walk(rest, { shortValue: 'c', shortFlags: 'qt', longValue: ['--create'], longFlags: ['--quiet', '--track', '--no-track', '--guess', '--no-guess'] });
    if (w.off) return w.off;
    if (w.paths.length) return 'switch with paths';
    const creating = w.valued.includes('c') || w.longs.includes('--create');
    return (creating ? w.positional.length <= 1 : w.positional.length === 1) ? null : 'switch with these arguments';
  },
  restore: (rest) => {
    const w = walk(rest, { shortFlags: 'Sq', longFlags: ['--staged', '--quiet'] });
    return w.off ?? (w.shorts.includes('S') || w.longs.includes('--staged') ? null : 'restore without --staged');
  },
  reset: (rest) => offWalk(rest, { shortFlags: 'q', longFlags: ['--soft', '--mixed', '--quiet'] }),
  // Only the dry run, which lists what -f would delete.
  clean: (rest) => {
    const w = walk(rest, { shortFlags: 'ndxXq', longFlags: ['--dry-run', '--quiet'] });
    return w.off ?? (w.shorts.includes('n') || w.longs.includes('--dry-run') ? null : 'clean without -n');
  },
  // Only stepping out of one that's already under way.
  rebase: (rest) => (rest.length === 1 && hasLong(rest, '--abort', '--quit') ? null : 'rebase'),
  rm: (rest) => offWalk(rest, { shortFlags: 'rnq', longFlags: ['--cached', '--dry-run', '--quiet', '--ignore-unmatch'] }),
  mv: (rest) => offWalk(rest, { shortFlags: 'nvk', longFlags: ['--dry-run', '--verbose'] }),
  stash: (rest) => {
    const action = rest.find((a) => !a.startsWith('-')) ?? 'push';
    const after = rest.slice(rest.indexOf(action) + 1);
    if (action === 'push') {
      return offWalk(rest[0] === 'push' ? after : rest, { shortValue: 'm', shortFlags: 'uq', longValue: ['--message'], longFlags: ['--include-untracked', '--quiet'] });
    }
    if (['pop', 'apply', 'list', 'show'].includes(action)) {
      const w = walk(after, { shortFlags: 'qp', longFlags: ['--quiet', '--patch', '--stat', '--index'] });
      return w.off ?? (w.positional.length || w.paths.length ? `stash ${action} with these arguments` : null);
    }
    return `stash ${action}`;
  },
  merge: (rest) => offWalk(rest, { shortValue: 'm', shortFlags: 'qv', longValue: ['--message'],
    longFlags: ['--no-ff', '--ff-only', '--ff', '--no-edit', '--abort', '--continue', '--quit', '--quiet', '--verbose', '--stat', '--no-stat', '--log', '--no-log'] }),
  fetch: (rest) => {
    const w = walk(rest, { shortFlags: 'pqvt', longValue: ['--depth'], longFlags: ['--all', '--prune', '--tags', '--no-tags', '--quiet', '--verbose', '--dry-run'] });
    return w.off ?? (w.positional.some((a) => /^\+|:/.test(a)) || w.paths.length ? 'fetch with a refspec' : null);
  },
  pull: (rest) => {
    const w = walk(rest, { shortFlags: 'qv', longFlags: ['--ff-only', '--no-rebase', '--ff', '--no-ff', '--no-edit', '--quiet', '--verbose', '--tags', '--autostash'] });
    return w.off ?? (w.positional.some((a) => /^\+|:/.test(a)) || w.paths.length ? 'pull with a refspec' : null);
  },
  push: (rest) => {
    const w = walk(rest, { shortFlags: 'unqv', longFlags: ['--set-upstream', '--dry-run', '--quiet', '--verbose', '--tags', '--follow-tags', '--progress', '--porcelain'] });
    if (w.off) return w.off;
    const refspecs = w.positional.slice(1);
    return w.paths.length || refspecs.some((r) => /^[+:]|:$/.test(r)) ? 'push with this refspec' : null;
  },
  remote: (rest) => {
    const w = walk(rest, { shortFlags: 'v', longFlags: ['--verbose'] });
    if (w.off) return w.off;
    const [action, name, ...more] = w.positional;
    return action === undefined || (['get-url', 'show'].includes(action) && name && !more.length) ? null : `remote ${action}`;
  },
  tag: (rest) => {
    const w = walk(rest, { shortValue: 'mF', shortFlags: 'lan', longValue: ['--message', '--file'], longFlags: ['--list', '--annotate'] });
    return w.off ?? (w.positional.length > 2 ? 'tag with these arguments' : null);
  },
  reflog: (rest) => (rest.length === 0 || rest[0] === 'show' ? null : `reflog ${rest[0]}`),
  init: (rest) => offWalk(rest, { shortValue: 'b', shortFlags: 'q', longValue: ['--initial-branch'], longFlags: ['--quiet'] }),
  clone: (rest) => {
    const w = walk(rest, { shortValue: 'b', shortFlags: 'q', longValue: ['--branch', '--depth'], longFlags: ['--quiet', '--single-branch', '--no-single-branch'] });
    return w.off ?? (w.positional.length < 1 || w.positional.length > 2 ? 'clone with these arguments' : null);
  },
  config: (rest) => {
    const scope = ['--global', '--local', '--system', '--get', '--get-all', '--list', '-l', '--show-origin', '--name-only'];
    const bad = rest.find((a) => a.startsWith('-') && !scope.includes(a));
    if (bad) return `config ${bad}`;
    const plain = rest.filter((a) => !a.startsWith('-'));
    const reading = rest.some((a) => ['--get', '--get-all', '--list', '-l'].includes(a)) || plain.length <= 1;
    if (reading) return plain.length <= 1 ? null : 'config with these arguments';
    return plain.length === 2 && SAFE_CONFIG.test(plain[0]) ? null : `config ${plain[0]}`;
  },
};

/**
 * The verdict on one git command (the words after "git").
 * @param {Word[]} argWords
 * @param {Required<Context>} ctx
 * @returns {Block | null}
 */
function checkGit(argWords, ctx) {
  for (const w of argWords) {
    if (w.dollar) return unreadable('git with a shell variable');
    if (w.escape) return unreadable('git with an escape character');
    if (w.glob) return unreadable('git with a wildcard');
    if (/^@[A-Za-z_]/.test(w.text)) return unreadable('git with a splatted variable');
  }
  const args = argWords.map((w) => w.text);
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const opt = args[i];
    if (opt === '-c' && !SAFE_CONFIG.test((args[i + 1] ?? '').split('=')[0])) return unreadable(`git -c ${(args[i + 1] ?? '').split('=')[0]}`);
    if (GIT_GLOBAL_VALUE.has(opt)) i += 2;
    else if (GIT_GLOBAL_FLAG.has(opt)) i += 1;
    else return offList(`git ${opt}`);
  }
  const sub = args[i];
  if (sub === undefined) return null;
  const rest = args.slice(i + 1);

  const found = classic(sub, rest, ctx);
  if (found) return found;
  if (Object.hasOwn(READ_ONLY, sub)) {
    const off = walk(rest, READ_ONLY[sub]).off;
    return off ? offList(`git ${sub} ${off}`) : null;
  }
  const allow = Object.hasOwn(ALLOWED, sub) ? ALLOWED[sub] : null;
  if (!allow) return offList(ctx.alias(sub) !== null ? `git ${sub} (an alias)` : `git ${sub}`);
  const why = allow(rest, ctx);
  return why === null ? null : offList(`git ${why.startsWith('-') ? `${sub} ${why}` : why}`);
}

// ---------------------------------------------------------------------------------------------
// One command, one line
// ---------------------------------------------------------------------------------------------

/**
 * Strip the wrappers the guard reads exactly: sudo, command, exec and nohup with no options, timeout
 * with just a duration, nice with no options or -n N.
 * @param {Word[]} w
 * @returns {{ rest: Word[], wrapped: boolean } | { refused: Block }}
 */
function stripWrappers(w) {
  let wrapped = false;
  for (;;) {
    const p = w.length ? program(w[0].text) : '';
    const next = w[1]?.text ?? '';
    if (['sudo', 'exec', 'nohup'].includes(p)) {
      if (next.startsWith('-')) return { refused: unreadable(`${p} ${next}`) };
      w = w.slice(1);
    } else if (p === 'command') {
      if (/^-[vV]$/.test(next)) return { rest: [], wrapped: false };
      if (next.startsWith('-')) return { refused: unreadable(`command ${next}`) };
      w = w.slice(1);
    } else if (p === 'timeout') {
      if (!/^\d+(\.\d+)?[smhd]?$/.test(next)) return { refused: unreadable(`timeout ${next}`) };
      w = w.slice(2);
    } else if (p === 'nice') {
      if (next === '-n' && /^-?\d+$/.test(w[2]?.text ?? '')) w = w.slice(3);
      else if (next.startsWith('-')) return { refused: unreadable(`nice ${next}`) };
      else w = w.slice(1);
    } else break;
    wrapped = true;
  }
  return { rest: w, wrapped };
}

/**
 * The verdict on one simple command.
 * @param {Word[]} command @param {Required<Context>} ctx
 * @returns {Block | null}
 */
function checkCommand(command, ctx) {
  let w = command;
  let assigned = false;
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0].text)) {
    w = w.slice(1);
    assigned = true;
  }
  const stripped = stripWrappers(w);
  if ('refused' in stripped) return stripped.refused;
  w = stripped.rest;
  if (!w.length) return null;
  const head = w[0];
  if (head.dollar || head.escape || head.glob || !PLAIN_PROGRAM.test(head.text)) return unreadable('a command named by an expression');
  const prog = program(head.text);
  const args = w.slice(1);
  const texts = args.map((a) => a.text);

  if (prog === 'git') return assigned ? unreadable('git with variables set in front of it') : checkGit(args, ctx);
  if (prog.startsWith('git-')) return offList(prog);
  if (prog === 'gh') {
    if (texts[0] === 'repo' && texts[1] === 'delete') {
      return block('repo-delete', 'gh repo delete', 'it deletes the whole repository on GitHub', 'archive it on GitHub instead, which can be undone');
    }
    return texts[0] === 'api' ? offList('gh api') : null;
  }
  if (RM.has(prog)) {
    return texts.some((a) => /(^|[\\/])\.git[\\/]?$/.test(a)) ? block('delete-dot-git', 'rm -rf .git',
      "it deletes the .git folder, which is the project's entire history", 'leave .git alone; ask for help with whatever you were trying to undo') : null;
  }
  if (stripped.wrapped) return unreadable(`${prog} after a wrapper`);
  if (REFUSED_PROGRAMS.has(prog)) return unreadable(prog);
  if (prog === 'export' || prog === 'declare' || prog === 'typeset') {
    return texts.some((a) => RISKY_VARIABLE.test(a.split('=')[0])) ? unreadable(`${prog} ${texts.join(' ')}`) : null;
  }
  if (prog === 'find' && texts.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a))) return unreadable('find -exec');
  if (INLINE_CODE.has(prog) && texts.some((a) => INLINE_CODE.get(prog)?.test(a))) return unreadable(`${prog} running inline code`);
  if (SHELLS.has(prog) || prog === 'source' || prog === '.') {
    const first = texts[0];
    const fromInput = first === undefined || first === '-' || /^[-+]/.test(first) || /^\d*</.test(first)
      || /^\/(dev\/(stdin|fd\/\d+)|proc\/self\/fd\/\d+)$/.test(first) || texts.includes('<<<');
    return fromInput ? unreadable(`${prog} ${first ?? ''}`.trim()) : null;
  }
  if (POWERSHELLS.has(prog)) {
    const k = texts.findIndex((a) => /^-f(i(le?)?)?$/i.test(a));
    const before = k === -1 ? texts : texts.slice(0, k);
    const plainFlags = before.every((a, n) => /^-(noprofile|nologo|noninteractive|nop|nol|noni)$/i.test(a)
      || /^-(executionpolicy|ep|ex)$/i.test(a) || /^-(executionpolicy|ep|ex)$/i.test(before[n - 1] ?? ''));
    return k !== -1 && plainFlags && texts[k + 1] && texts[k + 1] !== '-' ? null : unreadable(`${prog} ${texts[0] ?? ''}`.trim());
  }
  return null;
}

/**
 * The verdict on one command line, or null if nothing in it is blocked.
 * @param {string} line
 * @param {Context} [context]
 * @returns {Block | null}
 */
export function check(line, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  /** @type {Required<Context>} */
  const ctx = {
    cwd,
    shell: context.shell ?? 'bash',
    isRef: context.isRef ?? ((name) => gitOk(cwd, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`])),
    isPath: context.isPath ?? ((name) => existsSync(resolve(cwd, name))),
    alias: context.alias ?? ((name) => gitOut(cwd, ['config', '--get', `alias.${name}`])),
  };
  const raw = rawRefusal(line);
  if (raw) return unreadable(raw);
  if (MENTIONS_GIT.test(line)) {
    // Curly quotes are quotes to PowerShell but not to this reader, so the two could split a line differently.
    if (/[“”‘’]/.test(line)) return unreadable('a curly quote in a git line');
    if (ctx.shell === 'powershell') {
      // The backtick is PowerShell's escape character; nothing a first pull request needs uses it.
      if (line.includes('`')) return unreadable('a PowerShell backtick in a git line');
      // PowerShell builds arguments from expressions: (subexpressions), @(arrays), a,b lists and @splats.
      const c = unquoted(line, '(,@');
      if (c) return unreadable(`a PowerShell ${c} in a git line`);
    }
  }
  const { commands, why } = parse(line.replace(FD_DUP, '$1'), ctx.shell);
  if (why) return unreadable(why);
  for (const command of commands) {
    const found = checkCommand(command, ctx);
    if (found) return found;
  }
  return null;
}

/** @param {string} cwd @param {string[]} args */
function gitOk(cwd, args) {
  try {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** @param {string} cwd @param {string[]} args @returns {string | null} */
function gitOut(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || null;
  } catch {
    return null;
  }
}

/** The hook's answer for a blocked command: what Claude Code reads, and what the person sees. @param {Block} b */
export function denial(b) {
  const sentence = `training-wheels stopped \`${b.shown}\`: ${b.why}. Instead: ${b.instead}.`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${sentence} Explain this to the person in plain words, and don't look for a way around it.`,
    },
    systemMessage: sentence,
  };
}

function main() {
  if (/^(off|0|false|no)$/i.test(process.env.TRAINING_WHEELS ?? '')) return;
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return;
  const found = check(command, {
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    shell: input.tool_name === 'PowerShell' ? 'powershell' : 'bash',
  });
  if (found) process.stdout.write(JSON.stringify(denial(found)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    // A broken check lets the command through rather than locking you out; Claude Code shows this line.
    process.stderr.write(`training-wheels could not check this command: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
