import type { DesktopProviderStatusView } from '../../../client-bridge/src/desktop-bridge.ts'
import { DEFAULT_MODEL_GROUPS, MODEL_GROUPS, type GroupModelSelection, type ModelGroupSelections } from '../../../client-bridge/src/model-groups.ts'
import css from './WritingAgentShell.module.css'

const selectionKey = (selection: GroupModelSelection | null) => selection ? JSON.stringify([selection.profileId, selection.model]) : ''

export function ModelGroupSettings({ status, busy, onChange }: {
  status: DesktopProviderStatusView; busy: boolean; onChange: (groups: ModelGroupSelections) => void
}) {
  const groups = status.modelGroups ?? DEFAULT_MODEL_GROUPS
  const choices = (status.profiles ?? []).flatMap(profile => {
    const verified = profile.verifiedModels ?? (profile.verifiedAt ? { [profile.model]: profile.verifiedAt } : {})
    if (profile.tools !== 'supported' || (profile.credentialChecked === true && !profile.configured)) return []
    return profile.models.filter(model => Boolean(verified[model])).map(model => ({
      value: { profileId: profile.profileId, model }, label: `${profile.displayName} / ${model}`,
    }))
  })
  return <section className={css.modelGroups} aria-label="角色模型分配">
    <h3 className={css.settingsSectionTitle}>角色模型分配</h3>
    <p className={css.settingHint}>不确定时保持“跟随默认”即可。只配置一个模型时，三组共用，无需额外设置。</p>
    {MODEL_GROUPS.map(group => {
      const selection = groups[group.id]
      const value = selectionKey(selection)
      const unavailable = selection && !choices.some(choice => selectionKey(choice.value) === value)
      return <div className={css.modelGroupRow} key={group.id}>
        <label className={css.formField}><span>{group.label}</span>
          <select aria-label={`${group.label}模型`} aria-describedby={`model-group-${group.id}-hint`} value={value} disabled={busy || !status.model}
            onChange={event => {
              const selected = choices.find(choice => selectionKey(choice.value) === event.target.value)?.value ?? null
              onChange({ ...groups, [group.id]: selected })
            }}>
            <option value="">跟随默认{status.model ? ` · ${status.model}` : ' · 尚未配置'}</option>
            {unavailable && <option value={value} disabled>{selection.model} · 不可用，请重新验证或选择</option>}
            {choices.map(choice => <option key={selectionKey(choice.value)} value={selectionKey(choice.value)}>{choice.label}</option>)}
          </select>
        </label>
        <p className={css.settingHint} id={`model-group-${group.id}-hint`}>{group.advice}</p>
        <p className={css.settingHint}>负责：{group.roles}</p>
      </div>
    })}
    <p className={css.settingHint}>仅可选择已验证通过的模型。在下方供应商中选择模型并点击“验证连接”即可加入。配置对所有项目生效，下一次启动或继续任务时使用。</p>
  </section>
}
