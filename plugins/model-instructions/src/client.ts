/**
 * Browser half: the "Model rules" page in Settings.
 *
 * The Host plugin (`@nick.du/dsh-plugin-model-instructions`) declares one volatile
 * `rules` field. This page reads that field through the settings document the
 * Host serves (`ctx.remote.settings`) and writes the whole rule list back on
 * save, so rules apply to the next model step without a restart.
 *
 * Provider and model are chosen from the deployment's routable catalog
 * (`ctx.remote.session.modelCatalog()`); a rule that needs a wildcard or an id
 * outside the catalog picks "Custom" and keeps the raw pattern text.
 *
 * The page owns its markup and styles: it imports no Harness Client package,
 * uses theme tokens only, and renders its own controls.
 *
 * This file is a **classic browser script**, not an ES module: DSH appends a
 * `<script src>` element for the package's `./client` artifact, so the bundle
 * registers itself through `window.__ModuleLoader__` and must not contain any
 * `import` or `export` statement (either one would make tsc emit a module, and
 * a module script is not what the page loads). The domain types below are
 * erased at emit; their ambient contract lives in `client-contract.d.ts`.
 */

/** The namespace identity a settings view is keyed by; enough for one write. */
interface NamespaceRef {
  /** Namespace key (the plugin row id). */
  ns: string
  /** Revision the view was read at; a write expects it unchanged. */
  revision: number
}

/** One editable rule: the stored pattern arrays projected into form fields. */
interface DraftRule {
  /** Stable id for React keys and field ids. */
  id: string
  /** Optional display name; empty means the title shows provider · model. */
  name: string
  /** Select value: `''` (every provider), a provider id, or `CUSTOM`. */
  provider: string
  /** Raw provider patterns, used when `provider` is `CUSTOM`. */
  providerText: string
  /** Select value: `''` (every model), a model id, or `CUSTOM`. */
  model: string
  /** Raw model patterns, used when `model` is `CUSTOM`. */
  modelText: string
  /** Instruction text appended when the rule matches. */
  instruction: string
}

/** One draft change: a replacement list or an updater over the current list. */
type DraftUpdate = DraftRule[] | ((current: DraftRule[]) => DraftRule[])

/** One rule as written back to the settings document (the Host's schema shape). */
interface StoredRule {
  /** Optional display name. */
  name: string
  /** Provider globs; empty admits every provider. */
  providers: string[]
  /** Model globs; empty admits every model. */
  models: string[]
  /** Instruction text; blank rules stay inactive. */
  instruction: string
}

/** Structural view of one stored rule, which may be partial or malformed. */
interface StoredRuleLike {
  name?: unknown
  providers?: unknown
  models?: unknown
  instruction?: unknown
}

/** One routable model of the deployment's catalog, flattened for the select. */
interface CatalogModel {
  /** Model id. */
  id: string
  /** Display name; falls back to the id. */
  name: string
}

/** One provider of the routable catalog with its models. */
interface CatalogGroup {
  /** Provider id. */
  id: string
  /** Display name; falls back to the id. */
  name: string
  /** Routable models of this provider. */
  models: CatalogModel[]
}

/** Lifecycle of the model-catalog request. */
type CatalogStatus = 'loading' | 'ready' | 'error'

/** The model-catalog request state. */
interface CatalogState {
  /** Whether the catalog is loading, readable, or unavailable. */
  status: CatalogStatus
  /** Provider groups; empty until the request succeeds. */
  groups: CatalogGroup[]
}

/** Lifecycle of the settings page. */
type SectionPhase = 'loading' | 'ready' | 'unavailable' | 'error'

/** One user-visible status line. */
interface SectionMessage {
  /** Error lines tint red and announce as alerts; info lines are green. */
  kind: 'error' | 'info'
  /** Locale dictionary key. */
  key: string
  /** Raw diagnostic shown in the details disclosure, when there is one. */
  raw?: string
}

/** Select projection of one stored pattern list. */
interface SelectPattern {
  /** A single value, `''` for every value, or `CUSTOM`. */
  value: string
  /** Raw comma-separated text, used when `value` is `CUSTOM`. */
  text: string
}

/** A failed settings read: no namespace view, but a diagnostic. */
interface ReadFailure {
  /** The refused call's failure, when the Host described one. */
  failure: DshRemoteFailure | undefined
}

/** Result of reading the Host's current namespace view. */
type ReadViewResult = DshSettingsNamespaceView | ReadFailure | null

window.__ModuleLoader__!.load({
  id: '@nick.du/dsh-plugin-model-instructions',
  factory(require: DshBundleRequire) {
    const React = require('react') as ReactRuntime
    const h = React.createElement

    /** Settings namespace row id of the Host plugin. */
    const NAMESPACE = 'model-instructions'
    /** Locale dictionary this page owns. */
    const LOCALE_NS = 'settings.modelInstructions'
    /** Select value meaning "edit the patterns by hand". */
    const CUSTOM = '__custom__'
    /** Monotonic id source for stable React keys and field ids. */
    let draftSeq = 0

    const EN: Record<string, string> = {
      nav: 'Model rules',
      title: 'Model instructions',
      intro:
        'Appends instructions to the system prompt of the model that is about to answer. Rules apply to every session and subagent; the minimal preset sends only its own persona and ignores them.',
      loading: 'Loading configuration…',
      unavailable:
        'These settings are not available. Make sure the Model rules plugin is enabled, then reopen Settings.',
      loadFailed: 'Could not read the configuration.',
      details: 'Details',
      empty: 'No rules yet. The system prompt stays unchanged for every model.',
      addFirst: 'Add the first rule',
      rule: 'Rule',
      ruleName: 'Name (optional)',
      ruleNamePlaceholder: 'e.g. Reasoning model: think first',
      listTitle: 'Rules',
      collapseList: 'Collapse',
      expandList: 'Expand',
      collapseRule: 'Collapse rule',
      expandRule: 'Expand rule',
      providers: 'Provider',
      models: 'Model',
      allProviders: 'All providers',
      allModels: 'All models',
      customOption: 'Custom patterns…',
      patternsHint: 'Comma-separated glob patterns: * matches any run, ? one character.',
      instruction: 'Instruction',
      instructionHint:
        'Appended to the system prompt when the rule matches. An empty instruction leaves the rule inactive.',
      instructionPlaceholder: 'Reason through the change before editing files.',
      catalogError:
        'The model list is unavailable; use "Custom patterns" to enter model ids by hand.',
      badgeInactive: 'Inactive',
      badgeEveryModel: 'Every model',
      broadWarning: 'A rule without a provider or model applies to every model.',
      moveUp: 'Move rule up',
      moveDown: 'Move rule down',
      removeRule: 'Delete',
      addRule: 'Add rule',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard changes',
      reload: 'Reload',
      saved: 'Saved. The next model step uses these rules.',
      unsaved: 'You have unsaved changes.',
      readOnly: 'This configuration is read-only.',
      conflict:
        'Another change landed first. Your edits are kept and the latest configuration is loaded; save again to apply them.',
      saveFailed: 'Could not save the configuration.',
    }

    const ZH: Record<string, string> = {
      nav: '按模型注入',
      title: '按模型注入提示词',
      intro:
        '根据当前这一步将要调用的模型，向系统提示词追加不同指令。规则对所有会话和子代理生效；minimal 预设只发送自己的人设，会忽略这些规则。',
      loading: '正在读取配置…',
      unavailable: '暂时无法读取该插件的设置。请确认“按模型注入”插件已启用，然后重新打开设置。',
      loadFailed: '读取配置失败。',
      details: '详情',
      empty: '还没有规则。所有模型的系统提示词保持原样。',
      addFirst: '添加第一条规则',
      rule: '规则',
      ruleName: '规则名（可选）',
      ruleNamePlaceholder: '例如：推理模型先推理',
      listTitle: '规则列表',
      collapseList: '收起',
      expandList: '展开',
      collapseRule: '收起规则',
      expandRule: '展开规则',
      providers: '提供商',
      models: '模型',
      allProviders: '全部提供商',
      allModels: '全部模型',
      customOption: '自定义通配符…',
      patternsHint: '逗号分隔的通配符：* 匹配任意长度，? 匹配单个字符。',
      instruction: '指令',
      instructionHint: '命中该规则时追加到系统提示词；留空则该条规则不生效。',
      instructionPlaceholder: '先说明失败模式，再给出最小改动。',
      catalogError: '暂时读不到模型列表；可以用“自定义通配符”手填模型 id。',
      badgeInactive: '未生效',
      badgeEveryModel: '全部模型',
      broadWarning: '有规则没有选择提供商和模型，它会应用到所有模型。',
      moveUp: '上移规则',
      moveDown: '下移规则',
      removeRule: '删除',
      addRule: '添加规则',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      reload: '重新加载',
      saved: '已保存，下一个模型步骤开始生效。',
      unsaved: '有未保存的修改。',
      readOnly: '当前配置只读，无法保存。',
      conflict: '配置已被其他改动更新。你的修改已保留，最新配置已载入，再次保存即可应用。',
      saveFailed: '保存配置失败。',
    }

    const CSS = `
.mi-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
}
.mi-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.mi-intro { margin: 0; color: var(--dsw-alias-label-tertiary); }
.mi-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.mi-empty {
  box-sizing: border-box;
  width: 100%;
  margin: 12px 0 0;
  padding: 12px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: center;
  cursor: pointer;
}
.mi-list-head { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.mi-rules { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.mi-rule {
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mi-rule-head { display: flex; align-items: center; gap: 8px; }
.mi-rule-toggle {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 32px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}
.mi-rule-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.mi-chevron {
  display: inline-flex;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 160ms ease;
}
.mi-rule-toggle[aria-expanded='true'] .mi-chevron { transform: rotate(90deg); }
.mi-rule-toggle:hover .mi-chevron { color: var(--dsw-alias-label-secondary); }
.mi-rule-title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 500;
}
.mi-rule-excerpt {
  margin: 6px 0 0;
  padding-left: 24px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.mi-rule-body { display: flex; flex-direction: column; gap: 10px; }
.mi-badge {
  padding: 1px 6px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-xs);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}
.mi-badge-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.mi-rule-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 2px; }
.mi-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.mi-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.mi-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.mi-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.mi-input, .mi-textarea, .mi-select {
  box-sizing: border-box;
  width: 100%;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
}
.mi-input, .mi-select { height: 32px; }
.mi-textarea { padding-top: 5px; padding-bottom: 5px; min-height: 84px; resize: vertical; }
.mi-input::placeholder, .mi-textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
.mi-input:focus-visible, .mi-select:focus-visible, .mi-textarea:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.mi-input:disabled, .mi-select:disabled, .mi-textarea:disabled { opacity: 0.4; }
.mi-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.mi-toolbar-spacer { flex: 1 1 0; }
.mi-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-md);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.mi-button:disabled { cursor: default; opacity: 0.4; }
.mi-button:focus-visible, .mi-link:focus-visible, .mi-icon-button:focus-visible, .mi-empty:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.mi-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.mi-secondary {
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: transparent;
  color: var(--dsw-alias-label-primary);
}
.mi-link {
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.mi-link:disabled { cursor: default; opacity: 0.4; }
.mi-icon-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}
.mi-icon-button:disabled { cursor: default; opacity: 0.4; }
.mi-danger { color: var(--dsw-alias-state-error-primary); }
.mi-message { margin: 0; font-size: 12px; line-height: 18px; }
.mi-message-error { color: var(--dsw-alias-state-error-primary); }
.mi-message-info { color: var(--dsw-alias-state-success-primary); }
.mi-message-note { color: var(--dsw-alias-state-warn-label); }
.mi-detail { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.mi-detail summary { cursor: pointer; }
.mi-detail code { display: block; margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }
.mi-status { display: flex; flex-direction: column; gap: 6px; }
.mi-status > p:first-child { margin-top: 0; }
.mi-status:empty { display: none; }
@media (hover: hover) {
  .mi-empty:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
  .mi-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
  .mi-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
  .mi-link:hover:not(:disabled), .mi-icon-button:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
  .mi-danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
}
@media (max-width: 520px) {
  .mi-grid { grid-template-columns: minmax(0, 1fr); }
}
`

    /**
     * Read one property off an untrusted value without assuming its shape.
     * @param value - the value to inspect.
     * @param key - the property name.
     * @returns the property value, or undefined for a non-object.
     */
    function property(value: unknown, key: string): unknown {
      return value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)[key]
        : undefined
    }

    /**
     * Find this plugin's settings namespace. A bundle installed by the plugin
     * manager contributes its rows under an include scope, so the live entry id
     * may carry a prefix (`include:model-instructions`); the row id itself is
     * what this page declares.
     * @param namespaces - the namespaces the Host described.
     * @returns the matching namespace view, when the Host serves one.
     */
    function findNamespace(namespaces: unknown): DshSettingsNamespaceView | undefined {
      if (!Array.isArray(namespaces)) return undefined
      // The Host contract pins the entry shape; the array guard keeps an older
      // Host from failing the whole page.
      const views = namespaces as DshSettingsNamespaceView[]
      return (
        views.find((entry) => entry.ns === NAMESPACE) ??
        views.find((entry) => typeof entry.ns === 'string' && entry.ns.endsWith(`:${NAMESPACE}`))
      )
    }

    /**
     * Split comma-separated text into glob patterns.
     * @param text - the field's text.
     * @returns the trimmed, non-empty patterns.
     */
    function splitList(text: unknown): string[] {
      return String(text ?? '')
        .split(/[,，\n]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    }

    /**
     * Choose the select value and custom text for one stored pattern list.
     * @param value - the rule's `providers` or `models` array.
     * @returns a single id, `''` for every value, or `CUSTOM` with raw text.
     */
    function selectValue(value: unknown): SelectPattern {
      if (!Array.isArray(value) || value.length === 0) return { value: '', text: '' }
      const entries = value as unknown[]
      if (entries.length === 1) return { value: String(entries[0]), text: String(entries[0]) }
      return { value: CUSTOM, text: entries.join(', ') }
    }

    /**
     * Project the configured rules into editable fields.
     * @param value - the namespace's `rules` value.
     * @returns one draft rule per configured rule.
     */
    function toDraft(value: unknown): DraftRule[] {
      if (!Array.isArray(value)) return []
      return (value as unknown[]).map((rule) => {
        const source =
          rule !== null && typeof rule === 'object'
            ? (rule as StoredRuleLike)
            : ({} as StoredRuleLike)
        const providers = selectValue(source.providers)
        const models = selectValue(source.models)
        return {
          id: `mi-${++draftSeq}`,
          name: typeof source.name === 'string' ? source.name : '',
          provider: providers.value,
          providerText: providers.text,
          model: models.value,
          modelText: models.text,
          instruction: typeof source.instruction === 'string' ? source.instruction : '',
        }
      })
    }

    /**
     * Resolve one select value plus its custom text into stored patterns.
     * @param value - the select value.
     * @param text - the custom text.
     * @returns the pattern array the Host validates.
     */
    function patternsOf(value: string, text: string): string[] {
      if (value === '') return []
      if (value === CUSTOM) return splitList(text)
      return [value]
    }

    /**
     * Project a draft back into the schema's rule shape.
     * @param draft - the editable rules.
     * @returns the value written to the settings document.
     */
    function toValue(draft: readonly DraftRule[]): StoredRule[] {
      return draft.map((rule) => ({
        name: rule.name.trim(),
        providers: patternsOf(rule.provider, rule.providerText),
        models: patternsOf(rule.model, rule.modelText),
        instruction: rule.instruction,
      }))
    }

    /**
     * Whether a draft rule would apply to every model while carrying text.
     * @param rule - one draft rule.
     * @returns true for an unfiltered, active rule.
     */
    function isBroadRule(rule: DraftRule): boolean {
      return (
        rule.instruction.trim().length > 0 &&
        patternsOf(rule.provider, rule.providerText).length === 0 &&
        patternsOf(rule.model, rule.modelText).length === 0
      )
    }

    /**
     * Flatten the catalog into provider rows and their models.
     * @param groups - the catalog's provider groups.
     * @returns normalized groups with id, label, and models.
     */
    function catalogGroups(groups: unknown): CatalogGroup[] {
      if (!Array.isArray(groups)) return []
      return (groups as unknown[])
        .map((group) => {
          const source: DshModelCatalogGroup =
            group !== null && typeof group === 'object' ? (group as DshModelCatalogGroup) : {}
          const models = Array.isArray(source.models) ? source.models : []
          return {
            id: String(source.id ?? ''),
            name: String(source.name ?? source.id ?? ''),
            models: models
              .map((model) => {
                const entry: DshModelCatalogEntry =
                  model !== null && typeof model === 'object' ? (model as DshModelCatalogEntry) : {}
                return { id: String(entry.id ?? ''), name: String(entry.name ?? entry.id ?? '') }
              })
              .filter((model) => model.id.length > 0),
          }
        })
        .filter((group) => group.id.length > 0)
    }

    /**
     * Render a thrown value or Remote failure as one diagnostic line.
     * @param error - the thrown value or `{ code, message }` failure.
     * @returns a short single-line description.
     */
    function describeError(error: unknown): string {
      if (error instanceof Error) return `${error.name}: ${error.message}`
      if (error !== null && typeof error === 'object') {
        const failure = error as { code?: unknown; message?: unknown }
        const code = typeof failure.code === 'string' ? failure.code : undefined
        const message = typeof failure.message === 'string' ? failure.message : undefined
        if (code !== undefined || message !== undefined) {
          return [code, message].filter(Boolean).join(': ')
        }
        try {
          return JSON.stringify(error).slice(0, 400)
        } catch {
          return String(error)
        }
      }
      return String(error)
    }

    /**
     * Build the settings page component for one plugin instance.
     * @param t - the bound locale translator.
     * @param remote - the Client Remote service (`ctx.remote`).
     * @param locale - the Client locale service.
     * @returns the React component registered in `settings.section`.
     */
    function createSection(
      t: DshTranslation,
      remote: DshRemoteService,
      locale: DshLocaleService,
    ): (props: DshSettingsSectionOwnerProps) => ReactElementLike {
      return function ModelInstructionsSection() {
        const [phase, setPhase] = React.useState<SectionPhase>('loading')
        const [view, setView] = React.useState<NamespaceRef | null>(null)
        const [writable, setWritable] = React.useState<boolean>(true)
        const [draft, setDraft] = React.useState<DraftRule[]>([])
        const [baseline, setBaseline] = React.useState<string>('[]')
        const [saving, setSaving] = React.useState<boolean>(false)
        const [message, setMessage] = React.useState<SectionMessage | null>(null)
        const [focusId, setFocusId] = React.useState<string | null>(null)
        const [collapsed, setCollapsed] = React.useState<string[]>([])
        const [listOpen, setListOpen] = React.useState<boolean>(true)
        const [catalog, setCatalog] = React.useState<CatalogState>({
          status: 'loading',
          groups: [],
        })
        const [, rerender] = React.useState<number>(0)
        const addButton = React.useRef<HTMLButtonElement | null>(null)

        React.useEffect(
          () =>
            locale.subscribe(() => {
              rerender((count) => count + 1)
            }),
          [],
        )

        // The deployment's routable models, for the provider and model selects.
        React.useEffect(() => {
          let live = true
          void (async () => {
            try {
              const response = await remote.session.modelCatalog()
              if (!live) return
              if (!response || response.ok !== true) {
                console.debug(
                  '[model-instructions] model catalog refused',
                  response && response.error,
                )
                setCatalog({ status: 'error', groups: [] })
                return
              }
              setCatalog({
                status: 'ready',
                groups: catalogGroups(response.value && response.value.groups),
              })
            } catch (error) {
              console.debug('[model-instructions] model catalog failed', error)
              if (live) setCatalog({ status: 'error', groups: [] })
            }
          })()
          return () => {
            live = false
          }
        }, [remote])

        /**
         * Read the Host's current namespace view, keeping the draft as it is.
         * @returns the found namespace view, a `{ failure }` marker, or null.
         */
        const readView = React.useCallback(async (): Promise<ReadViewResult> => {
          const response = await remote.settings.describe()
          if (!response || response.ok !== true) {
            const failure = response && response.error
            console.debug('[model-instructions] describe refused', failure)
            return { failure }
          }
          const found = findNamespace(response.value && response.value.namespaces)
          if (found === undefined) return null
          setWritable(response.value.writable !== false)
          setView({ ns: found.ns, revision: found.revision })
          return found
        }, [remote])

        const load = React.useCallback(async () => {
          setPhase('loading')
          setMessage(null)
          try {
            const found = await readView()
            if (found !== null && typeof found === 'object' && 'failure' in found) {
              setMessage({ kind: 'error', key: 'loadFailed', raw: describeError(found.failure) })
              setPhase('error')
              return
            }
            if (found === null) {
              setPhase('unavailable')
              return
            }
            const rules = toDraft(property(found.value, 'rules'))
            setDraft(rules)
            setBaseline(JSON.stringify(rules))
            setPhase('ready')
          } catch (error) {
            console.debug('[model-instructions] load failed', error)
            setMessage({ kind: 'error', key: 'loadFailed', raw: describeError(error) })
            setPhase('error')
          }
        }, [readView])

        React.useEffect(() => {
          void load()
        }, [load])

        const editing = phase === 'ready' && writable && !saving
        const dirty = JSON.stringify(draft) !== baseline
        const groups = catalog.groups

        const closed = (id: string) => collapsed.includes(id)
        const toggleRule = (id: string) => {
          setCollapsed((current) =>
            current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
          )
        }
        const toggleList = () => {
          setListOpen((open) => !open)
        }
        const groupName = (id: string): string => {
          const group = groups.find((candidate) => candidate.id === id)
          return group ? group.name || group.id : id
        }
        const modelName = (rule: DraftRule): string => {
          for (const group of groups) {
            const model = group.models.find((candidate) => candidate.id === rule.model)
            if (model !== undefined) return model.name || model.id
          }
          return rule.model
        }
        const ruleTitle = (rule: DraftRule): string => {
          const name = rule.name.trim()
          if (name.length > 0) return name
          const provider =
            rule.provider === ''
              ? t('allProviders')
              : rule.provider === CUSTOM
                ? t('customOption')
                : groupName(rule.provider)
          const model =
            rule.model === ''
              ? t('allModels')
              : rule.model === CUSTOM
                ? t('customOption')
                : modelName(rule)
          return `${provider} · ${model}`
        }
        const ruleExcerpt = (rule: DraftRule): string => {
          const text = rule.instruction.trim().replace(/\s+/g, ' ')
          if (text.length === 0) return ''
          return text.length > 72 ? `${text.slice(0, 72)}…` : text
        }

        const edit = (change: DraftUpdate) => {
          setMessage(null)
          setDraft(change)
        }

        const update = (id: string, patch: Partial<DraftRule>) => {
          edit((current) => current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)))
        }

        const remove = (id: string) => {
          edit((current) => current.filter((rule) => rule.id !== id))
          if (addButton.current) addButton.current.focus()
        }

        const add = () => {
          const id = `mi-${++draftSeq}`
          edit((current) => [
            ...current,
            {
              id,
              name: '',
              provider: '',
              providerText: '',
              model: '',
              modelText: '',
              instruction: '',
            },
          ])
          setListOpen(true)
          setCollapsed((current) => current.filter((item) => item !== id))
          setFocusId(id)
        }

        const move = (id: string, offset: number) => {
          edit((current) => {
            const index = current.findIndex((rule) => rule.id === id)
            const target = index + offset
            if (index < 0 || target < 0 || target >= current.length) return current
            const next = current.slice()
            const [moved] = next.splice(index, 1)
            if (moved === undefined) return current
            next.splice(target, 0, moved)
            return next
          })
        }

        const discard = () => {
          setDraft(JSON.parse(baseline) as DraftRule[])
          setMessage(null)
        }

        const save = async () => {
          if (!editing || !dirty || view === null) return
          setSaving(true)
          setMessage(null)
          try {
            const response = await remote.settings.mutate(
              view.ns,
              [{ op: 'set', path: ['rules'], value: toValue(draft) }],
              view.revision,
            )
            if (!response || response.ok !== true) {
              console.debug('[model-instructions] save refused', response && response.error)
              const code = response && response.error && response.error.code
              const failure = response && response.error && response.error.message
              const conflict = code === 'settings/conflict' || /changed since/i.test(failure || '')
              if (conflict) await readView()
              setMessage({ kind: 'error', key: conflict ? 'conflict' : 'saveFailed' })
              return
            }
            // Re-read after the write: seeding the draft from the Host's own
            // view makes a write that did not persist visible immediately
            // instead of leaving the page showing an unsaved-looking draft.
            const fresh = await readView()
            const stored =
              fresh !== null && typeof fresh === 'object' && !('failure' in fresh)
                ? property(fresh.value, 'rules')
                : property(response.value.value, 'rules')
            const rules = toDraft(stored)
            if (fresh === null || (fresh && typeof fresh === 'object' && 'failure' in fresh)) {
              const next = response.value
              setView({ ns: (next && next.ns) || view.ns, revision: next.revision })
            }
            setDraft(rules)
            setBaseline(JSON.stringify(rules))
            setMessage({ kind: 'info', key: 'saved' })
          } catch (error) {
            console.debug('[model-instructions] save failed', error)
            setMessage({ kind: 'error', key: 'saveFailed', raw: describeError(error) })
          } finally {
            setSaving(false)
          }
        }

        const hint = (id: string, text: string) =>
          text.length > 0 ? h('p', { className: 'mi-hint', id }, text) : null

        /**
         * Provider select plus its custom pattern field.
         * @param rule - the draft rule.
         * @param index - position, used for ids and labels.
         * @returns the field element.
         */
        const providerField = (rule: DraftRule, index: number) => {
          const id = `${rule.id}-provider`
          const hintId = `${id}-hint`
          const known = groups.map((group) => group.id)
          const values = ['']
          for (const group of groups) values.push(group.id)
          if (rule.provider && rule.provider !== CUSTOM && !known.includes(rule.provider)) {
            values.push(rule.provider)
          }
          values.push(CUSTOM)
          const options = values.map((value) => {
            const group = groups.find((candidate) => candidate.id === value)
            const label =
              value === ''
                ? t('allProviders')
                : value === CUSTOM
                  ? t('customOption')
                  : group
                    ? group.name
                    : value
            return h('option', { key: value, value }, label)
          })
          return h(
            'div',
            { className: 'mi-field', key: 'provider' },
            h('label', { className: 'mi-label', htmlFor: id }, t('providers')),
            h(
              'select',
              {
                id,
                className: 'mi-select',
                value: rule.provider,
                disabled: !editing,
                'aria-describedby': hintId,
                onChange: (event: DshInputChangeEvent) => {
                  const value = event.target.value
                  const text =
                    value === CUSTOM && rule.providerText.length === 0
                      ? rule.provider
                      : rule.providerText
                  update(rule.id, { provider: value, providerText: text })
                },
              },
              options,
            ),
            rule.provider === CUSTOM
              ? h('input', {
                  className: 'mi-input',
                  type: 'text',
                  value: rule.providerText,
                  disabled: !editing,
                  spellCheck: false,
                  autoComplete: 'off',
                  placeholder: 'deepseek-*',
                  'aria-label': `${t('providers')}: ${t('customOption')}`,
                  onChange: (event: DshInputChangeEvent) =>
                    update(rule.id, { providerText: event.target.value }),
                })
              : null,
            hint(hintId, rule.provider === CUSTOM ? t('patternsHint') : ''),
          )
        }

        /**
         * Model select plus its custom pattern field, filtered by the provider.
         * @param rule - the draft rule.
         * @param index - position, used for ids and labels.
         * @returns the field element.
         */
        const modelField = (rule: DraftRule, index: number) => {
          const id = `${rule.id}-model`
          const hintId = `${id}-hint`
          const provider = rule.provider === CUSTOM ? '' : rule.provider
          const scoped = provider === '' ? groups : groups.filter((group) => group.id === provider)
          const visibleGroups = scoped.length > 0 ? scoped : groups
          const known = new Set<string>()
          for (const group of visibleGroups) {
            for (const model of group.models) known.add(model.id)
          }
          const children: ReactElementLike[] = []
          if (provider === '' && visibleGroups.length > 1) {
            for (const group of visibleGroups) {
              children.push(
                h(
                  'optgroup',
                  { key: group.id, label: group.name },
                  group.models.map((model) =>
                    h('option', { key: `${group.id}:${model.id}`, value: model.id }, model.name),
                  ),
                ),
              )
            }
          } else {
            for (const group of visibleGroups) {
              for (const model of group.models) {
                children.push(
                  h('option', { key: `${group.id}:${model.id}`, value: model.id }, model.name),
                )
              }
            }
          }
          const extra: ReactElementLike[] = []
          if (rule.model && rule.model !== CUSTOM && !known.has(rule.model)) {
            extra.push(h('option', { key: `extra-${rule.model}`, value: rule.model }, rule.model))
          }
          const all = [
            h('option', { key: '', value: '' }, t('allModels')),
            ...children,
            ...extra,
            h('option', { key: CUSTOM, value: CUSTOM }, t('customOption')),
          ]
          return h(
            'div',
            { className: 'mi-field', key: 'model' },
            h('label', { className: 'mi-label', htmlFor: id }, t('models')),
            h(
              'select',
              {
                id,
                className: 'mi-select',
                value: rule.model,
                disabled: !editing,
                'aria-describedby': hintId,
                onChange: (event: DshInputChangeEvent) => {
                  const value = event.target.value
                  const text =
                    value === CUSTOM && rule.modelText.length === 0 ? rule.model : rule.modelText
                  update(rule.id, { model: value, modelText: text })
                },
              },
              all,
            ),
            rule.model === CUSTOM
              ? h('input', {
                  className: 'mi-input',
                  type: 'text',
                  value: rule.modelText,
                  disabled: !editing,
                  spellCheck: false,
                  autoComplete: 'off',
                  placeholder: 'deepseek-reasoner*',
                  'aria-label': `${t('models')}: ${t('customOption')}`,
                  onChange: (event: DshInputChangeEvent) =>
                    update(rule.id, { modelText: event.target.value }),
                })
              : null,
            hint(hintId, rule.model === CUSTOM ? t('patternsHint') : ''),
          )
        }

        const ruleCard = (rule: DraftRule, index: number) => {
          const prefix = rule.id
          const active = rule.instruction.trim().length > 0
          const broad = isBroadRule(rule)
          const open = !closed(rule.id)
          const bodyId = `${prefix}-body`
          const title = ruleTitle(rule)
          const excerpt = ruleExcerpt(rule)
          return h(
            'li',
            { className: 'mi-rule', key: rule.id },
            h(
              'div',
              { className: 'mi-rule-head' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mi-rule-toggle',
                  'aria-expanded': open,
                  'aria-controls': bodyId,
                  'aria-label': `${open ? t('collapseRule') : t('expandRule')}${
                    title.length > 0 ? `: ${title}` : ''
                  }`,
                  onClick: () => toggleRule(rule.id),
                },
                h(
                  'span',
                  { className: 'mi-chevron', 'aria-hidden': true },
                  h(
                    'svg',
                    {
                      viewBox: '0 0 16 16',
                      width: 16,
                      height: 16,
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: 1.5,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                    },
                    h('path', { d: 'M6 3.5 10.5 8 6 12.5' }),
                  ),
                ),
                h('span', { className: 'mi-rule-title' }, title),
              ),
              !active ? h('span', { className: 'mi-badge' }, t('badgeInactive')) : null,
              active && broad
                ? h('span', { className: 'mi-badge mi-badge-warn' }, t('badgeEveryModel'))
                : null,
              h(
                'div',
                { className: 'mi-rule-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mi-icon-button',
                    disabled: !editing || index === 0,
                    'aria-label': `${t('moveUp')}: ${index + 1}`,
                    onClick: () => move(rule.id, -1),
                  },
                  '↑',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mi-icon-button',
                    disabled: !editing || index === draft.length - 1,
                    'aria-label': `${t('moveDown')}: ${index + 1}`,
                    onClick: () => move(rule.id, 1),
                  },
                  '↓',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mi-link mi-danger',
                    disabled: !editing,
                    'aria-label': `${t('removeRule')}: ${index + 1}`,
                    onClick: () => remove(rule.id),
                  },
                  t('removeRule'),
                ),
              ),
            ),
            open
              ? null
              : excerpt.length > 0
                ? h('p', { className: 'mi-rule-excerpt' }, excerpt)
                : null,
            open
              ? h(
                  'div',
                  { className: 'mi-rule-body', id: bodyId, key: 'body' },
                  h(
                    'div',
                    { className: 'mi-field', key: 'name' },
                    h('label', { className: 'mi-label', htmlFor: `${prefix}-name` }, t('ruleName')),
                    h('input', {
                      id: `${prefix}-name`,
                      className: 'mi-input',
                      type: 'text',
                      value: rule.name,
                      disabled: !editing,
                      spellCheck: false,
                      autoComplete: 'off',
                      placeholder: t('ruleNamePlaceholder'),
                      onChange: (event: DshInputChangeEvent) =>
                        update(rule.id, { name: event.target.value }),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'mi-grid', key: 'match' },
                    providerField(rule, index),
                    modelField(rule, index),
                  ),
                  h(
                    'div',
                    { className: 'mi-field', key: 'instruction' },
                    h(
                      'label',
                      { className: 'mi-label', htmlFor: `${prefix}-instruction` },
                      t('instruction'),
                    ),
                    h('textarea', {
                      id: `${prefix}-instruction`,
                      className: 'mi-textarea',
                      rows: 4,
                      value: rule.instruction,
                      disabled: !editing,
                      autoFocus: rule.id === focusId,
                      placeholder: t('instructionPlaceholder'),
                      'aria-describedby': `${prefix}-instruction-hint`,
                      onChange: (event: DshInputChangeEvent) =>
                        update(rule.id, { instruction: event.target.value }),
                    }),
                    hint(`${prefix}-instruction-hint`, t('instructionHint')),
                  ),
                )
              : null,
          )
        }

        const status = (): ReactElementLike | null => {
          if (message) {
            return h(
              React.Fragment,
              null,
              h(
                'p',
                {
                  className: `mi-message mi-message-${message.kind === 'error' ? 'error' : 'info'}`,
                  role: message.kind === 'error' ? 'alert' : 'status',
                },
                t(message.key),
              ),
              message.raw
                ? h(
                    'details',
                    { className: 'mi-detail' },
                    h('summary', null, t('details')),
                    h('code', null, message.raw),
                  )
                : null,
            )
          }
          if (phase !== 'ready') return null
          if (!writable) {
            return h(
              'p',
              { className: 'mi-message mi-message-note', role: 'status' },
              t('readOnly'),
            )
          }
          if (dirty) {
            return h('p', { className: 'mi-message mi-message-note', role: 'status' }, t('unsaved'))
          }
          if (draft.some(isBroadRule)) {
            return h(
              'p',
              { className: 'mi-message mi-message-note', role: 'status' },
              t('broadWarning'),
            )
          }
          return null
        }

        const body: ReactNodeLike[] = []
        if (phase === 'loading') {
          body.push(h('p', { className: 'mi-note', key: 'loading' }, t('loading')))
        }
        if (catalog.status === 'error') {
          body.push(h('p', { className: 'mi-note', key: 'catalog' }, t('catalogError')))
        }
        if (phase === 'unavailable' || phase === 'error') {
          body.push(h('div', { className: 'mi-status', key: 'status' }, status()))
          body.push(
            h(
              'div',
              { className: 'mi-toolbar', key: 'retry' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mi-button mi-secondary',
                  onClick: () => {
                    void load()
                  },
                },
                t('reload'),
              ),
            ),
          )
        }
        if (phase === 'ready') {
          if (draft.length === 0) {
            body.push(
              h(
                'button',
                {
                  type: 'button',
                  className: 'mi-empty',
                  key: 'empty',
                  disabled: !editing,
                  onClick: add,
                },
                t('addFirst'),
              ),
            )
          } else {
            body.push(
              h(
                'div',
                { className: 'mi-list-head', key: 'list-head' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mi-rule-toggle',
                    'aria-expanded': listOpen,
                    'aria-controls': listOpen ? 'mi-rules' : undefined,
                    'aria-label': `${listOpen ? t('collapseList') : t('expandList')}: ${t(
                      'listTitle',
                    )}`,
                    onClick: toggleList,
                  },
                  h(
                    'span',
                    { className: 'mi-chevron', 'aria-hidden': true },
                    h(
                      'svg',
                      {
                        viewBox: '0 0 16 16',
                        width: 16,
                        height: 16,
                        fill: 'none',
                        stroke: 'currentColor',
                        strokeWidth: 1.5,
                        strokeLinecap: 'round',
                        strokeLinejoin: 'round',
                      },
                      h('path', { d: 'M6 3.5 10.5 8 6 12.5' }),
                    ),
                  ),
                  h('span', { className: 'mi-rule-title' }, t('listTitle')),
                ),
              ),
            )
            if (listOpen) {
              body.push(
                h(
                  'ul',
                  { className: 'mi-rules', id: 'mi-rules', key: 'rules' },
                  draft.map(ruleCard),
                ),
              )
            }
          }
          body.push(
            h(
              'div',
              { className: 'mi-toolbar', key: 'toolbar' },
              h(
                'button',
                {
                  type: 'button',
                  ref: addButton,
                  className: 'mi-button mi-secondary',
                  disabled: !editing,
                  onClick: add,
                },
                t('addRule'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mi-link',
                  disabled: !editing || dirty,
                  onClick: () => {
                    void load()
                  },
                },
                t('reload'),
              ),
              h('div', { className: 'mi-toolbar-spacer' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mi-button mi-secondary',
                  disabled: !editing || !dirty,
                  onClick: discard,
                },
                t('discard'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mi-button mi-primary',
                  disabled: !editing || !dirty,
                  onClick: () => {
                    void save()
                  },
                },
                saving ? t('saving') : t('save'),
              ),
            ),
          )
          body.push(h('div', { className: 'mi-status', key: 'status' }, status()))
        }

        return h(
          React.Fragment,
          null,
          h('style', { key: 'styles' }, CSS),
          h(
            'section',
            { className: 'mi-page', 'aria-label': t('title'), 'aria-busy': saving },
            h('h2', { className: 'mi-title' }, t('title')),
            h('p', { className: 'mi-intro' }, t('intro')),
            body,
          ),
        )
      }
    }

    /**
     * Build the nav glyph shown beside the section label.
     * @returns the icon component.
     */
    function createIcon(): (props: DshSettingsSectionIconProps) => ReactElementLike {
      return function ModelInstructionsIcon(props: DshSettingsSectionIconProps) {
        const size = props && typeof props.size === 'number' ? props.size : 16
        return h(
          'svg',
          {
            viewBox: '0 0 16 16',
            width: size,
            height: size,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            'aria-hidden': true,
            focusable: false,
          },
          h('rect', { x: 2.75, y: 2.75, width: 10.5, height: 10.5, rx: 3.25 }),
          h('path', { d: 'M5.5 6.5h5M5.5 9.5h3' }),
        )
      }
    }

    return {
      // `remote.settings` and `remote.session` are nested services: the Remote
      // carrier authorizes each consumer, so this plugin declares the exact
      // namespaces it calls (the shipped settings pages do the same).
      inject: ['slots', 'locale', 'remote', 'remote.settings', 'remote.session'],
      apply(ctx: DshClientContext) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, 'en', EN), 'model-instructions:locale:en')
        ctx.effect(() => ctx.locale.register(LOCALE_NS, 'zh', ZH), 'model-instructions:locale:zh')
        // Other built-in locales read the English copy rather than raw keys.
        for (const localeId of ['ja', 'es', 'fr', 'de', 'ru', 'pt']) {
          ctx.effect(
            () => ctx.locale.register(LOCALE_NS, localeId, EN),
            `model-instructions:locale:${localeId}`,
          )
        }
        const t = ctx.locale.bind(LOCALE_NS)
        const Section = createSection(t, ctx.remote, ctx.locale)
        const Icon = createIcon()
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'model-instructions',
                  order: 12,
                  label: () => t('nav'),
                },
                Section,
              ),
            ),
          'model-instructions:settings-page',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section.icon', () =>
              ctx.slots.register(
                {
                  name: 'settings.section.icon',
                  id: 'model-instructions',
                },
                Icon,
              ),
            ),
          'model-instructions:settings-icon',
        )
      },
    }
  },
})
