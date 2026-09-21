#!/usr/bin/env node
/**
 * scripts/release.mjs
 *
 * Assisted release: bump versions, sync create-tzin templates,
 * prepend a CHANGELOG entry, commit, tag, and show publish commands.
 *
 * Usage:
 *   node scripts/release.mjs <patch|minor|major> [--dry-run]
 *
 * What it does:
 *   1. Validates semver arg + clean git tree (unless --dry-run).
 *   2. Bumps root package.json (+package-lock), and create-tzin
 *      templates' @carlos-tzin/tzin ranges to ^NEW_VERSION.
 *   3. Prepends a dated CHANGELOG skeleton for you to fill.
 *   4. Commits + tags vNEW_VERSION.
 *   5. Prints the publish commands (npm publish + gh release create)
 *      — it does NOT publish by itself (OTP-safe by design).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const [kind, ...rest] = process.argv.slice(2)
const dryRun = rest.includes('--dry-run')

if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('Usage: node scripts/release.mjs <patch|minor|major> [--dry-run]')
  process.exit(1)
}

const run = (cmd) => execSync(cmd, { stdio: dryRun ? 'pipe' : 'inherit' })
const runOut = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()

if (!dryRun && runOut('git status --porcelain') !== '') {
  console.error('Working tree is dirty. Commit or stash first (or use --dry-run).')
  process.exit(1)
}

const bump = (v, k) => {
  const [M, m, p] = v.split('.').map(Number)
  return k === 'major' ? `${M + 1}.0.0` : k === 'minor' ? `${M}.${m + 1}.0` : `${M}.${m}.${p + 1}`
}

const root = JSON.parse(readFileSync('package.json', 'utf8'))
const next = bump(root.version, kind)
console.log(`tzin ${root.version} → ${next}${dryRun ? ' (dry-run)' : ''}`)

// 1. Root version (+ lock handled by npm below if not dry-run).
if (!dryRun) run(`npm version ${next} --no-git-tag-version --allow-same-version=false`)
else console.log(`[dry-run] would set package.json version → ${next}`)

// 2. Sync create-tzin templates to ^NEXT for @carlos-tzin/tzin.
const templates = ['node', 'bun', 'workers']
for (const t of templates) {
  const p = `create-tzin/templates/${t}/package.json`
  const pkg = JSON.parse(readFileSync(p, 'utf8'))
  const old = pkg.dependencies?.['@carlos-tzin/tzin']
  if (old !== `^${next}`) {
    pkg.dependencies['@carlos-tzin/tzin'] = `^${next}`
    if (!dryRun) writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
    console.log(`templates/${t}: ${old} → ^${next}`)
  } else {
    console.log(`templates/${t}: already ^${next}`)
  }
}

// 3. CHANGELOG skeleton.
const date = new Date().toISOString().slice(0, 10)
const skeleton = `\n## ${next} — ${date}\n\n- \n`
if (!dryRun) {
  const cl = readFileSync('CHANGELOG.md', 'utf8')
  const marker = '# Changelog\n'
  writeFileSync('CHANGELOG.md', cl.replace(marker, marker + skeleton))
  console.log('CHANGELOG.md: prepended skeleton entry (fill it in, then amend).')
} else {
  console.log(`[dry-run] would prepend CHANGELOG entry for ${next}`)
}

// 4. Commit + tag.
if (!dryRun) {
  run('git add package.json package-lock.json CHANGELOG.md create-tzin/templates/*/package.json')
  run(`git commit -m "chore: bump to v${next}"`)
  run(`git tag v${next}`)
  console.log(`\nCommitted + tagged v${next}.`)
}

console.log(`
Next steps:
  git push && git push origin v${next}
  npm publish --otp=XXXXXX        # 2FA code from your authenticator
  npm publish --workspace create-tzin   # if create-tzin changed
  gh release create v${next} --title "${next}" --generate-notes
  # then edit the generated notes with CHANGELOG.md section
`)
