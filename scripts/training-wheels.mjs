#!/usr/bin/env node
// training-wheels: a Claude Code PreToolUse hook that stops the git commands you can't take back.
//
// Claude Code runs this before every Bash or PowerShell command the agent wants to run, with the
// call as JSON on stdin. If the command would throw away work for good, or rewrite history other
// people may already have, this prints a "deny" decision with a one-sentence reason and a safer
// command, and the command never runs. Anything else gets no output, so Claude Code's normal
// permission flow carries on.
//
// What it is for: catching the honest mistakes an agent makes while helping a beginner. It reads
// commands the way a shell would, and where it can't see what a command will run (a shell
// variable, an encoded command, a command fed to a shell on stdin), it refuses rather than guess.
// It is not a sandbox and not a defense against an agent set on getting around it (see README.md).
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
// Reading a command line the way a shell would
// ---------------------------------------------------------------------------------------------

/**
 * A word, after quote removal. `dq`: it holds an expansion inside double quotes ("$X", "$(...)"),
 * so it stays one word but its text is unknown. `unq`: it holds an unquoted expansion ($X, $(...),
 * `...`, {a,b}), which can become any number of words.
 * @typedef {{ text: string, raw: string, dq: boolean, unq: boolean }} Word
 */

/** @param {string} c */
const startsExpansion = (c) => c !== undefined && /[A-Za-z_{0-9@*#?$!-]/.test(c);

/**
 * Decode one ANSI-C escape ($'...') starting at src[i] (the character after the backslash).
 * @param {string} src @param {number} i
 * @returns {[string, number]} the character(s) and how many source characters were used
 */
function ansiEscape(src, i) {
  const c = src[i];
  const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  if (c in simple) return [simple[c], 1];
  const hex = (max, from) => {
    let j = from;
    while (j < src.length && j - from < max && /[0-9a-fA-F]/.test(src[j])) j++;
    return j;
  };
  if (c === 'x' || c === 'u' || c === 'U') {
    const end = hex(c === 'x' ? 2 : c === 'u' ? 4 : 8, i + 1);
    if (end === i + 1) return ['\\' + c, 1];
    return [String.fromCodePoint(parseInt(src.slice(i + 1, end), 16)), end - i];
  }
  if (/[0-7]/.test(c)) {
    let j = i;
    while (j < src.length && j - i < 3 && /[0-7]/.test(src[j])) j++;
    return [String.fromCharCode(parseInt(src.slice(i, j), 8)), j - i];
  }
  if (c === 'c' && i + 1 < src.length) return [String.fromCharCode(src.charCodeAt(i + 1) & 31), 2];
  return ['\\' + c, 1];
}

/**
 * Parse src from i into simple commands, appending them to `out`. Command substitutions
 * ($( ... ) and backticks) are parsed recursively: their commands are checked too, and the word
 * they sit in is marked as unknown. Heredoc bodies are skipped as text.
 * @param {string} src
 * @param {number} i
 * @param {boolean} untilParen stop at the ) that closes a $( ... )
 * @param {Word[][]} out
 * @returns {number} the index just past where parsing stopped
 */
function parse(src, i, untilParen, out) {
  /** @type {Word[]} */
  let words = [];
  /** @type {Word | null} */
  let cur = null;
  /** @type {null | "'" | '"' | 'ansi'} */
  let quote = null;
  /** @type {{ delim: string, strip: boolean }[]} */
  let heredocs = [];
  let depth = 0;
  const word = () => (cur ??= { text: '', raw: '', dq: false, unq: false });
  const endWord = () => {
    if (cur) words.push(cur);
    cur = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  /** A backtick substitution starting at src[at] (the opening backtick): parse it, return its end. */
  const backtick = (at) => {
    let j = at + 1;
    while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
    parse(src.slice(at + 1, j), 0, false, out);
    return j;
  };

  for (; i < src.length; i++) {
    const c = src[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word().text += c;
      continue;
    }
    if (quote === 'ansi') {
      if (c === "'") quote = null;
      else if (c === '\\' && i + 1 < src.length) {
        const [ch, used] = ansiEscape(src, i + 1);
        word().text += ch;
        i += used;
      } else word().text += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) word().text += src[++i];
      else if (c === '$' && src[i + 1] === '(') {
        word().dq = true;
        i = parse(src, i + 2, true, out) - 1;
      } else if (c === '`') {
        word().dq = true;
        i = backtick(i);
      } else {
        if (c === '$' && startsExpansion(src[i + 1])) word().dq = true;
        word().text += c;
      }
      continue;
    }

    // Unquoted.
    if (c === '$' && src[i + 1] === "'") {
      word();
      quote = 'ansi';
      i++;
    } else if (c === '$' && src[i + 1] === '"') {
      word();
      quote = '"';
      i++;
    } else if (c === "'" || c === '"') {
      word();
      quote = c;
    } else if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') word().text += src[i + 1];
      i++;
    } else if (c === '$' && src[i + 1] === '(') {
      word().unq = true;
      i = parse(src, i + 2, true, out) - 1;
    } else if (c === '`') {
      word().unq = true;
      i = backtick(i);
    } else if (src.startsWith('<<<', i)) {
      endWord();
      words.push({ text: '<<<', raw: '<<<', dq: false, unq: false });
      i += 2;
    } else if (c === '<' && src[i + 1] === '<') {
      // A heredoc: note its delimiter; its body starts at the next newline and is only text.
      let j = i + 2;
      const strip = src[j] === '-';
      if (strip) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      let delim = '';
      if (src[j] === "'" || src[j] === '"') {
        const q = src[j++];
        while (j < src.length && src[j] !== q) delim += src[j++];
        j++;
      } else {
        while (j < src.length && !/[\s;&|<>()]/.test(src[j])) delim += src[j++];
      }
      delim = delim.replace(/\\/g, '');
      if (delim) heredocs.push({ delim, strip });
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
        }
      }
      heredocs = [];
      i = pos - 1;
    } else if (c === '(') {
      endCommand();
      depth++;
    } else if (c === ')') {
      endCommand();
      if (untilParen && depth === 0) return i + 1;
      depth = Math.max(0, depth - 1);
    } else if (';&|\n\r'.includes(c)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      const w = word();
      if (c === '$' && startsExpansion(src[i + 1])) w.unq = true;
      w.text += c;
      w.raw += c;
    }
  }
  endCommand();
  return i;
}

/** Brace expansion, as in --{force,x}, turns one word into several. @param {string} text */
const hasBraceExpansion = (text) => /\{[^{}]*(,|\.\.)[^{}]*\}/.test(text);

/**
 * Split a command line into simple commands, each a list of words with quotes removed (including
 * the commands inside $( ... ) and backticks). Never splits inside quotes, so a commit message that
 * mentions a dangerous command is just text, and heredoc bodies are text too.
 * @param {string} src
 * @returns {string[][]}
 */
export function splitCommands(src) {
  /** @type {Word[][]} */
  const out = [];
  parse(src, 0, false, out);
  return out.map((ws) => ws.map((w) => w.text));
}

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

/** The program a word names: "C:\\Program Files\\Git\\cmd\\git.exe" and "/usr/bin/git" are both "git". */
const program = (w) => basename(w.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();

// Programs that run the command that follows them, and their options that take a value.
const WRAPPERS = new Map([
  ['sudo', ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '--user', '--group', '--host', '--prompt']],
  ['command', []], ['builtin', []], ['exec', ['-a']], ['nohup', []], ['time', ['-f', '-o']], ['noglob', []],
  ['env', ['-u', '-C', '-S', '--unset', '--chdir', '--split-string']], ['nice', ['-n', '--adjustment']],
  ['timeout', ['-s', '-k', '--signal', '--kill-after']], ['stdbuf', ['-i', '-o', '-e']], ['ionice', ['-c', '-n', '-p']],
  ['xargs', ['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs']],
  ['unbuffer', []], ['chronic', []],
]);
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);

// git's own options that take a value, as in "git -C path reset --hard".
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']);

// Options whose value can't turn into another option or a subcommand: a quoted "$(...)" there is fine
// (the usual commit-message heredoc), anywhere else it could hide --force.
const MESSAGE_LIKE = /^(-[A-Za-z]*[mF]|--message|--file|--template|-C|--git-dir|--work-tree)$/;

// git's built-in commands. A subcommand that isn't one may be an alias, which is looked up and checked.
const BUILTINS = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore checkout '
  + 'cherry cherry-pick citool clean clone column commit commit-tree config count-objects credential describe diff '
  + 'diff-files diff-index diff-tree difftool fast-export fast-import fetch filter-branch for-each-ref format-patch fsck '
  + 'gc grep gui hash-object help init instaweb log ls-files ls-remote ls-tree maintenance merge merge-base mergetool mv '
  + 'name-rev notes prune pull push range-diff read-tree rebase reflog remote repack replace request-pull reset restore '
  + 'rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout stage stash status submodule switch '
  + 'symbolic-ref tag update-index update-ref var verify-commit verify-tag version whatchanged worktree write-tree').split(' '));

/**
 * @typedef {{ rule: string, shown: string, why: string, instead: string }} Block
 * @typedef {{ cwd?: string, isRef?: (name: string) => boolean, isPath?: (name: string) => boolean, alias?: (name: string) => string | null }} Context
 */

/** Options before a lone "--"; everything after it is a path. @param {string[]} args */
function beforeDashes(args) {
  const i = args.indexOf('--');
  return i === -1 ? args : args.slice(0, i);
}

/**
 * A long option, matched the way git matches it: the full name, "name=value", or any abbreviation
 * git would accept (git takes an unambiguous prefix, so --forc is --force). An ambiguous prefix
 * also counts: git refuses to run it, so treating it as the dangerous option costs nothing.
 * @param {string[]} opts @param {...string} names
 */
const hasLong = (opts, ...names) => opts.some((a) => {
  if (!a.startsWith('--') || a === '--') return false;
  const name = a.split('=')[0];
  return names.some((n) => name === n || (name.length > 2 && n.startsWith(name)));
});

/** A short option, alone or in a cluster such as -fd. Case matters: -d and -D differ. @param {string[]} opts @param {string} ch */
const hasShort = (opts, ch) => opts.some((a) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(ch));

/** @param {string} rule @param {string} shown @param {string} why @param {string} instead @returns {Block} */
const block = (rule, shown, why, instead) => ({ rule, shown, why, instead });

const UNSEEN = (what) => block('cannot-see', what,
  "the guard can't see what it would actually run, so it won't guess",
  'write the command out in full, with no shell variables or encoded parts');

/**
 * The verdict on one git command (the words after "git").
 * @param {Word[]} argWords
 * @param {Required<Context>} ctx
 * @param {number} depth alias expansion depth
 * @returns {Block | null}
 */
function checkGit(argWords, ctx, depth = 0) {
  // Words whose text the guard can't know fail closed, unless they are the value of a message-like option.
  for (let k = 0; k < argWords.length; k++) {
    const w = argWords[k];
    const valueOf = k > 0 ? argWords[k - 1].text : '';
    if (w.unq || hasBraceExpansion(w.raw)) return UNSEEN('git with a shell variable');
    if (w.dq && !MESSAGE_LIKE.test(valueOf) && !/^--(message|file|template)=/.test(w.text)) return UNSEEN('git with a shell variable');
  }
  const args = argWords.map((w) => w.text);

  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const opt = args[i];
    if (opt === '-c' && /^alias\./i.test(args[i + 1] ?? '')) {
      const value = (args[i + 1] ?? '').split('=').slice(1).join('=');
      const inner = checkAliasValue(value, ctx, depth);
      if (inner) return inner;
    }
    if (opt.startsWith('--config-env') && /alias\./i.test(opt.includes('=') ? opt : args[i + 1] ?? '')) return UNSEEN('git --config-env alias');
    i += GIT_OPTIONS_WITH_VALUE.has(opt) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const opts = beforeDashes(rest);
  const positional = opts.filter((a) => !a.startsWith('-'));
  if (sub === undefined) return null;

  // An alias runs whatever it stands for: look it up and check that instead.
  if (!BUILTINS.has(sub) && depth < 5) {
    const value = ctx.alias(sub);
    if (value !== null) return checkAliasValue(value, ctx, depth, rest);
  }

  switch (sub) {
    case 'push': {
      if (hasLong(opts, '--force', '--force-with-lease', '--force-if-includes') || hasShort(opts, 'f') || positional.some((a) => a.startsWith('+'))) {
        return block('force-push', 'git push --force',
          'a force push replaces the branch on GitHub with yours, and whatever it replaces is gone for everyone who uses it',
          'pull first (git pull), fix any conflicts, then push normally');
      }
      if (hasLong(opts, '--delete', '--prune', '--mirror') || hasShort(opts, 'd') || positional.slice(1).some((a) => a.startsWith(':'))) {
        return block('remote-delete', 'git push --delete',
          'it deletes branches on GitHub, and a deleted branch there takes its unmerged commits with it',
          'leave the branch; GitHub offers to delete it for you after the pull request merges');
      }
      return null;
    }
    case 'reset':
      if (hasLong(opts, '--hard', '--merge')) {
        return block('reset-hard', 'git reset --hard',
          "it throws away every change you haven't committed, and git can't bring those changes back",
          'git stash sets your changes aside, and git stash pop brings them back');
      }
      return null;
    case 'branch':
      if (hasShort(opts, 'D') || (hasLong(opts, '--delete') || hasShort(opts, 'd')) && (hasLong(opts, '--force') || hasShort(opts, 'f'))) {
        return block('branch-force-delete', 'git branch -D',
          "it deletes a branch even when its commits aren't merged anywhere, so that work can be lost",
          'git branch -d deletes it only once its work is merged, and says so if it is not');
      }
      if (hasShort(opts, 'M') || hasShort(opts, 'C') || hasLong(opts, '--force') || hasShort(opts, 'f')) {
        return block('branch-force', 'git branch --force',
          'it overwrites an existing branch, and the commits that branch pointed to can be lost',
          'pick a new branch name instead of reusing one that exists');
      }
      return null;
    case 'clean':
      if ((hasLong(opts, '--force') || hasShort(opts, 'f')) && !(hasLong(opts, '--dry-run') || hasShort(opts, 'n'))) {
        return block('clean', 'git clean -f',
          "it deletes files git isn't tracking, and since they were never committed, git can't bring them back",
          'git clean -n lists what would go, so you can delete only what you mean to by hand');
      }
      return null;
    case 'checkout': {
      if (hasLong(opts, '--force') || hasShort(opts, 'f')) {
        return block('checkout-force', 'git checkout --force',
          "it switches branches by throwing away changes you haven't committed",
          'commit or git stash your changes first, then switch');
      }
      if (hasShort(opts, 'B')) {
        return block('checkout-reset-branch', 'git checkout -B',
          'it resets a branch that already exists, and its commits can be lost',
          'git switch -c with a new branch name');
      }
      const paths = rest.includes('--') ? rest.slice(rest.indexOf('--') + 1) : [];
      // Values of -b / --orphan are branch names, not paths.
      const words = [];
      for (let k = 0; k < opts.length; k++) {
        if (['-b', '--orphan'].includes(opts[k])) k++;
        else if (!opts[k].startsWith('-')) words.push(opts[k]);
      }
      const discards = paths.length > 0 || words.length > 1 || words.includes('.')
        || (words.length === 1 && !ctx.isRef(words[0]) && ctx.isPath(words[0]));
      if (discards) {
        return block('checkout-files', 'git checkout -- <file>',
          "it replaces your files with the last committed version, and changes you haven't committed are gone for good",
          'git stash sets your changes aside, and git stash pop brings them back');
      }
      return null;
    }
    case 'restore': {
      const staged = hasLong(opts, '--staged') || hasShort(opts, 'S');
      const worktree = hasLong(opts, '--worktree') || hasShort(opts, 'W');
      if (!staged || worktree) {
        return block('restore', 'git restore <file>',
          "it replaces your files with the last committed version, and changes you haven't committed are gone for good",
          'git restore --staged <file> only unstages a file; git stash sets changes aside and git stash pop brings them back');
      }
      return null;
    }
    case 'switch':
      if (hasLong(opts, '--discard-changes', '--force') || hasShort(opts, 'f')) {
        return block('switch-discard', 'git switch --discard-changes',
          "it switches branches by throwing away changes you haven't committed",
          'commit or git stash your changes first, then switch');
      }
      if (hasShort(opts, 'C') || hasLong(opts, '--force-create')) {
        return block('switch-force-create', 'git switch -C',
          'it resets a branch that already exists, and its commits can be lost',
          'git switch -c with a new branch name');
      }
      return null;
    case 'stash':
      if (['drop', 'clear'].includes(rest[0])) {
        return block('stash-drop', `git stash ${rest[0]}`,
          'it deletes stashed changes, and git keeps no easy way back to them',
          'leave the stash where it is; git stash list shows what is in it');
      }
      return null;
    case 'rebase':
      if (hasLong(opts, '--abort', '--quit')) return null;
      return block('rebase', 'git rebase',
        'it rewrites the commits on your branch, which confuses anyone who already has them',
        'git merge main brings main into your branch without rewriting anything');
    case 'commit':
      if (hasLong(opts, '--amend')) {
        return block('amend', 'git commit --amend',
          'it rewrites your last commit, and if that commit is already pushed, only a force push can follow',
          'make a new commit with the fix; history stays as it was');
      }
      return null;
    case 'rm':
      if (hasLong(opts, '--force') || hasShort(opts, 'f')) {
        return block('rm-force', 'git rm --force',
          "it deletes files even when they have changes you haven't committed",
          'commit or git stash your changes first, then git rm without --force');
      }
      return null;
    case 'filter-branch':
    case 'filter-repo':
      return block('rewrite-history', `git ${sub}`,
        "it rewrites the project's whole history",
        'leave history alone; ask someone who maintains the repository');
    case 'reflog':
      if (['expire', 'delete'].includes(rest[0])) {
        return block('reflog-expire', `git reflog ${rest[0]}`,
          "it erases git's record of where your branches have been, which is how lost work gets found again",
          'leave the reflog alone; it costs nothing to keep');
      }
      return null;
    case 'gc':
    case 'prune':
      if (sub === 'prune' || opts.some((a) => /^--pr(u(ne?)?)?=(now|all)$/.test(a))) {
        return block('prune-now', `git ${sub}`,
          "it deletes commits that nothing points to right now, and those are exactly the ones you'd want back after a mistake",
          'leave it; git cleans up on its own, after a safe delay');
      }
      return null;
    case 'update-ref':
      if (hasShort(opts, 'd')) {
        return block('update-ref-delete', 'git update-ref -d',
          'it deletes a branch or tag directly, without any of the checks git branch -d makes',
          'git branch -d, which only deletes merged work');
      }
      return null;
    case 'worktree':
      if (rest[0] === 'remove' && (hasLong(opts, '--force') || hasShort(opts, 'f'))) {
        return block('worktree-force', 'git worktree remove --force',
          "it deletes a working copy even when it has changes you haven't committed",
          'commit or git stash in that working copy first, then remove it without --force');
      }
      return null;
    case 'config': {
      // Defining an alias that would run a blocked command is the same as running it later.
      const k = args.findIndex((a, n) => n > i && /^alias\./i.test(a));
      if (k !== -1 && args[k + 1] !== undefined) return checkAliasValue(args[k + 1], ctx, depth);
      return null;
    }
    default:
      return null;
  }
}

/**
 * An alias's value, checked as what it runs: "!cmd" is a shell command, anything else is git arguments.
 * @param {string} value @param {Required<Context>} ctx @param {number} depth @param {string[]} [more]
 */
function checkAliasValue(value, ctx, depth, more = []) {
  if (value.startsWith('!')) return checkLine(`${value.slice(1)} ${more.join(' ')}`, ctx);
  /** @type {Word[][]} */
  const out = [];
  parse(value, 0, false, out);
  const words = (out[0] ?? []).concat(more.map((text) => ({ text, raw: text, dq: false, unq: false })));
  return checkGit(words, ctx, depth + 1);
}

/**
 * The verdict on one command line.
 * @param {string} line @param {Required<Context>} ctx
 * @returns {Block | null}
 */
function checkLine(line, ctx) {
  /** @type {Word[][]} */
  const commands = [];
  parse(line, 0, false, commands);
  for (const command of commands) {
    const found = checkCommand(command, ctx);
    if (found) return found;
  }
  return null;
}

/**
 * The verdict on one simple command.
 * @param {Word[]} command @param {Required<Context>} ctx
 * @returns {Block | null}
 */
function checkCommand(command, ctx) {
  let w = command;
  // Leading NAME=value assignments, then wrappers like sudo, env, timeout and xargs.
  for (;;) {
    if (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0].text)) {
      if (/^GIT_CONFIG/i.test(w[0].text)) return UNSEEN('git with config from the environment');
      w = w.slice(1);
      continue;
    }
    const prog = w.length ? program(w[0].text) : '';
    if (!WRAPPERS.has(prog)) break;
    const withValue = WRAPPERS.get(prog) ?? [];
    let k = 1;
    while (k < w.length && (w[k].text.startsWith('-') || (prog === 'env' && w[k].text.includes('=')))) {
      if (prog === 'env' && /^GIT_CONFIG/i.test(w[k].text)) return UNSEEN('git with config from the environment');
      k += withValue.includes(w[k].text) ? 2 : 1;
    }
    if (prog === 'timeout' && k < w.length) k++; // the duration
    w = w.slice(k);
  }
  if (!w.length) return null;
  const prog = program(w[0].text);
  const args = w.slice(1);
  const texts = args.map((a) => a.text);

  if (prog === 'git') return checkGit(args, ctx);
  if (prog === 'gh' && texts[0] === 'repo' && texts[1] === 'delete') {
    return block('repo-delete', 'gh repo delete', 'it deletes the whole repository on GitHub', 'archive it on GitHub instead, which can be undone');
  }
  if (['rm', 'rmdir', 'rd', 'del', 'remove-item', 'ri', 'erase'].includes(prog) && texts.some((a) => /(^|[\\/])\.git[\\/]?$/.test(a))) {
    return block('delete-dot-git', 'rm -rf .git', "it deletes the .git folder, which is the project's entire history", 'leave .git alone; ask for help with whatever you were trying to undo');
  }
  // Commands that run a string as a command.
  if (['eval', 'invoke-expression', 'iex'].includes(prog)) return checkLine(texts.join(' '), ctx);
  if (POSIX_SHELLS.has(prog)) return checkPosixShell(texts, ctx);
  if (POWERSHELLS.has(prog)) return checkPowerShell(texts, ctx);
  if (prog === 'cmd') {
    const k = texts.findIndex((a) => /^\/[ck]$/i.test(a));
    return k === -1 ? UNSEEN('cmd reading commands from input') : checkLine(texts.slice(k + 1).join(' '), ctx);
  }
  if (['start-process', 'saps', 'start'].includes(prog)) {
    const parts = texts.filter((a) => !a.startsWith('-')).flatMap((a) => a.split(',')).filter(Boolean);
    if (parts.length && program(parts[0]) === 'git') return checkLine(parts.map((p) => JSON.stringify(p)).join(' '), ctx);
  }
  return null;
}

/**
 * bash -c "...", sh -euc '...', bash <<< "...": check the string the shell will run. A shell reading
 * commands from stdin (a pipe or a redirect) runs something the guard can't see.
 * @param {string[]} args @param {Required<Context>} ctx
 */
function checkPosixShell(args, ctx) {
  let runsString = false;
  /** @type {string | null} */
  let script = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '<<<' && args[k + 1] !== undefined) return checkLine(args[k + 1], ctx);
    if (/^\d*<(?!<<)/.test(a) || /^-[A-Za-z]*s[A-Za-z]*$/.test(a) && !a.includes('c')) return UNSEEN('a shell reading commands from input');
    if (/^[-+][oO]$/.test(a)) { k++; continue; }
    if (/^--(rcfile|init-file)$/.test(a)) { k++; continue; }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) { runsString = true; continue; }
    if (a.startsWith('-') || a.startsWith('+')) continue;
    if (runsString) return checkLine(a, ctx);
    script = a;
    break;
  }
  if (runsString) return null; // -c with nothing after it: the shell errors out
  if (script === null) return UNSEEN('a shell reading commands from input');
  return null; // a script file: see README, "What it isn't"
}

/**
 * powershell -Command "...", with any abbreviation of -Command; -EncodedCommand can't be read, so it's refused.
 * @param {string[]} args @param {Required<Context>} ctx
 */
function checkPowerShell(args, ctx) {
  const isPrefixOf = (a, full, min) => a.length >= min && full.startsWith(a.toLowerCase());
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (/^-ec$/i.test(a) || isPrefixOf(a, '-encodedcommand', 2) || isPrefixOf(a, '-encodedarguments', 9)) return UNSEEN('an encoded PowerShell command');
    if (isPrefixOf(a, '-command', 2)) {
      const rest = args.slice(k + 1);
      if (!rest.length || rest[0] === '-') return UNSEEN('PowerShell reading commands from input');
      return checkLine(rest.join(' '), ctx);
    }
    if (isPrefixOf(a, '-file', 2)) return args[k + 1] === '-' ? UNSEEN('PowerShell reading commands from input') : null;
    if (!a.startsWith('-')) return checkLine(args.slice(k).join(' '), ctx); // powershell "git ..." runs it as a command
  }
  return args.length ? null : UNSEEN('PowerShell reading commands from input');
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
  return checkLine(line, ctx);
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
