import { Context, defineProperty, Dict, Logger, pick, Quester, Schema, Service, Time, valueMap } from 'koishi'
import Scanner, { DependencyMetaKey, PackageJson, Registry, RemotePackage } from '@koishijs/registry'
import { resolve } from 'path'
import { promises as fsp, readFileSync } from 'fs'
import { compare, satisfies, valid } from 'semver'
import {} from '@koishijs/console'
import {} from '@koishijs/loader'
import getRegistry from 'get-registry'
import which from 'which-pm-runs'
import spawn from 'execa'
import pMap from 'p-map'
import {} from '.'

const logger = new Logger('market')

export interface Dependency {
  /**
   * requested semver range
   * @example `^1.2.3` -> `1.2.3`
   */
  request: string
  /**
   * installed package version
   * @example `1.2.5`
   */
  resolved?: string
  /** whether it is a workspace package */
  workspace?: boolean
  /** valid (unsupported) syntax */
  invalid?: boolean
  /** latest version */
  latest?: string
}

export interface YarnLog {
  type: 'warning' | 'info' | 'error' | string
  name: number | null
  displayName: string
  indent?: string
  data: string
}

const levelMap = {
  'info': 'info',
  'warning': 'debug',
  'error': 'warn',
}

export interface LocalPackage extends PackageJson {
  private?: boolean
  $workspace?: boolean
}

export function loadManifest(name: string) {
  const filename = require.resolve(name + '/package.json')
  const meta: LocalPackage = JSON.parse(readFileSync(filename, 'utf8'))
  meta.dependencies ||= {}
  defineProperty(meta, '$workspace', !filename.includes('node_modules'))
  return meta
}

function getVersions(versions: RemotePackage[]) {
  return Object.fromEntries(versions
    .map(item => [item.version, pick(item, ['peerDependencies', 'peerDependenciesMeta', 'deprecated'])] as const)
    .sort(([a], [b]) => compare(b, a)))
}

class Installer extends Service {
  public http: Quester
  public endpoint: string
  public fullCache: Dict<Dict<Pick<RemotePackage, DependencyMetaKey>>> = {}
  public tempCache: Dict<Dict<Pick<RemotePackage, DependencyMetaKey>>> = {}

  private pkgTasks: Dict<Promise<Dict<Pick<RemotePackage, DependencyMetaKey>>>> = {}
  private agent = which()
  private manifest: PackageJson
  private depTask: Promise<Dict<Dependency>>
  private flushData: () => void

  constructor(public ctx: Context, public config: Installer.Config) {
    super(ctx, 'installer')
    this.manifest = loadManifest(this.cwd)
    this.flushData = ctx.throttle(() => {
      ctx.get('console')?.broadcast('market/registry', this.tempCache)
      this.tempCache = {}
    }, 500)
  }

  get cwd() {
    return this.ctx.baseDir
  }

  async start() {
    const { endpoint, timeout } = this.config
    this.endpoint = endpoint || await getRegistry()
    this.http = this.ctx.http.extend({
      endpoint: this.endpoint,
      timeout,
    })
  }

  resolveName(name: string) {
    if (name.startsWith('@koishijs/plugin-')) return [name]
    if (name.match(/(^|\/)koishi-plugin-/)) return [name]
    if (name[0] === '@') {
      const [left, right] = name.split('/')
      return [`${left}/koishi-plugin-${right}`]
    } else {
      return [`@koishijs/plugin-${name}`, `koishi-plugin-${name}`]
    }
  }

  async findVersion(names: string[]) {
    const entries = await Promise.all(names.map(async (name) => {
      try {
        const versions = Object.entries(await this.getPackage(name))
        if (!versions.length) return
        return { [name]: versions[0][0] }
      } catch (e) {}
    }))
    return entries.find(Boolean)
  }

  private async _getPackage(name: string) {
    try {
      const registry = await this.http.get<Registry>(`/${name}`)
      this.fullCache[name] = this.tempCache[name] = getVersions(Object.values(registry.versions).filter((remote) => {
        return !Scanner.isPlugin(name) || Scanner.isCompatible('4', remote)
      }))
      this.flushData()
      return this.fullCache[name]
    } catch (e) {
      logger.warn(e.message)
    }
  }

  setPackage(name: string, versions: RemotePackage[]) {
    this.fullCache[name] = this.tempCache[name] = getVersions(versions)
    this.flushData()
    this.pkgTasks[name] = Promise.resolve(this.fullCache[name])
  }

  getPackage(name: string) {
    return this.pkgTasks[name] ||= this._getPackage(name)
  }

  private async _getDeps() {
    const result = valueMap(this.manifest.dependencies, (request) => {
      return { request: request.replace(/^[~^]/, '') } as Dependency
    })
    await pMap(Object.keys(result), async (name) => {
      try {
        // some dependencies may be left with no local installation
        const meta = loadManifest(name)
        result[name].resolved = meta.version
        result[name].workspace = meta.$workspace
        if (meta.$workspace) return
      } catch {}

      if (!valid(result[name].request)) {
        result[name].invalid = true
      }

      const versions = await this.getPackage(name)
      if (versions) result[name].latest = Object.keys(versions)[0]
    }, { concurrency: 10 })
    return result
  }

  getDeps() {
    return this.depTask ||= this._getDeps()
  }

  refreshData() {
    this.ctx.get('console')?.refresh('registry')
    this.ctx.get('console')?.refresh('packages')
  }

  refresh(refresh = false) {
    this.pkgTasks = {}
    this.fullCache = {}
    this.tempCache = {}
    this.depTask = this._getDeps()
    if (!refresh) return
    this.refreshData()
  }

  async exec(args: string[]) {
    const name = this.agent?.name ?? 'npm'
    const useJson = name === 'yarn' && this.agent.version >= '2'
    if (name !== 'yarn') args.unshift('install')
    return new Promise<number>((resolve) => {
      if (useJson) args.push('--json')
      const child = spawn(name, args, { cwd: this.cwd })
      child.on('exit', (code) => resolve(code))
      child.on('error', () => resolve(-1))

      let stderr = ''
      child.stderr.on('data', (data) => {
        data = stderr + data.toString()
        const lines = data.split('\n')
        stderr = lines.pop()!
        for (const line of lines) {
          logger.warn(line)
        }
      })

      let stdout = ''
      child.stdout.on('data', (data) => {
        data = stdout + data.toString()
        const lines = data.split('\n')
        stdout = lines.pop()!
        for (const line of lines) {
          if (!useJson || line[0] !== '{') {
            logger.info(line)
            continue
          }
          try {
            const { type, data } = JSON.parse(line) as YarnLog
            logger[levelMap[type] ?? 'info'](data)
          } catch (error) {
            logger.warn(line)
            logger.warn(error)
          }
        }
      })
    })
  }

  async override(deps: Dict<string>) {
    const filename = resolve(this.cwd, 'package.json')
    for (const key in deps) {
      if (deps[key]) {
        this.manifest.dependencies[key] = deps[key]
      } else {
        delete this.manifest.dependencies[key]
      }
    }
    this.manifest.dependencies = Object.fromEntries(Object.entries(this.manifest.dependencies).sort((a, b) => a[0].localeCompare(b[0])))
    await fsp.writeFile(filename, JSON.stringify(this.manifest, null, 2) + '\n')
  }

  private _install() {
    const args: string[] = []
    if (this.config.endpoint) {
      args.push('--registry', this.endpoint)
    }
    return this.exec(args)
  }

  private _getLocalDeps(override: Dict<string>) {
    return valueMap(override, (request, name) => {
      const dep = { request } as Dependency
      try {
        const meta = loadManifest(name)
        dep.resolved = meta.version
        dep.workspace = meta.$workspace
      } catch {}
      return dep
    })
  }

  async install(deps: Dict<string>, forced?: boolean) {
    const localDeps = this._getLocalDeps(deps)
    await this.override(deps)

    for (const name in deps) {
      const { resolved, workspace } = localDeps[name] || {}
      if (workspace || deps[name] && resolved && satisfies(resolved, deps[name], { includePrerelease: true })) continue
      forced = true
      break
    }

    if (forced) {
      const code = await this._install()
      if (code) return code
    }

    this.refresh()
    const newDeps = await this.getDeps()
    for (const name in localDeps) {
      const { resolved, workspace } = localDeps[name]
      if (workspace || !newDeps[name]) continue
      if (newDeps[name].resolved === resolved) continue
      try {
        if (!(require.resolve(name) in require.cache)) continue
      } catch (error) {
        // FIXME https://github.com/koishijs/webui/issues/265
        // I have no idea why this happens and how to fix it.
        logger.error(error)
      }
      this.ctx.loader.fullReload()
    }
    this.refreshData()

    return 0
  }
}

namespace Installer {
  export interface Config {
    endpoint?: string
    timeout?: number
  }

  export const Config: Schema<Config> = Schema.object({
    endpoint: Schema.string().role('link'),
    timeout: Schema.number().role('time').default(Time.second * 5),
  })
}

export default Installer
