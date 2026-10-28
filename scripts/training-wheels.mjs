#!/usr/bin/env node
// training-wheels: a Claude Code PreToolUse hook that stops the git commands you can't take back.
//
// Claude Code runs this before every Bash or PowerShell command the agent wants to run, with the
// call as JSON on stdin. If the command would throw away work for good, or rewrite history other
// people may already have, this prints a "deny" decision with a one-sentence reason and a safer
// command, and the command never runs. Anything else gets no output, so Claude Code's normal
// permission flow carries on.
//
// What it is for: catching the honest mistakes an agent makes while helping a beginner. It is not a
// sandbox and not a defense against an agent set on getting around it.
//
// How it reads a command: it fully models plain `git <subcommand> ...`, walking each subcommand's
// options the way git does, and a few wrappers it can strip exactly (sudo, command, exec,
// timeout N, nice, nohup). Anything else that could carry a command (xargs, env, eval, a shell or
// PowerShell running a string, $( ... ), backticks, braces, a shell variable in a git command, an
// alias) is refused on purpose, with a note to run the command itself. Failing closed is the design:
// a command the guard can't read safely doesn't run.
//
// It only stops the agent. You can still type any of these yourself, and TRAINING_WHEELS=off in
// the environment Claude Code starts in turns the check off.
//
// No dependencies. Node 18 or later.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Reading a command line
// ---------------------------------------------------------------------------------------------

/**
 * A word, after quote removal. `dollar`: it holds a $ expansion (unquoted or inside double quotes)
 * or an ANSI-C $'...' string. `escape`: it holds a backslash escape the shell would remove.
 * @typedef {{ text: string, dollar: boolean, escape: boolean }} Word
 * @typedef {{ commands: Word[][], unreadable: string | null }} Parsed
 */

/** What can follow a $ to make it an expansion. @param {string | undefined} c */
const expands = (c) => c !== undefined && /[A-Za-z_{(0-9@*#?$!'"-]/.test(c);

/**
 * Split a command line into simple commands at ; && || | & newlines and parentheses, never inside
 * quotes, skipping heredoc bodies. It also notes the first thing that makes the line unreadable:
 * a command substitution, a backtick, an unquoted brace (a group or a script block), a process
 * substitution, or a heredoc whose body would run a command.
 * @param {string} src
 * @returns {Parsed}
 */
export function parse(src) {
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
  let unreadable = null;
  const flag = (why) => { unreadable ??= why; };
  const word = () => (cur ??= { text: '', dollar: false, escape: false });
  const endWord = () => {
    if (cur) words.push(cur);
    cur = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word().text += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && '"\\$`'.includes(src[i + 1] ?? '')) {
        word().escape = true;
        word().text += src[++i];
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
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') {
        word().escape = true;
        if (i + 1 < src.length) word().text += src[i + 1];
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
      words.push({ text: '<<<', dollar: false, escape: false });
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
      word().text += c;
    }
  }
  endCommand();
  return { commands, unreadable };
}

/**
 * The simple commands in a line, as plain words. Kept for tests and for anyone reusing the parser.
 * @param {string} src
 * @returns {string[][]}
 */
export function splitCommands(src) {
  return parse(src).commands.map((ws) => ws.map((w) => w.text));
}

// ---------------------------------------------------------------------------------------------
// What a refusal says
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ rule: string, shown: string, why: string, instead: string }} Block
 * @typedef {{ cwd?: string, isRef?: (name: string) => boolean, isPath?: (name: string) => boolean, alias?: (name: string) => string | null }} Context
 */

/** @param {string} rule @param {string} shown @param {string} why @param {string} instead @returns {Block} */
const block = (rule, shown, why, instead) => ({ rule, shown, why, instead });

/** A command the guard can't read safely. @param {string} what */
const unreadable = (what) => block('cannot-read', what,
  "the guard can't read safely what it would run, so it doesn't run",
  'run the command itself, written out in full, without wrappers, variables or $( ... ); for a long commit message, use one -m per paragraph');

// ---------------------------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------------------------

/** The program a word names: "C:\\Program Files\\Git\\cmd\\git.exe" and "/usr/bin/git" are both "git". */
const program = (w) => basename(w.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();

const RM = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri']);
// Programs that run another command given to them: refused, because the guard can't read what they'd run.
const CARRIERS = new Set(['xargs', 'env', 'eval', 'iex', 'invoke-expression', 'invoke-command', 'icm', 'start-process', 'saps',
  'start', 'start-job', 'sajb', 'foreach-object', '%', 'parallel', 'watch', 'su', 'doas', 'runas', 'chroot', 'script', 'unbuffer',
  'stdbuf', 'ionice', 'chronic', 'time', 'busybox', 'cmd', 'wsl', 'trap']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
// Interpreters, and the flags that make them run code given on the command line.
const INLINE_CODE = new Map([
  ['node', /^(-e|--eval|-p|--print)$/], ['python', /^-c$/], ['python3', /^-c$/], ['py', /^-c$/], ['perl', /^-[eE]$/],
  ['ruby', /^-e$/], ['php', /^-r$/], ['deno', /^eval$/], ['bun', /^(-e|--eval)$/],
]);
// Variables that make git run a program, or change which git runs.
const RISKY_VARIABLE = /^(GIT_[A-Z_]*|EDITOR|VISUAL|PAGER|PATH|LESS|LESSOPEN|BASH_ENV|ENV)$/i;

// ---------------------------------------------------------------------------------------------
// git: global options, subcommands and each subcommand's options
// ---------------------------------------------------------------------------------------------

// git's own options before the subcommand. Anything else there is refused.
const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const GIT_GLOBAL_FLAG = new Set(['--no-pager', '-P', '--paginate', '-p', '--bare', '--no-replace-objects', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch', '--version', '--help', '-v', '-h']);
// Settings that can't make git run a program: the only ones -c or git config may set.
const SAFE_CONFIG = /^(user\.(name|email)|color\.[a-z.]+|core\.(quotepath|autocrlf|safecrlf|filemode|ignorecase)|init\.defaultbranch|advice\.[a-z]+|push\.(default|autosetupremote)|pull\.(rebase|ff)|fetch\.prune|log\.(decorate|date)|merge\.conflictstyle|diff\.(renames|algorithm|colormoved))$/i;

// git's built-in commands. A subcommand that isn't one may be an alias, which is refused.
const BUILTINS = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore checkout '
  + 'checkout-index cherry cherry-pick citool clean clone column commit commit-tree config count-objects credential describe diff '
  + 'diff-files diff-index diff-tree difftool fast-export fast-import fetch filter-branch for-each-ref format-patch fsck '
  + 'gc grep gui hash-object help init instaweb log ls-files ls-remote ls-tree maintenance merge merge-base mergetool mv '
  + 'name-rev notes prune pull push range-diff read-tree rebase reflog remote repack replace request-pull reset restore '
  + 'rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout stage stash status submodule switch '
  + 'symbolic-ref tag update-index update-ref var verify-commit verify-tag version whatchanged worktree write-tree').split(' '));

/**
 * Each modeled subcommand's options: short letters that take a value (attached, or the next word),
 * letters whose value can only be attached, letters that take none, and long options that take a
 * value or none. An option that takes a value consumes it, so a value never reads as an option.
 * @typedef {{ shortValue?: string, shortOptional?: string, shortFlags?: string, longValue?: string[], longFlags?: string[] }} Spec
 * @type {Record<string, Spec>}
 */
const SPECS = {
  push: {
    shortValue: 'o', shortFlags: 'fundqv46',
    longValue: ['--repo', '--push-option', '--receive-pack', '--exec'],
    longFlags: ['--all', '--branches', '--mirror', '--delete', '--tags', '--dry-run', '--porcelain', '--force', '--prune',
      '--verbose', '--quiet', '--progress', '--no-progress', '--no-verify', '--verify', '--follow-tags', '--no-follow-tags',
      '--atomic', '--no-atomic', '--thin', '--no-thin', '--ipv4', '--ipv6', '--set-upstream', '--signed', '--no-signed',
      '--force-with-lease', '--no-force-with-lease', '--force-if-includes', '--no-force-if-includes', '--recurse-submodules',
      '--no-recurse-submodules'],
  },
  reset: {
    shortFlags: 'qpN',
    longValue: ['--pathspec-from-file'],
    longFlags: ['--soft', '--mixed', '--hard', '--merge', '--keep', '--quiet', '--patch', '--no-refresh', '--refresh',
      '--intent-to-add', '--recurse-submodules', '--no-recurse-submodules', '--pathspec-file-nul'],
  },
  branch: {
    shortValue: 'u', shortFlags: 'dDmMcCfralvqit',
    longValue: ['--set-upstream-to', '--points-at', '--format', '--sort'],
    longFlags: ['--delete', '--move', '--copy', '--force', '--remotes', '--all', '--list', '--verbose', '--quiet', '--ignore-case',
      '--track', '--no-track', '--unset-upstream', '--edit-description', '--show-current', '--create-reflog', '--no-create-reflog',
      '--contains', '--no-contains', '--merged', '--no-merged', '--color', '--no-color', '--column', '--no-column', '--abbrev',
      '--no-abbrev', '--omit-empty', '--recurse-submodules'],
  },
  clean: {
    shortValue: 'e', shortFlags: 'dfinqxX',
    longValue: ['--exclude'],
    longFlags: ['--force', '--interactive', '--dry-run', '--quiet'],
  },
  checkout: {
    shortValue: 'bB', shortFlags: 'qfmplt',
    longValue: ['--orphan', '--pathspec-from-file'],
    longFlags: ['--quiet', '--force', '--merge', '--patch', '--track', '--no-track', '--detach', '--ours', '--theirs', '--conflict',
      '--ignore-skip-worktree-bits', '--ignore-other-worktrees', '--overwrite-ignore', '--no-overwrite-ignore', '--recurse-submodules',
      '--no-recurse-submodules', '--overlay', '--no-overlay', '--pathspec-file-nul', '--progress', '--no-progress', '--guess', '--no-guess'],
  },
  switch: {
    shortValue: 'cC', shortFlags: 'dfmqt',
    longValue: ['--create', '--force-create', '--orphan'],
    longFlags: ['--detach', '--discard-changes', '--force', '--merge', '--conflict', '--quiet', '--progress', '--no-progress',
      '--track', '--no-track', '--guess', '--no-guess', '--ignore-other-worktrees', '--recurse-submodules', '--no-recurse-submodules'],
  },
  restore: {
    shortValue: 's', shortFlags: 'SWpqm',
    longValue: ['--source', '--pathspec-from-file'],
    longFlags: ['--staged', '--worktree', '--patch', '--quiet', '--progress', '--no-progress', '--ours', '--theirs', '--merge',
      '--conflict', '--ignore-unmerged', '--ignore-skip-worktree-bits', '--recurse-submodules', '--no-recurse-submodules', '--overlay',
      '--no-overlay', '--pathspec-file-nul'],
  },
  commit: {
    shortValue: 'mFCct', shortOptional: 'Su', shortFlags: 'apnsveioqz',
    longValue: ['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date',
      '--template', '--trailer', '--cleanup', '--pathspec-from-file'],
    longFlags: ['--all', '--patch', '--amend', '--no-edit', '--edit', '--signoff', '--no-signoff', '--no-verify', '--verify',
      '--allow-empty', '--allow-empty-message', '--include', '--only', '--short', '--branch', '--porcelain', '--long', '--null',
      '--dry-run', '--status', '--no-status', '--verbose', '--quiet', '--reset-author', '--no-post-rewrite', '--pathspec-file-nul',
      '--untracked-files', '--gpg-sign', '--no-gpg-sign'],
  },
  rm: {
    shortFlags: 'frnq',
    longValue: ['--pathspec-from-file'],
    longFlags: ['--force', '--dry-run', '--cached', '--ignore-unmatch', '--quiet', '--sparse', '--pathspec-file-nul'],
  },
  'update-ref': { shortValue: 'm', shortFlags: 'dz', longFlags: ['--no-deref', '--create-reflog', '--stdin'] },
  gc: { shortFlags: 'q', longFlags: ['--aggressive', '--auto', '--quiet', '--force', '--keep-largest-pack', '--cruft', '--no-cruft', '--prune', '--no-prune'] },
};

/**
 * Walk a subcommand's arguments the way git parses them.
 * @param {string[]} args
 * @param {Spec} spec
 * @returns {{ longs: string[], shorts: string, valued: string, positional: string[], paths: string[], bad: string | null }}
 */
function walk(args, spec) {
  const longs = [];
  let shorts = '';
  let valued = '';
  const positional = [];
  let paths = [];
  /** @type {string | null} */
  let bad = null;
  const known = [...(spec.longValue ?? []), ...(spec.longFlags ?? [])];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      paths = args.slice(k + 1);
      break;
    }
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      longs.push(name);
      if (!a.includes('=')) {
        // git accepts an unambiguous prefix; only an option that needs a value takes the next word.
        const matches = known.filter((n) => n.startsWith(name));
        const resolved = known.includes(name) ? name : matches.length === 1 ? matches[0] : null;
        if (resolved && spec.longValue?.includes(resolved)) k++;
      }
      continue;
    }
    if (a.length > 1 && a.startsWith('-')) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (spec.shortValue?.includes(c)) {
          valued += c;
          if (j === a.length - 1) k++; // the value is the next word; otherwise it's the rest of this one
          break;
        }
        if (spec.shortOptional?.includes(c)) break; // its value, if any, is the rest of this word
        if (!spec.shortFlags?.includes(c)) {
          bad = a; // a letter the guard doesn't know could take a value and change how the rest reads
          break;
        }
        shorts += c;
      }
      continue;
    }
    positional.push(a);
  }
  return { longs, shorts, valued, positional, paths, bad };
}

/**
 * A long option as git matches it: the full name, or any prefix of it (git accepts an unambiguous
 * prefix, so --forc is --force; an ambiguous one makes git refuse to run, so counting it costs nothing).
 * @param {string[]} longs @param {...string} names
 */
const hasLong = (longs, ...names) => longs.some((name) => names.some((n) => name === n || (name.length > 2 && n.startsWith(name))));

/**
 * The verdict on one git command (the words after "git").
 * @param {Word[]} argWords
 * @param {Required<Context>} ctx
 * @returns {Block | null}
 */
function checkGit(argWords, ctx) {
  for (const w of argWords) {
    if (w.dollar) return unreadable('git with a shell variable');
    if (w.escape) return unreadable('git with a backslash escape');
  }
  const args = argWords.map((w) => w.text);

  // git's own options, before the subcommand.
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const opt = args[i];
    const name = opt.split('=')[0];
    if (name === '-c' || name === '--config-env') {
      const kv = opt === '-c' ? args[i + 1] ?? '' : '';
      if (name === '--config-env' || !SAFE_CONFIG.test(kv.split('=')[0])) return unreadable(`git -c ${kv.split('=')[0] || '...'}`);
    }
    if (GIT_GLOBAL_VALUE.has(opt)) i += 2;
    else if (GIT_GLOBAL_VALUE.has(name) || GIT_GLOBAL_FLAG.has(opt)) i += 1;
    else return unreadable(`git ${opt}`);
  }
  const sub = args[i];
  if (sub === undefined) return null;
  const rest = args.slice(i + 1);
  if (sub === 'filter-repo') {
    return block('rewrite-history', 'git filter-repo', "it rewrites the project's whole history", 'leave history alone; ask someone who maintains the repository');
  }
  if (!BUILTINS.has(sub)) {
    // An alias runs whatever it stands for; external git-foo programs are someone else's.
    return ctx.alias(sub) !== null ? unreadable(`git ${sub} (an alias)`) : null;
  }

  const spec = SPECS[sub];
  const o = spec ? walk(rest, spec) : null;
  if (o?.bad) return unreadable(`git ${sub} ${o.bad}`);
  const flag = (c) => Boolean(o?.shorts.includes(c));
  const long = (...names) => Boolean(o && hasLong(o.longs, ...names));

  switch (sub) {
    case 'push':
      if (long('--force', '--force-with-lease', '--force-if-includes') || flag('f') || o.positional.some((a) => a.startsWith('+'))) {
        return block('force-push', 'git push --force',
          'a force push replaces the branch on GitHub with yours, and whatever it replaces is gone for everyone who uses it',
          'pull first (git pull), fix any conflicts, then push normally');
      }
      if (long('--delete', '--prune', '--mirror') || flag('d') || o.positional.slice(1).some((a) => a.startsWith(':'))) {
        return block('remote-delete', 'git push --delete',
          'it deletes branches on GitHub, and a deleted branch there takes its unmerged commits with it',
          'leave the branch; GitHub offers to delete it for you after the pull request merges');
      }
      return null;
    case 'reset':
      if (long('--hard', '--merge')) {
        return block('reset-hard', 'git reset --hard',
          "it throws away every change you haven't committed, and git can't bring those changes back",
          'git stash sets your changes aside, and git stash pop brings them back');
      }
      return null;
    case 'branch':
      if (flag('D') || (long('--delete') || flag('d')) && (long('--force') || flag('f'))) {
        return block('branch-force-delete', 'git branch -D',
          "it deletes a branch even when its commits aren't merged anywhere, so that work can be lost",
          'git branch -d deletes it only once its work is merged, and says so if it is not');
      }
      if (flag('M') || flag('C') || long('--force') || flag('f')) {
        return block('branch-force', 'git branch --force',
          'it overwrites an existing branch, and the commits that branch pointed to can be lost',
          'pick a new branch name instead of reusing one that exists');
      }
      return null;
    case 'clean':
      if ((long('--force') || flag('f')) && !(long('--dry-run') || flag('n'))) {
        return block('clean', 'git clean -f',
          "it deletes files git isn't tracking, and since they were never committed, git can't bring them back",
          'git clean -n lists what would go, so you can delete only what you mean to by hand');
      }
      return null;
    case 'checkout': {
      if (long('--force') || flag('f')) {
        return block('checkout-force', 'git checkout --force',
          "it switches branches by throwing away changes you haven't committed",
          'commit or git stash your changes first, then switch');
      }
      if (o.valued.includes('B')) {
        return block('checkout-reset-branch', 'git checkout -B',
          'it resets a branch that already exists, and its commits can be lost',
          'git switch -c with a new branch name');
      }
      const words = o.positional;
      const discards = o.paths.length > 0 || words.length > 1 || words.includes('.')
        || (words.length === 1 && !ctx.isRef(words[0]) && ctx.isPath(words[0]));
      if (discards) {
        return block('checkout-files', 'git checkout -- <file>',
          "it replaces your files with the last committed version, and changes you haven't committed are gone for good",
          'git stash sets your changes aside, and git stash pop brings them back');
      }
      return null;
    }
    case 'restore':
      if (!(long('--staged') || flag('S')) || long('--worktree') || flag('W')) {
        return block('restore', 'git restore <file>',
          "it replaces your files with the last committed version, and changes you haven't committed are gone for good",
          'git restore --staged <file> only unstages a file; git stash sets changes aside and git stash pop brings them back');
      }
      return null;
    case 'switch':
      if (long('--discard-changes', '--force') || flag('f')) {
        return block('switch-discard', 'git switch --discard-changes',
          "it switches branches by throwing away changes you haven't committed",
          'commit or git stash your changes first, then switch');
      }
      if (o.valued.includes('C') || long('--force-create')) {
        return block('switch-force-create', 'git switch -C',
          'it resets a branch that already exists, and its commits can be lost',
          'git switch -c with a new branch name');
      }
      return null;
    case 'stash': {
      const action = rest.find((a) => !a.startsWith('-'));
      if (action === 'drop' || action === 'clear') {
        return block('stash-drop', `git stash ${action}`,
          'it deletes stashed changes, and git keeps no easy way back to them',
          'leave the stash where it is; git stash list shows what is in it');
      }
      return null;
    }
    case 'rebase':
      // Only a bare --abort or --quit (or an abbreviation of one) is let through.
      if (rest.length === 1 && hasLong(rest, '--abort', '--quit') && !hasLong(rest, '--autosquash', '--autostash')) return null;
      return block('rebase', 'git rebase',
        'it rewrites the commits on your branch, which confuses anyone who already has them',
        'git merge main brings main into your branch without rewriting anything');
    case 'commit':
      if (long('--amend')) {
        return block('amend', 'git commit --amend',
          'it rewrites your last commit, and if that commit is already pushed, only a force push can follow',
          'make a new commit with the fix; history stays as it was');
      }
      return null;
    case 'rm':
      if (long('--force') || flag('f')) {
        return block('rm-force', 'git rm --force',
          "it deletes files even when they have changes you haven't committed",
          'commit or git stash your changes first, then git rm without --force');
      }
      return null;
    case 'filter-branch':
      return block('rewrite-history', 'git filter-branch', "it rewrites the project's whole history", 'leave history alone; ask someone who maintains the repository');
    case 'reflog': {
      const action = rest.find((a) => !a.startsWith('-'));
      if (action === 'expire' || action === 'delete') {
        return block('reflog-expire', `git reflog ${action}`,
          "it erases git's record of where your branches have been, which is how lost work gets found again",
          'leave the reflog alone; it costs nothing to keep');
      }
      return null;
    }
    case 'gc':
    case 'prune':
      if (sub === 'prune' || o.longs.some((n, k) => hasLong([n], '--prune') && /=(now|all)$/i.test(rest.find((a) => a.startsWith(n)) ?? ''))) {
        return block('prune-now', `git ${sub}`,
          "it deletes commits that nothing points to right now, and those are exactly the ones you'd want back after a mistake",
          'leave it; git cleans up on its own, after a safe delay');
      }
      return null;
    case 'update-ref':
      if (flag('d')) {
        return block('update-ref-delete', 'git update-ref -d',
          'it deletes a branch or tag directly, without any of the checks git branch -d makes',
          'git branch -d, which only deletes merged work');
      }
      return null;
    case 'worktree':
      if (rest[0] === 'remove' && rest.slice(1).some((a) => a === '-f' || hasLong([a.split('=')[0]], '--force'))) {
        return block('worktree-force', 'git worktree remove --force',
          "it deletes a working copy even when it has changes you haven't committed",
          'commit or git stash in that working copy first, then remove it without --force');
      }
      return null;
    case 'config': {
      // Reading settings is fine. Writing one that can make git run a program is refused.
      const plain = rest.filter((a) => !a.startsWith('-'));
      const writes = rest.some((a) => hasLong([a.split('=')[0]], '--add', '--replace-all')) || plain[0] === 'set' || plain.length >= 2;
      const key = plain[0] === 'set' ? plain[1] : plain[0];
      if (writes && key && !SAFE_CONFIG.test(key)) return unreadable(`git config ${key}`);
      return null;
    }
    case 'submodule':
      return rest.includes('foreach') ? unreadable('git submodule foreach') : null;
    case 'bisect':
      return rest[0] === 'run' ? unreadable('git bisect run') : null;
    case 'difftool':
      return rest.some((a) => a === '-x' || hasLong([a.split('=')[0]], '--extcmd')) ? unreadable('git difftool --extcmd') : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// One command, one line
// ---------------------------------------------------------------------------------------------

/**
 * Strip the wrappers the guard can read exactly: sudo, command, exec and nohup with no options,
 * timeout with just a duration, nice with no options or -n N.
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
      if (/^-[vV]$/.test(next)) return { rest: [], wrapped: false }; // command -v only looks a name up
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
  // NAME=value in front of a command. In front of git it's refused: a variable can make git run a program.
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
  if (w[0].dollar || w[0].escape) return unreadable('a command named by a variable');
  const prog = program(w[0].text);
  const args = w.slice(1);
  const texts = args.map((a) => a.text);

  if (prog === 'git') return assigned ? unreadable('git with variables set in front of it') : checkGit(args, ctx);
  if (prog === 'gh') {
    if (texts[0] === 'repo' && texts[1] === 'delete') {
      return block('repo-delete', 'gh repo delete', 'it deletes the whole repository on GitHub', 'archive it on GitHub instead, which can be undone');
    }
    return null;
  }
  if (RM.has(prog)) {
    if (texts.some((a) => /(^|[\\/])\.git[\\/]?$/.test(a))) {
      return block('delete-dot-git', 'rm -rf .git', "it deletes the .git folder, which is the project's entire history", 'leave .git alone; ask for help with whatever you were trying to undo');
    }
    return null;
  }
  if (stripped.wrapped) return unreadable(`${prog} after a wrapper`);
  if (CARRIERS.has(prog)) return unreadable(prog);
  if (prog === 'export' || prog === 'declare' || prog === 'typeset') {
    if (texts.some((a) => RISKY_VARIABLE.test(a.split('=')[0]))) return unreadable(`${prog} ${texts.join(' ')}`);
    return null;
  }
  if (prog === 'find' && texts.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a))) return unreadable('find -exec');
  if (INLINE_CODE.has(prog) && texts.some((a) => INLINE_CODE.get(prog)?.test(a))) return unreadable(`${prog} running inline code`);
  if (SHELLS.has(prog) || prog === 'source' || prog === '.') {
    // A shell may run a script file; a shell given a string, or reading from input, runs something unseen.
    const first = texts[0];
    const fromInput = first === undefined || first === '-' || /^[-+]/.test(first) || /^\d*</.test(first)
      || /^\/(dev\/(stdin|fd\/\d+)|proc\/self\/fd\/\d+)$/.test(first) || texts.includes('<<<');
    return fromInput ? unreadable(`${prog} ${first ?? ''}`.trim()) : null;
  }
  if (POWERSHELLS.has(prog)) {
    const k = texts.findIndex((a) => /^-f(i(le?)?)?$/i.test(a));
    const before = k === -1 ? texts : texts.slice(0, k);
    const plainFlags = before.every((a, n) => /^-(noprofile|nologo|noninteractive|nop|nol|noni)$/i.test(a)
      || (/^-(executionpolicy|ep|ex)$/i.test(a)) || /^-(executionpolicy|ep|ex)$/i.test(before[n - 1] ?? ''));
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
    isRef: context.isRef ?? ((name) => gitOk(cwd, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`])),
    isPath: context.isPath ?? ((name) => existsSync(resolve(cwd, name))),
    alias: context.alias ?? ((name) => gitOut(cwd, ['config', '--get', `alias.${name}`])),
  };
  const { commands, unreadable: why } = parse(line);
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
  const found = check(command, { cwd: typeof input.cwd === 'string' ? input.cwd : undefined });
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
