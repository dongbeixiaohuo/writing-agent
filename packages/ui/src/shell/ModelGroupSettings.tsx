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
    return profile.models.filter(model => Object.hasOwn(verified, model)).map(model => ({
      value: { profileId: profile.profileId, model }, label: `${profile.displayName} / ${model}`,
    }))
  })
  return <section className={css.modelGroups} aria-label="角色模型分配">
    <h3 className={css.settingsSectionTitle}>角色模型分配</h3>
    <p className={css.settingHint}>给三档各选一个已验证的模型，可以三档都选同一个。</p>
    {choices.length === 1 && MODEL_GROUPS.some(({ id }) => selectionKey(groups[id]) !== selectionKey(choices[0]!.value)) &&
      <button type="button" className={css.secondaryAction} disabled={busy} onClick={() => {
        const model = choices[0]!.value
        onChange({ writing: model, planning: model, review: model })
      }}>三档都用 {choices[0]!.label}</button>}
    {MODEL_GROUPS.map(group => {
      const selection = groups[group.id]
      const value = selectionKey(selection)
      const unavailable = selection && !choices.some(choice => selectionKey(choice.value) === value)
      return <div className={css.modelGroupRow} key={group.id}>
        <label className={css.formField}><span>{group.label}</span>
          <select aria-label={`${group.label}模型`} aria-describedby={`model-group-${group.id}-hint`} value={value} disabled={busy || choices.length === 0}
            onChange={event => {
              const selected = choices.find(choice => selectionKey(choice.value) === event.target.value)?.value
              if (selected) onChange({ ...groups, [group.id]: selected })
            }}>
            <option value="" disabled>请选择模型</option>
            {unavailable && <option value={value} disabled>{selection.model} · 不可用，请重新验证或选择</option>}
            {choices.map(choice => <option key={selectionKey(choice.value)} value={selectionKey(choice.value)}>{choice.label}</option>)}
          </select>
        </label>
        <p className={css.settingHint} id={`model-group-${group.id}-hint`}>{group.advice}</p>
        <ul className={css.modelGroupRoles} aria-label={`${group.label}档角色`}>
          {group.roles.map(([name, role]) => <li key={name}><strong>{name}</strong>（{role}）</li>)}
        </ul>
      </div>
    })}
    <p className={css.settingHint}>在下方供应商中点击「验证连接」，通过后即可分配。三档配齐后可以开始或继续写作。</p>
  </section>
}
