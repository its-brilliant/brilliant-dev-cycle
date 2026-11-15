/** One validation problem. `file` is relative to the project directory. */
export interface Issue {
  file: string;
  /** Field path such as `reviewers.security.block_on`. Empty for a file-level problem. */
  path: string;
  message: string;
}

export function joinPath(base: string, child: string): string {
  if (!base) return child;
  if (child.startsWith('[')) return `${base}${child}`;
  return `${base}.${child}`;
}

export function push(issues: Issue[], file: string, path: string, message: string): void {
  issues.push({ file, path, message });
}

/** Format an issue. `root` is the directory the user passed to `bdc validate`. */
export function formatIssue(issue: Issue, root?: string): string {
  let file = issue.file;
  if (root) {
    const prefix = root.replace(/\/+$/, '') || '.';
    file = issue.file === '.' ? prefix : `${prefix}/${issue.file}`;
  }
  if (issue.path) return `${file}: ${issue.path}: ${issue.message}`;
  return `${file}: ${issue.message}`;
}

export function got(value: unknown): string {
  if (typeof value === 'string') {
    const shown = value.length > 80 ? `${value.slice(0, 77)}...` : value;
    return JSON.stringify(shown);
  }
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'a mapping';
  return typeof value;
}
