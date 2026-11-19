/**
 * Ambient types for the DSH Web client half of this plugin.
 *
 * DSH loads a package's `./client` artifact as a **classic browser script**
 * (the module system appends a `<script src>` element, it never runs it as an
 * ES module), and the bundle registers itself through
 * `window.__ModuleLoader__.load({ id, factory })`. That is why `src/client.ts`
 * must not contain any runtime `import`/`export` statement: such a statement
 * makes tsc emit a module, and a module script is not what the page loads.
 *
 * This file is an ambient declaration file (no imports, no exports): tsc never
 * emits it, and it does not turn `src/client.ts` into a module. It mirrors the
 * subset of the DSH client contract this plugin uses, taken from the DSH
 * release pinned in the repository README; extend it only as needed.
 */

/** Registration facade the page installs before any bundle script runs. */
interface DshModuleLoaderTarget {
  /**
   * Submit one bundle factory. The id must equal the package name (the boot
   * graph row id), and a bundle must register exactly once per page load.
   * @param registration - the bundle's id and factory.
   */
  load(registration: DshBundleRegistration): void
}

/** One client bundle's factory registration submitted through the loader facade. */
interface DshBundleRegistration {
  /** Plugin id (package name); must match the boot graph row being executed. */
  id: string
  /**
   * Closure factory holding the whole bundle body. It runs once, at
   * materialization, and returns the bundle's exports.
   * @param require - the synchronous module-table resolver.
   * @returns the bundle exports.
   */
  factory(require: DshBundleRequire): Record<string, unknown>
}

/** Module resolver handed to a client bundle factory. */
interface DshBundleRequire {
  /**
   * Resolve a module-table dependency synchronously (`react` is a seed word).
   * @param specifier - module specifier.
   * @returns the module exports.
   */
  (specifier: string): unknown
  /**
   * Load and resolve a package-local dynamic chunk.
   * @param specifier - relative chunk specifier.
   * @returns the chunk exports.
   */
  async(specifier: string): Promise<unknown>
  /**
   * Resolve a package-asset reference to the URL the page loads.
   * @param reference - the build-time asset reference.
   * @returns the page URL.
   */
  asset(reference: string): string
}

/** The page globals this plugin reads. */
interface Window {
  /** HTML-installed bundle registration facade. */
  __ModuleLoader__?: DshModuleLoaderTarget
}

/** Opaque React element as produced by the runtime's `createElement`. */
interface ReactElementLike {
  readonly type: unknown
  readonly props: unknown
  readonly key: string | null
}

/** Values accepted as a React child by `createElement`. */
type ReactNodeLike =
  ReactElementLike | string | number | boolean | null | undefined | readonly ReactNodeLike[]

/** State setter shape produced by `useState`. */
type ReactStateSetter<T> = (next: T | ((previous: T) => T)) => void

/** Effect body accepted by `useEffect`; return a cleanup function or nothing. */
type ReactEffect = () => void | (() => void)

/** Current-value box produced by `useRef`. */
interface ReactRefObject<T> {
  current: T
}

/** The React surface this bundle actually uses; `react` is a module-table seed word. */
interface ReactRuntime {
  /** Fragment marker accepted as `createElement`'s first argument. */
  readonly Fragment: unknown
  /**
   * Create one element.
   * @param type - tag name or component.
   * @param props - element props (null for none).
   * @param children - child nodes.
   * @returns the element.
   */
  createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: ReactNodeLike[]
  ): ReactElementLike
  /**
   * Component state whose setter accepts a value or an updater.
   * @param initial - initial value or initializer.
   * @returns the current value and its setter.
   */
  useState<T>(initial: T | (() => T)): [T, ReactStateSetter<T>]
  /**
   * Run a side effect after render and clean it up before the next run.
   * @param effect - the effect body returning an optional cleanup.
   * @param dependencies - values that key the effect.
   */
  useEffect(effect: ReactEffect, dependencies?: readonly unknown[]): void
  /**
   * A mutable box that survives renders.
   * @param initial - initial value.
   * @returns the box.
   */
  useRef<T>(initial: T): ReactRefObject<T>
  /**
   * Memoize a callback between renders.
   * @param callback - the callback to memoize.
   * @param dependencies - values that key the memoization.
   * @returns the stable callback.
   */
  useCallback<T extends (...args: never[]) => unknown>(
    callback: T,
    dependencies: readonly unknown[],
  ): T
}

/** The only event shape this page reads: a control's current text value. */
interface DshInputChangeEvent {
  target: { value: string }
}

/** Translate one key of a registered client locale namespace. */
interface DshTranslation {
  /**
   * @param key - dictionary key.
   * @param params - interpolation values for `{name}` placeholders.
   * @returns the localized text.
   */
  (key: string, params?: Record<string, unknown>): string
}

/** The Client locale service this page registers dictionaries with. */
interface DshLocaleService {
  /**
   * Register one dictionary for one locale tag.
   * @param namespace - dictionary namespace.
   * @param locale - BCP 47-style locale tag.
   * @param dictionary - flat key → text.
   * @returns the disposer removing the dictionary.
   */
  register(namespace: string, locale: string, dictionary: Record<string, string>): () => void
  /**
   * Bind a namespace to a translate function that reads the active locale at
   * call time.
   * @param namespace - dictionary namespace.
   * @returns the translate function.
   */
  bind(namespace: string): DshTranslation
  /**
   * Subscribe to locale changes.
   * @param listener - change callback.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void
}

/** Props the settings shell passes to a registered section page. */
interface DshSettingsSectionOwnerProps {
  /** Close the settings panel. */
  close: () => void
}

/** Props the settings shell passes to a section nav icon. */
interface DshSettingsSectionIconProps {
  /** Requested square edge in pixels. */
  size: number
  /** Whether this section is selected. */
  active: boolean
}

/** One slot registration. */
interface DshSlotRegistrationOptions {
  /** Slot name; must match the slot being registered into. */
  name: string
  /** Registration id (unique per slot). */
  id: string
  /** Ascending position inside the slot. */
  order?: number
  /** Nav label: text, or a thunk resolved per render (locale-independent). */
  label?: string | (() => string)
  /** Dictionary namespace the renderer synthesizes the `t` seat from. */
  locale?: string
}

/** The Client slot service. */
interface DshSlotService {
  /**
   * Register into one slot once its declaration is live.
   * @param name - slot name.
   * @param callback - registration callback returning the registration disposer.
   * @returns a disposer releasing the injection.
   */
  inject(name: string, callback: () => () => void): () => void
  /**
   * Register one entry into a declared slot.
   * @param options - slot name, id, order, and optional label.
   * @param component - the component rendered by the slot.
   * @returns the registration disposer.
   */
  register(
    options: DshSlotRegistrationOptions,
    component: (props: never) => ReactNodeLike,
  ): () => void
}

/** Remote failure carried by a refused call. */
interface DshRemoteFailure {
  /** Stable machine-readable code; `settings/conflict` marks a stale write. */
  code?: string
  /** Human-readable description. */
  message?: string
}

/** Result of one authorized Remote call. */
type DshRemoteResult<T> = { ok: true; value: T } | { ok: false; error: DshRemoteFailure }

/** One plugin entry's configuration view on the Host. */
interface DshSettingsNamespaceView {
  /** Namespace key (the plugin row id). */
  ns: string
  /** Monotonic revision of the raw entry configuration this view was read at. */
  revision: number
  /** Redacted resolved value; the rule list lives at `rules`. */
  value: unknown
}

/** Everything a settings read returns. */
interface DshSettingsDescribeValue {
  /** Whether the profile accepts writes. */
  writable: boolean
  /** One view per profile plugin entry. */
  namespaces: DshSettingsNamespaceView[]
}

/** One path-addressed edit carried by a settings write. */
interface DshSettingsPathOp {
  /** `set` writes the value at the path, creating intermediate objects. */
  op: 'set'
  /** Path from the section root. */
  path: string[]
  /** The value to write. */
  value: unknown
}

/** What a settings write returns. */
interface DshSettingsMutateValue {
  /** Namespace key that was written. */
  ns: string
  /** Revision after the write. */
  revision: number
  /** Written resolved view, when the Host returns one. */
  value?: unknown
}

/** The `settings` Remote namespace. */
interface DshSettingsRemote {
  /**
   * Read every profile entry's configuration view.
   * @returns the describe result.
   */
  describe(): Promise<DshRemoteResult<DshSettingsDescribeValue>>
  /**
   * Write path-addressed edits to one entry.
   * @param namespace - the entry id.
   * @param operations - the edits to apply.
   * @param expectedRevision - revision the caller read; a moved revision is refused as `settings/conflict`.
   * @returns the write result.
   */
  mutate(
    namespace: string,
    operations: DshSettingsPathOp[],
    expectedRevision: number,
  ): Promise<DshRemoteResult<DshSettingsMutateValue>>
}

/** One provider group of the deployment's routable model catalog. */
interface DshModelCatalogGroup {
  /** Provider id. */
  id?: string
  /** Display name. */
  name?: string
  /** Models the provider currently routes. */
  models?: DshModelCatalogEntry[]
}

/** One routable model of the deployment's catalog. */
interface DshModelCatalogEntry {
  /** Model id. */
  id?: string
  /** Display name. */
  name?: string
}

/** What the model-catalog call returns. */
interface DshModelCatalogValue {
  /** Provider groups; the model selector reads the same catalog. */
  groups?: DshModelCatalogGroup[]
}

/** The `session` Remote namespace. */
interface DshSessionRemote {
  /**
   * Read the deployment's routable model catalog.
   * @returns the catalog result.
   */
  modelCatalog(): Promise<DshRemoteResult<DshModelCatalogValue>>
}

/** The Client Remote service (`ctx.remote`). */
interface DshRemoteService {
  /** The settings namespace. */
  settings: DshSettingsRemote
  /** The session namespace. */
  session: DshSessionRemote
}

/** The Client Cordis context this bundle receives in `apply`. */
interface DshClientContext {
  /**
   * Register a cleanup-aware effect on this plugin's fiber.
   * @param execute - effect body returning its disposer.
   * @param label - effect label shown in Cordis diagnostics.
   */
  effect(execute: () => () => void, label?: string): unknown
  /** The locale registry. */
  locale: DshLocaleService
  /** The slot renderer's registration service. */
  slots: DshSlotService
  /** Authorized Host capabilities. */
  remote: DshRemoteService
}
