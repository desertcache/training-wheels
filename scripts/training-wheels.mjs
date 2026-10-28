#!/usr/bin/env node
// training-wheels: a Claude Code PreToolUse hook that stops the git commands you can't take back.
//
// Claude Code runs this before every Bash or PowerShell command the agent wants to run, with the
// call as JSON on stdin. If the command would throw away work for good, or rewrite history other
// people may already have, this prints a "deny" decision with a one-sentence reason and a safer
// command, and the command never runs. Anything else gets no output, so Claude Code's normal
// permission flow carries on.
//
// It only stops the agent. You can still type any of these yourself, and TRAINING_WHEELS=off in
// the environment Claude Code starts in turns the check off (see README.md).
//
// No dependencies. Node 18 or later.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Split a command line into simple commands, each a list of words with quotes removed. Breaks at
 * the shell's command separators (; && || | & newline), at subshell parentheses and at command
 * substitution ($( ... ) and backticks), but never inside quotes, so a commit message that
 * mentions a dangerous command is just text. Heredoc bodies (cat <<'EOF' ... EOF) are text too,
 * so writing a file that mentions a dangerous command is fine.
 * @param {string} src
 * @returns {string[][]}
 */
export function splitCommands(src) {
  /** @type {string[][]} */
  const commands = [];
  /** @type {string[]} */
  let words = [];
  let word = '';
  let inWord = false;
  /** @type {string | null} */
  let quote = null;
  /** @type {{ delim: string, strip: boolean }[]} heredocs whose bodies start after the next newline */
  let heredocs = [];
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) word += src[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') {
        word += src[i + 1];
        inWord = true;
      }
      i++;
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      // A heredoc: note its delimiter; its body starts at the next newline.
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
      // Skip each pending heredoc's body, up to and including its delimiter line.
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
    } else if (c === '$' && src[i + 1] === '(') {
      endCommand();
      i++;
    } else if (';&|()`\n\r'.includes(c)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** The program a word names: "C:\\Program Files\\Git\\cmd\\git.exe" and "/usr/bin/git" are both "git". */
const program = (w) => basename(w.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();

// Words in front of the real program that don't change what it does.
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'env', 'noglob']);

// Shells that can run a command passed as a string: their -c / -Command / /c argument is checked too.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'powershell', 'pwsh', 'cmd']);

// git's own options that take a value, as in "git -C path reset --hard".
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);

/**
 * @typedef {{ rule: string, shown: string, why: string, instead: string }} Block
 * @typedef {{ cwd?: string, isRef?: (name: string) => boolean, isPath?: (name: string) => boolean }} Context
 */

/** Options before a lone "--"; everything after it is a path. @param {string[]} args */
function beforeDashes(args) {
  const i = args.indexOf('--');
  return i === -1 ? args : args.slice(0, i);
}

/** A long option, bare or with "=value". @param {string[]} opts @param {...string} names */
const hasLong = (opts, ...names) => opts.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));

/** A short option, alone or in a cluster such as -fd. Case matters: -d and -D differ. @param {string[]} opts @param {string} ch */
const hasShort = (opts, ch) => opts.some((a) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(ch));

/** @param {string} rule @param {string} shown @param {string} why @param {string} instead @returns {Block} */
const block = (rule, shown, why, instead) => ({ rule, shown, why, instead });

/**
 * The verdict on one git command (the words after "git").
 * @param {string[]} args
 * @param {Required<Context>} ctx
 * @returns {Block | null}
 */
function checkGit(args, ctx) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += GIT_OPTIONS_WITH_VALUE.has(args[i]) ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  const opts = beforeDashes(rest);
  const positional = opts.filter((a) => !a.startsWith('-'));

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
      if (sub === 'prune' || opts.some((a) => /^--prune=(now|all)$/.test(a))) {
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
    default:
      return null;
  }
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
    isRef: context.isRef ?? ((name) => isRef(cwd, name)),
    isPath: context.isPath ?? ((name) => existsSync(resolve(cwd, name))),
  };
  for (const words of splitCommands(line)) {
    let w = words;
    while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || WRAPPERS.has(program(w[0])) || (w !== words && w[0].startsWith('-') && program(words[0]) === 'env'))) w = w.slice(1);
    if (!w.length) continue;
    const prog = program(w[0]);
    const args = w.slice(1);
    let found = null;
    const inner = SHELLS.has(prog) ? args.findIndex((a) => /^(-c|-command|\/c|\/k)$/i.test(a)) : -1;
    if (inner !== -1) found = check(args.slice(inner + 1).join(' '), ctx); // bash -c "...", cmd /c ...
    else if (prog === 'git') found = checkGit(args, ctx);
    else if (prog === 'gh' && args[0] === 'repo' && args[1] === 'delete') {
      found = block('repo-delete', 'gh repo delete', 'it deletes the whole repository on GitHub', 'archive it on GitHub instead, which can be undone');
    } else if (['rm', 'rmdir', 'rd', 'del', 'remove-item', 'ri'].includes(prog)
      && args.some((a) => /(^|[\\/])\.git[\\/]?$/.test(a))) {
      found = block('delete-dot-git', 'rm -rf .git', "it deletes the .git folder, which is the project's entire history", 'leave .git alone; ask for help with whatever you were trying to undo');
    }
    if (found) return found;
  }
  return null;
}

/** Whether a name is a branch, tag or commit in the repository at cwd. @param {string} cwd @param {string} name */
function isRef(cwd, name) {
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `${name}^{commit}`], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
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
