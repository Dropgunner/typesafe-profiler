/** Link this in-workspace bundle to the built Harness packages in the parent checkout. */
import { mkdir, lstat, readlink, symlink } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url)) // .../typesafe-profiler/plugin
const workspace = resolve(here, '..')                 // .../typesafe-profiler
const harness = resolve(workspace, '..')              // .../deepseek-harness (checkout root)
const modules = resolve(workspace, 'node_modules/@deepseek-ai')
await mkdir(modules, { recursive: true })
for (const [name, path] of Object.entries({
  cordis: 'vendor/cordis', schemastery: 'vendor/schemastery',
  'dsh-tools': 'packages/core/tools', 'dsh-system-prompt': 'packages/core/system-prompt',
  'dsh-app-boot': 'packages/boot/app-boot',
})) {
  const target = resolve(harness, path)
  await lstat(resolve(target, 'package.json'))
  const link = resolve(modules, name)
  const existing = await lstat(link).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (existing) {
    if (!existing.isSymbolicLink() || resolve(dirname(link), await readlink(link)) !== target) throw new Error(`Refusing to replace ${link}`)
  } else await symlink(relative(modules, target), link, 'dir')
}
console.log('Local Harness dependencies linked.')
